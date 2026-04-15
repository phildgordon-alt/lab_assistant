// MaintenanceTab - Equipment maintenance management from Limble CMMS
import { useState, useEffect, useMemo } from 'react';
import { T, mono } from '../../constants';
import { Card, SectionHeader, Pill, KPICard } from '../shared';

// Local wrapper to avoid circular import with App.jsx
function ProductionStageWrapper({ children }) {
  return (
    <div style={{ display: "flex", height: "calc(100vh - 160px)", overflow: "hidden" }}>
      <div style={{ flex: 1, overflow: "auto", padding: "22px 28px" }}>
        {children}
      </div>
    </div>
  );
}

// Local InventoryDetailPanel to avoid circular import
function InventoryDetailPanel({ item, onClose, title = "Item Details" }) {
  if (!item) return null;
  const identFields = ['sku', 'id', 'name', 'description', 'barcode', 'partNumber'];
  const stockFields = ['qty', 'qtyAvailable', 'qtyReserved', 'reorderPoint', 'minQty', 'maxQty'];
  const locationFields = ['location', 'warehouse', 'bin', 'zone'];
  const renderField = (key, value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') value = value ? 'Yes' : 'No';
    if (typeof value === 'object') value = JSON.stringify(value);
    return (
      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${T.border}22` }}>
        <span style={{ color: T.textDim, fontSize: 11, fontFamily: mono }}>{key}</span>
        <span style={{ color: T.text, fontSize: 12, fontFamily: mono, fontWeight: 600, maxWidth: '60%', textAlign: 'right', wordBreak: 'break-word' }}>{String(value)}</span>
      </div>
    );
  };
  const renderSection = (sectionTitle, fields) => {
    const items = fields.map(f => renderField(f, item[f])).filter(Boolean);
    if (items.length === 0) return null;
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>{sectionTitle}</div>
        {items}
      </div>
    );
  };
  const isOutOfStock = item.qty === 0;
  const isLowStock = item.qty > 0 && item.qty <= (item.reorderPoint || 10);
  const stockColor = isOutOfStock ? T.red : isLowStock ? T.amber : T.green;
  const stockLabel = isOutOfStock ? 'OUT OF STOCK' : isLowStock ? 'LOW STOCK' : 'IN STOCK';
  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: T.surface, borderLeft: `1px solid ${T.border}`, zIndex: 1000, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px #00000040' }}>
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{item.sku || item.name || title}</div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: `${stockColor}20`, color: stockColor, fontFamily: mono }}>{stockLabel}</span>
            {item.qty !== undefined && <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: mono }}>{item.qty} units</span>}
          </div>
        </div>
        <button onClick={onClose} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 12px', color: T.textMuted, cursor: 'pointer', fontSize: 12 }}>✕ Close</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {renderSection('Identification', identFields)}
        {renderSection('Stock Levels', stockFields)}
        {renderSection('Location', locationFields)}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>All Fields</div>
          {Object.entries(item).map(([k, v]) => renderField(k, v))}
        </div>
      </div>
    </div>
  );
}

// ─── Machines Section: tool life, polish pads, attention rail ──────────────
function statusToColor(status){
  if(status==='critical')return T.red;
  if(status==='warning')return T.amber;
  if(status==='heads_up')return T.orange||'#F97316';
  return T.green;
}
function statusLabel(s){
  return s==='critical'?'CRITICAL':s==='warning'?'WARNING':s==='heads_up'?'HEADS-UP':'OK';
}

function ToolLifeBar({remainingPct,status}){
  const pct=Math.max(0,Math.min(1,remainingPct));
  const color=statusToColor(status);
  return (
    <div style={{position:'relative',height:8,background:`${T.border}40`,borderRadius:4,overflow:'hidden'}}>
      <div style={{position:'absolute',left:0,top:0,bottom:0,width:`${pct*100}%`,background:color,transition:'width .4s, background .4s'}}/>
    </div>
  );
}

function AttentionRail({alerts,summary}){
  if(!alerts||alerts.length===0){
    return (
      <Card style={{padding:'14px 18px',display:'flex',alignItems:'center',gap:12}}>
        <span style={{width:10,height:10,borderRadius:'50%',background:T.green}}/>
        <div style={{fontSize:13,color:T.text,fontWeight:700}}>All tools & pads within thresholds</div>
        <div style={{marginLeft:'auto',fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>NO ACTIVE ALERTS</div>
      </Card>
    );
  }
  const top=alerts.slice(0,6);
  return (
    <Card style={{padding:'12px 14px'}}>
      <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:10}}>
        <div style={{fontSize:11,color:T.textDim,fontFamily:mono,letterSpacing:1.5}}>ATTENTION RAIL</div>
        {summary.critical>0&&<Pill color={T.red}>{summary.critical} critical</Pill>}
        {summary.warning>0&&<Pill color={T.amber}>{summary.warning} warning</Pill>}
        {summary.headsUp>0&&<span style={{fontSize:10,fontFamily:mono,color:T.textDim}}>{summary.headsUp} heads-up</span>}
        <div style={{marginLeft:'auto',fontSize:10,color:T.textDim,fontFamily:mono}}>{alerts.length} total</div>
      </div>
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(260px,1fr))',gap:8}}>
        {top.map(a=>{
          const color=statusToColor(a.status);
          return (
            <div key={a.key} style={{display:'flex',alignItems:'center',gap:10,padding:'8px 10px',background:`${color}12`,border:`1px solid ${color}40`,borderRadius:6}}>
              <div style={{width:6,height:28,background:color,borderRadius:3}}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:mono,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                  {a.device}{a.slot!=null?` · slot ${a.slot}`:''}
                </div>
                <div style={{fontSize:10,color:T.textDim,fontFamily:mono,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                  SN {a.serialNumber} · {a.kind}
                </div>
              </div>
              <div style={{textAlign:'right'}}>
                <div style={{fontSize:16,fontWeight:800,color,fontFamily:mono,lineHeight:1}}>{(a.remainingPct*100).toFixed(0)}%</div>
                <div style={{fontSize:9,color,fontFamily:mono,letterSpacing:1}}>{statusLabel(a.status)}</div>
              </div>
            </div>
          );
        })}
      </div>
      {alerts.length>top.length&&(
        <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginTop:8,textAlign:'right'}}>+{alerts.length-top.length} more — see full grid below</div>
      )}
    </Card>
  );
}

function ToolLifeGrid({title,items,emptyLabel}){
  if(!items||items.length===0){
    return (
      <Card>
        <SectionHeader>{title}</SectionHeader>
        <div style={{padding:'16px 4px',fontSize:12,color:T.textDim,fontFamily:mono}}>{emptyLabel||'No data'}</div>
      </Card>
    );
  }
  // Sort: lowest remaining first so operators see the urgent ones on top
  const sorted=[...items].sort((a,b)=>a.remainingPct-b.remainingPct);
  // Group by device
  const byDevice={};
  sorted.forEach(t=>{
    if(!byDevice[t.device])byDevice[t.device]=[];
    byDevice[t.device].push(t);
  });
  return (
    <Card>
      <SectionHeader right={<span style={{fontSize:10,fontFamily:mono,color:T.textDim}}>{items.length} tools</span>}>{title}</SectionHeader>
      <div style={{display:'flex',flexDirection:'column',gap:14,maxHeight:440,overflowY:'auto',paddingRight:4}}>
        {Object.entries(byDevice).map(([device,tools])=>(
          <div key={device}>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:6,borderBottom:`1px solid ${T.border}40`,paddingBottom:4}}>
              {device} <span style={{color:T.textDim,fontWeight:400}}>· {tools.length} tool{tools.length!==1?'s':''}</span>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fill,minmax(220px,1fr))',gap:8}}>
              {tools.map(t=>{
                const color=statusToColor(t.status);
                const pct=(t.remainingPct*100).toFixed(0);
                return (
                  <div key={`${device}-${t.side}-${t.slot}-${t.serialNumber}`} style={{padding:'8px 10px',background:T.card,border:`1px solid ${color}30`,borderRadius:6}}>
                    <div style={{display:'flex',justifyContent:'space-between',alignItems:'baseline',marginBottom:4}}>
                      <div style={{fontSize:11,fontWeight:700,color:T.text,fontFamily:mono}}>
                        Slot {t.slot}{t.side?` · ${t.side}`:''}
                      </div>
                      <div style={{fontSize:14,fontWeight:800,color,fontFamily:mono}}>{pct}%</div>
                    </div>
                    <ToolLifeBar remainingPct={t.remainingPct} status={t.status}/>
                    <div style={{display:'flex',justifyContent:'space-between',marginTop:4,fontSize:9,color:T.textDim,fontFamily:mono}}>
                      <span>SN {t.serialNumber}</span>
                      <span>{t.used.toLocaleString()}/{t.max.toLocaleString()}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
}

function PolishPadBars({items}){
  if(!items||items.length===0){
    return (
      <Card>
        <SectionHeader>Polish Pad Liquid Levels</SectionHeader>
        <div style={{padding:'16px 4px',fontSize:12,color:T.textDim,fontFamily:mono}}>No polish pad data available</div>
      </Card>
    );
  }
  const sorted=[...items].sort((a,b)=>a.remainingPct-b.remainingPct);
  return (
    <Card>
      <SectionHeader right={<span style={{fontSize:10,fontFamily:mono,color:T.textDim}}>{items.length} pads</span>}>Polish Pad Liquid Levels</SectionHeader>
      <div style={{display:'flex',flexDirection:'column',gap:6,maxHeight:440,overflowY:'auto',paddingRight:4}}>
        {sorted.map(p=>{
          const color=statusToColor(p.status);
          const pct=(p.remainingPct*100).toFixed(0);
          return (
            <div key={`${p.device}-${p.side}-${p.serialNumber}`} style={{display:'grid',gridTemplateColumns:'180px 1fr 60px 80px',gap:10,alignItems:'center',padding:'6px 8px',borderBottom:`1px solid ${T.border}22`}}>
              <div style={{fontSize:11,fontWeight:700,color:T.text,fontFamily:mono,whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                {p.device}{p.side?` · ${p.side}`:''}
              </div>
              <ToolLifeBar remainingPct={p.remainingPct} status={p.status}/>
              <div style={{fontSize:13,fontWeight:800,color,fontFamily:mono,textAlign:'right'}}>{pct}%</div>
              <div style={{fontSize:9,color:T.textDim,fontFamily:mono,textAlign:'right',whiteSpace:'nowrap',overflow:'hidden',textOverflow:'ellipsis'}}>
                {p.padType||''} SN {p.serialNumber}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function MachinesSection({tools,toolAlerts,ovenServerUrl}){
  const sum=tools.summary||{};
  const lastPoll=tools.lastPoll?new Date(tools.lastPoll).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}):'—';
  const statusDot=tools.isLive?T.green:T.red;
  const statusTxt=tools.isLive?'SOM LIVE':'SOM OFFLINE';
  return (
    <div style={{display:'flex',flexDirection:'column',gap:16}}>
      {/* Header strip */}
      <div style={{display:'flex',alignItems:'center',gap:14,flexWrap:'wrap'}}>
        <div>
          <div style={{fontSize:18,fontWeight:800,color:T.text,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1}}>MACHINES</div>
          <div style={{fontSize:11,color:T.textDim}}>Tool life & polish pad liquid levels — Schneider SOM</div>
        </div>
        <div style={{marginLeft:'auto',display:'flex',alignItems:'center',gap:10}}>
          <span style={{width:8,height:8,borderRadius:'50%',background:statusDot}}/>
          <span style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>{statusTxt}</span>
          <span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>Updated {lastPoll}</span>
        </div>
      </div>

      {/* KPI strip */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(150px,1fr))',gap:10}}>
        <KPICard label="Cutting Tools" value={sum.cutting||0} sub="tracked" accent={T.cyan}/>
        <KPICard label="Milling Tools" value={sum.milling||0} sub="tracked" accent={T.purple}/>
        <KPICard label="Polish Pads" value={sum.polish||0} sub="tracked" accent={T.blue}/>
        <KPICard label="Critical" value={sum.critical||0} sub="≤ 5% remaining" accent={(sum.critical||0)>0?T.red:T.green}/>
        <KPICard label="Warning" value={sum.warning||0} sub="≤ 10% remaining" accent={(sum.warning||0)>0?T.amber:T.green}/>
        <KPICard label="Heads-up" value={sum.headsUp||0} sub="≤ 25% remaining" accent={(sum.headsUp||0)>0?(T.orange||'#F97316'):T.green}/>
      </div>

      {/* Attention Rail */}
      <AttentionRail alerts={toolAlerts.alerts||[]} summary={toolAlerts.summary||{}}/>

      {/* Tool Life Grids — cutting + milling side by side, polish pads below */}
      <div style={{display:'grid',gridTemplateColumns:'repeat(auto-fit,minmax(420px,1fr))',gap:16}}>
        <ToolLifeGrid title="Cutting Tool Life" items={tools.cutting} emptyLabel="No cutting tools reporting"/>
        <ToolLifeGrid title="Milling Tool Life" items={tools.milling} emptyLabel="No milling tools reporting"/>
      </div>

      <PolishPadBars items={tools.polish}/>
    </div>
  );
}

export default function MaintenanceTab({ovenServerUrl,settings}){
  const [sub,setSub]=useState("machines");
  const [maintenance,setMaintenance]=useState({assets:[],tasks:[],downtime:[],parts:[],stats:{},lastSync:null,status:'pending'});
  const [loading,setLoading]=useState(true);
  const [selectedTask,setSelectedTask]=useState(null);  // For work order detail modal
  const [selectedPart,setSelectedPart]=useState(null);  // For spare part detail panel

  // SOM machine monitoring (tool life + polish pads)
  const [somTools,setSomTools]=useState({milling:[],cutting:[],polish:[],summary:{},isLive:false,lastPoll:null});
  const [somToolAlerts,setSomToolAlerts]=useState({alerts:[],summary:{}});
  useEffect(()=>{
    if(!ovenServerUrl)return;
    const go=async()=>{
      try{
        const [tR,aR]=await Promise.all([
          fetch(`${ovenServerUrl}/api/som/tools`,{signal:AbortSignal.timeout(5000)}),
          fetch(`${ovenServerUrl}/api/som/alerts/active`,{signal:AbortSignal.timeout(5000)}),
        ]);
        if(tR.ok)setSomTools(await tR.json());
        if(aR.ok)setSomToolAlerts(await aR.json());
      }catch(e){/* silent — banner will show offline */}
    };
    go(); const iv=setInterval(go,30000); return()=>clearInterval(iv);
  },[ovenServerUrl]);

  // Fetch maintenance data from server
  useEffect(()=>{
    if(!ovenServerUrl)return;
    const go=async()=>{
      try{
        const [aR,tR,dR,pR,sR]=await Promise.all([
          fetch(`${ovenServerUrl}/api/maintenance/assets`,{signal:AbortSignal.timeout(5000)}),
          fetch(`${ovenServerUrl}/api/maintenance/tasks`,{signal:AbortSignal.timeout(5000)}),
          fetch(`${ovenServerUrl}/api/maintenance/downtime`,{signal:AbortSignal.timeout(5000)}),
          fetch(`${ovenServerUrl}/api/maintenance/parts`,{signal:AbortSignal.timeout(5000)}),
          fetch(`${ovenServerUrl}/api/maintenance/stats`,{signal:AbortSignal.timeout(5000)}),
        ]);
        const assets=aR.ok?await aR.json():{assets:[]};
        const tasks=tR.ok?await tR.json():{tasks:[],open:[],critical:[]};
        const downtime=dR.ok?await dR.json():{downtime:[],planned:[],unplanned:[]};
        const parts=pR.ok?await pR.json():{parts:[],lowStock:[]};
        const stats=sR.ok?await sR.json():{};
        setMaintenance({
          assets:assets.assets||[],
          tasks:tasks.tasks||[],
          openTasks:tasks.open||[],
          criticalTasks:tasks.critical||[],
          downtime:downtime.downtime||[],
          plannedDowntime:downtime.planned||[],
          unplannedDowntime:downtime.unplanned||[],
          parts:parts.parts||[],
          lowStockParts:parts.lowStock||[],
          stats:stats||{},
          lastSync:stats.lastSync||assets.lastSync,
          status:stats.status||assets.status||'ok',
        });
        setLoading(false);
      }catch(e){
        console.error('[Maintenance] Fetch error:',e);
        setMaintenance(prev=>({...prev,status:'error'}));
        setLoading(false);
      }
    };
    go(); const iv=setInterval(go,60000); return()=>clearInterval(iv);
  },[ovenServerUrl]);

  const s=maintenance.stats;
  const fmtHrs=h=>h!==null&&h!==undefined?`${h}h`:'—';

  // Equipment categories for grouping
  const assetsByCategory=useMemo(()=>{
    const map={};
    maintenance.assets.forEach(a=>{
      const cat=a.category||'Other';
      if(!map[cat])map[cat]=[];
      map[cat].push(a);
    });
    return map;
  },[maintenance.assets]);

  // Status color helper
  const statusColor=(status)=>{
    if(status==='operational'||status==='online')return T.green;
    if(status==='down'||status==='offline')return T.red;
    if(status==='maintenance')return T.amber;
    return T.textMuted;
  };

  const priorityColor=(p)=>{
    if(p==='critical')return T.red;
    if(p==='high')return T.orange;
    if(p==='medium')return T.amber;
    return T.textMuted;
  };

  const pmStatusColor=(s)=>{
    if(s==='overdue')return T.red;
    if(s==='due-soon')return T.amber;
    return T.green;
  };

  // Top bar navigation
  const topBar=(
    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:18,flexWrap:"wrap"}}>
      {[{id:"machines",icon:"🛠",label:"Machines"},{id:"overview",icon:"◉",label:"Overview"},{id:"equipment",icon:"⚙️",label:"Equipment"},
        {id:"tasks",icon:"📋",label:"Work Orders"},{id:"downtime",icon:"⏱️",label:"Downtime"},
        {id:"parts",icon:"🔩",label:"Spare Parts"}].map(n=>(
        <button key={n.id} onClick={()=>setSub(n.id)}
          style={{background:sub===n.id?T.blueDark:"transparent",border:`1px solid ${sub===n.id?T.blue:"transparent"}`,
          borderRadius:8,padding:"9px 18px",cursor:"pointer",color:sub===n.id?"#93C5FD":T.textMuted,
          fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:7,fontFamily:"'DM Sans',sans-serif",transition:"all 0.2s"}}>
          {n.icon} {n.label}
        </button>
      ))}
      <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
        <div style={{width:8,height:8,borderRadius:"50%",background:maintenance.status==='ok'?T.green:maintenance.status==='mock'?T.amber:T.red}}/>
        <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{maintenance.status==='mock'?'MOCK DATA':maintenance.status==='ok'?'LIMBLE LIVE':'OFFLINE'}</span>
        {maintenance.lastSync&&<span style={{fontSize:9,color:T.textDim,fontFamily:mono,marginLeft:4}}>Last sync: {new Date(maintenance.lastSync).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'})}</span>}
      </div>
    </div>
  );

  const contextData={
    uptimePercent:s.uptimePercent,oePercent:s.oePercent,teapScore:s.teapScore,
    openTaskCount:s.openTaskCount||0,criticalTaskCount:s.criticalTaskCount||0,
    pmCompliancePercent:s.pmCompliancePercent,
    assetCount:maintenance.assets?.length||0,
    hasData:s.hasData,
    status:maintenance.status
  };

  if(loading){
    return(
      <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:300}}>
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:32,marginBottom:10}}>🔧</div>
          <div style={{fontSize:14,color:T.textMuted}}>Loading maintenance data...</div>
        </div>
      </div>
    );
  }

  return(
    <ProductionStageWrapper>
    <div>
      {topBar}

      {/* ══ MACHINES (SOM tool life + polish pads) ══ */}
      {sub==="machines"&&(
        <MachinesSection tools={somTools} toolAlerts={somToolAlerts} ovenServerUrl={ovenServerUrl}/>
      )}

      {/* ══ OVERVIEW ══ */}
      {sub==="overview"&&(
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          {/* No data warning banner */}
          {s.hasData===false&&(
            <div style={{background:`${T.amber}15`,border:`1px solid ${T.amber}40`,borderRadius:8,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:20}}>⚠️</span>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:T.amber}}>No Recent Maintenance Data</div>
                <div style={{fontSize:11,color:T.textMuted}}>All tasks in Limble are historical (completed). KPIs will show once new work orders or downtime records are logged.</div>
              </div>
            </div>
          )}
          {/* Primary KPI strip */}
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <KPICard label="Uptime" value={s.uptimePercent!=null?`${s.uptimePercent}%`:'—'} sub="last 30 days" accent={s.uptimePercent!=null?(s.uptimePercent>95?T.green:s.uptimePercent>90?T.amber:T.red):T.textDim}/>
            <KPICard label="OE Score" value={s.oePercent!=null?`${s.oePercent}%`:'—'} sub="operational efficiency" accent={s.oePercent!=null?(s.oePercent>90?T.green:s.oePercent>80?T.amber:T.red):T.textDim}/>
            <KPICard label="TEAP Score" value={s.teapScore!=null?s.teapScore:'—'} sub="total effective performance" accent={s.teapScore!=null?(s.teapScore>85?T.green:s.teapScore>75?T.amber:T.red):T.textDim}/>
            <KPICard label="Open Tasks" value={s.openTaskCount||0} sub={`${s.criticalTaskCount||0} critical`} accent={s.criticalTaskCount>0?T.red:s.openTaskCount>10?T.amber:T.green}/>
            <KPICard label="PM Compliance" value={s.pmCompliancePercent!=null?`${s.pmCompliancePercent}%`:'—'} sub={`${s.pmCompleted30d||0} of ${s.pmScheduled30d||0}`} accent={s.pmCompliancePercent!=null?(s.pmCompliancePercent>90?T.green:s.pmCompliancePercent>75?T.amber:T.red):T.textDim}/>
          </div>

          {/* Secondary stats row */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:14}}>
            <Card style={{padding:"14px 18px"}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:6}}>DOWNTIME (30D)</div>
              <div style={{display:"flex",gap:16}}>
                <div>
                  <div style={{fontSize:24,fontWeight:800,color:T.text,fontFamily:mono}}>{fmtHrs(s.totalDowntimeHrs)}</div>
                  <div style={{fontSize:10,color:T.textDim}}>total</div>
                </div>
                <div>
                  <div style={{fontSize:18,fontWeight:700,color:T.amber,fontFamily:mono}}>{fmtHrs(s.plannedDowntimeHrs)}</div>
                  <div style={{fontSize:10,color:T.textDim}}>planned</div>
                </div>
                <div>
                  <div style={{fontSize:18,fontWeight:700,color:T.red,fontFamily:mono}}>{fmtHrs(s.unplannedDowntimeHrs)}</div>
                  <div style={{fontSize:10,color:T.textDim}}>unplanned</div>
                </div>
              </div>
            </Card>
            <Card style={{padding:"14px 18px"}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:6}}>RELIABILITY</div>
              <div style={{display:"flex",gap:20}}>
                <div>
                  <div style={{fontSize:24,fontWeight:800,color:T.cyan,fontFamily:mono}}>{s.mtbfHrs!==null?`${s.mtbfHrs}h`:'—'}</div>
                  <div style={{fontSize:10,color:T.textDim}}>MTBF</div>
                </div>
                <div>
                  <div style={{fontSize:24,fontWeight:800,color:T.purple,fontFamily:mono}}>{s.mttrHrs!==null?`${s.mttrHrs}h`:'—'}</div>
                  <div style={{fontSize:10,color:T.textDim}}>MTTR</div>
                </div>
              </div>
            </Card>
            <Card style={{padding:"14px 18px"}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:6}}>EQUIPMENT STATUS</div>
              <div style={{display:"flex",gap:16}}>
                <div>
                  <div style={{fontSize:24,fontWeight:800,color:T.green,fontFamily:mono}}>{s.operationalAssets||0}</div>
                  <div style={{fontSize:10,color:T.textDim}}>operational</div>
                </div>
                <div>
                  <div style={{fontSize:18,fontWeight:700,color:T.red,fontFamily:mono}}>{s.assetsDown||0}</div>
                  <div style={{fontSize:10,color:T.textDim}}>down</div>
                </div>
                <div>
                  <div style={{fontSize:18,fontWeight:700,color:T.amber,fontFamily:mono}}>{s.assetsPMOverdue||0}</div>
                  <div style={{fontSize:10,color:T.textDim}}>PM overdue</div>
                </div>
              </div>
            </Card>
          </div>

          {/* Critical tasks and equipment health side by side */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <Card>
              <SectionHeader right={<span style={{fontSize:10,fontFamily:mono,color:T.textDim}}>{maintenance.openTasks?.length||0} open</span>}>Critical & High Priority Tasks</SectionHeader>
              <div style={{maxHeight:280,overflowY:"auto"}}>
                {maintenance.openTasks?.filter(t=>t.priority==='critical'||t.priority==='high').slice(0,8).map(t=>(
                  <div key={t.id} onClick={()=>setSelectedTask(t)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 0",borderBottom:`1px solid ${T.border}`,cursor:"pointer",transition:"background 0.15s",marginLeft:-8,marginRight:-8,paddingLeft:8,paddingRight:8,borderRadius:6}}
                    onMouseEnter={e=>e.currentTarget.style.background=T.bg}
                    onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:priorityColor(t.priority),flexShrink:0}}/>
                    <div style={{flex:1,minWidth:0}}>
                      <div style={{fontSize:12,color:T.text,fontWeight:600,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.title}</div>
                      <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{t.asset||'General'} · {t.assignee||'Unassigned'}</div>
                    </div>
                    <Pill color={priorityColor(t.priority)}>{t.priority}</Pill>
                  </div>
                ))}
                {(!maintenance.openTasks||maintenance.openTasks.filter(t=>t.priority==='critical'||t.priority==='high').length===0)&&(
                  <div style={{textAlign:"center",padding:20,color:T.textDim,fontFamily:mono,fontSize:11}}>No critical/high priority tasks</div>
                )}
              </div>
            </Card>

            <Card>
              <SectionHeader right={<span style={{fontSize:10,fontFamily:mono,color:T.textDim}}>{maintenance.assets?.length||0} assets</span>}>Equipment by Category</SectionHeader>
              <div style={{maxHeight:280,overflowY:"auto"}}>
                {Object.entries(assetsByCategory).map(([cat,assets])=>{
                  const operational=assets.filter(a=>a.status==='operational'||a.status==='online').length;
                  const down=assets.filter(a=>a.status!=='operational'&&a.status!=='online').length;
                  const pmIssues=assets.filter(a=>a.pmStatus==='overdue'||a.pmStatus==='due-soon').length;
                  return(
                    <div key={cat} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
                      <div style={{fontSize:16}}>⚙️</div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:13,fontWeight:700,color:T.text}}>{cat}</div>
                        <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{assets.length} units</div>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <span style={{fontSize:11,fontWeight:700,color:T.green,fontFamily:mono}}>{operational}✓</span>
                        {down>0&&<span style={{fontSize:11,fontWeight:700,color:T.red,fontFamily:mono}}>{down}✗</span>}
                        {pmIssues>0&&<span style={{fontSize:11,fontWeight:700,color:T.amber,fontFamily:mono}}>{pmIssues}⚠</span>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          </div>
        </div>
      )}

      {/* ══ EQUIPMENT ══ */}
      {sub==="equipment"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {Object.entries(assetsByCategory).map(([cat,assets])=>(
            <Card key={cat} style={{borderLeft:`4px solid ${T.blue}`}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:14}}>
                <span style={{fontSize:18}}>⚙️</span>
                <span style={{fontSize:16,fontWeight:800,color:T.text}}>{cat}</span>
                <span style={{fontSize:11,color:T.textDim,fontFamily:mono}}>{assets.length} units</span>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(260px,1fr))",gap:12}}>
                {assets.map(a=>(
                  <div key={a.id} style={{background:T.bg,border:`1px solid ${statusColor(a.status)}30`,borderRadius:10,padding:"12px 14px"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                      <div>
                        <div style={{fontSize:14,fontWeight:700,color:T.text}}>{a.name}</div>
                        <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{a.manufacturer} {a.model}</div>
                      </div>
                      <Pill color={statusColor(a.status)} bg={`${statusColor(a.status)}20`}>{a.status}</Pill>
                    </div>
                    <div style={{display:"flex",gap:12,fontSize:10,color:T.textDim,fontFamily:mono}}>
                      <span>📍 {a.location||'—'}</span>
                      <span>🔢 {a.serialNumber||'—'}</span>
                    </div>
                    <div style={{marginTop:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{fontSize:10,color:T.textDim}}>
                        <span style={{marginRight:8}}>Last PM: {a.lastPM?new Date(a.lastPM).toLocaleDateString():'—'}</span>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:4}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:pmStatusColor(a.pmStatus)}}/>
                        <span style={{fontSize:9,color:pmStatusColor(a.pmStatus),fontFamily:mono,fontWeight:700}}>
                          {a.pmStatus==='overdue'?'PM OVERDUE':a.pmStatus==='due-soon'?'PM DUE SOON':'PM OK'}
                        </span>
                      </div>
                    </div>
                    {a.hoursRun>0&&<div style={{marginTop:6,fontSize:10,color:T.textMuted,fontFamily:mono}}>{a.hoursRun.toLocaleString()} hours run</div>}
                  </div>
                ))}
              </div>
            </Card>
          ))}
        </div>
      )}

      {/* ══ WORK ORDERS ══ */}
      {sub==="tasks"&&(
        <Card style={{padding:0}}>
          <div style={{overflowX:"auto",maxHeight:620,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead style={{position:"sticky",top:0,background:T.card,zIndex:1}}>
                <tr>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>ID</th>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Type</th>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Title</th>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Asset</th>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Priority</th>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Status</th>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Assignee</th>
                  <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Due</th>
                </tr>
              </thead>
              <tbody>
                {maintenance.tasks.slice(0,100).map(t=>{
                  const overdue=t.dueDate&&new Date(t.dueDate)<new Date()&&t.status!=='completed';
                  return(
                    <tr key={t.id} onClick={()=>setSelectedTask(t)} style={{borderBottom:`1px solid ${T.border}`,background:overdue?`${T.red}08`:'',cursor:'pointer',transition:'background 0.15s'}}
                      onMouseEnter={e=>e.currentTarget.style.background=overdue?`${T.red}12`:T.bg}
                      onMouseLeave={e=>e.currentTarget.style.background=overdue?`${T.red}08`:''}>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{t.id}</td>
                      <td style={{padding:"8px 12px"}}>
                        <Pill color={t.type==='pm'?T.cyan:t.type==='work-request'?T.purple:T.blue}>{t.type}</Pill>
                      </td>
                      <td style={{padding:"8px 12px",fontSize:12,color:T.text,maxWidth:200,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.title}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.amber}}>{t.asset||'—'}</td>
                      <td style={{padding:"8px 12px"}}>
                        <Pill color={priorityColor(t.priority)}>{t.priority}</Pill>
                      </td>
                      <td style={{padding:"8px 12px"}}>
                        <Pill color={t.status==='completed'?T.green:t.status==='in-progress'?T.blue:t.status==='on-hold'?T.amber:T.textMuted}>{t.status}</Pill>
                      </td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textMuted}}>{t.assignee||'—'}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:overdue?T.red:T.textDim}}>{t.dueDate?new Date(t.dueDate).toLocaleDateString():'—'}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      {/* ══ DOWNTIME ══ */}
      {sub==="downtime"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {/* No data warning */}
          {s.hasData===false&&(
            <div style={{background:`${T.amber}15`,border:`1px solid ${T.amber}40`,borderRadius:8,padding:"12px 16px",display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:20}}>⚠️</span>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:T.amber}}>No Downtime Data Available</div>
                <div style={{fontSize:11,color:T.textMuted}}>No downtime records found in Limble. Stats will populate when downtime events are logged.</div>
              </div>
            </div>
          )}
          {/* Summary stats */}
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <KPICard label="Total Downtime" value={fmtHrs(s.totalDowntimeHrs)} sub="last 30 days" accent={s.totalDowntimeHrs!=null?T.purple:T.textDim}/>
            <KPICard label="Planned" value={fmtHrs(s.plannedDowntimeHrs)} sub="scheduled maintenance" accent={s.plannedDowntimeHrs!=null?T.amber:T.textDim}/>
            <KPICard label="Unplanned" value={fmtHrs(s.unplannedDowntimeHrs)} sub="failures/issues" accent={s.unplannedDowntimeHrs!=null?T.red:T.textDim}/>
            <KPICard label="Uptime" value={s.uptimePercent!=null?`${s.uptimePercent}%`:'—'} sub="availability" accent={s.uptimePercent!=null?(s.uptimePercent>95?T.green:T.amber):T.textDim}/>
          </div>

          <Card style={{padding:0}}>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <span style={{fontSize:13,fontWeight:700,color:T.textMuted,fontFamily:mono,letterSpacing:1}}>DOWNTIME RECORDS (30 DAYS)</span>
              <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{maintenance.downtime?.length||0} records</span>
            </div>
            <div style={{overflowX:"auto",maxHeight:400,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{position:"sticky",top:0,background:T.card,zIndex:1}}>
                  <tr>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Asset</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Start</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Duration</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Type</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Reason</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenance.downtime?.slice(0,50).map(d=>(
                    <tr key={d.id} style={{borderBottom:`1px solid ${T.border}`}}>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:12,color:T.amber,fontWeight:700}}>{d.assetName}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{new Date(d.startTime).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'})}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:12,fontWeight:700,color:T.text}}>{d.durationMins?`${Math.round(d.durationMins/60*10)/10}h`:'ongoing'}</td>
                      <td style={{padding:"8px 12px"}}>
                        <Pill color={d.planned?T.amber:T.red}>{d.planned?'Planned':'Unplanned'}</Pill>
                      </td>
                      <td style={{padding:"8px 12px",fontSize:11,color:T.textMuted,maxWidth:200,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{d.reason}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* ══ SPARE PARTS ══ */}
      {sub==="parts"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div style={{display:"flex",gap:14}}>
            <KPICard label="Total Parts" value={maintenance.parts?.length||0} sub="tracked items" accent={T.blue}/>
            <KPICard label="Low Stock" value={maintenance.lowStockParts?.length||0} sub="below minimum" accent={maintenance.lowStockParts?.length>0?T.red:T.green}/>
          </div>

          <Card style={{padding:0}}>
            <div style={{overflowX:"auto",maxHeight:500,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{position:"sticky",top:0,background:T.card,zIndex:1}}>
                  <tr>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Part</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Part #</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"right",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Qty</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"right",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Min</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Location</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Vendor</th>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"right",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {maintenance.parts?.map(p=>{
                    const isSelected=selectedPart?.id===p.id;
                    return(
                    <tr key={p.id} onClick={()=>setSelectedPart(p)} style={{borderBottom:`1px solid ${T.border}`,background:isSelected?`${T.blue}15`:p.lowStock?`${T.red}08`:'',cursor:'pointer',transition:'background 0.15s'}} onMouseEnter={e=>e.currentTarget.style.background=`${T.blue}10`} onMouseLeave={e=>e.currentTarget.style.background=isSelected?`${T.blue}15`:p.lowStock?`${T.red}08`:''}>
                      <td style={{padding:"8px 12px",fontSize:12,color:T.text,fontWeight:600}}>{p.name}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{p.partNum||'—'}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:13,fontWeight:800,color:p.lowStock?T.red:T.text,textAlign:"right"}}>{p.qty}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim,textAlign:"right"}}>{p.minQty}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textMuted}}>{p.location||'—'}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textMuted}}>{p.vendor||'—'}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim,textAlign:"right"}}>{p.cost?`$${p.cost.toFixed(2)}`:'—'}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}

      {/* Work Order Detail Modal */}
      {selectedTask&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setSelectedTask(null)}>
          <div style={{background:T.surface,border:`1px solid ${T.borderLight}`,borderRadius:16,padding:0,width:600,maxWidth:"90vw",maxHeight:"85vh",overflow:"hidden"}} onClick={e=>e.stopPropagation()}>
            {/* Header */}
            <div style={{padding:"18px 24px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"flex-start",background:T.card}}>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                  <Pill color={selectedTask.type==='pm'?T.cyan:selectedTask.type==='work-request'?T.purple:T.blue}>{selectedTask.type==='pm'?'PM':selectedTask.type==='work-request'?'Work Request':'Work Order'}</Pill>
                  <Pill color={priorityColor(selectedTask.priority)}>{selectedTask.priority}</Pill>
                  <Pill color={selectedTask.status==='completed'?T.green:selectedTask.status==='in-progress'?T.blue:selectedTask.status==='on-hold'?T.amber:T.textMuted}>{selectedTask.status}</Pill>
                </div>
                <div style={{fontSize:18,fontWeight:800,color:T.text,lineHeight:1.3}}>{selectedTask.title}</div>
                <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginTop:6}}>ID: {selectedTask.id}</div>
              </div>
              <button onClick={()=>setSelectedTask(null)} style={{background:"transparent",border:"none",color:T.textDim,fontSize:24,cursor:"pointer",padding:4,marginTop:-4}}>✕</button>
            </div>

            {/* Content */}
            <div style={{padding:"20px 24px",maxHeight:"60vh",overflowY:"auto"}}>
              {/* Key Details Grid */}
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:20}}>
                <div style={{background:T.bg,padding:14,borderRadius:10,border:`1px solid ${T.border}`}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:6}}>ASSET</div>
                  <div style={{fontSize:14,fontWeight:700,color:T.amber}}>{selectedTask.asset||'Not specified'}</div>
                  {selectedTask.assetId&&<div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>ID: {selectedTask.assetId}</div>}
                </div>
                <div style={{background:T.bg,padding:14,borderRadius:10,border:`1px solid ${T.border}`}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:6}}>ASSIGNEE</div>
                  <div style={{fontSize:14,fontWeight:700,color:T.text}}>{selectedTask.assignee||'Unassigned'}</div>
                  {selectedTask.teamId&&<div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Team: {selectedTask.teamId}</div>}
                </div>
              </div>

              {/* Dates */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:20}}>
                <div>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:4}}>CREATED</div>
                  <div style={{fontSize:12,color:T.text,fontFamily:mono}}>{selectedTask.createdAt?new Date(selectedTask.createdAt).toLocaleDateString():'—'}</div>
                </div>
                <div>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:4}}>DUE DATE</div>
                  <div style={{fontSize:12,color:selectedTask.dueDate&&new Date(selectedTask.dueDate)<new Date()&&selectedTask.status!=='completed'?T.red:T.text,fontFamily:mono,fontWeight:700}}>
                    {selectedTask.dueDate?new Date(selectedTask.dueDate).toLocaleDateString():'Not set'}
                    {selectedTask.dueDate&&new Date(selectedTask.dueDate)<new Date()&&selectedTask.status!=='completed'&&<span style={{marginLeft:6,fontSize:10}}>OVERDUE</span>}
                  </div>
                </div>
                <div>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:4}}>COMPLETED</div>
                  <div style={{fontSize:12,color:selectedTask.completedAt?T.green:T.textDim,fontFamily:mono}}>{selectedTask.completedAt?new Date(selectedTask.completedAt).toLocaleDateString():'—'}</div>
                </div>
              </div>

              {/* Time Estimates */}
              {(selectedTask.estimatedHrs||selectedTask.actualHrs)&&(
                <div style={{display:"flex",gap:16,marginBottom:20}}>
                  {selectedTask.estimatedHrs&&(
                    <div style={{background:T.bg,padding:12,borderRadius:8,border:`1px solid ${T.border}`}}>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5}}>ESTIMATED</div>
                      <div style={{fontSize:18,fontWeight:800,color:T.cyan,fontFamily:mono}}>{selectedTask.estimatedHrs}h</div>
                    </div>
                  )}
                  {selectedTask.actualHrs&&(
                    <div style={{background:T.bg,padding:12,borderRadius:8,border:`1px solid ${T.border}`}}>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5}}>ACTUAL</div>
                      <div style={{fontSize:18,fontWeight:800,color:T.green,fontFamily:mono}}>{selectedTask.actualHrs}h</div>
                    </div>
                  )}
                </div>
              )}

              {/* Description */}
              {selectedTask.description&&(
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:8}}>DESCRIPTION</div>
                  <div style={{background:T.bg,padding:14,borderRadius:10,border:`1px solid ${T.border}`,fontSize:13,color:T.text,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{selectedTask.description}</div>
                </div>
              )}

              {/* Completion Notes */}
              {selectedTask.completionNotes&&(
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:8}}>COMPLETION NOTES</div>
                  <div style={{background:`${T.green}10`,padding:14,borderRadius:10,border:`1px solid ${T.green}30`,fontSize:13,color:T.text,lineHeight:1.6,whiteSpace:"pre-wrap"}}>{selectedTask.completionNotes}</div>
                </div>
              )}

              {/* Requestor Info (for work requests) */}
              {selectedTask.requestor&&(
                <div style={{marginBottom:20}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:8}}>REQUESTOR</div>
                  <div style={{background:T.bg,padding:14,borderRadius:10,border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:13,fontWeight:600,color:T.text}}>{selectedTask.requestor.name}</div>
                    {selectedTask.requestor.email&&<div style={{fontSize:11,color:T.textDim,marginTop:4}}>{selectedTask.requestor.email}</div>}
                    {selectedTask.requestor.phone&&<div style={{fontSize:11,color:T.textDim}}>{selectedTask.requestor.phone}</div>}
                  </div>
                </div>
              )}

              {/* Tags */}
              {selectedTask.customTags&&selectedTask.customTags.length>0&&(
                <div>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:8}}>TAGS</div>
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {selectedTask.customTags.map((tag,i)=>(
                      <span key={i} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:12,padding:"4px 10px",fontSize:11,color:T.textMuted}}>{tag}</span>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div style={{padding:"14px 24px",borderTop:`1px solid ${T.border}`,background:T.card,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <a href={`https://app.limblecmms.com/tasks/${selectedTask.id}`} target="_blank" rel="noopener noreferrer"
                style={{fontSize:12,color:T.blue,textDecoration:"none",display:"flex",alignItems:"center",gap:6}}>
                Open in Limble ↗
              </a>
              <button onClick={()=>setSelectedTask(null)} style={{background:T.blue,color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",fontSize:13,fontWeight:700,cursor:"pointer"}}>Close</button>
            </div>
          </div>
        </div>
      )}

      {/* Spare Part Detail Panel */}
      {selectedPart && <InventoryDetailPanel item={selectedPart} onClose={()=>setSelectedPart(null)} title="Spare Part Details" />}
    </div>
    </ProductionStageWrapper>
  );
}
