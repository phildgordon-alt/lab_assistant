#!/usr/bin/env node
/**
 * daily-reconcile.js — runs once per day, posts data-validity report to Slack.
 *
 * Run via cron (5 AM PT recommended):
 *   0 5 * * * /usr/local/bin/node /Users/Shared/lab_assistant/scripts/daily-reconcile.js
 *
 * Two layers:
 *   (1) Health metrics — same as scripts/health-check.sql, every metric should be 0 (or
 *       documented residual). Anything non-zero gets a 🔴 in the Slack message.
 *   (2) Source-comparison — row counts across systems that SHOULD line up:
 *       jobs vs dvi_shipped_jobs vs picks_history vs daily-export jobs.
 *
 * Always posts (even on green) so a missing post is itself a signal that the cron
 * died — silence is suspicious. Set SLACK_WEBHOOK env var to enable; otherwise logs.
 *
 * Exit codes:
 *   0 — all green
 *   1 — at least one metric red (so cron mailer / monitoring can pick it up too)
 *   2 — script-level error (DB unreadable, etc.)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.resolve(__dirname, '..');
const DB_PATH = path.join(ROOT, 'data', 'lab_assistant.db');
const DAILY_DIR = path.join(ROOT, 'data', 'dvi', 'daily');
const SHIPPED_DIR = path.join(ROOT, 'data', 'dvi', 'shipped');

const SLACK_WEBHOOK = process.env.SLACK_WEBHOOK || '';

function asInt(n) { return n == null ? 0 : Number(n) | 0; }

function countDvi(dir, pattern) {
  if (!fs.existsSync(dir)) return 0;
  const re = new RegExp(pattern);
  return fs.readdirSync(dir).filter(f => re.test(f)).length;
}

function main() {
  if (!fs.existsSync(DB_PATH)) { console.error('DB not found:', DB_PATH); process.exit(2); }
  const db = new Database(DB_PATH, { readonly: true });

  // ── Layer 1: health metrics ────────────────────────────────────────────────
  // Mirror of scripts/health-check.sql — duplicated here so this script is
  // self-contained for cron (no shell pipe through sqlite3 binary).
  const m = {};
  m.guid_orphans = asInt(db.prepare(
    `SELECT COUNT(*) AS n FROM picks_history WHERE LENGTH(order_id) >= 32 AND order_id LIKE '%-%'`
  ).get().n);
  m.picks_orphans = asInt(db.prepare(
    `SELECT COUNT(*) AS n FROM picks_history ph LEFT JOIN jobs j ON j.invoice = ph.order_id WHERE j.invoice IS NULL`
  ).get().n);
  m.past_pick_violations = asInt(db.prepare(
    `SELECT COUNT(DISTINCT j.invoice) AS n FROM jobs j JOIN picks_history ph ON ph.order_id = j.invoice
       WHERE j.status NOT IN ('SHIPPED','CANCELLED','CANCELED') AND (j.lens_type IS NULL OR j.lens_type = '')`
  ).get().n);
  m.corrupt_invoices = asInt(db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE invoice NOT GLOB '[0-9][0-9][0-9][0-9]*' OR invoice IS NULL`
  ).get().n);
  m.shipped_xref_not_propagated = asInt(db.prepare(
    `SELECT COUNT(*) AS n FROM dvi_shipped_jobs dsj JOIN jobs j ON j.invoice = dsj.invoice WHERE j.status != 'SHIPPED'`
  ).get().n);
  m.stale_shipping_no_xref = asInt(db.prepare(
    `SELECT COUNT(*) AS n FROM jobs j WHERE j.current_stage = 'SHIPPING' AND j.status != 'SHIPPED'
       AND (j.last_event_at IS NULL OR j.last_event_at < datetime('now','-7 days'))
       AND NOT EXISTS (SELECT 1 FROM dvi_shipped_jobs dsj WHERE dsj.invoice = j.invoice)`
  ).get().n);
  m.active_wip_null_lens_type = asInt(db.prepare(
    `SELECT COUNT(*) AS n FROM jobs WHERE status NOT IN ('SHIPPED','CANCELLED','CANCELED')
       AND (lens_type IS NULL OR lens_type = '')`
  ).get().n);

  // shipped_no_xref column is only present after reconcile-shipped-jobs.js ran.
  // Treat absence as 0 — flag is informational anyway.
  let shipped_no_xref_count = 0;
  try {
    shipped_no_xref_count = asInt(db.prepare(
      `SELECT COUNT(*) AS n FROM jobs WHERE shipped_no_xref = 1`
    ).get().n);
  } catch { /* column missing — fine */ }
  m.shipped_no_xref_count = shipped_no_xref_count;

  // ── Layer 2: source-comparison row counts ──────────────────────────────────
  // These should line up roughly. Big drift is the early-warning signal.
  const cmp = {};
  cmp.jobs_active             = asInt(db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='ACTIVE'`).get().n);
  cmp.jobs_shipped            = asInt(db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE status='SHIPPED'`).get().n);
  cmp.jobs_total              = asInt(db.prepare(`SELECT COUNT(*) AS n FROM jobs`).get().n);
  cmp.dvi_shipped_jobs        = asInt(db.prepare(`SELECT COUNT(*) AS n FROM dvi_shipped_jobs`).get().n);
  cmp.picks_history_total     = asInt(db.prepare(`SELECT COUNT(*) AS n FROM picks_history`).get().n);
  cmp.picks_table_active      = asInt(db.prepare(`SELECT COUNT(*) AS n FROM picks WHERE archived=0`).get().n);

  // On-disk sources (the SMB syncs)
  cmp.dvi_inbound_xml_on_disk = countDvi(path.join(ROOT, 'data', 'dvi', 'jobs'), '\\.xml$');
  cmp.dvi_shiplog_xml_on_disk = countDvi(SHIPPED_DIR, '\\.xml$');
  cmp.dvi_daily_files_on_disk = countDvi(DAILY_DIR, '_D_a_jobdta\\.txt$');

  // Drift signals
  cmp.shipped_jobs_vs_xref_drift = cmp.jobs_shipped - cmp.dvi_shipped_jobs;

  // ── Verdict ────────────────────────────────────────────────────────────────
  // Each metric → red (must be 0) or info (just informational).
  const RED_THRESHOLDS = {
    guid_orphans:                0,
    picks_orphans:               null, // historical residual — track only
    past_pick_violations:        0,
    corrupt_invoices:            0,
    shipped_xref_not_propagated: 0,
    stale_shipping_no_xref:      0,
    active_wip_null_lens_type:   null, // residual — track only
    shipped_no_xref_count:       null, // informational
  };

  const reds = [];
  for (const [k, threshold] of Object.entries(RED_THRESHOLDS)) {
    if (threshold === null) continue;
    if (m[k] > threshold) reds.push(`${k} = ${m[k]} (expected ≤ ${threshold})`);
  }

  // ── Compose Slack message ──────────────────────────────────────────────────
  const dateStr = new Date().toISOString().slice(0,10);
  const verdict = reds.length === 0 ? '🟢 all green' : `🔴 ${reds.length} red metric${reds.length === 1 ? '' : 's'}`;

  const lines = [
    `*Lab_Assistant daily reconcile — ${dateStr}*`,
    verdict,
    '',
    '*Health metrics (must be 0 unless residual):*',
    `• guid_orphans:               ${m.guid_orphans}`,
    `• picks_orphans:              ${m.picks_orphans}  _(historical residual)_`,
    `• past_pick_violations:       ${m.past_pick_violations}`,
    `• corrupt_invoices:           ${m.corrupt_invoices}`,
    `• shipped_xref_not_propagated:${m.shipped_xref_not_propagated}`,
    `• stale_shipping_no_xref:     ${m.stale_shipping_no_xref}`,
    `• active_wip_null_lens_type:  ${m.active_wip_null_lens_type}  _(residual, track downward)_`,
    `• shipped_no_xref_count:      ${m.shipped_no_xref_count}  _(informational)_`,
    '',
    '*Source-comparison (drift = something stopped flowing):*',
    `• jobs total / active / shipped:   ${cmp.jobs_total} / ${cmp.jobs_active} / ${cmp.jobs_shipped}`,
    `• dvi_shipped_jobs xref:           ${cmp.dvi_shipped_jobs}`,
    `• shipped vs xref drift:           ${cmp.shipped_jobs_vs_xref_drift}`,
    `• picks_history total:             ${cmp.picks_history_total}`,
    `• picks (live mirror, active):     ${cmp.picks_table_active}`,
    `• inbound XML on disk:             ${cmp.dvi_inbound_xml_on_disk}`,
    `• SHIPLOG XML on disk:             ${cmp.dvi_shiplog_xml_on_disk}`,
    `• daily-export files on disk:      ${cmp.dvi_daily_files_on_disk}`,
  ];
  if (reds.length > 0) {
    lines.push('');
    lines.push('*Red detail:*');
    for (const r of reds) lines.push(`• ${r}`);
  }
  const text = lines.join('\n');

  // ── Post / log ─────────────────────────────────────────────────────────────
  console.log(text);

  if (SLACK_WEBHOOK) {
    // Use require('https') instead of fetch — avoid pulling in undici for a 1-shot script.
    const https = require('https');
    const url = new URL(SLACK_WEBHOOK);
    const body = JSON.stringify({ text });
    const req = https.request({
      method: 'POST',
      hostname: url.hostname,
      path: url.pathname + url.search,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, (res) => {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        console.log(`[daily-reconcile] Slack OK (HTTP ${res.statusCode})`);
      } else {
        console.error(`[daily-reconcile] Slack HTTP ${res.statusCode}`);
      }
      // Set exit code on next tick so Slack request completes first
      process.exitCode = reds.length > 0 ? 1 : 0;
    });
    req.on('error', (e) => {
      console.error(`[daily-reconcile] Slack send failed: ${e.message}`);
      process.exitCode = 2;
    });
    req.write(body);
    req.end();
  } else {
    console.warn('[daily-reconcile] SLACK_WEBHOOK not set — report logged only.');
    process.exitCode = reds.length > 0 ? 1 : 0;
  }
}

main();
