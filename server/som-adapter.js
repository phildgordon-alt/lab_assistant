/**
 * SOM (Schneider Optical Machines) Control Center Adapter
 *
 * Connects to Schneider's LMS MySQL database for real-time machine status,
 * conveyor information, and production data.
 *
 * Behavior:
 * - When connected: Pulls live data every 30s, persists to disk
 * - When disconnected: Serves last known data from disk, shows offline status
 * - No mock data - only real data with persistence
 *
 * Data sources:
 * - production_device: Machine status (CCL, DBA, generators, etc.)
 * - production_conveyor_device: Conveyor belt positions and errors
 * - lab_oee: Overall Equipment Effectiveness metrics
 */

const fs = require('fs');
const path = require('path');

let mysql;
try {
  mysql = require('mysql2/promise');
} catch (e) {
  console.warn('[SOM] mysql2 not installed. Run: npm install mysql2');
}

// Configuration from environment
const SOM_HOST = process.env.SOM_HOST || '192.168.0.155';
const SOM_PORT = parseInt(process.env.SOM_PORT || '3306');
const SOM_USER = process.env.SOM_USER || 'root';
const SOM_PASSWORD = process.env.SOM_PASSWORD || 'schneider';
const SOM_DATABASE = process.env.SOM_DATABASE || 'som_lms';
const SOM_POLL_INTERVAL = parseInt(process.env.SOM_POLL_INTERVAL || '30000'); // 30 seconds

// Persistence file
const DATA_FILE = path.join(__dirname, 'som-data.json');

// Alert thresholds config (config/som-alert-thresholds.json, hot-reloadable)
const THRESHOLD_FILE = path.join(__dirname, '..', 'config', 'som-alert-thresholds.json');
const DEFAULT_THRESHOLDS = {
  tool_life: { heads_up: 0.25, warning: 0.10, critical: 0.05 }, // remainingPct
  polish_liquid: { heads_up: 0.30, warning: 0.15, critical: 0.05 },
  slack_channel: '#lab-maintenance',
  slack_rate_limit_hours: 24, // min hours between slack alerts for same tool
};
let ALERT_THRESHOLDS = { ...DEFAULT_THRESHOLDS };
function loadThresholds() {
  try {
    if (fs.existsSync(THRESHOLD_FILE)) {
      const raw = JSON.parse(fs.readFileSync(THRESHOLD_FILE, 'utf8'));
      ALERT_THRESHOLDS = { ...DEFAULT_THRESHOLDS, ...raw };
    }
  } catch (e) {
    console.warn('[SOM] Could not load alert thresholds, using defaults:', e.message);
    ALERT_THRESHOLDS = { ...DEFAULT_THRESHOLDS };
  }
}

const SLACK_BOT_TOKEN = process.env.SLACK_BOT_TOKEN || '';
const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || '';

async function postSlackAlert(text, channel) {
  const ch = channel || ALERT_THRESHOLDS.slack_channel || '#lab-maintenance';
  try {
    if (SLACK_BOT_TOKEN) {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${SLACK_BOT_TOKEN}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: ch, text, mrkdwn: true }),
      });
      const data = await resp.json();
      if (!data.ok) console.warn('[SOM] Slack error:', data.error);
      return data.ok;
    } else if (SLACK_WEBHOOK) {
      const resp = await fetch(SLACK_WEBHOOK, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ channel: ch, text }),
      });
      return resp.ok;
    }
  } catch (e) {
    console.warn('[SOM] Slack alert failed:', e.message);
  }
  return false;
}

function classifyTool(remainingPct, kind) {
  const t = kind === 'polish_liquid' ? ALERT_THRESHOLDS.polish_liquid : ALERT_THRESHOLDS.tool_life;
  if (remainingPct <= t.critical) return 'critical';
  if (remainingPct <= t.warning) return 'warning';
  if (remainingPct <= t.heads_up) return 'heads_up';
  return 'ok';
}

// In-memory state
let devices = [];
let conveyors = [];
let oee = [];
let orders = { byDepartment: [], today: [], total: 0, todayTotal: 0 };
let activeJobs = []; // Individual WIP jobs with department + DVI job#
let alerts = [];
// Per-machine aggregated summaries, one row per device from the aggregated SQL query.
// Shape: { device, category, worst_tool_remaining_pct, worst_tool_status, tool_count,
//          critical_tool_count, warning_tool_count, heads_up_tool_count,
//          worst_polish_pct, worst_polish_status, throughput_today, errors_today,
//          last_update }
let machineSummaries = [];
let machineSummariesLastUpdated = null;
let toolAlerts = []; // One alert per machine where roll-up status !== 'healthy'
let lastSlackAlertByMachine = {}; // key=`${device}:${category}` → 24h rate-limit

// Department mappings (Schneider LMS department IDs)
const DEPARTMENTS = {
  4: { name: 'Production', zone: 'surfacing', description: 'Generators, Coating, Polishing' },
  8: { name: 'Processing', zone: 'coating', description: 'Processing stage' },
  9: { name: 'Complete', zone: 'ship', description: 'Completed/Ready to ship' },
  10: { name: 'Control', zone: 'control', description: 'Control terminals' },
  '-1': { name: 'Error', zone: 'error', description: 'Error state' },
  'null': { name: 'Unassigned', zone: 'picking', description: 'Not yet assigned' }
};
let lastPoll = null;
let lastSuccessfulPoll = null;
let pollInterval = null;
let connection = null;
let isLive = false;
let connectionError = null;
let pollCount = 0;
let failCount = 0;

// Status code mappings
const DEVICE_STATUS = {
  'SBLK': { label: 'Blocked', color: 'amber', severity: 'warning' },
  'SENG': { label: 'Engaged', color: 'green', severity: 'ok' },
  'MINS': { label: 'Manual Insert', color: 'blue', severity: 'info' },
  'SERR': { label: 'Error', color: 'red', severity: 'critical' },
  'SIDL': { label: 'Idle', color: 'gray', severity: 'ok' },
  'SRUN': { label: 'Running', color: 'green', severity: 'ok' },
  'SWAI': { label: 'Waiting', color: 'amber', severity: 'warning' },
  'SOFF': { label: 'Offline', color: 'gray', severity: 'warning' }
};

const CONVEYOR_STATUS = {
  1: { label: 'OK', color: 'green', severity: 'ok' },
  2: { label: 'Warning', color: 'amber', severity: 'warning' },
  3: { label: 'Busy', color: 'blue', severity: 'info' },
  4: { label: 'Error', color: 'red', severity: 'critical' },
  0: { label: 'Unknown', color: 'gray', severity: 'unknown' }
};

// LED status parsing (format: "green;red" where 1=on, 0=off)
function parseLEDStatus(ledStr) {
  if (!ledStr) return { green: false, red: false, status: 'unknown' };
  const [green, red] = ledStr.split(';').map(v => v === '1');
  let status = 'unknown';
  if (green && !red) status = 'running';
  else if (!green && red) status = 'error';
  else if (green && red) status = 'warning';
  else status = 'idle';
  return { green, red, status };
}

// Machine type categorization
function categorizeDevice(model, typeDescr, deviceName) {
  const text = ((model || '') + ' ' + (typeDescr || '') + ' ' + (deviceName || '')).toUpperCase();
  // Deblocking (DBA modulo — end of surfacing line)
  if (text.includes('DBA')) return 'deblocking';
  // Generators (HSC modulo XTS)
  if (text.includes('GENERATOR') || text.includes('SURF') || text.includes('HSC')) return 'generators';
  // Cutters (HSE modulo QS)
  if (text.includes('HSE')) return 'cutters';
  // Blocking / Autoblockers (CBB, CCU, CU1 — start of surfacing line)
  if (text.includes('BOND') || text.includes('CB-') || text.includes('BLOCK') || text.includes('CBB') || text.includes('CCU') || text.includes('CU1')) return 'blocking';
  // Polishing
  if (text.includes('CCP') || text.includes('POLISH') || text.includes('CP1')) return 'polishing';
  // Coating (CCL, COA, DHC, EBC coaters)
  if (text.includes('CCL') || text.includes('COA') || text.includes('DHC') || text.includes('COAT') || text.includes('EBC')) return 'coating';
  // Cleaning (CCS, LCU lens cleaner)
  if (text.includes('CCS') || text.includes('LCU') || text.includes('LC1')) return 'cleaning';
  // Edging
  if (text.includes('EDGE') || text.includes('TRACE')) return 'edging';
  // Assembly terminal
  if (text.includes('ASSEMB')) return 'assembly';
  // QC/Inspection
  if (text.includes('INSPECT') || text.includes('QC') || text.includes('DEFECT')) return 'qc';
  // AR Room
  if (text.includes('AR ROOM') || text.includes('AR_ROOM')) return 'ar_room';
  // Control terminals
  if (text.includes('CONTROL') || text.includes('CCM')) return 'control';
  // Conveyor
  if (text.includes('CONVEYOR') || text.includes('BELT')) return 'conveyor';
  // CLI/DNL - fining/cleaning line
  if (text.includes('CLI') || text.includes('DNL')) return 'fining';
  // Detaper (TSA modulo)
  if (text.includes('TSA')) return 'detaper';
  // Terminal (TER model)
  if (model === 'TER') return 'terminal';
  return 'other';
}

// Categorize station/workstation name to production zone
function categorizeStation(stationName) {
  const text = (stationName || '').toUpperCase();
  // Surfacing sub-zones
  if (text.includes('DBA')) return 'deblocking';
  if (text.includes('GENERATOR') || text.includes('GEN')) return 'generators';
  if (text.includes('BLOCK') || text.includes('CBB') || text.includes('TAPE')) return 'blocking';
  if (text.includes('POLISH') || text.includes('POL')) return 'polishing';
  if (text.includes('FINER') || text.includes('FIN')) return 'fining';
  // Coating
  if (text.includes('COAT') || text.includes('CCL') || text.includes('AR') || text.includes('DIP')) return 'coating';
  if (text.includes('OVEN') || text.includes('CURE')) return 'curing';
  // Edging
  if (text.includes('EDGE') || text.includes('CUT') || text.includes('TRACE')) return 'edging';
  // Assembly/Finishing
  if (text.includes('ASSEMB') || text.includes('MOUNT') || text.includes('FRAME')) return 'assembly';
  if (text.includes('INSPECT') || text.includes('QC') || text.includes('QUALITY')) return 'qc';
  // Control/Admin
  if (text.includes('CONTROL') || text.includes('ADMIN') || text.includes('CCM')) return 'control';
  // Ship
  if (text.includes('SHIP') || text.includes('PACK') || text.includes('COMPLETE')) return 'ship';
  return 'other';
}

// Load persisted data from disk
function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      devices = data.devices || [];
      conveyors = data.conveyors || [];
      oee = data.oee || [];
      orders = data.orders || { byDepartment: [], today: [], total: 0, todayTotal: 0 };
      alerts = data.alerts || [];
      lastSuccessfulPoll = data.lastSuccessfulPoll || null;
      console.log(`[SOM] Loaded ${devices.length} devices, ${conveyors.length} conveyors, ${orders.todayTotal} jobs from disk (last update: ${lastSuccessfulPoll || 'unknown'})`);
      return true;
    }
  } catch (e) {
    console.warn('[SOM] Could not load persisted data:', e.message);
  }
  return false;
}

// Save data to disk
function saveToDisk() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      devices,
      conveyors,
      oee,
      orders,
      alerts,
      lastSuccessfulPoll,
      savedAt: new Date().toISOString()
    }, null, 2));
  } catch (e) {
    console.warn('[SOM] Could not persist data:', e.message);
  }
}

async function connect() {
  if (!mysql) {
    connectionError = 'mysql2 package not installed';
    return false;
  }

  try {
    connection = await mysql.createConnection({
      host: SOM_HOST,
      port: SOM_PORT,
      user: SOM_USER,
      password: SOM_PASSWORD,
      database: SOM_DATABASE,
      ssl: false,
      insecureAuth: true,
      connectTimeout: 15000,
      // Keep connection alive
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000
    });

    // Handle connection errors
    connection.on('error', (err) => {
      console.error('[SOM] Connection error:', err.message);
      isLive = false;
      connectionError = err.message;
      connection = null;
    });

    isLive = true;
    connectionError = null;
    failCount = 0;
    console.log(`[SOM] Connected to MySQL at ${SOM_HOST}:${SOM_PORT}/${SOM_DATABASE}`);
    return true;
  } catch (err) {
    console.error(`[SOM] Connection failed: ${err.message}`);
    isLive = false;
    connectionError = err.message;
    failCount++;
    return false;
  }
}

async function disconnect() {
  if (connection) {
    try {
      await connection.end();
    } catch (e) {
      // Ignore disconnect errors
    }
    connection = null;
    isLive = false;
  }
}

async function reconnect() {
  await disconnect();
  return await connect();
}

// ─────────────────────────────────────────────────────────────────────────────
// Per-machine aggregated summary polling (single query, ~400ms)
// ─────────────────────────────────────────────────────────────────────────────

// Build the 25-branch UNION ALL for tools CTE programmatically rather than
// pasting 25 near-identical SELECT statements. Tool_{i}SN / Tool_{i}C / Tool_{i}M
// are the per-slot serial, cumulative count, and max-life columns.
function buildToolsCte() {
  const branches = [];
  for (let i = 0; i <= 24; i++) {
    branches.push(
      `    SELECT Device, Time, Tool_${i}SN sn, Tool_${i}C c, Tool_${i}M m FROM latest ` +
      `WHERE Tool_${i}SN IS NOT NULL AND Tool_${i}M > 0`
    );
  }
  return branches.join('\n    UNION ALL\n');
}

const MACHINE_SUMMARY_SQL = `
WITH latest AS (
  SELECT t.* FROM production_tool_usage_current t
  JOIN (SELECT Device, Side, MAX(Time) mx FROM production_tool_usage_current
        WHERE Device IS NOT NULL GROUP BY Device, Side) m
    ON m.Device=t.Device AND m.Side=t.Side AND m.mx=t.Time
),
tools AS (
${buildToolsCte()}
),
tool_agg AS (
  SELECT Device, MAX(Time) last_tool_update, COUNT(*) tool_count,
    MIN((m-c)/m) worst_tool_remaining_pct,
    SUM(CASE WHEN (m-c)/m <= 0.05 THEN 1 ELSE 0 END) critical_tool_count,
    SUM(CASE WHEN (m-c)/m >  0.05 AND (m-c)/m <= 0.10 THEN 1 ELSE 0 END) warning_tool_count,
    SUM(CASE WHEN (m-c)/m >  0.10 AND (m-c)/m <= 0.25 THEN 1 ELSE 0 END) heads_up_tool_count
  FROM tools GROUP BY Device
),
pads AS (
  SELECT Device,
    GREATEST(0, (CASE padType WHEN 'B_0' THEN 1200 WHEN 'S+_0' THEN 8000 ELSE 5000 END - Value))
      / (CASE padType WHEN 'B_0' THEN 1200 WHEN 'S+_0' THEN 8000 ELSE 5000 END) rem_pct
  FROM production_tool_usage_current_ccp
),
pad_agg AS (SELECT Device, MIN(rem_pct) worst_polish_pct FROM pads GROUP BY Device),
throughput AS (
  SELECT DeviceID Device, SUM(Lenses) throughput_today FROM view_som_oee
  WHERE TimeUnit='H' AND DATE(Time)=CURDATE() GROUP BY DeviceID
),
devices AS (SELECT Device FROM tool_agg UNION SELECT Device FROM pad_agg)
SELECT d.Device device,
  CASE WHEN d.Device LIKE 'CP%' THEN 'polishing'
       WHEN d.Device LIKE 'HXS%' OR d.Device LIKE 'HSQ%' THEN 'generator'
       WHEN d.Device LIKE 'D2H%' THEN 'deblocking'
       WHEN d.Device LIKE 'CCL%' THEN 'coating'
       WHEN d.Device LIKE 'MIL%' THEN 'milling'
       WHEN d.Device LIKE 'CUT%' THEN 'cutting' ELSE 'other' END category,
  ROUND(ta.worst_tool_remaining_pct,4) worst_tool_remaining_pct,
  CASE WHEN ta.worst_tool_remaining_pct IS NULL THEN NULL
       WHEN ta.worst_tool_remaining_pct <= 0.05 THEN 'critical'
       WHEN ta.worst_tool_remaining_pct <= 0.10 THEN 'warning'
       WHEN ta.worst_tool_remaining_pct <= 0.25 THEN 'heads_up' ELSE 'ok' END worst_tool_status,
  COALESCE(ta.tool_count,0) tool_count,
  COALESCE(ta.critical_tool_count,0) critical_tool_count,
  COALESCE(ta.warning_tool_count,0) warning_tool_count,
  COALESCE(ta.heads_up_tool_count,0) heads_up_tool_count,
  ROUND(pa.worst_polish_pct,4) worst_polish_pct,
  CASE WHEN pa.worst_polish_pct IS NULL THEN NULL
       WHEN pa.worst_polish_pct <= 0.05 THEN 'critical'
       WHEN pa.worst_polish_pct <= 0.10 THEN 'warning'
       WHEN pa.worst_polish_pct <= 0.25 THEN 'heads_up' ELSE 'ok' END worst_polish_status,
  COALESCE(tp.throughput_today,0) throughput_today,
  0 errors_today,
  ta.last_tool_update last_update
FROM devices d
LEFT JOIN tool_agg ta ON ta.Device=d.Device
LEFT JOIN pad_agg pa ON pa.Device=d.Device
LEFT JOIN throughput tp ON tp.Device=d.Device
ORDER BY d.Device`;

// Roll the worst tool state + polish state into a single machine-level status.
// heads_up is bucketed into "warning" per HID spec (only 3 row colors).
function rollupMachineStatus(worstToolState, worstPolishState) {
  const states = [worstToolState, worstPolishState].filter(s => s != null);
  if (states.length === 0) return 'offline';
  if (states.includes('critical')) return 'critical';
  if (states.includes('warning') || states.includes('heads_up')) return 'warning';
  return 'healthy';
}

async function pollMachineSummaries() {
  if (!connection) return false;
  try {
    const [rows] = await connection.query(MACHINE_SUMMARY_SQL);
    machineSummaries = rows.map(r => ({
      device: (r.device || '').trim(),
      category: r.category,
      worst_tool_remaining_pct: r.worst_tool_remaining_pct != null ? Number(r.worst_tool_remaining_pct) : null,
      worst_tool_status: r.worst_tool_status,
      tool_count: Number(r.tool_count) || 0,
      critical_tool_count: Number(r.critical_tool_count) || 0,
      warning_tool_count: Number(r.warning_tool_count) || 0,
      heads_up_tool_count: Number(r.heads_up_tool_count) || 0,
      worst_polish_pct: r.worst_polish_pct != null ? Number(r.worst_polish_pct) : null,
      worst_polish_status: r.worst_polish_status,
      throughput_today: Number(r.throughput_today) || 0,
      errors_today: Number(r.errors_today) || 0,
      last_update: r.last_update,
    }));
    machineSummariesLastUpdated = new Date().toISOString();

    checkMachineAlerts();
    return true;
  } catch (e) {
    console.warn('[SOM] pollMachineSummaries error:', e.message);
    return false;
  }
}

// Build one alert per machine whose rolled-up status is not healthy.
// Slack is rate-limited per `${device}:${category}` on a 24h window.
function checkMachineAlerts() {
  const now = Date.now();
  const rateMs = (ALERT_THRESHOLDS.slack_rate_limit_hours || 24) * 3600 * 1000;
  const nowIso = new Date().toISOString();
  const newAlerts = [];

  for (const m of machineSummaries) {
    const status = rollupMachineStatus(m.worst_tool_status, m.worst_polish_status);
    if (status === 'healthy' || status === 'offline') continue;

    const key = `${m.device}:${m.category}`;
    newAlerts.push({
      key,
      device: m.device,
      category: m.category,
      status, // 'critical' | 'warning'
      worstToolRemainingPct: m.worst_tool_remaining_pct,
      worstPolishPct: m.worst_polish_pct,
      timestamp: nowIso,
    });

    // Slack only on critical, rate-limited per machine+category
    if (status === 'critical') {
      const last = lastSlackAlertByMachine[key] || 0;
      if (now - last > rateMs) {
        lastSlackAlertByMachine[key] = now;
        const parts = [];
        if (m.worst_tool_status === 'critical' && m.worst_tool_remaining_pct != null) {
          parts.push(`worst tool at ${(m.worst_tool_remaining_pct * 100).toFixed(1)}%`);
        }
        if (m.worst_polish_status === 'critical' && m.worst_polish_pct != null) {
          parts.push(`worst polish pad at ${(m.worst_polish_pct * 100).toFixed(1)}%`);
        }
        const detail = parts.length ? ` — ${parts.join(', ')}` : '';
        postSlackAlert(
          `:rotating_light: *${m.device} critical* (${m.category})${detail}`
        ).catch(() => {});
      }
    }
  }

  // Sort: critical first, then warning; within a bucket lowest remaining first
  const order = { critical: 0, warning: 1 };
  newAlerts.sort((a, b) => {
    const s = (order[a.status] ?? 9) - (order[b.status] ?? 9);
    if (s !== 0) return s;
    const aPct = Math.min(a.worstToolRemainingPct ?? 1, a.worstPolishPct ?? 1);
    const bPct = Math.min(b.worstToolRemainingPct ?? 1, b.worstPolishPct ?? 1);
    return aPct - bPct;
  });

  toolAlerts = newAlerts;
}

// Map SQL category → HID-spec machine type. SQL already emits HID-friendly values
// for CP/HXS/HSQ/D2H/CCL/MIL/CUT; blocking/surfacing/edging/other fall through.
function hidMachineType(sqlCategory) {
  const allowed = new Set([
    'polishing', 'cutting', 'milling', 'blocking', 'surfacing',
    'edging', 'coating', 'generator', 'deblocking', 'other'
  ]);
  return allowed.has(sqlCategory) ? sqlCategory : 'other';
}

async function poll() {
  lastPoll = new Date().toISOString();
  pollCount++;

  // Check if connection is still alive
  if (connection) {
    try {
      await connection.ping();
    } catch (e) {
      console.warn('[SOM] Connection lost, reconnecting...');
      isLive = false;
      connection = null;
    }
  }

  // Try to connect if not connected
  if (!connection) {
    const connected = await connect();
    if (!connected) {
      console.warn(`[SOM] Poll #${pollCount} - OFFLINE (${connectionError})`);
      return false;
    }
  }

  try {
    // Query production devices (machines)
    const [deviceRows] = await connection.query(`
      SELECT
        Device, Model, Status, Event, EventEnglish, LEDStatus,
        LastOrder, Count1, Count2, Count3, TypeDescr,
        DepartmentID, isActive, CycleTimePerLensSec
      FROM production_device
      WHERE isActive = 1 OR isActive IS NULL
    `);

    devices = deviceRows.map(row => {
      const statusInfo = DEVICE_STATUS[row.Status] || { label: row.Status || 'Unknown', color: 'gray', severity: 'unknown' };
      const ledInfo = parseLEDStatus(row.LEDStatus);
      const category = categorizeDevice(row.Model, row.TypeDescr, row.Device);

      return {
        id: row.Device,
        name: row.Device,
        model: row.Model,
        typeDescription: row.TypeDescr,
        category,
        departmentId: row.DepartmentID,
        status: row.Status,
        statusLabel: statusInfo.label,
        statusColor: statusInfo.color,
        severity: statusInfo.severity,
        event: row.EventEnglish || row.Event, // Prefer English
        eventOriginal: row.Event,
        led: ledInfo,
        lastOrder: row.LastOrder,
        counts: {
          count1: row.Count1 || 0,
          count2: row.Count2 || 0,
          count3: row.Count3 || 0
        },
        cycleTime: row.CycleTimePerLensSec || 0,
        isActive: row.isActive
      };
    });

    // Query conveyor positions
    const [conveyorRows] = await connection.query(`
      SELECT Device, Status, Time, Event
      FROM production_conveyor_device
    `);

    conveyors = conveyorRows.map(row => {
      const statusInfo = CONVEYOR_STATUS[row.Status] || CONVEYOR_STATUS[0];
      return {
        id: row.Device,
        position: row.Device,
        status: row.Status,
        statusLabel: statusInfo.label,
        statusColor: statusInfo.color,
        severity: statusInfo.severity,
        event: row.Event,
        lastUpdate: row.Time
      };
    });

    // Query recent OEE data (last 24 hours)
    try {
      const [oeeRows] = await connection.query(`
        SELECT DeviceID, Time, OEE, Availability, Performance, Quality, Lenses
        FROM lab_oee
        WHERE Time > DATE_SUB(NOW(), INTERVAL 24 HOUR)
        ORDER BY Time DESC
        LIMIT 100
      `);
      oee = oeeRows;
    } catch (e) {
      // OEE table might not exist or have different schema
      oee = [];
    }

    // Query order/job tracking by department and station
    try {
      // Total count
      const [totalCount] = await connection.query('SELECT COUNT(*) as cnt FROM order_header');

      // Jobs by department (all time)
      const [byDeptAll] = await connection.query(`
        SELECT CurrentDepartmentID as dept, COUNT(*) as jobs
        FROM order_header
        GROUP BY CurrentDepartmentID
        ORDER BY jobs DESC
      `);

      // Today's jobs by department
      const [byDeptToday] = await connection.query(`
        SELECT CurrentDepartmentID as dept, COUNT(*) as jobs
        FROM order_header
        WHERE EntryDate >= CURDATE()
        GROUP BY CurrentDepartmentID
        ORDER BY jobs DESC
      `);

      // Today's total
      const [todayCount] = await connection.query(`
        SELECT COUNT(*) as cnt FROM order_header WHERE EntryDate >= CURDATE()
      `);

      // Today's jobs by station/workstation for more granular breakdown
      let byStation = [];
      try {
        const [stationRows] = await connection.query(`
          SELECT
            o.CurrentWorkstationID as stationId,
            COALESCE(w.Name, CONCAT('Station ', o.CurrentWorkstationID)) as stationName,
            o.CurrentDepartmentID as deptId,
            COUNT(*) as jobs
          FROM order_header o
          LEFT JOIN workstation w ON o.CurrentWorkstationID = w.WorkstationID
          WHERE o.EntryDate >= CURDATE() AND o.CurrentWorkstationID IS NOT NULL
          GROUP BY o.CurrentWorkstationID, o.CurrentDepartmentID
          ORDER BY jobs DESC
        `);
        byStation = stationRows.map(r => ({
          stationId: r.stationId,
          stationName: r.stationName || `Station ${r.stationId}`,
          departmentId: r.deptId,
          zone: categorizeStation(r.stationName),
          jobs: r.jobs
        }));
      } catch (stationErr) {
        // CurrentWorkstationID doesn't exist in this SOM install — skip station breakdown
        if (!this._stationWarnLogged) {
          console.log('[SOM] Station breakdown unavailable (no CurrentWorkstationID column) — skipping');
          this._stationWarnLogged = true;
        }
      }

      orders = {
        total: totalCount[0].cnt,
        todayTotal: todayCount[0].cnt,
        byDepartment: byDeptAll.map(r => ({
          departmentId: r.dept,
          departmentName: DEPARTMENTS[r.dept]?.name || `Dept ${r.dept}`,
          zone: DEPARTMENTS[r.dept]?.zone || 'unknown',
          jobs: r.jobs
        })),
        today: byDeptToday.map(r => ({
          departmentId: r.dept,
          departmentName: DEPARTMENTS[r.dept]?.name || `Dept ${r.dept}`,
          zone: DEPARTMENTS[r.dept]?.zone || 'unknown',
          jobs: r.jobs
        })),
        byStation
      };
    } catch (e) {
      console.warn('[SOM] Could not query orders:', e.message);
    }

    // Query individual active WIP jobs (not Complete/dept 9)
    try {
      const [jobRows] = await connection.query(`
        SELECT
          TRIM(OrdNumbH) as dviJob,
          TRIM(OrdNumb) as somOrder,
          CurrentDepartmentID as dept,
          previousDepartmentID as prevDept,
          Side,
          EntryDate,
          EntryTime,
          TRIM(FrameNo) as frameNo,
          TRIM(FReference) as frameRef,
          TRIM(LDS) as lds,
          TRIM(Reference) as reference
        FROM order_header
        WHERE EntryDate >= DATE_SUB(CURDATE(), INTERVAL 7 DAY)
          AND CurrentDepartmentID != 9
        ORDER BY EntryDate DESC, EntryTime DESC
      `);
      activeJobs = jobRows.map(r => ({
        dviJob: r.dviJob,
        somOrder: r.somOrder,
        dept: r.dept,
        deptName: DEPARTMENTS[r.dept]?.name || `Dept ${r.dept}`,
        zone: DEPARTMENTS[r.dept]?.zone || 'unknown',
        prevDept: r.prevDept,
        side: r.Side,
        entryDate: r.EntryDate,
        entryTime: r.EntryTime,
        frameNo: r.frameNo,
        frameRef: r.frameRef,
        lds: r.lds,
        reference: r.reference
      }));
    } catch (e) {
      console.warn('[SOM] Could not query active jobs:', e.message);
    }

    // Build alerts from errors
    alerts = [];

    // Device alerts
    devices.forEach(device => {
      if (device.severity === 'critical' || device.severity === 'warning') {
        alerts.push({
          id: `dev-${device.id}`,
          type: 'device',
          source: device.id,
          model: device.model,
          category: device.category,
          severity: device.severity,
          message: device.event || `${device.statusLabel}`,
          timestamp: lastPoll
        });
      }
    });

    // Conveyor alerts (errors only)
    conveyors.forEach(conv => {
      if (conv.severity === 'critical') {
        alerts.push({
          id: `conv-${conv.id}`,
          type: 'conveyor',
          source: conv.id,
          severity: conv.severity,
          message: conv.event,
          timestamp: conv.lastUpdate
        });
      }
    });

    // Sort alerts by severity
    alerts.sort((a, b) => {
      const severityOrder = { critical: 0, warning: 1, info: 2, ok: 3 };
      return (severityOrder[a.severity] || 4) - (severityOrder[b.severity] || 4);
    });

    // Per-machine aggregated summary (single query — replaces pollTools)
    await pollMachineSummaries();

    lastSuccessfulPoll = lastPoll;
    isLive = true;
    connectionError = null;

    // Persist to disk
    saveToDisk();

    // Enrich unified jobs table with SOM order_header data
    try {
      const db = require('./db');
      let somEnriched = 0;
      for (const j of activeJobs) {
        if (j.dviJob) {
          db.upsertJobFromSOM(j);
          somEnriched++;
        }
      }
      if (somEnriched > 0) console.log(`[SOM] Enriched ${somEnriched} jobs in unified table`);
    } catch (e) { console.warn('[SOM] Jobs enrichment error:', e.message); }

    console.log(`[SOM] Poll #${pollCount} - LIVE: ${devices.length} devices, ${conveyors.length} conveyors, ${orders.todayTotal} jobs today, ${alerts.length} alerts, ${machineSummaries.length} machine summaries, ${toolAlerts.length} machine alerts`);
    return true;

  } catch (err) {
    console.error(`[SOM] Poll #${pollCount} - ERROR: ${err.message}`);
    isLive = false;
    connectionError = err.message;
    failCount++;

    // Connection might be dead
    if (err.code === 'PROTOCOL_CONNECTION_LOST' || err.code === 'ECONNRESET') {
      connection = null;
    }

    return false;
  }
}

// Public API
module.exports = {
  /**
   * Start polling SOM database
   */
  async start() {
    console.log(`[SOM] Starting adapter`);
    console.log(`[SOM] Host: ${SOM_HOST}:${SOM_PORT}/${SOM_DATABASE}`);
    console.log(`[SOM] Poll interval: ${SOM_POLL_INTERVAL}ms`);

    // Load thresholds + any persisted data first
    loadThresholds();
    loadFromDisk();

    // Start initial poll asynchronously (don't block server startup)
    poll().catch(e => console.error('[SOM] Initial poll failed:', e.message));

    // Start polling interval
    pollInterval = setInterval(async () => {
      await poll();
    }, SOM_POLL_INTERVAL);
  },

  /**
   * Stop polling
   */
  async stop() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    await disconnect();
    console.log('[SOM] Adapter stopped');
  },

  /**
   * Get all production devices (machines)
   */
  getDevices() {
    return {
      devices,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
      summary: {
        total: devices.length,
        running: devices.filter(d => d.severity === 'ok' && d.status !== 'SIDL').length,
        idle: devices.filter(d => d.status === 'SIDL').length,
        errors: devices.filter(d => d.severity === 'critical').length,
        warnings: devices.filter(d => d.severity === 'warning').length,
        byCategory: devices.reduce((acc, d) => {
          acc[d.category] = (acc[d.category] || 0) + 1;
          return acc;
        }, {})
      }
    };
  },

  /**
   * Get conveyor positions
   */
  getConveyors() {
    return {
      conveyors,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
      summary: {
        total: conveyors.length,
        ok: conveyors.filter(c => c.severity === 'ok').length,
        errors: conveyors.filter(c => c.severity === 'critical').length,
        warnings: conveyors.filter(c => c.severity === 'warning').length
      }
    };
  },

  /**
   * Get OEE metrics
   */
  getOEE() {
    return {
      oee,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError
    };
  },

  /**
   * Get lens-per-hour by machine type (for throughput chart)
   * Queries lab_oee for the last 24h, groups by hour and device category
   */
  async getLensPerHour(options = {}) {
    if (!connection) return { series: [], isLive: false };
    try {
      const { date, hours } = options;
      let whereClause, params;
      if (date) {
        // SOM MySQL is in Pacific time — no UTC conversion needed
        // Show 24h rolling: previous day 4PM through current day 4PM
        // This matches the SOM Control Center's default view
        const prevDay = new Date(date + 'T00:00:00');
        prevDay.setDate(prevDay.getDate() - 1);
        const prevStr = prevDay.toISOString().slice(0, 10);
        whereClause = "TimeUnit = 'H' AND ((DATE(Time) = ? AND HOUR(Time) >= 16) OR (DATE(Time) = ? AND HOUR(Time) < 16))";
        params = [prevStr, date];
      } else {
        whereClause = "TimeUnit = 'H' AND Time > DATE_SUB(NOW(), INTERVAL ? HOUR)";
        params = [hours || 24];
      }
      const [rows] = await connection.query(`
        SELECT
          DeviceID,
          DevModel as Model,
          DeviceType as TypeDescr,
          DATE_FORMAT(Time, '%Y-%m-%d %H:00:00') as hour,
          SUM(Lenses) as lenses
        FROM view_som_oee
        WHERE ${whereClause}
        GROUP BY DeviceID, DevModel, DeviceType, hour
        ORDER BY hour ASC, DeviceID
      `, params);

      // Group by SOM device type (matches SOM Control Center labels)
      const TYPE_LABELS = {
        'SBK': 'Blocker', 'SEN': 'Engraver', 'SST': 'Stacker', 'SPO': 'Polisher',
        'SCO': 'Coater', 'SDB': 'De blocker', 'SED': 'Edger', 'SGE': 'Generator',
        'SCU': 'Cleaning Unit', 'SDT': 'De taper', 'SLI': 'Line input', 'SLO': 'Line output',
        'SCI': 'Cosmetic Insp', 'SME': 'Measurement',
      };
      const byCategory = {};
      for (const row of rows) {
        const cat = TYPE_LABELS[row.TypeDescr] || row.TypeDescr || row.Model || 'Unknown';
        if (!byCategory[cat]) byCategory[cat] = {};
        if (!byCategory[cat][row.hour]) byCategory[cat][row.hour] = 0;
        byCategory[cat][row.hour] += parseInt(row.lenses) || 0;
      }

      // Build full 24h window: previous day 4PM through current day 3PM
      const allHours = [];
      if (date) {
        const prevDay = new Date(date + 'T00:00:00');
        prevDay.setDate(prevDay.getDate() - 1);
        const prevStr = prevDay.toISOString().slice(0, 10);
        for (let h = 16; h < 24; h++) {
          allHours.push(`${prevStr} ${String(h).padStart(2,'0')}:00:00`);
        }
        for (let h = 0; h < 16; h++) {
          allHours.push(`${date} ${String(h).padStart(2,'0')}:00:00`);
        }
      } else {
        allHours.push(...[...new Set(rows.map(r => r.hour))].sort());
      }

      const series = Object.entries(byCategory).map(([category, hourData]) => ({
        name: category,
        data: allHours.map(h => ({ hour: h, lenses: hourData[h] || 0 }))
      }));

      return { series, hours: allHours, isLive, lastPoll };
    } catch (e) {
      console.warn('[SOM] getLensPerHour error:', e.message);
      return { series: [], isLive, error: e.message };
    }
  },

  /**
   * Get order/job tracking by department
   */
  getOrders() {
    return {
      orders,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
      summary: {
        total: orders.total,
        todayTotal: orders.todayTotal,
        inProduction: orders.today.find(d => d.departmentId === 4)?.jobs || 0,
        complete: orders.today.find(d => d.departmentId === 9)?.jobs || 0,
        unassigned: orders.today.find(d => d.departmentId === null)?.jobs || 0
      }
    };
  },

  /**
   * Get individual active WIP jobs with department tracking
   */
  getActiveJobs() {
    return {
      jobs: activeJobs,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
      summary: {
        total: activeJobs.length,
        byDept: activeJobs.reduce((acc, j) => {
          const key = j.zone || 'unknown';
          acc[key] = (acc[key] || 0) + 1;
          return acc;
        }, {})
      }
    };
  },

  /**
   * Machine summary for HID — one entry per machine with rolled-up status dot.
   * Matches the per-machine aggregation contract (HID spec).
   */
  getMachineSummary() {
    const machines = machineSummaries.map(m => {
      const type = hidMachineType(m.category);
      const status = rollupMachineStatus(m.worst_tool_status, m.worst_polish_status);
      const worstTool = m.worst_tool_status
        ? { pct: m.worst_tool_remaining_pct, state: m.worst_tool_status }
        : null;
      const polishPad = m.worst_polish_status
        ? { pct: m.worst_polish_pct, state: m.worst_polish_status }
        : null;
      return {
        id: m.device,
        name: m.device,
        type,
        status,
        worstTool,
        polishPad,
        errorsToday: m.errors_today,
        throughputToday: m.throughput_today,
        throughputUnit: 'lenses',
        lastUpdate: m.last_update ? new Date(m.last_update).toISOString() : null,
      };
    });

    return {
      updatedAt: machineSummariesLastUpdated || new Date().toISOString(),
      isLive,
      machines,
    };
  },

  /**
   * Per-machine detail for HID drawer — lazy, only queried on drawer open.
   * Not on hot polling path.
   */
  async getMachineDetail(machineId) {
    if (!connection) {
      return { machineId, error: 'offline', isLive: false };
    }
    const id = String(machineId || '').trim();
    if (!id) return { error: 'machineId required' };

    const [latestRows] = await connection.query(
      `SELECT t.* FROM production_tool_usage_current t
       JOIN (SELECT Device, Side, MAX(Time) mx FROM production_tool_usage_current
             WHERE Device = ? GROUP BY Device, Side) m
         ON m.Device=t.Device AND m.Side=t.Side AND m.mx=t.Time`,
      [id]
    );

    const tools = [];
    let lastUpdate = null;
    for (const row of latestRows) {
      if (row.Time && (!lastUpdate || row.Time > lastUpdate)) lastUpdate = row.Time;
      for (let i = 0; i <= 24; i++) {
        const sn = row[`Tool_${i}SN`];
        const used = Number(row[`Tool_${i}C`]);
        const max = Number(row[`Tool_${i}M`]);
        if (!sn || !max || max <= 0) continue;
        const remaining = Math.max(0, max - used);
        const remainingPct = remaining / max;
        let status;
        if (remainingPct <= 0.05) status = 'critical';
        else if (remainingPct <= 0.10) status = 'warning';
        else if (remainingPct <= 0.25) status = 'heads_up';
        else status = 'ok';
        tools.push({
          slot: i,
          side: row.Side,
          serialNumber: String(sn).trim(),
          used, max, remaining,
          remainingPct: Number(remainingPct.toFixed(4)),
          status,
        });
      }
    }

    // Polish pads — compute remainingPct using the same pad-type max map as the SQL
    const polishPads = [];
    try {
      const [padRows] = await connection.query(
        `SELECT Device, padType, Side, SN, Value,
           GREATEST(0, (CASE padType WHEN 'B_0' THEN 1200 WHEN 'S+_0' THEN 8000 ELSE 5000 END - Value))
             / (CASE padType WHEN 'B_0' THEN 1200 WHEN 'S+_0' THEN 8000 ELSE 5000 END) rem_pct
         FROM production_tool_usage_current_ccp
         WHERE Device = ?`,
        [id]
      );
      for (const p of padRows) {
        const pct = p.rem_pct != null ? Number(p.rem_pct) : null;
        let status = null;
        if (pct != null) {
          if (pct <= 0.05) status = 'critical';
          else if (pct <= 0.10) status = 'warning';
          else if (pct <= 0.25) status = 'heads_up';
          else status = 'ok';
        }
        polishPads.push({
          side: p.Side,
          padType: p.padType,
          serialNumber: p.SN ? String(p.SN).trim() : null,
          remainingPct: pct != null ? Number(pct.toFixed(4)) : null,
          status,
        });
      }
    } catch (_) {
      // Table may not exist on all installs
    }

    // 24 hourly throughput buckets for today from view_som_oee
    let throughput24h = [];
    try {
      const [oeeRows] = await connection.query(
        `SELECT HOUR(Time) hr, SUM(Lenses) lenses
         FROM view_som_oee
         WHERE TimeUnit='H' AND DATE(Time)=CURDATE() AND DeviceID = ?
         GROUP BY HOUR(Time)`,
        [id]
      );
      const byHour = new Map(oeeRows.map(r => [Number(r.hr), Number(r.lenses) || 0]));
      throughput24h = Array.from({ length: 24 }, (_, h) => ({
        hour: h,
        lenses: byHour.get(h) || 0,
      }));
    } catch (e) {
      throughput24h = [];
    }

    return {
      machineId: id,
      tools,
      polishPads,
      throughput24h,
      lastUpdate: lastUpdate ? new Date(lastUpdate).toISOString() : null,
    };
  },

  /**
   * Active per-machine alerts (one row per machine with status !== healthy).
   */
  getToolAlerts() {
    return {
      alerts: toolAlerts,
      isLive,
      lastPoll,
      thresholds: ALERT_THRESHOLDS,
      summary: {
        total: toolAlerts.length,
        critical: toolAlerts.filter(a => a.status === 'critical').length,
        warning: toolAlerts.filter(a => a.status === 'warning').length,
      },
    };
  },

  /**
   * Reload alert thresholds from disk (hot-reload without restarting server).
   * Thresholds are currently embedded in the aggregated SQL; reloading re-evaluates
   * the in-memory alert rollup against the latest snapshot.
   */
  reloadThresholds() {
    loadThresholds();
    checkMachineAlerts();
    return ALERT_THRESHOLDS;
  },

  /**
   * Get current alerts (errors and warnings)
   */
  getAlerts() {
    return {
      alerts,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
      summary: {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        warning: alerts.filter(a => a.severity === 'warning').length
      }
    };
  },

  /**
   * Get device by ID
   */
  getDevice(deviceId) {
    return devices.find(d => d.id === deviceId) || null;
  },

  /**
   * Get AI-ready context for Lab Assistant AI queries
   */
  getAIContext() {
    const criticalDevices = devices.filter(d => d.severity === 'critical');
    const warningDevices = devices.filter(d => d.severity === 'warning');
    const criticalConveyors = conveyors.filter(c => c.severity === 'critical');

    return {
      source: 'SOM Control Center',
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionStatus: isLive ? 'connected' : `disconnected: ${connectionError}`,
      machines: {
        total: devices.length,
        running: devices.filter(d => d.severity === 'ok' && d.status !== 'SIDL').length,
        errors: criticalDevices.length,
        warnings: warningDevices.length,
        byCategory: devices.reduce((acc, d) => {
          if (!acc[d.category]) acc[d.category] = [];
          acc[d.category].push({
            id: d.id,
            model: d.model,
            status: d.statusLabel,
            event: d.event
          });
          return acc;
        }, {})
      },
      conveyors: {
        total: conveyors.length,
        errors: criticalConveyors.length,
        errorPositions: criticalConveyors.map(c => ({
          position: c.id,
          error: c.event
        }))
      },
      jobs: {
        totalInSystem: orders.total,
        todayTotal: orders.todayTotal,
        todayByDepartment: orders.today.map(d => ({
          department: d.departmentName,
          zone: d.zone,
          jobs: d.jobs
        }))
      },
      activeAlerts: alerts.slice(0, 10).map(a => ({
        source: a.source,
        severity: a.severity,
        message: a.message
      }))
    };
  },

  /**
   * Force refresh data
   */
  async refresh() {
    const success = await poll();
    return {
      success,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError
    };
  },

  /**
   * Check connection health
   */
  getHealth() {
    return {
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
      host: SOM_HOST,
      port: SOM_PORT,
      database: SOM_DATABASE,
      pollInterval: SOM_POLL_INTERVAL,
      pollCount,
      failCount,
      deviceCount: devices.length,
      conveyorCount: conveyors.length,
      alertCount: alerts.length
    };
  }
};
