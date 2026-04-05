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
  const containerRef = useRef(null);
  const [chartW, setChartW] = useState(800);

  useEffect(() => {
    if (!serverUrl) return;
    fetch(`${serverUrl}/api/som/lens-per-hour?date=${date}`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setSomData(d))
      .catch(() => setSomData(null));
  }, [serverUrl, date]);

  useEffect(() => {
    if (!containerRef.current) return;
    setChartW(containerRef.current.clientWidth - 40);
    const ro = new ResizeObserver(entries => { setChartW(entries[0].contentRect.width - 40); });
    ro.observe(containerRef.current);
    return () => ro.disconnect();
  }, []);

  if (!somData || !somData.series || somData.series.length === 0) return null;

  const series = somData.series;
  const hours = somData.hours || [];
  const maxVal = Math.max(1, ...series.flatMap(s => (s.data || []).map(d => d.lenses || 0)));
  const H = 160;
  const padL = 35;
  const barGroupW = hours.length > 0 ? (chartW - padL) / hours.length : 30;

  return (
    <div ref={containerRef} style={{
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
      <svg width="100%" height={H + 25} style={{ display: 'block', overflow: 'hidden' }}>
        {/* Grid lines */}
        {[0, 0.25, 0.5, 0.75, 1].map(f => (
          <g key={f}>
            <line x1={padL} y1={H - f * H} x2={chartW} y2={H - f * H} stroke="rgba(255,255,255,0.05)" />
            <text x={padL - 4} y={H - f * H + 3} fill={T.textDim} fontSize={8} fontFamily={mono} textAnchor="end">
              {Math.round(f * maxVal)}
            </text>
          </g>
        ))}
        {/* Stacked bars per hour */}
        {hours.map((h, hi) => {
          const x = padL + hi * barGroupW;
          let yOffset = 0;
          return (
            <g key={h}>
              {series.map(s => {
                const dp = (s.data || []).find(d => d.hour === h);
                const val = dp ? dp.lenses : 0;
                const barH = (val / maxVal) * H;
                const y = H - yOffset - barH;
                yOffset += barH;
                return val > 0 ? (
                  <rect key={s.name} x={x + 2} y={y} width={Math.max(1, barGroupW - 4)} height={barH}
                    fill={MACHINE_COLORS[s.name] || T.textDim} opacity={0.8} rx={2}>
                    <title>{s.name} {h > 12 ? h - 12 + 'p' : h + 'a'}: {val} lenses</title>
                  </rect>
                ) : null;
              })}
              <text x={x + barGroupW / 2} y={H + 14} fill={T.textDim} fontSize={8} fontFamily={mono} textAnchor="middle">
                {h > 12 ? h - 12 + 'p' : h === 12 ? '12p' : h + 'a'}
              </text>
            </g>
          );
        })}
      </svg>
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

  // Chart container ref for responsive width
  const chartRef = useRef(null);
  const [chartW, setChartW] = useState(1200);

  useEffect(() => {
    if (!chartRef.current) return;
    // Measure immediately
    setChartW(chartRef.current.clientWidth || 1200);
    const obs = new ResizeObserver(entries => {
      for (const e of entries) setChartW(e.contentRect.width);
    });
    obs.observe(chartRef.current);
    return () => obs.disconnect();
  }, []);

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
  const svgPadL = 40;
  const svgPadR = 10;
  const svgH = 240;
  const svgW = chartW - 2; // account for border
  const plotW = svgW - svgPadL - svgPadR;
  const plotH = svgH - 30; // leave room for x labels

  const xForHour = (idx) => svgPadL + (hours.length > 1 ? (idx / (hours.length - 1)) * plotW : plotW / 2);
  const yForVal = (val) => 10 + (1 - val / chartMax) * (plotH - 20);

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

        {/* SVG Chart */}
        <div ref={chartRef} style={{ width: '100%', minWidth: 0, overflow: 'hidden' }}>
          <svg width="100%" height={svgH} style={{ display: 'block', overflow: 'hidden' }}>
            {/* Grid lines */}
            {[0, 0.25, 0.5, 0.75, 1].map(p => {
              const y = yForVal(chartMax * p);
              return (
                <g key={p}>
                  <line x1={svgPadL} y1={y} x2={svgW - svgPadR} y2={y}
                    stroke="rgba(255,255,255,0.06)" strokeWidth="1" />
                  <text x={svgPadL - 4} y={y + 3} textAnchor="end"
                    fill={T.textDim} fontSize="9" fontFamily="'JetBrains Mono',monospace">
                    {Math.round(chartMax * p)}
                  </text>
                </g>
              );
            })}

            {/* X-axis labels */}
            {hours.map((h, i) => (
              <text key={h} x={xForHour(i)} y={svgH - 4} textAnchor="middle"
                fill={T.textDim} fontSize="9" fontFamily="'JetBrains Mono',monospace">
                {formatHour(h)}
              </text>
            ))}

            {/* Compare lines (dashed, behind) */}
            {compareOn && compareData && visibleStages.map(s => {
              const arr = compareData[s.key] || [];
              if (arr.length < 2) return null;
              const pts = arr.map((d, i) => `${xForHour(i)},${yForVal(d.count)}`).join(' ');
              return (
                <polyline key={s.key + '-cmp'} points={pts} fill="none"
                  stroke={s.color} strokeWidth="1.5" strokeDasharray="4,3" opacity="0.35" />
              );
            })}

            {/* Main lines */}
            {visibleStages.map(s => {
              const arr = throughput[s.key] || [];
              if (arr.length < 2) return null;
              const pts = arr.map((d, i) => `${xForHour(i)},${yForVal(d.count)}`).join(' ');
              const peakIdx = arr.reduce((best, d, i) => d.count > arr[best].count ? i : best, 0);
              const peakVal = arr[peakIdx]?.count || 0;
              return (
                <g key={s.key}>
                  <polyline points={pts} fill="none" stroke={s.color} strokeWidth="2" opacity="0.85" />
                  {peakVal > 0 && (
                    <>
                      <circle cx={xForHour(peakIdx)} cy={yForVal(peakVal)} r="3"
                        fill={s.color} stroke={T.bg} strokeWidth="1" />
                      <text x={xForHour(peakIdx)} y={yForVal(peakVal) - 7} textAnchor="middle"
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
    </div>
  );
}

