// AnalyticsTab - Extracted from App.jsx
// Provides analytics views: Overview, By Coating, Oven Runs, Full Batch Log
import { useState, useEffect, useMemo } from 'react';
import { T, mono, COATING_TYPES, MACHINES, pick } from '../../constants';
import { Card, SectionHeader } from '../shared';

// ── Local color map (flat colors for chart rendering) ───────────────────────────
const COATING_COLORS = {
  "AR":          "#3B82F6",
  "Blue Cut":    "#06B6D4",
  "Mirror":      "#A855F7",
  "Transitions": "#F97316",
  "Polarized":   "#EC4899",
  "Hard Coat":   "#84CC16",
};

// ── Helper: generate mock historical batches ────────────────────────────────────
function genHistoricalBatches(numDays=30){
  const out=[]; const now=Date.now(); let n=1;
  const targets={"AR":50,"Blue Cut":45,"Mirror":70,"Transitions":75,"Polarized":60,"Hard Coat":48};
  for(let d=numDays;d>=0;d--){
    const dayStart=now-d*86400000;
    const perDay=Math.floor(Math.random()*8)+4;
    for(let b=0;b<perDay;b++){
      const coating=pick(COATING_TYPES);
      const machine=pick(MACHINES);
      const capacity=140;
      const lenses=Math.floor(capacity*(0.6+Math.random()*0.4));
      const targetMins=targets[coating]||60;
      const actualMins=Math.round(targetMins*(0.85+Math.random()*0.3));
      const startedAt=dayStart+b*Math.floor(86400000/perDay)+Math.floor(Math.random()*3600000);
      out.push({
        id:`CB${String(n++).padStart(4,"0")}`,
        machine,coating,lenses,capacity,targetMins,actualMins,
        startedAt,endedAt:startedAt+actualMins*60000,
        operator:pick(["Mike S.","Sarah K.","James T.","Ana R."]),
        rush:Math.random()<0.08,
        passRate:Math.round(Math.random()*10+88),
      });
    }
  }
  return out.sort((a,b)=>b.startedAt-a.startedAt);
}

// ── Simple SVG bar chart ────────────────────────────────────────────────────────
function BarChart({data,height=56,labelKey,valueKey,colorKey}){
  if(!data||!data.length)return null;
  const max=Math.max(...data.map(d=>d[valueKey]),1);
  const w=100/data.length;
  return(
    <svg width="100%" height={height+28} style={{overflow:"visible"}}>
      {data.map((d,i)=>{
        const bh=Math.max(3,(d[valueKey]/max)*(height-4));
        const x=i*w+w*0.12; const bw=w*0.76;
        const color=d[colorKey]||T.blue;
        return(
          <g key={i}>
            <rect x={`${x}%`} y={height-bh} width={`${bw}%`} height={bh} rx={2} fill={color} opacity={0.85}/>
            <text x={`${x+bw/2}%`} y={height+14} textAnchor="middle" fontSize={9} fill={T.textDim} fontFamily="'JetBrains Mono',monospace">{d[labelKey]}</text>
            <text x={`${x+bw/2}%`} y={height-bh-5} textAnchor="middle" fontSize={9} fill={color} fontFamily="'JetBrains Mono',monospace" fontWeight="bold">{d[valueKey]}</text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Tiny inline sparkline ───────────────────────────────────────────────────────
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

// ── Pill component ──────────────────────────────────────────────────────────────
const Pill = ({children,color,bg})=>(
  <span style={{fontSize:11,fontWeight:700,padding:"3px 10px",borderRadius:5,background:bg||`${color}20`,color,fontFamily:mono,textTransform:"uppercase",whiteSpace:"nowrap"}}>{children}</span>
);

// ── KPI Card component ──────────────────────────────────────────────────────────
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

// ══════════════════════════════════════════════════════════════════════════════
// AnalyticsTab Component
// ══════════════════════════════════════════════════════════════════════════════
export default function AnalyticsTab({batches,trays,ovenServerUrl,settings}){
  const [sub,setSub]=useState("overview");
  const [range,setRange]=useState("30d");
  const [filterCoating,setFilterCoating]=useState("All");
  const [sortCol,setSortCol]=useState("startedAt");
  const [sortDir,setSortDir]=useState("desc");
  const [ovenRuns,setOvenRuns]=useState([]);
  const [ovenStats,setOvenStats]=useState(null);
  const [ovenOk,setOvenOk]=useState(false);

  // Get coater machines from settings (fallback to MACHINES constant)
  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  // Static historical data (replace with API)
  const [history]=useState(()=>genHistoricalBatches(30));

  // Fetch oven server
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

  // Date cutoff
  const daysMap={"7d":7,"30d":30,"90d":90,"all":9999};
  const cutoff=Date.now()-daysMap[range]*86400000;
  const inRange=r=>r.startedAt>=cutoff;
  const hf=history.filter(inRange);
  const of_=ovenRuns.filter(inRange);

  // ── Per-coating aggregates ──────────────────────────
  const byCoating=useMemo(()=>{
    const map={};
    COATING_TYPES.forEach(ct=>{
      const rows=hf.filter(b=>b.coating===ct);
      const oRows=of_.filter(r=>r.coating===ct);
      map[ct]={
        ct,color:COATING_COLORS[ct]||T.blue,
        batches:rows.length,
        lenses:rows.reduce((s,b)=>s+b.lenses,0),
        avgLenses:rows.length?Math.round(rows.reduce((s,b)=>s+b.lenses,0)/rows.length):0,
        totalMins:rows.reduce((s,b)=>s+b.actualMins,0),
        avgMins:rows.length?Math.round(rows.reduce((s,b)=>s+b.actualMins,0)/rows.length):0,
        avgFill:rows.length?Math.round(rows.reduce((s,b)=>s+(b.lenses/b.capacity)*100,0)/rows.length):0,
        avgPass:rows.length?Math.round(rows.reduce((s,b)=>s+b.passRate,0)/rows.length):0,
        ovenRuns:oRows.length,
        ovenAvgSecs:oRows.length?Math.round(oRows.reduce((s,r)=>s+r.actualSecs,0)/oRows.length):0,
        rows,oRows,
      };
    });
    return map;
  },[hf,of_]);

  // ── Totals ──────────────────────────────────────────
  const totBatches=hf.length;
  const totLenses=hf.reduce((s,b)=>s+b.lenses,0);
  const totHours=(hf.reduce((s,b)=>s+b.actualMins,0)/60).toFixed(1);
  const avgFill=hf.length?Math.round(hf.reduce((s,b)=>s+(b.lenses/b.capacity)*100,0)/hf.length):0;
  const totOvenRuns=of_.length;
  const totOvenHours=(of_.reduce((s,r)=>s+r.actualSecs,0)/3600).toFixed(1);

  // ── 14-day daily trend ──────────────────────────────
  const daily=useMemo(()=>Array.from({length:14},(_,i)=>{
    const d=new Date(); d.setHours(0,0,0,0); d.setDate(d.getDate()-(13-i));
    const nd=new Date(d); nd.setDate(nd.getDate()+1);
    const rows=hf.filter(b=>b.startedAt>=d.getTime()&&b.startedAt<nd.getTime());
    return{
      label:d.toLocaleDateString([],{month:"numeric",day:"numeric"}),
      batches:rows.length,
      lenses:rows.reduce((s,b)=>s+b.lenses,0),
      color:T.blue,
    };
  }),[hf]);

  // ── Batch log ───────────────────────────────────────
  const logRows=useMemo(()=>{
    let rows=filterCoating==="All"?[...hf]:hf.filter(b=>b.coating===filterCoating);
    rows.sort((a,b)=>{
      const av=a[sortCol],bv=b[sortCol];
      return typeof av==="string"
        ?(sortDir==="asc"?av.localeCompare(bv):bv.localeCompare(av))
        :(sortDir==="asc"?av-bv:bv-av);
    });
    return rows;
  },[hf,filterCoating,sortCol,sortDir]);

  const toggleSort=col=>{ if(sortCol===col)setSortDir(d=>d==="asc"?"desc":"asc"); else{setSortCol(col);setSortDir("desc");} };

  const fmtMins=m=>`${Math.floor(m/60)}h ${m%60}m`;
  const fmtSecs=s=>{const m=Math.floor(Math.abs(s)/60),sc=Math.abs(s)%60;return`${s<0?"-":""}${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")}`;};
  const fmtDate=ts=>new Date(ts).toLocaleDateString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"});

  const SHdr=({col,children,align="left"})=>(
    <th onClick={()=>toggleSort(col)} style={{fontFamily:mono,fontSize:9,color:sortCol===col?T.amber:T.textDim,letterSpacing:1.5,
      textAlign:align,padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase",whiteSpace:"nowrap",cursor:"pointer",userSelect:"none"}}>
      {children}{sortCol===col?<span style={{marginLeft:3}}>{sortDir==="asc"?"▲":"▼"}</span>:null}
    </th>
  );

  const exportCSV=()=>{
    const hdrs=["Batch ID","Machine","Coating","Lenses","Fill%","Actual(min)","Target(min)","Variance(min)","Started","Operator","Pass%","Rush"];
    const rows=logRows.map(b=>[b.id,b.machine,b.coating,b.lenses,Math.round(b.lenses/b.capacity*100),b.actualMins,b.targetMins,b.actualMins-b.targetMins,new Date(b.startedAt).toISOString(),b.operator,b.passRate,b.rush?"YES":"NO"].join(","));
    const blob=new Blob([[hdrs.join(","),...rows].join("\n")],{type:"text/csv"});
    const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=`coating-batches-${range}-${new Date().toISOString().slice(0,10)}.csv`;a.click();
  };

  // ── Shared top bar ──────────────────────────────────
  const topBar=(
    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:18,flexWrap:"wrap"}}>
      {[{id:"overview",icon:"◉",label:"Overview"},{id:"by-coating",icon:"🎨",label:"By Coating"},
        {id:"oven",icon:"🌡",label:"Oven Runs"},{id:"log",icon:"📋",label:"Full Batch Log"}].map(s=>(
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
        <button onClick={exportCSV} style={{padding:"5px 12px",background:"transparent",border:`1px solid ${T.blue}`,borderRadius:5,color:T.blue,fontSize:10,fontFamily:mono,fontWeight:700,cursor:"pointer",marginLeft:4}}>⬇ CSV</button>
      </div>
    </div>
  );

  return(
    <div>
      {topBar}

      {/* ══ OVERVIEW ══ */}
      {sub==="overview"&&(
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          {/* KPI strip */}
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <KPICard label="Coating Batches"  value={totBatches}              sub={range==="all"?"all time":`last ${range}`} accent={T.blue}/>
            <KPICard label="Total Lenses"     value={totLenses.toLocaleString()} sub="through coater"                       accent={T.cyan}/>
            <KPICard label="Machine Hours"    value={`${totHours}h`}          sub="total coating time"                      accent={T.amber}/>
            <KPICard label="Avg Fill Rate"    value={`${avgFill}%`}           sub="of 140-lens capacity"                    accent={avgFill>80?T.green:T.amber}/>
            <KPICard label="Oven Runs"        value={totOvenRuns}             sub={ovenOk?"from timer app":"no server"}     accent={T.orange}/>
            <KPICard label="Oven Hours"       value={`${totOvenHours}h`}      sub="total dwell time"                        accent={T.orange}/>
          </div>

          {/* Daily volume + coating split side-by-side */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <Card>
              <SectionHeader right={<span style={{fontFamily:mono,fontSize:9,color:T.textDim}}>14-day view</span>}>Daily Batch Volume</SectionHeader>
              <BarChart data={daily} labelKey="label" valueKey="batches" colorKey="color" height={52}/>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,fontFamily:mono,marginTop:6}}>
                <span>Avg {daily.length?Math.round(daily.reduce((s,d)=>s+d.batches,0)/daily.length):0} batches/day</span>
                <span>Peak {Math.max(...daily.map(d=>d.batches),0)}/day</span>
              </div>
            </Card>

            <Card>
              <SectionHeader>Batches by Coating Type</SectionHeader>
              {COATING_TYPES.map(ct=>{
                const d=byCoating[ct];
                const pct=totBatches?Math.round(d.batches/totBatches*100):0;
                return(
                  <div key={ct} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:3}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <div style={{width:8,height:8,borderRadius:"50%",background:d.color,flexShrink:0}}/>
                        <span style={{fontSize:12,color:T.text,fontWeight:600}}>{ct}</span>
                      </div>
                      <div style={{display:"flex",gap:10,fontFamily:mono,fontSize:11}}>
                        <span style={{color:d.color,fontWeight:800}}>{d.batches}</span>
                        <span style={{color:T.textDim,minWidth:28}}>{pct}%</span>
                        <span style={{color:T.textDim}}>{d.lenses.toLocaleString()} lenses</span>
                      </div>
                    </div>
                    <div style={{height:5,background:T.bg,borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${pct}%`,background:d.color,borderRadius:3,transition:"width 0.4s"}}/>
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>

          {/* 14-day lens throughput grid */}
          <Card>
            <SectionHeader right={<span style={{fontFamily:mono,fontSize:9,color:T.textDim}}>lenses per day</span>}>Daily Lens Throughput</SectionHeader>
            <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:10}}>
              {daily.slice(-14).map((d,i)=>(
                <div key={i} style={{textAlign:"center",padding:"10px 6px",background:T.bg,borderRadius:8,border:`1px solid ${d.batches>0?T.border:"transparent"}`}}>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginBottom:4}}>{d.label}</div>
                  <div style={{fontSize:20,fontWeight:800,color:d.lenses>0?T.cyan:T.textDim,fontFamily:mono,lineHeight:1}}>
                    {d.lenses>0?d.lenses.toLocaleString():"—"}
                  </div>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginTop:2}}>{d.batches} batch{d.batches!==1?"es":""}</div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ══ BY COATING TYPE ══ */}
      {sub==="by-coating"&&(
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          {COATING_TYPES.map(ct=>{
            const d=byCoating[ct];
            if(!d.batches)return null;
            // 7-day batch trend
            const trend=Array.from({length:7},(_,i)=>{
              const day=new Date();day.setHours(0,0,0,0);day.setDate(day.getDate()-(6-i));
              const nxt=new Date(day);nxt.setDate(nxt.getDate()+1);
              return d.rows.filter(b=>b.startedAt>=day.getTime()&&b.startedAt<nxt.getTime()).length;
            });
            const varMins=d.avgMins-({"AR":50,"Blue Cut":45,"Mirror":70,"Transitions":75,"Polarized":60,"Hard Coat":48}[ct]||60);
            const varColor=varMins>5?T.red:varMins<-5?T.green:T.textDim;
            return(
              <Card key={ct} style={{borderLeft:`4px solid ${d.color}`}}>
                {/* Header row */}
                <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:14}}>
                  <div style={{width:12,height:12,borderRadius:"50%",background:d.color,flexShrink:0}}/>
                  <span style={{fontSize:16,fontWeight:900,color:T.text}}>{ct}</span>
                  {d.rows.filter(b=>b.rush).length>0&&<Pill color={T.red}>{d.rows.filter(b=>b.rush).length} RUSH</Pill>}
                </div>

                {/* Stats grid */}
                <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:14,marginBottom:14}}>
                  {[
                    {label:"BATCHES",     value:d.batches,             color:d.color,      suffix:""},
                    {label:"TOTAL LENSES",value:d.lenses.toLocaleString(), color:T.text,  suffix:""},
                    {label:"AVG LENSES",  value:d.avgLenses,           color:T.text,       suffix:"/batch"},
                    {label:"MACHINE HRS", value:(d.totalMins/60).toFixed(1), color:T.amber, suffix:"h"},
                    {label:"AVG TIME",    value:d.avgMins,             color:T.amber,      suffix:"m"},
                    {label:"AVG FILL",    value:d.avgFill,             color:d.avgFill>80?T.green:T.amber, suffix:"%"},
                  ].map(s=>(
                    <div key={s.label} style={{textAlign:"center",padding:"10px 4px",background:T.bg,borderRadius:8}}>
                      <div style={{fontSize:8,color:T.textDim,fontFamily:mono,letterSpacing:1.5,marginBottom:4}}>{s.label}</div>
                      <div style={{fontSize:22,fontWeight:900,color:s.color,fontFamily:mono,lineHeight:1}}>{s.value}<span style={{fontSize:11}}>{s.suffix}</span></div>
                    </div>
                  ))}
                </div>

                {/* Bottom row: machine split + oven data + sparkline */}
                <div style={{display:"flex",gap:14,alignItems:"flex-start",paddingTop:12,borderTop:`1px solid ${T.border}`}}>
                  {/* Machine breakdown */}
                  <div style={{flex:1}}>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:6}}>BY MACHINE</div>
                    {coaterMachines.map(m=>{
                      const cnt=d.rows.filter(b=>b.machine===m).length;
                      const pct=d.batches?Math.round(cnt/d.batches*100):0;
                      if(!cnt)return null;
                      return(
                        <div key={m} style={{marginBottom:5}}>
                          <div style={{display:"flex",justifyContent:"space-between",marginBottom:2}}>
                            <span style={{fontFamily:mono,fontSize:10,color:T.textMuted}}>{m}</span>
                            <span style={{fontFamily:mono,fontSize:10,color:d.color,fontWeight:700}}>{cnt} <span style={{color:T.textDim}}>({pct}%)</span></span>
                          </div>
                          <div style={{height:4,background:T.bg,borderRadius:2,overflow:"hidden"}}>
                            <div style={{height:"100%",width:`${pct}%`,background:d.color,borderRadius:2}}/>
                          </div>
                        </div>
                      );
                    })}
                  </div>

                  {/* Oven cross-ref */}
                  <div style={{flex:1,padding:"10px 12px",background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:8}}>OVEN RUNS</div>
                    <div style={{fontSize:28,fontWeight:900,color:T.orange,fontFamily:mono,lineHeight:1}}>{d.ovenRuns||"—"}</div>
                    <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginTop:2}}>
                      {d.ovenRuns>0?`avg ${fmtSecs(d.ovenAvgSecs)} per run`:ovenOk?"none recorded":"connect oven server"}
                    </div>
                    {d.ovenRuns>0&&d.batches>0&&(
                      <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginTop:4}}>
                        ratio <strong style={{color:T.text}}>{(d.ovenRuns/d.batches).toFixed(1)}</strong> oven runs/batch
                      </div>
                    )}
                    {varMins!==0&&(
                      <div style={{fontSize:10,fontWeight:700,color:varColor,fontFamily:mono,marginTop:4}}>
                        {varMins>0?"+":""}{varMins}m vs target avg
                      </div>
                    )}
                  </div>

                  {/* 7-day sparkline */}
                  <div style={{flex:1}}>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:4}}>7-DAY TREND</div>
                    <Spark values={trend} color={d.color} h={40}/>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:8,color:T.textDim,fontFamily:mono,marginTop:2}}>
                      <span>6d ago</span><span>today</span>
                    </div>
                    <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginTop:4}}>
                      avg <strong style={{color:T.text}}>{Math.round(trend.reduce((s,v)=>s+v,0)/7)}</strong> batches/day
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {/* ══ OVEN RUNS ══ */}
      {sub==="oven"&&(
        <div style={{display:"flex",flexDirection:"column",gap:18}}>
          {/* Server status */}
          <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 16px",background:T.card,border:`1px solid ${ovenOk?T.green:T.border}`,borderRadius:8}}>
            <div style={{width:8,height:8,borderRadius:"50%",background:ovenOk?T.green:T.textDim,boxShadow:ovenOk?`0 0 8px ${T.green}`:""}}/>
            <span style={{fontFamily:mono,fontSize:11,color:ovenOk?T.green:T.textDim,fontWeight:700}}>
              {ovenOk?`Oven Timer Server connected — ${ovenRuns.length} runs on record`:`Not connected — start oven-timer-server.js on the oven PC (${ovenServerUrl||"http://localhost:3002"})`}
            </span>
          </div>

          {/* KPIs from server */}
          {ovenStats&&(
            <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
              <KPICard label="Total Oven Runs"   value={ovenStats.totalRuns}               sub="all time"             accent={T.orange}/>
              <KPICard label="Today's Runs"       value={ovenStats.todayRuns}               sub="completed today"      accent={T.amber}/>
              <KPICard label="Today Oven Hours"   value={`${ovenStats.todayHours}h`}       sub="dwell time today"     accent={T.amber}/>
              <KPICard label="Overtime Runs"      value={ovenStats.overtimeRuns}            sub="> 2 min over target"  accent={T.red}/>
            </div>
          )}

          {/* Per-coating oven summary */}
          {(ovenStats?.coatingStats||[]).length>0&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(180px,1fr))",gap:12}}>
              {ovenStats.coatingStats.sort((a,b)=>b.count-a.count).map(c=>{
                const color=COATING_COLORS[c.coating]||T.textDim;
                const targetSecs=({"AR":50,"Blue Cut":45,"Mirror":70,"Transitions":75,"Polarized":60,"Hard Coat":48}[c.coating]||60)*60;
                const diff=targetSecs?(c.avgSecs-targetSecs):null;
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
                      {diff!==null&&<div style={{color:diff>120?T.red:diff<-120?T.green:T.textDim,fontWeight:700}}>{diff>0?"+":""}{fmtSecs(diff)} vs target</div>}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}

          {/* Oven run log table */}
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
                      {["Machine","Batch","Coating","Started","Target","Actual","Variance","Operator"].map(h=>(
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
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.amber,fontWeight:700}}>{r.machine}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.text}}>{r.batchId}</td>
                          <td style={{padding:"8px 12px"}}>
                            <div style={{display:"flex",alignItems:"center",gap:5}}>
                              <div style={{width:6,height:6,borderRadius:"50%",background:color,flexShrink:0}}/>
                              <span style={{fontFamily:mono,fontSize:11,color,fontWeight:700}}>{r.coating}</span>
                            </div>
                          </td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim,whiteSpace:"nowrap"}}>{fmtDate(r.startedAt)}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim}}>{r.targetSecs>0?fmtSecs(r.targetSecs):"—"}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,fontWeight:700,color:T.text}}>{fmtSecs(r.actualSecs)}</td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,fontWeight:700,color:vc}}>
                            {r.variance===null?"—":(r.variance>0?"+":"")+fmtSecs(r.variance)}
                          </td>
                          <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{r.operator||"—"}</td>
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

      {/* ══ FULL BATCH LOG ══ */}
      {sub==="log"&&(
        <div>
          {/* Coating filter chips */}
          <div style={{display:"flex",gap:5,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
            <span style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,lineHeight:"26px"}}>FILTER:</span>
            {["All",...COATING_TYPES].map(ct=>{
              const color=COATING_COLORS[ct]||T.blue;
              const cnt=ct==="All"?hf.length:byCoating[ct]?.batches||0;
              return(
                <button key={ct} onClick={()=>setFilterCoating(ct)} style={{padding:"4px 11px",borderRadius:5,fontSize:10,fontFamily:mono,fontWeight:700,cursor:"pointer",
                  background:filterCoating===ct?`${color}20`:"transparent",
                  border:`1px solid ${filterCoating===ct?color:T.border}`,
                  color:filterCoating===ct?color:T.textDim}}>
                  {ct} <span style={{opacity:0.6}}>({cnt})</span>
                </button>
              );
            })}
            <span style={{marginLeft:"auto",fontSize:10,color:T.textDim,fontFamily:mono}}>{logRows.length} batches</span>
          </div>

          <Card style={{padding:0}}>
            <div style={{overflowX:"auto",maxHeight:620,overflowY:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{position:"sticky",top:0,background:T.card,zIndex:1}}>
                  <tr>
                    <SHdr col="id">Batch</SHdr>
                    <SHdr col="machine">Machine</SHdr>
                    <SHdr col="coating">Coating</SHdr>
                    <SHdr col="lenses" align="right">Lenses</SHdr>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Fill</th>
                    <SHdr col="actualMins" align="right">Actual</SHdr>
                    <SHdr col="targetMins" align="right">Target</SHdr>
                    <th style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase"}}>Var</th>
                    <SHdr col="startedAt">Started</SHdr>
                    <SHdr col="passRate" align="right">Pass%</SHdr>
                    <SHdr col="operator">Operator</SHdr>
                  </tr>
                </thead>
                <tbody>
                  {logRows.slice(0,500).map(b=>{
                    const fill=Math.round(b.lenses/b.capacity*100);
                    const varMin=b.actualMins-b.targetMins;
                    const vc=varMin>5?T.red:varMin<-5?T.green:T.textDim;
                    const cc=COATING_COLORS[b.coating]||T.textDim;
                    return(
                      <tr key={b.id}
                        onMouseEnter={e=>e.currentTarget.style.background=T.cardHover}
                        onMouseLeave={e=>e.currentTarget.style.background=""}
                        style={{borderBottom:`1px solid ${T.border}`,transition:"background 0.1s"}}>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{b.id}</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.amber,fontWeight:700}}>{b.machine}</td>
                        <td style={{padding:"8px 12px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:5}}>
                            <div style={{width:7,height:7,borderRadius:"50%",background:cc,flexShrink:0}}/>
                            <span style={{fontFamily:mono,fontSize:11,color:cc,fontWeight:700}}>{b.coating}</span>
                          </div>
                        </td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:13,fontWeight:800,color:T.text,textAlign:"right"}}>{b.lenses}</td>
                        <td style={{padding:"8px 12px"}}>
                          <div style={{display:"flex",alignItems:"center",gap:5}}>
                            <div style={{width:48,height:5,background:T.bg,borderRadius:3,overflow:"hidden"}}>
                              <div style={{height:"100%",width:`${fill}%`,background:fill>80?T.green:T.amber,borderRadius:3}}/>
                            </div>
                            <span style={{fontFamily:mono,fontSize:10,color:fill>80?T.green:T.amber,fontWeight:700,minWidth:28}}>{fill}%</span>
                          </div>
                        </td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:12,fontWeight:800,color:T.text,textAlign:"right"}}>{b.actualMins}m</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim,textAlign:"right"}}>{b.targetMins}m</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,fontWeight:700,color:vc}}>{varMin>0?"+":""}{varMin}m</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim,whiteSpace:"nowrap"}}>{fmtDate(b.startedAt)}</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:12,fontWeight:700,textAlign:"right",color:b.passRate>93?T.green:b.passRate>88?T.amber:T.red}}>{b.passRate}%</td>
                        <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{b.operator}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {logRows.length>500&&<div style={{padding:"10px 16px",fontFamily:mono,fontSize:10,color:T.textDim}}>Showing 500 of {logRows.length} — export CSV for full set</div>}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
