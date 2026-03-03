-- Lab Assistant Agentic Gateway - Database Schema
-- Run this against your Postgres database (Supabase or local)

-- All requests through the gateway
CREATE TABLE IF NOT EXISTS gateway_requests (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source        TEXT NOT NULL CHECK (source IN ('slack', 'web', 'rest')),
  agent_name    TEXT NOT NULL,
  user_id       TEXT,
  input_text    TEXT NOT NULL,
  response_text TEXT,
  status        TEXT NOT NULL CHECK (status IN ('success', 'error', 'rate_limited', 'circuit_open')),
  duration_ms   INT,
  error_message TEXT,
  created_at    TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateway_requests_created ON gateway_requests(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_gateway_requests_agent   ON gateway_requests(agent_name);
CREATE INDEX IF NOT EXISTS idx_gateway_requests_source  ON gateway_requests(source);

-- Rate limit tracking
CREATE TABLE IF NOT EXISTS gateway_rate_limits (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  identifier  TEXT NOT NULL,   -- user_id or api_key
  source      TEXT NOT NULL,
  hit_at      TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_gateway_rate_limits_identifier ON gateway_rate_limits(identifier, hit_at DESC);

-- Circuit breaker state
CREATE TABLE IF NOT EXISTS gateway_circuit_state (
  id              SERIAL PRIMARY KEY,
  is_open         BOOLEAN DEFAULT FALSE,
  error_count     INT DEFAULT 0,
  last_checked_at TIMESTAMPTZ DEFAULT NOW(),
  opened_at       TIMESTAMPTZ,
  recovered_at    TIMESTAMPTZ
);

-- Seed initial circuit state if not exists
INSERT INTO gateway_circuit_state (is_open)
SELECT false
WHERE NOT EXISTS (SELECT 1 FROM gateway_circuit_state);

-- Function to clean up old rate limit records (run periodically)
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS void AS $$
BEGIN
  DELETE FROM gateway_rate_limits WHERE hit_at < NOW() - INTERVAL '5 minutes';
END;
$$ LANGUAGE plpgsql;

-- Function to clean up old requests (keep 30 days)
CREATE OR REPLACE FUNCTION cleanup_old_requests()
RETURNS void AS $$
BEGIN
  DELETE FROM gateway_requests WHERE created_at < NOW() - INTERVAL '30 days';
END;
$$ LANGUAGE plpgsql;
