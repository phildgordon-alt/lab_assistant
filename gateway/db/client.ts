import pg from 'pg';
import { v4 as uuidv4 } from 'uuid';

const { Pool } = pg;

// ─────────────────────────────────────────────────────────────────────────────
// Database Connection
// ─────────────────────────────────────────────────────────────────────────────

const DATABASE_URL = process.env.DATABASE_URL;
const DB_ENABLED = !!DATABASE_URL;

let pool: pg.Pool | null = null;

if (DB_ENABLED) {
  pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
  });
  pool.on('error', (err) => console.error('[DB] Pool error', err));
} else {
  console.warn('[DB] DATABASE_URL not set — running in mock mode');
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
  status: 'success' | 'error' | 'rate_limited' | 'circuit_open';
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
// In-Memory Mock Storage
// ─────────────────────────────────────────────────────────────────────────────

const mockRequests: GatewayRequest[] = [];
const mockRateLimits: Array<{ identifier: string; source: string; hit_at: Date }> = [];
const mockCircuitState: CircuitState = {
  is_open: false,
  error_count: 0,
  last_checked_at: new Date(),
  opened_at: null,
  recovered_at: null,
};

// ─────────────────────────────────────────────────────────────────────────────
// Request Logging
// ─────────────────────────────────────────────────────────────────────────────

export async function logRequest(req: Omit<GatewayRequest, 'id' | 'created_at'>): Promise<string> {
  const id = uuidv4();
  if (pool) {
    await pool.query(
      `INSERT INTO gateway_requests (id, source, agent_name, user_id, input_text, response_text, status, duration_ms, error_message)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [id, req.source, req.agent_name, req.user_id, req.input_text, req.response_text, req.status, req.duration_ms, req.error_message]
    );
  } else {
    mockRequests.push({ id, ...req, created_at: new Date() });
    if (mockRequests.length > 1000) mockRequests.shift();
  }
  return id;
}

export async function updateRequestResponse(id: string, response_text: string, duration_ms: number): Promise<void> {
  if (pool) {
    await pool.query(`UPDATE gateway_requests SET response_text = $1, duration_ms = $2, status = 'success' WHERE id = $3`, [response_text, duration_ms, id]);
  } else {
    const req = mockRequests.find(r => r.id === id);
    if (req) { req.response_text = response_text; req.duration_ms = duration_ms; req.status = 'success'; }
  }
}

export async function markRequestError(id: string, error_message: string, duration_ms: number): Promise<void> {
  if (pool) {
    await pool.query(`UPDATE gateway_requests SET error_message = $1, duration_ms = $2, status = 'error' WHERE id = $3`, [error_message, duration_ms, id]);
  } else {
    const req = mockRequests.find(r => r.id === id);
    if (req) { req.error_message = error_message; req.duration_ms = duration_ms; req.status = 'error'; }
  }
}

export async function getRecentRequests(limit = 50): Promise<GatewayRequest[]> {
  if (pool) {
    const result = await pool.query(`SELECT * FROM gateway_requests ORDER BY created_at DESC LIMIT $1`, [limit]);
    return result.rows;
  }
  return mockRequests.slice(-limit).reverse();
}

export async function getRequestStats(since = '24h') {
  const windowMs = since === '1h' ? 3600000 : since === '7d' ? 604800000 : 86400000;
  const cutoff = Date.now() - windowMs;

  if (!pool) {
    const filtered = mockRequests.filter(r => r.created_at.getTime() > cutoff);
    const by_agent: Record<string, number> = {};
    const by_source: Record<string, number> = {};
    const by_status: Record<string, number> = {};
    let totalDuration = 0, durationCount = 0;
    for (const r of filtered) {
      by_agent[r.agent_name] = (by_agent[r.agent_name] || 0) + 1;
      by_source[r.source] = (by_source[r.source] || 0) + 1;
      by_status[r.status] = (by_status[r.status] || 0) + 1;
      if (r.duration_ms) { totalDuration += r.duration_ms; durationCount++; }
    }
    return { total: filtered.length, avg_duration_ms: durationCount ? totalDuration / durationCount : 0, by_agent, by_source, by_status };
  }

  const interval = since === '1h' ? '1 hour' : since === '7d' ? '7 days' : '24 hours';
  const [result, byAgent, bySource, byStatus] = await Promise.all([
    pool.query(`SELECT COUNT(*) as total, AVG(duration_ms) as avg FROM gateway_requests WHERE created_at > NOW() - INTERVAL '${interval}'`),
    pool.query(`SELECT agent_name, COUNT(*) as count FROM gateway_requests WHERE created_at > NOW() - INTERVAL '${interval}' GROUP BY agent_name`),
    pool.query(`SELECT source, COUNT(*) as count FROM gateway_requests WHERE created_at > NOW() - INTERVAL '${interval}' GROUP BY source`),
    pool.query(`SELECT status, COUNT(*) as count FROM gateway_requests WHERE created_at > NOW() - INTERVAL '${interval}' GROUP BY status`),
  ]);
  return {
    total: parseInt(result.rows[0].total) || 0,
    avg_duration_ms: parseFloat(result.rows[0].avg) || 0,
    by_agent: Object.fromEntries(byAgent.rows.map(r => [r.agent_name, +r.count])),
    by_source: Object.fromEntries(bySource.rows.map(r => [r.source, +r.count])),
    by_status: Object.fromEntries(byStatus.rows.map(r => [r.status, +r.count])),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rate Limiting
// ─────────────────────────────────────────────────────────────────────────────

export async function recordRateHit(identifier: string, source: string): Promise<void> {
  if (pool) {
    await pool.query(`INSERT INTO gateway_rate_limits (identifier, source) VALUES ($1, $2)`, [identifier, source]);
  } else {
    mockRateLimits.push({ identifier, source, hit_at: new Date() });
    const cutoff = Date.now() - 300000;
    while (mockRateLimits.length && mockRateLimits[0].hit_at.getTime() < cutoff) mockRateLimits.shift();
  }
}

export async function getRateCount(identifier: string, windowMs: number): Promise<number> {
  if (pool) {
    const result = await pool.query(`SELECT COUNT(*) FROM gateway_rate_limits WHERE identifier = $1 AND hit_at > NOW() - INTERVAL '${windowMs} milliseconds'`, [identifier]);
    return parseInt(result.rows[0].count) || 0;
  }
  const cutoff = Date.now() - windowMs;
  return mockRateLimits.filter(r => r.identifier === identifier && r.hit_at.getTime() > cutoff).length;
}

export async function cleanupRateLimits(): Promise<void> {
  if (pool) await pool.query(`DELETE FROM gateway_rate_limits WHERE hit_at < NOW() - INTERVAL '5 minutes'`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Circuit Breaker
// ─────────────────────────────────────────────────────────────────────────────

export async function getCircuitState(): Promise<CircuitState> {
  if (!pool) return { ...mockCircuitState };
  const result = await pool.query(`SELECT * FROM gateway_circuit_state ORDER BY id DESC LIMIT 1`);
  if (!result.rows.length) {
    await pool.query(`INSERT INTO gateway_circuit_state (is_open) VALUES (false)`);
    return { is_open: false, error_count: 0, last_checked_at: new Date(), opened_at: null, recovered_at: null };
  }
  return result.rows[0];
}

export async function incrementErrorCount(): Promise<number> {
  if (!pool) { mockCircuitState.error_count++; mockCircuitState.last_checked_at = new Date(); return mockCircuitState.error_count; }
  const result = await pool.query(`UPDATE gateway_circuit_state SET error_count = error_count + 1, last_checked_at = NOW() WHERE id = (SELECT id FROM gateway_circuit_state ORDER BY id DESC LIMIT 1) RETURNING error_count`);
  return result.rows[0]?.error_count || 0;
}

export async function resetErrorCount(): Promise<void> {
  if (!pool) { mockCircuitState.error_count = 0; mockCircuitState.last_checked_at = new Date(); return; }
  await pool.query(`UPDATE gateway_circuit_state SET error_count = 0, last_checked_at = NOW() WHERE id = (SELECT id FROM gateway_circuit_state ORDER BY id DESC LIMIT 1)`);
}

export async function openCircuit(): Promise<void> {
  if (!pool) { mockCircuitState.is_open = true; mockCircuitState.opened_at = new Date(); mockCircuitState.last_checked_at = new Date(); return; }
  await pool.query(`UPDATE gateway_circuit_state SET is_open = true, opened_at = NOW(), last_checked_at = NOW() WHERE id = (SELECT id FROM gateway_circuit_state ORDER BY id DESC LIMIT 1)`);
}

export async function closeCircuit(): Promise<void> {
  if (!pool) { mockCircuitState.is_open = false; mockCircuitState.recovered_at = new Date(); mockCircuitState.error_count = 0; mockCircuitState.last_checked_at = new Date(); return; }
  await pool.query(`UPDATE gateway_circuit_state SET is_open = false, recovered_at = NOW(), error_count = 0, last_checked_at = NOW() WHERE id = (SELECT id FROM gateway_circuit_state ORDER BY id DESC LIMIT 1)`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Health Check
// ─────────────────────────────────────────────────────────────────────────────

export async function healthCheck(): Promise<boolean> {
  if (!pool) return true; // Mock mode is always "healthy"
  try { await pool.query('SELECT 1'); return true; } catch { return false; }
}

export { pool };
