'use strict';

/**
 * System secrets — DB-backed config for keys Phil wants to rotate via
 * the Settings UI without SSH-editing .env.
 *
 * Phil 2026-05-13 very late: single-tenant threat model. He's the only
 * SSH user on prod and the API is behind Cloudflare Zero Trust. Plain
 * text in SQLite. No encryption-at-rest theatre.
 *
 * Read order (intentional):
 *   1. In-memory cache (cleared on setSecret)
 *   2. system_secrets table
 *   3. process.env[name]  (bootstrap fallback)
 *
 * Cache TTL: cleared on write, otherwise lives forever (process
 * lifetime). Rotating the key via the UI hits setSecret → cache
 * invalidates → next call reads fresh.
 */

// Phil 2026-05-13 very late: 60-second TTL on cached values so a key
// rotation via Lab Server's PUT endpoint is picked up by the separate
// Gateway process (port 3001) within a minute — no Gateway restart
// needed. Each Node process maintains its own cache; the TTL is the
// cross-process consistency mechanism.
const CACHE_TTL_MS = 60 * 1000;
const _cache = new Map(); // name → { value, expiresAt }

function getSecret(db, name) {
  const cached = _cache.get(name);
  const now = Date.now();
  if (cached && cached.expiresAt > now) return cached.value;
  // Reload from DB
  try {
    const row = db.prepare('SELECT value FROM system_secrets WHERE name = ?').get(name);
    if (row && row.value) {
      _cache.set(name, { value: row.value, expiresAt: now + CACHE_TTL_MS });
      return row.value;
    }
  } catch (_) { /* table may not exist; fall through to env */ }
  // Fallback to env
  const envVal = process.env[name];
  if (envVal) {
    _cache.set(name, { value: envVal, expiresAt: now + CACHE_TTL_MS });
    return envVal;
  }
  return null;
}

function setSecret(db, name, value) {
  if (!value || typeof value !== 'string') {
    throw new Error('setSecret requires a non-empty string value');
  }
  db.prepare(`
    INSERT INTO system_secrets (name, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(name) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(name, value);
  _cache.set(name, { value, expiresAt: Date.now() + CACHE_TTL_MS });
}

function deleteSecret(db, name) {
  db.prepare('DELETE FROM system_secrets WHERE name = ?').run(name);
  _cache.delete(name);
}

/**
 * Return masked + metadata for a secret — for UI display without
 * exposing the raw value. Last 4 chars visible, rest dot-masked.
 * Returns null if no secret is set (neither DB nor env).
 */
function describeSecret(db, name) {
  const value = getSecret(db, name);
  if (!value) return { configured: false, masked: null, updatedAt: null, source: null };
  const last4 = value.slice(-4);
  const masked = `${value.slice(0, 6)}…${last4}`;
  let updatedAt = null;
  let source = 'env';
  try {
    const row = db.prepare('SELECT updated_at FROM system_secrets WHERE name = ?').get(name);
    if (row) { updatedAt = row.updated_at; source = 'db'; }
  } catch (_) { /* table may not exist */ }
  return { configured: true, masked, updatedAt, source };
}

// Test-only: clear in-memory cache. Production code should never call this.
function _resetCacheForTests() {
  _cache.clear();
}

module.exports = {
  getSecret,
  setSecret,
  deleteSecret,
  describeSecret,
  _resetCacheForTests,
};
