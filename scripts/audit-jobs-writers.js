#!/usr/bin/env node
'use strict';

// Step 5 of Task #19 — codebase audit script.
//
// Scans all .js files under the project for direct writes to the `jobs`
// table that bypass jobs-repo.js. The architecture invariant after
// Step 3b is: every INSERT/UPDATE/REPLACE on `jobs` must originate from
// server/domain/jobs-repo.js or one of the prepared statements created
// inside server/db.js (which the repo itself uses). Anything else is a
// bypass and should either route through jobsRepo.upsert(), or — if it
// genuinely needs raw SQL — be added to the allowlist in this script
// with a comment explaining why.
//
// Exits non-zero on findings so this can be wired into CI / pre-commit.
//
// Usage:
//   node scripts/audit-jobs-writers.js               # scan + report
//   node scripts/audit-jobs-writers.js --quiet       # only print on findings
//   node scripts/audit-jobs-writers.js --root /path  # scan a different dir

const fs = require('fs');
const path = require('path');

const ROOT = (() => {
  const ix = process.argv.indexOf('--root');
  return ix > 0 ? process.argv[ix + 1] : path.resolve(__dirname, '..');
})();
const QUIET = process.argv.includes('--quiet');

// Files that are ALLOWED to write to jobs directly. Add with a comment.
const ALLOWLIST = new Set([
  'server/db.js',                                // hosts the prepared statements jobs-repo uses
  'server/domain/jobs-repo.js',                  // the canonical write path
  'scripts/audit-jobs-writers.js',               // this file
  // ── Test fixtures (write to in-memory or temp DBs, not prod) ──
  'scripts/test-backfill-tier3.js',
  'scripts/test-inbound-xml-classification.js',
  'scripts/test-npi.js',
  'scripts/test-shipped-back-propagation.js',
  // ── One-shot historical migrations (no longer run) ──
  'scripts/migrate-to-unified-jobs.js',          // one-time DVI → unified jobs migration; complete
]);

// Patterns that indicate a write to the jobs table.
// Word-boundary on `jobs` so we don't match `dvi_shipped_jobs`, `looker_jobs`, etc.
const PATTERNS = [
  /\bINSERT\s+(?:OR\s+(?:REPLACE|IGNORE|ABORT|FAIL|ROLLBACK)\s+)?INTO\s+jobs\b/i,
  /\bUPDATE\s+jobs\s+SET\b/i,
  /\bREPLACE\s+INTO\s+jobs\b/i,
];

// Skip these directories entirely.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.claude']);

const findings = [];

function scanFile(absPath) {
  const rel = path.relative(ROOT, absPath);
  if (ALLOWLIST.has(rel)) return;
  if (!absPath.endsWith('.js') && !absPath.endsWith('.sql')) return;

  let text;
  try { text = fs.readFileSync(absPath, 'utf8'); }
  catch { return; }

  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const re of PATTERNS) {
      if (re.test(line)) {
        // Trim very long lines for readability
        const snippet = line.trim().slice(0, 160);
        findings.push({ file: rel, lineNumber: i + 1, snippet });
        break;
      }
    }
  }
}

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch { return; }
  for (const e of entries) {
    if (SKIP_DIRS.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full);
    else if (e.isFile()) scanFile(full);
  }
}

walk(ROOT);

if (findings.length === 0) {
  if (!QUIET) console.log('[audit-jobs-writers] clean — no direct writes to jobs outside the allowlist');
  process.exit(0);
}

console.log(`[audit-jobs-writers] FOUND ${findings.length} direct write(s) to \`jobs\` outside the allowlist:\n`);
for (const f of findings) {
  console.log(`  ${f.file}:${f.lineNumber}`);
  console.log(`    ${f.snippet}`);
}
console.log('');
console.log('Each of the above should either:');
console.log('  1. Route through jobsRepo.upsert() in server/domain/jobs-repo.js, or');
console.log('  2. Be added to the ALLOWLIST in scripts/audit-jobs-writers.js with a comment explaining why.');
process.exit(1);
