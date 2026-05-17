// ══════════════════════════════════════════════════════════════
// PickingTab — 6th department, Picking / Lens Kitchen
// ══════════════════════════════════════════════════════════════
//
// Phil 2026-05-13: Where everything gets picked from Kardex to feed the
// SV and Surfacing lines. Pick goal = unpickedBacklog + intakeProjection.
// If picking falls behind, every downstream stage starves.
//
// First dept tab to live in src/components/tabs/. GoalBar was promoted
// to src/components/shared.jsx in the same commit so this can import
// cleanly without depending on App.jsx.
//
// Structure (top-to-bottom):
//   <GoalBar>                — today's progress (live)
//   Picks-by-warehouse tile  — WH1/WH2/WH3 event counts (operational stat)
//   Unpicked WIP queue       — invoices waiting to be picked
//   <GoalHistory>            — 14-day trailing context (per Phil's
//                              "history at the bottom" rule)

import { useState, useEffect } from 'react';
import { T, mono } from '../../constants';
import { GoalBar, GoalHistory, Card, SectionHeader, Pill, DeptKpiStrip } from '../shared';

// ─── DEMO MODE MOCKS ──────────────────────────────────────────────────
// Pinned-date mocks for settings.demoMode=true. All identifiers prefixed
// with DEMO- so operators cannot mistake them for live data. Numeric
// KPIs are realistic for a mid-morning shift (~400 pick goal, ~80
// backlog) but shapes mirror what the live endpoints return so the UI
// renders identically. Live behavior is unchanged when isDemo=false.
const MOCK_NOW = new Date('2026-05-17T10:00:00').getTime();
const MOCK_YMD = (offsetDays = 0) => {
  const d = new Date(MOCK_NOW - offsetDays * 86400000);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
};

const MOCK_PICKING_TARGET = {
  dailyGoal: 420,
  completedToday: 287,
  target: { target: 420, unpicked: 78, intake14d: 342, source: 'demo' },
};

const MOCK_PICKING_WH = {
  WH1: 412,
  WH2: 318,
  WH3: 74,
  invoiceCount: 287,
};

// 100 unpicked jobs across realistic queue mix. Fields mirror
// getUnpickedBacklog's row shape (invoice, lens_type, frame_name,
// entry_ymd, rush). DEMO- prefix on every identifier.
const MOCK_PICKING_UNPICKED_JOBS = (() => {
  const queues = [
    { station: 'At Kardex',         n: 34 },
    { station: 'Not Enough Lens',   n: 18 },
    { station: 'Edits',             n: 12 },
    { station: 'CX',                n: 9  },
    { station: 'SubconWait-TOG',    n: 6  },
    { station: 'Slow Movers',       n: 4  },
  ];
  const frames = ['DEMO-PARKER-NAVY', 'DEMO-OXFORD-BLK', 'DEMO-CARLYLE-TORT', 'DEMO-MILANO-CRYS', 'DEMO-ASPEN-OLIV'];
  const lensTypes = ['S', 'P', 'B', 'S', 'C']; // weight SV
  const jobs = [];
  let idx = 0;
  for (const q of queues) {
    for (let i = 0; i < q.n; i++) {
      const ageDays = idx < 8 ? 4 : idx < 24 ? 2 : idx < 60 ? 1 : 0;
      jobs.push({
        invoice: `DEMO-${420000 + idx}`,
        lens_type: lensTypes[idx % lensTypes.length],
        frame_name: frames[idx % frames.length],
        entry_ymd: MOCK_YMD(ageDays),
        rush: idx % 17 === 0 ? 'Y' : 'N',
        current_station: q.station,
      });
      idx++;
    }
  }
  return jobs;
})();

const MOCK_PICKING_UNPICKED = {
  count: MOCK_PICKING_UNPICKED_JOBS.length,
  jobs: MOCK_PICKING_UNPICKED_JOBS,
  byQueue: [
    { station: 'At Kardex',       n: 34 },
    { station: 'Not Enough Lens', n: 18 },
    { station: 'Edits',           n: 12 },
    { station: 'CX',              n: 9  },
    { station: 'SubconWait-TOG',  n: 6  },
    { station: 'Slow Movers',     n: 4  },
  ],
};

export function PickingTab({ ovenServerUrl, settings }) {
  const isDemo = settings?.demoMode || false;
  const [target, setTarget] = useState({ dailyGoal: 0, completedToday: 0, target: null });
  const [whPicks, setWhPicks] = useState({ WH1: 0, WH2: 0, WH3: 0, invoiceCount: 0 });
  const [unpicked, setUnpicked] = useState({ count: 0, jobs: [], byQueue: [] });
  const [search, setSearch] = useState('');

  // Poll /api/picking/target every 60s
  useEffect(() => {
    if (isDemo) { setTarget(MOCK_PICKING_TARGET); return; }
    if (ovenServerUrl == null) return;
    let active = true;
    const go = async () => {
      try {
        const r = await fetch(`${ovenServerUrl}/api/picking/target`);
        if (r.ok && active) {
          const d = await r.json();
          setTarget({ dailyGoal: d.dailyGoal || 0, completedToday: d.completedToday || 0, target: d.target || null });
        }
      } catch (_) { /* silent — GoalBar self-hides on goal=0 */ }
    };
    go();
    const iv = setInterval(go, 60000);
    return () => { active = false; clearInterval(iv); };
  }, [ovenServerUrl, isDemo]);

  // Poll /api/powerpick/picks-today every 30s for the per-warehouse event
  // counts (operational stat — separate from the invoice-count GoalBar)
  useEffect(() => {
    if (isDemo) { setWhPicks(MOCK_PICKING_WH); return; }
    if (ovenServerUrl == null) return;
    let active = true;
    const go = async () => {
      try {
        const r = await fetch(`${ovenServerUrl}/api/powerpick/picks-today`);
        if (r.ok && active) {
          const d = await r.json();
          setWhPicks({
            WH1: d.WH1 || 0,
            WH2: d.WH2 || 0,
            WH3: d.WH3 || 0,
            invoiceCount: d.invoiceCount || 0,
          });
        }
      } catch (_) {}
    };
    go();
    const iv = setInterval(go, 30000);
    return () => { active = false; clearInterval(iv); };
  }, [ovenServerUrl, isDemo]);

  // Poll /api/picking/unpicked every 60s for the WIP queue
  useEffect(() => {
    if (isDemo) { setUnpicked(MOCK_PICKING_UNPICKED); return; }
    if (ovenServerUrl == null) return;
    let active = true;
    const go = async () => {
      try {
        const r = await fetch(`${ovenServerUrl}/api/picking/unpicked?limit=100`);
        if (r.ok && active) {
          const d = await r.json();
          setUnpicked({ count: d.count || 0, jobs: d.jobs || [], byQueue: d.byQueue || [] });
        }
      } catch (_) {}
    };
    go();
    const iv = setInterval(go, 60000);
    return () => { active = false; clearInterval(iv); };
  }, [ovenServerUrl, isDemo]);

  const filteredJobs = search
    ? unpicked.jobs.filter(j => {
        const q = search.toLowerCase();
        return (j.invoice || '').toLowerCase().includes(q)
            || (j.frame_name || '').toLowerCase().includes(q);
      })
    : unpicked.jobs;

  // Days-in-lab helper for the queue
  const daysSince = (ymd) => {
    if (!ymd) return null;
    const ms = Date.now() - new Date(ymd + 'T12:00:00Z').getTime();
    return Math.max(0, Math.round(ms / 86400000));
  };

  const lensLabel = (lt) => {
    if (lt === 'P') return 'Progressive';
    if (lt === 'B') return 'Bifocal';
    if (lt === 'S') return 'SV';
    if (lt === 'C') return 'SV (custom)';
    return 'Unknown';
  };

  const totalEvents = whPicks.WH1 + whPicks.WH2 + whPicks.WH3;

  return (
    <div style={{ padding: '22px 28px', overflow: 'auto', height: 'calc(100vh - 160px)' }}>
      <GoalBar completedToday={target.completedToday} dailyGoal={target.dailyGoal} label="PICKED" />
      <DeptKpiStrip dept="picking" serverUrl={ovenServerUrl} />

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>🤏 Picking / Lens Kitchen</h2>
          <p style={{ margin: '4px 0 0', color: T.textMuted, fontSize: 13 }}>
            Kardex lens-blank picking • {unpicked.count} invoices awaiting pick
          </p>
        </div>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>BACKLOG</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: unpicked.count > 200 ? T.red : unpicked.count > 100 ? T.amber : T.green, fontFamily: mono }}>
              {unpicked.count}
            </div>
          </div>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>EVENTS TODAY</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>
              {totalEvents.toLocaleString()}
            </div>
          </div>
        </div>
      </div>

      {/* Picks by Warehouse */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right="Pick events today (Kardex)">Picks by Warehouse</SectionHeader>
        <div style={{ display: 'flex', gap: 16 }}>
          <div style={{ flex: 1, padding: 16, background: T.bg, borderRadius: 8, borderLeft: `4px solid ${T.blue}` }}>
            <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono, fontWeight: 700 }}>WH1 — SINGLE VISION</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: T.text, fontFamily: mono, marginTop: 4 }}>{whPicks.WH1.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>picks today</div>
          </div>
          <div style={{ flex: 1, padding: 16, background: T.bg, borderRadius: 8, borderLeft: `4px solid ${T.purple}` }}>
            <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono, fontWeight: 700 }}>WH2 — SURFACING</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: T.text, fontFamily: mono, marginTop: 4 }}>{whPicks.WH2.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>picks today</div>
          </div>
          <div style={{ flex: 1, padding: 16, background: T.bg, borderRadius: 8, borderLeft: `4px solid ${T.amber}` }}>
            <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono, fontWeight: 700 }}>WH3 — MANUAL</div>
            <div style={{ fontSize: 32, fontWeight: 800, color: T.text, fontFamily: mono, marginTop: 4 }}>{whPicks.WH3.toLocaleString()}</div>
            <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>picks today</div>
          </div>
        </div>
      </Card>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search unpicked jobs by invoice or frame..."
          value={search}
          onChange={e => setSearch(e.target.value)}
          style={{ width: '100%', maxWidth: 400, padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }}
        />
      </div>

      {/* Phil 2026-05-15: DVI queue breakdown card — one tile per actual
          DVI station name (Not enough lens / At Kardex / Edits / etc.).
          Groups directly from jobs.current_station so labels match the
          DVI screen exactly. Sorted by count desc, only non-zero shown. */}
      {unpicked.byQueue.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <SectionHeader right={`${unpicked.byQueue.length} queue${unpicked.byQueue.length === 1 ? '' : 's'} active`}>DVI Queues</SectionHeader>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 10 }}>
            {unpicked.byQueue.map(q => {
              const accent = q.n > 100 ? '#EF4444' : q.n > 20 ? '#F59E0B' : '#3B82F6';
              return (
                <div key={q.station} style={{ background: T.bg, border: `1px solid ${T.border}`, borderLeft: `3px solid ${accent}`, borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 0.5, textTransform: 'uppercase', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={q.station}>{q.station}</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: mono, lineHeight: 1.1, marginTop: 4 }}>{q.n.toLocaleString()}</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Unpicked WIP Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${filteredJobs.length} jobs · oldest first`}>Unpicked WIP Queue</SectionHeader>
        {filteredJobs.length > 0 ? (
          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead style={{ position: 'sticky', top: 0, background: T.surface }}>
                <tr style={{ background: T.bg }}>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, fontFamily: mono }}>INVOICE</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, fontFamily: mono }}>LENS</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, fontFamily: mono }}>FRAME</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, fontFamily: mono }}>ENTRY</th>
                  <th style={{ padding: '10px 12px', textAlign: 'right', fontSize: 10, color: T.textDim, fontFamily: mono }}>DAYS</th>
                  <th style={{ padding: '10px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, fontFamily: mono }}>RUSH</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.slice(0, 50).map((j, i) => {
                  const days = daysSince(j.entry_ymd);
                  const ageColor = days >= 3 ? T.red : days >= 2 ? T.amber : T.text;
                  return (
                    <tr key={j.invoice || i} style={{ borderBottom: `1px solid ${T.border}`, background: j.rush === 'Y' ? `${T.red}08` : 'transparent' }}>
                      <td style={{ padding: '10px 12px', fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                        {j.invoice || '—'}
                      </td>
                      <td style={{ padding: '10px 12px', fontFamily: mono, fontSize: 11, color: T.textMuted }}>{lensLabel(j.lens_type)}</td>
                      <td style={{ padding: '10px 12px', fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.frame_name || '—'}</td>
                      <td style={{ padding: '10px 12px', fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.entry_ymd || '—'}</td>
                      <td style={{ padding: '10px 12px', fontFamily: mono, fontSize: 12, fontWeight: 700, color: ageColor, textAlign: 'right' }}>{days != null ? days : '—'}</td>
                      <td style={{ padding: '10px 12px' }}>{j.rush === 'Y' ? <Pill color={T.red}>RUSH</Pill> : null}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: 'center', color: T.textDim, fontFamily: mono, fontSize: 12 }}>
            {unpicked.count === 0 ? 'No invoices waiting to be picked' : 'No jobs match your search'}
          </div>
        )}
      </Card>

      {/* Goal vs Actual history at the bottom per Phil's tab convention */}
      <GoalHistory serverUrl={ovenServerUrl} dept="picking" deptLabel="Picking" days={14} />
    </div>
  );
}
