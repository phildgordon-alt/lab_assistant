/**
 * DVI File Sync Service
 *
 * Polls DVI server directories and syncs files locally:
 * - Breakage reports: copy (keep original)
 * - Job XML/JSON: move (take & delete)
 * - Shipped PDFs: move (take & delete)
 *
 * Supports:
 * - SMB shares (Windows file shares)
 * - Local/mounted paths
 * - Configurable polling intervals per sync
 * - Retry with backoff
 * - Status API for monitoring
 *
 * Config: config/dvi-sync.json (env var substitution supported)
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const { execFile } = require('child_process');

// Try to load SMB2 library (optional - falls back to local mode)
let SMB2;
try {
  SMB2 = require('@marsaud/smb2');
} catch (e) {
  console.warn('[DVI-Sync] SMB2 not installed. Run: npm install @marsaud/smb2');
  console.warn('[DVI-Sync] Will only support local/mounted paths');
}

// ─────────────────────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────────────────────

const CONFIG_PATH = path.join(__dirname, '..', 'config', 'dvi-sync.json');
const DATA_DIR = path.join(__dirname, '..', 'data', 'dvi');
const STATE_FILE = path.join(DATA_DIR, 'sync-state.json');

// Substitute ${ENV_VAR} and ${ENV_VAR:-default} in config values
function substituteEnvVars(obj) {
  if (typeof obj === 'string') {
    return obj.replace(/\$\{([^}]+)\}/g, (match, expr) => {
      const [varName, defaultVal] = expr.split(':-');
      return process.env[varName] || defaultVal || '';
    });
  }
  if (Array.isArray(obj)) {
    return obj.map(substituteEnvVars);
  }
  if (obj && typeof obj === 'object') {
    const result = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = substituteEnvVars(value);
    }
    return result;
  }
  return obj;
}

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      console.warn('[DVI-Sync] Config not found:', CONFIG_PATH);
      return null;
    }
    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
    const config = JSON.parse(raw);
    return substituteEnvVars(config);
  } catch (e) {
    console.error('[DVI-Sync] Failed to load config:', e.message);
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// State Management
// ─────────────────────────────────────────────────────────────────────────────

let state = {
  startedAt: null,
  syncs: {},
  stats: {
    totalFiles: 0,
    totalBytes: 0,
    errors: 0,
    lastError: null
  }
};

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const data = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      // Preserve stats across restarts
      state.stats = data.stats || state.stats;
    }
  } catch (e) {
    console.warn('[DVI-Sync] Could not load state:', e.message);
  }
}

function saveState() {
  try {
    fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch (e) {
    console.warn('[DVI-Sync] Could not save state:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// SMB Client Wrapper
// ─────────────────────────────────────────────────────────────────────────────

class SmbClient {
  constructor(config) {
    this.config = config;
    this.clients = {}; // Cache SMB2 clients per share
  }

  async getClient(shareName) {
    if (!SMB2) {
      throw new Error('SMB2 not installed');
    }

    const key = `${this.config.host}/${shareName}`;
    if (this.clients[key]) {
      return this.clients[key];
    }

    const client = new SMB2({
      share: `\\\\${this.config.host}\\${shareName}`,
      domain: this.config.domain || 'WORKGROUP',
      username: this.config.user,
      password: this.config.password,
      port: this.config.port || 445,
      autoCloseTimeout: 30000
    });

    this.clients[key] = client;
    return client;
  }

  async listFiles(shareName, remotePath, patterns) {
    const client = await this.getClient(shareName);

    return new Promise((resolve, reject) => {
      let settled = false; // Guard against SMB2 calling callback multiple times
      const fullPath = remotePath.replace(/^\//, '').replace(/\//g, '\\');
      client.readdir(fullPath, (err, files) => {
        if (settled) return; settled = true;
        if (err) {
          if (err.code === 'STATUS_OBJECT_NAME_NOT_FOUND' || err.code === 'STATUS_OBJECT_NAME_INVALID') {
            return resolve([]);
          }
          return reject(err);
        }

        const fileNames = files.map(f => typeof f === 'string' ? f : f.name).filter(Boolean);

        const filtered = fileNames.filter(name => {
          return patterns.some(pattern => {
            const regex = new RegExp('^' + pattern.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
            return regex.test(name);
          });
        });

        resolve(filtered.map(name => ({
          name,
          size: 0,
          mtime: null
        })));
      });
    });
  }

  async readFile(shareName, remotePath) {
    const client = await this.getClient(shareName);

    return new Promise((resolve, reject) => {
      let settled = false;
      const fullPath = remotePath.replace(/^\//, '').replace(/\//g, '\\');
      client.readFile(fullPath, (err, data) => {
        if (settled) return; settled = true;
        if (err) return reject(err);
        resolve(data);
      });
    });
  }

  async deleteFile(shareName, remotePath) {
    const client = await this.getClient(shareName);

    return new Promise((resolve, reject) => {
      const fullPath = remotePath.replace(/^\//, '').replace(/\//g, '\\');
      client.unlink(fullPath, (err) => {
        if (err) return reject(err);
        resolve();
      });
    });
  }

  async close() {
    for (const client of Object.values(this.clients)) {
      try {
        client.close();
      } catch (e) {
        // Ignore close errors
      }
    }
    this.clients = {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Local File Client (for mounted paths)
// ─────────────────────────────────────────────────────────────────────────────

class LocalClient {
  constructor(basePath) {
    this.basePath = basePath;
  }

  // Convert Windows-style backslash paths from config to forward slashes for macOS/Linux
  _resolvePath(shareName, remotePath) {
    const normalized = (remotePath || '').replace(/\\/g, '/');
    return path.join(this.basePath, shareName, normalized);
  }

  async listFiles(shareName, remotePath, patterns) {
    const fullPath = this._resolvePath(shareName, remotePath);

    try {
      await fs.promises.access(fullPath);
    } catch {
      console.warn(`[DVI-Sync] LocalClient: path not found: ${fullPath}`);
      return [];
    }

    // Use async readdir to avoid blocking the event loop on large directories (25K+ files over SMB)
    const fileNames = await fs.promises.readdir(fullPath);

    const regexes = patterns.map(p => new RegExp('^' + p.replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'));

    return fileNames
      .filter(name => regexes.some(r => r.test(name)))
      .map(name => ({ name, size: 0, mtime: null }));
  }

  async readFile(shareName, remotePath) {
    const fullPath = this._resolvePath(shareName, remotePath);
    return new Promise((resolve, reject) => {
      execFile('/bin/cat', [fullPath], {
        timeout: 10000,
        maxBuffer: 5 * 1024 * 1024,
        encoding: 'buffer',
      }, (err, stdout) => {
        if (err) {
          if (err.killed) return reject(new Error(`ETIMEDOUT: cat ${path.basename(fullPath)} killed after 10s`));
          return reject(err);
        }
        resolve(stdout);
      });
    });
  }

  async deleteFile(shareName, remotePath) {
    const fullPath = this._resolvePath(shareName, remotePath);
    return fs.promises.unlink(fullPath);
  }

  async close() {
    // No-op for local
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sync Service
// ─────────────────────────────────────────────────────────────────────────────

class DviSyncService extends EventEmitter {
  constructor() {
    super();
    this.config = null;
    this.client = null;
    this.running = false;
    this.intervals = {};
    this.processors = {};

    // Prevent unhandled 'error' events from crashing the process
    this.on('error', (err) => {
      console.error('[DVI-Sync] Event error:', err.sync || '', err.error?.message || err.message || err);
    });
  }

  // Register custom file processors
  registerProcessor(type, handler) {
    this.processors[type] = handler;
  }

  async start() {
    this.config = loadConfig();
    if (!this.config || !this.config.enabled) {
      console.log('[DVI-Sync] Disabled or no config');
      return false;
    }

    loadState();
    state.startedAt = new Date().toISOString();

    // Initialize client based on connection type
    const connType = this.config.connection?.type || 'local';

    if (connType === 'smb') {
      if (!SMB2) {
        console.error('[DVI-Sync] SMB mode requires @marsaud/smb2 package');
        console.log('[DVI-Sync] Install with: npm install @marsaud/smb2');
        console.log('[DVI-Sync] Or set connection.type to "local" and mount shares manually');
        return false;
      }
      if (!this.config.connection.host || !this.config.connection.user) {
        console.error('[DVI-Sync] SMB mode requires host and user in config');
        console.log('[DVI-Sync] Set DVI_SYNC_HOST and DVI_SYNC_USER environment variables');
        return false;
      }
      this.client = new SmbClient(this.config.connection);
      console.log(`[DVI-Sync] SMB mode: \\\\${this.config.connection.host}`);
    } else {
      const basePath = this.config.connection?.basePath || '/mnt/dvi';
      this.client = new LocalClient(basePath);
      console.log(`[DVI-Sync] Local mode: ${basePath}`);
    }

    this.running = true;

    // Start sync loops — defer initial polls to let the server start accepting requests first.
    // Listing 25K+ files on an SMB mount is slow and blocks the event loop.
    let staggerDelay = 30000; // First sync starts 30s after boot
    for (const sync of this.config.syncs) {
      if (!sync.enabled) {
        console.log(`[DVI-Sync] Skipping disabled sync: ${sync.name}`);
        continue;
      }

      state.syncs[sync.id] = {
        name: sync.name,
        lastPoll: null,
        lastSuccess: null,
        filesProcessed: 0,
        errors: 0,
        status: 'starting'
      };

      // Stagger initial polls by 15s each so they don't all hit SMB at once
      const delay = staggerDelay;
      setTimeout(() => {
        this.pollSync(sync).catch(e => { console.warn(`[DVI-Sync] Initial poll failed for ${sync.name}:`, e.message); });
      }, delay);
      staggerDelay += 15000;

      // Set up interval
      const interval = sync.pollInterval || 60000;
      this.intervals[sync.id] = setInterval(() => {
        this.pollSync(sync).catch(e => { console.warn(`[DVI-Sync] Poll failed for ${sync.name}:`, e.message); });
      }, interval);

      console.log(`[DVI-Sync] Scheduled: ${sync.name} (every ${interval / 1000}s, first poll in ${delay / 1000}s)`);
    }

    console.log(`[DVI-Sync] Service started with ${Object.keys(this.intervals).length} syncs`);
    return true;
  }

  async stop() {
    this.running = false;

    // Clear all intervals
    for (const [id, interval] of Object.entries(this.intervals)) {
      clearInterval(interval);
      if (state.syncs[id]) {
        state.syncs[id].status = 'stopped';
      }
    }
    this.intervals = {};

    // Close client
    if (this.client) {
      await this.client.close();
      this.client = null;
    }

    saveState();
    console.log('[DVI-Sync] Service stopped');
  }

  async pollSync(sync) {
    const syncState = state.syncs[sync.id];
    if (!syncState) return;

    syncState.lastPoll = new Date().toISOString();
    syncState.status = 'polling';

    try {
      // List files matching patterns
      const files = await this.client.listFiles(
        sync.source.share,
        sync.source.path,
        sync.patterns
      );

      if (files.length === 0) {
        syncState.lastError = null;
        syncState.status = 'idle';
        return;
      }

      // For copy mode, skip files we already have locally
      let toProcess = files;
      if (sync.action === 'copy') {
        await fs.promises.mkdir(sync.dest, { recursive: true });
        // Read local directory once and use a Set for O(1) lookup instead of
        // calling existsSync per file (25K+ calls blocks the event loop)
        const localFiles = new Set(await fs.promises.readdir(sync.dest));
        toProcess = files.filter(f => !localFiles.has(f.name));
      }

      if (toProcess.length === 0) {
        syncState.lastError = null;
        syncState.status = 'idle';
        return;
      }

      // Limit batch size to avoid overwhelming SMB connection
      const batchSize = sync.batchSize || 50;
      const batch = toProcess.slice(0, batchSize);

      syncState.status = 'processing';
      console.log(`[DVI-Sync] ${sync.name}: Found ${files.length} files, ${toProcess.length} new, processing ${batch.length}`);

      // Process each file
      for (const file of batch) {
        await this.processFile(sync, file);
      }

      syncState.lastSuccess = new Date().toISOString();
      syncState.lastError = null;
      syncState.status = 'idle';
      saveState();

    } catch (err) {
      syncState.status = 'error';
      syncState.errors++;
      syncState.lastError = err.message;
      state.stats.errors++;
      state.stats.lastError = { sync: sync.id, error: err.message, at: new Date().toISOString() };

      console.error(`[DVI-Sync] ${sync.name} error:`, err.message);
      this.emit('error', { sync: sync.id, error: err });
    }
  }

  async processFile(sync, file) {
    const syncState = state.syncs[sync.id];
    // Build remote path — LocalClient handles backslash-to-forward conversion internally
    const remotePath = sync.source.path + '\\' + file.name;
    const localPath = path.join(sync.dest, file.name);

    try {
      // Ensure dest directory exists
      await fs.promises.mkdir(sync.dest, { recursive: true });

      // Read file from remote
      const data = await this.client.readFile(sync.source.share, remotePath);

      // Write to local
      await fs.promises.writeFile(localPath, data);

      // Delete from remote if action is 'move'
      if (sync.action === 'move') {
        await this.client.deleteFile(sync.source.share, remotePath);
      }

      const fileSize = data.length || 0;

      // Update stats
      syncState.filesProcessed++;
      state.stats.totalFiles++;
      state.stats.totalBytes += fileSize;

      console.log(`[DVI-Sync] ${sync.action === 'move' ? 'Moved' : 'Copied'}: ${file.name} (${(fileSize / 1024).toFixed(1)}KB)`);

      // Run processor if configured
      await this.runProcessor(sync, localPath, file, data);

      // Emit event
      this.emit('file', { sync: sync.id, file: file.name, path: localPath, action: sync.action });

    } catch (err) {
      console.error(`[DVI-Sync] Failed to process ${file.name}:`, err.message);
      throw err;
    }
  }

  async runProcessor(sync, localPath, file, data) {
    // Determine processor based on file type and sync config
    const ext = path.extname(file.name).toLowerCase();

    let processorType = null;
    if (sync.processJson && ext === '.json') {
      processorType = 'json';
    } else if (sync.processXml && ext === '.xml') {
      processorType = 'xml';
    } else if (ext === '.pdf') {
      processorType = 'pdf';
    } else if (ext === '.csv' || ext === '.xlsx') {
      processorType = 'breakage';
    }

    if (!processorType) return;

    const handler = this.processors[processorType];
    if (handler) {
      try {
        await handler(localPath, file, data, sync);
      } catch (err) {
        console.error(`[DVI-Sync] Processor error (${processorType}):`, err.message);
      }
    }
  }

  getStatus() {
    return {
      running: this.running,
      startedAt: state.startedAt,
      config: this.config ? {
        connectionType: this.config.connection?.type,
        host: this.config.connection?.host,
        syncsEnabled: this.config.syncs?.filter(s => s.enabled).length
      } : null,
      syncs: state.syncs,
      stats: state.stats
    };
  }

  // Force immediate poll of a specific sync
  async forcePoll(syncId) {
    if (!this.config) return { ok: false, error: 'Not configured' };

    const sync = this.config.syncs.find(s => s.id === syncId);
    if (!sync) return { ok: false, error: 'Sync not found' };

    await this.pollSync(sync);
    return { ok: true, sync: state.syncs[syncId] };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module Exports
// ─────────────────────────────────────────────────────────────────────────────

const service = new DviSyncService();

module.exports = {
  service,

  async start() {
    return service.start();
  },

  async stop() {
    return service.stop();
  },

  getStatus() {
    return service.getStatus();
  },

  async forcePoll(syncId) {
    return service.forcePoll(syncId);
  },

  // Register custom file processors
  onJson(handler) {
    service.registerProcessor('json', handler);
  },

  onXml(handler) {
    service.registerProcessor('xml', handler);
  },

  onPdf(handler) {
    service.registerProcessor('pdf', handler);
  },

  onBreakage(handler) {
    service.registerProcessor('breakage', handler);
  },

  // Event subscription
  on(event, handler) {
    service.on(event, handler);
  }
};
