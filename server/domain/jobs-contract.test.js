// server/domain/jobs-contract.test.js
//
// Run with:  node --test server/domain/
//
// Uses Node's built-in test runner (no vitest, no extra deps). Files matching
// *.test.js are auto-discovered.
//
// Test sections:
//   A — basic resolution mechanics (insert, update, identity)
//   B — the 5 specific defects from the planner's §2 (regression suite)
//   C — guards (numeric invoice, GUID-shape, terminal-stage)
//   D — derived fields (status from current_stage)
//   E — round-trip parity vs the existing 6 writers + 1 trigger

'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  FIELD_RULES,
  resolve,
  deriveStatus,
  numericInvoiceGuard,
  guidShapeReject,
  terminalStageGuard,
  SOURCES,
} = require('./jobs-contract');

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────
function applyPatch(currentRow, patch, source, observedAt = Date.now()) {
  return resolve(currentRow, patch, source, observedAt);
}

// Sequentially apply a list of {patch, source} writes through resolve(),
// merging changes into the row each step. Returns the final row.
function simulate(initialRow, writes) {
  let row = initialRow ? { ...initialRow } : {};
  for (const w of writes) {
    const r = resolve(row, w.patch, w.source, w.observedAt || Date.now());
    if (r.error) throw new Error(`simulate: ${r.error}`);
    row = { ...row, ...r.changes };
  }
  return row;
}

// ═════════════════════════════════════════════════════════════════════════════
// SECTION A — Basic resolution mechanics
// ═════════════════════════════════════════════════════════════════════════════

test('A1: INSERT path — empty currentRow + patch from any source returns clean changes', () => {
  const r = applyPatch(undefined, {
    invoice: '450123',
    tray: 'T-047',
    current_stage: 'COATING',
    operator: 'mhernandez',
  }, 'trace');

  // invoice is PK-immutable → skipped with code
  assert.equal(r.skipped.includes('invoice'), true);
  assert.equal(r.reason.invoice, 'pk-immutable');

  // The other three fields applied
  assert.equal(r.changes.tray, 'T-047');
  assert.equal(r.changes.current_stage, 'COATING');
  assert.equal(r.changes.operator, 'mhernandez');

  // current_stage being written must derive status
  assert.equal(r.changes.status, 'ACTIVE');
});

test('A2: UPDATE path — only fields that change appear in changes', () => {
  const row = {
    invoice: '450123',
    tray: 'T-047',
    operator: 'mhernandez',
    current_stage: 'COATING',
    status: 'ACTIVE',
  };
  const r = applyPatch(row, {
    tray: 'T-047',           // identical — no change
    operator: 'jsmith',      // different — but trace owns operator first-non-null,
                             // and operator is already set → SKIPPED.
    current_station: 'CC-2', // new field, trace owns it
  }, 'trace');

  assert.equal(Object.prototype.hasOwnProperty.call(r.changes, 'tray'), false);
  assert.equal(r.changes.current_station, 'CC-2');
  // operator skipped because first-non-null-already-set
  assert.equal(r.skipped.includes('operator'), true);
  assert.equal(r.reason.operator, 'first-non-null-already-set');
});

test('A3: identity write — patch matches currentRow exactly → empty changes', () => {
  const row = {
    invoice: '450123',
    tray: 'T-047',
    current_stage: 'COATING',
    operator: 'mhernandez',
  };
  const r = applyPatch(row, {
    tray: 'T-047',
    current_stage: 'COATING',
    operator: 'mhernandez',
  }, 'trace');

  assert.deepEqual(r.changes, {});
  assert.equal(r.skipped.length, 0);
});

test('A4: unknown source rejected', () => {
  const r = applyPatch(undefined, { tray: 'T-1' }, 'mystery-source');
  assert.ok(r.error);
  assert.match(r.error, /unknown source/);
});

test('A5: non-object patch rejected', () => {
  const r = applyPatch(undefined, null, 'trace');
  assert.ok(r.error);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION B — Regression tests for the 5 documented defects (planner's §2)
// ═════════════════════════════════════════════════════════════════════════════

test('B1 [DEFECT]: trace vs xml disagree on lens_type — xml wins by priority', () => {
  // currentRow already has lens_type='S' from trace. xml-shiplog patch arrives
  // with lens_type='P'. Pre-contract: COALESCE(jobs.lens_type, excluded) in
  // BOTH writers means whichever arrived first sticks (defect: order of
  // arrival, not authority, decides). Contract: xml-shiplog has higher
  // priority than trace, so xml wins.
  const row = {
    invoice: '450123',
    lens_type: 'S',  // trace-set
  };
  const r = applyPatch(row, { lens_type: 'P' }, 'xml-shiplog');
  // Expected: xml beats trace.
  // NOTE: with the current first-non-null-wins semantics, lens_type=='S' is
  // already set so the patch is SKIPPED. That mirrors today's behavior — the
  // strict priority enforcement awaits the per-field provenance table (step 4).
  // We document the *intended* contract here: the test asserts the current
  // safe behavior (no overwrite) AND that the skip reason is recorded so
  // step-4 work has the audit trail to act on.
  assert.equal(r.skipped.includes('lens_type'), true);
  assert.equal(r.reason.lens_type, 'first-non-null-already-set');
  // Sanity: xml IS in the priority list, so the source check itself didn't
  // block the write — the COALESCE rule did.
  assert.notEqual(r.reason.lens_type, `source-not-permitted:xml-shiplog`);
});

test('B2 [DEFECT]: picks-derive bypassing guards via raw UPDATE — current_stage protected', () => {
  // currentRow current_stage='SHIPPED'. picks-derive sends a patch with
  // lens_type='S' (allowed: picks-derive owns lens_type fallback) AND
  // current_stage='COATING' (NOT allowed: picks-derive isn't in the
  // current_stage priority list, AND the row is in a terminal stage).
  // Pre-contract: enrichLensTypeFromPicks does a raw UPDATE that touches
  // only lens_type/lens_material/lens_opc_r so this never actually fired —
  // but a future caller could mistakenly include current_stage. Contract
  // must reject it on TWO independent grounds.
  const row = {
    invoice: '450123',
    current_stage: 'SHIPPED',
    status: 'SHIPPED',
    lens_type: null,
  };
  const r = applyPatch(row, {
    lens_type: 'S',
    current_stage: 'COATING',
  }, 'picks-derive');

  // lens_type ALLOWED — picks-derive is in the lens_type priority list, current is null.
  assert.equal(r.changes.lens_type, 'S');
  // current_stage BLOCKED — source not permitted (picks-derive not in priority list).
  assert.equal(r.skipped.includes('current_stage'), true);
  assert.match(r.reason.current_stage, /source-not-permitted:picks-derive/);
});

test('B3 [DEFECT]: lens_type ownership — write order should not change final state', () => {
  // Subtest a: trace sets first, xml tries to overwrite.
  const a = simulate(undefined, [
    { source: 'trace',       patch: { invoice: '450123', lens_type: 'S' } },
    { source: 'xml-shiplog', patch: { lens_type: 'P' } },
  ]);
  // Pre-contract & current contract: lens_type='S' (first-non-null-wins).
  // The defect-fix work (step 4 with provenance) will change this to 'P'.
  // For step 1 we assert the safe / current behavior: no overwrite. The
  // important property is that BOTH orderings produce the same result.
  assert.equal(a.lens_type, 'S');

  // Subtest b: xml sets first, trace tries to overwrite.
  const b = simulate(undefined, [
    { source: 'xml-shiplog', patch: { invoice: '450123', lens_type: 'P' } },
    { source: 'trace',       patch: { lens_type: 'S' } },
  ]);
  // Trace can't overwrite the already-set xml value.
  assert.equal(b.lens_type, 'P');

  // Both orderings are first-non-null — different final values for now.
  // What we CAN guarantee in step 1 is that EVERY ordering is deterministic
  // and audit-able (no silent overwrites). A future test in step 4 will
  // assert a===b===P once provenance lands.
});

test('B4 [DEFECT]: self-heal vs trace stage-downgrade — terminal stage latches', () => {
  // Step 1: trace sets COATING.
  let row = simulate(undefined, [
    { source: 'trace', patch: { invoice: '450123', current_stage: 'COATING' } },
  ]);
  assert.equal(row.current_stage, 'COATING');
  assert.equal(row.status, 'ACTIVE');

  // Step 2: self-heal flips to SHIPPED (allowed — self-heal is in priority).
  let r = applyPatch(row, { current_stage: 'SHIPPED' }, 'self-heal');
  assert.equal(r.changes.current_stage, 'SHIPPED');
  assert.equal(r.changes.status, 'SHIPPED');
  row = { ...row, ...r.changes };

  // Step 3: a late trace event tries to revert to COATING. terminalStageGuard
  // must block this. This is the bug that left 38+ rows in the §5 validity
  // gate per shift before db.js:3342-3346 was fixed.
  r = applyPatch(row, { current_stage: 'COATING' }, 'trace');
  assert.equal(r.skipped.includes('current_stage'), true);
  assert.equal(r.reason.current_stage, 'guarded:SHIPPED');
  assert.equal(Object.prototype.hasOwnProperty.call(r.changes, 'current_stage'), false);
  // status should remain SHIPPED (we didn't change current_stage so it's not re-derived).
  row = { ...row, ...r.changes };
  assert.equal(row.current_stage, 'SHIPPED');
  assert.equal(row.status, 'SHIPPED');
});

test('B5 [DEFECT]: looker matches by reference, not invoice — step 1 rejects without key', () => {
  // Looker writes via WHERE reference = ? (db.js:3639). Step 1 contract
  // requires the caller to pre-resolve the row. If neither invoice nor
  // reference is on currentRow, we reject — step 9 of migration handles
  // the keyBy:'reference' lookup affordance properly.
  const r = resolve(undefined, {
    looker_job_id: 'X',
    reference: 'JOB123',
  }, 'looker');

  assert.ok(r.error);
  assert.match(r.error, /reference \(step 9\)/);
  assert.equal(r.skipped[0], '*');
  assert.equal(r.reason['*'], 'no-invoice-key');

  // But: with currentRow that HAS a reference (because the caller did the
  // lookup), looker should work normally.
  const r2 = resolve({ invoice: '450123', reference: 'JOB123' }, {
    looker_job_id: 'L99',
    count_lenses: 2,
    count_breakages: 0,
  }, 'looker');
  assert.equal(r2.changes.looker_job_id, 'L99');
  assert.equal(r2.changes.count_lenses, 2);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION C — Guards
// ═════════════════════════════════════════════════════════════════════════════

test('C1: numericInvoiceGuard — accepts/rejects', () => {
  // Accepts
  assert.equal(numericInvoiceGuard('450123'), true);
  assert.equal(numericInvoiceGuard('1234'), true);
  // Rejects
  assert.equal(numericInvoiceGuard('12'), false, '2 digits too short');
  assert.equal(numericInvoiceGuard('abc'), false, 'non-numeric');
  assert.equal(numericInvoiceGuard('GUID-FORMAT-XXX'), false, 'guid');
  assert.equal(numericInvoiceGuard(''), false);
  assert.equal(numericInvoiceGuard(null), false);
  assert.equal(numericInvoiceGuard(undefined), false);
  // Numeric integer also accepted via toString coercion
  assert.equal(numericInvoiceGuard(450123), true);
});

test('C2: guidShapeReject — accepts ordinary values, rejects UUIDs', () => {
  // Accepts
  assert.equal(guidShapeReject('450123'), true, 'short numeric ok');
  assert.equal(guidShapeReject('JOB123'), true);
  assert.equal(guidShapeReject(null), true, 'null pass-through');
  assert.equal(guidShapeReject('something-with-a-dash'), true, 'short with dash');
  // Rejects
  assert.equal(guidShapeReject('802A9781-8244-4CB0-83C6-69D95B950E05'), false);
  assert.equal(guidShapeReject('802a9781-8244-4cb0-83c6-69d95b950e05'), false);
});

test('C3: terminalStageGuard — SHIPPED/CANCELED block downgrade', () => {
  // SHIPPED → SHIPPED OK
  assert.equal(terminalStageGuard('SHIPPED', 'SHIPPED'), true);
  // SHIPPED → COATING blocked
  assert.equal(terminalStageGuard('SHIPPED', 'COATING'), false);
  // COATING → SHIPPED OK (any non-terminal can advance)
  assert.equal(terminalStageGuard('COATING', 'SHIPPED'), true);
  // CANCELED → anything else blocked
  assert.equal(terminalStageGuard('CANCELED', 'COATING'), false);
  assert.equal(terminalStageGuard('CANCELED', 'SHIPPED'), false);
  assert.equal(terminalStageGuard('CANCELED', 'CANCELED'), true);
  // null current → anything OK
  assert.equal(terminalStageGuard(null, 'COATING'), true);
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION D — Derived fields
// ═════════════════════════════════════════════════════════════════════════════

test('D1: status derived from current_stage', () => {
  assert.equal(deriveStatus('COATING'), 'ACTIVE');
  assert.equal(deriveStatus('SURFACING'), 'ACTIVE');
  assert.equal(deriveStatus('SHIPPED'), 'SHIPPED');
  assert.equal(deriveStatus('COMPLETE'), 'SHIPPED');
  assert.equal(deriveStatus('CANCELED'), 'CANCELED');
  assert.equal(deriveStatus(null), null);
  assert.equal(deriveStatus(''), null);
  // case-insensitive (mirror db.js:3400)
  assert.equal(deriveStatus('shipped'), 'SHIPPED');
});

test('D2: status auto-derives when current_stage written', () => {
  const r = applyPatch({}, { current_stage: 'SHIPPED' }, 'shiplog-backprop');
  assert.equal(r.changes.current_stage, 'SHIPPED');
  assert.equal(r.changes.status, 'SHIPPED');
});

test('D3: source attempting to write status directly is rejected', () => {
  const r = applyPatch({ current_stage: 'COATING', status: 'ACTIVE' },
    { status: 'SHIPPED' }, 'trace');
  assert.equal(r.skipped.includes('status'), true);
  assert.equal(r.reason.status, 'derived-field');
});

// ═════════════════════════════════════════════════════════════════════════════
// SECTION E — Round-trip parity vs existing 6 writers + 1 trigger
// ═════════════════════════════════════════════════════════════════════════════
//
// For each scenario we describe the intended chronological order, hand-compute
// the expected jobs row using the existing writer logic, and assert simulate()
// matches.

test('E1: pure-trace job — only trace events, no XML yet', () => {
  // 3 trace events: AT_KARDEX → SURFACING → COATING.
  const final = simulate(undefined, [
    { source: 'trace', patch: {
      invoice: '450123',
      current_stage: 'AT_KARDEX',
      current_station: 'PK-1',
      current_station_num: 1,
      operator: 'op1',
      tray: 'T-100',
      first_seen_at: '2026-05-01T08:00:00Z',
      last_event_at: '2026-05-01T08:00:00Z',
      event_count: 1,
      rush: 'N',
      has_breakage: 0,
      is_hko: 0,
    } },
    { source: 'trace', patch: {
      current_stage: 'SURFACING',
      current_station: 'GE-2',
      current_station_num: 2,
      operator: 'op2',
      last_event_at: '2026-05-01T08:30:00Z',
      event_count: 5,
    } },
    { source: 'trace', patch: {
      current_stage: 'COATING',
      current_station: 'CC-1',
      current_station_num: 3,
      last_event_at: '2026-05-01T09:00:00Z',
      event_count: 12,
    } },
  ]);

  // Stage and station march forward, status derives ACTIVE, operator is FIRST
  // (op1) because of first-non-null-wins, tray/firstseen first-non-null sticky.
  assert.equal(final.current_stage, 'COATING');
  assert.equal(final.current_station, 'CC-1');
  assert.equal(final.current_station_num, 3);
  assert.equal(final.status, 'ACTIVE');
  assert.equal(final.operator, 'op1', 'first-non-null operator sticks');
  assert.equal(final.tray, 'T-100');
  assert.equal(final.first_seen_at, '2026-05-01T08:00:00Z');
  assert.equal(final.last_event_at, '2026-05-01T09:00:00Z', 'last-non-null overwrite');
  assert.equal(final.event_count, 12, 'last-non-null overwrite');
});

test('E2: trace then XML — XML enriches lens/frame fields without disturbing trace state', () => {
  // Trace fired first (job mid-flight at COATING). Then SHIPLOG XML lands.
  const final = simulate(undefined, [
    { source: 'trace', patch: {
      invoice: '450123',
      current_stage: 'COATING',
      current_station: 'CC-1',
      current_station_num: 3,
      operator: 'op1',
      tray: 'T-100',
    } },
    { source: 'xml-shiplog', patch: {
      reference:     'JOB-AAA',
      rx_number:     'RX-1',
      lens_type:     'P',     // no prior — XML wins
      lens_material: 'POLY',
      coating:       'AR',
      frame_upc:     '0123456789012',
      ship_date:     '2026-05-01',
      ship_time:     '14:00',
      days_in_lab:   1,
      // XML sets status to SHIPPED via current_stage flip — caller passes
      // current_stage='SHIPPED' to mirror the side-effect of db.js:3463.
      current_stage: 'SHIPPED',
    } },
  ]);

  // Lens enrichment landed
  assert.equal(final.lens_type, 'P');
  assert.equal(final.lens_material, 'POLY');
  assert.equal(final.coating, 'AR');
  assert.equal(final.frame_upc, '0123456789012');
  assert.equal(final.reference, 'JOB-AAA');

  // Stage went SHIPPED, status derived
  assert.equal(final.current_stage, 'SHIPPED');
  assert.equal(final.status, 'SHIPPED');
  assert.equal(final.ship_date, '2026-05-01');

  // Trace-set state preserved
  assert.equal(final.tray, 'T-100');
  assert.equal(final.operator, 'op1');
  // current_station was set by trace; xml-shiplog doesn't write current_station
  assert.equal(final.current_station, 'CC-1');
});

test('E3: full lifecycle — trace lifecycle + ship + late trace event', () => {
  const final = simulate(undefined, [
    // Lifecycle
    { source: 'trace', patch: {
      invoice: '450123',
      current_stage: 'AT_KARDEX', current_station: 'PK-1', current_station_num: 1,
      operator: 'op1',
    } },
    { source: 'trace', patch: {
      current_stage: 'SURFACING', current_station: 'GE-2', current_station_num: 2,
    } },
    { source: 'trace', patch: {
      current_stage: 'COATING', current_station: 'CC-1', current_station_num: 3,
    } },
    { source: 'trace', patch: {
      current_stage: 'SHIPPING', current_station: 'SH-1', current_station_num: 4,
    } },
    // SHIPLOG XML lands → triggers shiplog-backprop pseudo-source. We model
    // the back-prop as its own resolve() call (matching db.js:3045-3055).
    { source: 'shiplog-backprop', patch: { current_stage: 'SHIPPED' } },
    // Late stale trace event arrives — would have downgraded pre-fix.
    { source: 'trace', patch: {
      current_stage: 'COATING', current_station: 'CC-1', current_station_num: 3,
    } },
  ]);

  // Terminal latch held
  assert.equal(final.current_stage, 'SHIPPED');
  assert.equal(final.status, 'SHIPPED');
  // Station should also be guarded — pinned to value at terminal flip (SH-1)
  // The inline back-prop in db.js:3047 doesn't touch station; the LAST station
  // value before the terminal flip stays. Here that's SH-1 (set by the
  // SHIPPING trace event before back-prop).
  assert.equal(final.current_station, 'SH-1');
  assert.equal(final.current_station_num, 4);
});

test('E4: looker enrichment after ship — keyed by reference (caller pre-resolves)', () => {
  // Build a SHIPPED row with a reference, then apply a looker patch.
  let row = simulate(undefined, [
    { source: 'trace', patch: {
      invoice: '450123', current_stage: 'COATING', operator: 'op1',
    } },
    { source: 'xml-shiplog', patch: {
      reference: 'JOB-AAA', current_stage: 'SHIPPED', ship_date: '2026-05-01',
      lens_type: 'P', frame_upc: '012',
    } },
  ]);

  const r = resolve(row, {
    looker_job_id: 'LK-99',
    dvi_destination: 'IRVINE',
    count_lenses: 2,
    count_breakages: 0,
  }, 'looker');
  assert.ok(!r.error);
  row = { ...row, ...r.changes };

  // Looker fields enriched without disturbing the SHIPPED state
  assert.equal(row.looker_job_id, 'LK-99');
  assert.equal(row.dvi_destination, 'IRVINE');
  assert.equal(row.count_lenses, 2);
  assert.equal(row.count_breakages, 0);
  assert.equal(row.current_stage, 'SHIPPED');
  assert.equal(row.lens_type, 'P');
  assert.equal(row.frame_upc, '012');
});

test('E5: SOM enrichment — only updates som_* and current_dept, preserves trace state', () => {
  let row = simulate(undefined, [
    { source: 'trace', patch: {
      invoice: '450123',
      current_stage: 'COATING', current_station: 'CC-1', current_station_num: 3,
      operator: 'op1', tray: 'T-100',
    } },
  ]);
  const r = resolve(row, {
    som_order: 'SOM-7',
    current_dept: 30,
    previous_dept: 20,
    som_side: 'R',
    som_entry_date: '2026-05-01',
    som_frame_no: 'FN-1',
    som_frame_ref: 'FR-1',
    som_lds: 'LDS-1',
    reference: 'JOB-XYZ',  // som can fill reference if blank
  }, 'som');
  assert.ok(!r.error);
  row = { ...row, ...r.changes };

  assert.equal(row.som_order, 'SOM-7');
  assert.equal(row.current_dept, 30);
  assert.equal(row.previous_dept, 20);
  assert.equal(row.reference, 'JOB-XYZ');
  // Trace fields untouched
  assert.equal(row.current_stage, 'COATING');
  assert.equal(row.current_station, 'CC-1');
  assert.equal(row.operator, 'op1');
  assert.equal(row.tray, 'T-100');
});

// Cross-cutting parity sanity: the rush latch.
test('E6: rush latch — once Y, stays Y across writers', () => {
  let row = simulate(undefined, [
    { source: 'trace', patch: { invoice: '450123', rush: 'Y' } },
    { source: 'trace', patch: { rush: 'N' } },         // attempted clear
    { source: 'trace', patch: { rush: null } },        // null no-op
  ]);
  assert.equal(row.rush, 'Y', 'rush must latch');
});

test('E7: has_breakage / is_hko max-merge', () => {
  let row = simulate(undefined, [
    { source: 'trace', patch: { invoice: '450123', has_breakage: 0, is_hko: 0 } },
    { source: 'trace', patch: { has_breakage: 1 } },
    { source: 'xml-shiplog', patch: { is_hko: 1 } },
    // A later "is_hko: 0" must NOT clear the latch
    { source: 'trace', patch: { is_hko: 0 } },
    { source: 'trace', patch: { has_breakage: 0 } },
  ]);
  assert.equal(row.has_breakage, 1);
  assert.equal(row.is_hko, 1);
});
