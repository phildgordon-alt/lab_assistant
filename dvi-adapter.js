/**
 * dvi-adapter.js
 * Lab_Assistant — DVI live job data integration for Assembly Dashboard
 *
 * DVI (Digital Vision Inc / Digital Workflow Interface) is the optical lab
 * management system used to track Rx jobs through the production workflow.
 *
 * AUTH: API Key — set via environment variable DVI_API_KEY
 *       Some DVI versions use Basic Auth (DVI_USER + DVI_PASS) — toggle below.
 *
 * POLL INTERVAL: 90 seconds — DVI job status changes on operator scan events,
 *                not continuously. 90s keeps us fresh without hammering the API.
 *
 * ENDPOINTS USED (adjust path to match your DVI version):
 *   GET /api/v1/jobs/active            → jobs currently in assembly
 *   GET /api/v1/jobs/completed?date=   → jobs completed today
 *   GET /api/v1/jobs/pending           → jobs queued for assembly
 *   GET /api/v1/jobs?status=hold       → jobs on QC/remake hold
 *
 * USAGE — add to oven-timer-server.js:
 *   const dvi = require('./dvi-adapter');
 *   dvi.start();
 *   app.get('/api/dvi/jobs',       (req,res) => res.json(dvi.getJobs(req.query)));
 *   app.get('/api/dvi/stats',      (req,res) => res.json(dvi.getStats()));
 *   app.get('/api/dvi/operator/:name', (req,res) => res.json(dvi.getOperatorStats(req.params.name)));
 *   app.get('/api/dvi/context',    (req,res) => res.json(dvi.getAIContext()));
 *
 * DVI VERSION NOTES:
 * DVI comes in several versions (VisionWeb, OfficeMate/Eyefinity, custom installs).
 * The field names below represent the most common schema.
 * You may need to adjust field mappings in normalizeDVIJob() to match your version.
 * Request a data dictionary from your DVI admin or inspect a sample API response.
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:     process.env.DVI_URL      || '',
  apiKey:      process.env.DVI_API_KEY  || '',
  apiUser:     process.env.DVI_USER     || '',       // for Basic Auth installs
  apiPass:     process.env.DVI_PASS     || '',
  authMethod:  process.env.DVI_AUTH     || 'apikey', // 'apikey' or 'basic'
  pollInterval: parseInt(process.env.DVI_POLL_MS || '90000'),
  mockMode:    !process.env.DVI_URL,

  // Assembly stage name in DVI — what DVI calls the assembly/insert step
  // Common values: 'ASSEMBLY', 'INSERT', 'FRAME_MOUNT', 'FINISHING'
  assemblyStage: process.env.DVI_ASSEMBLY_STAGE || 'ASSEMBLY',

  // How many days of history to keep in memory
  historyDays: 7,

  slackWebhook: process.env.SLACK_WEBHOOK || '',
};

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CACHE
// ─────────────────────────────────────────────────────────────────────────────
let cache = {
  jobs:        [],     // all jobs (active + pending + hold)
  completedToday: [],  // jobs completed today
  lastSync:    null,
  syncStatus:  'pending',
  syncError:   null,
  totalFetched: 0,
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTH HEADERS
// ─────────────────────────────────────────────────────────────────────────────
function authHeaders() {
  if (CONFIG.authMethod === 'basic') {
    const token = Buffer.from(`${CONFIG.apiUser}:${CONFIG.apiPass}`).toString('base64');
    return { 'Authorization': `Basic ${token}`, 'Content-Type': 'application/json', 'Accept': 'application/json' };
  }
  // API Key — common DVI header names:
  return {
    'X-API-Key':     CONFIG.apiKey,       // most common
    'Authorization': `Bearer ${CONFIG.apiKey}`, // some installs
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH WRAPPER
// ─────────────────────────────────────────────────────────────────────────────
async function dviFetch(path, params = {}) {
  const url = new URL(`${CONFIG.baseUrl}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const resp = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(10000),
  });
  if (!resp.ok) throw new Error(`DVI ${path} → HTTP ${resp.status} ${resp.statusText}`);
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZE — map DVI response to Lab_Assistant standard job schema
// ─────────────────────────────────────────────────────────────────────────────
function normalizeDVIJob(j) {
  /*
   * DVI field names vary by version. Common variants documented inline.
   * Your DVI admin can provide a full data dictionary.
   * Most critical fields: job ID, status, operator, timestamps.
   */
  return {
    // Job identification
    id:          j.job_id          || j.order_number    || j.lab_order_id   || j.id,
    rxId:        j.rx_id           || j.prescription_id || null,
    patient:     j.patient_name    || j.patient         || j.account_name   || null,

    // Rx specification (useful for blank cross-reference with Kardex)
    rx: {
      sphere:    j.rx_sphere       || j.sph             || j.od_sphere      || null,
      cylinder:  j.rx_cylinder     || j.cyl             || j.od_cylinder    || null,
      axis:      j.rx_axis         || j.axis             || null,
      add:       j.rx_add          || j.add              || null,
    },

    // Product
    lensType:    j.lens_type        || j.product_name    || j.material       || '',
    coatingType: j.coating_type     || j.coating         || j.treatment      || '',
    frameRef:    j.frame_reference  || j.frame           || j.frame_sku      || null,

    // Status — normalized to our standard values
    status:      normalizeStatus(j.status || j.stage || j.current_stage),
    stage:       j.stage           || j.current_stage   || j.status         || '',

    // People + location
    operator:    j.operator        || j.assembled_by     || j.technician     || null,
    operatorId:  j.operator_id     || j.tech_id          || null,
    stationId:   j.station         || j.station_id       || j.workstation     || null,

    // Timing
    receivedAt:      j.received_at     || j.order_date        || j.created_at     || null,
    startedAt:       j.assembly_start  || j.started_at        || j.in_progress_at || null,
    completedAt:     j.completed_at    || j.assembly_end      || j.finished_at    || null,
    dueDate:         j.due_date        || j.promised_date      || j.ship_date      || null,
    minutesAtStation: j.minutes_at_station || computeMinutes(j.assembly_start || j.started_at, j.completed_at || j.assembly_end) || null,

    // Priority
    isRush:          j.rush            || j.priority === 'rush' || j.priority === 'RUSH' ||
                     j.priority_flag === 1 || j.stat_order === true || false,
    priority:        j.priority        || j.priority_code     || 'normal',

    // Quality
    remake:          j.remake          || j.is_remake         || j.redo           || false,
    remakeReason:    j.remake_reason   || j.redo_reason        || null,
    holdReason:      j.hold_reason     || j.on_hold_reason     || null,
  };
}

function normalizeStatus(s) {
  if (!s) return 'waiting';
  const sl = String(s).toLowerCase().replace(/[_\s-]/g, '');
  if (['completed','done','finished','assembled','shipped','complete'].some(v=>sl.includes(v))) return 'completed';
  if (['inprogress','active','assembling','inassembly','working'].some(v=>sl.includes(v))) return 'active';
  if (['hold','onhold','qchold','remake','pending_qc','blocked'].some(v=>sl.includes(v))) return 'hold';
  return 'waiting';
}

function computeMinutes(start, end) {
  if (!start) return null;
  const s = new Date(start);
  const e = end ? new Date(end) : new Date();
  return Math.round((e - s) / 60000);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN POLL
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
  if (CONFIG.mockMode) { loadMock(); return; }

  try {
    const today = new Date().toISOString().slice(0, 10);

    // Parallel fetch all job states
    const [activeResp, pendingResp, holdResp, completedResp] = await Promise.allSettled([
      dviFetch('/api/v1/jobs/active'),
      dviFetch('/api/v1/jobs/pending', { stage: CONFIG.assemblyStage }),
      dviFetch('/api/v1/jobs', { status: 'hold', stage: CONFIG.assemblyStage }),
      dviFetch('/api/v1/jobs/completed', { date: today }),
    ]);

    const flatten = (res) => res.status === 'fulfilled' ? (res.value.jobs || res.value || []) : [];

    const active    = flatten(activeResp).map(normalizeDVIJob);
    const pending   = flatten(pendingResp).map(normalizeDVIJob);
    const onHold    = flatten(holdResp).map(normalizeDVIJob);
    const completed = flatten(completedResp).map(normalizeDVIJob);

    // De-duplicate by job ID (active may overlap with completed during transitions)
    const allById = new Map();
    [...pending, ...onHold, ...active, ...completed].forEach(j => allById.set(j.id, j));

    const allJobs = Array.from(allById.values());

    cache = {
      jobs:        allJobs.filter(j => j.status !== 'completed'),
      completedToday: completed,
      lastSync:    new Date().toISOString(),
      syncStatus:  'ok',
      syncError:   null,
      totalFetched: allJobs.length,
    };

    console.log(`[DVI] ✓ Sync: ${active.length} active, ${pending.length} pending, ${onHold.length} hold, ${completed.length} completed today`);

    // Alert on high hold count
    if (onHold.length >= 5 && CONFIG.slackWebhook) {
      sendSlackAlert(`⚠️ Assembly hold queue: *${onHold.length} jobs on hold*. Check QC station.`);
    }

  } catch (err) {
    cache.syncStatus = 'error';
    cache.syncError  = err.message;
    console.error('[DVI] Poll failed:', err.message);
  }
}

async function sendSlackAlert(text) {
  try {
    await fetch(CONFIG.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch {}
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA — realistic assembly job data for development / demo
// ─────────────────────────────────────────────────────────────────────────────
function loadMock() {
  const operators = ['Maria Rodriguez','James Liu','Sofia Patel','Diego Reyes','Aisha Johnson','Liam Chen'];
  const coatings  = ['AR','Blue Cut','Hard Coat','Polarized','Mirror','Transitions'];
  const lenses    = ['1.67 Hi-Index','1.56 Standard','1.50 CR-39','1.74 Ultra-Thin'];
  const statuses  = ['active','active','active','waiting','waiting','waiting','completed','hold'];
  const rxSpecs   = ['-1.00','-2.50','+0.75','-3.25','+1.50','0.00','-0.50','+2.00'];
  const cyls      = ['-0.25','-0.50','0.00','-0.75','-1.00'];

  const jobs = Array.from({ length: 60 }, (_, i) => ({
    id:          `J${21600 + i}`,
    patient:     null,
    rx:          { sphere: rxSpecs[i % rxSpecs.length], cylinder: cyls[i % cyls.length], axis: String(90 + (i * 15) % 180), add: i % 3 === 0 ? '+2.25' : null },
    lensType:    lenses[i % lenses.length],
    coatingType: coatings[i % coatings.length],
    frameRef:    `FR-${1000 + i}`,
    status:      statuses[i % statuses.length],
    stage:       'ASSEMBLY',
    operator:    operators[i % operators.length],
    stationId:   `STN-0${(i % 8) + 1}`,
    receivedAt:  new Date(Date.now() - (i + 20) * 900000).toISOString(),
    startedAt:   i % statuses.length < 3 ? new Date(Date.now() - i * 420000).toISOString() : null,
    completedAt: statuses[i % statuses.length] === 'completed' ? new Date(Date.now() - i * 120000).toISOString() : null,
    dueDate:     new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    minutesAtStation: Math.round(10 + Math.random() * 20),
    isRush:      i % 7 === 0,
    priority:    i % 7 === 0 ? 'rush' : 'normal',
    remake:      i % 11 === 0,
    remakeReason: i % 11 === 0 ? 'Scratch on lens' : null,
    holdReason:  statuses[i % statuses.length] === 'hold' ? 'QC inspection required' : null,
  }));

  const completedToday = jobs.filter(j => j.status === 'completed');
  cache = {
    jobs:           jobs.filter(j => j.status !== 'completed'),
    completedToday,
    lastSync:       new Date().toISOString(),
    syncStatus:     'mock',
    syncError:      null,
    totalFetched:   jobs.length,
  };
  console.log('[DVI] Mock mode active — set DVI_URL + DVI_API_KEY to go live');
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/**
 * All jobs — supports optional filtering
 * query: { status, operator, stationId, isRush, includeCompleted }
 */
function getJobs(query = {}) {
  let result = query.includeCompleted
    ? [...cache.jobs, ...cache.completedToday]
    : [...cache.jobs];

  if (query.status)    result = result.filter(j => j.status === query.status);
  if (query.operator)  result = result.filter(j => j.operator?.toLowerCase().includes(query.operator.toLowerCase()));
  if (query.stationId) result = result.filter(j => j.stationId === query.stationId);
  if (query.isRush)    result = result.filter(j => j.isRush);

  return {
    jobs: result,
    total: result.length,
    lastSync: cache.lastSync,
    status: cache.syncStatus,
    error: cache.syncError,
  };
}

/**
 * Aggregated stats for Analytics tab and AI context
 */
function getStats() {
  const all = [...cache.jobs, ...cache.completedToday];
  const active    = cache.jobs.filter(j => j.status === 'active');
  const waiting   = cache.jobs.filter(j => j.status === 'waiting');
  const onHold    = cache.jobs.filter(j => j.status === 'hold');
  const completed = cache.completedToday;
  const rush      = cache.jobs.filter(j => j.isRush);

  // Per-operator stats
  const opStats = {};
  completed.forEach(j => {
    if (!j.operator) return;
    if (!opStats[j.operator]) opStats[j.operator] = { jobs: 0, totalMin: 0, rush: 0, remakes: 0 };
    opStats[j.operator].jobs++;
    opStats[j.operator].totalMin += j.minutesAtStation || 14;
    if (j.isRush)  opStats[j.operator].rush++;
    if (j.remake)  opStats[j.operator].remakes++;
  });

  // Per-coating stats
  const coatingStats = {};
  all.forEach(j => {
    if (!j.coatingType) return;
    if (!coatingStats[j.coatingType]) coatingStats[j.coatingType] = { total: 0, completed: 0, hold: 0 };
    coatingStats[j.coatingType].total++;
    if (j.status === 'completed') coatingStats[j.coatingType].completed++;
    if (j.status === 'hold')      coatingStats[j.coatingType].hold++;
  });

  const avgMinutes = completed.length
    ? (completed.reduce((s, j) => s + (j.minutesAtStation || 14), 0) / completed.length).toFixed(1)
    : 0;

  return {
    summary: {
      active:    active.length,
      waiting:   waiting.length,
      onHold:    onHold.length,
      completed: completed.length,
      rush:      rush.length,
      avgMinutes,
      remakes:   completed.filter(j => j.remake).length,
    },
    operators: Object.entries(opStats).map(([name, s]) => ({
      name,
      jobs:       s.jobs,
      avgMinutes: s.totalMin / Math.max(1, s.jobs),
      rush:       s.rush,
      remakes:    s.remakes,
    })).sort((a, b) => b.jobs - a.jobs),
    coatings: coatingStats,
    lastSync: cache.lastSync,
    status:   cache.syncStatus,
  };
}

/**
 * Single operator detailed stats — for operator detail panel
 */
function getOperatorStats(name) {
  const jobs = [...cache.jobs, ...cache.completedToday].filter(j =>
    j.operator?.toLowerCase() === name.toLowerCase()
  );
  const completed = jobs.filter(j => j.status === 'completed');
  const active    = jobs.filter(j => j.status === 'active');
  const avgMin    = completed.length ? (completed.reduce((s, j) => s + (j.minutesAtStation || 0), 0) / completed.length).toFixed(1) : 0;

  return {
    name,
    jobs:        completed.length,
    activeNow:   active.length,
    avgMinutes:  parseFloat(avgMin),
    rush:        completed.filter(j => j.isRush).length,
    remakes:     completed.filter(j => j.remake).length,
    coatings:    [...new Set(completed.map(j => j.coatingType).filter(Boolean))],
    recentJobs:  completed.slice(0, 10).map(j => ({ id: j.id, coating: j.coatingType, minutes: j.minutesAtStation, rush: j.isRush })),
    lastSync: cache.lastSync,
  };
}

/**
 * Compact AI context — fits in system prompt for AI queries
 */
function getAIContext() {
  const stats = getStats();
  const topOps = stats.operators.slice(0, 5)
    .map(o => `${o.name}: ${o.jobs} jobs, avg ${o.avgMinutes.toFixed(0)}min`)
    .join('; ');

  return {
    assemblyActive:    stats.summary.active,
    assemblyWaiting:   stats.summary.waiting,
    assemblyHold:      stats.summary.onHold,
    assemblyCompleted: stats.summary.completed,
    rushCount:         stats.summary.rush,
    avgCycleMin:       stats.summary.avgMinutes,
    remakeCount:       stats.summary.remakes,
    topOperators:      topOps,
    lastSync:          cache.lastSync,
    mode:              cache.syncStatus,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
function start() {
  console.log(`[DVI] Starting — ${CONFIG.mockMode ? 'MOCK MODE' : CONFIG.baseUrl} — poll every ${CONFIG.pollInterval / 1000}s`);
  poll();
  setInterval(poll, CONFIG.pollInterval);
}

module.exports = { start, getJobs, getStats, getOperatorStats, getAIContext };
