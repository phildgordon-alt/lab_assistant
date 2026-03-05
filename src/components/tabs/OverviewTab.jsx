import { useState, useEffect, useMemo, useCallback, useRef } from "react";

// ── Theme Constants ───────────────────────────────────────────
const T = {
  bg: "#080C18", surface: "#0F1629", card: "#141B2D", cardBg: "#141B2D", cardHover: "#1A2340",
  border: "#1E293B", borderLight: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textDim: "#475569", dim: "#475569",
  blue: "#3B82F6", blueGlow: "#2563EB", blueDark: "#1E3A5F",
  green: "#10B981", greenDark: "#064E3B",
  amber: "#F59E0B", amberDark: "#78350F",
  red: "#EF4444", redDark: "#7F1D1D",
  purple: "#8B5CF6", purpleDark: "#4C1D95",
  pink: "#EC4899", pinkDark: "#831843",
  cyan: "#06B6D4", cyanDark: "#164E63",
  lime: "#84CC16", limeDark: "#365314",
  orange: "#F97316", orangeDark: "#7C2D12",
};

const mono = "'JetBrains Mono','Fira Code',monospace";
const sans = "'Outfit','DM Sans',system-ui,sans-serif";

const MACHINES = ["Satis 1200", "Satis 1200-B", "Opticoat S"];

const DEPARTMENTS = {
  PICKING:    { label: "Picking",    color: "#94A3B8", icon: "📦" },
  SURFACING:  { label: "Surfacing",  color: "#3B82F6", icon: "🌀" },
  CUTTING:    { label: "Cutting",    color: "#8B5CF6", icon: "✂️" },
  COATING:    { label: "Coating",    color: "#F59E0B", icon: "🌡" },
  ASSEMBLY:   { label: "Assembly",   color: "#EC4899", icon: "🔧" },
  QC:         { label: "QC",         color: "#F97316", icon: "🔬" },
  SHIPPING:   { label: "Shipping",   color: "#10B981", icon: "📤" },
};

const COATING_STAGES = {
  QUEUE:     { label: "Queue",      color: "#64748B", desc: "Waiting for batch" },
  DIP:       { label: "Dip",        color: "#06B6D4", desc: "Chemical dip in progress" },
  SCAN_IN:   { label: "LMS Scan",   color: "#3B82F6", desc: "Scanned into coater" },
  OVEN:      { label: "Oven",       color: "#F59E0B", desc: "In oven — OD verified" },
  COATER:    { label: "Coater",     color: "#EF4444", desc: "In coater — OD verified" },
  COOL_DOWN: { label: "Cool Down",  color: "#8B5CF6", desc: "Post-coat cooling" },
  UNLOAD:    { label: "Unload",     color: "#10B981", desc: "Ready for unload" },
};

const COATING_COLORS = {
  "AR":          { color: "#3B82F6", bg: "#1E3A5F" },
  "Blue Cut":    { color: "#06B6D4", bg: "#164E63" },
  "Mirror":      { color: "#A855F7", bg: "#581C87" },
  "Transitions": { color: "#F97316", bg: "#7C2D12" },
  "Polarized":   { color: "#EC4899", bg: "#831843" },
  "Hard Coat":   { color: "#84CC16", bg: "#365314" },
};

// ── UI Primitives ────────────────────────────────────────────
const Pill = ({children,color,bg})=>(
  <span style={{fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:5,background:bg||`${color}20`,color,fontFamily:mono,textTransform:"uppercase",whiteSpace:"nowrap"}}>{children}</span>
);

const SectionHeader = ({children,right})=>(
  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
    <div style={{fontSize:13,color:T.textMuted,textTransform:"uppercase",letterSpacing:1.5,fontFamily:mono,fontWeight:600}}>{children}</div>
    {right&&<div style={{fontSize:12,color:T.textDim}}>{right}</div>}
  </div>
);

const Card = ({children,style,onClick})=>(
  <div onClick={onClick} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:16,cursor:onClick?"pointer":"default",transition:"border-color 0.2s",...style}}>{children}</div>
);

// ── Gateway helper ─────────────────────────────────────────────
const callGateway = async (settings, question, { onChunk, agent, userId = 'web-user', context } = {}) => {
  const gatewayUrl = settings?.gatewayUrl || 'http://localhost:3001';
  const res = await fetch(`${gatewayUrl}/web/ask-sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, agent, userId, context }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `Gateway error ${res.status}`);
  }
  return await res.json();
};

// ── KPI Metrics Registry ──────────────────────────────────────
const KPI_METRICS = {
  incoming_jobs:     { label: "Incoming Jobs",    desc: "Yesterday's incoming work",      accent: T.blue,   category: "Production" },
  total_wip:         { label: "Total WIP",        desc: "Jobs in all queues",            accent: T.cyan,   category: "Production" },
  shipped_jobs:      { label: "Shipped Jobs",     desc: "Jobs shipped today",            accent: T.green,  category: "Production" },
  coating_wip:       { label: "Coating WIP",      desc: "Jobs in coating",               accent: T.amber,  category: "Department" },
  cutting_wip:       { label: "Cutting WIP",      desc: "Jobs in cutting/edging",        accent: T.purple, category: "Department" },
  assembly_wip:      { label: "Assembly WIP",     desc: "Jobs in assembly",              accent: T.pink,   category: "Department" },
  surfacing_wip:     { label: "Surfacing WIP",    desc: "Jobs in surfacing",             accent: T.orange, category: "Department" },
  qc_wip:            { label: "QC WIP",           desc: "Jobs in QC",                    accent: T.cyan,   category: "Department" },
  breakage:          { label: "Breakage",         desc: "Broken jobs today",             accent: T.red,    category: "Quality" },
  rush_jobs:         { label: "Rush Jobs",        desc: "Rush priority in system",       accent: T.red,    category: "Production" },
  qc_holds:          { label: "QC Holds",         desc: "Jobs held for inspection",      accent: T.orange, category: "Quality" },
  active_trays:      { label: "Active Trays",     desc: "Trays in production",           accent: T.blue,   category: "Fleet" },
  avg_batch_fill:    { label: "Avg Batch Fill",   desc: "Coating batch fill rate",       accent: T.purple, category: "Efficiency" },
  pm_compliance:     { label: "PM Compliance",    desc: "Preventive maintenance rate",   accent: T.green,  category: "Maintenance" },
  open_work_orders:  { label: "Open WOs",         desc: "Open maintenance work orders",  accent: T.amber,  category: "Maintenance" },
  equipment_uptime:  { label: "Equipment Uptime", desc: "Overall equipment availability",accent: T.green,  category: "Maintenance" },
};

const DEFAULT_KPIS = ['incoming_jobs', 'total_wip', 'shipped_jobs', 'coating_wip', 'cutting_wip', 'assembly_wip', 'breakage'];

const KPI_AGENTS = {
  incoming_jobs: 'ShiftReportAgent',
  total_wip: 'ShiftReportAgent',
  shipped_jobs: 'ShiftReportAgent',
  coating_wip: 'CoatingAgent',
  cutting_wip: 'CuttingAgent',
  assembly_wip: 'AssemblyAgent',
  surfacing_wip: 'SurfacingAgent',
  qc_wip: 'QCAgent',
  breakage: 'QCAgent',
  rush_jobs: 'ShiftReportAgent',
  qc_holds: 'QCAgent',
  active_trays: 'ShiftReportAgent',
  avg_batch_fill: 'CoatingAgent',
  pm_compliance: 'MaintenanceAgent',
  open_work_orders: 'MaintenanceAgent',
  equipment_uptime: 'MaintenanceAgent',
};

// ── Card Registry ─────────────────────────────────────────────
const CARD_REGISTRY = [
  { type:"kpi_row",         label:"KPI Row",              icon:"📊", desc:"Key metrics — active trays, rush jobs, coating WIP, batch fill, QC holds" },
  { type:"slack_feed",      label:"Slack Messages",        icon:"💬", desc:"Live Slack channel feed with outgoing message compose and QR code" },
  { type:"coating_machines",label:"Coating Machines",      icon:"🌡", desc:"Status of all three coating machines with batch controls" },
  { type:"putwall_grid",    label:"Put Wall + Event Log",  icon:"⬡",  desc:"Quick Bind slot grid and live event feed side by side" },
  { type:"fleet_dept",      label:"Fleet by Department",   icon:"◈",  desc:"All trays visualized by department with coating type legend" },
  { type:"rush_queue",      label:"Rush Queue",            icon:"🔴", desc:"All active rush jobs with location and time in system" },
  { type:"aging_alert",     label:"WIP Aging Alert",       icon:"⏱", desc:"Jobs in system longer than threshold — configurable hours" },
  { type:"inventory",       label:"Lens Blank Inventory",  icon:"📦", desc:"Lens blank stock levels from Kardex / ItemPath (live when connected)" },
  { type:"ai_query",        label:"AI Quick Query",        icon:"🤖", desc:"Single-question AI widget — ask anything about current lab state" },
  { type:"custom_metric",   label:"Custom Metric",         icon:"✦",  desc:"Point at any server endpoint and display the returned value" },
  { type:"surfacing_summary", label:"Surfacing Summary", icon:"🌀", desc:"Surfacing queue status — jobs in queue, in progress, rush count, throughput" },
  { type:"cutting_summary",   label:"Cutting Summary",   icon:"✂️", desc:"Cutting stage status — queue, breakage rate, edge quality metrics" },
  { type:"assembly_summary",  label:"Assembly Summary",  icon:"🔧", desc:"Assembly station status — station queues, operator metrics, QC returns" },
  { type:"shipping_summary",  label:"Shipping Summary",  icon:"📤", desc:"Shipping status — ready to ship, overdue, due today counts" },
  { type:"maintenance_summary", label:"Maintenance Summary", icon:"🔩", desc:"Maintenance status — open work orders, PM compliance, equipment health, critical tasks" },
];

const DEFAULT_CARDS = [
  { id:"c1", type:"kpi_row",          title:"KPI Row",             config:{} },
  { id:"c2", type:"slack_feed",       title:"Slack Messages",      config:{} },
  { id:"c3", type:"coating_machines", title:"Coating Machines",    config:{} },
  { id:"c4", type:"putwall_grid",     title:"Put Wall & Events",   config:{} },
  { id:"c5", type:"fleet_dept",       title:"Fleet by Department", config:{} },
];

function genId(){ return "c"+(Date.now().toString(36)+Math.random().toString(36).slice(2,6)); }

// ── Live Elapsed Timer Hook ───────────────────────────────────
function useElapsed(startedAt, running) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!running || !startedAt) return;
    const iv = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(iv);
  }, [running, startedAt]);
  if (!running || !startedAt) return null;
  const secs = Math.floor((now - startedAt) / 1000);
  const h = Math.floor(secs / 3600), m = Math.floor((secs % 3600) / 60), s = secs % 60;
  return h > 0
    ? `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`
    : `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// ── Slack Integration Hook ─────────────────────────────────────
function useSlackConfig(onIncoming, setMessages){
  const KEY="la_slack_v2";
  const DEFAULTS={
    proxyUrl:"http://localhost:3001/api/slack/messages?channel=C0AJH9LG96D",
    channel:"lab-assistant",
    channelId:"C0AJH9LG96D"
  };
  const [cfg,setCfgRaw]=useState(()=>{try{const stored=JSON.parse(localStorage.getItem(KEY)||"{}");return {...DEFAULTS,...stored};}catch{return DEFAULTS;}});
  const [status,setStatus]=useState(null);
  const [proxyConnected,setProxyConnected]=useState(false);
  const lastTs=useRef(null);
  const initialLoad=useRef(false);
  const save=(next)=>{setCfgRaw(next);try{localStorage.setItem(KEY,JSON.stringify(next));}catch{}};

  const post=useCallback(async(text)=>{
    setStatus("sending");
    try{
      const sendUrl=cfg.proxyUrl?.replace('/messages','/send').split('?')[0] || 'http://localhost:3001/api/slack/send';
      const r=await fetch(sendUrl,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          channel:cfg.channelId||"C0AJH9LG96D",
          text:`🏭 *Lab_Assistant* › ${cfg.channel||"lab-assistant"}\n${text}`
        })
      });
      const data=await r.json().catch(()=>({}));
      const ok=r.ok && data.ok;
      setStatus(ok?"ok":"err");
      setTimeout(()=>setStatus(null),3000);
      return ok;
    }catch{setStatus("err");setTimeout(()=>setStatus(null),3000);return false;}
  },[cfg]);

  useEffect(()=>{
    if(!cfg.proxyUrl)return;
    const poll=async()=>{
      try{
        const url=cfg.proxyUrl.includes('?')?cfg.proxyUrl:`${cfg.proxyUrl}?channel=${cfg.channelId||""}`;
        const r=await fetch(url);
        if(!r.ok){setProxyConnected(false);return;}
        setProxyConnected(true);
        const data=await r.json();
        const allMsgs=(data.messages||[]).filter(m=>
          m.type==="message" &&
          m.text &&
          !m.bot_id &&
          !m.text.match(/^(?:\/ai|@ai|ai:|\/lab)\b/i) &&
          !m.text.match(/<@U[A-Z0-9]+>/i)
        );

        if(!initialLoad.current && allMsgs.length>0 && setMessages){
          initialLoad.current=true;
          const slackMsgs=allMsgs.slice(0,20).map(m=>({
            id:`slack-${m.ts}`,
            from:m.bot_profile?.name||m.username||m.user||"Slack",
            text:m.text.replace(/<[^>]*>/g,'').slice(0,200),
            time:new Date(parseFloat(m.ts)*1000),
            priority:m.text.toLowerCase().includes("rush")||m.text.toLowerCase().includes("hot")||m.text.toLowerCase().includes("critical")?"high":"normal",
            source:"slack",
            isBot:!!m.bot_id,
          }));
          setMessages(slackMsgs);
          lastTs.current=allMsgs[0].ts;
          return;
        }

        const humanMsgs=allMsgs.filter(m=>!m.bot_id);
        if(lastTs.current && humanMsgs.length>0){
          const newMsgs=humanMsgs.filter(m=>parseFloat(m.ts)>parseFloat(lastTs.current));
          if(newMsgs.length>0){
            lastTs.current=humanMsgs[0].ts;
            newMsgs.reverse().forEach(m=>{
              onIncoming({
                id:`slack-${m.ts}`,
                from:m.username||m.user||"Slack",
                text:m.text,
                time:new Date(parseFloat(m.ts)*1000),
                priority:m.text.toLowerCase().includes("rush")||m.text.toLowerCase().includes("hot")?"high":"normal",
                source:"slack",
              });
            });
          }
        }
        if(!lastTs.current && allMsgs.length>0) lastTs.current=allMsgs[0].ts;
      }catch(e){setProxyConnected(false);}
    };
    poll();
    const iv=setInterval(poll,12000);
    return()=>clearInterval(iv);
  },[cfg.proxyUrl,cfg.channelId,onIncoming,setMessages]);

  return{cfg,save,post,status,proxyConnected};
}

// ── KPI Card ──────────────────────────────────────────────────
const KPICard = ({label,value,sub,trend,accent,onRemove,editable,onClick,clickable})=>(
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

// ── Configurable KPI Row ──────────────────────────────────────
function ConfigurableKPIRow({data, settings, cardConfig, onConfigChange}){
  const [editing,setEditing]=useState(false);
  const [selectedKpis,setSelectedKpis]=useState(cardConfig?.kpis || DEFAULT_KPIS);
  const [modalKpi,setModalKpi]=useState(null);
  const [modalSearch,setModalSearch]=useState('');
  const [selectedJob,setSelectedJob]=useState(null);
  const [aiQuery,setAiQuery]=useState('');
  const [aiResponse,setAiResponse]=useState('');
  const [aiLoading,setAiLoading]=useState(false);

  const getJobsForKPI=(kpiId)=>{
    const {trays=[],batches=[],dviJobs=[],breakage=[],wipJobs=[]}=data||{};
    const jobs=dviJobs;
    const byStage=(stage)=>jobs.filter(j=>(j.stage||j.Stage||j.station||j.department||'').toLowerCase().includes(stage.toLowerCase()));

    switch(kpiId){
      case 'incoming_jobs': return jobs.filter(j=>{
        const station=(j.station||'').toUpperCase();
        if(j.daysInLab!==undefined) return j.daysInLab<=1;
        return station.includes('INITIATE')||station.includes('NEW WORK')||station.includes('RECEIVED');
      });
      case 'total_wip': return jobs.filter(j=>j.status!=='Completed'&&j.status!=='SHIPPED');
      case 'shipped_jobs': return jobs.filter(j=>(j.status==='SHIPPED'||j.stage==='SHIP'));
      case 'coating_wip':
        return jobs.filter(j=>j.inCoatingQueue||byStage('COAT').includes(j)||byStage('CCL').includes(j)||byStage('CCP').includes(j));
      case 'cutting_wip': return byStage('CUT').concat(byStage('EDGER')).concat(byStage('LCU'));
      case 'assembly_wip': return byStage('ASSEMBL');
      case 'surfacing_wip': return byStage('SURF').concat(byStage('GENERATOR'));
      case 'qc_wip': return byStage('QC');
      case 'breakage':
        return jobs.filter(j=>j.hasBreakage||(j.station||'').toUpperCase().includes('BREAKAGE'));
      case 'rush_jobs': return jobs.filter(j=>j.rush==='Y'||j.Rush==='Y'||j.priority==='RUSH');
      case 'qc_holds': return jobs.filter(j=>(j.station||'').toUpperCase().includes('QC_HOLD')||(j.status||'').includes('HOLD'));
      default: return [];
    }
  };

  const getKPIValue=(kpiId)=>{
    const {trays=[],batches=[],dviJobs=[],breakage=[],maintenance={},shippedStats={}}=data||{};
    const dviByStage=(stage)=>dviJobs.filter(j=>(j.stage||j.Stage||'').toLowerCase().includes(stage.toLowerCase())).length;

    switch(kpiId){
      case 'incoming_jobs': return {value:dviJobs.filter(j=>{const s=(j.station||'').toUpperCase();return s.includes('INITIATE')||s.includes('NEW WORK')||s.includes('INCOMING');}).length,sub:"incoming"};
      case 'total_wip': return {value:dviJobs.filter(j=>j.status!=='Completed'&&j.status!=='SHIPPED').length,sub:"in queues"};
      case 'shipped_jobs': return {value:shippedStats.today||0,sub:"today"};
      case 'coating_wip': return {value:dviByStage('COAT')+dviJobs.filter(j=>(j.station||'').includes('CCL')||(j.station||'').includes('CCP')).length,sub:"in coating"};
      case 'cutting_wip': return {value:dviByStage('CUT')+dviJobs.filter(j=>(j.station||'').includes('EDGER')||(j.station||'').includes('LCU')).length,sub:"in cutting"};
      case 'assembly_wip': return {value:dviByStage('ASSEMBL'),sub:"in assembly"};
      case 'surfacing_wip': return {value:dviByStage('SURF')+dviJobs.filter(j=>(j.station||'').includes('GENERATOR')).length,sub:"in surfacing"};
      case 'qc_wip': return {value:dviByStage('QC'),sub:"in QC"};
      case 'breakage': return {value:dviJobs.filter(j=>(j.station||'').toUpperCase().includes('BREAKAGE')).length,sub:"today",accent:T.red};
      case 'rush_jobs': return {value:dviJobs.filter(j=>j.rush==='Y'||j.Rush==='Y'||j.priority==='RUSH').length,sub:"in system"};
      case 'qc_holds': return {value:trays.filter(t=>t.state==='QC_HOLD').length,sub:"held"};
      case 'active_trays': return {value:trays.filter(t=>t.state!=='IDLE').length,sub:`of ${trays.length}`};
      case 'avg_batch_fill': return {value:`${batches.length>0?Math.round(batches.reduce((s,b)=>s+(b.jobs||0),0)/batches.length/1.4):0}%`,sub:"of capacity"};
      case 'pm_compliance': return {value:maintenance.stats?.pmCompliancePercent!=null?`${maintenance.stats.pmCompliancePercent}%`:'—',sub:"on schedule"};
      case 'open_work_orders': return {value:maintenance.stats?.openWorkOrders||0,sub:"open"};
      case 'equipment_uptime': return {value:maintenance.stats?.uptimePercent!=null?`${maintenance.stats.uptimePercent}%`:'—',sub:"availability"};
      default: return {value:'—',sub:''};
    }
  };

  const askAgent=async()=>{
    if(!aiQuery.trim()||!modalKpi)return;
    setAiLoading(true);
    setAiResponse('');
    try{
      const agent=KPI_AGENTS[modalKpi]||'ShiftReportAgent';
      const jobs=getJobsForKPI(modalKpi);
      const context=`KPI: ${KPI_METRICS[modalKpi]?.label}\nJobs count: ${jobs.length}\nSample jobs: ${JSON.stringify(jobs.slice(0,10))}`;
      const res=await fetch('http://localhost:3001/web/ask-sync',{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({question:aiQuery,agent,userId:'kpi-modal',context})
      });
      const resData=await res.json();
      setAiResponse(resData.response||resData.error||'No response');
    }catch(err){
      setAiResponse('Error: '+err.message);
    }finally{
      setAiLoading(false);
    }
  };

  const addKPI=(kpiId)=>{
    if(!selectedKpis.includes(kpiId)){
      const newKpis=[...selectedKpis,kpiId];
      setSelectedKpis(newKpis);
      onConfigChange?.({...cardConfig,kpis:newKpis});
    }
  };

  const removeKPI=(kpiId)=>{
    const newKpis=selectedKpis.filter(k=>k!==kpiId);
    setSelectedKpis(newKpis);
    onConfigChange?.({...cardConfig,kpis:newKpis});
  };

  const availableKpis=Object.keys(KPI_METRICS).filter(k=>!selectedKpis.includes(k));
  const categories=[...new Set(Object.values(KPI_METRICS).map(m=>m.category))];

  const modalJobs=useMemo(()=>{
    if(!modalKpi)return[];
    const jobs=getJobsForKPI(modalKpi);
    if(!modalSearch)return jobs;
    const q=modalSearch.toLowerCase();
    return jobs.filter(j=>
      (j.job_id||'').toLowerCase().includes(q)||
      (j.station||'').toLowerCase().includes(q)||
      (j.invoice||'').toLowerCase().includes(q)||
      (j.date||'').toLowerCase().includes(q)
    );
  },[modalKpi,modalSearch,data]);

  return(
    <div>
      <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
        {selectedKpis.map(kpiId=>{
          const metric=KPI_METRICS[kpiId];
          if(!metric)return null;
          const val=getKPIValue(kpiId);
          const hasJobs=['incoming_jobs','total_wip','shipped_jobs','coating_wip','cutting_wip','assembly_wip','surfacing_wip','qc_wip','breakage','rush_jobs'].includes(kpiId);
          return(
            <KPICard
              key={kpiId}
              label={metric.label}
              value={val.value}
              sub={val.sub}
              trend={val.trend}
              accent={val.accent||metric.accent}
              editable={editing}
              onRemove={()=>removeKPI(kpiId)}
              clickable={hasJobs&&!editing}
              onClick={()=>{setModalKpi(kpiId);setModalSearch('');setAiQuery('');setAiResponse('');}}
            />
          );
        })}
        {editing&&(
          <div onClick={()=>{}} style={{background:`${T.blue}10`,border:`2px dashed ${T.blue}40`,borderRadius:12,padding:"18px 22px",flex:"0 0 160px",minWidth:160,display:'flex',alignItems:'center',justifyContent:'center',cursor:'pointer'}}>
            <span style={{color:T.blue,fontSize:24}}>+</span>
          </div>
        )}
      </div>

      <div style={{marginTop:12,display:'flex',justifyContent:'flex-end',gap:8}}>
        {!editing?(
          <button onClick={()=>setEditing(true)} style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:6,padding:'6px 14px',color:T.textMuted,fontSize:11,cursor:'pointer',display:'flex',alignItems:'center',gap:4}}>
            <span style={{fontSize:12}}>⚙</span> Customize KPIs
          </button>
        ):(
          <button onClick={()=>setEditing(false)} style={{background:T.green,border:'none',borderRadius:6,padding:'6px 14px',color:'#fff',fontSize:11,fontWeight:600,cursor:'pointer'}}>
            Done
          </button>
        )}
      </div>

      {editing&&availableKpis.length>0&&(
        <div style={{marginTop:12,background:T.surface,borderRadius:10,padding:14,border:`1px solid ${T.border}`}}>
          <div style={{fontSize:11,color:T.textMuted,marginBottom:10,fontWeight:600}}>ADD KPI METRIC</div>
          {categories.map(cat=>{
            const catKpis=availableKpis.filter(k=>KPI_METRICS[k].category===cat);
            if(catKpis.length===0)return null;
            return(
              <div key={cat} style={{marginBottom:10}}>
                <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:6}}>{cat.toUpperCase()}</div>
                <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                  {catKpis.map(kpiId=>(
                    <button key={kpiId} onClick={()=>addKPI(kpiId)}
                      style={{background:T.card,border:`1px solid ${KPI_METRICS[kpiId].accent}40`,borderRadius:6,padding:'6px 12px',color:T.text,fontSize:11,cursor:'pointer',display:'flex',alignItems:'center',gap:6}}>
                      <span style={{width:8,height:8,borderRadius:2,background:KPI_METRICS[kpiId].accent}}></span>
                      {KPI_METRICS[kpiId].label}
                    </button>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {modalKpi&&(
        <div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.8)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={()=>setModalKpi(null)}>
          <div style={{background:T.surface,borderRadius:16,width:'100%',maxWidth:1200,maxHeight:'90vh',display:'flex',overflow:'hidden',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            <div style={{flex:2,display:'flex',flexDirection:'column',borderRight:`1px solid ${T.border}`}}>
              <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',gap:12}}>
                <div style={{width:12,height:12,borderRadius:3,background:KPI_METRICS[modalKpi]?.accent||T.blue}}></div>
                <div>
                  <h3 style={{margin:0,fontSize:18,fontWeight:700,color:T.text}}>{KPI_METRICS[modalKpi]?.label}</h3>
                  <p style={{margin:0,fontSize:12,color:T.textMuted}}>{modalJobs.length} jobs</p>
                </div>
                <button onClick={()=>setModalKpi(null)} style={{marginLeft:'auto',background:'transparent',border:'none',color:T.textDim,fontSize:20,cursor:'pointer',padding:4}}>×</button>
              </div>
              <div style={{padding:'12px 20px',borderBottom:`1px solid ${T.border}`}}>
                <input type="text" placeholder="Search jobs..." value={modalSearch} onChange={e=>setModalSearch(e.target.value)}
                  style={{width:'100%',padding:'10px 14px',background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}/>
              </div>
              <div style={{flex:1,overflowY:'auto',padding:0}}>
                {modalJobs.length>0?(
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead style={{position:'sticky',top:0,background:T.surface}}>
                      <tr>
                        <th style={{padding:'10px 20px',textAlign:'left',fontSize:10,color:T.textDim,fontFamily:mono,borderBottom:`1px solid ${T.border}`}}>JOB ID</th>
                        <th style={{padding:'10px 12px',textAlign:'left',fontSize:10,color:T.textDim,fontFamily:mono,borderBottom:`1px solid ${T.border}`}}>STATION</th>
                        <th style={{padding:'10px 12px',textAlign:'left',fontSize:10,color:T.textDim,fontFamily:mono,borderBottom:`1px solid ${T.border}`}}>STATUS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalJobs.slice(0,100).map((j,i)=>(
                        <tr key={j.job_id||i} onClick={()=>setSelectedJob(j)} style={{borderBottom:`1px solid ${T.border}22`,cursor:'pointer',background:selectedJob?.job_id===j.job_id?`${KPI_METRICS[modalKpi]?.accent||T.blue}15`:'transparent'}}>
                          <td style={{padding:'10px 20px',fontFamily:mono,fontSize:12,fontWeight:600,color:T.text}}>{j.job_id||j.invoice||'—'}</td>
                          <td style={{padding:'10px 12px',fontFamily:mono,fontSize:11,color:T.textMuted}}>{j.station||j.stage||'—'}</td>
                          <td style={{padding:'10px 12px'}}><Pill color={j.status==='SHIPPED'?T.green:T.blue}>{j.status||'WIP'}</Pill></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                ):(
                  <div style={{padding:40,textAlign:'center',color:T.textDim}}>No jobs found</div>
                )}
              </div>
            </div>
            <div style={{flex:1,minWidth:360,display:'flex',flexDirection:'column',background:T.bg}}>
              {selectedJob ? (
                <>
                  <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                    <div>
                      <div style={{fontSize:16,fontWeight:700,color:T.text,fontFamily:mono}}>{selectedJob.job_id||selectedJob.invoice||'Job Details'}</div>
                      <div style={{fontSize:11,color:T.textMuted}}>{selectedJob.station||selectedJob.stage||'—'}</div>
                    </div>
                    <button onClick={()=>setSelectedJob(null)} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:'6px 12px',fontSize:11,color:T.text,cursor:'pointer'}}>← Back</button>
                  </div>
                  <div style={{flex:1,padding:16,overflowY:'auto'}}>
                    <div style={{display:'grid',gap:12}}>
                      {Object.entries(selectedJob).filter(([k,v])=>v&&k!=='rawXml'&&typeof v!=='object').map(([key,value])=>(
                        <div key={key} style={{background:T.card,borderRadius:8,padding:'10px 14px'}}>
                          <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:4}}>{key.toUpperCase().replace(/_/g,' ')}</div>
                          <div style={{fontSize:13,color:T.text,fontFamily:mono,wordBreak:'break-all'}}>{String(value)}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              ) : (
                <>
                  <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:18}}>🤖</span>
                      <div>
                        <div style={{fontSize:13,fontWeight:700,color:T.text}}>{KPI_AGENTS[modalKpi]||'ShiftReportAgent'}</div>
                        <div style={{fontSize:10,color:T.textMuted}}>AI Assistant for {KPI_METRICS[modalKpi]?.label}</div>
                      </div>
                    </div>
                  </div>
                  <div style={{flex:1,padding:16,overflowY:'auto'}}>
                    {aiResponse?(
                      <div style={{background:T.card,borderRadius:8,padding:14}}>
                        <div style={{fontSize:10,color:T.textDim,marginBottom:8,fontFamily:mono}}>AI RESPONSE</div>
                        <div style={{fontSize:13,color:T.text,lineHeight:1.5,whiteSpace:'pre-wrap'}}>{aiResponse}</div>
                      </div>
                    ):aiLoading?(
                      <div style={{textAlign:'center',color:T.textMuted,padding:20}}>Thinking...</div>
                    ):(
                      <div style={{textAlign:'center',color:T.textDim,padding:20,fontSize:12}}>Click a job to see details</div>
                    )}
                  </div>
                  <div style={{padding:16,borderTop:`1px solid ${T.border}`}}>
                    <div style={{display:'flex',gap:8}}>
                      <input type="text" placeholder="Ask the AI agent..." value={aiQuery} onChange={e=>setAiQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Enter')askAgent();}}
                        style={{flex:1,padding:'10px 14px',background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:12}}/>
                      <button onClick={askAgent} disabled={aiLoading||!aiQuery.trim()}
                        style={{padding:'10px 16px',background:aiLoading||!aiQuery.trim()?T.border:T.blue,border:'none',borderRadius:8,color:'#fff',fontSize:12,fontWeight:600,cursor:aiLoading?'wait':'pointer'}}>Ask</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Event Log ────────────────────────────────────────────────
function EventLog({events}){
  return(
    <Card style={{maxHeight:380,overflowY:"auto"}}>
      <SectionHeader>Live Event Feed</SectionHeader>
      {events.map((e,i)=>(
        <div key={e.id} style={{display:"flex",gap:10,padding:"6px 0",borderBottom:i<events.length-1?`1px solid ${T.border}`:"none",opacity:Math.max(0.3,1-i*0.04)}}>
          <span style={{fontSize:15,flexShrink:0}}>{e.icon}</span>
          <div style={{flex:1,fontSize:12,color:"#CBD5E1",lineHeight:1.4}}>{e.message}</div>
          <span style={{fontSize:10,color:T.textDim,flexShrink:0,fontFamily:mono}}>{e.time.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
        </div>
      ))}
    </Card>
  );
}

// ── Run Timer ────────────────────────────────────────────────
function RunTimer({startedAt, running, eta}){
  const elapsed = useElapsed(startedAt, running);
  const [now, setNow] = useState(Date.now());
  useEffect(()=>{
    if(!running) return;
    const iv = setInterval(()=>setNow(Date.now()),1000);
    return ()=>clearInterval(iv);
  },[running]);
  const etaMin = eta ? Math.max(0,Math.floor((eta-now)/60000)) : null;
  const etaSecs = eta ? Math.max(0,Math.floor((eta-now)%60000/1000)) : null;
  if(!running || !startedAt) return null;
  return(
    <div style={{display:"flex",gap:14,padding:"10px 14px",background:"#0B1A0E",border:`1px solid ${T.green}40`,borderRadius:8,marginTop:8,alignItems:"center"}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:8,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:1}}>ELAPSED</div>
        <div style={{fontSize:22,fontWeight:800,color:T.green,fontFamily:mono,letterSpacing:2}}>{elapsed||"00:00"}</div>
      </div>
      <div style={{width:1,height:32,background:T.border}}/>
      {etaMin!==null&&(
        <div style={{textAlign:"center"}}>
          <div style={{fontSize:8,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:1}}>ETA</div>
          <div style={{fontSize:22,fontWeight:800,color:etaMin<10?T.amber:T.textMuted,fontFamily:mono,letterSpacing:2}}>
            {String(etaMin).padStart(2,"0")}:{String(etaSecs).padStart(2,"0")}
          </div>
        </div>
      )}
      <div style={{flex:1}}>
        <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginBottom:4}}>PROGRESS</div>
        <div style={{height:3,background:T.bg,borderRadius:2,overflow:"hidden"}}>
          {eta&&startedAt&&<div style={{height:"100%",background:T.green,borderRadius:2,width:`${Math.min(100,((now-startedAt)/(eta-startedAt))*100)}%`,transition:"width 1s linear"}}/>}
        </div>
      </div>
      <div style={{width:8,height:8,borderRadius:"50%",background:T.green,boxShadow:`0 0 8px ${T.green}`,animation:"pulse 1s infinite"}}/>
    </div>
  );
}

// ── Oven Timer ────────────────────────────────────────────────
function OvenTimer({tray}){
  const elapsed = useElapsed(tray.stageEnteredAt, !!tray.stageEnteredAt);
  if(!tray.stageEnteredAt || !["OVEN","COATER"].includes(tray.coatingStage)) return null;
  const isOven = tray.coatingStage === "OVEN";
  const color = isOven ? T.amber : T.red;
  const targetMins = isOven ? 25 : 45;
  const elapsedMins = tray.stageEnteredAt ? Math.floor((Date.now()-tray.stageEnteredAt)/60000) : 0;
  const pct = Math.min(100,(elapsedMins/targetMins)*100);
  const overdue = elapsedMins > targetMins;
  return(
    <div style={{display:"flex",alignItems:"center",gap:6,padding:"3px 7px",background:`${color}12`,border:`1px solid ${color}30`,borderRadius:5,flex:1}}>
      <span style={{fontSize:9,color:color,fontFamily:mono,fontWeight:700}}>{isOven?"🌡 OVEN":"⚡ COATER"}</span>
      <div style={{flex:1,height:3,background:T.bg,borderRadius:2,overflow:"hidden"}}>
        <div style={{height:"100%",width:`${pct}%`,background:overdue?T.red:color,borderRadius:2}}/>
      </div>
      <span style={{fontSize:10,fontWeight:800,color:overdue?T.red:color,fontFamily:mono,minWidth:38}}>{elapsed||"00:00"}</span>
      {overdue&&<span style={{fontSize:8,color:T.red,fontFamily:mono,fontWeight:800}}>OVER</span>}
    </div>
  );
}

// ── Batch Card ────────────────────────────────────────────────
function BatchCard({batch,trays,expanded,onToggle,onControl,machineDisplayName}){
  const displayName = machineDisplayName || batch.machine;
  const pct=batch.capacity>0?(batch.loaded/batch.capacity)*100:0;
  const stateColor={idle:T.textDim,loading:T.blue,running:T.green,complete:T.lime,waiting:T.amber,hold:T.red};
  const sc=stateColor[batch.status]||T.textDim;
  const ctrlState=batch.controlState||"idle";
  const isRunning=batch.status==="running"&&!!batch.startedAt;

  const stageCounts={};
  Object.keys(COATING_STAGES).forEach(s=>{stageCounts[s]=(batch.stageLoads&&batch.stageLoads[s])||0;});

  const batchJobs=trays?trays.filter(t=>t.batchId===batch.id&&t.department==="COATING"):[];
  const waitingJobs=trays?trays.filter(t=>t.department==="COATING"&&t.coatingStage==="QUEUE"&&t.coatingType===batch.coatingType&&t.batchId!==batch.id):[];
  const ovenJobs=batchJobs.filter(t=>["OVEN","COATER"].includes(t.coatingStage));

  return(
    <Card onClick={onToggle} style={{flex:"1 1 300px",cursor:"pointer",borderLeft:`4px solid ${sc}`,
      boxShadow:expanded?`0 0 20px ${sc}20`:isRunning?`0 0 8px ${T.green}15`:"none",
      border:expanded?`1px solid ${sc}`:`1px solid ${T.border}`}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          {isRunning&&<div style={{width:8,height:8,borderRadius:"50%",background:T.green,boxShadow:`0 0 8px ${T.green}`,animation:"pulse 1.5s infinite"}}/>}
          <span style={{fontSize:14,fontWeight:800,color:T.text,fontFamily:mono}}>{displayName}</span>
          <span style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>{batch.id}</span>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <Pill color={sc}>{batch.status}</Pill>
          <span style={{fontSize:12,color:T.textDim,transform:expanded?"rotate(180deg)":"rotate(0)",transition:"transform 0.2s"}}>▼</span>
        </div>
      </div>
      {batch.coatingType&&<div style={{fontSize:11,color:T.textMuted,marginTop:4}}>Coating: <strong style={{color:T.text}}>{batch.coatingType}</strong></div>}

      {isRunning&&!expanded&&<RunTimer startedAt={batch.startedAt} running={isRunning} eta={batch.eta}/>}

      <div style={{marginTop:8}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,marginBottom:3,fontFamily:mono}}>
          <span>{batch.loaded}/{batch.capacity} lenses</span><span>{Math.round(pct)}%</span>
        </div>
        <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${pct}%`,background:sc,borderRadius:3,transition:"width 0.6s"}}/>
        </div>
      </div>

      <div style={{marginTop:10,display:"flex",gap:3,overflowX:"auto"}}>
        {Object.entries(COATING_STAGES).map(([key,stage])=>{
          const cnt=stageCounts[key]||0;
          const isActive=cnt>0;
          const isHot=["OVEN","COATER"].includes(key)&&cnt>0;
          return(
            <div key={key} style={{flex:"1 1 0",minWidth:36,textAlign:"center",padding:"4px 2px",borderRadius:4,
              background:isActive?`${stage.color}18`:T.bg,
              border:`1px solid ${isActive?stage.color:T.border}`,
              boxShadow:isHot?`0 0 6px ${stage.color}40`:"none",
              transition:"all 0.3s"}}>
              <div style={{fontSize:11,fontWeight:700,color:isActive?stage.color:T.textDim,fontFamily:mono}}>{cnt}</div>
              <div style={{fontSize:8,color:isActive?stage.color:T.textDim,fontFamily:mono,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{stage.label}</div>
            </div>
          );
        })}
      </div>

      {ovenJobs.length>0&&!expanded&&(
        <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:3}}>
          {ovenJobs.slice(0,3).map(t=><OvenTimer key={t.id} tray={t}/>)}
          {ovenJobs.length>3&&<div style={{fontSize:9,color:T.textDim,fontFamily:mono,paddingLeft:4}}>+{ovenJobs.length-3} more in heat</div>}
        </div>
      )}

      {expanded&&(
        <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
          <RunTimer startedAt={batch.startedAt} running={isRunning} eta={batch.eta}/>
          <div style={{marginBottom:14,marginTop:isRunning?12:0}}>
            <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,marginBottom:8,letterSpacing:1}}>BATCH CONTROL</div>
            <div style={{display:"flex",gap:6}}>
              {[
                {key:"running",label:"▶ RUN",  color:T.green, bg:T.greenDark},
                {key:"hold",   label:"⏸ HOLD", color:T.red,   bg:T.redDark},
                {key:"waiting",label:"⏳ WAIT", color:T.amber, bg:T.amberDark},
              ].map(btn=>(
                <button key={btn.key} onClick={()=>onControl(batch.id,btn.key)}
                  style={{flex:1,padding:"10px 6px",borderRadius:7,fontWeight:800,fontSize:11,fontFamily:mono,cursor:"pointer",transition:"all 0.15s",
                    background:ctrlState===btn.key?btn.bg:"transparent",
                    border:`2px solid ${ctrlState===btn.key?btn.color:T.border}`,
                    color:ctrlState===btn.key?btn.color:T.textDim,
                    boxShadow:ctrlState===btn.key?`0 0 12px ${btn.color}30`:"none",
                  }}>{btn.label}</button>
              ))}
            </div>
          </div>
          {batchJobs.length>0&&(
            <div style={{marginBottom:10}}>
              <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,marginBottom:6,display:"flex",justifyContent:"space-between"}}>
                <span>ALL JOBS IN BATCH</span><span style={{color:T.text,fontWeight:700}}>{batchJobs.length}</span>
              </div>
              <div style={{maxHeight:140,overflowY:"auto"}}>
                {batchJobs.map(j=>(
                  <div key={j.id} style={{display:"flex",alignItems:"center",gap:6,padding:"3px 6px",marginBottom:2,background:T.bg,borderRadius:4,fontSize:10}}>
                    {j.coatingStage&&COATING_STAGES[j.coatingStage]&&(
                      <div style={{width:6,height:6,borderRadius:"50%",background:COATING_STAGES[j.coatingStage].color,flexShrink:0}}/>
                    )}
                    <span style={{color:T.text,fontFamily:mono,fontWeight:600}}>{j.job||j.id}</span>
                    <span style={{color:T.textDim,fontFamily:mono}}>{j.id}</span>
                    {j.rush&&<Pill color={T.red}>R</Pill>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Overview AI Quick Query Card ───────────────────────────────
function OverviewAICard({trays,batches,settings}){
  const [q,setQ]=useState("");
  const [ans,setAns]=useState("");
  const [loading,setLoading]=useState(false);
  const ask=async()=>{
    if(!q.trim()||loading)return;
    setLoading(true);setAns("");
    const ctx=`Lab state: ${trays.filter(t=>t.state!=="IDLE").length} active trays, ${trays.filter(t=>t.rush).length} rush, ${trays.filter(t=>["COATING_STAGED","COATING_IN_PROCESS"].includes(t.state)).length} in coating. Avg batch fill ${Math.round(batches.reduce((s,b)=>s+(b.loaded/b.capacity)*100,0)/batches.length)}%. Answer in 2-3 sentences max. Be specific and direct.`;
    try{
      const result = await callGateway(settings, q, { context: ctx });
      setAns(result?.response || "No response.");
    }catch(e){setAns(`Connection error: ${e.message}`);}
    setLoading(false);
  };
  return(
    <div>
      <SectionHeader>🤖 AI Quick Query</SectionHeader>
      <div style={{display:"flex",gap:8,marginBottom:10}}>
        <input value={q} onChange={e=>setQ(e.target.value)} onKeyDown={e=>e.key==="Enter"&&ask()}
          placeholder="Ask anything about current lab state…"
          style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:7,padding:"9px 12px",color:T.text,fontSize:12,fontFamily:sans,outline:"none"}}/>
        <button onClick={ask} disabled={loading||!q.trim()}
          style={{background:T.blue,border:"none",borderRadius:7,padding:"9px 18px",color:"#fff",fontWeight:700,fontSize:12,cursor:"pointer",opacity:loading?0.6:1}}>
          {loading?"…":"Ask"}
        </button>
      </div>
      {ans&&<div style={{fontSize:13,color:T.text,lineHeight:1.6,padding:"10px 14px",background:T.bg,borderRadius:7,border:`1px solid ${T.border}`}}>{ans}</div>}
    </div>
  );
}

// ── Main OverviewTab Component ────────────────────────────────
export default function OverviewTab({trays,putWall,batches,events,messages:initMessages,onSendMessage,onBatchControl,settings,breakage=[],dviJobs=[],wipJobs=[],shippedStats={},setView}){
  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  const STORAGE_KEY = "la_cards_v1";
  const [cards,setCards]=useState(()=>{
    try{ const s=localStorage.getItem(STORAGE_KEY); return s?JSON.parse(s):DEFAULT_CARDS; }
    catch{ return DEFAULT_CARDS; }
  });
  const [msgInput,setMsgInput]=useState("");
  const [messages,setMessages]=useState(initMessages||[]);
  const messagesRef=useRef(null);
  const [expandedBatch,setExpandedBatch]=useState(null);
  const [drag,setDrag]=useState({dragging:null,over:null});
  const [showSlackCfg,setShowSlackCfg]=useState(false);
  const [draft,setDraft]=useState({});
  const [showCardPicker,setShowCardPicker]=useState(false);
  const [editCard,setEditCard]=useState(null);
  const [cardMenu,setCardMenu]=useState(null);

  useEffect(()=>{
    if(!cardMenu)return;
    const close=()=>setCardMenu(null);
    document.addEventListener("click",close);
    return()=>document.removeEventListener("click",close);
  },[cardMenu]);

  useEffect(()=>{
    if(messagesRef.current) messagesRef.current.scrollTop=messagesRef.current.scrollHeight;
  },[messages]);

  const [inventory,setInventory]=useState({materials:[],alerts:[],status:"pending",lastSync:null});
  useEffect(()=>{
    const fetchInventory=async()=>{
      try{
        const [invRes,alertRes]=await Promise.all([
          fetch("http://localhost:3002/api/inventory"),
          fetch("http://localhost:3002/api/inventory/alerts")
        ]);
        const inv=await invRes.json();
        const alerts=await alertRes.json();
        setInventory({
          materials:inv.materials||[],
          alerts:alerts.alerts||[],
          status:inv.status||"ok",
          lastSync:inv.lastSync,
          alertCount:inv.alertCount||0
        });
      }catch(e){
        setInventory(prev=>({...prev,status:"error",error:e.message}));
      }
    };
    fetchInventory();
    const iv=setInterval(fetchInventory,60000);
    return()=>clearInterval(iv);
  },[]);

  const [maintenanceData,setMaintenanceData]=useState({stats:{},openTasks:[],criticalTasks:[],status:"pending"});
  useEffect(()=>{
    const fetchMaintenance=async()=>{
      try{
        const [statsRes,tasksRes]=await Promise.all([
          fetch("http://localhost:3002/api/maintenance/stats"),
          fetch("http://localhost:3002/api/maintenance/tasks")
        ]);
        const stats=await statsRes.json();
        const tasks=await tasksRes.json();
        setMaintenanceData({
          stats:stats||{},
          openTasks:tasks.open||[],
          criticalTasks:tasks.critical||[],
          status:stats.status||"ok",
          lastSync:stats.lastSync
        });
      }catch(e){
        setMaintenanceData(prev=>({...prev,status:"error"}));
      }
    };
    fetchMaintenance();
    const iv=setInterval(fetchMaintenance,60000);
    return()=>clearInterval(iv);
  },[]);

  useEffect(()=>{ try{localStorage.setItem(STORAGE_KEY,JSON.stringify(cards));}catch{} },[cards]);

  const addCard=(type)=>{
    const def=CARD_REGISTRY.find(r=>r.type===type);
    const newCard={ id:genId(), type, title:def?.label||type, config:{} };
    setCards(prev=>[...prev,newCard]);
    setShowCardPicker(false);
  };

  const removeCard=(id)=>setCards(prev=>prev.filter(c=>c.id!==id));
  const updateCardConfig=(id,cfg)=>setCards(prev=>prev.map(c=>c.id===id?{...c,config:{...c.config,...cfg}}:c));
  const updateCardTitle=(id,title)=>setCards(prev=>prev.map(c=>c.id===id?{...c,title}:c));

  const handleIncoming=useCallback((msg)=>{
    onSendMessage && onSendMessage(msg.text, msg);
    setMessages(prev=>[msg,...prev].slice(0,50));
  },[onSendMessage]);

  const slack=useSlackConfig(handleIncoming, setMessages);
  const activeTrays=trays.filter(t=>t.state!=="IDLE").length;
  const rushCount=trays.filter(t=>t.rush).length;
  const coatingWIP=trays.filter(t=>["COATING_STAGED","COATING_IN_PROCESS"].includes(t.state)).length;
  const avgBatchFill=Math.round(batches.reduce((s,b)=>s+(b.loaded/b.capacity)*100,0)/batches.length);
  const pwOcc=putWall.filter(s=>s.trayId).length;
  const isConnected=slack.proxyConnected||!!slack.cfg.webhook;
  const sendBg=slack.status==="sending"?T.amber:slack.status==="ok"?T.green:slack.status==="err"?T.red:"#4A154B";
  const sendLabel=slack.status==="sending"?"…":slack.status==="ok"?"✓ SENT":slack.status==="err"?"✗ ERR":isConnected?"SEND":"SEND";

  const handleSend=async()=>{
    if(!msgInput.trim())return;
    const text=msgInput.trim();
    setMsgInput("");
    const newMsg={
      id:`sent-${Date.now()}`,
      from:"You",
      text,
      time:new Date(),
      priority:text.toLowerCase().includes("rush")||text.toLowerCase().includes("hot")?"high":"normal",
      source:"local"
    };
    setMessages(prev=>[newMsg,...prev].slice(0,50));
    onSendMessage(text);
    if(isConnected) slack.post(text);
  };

  const handleDragStart=(id)=>setDrag({dragging:id,over:null});
  const handleDragOver=(id)=>setDrag(d=>({...d,over:id}));
  const handleDrop=(targetId)=>{
    if(!drag.dragging||drag.dragging===targetId)return;
    setCards(prev=>{
      const next=[...prev];
      const fromIdx=next.findIndex(c=>c.id===drag.dragging);
      const toIdx=next.findIndex(c=>c.id===targetId);
      const [moved]=next.splice(fromIdx,1);
      next.splice(toIdx,0,moved);
      return next;
    });
    setDrag({dragging:null,over:null});
  };
  const handleDragEnd=()=>setDrag({dragging:null,over:null});

  const [opcSearch,setOpcSearch]=useState("");
  const configCard=editCard?cards.find(c=>c.id===editCard):null;
  const configCfg=configCard?.config||{};
  const configWatchedOPCs=configCard?(configCfg.opcWatchlist||"").split(/[\n,]/).map(s=>s.trim()).filter(Boolean):[];
  const configFilteredMaterials=opcSearch.trim().length>=2
    ? inventory.materials.filter(m=>
        m.sku?.toLowerCase().includes(opcSearch.toLowerCase())||
        m.name?.toLowerCase().includes(opcSearch.toLowerCase())
      ).slice(0,15)
    : [];

  const renderCardContent=(card)=>{
    switch(card.type){
      case "kpi_row": return(
        <ConfigurableKPIRow
          data={{trays,batches,dviJobs,breakage,maintenance:maintenanceData,wipJobs,shippedStats}}
          settings={settings}
          cardConfig={card.config}
          onConfigChange={(cfg)=>updateCardConfig(card.id,cfg)}
        />
      );

      case "slack_feed": return(
        <div>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <svg width={20} height={20} viewBox="0 0 122 122" fill="none">
                <path d="M26 80.5a13 13 0 1 1-13-13h13v13Z" fill="#E01E5A"/>
                <path d="M32.5 80.5a13 13 0 0 1 26 0v32.5a13 13 0 0 1-26 0V80.5Z" fill="#E01E5A"/>
                <path d="M45.5 26a13 13 0 1 1 13-13v13H45.5Z" fill="#36C5F0"/>
                <path d="M45.5 32.5a13 13 0 0 1 0 26H13a13 13 0 0 1 0-26h32.5Z" fill="#36C5F0"/>
                <path d="M96 45.5a13 13 0 1 1 13 13H96V45.5Z" fill="#2EB67D"/>
                <path d="M89.5 45.5a13 13 0 0 1-26 0V13a13 13 0 0 1 26 0v32.5Z" fill="#2EB67D"/>
                <path d="M76.5 96a13 13 0 1 1-13 13V96h13Z" fill="#ECB22E"/>
                <path d="M76.5 89.5a13 13 0 0 1 0-26H109a13 13 0 0 1 0 26H76.5Z" fill="#ECB22E"/>
              </svg>
              <span style={{fontSize:14,fontWeight:800,color:T.text}}>Slack Messages</span>
              <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 9px",borderRadius:12,background:isConnected?"#4A154B22":"transparent",border:`1px solid ${isConnected?"#4A154B":T.border}`}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:isConnected?T.green:T.textDim,boxShadow:isConnected?`0 0 6px ${T.green}`:""}}/>
                <span style={{fontSize:10,color:isConnected?T.green:T.textDim,fontFamily:mono,fontWeight:700}}>{isConnected?`#${slack.cfg.channel||"lab-assistant"}`:"Not connected"}</span>
              </div>
            </div>
            <button onClick={()=>{setDraft({...slack.cfg});setShowSlackCfg(s=>!s);}}
              style={{fontSize:11,padding:"5px 12px",background:showSlackCfg?"#4A154B":T.bg,border:`1px solid ${showSlackCfg?"#611f69":T.border}`,borderRadius:6,color:showSlackCfg?"#E8A9F4":T.textMuted,cursor:"pointer",fontFamily:mono,fontWeight:700}}>
              ⚙ {showSlackCfg?"Close":"Configure"}
            </button>
          </div>
          {showSlackCfg&&(
            <div style={{marginBottom:14,padding:16,background:"#1A0A1E",border:"1px solid #611f69",borderRadius:10}}>
              <div style={{fontSize:11,color:"#E8A9F4",fontFamily:mono,fontWeight:700,marginBottom:12,letterSpacing:1}}>SLACK INTEGRATION SETUP</div>
              {[
                {key:"webhook",label:"Outgoing Webhook URL",ph:"https://hooks.slack.com/services/...",type:"url"},
                {key:"channel",label:"Channel name (no #)",ph:"lab-assistant",type:"text"},
                {key:"channelUrl",label:"Channel URL (for QR code)",ph:"https://yourco.slack.com/archives/C...",type:"url"},
                {key:"channelId",label:"Channel ID (incoming)",ph:"C05AB12XYZ",type:"text"},
                {key:"proxyUrl",label:"Local proxy URL (incoming)",ph:"http://localhost:3001/slack/messages",type:"url"},
              ].map(f=>(
                <div key={f.key} style={{marginBottom:10}}>
                  <label style={{fontSize:9,color:"#E8A9F4",fontFamily:mono,display:"block",marginBottom:3,letterSpacing:1}}>{f.label.toUpperCase()}</label>
                  <input type={f.type} value={draft[f.key]||""} onChange={e=>setDraft(d=>({...d,[f.key]:e.target.value}))} placeholder={f.ph}
                    style={{width:"100%",background:"#0D0010",border:"1px solid #611f69",borderRadius:6,padding:"8px 12px",color:T.text,fontSize:11,fontFamily:mono,outline:"none",boxSizing:"border-box"}}/>
                </div>
              ))}
              <button onClick={()=>{slack.save(draft);setShowSlackCfg(false);}}
                style={{width:"100%",padding:"9px",background:"#4A154B",border:"1px solid #611f69",borderRadius:6,color:"#E8A9F4",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:mono}}>
                SAVE & CONNECT
              </button>
            </div>
          )}
          <div ref={messagesRef} style={{maxHeight:220,overflowY:"auto",display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
            {[...messages.slice(0,12)].reverse().map((m,i)=>(
              <div key={m.id||i} style={{display:"flex",gap:8,padding:"7px 10px",background:m.priority==="high"?"#7F1D1D33":T.bg,borderRadius:7,border:`2px solid ${m.priority==="high"?T.red:T.border}`,boxShadow:m.priority==="high"?`0 0 8px ${T.red}40`:""}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:m.source==="slack"?"#4A154B":T.blue,marginTop:4,flexShrink:0}}/>
                <div style={{flex:1}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                    <span style={{fontSize:11,fontWeight:700,color:T.text,fontFamily:mono}}>{m.from||"System"}</span>
                    <span style={{display:"flex",alignItems:"center",gap:6}}>
                      {m.priority==="high"&&<span style={{padding:"2px 6px",background:T.red,borderRadius:4,fontSize:9,fontWeight:800,color:"#fff",fontFamily:mono}}>HOT</span>}
                      <span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{m.time instanceof Date?m.time.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):""}</span>
                    </span>
                  </div>
                  <div style={{fontSize:slack.cfg.textSize||12,color:T.textMuted}}>{m.text}</div>
                </div>
              </div>
            ))}
            {messages.length===0&&<div style={{textAlign:"center",padding:20,fontSize:12,color:T.textDim}}>No messages yet</div>}
          </div>
          <div style={{display:"flex",gap:8}}>
            <input value={msgInput} onChange={e=>setMsgInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")handleSend();}}
              placeholder={isConnected?`Message #${slack.cfg.channel||"lab-assistant"}…`:"Type a message…"}
              style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 12px",color:T.text,fontSize:12,fontFamily:sans,outline:"none"}}/>
            <button onClick={handleSend} style={{background:sendBg,border:"none",borderRadius:6,padding:"8px 18px",color:"#fff",fontWeight:800,fontSize:11,cursor:"pointer",fontFamily:mono,minWidth:72}}>
              {sendLabel}
            </button>
          </div>
        </div>
      );

      case "coating_machines": return(
        <div>
          <SectionHeader>Coating Machines</SectionHeader>
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            {batches.map((b,idx)=><BatchCard key={b.id} batch={b} trays={trays} expanded={expandedBatch===b.id} onToggle={()=>setExpandedBatch(expandedBatch===b.id?null:b.id)} onControl={onBatchControl} machineDisplayName={coaterMachines[idx]}/>)}
          </div>
        </div>
      );

      case "putwall_grid": return(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
          <Card>
            <SectionHeader right={`${pwOcc}/20 occupied`}>Quick Bind</SectionHeader>
            <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:6}}>
              {putWall.map((s,i)=>{
                const bg=!s.trayId?T.bg:s.rush?T.redDark:T.blueDark;
                const border=!s.trayId?T.border:s.rush?T.red:T.blue;
                return(
                  <div key={i} style={{background:bg,border:`1px solid ${border}`,borderRadius:6,padding:"7px 5px",textAlign:"center",minHeight:60,display:"flex",flexDirection:"column",justifyContent:"center",position:"relative"}}>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{String(s.position).padStart(2,"0")}</div>
                    {s.trayId?(<>
                      <div style={{fontSize:11,color:T.text,fontWeight:700,fontFamily:mono}}>{s.job}</div>
                      <div style={{fontSize:9,color:T.textMuted}}>{s.trayId}</div>
                      {s.rush&&<div style={{position:"absolute",top:2,right:2,fontSize:7,background:T.red,color:"#fff",borderRadius:3,padding:"1px 3px",fontWeight:800}}>R</div>}
                    </>):<div style={{fontSize:14,color:T.border}}>—</div>}
                  </div>
                );
              })}
            </div>
          </Card>
          <EventLog events={events}/>
        </div>
      );

      case "fleet_dept": return(
        <Card style={{padding:20}}>
          <SectionHeader right={`${trays.length} trays total`}>Fleet by Department</SectionHeader>
          <div style={{display:"grid",gridTemplateColumns:`repeat(${Object.keys(DEPARTMENTS).length},1fr)`,gap:10}}>
            {Object.entries(DEPARTMENTS).map(([deptKey,dept])=>{
              const deptTrays=trays.filter(t=>t.department===deptKey);
              const rushInDept=deptTrays.filter(t=>t.rush).length;
              return(
                <div key={deptKey} style={{display:"flex",flexDirection:"column"}}>
                  <div style={{textAlign:"center",paddingBottom:8,marginBottom:8,borderBottom:`2px solid ${dept.color}`}}>
                    <div style={{fontSize:12,fontWeight:700,color:dept.color,fontFamily:mono}}>{dept.label}</div>
                    <div style={{fontSize:22,fontWeight:800,color:T.text,fontFamily:mono}}>{deptTrays.length}</div>
                    <Pill color={rushInDept>0?T.red:T.textDim} bg={rushInDept>0?`${T.red}20`:`${T.textDim}15`}>{rushInDept} RUSH</Pill>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(16px,1fr))",gap:3,flex:1}}>
                    {deptTrays.map(t=>{
                      const ct=t.coatingType&&COATING_COLORS[t.coatingType]?COATING_COLORS[t.coatingType]:{color:"#475569",bg:"#1E293B"};
                      return(
                        <div key={t.id} title={`${t.id}${t.job?` | ${t.job}`:""} | ${t.coatingType||"No coating"}${t.rush?" | RUSH":""}`}
                          style={{width:"100%",aspectRatio:"1",borderRadius:3,background:ct.bg,border:`1px solid ${ct.color}35`,display:"flex",alignItems:"center",justifyContent:"center",position:"relative"}}>
                          <div style={{width:5,height:5,borderRadius:"50%",background:ct.color,opacity:0.9}}/>
                          {t.rush&&<div style={{position:"absolute",top:0,right:0,width:4,height:4,background:T.red,borderRadius:"0 3px 0 2px"}}/>}
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{display:"flex",flexWrap:"wrap",gap:8,marginTop:12,paddingTop:10,borderTop:`1px solid ${T.border}`,justifyContent:"center"}}>
            {Object.entries(COATING_COLORS).map(([name,c])=>(
              <div key={name} style={{display:"flex",alignItems:"center",gap:4,padding:"2px 6px"}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:c.color}}/><span style={{fontSize:10,color:c.color,fontFamily:mono}}>{name}</span>
              </div>
            ))}
          </div>
        </Card>
      );

      case "rush_queue":{
        const rushJobs=trays.filter(t=>t.rush&&t.state!=="IDLE");
        return(
          <div>
            <SectionHeader right={<span style={{color:rushJobs.length>0?T.red:T.green,fontFamily:mono}}>{rushJobs.length} ACTIVE</span>}>Rush Queue</SectionHeader>
            {rushJobs.length===0
              ?<div style={{textAlign:"center",padding:"24px 0",fontSize:12,color:T.green,fontFamily:mono}}>No rush jobs active</div>
              :<div style={{display:"flex",flexDirection:"column",gap:6}}>
                {rushJobs.map(t=>{
                  const dept=DEPARTMENTS[t.department];
                  const minsInSystem=Math.floor((Date.now()-(t.updatedAt||Date.now()))/60000);
                  return(
                    <div key={t.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",background:T.bg,border:`1px solid ${T.red}40`,borderRadius:8,borderLeft:`3px solid ${T.red}`}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:T.red,boxShadow:`0 0 8px ${T.red}`,flexShrink:0}}/>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:mono}}>{t.job||t.id}</span>
                          {t.coatingType&&<Pill color={T.amber}>{t.coatingType}</Pill>}
                        </div>
                        <div style={{fontSize:10,color:T.textDim,marginTop:2}}>
                          {dept?<span style={{color:dept.color}}>{dept.icon} {dept.label}</span>:"—"}
                          {t.coatingStage&&COATING_STAGES[t.coatingStage]&&<span> › {COATING_STAGES[t.coatingStage].label}</span>}
                        </div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontSize:14,fontWeight:800,color:minsInSystem>120?T.red:minsInSystem>60?T.amber:T.text,fontFamily:mono}}>{minsInSystem}m</div>
                        <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>IN SYSTEM</div>
                      </div>
                    </div>
                  );
                })}
              </div>
            }
          </div>
        );
      }

      case "aging_alert":{
        const threshHours=card.config?.thresholdHours||8;
        const aged=trays.filter(t=>t.state!=="IDLE"&&t.job&&((Date.now()-(t.updatedAt||Date.now()))/3600000)>=threshHours)
          .map(t=>({...t,hoursIn:((Date.now()-(t.updatedAt||Date.now()))/3600000)}))
          .sort((a,b)=>b.hoursIn-a.hoursIn);
        return(
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>WIP Aging Alert</SectionHeader>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>THRESHOLD</span>
                <select value={threshHours} onChange={e=>updateCardConfig(card.id,{thresholdHours:Number(e.target.value)})}
                  style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,fontSize:11,fontFamily:mono,padding:"3px 8px"}}>
                  {[2,4,6,8,12,24,48].map(h=><option key={h} value={h}>{h}h</option>)}
                </select>
              </div>
            </div>
            {aged.length===0
              ?<div style={{textAlign:"center",padding:"20px 0",fontSize:12,color:T.green,fontFamily:mono}}>All jobs under {threshHours}h threshold</div>
              :<div style={{display:"flex",flexDirection:"column",gap:5,maxHeight:280,overflowY:"auto"}}>
                {aged.map(t=>{
                  const h=Math.floor(t.hoursIn),m=Math.round((t.hoursIn-h)*60);
                  const col=t.hoursIn>48?T.red:t.hoursIn>24?T.orange:T.amber;
                  return(
                    <div key={t.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",background:T.bg,borderRadius:7,border:`1px solid ${col}30`,borderLeft:`3px solid ${col}`}}>
                      <div style={{fontFamily:mono,fontSize:13,fontWeight:800,color:col,minWidth:56}}>{h>0?`${h}h ${m}m`:`${m}m`}</div>
                      <div style={{flex:1}}>
                        <span style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:mono}}>{t.job||t.id}</span>
                        {t.coatingType&&<span style={{fontSize:10,color:T.amber,fontFamily:mono,marginLeft:8}}>{t.coatingType}</span>}
                      </div>
                      <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{DEPARTMENTS[t.department]?.label||t.department||"?"}</div>
                      {t.rush&&<Pill color={T.red}>RUSH</Pill>}
                    </div>
                  );
                })}
              </div>
            }
          </div>
        );
      }

      case "inventory":{
        const liveConnected=inventory.status==="ok";
        const opcWatchlist=card.config?.opcWatchlist||"";
        const watchedOPCs=opcWatchlist.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
        const hasWatchlist=watchedOPCs.length>0;

        let displayItems=[];
        if(hasWatchlist){
          const materialMap=new Map(inventory.materials.map(m=>[m.sku?.toUpperCase(),m]));
          displayItems=watchedOPCs.map(opc=>{
            const mat=materialMap.get(opc.toUpperCase());
            if(mat){
              const thresh=20;
              const status=mat.qty===0?"CRITICAL":mat.qty<=thresh*0.5?"LOW":mat.qty<=thresh?"WATCH":"OK";
              return {sku:mat.sku,name:mat.name||mat.sku,qty:mat.qty,thresh,severity:status,found:true};
            }else{
              return {sku:opc,name:opc,qty:null,thresh:0,severity:"NOT_FOUND",found:false};
            }
          });
        }else{
          displayItems=inventory.alerts.slice(0,20).map(a=>({
            sku:a.material?.sku||a.sku||"?",
            name:a.material?.name||a.material?.description||a.name||"Unknown",
            qty:a.qtyOnHand??0,
            thresh:a.reorderPoint||20,
            severity:a.severity,
            found:true
          }));
        }

        const hasData=displayItems.length>0;
        return(
          <div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:8}}>
              <SectionHeader>Lens Blank Inventory</SectionHeader>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                {hasWatchlist&&<span style={{fontSize:9,color:T.blue,fontFamily:mono,fontWeight:700}}>{watchedOPCs.length} OPCs</span>}
                <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:12,background:liveConnected?`${T.green}15`:`${T.amber}15`,border:`1px solid ${liveConnected?T.green:T.amber}`}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:liveConnected?T.green:T.amber}}/>
                  <span style={{fontSize:9,color:liveConnected?T.green:T.amber,fontFamily:mono,fontWeight:700}}>{liveConnected?"ITEMPATH LIVE":"CONNECTING..."}</span>
                </div>
              </div>
            </div>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:10}}>
              {hasWatchlist?`Showing ${watchedOPCs.length} watched OPCs`:"Showing low-stock alerts"}
            </div>
            {!hasData?(
              <div style={{textAlign:"center",padding:"30px 0",fontSize:12,color:liveConnected?T.green:T.textDim,fontFamily:mono}}>
                {liveConnected?"Add OPCs via Configure":"Loading inventory..."}
              </div>
            ):(
              <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:320,overflowY:"auto"}}>
                {displayItems.map(item=>{
                  const isNotFound=item.severity==="NOT_FOUND";
                  const pct=isNotFound?0:Math.min(100,Math.round((item.qty/(item.thresh||1))*50));
                  const col=isNotFound?T.textDim:item.severity==="CRITICAL"?T.red:item.severity==="LOW"?T.orange:item.severity==="WATCH"?T.amber:T.green;
                  const status=isNotFound?"NOT FOUND":item.severity==="OK"?"IN STOCK":item.severity;
                  return(
                    <div key={item.sku} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 12px",background:T.bg,borderRadius:7,border:`1px solid ${T.border}`,opacity:isNotFound?0.6:1}}>
                      <div style={{flex:1}}>
                        <div style={{fontSize:11,fontWeight:700,color:T.text}}>{item.name}</div>
                        <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginTop:1}}>{item.sku}</div>
                      </div>
                      {!isNotFound&&(
                        <div style={{width:80,height:5,background:T.border,borderRadius:3,overflow:"hidden"}}>
                          <div style={{width:`${pct}%`,height:"100%",background:col,borderRadius:3}}/>
                        </div>
                      )}
                      <div style={{fontFamily:mono,fontSize:14,fontWeight:800,color:col,minWidth:32,textAlign:"right"}}>{isNotFound?"—":item.qty}</div>
                      <Pill color={col}>{status}</Pill>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      }

      case "ai_query": return <OverviewAICard trays={trays} batches={batches} settings={settings}/>;

      case "custom_metric":{
        const url=card.config?.url||"";
        const [metricVal,setMetricVal]=useState(null);
        const [metricErr,setMetricErr]=useState(null);
        useEffect(()=>{
          if(!url)return;
          const doFetch=async()=>{
            try{
              const r=await fetch(url,{signal:AbortSignal.timeout(5000)});
              const data=await r.json();
              setMetricVal(String(card.config?.field?data[card.config.field]:JSON.stringify(data)));
              setMetricErr(null);
            }catch(e){setMetricErr(e.message);}
          };
          doFetch();
          const iv=setInterval(doFetch,(card.config?.intervalSec||30)*1000);
          return()=>clearInterval(iv);
        },[url,card.config?.field,card.config?.intervalSec]);
        if(!url) return(
          <div style={{textAlign:"center",padding:24,fontSize:12,color:T.textDim}}>
            Configure endpoint URL in card settings to display a live metric.
          </div>
        );
        return(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:48,fontWeight:800,color:metricErr?T.red:T.green,fontFamily:mono,lineHeight:1}}>
              {metricErr?"ERR":metricVal||"…"}
            </div>
            {card.config?.label&&<div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginTop:6,letterSpacing:1}}>{card.config.label.toUpperCase()}</div>}
            {metricErr&&<div style={{fontSize:10,color:T.red,fontFamily:mono,marginTop:4}}>{metricErr}</div>}
          </div>
        );
      }

      case "surfacing_summary":{
        const surfacingJobs=trays.filter(t=>t.department==="SURFACING"&&t.state!=="IDLE");
        const queueJobs=surfacingJobs.filter(t=>t.state==="QUEUED");
        const inProgress=surfacingJobs.filter(t=>t.state==="IN_PROGRESS");
        const rushJobs=surfacingJobs.filter(t=>t.rush);
        return(
          <div onClick={()=>setView&&setView("surfacing")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>Surfacing</SectionHeader>
              <span style={{fontSize:10,color:T.blue,fontFamily:mono}}>VIEW TAB →</span>
            </div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <KPICard label="Queue" value={queueJobs.length} sub="waiting" accent={T.blue}/>
              <KPICard label="In Progress" value={inProgress.length} sub="active" accent={T.green}/>
              <KPICard label="Rush" value={rushJobs.length} sub="priority" accent={rushJobs.length>0?T.red:T.textDim}/>
            </div>
          </div>
        );
      }

      case "cutting_summary":{
        const cuttingJobs=trays.filter(t=>t.department==="CUTTING"&&t.state!=="IDLE");
        const queueJobs=cuttingJobs.filter(t=>t.state==="QUEUED");
        const inProgress=cuttingJobs.filter(t=>t.state==="IN_PROGRESS");
        const rushJobs=cuttingJobs.filter(t=>t.rush);
        return(
          <div onClick={()=>setView&&setView("cutting")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>Cutting</SectionHeader>
              <span style={{fontSize:10,color:T.blue,fontFamily:mono}}>VIEW TAB →</span>
            </div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <KPICard label="Queue" value={queueJobs.length} sub="waiting" accent={T.blue}/>
              <KPICard label="In Progress" value={inProgress.length} sub="active" accent={T.green}/>
              <KPICard label="Rush" value={rushJobs.length} sub="priority" accent={rushJobs.length>0?T.red:T.textDim}/>
            </div>
          </div>
        );
      }

      case "assembly_summary":{
        const assemblyJobs=trays.filter(t=>t.department==="ASSEMBLY"&&t.state!=="IDLE");
        const queueJobs=assemblyJobs.filter(t=>t.state==="QUEUED");
        const inProgress=assemblyJobs.filter(t=>t.state==="IN_PROGRESS");
        const rushJobs=assemblyJobs.filter(t=>t.rush);
        return(
          <div onClick={()=>setView&&setView("assembly")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>Assembly</SectionHeader>
              <span style={{fontSize:10,color:T.blue,fontFamily:mono}}>VIEW TAB →</span>
            </div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <KPICard label="Queue" value={queueJobs.length} sub="waiting" accent={T.blue}/>
              <KPICard label="In Progress" value={inProgress.length} sub="active" accent={T.green}/>
              <KPICard label="Rush" value={rushJobs.length} sub="priority" accent={rushJobs.length>0?T.red:T.textDim}/>
            </div>
          </div>
        );
      }

      case "shipping_summary":{
        const shippingJobs=trays.filter(t=>t.department==="SHIPPING"&&t.state!=="IDLE");
        const readyToShip=shippingJobs.filter(t=>t.state==="READY");
        const inProgress=shippingJobs.filter(t=>t.state==="IN_PROGRESS");
        const rushJobs=shippingJobs.filter(t=>t.rush);
        return(
          <div onClick={()=>setView&&setView("shipping")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>Shipping</SectionHeader>
              <span style={{fontSize:10,color:T.blue,fontFamily:mono}}>VIEW TAB →</span>
            </div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <KPICard label="Ready" value={readyToShip.length} sub="to ship" accent={T.green}/>
              <KPICard label="In Progress" value={inProgress.length} sub="packing" accent={T.blue}/>
              <KPICard label="Rush" value={rushJobs.length} sub="priority" accent={rushJobs.length>0?T.red:T.textDim}/>
            </div>
          </div>
        );
      }

      case "maintenance_summary":{
        const ms=maintenanceData.stats;
        const criticalCount=maintenanceData.criticalTasks?.length||0;
        const openCount=ms.openTaskCount||maintenanceData.openTasks?.length||0;
        const pmCompliance=ms.pmCompliancePercent;
        const assetsDown=ms.assetsDown||0;
        const hasData=ms.hasData!==false;
        return(
          <div onClick={()=>setView&&setView("maintenance")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>Maintenance</SectionHeader>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:maintenanceData.status==='ok'?T.green:maintenanceData.status==='mock'?T.amber:T.red}}/>
                <span style={{fontSize:10,color:T.blue,fontFamily:mono}}>VIEW TAB →</span>
              </div>
            </div>
            {!hasData&&<div style={{fontSize:10,color:T.amber,fontFamily:mono,marginBottom:8}}>No recent maintenance data</div>}
            <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
              <KPICard label="Open WOs" value={openCount} sub={`${criticalCount} critical`} accent={criticalCount>0?T.red:openCount>20?T.amber:T.green}/>
              <KPICard label="PM Compliance" value={pmCompliance!=null?`${pmCompliance}%`:'—'} sub="on schedule" accent={pmCompliance!=null?(pmCompliance>=90?T.green:pmCompliance>=75?T.amber:T.red):T.textDim}/>
              <KPICard label="Equipment" value={ms.totalAssets||0} sub={assetsDown>0?`${assetsDown} down`:'all operational'} accent={assetsDown>0?T.red:T.green}/>
            </div>
            {criticalCount>0&&(
              <div style={{marginTop:10,padding:"8px 10px",background:`${T.red}15`,borderRadius:6,border:`1px solid ${T.red}30`}}>
                <div style={{fontSize:10,fontWeight:700,color:T.red,marginBottom:4}}>CRITICAL TASKS:</div>
                {maintenanceData.criticalTasks?.slice(0,2).map((t,i)=>(
                  <div key={i} style={{fontSize:11,color:T.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{t.title}</div>
                ))}
              </div>
            )}
          </div>
        );
      }

      default: return <div style={{padding:20,color:T.textDim,fontFamily:mono,fontSize:12}}>Unknown card type: {card.type}</div>;
    }
  };

  const CardPickerModal=()=>(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setShowCardPicker(false)}>
      <div style={{background:T.surface,border:`1px solid ${T.borderLight}`,borderRadius:16,padding:28,width:600,maxWidth:"90vw",maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:16,fontWeight:800,color:T.text}}>Add a Card</div>
          <button onClick={()=>setShowCardPicker(false)} style={{background:"transparent",border:"none",color:T.textDim,fontSize:20,cursor:"pointer"}}>×</button>
        </div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          {CARD_REGISTRY.map(ct=>(
            <button key={ct.type} onClick={()=>addCard(ct.type)}
              style={{display:"flex",alignItems:"flex-start",gap:12,padding:14,background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,cursor:"pointer",textAlign:"left",transition:"border-color 0.15s"}}
              onMouseEnter={e=>e.currentTarget.style.borderColor=T.blue}
              onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
              <span style={{fontSize:24,flexShrink:0}}>{ct.icon}</span>
              <div>
                <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:3}}>{ct.label}</div>
                <div style={{fontSize:11,color:T.textDim,lineHeight:1.4}}>{ct.desc}</div>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}} onDragEnd={handleDragEnd}>
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,alignItems:"center"}}>
        <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{cards.length} CARDS · DRAG TO REORDER</span>
        <button onClick={()=>setShowCardPicker(true)}
          style={{display:"flex",alignItems:"center",gap:7,padding:"8px 16px",background:T.blueDark,border:`1px solid ${T.blue}`,borderRadius:8,color:T.blue,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:mono,letterSpacing:.5}}>
          + ADD CARD
        </button>
      </div>
      {cards.map(card=>(
        <div key={card.id} draggable
          onDragStart={()=>handleDragStart(card.id)}
          onDragOver={e=>{e.preventDefault();handleDragOver(card.id);}}
          onDrop={()=>handleDrop(card.id)}
          style={{opacity:drag.dragging===card.id?0.4:1,outline:drag.over===card.id&&drag.dragging!==card.id?`2px dashed ${T.blue}`:"none",borderRadius:14,transition:"opacity 0.15s"}}>
          <Card style={{borderTop:`3px solid ${T.border}`}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12,cursor:"grab",userSelect:"none"}}>
              <span style={{color:T.textDim,fontSize:16}}>⠿</span>
              <span style={{flex:1,fontSize:11,fontWeight:700,color:T.dim,fontFamily:mono,letterSpacing:1,textTransform:"uppercase"}}>{card.title}</span>
              <div style={{position:"relative"}}>
                <button onClick={e=>{e.stopPropagation();setCardMenu(cardMenu===card.id?null:card.id);}}
                  style={{background:"transparent",border:"none",color:T.textDim,cursor:"pointer",fontSize:18,lineHeight:1,padding:"0 4px"}}
                  title="Card menu"
                  onMouseEnter={e=>e.currentTarget.style.color=T.text}
                  onMouseLeave={e=>e.currentTarget.style.color=T.textDim}>⋮</button>
                {cardMenu===card.id&&(
                  <div style={{position:"absolute",right:0,top:"100%",marginTop:4,background:T.cardBg,border:`1px solid ${T.border}`,borderRadius:8,boxShadow:"0 4px 12px rgba(0,0,0,0.3)",zIndex:100,minWidth:140,overflow:"hidden"}}>
                    <button onClick={()=>{setEditCard(card.id);setCardMenu(null);}}
                      style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"10px 14px",background:"transparent",border:"none",color:T.text,fontSize:12,fontFamily:mono,cursor:"pointer",textAlign:"left"}}
                      onMouseEnter={e=>e.currentTarget.style.background=T.bg}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <span>⚙</span> Configure
                    </button>
                    <button onClick={()=>{removeCard(card.id);setCardMenu(null);}}
                      style={{display:"flex",alignItems:"center",gap:8,width:"100%",padding:"10px 14px",background:"transparent",border:"none",color:T.red,fontSize:12,fontFamily:mono,cursor:"pointer",textAlign:"left"}}
                      onMouseEnter={e=>e.currentTarget.style.background=T.bg}
                      onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                      <span>×</span> Remove
                    </button>
                  </div>
                )}
              </div>
            </div>
            {renderCardContent(card)}
          </Card>
        </div>
      ))}
      {cards.length===0&&(
        <div style={{textAlign:"center",padding:"60px 20px",border:`2px dashed ${T.border}`,borderRadius:16}}>
          <div style={{fontSize:36,marginBottom:12}}>✦</div>
          <div style={{fontSize:16,fontWeight:700,color:T.text,marginBottom:8}}>No cards on this dashboard</div>
          <div style={{fontSize:13,color:T.textDim,marginBottom:20}}>Add cards to build your custom overview</div>
          <button onClick={()=>setShowCardPicker(true)}
            style={{padding:"10px 24px",background:T.blue,border:"none",borderRadius:8,color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>
            + Add Your First Card
          </button>
        </div>
      )}
      {showCardPicker&&<CardPickerModal/>}
      {editCard&&configCard&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setEditCard(null);setOpcSearch("");}}>
          <div style={{background:T.surface,border:`1px solid ${T.borderLight}`,borderRadius:16,padding:28,width:480,maxWidth:"90vw",maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:16,fontWeight:800,color:T.text}}>Configure Card</div>
              <button onClick={()=>{setEditCard(null);setOpcSearch("");}} style={{background:"transparent",border:"none",color:T.textDim,fontSize:20,cursor:"pointer"}}>×</button>
            </div>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>CARD TITLE</div>
              <input type="text" value={configCard.title} onChange={e=>updateCardTitle(configCard.id,e.target.value)} style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}/>
            </div>
            {configCard.type==="inventory"&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>OPC WATCHLIST ({configWatchedOPCs.length} selected)</div>
                {configWatchedOPCs.length>0&&(
                  <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:10,maxHeight:120,overflowY:"auto"}}>
                    {configWatchedOPCs.map(sku=>{
                      const mat=inventory.materials.find(m=>m.sku===sku);
                      return(
                        <div key={sku} style={{display:"flex",alignItems:"center",gap:6,padding:"4px 8px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6}}>
                          <span style={{fontSize:11,fontFamily:"monospace",color:T.text}}>{sku}</span>
                          {mat&&<span style={{fontSize:10,color:T.green}}>{mat.qty}</span>}
                          {!mat&&<span style={{fontSize:10,color:T.red}}>?</span>}
                          <button onClick={()=>updateCardConfig(configCard.id,{opcWatchlist:configWatchedOPCs.filter(s=>s!==sku).join('\n')})} style={{background:"none",border:"none",color:T.textDim,cursor:"pointer",padding:0,fontSize:14,lineHeight:1}}>×</button>
                        </div>
                      );
                    })}
                  </div>
                )}
                <input type="text" placeholder="Type to search OPCs..." value={opcSearch} onChange={e=>setOpcSearch(e.target.value)} autoComplete="off"
                  style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}/>
                {opcSearch.trim().length>=2&&(
                  <div style={{marginTop:8,border:`1px solid ${T.border}`,borderRadius:8,maxHeight:180,overflowY:"auto",background:T.bg}}>
                    {configFilteredMaterials.length>0?configFilteredMaterials.map(m=>(
                      <div key={m.sku} onClick={()=>{
                          if(!configWatchedOPCs.includes(m.sku)){
                            updateCardConfig(configCard.id,{opcWatchlist:[...configWatchedOPCs,m.sku].join('\n')});
                          }
                          setOpcSearch("");
                        }}
                        style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",borderBottom:`1px solid ${T.border}`,cursor:"pointer"}}>
                        <div>
                          <div style={{fontSize:12,fontWeight:600,fontFamily:"monospace",color:T.text}}>{m.sku}</div>
                          <div style={{fontSize:10,color:T.textDim}}>{m.name}</div>
                        </div>
                        <div style={{fontSize:12,fontWeight:700,color:m.qty>20?T.green:m.qty>5?T.amber:T.red}}>{m.qty}</div>
                      </div>
                    )):(
                      <div style={{padding:12,textAlign:"center",color:T.textDim,fontSize:11}}>No OPCs match "{opcSearch}"</div>
                    )}
                  </div>
                )}
                <div style={{fontSize:10,color:T.textDim,marginTop:6}}>
                  {opcSearch.trim().length<2?"Type at least 2 characters to search":"Click an item to add it"}
                </div>
              </div>
            )}
            {configCard.type==="custom_metric"&&(
              <>
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>DATA URL</div>
                  <input type="text" placeholder="https://api.example.com/metric" value={configCfg.url||""} onChange={e=>updateCardConfig(configCard.id,{url:e.target.value})} style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}/>
                </div>
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>JSON FIELD (OPTIONAL)</div>
                  <input type="text" placeholder="value" value={configCfg.field||""} onChange={e=>updateCardConfig(configCard.id,{field:e.target.value})} style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}/>
                </div>
                <div style={{marginBottom:16}}>
                  <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>REFRESH INTERVAL (SECONDS)</div>
                  <input type="number" min="5" max="3600" value={configCfg.intervalSec||30} onChange={e=>updateCardConfig(configCard.id,{intervalSec:Number(e.target.value)})} style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}/>
                </div>
              </>
            )}
            {!["inventory","wip_aging","custom_metric"].includes(configCard.type)&&(
              <div style={{padding:20,textAlign:"center",color:T.textDim,fontSize:12,fontFamily:mono}}>
                This card type has no additional settings.
              </div>
            )}
            <button onClick={()=>setEditCard(null)} style={{width:"100%",marginTop:8,padding:"12px",background:T.blue,border:"none",borderRadius:8,color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer"}}>
              Done
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
