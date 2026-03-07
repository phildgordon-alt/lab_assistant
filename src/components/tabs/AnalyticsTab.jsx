// AnalyticsTab - Real data from DVI trace + oven timers
import { useState, useEffect, useMemo } from 'react';
import { T, mono, COATING_TYPES, MACHINES } from '../../constants';
import { Card, SectionHeader } from '../shared';

// ── Local color map ───────────────────────────────────────────────────────────
const COATING_COLORS = {
  "AR":          "#3B82F6",
  "Blue Cut":    "#06B6D4",
  "Mirror":      "#A855F7",
  "Transitions": "#F97316",
  "Polarized":   "#EC4899",
  "Hard Coat":   "#84CC16",
};
const STAGE_COLORS = {
  INCOMING:   "#3B82F6",
  SURFACING:  "#06B6D4",
  COATING:    "#F59E0B",
  EDGING:     "#8B5CF6",
  ASSEMBLY:   "#EC4899",
  QC:         "#F97316",
  SHIPPING:   "#10B981",
  CONTROL:    "#64748B",
  ERROR:      "#EF4444",
};

// ── Simple SVG bar chart ──────────────────────────────────────────────────────
function BarChart({data,height=56,labelKey,valueKey,colorKey,color2Key}){
  if(!data||!data.length)return null;
  const max=Math.max(...data.map(d=>Math.max(d[valueKey]||0,d[color2Key]||0)),1);
  const w=100/data.length;
  return(
    <svg width="100%" height={height+28} style={{overflow:"visible"}}>
      {data.map((d,i)=>{
        const bh=Math.max(2,(d[valueKey]/max)*(height-4));
        const x=i*w+w*0.08; const bw=w*0.42;
        const c=d[colorKey]||T.blue;
        // Optional second bar (e.g. shipped alongside incoming)
        const bh2=color2Key&&d[color2Key]?Math.max(2,(d[color2Key]/max)*(height-4)):0;
        const x2=i*w+w*0.52; const bw2=w*0.42;
        return(
          <g key={i}>
            <rect x={`${x}%`} y={height-bh} width={`${bw}%`} height={bh} rx={2} fill={c} opacity={0.85}/>
            {bh2>0&&<rect x={`${x2}%`} y={height-bh2} width={`${bw2}%`} height={bh2} rx={2} fill={T.green} opacity={0.7}/>}
            <text x={`${x+w*0.42}%`} y={height+14} textAnchor="middle" fontSize={8} fill={T.textDim} fontFamily="'JetBrains Mono',monospace">{d[labelKey]}</text>
            <text x={`${x+bw/2}%`} y={height-bh-4} textAnchor="middle" fontSize={8} fill={c} fontFamily="'JetBrains Mono',monospace" fontWeight="bold">{d[valueKey]||''}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Tiny inline sparkline ─────────────────────────────────────────────────────
function Spark({values,color=T.blue,h=32}){
  if(!values||values.length<2)return null;
  const max=Math.max(...values,1),min=Math.min(...values,0),range=max-min||1;
  const pts=values.map((v,i)=>`${(i/(values.length-1))*100},${h-((v-min)/range)*h}`).join(" ");
  const last=pts.split(" ").pop().split(",");
  return(
    <svg width="100%" height={h} preserveAspectRatio="none" viewBox={`0 0 100 ${h}`}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} strokeLinecap="round" strokeLinejoin="round"/>
      <circle cx={parseFloat(last[0])} cy={parseFloat(last[1])} r={2.5} fill={color}/>
    </svg>
  );
}

// ── Pill component ────────────────────────────────────────────────────────────
const Pill = ({children,color,bg})=>(
  <span style={{fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:5,background:bg||`${color}20`,color,fontFamily:mono,textTransform:"uppercase",whiteSpace:"nowrap"}}>{children}</span>
);

// ── KPI Card ──────────────────────────────────────────────────────────────────
const KPICard = ({label,value,sub,trend,accent})=>(
  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 22px",flex:"1 1 0",minWidth:140,borderTop:`4px solid ${accent||T.blue}`}}>
    <div style={{fontSize:13,color:T.textMuted,textTransform:"uppercase",letterSpacing:1.5,fontFamily:mono,fontWeight:600}}>{label}</div>
    <div style={{fontSize:34,fontWeight:800,color:T.text,marginTop:4,fontFamily:mono}}>{value}</div>
    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
      {trend!=null&&<span style={{fontSize:13,color:trend>0?T.green:T.red,fontFamily:mono}}>{trend>0?"\u25B2":"\u25BC"}{Math.abs(trend)}%</span>}
      {sub&&<span style={{fontSize:12,color:T.textDim}}>{sub}</span>}
    </div>
  </div>
);

// ══════════════════════════════════════════════════════════════════════════════
// AnalyticsTab Component — Real Data
// ══════════════════════════════════════════════════════════════════════════════
export default function AnalyticsTab({batches,trays,dviJobs=[],ovenServerUrl,settings}){
  const [sub,setSub]=useState("overview");
  const [range,setRange]=useState("30d");
  const [ovenRuns,setOvenRuns]=useState([]);
  const [ovenStats,setOvenStats]=useState(null);
  const [ovenOk,setOvenOk]=useState(false);
  const [analytics,setAnalytics]=useState(null);
  const [analyticsLoading,setAnalyticsLoading]=useState(true);

  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  // Fetch real analytics from DVI trace
  const daysMap={"7d":7,"30d":30,"90d":90,"all":365};
  useEffect(()=>{
    if(!ovenServerUrl)return;
    setAnalyticsLoading(true);
    const go=async()=>{
      try{
        const res=await fetch(`${ovenServerUrl}/api/analytics/throughput?days=${daysMap[range]}`,{signal:AbortSignal.timeout(5000)});
        if(res.ok){const d=await res.json();setAnalytics(d);}
      }catch(e){console.error('Analytics fetch:',e);}
      setAnalyticsLoading(false);
    };
    go(); const iv=setInterval(go,30000); return()=>clearInterval(iv);
  },[ovenServerUrl,range]);

  // Fetch oven data
  useEffect(()=>{
    if(!ovenServerUrl)return;
    const go=async()=>{
      try{
        const [rR,sR]=await Promise.all([
          fetch(`${ovenServerUrl}/api/oven-runs?limit=2000`,{signal:AbortSignal.timeout(3000)}),
          fetch(`${ovenServerUrl}/api/oven-stats`,{signal:AbortSignal.timeout(3000)}),
        ]);
        if(rR.ok){const d=await rR.json();setOvenRuns(d.runs||[]);setOvenOk(true);}
        if(sR.ok){const d=await sR.json();setOvenStats(d);}
      }catch{setOvenOk(false);}
    };
    go(); const iv=setInterval(go,15000); return()=>clearInterval(iv);
  },[ovenServerUrl]);

  const cutoff=Date.now()-daysMap[range]*86400000;
  const of_=ovenRuns.filter(r=>r.startedAt>=cutoff);

  // Computed from analytics endpoint
  const daily=analytics?.daily||[];
  const stageCount=analytics?.stageCount||{};
  const topStations=analytics?.topStations||[];
  const coatingCount=analytics?.coatingCount||{};
  const cycleTime=analytics?.cycleTime||{};
  const topOperators=analytics?.topOperators||[];
  const totalActive=analytics?.activeWIP||0;
  const incoming=analytics?.incoming||0;

  // Totals from daily
  const totIncoming=daily.reduce((s,d)=>s+d.incoming,0);
  const totShipped=daily.reduce((s,d)=>s+d.shipped,0);
  const totBreakage=daily.reduce((s,d)=>s+d.breakage,0);
  const avgIncoming=daily.length?Math.round(totIncoming/daily.length):0;

  // WIP by stage for pie chart
  const stages=Object.entries(stageCount).sort((a,b)=>b[1]-a[1]);
  const totalWIP=stages.reduce((s,[,c])=>s+c,0);

  // Coating WIP breakdown
  const coatEntries=Object.entries(coatingCount).filter(([k])=>k!=='Unknown').sort((a,b)=>b[1].total-a[1].total);
  const totalCoatWIP=coatEntries.reduce((s,[,v])=>s+v.total,0);

  const fmtSecs=s=>{const m=Math.floor(Math.abs(s)/60),sc=Math.abs(s)%60;return`${s<0?"-":""}${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")}`;};
  const fmtDate=ts=>new Date(ts).toLocaleDateString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

  // ── Export CSV from DVI jobs ──
  const exportCSV=()=>{
    const hdrs=["Job ID","Station","Stage","Days In Lab","First Seen","Last Seen","Coating","Rush","Breakage"];
    const rows=(dviJobs||[]).map(j=>[j.job_id,j.station,j.stage,(j.daysInLab||0).toFixed(1),j.firstSeen?new Date(j.firstSeen).toISOString():'',j.lastSeen?new Date(j.lastSeen).toISOString():'',j.coatType||'',j.rush||'N',j.hasBreakage?'Y':'N'].join(","));
    const blob=new Blob([[hdrs.join(","),...rows].join("\n")],{type:"text/csv"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`lab-analytics-${range}-${new Date().toISOString().slice(0,10)}.csv`;a.click();
  };

  // ── Top bar ──
  const topBar=(
    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:18,flexWrap:"wrap"}}>
      {[{id:"overview",icon:"\u25C9",label:"Overview"},{id:"by-stage",icon:"\uD83C\uDFED",label:"By Stage"},
        {id:"oven",icon:"\uD83C\uDF21",label:"Oven Runs"},{id:"jobs",icon:"\uD83D\uDCCB",label:"Job Log"}].map(s=>(
        <button key={s.id} onClick={()=>setSub(s.id)}
          style={{background:sub===s.id?T.blueDark:"transparent",border:`1px solid ${sub===s.id?T.blue:"transparent"}`,
          borderRadius:8,padding:"9px 18px",cursor:"pointer",color:sub===s.id?"#93C5FD":T.textMuted,
          fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:7,fontFamily:"'DM Sans',sans-serif",transition:"all 0.2s"}}>
          {s.icon} {s.label}
        </button>
      ))}
      <div style={{marginLeft:"auto",display:"flex",gap:5,alignItems:"center"}}>
        <span style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1}}>RANGE</span>
        {["7d","30d","90d","all"].map(r=>(
          <button key={r} onClick={()=>setRange(r)} style={{padding:"5px 10px",borderRadius:5,fontSize:10,fontFamily:mono,fontWeight:700,cursor:"pointer",
            background:range===r?T.amberDark:"transparent",border:`1px solid ${range===r?T.amber:T.border}`,color:range===r?T.amber:T.textDim}}>
            {r==="all"?"All":r}
          </button>
        ))}
        <button onClick={exportCSV} style={{padding:"5px 12px",background:"transparent",border:`1px solid ${T.blue}`,borderRadius:5,color:T.blue,fontSize:10,fontFamily:mono,fontWeight:700,cursor:"pointer",marginLeft:4}}>{"\u2B07"} CSV</button>
      </div>
    </div>
  );

  if(analyticsLoading&&!analytics) return <div>{topBar}<div style={{textAlign:"center",padding:60,color:T.textMuted}}>Loading analytics from DVI trace...</div></div>;

  return(
    <div>
      {topBar}

      {/* ══ OVERVIEW ══ */}
      {sub==="overview"&&(
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          {/* KPI strip */}
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <KPICard label="Active WIP"      value={totalActive}                sub="jobs in lab now"        accent={T.blue}/>
            <KPICard label="Incoming"         value={incoming}                   sub="INHSE FIN + SF"         accent={T.cyan}/>
            <KPICard label={`Shipped (${range})`} value={totShipped.toLocaleString()} sub={`avg ${daily.length?Math.round(totShipped/daily.length):0}/day`} accent={T.green}/>
            <KPICard label="Avg Cycle Time"   value={`${cycleTime.avg||0}d`}    sub={`median ${cycleTime.median||0}d, P90 ${cycleTime.p90||0}d`} accent={T.amber}/>
            <KPICard label="Breakage"         value={totBreakage}               sub={`${range} period`}       accent={T.red}/>
            <KPICard label="Oven Runs"        value={of_.length}                sub={ovenOk?"from timer app":"no server"} accent={T.orange}/>
          </div>

          {/* Daily volume + WIP by stage side-by-side */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <Card>
              <SectionHeader right={<span style={{fontFamily:mono,fontSize:9,color:T.textDim}}>blue=incoming, green=shipped</span>}>Daily Throughput</SectionHeader>
              <BarChart data={daily.slice(-14).map(d=>({...d,label:d.date.slice(5),color:T.blue}))} labelKey="label" valueKey="incoming" colorKey="color" color2Key="shipped" height={52}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,fontFamily:mono,marginTop:6}}>
                <span>Avg {avgIncoming} incoming/day</span>
                <span>Peak {Math.max(...daily.map(d=>d.incoming),0)}/day</span>
              </div>
            </Card>

            <Card>
              <SectionHeader>WIP by Stage</SectionHeader>
              {stages.map(([stage,count])=>{
                const pct=totalWIP?Math.round(count/totalWIP*100):0;
                const color=STAGE_COLORS[stage]||T.textDim;
                return(
                  <div key={stage} style={{marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:color,flexShrink:0}}/>
                        <span style={{fontSize:12,color:T.text,fontWeight:600}}>{stage}</span>
                      </div>
                      <div style={{display:"flex",gap:10,fontFamily:mono,fontSize:11}}>
                        <span style={{color,fontWeight:800}}>{count}</span>
                        <span style={{color:T.textDim,minWidth:28}}>{pct}%</span>
                      </div>
                    </div>
                    <div style={{height:5,background:T.bg,borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:3,transition:"width 0.4s"}}/>
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>

          {/* Daily throughput grid */}
          <Card>
            <SectionHeader right={<span style={{fontFamily:mono,fontSize:9,color:T.textDim}}>jobs incoming per day</span>}>Daily Incoming Volume</SectionHeader>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:10}}>
              {daily.slice(-14).map((d,i)=>(
                <div key={i} style={{textAlign:"center",padding:"10px 6px",background:T.bg,borderRadius:8,border:`1px solid ${d.incoming>0?T.border:"transparent"}`}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginBottom:4}}>{d.date.slice(5)}</div>
                  <div style={{fontSize:20,fontWeight:800,color:d.incoming>0?T.cyan:T.textDim,fontFamily:mono,lineHeight:1}}>
                    {d.incoming>0?d.incoming.toLocaleString():"\u2014"}
                  </div>
                  <div style={{fontSize:9,color:T.green,fontFamily:mono,marginTop:2}}>{d.shipped} shipped</div>
                </div>
              ))}
            </div>
          </Card>

          {/* Cycle time + operators */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <Card>
              <SectionHeader>Cycle Time Distribution</SectionHeader>
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14}}>
                <div style={{textAlign:"center",padding:14,background:T.bg,borderRadius:8}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:4}}>AVERAGE</div>
                  <div style={{fontSize:28,fontWeight:900,color:T.blue,fontFamily:mono}}>{cycleTime.avg||0}<span style={{fontSize:12}}>d</span></div>
                </div>
                <div style={{textAlign:"center",padding:14,background:T.bg,borderRadius:8}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:4}}>MEDIAN</div>
                  <div style={{fontSize:28,fontWeight:900,color:T.green,fontFamily:mono}}>{cycleTime.median||0}<span style={{fontSize:12}}>d</span></div>
                </div>
                <div style={{textAlign:"center",padding:14,background:T.bg,borderRadius:8}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:4}}>P90</div>
                  <div style={{fontSize:28,fontWeight:900,color:cycleTime.p90>5?T.red:T.amber,fontFamily:mono}}>{cycleTime.p90||0}<span style={{fontSize:12}}>d</span></div>
                </div>
              </div>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,textAlign:"center",marginTop:8}}>{cycleTime.samples||0} shipped jobs sampled</div>
            </Card>

            <Card>
              <SectionHeader>Top Operators Today</SectionHeader>
              {topOperators.length===0?(
                <div style={{textAlign:"center",padding:20,color:T.textDim,fontSize:12}}>No operator data today</div>
              ):(
                <div style={{display:"flex",flexDirection:"column",gap:6}}>
                  {topOperators.slice(0,10).map((op,i)=>(
                    <div key={op.operator} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 10px",background:i<3?`${T.amber}08`:T.bg,borderRadius:6,border:`1px solid ${i<3?`${T.amber}30`:T.border}`}}>
                      <span style={{fontSize:12,fontWeight:900,color:i===0?T.amber:i<3?"#93C5FD":T.textDim,fontFamily:mono,minWidth:22}}>{i+1}.</span>
                      <span style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:mono}}>{op.operator}</span>
                      <span style={{marginLeft:"auto",fontSize:13,fontWeight:800,color:T.cyan,fontFamily:mono}}>{op.events}</span>
                      <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{op.topStation}</span>
                    </div>
                  ))}
                </div>
              )}
            </Card>
          </div>
        </div>
      )}

      {/* ══ BY STAGE ══ */}
      {sub==="by-stage"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {/* Top stations table */}
          <Card>
            <SectionHeader right={<span style={{fontFamily:mono,fontSize:9,color:T.textDim}}>active WIP only</span>}>Jobs by Station</SectionHeader>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10}}>
              {topStations.map(s=>{
                const pct=totalActive?Math.round(s.jobs/totalActive*100):0;
                const isIncoming=s.station.includes('INHSE');
                const isError=s.station.includes('BREAKAGE')||s.station.includes('FAIL')||s.station.includes('NE LENS')||s.station.includes('NE FRMS');
                const color=isError?T.red:isIncoming?T.cyan:T.blue;
                return(
                  <div key={s.station} style={{padding:"12px 14px",background:T.bg,borderRadius:8,border:`1px solid ${T.border}`,borderLeft:`4px solid ${color}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <span style={{fontSize:12,fontWeight:700,color:T.text,fontFamily:mono}}>{s.station}</span>
                      <span style={{fontSize:18,fontWeight:900,color,fontFamily:mono}}>{s.jobs}</span>
                    </div>
                    <div style={{height:4,background:T.card,borderRadius:2,overflow:"hidden",marginTop:6}}>
                      <div style={{height:"100%",width:`${Math.min(pct*2,100)}%`,background:color,borderRadius:2}}/>
                    </div>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginTop:3}}>{pct}% of WIP</div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Coating WIP breakdown */}
          <Card>
            <SectionHeader>WIP by Coating Type</SectionHeader>
            {coatEntries.length===0?(
              <div style={{textAlign:"center",padding:20,color:T.textDim,fontSize:12}}>No coating data available</div>
            ):(
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:12}}>
                {coatEntries.map(([ct,data])=>{
                  const color=COATING_COLORS[ct]||T.textDim;
                  const pct=totalCoatWIP?Math.round(data.total/totalCoatWIP*100):0;
                  return(
                    <Card key={ct} style={{borderTop:`3px solid ${color}`,padding:14}}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:color}}/>
                        <span style={{fontSize:13,fontWeight:700,color:T.text}}>{ct}</span>
                        <span style={{marginLeft:"auto",fontSize:18,fontWeight:900,color,fontFamily:mono}}>{data.total}</span>
                      </div>
                      <div style={{height:5,background:T.bg,borderRadius:3,overflow:"hidden",marginBottom:8}}>
                        <div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:3}}/>
                      </div>
                      <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{pct}% of coating WIP</div>
                      {Object.entries(data.stages||{}).sort((a,b)=>b[1]-a[1]).slice(0,4).map(([stage,cnt])=>(
                        <div key={stage} style={{display:"flex",justifyContent:"space-between",fontSize:10,fontFamily:mono,marginTop:3}}>
                          <span style={{color:T.textMuted}}>{stage}</span>
                          <span style={{color:T.text,fontWeight:700}}>{cnt}</span>
                        </div>
                      ))}
                    </Card>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Stage flow summary */}
          <Card>
            <SectionHeader>Stage Summary</SectionHeader>
            <div style={{display:"flex",gap:10,flexWrap:"wrap"}}>
              {stages.map(([stage,count])=>{
                const color=STAGE_COLORS[stage]||T.textDim;
                return(
                  <div key={stage} style={{textAlign:"center",padding:"14px 18px",background:T.bg,borderRadius:10,border:`1px solid ${T.border}`,borderTop:`3px solid ${color}`,minWidth:100}}>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:4}}>{stage}</div>
                    <div style={{fontSize:26,fontWeight:900,color,fontFamily:mono,lineHeight:1}}>{count}</div>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginTop:3}}>{totalWIP?Math.round(count/totalWIP*100):0}%</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </div>
      )}

      {/* ══ OVEN RUNS ══ */}
      {sub==="oven"&&(
        <div style={{display:"flex",flexDirection:"column",gap:18}}>
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 16px",background:T.card,border:`1px solid ${ovenOk?T.green:T.border}`,borderRadius:8}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:ovenOk?T.green:T.textDim,boxShadow:ovenOk?`0 0 8px ${T.green}`:""}}/>
            <span style={{fontFamily:mono,fontSize:11,color:ovenOk?T.green:T.textDim,fontWeight:700}}>
              {ovenOk?`Oven Timer Server connected \u2014 ${ovenRuns.length} runs on record`:`Not connected \u2014 start oven-timer-server.js`}
            </span>
          </div>

          {ovenStats&&(
            <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
              <KPICard label="Total Oven Runs"   value={ovenStats.totalRuns}             sub="all time"            accent={T.orange}/>
              <KPICard label="Today's Runs"       value={ovenStats.todayRuns}             sub="completed today"     accent={T.amber}/>
              <KPICard label="Today Oven Hours"   value={`${ovenStats.todayHours}h`}     sub="dwell time today"    accent={T.amber}/>
              <KPICard label="Overtime Runs"      value={ovenStats.overtimeRuns}          sub="> 2 min over target" accent={T.red}/>
            </div>
          )}

          {(ovenStats?.coatingStats||[]).length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:12}}>
              {ovenStats.coatingStats.sort((a,b)=>b.count-a.count).map(c=>{
                const color=COATING_COLORS[c.coating]||T.textDim;
                return(
                  <Card key={c.coating} style={{borderTop:`3px solid ${color}`}}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:color}}/>
                      <span style={{fontSize:12,fontWeight:700,color:T.text}}>{c.coating}</span>
                    </div>
                    <div style={{fontSize:32,fontWeight:900,color,fontFamily:mono,lineHeight:1}}>{c.count}</div>
                    <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:8}}>oven runs</div>
                    <div style={{fontFamily:mono,fontSize:11,display:"flex",flexDirection:"column",gap:3}}>
                      <div><span style={{color:T.textDim}}>Avg </span><strong style={{color:T.text}}>{fmtSecs(c.avgSecs)}</strong></div>
                      <div><span style={{color:T.textDim}}>Min </span><strong style={{color:T.green}}>{fmtSecs(c.minSecs)}</strong></div>
                      <div><span style={{color:T.textDim}}>Max </span><strong style={{color:T.red}}>{fmtSecs(c.maxSecs)}</strong></div>
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          <Card style={{padding:0}}>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:13,fontWeight:700,color:T.text}}>Oven Run Log</span>
              <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{of_.length} runs in range</span>
            </div>
            {of_.length===0?(
              <div style={{textAlign:"center",padding:40,fontFamily:mono,fontSize:11,color:T.textDim}}>
                {ovenOk?"No oven runs in selected date range":"Start oven-timer-server.js and run some batches to see data here"}
              </div>
            ):(
              <div style={{overflowX:"auto",maxHeight:440,overflowY:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead style={{position:"sticky",top:0,background:T.card,zIndex:1}}>
                    <tr>
                      {["Oven","Rack","Coating","Started","Target","Actual","Variance","Operator"].map(h=>(
                        <th key={h} style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {of_.slice(0,300).map(r=>{
                      const vc=r.variance===null?T.textDim:r.variance>120?T.red:r.variance<-120?T.green:T.textDim;
                      const color=COATING_COLORS[r.coating]||T.textDim;
                      return(
                        <tr key={r.id} style={{borderBottom:`1px solid ${T.border}`}}>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.amber,fontWeight:700}}>{r.ovenName||r.machine||'?'}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.text}}>{r.rackLabel||r.rack||'?'}</td>
                          <td style={{padding:"8px 12px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:5}}>
                              <div style={{width:6,height:6,borderRadius:"50%",background:color,flexShrink:0}}/>
                              <span style={{fontFamily:mono,fontSize:11,color,fontWeight:700}}>{r.coating||'\u2014'}</span>
                            </div>
                          </td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim,whiteSpace:"nowrap"}}>{fmtDate(r.startedAt)}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim}}>{r.targetSecs>0?fmtSecs(r.targetSecs):"\u2014"}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,fontWeight:700,color:T.text}}>{fmtSecs(r.actualSecs)}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,fontWeight:700,color:vc}}>
                            {r.variance===null?"\u2014":(r.variance>0?"+":"")+fmtSecs(r.variance)}
                          </td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{r.operator||"\u2014"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </Card>
        </div>
      )}

      {/* ══ JOB LOG ══ */}
      {sub==="jobs"&&(
        <div>
          <Card style={{padding:0}}>
            <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:8}}>
              <span style={{fontSize:13,fontWeight:700,color:T.text}}>DVI Job Log</span>
              <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{(dviJobs||[]).length} total jobs</span>
            </div>
            <div style={{overflowX:"auto",maxHeight:620,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{position:"sticky",top:0,background:T.card,zIndex:1}}>
                  <tr>
                    {["Job ID","Station","Stage","Days","Coating","Rush","Operator","Events"].map(h=>(
                      <th key={h} style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(dviJobs||[]).filter(j=>j.status!=='SHIPPED'&&j.status!=='CANCELED').sort((a,b)=>(b.daysInLab||0)-(a.daysInLab||0)).slice(0,500).map(j=>{
                    const isRush=j.rush==='Y'||j.Rush==='Y';
                    const hasBreak=j.hasBreakage;
                    const days=(j.daysInLab||0).toFixed(1);
                    const daysColor=j.daysInLab>5?T.red:j.daysInLab>2?T.amber:T.textDim;
                    const stageColor=STAGE_COLORS[j.stage]||T.textDim;
                    return(
                      <tr key={j.job_id} style={{borderBottom:`1px solid ${T.border}`}}
                        onMouseEnter={e=>e.currentTarget.style.background=T.cardHover||'#1a1a2e'}
                        onMouseLeave={e=>e.currentTarget.style.background=""}>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.text,fontWeight:700}}>
                          {j.job_id}
                          {isRush&&<span style={{marginLeft:6,fontSize:9,background:`${T.red}20`,color:T.red,padding:"1px 5px",borderRadius:3,fontWeight:700}}>RUSH</span>}
                          {hasBreak&&<span style={{marginLeft:4,fontSize:9,background:`${T.amber}20`,color:T.amber,padding:"1px 5px",borderRadius:3,fontWeight:700}}>BRK</span>}
                        </td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textMuted}}>{j.station}</td>
                        <td style={{padding:"8px 12px"}}>
                          <span style={{fontSize:10,fontWeight:700,color:stageColor,fontFamily:mono,padding:"2px 8px",background:`${stageColor}15`,borderRadius:4}}>{j.stage}</span>
                        </td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:12,fontWeight:800,color:daysColor}}>{days}d</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:COATING_COLORS[j.coatType]||T.textDim,fontWeight:600}}>{j.coatType||'\u2014'}</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:isRush?T.red:T.textDim}}>{isRush?'YES':'N'}</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{j.operator||'\u2014'}</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{j.eventCount||0}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {(dviJobs||[]).length>500&&<div style={{padding:"10px 16px",fontFamily:mono,fontSize:10,color:T.textDim}}>Showing 500 of {dviJobs.length} active jobs</div>}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
