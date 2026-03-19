/**
 * Gateway Database Client
 * Uses SQLite for request logging, rate limiting, and circuit breaker state
 */

import Database from 'better-sqlite3';
import { v4 as uuidv4 } from 'uuid';
import { existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const DB_FILE = join(DATA_DIR, 'gateway.db');

// Ensure data directory exists
if (!existsSync(DATA_DIR)) {
  mkdirSync(DATA_DIR, { recursive: true });
}

// Initialize SQLite database
let db: Database.Database;
try {
  db = new Database(DB_FILE);
  db.pragma('journal_mode = WAL');

  // Create tables if they don't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS gateway_requests (
      id TEXT PRIMARY KEY,
      source TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      user_id TEXT,
      input_text TEXT NOT NULL,
      response_text TEXT,
      status TEXT DEFAULT 'pending',
      duration_ms INTEGER,
      error_message TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS gateway_rate_limits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      identifier TEXT NOT NULL,
      source TEXT NOT NULL,
      hit_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS gateway_circuit_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      is_open INTEGER DEFAULT 0,
      error_count INTEGER DEFAULT 0,
      last_checked_at INTEGER DEFAULT (strftime('%s', 'now') * 1000),
      opened_at INTEGER,
      recovered_at INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_requests_created ON gateway_requests(created_at);
    CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier ON gateway_rate_limits(identifier, hit_at);

    CREATE TABLE IF NOT EXISTS api_usage (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      request_id TEXT,
      agent_name TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      source TEXT,
      user_id TEXT,
      created_at INTEGER DEFAULT (strftime('%s', 'now') * 1000)
    );
    CREATE INDEX IF NOT EXISTS idx_api_usage_agent ON api_usage(agent_name, created_at);
    CREATE INDEX IF NOT EXISTS idx_api_usage_created ON api_usage(created_at);

    INSERT OR IGNORE INTO gateway_circuit_state (id, is_open, error_count) VALUES (1, 0, 0);
  `);

  console.log('[DB] SQLite database initialized at', DB_FILE);
} catch (err) {
  console.error('[DB] Failed to initialize SQLite:', err);
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface GatewayRequest {
  id: string;
  source: 'slack' | 'web' | 'rest';
  agent_name: string;
  user_id: string | null;
  input_text: string;
  response_text: string | null;
  status: 'success' | 'error' | 'rate_limited' | 'circuit_open' | 'pending';
  duration_ms: number | null;
  error_message: string | null;
  created_at: Date;
}

export interface CircuitState {
  is_open: boolean;
  error_count: number;
  last_checked_at: Date;
  opened_at: Date | null;
  recovered_at: Date | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Request Logging
// ─────────────────────────────────────────────────────────────────────────────

export async function logRequest(req: Omit<GatewayRequest, 'id' | 'created_at'>): Promise<string> {
  const id = uuidv4();
  const stmt = db.prepare(`
    INSERT INTO gateway_requests (id, source, agent_name, user_id, input_text, response_text, status, duration_ms, error_message)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(id, req.source, req.agent_name, req.user_id, req.input_text, req.response_text, req.status, req.duration_ms, req.error_message);
  return id;
}

export async function updateRequestResponse(id: string, response_text: string, duration_ms: number): Promise<void> {
  const stmt = db.prepare(`UPDATE gateway_requests SET response_text = ?, duration_ms = ?, status = 'success' WHERE id = ?`);
  stmt.run(response_text, duration_ms, id);
}

export async function markRequestError(id: string, error_message: string, duration_ms: number): Promise<void> {
  const stmt = db.prepare(`UPDATE gateway_requests SET error_message = ?, duration_ms = ?, status = 'error' WHERE id = ?`);
  stmt.run(error_message, duration_ms, id);
}

export async function getRecentRequests(limit = 50): Promise<GatewayRequest[]> {
  const stmt = db.prepare(`SELECT * FROM gateway_requests ORDER BY created_at DESC LIMIT ?`);
  const rows = stmt.all(limit) as any[];
  return rows.map(r => ({
    ...r,
    created_at: new Date(r.created_at),
    status: r.status as GatewayRequest['status'],
    source: r.source as GatewayRequest['source'],
  }));
}

export async function getRequestStats(since = '24h') {
  const windowMs = since === '1h' ? 3600000 : since === '7d' ? 604800000 : 86400000;
  const cutoff = Date.now() - windowMs;

  const totalStmt = db.prepare(`SELECT COUNT(*) as total, AVG(duration_ms) as avg FROM gateway_requests WHERE created_at > ?`);
  const totalRow = totalStmt.get(cutoff) as any;

  const byAgentStmt = db.prepare(`SELECT agent_name, COUNT(*) as count FROM gateway_requests WHERE created_at > ? GROUP BY agent_name`);
  const byAgentRows = byAgentStmt.all(cutoff) as any[];

  const bySourceStmt = db.prepare(`SELECT source, COUNT(*) as count FROM gateway_requests WHERE created_at > ? GROUP BY source`);
  const bySourceRows = bySourceStmt.all(cutoff) as any[];

  const byStatusStmt = db.prepare(`SELECT status, COUNT(*) as count FROM gateway_requests WHERE created_at > ? GROUP BY status`);
  const byStatusRows = byStatusStmt.all(cutoff) as any[];

  return {
    total: totalRow?.total || 0,
    avg_duration_ms: totalRow?.avg || 0,
    by_agent: Object.fromEntries(byAgentRows.map(r => [r.agent_name, r.count])),
    by_source: Object.fromEntries(bySourceRows.map(r => [r.source, r.count])),
    by_status: Object.fromEntries(byStatusRows.map(r => [r.status, r.count])),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// API Usage Tracking
// ─────────────────────────────────────────────────────────────────────────────

// Pricing per 1M tokens (as of March 2026)
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
};

function calcCost(model: string, inputTokens: number, outputTokens: number): number {
  const pricing = MODEL_PRICING[model] || MODEL_PRICING['claude-haiku-4-5-20251001'];
  return (inputTokens / 1_000_000 * pricing.input) + (outputTokens / 1_000_000 * pricing.output);
}

export async function recordUsage(params: {
  requestId?: string;
  agentName: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  source?: string;
  userId?: string;
}): Promise<void> {
  const totalTokens = params.inputTokens + params.outputTokens;
  const costUsd = calcCost(params.model, params.inputTokens, params.outputTokens);
  const stmt = db.prepare(`
    INSERT INTO api_usage (request_id, agent_name, model, input_tokens, output_tokens, total_tokens, cost_usd, source, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  stmt.run(params.requestId || null, params.agentName, params.model, params.inputTokens, params.outputTokens, totalTokens, costUsd, params.source || null, params.userId || null);
}

export async function getUsageStats(since = '24h') {
  const windowMs = since === '1h' ? 3600000 : since === '7d' ? 604800000 : since === '30d' ? 2592000000 : 86400000;
  const cutoff = Date.now() - windowMs;

  const totals = db.prepare(`
    SELECT COUNT(*) as requests, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
           SUM(total_tokens) as total_tokens, SUM(cost_usd) as total_cost
    FROM api_usage WHERE created_at > ?
  `).get(cutoff) as any;

  const byAgent = db.prepare(`
    SELECT agent_name, COUNT(*) as requests, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
           SUM(total_tokens) as total_tokens, SUM(cost_usd) as cost
    FROM api_usage WHERE created_at > ? GROUP BY agent_name ORDER BY cost DESC
  `).all(cutoff) as any[];

  const byDay = db.prepare(`
    SELECT DATE(created_at / 1000, 'unixepoch') as day, COUNT(*) as requests,
           SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
           SUM(total_tokens) as total_tokens, SUM(cost_usd) as cost
    FROM api_usage WHERE created_at > ? GROUP BY day ORDER BY day
  `).all(cutoff) as any[];

  const byModel = db.prepare(`
    SELECT model, COUNT(*) as requests, SUM(input_tokens) as input_tokens, SUM(output_tokens) as output_tokens,
           SUM(cost_usd) as cost
    FROM api_usage WHERE created_at > ? GROUP BY model
  `).all(cutoff) as any[];

  const bySource = db.prepare(`
    SELECT source, COUNT(*) as requests, SUM(cost_usd) as cost
    FROM api_usage WHERE created_at > ? GROUP BY source
  `).all(cutoff) as any[];

  return {
    period: since,
    totals: {
      requests: totals?.requests || 0,
      input_tokens: totals?.input_tokens || 0,
      output_tokens: totals?.output_tokens || 0,
      total_tokens: totals?.total_tokens || 0,
      cost_usd: Math.round((totals?.total_cost || 0) * 10000) / 10000,
    },
    by_agent: byAgent.map(r => ({ ...r, cost: Math.round(r.cost * 10000) / 10000 })),
    by_day: byDay.map(r => ({ ...r, cost: Math.round(r.cost * 10000) / 10000 })),
    by_model: byModel.map(r => ({ ...r, cost: Math.round(r.cost * 10000) / 10000 })),
    by_source: bySource.map(r => ({ ...r, cost: Math.round(r.cost * 10000) / 10000 })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

export async function recordRateHit(identifier: string, source: string): Promise<void> {
  const stmt = db.prepare(`INSERT INTO gateway_rate_limits (identifier, source) VALUES (?, ?)`);
  stmt.run(identifier, source);
}

export async function getRateCount(identifier: string, windowMs: number): Promise<number> {
  const cutoff = Date.now() - windowMs;
  const stmt = db.prepare(`SELECT COUNT(*) as count FROM gateway_rate_limits WHERE identifier = ? AND hit_at > ?`);
  const row = stmt.get(identifier, cutoff) as any;
  return row?.count || 0;
}

export async function cleanupRateLimits(): Promise<void> {
  const cutoff = Date.now() - 300000; // 5 minutes
  const stmt = db.prepare(`DELETE FROM gateway_rate_limits WHERE hit_at < ?`);
  stmt.run(cutoff);
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker
// ─────────────────────────────────────────────────────────────────────────────

export async function getCircuitState(): Promise<CircuitState> {
  const stmt = db.prepare(`SELECT * FROM gateway_circuit_state WHERE id = 1`);
  const row = stmt.get() as any;
  return {
    is_open: !!row?.is_open,
    error_count: row?.error_count || 0,
    last_checked_at: row?.last_checked_at ? new Date(row.last_checked_at) : new Date(),
    opened_at: row?.opened_at ? new Date(row.opened_at) : null,
    recovered_at: row?.recovered_at ? new Date(row.recovered_at) : null,
  };
}

export async function incrementErrorCount(): Promise<number> {
  const stmt = db.prepare(`UPDATE gateway_circuit_state SET error_count = error_count + 1, last_checked_at = ? WHERE id = 1 RETURNING error_count`);
  const row = stmt.get(Date.now()) as any;
  return row?.error_count || 0;
}

export async function resetErrorCount(): Promise<void> {
  const stmt = db.prepare(`UPDATE gateway_circuit_state SET error_count = 0, last_checked_at = ? WHERE id = 1`);
  stmt.run(Date.now());
}

export async function openCircuit(): Promise<void> {
  const now = Date.now();
  const stmt = db.prepare(`UPDATE gateway_circuit_state SET is_open = 1, opened_at = ?, last_checked_at = ? WHERE id = 1`);
  stmt.run(now, now);
}

export async function closeCircuit(): Promise<void> {
  const now = Date.now();
  const stmt = db.prepare(`UPDATE gateway_circuit_state SET is_open = 0, recovered_at = ?, error_count = 0, last_checked_at = ? WHERE id = 1`);
  stmt.run(now, now);
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}

export { db };
