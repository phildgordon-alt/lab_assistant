#!/usr/bin/env node
/**
 * test-mcp-tools.js — Verify every MCP tool endpoint returns correct data
 *
 * Calls each endpoint the MCP tools use and validates the response has
 * the fields the agents expect. Fails loudly on any mismatch.
 *
 * Run: node server/test-mcp-tools.js
 * Requires: lab server running on port 3002
 */

const BASE = process.env.TEST_URL || 'http://localhost:3002';

async function get(path) {
  const r = await fetch(`${BASE}${path}`);
  if (!r.ok) throw new Error(`${path} → ${r.status} ${r.statusText}`);
  return r.json();
}

let passed = 0;
let failed = 0;

function assert(test, endpoint, msg) {
  if (test) {
    passed++;
  } else {
    failed++;
    console.error(`  ✗ FAIL: ${endpoint} — ${msg}`);
  }
}

async function runTests() {
  console.log(`Testing MCP tool endpoints against ${BASE}\n`);

  // 1. /api/dvi/jobs — used by get_dvi_operator_data (non-assembly)
  try {
    const d = await get('/api/dvi/jobs');
    assert(Array.isArray(d) || d.jobs, '/api/dvi/jobs', 'should return array or {jobs:[]}');
    const jobs = Array.isArray(d) ? d : (d.jobs || []);
    if (jobs.length > 0) {
      const j = jobs[0];
      assert(j.job_id || j.invoice, '/api/dvi/jobs', 'jobs should have job_id or invoice');
      assert(j.stage !== undefined, '/api/dvi/jobs', 'jobs should have stage');
      console.log(`  ✓ /api/dvi/jobs — ${jobs.length} jobs, has job_id + stage`);
      // Check if operator field exists on any job
      const withOp = jobs.filter(j => j.operator);
      console.log(`    operators present on ${withOp.length}/${jobs.length} jobs`);
    } else {
      console.log(`  ⚠ /api/dvi/jobs — 0 jobs (may be expected if DVI not running)`);
    }
  } catch (e) { failed++; console.error(`  ✗ /api/dvi/jobs — ${e.message}`); }

  // 2. /api/assembly/jobs — used by get_dvi_operator_data(dept=A)
  try {
    const d = await get('/api/assembly/jobs');
    assert(d.operatorStats !== undefined, '/api/assembly/jobs', 'should have operatorStats');
    assert(d.stationOperators !== undefined, '/api/assembly/jobs', 'should have stationOperators');
    assert(d.byStation !== undefined, '/api/assembly/jobs', 'should have byStation');
    assert(d.jobs !== undefined, '/api/assembly/jobs', 'should have jobs array');
    const opCount = Object.keys(d.operatorStats || {}).length;
    console.log(`  ✓ /api/assembly/jobs — ${opCount} operators, ${(d.jobs||[]).length} jobs`);
    if (opCount > 0) {
      const first = Object.values(d.operatorStats)[0];
      assert(first.jobs !== undefined, '/api/assembly/jobs', 'operatorStats should have jobs count');
      assert(first.jobsPerHour !== undefined, '/api/assembly/jobs', 'operatorStats should have jobsPerHour');
      console.log(`    sample operator: ${JSON.stringify(first)}`);
    }
  } catch (e) { failed++; console.error(`  ✗ /api/assembly/jobs — ${e.message}`); }

  // 3. /api/time-at-lab/operators — used by get_operator_leaderboard
  try {
    const d = await get('/api/time-at-lab/operators?days=14');
    assert(d.operators !== undefined, '/api/time-at-lab/operators', 'should have operators array');
    assert(d.operatorCount !== undefined, '/api/time-at-lab/operators', 'should have operatorCount');
    assert(d.period !== undefined, '/api/time-at-lab/operators', 'should have period');
    const ops = d.operators || [];
    if (ops.length > 0) {
      assert(ops[0].rank !== undefined, '/api/time-at-lab/operators', 'operator should have rank');
      assert(ops[0].operator !== undefined, '/api/time-at-lab/operators', 'operator should have operator initials');
      assert(ops[0].totalJobs !== undefined, '/api/time-at-lab/operators', 'operator should have totalJobs');
      assert(ops[0].jobsPerDay !== undefined, '/api/time-at-lab/operators', 'operator should have jobsPerDay');
    }
    console.log(`  ✓ /api/time-at-lab/operators — ${d.operatorCount} operators over ${d.period}`);
    ops.slice(0, 3).forEach(o => console.log(`    #${o.rank} ${o.operator}: ${o.totalJobs} jobs, ${o.jobsPerDay}/day`));
  } catch (e) { failed++; console.error(`  ✗ /api/time-at-lab/operators — ${e.message}`); }

  // 4. /api/time-at-lab/summary
  try {
    const d = await get('/api/time-at-lab/summary?period=7d');
    assert(d.shipped !== undefined, '/api/time-at-lab/summary', 'should have shipped');
    assert(d.stageDwells !== undefined, '/api/time-at-lab/summary', 'should have stageDwells');
    assert(d.wip !== undefined, '/api/time-at-lab/summary', 'should have wip');
    assert(d.bottleneck !== undefined, '/api/time-at-lab/summary', 'should have bottleneck');
    console.log(`  ✓ /api/time-at-lab/summary — shipped: ${d.shipped?.total}, bottleneck: ${d.bottleneck?.stage}`);
  } catch (e) { failed++; console.error(`  ✗ /api/time-at-lab/summary — ${e.message}`); }

  // 5. /api/time-at-lab/at-risk
  try {
    const d = await get('/api/time-at-lab/at-risk');
    assert(Array.isArray(d), '/api/time-at-lab/at-risk', 'should return array');
    console.log(`  ✓ /api/time-at-lab/at-risk — ${d.length} at-risk jobs`);
  } catch (e) { failed++; console.error(`  ✗ /api/time-at-lab/at-risk — ${e.message}`); }

  // 6. /api/time-at-lab/histogram
  try {
    const d = await get('/api/time-at-lab/histogram?mode=active');
    assert(d.buckets !== undefined, '/api/time-at-lab/histogram', 'should have buckets');
    assert(d.totalJobs !== undefined, '/api/time-at-lab/histogram', 'should have totalJobs');
    console.log(`  ✓ /api/time-at-lab/histogram — ${d.totalJobs} jobs in ${(d.buckets||[]).length} buckets`);
  } catch (e) { failed++; console.error(`  ✗ /api/time-at-lab/histogram — ${e.message}`); }

  // 7. /api/som/devices
  try {
    const d = await get('/api/som/devices');
    assert(d.devices !== undefined || Array.isArray(d), '/api/som/devices', 'should have devices');
    const devs = d.devices || d || [];
    console.log(`  ✓ /api/som/devices — ${Array.isArray(devs) ? devs.length : Object.keys(devs).length} devices`);
  } catch (e) { failed++; console.error(`  ✗ /api/som/devices — ${e.message}`); }

  // 8. /api/lab/catchup
  try {
    const d = await get('/api/lab/catchup?department=assembly');
    assert(d.department !== undefined, '/api/lab/catchup', 'should have department');
    assert(d.feasible !== undefined || d.netDaily !== undefined, '/api/lab/catchup', 'should have feasibility or netDaily');
    console.log(`  ✓ /api/lab/catchup — dept: ${d.department}, feasible: ${d.feasible}`);
  } catch (e) { failed++; console.error(`  ✗ /api/lab/catchup — ${e.message}`); }

  // 9. /api/coating/intelligence
  try {
    const d = await get('/api/coating/intelligence');
    assert(d.ok !== undefined || d.queue !== undefined, '/api/coating/intelligence', 'should have ok or queue');
    console.log(`  ✓ /api/coating/intelligence — ok: ${d.ok}, queue: ${d.queue?.total || 'N/A'}`);
  } catch (e) { failed++; console.error(`  ✗ /api/coating/intelligence — ${e.message}`); }

  // 10. /api/ews/rules
  try {
    const d = await get('/api/ews/rules');
    assert(Array.isArray(d), '/api/ews/rules', 'should return array');
    console.log(`  ✓ /api/ews/rules — ${d.length} rules`);
  } catch (e) { failed++; console.error(`  ✗ /api/ews/rules — ${e.message}`); }

  // Summary
  console.log(`\n${'='.repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) {
    console.log(`\n⚠️  ${failed} endpoints returned unexpected data — agents will fail on these.`);
    process.exit(1);
  } else {
    console.log(`\n✅ All MCP tool endpoints verified — response shapes match agent expectations.`);
  }
}

runTests().catch(e => { console.error('Test runner error:', e); process.exit(1); });
