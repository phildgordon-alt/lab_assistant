/**
 * Anthropic API call telemetry — shared with the gateway's tracking table.
 *
 * The lab server (server/oven-timer-server.js) has three places where it
 * calls api.anthropic.com directly with `fetch()`, bypassing the gateway
 * agent runner. Those calls were invisible to the gateway's local
 * api_usage table — so the API Spend Tracker dashboard under-reported
 * direct-call cost.
 *
 * This module opens the same SQLite file the gateway uses
 * (../data/gateway.db) and writes rows in the same schema. Both processes
 * can write concurrently in WAL mode.
 *
 * Usage:
 *   const telemetry = require('./anthropic-telemetry');
 *   const claudeRes = await fetch('https://api.anthropic.com/v1/messages', ...);
 *   const claudeData = await claudeRes.json();
 *   telemetry.recordUsage({
 *     model: 'claude-sonnet-4-20250514',
 *     usage: claudeData.usage,         // { input_tokens, output_tokens, cache_*_input_tokens }
 *     agentName: 'ai-query',
 *     source: 'direct',
 *     userId: req.headers['cf-access-authenticated-user-email'] || 'anonymous',
 *   });
 *
 * If the gateway.db file is unreachable (filesystem error, locked, etc.)
 * the recordUsage call logs a warning and returns — it NEVER throws, so a
 * telemetry failure can't break the user-facing API call.
 *
 * 2026-05-13: Phil — close the telemetry gap for the 3 direct calls in
 * oven-timer-server.js (/api/ai/query, /api/slack/ai-respond, Slack
 * auto-poller).
 */

'use strict';

const path = require('path');
const Database = require('better-sqlite3');

// Pricing per 1M tokens. Mirrors gateway/db/client.ts:176-180. Update both
// together when Anthropic publishes new rates or we adopt newer models.
const MODEL_PRICING = {
  'claude-haiku-4-5-20251001': { input: 0.80, output: 4.00 },
  'claude-sonnet-4-20250514':  { input: 3.00, output: 15.00 },
  'claude-opus-4-20250514':    { input: 15.00, output: 75.00 },
};
const DEFAULT_PRICING = MODEL_PRICING['claude-haiku-4-5-20251001'];

// Path resolution mirrors gateway/db/client.ts: <repo>/data/gateway.db.
// From server/ that's ../data/gateway.db.
const DB_FILE = path.join(__dirname, '..', 'data', 'gateway.db');

let db = null;
let initFailed = false;
let insertStmt = null;

function _init() {
  if (db || initFailed) return;
  try {
    db = new Database(DB_FILE);
    db.pragma('journal_mode = WAL');
    // Mirror gateway's api_usage schema exactly (gateway/db/client.ts:61-75).
    // CREATE IF NOT EXISTS is a no-op when the gateway already created it,
    // and the only case we'd be the first writer is if the gateway hasn't
    // booted yet — unlikely on prod but safe to handle.
    db.exec(`
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
    `);
    insertStmt = db.prepare(`
      INSERT INTO api_usage (request_id, agent_name, model, input_tokens, output_tokens, total_tokens, cost_usd, source, user_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    console.log(`[Anthropic-Telemetry] Connected to ${DB_FILE}`);
  } catch (e) {
    initFailed = true;
    console.warn(`[Anthropic-Telemetry] init failed — telemetry disabled: ${e.message}`);
  }
}

function calcCost(model, inputTokens, outputTokens) {
  const pricing = MODEL_PRICING[model] || DEFAULT_PRICING;
  return (inputTokens / 1_000_000) * pricing.input + (outputTokens / 1_000_000) * pricing.output;
}

/**
 * Record a single Anthropic API call.
 *
 * Never throws. Telemetry failures are logged but do not propagate.
 *
 * @param {Object}   params
 * @param {string}   params.model        — model ID from the request (e.g. 'claude-sonnet-4-20250514')
 * @param {Object}   [params.usage]      — claudeData.usage from the API response
 * @param {number}   [params.usage.input_tokens]
 * @param {number}   [params.usage.output_tokens]
 * @param {number}   [params.usage.cache_creation_input_tokens]
 * @param {number}   [params.usage.cache_read_input_tokens]
 * @param {string}   params.agentName    — short label for the call site (e.g. 'ai-query', 'slack-ai-respond')
 * @param {string}   [params.source]     — origin of the call (e.g. 'direct', 'slack-direct', 'slack-poller')
 * @param {string}   [params.userId]     — caller identity if known
 * @param {string}   [params.requestId]  — optional dedupe key
 */
function recordUsage(params) {
  _init();
  if (initFailed) return;

  try {
    const usage = params.usage || {};
    // Include cache tokens in the input count so the cost matches what
    // Anthropic actually bills (the 3 direct call sites don't currently
    // use prompt caching, but if they ever do this stays correct).
    const inputTokens =
      (usage.input_tokens || 0) +
      (usage.cache_creation_input_tokens || 0) +
      (usage.cache_read_input_tokens || 0);
    const outputTokens = usage.output_tokens || 0;
    const totalTokens = inputTokens + outputTokens;
    const costUsd = calcCost(params.model, inputTokens, outputTokens);

    insertStmt.run(
      params.requestId || null,
      params.agentName || 'unknown',
      params.model || 'unknown',
      inputTokens,
      outputTokens,
      totalTokens,
      costUsd,
      params.source || 'direct',
      params.userId || null
    );
  } catch (e) {
    console.warn(`[Anthropic-Telemetry] recordUsage failed: ${e.message}`);
  }
}

module.exports = { recordUsage, calcCost };
