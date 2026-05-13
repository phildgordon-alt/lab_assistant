// Shared UI components used across multiple tabs
import { useState, useEffect } from 'react';
import { T, mono } from '../constants';

// ──────────────────────────────────────────────────────────────────────────
// ceilToNice — round up to the next 1/2/5×10^n so shared axis ticks land
// on readable numbers (e.g. 1547 → 1600, 466 → 500). Used by GoalBar.
// ──────────────────────────────────────────────────────────────────────────
export function ceilToNice(n) {
  if (!isFinite(n) || n <= 0) return 100;
  const mag = Math.pow(10, Math.floor(Math.log10(n)));
  const norm = n / mag;
  const nice = norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10;
  return nice * mag;
}

// ──────────────────────────────────────────────────────────────────────────
// GoalBar — canonical goal-at-top-of-tab visual. Moved here from
// App.jsx-inline on 2026-05-13 so dept tabs in src/components/tabs/ can
// import cleanly (PickingTab was the first such tab).
//
// Phil 2026-05-13: actuals fill colored by actual/goal pace (green ≥100%,
// amber ≥85%, red <85%). Overage past goal renders as diagonal hatch in
// PROJ color. Bar never caps — axis max = ceilToNice(max(goal, projected,
// actual) × 1.05). Goal mark 2px slate-400 with 3px overshoot. Projected
// tick 3px in projColor with 4px overshoot. Shift-time hash 1px grey.
//
// Renders nothing when dailyGoal===0 so it self-hides until a formula ships.
// ──────────────────────────────────────────────────────────────────────────
export function GoalBar({ completedToday = 0, dailyGoal = 0, label = 'ACTUAL', shiftStartHour = 7, shiftEndHour = 15.5 }) {
  if (!dailyGoal) return null;
  const fmt = n => Math.round(n || 0).toLocaleString();
  const shiftStart = new Date(); shiftStart.setHours(shiftStartHour, 0, 0, 0);
  const shiftLenH = shiftEndHour - shiftStartHour;
  const shiftH = Math.max(0.5, (Date.now() - shiftStart.getTime()) / 3600000);
  const hoursRemaining = Math.max(0, shiftLenH - shiftH);
  const rate = shiftH > 0 ? completedToday / shiftH : 0;
  const projected = rate > 0 && shiftH > 0 ? Math.round(completedToday + rate * hoursRemaining) : completedToday;
  const axisMax = ceilToNice(Math.max(dailyGoal, projected, completedToday) * 1.05);
  const goalPct    = axisMax > 0 ? (dailyGoal     / axisMax) * 100 : 0;
  const actualPct  = axisMax > 0 ? (completedToday / axisMax) * 100 : 0;
  const projPct    = axisMax > 0 ? (projected     / axisMax) * 100 : 0;
  const shiftElapsedPct = Math.max(0, Math.min(100, (shiftH / shiftLenH) * 100));
  const projDelta = projected - dailyGoal;
  const colorFor = r => r >= 1.0 ? '#10B981' : r >= 0.85 ? '#F59E0B' : '#EF4444';
  const actualColor = colorFor(dailyGoal > 0 ? completedToday / dailyGoal : 0);
  const projColor   = colorFor(dailyGoal > 0 ? projected / dailyGoal : 0);
  const showProjTick = projected !== completedToday && Math.abs(projPct - actualPct) >= 3;
  const overage = Math.max(0, actualPct - goalPct);
  const cellLbl = { fontSize: 9, fontFamily: mono, color: '#94a3b8', fontWeight: 700, letterSpacing: 1.5 };
  const cellNum = { fontSize: 22, fontFamily: mono, fontWeight: 800, lineHeight: 1.1 };
  const cellSub = { fontSize: 11, fontFamily: mono, fontWeight: 700, marginTop: 2 };
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, padding: '10px 14px', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 10, marginBottom: 16 }}>
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 110 }}>
        <div style={cellLbl}>{label}</div>
        <div style={{ ...cellNum, color: actualColor }}>{fmt(completedToday)}</div>
      </div>
      <div style={{ flex: 1, position: 'relative', height: 16, background: T.bg, borderRadius: 6, overflow: 'visible' }}>
        <div style={{ position: 'absolute', inset: 0, borderRadius: 6, overflow: 'hidden' }}>
          <div style={{ position: 'absolute', left: 0, width: `${Math.min(actualPct, goalPct)}%`, height: '100%', background: actualColor, transition: 'width 0.8s ease, background 0.4s ease' }} />
          {overage > 0 && (
            <div
              title={`Over goal by ${fmt(completedToday - dailyGoal)}`}
              style={{
                position: 'absolute',
                left: `${goalPct}%`,
                width: `${overage}%`,
                height: '100%',
                background: `repeating-linear-gradient(135deg, ${projColor}88 0 4px, ${projColor}33 4px 8px)`,
                transition: 'width 0.8s ease',
              }}
            />
          )}
        </div>
        <div title={`Shift ${Math.round(shiftElapsedPct)}% elapsed`} style={{ position: 'absolute', left: `calc(${shiftElapsedPct}% - 0.5px)`, top: 0, width: 1, height: 16, background: 'rgba(203,213,225,0.45)', zIndex: 1 }} />
        <div title={`Goal ${fmt(dailyGoal)}`} style={{ position: 'absolute', left: `calc(${goalPct}% - 1px)`, top: -3, width: 2, height: 22, background: '#94a3b8', zIndex: 2 }} />
        {showProjTick && (
          <div title={`Projected ${fmt(projected)}`} style={{ position: 'absolute', left: `calc(${projPct}% - 1.5px)`, top: -4, width: 3, height: 24, background: projColor, borderRadius: 1, zIndex: 3 }} />
        )}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 110 }}>
        <div style={cellLbl}>PROJ EOD</div>
        <div style={{ ...cellNum, color: projColor }}>{fmt(projected)}</div>
        <div style={{ ...cellSub, color: projDelta >= 0 ? '#10B981' : '#EF4444' }}>
          {projDelta >= 0 ? '+' : ''}{fmt(projDelta)}
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', minWidth: 110, paddingLeft: 10, borderLeft: `1px solid ${T.border}` }}>
        <div style={cellLbl}>GOAL</div>
        <div style={{ ...cellNum, color: '#cbd5e1' }}>{fmt(dailyGoal)}</div>
      </div>
    </div>
  );
}

export const SectionHeader = ({children,right})=>(
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
    <div style={{fontSize:13,color:T.textMuted,textTransform:"uppercase",letterSpacing:1.5,fontFamily:mono,fontWeight:600}}>{children}</div>
    {right&&<div style={{fontSize:12,color:T.textDim}}>{right}</div>}
  </div>
);

export const Card = ({children,style,onClick})=>(
  <div onClick={onClick} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:16,cursor:onClick?"pointer":"default",transition:"border-color 0.2s",...style}}>{children}</div>
);

export const Pill = ({children,color,bg})=>(
  <span style={{fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:5,background:bg||`${color}20`,color,fontFamily:mono,textTransform:"uppercase",whiteSpace:"nowrap"}}>{children}</span>
);

export const KPICard = ({label,value,sub,trend,accent,onRemove,editable,onClick,clickable})=>(
  <div
    onClick={clickable&&onClick?onClick:undefined}
    style={{
      background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 22px",flex:"1 1 0",minWidth:160,borderTop:`4px solid ${accent||T.blue}`,position:'relative',
      cursor:clickable?'pointer':'default',
      transition:'all 0.15s ease',
    }}
    onMouseEnter={e=>{if(clickable){e.currentTarget.style.transform='translateY(-2px)';e.currentTarget.style.boxShadow=`0 4px 12px ${accent||T.blue}30`;}}}
    onMouseLeave={e=>{if(clickable){e.currentTarget.style.transform='none';e.currentTarget.style.boxShadow='none';}}}
  >
    {editable&&onRemove&&(
      <button onClick={e=>{e.stopPropagation();onRemove();}} style={{position:'absolute',top:6,right:6,background:'transparent',border:'none',color:T.textDim,fontSize:14,cursor:'pointer',opacity:0.5,padding:2}} title="Remove KPI">×</button>
    )}
    <div style={{fontSize:14,color:T.textMuted,textTransform:"uppercase",letterSpacing:1.5,fontFamily:mono,fontWeight:600}}>{label}</div>
    <div style={{fontSize:36,fontWeight:800,color:T.text,marginTop:4,fontFamily:mono}}>{value}</div>
    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
      {trend!=null&&<span style={{fontSize:13,color:trend>0?T.green:T.red,fontFamily:mono}}>{trend>0?"▲":"▼"}{Math.abs(trend)}%</span>}
      {sub&&<span style={{fontSize:12,color:T.textDim}}>{sub}</span>}
      {clickable&&<span style={{fontSize:10,color:accent||T.blue,marginLeft:'auto'}}>Click to view →</span>}
    </div>
  </div>
);

// ──────────────────────────────────────────────────────────────────────────
// GoalHistory — Goal vs Actual table for each department tab. Reads from
// /api/{dept}/goal-history?days=N. Hides until first server response.
//
// Threshold convention (matches GoalBar in App.jsx and Department Goals
// tile in OverviewTab):
//   actual >= 100% target → green
//   actual >=  85% target → amber
//   actual <   85% target → red
//
// Phil 2026-05-13: history data is written to DB by daily-capture writers
// (server/domain/daily-capture.js + captureDailyShipTarget). This component
// is a pure presenter — no live computation.
// ──────────────────────────────────────────────────────────────────────────
export function GoalHistory({ serverUrl, dept, deptLabel, days = 14 }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!serverUrl && serverUrl !== '') return;
    let cancelled = false;
    const fetchRows = async () => {
      try {
        const r = await fetch(`${serverUrl}/api/${dept}/goal-history?days=${days}`);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        if (!cancelled) {
          setRows(data.history || []);
          setError(null);
        }
      } catch (e) {
        if (!cancelled) setError(e.message);
      }
    };
    fetchRows();
    const iv = setInterval(fetchRows, 120000); // 2-min poll
    return () => { cancelled = true; clearInterval(iv); };
  }, [serverUrl, dept, days]);

  if (rows === null && !error) {
    return null; // hide until first response
  }

  if (error) {
    return (
      <Card style={{ marginTop: 16 }}>
        <SectionHeader>Goal vs Actual — {deptLabel || dept}</SectionHeader>
        <div style={{ padding: 16, color: T.red, fontSize: 12, fontFamily: mono }}>
          History unavailable: {error}
        </div>
      </Card>
    );
  }

  if (!rows.length) {
    return (
      <Card style={{ marginTop: 16 }}>
        <SectionHeader>Goal vs Actual — {deptLabel || dept}</SectionHeader>
        <div style={{ padding: 24, color: T.textDim, fontSize: 12, fontFamily: mono, textAlign: 'center' }}>
          No history yet — first day of tracking
        </div>
      </Card>
    );
  }

  // Compute max value for bar scaling.
  const max = Math.max(1, ...rows.map(r => Math.max(r.target || 0, r.actual || 0)));
  const todayYMD = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

  const rowColor = (r) => {
    if (!r.target) return T.textDim;
    const pct = r.actual / r.target;
    if (pct >= 1.0) return '#10B981';
    if (pct >= 0.85) return '#F59E0B';
    return '#EF4444';
  };

  return (
    <Card style={{ marginTop: 16 }}>
      <SectionHeader right={`${rows.length} day${rows.length === 1 ? '' : 's'}`}>Goal vs Actual — {deptLabel || dept}</SectionHeader>
      <div style={{ maxHeight: 400, overflowY: 'auto' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: mono }}>
          <thead style={{ position: 'sticky', top: 0, background: T.card, zIndex: 1 }}>
            <tr style={{ borderBottom: `1px solid ${T.border}` }}>
              <th style={{ padding: '8px 10px', textAlign: 'left', color: T.textDim, fontWeight: 600, fontSize: 10, letterSpacing: 1 }}>DATE</th>
              <th style={{ padding: '8px 10px', textAlign: 'left', color: T.textDim, fontWeight: 600, fontSize: 10, letterSpacing: 1 }}></th>
              <th style={{ padding: '8px 10px', textAlign: 'right', color: T.textDim, fontWeight: 600, fontSize: 10, letterSpacing: 1 }}>TARGET</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', color: T.textDim, fontWeight: 600, fontSize: 10, letterSpacing: 1 }}>ACTUAL</th>
              <th style={{ padding: '8px 10px', textAlign: 'right', color: T.textDim, fontWeight: 600, fontSize: 10, letterSpacing: 1 }}>Δ</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => {
              const isToday = r.date === todayYMD;
              const color = rowColor(r);
              const pct = r.target > 0 ? Math.min(100, Math.round((r.actual / r.target) * 100)) : 0;
              const tgtPct = max > 0 ? Math.round((r.target / max) * 100) : 0;
              const variance = r.variance != null ? r.variance : (r.actual - (r.target || 0));
              return (
                <tr key={r.date} style={{
                  background: isToday ? `${T.blue}15` : variance < -1 ? 'rgba(239,68,68,0.04)' : variance > 1 ? 'rgba(16,185,129,0.04)' : 'transparent',
                  borderBottom: `1px solid ${T.border}`,
                }}>
                  <td style={{ padding: '6px 10px', color: isToday ? T.text : T.textMuted, fontWeight: isToday ? 700 : 500 }}>
                    {r.date.slice(5)}
                  </td>
                  <td style={{ padding: '6px 10px', width: '40%' }}>
                    <div style={{ position: 'relative', height: 8, background: T.bg, borderRadius: 4, overflow: 'hidden' }}>
                      <div style={{ position: 'absolute', left: 0, top: 0, width: `${pct}%`, height: '100%', background: color, transition: 'width 0.6s ease, background 0.4s ease' }} />
                      {r.target > 0 && (
                        <div style={{ position: 'absolute', left: `${tgtPct}%`, top: -1, width: 2, height: 10, background: '#cbd5e1' }} title="Goal" />
                      )}
                    </div>
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: T.textMuted, fontWeight: 500 }}>
                    {(r.target || 0).toLocaleString()}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color, fontWeight: 700 }}>
                    {(r.actual || 0).toLocaleString()}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', color: variance >= 0 ? '#10B981' : '#EF4444', fontWeight: 700 }}>
                    {variance >= 0 ? '+' : ''}{variance.toLocaleString()}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

export function StageHistory({ serverUrl, stage, stageLabel, color }) {
  const [history, setHistory] = useState([]);

  useEffect(() => {
    if (!serverUrl) return;
    const go = async () => {
      try {
        const res = await fetch(`${serverUrl}/api/flow/production-history?days=14`);
        if (res.ok) setHistory(await res.json());
      } catch {}
    };
    go();
    const iv = setInterval(go, 120000);
    return () => clearInterval(iv);
  }, [serverUrl]);

  if (!history.length) return null;

  const stageKey = stage.toUpperCase();
  const maxCount = Math.max(1, ...history.map(d => d.totals?.[stageKey] || 0));

  return (
    <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: 16, marginTop: 20 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <div style={{ fontSize: 13, color: T.textMuted, textTransform: "uppercase", letterSpacing: 1.5, fontFamily: mono, fontWeight: 600 }}>{stageLabel} History — Daily Totals</div>
        <div style={{ fontSize: 12, color: T.textDim }}>{history.length} days</div>
      </div>
      <div style={{ maxHeight: 400, overflowY: "auto" }}>
        <table style={{ width: "100%", fontSize: 11, fontFamily: mono, borderCollapse: "collapse" }}>
          <thead>
            <tr style={{ borderBottom: `1px solid ${T.border}`, position: "sticky", top: 0, background: T.card }}>
              <th style={{ padding: "6px 10px", textAlign: "left", color: T.textMuted, fontSize: 9, letterSpacing: "0.08em" }}>Date</th>
              <th style={{ padding: "6px 10px", textAlign: "left", color: T.textMuted, fontSize: 9, letterSpacing: "0.08em" }}>Day</th>
              <th style={{ padding: "6px 10px", textAlign: "right", color: T.textMuted, fontSize: 9, letterSpacing: "0.08em" }}>{stageLabel}</th>
              <th style={{ padding: "6px 10px", textAlign: "right", color: T.textMuted, fontSize: 9, letterSpacing: "0.08em" }}>Shipped</th>
            </tr>
          </thead>
          <tbody>
            {history.map(day => {
              const count = day.totals?.[stageKey] || 0;
              const shipped = day.totals?.SHIPPING || 0;
              const barPct = Math.round((count / maxCount) * 100);
              const dayName = new Date(day.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
              const isToday = day.date === new Date().toISOString().slice(0, 10);
              return (
                <tr key={day.date} style={{ borderBottom: `1px solid ${T.bg}`, background: isToday ? `${color}10` : 'transparent' }}>
                  <td style={{ padding: "6px 10px", color: isToday ? color : T.text, fontWeight: isToday ? 700 : 600, fontSize: 11 }}>{day.date.slice(5)}</td>
                  <td style={{ padding: "6px 10px", color: T.textDim, fontSize: 10 }}>{dayName}</td>
                  <td style={{ padding: "6px 10px", textAlign: "right" }}>
                    <div style={{ display: "flex", alignItems: "center", justifyContent: "flex-end", gap: 8 }}>
                      <div style={{ width: 80, height: 5, background: T.surface, borderRadius: 3, overflow: "hidden" }}>
                        <div style={{ width: `${barPct}%`, height: "100%", background: count > 0 ? color : T.textDim, borderRadius: 3 }} />
                      </div>
                      <span style={{ minWidth: 30, textAlign: "right", fontWeight: 700, color: count > 0 ? color : T.textDim, fontSize: 13 }}>{count}</span>
                    </div>
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "right", color: shipped > 0 ? T.green : T.textDim, fontWeight: 600, fontSize: 12 }}>{shipped}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
