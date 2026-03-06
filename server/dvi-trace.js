/**
 * DVI Trace File Watcher
 *
 * Tails the daily LT{YYMMDD}.DAT file on the DVI SMB share.
 * These files are created at midnight and appended all day with
 * tray movement events (station transitions, breakage, etc.)
 *
 * Behavior:
 * - Polls every 5 seconds for new bytes (delta read)
 * - Rolls to the next day's file at midnight
 * - Never deletes or modifies the remote file
 * - Maintains in-memory job state (last known station per job)
 * - Exposes parsed events and current WIP snapshot via API
 *
 * File format (tab-delimited):
 *   TRAY  INVNUM  LOGDATE  LOGTIME  STATION#  STATION  CATEGORY#  CATEGORY  LOGOP  LOGMID  LOGPORT
 *
 * Location: \\{host}\visdir\TRACE\LT{YYMMDD}.DAT
 */

const { EventEmitter } = require('events');
const path = require('path');

let SMB2;
try {
  SMB2 = require('@marsaud/smb2');
} catch (e) {
  console.warn('[DVI-Trace] SMB2 not installed');
}

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

const POLL_INTERVAL = 5000; // 5 seconds
const TRACE_SHARE = 'visdir';
const TRACE_DIR = 'TRACE';

// ─────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────

function getTodayFilename() {
  const now = new Date();
  const yy = String(now.getFullYear()).slice(2);
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  return `LT${yy}${mm}${dd}.DAT`;
}

function parseTraceLine(line) {
  const parts = line.split('\t');
  if (parts.length < 6) return null;

  const tray = (parts[0] || '').trim();
  const invNum = (parts[1] || '').trim();
  const logDate = (parts[2] || '').trim();
  const logTime = (parts[3] || '').trim();
  const stationNum = parseInt(parts[4]) || 0;
  const station = (parts[5] || '').trim();
  const categoryNum = parseInt(parts[6]) || 0;
  const category = (parts[7] || '').trim();
  const logOp = (parts[8] || '').trim();
  const logMid = (parts[9] || '').trim();
  const logPort = (parts[10] || '').trim();

  if (!invNum || !station) return null;

  return {
    tray,
    jobId: invNum,
    date: logDate,
    time: logTime,
    stationNum,
    station,
    categoryNum,
    category,
    operator: logOp,
    machineId: logMid,
    port: logPort,
    timestamp: parseTimestamp(logDate, logTime)
  };
}

function parseTimestamp(dateStr, timeStr) {
  // dateStr: 20260305, timeStr: "18:17" or "3 :57"
  if (!dateStr || dateStr.length !== 8) return null;
  const y = dateStr.substring(0, 4);
  const m = dateStr.substring(4, 6);
  const d = dateStr.substring(6, 8);
  const cleanTime = (timeStr || '0:0').replace(/\s/g, '');
  const [h, min] = cleanTime.split(':').map(Number);
  return new Date(`${y}-${m}-${d}T${String(h).padStart(2,'0')}:${String(min||0).padStart(2,'0')}:00`).getTime();
}

// Map station names to stage for KPI compatibility
function stationToStage(station) {
  const s = (station || '').toUpperCase();
  if (s === 'CANCELED') return 'CANCELED';
  if (s.includes('INITIATE') || s.includes('NEW WORK') || s.includes('FRAME LOGGED') || s.includes('LOG LENSES') || s.includes('SENT TO LAB') || s.includes('RX ENTRY') || s.includes('INTL ACCT')) return 'INCOMING';
  if (s.includes('NE LENS') || s.includes('NEL') || s.includes('NOT ENOUGH') || s.includes('NE FRMS') || s.includes('KRDX FAIL')) return 'NEL';
  if (s.includes('KARDEX') || s.includes('MAN2KARDX')) return 'AT_KARDEX';
  if (s.includes('DIGITAL CALC') || s.includes('GENERATOR') || s.includes('AUTO BLKER') || s.includes('POLISH') || s.includes('FINE') || s.includes('MANBLKER') || s.includes('CBOB - INHSE SF') || s.includes('CBOB - DIG')) return 'SURFACING';
  if (s.includes('CCL') || s.includes('CCP') || s.includes('COAT') || s.includes('SENT TO COAT')) return 'COATING';
  if (s.includes('EDGER') || s.includes('LCU') || s.includes('CUT') || s.includes('INHSE FIN')) return 'CUTTING';
  if (s === 'ASSEMBLY PASS') return 'QC';
  if (s === 'ASSEMBLY FAIL') return 'HOLD';
  if (s.includes('ASSEMBL') || s.includes('RECOMBOB')) return 'ASSEMBLY';
  if (s.includes('QC')) return 'QC';
  if (s.includes('SH CONVEY') || s.includes('SHIP')) return 'SHIPPING';
  if (s.includes('BREAKAGE')) return 'BREAKAGE';
  if (s.includes('LASER REJECT') || s.includes('KICKOUT') || s.includes('SLOW MVRS') || s.includes('UNCATEGOR') || s.includes('INFLUENCE') || s.includes('PLANOSPLT')) return 'HOLD';
  if (s.includes('QC_HOLD') || s.includes('HOLD')) return 'HOLD';
  return 'OTHER';
}

// ─────────────────────────────────────────────────────────────
// Trace Watcher Service
// ─────────────────────────────────────────────────────────────

class DviTraceWatcher extends EventEmitter {
  constructor() {
    super();
    this.client = null;
    this.running = false;
    this.timer = null;
    this.currentFile = null;
    this.byteOffset = 0;
    this.partialLine = ''; // Buffer for incomplete lines at end of read

    // In-memory state
    this.jobs = new Map();       // jobId → { last station, stage, timestamps, events }
    this.events = [];            // Recent events (ring buffer, last 5000)
    this.todayStats = {
      totalEvents: 0,
      uniqueJobs: 0,
      byStation: {},
      byStage: {},
      byOperator: {},
      breakageCount: 0,
      firstEvent: null,
      lastEvent: null
    };

    this.on('error', (err) => {
      console.error('[DVI-Trace] Error:', err.message || err);
    });
  }

  start(config) {
    if (!SMB2) {
      console.error('[DVI-Trace] SMB2 not installed');
      return false;
    }

    this._connConfig = {
      host: config?.host || process.env.DVI_SYNC_HOST || '192.168.0.27',
      user: config?.user || process.env.DVI_SYNC_USER || 'dvi',
      pass: config?.password || process.env.DVI_SYNC_PASSWORD || 'dvi',
      domain: config?.domain || process.env.DVI_SYNC_DOMAIN || 'WORKGROUP',
    };
    this._consecutiveErrors = 0;

    this._createClient();

    this.running = true;
    this.currentFile = null;
    this.byteOffset = 0;

    const { host } = this._connConfig;
    console.log(`[DVI-Trace] Started — watching \\\\${host}\\${TRACE_SHARE}\\${TRACE_DIR}\\LT*.DAT (every ${POLL_INTERVAL/1000}s)`);

    // Delay history load to avoid SMB connection race with dvi-sync
    const startHistory = async () => {
      await new Promise(r => setTimeout(r, 3000));
      await this.loadHistory();
    };
    startHistory().then(() => {
      this.poll();
      this.timer = setInterval(() => this.poll(), POLL_INTERVAL);
    }).catch(err => {
      console.error('[DVI-Trace] History load failed, starting live poll anyway:', err.message);
      this.poll();
      this.timer = setInterval(() => this.poll(), POLL_INTERVAL);
    });
    return true;
  }

  /**
   * Load all historical LT files on startup to build complete WIP state.
   * Reads every LT*.DAT file in the TRACE directory (oldest first),
   * processes all events, then sets byteOffset on today's file so
   * live polling only picks up new data.
   */
  async loadHistory() {
    if (!this.client) return;
    const todayFile = getTodayFilename();

    try {
      // List all LT files in TRACE directory
      const files = await new Promise((resolve, reject) => {
        this.client.readdir(TRACE_DIR, (err, list) => {
          if (err) return reject(err);
          resolve(list);
        });
      });

      const ltFiles = files
        .filter(f => /^LT\d{6}\.DAT$/i.test(f))
        .sort(); // Chronological order

      console.log(`[DVI-Trace] Loading ${ltFiles.length} historical files...`);

      for (const file of ltFiles) {
        const remotePath = `${TRACE_DIR}\\${file}`;
        try {
          const data = await this.readFile(remotePath);
          if (!data || data.length === 0) continue;

          const text = data.toString('utf8');
          const lines = text.split(/\r?\n/);
          let parsed = 0;

          for (const line of lines) {
            if (!line.trim()) continue;
            if (line.startsWith('TRAY\t')) continue;
            const evt = parseTraceLine(line);
            if (!evt) continue;
            this.processEvent(evt);
            parsed++;
          }

          // If this is today's file, set byte offset so live poll picks up from here
          if (file === todayFile) {
            this.currentFile = todayFile;
            this.byteOffset = data.length;
            this.partialLine = '';
          }

          console.log(`[DVI-Trace] ${file}: ${parsed} events, ${this.jobs.size} jobs total`);
        } catch (err) {
          const msg = err.message || '';
          if (msg.includes('STATUS_OBJECT_NAME_NOT_FOUND')) continue;
          if (msg.includes('STATUS_PENDING') || msg.includes('ETIMEDOUT')) {
            console.warn(`[DVI-Trace] Skipping ${file}: ${msg.substring(0, 60)}`);
            continue;
          }
          console.warn(`[DVI-Trace] Error reading ${file}: ${msg.substring(0, 80)}`);
        }

        // Small delay between files to avoid SMB connection issues
        await new Promise(r => setTimeout(r, 500));
      }

      // Reset today stats (history loaded stats from all days, we want today-only for stats)
      const todayJobs = this.jobs.size;
      this.todayStats = {
        totalEvents: this.todayStats.totalEvents,
        uniqueJobs: todayJobs,
        byStation: this.todayStats.byStation,
        byStage: this.todayStats.byStage,
        byOperator: this.todayStats.byOperator,
        breakageCount: this.todayStats.breakageCount,
        firstEvent: this.todayStats.firstEvent,
        lastEvent: this.todayStats.lastEvent
      };

      console.log(`[DVI-Trace] History loaded — ${todayJobs} total jobs across all files`);
    } catch (err) {
      console.error(`[DVI-Trace] Failed to load history: ${err.message}`);
      // Still continue with live polling even if history fails
    }
  }

  _createClient() {
    if (this.client) {
      try { this.client.close(); } catch (e) {}
    }
    const { host, user, pass, domain } = this._connConfig;
    this.client = new SMB2({
      share: `\\\\${host}\\${TRACE_SHARE}`,
      domain,
      username: user,
      password: pass,
      port: 445,
      autoCloseTimeout: 0
    });
  }

  stop() {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.client) {
      try { this.client.close(); } catch (e) {}
      this.client = null;
    }
    console.log('[DVI-Trace] Stopped');
  }

  async poll() {
    if (!this.running || !this.client) return;

    const filename = getTodayFilename();
    const remotePath = `${TRACE_DIR}\\${filename}`;

    // Day rolled over — reset offset for new file
    if (this.currentFile !== filename) {
      if (this.currentFile) {
        console.log(`[DVI-Trace] Day rolled: ${this.currentFile} → ${filename}`);
      }
      this.currentFile = filename;
      this.byteOffset = 0;
      this.partialLine = '';
    }

    try {
      // Read entire file — SMB2 doesn't support range reads,
      // so we read full file and slice from offset
      const data = await this.readFile(remotePath);
      if (!data) return;
      this._consecutiveErrors = 0;

      const fileSize = data.length;

      // No new data
      if (fileSize <= this.byteOffset) return;

      // Extract only new bytes
      const newData = data.slice(this.byteOffset);
      const newText = this.partialLine + newData.toString('utf8');
      this.byteOffset = fileSize;

      // Split into lines, keeping partial last line for next read
      const lines = newText.split(/\r?\n/);
      this.partialLine = lines.pop() || ''; // Last element may be incomplete

      let parsed = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        // Skip header line
        if (line.startsWith('TRAY\t')) continue;

        const evt = parseTraceLine(line);
        if (!evt) continue;

        this.processEvent(evt);
        parsed++;
      }

      if (parsed > 0) {
        this.emit('data', { count: parsed, fileSize, file: filename });
      }

    } catch (err) {
      // Don't spam errors for transient/expected SMB conditions
      const msg = err.message || '';
      if (msg.includes('STATUS_OBJECT_NAME_NOT_FOUND')) return;
      if (msg.includes('STATUS_PENDING') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET') || msg.includes('EALREADY')) {
        this._consecutiveErrors = (this._consecutiveErrors || 0) + 1;
        // Reconnect after 3 consecutive transient errors
        if (this._consecutiveErrors >= 3 && this._connConfig) {
          console.log('[DVI-Trace] Reconnecting SMB client after repeated errors');
          this._createClient();
          this._consecutiveErrors = 0;
        }
        return;
      }
      this.emit('error', err);
    }
  }

  readFile(remotePath) {
    return new Promise((resolve, reject) => {
      this.client.readFile(remotePath, (err, data) => {
        if (err) return reject(err);
        resolve(data);
      });
    });
  }

  processEvent(evt) {
    const stage = stationToStage(evt.station);

    // Update job state
    let job = this.jobs.get(evt.jobId);
    if (!job) {
      job = {
        jobId: evt.jobId,
        tray: evt.tray,
        station: evt.station,
        stationNum: evt.stationNum,
        stage,
        category: evt.category,
        status: 'Active',
        firstSeen: evt.timestamp,
        lastSeen: evt.timestamp,
        events: []
      };
      this.jobs.set(evt.jobId, job);
    }

    // Update last known position
    job.station = evt.station;
    job.stationNum = evt.stationNum;
    job.stage = stage;
    job.category = evt.category;
    job.lastSeen = evt.timestamp;
    job.operator = evt.operator;
    job.machineId = evt.machineId;
    job.events.push({
      station: evt.station,
      stage,
      time: evt.time,
      timestamp: evt.timestamp,
      operator: evt.operator
    });

    // Update shipped status based on current stage
    if (stage === 'SHIPPING') {
      job.status = 'SHIPPED';
    } else if (job.status === 'SHIPPED') {
      // Job moved back into production after shipping station
      job.status = 'Active';
    }

    // Track breakage
    if (stage === 'BREAKAGE') {
      job.hasBreakage = true;
    }

    // Add to recent events ring buffer (include stage for API consumers)
    evt.stage = stage;
    this.events.push(evt);
    if (this.events.length > 5000) {
      this.events = this.events.slice(-5000);
    }

    // Update stats
    this.todayStats.totalEvents++;
    this.todayStats.uniqueJobs = this.jobs.size;
    this.todayStats.byStation[evt.station] = (this.todayStats.byStation[evt.station] || 0) + 1;
    this.todayStats.byStage[stage] = (this.todayStats.byStage[stage] || 0) + 1;
    if (evt.operator) {
      this.todayStats.byOperator[evt.operator] = (this.todayStats.byOperator[evt.operator] || 0) + 1;
    }
    if (stage === 'BREAKAGE') this.todayStats.breakageCount++;
    if (!this.todayStats.firstEvent) this.todayStats.firstEvent = evt.timestamp;
    this.todayStats.lastEvent = evt.timestamp;

    // Emit for real-time consumers
    this.emit('event', { ...evt, stage });
  }

  // ── Public API ──────────────────────────────────────────────

  /**
   * Get all active WIP jobs (not shipped) with their current station
   * This is what feeds the KPIs and department views
   */
  getJobs() {
    const jobs = [];
    for (const job of this.jobs.values()) {
      jobs.push({
        job_id: job.jobId,
        tray: job.tray,
        station: job.station,
        stationNum: job.stationNum,
        stage: job.stage,
        category: job.category,
        status: job.status,
        operator: job.operator,
        machineId: job.machineId,
        hasBreakage: job.hasBreakage || false,
        firstSeen: job.firstSeen,
        lastSeen: job.lastSeen,
        eventCount: job.events.length,
        daysInLab: job.firstSeen ? Math.max(0, (Date.now() - job.firstSeen) / 86400000) : 0
      });
    }
    return jobs;
  }

  /**
   * Get jobs formatted for frontend KPIs (matches expected dviJobs shape)
   */
  getJobsForKPI() {
    return this.getJobs().map(j => ({
      ...j,
      invoice: j.job_id,
      rush: 'N', // TODO: cross-ref with DVI job XML for rush flag
      Rush: 'N',
      priority: 'NORMAL'
    }));
  }

  /**
   * Get job counts by current stage (not event counts)
   */
  getJobsByStage() {
    const byStage = {};
    for (const job of this.jobs.values()) {
      byStage[job.stage] = (byStage[job.stage] || 0) + 1;
    }
    return byStage;
  }

  /**
   * Get recent events
   */
  getRecentEvents(limit = 100) {
    return this.events.slice(-limit).reverse();
  }

  /**
   * Get today's statistics
   */
  getStats() {
    return {
      ...this.todayStats,
      file: this.currentFile,
      byteOffset: this.byteOffset,
      jobCount: this.jobs.size,
      topStations: Object.entries(this.todayStats.byStation)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 20)
        .map(([station, count]) => ({ station, count }))
    };
  }

  /**
   * Get status for monitoring
   */
  getStatus() {
    return {
      running: this.running,
      currentFile: this.currentFile,
      byteOffset: this.byteOffset,
      jobCount: this.jobs.size,
      totalEvents: this.todayStats.totalEvents,
      lastEvent: this.todayStats.lastEvent
        ? new Date(this.todayStats.lastEvent).toISOString()
        : null,
      byStage: this.getJobsByStage(),
      eventsByStage: this.todayStats.byStage
    };
  }

  /**
   * Get job history (all events for a specific job)
   */
  getJobHistory(jobId) {
    const job = this.jobs.get(jobId);
    if (!job) return null;
    return {
      jobId: job.jobId,
      tray: job.tray,
      status: job.status,
      currentStation: job.station,
      currentStage: job.stage,
      hasBreakage: job.hasBreakage || false,
      firstSeen: job.firstSeen,
      lastSeen: job.lastSeen,
      events: job.events
    };
  }
}

// ─────────────────────────────────────────────────────────────
// Singleton + Exports
// ─────────────────────────────────────────────────────────────

const watcher = new DviTraceWatcher();

module.exports = {
  start(config) { return watcher.start(config); },
  stop() { return watcher.stop(); },
  getJobs() { return watcher.getJobs(); },
  getJobsForKPI() { return watcher.getJobsForKPI(); },
  getRecentEvents(limit) { return watcher.getRecentEvents(limit); },
  getStats() { return watcher.getStats(); },
  getStatus() { return watcher.getStatus(); },
  getJobHistory(jobId) { return watcher.getJobHistory(jobId); },
  on(event, handler) { watcher.on(event, handler); }
};
