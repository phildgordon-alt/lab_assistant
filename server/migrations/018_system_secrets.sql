-- 018_system_secrets.sql
--
-- Phil 2026-05-13 very late: store the Anthropic API key (and any
-- future system secrets) in the DB so Phil can rotate it via the
-- Settings UI without SSH-editing .env files and restarting services.
--
-- Threat model: Phil is the only user with SSH access to the Mac
-- Studio prod box. The /api/settings/* endpoints are gated by
-- Cloudflare Zero Trust at the perimeter. Same file-system-permission
-- boundary that protects .env protects this table. No encryption-at-
-- rest needed; nothing past the perimeter is hostile.
--
-- The .env vars (ANTHROPIC_API_KEY) remain as a fallback for any
-- bootstrap case where the DB is fresh or the cache hasn't loaded.
-- Order: getSecret(name) checks DB first, falls back to process.env.

CREATE TABLE IF NOT EXISTS system_secrets (
  name        TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
