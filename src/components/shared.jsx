// Shared UI components used across multiple tabs
import { useState, useEffect } from 'react';
import { T, mono } from '../constants';

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
