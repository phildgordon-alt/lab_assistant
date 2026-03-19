/**
 * lab-config.js — Lab Baseline Configuration + EWS Rule Management
 *
 * Manages:
 * - EWS rules (migrated from hardcoded RULES array to SQLite)
 * - EWS global config (sigma thresholds, poll interval, etc.)
 * - Lab operational baselines (expected throughput/yield/labor per department per shift)
 * - Lab schedule (shift hours, headcount, active days)
 * - Backlog computation (current queue depth vs baseline throughput → recovery time)
 *
 * All tables stored in data/ews.db alongside existing EWS tables.
 *
 * USAGE in oven-timer-server.js:
 *   const labConfig = require('./lab-config');
 *   app.get('/api/ews/rules', (req, res) => res.json(labConfig.getRules()));
 *   app.put('/api/ews/rules/:id', (req, res) => res.json(labConfig.updateRule(id, body)));
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');
const fs = require('fs');

// ─── DATABASE ──────────────────────────────────────────────────────────────

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const DB_FILE = path.join(DATA_DIR, 'ews.db');
const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL');

// ─── TABLE CREATION ────────────────────────────────────────────────────────

db.exec(`
  -- EWS rules (migrated from hardcoded RULES array)
  CREATE TABLE IF NOT EXISTS ews_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    metric TEXT NOT NULL,
    op TEXT NOT NULL DEFAULT '>=',
    threshold REAL NOT NULL,
    tier TEXT NOT NULL DEFAULT 'P2',
    message TEXT NOT NULL,
    category TEXT,
    department TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    cooldown_min INTEGER NOT NULL DEFAULT 30,
    window_min INTEGER NOT NULL DEFAULT 5,
    suppress_until TEXT,
    suppress_reason TEXT,
    slack_channel TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    last_fired_at TEXT,
    fire_count INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX IF NOT EXISTS idx_ews_rules_metric ON ews_rules(metric);
  CREATE INDEX IF NOT EXISTS idx_ews_rules_enabled ON ews_rules(enabled);

  -- Audit trail for rule changes
  CREATE TABLE IF NOT EXISTS ews_rule_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    rule_id INTEGER NOT NULL,
    field TEXT NOT NULL,
    old_value TEXT,
    new_value TEXT,
    changed_by TEXT DEFAULT 'system',
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_ews_rule_hist_rule ON ews_rule_history(rule_id);

  -- Global EWS configuration (key-value)
  CREATE TABLE IF NOT EXISTS ews_config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- Lab operational baselines
  CREATE TABLE IF NOT EXISTS lab_baselines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    shift TEXT NOT NULL,
    metric TEXT NOT NULL,
    value REAL NOT NULL,
    unit TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(department, shift, metric)
  );

  -- Lab baseline change history
  CREATE TABLE IF NOT EXISTS lab_baseline_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    shift TEXT NOT NULL,
    metric TEXT NOT NULL,
    old_value REAL,
    new_value REAL,
    changed_by TEXT DEFAULT 'system',
    changed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_lab_bl_hist ON lab_baseline_history(department, metric);

  -- Lab shift schedule
  CREATE TABLE IF NOT EXISTS lab_schedule (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    department TEXT NOT NULL,
    day_of_week INTEGER NOT NULL,
    shift TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    start_hour INTEGER NOT NULL DEFAULT 6,
    end_hour INTEGER NOT NULL DEFAULT 14,
    headcount INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(department, day_of_week, shift)
  );
`);

// ─── PREPARED STATEMENTS ───────────────────────────────────────────────────

// Rules
const stmtGetRules = db.prepare('SELECT * FROM ews_rules ORDER BY id');
const stmtGetRule = db.prepare('SELECT * FROM ews_rules WHERE id = ?');
const stmtInsertRule = db.prepare(`
  INSERT INTO ews_rules (metric, op, threshold, tier, message, category, department)
  VALUES (@metric, @op, @threshold, @tier, @message, @category, @department)
`);
const stmtRuleCount = db.prepare('SELECT COUNT(*) as cnt FROM ews_rules');
const stmtUpdateRuleFire = db.prepare(`
  UPDATE ews_rules SET last_fired_at = datetime('now'), fire_count = fire_count + 1 WHERE id = ?
`);
const stmtLogRuleChange = db.prepare(`
  INSERT INTO ews_rule_history (rule_id, field, old_value, new_value, changed_by)
  VALUES (?, ?, ?, ?, ?)
`);
const stmtGetRuleHistory = db.prepare(`
  SELECT * FROM ews_rule_history WHERE rule_id = ? ORDER BY changed_at DESC LIMIT ?
`);

// Config
const stmtGetConfig = db.prepare('SELECT key, value FROM ews_config');
const stmtUpsertConfig = db.prepare(`
  INSERT INTO ews_config (key, value, updated_at) VALUES (?, ?, datetime('now'))
  ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
`);
const stmtConfigCount = db.prepare('SELECT COUNT(*) as cnt FROM ews_config');

// Baselines
const stmtGetBaselines = db.prepare('SELECT * FROM lab_baselines ORDER BY department, shift, metric');
const stmtUpsertBaseline = db.prepare(`
  INSERT INTO lab_baselines (department, shift, metric, value, unit, updated_at)
  VALUES (@department, @shift, @metric, @value, @unit, datetime('now'))
  ON CONFLICT(department, shift, metric) DO UPDATE SET
    value = excluded.value, unit = excluded.unit, updated_at = excluded.updated_at
`);
const stmtGetBaselineValue = db.prepare(
  'SELECT value FROM lab_baselines WHERE department = ? AND shift = ? AND metric = ?'
);
const stmtBaselineCount = db.prepare('SELECT COUNT(*) as cnt FROM lab_baselines');
const stmtLogBaselineChange = db.prepare(`
  INSERT INTO lab_baseline_history (department, shift, metric, old_value, new_value, changed_by)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const stmtGetBaselineHistory = db.prepare(`
  SELECT * FROM lab_baseline_history
  WHERE (? IS NULL OR department = ?)
  ORDER BY changed_at DESC LIMIT ?
`);

// Schedule
const stmtGetSchedule = db.prepare('SELECT * FROM lab_schedule ORDER BY department, day_of_week, shift');
const stmtUpsertSchedule = db.prepare(`
  INSERT INTO lab_schedule (department, day_of_week, shift, active, start_hour, end_hour, headcount, updated_at)
  VALUES (@department, @day_of_week, @shift, @active, @start_hour, @end_hour, @headcount, datetime('now'))
  ON CONFLICT(department, day_of_week, shift) DO UPDATE SET
    active = excluded.active, start_hour = excluded.start_hour, end_hour = excluded.end_hour,
    headcount = excluded.headcount, updated_at = excluded.updated_at
`);
const stmtScheduleCount = db.prepare('SELECT COUNT(*) as cnt FROM lab_schedule');

// Readings (for backlog + test rule) — lazy-prepared because ews_readings
// is created by ews-engine.js which may load after lab-config.js
let _stmtLatestReading = null;
let _stmtRecentReadings = null;
function getStmtLatestReading() {
  if (!_stmtLatestReading) {
    try { _stmtLatestReading = db.prepare('SELECT value FROM ews_readings WHERE metric = ? ORDER BY ts DESC LIMIT 1'); }
    catch (e) { return null; }
  }
  return _stmtLatestReading;
}
function getStmtRecentReadings() {
  if (!_stmtRecentReadings) {
    try { _stmtRecentReadings = db.prepare("SELECT metric, value, unit, ts FROM ews_readings WHERE metric = ? AND ts >= datetime('now', ?) ORDER BY ts DESC"); }
    catch (e) { return null; }
  }
  return _stmtRecentReadings;
}

// ─── METRIC → CATEGORY/DEPARTMENT MAPPING ──────────────────────────────────

function deriveCategory(metric) {
  if (metric.startsWith('som_')) return 'machine';
  if (metric.startsWith('itempath_')) return 'inventory';
  if (metric.startsWith('dvi_')) return 'production';
  if (metric.startsWith('breakage') || metric.startsWith('coating_reject')) return 'quality';
  if (metric.startsWith('network_')) return 'network';
  if (metric.startsWith('maintenance_')) return 'maintenance';
  if (metric.startsWith('oven_')) return 'oven';
  if (metric.startsWith('cycle_time_')) return 'production';
  return 'other';
}

function deriveDepartment(metric) {
  if (metric.includes('surf')) return 'surfacing';
  if (metric.includes('coat') || metric.includes('oven')) return 'coating';
  if (metric.includes('cut') || metric.includes('edg')) return 'cutting';
  if (metric.includes('assembl')) return 'assembly';
  if (metric.includes('kardex') || metric.includes('itempath') || metric.includes('pick')) return 'picking';
  if (metric.includes('som') || metric.includes('conveyor')) return 'equipment';
  if (metric.includes('network') || metric.includes('vlan') || metric.includes('wan')) return 'network';
  if (metric.includes('maintenance')) return 'maintenance';
  return 'lab-wide';
}

// ─── SEED DATA ─────────────────────────────────────────────────────────────

// Import DEFAULT_RULES from ews-engine at seed time
function seedRules() {
  if (stmtRuleCount.get().cnt > 0) return;
  console.log('[LAB-CONFIG] Seeding ews_rules from hardcoded RULES...');

  // Read RULES from ews-engine module scope
  const { RULES } = require('./ews-engine');
  if (!RULES || RULES.length === 0) {
    console.warn('[LAB-CONFIG] No RULES found in ews-engine — skipping seed');
    return;
  }

  const insert = db.transaction((rules) => {
    for (const r of rules) {
      stmtInsertRule.run({
        metric: r.metric,
        op: r.op,
        threshold: r.threshold,
        tier: r.tier,
        message: r.message,
        category: deriveCategory(r.metric),
        department: deriveDepartment(r.metric),
      });
    }
  });
  insert(RULES);
  console.log(`[LAB-CONFIG] Seeded ${RULES.length} rules`);
}

function seedConfig() {
  if (stmtConfigCount.get().cnt > 0) return;
  console.log('[LAB-CONFIG] Seeding ews_config with defaults...');
  const defaults = {
    p1_sigma: process.env.EWS_P1_SIGMA || '3.5',
    p2_sigma: process.env.EWS_P2_SIGMA || '2.5',
    p3_sigma: process.env.EWS_P3_SIGMA || '1.5',
    poll_interval_sec: process.env.EWS_POLL_INTERVAL_SEC || '300',
    baseline_days: process.env.EWS_BASELINE_DAYS || '30',
    auto_resolve_hours: process.env.EWS_AUTO_RESOLVE_HOURS || '4',
    min_baseline_samples: '10',
    dedup_window_min: '30',
  };
  const insert = db.transaction((defs) => {
    for (const [key, value] of Object.entries(defs)) {
      stmtUpsertConfig.run(key, value);
    }
  });
  insert(defaults);
  console.log(`[LAB-CONFIG] Seeded ${Object.keys(defaults).length} config entries`);
}

function seedBaselines() {
  if (stmtBaselineCount.get().cnt > 0) return;
  console.log('[LAB-CONFIG] Seeding lab_baselines with placeholders...');
  const depts = [
    { dept: 'surfacing', throughput: [40, 35, 0], yield: [96, 95, 0], labor: [8, 7, 0] },
    { dept: 'cutting',   throughput: [45, 40, 0], yield: [97, 96, 0], labor: [6, 5, 0] },
    { dept: 'coating',   throughput: [30, 25, 0], yield: [92, 91, 0], labor: [6, 5, 0] },
    { dept: 'assembly',  throughput: [35, 30, 0], yield: [98, 97, 0], labor: [8, 7, 0] },
    { dept: 'picking',   throughput: [50, 45, 0], yield: [99, 99, 0], labor: [4, 3, 0] },
    { dept: 'print',     throughput: [60, 55, 0], yield: [99, 99, 0], labor: [2, 2, 0] },
  ];
  const shifts = ['morning', 'afternoon', 'night'];
  const insert = db.transaction(() => {
    for (const d of depts) {
      for (let si = 0; si < shifts.length; si++) {
        stmtUpsertBaseline.run({ department: d.dept, shift: shifts[si], metric: 'throughput', value: d.throughput[si], unit: 'jobs/hr' });
        stmtUpsertBaseline.run({ department: d.dept, shift: shifts[si], metric: 'yield', value: d.yield[si], unit: '%' });
        stmtUpsertBaseline.run({ department: d.dept, shift: shifts[si], metric: 'labor_rate', value: d.labor[si], unit: 'operators' });
      }
    }
  });
  insert();
  console.log(`[LAB-CONFIG] Seeded baselines for ${depts.length} departments`);
}

function seedSchedule() {
  if (stmtScheduleCount.get().cnt > 0) return;
  console.log('[LAB-CONFIG] Seeding lab_schedule...');
  const depts = ['surfacing', 'cutting', 'coating', 'assembly', 'picking', 'print'];
  const shiftDefs = [
    { shift: 'morning', start: 6, end: 14, hc: 8 },
    { shift: 'afternoon', start: 14, end: 22, hc: 6 },
    { shift: 'night', start: 22, end: 6, hc: 0 },
  ];
  const insert = db.transaction(() => {
    for (const dept of depts) {
      for (let dow = 0; dow <= 6; dow++) {
        for (const sd of shiftDefs) {
          const isWeekday = dow >= 1 && dow <= 5;
          stmtUpsertSchedule.run({
            department: dept,
            day_of_week: dow,
            shift: sd.shift,
            active: (isWeekday && sd.shift !== 'night') ? 1 : 0,
            start_hour: sd.start,
            end_hour: sd.end,
            headcount: (isWeekday && sd.shift !== 'night') ? sd.hc : 0,
          });
        }
      }
    }
  });
  insert();
  console.log(`[LAB-CONFIG] Seeded schedule for ${depts.length} departments`);
}

// Run seeds
seedRules();
seedConfig();
seedBaselines();
seedSchedule();

// ─── RULES CACHE ───────────────────────────────────────────────────────────

let rulesCache = null;
let rulesCacheTime = 0;
const RULES_CACHE_TTL = 5 * 60 * 1000; // 5 min

function clearRuleCache() {
  rulesCache = null;
  rulesCacheTime = 0;
}

// ─── PUBLIC API ────────────────────────────────────────────────────────────

module.exports = {
  // ── Rules ──

  getRules() {
    const now = Date.now();
    if (rulesCache && (now - rulesCacheTime) < RULES_CACHE_TTL) return rulesCache;
    rulesCache = stmtGetRules.all();
    rulesCacheTime = now;
    return rulesCache;
  },

  getRule(id) {
    const rule = stmtGetRule.get(id);
    if (!rule) return null;
    const history = stmtGetRuleHistory.all(id, 20);
    return { ...rule, history };
  },

  updateRule(id, fields) {
    const existing = stmtGetRule.get(id);
    if (!existing) return { error: 'Rule not found' };

    const allowed = ['metric', 'op', 'threshold', 'tier', 'message', 'category', 'department',
      'enabled', 'cooldown_min', 'window_min', 'slack_channel'];
    const sets = [];
    const params = [];
    const changedBy = fields.changed_by || 'user';

    for (const key of allowed) {
      if (fields[key] !== undefined && fields[key] !== existing[key]) {
        sets.push(`${key} = ?`);
        params.push(fields[key]);
        stmtLogRuleChange.run(id, key, String(existing[key]), String(fields[key]), changedBy);
      }
    }
    if (sets.length === 0) return existing;

    sets.push("updated_at = datetime('now')");
    params.push(id);
    db.prepare(`UPDATE ews_rules SET ${sets.join(', ')} WHERE id = ?`).run(...params);
    clearRuleCache();
    return stmtGetRule.get(id);
  },

  toggleRule(id) {
    const existing = stmtGetRule.get(id);
    if (!existing) return { error: 'Rule not found' };
    const newVal = existing.enabled ? 0 : 1;
    db.prepare("UPDATE ews_rules SET enabled = ?, updated_at = datetime('now') WHERE id = ?").run(newVal, id);
    stmtLogRuleChange.run(id, 'enabled', String(existing.enabled), String(newVal), 'user');
    clearRuleCache();
    return { id, enabled: newVal };
  },

  suppressRule(id, until, reason) {
    const existing = stmtGetRule.get(id);
    if (!existing) return { error: 'Rule not found' };
    db.prepare("UPDATE ews_rules SET suppress_until = ?, suppress_reason = ?, updated_at = datetime('now') WHERE id = ?")
      .run(until, reason || null, id);
    stmtLogRuleChange.run(id, 'suppress_until', existing.suppress_until || 'null', until, 'user');
    clearRuleCache();
    return stmtGetRule.get(id);
  },

  unsuppressRule(id) {
    const existing = stmtGetRule.get(id);
    if (!existing) return { error: 'Rule not found' };
    db.prepare("UPDATE ews_rules SET suppress_until = NULL, suppress_reason = NULL, updated_at = datetime('now') WHERE id = ?")
      .run(id);
    stmtLogRuleChange.run(id, 'suppress_until', existing.suppress_until || 'null', 'null', 'user');
    clearRuleCache();
    return stmtGetRule.get(id);
  },

  testRule(id) {
    const rule = stmtGetRule.get(id);
    if (!rule) return { error: 'Rule not found' };
    const readings = getStmtRecentReadings()?.all(rule.metric, '-60 minutes') || [];
    const violations = readings.filter(r => {
      if (rule.op === '>=') return r.value >= rule.threshold;
      if (rule.op === '<=') return r.value <= rule.threshold;
      if (rule.op === '>') return r.value > rule.threshold;
      if (rule.op === '<') return r.value < rule.threshold;
      return false;
    });
    return {
      rule_id: id,
      metric: rule.metric,
      threshold: rule.threshold,
      op: rule.op,
      readings_evaluated: readings.length,
      violations: violations.length,
      would_fire: violations.length > 0,
      sample_values: readings.slice(0, 10).map(r => ({ value: r.value, ts: r.ts })),
    };
  },

  recordRuleFire(id) {
    stmtUpdateRuleFire.run(id);
    clearRuleCache();
  },

  getRuleHistory(id, limit = 20) {
    return stmtGetRuleHistory.all(id, limit);
  },

  // ── Global Config ──

  getConfig() {
    const rows = stmtGetConfig.all();
    const config = {};
    for (const r of rows) config[r.key] = r.value;
    return config;
  },

  setConfig(keyValues) {
    const update = db.transaction((kv) => {
      for (const [key, value] of Object.entries(kv)) {
        stmtUpsertConfig.run(key, String(value));
      }
    });
    update(keyValues);
    return this.getConfig();
  },

  // ── Lab Baselines ──

  getLabBaselines() {
    return stmtGetBaselines.all();
  },

  setLabBaseline({ department, shift, metric, value, unit, changed_by }) {
    const existing = stmtGetBaselineValue.get(department, shift, metric);
    const oldVal = existing ? existing.value : null;
    stmtUpsertBaseline.run({ department, shift, metric, value, unit: unit || null });
    if (oldVal !== null && oldVal !== value) {
      stmtLogBaselineChange.run(department, shift, metric, oldVal, value, changed_by || 'user');
    }
    return { department, shift, metric, value, old_value: oldVal };
  },

  getBaselineHistory(department, limit = 50) {
    return stmtGetBaselineHistory.all(department || null, department || null, limit);
  },

  // ── Schedule ──

  getSchedule() {
    return stmtGetSchedule.all();
  },

  setScheduleSlot(fields) {
    const { department, day_of_week, shift } = fields;
    if (!department || day_of_week == null || !shift) return { error: 'department, day_of_week, shift required' };
    stmtUpsertSchedule.run({
      department,
      day_of_week,
      shift,
      active: fields.active != null ? (fields.active ? 1 : 0) : 1,
      start_hour: fields.start_hour || 6,
      end_hour: fields.end_hour || 14,
      headcount: fields.headcount || 0,
    });
    return { ok: true };
  },

  // ── Backlog & Recovery ──

  getBacklog() {
    const departments = ['surfacing', 'cutting', 'coating', 'assembly'];
    const zoneMetrics = { surfacing: 'dvi_queue_depth_surf', cutting: 'dvi_queue_depth_cut', coating: 'dvi_queue_depth_coat', assembly: 'dvi_queue_depth_asse' };

    // Determine current shift
    const hour = new Date().getHours();
    const currentShift = hour >= 6 && hour < 14 ? 'morning' : hour >= 14 && hour < 22 ? 'afternoon' : 'night';

    const result = [];
    for (const dept of departments) {
      const queueMetric = zoneMetrics[dept];
      const queueReading = queueMetric ? getStmtLatestReading()?.get(queueMetric) : null;
      const backlog = queueReading ? queueReading.value : 0;

      const throughputReading = getStmtLatestReading()?.get('dvi_throughput_per_hour');
      const throughput = throughputReading ? throughputReading.value : 0;

      const baselineRow = stmtGetBaselineValue.get(dept, currentShift, 'throughput');
      const baselineThroughput = baselineRow ? baselineRow.value : 0;

      let recoveryHours = null;
      let color = 'green';
      if (backlog > 0 && throughput > 0) {
        recoveryHours = Math.round((backlog / throughput) * 10) / 10;
        if (recoveryHours > 8) color = 'red';
        else if (recoveryHours > 2) color = 'amber';
      } else if (backlog > 0) {
        color = 'red';
      }

      result.push({
        department: dept,
        backlog,
        throughput,
        baseline_throughput: baselineThroughput,
        recovery_hours: recoveryHours,
        color,
        shift: currentShift,
      });
    }
    return result;
  },

  getBacklogTrend(department, days = 30) {
    if (!department) return [];
    const zoneMetrics = { surfacing: 'dvi_queue_depth_surf', cutting: 'dvi_queue_depth_cut', coating: 'dvi_queue_depth_coat', assembly: 'dvi_queue_depth_asse' };
    const metric = zoneMetrics[department];
    if (!metric) return [];

    const rows = db.prepare(`
      SELECT DATE(ts) as day, AVG(value) as avg_backlog, MAX(value) as max_backlog, COUNT(*) as samples
      FROM ews_readings
      WHERE metric = ? AND ts >= datetime('now', ?)
      GROUP BY DATE(ts)
      ORDER BY day
    `).all(metric, `-${days} days`);

    return rows;
  },

  /**
   * Catch-up calculator: given backlog, incoming rate, output rate → burn-down projection
   * Can compute for a specific department or lab-wide.
   * Returns: netDaily, daysToZero, clearDate, weeklyMilestones, suggestedOutput (for target date)
   */
  getCatchUp({ department, backlog, incoming, output, surge, target, targetDate, workDaysPerWeek, skipWeekends } = {}) {
    // Auto-fill from live data if params not provided
    const hour = new Date().getHours();
    const currentShift = hour >= 6 && hour < 14 ? 'morning' : hour >= 14 && hour < 22 ? 'afternoon' : 'night';

    // If department provided, pull live data
    if (department && (backlog == null || incoming == null || output == null)) {
      const zoneMetrics = { surfacing: 'dvi_queue_depth_surf', cutting: 'dvi_queue_depth_cut', coating: 'dvi_queue_depth_coat', assembly: 'dvi_queue_depth_asse' };
      const queueMetric = zoneMetrics[department];
      if (queueMetric) {
        const qr = getStmtLatestReading()?.get(queueMetric);
        if (qr && backlog == null) backlog = qr.value;
      }
      const thr = getStmtLatestReading()?.get('dvi_throughput_per_hour');
      if (thr && output == null) output = Math.round(thr.value * 8); // 8hr shift → daily
      const blRow = stmtGetBaselineValue.get(department, currentShift, 'throughput');
      if (blRow && incoming == null) incoming = Math.round(blRow.value * 8 * 0.9); // assume 90% of baseline is incoming demand
    }

    backlog = backlog || 0;
    incoming = incoming || 0;
    output = output || 0;
    surge = surge || 0;
    target = target || 0;
    workDaysPerWeek = workDaysPerWeek || 5;
    skipWeekends = skipWeekends !== false;

    const effectiveOutput = surge > 0 ? surge : output;
    const netDaily = effectiveOutput - incoming;

    // Can't catch up if net <= 0
    if (netDaily <= 0) {
      return {
        department: department || 'lab-wide',
        backlog, incoming, output, surge, target,
        netDaily,
        feasible: false,
        message: `Output (${effectiveOutput}) does not exceed incoming (${incoming}). Backlog is growing.`,
      };
    }

    // Simulate burn-down
    const startDate = new Date();
    startDate.setHours(0,0,0,0);
    let bl = backlog;
    let workDay = 0;
    const milestones = [];
    const calDate = new Date(startDate);

    while (bl > target && workDay < 730) {
      calDate.setDate(calDate.getDate() + 1);
      if (skipWeekends && (calDate.getDay() === 0 || calDate.getDay() === 6)) continue;
      workDay++;
      bl = Math.max(target, bl - netDaily);
      if (workDay % workDaysPerWeek === 0 || bl <= target) {
        milestones.push({
          week: Math.ceil(workDay / workDaysPerWeek),
          workDay,
          date: calDate.toISOString().split('T')[0],
          backlog: Math.round(bl),
          pctCleared: Math.round((1 - bl / backlog) * 100),
        });
      }
    }

    const daysToZero = workDay;
    const weeksToZero = Math.ceil(workDay / workDaysPerWeek);
    const clearDate = new Date(calDate).toISOString().split('T')[0];

    // Suggested output if target date provided
    let suggestedOutput = null;
    if (targetDate) {
      const end = new Date(targetDate + 'T00:00:00');
      const start = new Date();
      start.setHours(0,0,0,0);
      if (end > start) {
        let wDays = 0;
        const cur = new Date(start);
        while (cur < end) {
          cur.setDate(cur.getDate() + 1);
          if (skipWeekends && (cur.getDay() === 0 || cur.getDay() === 6)) continue;
          wDays++;
        }
        if (wDays > 0) {
          suggestedOutput = Math.ceil((backlog - target) / wDays + incoming);
        }
      }
    }

    return {
      department: department || 'lab-wide',
      backlog, incoming, output, surge, target,
      effectiveOutput,
      netDaily,
      feasible: true,
      daysToZero,
      weeksToZero,
      clearDate,
      milestones,
      suggestedOutput,
      targetDate: targetDate || null,
      message: `At ${effectiveOutput} output/day vs ${incoming} incoming/day (net +${netDaily}/day), backlog of ${backlog} clears in ${daysToZero} working days (${weeksToZero} weeks) by ${clearDate}.`,
    };
  },
};
