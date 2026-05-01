/**
 * Adapter watchdog — continuous Slack alerting for adapter health.
 *
 * Reads sync_heartbeats every 5 minutes and Slacks when any source goes:
 *   - ERRORING: consecutive_errors >= 3 (sustained, not transient)
 *   - STALE:    no successful poll in stale_threshold_ms * 2
 *
 * Dedupes by tracking last-alerted state per source in memory — only fires
 * when state changes, so a source erroring for an hour Slacks once, not 12x.
 * Posts a recovery message when a previously-alerted source flips back healthy.
 *
 * Complements scripts/data-health-check.js (1:30 AM daily): this catches
 * mid-day deaths within minutes; the daily check is the safety net.
 */

'use strict';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const ERROR_THRESHOLD  = 3;             // consecutive_errors that count as ERRORING
const STALE_MULTIPLIER = 2;             // stale = no success in threshold * this

// Naming inconsistency across the codebase: data-health-check.js uses
// SLACK_WEBHOOK_URL, daily-reconcile.js uses SLACK_WEBHOOK. Accept either —
// whichever the prod .env has set will work.
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || process.env.SLACK_WEBHOOK || '';

// In-memory last-known-state per source. Map<source, 'healthy' | 'erroring' | 'stale'>
const lastState = new Map();
let timer = null;

function _evaluate(row) {
  const now = Date.now();
  const ageMs = row.last_success_at ? now - row.last_success_at : Infinity;
  const staleLimit = (row.stale_threshold_ms || 60 * 60 * 1000) * STALE_MULTIPLIER;
  if ((row.consecutive_errors || 0) >= ERROR_THRESHOLD) return 'erroring';
  if (ageMs > staleLimit) return 'stale';
  return 'healthy';
}

async function _slack(text) {
  // No webhook configured? Skip the network call but still log so the alert
  // is visible in stdout / lab-server.log. State tracking still runs and
  // /api/watchdog/state still surfaces the per-source state map.
  if (!SLACK_WEBHOOK_URL) {
    console.log('[adapter-watchdog]', text.replace(/\n/g, ' '));
    return;
  }
  try {
    await fetch(SLACK_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
    });
  } catch (e) {
    console.error('[adapter-watchdog] Slack post failed:', e.message);
  }
}

async function _check() {
  let labDb;
  try { labDb = require('./db'); } catch (e) {
    console.error('[adapter-watchdog] cannot load ./db:', e.message);
    return;
  }

  let rows;
  try {
    rows = labDb.db.prepare(`
      SELECT source, last_success_at, last_row_count, last_error,
             consecutive_errors, stale_threshold_ms
      FROM sync_heartbeats
    `).all();
  } catch (e) {
    console.error('[adapter-watchdog] sync_heartbeats query failed:', e.message);
    return;
  }

  for (const row of rows) {
    const state = _evaluate(row);
    const prev = lastState.get(row.source);

    // No state change → nothing to do
    if (state === prev) continue;

    // First-ever observation: record but only alert if not healthy
    if (prev === undefined && state === 'healthy') {
      lastState.set(row.source, state);
      continue;
    }

    lastState.set(row.source, state);

    if (state === 'erroring') {
      const ageMin = row.last_success_at ? Math.round((Date.now() - row.last_success_at) / 60000) : '?';
      await _slack(
        `:rotating_light: *adapter erroring — ${row.source}*\n` +
        `• consecutive errors: ${row.consecutive_errors}\n` +
        `• last successful poll: ${ageMin} min ago\n` +
        `• last error: ${row.last_error || '(none recorded)'}`
      );
    } else if (state === 'stale') {
      const ageMin = row.last_success_at ? Math.round((Date.now() - row.last_success_at) / 60000) : '?';
      const thresholdMin = Math.round((row.stale_threshold_ms || 0) / 60000);
      await _slack(
        `:warning: *adapter stale — ${row.source}*\n` +
        `• no successful poll in ${ageMin} min (threshold ${thresholdMin} min × ${STALE_MULTIPLIER})\n` +
        `• consecutive errors: ${row.consecutive_errors || 0}\n` +
        `• last error: ${row.last_error || '(none recorded)'}`
      );
    } else if (state === 'healthy' && (prev === 'erroring' || prev === 'stale')) {
      await _slack(`:white_check_mark: *adapter recovered — ${row.source}* — back to healthy.`);
    }
  }
}

function start() {
  if (timer) return;
  if (!SLACK_WEBHOOK_URL) {
    // No Slack — watchdog still runs, populates /api/watchdog/state, and
    // logs alerts to stdout. Add SLACK_WEBHOOK_URL or SLACK_WEBHOOK to .env
    // when you want alerts pushed to a channel.
    console.log('[adapter-watchdog] Starting — no Slack webhook configured, alerts logged to stdout only');
  } else {
    console.log(`[adapter-watchdog] Starting — checking sync_heartbeats every ${POLL_INTERVAL_MS / 60000} min, alerts to Slack`);
  }
  // First check after 60s (let adapters settle on boot), then every POLL_INTERVAL_MS
  setTimeout(() => {
    _check().catch(e => console.error('[adapter-watchdog] check error:', e.message));
    timer = setInterval(() => {
      _check().catch(e => console.error('[adapter-watchdog] check error:', e.message));
    }, POLL_INTERVAL_MS);
  }, 60000);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
  console.log('[adapter-watchdog] Stopped.');
}

function getState() {
  return Object.fromEntries(lastState);
}

module.exports = { start, stop, getState };
