/**
 * nightly-etl.js
 * Lab_Assistant — Nightly historical data sync
 * Pulls from Looker + DVI via email attachment or API
 * Runs at 2:00 AM via cron, writes to /data/historical/
 *
 * SETUP:
 *   node nightly-etl.js          → manual run (test)
 *   Add to crontab:
 *   0 2 * * * /usr/bin/node /path/to/nightly-etl.js >> /var/log/la-etl.log 2>&1
 *
 * DIRECTORY STRUCTURE CREATED:
 *   /data/historical/
 *     throughput_YYYY-MM-DD.json   ← from Looker
 *     yield_YYYY-MM-DD.json        ← from Looker
 *     jobs_YYYY-MM-DD.json         ← from DVI
 *     sync-log.json                ← last N sync results
 */

'use strict';

const fs   = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  dataDir:      process.env.LA_DATA_DIR || path.join(__dirname, 'data', 'historical'),
  slackWebhook: process.env.SLACK_WEBHOOK || '',

  // ── Looker API ──────────────────────────────────────────────────────────────
  // Option A: Looker API (preferred if you have access)
  looker: {
    enabled:   !!process.env.LOOKER_CLIENT_ID,
    baseUrl:   process.env.LOOKER_URL    || 'https://your-company.looker.com',
    clientId:  process.env.LOOKER_CLIENT_ID  || '',
    clientSecret: process.env.LOOKER_CLIENT_SECRET || '',
    // Look IDs to pull — find these in the Looker URL when viewing a Look
    looks: {
      throughput: process.env.LOOKER_LOOK_THROUGHPUT || '101',  // daily throughput look
      yield:      process.env.LOOKER_LOOK_YIELD      || '102',  // yield/breakage look
      cycleTimes: process.env.LOOKER_LOOK_CYCLES     || '103',  // job cycle time look
    },
  },

  // ── Email / IMAP ─────────────────────────────────────────────────────────────
  // Option B: Parse nightly email attachments from Looker/DVI
  email: {
    enabled:  !!process.env.EMAIL_HOST,
    host:     process.env.EMAIL_HOST     || 'imap.gmail.com',
    port:     parseInt(process.env.EMAIL_PORT || '993'),
    tls:      true,
    user:     process.env.EMAIL_USER     || 'labdata@paireyewear.com',
    password: process.env.EMAIL_PASS     || '',
    // Only process emails from these senders
    allowedSenders: [
      'noreply@looker.com',
      'reports@paireyewear.com',
      'dvi@paireyewear.com',
      process.env.EMAIL_ALLOWED_SENDER || '',
    ].filter(Boolean),
    // Subject line patterns to identify report type
    subjectPatterns: {
      throughput: /throughput|production.daily/i,
      yield:      /yield|breakage|scrap/i,
      jobs:       /jobs.completed|dvi.export|job.archive/i,
    },
  },

  // ── DVI ──────────────────────────────────────────────────────────────────────
  dvi: {
    enabled:  !!process.env.DVI_URL,
    baseUrl:  process.env.DVI_URL      || '',
    apiKey:   process.env.DVI_API_KEY  || '',
    // DVI endpoint for completed jobs — adjust to match your DVI version
    jobsEndpoint: '/api/v1/jobs/completed',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FILESYSTEM SETUP
// ─────────────────────────────────────────────────────────────────────────────
function ensureDataDir() {
  if (!fs.existsSync(CONFIG.dataDir)) {
    fs.mkdirSync(CONFIG.dataDir, { recursive: true });
    console.log(`[ETL] Created data dir: ${CONFIG.dataDir}`);
  }
}

function writeDaily(type, date, data) {
  const file = path.join(CONFIG.dataDir, `${type}_${date}.json`);
  fs.writeFileSync(file, JSON.stringify({ date, type, records: data, savedAt: new Date().toISOString() }, null, 2));
  console.log(`[ETL] ✓ Wrote ${data.length} records → ${path.basename(file)}`);
  return file;
}

function logSync(results) {
  const logFile = path.join(CONFIG.dataDir, 'sync-log.json');
  let log = [];
  try { log = JSON.parse(fs.readFileSync(logFile, 'utf8')); } catch {}
  log.unshift({ ...results, timestamp: new Date().toISOString() });
  fs.writeFileSync(logFile, JSON.stringify(log.slice(0, 90), null, 2));  // keep 90 days
}

// ─────────────────────────────────────────────────────────────────────────────
// DATE HELPER — yesterday in YYYY-MM-DD
// ─────────────────────────────────────────────────────────────────────────────
function yesterday() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOKER PULL — authenticates + fetches Look results as JSON
// ─────────────────────────────────────────────────────────────────────────────
async function pullLooker(date) {
  if (!CONFIG.looker.enabled) {
    console.log('[ETL] Looker not configured — skipping');
    return { throughput: null, yield: null };
  }

  // Step 1: Get access token (Looker uses OAuth2 client credentials)
  const tokenResp = await fetch(`${CONFIG.looker.baseUrl}/api/4.0/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `client_id=${CONFIG.looker.clientId}&client_secret=${CONFIG.looker.clientSecret}`,
  });
  if (!tokenResp.ok) throw new Error(`Looker login failed: ${tokenResp.status}`);
  const { access_token } = await tokenResp.json();

  const lookerFetch = (path) => fetch(`${CONFIG.looker.baseUrl}${path}`, {
    headers: { 'Authorization': `token ${access_token}`, 'Content-Type': 'application/json' },
  }).then(r => r.json());

  // Step 2: Fetch each Look — run_look returns rows as JSON
  // Filter to yesterday by passing date range via Look filters
  const [throughputRows, yieldRows, cycleRows] = await Promise.all([
    lookerFetch(`/api/4.0/looks/${CONFIG.looker.looks.throughput}/run/json?filters[date]=${date}`),
    lookerFetch(`/api/4.0/looks/${CONFIG.looker.looks.yield}/run/json?filters[date]=${date}`),
    lookerFetch(`/api/4.0/looks/${CONFIG.looker.looks.cycleTimes}/run/json?filters[date]=${date}`),
  ]);

  // Normalize Looker rows to Lab_Assistant format
  const throughput = (throughputRows || []).map(r => ({
    date,
    zone:      r['zone'] || r['department'] || r['production.zone'],
    jobsIn:    parseInt(r['jobs_in']  || r['production.jobs_in']  || 0),
    jobsOut:   parseInt(r['jobs_out'] || r['production.jobs_out'] || 0),
    avgMinutes: parseFloat(r['avg_minutes'] || r['production.avg_cycle_time'] || 0),
  }));

  const yieldData = (yieldRows || []).map(r => ({
    date,
    coatingType: r['coating_type'] || r['coating'],
    total:       parseInt(r['total']   || r['jobs.total']   || 0),
    broken:      parseInt(r['broken']  || r['jobs.broken']  || 0),
    yieldPct:    parseFloat(r['yield'] || r['jobs.yield']   || 0),
  }));

  const cycles = (cycleRows || []).map(r => ({
    date,
    zone:         r['zone'] || r['department'],
    avgCycleMin:  parseFloat(r['avg_cycle_min'] || 0),
    p95CycleMin:  parseFloat(r['p95_cycle_min'] || 0),
    jobCount:     parseInt(r['job_count'] || 0),
  }));

  writeDaily('throughput', date, throughput);
  writeDaily('yield',      date, yieldData);
  writeDaily('cycle-times',date, cycles);

  return { throughput, yield: yieldData, cycles };
}

// ─────────────────────────────────────────────────────────────────────────────
// DVI PULL — fetch completed jobs from DVI API
// ─────────────────────────────────────────────────────────────────────────────
async function pullDVI(date) {
  if (!CONFIG.dvi.enabled) {
    console.log('[ETL] DVI not configured — skipping');
    return null;
  }

  const resp = await fetch(
    `${CONFIG.dvi.baseUrl}${CONFIG.dvi.jobsEndpoint}?date=${date}`,
    { headers: { 'X-API-Key': CONFIG.dvi.apiKey, 'Accept': 'application/json' } }
  );
  if (!resp.ok) throw new Error(`DVI fetch failed: ${resp.status}`);
  const data = await resp.json();

  // Normalize DVI jobs — field names will depend on your DVI version
  const jobs = (data.jobs || data || []).map(j => ({
    jobId:       j.job_id || j.id,
    rxSpec:      j.rx_spec || j.prescription,
    lensType:    j.lens_type || j.product,
    coatingType: j.coating_type || j.coating,
    status:      j.status,
    completedAt: j.completed_at || j.completion_date,
    cycleMinutes: j.cycle_minutes || null,
    broken:      j.broken || false,
    breakReason: j.break_reason || null,
  }));

  writeDaily('jobs', date, jobs);
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────────
// EMAIL PARSE — IMAP inbox reader for nightly report emails
// Requires: npm install imap mailparser
// ─────────────────────────────────────────────────────────────────────────────
async function pullFromEmail(date) {
  if (!CONFIG.email.enabled) {
    console.log('[ETL] Email not configured — skipping');
    return null;
  }

  // Dynamic require so server starts even if imap not installed
  let Imap, simpleParser;
  try {
    Imap         = require('imap');
    simpleParser = require('mailparser').simpleParser;
  } catch {
    console.warn('[ETL] Email pull requires: npm install imap mailparser');
    return null;
  }

  return new Promise((resolve, reject) => {
    const imap = new Imap({
      user:     CONFIG.email.user,
      password: CONFIG.email.password,
      host:     CONFIG.email.host,
      port:     CONFIG.email.port,
      tls:      CONFIG.email.tls,
    });

    const results = {};

    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err, box) => {
        if (err) { imap.end(); return reject(err); }

        // Search for emails since yesterday
        imap.search(['UNSEEN', ['SINCE', new Date(date)]], (err, uids) => {
          if (err || !uids.length) { imap.end(); return resolve(results); }

          const f = imap.fetch(uids, { bodies: '', struct: true });
          f.on('message', (msg) => {
            let buffer = '';
            msg.on('body', stream => { stream.on('data', c => buffer += c); });
            msg.once('end', async () => {
              try {
                const parsed = await simpleParser(buffer);
                const from   = parsed.from?.value?.[0]?.address || '';
                const subject = parsed.subject || '';

                // Check sender is allowed
                if (!CONFIG.email.allowedSenders.some(s => from.includes(s))) return;

                // Identify report type from subject
                let reportType = null;
                for (const [type, pattern] of Object.entries(CONFIG.email.subjectPatterns)) {
                  if (pattern.test(subject)) { reportType = type; break; }
                }
                if (!reportType) return;

                // Parse CSV attachments
                const csvAttachment = parsed.attachments?.find(a =>
                  a.contentType === 'text/csv' || a.filename?.endsWith('.csv')
                );
                if (!csvAttachment) return;

                const rows = parseCSV(csvAttachment.content.toString());
                writeDaily(reportType, date, rows);
                results[reportType] = rows;
                console.log(`[ETL] ✓ Email parsed: ${reportType} — ${rows.length} rows from ${from}`);
              } catch (e) {
                console.warn('[ETL] Email parse error:', e.message);
              }
            });
          });

          f.once('end', () => { imap.end(); resolve(results); });
        });
      });
    });

    imap.once('error', reject);
    imap.connect();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SIMPLE CSV PARSER — handles quoted fields
// ─────────────────────────────────────────────────────────────────────────────
function parseCSV(text) {
  const lines = text.trim().split('\n');
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.trim().replace(/"/g,'').toLowerCase().replace(/\s+/g,'_'));
  return lines.slice(1).map(line => {
    const vals = line.split(',').map(v => v.trim().replace(/"/g,''));
    return Object.fromEntries(headers.map((h,i) => [h, vals[i] || '']));
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SLACK NOTIFICATION — success/failure summary
// ─────────────────────────────────────────────────────────────────────────────
async function notify(summary) {
  if (!CONFIG.slackWebhook) return;
  const icon = summary.errors.length ? '⚠️' : '✅';
  const lines = [
    `${icon} *Lab_Assistant Nightly Sync — ${summary.date}*`,
    summary.looker    ? `• Looker: ${summary.looker.throughput?.length||0} throughput, ${summary.looker.yield?.length||0} yield records` : '• Looker: skipped',
    summary.dvi       ? `• DVI: ${summary.dvi?.length||0} jobs` : '• DVI: skipped',
    summary.email     ? `• Email: ${Object.keys(summary.email).join(', ')}` : null,
    summary.errors.length ? `• Errors: ${summary.errors.join(', ')}` : null,
    `• Duration: ${summary.durationMs}ms`,
  ].filter(Boolean);

  await fetch(CONFIG.slackWebhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: lines.join('\n') }),
  }).catch(e => console.warn('[ETL] Slack notify failed:', e.message));
}

// ─────────────────────────────────────────────────────────────────────────────
// READ HISTORICAL — used by Lab_Assistant server to answer AI queries
// ─────────────────────────────────────────────────────────────────────────────
function readHistorical(type, days = 30) {
  const results = [];
  for (let i = 0; i < days; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const date = d.toISOString().slice(0, 10);
    const file = path.join(CONFIG.dataDir, `${type}_${date}.json`);
    if (fs.existsSync(file)) {
      try {
        const data = JSON.parse(fs.readFileSync(file, 'utf8'));
        results.push(...(data.records || []));
      } catch {}
    }
  }
  return results;
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────────────────────────────────────
async function main() {
  const start  = Date.now();
  const date   = yesterday();
  const errors = [];
  ensureDataDir();

  console.log(`[ETL] Starting nightly sync for ${date}`);

  const summary = { date, looker: null, dvi: null, email: null, errors, durationMs: 0 };

  // Run all pulls — don't let one failure block the others
  const [lookerResult, dviResult, emailResult] = await Promise.allSettled([
    pullLooker(date),
    pullDVI(date),
    pullFromEmail(date),
  ]);

  if (lookerResult.status === 'fulfilled') summary.looker = lookerResult.value;
  else { errors.push(`Looker: ${lookerResult.reason?.message}`); console.error('[ETL] Looker failed:', lookerResult.reason?.message); }

  if (dviResult.status === 'fulfilled') summary.dvi = dviResult.value;
  else { errors.push(`DVI: ${dviResult.reason?.message}`); console.error('[ETL] DVI failed:', dviResult.reason?.message); }

  if (emailResult.status === 'fulfilled') summary.email = emailResult.value;
  else { errors.push(`Email: ${emailResult.reason?.message}`); console.error('[ETL] Email failed:', emailResult.reason?.message); }

  summary.durationMs = Date.now() - start;
  logSync(summary);
  await notify(summary);

  console.log(`[ETL] Complete — ${summary.durationMs}ms — ${errors.length} errors`);
  process.exit(errors.length ? 1 : 0);
}

main().catch(e => { console.error('[ETL] Fatal:', e); process.exit(1); });

// Export for use in oven-timer-server.js
module.exports = { readHistorical };
