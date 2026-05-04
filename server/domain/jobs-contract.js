// server/domain/jobs-contract.js
//
// Pure declarative field-write contract for the `jobs` table.
//
// STEP 1 of 12-step migration plan (approved 2026-05-04, scoping doc / task #19).
// This module has NO database access and NO production wiring. It encodes the
// priority + conflict resolution + guards that today are spread across 6
// writers and 1 SQL trigger in server/db.js, and exposes a single resolve()
// function that downstream wiring (step 2) will call.
//
// Authoritative source rules mirrored from server/db.js (line refs in comments):
//   - upsertJobFromTrace         server/db.js:3322-3428  (source = 'trace')
//   - upsertJobFromXML           server/db.js:3430-3528  (source = 'xml-shiplog')
//   - upsertJobClassificationFromXML
//                                server/db.js:3538-3605  (source = 'xml-classification')
//   - upsertShippedJob           server/db.js:2992-3078
//       inline back-prop subset  server/db.js:3045-3055  (source = 'shiplog-backprop')
//   - upsertJobFromSOM           server/db.js:3607-3630  (source = 'som')
//   - upsertJobFromLooker        server/db.js:3632-3649  (source = 'looker')
//   - enrichLensTypeFromPicks    server/db.js:1920-1958  (source = 'picks-derive')
//   - startup self-heal          server/oven-timer-server.js:131-142  (source = 'self-heal')
//
// Vocabulary:
//   priority      ordered list of source names; leftmost wins for `priority-wins`
//                 strategy. The wildcard '*' means "any source allowed".
//   onConflict    'first-non-null-wins' (COALESCE-style: keep first value seen),
//                 'priority-wins' (only listed sources may write; later sources
//                 ignored unless current is null/lower-priority),
//                 'last-non-null-wins' (overwrite with any non-null patch from
//                 an allowed source — used by transient/stateful telemetry),
//                 'max' (numeric/boolean: keep larger),
//                 'first-non-Y-wins' (custom: rush latch — once 'Y', stays 'Y'),
//                 'derive' (computed from other fields, not written directly).
//   guards        list of guard fns. Each receives ({currentRow, patch, source,
//                 newValue, currentValue}) and returns true to allow, false to
//                 block. A blocked field becomes a `skipped` entry with reason.

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Known sources (the only legal `source` values resolve() will accept).
// Mirrors the writer inventory at the top of this file.
// ─────────────────────────────────────────────────────────────────────────────
const SOURCES = Object.freeze([
  'trace',
  'xml-shiplog',
  'xml-classification',
  'shiplog-backprop',
  'som',
  'looker',
  'picks-derive',
  'self-heal',
]);

const TERMINAL_STAGES = new Set(['SHIPPED', 'CANCELED']);

// ─────────────────────────────────────────────────────────────────────────────
// Validation guards — exported individually for direct unit testing.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mirrors the numeric-invoice gate enforced in db.js:3397, db.js:3500, and
 * db.js:1949. The jobs PK MUST be all-digit ≥4 chars; anything else is a
 * malformed key (GUID, alpha, short legacy code) and must be rejected.
 */
function numericInvoiceGuard(invoice) {
  if (invoice == null) return false;
  return /^\d{4,}$/.test(String(invoice));
}

/**
 * Reject UUID-shaped values. Mirrors the picks_history.order_id GUID-shape
 * defense added in db.js:1967-1971 — the historical bug that caused the
 * 9,125-row picks_history corruption when ItemPath order GUIDs were
 * accidentally stored where DVI invoices belonged. Heuristic: ≥32 chars
 * AND contains ≥1 dash. Standard UUID is 36 chars (8-4-4-4-12).
 */
function guidShapeReject(value) {
  if (value == null) return true; // null is fine, only reject GUID shape
  const s = String(value);
  if (s.length < 32) return true;
  return !/-/.test(s);
}

/**
 * Block downgrades from terminal stages. Mirrors db.js:3342-3364 (current_stage,
 * current_station, current_station_num, status all guarded the same way).
 *
 * Returns true if the transition is allowed, false if blocked.
 *   currentStage === 'SHIPPED'  → only 'SHIPPED' allowed
 *   currentStage === 'CANCELED' → only 'CANCELED' allowed
 *   otherwise → any transition allowed
 */
function terminalStageGuard(currentStage, newStage) {
  if (currentStage == null) return true;
  const cur = String(currentStage).toUpperCase();
  if (!TERMINAL_STAGES.has(cur)) return true;
  if (newStage == null) return false; // can't blank a terminal stage either
  return String(newStage).toUpperCase() === cur;
}

// Wraps terminalStageGuard for use in FIELD_RULES.guards (which receive the
// full context object, not bare values).
function guardTerminalStage(ctx) {
  // currentValue is the field's current value (current_stage, current_station,
  // or current_station_num). For station/station_num we still need to consult
  // currentRow.current_stage, since stage is the source of truth for terminality.
  const curStage = ctx.currentRow ? ctx.currentRow.current_stage : null;
  if (!TERMINAL_STAGES.has(String(curStage || '').toUpperCase())) return true;
  // We're in a terminal row. Only allow updates to current_stage/status that
  // keep us in the same terminal state.
  if (ctx.field === 'current_stage' || ctx.field === 'status') {
    return terminalStageGuard(curStage, ctx.newValue);
  }
  // current_station / current_station_num: pin to existing value when terminal.
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Status derivation — mirrors db.js:3399-3403 (trace path) and db.js:3463
// (xml-shiplog forces SHIPPED). The contract treats `status` as derived from
// `current_stage` to remove an entire class of writer disagreement.
// ─────────────────────────────────────────────────────────────────────────────
function deriveStatus(currentStage) {
  const s = String(currentStage || '').toUpperCase();
  if (s === 'CANCELED') return 'CANCELED';
  if (s === 'SHIPPED' || s === 'COMPLETE') return 'SHIPPED';
  if (!s) return null;
  return 'ACTIVE';
}

// ─────────────────────────────────────────────────────────────────────────────
// FIELD_RULES — declarative ownership table.
//
// Conflict-strategy semantics for resolve():
//   priority-wins:        Only sources in `priority` may write. If a higher-
//                         priority source has already written (currentRow value
//                         present AND attributable to a higher-priority source
//                         via observedAt history), reject lower-priority.
//                         Within the same priority tier, last-write-wins.
//                         Because we don't yet have a per-field source-tag
//                         column, the practical implementation: source must be
//                         listed in `priority`, and any non-null patch value
//                         from an allowed source overwrites the current value.
//                         (When the per-field provenance table lands in step 4
//                         this becomes strict priority-wins.)
//   first-non-null-wins:  COALESCE(jobs.field, excluded.field). Source must
//                         appear in `priority`. If currentRow.field is non-null,
//                         the patch is skipped. Otherwise the patch wins.
//   last-non-null-wins:   Source must be in `priority`. Any non-null patch
//                         overwrites; null patch is ignored.
//   max:                  Numeric / boolean — keep MAX(current, patch).
//   first-non-Y-wins:     Rush latch — once value is 'Y', it sticks. Otherwise
//                         take the patch.
//   derive:               This field is computed from other fields by the
//                         resolver, not written by any source.
//
// Permissive fallback: any column NOT in this table is treated as
//   { priority: ['*'], onConflict: 'last-non-null-wins' }
// — see resolveFieldRule(). Add an explicit rule when ownership is decided.
// ─────────────────────────────────────────────────────────────────────────────

const FIELD_RULES = Object.freeze({
  // ── Identity ──────────────────────────────────────────────────────────────
  // invoice is the PK; never written via patch (it's the key). Listed for
  // documentation only.
  invoice: {
    priority: ['*'],
    onConflict: 'identity',
    guards: [],
    note: 'Primary key. Never updated by a patch; resolved upstream.',
  },

  // db.js:3370 (trace), :3449 (xml-shiplog), :3552 (xml-classification),
  // :3617 (som). All four use COALESCE; xml beats trace in practice because
  // it tends to land first with reference for jobs that come in via XML.
  // We codify: xml-shiplog > xml-classification > trace > som, first-non-null.
  // GUID-shape reject mirrors the picks_history.order_id defense.
  reference: {
    priority: ['xml-shiplog', 'xml-classification', 'trace', 'som'],
    onConflict: 'first-non-null-wins',
    guards: [(ctx) => guidShapeReject(ctx.newValue)],
  },

  // db.js:3371 (trace COALESCE jobs.first), :3450 (xml COALESCE jobs.first),
  // :3553 (classification COALESCE jobs.first). All "keep first non-null".
  rx_number: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // db.js:3336 (trace COALESCE excluded.tray, jobs.tray — i.e. trace OVERWRITES
  // when non-null), :3451 (xml COALESCE excluded, jobs — xml also overwrites).
  // Trace fires far more often than XML, so trace effectively owns this field.
  // Keeping it as first-non-null with trace first means trace's first write
  // sticks unless null-cleared.
  tray: {
    priority: ['trace', 'xml-shiplog'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // db.js:3357 (trace COALESCE excluded.operator, jobs.operator — trace
  // OVERWRITES on non-null), :3459 (xml COALESCE excluded, jobs — xml also
  // overwrites). Trace is the live operator stream so trace owns it.
  operator: {
    priority: ['trace', 'xml-shiplog'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // db.js:3358 (trace COALESCE excluded, jobs), :3461 (xml COALESCE excluded,
  // jobs). Last-non-null is the practical observed behavior.
  machine_id: {
    priority: ['trace', 'xml-shiplog'],
    onConflict: 'last-non-null-wins',
    guards: [],
  },

  // ── Lifecycle / dates ─────────────────────────────────────────────────────
  // db.js:3372 (trace), :3452 (xml), :3554 (classification). All COALESCE
  // jobs.first — i.e. first non-null sticks. Order of arrival drives.
  entry_date: {
    priority: ['xml-shiplog', 'xml-classification', 'trace', 'som'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  entry_time: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // db.js:3454 — xml OVERWRITES ship_date (no COALESCE). Only xml-shiplog
  // ever sets these.
  ship_date: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },
  ship_time: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },
  // db.js:3456 — COALESCE excluded, jobs (i.e. overwrite when xml has it).
  days_in_lab: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },

  // db.js:3374 (trace), :3457 (xml), :3556 (classification). All COALESCE
  // jobs.first. SOM doesn't write department here (it writes current_dept).
  department: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  job_type: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // db.js:3460 — xml COALESCE excluded, jobs. Only xml writes job_origin.
  job_origin: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },

  // ── Stage / station / status — the contested fields ──────────────────────
  // current_stage: trace is primary. shiplog-backprop and self-heal can flip
  // to SHIPPED. xml-shiplog forces SHIPPED via status side-effect (db.js:3463).
  // Once terminal (SHIPPED/CANCELED) NEVER downgrade. db.js:3342-3346.
  current_stage: {
    priority: ['shiplog-backprop', 'self-heal', 'xml-shiplog', 'trace'],
    onConflict: 'priority-wins',
    guards: [guardTerminalStage],
  },

  // db.js:3347-3356. Trace owns station; terminal-stage rows pin station.
  current_station: {
    priority: ['trace'],
    onConflict: 'priority-wins',
    guards: [guardTerminalStage],
  },
  current_station_num: {
    priority: ['trace'],
    onConflict: 'priority-wins',
    guards: [guardTerminalStage],
  },

  // status is DERIVED from current_stage. db.js:3360-3364 (trace), :3463
  // (xml). The contract treats status as a function of stage to eliminate
  // every "status disagrees with stage" defect.
  status: {
    priority: [],
    onConflict: 'derive',
    derive: (row) => deriveStatus(row.current_stage),
    guards: [],
  },

  // ── Lens classification — the "no owner" cluster (defect #3) ─────────────
  // db.js:3377 (trace COALESCE jobs.first), :3468 (xml COALESCE excluded.first
  // — XML OVERWRITES when non-null), :3559 (classification COALESCE jobs.first),
  // :1933 (picks-derive UPDATE COALESCE). The contract picks an explicit owner
  // ranking: xml-shiplog first (most authoritative — has the actual lens type
  // from the SHIPLOG XML), then xml-classification (re-process), then
  // picks-derive (Tier 3 fallback from picks_history), then trace (rarely
  // carries lensType but kept for completeness).
  lens_type: {
    priority: ['xml-shiplog', 'xml-classification', 'picks-derive', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // Same priority pattern as lens_type — XML is most authoritative, classification
  // backfills, picks-derive is Tier 3, trace rarely carries it.
  // db.js:3378 (trace), :3467 (xml), :3560 (classification), :1934 (picks-derive).
  lens_material: {
    priority: ['xml-shiplog', 'xml-classification', 'picks-derive', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // db.js:3379 (trace), :3466 (xml), :3561 (classification). picks-derive does
  // NOT touch lens_style.
  lens_style: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  lens_color: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  coating: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  coat_type: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // db.js:3383 (trace COALESCE jobs.first), :3464 (xml COALESCE excluded.first
  // — xml overwrites), :3565 (classification COALESCE jobs.first), :1935
  // (picks-derive COALESCE).
  lens_opc_r: {
    priority: ['xml-shiplog', 'xml-classification', 'picks-derive', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  lens_opc_l: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },

  // xml-shiplog only — db.js:3469.
  lens_pick_r: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },

  // ── Frame ────────────────────────────────────────────────────────────────
  // db.js:3385-3387 (trace), :3473-3478 (xml), :3567-3569 (classification).
  frame_upc: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  frame_name: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  frame_style: {
    priority: ['xml-shiplog', 'xml-classification', 'trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  // xml-only frame fields — db.js:3476-3481.
  frame_sku: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },
  frame_mfr: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },
  frame_color: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },
  eye_size: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },
  bridge: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },
  edge_type: {
    priority: ['xml-shiplog'],
    onConflict: 'priority-wins',
    guards: [],
  },

  // ── RX (xml-shiplog only) — db.js:3482-3491. ──────────────────────────────
  rx_r_sphere:   { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_r_cylinder: { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_r_axis:     { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_r_pd:       { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_r_add:      { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_l_sphere:   { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_l_cylinder: { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_l_axis:     { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_l_pd:       { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },
  rx_l_add:      { priority: ['xml-shiplog'], onConflict: 'priority-wins', guards: [] },

  // ── Booleans (max-merge: latch on once true) ─────────────────────────────
  // db.js:3376 / :3462 / :3558 — is_hko uses MAX (1 sticks).
  is_hko: {
    priority: ['*'],
    onConflict: 'max',
    guards: [],
  },
  // db.js:3365 — has_breakage MAX(jobs, excluded).
  has_breakage: {
    priority: ['*'],
    onConflict: 'max',
    guards: [],
  },

  // db.js:3369 — rush latches: once 'Y' it stays 'Y'. Trace is the typical writer.
  rush: {
    priority: ['trace'],
    onConflict: 'first-non-Y-wins',
    guards: [],
  },

  // ── Trace state (last-write-wins from trace only) ────────────────────────
  // db.js:3366-3368.
  first_seen_at: {
    priority: ['trace'],
    onConflict: 'first-non-null-wins',
    guards: [],
  },
  last_event_at: {
    priority: ['trace'],
    onConflict: 'last-non-null-wins',
    guards: [],
  },
  event_count: {
    priority: ['trace'],
    onConflict: 'last-non-null-wins',
    guards: [],
  },
  events_json: {
    priority: ['trace'],
    onConflict: 'last-non-null-wins',
    guards: [],
  },

  // ── SOM enrichment — db.js:3607-3620 (UPDATE-only, only writes via 'som'). ─
  som_order:      { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },
  current_dept:   { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },
  previous_dept:  { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },
  som_side:       { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },
  som_entry_date: { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },
  som_frame_no:   { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },
  som_frame_ref:  { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },
  som_lds:        { priority: ['som'], onConflict: 'last-non-null-wins', guards: [] },

  // ── Looker enrichment — db.js:3632-3640 (UPDATE-only by reference). ──────
  looker_job_id:   { priority: ['looker'], onConflict: 'last-non-null-wins', guards: [] },
  dvi_destination: { priority: ['looker'], onConflict: 'last-non-null-wins', guards: [] },
  count_lenses:    { priority: ['looker'], onConflict: 'last-non-null-wins', guards: [] },
  count_breakages: { priority: ['looker'], onConflict: 'last-non-null-wins', guards: [] },

  // ── System ────────────────────────────────────────────────────────────────
  // updated_at is set by the writer layer (datetime('now')); not in patch.
  updated_at: {
    priority: ['*'],
    onConflict: 'last-non-null-wins',
    guards: [],
  },
});

// Permissive fallback — any column not in FIELD_RULES is allowed last-write-wins.
// Add an explicit rule when the writer set is settled.
const DEFAULT_RULE = Object.freeze({
  priority: ['*'],
  onConflict: 'last-non-null-wins',
  guards: [],
});

function resolveFieldRule(field) {
  return FIELD_RULES[field] || DEFAULT_RULE;
}

function sourceAllowed(rule, source) {
  if (!rule.priority || rule.priority.length === 0) return false;
  if (rule.priority.includes('*')) return true;
  return rule.priority.includes(source);
}

// ─────────────────────────────────────────────────────────────────────────────
// resolve()
//
// currentRow:  current jobs row as an object (or undefined for INSERT).
// patch:       { fieldName: value, ... } — the proposed write.
// source:      one of SOURCES.
// observedAt:  ms timestamp; reserved for tiebreak in step-4 provenance work.
//
// Returns:
//   { changes:  { field: newValue, ... },          // fields to actually write
//     skipped:  ['fieldName1', ...],                // fields the patch tried but lost
//     reason:   { fieldName: 'reason-code', ... },  // why each skipped field lost
//     error?:   string                              // if the call itself was rejected
//   }
//
// resolve() is PURE: no DB access, no side effects. The caller is responsible
// for opening a transaction, applying `changes`, recording `reason` in the
// state_history audit log (step 2 / step 4), and re-checking guards as the
// row evolves within a batch.
// ─────────────────────────────────────────────────────────────────────────────

function resolve(currentRow, patch, source, observedAt) {
  // Fast-fail validation. Caller bugs should be loud, not silent COALESCE-eats-
  // them-all corruption.
  if (!source || !SOURCES.includes(source)) {
    return {
      changes: {},
      skipped: ['*'],
      reason: { '*': `unknown-source:${source}` },
      error: `unknown source: ${source}`,
    };
  }
  if (!patch || typeof patch !== 'object') {
    return {
      changes: {},
      skipped: ['*'],
      reason: { '*': 'patch-not-object' },
      error: 'patch must be a non-null object',
    };
  }

  // Looker keys by reference, not invoice (db.js:3639). Step 1 contract
  // accepts EITHER (a) a currentRow with a known invoice/reference, or
  // (b) a patch object — but the caller MUST supply currentRow.invoice
  // OR currentRow.reference. If neither, this is the looker-by-reference
  // case that step 9 of the migration handles. Reject for now.
  const haveKey = currentRow && (currentRow.invoice != null || currentRow.reference != null);
  if (source === 'looker' && !haveKey) {
    return {
      changes: {},
      skipped: ['*'],
      reason: { '*': 'no-invoice-key' },
      error: 'looker source requires currentRow.invoice or currentRow.reference (step 9)',
    };
  }

  const row = currentRow || {};
  const changes = {};
  const skipped = [];
  const reason = {};

  // Iterate patch keys (don't iterate FIELD_RULES — only fields the source
  // is actually trying to write should be considered).
  for (const field of Object.keys(patch)) {
    const newValue = patch[field];
    const currentValue = row[field];
    const rule = resolveFieldRule(field);

    // Identity-write fast path: if newValue === currentValue, no change.
    if (newValue === currentValue) {
      // Don't list as skipped — there's nothing to skip; values agree.
      continue;
    }

    // Status is derived; a source attempting to write it directly is rejected.
    if (rule.onConflict === 'derive') {
      skipped.push(field);
      reason[field] = 'derived-field';
      continue;
    }

    if (field === 'invoice') {
      skipped.push(field);
      reason[field] = 'pk-immutable';
      continue;
    }

    if (!sourceAllowed(rule, source)) {
      skipped.push(field);
      reason[field] = `source-not-permitted:${source}`;
      continue;
    }

    // Run guards.
    let blocked = false;
    if (rule.guards && rule.guards.length) {
      const ctx = { currentRow: row, patch, source, field, newValue, currentValue };
      for (const guard of rule.guards) {
        if (!guard(ctx)) {
          blocked = true;
          // Reason hint: terminal-stage block uses a distinct code so callers
          // (and audit tooling) can spot stage-downgrade attempts.
          if (guard === guardTerminalStage) {
            const cur = String(row.current_stage || '').toUpperCase();
            reason[field] = `guarded:${cur || 'TERMINAL'}`;
          } else {
            reason[field] = 'guarded';
          }
          break;
        }
      }
    }
    if (blocked) {
      skipped.push(field);
      continue;
    }

    // Apply the per-field conflict strategy.
    switch (rule.onConflict) {
      case 'first-non-null-wins': {
        // COALESCE(jobs.field, excluded.field) semantics — current sticks if
        // already non-null; otherwise patch wins (when non-null).
        if (currentValue != null) {
          skipped.push(field);
          reason[field] = 'first-non-null-already-set';
        } else if (newValue != null) {
          changes[field] = newValue;
        } else {
          // both null — nothing to do, not even a skip.
        }
        break;
      }
      case 'last-non-null-wins': {
        if (newValue != null) {
          changes[field] = newValue;
        } else {
          // null patch ignored; not really skipped because there's no value
          // to write.
        }
        break;
      }
      case 'priority-wins': {
        // Source is in priority list (sourceAllowed gated this). Practical
        // implementation: treat as last-non-null-wins among allowed sources.
        // When the per-field provenance table lands (step 4), enforce strict
        // priority by checking the recorded source of the current value.
        if (newValue != null) {
          changes[field] = newValue;
        }
        break;
      }
      case 'max': {
        const a = Number(currentValue || 0);
        const b = Number(newValue || 0);
        const max = a > b ? a : b;
        if (max !== currentValue) {
          changes[field] = max;
        }
        break;
      }
      case 'first-non-Y-wins': {
        if (currentValue === 'Y') {
          skipped.push(field);
          reason[field] = 'rush-latched';
        } else if (newValue != null) {
          changes[field] = newValue;
        }
        break;
      }
      case 'identity': {
        skipped.push(field);
        reason[field] = 'identity-field-immutable';
        break;
      }
      default: {
        skipped.push(field);
        reason[field] = `unknown-strategy:${rule.onConflict}`;
      }
    }
  }

  // Derive `status` from the resulting current_stage if either
  //   (a) current_stage is in the changes, or
  //   (b) the patch attempted to set status (which we just skipped above) and
  //       current_stage is already set on the row.
  const incomingStageWritten = Object.prototype.hasOwnProperty.call(changes, 'current_stage');
  const patchTriedStatus = Object.prototype.hasOwnProperty.call(patch, 'status');
  if (incomingStageWritten) {
    const newStatus = deriveStatus(changes.current_stage);
    if (newStatus != null && newStatus !== row.status) {
      changes.status = newStatus;
    }
  } else if (patchTriedStatus && row.current_stage != null) {
    // Caller asked for a status but current_stage didn't change. Re-derive
    // from the existing stage so status stays consistent.
    const newStatus = deriveStatus(row.current_stage);
    if (newStatus != null && newStatus !== row.status) {
      changes.status = newStatus;
    }
  }

  return { changes, skipped, reason };
}

module.exports = {
  // Core API
  FIELD_RULES,
  resolve,
  // Derivation helpers
  deriveStatus,
  // Guards (exported individually for direct unit testing)
  numericInvoiceGuard,
  guidShapeReject,
  terminalStageGuard,
  // Constants
  SOURCES,
  TERMINAL_STAGES,
};
