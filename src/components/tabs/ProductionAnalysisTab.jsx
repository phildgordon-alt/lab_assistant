// ProductionAnalysisTab — Hour-by-hour production flow analysis with bottleneck detection
import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { T, mono } from '../../constants';
import { Card, SectionHeader } from '../shared';

// Stage config: colors, labels, order
const STAGES = [
  { key: 'PICKING',    label: 'Picked',    color: '#06B6D4' },
  { key: 'SURFACING',  label: 'Surfaced',  color: '#3B82F6' },
  { key: 'CUTTING',    label: 'Cut',       color: '#8B5CF6' },
  { key: 'COATING',    label: 'Coated',    color: '#F59E0B' },
  { key: 'ASSEMBLY',   label: 'Assembled', color: '#EC4899' },
  { key: 'SHIPPING',   label: 'Shipped',   color: '#10B981' },
];
const STAGE_MAP = Object.fromEntries(STAGES.map(s => [s.key, s]));

function formatHour(h) {
  if (h === 0 || h === 24) return '12a';
  if (h < 12) return h + 'a';
  if (h === 12) return '12p';
  return (h - 12) + 'p';
}

function formatHourFull(h) {
  if (h === 0 || h === 24) return '12 AM';
  if (h < 12) return h + ' AM';
  if (h === 12) return '12 PM';
  return (h - 12) + ' PM';
}

function todayStr() {
  return new Date().toISOString().slice(0, 10);
}

function yesterdayStr() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}

const MACHINE_COLORS = {
  'Blocker': '#3B82F6',
  'FSE': '#06B6D4',   // Freeform Surface Edger
  'CCS': '#10B981',   // Coater
  'FSP': '#8B5CF6',   // Freeform Surface Polisher
  'DBA': '#34D399',   // Digital Blocker
  'FED': '#EC4899',   // Freeform Edger
  'FSG': '#F59E0B',   // Freeform Surface Generator
  'CLU': '#FB923C',   // Cylinder Lapping Unit
  'TSA': '#A78BFA',   // Tray Scanner
};

function MachineChart({ serverUrl, date }) {
  const [somData, setSomData] = useState(null);
  useEffect(() => {
    if (!serverUrl) return;
    fetch(`${serverUrl}/api/som/lens-per-hour?date=${date}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setSomData(d))
      .catch(() => setSomData(null));
  }, [serverUrl, date]);

  if (!somData || !somData.series || somData.series.length === 0) return null;

  const series = somData.series;
  const hours = somData.hours || [];
  const maxVal = Math.max(1, ...series.flatMap(s => (s.data || []).map(d => d.lenses || 0)));
  const H = 160;

  return (
    <div style={{
      background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
      borderRadius: 10, padding: 16, marginBottom: 18
    }}>
      <SectionHeader>Machine Throughput (SOM)</SectionHeader>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 10 }}>
        {series.map(s => (
          <span key={s.name} style={{ fontSize: 10, fontFamily: mono, color: MACHINE_COLORS[s.name] || T.textDim }}>
            ● {s.name}: {(s.data || []).reduce((sum, d) => sum + (d.lenses || 0), 0)} lenses
          </span>
        ))}
      </div>
      <div style={{ position: 'relative', height: H }}>
        {/* Y-axis grid */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <div key={f} style={{ position: 'absolute', left: 0, bottom: `${f * 100}%`, width: '100%', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span style={{ position: 'absolute', left: 0, top: -8, fontSize: 8, color: T.textDim, fontFamily: mono }}>{Math.round(f * maxVal)}</span>
          </div>
        ))}
        {/* Bars via CSS flex */}
        <div style={{ position: 'absolute', left: 30, right: 0, top: 0, bottom: 0, display: 'flex', alignItems: 'flex-end', gap: 1 }}>
          {hours.map(h => {
            let totalH = 0;
            const segments = series.map(s => {
              const dp = (s.data || []).find(d => d.hour === h);
              const val = dp ? dp.lenses : 0;
              const pct = (val / maxVal) * 100;
              totalH += pct;
              return { name: s.name, val, pct };
            }).filter(seg => seg.val > 0);
            return (
              <div key={h} style={{ flex: 1, display: 'flex', flexDirection: 'column-reverse', height: '100%', justifyContent: 'flex-start' }}>
                {segments.map(seg => (
                  <div key={seg.name} style={{ width: '100%', height: `${seg.pct}%`, background: MACHINE_COLORS[seg.name] || T.textDim, opacity: 0.8, minHeight: seg.val > 0 ? 2 : 0 }}
                    title={`${seg.name}: ${seg.val} lenses`} />
                ))}
              </div>
            );
          })}
        </div>
      </div>
      {/* X labels */}
      <div style={{ display: 'flex', justifyContent: 'space-between', marginLeft: 30, marginTop: 4 }}>
        {hours.map(h => (
          <span key={h} style={{ fontSize: 8, color: T.textDim, fontFamily: mono }}>
            {h > 12 ? h - 12 + 'p' : h === 12 ? '12p' : h + 'a'}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function ProductionAnalysisTab({ serverUrl, settings }) {
  const base = serverUrl || `http://${window.location.hostname}:3002`;

  const [date, setDate] = useState(todayStr());
  const [compareOn, setCompareOn] = useState(false);
  const [compareDate, setCompareDate] = useState(yesterdayStr());
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [hiddenStages, setHiddenStages] = useState(new Set());
  const [history, setHistory] = useState([]);
  const [flowSnapshot, setFlowSnapshot] = useState(null);

  // Fetch history (once on mount)
  useEffect(() => {
    fetch(`${base}/api/flow/production-history?days=14`)
      .then(r => r.ok ? r.json() : [])
      .then(d => setHistory(Array.isArray(d) ? d : []))
      .catch(() => setHistory([]));
  }, [base]);

  // Fetch flow snapshot for VSM
  const fetchSnapshot = useCallback(() => {
    fetch(`${base}/api/flow/snapshot`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setFlowSnapshot(d))
      .catch(() => setFlowSnapshot(null));
  }, [base]);

  useEffect(() => { fetchSnapshot(); }, [fetchSnapshot]);

  // Auto-refresh snapshot every 60s if viewing today
  useEffect(() => {
    if (date !== todayStr()) return;
    const iv = setInterval(fetchSnapshot, 60000);
    return () => clearInterval(iv);
  }, [date, fetchSnapshot]);

  // Fetch data
  const fetchData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      let url = `${base}/api/flow/production-analysis?date=${date}`;
      if (compareOn && compareDate) url += `&compare=${compareDate}`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const d = await res.json();
      setData(d);
    } catch (e) {
      setError(e.message);
      setData(null);
    }
    setLoading(false);
  }, [base, date, compareOn, compareDate]);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Auto-refresh every 2 minutes if viewing today
  useEffect(() => {
    if (date !== todayStr()) return;
    const iv = setInterval(fetchData, 120000);
    return () => clearInterval(iv);
  }, [date, fetchData]);

  const hours = data?.hours || [];
  const throughput = data?.throughput || {};
  const compareData = data?.compareData || null;
  const dailyTotals = data?.dailyTotals || {};
  const compareDailyTotals = data?.compareDailyTotals || {};
  const operators = data?.operators || {};
  const picks = data?.picks || [];
  const bottleneck = data?.bottleneck || null;

  // Toggle a stage in the main chart legend
  const toggleStage = (key) => {
    setHiddenStages(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });
  };

  // ── Loading / Error / Empty ──
  if (loading && !data) {
    return (
      <div style={{ textAlign: 'center', padding: 60, color: T.textMuted, fontFamily: mono }}>
        Loading production analysis...
      </div>
    );
  }

  if (error && !data) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <div style={{ color: T.red, fontSize: 14, fontFamily: mono, marginBottom: 12 }}>
          Error: {error}
        </div>
        <button onClick={fetchData} style={{
          background: `${T.blue}20`, border: `1px solid ${T.blue}40`, borderRadius: 6,
          padding: '8px 20px', color: T.blue, fontSize: 12, cursor: 'pointer', fontFamily: mono
        }}>Retry</button>
      </div>
    );
  }

  if (data && hours.length === 0) {
    return (
      <div style={{ textAlign: 'center', padding: 60 }}>
        <div style={{ fontSize: 36, marginBottom: 12, opacity: 0.3 }}>📊</div>
        <div style={{ color: T.textMuted, fontSize: 13, fontFamily: mono }}>
          No production data for {date}
        </div>
      </div>
    );
  }

  // ── Compute chart values ──
  const visibleStages = STAGES.filter(s => !hiddenStages.has(s.key));
  const maxThroughput = Math.max(1, ...visibleStages.flatMap(s =>
    (throughput[s.key] || []).map(h => h.count)
  ));
  const maxCompare = compareData ? Math.max(1, ...visibleStages.flatMap(s =>
    (compareData[s.key] || []).map(h => h.count)
  )) : 0;
  const chartMax = Math.max(maxThroughput, maxCompare);

  // Picks max
  const maxPicks = Math.max(1, ...picks.map(p => p.count));

  // SVG chart dimensions
  const plotH = 210; // chart area height

  return (
    <div>
      {/* ═══ A. HEADER + CONTROLS ═══ */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20, flexWrap: 'wrap', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ fontSize: 28 }}>📊</span>
          <div>
            <h2 style={{ margin: 0, fontFamily: "'Bebas Neue',sans-serif", fontSize: 28, letterSpacing: 1, color: T.text }}>
              Production Analysis
            </h2>
            <span style={{ fontSize: 11, color: T.textDim, fontFamily: mono }}>
              Hour-by-hour throughput &middot; Bottleneck detection
            </span>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <input
            type="date"
            value={date}
            onChange={e => setDate(e.target.value)}
            style={{
              background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
              padding: '6px 10px', color: T.text, fontSize: 12, fontFamily: mono,
              colorScheme: 'dark'
            }}
          />

          <button
            onClick={() => setCompareOn(!compareOn)}
            style={{
              background: compareOn ? `${T.blue}20` : 'transparent',
              border: `1px solid ${compareOn ? T.blue : T.border}`,
              borderRadius: 6, padding: '6px 14px', color: compareOn ? T.blue : T.textMuted,
              fontSize: 11, cursor: 'pointer', fontFamily: mono, fontWeight: 700
            }}
          >
            {compareOn ? 'Compare ON' : 'Compare'}
          </button>

          {compareOn && (
            <input
              type="date"
              value={compareDate}
              onChange={e => setCompareDate(e.target.value)}
              style={{
                background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6,
                padding: '6px 10px', color: T.text, fontSize: 12, fontFamily: mono,
                colorScheme: 'dark'
              }}
            />
          )}

          <button
            onClick={fetchData}
            disabled={loading}
            style={{
              background: `${T.blue}15`, border: `1px solid ${T.blue}40`, borderRadius: 6,
              padding: '6px 16px', color: T.blue, fontSize: 11, cursor: 'pointer',
              fontFamily: mono, fontWeight: 700, opacity: loading ? 0.5 : 1
            }}
          >
            {loading ? '...' : '↻ Refresh'}
          </button>
        </div>
      </div>

      {/* ═══ B. KPI CARDS ═══ */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 18, flexWrap: 'wrap' }}>
        {STAGES.map(s => {
          const val = dailyTotals[s.key] || 0;
          const cmpVal = compareDailyTotals[s.key];
          const delta = compareOn && cmpVal != null ? val - cmpVal : null;
          return (
            <div key={s.key} style={{
              flex: '1 1 140px', minWidth: 130, background: T.card,
              border: `1px solid ${T.border}`, borderRadius: 10, padding: '14px 16px',
              borderTop: `3px solid ${s.color}`
            }}>
              <div style={{ fontSize: 11, color: T.textMuted, textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: mono, fontWeight: 600 }}>
                {s.label}
              </div>
              <div style={{ fontSize: 32, fontWeight: 800, color: T.text, fontFamily: mono, marginTop: 2 }}>
                {val}
              </div>
              {delta != null && (
                <div style={{ fontSize: 12, fontFamily: mono, color: delta > 0 ? T.green : delta < 0 ? T.red : T.textDim, marginTop: 2 }}>
                  {delta > 0 ? '▲' : delta < 0 ? '▼' : '—'}{delta !== 0 ? ` ${Math.abs(delta)}` : ''}
                  <span style={{ fontSize: 10, color: T.textDim, marginLeft: 6 }}>vs {compareDate}</span>
                </div>
              )}
              {s.key === 'SHIPPING' && data?.hko > 0 && (
                <div style={{ fontSize: 10, fontFamily: mono, color: T.textDim, marginTop: 4 }}>
                  + {data.hko} HKO
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* ═══ C. BOTTLENECK ALERT ═══ */}
      {bottleneck && (
        <div style={{
          background: `${T.red}12`, border: `1px solid ${T.red}40`, borderRadius: 10,
          padding: '14px 18px', marginBottom: 18, display: 'flex', alignItems: 'center', gap: 14
        }}>
          <div style={{
            width: 40, height: 40, borderRadius: 8,
            background: `${T.red}25`, display: 'flex', alignItems: 'center', justifyContent: 'center',
            fontSize: 20, flexShrink: 0
          }}>⚠</div>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: T.red, fontFamily: mono }}>
              BOTTLENECK: {bottleneck.stage}
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, marginTop: 2 }}>
              {bottleneck.reason || `${bottleneck.avgRate} jobs/hr vs ${bottleneck.upstreamRate}/hr upstream (gap: ${bottleneck.gap}/hr)`}
            </div>
          </div>
        </div>
      )}

      {/* ═══ C2. VALUE STREAM MAP ═══ */}
      {data && (() => {
        // Build VSM stage data by merging snapshot + production-analysis
        const snapshotStages = flowSnapshot?.stages || [];
        const snapshotMap = Object.fromEntries(snapshotStages.map(s => [s.id?.toUpperCase(), s]));
        const activeHours = hours.length > 1 ? (hours[hours.length - 1] - hours[0]) || 1 : 1;

        const vsmStages = STAGES.map(s => {
          const snap = snapshotMap[s.key] || {};
          const total = dailyTotals[s.key] || 0;
          const rate = Math.round((total / activeHours) * 10) / 10;
          return {
            key: s.key,
            label: s.label,
            color: s.color,
            wip: snap.current_count ?? 0,
            rate,
            total,
            status: snap.status || 'ok',
            isBottleneck: bottleneck?.stage === s.key,
          };
        });

        // Compute flow rates between adjacent stages (min of pair)
        const arrows = [];
        for (let i = 0; i < vsmStages.length - 1; i++) {
          const from = vsmStages[i];
          const to = vsmStages[i + 1];
          const flowRate = Math.min(from.rate, to.rate);
          const keepingUp = to.rate >= from.rate * 0.85; // 85% threshold
          arrows.push({ flowRate, keepingUp, fromKey: from.key, toKey: to.key });
        }

        const boxW = 160;
        const boxH = 120;
        const arrowW = 80;
        const totalW = vsmStages.length * boxW + (vsmStages.length - 1) * arrowW;

        return (
          <div style={{
            background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
            borderRadius: 10, padding: 16, marginBottom: 18
          }}>
            <SectionHeader>Value Stream Map</SectionHeader>
            <style>{`
              @keyframes vsm-pulse {
                0%, 100% { box-shadow: 0 0 0 0 rgba(239,68,68,0.4); }
                50% { box-shadow: 0 0 0 8px rgba(239,68,68,0); }
              }
            `}</style>
            <div style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              overflowX: 'auto', padding: '16px 0', gap: 0
            }}>
              {vsmStages.map((stage, i) => (
                <React.Fragment key={stage.key}>
                  {/* Stage box */}
                  <div style={{
                    width: boxW, minWidth: boxW, height: boxH,
                    background: stage.isBottleneck ? `${T.red}15` : `${stage.color}10`,
                    border: `2px solid ${stage.isBottleneck ? T.red : stage.color}${stage.isBottleneck ? '' : '40'}`,
                    borderRadius: 10,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                    position: 'relative',
                    animation: stage.isBottleneck ? 'vsm-pulse 2s ease-in-out infinite' : 'none',
                    flexShrink: 0,
                  }}>
                    {/* Bottleneck warning icon */}
                    {stage.isBottleneck && (
                      <div style={{
                        position: 'absolute', top: -10, right: -10,
                        width: 22, height: 22, borderRadius: '50%',
                        background: T.red, display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 12, fontWeight: 700, color: '#fff',
                        border: `2px solid ${T.bg}`
                      }}>!</div>
                    )}

                    {/* Stage name */}
                    <div style={{
                      fontSize: 11, fontWeight: 700, color: stage.color,
                      textTransform: 'uppercase', letterSpacing: 1.2, fontFamily: mono,
                      marginBottom: 4
                    }}>{stage.key}</div>

                    {/* WIP count */}
                    <div style={{
                      fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono,
                      lineHeight: 1
                    }}>{stage.wip}</div>
                    <div style={{
                      fontSize: 9, color: T.textDim, fontFamily: mono, marginTop: 2
                    }}>WIP</div>

                    {/* Throughput rate */}
                    <div style={{
                      fontSize: 11, color: T.textMuted, fontFamily: mono, marginTop: 6,
                      background: 'rgba(255,255,255,0.05)', borderRadius: 4, padding: '2px 8px'
                    }}>
                      {stage.rate} jobs/hr
                    </div>

                    {/* Daily total at bottom */}
                    <div style={{
                      position: 'absolute', bottom: -18,
                      fontSize: 9, color: T.textDim, fontFamily: mono,
                    }}>
                      {stage.total} today
                    </div>
                  </div>

                  {/* Arrow between stages */}
                  {i < vsmStages.length - 1 && (() => {
                    const arrow = arrows[i];
                    const arrowColor = arrow.keepingUp ? T.green : T.red;
                    return (
                      <div style={{
                        width: arrowW, minWidth: arrowW, display: 'flex', flexDirection: 'column',
                        alignItems: 'center', justifyContent: 'center', position: 'relative',
                        flexShrink: 0,
                      }}>
                        {/* Flow rate label */}
                        <div style={{
                          fontSize: 10, fontFamily: mono, fontWeight: 700,
                          color: arrowColor, marginBottom: 4, whiteSpace: 'nowrap'
                        }}>
                          {arrow.flowRate}/hr
                        </div>
                        {/* Arrow SVG */}
                        <svg width={arrowW} height="20" viewBox={`0 0 ${arrowW} 20`}>
                          <defs>
                            <marker id={`vsm-arrow-${i}`} markerWidth="8" markerHeight="6" refX="8" refY="3" orient="auto">
                              <polygon points="0 0, 8 3, 0 6" fill={arrowColor} />
                            </marker>
                          </defs>
                          <line x1="4" y1="10" x2={arrowW - 10} y2="10"
                            stroke={arrowColor} strokeWidth="2.5"
                            markerEnd={`url(#vsm-arrow-${i})`}
                            opacity="0.8" />
                        </svg>
                        {/* Status indicator */}
                        {!arrow.keepingUp && (
                          <div style={{
                            fontSize: 8, fontFamily: mono, color: T.red, marginTop: 2,
                            opacity: 0.8
                          }}>
                            BACKING UP
                          </div>
                        )}
                      </div>
                    );
                  })()}
                </React.Fragment>
              ))}
            </div>
          </div>
        );
      })()}

      {/* ═══ D. HOUR-BY-HOUR THROUGHPUT CHART ═══ */}
      <div style={{
        background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
        borderRadius: 10, padding: 16, marginBottom: 18
      }}>
        <SectionHeader right={`Peak hour scale: ${chartMax}`}>
          Throughput by Hour
        </SectionHeader>

        {/* Legend */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 10, alignItems: 'center' }}>
          {hiddenStages.size > 0 && (
            <button onClick={() => setHiddenStages(new Set())} style={{
              fontSize: 10, fontFamily: mono, background: `${T.blue}15`,
              border: `1px solid ${T.blue}30`, borderRadius: 4, padding: '3px 8px',
              cursor: 'pointer', color: T.blue
            }}>Show All</button>
          )}
          {STAGES.map(s => {
            const hidden = hiddenStages.has(s.key);
            return (
              <button key={s.key} onClick={() => toggleStage(s.key)} style={{
                fontSize: 10, color: hidden ? T.textDim : s.color, fontFamily: mono,
                background: hidden ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.06)',
                border: `1px solid ${hidden ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.1)'}`,
                borderRadius: 4, padding: '3px 8px', cursor: 'pointer', opacity: hidden ? 0.4 : 1
              }}>
                <span style={{ display: 'inline-block', width: 10, height: 3, background: hidden ? T.textDim : s.color, borderRadius: 2, marginRight: 4 }} />
                {s.label}
                {compareOn && <span style={{ marginLeft: 4, opacity: 0.5 }}>(- - -)</span>}
              </button>
            );
          })}
        </div>

        {/* Chart area — CSS positioned like Flow tab */}
        <div style={{ position: 'relative', height: plotH + 10 }}>
          {/* Y-axis grid lines via CSS */}
          {[0, 0.25, 0.5, 0.75, 1].map(p => (
            <div key={p} style={{ position: 'absolute', left: 0, bottom: `${p * 100}%`, width: '100%', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
              <span style={{ position: 'absolute', left: 0, top: -8, fontSize: 9, color: T.textDim, fontFamily: mono }}>{Math.round(chartMax * p)}</span>
            </div>
          ))}
          {/* SVG with CSS width */}
          <svg width="100%" height="100%"
            viewBox={`0 0 ${Math.max(hours.length, 1) * 40} ${plotH}`}
            preserveAspectRatio="none"
            style={{ position: 'absolute', left: 30, top: 0, width: 'calc(100% - 40px)', height: '100%' }}>

            {/* Compare lines (dashed, behind) */}
            {compareOn && compareData && visibleStages.map(s => {
              const arr = compareData[s.key] || [];
              if (arr.length < 2) return null;
              const xScale = hours.length > 1 ? (hours.length * 40 - 40) / (hours.length - 1) : 0;
              const pts = arr.map((d, i) => `${i * xScale},${plotH - (d.count / chartMax) * (plotH - 20)}`).join(' ');
              return (
                <polyline key={s.key + '-cmp'} points={pts} fill="none"
                  stroke={s.color} strokeWidth="1.5" strokeDasharray="4,3" opacity="0.35" />
              );
            })}

            {/* Main lines */}
            {visibleStages.map(s => {
              const arr = throughput[s.key] || [];
              if (arr.length < 2) return null;
              const xScale = hours.length > 1 ? (hours.length * 40 - 40) / (hours.length - 1) : 0;
              const pts = arr.map((d, i) => `${i * xScale},${plotH - (d.count / chartMax) * (plotH - 20)}`).join(' ');
              const peakIdx = arr.reduce((best, d, i) => d.count > arr[best].count ? i : best, 0);
              const peakVal = arr[peakIdx]?.count || 0;
              const peakX = peakIdx * xScale;
              const peakY = plotH - (peakVal / chartMax) * (plotH - 20);
              return (
                <g key={s.key}>
                  <polyline points={pts} fill="none" stroke={s.color} strokeWidth="2" opacity="0.85" />
                  {peakVal > 0 && (
                    <>
                      <circle cx={peakX} cy={peakY} r="3" fill={s.color} stroke={T.bg} strokeWidth="1" />
                      <text x={peakX} y={peakY - 6} textAnchor="middle"
                        fill={s.color} fontSize="8" fontFamily="'JetBrains Mono',monospace" fontWeight="700">
                        {peakVal}
                      </text>
                    </>
                  )}
                </g>
              );
            })}
          </svg>
        </div>
        {/* X-axis labels */}
        <div style={{ display: 'flex', justifyContent: 'space-between', marginLeft: 30, marginTop: 4 }}>
          {hours.map(h => (
            <span key={h} style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>{formatHour(h)}</span>
          ))}
        </div>
      </div>

      {/* ═══ E. PICKS FEED RATE ═══ */}
      {picks.length > 0 && (
        <div style={{
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 10, padding: 16, marginBottom: 18
        }}>
          <SectionHeader right={`Peak: ${maxPicks}`}>
            Picks Feed Rate
          </SectionHeader>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: 100, padding: '0 4px' }}>
            {picks.map((p, i) => {
              const barH = Math.max(2, (p.count / maxPicks) * 80);
              return (
                <div key={p.hour} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                  <div style={{ fontSize: 9, color: T.textMuted, fontFamily: mono }}>{p.count || ''}</div>
                  <div style={{
                    width: '100%', maxWidth: 28, height: barH, borderRadius: 2,
                    background: STAGE_MAP.PICKING.color, opacity: p.count > 0 ? 0.7 : 0.1
                  }} title={`${formatHourFull(p.hour)}: ${p.count} picks (${p.qty || 0} qty)`} />
                  <div style={{ fontSize: 8, color: T.textDim, fontFamily: mono }}>{formatHour(p.hour)}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ═══ F. MACHINE THROUGHPUT (SOM) ═══ */}
      <MachineChart serverUrl={serverUrl} date={date} />

      {/* ═══ G. DAILY COMPARISON TABLE ═══ */}
      {compareOn && compareDailyTotals && Object.keys(compareDailyTotals).length > 0 && (
        <div style={{
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 10, padding: 16
        }}>
          <SectionHeader>Daily Comparison: {date} vs {compareDate}</SectionHeader>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: mono, fontSize: 12 }}>
            <thead>
              <tr>
                {['Stage', date, compareDate, 'Delta'].map(col => (
                  <th key={col} style={{
                    textAlign: col === 'Stage' ? 'left' : 'right',
                    padding: '8px 12px', borderBottom: `1px solid ${T.border}`,
                    color: T.textMuted, fontSize: 10, textTransform: 'uppercase', letterSpacing: 1
                  }}>{col}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {STAGES.map(s => {
                const today = dailyTotals[s.key] || 0;
                const cmp = compareDailyTotals[s.key] || 0;
                const delta = today - cmp;
                return (
                  <tr key={s.key}>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${T.border}10`, color: s.color, fontWeight: 600 }}>
                      {s.label}
                    </td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${T.border}10`, textAlign: 'right', color: T.text, fontWeight: 700 }}>
                      {today}
                    </td>
                    <td style={{ padding: '8px 12px', borderBottom: `1px solid ${T.border}10`, textAlign: 'right', color: T.textMuted }}>
                      {cmp}
                    </td>
                    <td style={{
                      padding: '8px 12px', borderBottom: `1px solid ${T.border}10`, textAlign: 'right',
                      color: delta > 0 ? T.green : delta < 0 ? T.red : T.textDim,
                      fontWeight: 700
                    }}>
                      {delta > 0 ? '+' : ''}{delta}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* ═══ H. DAILY HISTORY ═══ */}
      {history.length > 0 && (
        <div style={{
          background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)',
          borderRadius: 10, padding: 16, marginTop: 18
        }}>
          <SectionHeader>14-Day Production History</SectionHeader>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: mono, fontSize: 11 }}>
              <thead>
                <tr>
                  {['Day', 'Picked', 'Surfaced', 'Cut', 'Coated', 'Assembled', 'Shipped', 'HKO', 'Bottleneck'].map(col => (
                    <th key={col} style={{
                      textAlign: col === 'Day' || col === 'Bottleneck' ? 'left' : 'right',
                      padding: '8px 10px', borderBottom: `1px solid ${T.border}`,
                      color: T.textMuted, fontSize: 9, textTransform: 'uppercase', letterSpacing: 1,
                      whiteSpace: 'nowrap'
                    }}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {history.map(day => {
                  const t = day.totals || {};
                  const isToday = day.date === todayStr();
                  const bn = day.bottleneck;
                  const bnStage = bn ? STAGE_MAP[bn.stage] : null;
                  return (
                    <tr key={day.date}
                      onClick={() => setDate(day.date)}
                      style={{ cursor: 'pointer', background: day.date === date ? 'rgba(59,130,246,0.08)' : 'transparent' }}
                      onMouseOver={e => { if (day.date !== date) e.currentTarget.style.background = 'rgba(255,255,255,0.03)'; }}
                      onMouseOut={e => { if (day.date !== date) e.currentTarget.style.background = 'transparent'; }}
                    >
                      <td style={{ padding: '8px 10px', borderBottom: `1px solid ${T.border}10`, color: isToday ? T.blue : T.text, fontWeight: isToday ? 700 : 400, whiteSpace: 'nowrap' }}>
                        {day.label}{isToday ? ' (today)' : ''}
                      </td>
                      {['PICKING', 'SURFACING', 'CUTTING', 'COATING', 'ASSEMBLY', 'SHIPPING'].map(stage => (
                        <td key={stage} style={{
                          padding: '8px 10px', borderBottom: `1px solid ${T.border}10`, textAlign: 'right',
                          color: (t[stage] || 0) > 0 ? T.text : T.textDim
                        }}>
                          {t[stage] || 0}
                        </td>
                      ))}
                      <td style={{ padding: '8px 10px', borderBottom: `1px solid ${T.border}10`, textAlign: 'right', color: T.textDim }}>
                        {day.hko || 0}
                      </td>
                      <td style={{
                        padding: '8px 10px', borderBottom: `1px solid ${T.border}10`,
                        color: bnStage ? bnStage.color : T.textDim, fontWeight: bn ? 600 : 400
                      }}>
                        {bn ? `${bn.stage} (${bn.avgRate}/hr)` : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

