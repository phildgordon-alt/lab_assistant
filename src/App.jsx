import { useState, useEffect, useCallback, useMemo, useRef } from "react";

const T = {
  bg: "#080C18", surface: "#0F1629", card: "#141B2D", cardHover: "#1A2340",
  border: "#1E293B", borderLight: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textDim: "#475569",
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

const TRAY_STATES = {
  IDLE: { label: "Idle", color: "#64748B", bg: "#1E293B" },
  BOUND: { label: "Bound", color: T.blue, bg: T.blueDark },
  ACTIVE: { label: "Active", color: T.green, bg: T.greenDark },
  COATING_STAGED: { label: "Staged", color: T.amber, bg: T.amberDark },
  COATING_IN_PROCESS: { label: "Coating", color: T.red, bg: T.redDark },
  RE_TRAY: { label: "Re-Tray", color: T.purple, bg: T.purpleDark },
  QC_HOLD: { label: "QC Hold", color: T.pink, bg: T.pinkDark },
  BROKEN: { label: "Broken", color: T.orange, bg: T.orangeDark },
  COMPLETE: { label: "Complete", color: T.lime, bg: T.limeDark },
};

const COATING_TYPES = ["AR", "Blue Cut", "Mirror", "Transitions", "Polarized", "Hard Coat"];
const MACHINES = ["Satis 1200", "Satis 1200-B", "Opticoat S"];
const DEFECT_TYPES = ["Crazing", "Pinholes", "Delamination", "Haze", "Scratches", "Color Shift", "Adhesion Fail"];
const BREAK_TYPES = ["Edge chip", "Surface scratch", "Coating fail", "Edging crack", "Assembly break", "Prescription error"];

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

const BATCH_STATES = { running: "RUNNING", hold: "HOLD", waiting: "WAITING", complete: "COMPLETE", idle: "IDLE", loading: "LOADING" };

// ── API Key helper — checks settings first, then env variable ────────────────
const getAnthropicApiKey = (settings) => {
  return settings?.anthropicApiKey || import.meta.env.VITE_ANTHROPIC_API_KEY || '';
};

// ── Gateway helper — calls MCP gateway or falls back to direct Anthropic ─────
const callGateway = async (settings, question, { onChunk, agent, userId = 'web-user', context } = {}) => {
  const gatewayUrl = settings?.gatewayUrl || 'http://localhost:3001';

  // If streaming with onChunk callback, use SSE endpoint
  if (onChunk) {
    const res = await fetch(`${gatewayUrl}/web/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question, agent, userId, context }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error(err.message || `Gateway error ${res.status}`);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let fullText = '';
    let agentName = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = decoder.decode(value, { stream: true });
      const lines = chunk.split('\n');

      for (const line of lines) {
        if (line.startsWith('event: ')) {
          // Skip event lines, data follows
        } else if (line.startsWith('data: ')) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.name) agentName = data.name;
            if (data.text) {
              fullText += data.text;
              onChunk(data.text);
            }
            if (data.message) throw new Error(data.message);
          } catch (e) {
            if (e.message && !e.message.includes('JSON')) throw e;
          }
        }
      }
    }

    return { response: fullText, agent: agentName };
  }

  // Non-streaming sync call
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

// ── DEFAULT SETTINGS — equipment categories and configuration ────────────────
const DEFAULT_SETTINGS = {
  pin: null,           // null = no PIN, otherwise 4-6 digit string
  pinEnabled: false,
  anthropicApiKey: '', // Claude API key for AI features (fallback if no gateway)
  gatewayUrl: 'http://localhost:3001', // MCP Gateway URL
  equipmentCategories: [
    { id: 'coaters', name: 'Coaters', icon: '🌡', color: '#F59E0B' },
    { id: 'ovens', name: 'Ovens', icon: '🔥', color: '#EF4444' },
    { id: 'cutters', name: 'Cutters', icon: '✂️', color: '#8B5CF6' },
    { id: 'polishers', name: 'Polishers', icon: '💿', color: '#06B6D4' },
    { id: 'generators', name: 'Generators', icon: '⚡', color: '#10B981' },
    { id: 'lasers', name: 'Lasers', icon: '📡', color: '#EC4899' },
    { id: 'blockers', name: 'Blockers', icon: '🔲', color: '#3B82F6' },
    { id: 'deblockers', name: 'De-blockers', icon: '🔳', color: '#64748B' },
    { id: 'tapers', name: 'Tapers', icon: '📐', color: '#84CC16' },
  ],
  equipment: [
    { id: 'eq1', categoryId: 'coaters', name: 'Satis 1200', serialNumber: '', location: 'Lab Floor 1' },
    { id: 'eq2', categoryId: 'coaters', name: 'Satis 1200-B', serialNumber: '', location: 'Lab Floor 1' },
    { id: 'eq3', categoryId: 'coaters', name: 'Opticoat S', serialNumber: '', location: 'Lab Floor 2' },
  ],
  serverUrl: 'http://localhost:3002',
  slackWebhook: '',
};

const mono = "'JetBrains Mono','Fira Code',monospace";
const sans = "'Outfit','DM Sans',system-ui,sans-serif";

function genJob() { return `J${String(Math.floor(Math.random()*90000)+10000)}`; }
function genTray() { return `T-${String(Math.floor(Math.random()*900)+100)}`; }
function pick(a) { return a[Math.floor(Math.random()*a.length)]; }
function genRx() {
  return { sph: (Math.random()*8-4).toFixed(2), cyl: (Math.random()*-4).toFixed(2), axis: Math.floor(Math.random()*180), add: Math.random()>0.5?(Math.random()*3).toFixed(2):null };
}

function playBeep(freq=880, dur=0.4, type="sine") {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.type = type; osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.35, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime+dur);
    osc.start(ctx.currentTime); osc.stop(ctx.currentTime+dur);
  } catch(e) { console.warn("Audio not available"); }
}

function initTrays(n) {
  const states = Object.keys(TRAY_STATES);
  const coatStages = Object.keys(COATING_STAGES);
  return Array.from({length:n},(_,i)=>{
    const state = pick(states);
    let dept;
    if(state==="IDLE") dept=pick(["PICKING","SHIPPING"]);
    else if(state==="COATING_STAGED"||state==="COATING_IN_PROCESS") dept="COATING";
    else if(state==="QC_HOLD"||state==="BROKEN") dept="QC";
    else if(state==="COMPLETE") dept=pick(["ASSEMBLY","SHIPPING"]);
    else if(state==="RE_TRAY") dept=pick(["COATING","ASSEMBLY"]);
    else dept=pick(["PICKING","SURFACING","CUTTING","COATING","ASSEMBLY","QC"]);
    let coatingStage=null;
    if(dept==="COATING"){
      if(state==="COATING_STAGED") coatingStage=pick(["QUEUE","DIP","SCAN_IN"]);
      else if(state==="COATING_IN_PROCESS") coatingStage=pick(["OVEN","COATER","COOL_DOWN"]);
      else coatingStage=pick(coatStages);
    }
    return {
      id:`T-${String(i+1).padStart(3,"0")}`,
      job:state==="IDLE"?null:genJob(),
      state, coatingType:state==="IDLE"?null:pick(COATING_TYPES),
      updatedAt:Date.now()-Math.floor(Math.random()*3600000),
      rush:Math.random()<0.08,
      battery:Math.floor(Math.random()*80)+20,
      rssi:Math.floor(Math.random()*-30)-40,
      lastSeen:Date.now()-Math.floor(Math.random()*300000),
      rx:state!=="IDLE"?genRx():null,
      einkPages:state!=="IDLE"?3:0,
      department:dept, coatingStage,
      lightOn:false,
      machine:dept==="COATING"&&coatingStage&&["OVEN","COATER"].includes(coatingStage)?pick(MACHINES):null,
      batchId:dept==="COATING"&&coatingStage&&!["QUEUE"].includes(coatingStage)?pick(["B01","B02","B03"]):null,
      stageEnteredAt:dept==="COATING"&&["OVEN","COATER"].includes(coatingStage)?Date.now()-Math.floor(Math.random()*2400000):null,
      breakType:state==="BROKEN"?pick(BREAK_TYPES):null,
    };
  });
}

function initPutWall(slots) {
  return Array.from({length:slots},(_,i)=>{
    const occupied=Math.random()<0.6;
    return { position:i+1, trayId:occupied?genTray():null, job:occupied?genJob():null, rush:occupied&&Math.random()<0.1, since:occupied?Date.now()-Math.floor(Math.random()*7200000):null, source:occupied?pick(["DVI","Lab Assistant","Kardex"]):null, coatingType:occupied?pick(COATING_TYPES):null };
  });
}

function initBatches() {
  return MACHINES.map((m,i)=>{
    const status=pick(["loading","running","waiting","idle"]);
    const capacity=140;
    const loaded=status==="idle"?0:status==="complete"?capacity:Math.floor(Math.random()*capacity);
    const stageLoads = {};
    Object.keys(COATING_STAGES).forEach(s=>{ stageLoads[s]=Math.floor(Math.random()*25); });
    return {
      id:`B${String(i+1).padStart(2,"0")}`, machine:m,
      coatingType:status==="idle"?null:pick(COATING_TYPES), status, loaded, capacity,
      startedAt:status==="running"?Date.now()-Math.floor(Math.random()*5400000):null,
      eta:status==="running"?Date.now()+Math.floor(Math.random()*3600000):null,
      stageLoads, controlState: status === "running" ? "running" : status === "waiting" ? "waiting" : "idle",
    };
  });
}

function initEvents() {
  const types=[
    {icon:"📥",msg:()=>`${genJob()} bound to ${genTray()} at Slot ${Math.floor(Math.random()*20)+1}`},
    {icon:"🔍",msg:()=>`Lens scan: ${genJob()} → Tray located Shelf ${pick(["A","B","C"])}-${Math.floor(Math.random()*5)+1}`},
    {icon:"⚡",msg:()=>`RUSH ${genJob()} routed to Rush Put Wall`},
    {icon:"✅",msg:()=>`Batch ${pick(["B01","B02","B03"])} verified: ${Math.floor(Math.random()*10)+130}/140 lenses`},
    {icon:"🌡",msg:()=>`${pick(MACHINES)}: Oven entry verified`},
    {icon:"🔄",msg:()=>`${genJob()} re-trayed → cutting`},
    {icon:"📊",msg:()=>`Batch fill: ${pick(COATING_TYPES)} at 85% in ${Math.floor(Math.random()*50)+10}min`},
    {icon:"⚠",msg:()=>`Wedge alert: position ${Math.floor(Math.random()*140)+1} misaligned`},
    {icon:"🔬",msg:()=>`QC: ${genJob()} passed inspection — ${pick(COATING_TYPES)}`},
    {icon:"💥",msg:()=>`Break reported: ${genJob()} — ${pick(BREAK_TYPES)}`},
  ];
  return Array.from({length:15},(_,i)=>{const t=pick(types);return{id:i,time:new Date(Date.now()-i*18000-Math.random()*12000),icon:t.icon,message:t.msg()};});
}

function initMessages() {
  return [
    {id:1,from:"Mike S.",text:"J48291 is HOT — customer pickup at 3PM",time:new Date(Date.now()-120000),priority:"high"},
    {id:2,from:"Sarah K.",text:"AR batch ready for unload on Satis 1200",time:new Date(Date.now()-300000),priority:"normal"},
    {id:3,from:"Phil",text:"Hold J55102 — Rx update coming from doctor",time:new Date(Date.now()-600000),priority:"high"},
  ];
}

function initInspections() {
  return Array.from({length:20},(_,i)=>({
    id:`INS-${String(i+1).padStart(3,"0")}`, job:genJob(), batch:pick(["B01","B02","B03"]),
    coatingType:pick(COATING_TYPES), result:Math.random()>0.15?"PASS":"FAIL",
    defects:Math.random()>0.15?[]:[pick(DEFECT_TYPES),...(Math.random()>0.5?[pick(DEFECT_TYPES)]:[])],
    inspectedAt:Date.now()-Math.floor(Math.random()*86400000),
    inspector:pick(["Auto-Vision","Manual-QC","Auto-Vision"]),
  }));
}

function initBreakage() {
  return Array.from({length:12},(_,i)=>({
    id:`BRK-${String(i+1).padStart(3,"0")}`, job:genJob(), dept:pick(Object.keys(DEPARTMENTS)),
    type:pick(BREAK_TYPES), lens:pick(["OD","OS","Both"]), coating:pick(COATING_TYPES),
    cost:parseFloat((Math.random()*45+15).toFixed(2)),
    time:new Date(Date.now()-Math.floor(Math.random()*86400000)),
    resolved:Math.random()>0.4,
  }));
}

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
const KPICard = ({label,value,sub,trend,accent})=>(
  <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:12,padding:"18px 22px",flex:"1 1 0",minWidth:160,borderTop:`4px solid ${accent||T.blue}`}}>
    <div style={{fontSize:12,color:T.textDim,textTransform:"uppercase",letterSpacing:1.5,fontFamily:mono}}>{label}</div>
    <div style={{fontSize:36,fontWeight:800,color:T.text,marginTop:4,fontFamily:mono}}>{value}</div>
    <div style={{display:"flex",alignItems:"center",gap:6,marginTop:4}}>
      {trend!=null&&<span style={{fontSize:13,color:trend>0?T.green:T.red,fontFamily:mono}}>{trend>0?"▲":"▼"}{Math.abs(trend)}%</span>}
      {sub&&<span style={{fontSize:12,color:T.textDim}}>{sub}</span>}
    </div>
  </div>
);

// ── Battery Icon (iPhone-style) ──────────────────────────────
function BatteryIcon({level,size=28}){
  const color=level>50?T.green:level>20?T.amber:T.red;
  const w=size*2, h=size, tip=size*0.2, padding=2;
  const innerW=w-tip-padding*2-4, innerH=h-padding*2-4;
  const fillW=Math.max(0,innerW*(level/100));
  return(
    <svg width={w+tip} height={h} viewBox={`0 0 ${w+tip} ${h}`}>
      <rect x={0} y={0} width={w} height={h} rx={h*0.2} fill="none" stroke={color} strokeWidth={2}/>
      <rect x={w} y={h*0.3} width={tip} height={h*0.4} rx={tip*0.4} fill={color}/>
      <rect x={padding+2} y={padding+2} width={fillW} height={innerH} rx={h*0.12} fill={color}/>
      {level<=20&&<text x={w/2} y={h/2+1} textAnchor="middle" dominantBaseline="middle" fontSize={h*0.45} fill={color} fontWeight="bold" fontFamily={mono}>!</text>}
    </svg>
  );
}

// ── Pure-JS QR Code (no external requests, works in sandbox) ─
function generateQRMatrix(text) {
  const GF = (() => {
    const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
    let x = 1;
    for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11D; }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
    return {
      mul: (a, b) => a && b ? EXP[LOG[a] + LOG[b]] : 0,
      poly: (ec) => {
        let g = [1];
        for (let i = 0; i < ec; i++) {
          const t = [1, EXP[i]], r = new Array(g.length + 1).fill(0);
          for (let a = 0; a < t.length; a++) for (let b = 0; b < g.length; b++) r[a+b] ^= GF.mul(t[a], g[b]);
          g = r;
        }
        return g;
      },
      remainder: (data, gen) => {
        const r = [...data];
        for (let i = 0; i < data.length; i++) { const c = r[i]; if (c) for (let j = 1; j < gen.length; j++) r[i+j] ^= GF.mul(gen[j], c); }
        return r.slice(data.length, data.length + gen.length - 1);
      }
    };
  })();

  const bytes = [];
  for (let i = 0; i < text.length; i++) bytes.push(text.charCodeAt(i) & 0xFF);
  const len = bytes.length;
  let version=1, size=21, ecCount=10, dcCount=16;
  if      (len<=14)  { version=1; size=21; ecCount=10; dcCount=16; }
  else if (len<=26)  { version=2; size=25; ecCount=16; dcCount=28; }
  else if (len<=42)  { version=3; size=29; ecCount=26; dcCount=44; }
  else if (len<=62)  { version=4; size=33; ecCount=36; dcCount=64; }
  else               { version=5; size=37; ecCount=48; dcCount=86; }

  const bits = [];
  const push = (v, n) => { for (let i=n-1;i>=0;i--) bits.push((v>>i)&1); };
  push(0b0100,4); push(len,8); bytes.forEach(b=>push(b,8)); push(0,4);
  while (bits.length%8) bits.push(0);
  const cw = [];
  for (let i=0;i<bits.length;i+=8) { let b=0; for (let j=0;j<8;j++) b=(b<<1)|(bits[i+j]||0); cw.push(b); }
  while (cw.length<dcCount) cw.push([0xEC,0x11][(cw.length)%2]);
  const gen = GF.poly(ecCount);
  const ec  = GF.remainder([...cw,...new Array(ecCount).fill(0)], gen);
  const all = [...cw.slice(0,dcCount),...ec];
  const stream = [];
  all.forEach(b=>{ for(let i=7;i>=0;i--) stream.push((b>>i)&1); });

  const M = Array.from({length:size},()=>new Int8Array(size).fill(-1));
  const isFunc = Array.from({length:size},()=>new Uint8Array(size));
  const set=(r,c,v)=>{ M[r][c]=v; };
  const mark=(r,c)=>{ isFunc[r][c]=1; };

  const finder=(tr,tc)=>{
    for(let r=-1;r<=7;r++) for(let c=-1;c<=7;c++) {
      const pr=tr+r, pc=tc+c;
      if(pr<0||pr>=size||pc<0||pc>=size) continue;
      const v=r>=0&&r<=6&&c>=0&&c<=6&&(r===0||r===6||c===0||c===6||(r>=2&&r<=4&&c>=2&&c<=4));
      set(pr,pc,v?1:0); mark(pr,pc);
    }
  };
  finder(0,0); finder(0,size-7); finder(size-7,0);

  for(let i=8;i<size-8;i++) { set(6,i,i%2===0?1:0); mark(6,i); set(i,6,i%2===0?1:0); mark(i,6); }
  set(size-8,8,1); mark(size-8,8);

  if(version>=2) {
    const ap=[[18,18]]; if(version>=3) ap.push([22,22]); if(version>=4) ap.push([26,26]); if(version>=5) ap.push([30,30]);
    // also top-right and bottom-left alignments
    const fixed=version>=2?[[6,size-7],[size-7,6]]:[];
    [...ap,...fixed].forEach(([ar,ac])=>{
      if(isFunc[ar]&&isFunc[ar][ac]) return;
      if(ar<0||ar>=size||ac<0||ac>=size) return;
      for(let r=-2;r<=2;r++) for(let c=-2;c<=2;c++) {
        const rr=ar+r,cc=ac+c; if(rr<0||rr>=size||cc<0||cc>=size) continue;
        if(isFunc[rr][cc]) continue;
        const v=r===-2||r===2||c===-2||c===2||(r===0&&c===0);
        set(rr,cc,v?1:0); mark(rr,cc);
      }
    });
  }

  let bi=0;
  for(let right=size-1;right>=1;right-=2) {
    if(right===6) right=5;
    for(let vert=0;vert<size;vert++) {
      for(let j=0;j<2;j++) {
        const c=right-j, r=((right+1)&2)===0?size-1-vert:vert;
        if(!isFunc[r][c]&&M[r][c]===-1&&bi<stream.length) set(r,c,stream[bi++]);
      }
    }
  }

  for(let r=0;r<size;r++) for(let c=0;c<size;c++) {
    if(!isFunc[r][c]&&M[r][c]!==-1) M[r][c]^=((r+c)%2===0?1:0);
  }

  // Format info (EC level M = bits 01, mask pattern 0)
  const fmt=[1,0,0,1,1,1,0,1,1,0,0,0,1,0,0];
  [[8,0],[8,1],[8,2],[8,3],[8,4],[8,5],[8,7],[8,8],[7,8],[5,8],[4,8],[3,8],[2,8],[1,8],[0,8]].forEach(([fr,fc],i)=>set(fr,fc,fmt[i]));
  [[size-1,8],[size-2,8],[size-3,8],[size-4,8],[size-5,8],[size-6,8],[size-7,8],[8,size-8],[8,size-7],[8,size-6],[8,size-5],[8,size-4],[8,size-3],[8,size-2],[8,size-1]].forEach(([fr,fc],i)=>set(fr,fc,fmt[i]));

  return { matrix:M, size };
}

function QRCode({data,size=96}){
  let qr;
  try { qr=generateQRMatrix(data); } catch(e) {
    return <div style={{width:size,height:size,background:"#fff",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:"#aaa"}}>QR</div>;
  }
  const {matrix,size:qs}=qr;
  const quiet=3, total=qs+quiet*2, mod=size/total;
  const cells=[];
  for(let r=0;r<qs;r++) for(let c=0;c<qs;c++) {
    if(matrix[r][c]===1) cells.push(<rect key={`${r}-${c}`} x={(c+quiet)*mod} y={(r+quiet)*mod} width={mod} height={mod} fill="#0F1629"/>);
  }
  return(
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} style={{borderRadius:4,display:"block"}}>
      <rect width={size} height={size} fill="#ffffff" rx={4}/>
      {cells}
    </svg>
  );
}

// ── Batch Control Card ───────────────────────────────────────
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

function OvenTimer({tray}){
  const elapsed = useElapsed(tray.stageEnteredAt, !!tray.stageEnteredAt);
  if(!tray.stageEnteredAt || !["OVEN","COATER"].includes(tray.coatingStage)) return null;
  const isOven = tray.coatingStage === "OVEN";
  const color = isOven ? T.amber : T.red;
  // Typical oven dwell: ~25 min. Typical coater: ~45 min
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

      {/* Compact run timer on card face when running */}
      {isRunning&&!expanded&&<RunTimer startedAt={batch.startedAt} running={isRunning} eta={batch.eta}/>}

      {/* Progress bar */}
      <div style={{marginTop:8}}>
        <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,marginBottom:3,fontFamily:mono}}>
          <span>{batch.loaded}/{batch.capacity} lenses</span><span>{Math.round(pct)}%</span>
        </div>
        <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden"}}>
          <div style={{height:"100%",width:`${pct}%`,background:sc,borderRadius:3,transition:"width 0.6s"}}/>
        </div>
      </div>

      {/* Stage pipeline */}
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

      {/* Oven/Coater alerts on card face */}
      {ovenJobs.length>0&&!expanded&&(
        <div style={{marginTop:8,display:"flex",flexDirection:"column",gap:3}}>
          {ovenJobs.slice(0,3).map(t=><OvenTimer key={t.id} tray={t}/>)}
          {ovenJobs.length>3&&<div style={{fontSize:9,color:T.textDim,fontFamily:mono,paddingLeft:4}}>+{ovenJobs.length-3} more in heat</div>}
        </div>
      )}

      {/* Expanded content */}
      {expanded&&(
        <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>

          {/* Full run timer in expanded */}
          <RunTimer startedAt={batch.startedAt} running={isRunning} eta={batch.eta}/>

          {/* Manual Batch Controls */}
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
            {ctrlState==="hold"&&(
              <div style={{marginTop:6,padding:"6px 10px",background:`${T.red}15`,border:`1px solid ${T.red}40`,borderRadius:5,fontSize:10,color:T.red,fontFamily:mono}}>
                ⛔ Batch on HOLD — operator intervention required
              </div>
            )}
            {ctrlState==="waiting"&&(
              <div style={{marginTop:6,padding:"6px 10px",background:`${T.amber}15`,border:`1px solid ${T.amber}40`,borderRadius:5,fontSize:10,color:T.amber,fontFamily:mono}}>
                ⏳ Waiting — will not start until manually triggered
              </div>
            )}
          </div>

          {/* Oven/Coater timers */}
          {ovenJobs.length>0&&(
            <div style={{marginBottom:12}}>
              <div style={{fontSize:10,color:T.amber,fontFamily:mono,marginBottom:6,letterSpacing:1}}>🌡 ACTIVE HEAT STAGES</div>
              <div style={{display:"flex",flexDirection:"column",gap:5}}>
                {ovenJobs.map(t=>(
                  <div key={t.id} style={{display:"flex",gap:8,alignItems:"center",padding:"6px 8px",background:T.bg,borderRadius:6}}>
                    <span style={{fontSize:11,color:T.text,fontFamily:mono,fontWeight:700,minWidth:60}}>{t.job||t.id}</span>
                    <span style={{fontSize:9,color:T.textDim,fontFamily:mono,minWidth:44}}>{t.id}</span>
                    <OvenTimer tray={t}/>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Jobs in batch */}
          <div style={{marginBottom:10}}>
            <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,marginBottom:6,display:"flex",justifyContent:"space-between"}}>
              <span>ALL JOBS IN BATCH</span><span style={{color:T.text,fontWeight:700}}>{batchJobs.length}</span>
            </div>
            {batchJobs.length>0?(
              <div style={{maxHeight:140,overflowY:"auto"}}>
                {batchJobs.map(j=>(
                  <div key={j.id} style={{display:"flex",alignItems:"center",gap:6,padding:"3px 6px",marginBottom:2,background:T.bg,borderRadius:4,fontSize:10}}>
                    {j.coatingStage&&COATING_STAGES[j.coatingStage]&&(
                      <div style={{width:6,height:6,borderRadius:"50%",background:COATING_STAGES[j.coatingStage].color,flexShrink:0}}/>
                    )}
                    <span style={{color:T.text,fontFamily:mono,fontWeight:600}}>{j.job||j.id}</span>
                    <span style={{color:T.textDim,fontFamily:mono}}>{j.id}</span>
                    {j.coatingStage&&COATING_STAGES[j.coatingStage]&&(
                      <span style={{color:COATING_STAGES[j.coatingStage].color,fontSize:9,fontFamily:mono}}>{COATING_STAGES[j.coatingStage].label}</span>
                    )}
                    {j.rush&&<Pill color={T.red}>R</Pill>}
                    <span style={{marginLeft:"auto",color:T.textDim,fontSize:9}}>{j.coatingType}</span>
                  </div>
                ))}
              </div>
            ):(
              <div style={{fontSize:10,color:T.textDim,fontStyle:"italic",padding:4}}>No tracked trays in batch</div>
            )}
          </div>

          {/* Waiting queue */}
          {batch.coatingType&&waitingJobs.length>0&&(
            <div>
              <div style={{fontSize:10,color:T.amber,fontFamily:mono,marginBottom:4,display:"flex",justifyContent:"space-between"}}>
                <span>WAITING — {batch.coatingType.toUpperCase()}</span>
                <span style={{color:T.text,fontWeight:700}}>{waitingJobs.length}</span>
              </div>
              <div style={{maxHeight:80,overflowY:"auto"}}>
                {waitingJobs.slice(0,15).map(j=>(
                  <div key={j.id} style={{display:"flex",alignItems:"center",gap:5,padding:"2px 6px",marginBottom:2,background:`${T.amber}08`,borderRadius:4,fontSize:10,border:`1px solid ${T.amber}15`}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:T.amber,opacity:0.5}}/>
                    <span style={{color:T.text,fontFamily:mono}}>{j.job||j.id}</span>
                    {j.rush&&<Pill color={T.red}>R</Pill>}
                  </div>
                ))}
                {waitingJobs.length>15&&<div style={{fontSize:9,color:T.textDim,fontFamily:mono,padding:4}}>+{waitingJobs.length-15} more</div>}
              </div>
            </div>
          )}
        </div>
      )}
    </Card>
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

// ── Draggable Panel System ───────────────────────────────────
function DraggablePanel({id,children,dragState,onDragStart,onDragOver,onDrop,style}){
  const isDragging=dragState.dragging===id;
  const isDragOver=dragState.over===id;
  return(
    <div draggable onDragStart={()=>onDragStart(id)} onDragOver={e=>{e.preventDefault();onDragOver(id);}} onDrop={()=>onDrop(id)}
      style={{opacity:isDragging?0.4:1,transition:"opacity 0.2s",outline:isDragOver?`2px dashed ${T.blue}`:"none",outlineOffset:3,borderRadius:12,...style}}>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8,cursor:"grab",userSelect:"none",width:"fit-content"}}>
        <span style={{fontSize:14,color:T.textDim,letterSpacing:2}}>⠿⠿</span>
        <span style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>DRAG TO REORDER</span>
      </div>
      {children}
    </div>
  );
}

// ── Overview Tab ──────────────────────────────────────────────
// ── Slack config stored in component state (persists via localStorage) ──────
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

// ── Slack Integration ─────────────────────────────────────────
// Outgoing: Incoming Webhook (browser-safe, no CORS issues)
// Incoming: polls a tiny local proxy at cfg.proxyUrl (see slack-proxy.js)
//   Slack conversations.history blocks browser CORS directly,
//   so a 1-file Node proxy runs alongside the app server-side.
function useSlackConfig(onIncoming, setMessages){
  const KEY="la_slack_v2";
  const DEFAULTS={
    proxyUrl:"http://localhost:3002/api/slack/messages?channel=C0AJH9LG96D",
    channel:"lab-assistant",
    channelId:"C0AJH9LG96D"
  };
  const [cfg,setCfgRaw]=useState(()=>{try{const stored=JSON.parse(localStorage.getItem(KEY)||"{}");return {...DEFAULTS,...stored};}catch{return DEFAULTS;}});
  const [status,setStatus]=useState(null);
  const [proxyConnected,setProxyConnected]=useState(false);
  const lastTs=useRef(null);
  const initialLoad=useRef(false);
  const save=(next)=>{setCfgRaw(next);try{localStorage.setItem(KEY,JSON.stringify(next));}catch{}};

  // Post outgoing via server proxy (uses bot token)
  const post=useCallback(async(text)=>{
    setStatus("sending");
    try{
      // Use server proxy endpoint which has the bot token
      const sendUrl=cfg.proxyUrl?.replace('/messages','/send').split('?')[0] || 'http://localhost:3002/api/slack/send';
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

  // Poll incoming via local proxy every 12s
  useEffect(()=>{
    if(!cfg.proxyUrl)return;
    const poll=async()=>{
      try{
        const url=cfg.proxyUrl.includes('?')?cfg.proxyUrl:`${cfg.proxyUrl}?channel=${cfg.channelId||""}`;
        const r=await fetch(url);
        if(!r.ok){setProxyConnected(false);return;}
        setProxyConnected(true);
        const data=await r.json();
        // Include ALL messages (including bot) for display
        // Filter out AI queries (/ai, @ai, ai:, /lab) - those are for lab use, not dashboard display
        const allMsgs=(data.messages||[]).filter(m=>m.type==="message"&&m.text&&!m.text.match(/^(?:\/ai|@ai|ai:|\/lab\b)/i));

        // On first successful load, replace demo messages with real Slack messages
        if(!initialLoad.current && allMsgs.length>0 && setMessages){
          initialLoad.current=true;
          const slackMsgs=allMsgs.slice(0,20).map(m=>({
            id:`slack-${m.ts}`,
            from:m.bot_profile?.name||m.username||m.user||"Slack",
            text:m.text.replace(/<[^>]*>/g,'').slice(0,200), // Strip Slack formatting, truncate
            time:new Date(parseFloat(m.ts)*1000),
            priority:m.text.toLowerCase().includes("rush")||m.text.toLowerCase().includes("hot")||m.text.toLowerCase().includes("critical")?"high":"normal",
            source:"slack",
            isBot:!!m.bot_id,
          }));
          setMessages(slackMsgs);
          lastTs.current=allMsgs[0].ts;
          return;
        }

        // After initial load, only add NEW human messages
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
  // Production Stage Summary Cards
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

function OverviewTab({trays,putWall,batches,events,messages:initMessages,onSendMessage,onBatchControl,settings}){
  // Get coater machines from settings (fallback to MACHINES constant)
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
  const [editCard,setEditCard]=useState(null); // card id being configured
  const [cardMenu,setCardMenu]=useState(null); // card id with open menu

  // Close card menu when clicking outside
  useEffect(()=>{
    if(!cardMenu)return;
    const close=()=>setCardMenu(null);
    document.addEventListener("click",close);
    return()=>document.removeEventListener("click",close);
  },[cardMenu]);

  // Auto-scroll to newest message (at bottom)
  useEffect(()=>{
    if(messagesRef.current) messagesRef.current.scrollTop=messagesRef.current.scrollHeight;
  },[messages]);

  // Live inventory from ItemPath/Kardex
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
    const iv=setInterval(fetchInventory,60000); // refresh every 60s
    return()=>clearInterval(iv);
  },[]);

  // Live maintenance data from Limble CMMS
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

  // Persist cards to localStorage
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
  },[]);

  const slack=useSlackConfig(handleIncoming, setMessages);
  const activeTrays=trays.filter(t=>t.state!=="IDLE").length;
  const rushCount=trays.filter(t=>t.rush).length;
  const coatingWIP=trays.filter(t=>["COATING_STAGED","COATING_IN_PROCESS"].includes(t.state)).length;
  const avgBatchFill=Math.round(batches.reduce((s,b)=>s+(b.loaded/b.capacity)*100,0)/batches.length);
  const pwOcc=putWall.filter(s=>s.trayId).length;
  const qcCount=trays.filter(t=>t.department==="QC").length;
  const breakCount=trays.filter(t=>t.state==="BROKEN").length;
  const isConnected=slack.proxyConnected||!!slack.cfg.webhook;
  const qrData=slack.cfg.channelUrl||"https://slack.com";
  const sendBg=slack.status==="sending"?T.amber:slack.status==="ok"?T.green:slack.status==="err"?T.red:"#4A154B";
  const sendLabel=slack.status==="sending"?"…":slack.status==="ok"?"✓ SENT":slack.status==="err"?"✗ ERR":isConnected?"SEND":"SEND";

  const handleSend=async()=>{
    if(!msgInput.trim())return;
    const text=msgInput.trim();
    setMsgInput("");
    // Add to local messages immediately for instant feedback
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

  // ── Drag-to-reorder cards ──────────────────────────────────
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

  // ── Render card content by type ────────────────────────────
  const renderCardContent=(card)=>{
    switch(card.type){

      case "kpi_row": return(
        <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
          <KPICard label="Active Trays"   value={activeTrays}               sub={`of ${trays.length}`} trend={3}  accent={T.blue}/>
          <KPICard label="Quick Bind"     value={`${pwOcc}/20`}             sub="slots filled"                     accent={T.green}/>
          <KPICard label="Coating WIP"    value={coatingWIP}                sub="in process"           trend={-5} accent={T.amber}/>
          <KPICard label="Avg Batch Fill" value={`${avgBatchFill}%`}        sub="3 machines"           trend={2}  accent={T.purple}/>
          <KPICard label="Rush Jobs"      value={rushCount}                 sub="in system"                        accent={T.red}/>
          <KPICard label="QC / Breaks"    value={`${qcCount}/${breakCount}`} sub="holds / broken"                 accent={T.orange}/>
        </div>
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
                {key:"webhook",    label:"Outgoing Webhook URL",      ph:"https://hooks.slack.com/services/...",type:"url"},
                {key:"channel",    label:"Channel name (no #)",        ph:"lab-assistant",                       type:"text"},
                {key:"channelUrl", label:"Channel URL (for QR code)", ph:"https://yourco.slack.com/archives/C...",type:"url"},
                {key:"channelId",  label:"Channel ID (incoming)",     ph:"C05AB12XYZ",                          type:"text"},
                {key:"proxyUrl",   label:"Local proxy URL (incoming)",ph:"http://localhost:3001/slack/messages", type:"url"},
              ].map(f=>(
                <div key={f.key} style={{marginBottom:10}}>
                  <label style={{fontSize:9,color:"#E8A9F4",fontFamily:mono,display:"block",marginBottom:3,letterSpacing:1}}>{f.label.toUpperCase()}</label>
                  <input type={f.type} value={draft[f.key]||""} onChange={e=>setDraft(d=>({...d,[f.key]:e.target.value}))} placeholder={f.ph}
                    style={{width:"100%",background:"#0D0010",border:"1px solid #611f69",borderRadius:6,padding:"8px 12px",color:T.text,fontSize:11,fontFamily:mono,outline:"none",boxSizing:"border-box"}}/>
                </div>
              ))}
              <div style={{marginBottom:10}}>
                <label style={{fontSize:9,color:"#E8A9F4",fontFamily:mono,display:"block",marginBottom:3,letterSpacing:1}}>TEXT SIZE</label>
                <div style={{display:"flex",alignItems:"center",gap:10}}>
                  <input type="range" min="10" max="18" value={draft.textSize||12} onChange={e=>setDraft(d=>({...d,textSize:parseInt(e.target.value)}))}
                    style={{flex:1,accentColor:"#4A154B"}}/>
                  <span style={{fontSize:12,color:T.text,fontFamily:mono,minWidth:36}}>{draft.textSize||12}px</span>
                </div>
              </div>
              <button onClick={()=>{slack.save(draft);setShowSlackCfg(false);}}
                style={{width:"100%",padding:"9px",background:"#4A154B",border:"1px solid #611f69",borderRadius:6,color:"#E8A9F4",fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:mono}}>
                💾 SAVE & CONNECT
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
                      {m.priority==="high"&&<span style={{padding:"2px 6px",background:T.red,borderRadius:4,fontSize:9,fontWeight:800,color:"#fff",fontFamily:mono}}>🔥 HOT</span>}
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
            <SectionHeader right={<span style={{color:rushJobs.length>0?T.red:T.green,fontFamily:mono}}>{rushJobs.length} ACTIVE</span>}>🔴 Rush Queue</SectionHeader>
            {rushJobs.length===0
              ?<div style={{textAlign:"center",padding:"24px 0",fontSize:12,color:T.green,fontFamily:mono}}>✓ No rush jobs active</div>
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
              <SectionHeader>⏱ WIP Aging Alert</SectionHeader>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>THRESHOLD</span>
                <select value={threshHours} onChange={e=>updateCardConfig(card.id,{thresholdHours:Number(e.target.value)})}
                  style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:5,color:T.text,fontSize:11,fontFamily:mono,padding:"3px 8px"}}>
                  {[2,4,6,8,12,24,48].map(h=><option key={h} value={h}>{h}h</option>)}
                </select>
              </div>
            </div>
            {aged.length===0
              ?<div style={{textAlign:"center",padding:"20px 0",fontSize:12,color:T.green,fontFamily:mono}}>✓ All jobs under {threshHours}h threshold</div>
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

        // Parse OPC watchlist into array
        const watchedOPCs=opcWatchlist.split(/[\n,]/).map(s=>s.trim()).filter(Boolean);
        const hasWatchlist=watchedOPCs.length>0;

        // Build inventory items to display
        let displayItems=[];

        if(hasWatchlist){
          // Show watched OPCs from full inventory (not just alerts)
          const materialMap=new Map(inventory.materials.map(m=>[m.sku?.toUpperCase(),m]));
          displayItems=watchedOPCs.map(opc=>{
            const mat=materialMap.get(opc.toUpperCase());
            if(mat){
              const thresh=20; // default threshold
              const status=mat.qty===0?"CRITICAL":mat.qty<=thresh*0.5?"LOW":mat.qty<=thresh?"WATCH":"OK";
              return {sku:mat.sku,name:mat.name||mat.sku,qty:mat.qty,thresh,severity:status,found:true};
            }else{
              return {sku:opc,name:opc,qty:null,thresh:0,severity:"NOT_FOUND",found:false};
            }
          });
        }else{
          // No watchlist - show low stock alerts
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
              <SectionHeader>📦 Lens Blank Inventory</SectionHeader>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                {hasWatchlist&&(
                  <span style={{fontSize:9,color:T.blue,fontFamily:mono,fontWeight:700}}>
                    {watchedOPCs.length} OPCs
                  </span>
                )}
                <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",borderRadius:12,background:liveConnected?`${T.green}15`:`${T.amber}15`,border:`1px solid ${liveConnected?T.green:T.amber}`}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:liveConnected?T.green:T.amber}}/>
                  <span style={{fontSize:9,color:liveConnected?T.green:T.amber,fontFamily:mono,fontWeight:700}}>{liveConnected?"ITEMPATH LIVE":"CONNECTING..."}</span>
                </div>
              </div>
            </div>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:10}}>
              {hasWatchlist?`Showing ${watchedOPCs.length} watched OPCs`:"Showing low-stock alerts · Use ⋮ menu to set OPC watchlist"}
            </div>
            {!hasData?(
              <div style={{textAlign:"center",padding:"30px 0",fontSize:12,color:liveConnected?T.green:T.textDim,fontFamily:mono}}>
                {liveConnected?"Add OPCs via ⋮ Configure":"Loading inventory..."}
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
            <div style={{fontSize:24,marginBottom:8}}>✦</div>
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

      // ── Production Stage Summary Cards ──────────────────────────────
      case "surfacing_summary":{
        const surfacingJobs=trays.filter(t=>t.department==="SURFACING"&&t.state!=="IDLE");
        const queueJobs=surfacingJobs.filter(t=>t.state==="QUEUED");
        const inProgress=surfacingJobs.filter(t=>t.state==="IN_PROGRESS");
        const rushJobs=surfacingJobs.filter(t=>t.rush);
        return(
          <div onClick={()=>setView("surfacing")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>🌀 Surfacing</SectionHeader>
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
          <div onClick={()=>setView("cutting")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>✂️ Cutting</SectionHeader>
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
          <div onClick={()=>setView("assembly")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>🔧 Assembly</SectionHeader>
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
          <div onClick={()=>setView("shipping")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>📤 Shipping</SectionHeader>
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
          <div onClick={()=>setView("maintenance")} style={{cursor:"pointer"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
              <SectionHeader>🔩 Maintenance</SectionHeader>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:maintenanceData.status==='ok'?T.green:maintenanceData.status==='mock'?T.amber:T.red}}/>
                <span style={{fontSize:10,color:T.blue,fontFamily:mono}}>VIEW TAB →</span>
              </div>
            </div>
            {!hasData&&<div style={{fontSize:10,color:T.amber,fontFamily:mono,marginBottom:8}}>⚠️ No recent maintenance data</div>}
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


  // ── Card Config Modal state ──────────────────────────────────────
  const [opcSearch,setOpcSearch]=useState("");

  // Config modal helpers (computed when modal is open)
  const configCard=editCard?cards.find(c=>c.id===editCard):null;
  const configCfg=configCard?.config||{};
  const configWatchedOPCs=configCard?(configCfg.opcWatchlist||"").split(/[\n,]/).map(s=>s.trim()).filter(Boolean):[];
  const configFilteredMaterials=opcSearch.trim().length>=2
    ? inventory.materials.filter(m=>
        m.sku?.toLowerCase().includes(opcSearch.toLowerCase())||
        m.name?.toLowerCase().includes(opcSearch.toLowerCase())
      ).slice(0,15)
    : [];

  // ── Card Picker Modal ──────────────────────────────────────
  const CardPickerModal=()=>(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>setShowCardPicker(false)}>
      <div style={{background:T.surface,border:`1px solid ${T.borderLight}`,borderRadius:16,padding:28,width:600,maxWidth:"90vw",maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
          <div style={{fontSize:16,fontWeight:800,color:T.text}}>Add a Card</div>
          <button onClick={()=>setShowCardPicker(false)} style={{background:"transparent",border:"none",color:T.textDim,fontSize:20,cursor:"pointer"}}>✕</button>
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

  // ── Render ─────────────────────────────────────────────────
  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}} onDragEnd={handleDragEnd}>
      <div style={{display:"flex",justifyContent:"flex-end",gap:10,alignItems:"center"}}>
        <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{cards.length} CARDS · DRAG TO REORDER</span>
        <button onClick={()=>setShowCardPicker(true)}
          style={{display:"flex",alignItems:"center",gap:7,padding:"8px 16px",background:T.blueDark,border:`1px solid ${T.blue}`,borderRadius:8,color:T.blue,fontSize:11,fontWeight:700,cursor:"pointer",fontFamily:mono,letterSpacing:.5}}>
          ＋ ADD CARD
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
                      <span>✕</span> Remove
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
            ＋ Add Your First Card
          </button>
        </div>
      )}
      {showCardPicker&&<CardPickerModal/>}
      {editCard&&configCard&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.75)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000}} onClick={()=>{setEditCard(null);setOpcSearch("");}}>
          <div style={{background:T.surface,border:`1px solid ${T.borderLight}`,borderRadius:16,padding:28,width:480,maxWidth:"90vw",maxHeight:"80vh",overflowY:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:16,fontWeight:800,color:T.text}}>⚙ Configure Card</div>
              <button onClick={()=>{setEditCard(null);setOpcSearch("");}} style={{background:"transparent",border:"none",color:T.textDim,fontSize:20,cursor:"pointer"}}>✕</button>
            </div>

            {/* Card Title */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>CARD TITLE</div>
              <input type="text" value={configCard.title} onChange={e=>updateCardTitle(configCard.id,e.target.value)} style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}/>
            </div>

            {/* Inventory Card Config */}
            {configCard.type==="inventory"&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>OPC WATCHLIST ({configWatchedOPCs.length} selected)</div>

                {/* Selected OPCs as chips */}
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

                {/* Search input */}
                <input
                  type="text"
                  placeholder="Type to search OPCs..."
                  value={opcSearch}
                  onChange={e=>setOpcSearch(e.target.value)}
                  autoComplete="off"
                  style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}
                />

                {/* Search results */}
                {opcSearch.trim().length>=2&&(
                  <div style={{marginTop:8,border:`1px solid ${T.border}`,borderRadius:8,maxHeight:180,overflowY:"auto",background:T.bg}}>
                    {configFilteredMaterials.length>0?configFilteredMaterials.map(m=>(
                      <div
                        key={m.sku}
                        onClick={()=>{
                          if(!configWatchedOPCs.includes(m.sku)){
                            updateCardConfig(configCard.id,{opcWatchlist:[...configWatchedOPCs,m.sku].join('\n')});
                          }
                          setOpcSearch("");
                        }}
                        style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 12px",borderBottom:`1px solid ${T.border}`,cursor:"pointer"}}
                      >
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

            {/* WIP Aging Config */}
            {configCard.type==="wip_aging"&&(
              <div style={{marginBottom:16}}>
                <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginBottom:6}}>AGE THRESHOLD (HOURS)</div>
                <select value={configCfg.thresholdHours||6} onChange={e=>updateCardConfig(configCard.id,{thresholdHours:Number(e.target.value)})} style={{width:"100%",padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono,cursor:"pointer"}}>
                  {[2,4,6,8,12,24,48].map(h=><option key={h} value={h}>{h} hours</option>)}
                </select>
              </div>
            )}

            {/* Custom Metric Config */}
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

            {/* No config message */}
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
// ── Put Wall Tab ─────────────────────────────────────────────
function PutWallTab({putWall,setPutWall,events}){
  const [selectedSlot,setSelectedSlot]=useState(null);
  const [scanTrayInput,setScanTrayInput]=useState("");
  const [scanJobInput,setScanJobInput]=useState("");
  const [bindSource,setBindSource]=useState("DVI");
  const pwOcc=putWall.filter(s=>s.trayId).length;

  const handleBind=()=>{
    if(selectedSlot===null||!scanTrayInput.trim())return;
    setPutWall(prev=>{const next=[...prev];next[selectedSlot]={...next[selectedSlot],trayId:scanTrayInput.trim(),job:scanJobInput.trim()||null,rush:false,since:Date.now(),source:bindSource,coatingType:pick(COATING_TYPES)};return next;});
    setScanTrayInput("");setScanJobInput("");
  };
  const handleUnbind=(idx)=>{
    setPutWall(prev=>{const next=[...prev];next[idx]={...next[idx],trayId:null,job:null,rush:false,since:null,source:null,coatingType:null};return next;});
    setSelectedSlot(null);
  };
  const selected=selectedSlot!==null?putWall[selectedSlot]:null;

  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:20}}>
      <div>
        <Card>
          <SectionHeader right={`${pwOcc}/20 occupied`}>Rush Put Wall — 20 Slots</SectionHeader>
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
            {putWall.map((slot,i)=>{
              const bg=!slot.trayId?T.bg:slot.rush?T.redDark:T.blueDark;
              const border=selectedSlot===i?T.cyan:!slot.trayId?T.border:slot.rush?T.red:T.blue;
              const age=slot.since?Math.floor((Date.now()-slot.since)/60000):null;
              return(
                <div key={i} onClick={()=>setSelectedSlot(i)} style={{background:bg,border:`2px solid ${border}`,borderRadius:8,padding:10,textAlign:"center",cursor:"pointer",position:"relative",minHeight:88,display:"flex",flexDirection:"column",justifyContent:"center",boxShadow:selectedSlot===i?`0 0 16px ${T.cyan}40`:"none",transform:selectedSlot===i?"scale(1.02)":"scale(1)",transition:"all 0.15s"}}>
                  <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:3}}>SLOT {String(slot.position).padStart(2,"0")}</div>
                  {slot.trayId?(<>
                    <div style={{fontSize:13,color:T.text,fontWeight:800,fontFamily:mono}}>{slot.job||"—"}</div>
                    <div style={{fontSize:9,color:T.textMuted,marginTop:1}}>{slot.trayId}</div>
                    {slot.coatingType&&<div style={{fontSize:8,color:T.blue,marginTop:1}}>{slot.coatingType}</div>}
                    {slot.source&&<div style={{marginTop:2}}><Pill color={T.textMuted}>{slot.source}</Pill></div>}
                    {slot.rush&&<div style={{position:"absolute",top:3,right:3,fontSize:7,background:T.red,color:"#fff",borderRadius:3,padding:"1px 5px",fontWeight:800}}>RUSH</div>}
                    {age!==null&&<div style={{fontSize:8,color:age>90?T.red:T.textDim,fontFamily:mono,marginTop:2}}>{age}m ago</div>}
                  </>):<div style={{fontSize:20,color:T.border}}>+</div>}
                </div>
              );
            })}
          </div>
        </Card>
        <div style={{marginTop:16}}><EventLog events={events}/></div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Card style={{borderTop:`3px solid ${T.cyan}`}}>
          <SectionHeader>{selectedSlot!==null?`Slot ${String(selectedSlot+1).padStart(2,"00")} Details`:"Select a Slot"}</SectionHeader>
          {selected?(selected.trayId?(
            <div>
              <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:"5px 12px",fontSize:12}}>
                {[["Tray",selected.trayId,T.text],["Job",selected.job||"No job",T.text],["Source",selected.source,T.cyan],["Coating",selected.coatingType||"—",T.amber],["Parked",selected.since?`${Math.floor((Date.now()-selected.since)/60000)}m ago`:"—",T.textMuted]].map(([l,v,c])=>(
                  <><span key={l+"l"} style={{color:T.textDim,fontFamily:mono}}>{l}:</span><span key={l+"v"} style={{color:c,fontWeight:700,fontFamily:mono}}>{v}</span></>
                ))}
              </div>
              <button onClick={()=>handleUnbind(selectedSlot)} style={{width:"100%",marginTop:14,background:T.redDark,border:`1px solid ${T.red}`,borderRadius:6,padding:"9px",color:T.red,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:mono}}>UNBIND TRAY</button>
            </div>
          ):(
            <div>
              <div style={{fontSize:11,color:T.green,marginBottom:10,fontFamily:mono}}>● EMPTY — Ready to bind</div>
              {[["SCAN TRAY ID",scanTrayInput,setScanTrayInput,"T-001"],["JOB NUMBER",scanJobInput,setScanJobInput,"J12345"]].map(([lbl,val,set,ph])=>(
                <div key={lbl} style={{marginBottom:10}}>
                  <label style={{fontSize:10,color:T.textDim,fontFamily:mono,display:"block",marginBottom:4}}>{lbl}</label>
                  <input value={val} onChange={e=>set(e.target.value)} placeholder={ph} style={{width:"100%",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 12px",color:T.text,fontSize:13,fontFamily:mono,outline:"none",boxSizing:"border-box"}}/>
                </div>
              ))}
              <div style={{marginBottom:12}}>
                <label style={{fontSize:10,color:T.textDim,fontFamily:mono,display:"block",marginBottom:4}}>SOURCE</label>
                <div style={{display:"flex",gap:4}}>
                  {["DVI","Lab Assistant","Kardex"].map(src=>(
                    <button key={src} onClick={()=>setBindSource(src)} style={{flex:1,padding:"6px 4px",borderRadius:5,fontSize:9,fontWeight:700,fontFamily:mono,cursor:"pointer",background:bindSource===src?T.blueDark:T.bg,border:`1px solid ${bindSource===src?T.blue:T.border}`,color:bindSource===src?T.blue:T.textDim}}>{src}</button>
                  ))}
                </div>
              </div>
              <button onClick={handleBind} disabled={!scanTrayInput.trim()} style={{width:"100%",background:scanTrayInput.trim()?T.green:T.border,border:"none",borderRadius:6,padding:"10px",color:scanTrayInput.trim()?"#000":T.textDim,fontWeight:800,fontSize:12,cursor:scanTrayInput.trim()?"pointer":"default",fontFamily:mono}}>BIND → SLOT {String((selectedSlot||0)+1).padStart(2,"0")}</button>
            </div>
          )):<div style={{fontSize:12,color:T.textDim,textAlign:"center",padding:24}}>Click a slot to view details or bind a tray</div>}
        </Card>
        <Card>
          <SectionHeader>Source Breakdown</SectionHeader>
          {["DVI","Lab Assistant","Kardex"].map(src=>{
            const count=putWall.filter(s=>s.source===src).length;
            return(
              <div key={src} style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                <span style={{fontSize:11,color:T.textMuted}}>{src}</span>
                <div style={{display:"flex",alignItems:"center",gap:8}}>
                  <div style={{width:80,height:4,background:T.bg,borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:`${(count/20)*100}%`,background:T.blue,borderRadius:2}}/></div>
                  <span style={{fontSize:11,color:T.text,fontFamily:mono,width:20,textAlign:"right"}}>{count}</span>
                </div>
              </div>
            );
          })}
        </Card>
      </div>
    </div>
  );
}

// ── Coating Intelligence Tab ──────────────────────────────────
// ── Oven Server Integration hook ─────────────────────────────
function useOvenServer(serverUrl){
  const [runs,setRuns]=useState([]);
  const [live,setLive]=useState({});
  const [stats,setStats]=useState(null);
  const [connected,setConnected]=useState(false);
  const url=serverUrl||"http://localhost:3002";

  useEffect(()=>{
    if(!url)return;
    const fetchAll=async()=>{
      try{
        const [runsRes,liveRes,statsRes]=await Promise.all([
          fetch(`${url}/api/oven-runs?limit=200`,{signal:AbortSignal.timeout(3000)}),
          fetch(`${url}/api/oven-live`,{signal:AbortSignal.timeout(3000)}),
          fetch(`${url}/api/oven-stats`,{signal:AbortSignal.timeout(3000)}),
        ]);
        if(runsRes.ok){const d=await runsRes.json();setRuns(d.runs||[]);setConnected(true);}
        if(liveRes.ok){const d=await liveRes.json();setLive(d.timers||{});}
        if(statsRes.ok){const d=await statsRes.json();setStats(d);}
      }catch{setConnected(false);}
    };
    fetchAll();
    const iv=setInterval(fetchAll,8000);
    return()=>clearInterval(iv);
  },[url]);

  return{runs,live,stats,connected};
}

function OvenHistoryView({serverUrl}){
  const {runs,live,stats,connected}=useOvenServer(serverUrl);
  const [filterCoating,setFilterCoating]=useState("All");
  const fmtSecs=(s)=>{const abs=Math.abs(s);const m=Math.floor(abs/60),sc=abs%60;return`${s<0?"-":""}${String(m).padStart(2,"0")}:${String(sc).padStart(2,"0")}`;};
  const isToday=(ts)=>new Date(ts).toDateString()===new Date().toDateString();
  const todayRuns=runs.filter(r=>isToday(r.startedAt));
  const coatings=["All",...new Set(runs.map(r=>r.coating))];
  const filtered=filterCoating==="All"?runs:runs.filter(r=>r.coating===filterCoating);

  const liveEntries=Object.entries(live);

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      {/* Connection status */}
      <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 16px",background:T.card,border:`1px solid ${connected?T.green:T.border}`,borderRadius:8}}>
        <div style={{width:8,height:8,borderRadius:"50%",background:connected?T.green:T.textDim,boxShadow:connected?`0 0 8px ${T.green}`:""}}/>
        <span style={{fontFamily:mono,fontSize:11,color:connected?T.green:T.textDim,fontWeight:700}}>
          {connected?`Oven Timer Server — ${runs.length} runs on record`:"Not connected — run oven-timer-server.js on the oven station PC"}
        </span>
        {!connected&&<span style={{fontFamily:mono,fontSize:9,color:T.textDim,marginLeft:"auto"}}>Polling {serverUrl||"http://localhost:3002"}</span>}
      </div>

      {/* Live timers */}
      {liveEntries.length>0&&(
        <Card style={{borderLeft:`4px solid ${T.green}`}}>
          <SectionHeader right={<div style={{width:8,height:8,borderRadius:"50%",background:T.green,boxShadow:`0 0 8px ${T.green}`,animation:"pulse 1s infinite"}}/>}>Live Oven Timers</SectionHeader>
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            {liveEntries.map(([mid,t])=>{
              const isOvertime=t.target>0&&t.elapsed>=t.target;
              const pct=t.target>0?Math.min(100,(t.elapsed/t.target)*100):0;
              const color=isOvertime?T.red:t.state==="paused"?T.amber:T.green;
              return(
                <div key={mid} style={{flex:"1 1 220px",padding:14,background:T.bg,border:`1px solid ${color}40`,borderRadius:10}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                    <span style={{fontFamily:mono,fontSize:12,fontWeight:800,color:T.text}}>{t.machine}</span>
                    <Pill color={color}>{isOvertime?"OVERTIME":t.state}</Pill>
                  </div>
                  <div style={{fontFamily:mono,fontSize:32,fontWeight:800,color,letterSpacing:2,textAlign:"center",margin:"10px 0"}}>{fmtSecs(t.elapsed)}</div>
                  {t.target>0&&(
                    <div>
                      <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:T.textDim,fontFamily:mono,marginBottom:3}}>
                        <span>{fmtSecs(Math.max(0,t.target-t.elapsed))} rem</span>
                        <span>{Math.round(pct)}%</span>
                      </div>
                      <div style={{height:4,background:T.card,borderRadius:2,overflow:"hidden"}}>
                        <div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:2,transition:"width 1s linear"}}/>
                      </div>
                    </div>
                  )}
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginTop:6}}>{t.batchId} · {t.coating}</div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Stats KPIs */}
      {stats&&(
        <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
          <KPICard label="Today's Runs" value={stats.todayRuns} sub="completed" accent={T.amber}/>
          <KPICard label="Today's Hours" value={`${stats.todayHours}h`} sub="oven dwell time" accent={T.amber}/>
          <KPICard label="Total Runs" value={stats.totalRuns} sub="all time" accent={T.blue}/>
          <KPICard label="Overtime Runs" value={stats.overtimeRuns} sub="> 2min over target" accent={T.red}/>
        </div>
      )}

      {/* Per-coating avg times */}
      {stats?.coatingStats?.length>0&&(
        <Card>
          <SectionHeader right="avg vs target">Actual vs Target Dwell by Coating</SectionHeader>
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:10}}>
            {stats.coatingStats.map(c=>{
              const targets={"AR":25,"Blue Cut":22,"Mirror":30,"Transitions":35,"Polarized":28,"Hard Coat":20};
              const targetSecs=(targets[c.coating]||0)*60;
              const diff=targetSecs>0?(c.avgSecs-targetSecs):null;
              const over=diff!==null&&diff>120;
              const color=over?T.red:diff!==null&&diff<-120?T.green:T.textMuted;
              return(
                <div key={c.coating} style={{padding:12,background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                  <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:2}}>{c.coating}</div>
                  <div style={{fontSize:22,fontWeight:800,color:T.amber,fontFamily:mono}}>{fmtSecs(c.avgSecs)}</div>
                  <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{c.count} runs · range {fmtSecs(c.minSecs)}–{fmtSecs(c.maxSecs)}</div>
                  {diff!==null&&<div style={{fontSize:10,fontWeight:700,color,fontFamily:mono,marginTop:3}}>{diff>0?"+":""}{fmtSecs(diff)} vs target</div>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Run history table */}
      <Card style={{padding:0}}>
        <div style={{padding:"14px 16px",display:"flex",alignItems:"center",gap:8,borderBottom:`1px solid ${T.border}`,flexWrap:"wrap"}}>
          <span style={{fontSize:13,fontWeight:700,color:T.text}}>Run History</span>
          <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{filtered.length} records</span>
          <div style={{marginLeft:"auto",display:"flex",gap:4,flexWrap:"wrap"}}>
            {coatings.map(c=>(
              <button key={c} onClick={()=>setFilterCoating(c)} style={{padding:"3px 9px",borderRadius:4,fontSize:9,fontFamily:mono,cursor:"pointer",background:filterCoating===c?T.amberDark:T.bg,border:`1px solid ${filterCoating===c?T.amber:T.border}`,color:filterCoating===c?T.amber:T.textDim,fontWeight:700}}>{c}</button>
            ))}
          </div>
        </div>
        {runs.length===0?(
          <div style={{textAlign:"center",padding:40,fontFamily:mono,fontSize:12,color:T.textDim}}>
            {connected?"No runs recorded yet — start OvenTimer.html on the oven station":"Connect the Oven Timer Server to see history"}
          </div>
        ):(
          <div style={{overflowX:"auto",maxHeight:420,overflowY:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead style={{position:"sticky",top:0,background:T.card,zIndex:1}}>
                <tr>
                  {["Machine","Batch","Coating","Started","Target","Actual","Variance","Operator"].map(h=>(
                    <th key={h} style={{fontFamily:mono,fontSize:9,color:T.textDim,letterSpacing:1.5,textAlign:"left",padding:"8px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase",whiteSpace:"nowrap"}}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.slice(0,100).map(r=>{
                  const variance=r.variance;
                  const varColor=variance===null?T.textDim:variance>120?T.red:variance<-120?T.green:T.textDim;
                  return(
                    <tr key={r.id} style={{borderBottom:`1px solid ${T.border}`}}>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.amber,fontWeight:700}}>{r.machine}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.text}}>{r.batchId}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.cyan}}>{r.coating}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim,whiteSpace:"nowrap"}}>{new Date(r.startedAt).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim}}>{r.targetSecs>0?fmtSecs(r.targetSecs):"—"}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,fontWeight:700,color:T.text}}>{fmtSecs(r.actualSecs)}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,fontWeight:700,color:varColor}}>{variance===null?"—":(variance>0?"+":"")+fmtSecs(variance)}</td>
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
  );
}

function CoatingTab({batches,trays,inspections,onBatchControl,ovenServerUrl,settings}){
  const [subView,setSubView]=useState("predictive");
  // Get coater machines from settings
  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  // Context for embedded AI
  const coatingJobs=trays.filter(t=>t.department==="COATING");
  const stagedJobs=coatingJobs.filter(t=>t.state==="COATING_STAGED");
  const inProcess=coatingJobs.filter(t=>t.state==="COATING_IN_PROCESS");
  const rushJobs=coatingJobs.filter(t=>t.rush);
  const contextData={
    jobs:coatingJobs,
    stagedCount:stagedJobs.length,
    inProcessCount:inProcess.length,
    rushCount:rushJobs.length,
    batches:batches,
    machines:coaterMachines,
  };

  return(
    <ProductionStageTab domain="coating" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
    <div>
      <div style={{display:"flex",gap:4,marginBottom:16}}>
        {[{id:"predictive",label:"Predictive Analysis",icon:"📊"},{id:"inspection",label:"Inspection & QC",icon:"🔬"},{id:"oven",label:"Oven History",icon:"🌡"}].map(sv=>(
          <button key={sv.id} onClick={()=>setSubView(sv.id)} style={{background:subView===sv.id?T.blueDark:"transparent",border:`1px solid ${subView===sv.id?T.blue:"transparent"}`,borderRadius:8,padding:"10px 20px",cursor:"pointer",color:subView===sv.id?T.blue:T.textMuted,fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:8,fontFamily:sans}}><span>{sv.icon}</span>{sv.label}</button>
        ))}
      </div>
      {subView==="predictive"&&<PredictiveView batches={batches} trays={trays} onBatchControl={onBatchControl} coaterMachines={coaterMachines}/>}
      {subView==="inspection"&&<InspectionView inspections={inspections}/>}
      {subView==="oven"&&<OvenHistoryView serverUrl={ovenServerUrl}/>}
    </div>
    </ProductionStageTab>
  );
}

function PredictiveView({batches,trays,onBatchControl}){
  const [expandedBatch,setExpandedBatch]=useState(null);
  const predictions=useMemo(()=>COATING_TYPES.map(ct=>{
    const queue=Math.floor(Math.random()*80)+20;
    const predicted=Math.floor(Math.random()*40)+60;
    const timeToFull=Math.floor(Math.random()*120)+15;
    const rec=predicted>=80?"RUN NOW":predicted>=50?"RUN PARTIAL":"WAIT";
    return{type:ct,queue,predicted,timeToFull,recommendation:rec,dailyAvg:Math.floor(Math.random()*200)+50};
  }),[]);
  const recColors={"RUN NOW":T.green,"WAIT":T.amber,"RUN PARTIAL":T.blue};

  // Stage pipeline view
  const stagePipeline=Object.entries(COATING_STAGES).map(([key,stage])=>{
    const count=trays.filter(t=>t.department==="COATING"&&t.coatingStage===key).length;
    return{key,stage,count};
  });

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      {/* Live Stage Pipeline */}
      <Card style={{borderLeft:`4px solid ${T.amber}`}}>
        <SectionHeader right="All machines combined">Coating Line — Live Stage View</SectionHeader>
        <div style={{display:"flex",alignItems:"stretch",gap:0}}>
          {stagePipeline.map(({key,stage,count},i)=>(
            <div key={key} style={{display:"flex",alignItems:"center",flex:1}}>
              <div style={{flex:1,padding:"12px 8px",textAlign:"center",background:count>0?`${stage.color}15`:T.bg,border:`1px solid ${count>0?stage.color:T.border}`,borderRadius:i===0?"8px 0 0 8px":i===stagePipeline.length-1?"0 8px 8px 0":"0",borderLeft:i>0?"none":"1px solid"}}>
                <div style={{fontSize:22,fontWeight:800,color:count>0?stage.color:T.textDim,fontFamily:mono}}>{count}</div>
                <div style={{fontSize:10,color:count>0?stage.color:T.textDim,fontFamily:mono,fontWeight:700,marginTop:2}}>{stage.label}</div>
                <div style={{fontSize:8,color:T.textDim,marginTop:2,fontFamily:mono}}>{stage.desc.slice(0,20)}</div>
              </div>
              {i<stagePipeline.length-1&&(
                <div style={{width:16,display:"flex",alignItems:"center",justifyContent:"center",color:T.textDim,fontSize:12,zIndex:1}}>→</div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Machines with full controls */}
      <div>
        <SectionHeader>Coating Machines — Manual Control</SectionHeader>
        <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
          {batches.map(b=><BatchCard key={b.id} batch={b} trays={trays} expanded={expandedBatch===b.id} onToggle={()=>setExpandedBatch(expandedBatch===b.id?null:b.id)} onControl={onBatchControl}/>)}
        </div>
      </div>

      {/* Fill Predictions */}
      <Card>
        <SectionHeader right="Updated every 60s">Batch Fill Predictions</SectionHeader>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(190px,1fr))",gap:10}}>
          {predictions.map(p=>(
            <div key={p.type} style={{background:T.bg,borderRadius:8,padding:14,border:`1px solid ${T.border}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span style={{fontSize:14,color:T.text,fontWeight:700}}>{p.type}</span>
                <Pill color={recColors[p.recommendation]}>{p.recommendation}</Pill>
              </div>
              <div style={{marginTop:10}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:3}}><span>Queue: {p.queue}</span><span>{p.predicted}% fill</span></div>
                <div style={{height:8,background:T.card,borderRadius:4,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${p.predicted}%`,borderRadius:4,background:p.predicted>=80?T.green:p.predicted>=50?T.amber:T.textDim}}/>
                </div>
              </div>
              <div style={{display:"flex",justifyContent:"space-between",marginTop:8,fontSize:10,color:T.textDim,fontFamily:mono}}>
                <span>ETA full: {p.timeToFull}m</span><span>Avg: {p.dailyAvg}/day</span>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function InspectionView({inspections}){
  const passCount=inspections.filter(i=>i.result==="PASS").length;
  const failCount=inspections.filter(i=>i.result==="FAIL").length;
  const passRate=Math.round((passCount/inspections.length)*100);
  const defectCounts={};
  inspections.forEach(i=>i.defects.forEach(d=>{defectCounts[d]=(defectCounts[d]||0)+1;}));
  const sortedDefects=Object.entries(defectCounts).sort((a,b)=>b[1]-a[1]);
  const maxDefect=sortedDefects.length>0?sortedDefects[0][1]:1;

  return(
    <div style={{display:"flex",flexDirection:"column",gap:20}}>
      <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
        <KPICard label="Pass Rate" value={`${passRate}%`} sub="last 24h" trend={passRate>85?2:-3} accent={passRate>85?T.green:T.red}/>
        <KPICard label="Inspected" value={inspections.length} sub="lenses" accent={T.blue}/>
        <KPICard label="Passed" value={passCount} accent={T.green}/>
        <KPICard label="Failed" value={failCount} accent={T.red}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
        <Card>
          <SectionHeader>Defect Distribution</SectionHeader>
          {sortedDefects.map(([defect,count])=>(
            <div key={defect} style={{marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}><span style={{color:T.textMuted}}>{defect}</span><span style={{color:T.text,fontFamily:mono,fontWeight:700}}>{count}</span></div>
              <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${(count/maxDefect)*100}%`,background:T.red,borderRadius:3,opacity:0.7+(count/maxDefect)*0.3}}/></div>
            </div>
          ))}
        </Card>
        <Card style={{maxHeight:380,overflowY:"auto"}}>
          <SectionHeader>Recent Inspections</SectionHeader>
          {inspections.slice(0,15).map(ins=>(
            <div key={ins.id} style={{display:"flex",gap:8,padding:"5px 0",alignItems:"center",borderBottom:`1px solid ${T.border}`}}>
              <div style={{width:8,height:8,borderRadius:"50%",flexShrink:0,background:ins.result==="PASS"?T.green:T.red,boxShadow:ins.result==="FAIL"?`0 0 6px ${T.red}`:"none"}}/>
              <div style={{flex:1}}>
                <div style={{fontSize:11,color:T.text,fontFamily:mono}}>{ins.job} — {ins.batch}</div>
                <div style={{fontSize:9,color:T.textDim}}>{ins.coatingType} • {ins.inspector}{ins.defects.length>0&&<span style={{color:T.red}}> • {ins.defects.join(", ")}</span>}</div>
              </div>
              <Pill color={ins.result==="PASS"?T.green:T.red}>{ins.result}</Pill>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ── Lightweight markdown renderer for AI chat messages ────────
function MarkdownMsg({text}){
  const lines=(text||"").split("\n");
  const elements=[];
  let i=0;
  while(i<lines.length){
    const line=lines[i];
    const trimmed=line.trim();
    if(!trimmed){elements.push(<div key={i} style={{height:8}}/>);i++;continue;}
    if(trimmed.startsWith("### ")){
      elements.push(<div key={i} style={{fontWeight:800,fontSize:13,color:"#93C5FD",marginTop:12,marginBottom:4}}>{trimmed.slice(4)}</div>);
    } else if(trimmed.startsWith("## ")){
      elements.push(<div key={i} style={{fontWeight:800,fontSize:14,color:"#60A5FA",marginTop:14,marginBottom:6,borderBottom:"1px solid #1E3A5F",paddingBottom:4}}>{trimmed.slice(3)}</div>);
    } else if(trimmed.startsWith("# ")){
      elements.push(<div key={i} style={{fontWeight:900,fontSize:15,color:"#93C5FD",marginTop:16,marginBottom:8}}>{trimmed.slice(2)}</div>);
    } else if(trimmed.startsWith("- ")||trimmed.startsWith("• ")){
      elements.push(<div key={i} style={{display:"flex",gap:8,marginBottom:2,paddingLeft:4}}><span style={{color:"#60A5FA",flexShrink:0,marginTop:1}}>•</span><span style={{flex:1}}><InlineMd text={trimmed.slice(2)}/></span></div>);
    } else if(/^\d+\.\s/.test(trimmed)){
      const num=trimmed.match(/^(\d+)\./)[1];
      elements.push(<div key={i} style={{display:"flex",gap:8,marginBottom:2,paddingLeft:4}}><span style={{color:"#60A5FA",flexShrink:0,minWidth:16,fontWeight:700}}>{num}.</span><span style={{flex:1}}><InlineMd text={trimmed.replace(/^\d+\.\s/,"")}/></span></div>);
    } else if(trimmed.startsWith("**")&&trimmed.endsWith("**")&&trimmed.length>4){
      elements.push(<div key={i} style={{fontWeight:700,marginTop:8,marginBottom:2}}><InlineMd text={trimmed.slice(2,-2)}/></div>);
    } else {
      elements.push(<div key={i} style={{marginBottom:2}}><InlineMd text={trimmed}/></div>);
    }
    i++;
  }
  return <div style={{display:"flex",flexDirection:"column"}}>{elements}</div>;
}
function InlineMd({text}){
  // Handle **bold** inline
  const parts=text.split(/(\*\*[^*]+\*\*)/);
  return <>{parts.map((p,i)=>p.startsWith("**")&&p.endsWith("**")&&p.length>4
    ? <strong key={i} style={{color:"#E2E8F0"}}>{p.slice(2,-2)}</strong>
    : <span key={i}>{p}</span>
  )}</>;
}

// ══════════════════════════════════════════════════════════════
// ── Domain AI Configurations ──────────────────────────────────
// ══════════════════════════════════════════════════════════════

const DOMAIN_CONFIGS = {
  surfacing: {
    title: "Surfacing AI",
    greeting: "I'm your Surfacing specialist. I can help with Rx interpretation, blank selection, queue priority, and defect troubleshooting.",
    quickPrompts: [
      { icon: "📋", label: "Queue Status", text: "Summarize current surfacing queue status and priorities." },
      { icon: "🔴", label: "Rush Jobs", text: "List all rush jobs in surfacing and recommended priority order." },
      { icon: "⚠️", label: "High Power Rx", text: "Identify any high-power Rx jobs (>6.00 sph/cyl) that need special attention." },
      { icon: "🔧", label: "Defect Help", text: "Help me troubleshoot a surfacing defect. What questions should I answer?" },
      { icon: "📊", label: "Throughput Report", text: "Generate a brief throughput report for the current shift.", isReport: true },
    ],
    buildContext: (data) => `You are the Surfacing Specialist AI for Pair Eyewear's lens lab.

CURRENT SURFACING STATE (${new Date().toLocaleString()}):
SURFACING QUEUE: ${data.queueCount || 0} jobs waiting
IN PROCESS: ${data.inProcessCount || 0} jobs
RUSH JOBS: ${data.rushCount || 0} active

JOBS IN SURFACING:
${(data.jobs || []).slice(0, 15).map(j => `  ${j.job || j.id}: ${j.rx?.sphere || '?'}/${j.rx?.cylinder || '?'} | ${j.state} ${j.rush ? '🔴 RUSH' : ''}`).join('\n') || '  No jobs in surfacing'}

STAGE METRICS:
  Queue depth: ${data.queueCount || 0}
  In process: ${data.inProcessCount || 0}
  Rush active: ${data.rushCount || 0}

You are an expert in lens surfacing operations. Help operators with:
- Rx interpretation and machine setup guidance
- Troubleshooting surfacing defects (scratches, pits, tool marks)
- Prioritizing rush jobs and managing queue
- Blank selection guidance based on Rx power

Be direct and technical. Use actual job IDs from the data.`,
  },

  cutting: {
    title: "Cutting AI",
    greeting: "I'm your Cutting/Edging specialist. I can help with edge quality, frame fit, breakage analysis, and axis verification.",
    quickPrompts: [
      { icon: "📋", label: "Queue Status", text: "What's the current cutting queue status?" },
      { icon: "💥", label: "Recent Breaks", text: "List any breaks reported in cutting today and their causes." },
      { icon: "🔴", label: "Rush Priority", text: "Which rush jobs need immediate edging attention?" },
      { icon: "🔧", label: "Edge Issue", text: "Help troubleshoot an edge quality issue. What information do you need?" },
      { icon: "📐", label: "Frame Fit", text: "Guide me through checking frame-to-lens fit parameters." },
    ],
    buildContext: (data) => `You are the Cutting/Edging Specialist AI for Pair Eyewear's lens lab.

CURRENT CUTTING STATE (${new Date().toLocaleString()}):
CUTTING QUEUE: ${data.queueCount || 0} jobs
IN PROCESS: ${data.inProcessCount || 0} jobs
ON HOLD: ${data.holdCount || 0} jobs
RUSH ACTIVE: ${data.rushCount || 0}

JOBS IN CUTTING:
${(data.jobs || []).slice(0, 15).map(j => `  ${j.job || j.id}: Frame ${j.frameRef || 'TBD'} | ${j.state} ${j.rush ? '🔴 RUSH' : ''}`).join('\n') || '  No jobs in cutting'}

You are an expert in lens edging operations. Help with:
- Edge quality troubleshooting (chips, cracks, bevel issues)
- Frame-to-lens fit problems
- Axis orientation verification
- Safety bevel requirements

Be specific with job IDs and frame references.`,
  },

  coating: {
    title: "Coating AI",
    greeting: "I'm your Coating specialist. I can help with batch timing, yield analysis, defect patterns, and oven/coater optimization.",
    quickPrompts: [
      { icon: "📊", label: "Batch Status", text: "Summarize all active coating batches and their status." },
      { icon: "⏱", label: "Fill Prediction", text: "When should we run the next batch for each coating type?" },
      { icon: "📉", label: "Yield Analysis", text: "Analyze current yield rates and flag any concerns.", isReport: true },
      { icon: "⚠️", label: "Defect Pattern", text: "Are there any defect patterns suggesting equipment issues?" },
      { icon: "🌡", label: "Oven Timing", text: "Review current oven dwell times and recommend adjustments." },
      { icon: "🔴", label: "Rush Coating", text: "Which rush jobs are currently in coating and their ETA?" },
    ],
    buildContext: (data) => `You are the Coating Specialist AI for Pair Eyewear's lens lab.

CURRENT COATING STATE (${new Date().toLocaleString()}):
TOTAL IN COATING: ${data.inCoating || 0} jobs across ${(data.batches || []).length} batches
MACHINES: ${(data.machines || []).join(', ') || 'Unknown'}

LIVE BATCHES:
${(data.batches || []).map(b => `  ${b.id}: ${b.coatingType || b.coating} | ${b.machine} | ${b.loaded}/${b.capacity} | ${b.status}`).join('\n') || '  No active batches'}

STAGE PIPELINE:
${Object.entries(data.stageCounts || {}).map(([stage, count]) => `  ${stage}: ${count}`).join('\n') || '  No stage data'}

YIELD BY COATING TYPE:
${Object.entries(data.yieldByType || {}).map(([type, rate]) => `  ${type}: ${rate}%`).join('\n') || '  No yield data'}

You are an expert in AR, Blue Cut, Mirror, Transitions, Polarized, and Hard Coat processes.
Help operators with:
- Batch timing and fill optimization
- Yield troubleshooting by defect type
- Oven/coater dwell time decisions
- Chemical bath maintenance indicators

Flag anything below 90% yield as a concern.`,
  },

  assembly: {
    title: "Assembly AI",
    greeting: "I'm your Assembly specialist. I can help with station optimization, operator performance, QC returns, and frame troubleshooting.",
    quickPrompts: [
      { icon: "📋", label: "Station Status", text: "Show current status of all assembly stations." },
      { icon: "🏆", label: "Leaderboard", text: "Who are today's top performers in assembly?" },
      { icon: "🔴", label: "Rush Priority", text: "Which rush jobs need immediate assembly attention?" },
      { icon: "⚠️", label: "QC Returns", text: "Analyze recent QC returns and identify patterns." },
      { icon: "📊", label: "Shift Report", text: "Generate current shift assembly summary.", isReport: true },
      { icon: "🔧", label: "Frame Issue", text: "Help troubleshoot a frame assembly problem." },
    ],
    buildContext: (data) => `You are the Assembly Specialist AI for Pair Eyewear's lens lab.

CURRENT ASSEMBLY STATE (${new Date().toLocaleString()}):
JOBS IN ASSEMBLY: ${data.inProcessCount || 0} in progress
QUEUE DEPTH: ${data.queueCount || 0} waiting
COMPLETED TODAY: ${data.completedToday || 0}
ON HOLD: ${data.holdCount || 0}

JOBS IN ASSEMBLY:
${(data.jobs || []).slice(0, 15).map(j => `  ${j.job || j.id}: ${j.state} ${j.rush ? '🔴 RUSH' : ''}`).join('\n') || '  No jobs in assembly'}

QC RETURNS:
${(data.qcReturns || []).slice(0, 3).map(r => `  ${r.job}: ${r.reason}`).join('\n') || '  None recent'}

You are an expert in eyewear assembly operations. Help with:
- Station assignment optimization
- Frame/lens compatibility issues
- Screw/hinge troubleshooting
- QC return root cause analysis
- Rush job prioritization

Reference specific job IDs.`,
  },

  shipping: {
    title: "Shipping AI",
    greeting: "I'm your Shipping specialist. I can help with priority decisions, overdue tracking, carrier selection, and customer escalations.",
    quickPrompts: [
      { icon: "📦", label: "Ready to Ship", text: "What jobs are ready to ship right now?" },
      { icon: "🔴", label: "Overdue", text: "List all overdue shipments and recommended actions." },
      { icon: "⏰", label: "Due Today", text: "Which shipments are due today and their status?" },
      { icon: "🚚", label: "Carrier Summary", text: "Summarize today's shipments by carrier." },
      { icon: "📊", label: "EOD Report", text: "Generate end-of-day shipping report.", isReport: true },
      { icon: "🔍", label: "Track Job", text: "Help me track a specific job. Which job ID?" },
    ],
    buildContext: (data) => `You are the Shipping Specialist AI for Pair Eyewear's lens lab.

CURRENT SHIPPING STATE (${new Date().toLocaleString()}):
READY TO SHIP: ${data.readyCount || 0} jobs
SHIPPED TODAY: ${data.shippedToday || 0}
OVERDUE: ${data.overdueCount || 0}

JOBS IN SHIPPING:
${(data.jobs || []).slice(0, 15).map(j => `  ${j.job || j.id}: ${j.state} ${j.rush ? '🔴 RUSH' : ''}`).join('\n') || '  No jobs in shipping'}

OVERDUE JOBS:
${(data.overdue || []).map(j => `  ${j.job || j.id}: Due ${j.dueDate} — ${j.reason || 'Unknown hold'}`).join('\n') || '  None'}

You are an expert in optical lab shipping operations. Help with:
- Shipping priority decisions
- Address/label verification
- Carrier selection optimization
- Tracking inquiry handling
- Customer escalation guidance

Always include job IDs and specific timing.`,
  },

  inventory: {
    title: "Inventory AI",
    greeting: "I'm your Inventory specialist. I can help with stock levels, reorder recommendations, blank searches, and usage trend analysis.",
    quickPrompts: [
      { icon: "⚠️", label: "Critical Stock", text: "What items are out of stock or critically low?" },
      { icon: "📊", label: "Stock Report", text: "Generate inventory status report.", isReport: true },
      { icon: "🔍", label: "Find Blank", text: "Help me find a lens blank. What Rx parameters?" },
      { icon: "📈", label: "Usage Trends", text: "Which SKUs are being consumed fastest?" },
      { icon: "📦", label: "Reorder List", text: "Generate recommended reorder list based on usage.", isReport: true },
      { icon: "🌡", label: "By Coating", text: "Summarize stock levels by coating type." },
    ],
    buildContext: (data) => `You are the Inventory Specialist AI for Pair Eyewear's lens lab.

INVENTORY STATUS (${new Date().toLocaleString()}):
TOTAL SKUs: ${data.totalSkus || 0}
TOTAL UNITS: ${data.totalUnits || 0}
OUT OF STOCK: ${data.outOfStock || 0} SKUs
LOW STOCK: ${data.lowStock || 0} SKUs

CRITICAL ALERTS:
${(data.criticalAlerts || []).slice(0, 5).map(m => `  ${m.sku}: ${m.name} — ${m.qty} left`).join('\n') || '  None'}

STOCK BY COATING TYPE:
${Object.entries(data.byCoatingType || {}).map(([type, count]) => `  ${type}: ${count} units`).join('\n') || '  No data'}

RECENT PICKS:
${(data.recentPicks || []).slice(0, 5).map(p => `  ${p.sku}: qty ${p.qty}`).join('\n') || '  None'}

You are an expert in lens blank inventory management. Help with:
- Low stock prioritization and reorder recommendations
- Finding specific blanks by Rx parameters
- Usage trend analysis
- Kardex pick optimization
- Safety stock level recommendations

Reference specific SKUs and quantities.`,
  },

  maintenance: {
    title: "Maintenance AI",
    greeting: "I'm your Maintenance specialist. I can help with PM scheduling, troubleshooting, downtime analysis, and spare parts.",
    quickPrompts: [
      { icon: "⚠️", label: "Alerts", text: "What equipment issues need immediate attention?" },
      { icon: "📅", label: "PM Schedule", text: "What preventive maintenance is due this week?" },
      { icon: "🔴", label: "Downtime", text: "Summarize recent equipment downtime and root causes." },
      { icon: "📊", label: "Health Report", text: "Generate equipment health report.", isReport: true },
      { icon: "🔧", label: "Troubleshoot", text: "Help troubleshoot an equipment issue. Which asset?" },
      { icon: "📦", label: "Parts Check", text: "Are there any spare parts running low?" },
    ],
    buildContext: (data) => `You are the Maintenance Specialist AI for Pair Eyewear's lens lab.

MAINTENANCE STATUS (${new Date().toLocaleString()}):
TOTAL ASSETS: ${data.totalAssets || 0}
OPERATIONAL: ${data.operational || 0}
DOWN: ${data.down || 0}

OPEN WORK ORDERS:
${(data.openTasks || []).slice(0, 5).map(t => `  ${t.id}: ${t.asset} — ${t.description} [${t.priority}]`).join('\n') || '  None'}

OVERDUE PM:
${(data.overduePM || []).slice(0, 5).map(t => `  ${t.asset}: ${t.pmType} due ${t.dueDate}`).join('\n') || '  None'}

RECENT DOWNTIME:
${(data.recentDowntime || []).slice(0, 5).map(d => `  ${d.asset}: ${d.duration}min — ${d.reason}`).join('\n') || '  None'}

You are an expert in optical lab equipment maintenance. Help with:
- PM scheduling and prioritization
- Troubleshooting equipment issues
- Root cause analysis for recurring failures
- Spare parts inventory management
- Downtime impact analysis

Reference specific asset IDs and work order numbers.`,
  },
};

// ══════════════════════════════════════════════════════════════
// ── Embedded AI Panel (Reusable) ──────────────────────────────
// ══════════════════════════════════════════════════════════════
function EmbeddedAIPanel({ domain, contextData, serverUrl, onClose, settings }) {
  const config = DOMAIN_CONFIGS[domain] || DOMAIN_CONFIGS.coating;
  const mono = "'JetBrains Mono',monospace";

  const [messages, setMessages] = useState([
    { role: "assistant", content: config.greeting }
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [reportDownloading, setReportDownloading] = useState(null);
  const chatRef = useRef(null);

  const REPORT_KEYWORDS = ["report", "summary", "analysis", "generate", "breakdown", "overview"];
  const isReportRequest = (text) => REPORT_KEYWORDS.some(k => text.toLowerCase().includes(k));

  const sendMessage = async (text) => {
    const userText = (text || input).trim();
    if (!userText || loading) return;
    setInput("");

    const willBeReport = isReportRequest(userText);
    const newMessages = [...messages, { role: "user", content: userText }];
    setMessages(newMessages);
    setLoading(true);

    try {
      const systemPrompt = config.buildContext(contextData || {});
      const result = await callGateway(settings, userText, { context: systemPrompt });
      const reply = result?.response || "Sorry, I couldn't get a response.";
      setMessages(prev => [...prev, { role: "assistant", content: reply, isReport: willBeReport, prompt: userText }]);
    } catch (e) {
      setMessages(prev => [...prev, { role: "assistant", content: `⚠️ ${e.message}\n\nMake sure MCP Gateway is running.` }]);
    }
    setLoading(false);
  };

  const downloadWordReport = async (msg, idx) => {
    setReportDownloading(idx);
    try {
      const title = msg.prompt?.replace(/^generate\s+a?\s*/i, "").replace(/report.*/i, "Report").trim().slice(0, 60) || "Report";
      const res = await fetch(`${serverUrl}/api/report`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, content: msg.content, generatedBy: `${config.title}`, timestamp: Date.now() }),
      });
      if (!res.ok) throw new Error("Server error");
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${domain}_Report_${new Date().toISOString().slice(0, 10)}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      alert(`Word export failed: ${e.message}`);
    }
    setReportDownloading(null);
  };

  useEffect(() => {
    if (chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [messages, loading]);

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%", background: T.surface }}>
      {/* Header */}
      <div style={{ padding: "12px 14px", borderBottom: `1px solid ${T.border}`, display: "flex", alignItems: "center", gap: 8, flexShrink: 0 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: `linear-gradient(135deg, ${T.blue}, ${T.blueGlow})`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 13 }}>🤖</div>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: T.text }}>{config.title}</div>
          <div style={{ fontSize: 9, color: T.green, fontFamily: mono }}>● ONLINE</div>
        </div>
        <button onClick={onClose} style={{ background: "transparent", border: `1px solid ${T.border}`, borderRadius: 4, padding: "4px 8px", cursor: "pointer", color: T.textDim, fontSize: 10 }}>✕</button>
      </div>

      {/* Quick Actions */}
      <div style={{ padding: "10px 12px", borderBottom: `1px solid ${T.border}`, display: "flex", flexWrap: "wrap", gap: 4, flexShrink: 0 }}>
        {config.quickPrompts.slice(0, 4).map((p, i) => (
          <button key={i} onClick={() => sendMessage(p.text)} disabled={loading}
            style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 8px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 5, cursor: loading ? "not-allowed" : "pointer", color: T.textMuted, fontSize: 10, fontFamily: mono, opacity: loading ? 0.5 : 1 }}>
            <span>{p.icon}</span><span>{p.label}</span>
          </button>
        ))}
      </div>

      {/* Chat Messages */}
      <div ref={chatRef} style={{ flex: 1, overflowY: "auto", padding: "12px", display: "flex", flexDirection: "column", gap: 10 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ display: "flex", gap: 8, flexDirection: m.role === "user" ? "row-reverse" : "row", alignItems: "flex-start" }}>
            <div style={{ width: 24, height: 24, borderRadius: 5, background: m.role === "user" ? T.blue : `linear-gradient(135deg, ${T.blue}50, ${T.blueGlow}50)`, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>
              {m.role === "user" ? "👤" : "🤖"}
            </div>
            <div style={{ maxWidth: "85%", display: "flex", flexDirection: "column", gap: 4 }}>
              <div style={{ padding: "8px 10px", borderRadius: 8, background: m.role === "user" ? `${T.blue}20` : T.bg, border: `1px solid ${m.role === "user" ? T.blue : T.border}`, fontSize: 11, color: T.text, lineHeight: 1.6 }}>
                {m.role === "user" ? <span style={{ fontFamily: mono }}>{m.content}</span> : <MarkdownMsg text={m.content} />}
              </div>
              {m.role === "assistant" && m.isReport && (
                <button onClick={() => downloadWordReport(m, i)} disabled={reportDownloading === i}
                  style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", background: `${T.blue}20`, border: `1px solid ${T.blue}`, borderRadius: 4, color: T.blue, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                  {reportDownloading === i ? "⏳..." : "📄 Word"}
                </button>
              )}
            </div>
          </div>
        ))}
        {loading && (
          <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
            <div style={{ width: 24, height: 24, borderRadius: 5, background: `linear-gradient(135deg, ${T.blue}50, ${T.blueGlow}50)`, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11 }}>🤖</div>
            <div style={{ padding: "8px 10px", borderRadius: 8, background: T.bg, border: `1px solid ${T.border}` }}>
              <div style={{ display: "flex", gap: 3 }}>
                {[0, 1, 2].map(j => (<div key={j} style={{ width: 5, height: 5, borderRadius: "50%", background: T.blue, animation: `pulse 1.2s ${j * 0.2}s infinite` }} />))}
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div style={{ padding: "10px 12px", borderTop: `1px solid ${T.border}`, display: "flex", gap: 8, flexShrink: 0 }}>
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
          placeholder="Ask a question..." disabled={loading}
          style={{ flex: 1, background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, padding: "8px 10px", color: T.text, fontSize: 11, fontFamily: mono, outline: "none" }} />
        <button onClick={() => sendMessage()} disabled={!input.trim() || loading}
          style={{ padding: "0 14px", background: input.trim() && !loading ? T.blue : T.border, border: "none", borderRadius: 6, color: input.trim() && !loading ? "#fff" : T.textDim, fontSize: 11, fontWeight: 700, cursor: input.trim() && !loading ? "pointer" : "default", fontFamily: mono }}>
          Send
        </button>
      </div>

      <style>{`@keyframes pulse{0%,100%{opacity:0.3;transform:scale(0.8)}50%{opacity:1;transform:scale(1.1)}}`}</style>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Production Stage Tab Wrapper ──────────────────────────────
// ══════════════════════════════════════════════════════════════
function ProductionStageTab({ domain, children, contextData, serverUrl, settings }) {
  const [aiPanelOpen, setAIPanelOpen] = useState(false);

  return (
    <div style={{ display: "flex", height: "calc(100vh - 160px)", overflow: "hidden" }}>
      {/* Main Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "22px 28px" }}>
        {children}
      </div>

      {/* AI Toggle Button (when collapsed) */}
      {!aiPanelOpen && (
        <button onClick={() => setAIPanelOpen(true)}
          style={{ position: "fixed", right: 0, top: "50%", transform: "translateY(-50%)", background: T.blue, border: "none", borderRadius: "8px 0 0 8px", padding: "14px 10px", cursor: "pointer", color: "#fff", fontSize: 18, zIndex: 50, boxShadow: `0 0 20px ${T.blue}40` }}>
          🤖
        </button>
      )}

      {/* AI Sidebar */}
      <div style={{ width: aiPanelOpen ? 320 : 0, overflow: "hidden", transition: "width 0.3s ease", borderLeft: aiPanelOpen ? `1px solid ${T.border}` : "none", background: T.surface, flexShrink: 0 }}>
        {aiPanelOpen && (
          <EmbeddedAIPanel domain={domain} contextData={contextData} serverUrl={serverUrl} onClose={() => setAIPanelOpen(false)} settings={settings} />
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Surfacing Tab ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function SurfacingTab({ trays, ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";

  // Filter trays in surfacing department
  const surfacingJobs = useMemo(() => trays.filter(t => t.department === "SURFACING"), [trays]);
  const queueJobs = surfacingJobs.filter(t => t.state === "BOUND" || t.state === "ACTIVE");
  const inProcess = surfacingJobs.filter(t => t.state === "IN_PROCESS" || t.state === "COATING_STAGED");
  const rushJobs = surfacingJobs.filter(t => t.rush);
  const holdJobs = surfacingJobs.filter(t => t.state === "QC_HOLD");

  const contextData = {
    jobs: surfacingJobs,
    queueCount: queueJobs.length,
    inProcessCount: inProcess.length,
    rushCount: rushJobs.length,
    holdCount: holdJobs.length,
  };

  return (
    <ProductionStageTab domain="surfacing" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>🌀 Surfacing</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Lens surfacing and grinding operations</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>QUEUE</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{queueJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>IN PROCESS</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{inProcess.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>RUSH</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: rushJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{rushJobs.length}</div>
          </div>
        </div>
      </div>

      {/* WIP Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${surfacingJobs.length} total`}>WIP Queue</SectionHeader>
        {surfacingJobs.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: T.bg }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>TRAY</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATUS</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>COATING</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontSize: 10, color: T.textDim, fontFamily: mono }}>TIME IN STAGE</th>
              </tr>
            </thead>
            <tbody>
              {surfacingJobs.slice(0, 20).map(t => {
                const mins = t.updatedAt ? Math.floor((Date.now() - t.updatedAt) / 60000) : 0;
                return (
                  <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}`, background: t.rush ? `${T.red}08` : "transparent" }}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {t.job || "—"} {t.rush && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{t.id}</td>
                    <td style={{ padding: "10px 12px" }}><Pill color={t.state === "QC_HOLD" ? T.red : T.blue}>{t.state}</Pill></td>
                    <td style={{ padding: "10px 12px", fontSize: 11, color: T.textMuted }}>{t.coatingType || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: mins > 60 ? T.amber : T.textDim, textAlign: "right" }}>{mins}m</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No jobs in surfacing</div>
        )}
      </Card>

      {/* Hold Queue */}
      {holdJobs.length > 0 && (
        <Card>
          <SectionHeader right={`${holdJobs.length} on hold`}>QC Holds</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {holdJobs.map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: `${T.red}10`, borderRadius: 6, borderLeft: `4px solid ${T.red}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: T.text }}>{t.job}</div>
                  <div style={{ fontSize: 11, color: T.textDim }}>Tray: {t.id}</div>
                </div>
                <Pill color={T.red}>HOLD</Pill>
              </div>
            ))}
          </div>
        </Card>
      )}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Cutting Tab ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function CuttingTab({ trays, breakage, ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";

  const cuttingJobs = useMemo(() => trays.filter(t => t.department === "CUTTING"), [trays]);
  const queueJobs = cuttingJobs.filter(t => t.state === "BOUND" || t.state === "ACTIVE");
  const inProcess = cuttingJobs.filter(t => t.state === "IN_PROCESS");
  const rushJobs = cuttingJobs.filter(t => t.rush);
  const holdJobs = cuttingJobs.filter(t => t.state === "QC_HOLD");

  // Recent breaks in cutting
  const cuttingBreaks = (breakage || []).filter(b => b.dept === "CUTTING").slice(0, 10);

  const contextData = {
    jobs: cuttingJobs,
    queueCount: queueJobs.length,
    inProcessCount: inProcess.length,
    rushCount: rushJobs.length,
    holdCount: holdJobs.length,
    recentBreaks: cuttingBreaks,
  };

  return (
    <ProductionStageTab domain="cutting" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>✂️ Cutting / Edging</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Lens cutting and edging operations</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>QUEUE</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{queueJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>IN PROCESS</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{inProcess.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>RUSH</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: rushJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{rushJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>BREAKS</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: cuttingBreaks.length > 0 ? T.amber : T.green, fontFamily: mono }}>{cuttingBreaks.length}</div>
          </div>
        </div>
      </div>

      {/* WIP Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${cuttingJobs.length} total`}>WIP Queue</SectionHeader>
        {cuttingJobs.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: T.bg }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>TRAY</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATUS</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>COATING</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontSize: 10, color: T.textDim, fontFamily: mono }}>TIME</th>
              </tr>
            </thead>
            <tbody>
              {cuttingJobs.slice(0, 20).map(t => {
                const mins = t.updatedAt ? Math.floor((Date.now() - t.updatedAt) / 60000) : 0;
                return (
                  <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}`, background: t.rush ? `${T.red}08` : "transparent" }}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {t.job || "—"} {t.rush && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{t.id}</td>
                    <td style={{ padding: "10px 12px" }}><Pill color={t.state === "QC_HOLD" ? T.red : T.blue}>{t.state}</Pill></td>
                    <td style={{ padding: "10px 12px", fontSize: 11, color: T.textMuted }}>{t.coatingType || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: mins > 60 ? T.amber : T.textDim, textAlign: "right" }}>{mins}m</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No jobs in cutting</div>
        )}
      </Card>

      {/* Recent Breaks */}
      {cuttingBreaks.length > 0 && (
        <Card>
          <SectionHeader right={`${cuttingBreaks.length} today`}>Recent Breaks</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {cuttingBreaks.slice(0, 5).map((b, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 12, padding: 10, background: T.bg, borderRadius: 6, borderLeft: `3px solid ${T.amber}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: T.text }}>{b.job}</div>
                  <div style={{ fontSize: 10, color: T.textDim }}>{b.type} • {b.lens}</div>
                </div>
                <div style={{ fontFamily: mono, fontSize: 11, color: T.amber }}>${b.cost?.toFixed(2)}</div>
              </div>
            ))}
          </div>
        </Card>
      )}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Assembly Tab ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function AssemblyTab({ trays, ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";

  const assemblyJobs = useMemo(() => trays.filter(t => t.department === "ASSEMBLY"), [trays]);
  const queueJobs = assemblyJobs.filter(t => t.state === "BOUND" || t.state === "ACTIVE");
  const inProcess = assemblyJobs.filter(t => t.state === "IN_PROCESS");
  const rushJobs = assemblyJobs.filter(t => t.rush);
  const holdJobs = assemblyJobs.filter(t => t.state === "QC_HOLD");
  const completedToday = trays.filter(t => t.state === "COMPLETE" && t.updatedAt && (Date.now() - t.updatedAt) < 86400000).length;

  const contextData = {
    jobs: assemblyJobs,
    queueCount: queueJobs.length,
    inProcessCount: inProcess.length,
    rushCount: rushJobs.length,
    holdCount: holdJobs.length,
    completedToday,
    qcReturns: holdJobs.map(t => ({ job: t.job, reason: "QC Hold" })),
  };

  return (
    <ProductionStageTab domain="assembly" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>🔧 Assembly</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Frame assembly and final inspection</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>QUEUE</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{queueJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>IN PROCESS</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{inProcess.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>COMPLETED</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{completedToday}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>RUSH</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: rushJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{rushJobs.length}</div>
          </div>
        </div>
      </div>

      {/* WIP Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${assemblyJobs.length} total`}>WIP Queue</SectionHeader>
        {assemblyJobs.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: T.bg }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>TRAY</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATUS</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>COATING</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontSize: 10, color: T.textDim, fontFamily: mono }}>TIME</th>
              </tr>
            </thead>
            <tbody>
              {assemblyJobs.slice(0, 20).map(t => {
                const mins = t.updatedAt ? Math.floor((Date.now() - t.updatedAt) / 60000) : 0;
                return (
                  <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}`, background: t.rush ? `${T.red}08` : "transparent" }}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {t.job || "—"} {t.rush && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{t.id}</td>
                    <td style={{ padding: "10px 12px" }}><Pill color={t.state === "QC_HOLD" ? T.red : T.blue}>{t.state}</Pill></td>
                    <td style={{ padding: "10px 12px", fontSize: 11, color: T.textMuted }}>{t.coatingType || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: mins > 60 ? T.amber : T.textDim, textAlign: "right" }}>{mins}m</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No jobs in assembly</div>
        )}
      </Card>

      {/* QC Returns */}
      {holdJobs.length > 0 && (
        <Card>
          <SectionHeader right={`${holdJobs.length} returns`}>QC Returns</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {holdJobs.map(t => (
              <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: `${T.amber}10`, borderRadius: 6, borderLeft: `4px solid ${T.amber}` }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: T.text }}>{t.job}</div>
                  <div style={{ fontSize: 11, color: T.textDim }}>Tray: {t.id}</div>
                </div>
                <Pill color={T.amber}>QC RETURN</Pill>
              </div>
            ))}
          </div>
        </Card>
      )}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Shipping Tab ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function ShippingTab({ trays, ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";

  const shippingJobs = useMemo(() => trays.filter(t => t.department === "SHIPPING"), [trays]);
  const readyToShip = shippingJobs.filter(t => t.state === "COMPLETE");
  const inProcess = shippingJobs.filter(t => t.state !== "COMPLETE");
  const rushJobs = shippingJobs.filter(t => t.rush);

  // Simulate overdue (jobs in shipping > 2 hours)
  const overdueJobs = shippingJobs.filter(t => t.updatedAt && (Date.now() - t.updatedAt) > 2 * 3600000);
  const shippedToday = trays.filter(t => t.state === "SHIPPED" || (t.department === "SHIPPING" && t.state === "COMPLETE")).length;

  const contextData = {
    jobs: shippingJobs,
    readyCount: readyToShip.length,
    inProcessCount: inProcess.length,
    rushCount: rushJobs.length,
    overdueCount: overdueJobs.length,
    shippedToday,
    overdue: overdueJobs.map(t => ({ job: t.job, dueDate: "Today", reason: "Delayed" })),
  };

  return (
    <ProductionStageTab domain="shipping" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>📤 Shipping</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Final QC and shipment processing</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>READY</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{readyToShip.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>SHIPPED TODAY</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{shippedToday}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>OVERDUE</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: overdueJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{overdueJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>RUSH</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: rushJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{rushJobs.length}</div>
          </div>
        </div>
      </div>

      {/* Ready to Ship */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${readyToShip.length} ready`}>Ready to Ship</SectionHeader>
        {readyToShip.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead>
              <tr style={{ background: T.bg }}>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>TRAY</th>
                <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>COATING</th>
                <th style={{ padding: "10px 12px", textAlign: "right", fontSize: 10, color: T.textDim, fontFamily: mono }}>WAIT TIME</th>
              </tr>
            </thead>
            <tbody>
              {readyToShip.slice(0, 20).map(t => {
                const mins = t.updatedAt ? Math.floor((Date.now() - t.updatedAt) / 60000) : 0;
                return (
                  <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}`, background: t.rush ? `${T.red}08` : "transparent" }}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {t.job || "—"} {t.rush && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{t.id}</td>
                    <td style={{ padding: "10px 12px", fontSize: 11, color: T.textMuted }}>{t.coatingType || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: mins > 120 ? T.red : T.textDim, textAlign: "right" }}>{mins}m</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No jobs ready to ship</div>
        )}
      </Card>

      {/* Overdue */}
      {overdueJobs.length > 0 && (
        <Card>
          <SectionHeader right={`${overdueJobs.length} overdue`}>Overdue Shipments</SectionHeader>
          <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
            {overdueJobs.map(t => {
              const hrs = t.updatedAt ? Math.floor((Date.now() - t.updatedAt) / 3600000) : 0;
              return (
                <div key={t.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: `${T.red}10`, borderRadius: 6, borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: T.text }}>{t.job}</div>
                    <div style={{ fontSize: 11, color: T.textDim }}>Waiting {hrs}+ hours</div>
                  </div>
                  <Pill color={T.red}>OVERDUE</Pill>
                </div>
              );
            })}
          </div>
        </Card>
      )}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Claude AI Assistant Tab ───────────────────────────────────
// ══════════════════════════════════════════════════════════════
function AIAssistantTab({trays,batches,settings}){
  // Get coater machines from settings (fallback to MACHINES constant)
  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  const [messages,setMessages]=useState([
    {role:"assistant",content:"Hello! I'm your Lab_Assistant AI. I have full context on your tray fleet, coating batches, and production data.\n\nAsk me anything — job lookups, yield analysis, shift reports — or click a quick action. For reports, I'll also offer a **Download as Word** button so you can share them directly."}
  ]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [reportDownloading,setReportDownloading]=useState(null); // messageIdx
  const [serverUrl,setServerUrl]=useState("http://localhost:3002");
  const chatRef=useRef(null);

  const REPORT_KEYWORDS=["report","summary","analysis","generate","write up","breakdown","overview"];
  const isReportRequest=(text)=>REPORT_KEYWORDS.some(k=>text.toLowerCase().includes(k));

  const QUICK_PROMPTS=[
    {icon:"🔍", label:"Find a job",          text:"Look up job "},
    {icon:"📊", label:"Shift report",         text:"Generate a shift summary report for today including coating batch counts, yield rates by machine, and any notable issues. Format with sections and bullet points.", isReport:true},
    {icon:"⏱",  label:"WIP Aging Report",    text:"__WIP_AGING__", isReport:true},
    {icon:"⚠️", label:"Overdue trays",        text:"Which trays have been in the same state for the longest time? List the top 5 most overdue with estimated time stuck."},
    {icon:"🏭", label:"Machine analysis",     text:"Generate a machine performance analysis report comparing all three coating machines on yield, throughput, and dwell time accuracy.", isReport:true},
    {icon:"💡", label:"Coating yield",        text:"What is the overall coating pass rate across all batches? Break it down by coating type and flag anything below 90%."},
    {icon:"🔴", label:"Rush jobs",            text:"List all current rush jobs and their exact locations in the lab right now."},
    {icon:"📋", label:"End of day report",    text:"Generate a comprehensive end-of-day production report including total jobs processed, coating utilization, breakage summary, and recommendations for tomorrow's shift.", isReport:true},
  ];

  const buildAgingPrompt=()=>{
    // WIP = any tray that is not IDLE
    const wip = trays.filter(t=>t.state!=="IDLE" && t.job);
    const now = Date.now();

    // Compute days in lab from updatedAt (proxy until DVI receivedAt is live)
    // Due date is simulated as 3–5 business days from entry; DVI will supply real values
    const rows = wip.map(t=>{
      const msInLab  = now - (t.updatedAt || now);
      const daysInLab= msInLab / 86400000;
      const hrsInLab = msInLab / 3600000;
      // Simulated due date: rush = +1d, standard = +3d from entry
      const dueMsOffset = t.rush ? 86400000 : 3 * 86400000;
      const dueDate  = new Date((t.updatedAt || now) + dueMsOffset);
      const dueDateStr = dueDate.toLocaleDateString("en-US",{month:"short",day:"numeric"});
      const daysUntilDue = (dueDate - now) / 86400000;
      const overdue  = daysUntilDue < 0;
      const dueSoon  = !overdue && daysUntilDue < 1;
      return { t, daysInLab, hrsInLab, dueDateStr, daysUntilDue, overdue, dueSoon };
    }).sort((a,b)=>b.daysInLab - a.daysInLab); // oldest first

    const overdueCount  = rows.filter(r=>r.overdue).length;
    const dueSoonCount  = rows.filter(r=>r.dueSoon).length;
    const avgDays       = rows.length ? (rows.reduce((s,r)=>s+r.daysInLab,0)/rows.length).toFixed(2) : 0;

    const rowLines = rows.map(r=>{
      const d = r.daysInLab < 1
        ? `${Math.round(r.hrsInLab)}h`
        : `${r.daysInLab.toFixed(1)}d`;
      const flag = r.overdue ? " ⚠ OVERDUE" : r.t.rush ? " 🔴 RUSH" : r.dueSoon ? " ⏰ DUE TODAY" : "";
      return `  ${r.t.job} | Tray: ${r.t.id} | In lab: ${d} | Due: ${r.dueDateStr} | ${r.t.department||"?"} → ${r.t.state}${flag}`;
    }).join("\n");

    return `Generate a WIP Aging Report for the Pair Eyewear assembly lab.

REPORT DATE: ${new Date().toLocaleString()}
TOTAL WIP JOBS: ${rows.length}
AVERAGE TIME IN LAB: ${avgDays} days
OVERDUE: ${overdueCount} jobs
DUE TODAY: ${dueSoonCount} jobs

ALL WIP JOBS (sorted oldest first — Days In Lab | Due Date | Location | Status):
${rowLines || "  No active WIP jobs"}

Generate a professional WIP Aging Report with these sections:
## WIP Aging Summary
A brief 2–3 sentence overview of the current WIP state.

## Aging Detail Table
Present all jobs as a clean text table with columns: Job | Tray | Days In Lab | Due Date | Location | Status | Flag
Sort by Days In Lab descending. Flag overdue jobs with ⚠, rush with 🔴, due today with ⏰.

## Concerns
List any jobs requiring immediate attention with specific job numbers and reasons.

## Recommended Actions
3–5 specific actions the floor supervisor should take right now, ordered by priority.

Be precise with job IDs and times. Use the actual data above — do not invent numbers.`;
  };

  const buildContext=()=>{
    const bound=trays.filter(t=>t.state==="BOUND");
    const inCoat=trays.filter(t=>t.state==="IN_COATING");
    const idle=trays.filter(t=>t.state==="IDLE");
    const recentBatches=batches.slice(0,20);
    const rushTrays=trays.filter(t=>t.rush&&t.state!=="IDLE");
    const byCoating={};
    batches.forEach(b=>{if(!byCoating[b.coating])byCoating[b.coating]={count:0,passSum:0};byCoating[b.coating].count++;byCoating[b.coating].passSum+=b.passRate;});

    // WIP aging context
    const wip=trays.filter(t=>t.state!=="IDLE"&&t.job);
    const now=Date.now();
    const aging=wip.map(t=>{
      const h=((now-(t.updatedAt||now))/3600000).toFixed(1);
      const due=new Date((t.updatedAt||now)+(t.rush?86400000:3*86400000));
      const dueStr=due.toLocaleDateString("en-US",{month:"short",day:"numeric"});
      const overdue=due<new Date();
      return `${t.job}|${t.id}|${h}h in lab|due ${dueStr}|${t.department||"?"}${overdue?" OVERDUE":""}${t.rush?" RUSH":""}`;
    }).join("; ");

    return `You are Lab_Assistant AI, an expert optical manufacturing analyst embedded in the Pair Eyewear lens lab MES.

LIVE LAB STATE (${new Date().toLocaleString()}):
TRAY FLEET: ${trays.length} total | IDLE: ${idle.length} | BOUND: ${bound.length} | IN COATING: ${inCoat.length} | RUSH: ${rushTrays.length}

BOUND TRAYS:
${bound.slice(0,8).map(t=>`  ${t.id}: Job ${t.job} | ${t.department||"?"} | ${t.coatingType||"?"}${t.rush?" 🔴 RUSH":""}`).join("\n")||"  None"}

IN COATING:
${inCoat.slice(0,8).map(t=>`  ${t.id}: Job ${t.job} | Machine: ${t.machine||"?"} | Stage: ${t.coatingStage||"?"}`).join("\n")||"  None"}

RUSH JOBS:
${rushTrays.map(t=>`  ${t.id}: Job ${t.job} — State: ${t.state} | Dept: ${t.department||"?"}`).join("\n")||"  None active"}

WIP AGING (all active jobs — hours in lab | due date | location | flags):
${aging||"  No WIP data"}

RECENT BATCHES (last 20):
${recentBatches.map(b=>`  ${b.id}: ${b.coating} | ${b.machine} | ${b.lenses}/${b.capacity} lenses | Actual ${b.actualMins}min vs Target ${b.targetMins}min | Pass ${b.passRate}% | Op: ${b.operator||"?"}`).join("\n")}

YIELD BY COATING TYPE:
${Object.entries(byCoating).map(([k,v])=>`  ${k}: ${v.count} batches, avg ${Math.round(v.passSum/v.count)}% pass rate`).join("\n")}

MACHINES: ${coaterMachines.join(", ")}
COATING TYPES: ${COATING_TYPES.join(", ")}

When generating reports: use ## for main sections, ### for subsections, - for bullet points, **bold** for key metrics. Be specific with actual numbers from the data. Flag anything below 90% pass rate as a concern. Be concise but comprehensive.`;
  };

  const sendMessage=async(text)=>{
    let userText=(text||input).trim();
    if(!userText||loading)return;
    setInput("");

    // "AI ?" - show available reports and prompts
    if(userText.match(/^(ai\s*\?|help|commands|\?)$/i)){
      const helpText=`## Available AI Reports & Commands

### Quick Reports (click buttons on left, or type):
${QUICK_PROMPTS.map(p=>`- **${p.icon} ${p.label}** — "${p.text.slice(0,50)}${p.text.length>50?'...':''}"${p.isReport?' 📄':''}"`).join('\n')}

### Domain-Specific AI (type domain + question):
- **coating** — Batch status, yield analysis, fill predictions
- **cutting** — Queue status, breaks, rush priority
- **assembly** — Station status, leaderboard, rush jobs
- **shipping** — Ready to ship, overdue, due today
- **inventory** — Stock levels, critical items, reorder
- **maintenance** — Equipment alerts, PM schedule, downtime

### MCP Tools (AI can use automatically):
- **call_api** — Fetch live data from Lab Assistant
- **query_database** — Run read-only SQL queries
- **take_action** — Execute write operations (audit logged)

### Tips:
- Add "report" to any question to get a formatted, downloadable report
- Use specific job IDs, tray numbers, or machine names
- Ask about trends, comparisons, or recommendations

Type a question to get started!`;
      setMessages(prev=>[...prev,{role:"user",content:"AI ?"},{role:"assistant",content:helpText}]);
      return;
    }

    // WIP Aging Report — build full data-rich prompt, display friendly label in chat
    const isAgingReport = userText==="__WIP_AGING__";
    if(isAgingReport) userText=buildAgingPrompt();
    const displayText = isAgingReport ? "⏱ Generate WIP Aging Report — show due date and days in lab for all active jobs." : userText;

    const willBeReport=isAgingReport||isReportRequest(userText);
    const newMessages=[...messages,{role:"user",content:displayText}];
    setMessages(newMessages);
    setLoading(true);
    try{
      // Use MCP gateway with streaming
      let reply = '';
      const msgIdx = newMessages.length;

      // Add placeholder message for streaming
      setMessages(prev => [...prev, { role: "assistant", content: "", isReport: willBeReport, prompt: isAgingReport ? "WIP Aging Report" : userText, msgIdx, streaming: true }]);

      await callGateway(settings, userText, {
        context: buildContext(),
        onChunk: (chunk) => {
          reply += chunk;
          setMessages(prev => prev.map((m, i) => i === msgIdx ? { ...m, content: reply } : m));
        }
      });

      // Mark streaming complete
      setMessages(prev => prev.map((m, i) => i === msgIdx ? { ...m, streaming: false } : m));

    } catch(e) {
      const errorMsg = e.message || "Connection error";
      setMessages(prev => [...prev, { role: "assistant", content: `⚠️ ${errorMsg}\n\nMake sure the MCP Gateway is running (Settings → Server → Test).` }]);
    }
    setLoading(false);
  };

  const downloadWordReport=async(msg,idx)=>{
    setReportDownloading(idx);
    try{
      // Extract a title from the prompt
      const title=msg.prompt
        ? msg.prompt.replace(/^generate\s+a?\s*/i,"").replace(/report.*/i,"Report").trim().slice(0,60)
        : "Lab Report";

      // Build KPI summary from current data
      const bound=trays.filter(t=>t.state==="BOUND").length;
      const inCoat=trays.filter(t=>t.state==="IN_COATING").length;
      const rush=trays.filter(t=>t.rush&&t.state!=="IDLE").length;
      const avgPass=batches.length?Math.round(batches.reduce((s,b)=>s+b.passRate,0)/batches.length):0;

      const res=await fetch(`${serverUrl}/api/report`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({
          title,
          content:msg.content,
          generatedBy:"Lab_Assistant AI",
          timestamp:Date.now(),
          meta:{
            kpis:[
              {label:"Jobs Bound",    value:String(bound)},
              {label:"In Coating",    value:String(inCoat)},
              {label:"Rush Active",   value:String(rush)},
              {label:"Avg Pass Rate", value:`${avgPass}%`},
            ]
          }
        }),
      });

      if(!res.ok){const e=await res.json();throw new Error(e.error||"Server error");}

      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download=`LabReport_${title.replace(/\s+/g,"_")}_${new Date().toISOString().slice(0,10)}.docx`;
      a.click();
      URL.revokeObjectURL(url);
    }catch(e){
      alert(`Word export failed: ${e.message}\n\nMake sure oven-timer-server.js is running at ${serverUrl}`);
    }
    setReportDownloading(null);
  };

  useEffect(()=>{
    if(chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight;
  },[messages,loading]);

  return(
    <div style={{display:"grid",gridTemplateColumns:"260px 1fr",gap:20,height:"calc(100vh - 160px)",minHeight:0}}>
      {/* Left: Quick prompts + context panel */}
      <div style={{display:"flex",flexDirection:"column",gap:14}}>

        <Card style={{borderTop:`3px solid ${T.blue}`}}>
          <SectionHeader>Quick Analysis</SectionHeader>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {QUICK_PROMPTS.map((p,i)=>(
              <button key={i} onClick={()=>sendMessage(p.text)} disabled={loading}
                style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,cursor:loading?"not-allowed":"pointer",color:T.text,fontFamily:mono,fontSize:11,fontWeight:600,textAlign:"left",transition:"all 0.15s",opacity:loading?0.5:1}}
                onMouseEnter={e=>e.currentTarget.style.borderColor=T.blue}
                onMouseLeave={e=>e.currentTarget.style.borderColor=T.border}>
                <span style={{fontSize:16}}>{p.icon}</span>
                <span style={{color:T.textMuted}}>{p.label}</span>
              </button>
            ))}
          </div>
        </Card>
        <Card>
          <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:8}}>LIVE CONTEXT</div>
          {[
            ["Trays",`${trays.filter(t=>t.state!=="IDLE").length} / ${trays.length} active`],
            ["Rush Jobs",`${trays.filter(t=>t.rush&&t.state!=="IDLE").length} active`],
            ["In Coating",`${trays.filter(t=>t.state==="IN_COATING").length} trays`],
            ["Batches",`${batches.length} total`],
          ].map(([k,v])=>(
            <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${T.border}`,fontSize:11}}>
              <span style={{color:T.textDim,fontFamily:mono}}>{k}</span>
              <span style={{color:T.cyan,fontFamily:mono,fontWeight:700}}>{v}</span>
            </div>
          ))}
          <div style={{marginTop:10,fontSize:9,color:T.textDim,fontFamily:mono,lineHeight:1.6}}>
            AI has full access to tray fleet, batch history, coating data, and machine states.
          </div>
          <div style={{marginTop:12,borderTop:`1px solid ${T.border}`,paddingTop:10}}>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:6}}>WORD EXPORT SERVER</div>
            <input value={serverUrl} onChange={e=>setServerUrl(e.target.value)}
              style={{width:"100%",background:T.bg,border:`1px solid ${T.border}`,borderRadius:5,padding:"6px 8px",color:T.text,fontSize:10,fontFamily:mono,outline:"none",boxSizing:"border-box"}}/>
            <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginTop:4,lineHeight:1.5}}>
              📄 Word reports require oven-timer-server.js running locally.
            </div>
          </div>
        </Card>
      </div>

      {/* Right: Chat */}
      <div style={{display:"flex",flexDirection:"column",minHeight:0,overflow:"hidden"}}>
        <Card style={{flex:1,minHeight:0,display:"flex",flexDirection:"column",borderTop:`3px solid ${T.blue}`,padding:0,overflow:"hidden"}}>
          {/* Chat header */}
          <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10,flexShrink:0}}>
            <div style={{width:36,height:36,borderRadius:8,background:`linear-gradient(135deg,${T.blue},${T.blueGlow})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,boxShadow:`0 0 16px ${T.blue}30`}}>🤖</div>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:T.text}}>Lab_Assistant AI</div>
              <div style={{fontSize:10,color:T.green,fontFamily:mono}}>● ONLINE — claude-sonnet-4</div>
            </div>
            <button onClick={()=>setMessages([{role:"assistant",content:"Chat cleared. How can I help you?"}])}
              style={{marginLeft:"auto",padding:"6px 12px",background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,color:T.textDim,fontSize:11,cursor:"pointer",fontFamily:mono}}>
              Clear
            </button>
          </div>

          {/* Messages */}
          <div ref={chatRef} style={{flex:1,minHeight:0,overflowY:"auto",padding:"16px 18px",display:"flex",flexDirection:"column",gap:12}}>
            {messages.map((m,i)=>(
              <div key={i} style={{display:"flex",gap:10,flexDirection:m.role==="user"?"row-reverse":"row",alignItems:"flex-start"}}>
                <div style={{width:30,height:30,borderRadius:6,background:m.role==="user"?T.blue:`linear-gradient(135deg,${T.blue}50,${T.blueGlow}50)`,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>
                  {m.role==="user"?"👤":"🤖"}
                </div>
                <div style={{maxWidth:"82%",minWidth:0,display:"flex",flexDirection:"column",gap:6}}>
                  <div style={{padding:"10px 14px",borderRadius:10,background:m.role==="user"?`${T.blue}20`:T.surface,border:`1px solid ${m.role==="user"?T.blue:T.border}`,fontSize:13,color:T.text,lineHeight:1.7,wordBreak:"break-word",overflowWrap:"break-word"}}>
                    {m.role==="user"
                      ? <span style={{fontFamily:mono,whiteSpace:"pre-wrap"}}>{m.content}</span>
                      : <MarkdownMsg text={m.content}/>
                    }
                  </div>
                  {m.role==="assistant"&&m.isReport&&(
                    <button
                      onClick={()=>downloadWordReport(m,i)}
                      disabled={reportDownloading===i}
                      style={{alignSelf:"flex-start",display:"flex",alignItems:"center",gap:6,padding:"6px 12px",background:reportDownloading===i?T.border:`${T.blue}20`,border:`1px solid ${reportDownloading===i?T.border:T.blue}`,borderRadius:6,color:reportDownloading===i?T.textDim:T.blue,fontSize:11,fontWeight:700,cursor:reportDownloading===i?"not-allowed":"pointer",fontFamily:mono,transition:"all 0.2s"}}>
                      {reportDownloading===i?"⏳ Generating...":"📄 Download as Word (.docx)"}
                    </button>
                  )}
                </div>
              </div>
            ))}
            {loading&&(
              <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                <div style={{width:30,height:30,borderRadius:6,background:`linear-gradient(135deg,${T.blue}50,${T.blueGlow}50)`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>🤖</div>
                <div style={{padding:"10px 14px",borderRadius:10,background:T.surface,border:`1px solid ${T.border}`}}>
                  <div style={{display:"flex",gap:4,alignItems:"center"}}>
                    {[0,1,2].map(j=>(
                      <div key={j} style={{width:6,height:6,borderRadius:"50%",background:T.blue,animation:`pulse 1.2s ${j*0.2}s infinite`}}/>
                    ))}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Input */}
          <div style={{padding:"14px 18px",borderTop:`1px solid ${T.border}`,display:"flex",gap:10,flexShrink:0}}>
            <input
              value={input}
              onChange={e=>setInput(e.target.value)}
              onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey){e.preventDefault();sendMessage();}}}
              placeholder="Ask anything — 'Where is job J21694?' or 'Generate shift report'..."
              disabled={loading}
              style={{flex:1,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:"11px 14px",color:T.text,fontSize:13,fontFamily:sans,outline:"none"}}
            />
            <button
              onClick={()=>sendMessage()}
              disabled={!input.trim()||loading}
              style={{padding:"0 20px",background:input.trim()&&!loading?T.blue:T.border,border:"none",borderRadius:8,color:input.trim()&&!loading?"#fff":T.textDim,fontSize:13,fontWeight:700,cursor:input.trim()&&!loading?"pointer":"default",transition:"all 0.2s",fontFamily:mono}}>
              SEND
            </button>
          </div>
        </Card>

        <style>{`
          @keyframes pulse {
            0%,100%{opacity:0.3;transform:scale(0.8)}
            50%{opacity:1;transform:scale(1.1)}
          }
        `}</style>
      </div>
    </div>
  );
}

// ── QC & Breakage Tab ────────────────────────────────────────
function QCTab({trays,breakage,setBreakage}){
  const [subView,setSubView]=useState("live");
  const [newBreak,setNewBreak]=useState({job:"",dept:"ASSEMBLY",type:BREAK_TYPES[0],lens:"OD",coating:COATING_TYPES[0],note:""});
  const [showForm,setShowForm]=useState(false);

  const qcHolds=trays.filter(t=>t.department==="QC");
  const brokenTrays=trays.filter(t=>t.state==="BROKEN");
  const todayBreaks=breakage.filter(b=>{const today=new Date();const d=new Date(b.time);return d.toDateString()===today.toDateString();});
  const totalCost=breakage.reduce((s,b)=>s+b.cost,0);
  const byType={};breakage.forEach(b=>{byType[b.type]=(byType[b.type]||0)+1;});
  const sortedTypes=Object.entries(byType).sort((a,b)=>b[1]-a[1]);

  const handleLogBreak=()=>{
    if(!newBreak.job.trim())return;
    setBreakage(prev=>[{id:`BRK-${String(prev.length+1).padStart(3,"0")}`,job:newBreak.job,dept:newBreak.dept,type:newBreak.type,lens:newBreak.lens,coating:newBreak.coating,cost:parseFloat((Math.random()*45+15).toFixed(2)),time:new Date(),resolved:false,note:newBreak.note},...prev]);
    setNewBreak({job:"",dept:"ASSEMBLY",type:BREAK_TYPES[0],lens:"OD",coating:COATING_TYPES[0],note:""});
    setShowForm(false);
  };

  return(
    <div>
      <div style={{display:"flex",gap:4,marginBottom:16,flexWrap:"wrap"}}>
        {[{id:"live",label:"Live QC Board",icon:"🔬"},{id:"breakage",label:"Breakage Log",icon:"💥"},{id:"analytics",label:"Analytics",icon:"📊"}].map(sv=>(
          <button key={sv.id} onClick={()=>setSubView(sv.id)} style={{background:subView===sv.id?T.blueDark:"transparent",border:`1px solid ${subView===sv.id?T.blue:"transparent"}`,borderRadius:8,padding:"10px 20px",cursor:"pointer",color:subView===sv.id?T.blue:T.textMuted,fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:8,fontFamily:sans}}><span>{sv.icon}</span>{sv.label}</button>
        ))}
      </div>

      {subView==="live"&&(
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <KPICard label="QC Holds" value={qcHolds.length} sub="awaiting inspection" accent={T.orange}/>
            <KPICard label="Broken Today" value={todayBreaks.length} sub="logged breaks" accent={T.red}/>
            <KPICard label="Break Cost Today" value={`$${todayBreaks.reduce((s,b)=>s+b.cost,0).toFixed(0)}`} sub="est. material cost" accent={T.red}/>
            <KPICard label="Total Fleet in QC" value={`${qcHolds.length+brokenTrays.length}`} sub="trays held" accent={T.pink}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <Card>
              <SectionHeader right={`${qcHolds.length} trays`}>QC Hold Queue</SectionHeader>
              {qcHolds.length===0?<div style={{fontSize:12,color:T.textDim,textAlign:"center",padding:24}}>✓ No jobs on QC hold</div>:
                <div style={{maxHeight:400,overflowY:"auto"}}>
                  {qcHolds.map(t=>(
                    <div key={t.id} style={{display:"flex",gap:10,padding:"10px",marginBottom:6,background:T.bg,borderRadius:8,border:`1px solid ${T.pink}30`}}>
                      <div style={{width:10,height:10,borderRadius:"50%",background:T.pink,marginTop:4,flexShrink:0,boxShadow:`0 0 8px ${T.pink}60`}}/>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}>
                          <span style={{fontSize:13,color:T.text,fontWeight:700,fontFamily:mono}}>{t.job||t.id}</span>
                          {t.rush&&<Pill color={T.red}>RUSH</Pill>}
                        </div>
                        <div style={{fontSize:10,color:T.textDim}}>Tray: {t.id} • {t.coatingType||"No coating"}</div>
                        {t.rx&&<div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>SPH {t.rx.sph} CYL {t.rx.cyl}</div>}
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:4}}>
                        <button onClick={()=>alert(`Releasing ${t.job} — integrate with DVI to update status`)} style={{fontSize:10,padding:"4px 8px",background:T.greenDark,border:`1px solid ${T.green}`,borderRadius:5,color:T.green,cursor:"pointer",fontFamily:mono,fontWeight:700}}>RELEASE</button>
                        <button onClick={()=>alert(`Scrapping ${t.job}`)} style={{fontSize:10,padding:"4px 8px",background:T.redDark,border:`1px solid ${T.red}`,borderRadius:5,color:T.red,cursor:"pointer",fontFamily:mono,fontWeight:700}}>SCRAP</button>
                      </div>
                    </div>
                  ))}
                </div>
              }
            </Card>
            <Card>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
                <SectionHeader>Breakage Log</SectionHeader>
                <button onClick={()=>setShowForm(!showForm)} style={{fontSize:11,padding:"6px 14px",background:T.redDark,border:`1px solid ${T.red}`,borderRadius:6,color:T.red,cursor:"pointer",fontFamily:mono,fontWeight:700}}>+ LOG BREAK</button>
              </div>
              {showForm&&(
                <div style={{background:T.bg,border:`1px solid ${T.red}40`,borderRadius:8,padding:14,marginBottom:12}}>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
                    {[["Job #",newBreak.job,v=>setNewBreak(b=>({...b,job:v})),"J12345"]].map(([lbl,val,set,ph])=>(
                      <div key={lbl} style={{gridColumn:"1/-1"}}>
                        <label style={{fontSize:9,color:T.textDim,fontFamily:mono,display:"block",marginBottom:3}}>{lbl}</label>
                        <input value={val} onChange={e=>set(e.target.value)} placeholder={ph} style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:5,padding:"7px 10px",color:T.text,fontSize:13,fontFamily:mono,outline:"none",boxSizing:"border-box"}}/>
                      </div>
                    ))}
                    {[["Break Type",BREAK_TYPES,newBreak.type,v=>setNewBreak(b=>({...b,type:v}))],["Department",Object.keys(DEPARTMENTS),newBreak.dept,v=>setNewBreak(b=>({...b,dept:v}))],["Lens",["OD","OS","Both"],newBreak.lens,v=>setNewBreak(b=>({...b,lens:v}))],["Coating",COATING_TYPES,newBreak.coating,v=>setNewBreak(b=>({...b,coating:v}))]].map(([lbl,opts,val,set])=>(
                      <div key={lbl}>
                        <label style={{fontSize:9,color:T.textDim,fontFamily:mono,display:"block",marginBottom:3}}>{lbl}</label>
                        <select value={val} onChange={e=>set(e.target.value)} style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:5,padding:"7px 10px",color:T.text,fontSize:11,fontFamily:mono,outline:"none"}}>
                          {opts.map(o=><option key={o} value={o}>{o}</option>)}
                        </select>
                      </div>
                    ))}
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={handleLogBreak} style={{flex:1,padding:"9px",background:T.redDark,border:`1px solid ${T.red}`,borderRadius:6,color:T.red,fontWeight:800,fontSize:12,cursor:"pointer",fontFamily:mono}}>LOG BREAK</button>
                    <button onClick={()=>setShowForm(false)} style={{padding:"9px 16px",background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,color:T.textDim,cursor:"pointer",fontFamily:mono}}>Cancel</button>
                  </div>
                </div>
              )}
              <div style={{maxHeight:350,overflowY:"auto"}}>
                {breakage.slice(0,20).map(b=>(
                  <div key={b.id} style={{display:"flex",gap:8,padding:"8px 0",borderBottom:`1px solid ${T.border}`,alignItems:"center"}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:b.resolved?T.green:T.red,flexShrink:0}}/>
                    <div style={{flex:1}}>
                      <div style={{fontSize:11,color:T.text,fontFamily:mono,fontWeight:700}}>{b.job} <span style={{color:T.textDim,fontWeight:400}}>• {b.type}</span></div>
                      <div style={{fontSize:9,color:T.textDim}}>{b.dept} • {b.lens} • {b.coating}</div>
                    </div>
                    <div style={{textAlign:"right",flexShrink:0}}>
                      <div style={{fontSize:11,color:T.red,fontFamily:mono,fontWeight:700}}>${b.cost.toFixed(2)}</div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{new Date(b.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
                    </div>
                    {b.resolved&&<Pill color={T.green}>OK</Pill>}
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      )}

      {subView==="breakage"&&(
        <Card>
          <SectionHeader right={`${breakage.length} total breaks logged`}>Full Breakage History</SectionHeader>
          <div style={{maxHeight:600,overflowY:"auto"}}>
            {breakage.map(b=>(
              <div key={b.id} style={{display:"flex",gap:12,padding:"10px",marginBottom:4,background:T.bg,borderRadius:8,border:`1px solid ${b.resolved?T.border:T.red+"30"}`}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:b.resolved?T.green:T.red,marginTop:5,flexShrink:0}}/>
                <div style={{flex:1,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
                  {[["Job",b.job,T.text],["Type",b.type,T.red],["Dept",b.dept,T.textMuted],["Lens",b.lens,T.textMuted],["Coating",b.coating,T.blue],["Cost",`$${b.cost.toFixed(2)}`,T.red],["Time",new Date(b.time).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}),T.textDim],["Status",b.resolved?"Resolved":"Open",b.resolved?T.green:T.red]].map(([l,v,c])=>(
                    <div key={l}><div style={{fontSize:8,color:T.textDim,fontFamily:mono}}>{l}</div><div style={{fontSize:11,color:c,fontFamily:mono,fontWeight:600}}>{v}</div></div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {subView==="analytics"&&(
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <KPICard label="Total Breaks" value={breakage.length} sub="all time" accent={T.red}/>
            <KPICard label="Total Cost" value={`$${totalCost.toFixed(0)}`} sub="material loss" accent={T.red}/>
            <KPICard label="Today" value={todayBreaks.length} sub="breaks today" accent={T.orange}/>
            <KPICard label="Avg Cost" value={`$${(totalCost/Math.max(1,breakage.length)).toFixed(2)}`} sub="per break" accent={T.amber}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <Card>
              <SectionHeader>Break Type Distribution</SectionHeader>
              {sortedTypes.map(([type,count])=>(
                <div key={type} style={{marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}><span style={{color:T.textMuted}}>{type}</span><span style={{color:T.text,fontFamily:mono,fontWeight:700}}>{count}</span></div>
                  <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${(count/sortedTypes[0][1])*100}%`,background:T.red,borderRadius:3}}/></div>
                </div>
              ))}
            </Card>
            <Card>
              <SectionHeader>Breaks by Department</SectionHeader>
              {Object.entries(DEPARTMENTS).map(([key,dept])=>{
                const count=breakage.filter(b=>b.dept===key).length;
                if(!count)return null;
                return(
                  <div key={key} style={{marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}><span style={{color:dept.color}}>{dept.label}</span><span style={{color:T.text,fontFamily:mono,fontWeight:700}}>{count}</span></div>
                    <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${(count/breakage.length)*100}%`,background:dept.color,borderRadius:3}}/></div>
                  </div>
                );
              })}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Smart Tray Fleet Tab ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════
// ── UWB Position View (Phase 1 — Position Reporting Only) ────
// ══════════════════════════════════════════════════════════════

// Lab floor zones mapped to approximate UWB anchor positions
const LAB_ZONES = {
  PICKING:   {label:"Picking",     x:0.08, y:0.15, w:0.18, h:0.20, color:"#3B82F6"},
  SURFACING: {label:"Surfacing",   x:0.30, y:0.05, w:0.22, h:0.22, color:"#A855F7"},
  CUTTING:   {label:"Cutting",     x:0.58, y:0.05, w:0.18, h:0.20, color:"#F59E0B"},
  COATING:   {label:"Coating",     x:0.30, y:0.38, w:0.40, h:0.26, color:"#10B981"},
  ASSEMBLY:  {label:"Assembly",    x:0.08, y:0.65, w:0.26, h:0.22, color:"#EC4899"},
  QC:        {label:"QC",         x:0.40, y:0.72, w:0.16, h:0.18, color:"#EF4444"},
  SHIPPING:  {label:"Shipping",   x:0.62, y:0.65, w:0.18, h:0.22, color:"#06B6D4"},
};

// Deterministic UWB position from tray ID — simulates real UWB coordinate output
function getUWBPos(tray){
  const zone=LAB_ZONES[tray.department]||LAB_ZONES.PICKING;
  const seed=tray.id.split("").reduce((s,c)=>s+c.charCodeAt(0),0);
  const jitter=(n,range)=>((n*2654435761)>>>0)%1000/1000*range;
  return {
    x: zone.x + jitter(seed,zone.w*0.85),
    y: zone.y + jitter(seed*7,zone.h*0.85),
    zone: tray.department,
    rssi: tray.rssi,
    accuracy: Math.abs((seed%15)+10), // cm accuracy estimate
  };
}

function UWBPositionView({trays,selectedTray,setSelectedTray}){
  const [filterZone,setFilterZone]=useState("ALL");
  const [showIdle,setShowIdle]=useState(false);
  const [hovered,setHovered]=useState(null);

  const visibleTrays=trays.filter(t=>{
    if(!showIdle&&t.state==="IDLE")return false;
    if(filterZone!=="ALL"&&t.department!==filterZone)return false;
    return true;
  });

  const sel=trays.find(t=>t.id===selectedTray);
  const selPos=sel?getUWBPos(sel):null;
  const rushTrays=trays.filter(t=>t.rush&&t.state!=="IDLE");

  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:20}}>
      {/* Map */}
      <div>
        <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12,flexWrap:"wrap"}}>
          <div style={{fontSize:11,color:T.textDim,fontFamily:mono}}>ZONE FILTER:</div>
          <button onClick={()=>setFilterZone("ALL")} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontFamily:mono,cursor:"pointer",background:filterZone==="ALL"?T.blueDark:T.bg,border:`1px solid ${filterZone==="ALL"?T.blue:T.border}`,color:filterZone==="ALL"?T.blue:T.textDim,fontWeight:700}}>ALL</button>
          {Object.entries(LAB_ZONES).map(([k,v])=>(
            <button key={k} onClick={()=>setFilterZone(filterZone===k?"ALL":k)} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontFamily:mono,cursor:"pointer",background:filterZone===k?`${v.color}20`:T.bg,border:`1px solid ${filterZone===k?v.color:T.border}`,color:filterZone===k?v.color:T.textDim,fontWeight:700}}>{v.label}</button>
          ))}
          <label style={{display:"flex",alignItems:"center",gap:5,fontSize:10,color:T.textDim,fontFamily:mono,cursor:"pointer",marginLeft:"auto"}}>
            <input type="checkbox" checked={showIdle} onChange={e=>setShowIdle(e.target.checked)} style={{cursor:"pointer"}}/>
            Show IDLE
          </label>
        </div>

        <Card style={{padding:0,position:"relative",overflow:"hidden",background:"#0A1628"}}>
          {/* SVG floor plan */}
          <svg width="100%" viewBox="0 0 1000 550" style={{display:"block",minHeight:440}}>
            {/* Grid lines */}
            {Array.from({length:20},(_,i)=>(
              <line key={`v${i}`} x1={i*50} y1={0} x2={i*50} y2={550} stroke="#1E293B" strokeWidth={0.5}/>
            ))}
            {Array.from({length:11},(_,i)=>(
              <line key={`h${i}`} x1={0} y1={i*50} x2={1000} y2={i*50} stroke="#1E293B" strokeWidth={0.5}/>
            ))}
            {/* Outer wall */}
            <rect x={5} y={5} width={990} height={540} rx={8} fill="none" stroke="#334155" strokeWidth={2}/>

            {/* Zone rectangles */}
            {Object.entries(LAB_ZONES).map(([k,v])=>{
              const zx=v.x*1000,zy=v.y*550,zw=v.w*1000,zh=v.h*550;
              const cnt=trays.filter(t=>t.department===k&&(showIdle||t.state!=="IDLE")).length;
              return(
                <g key={k}>
                  <rect x={zx} y={zy} width={zw} height={zh} rx={4}
                    fill={filterZone===k?`${v.color}15`:`${v.color}08`}
                    stroke={filterZone===k?v.color:`${v.color}60`}
                    strokeWidth={filterZone===k?2:1}/>
                  <text x={zx+8} y={zy+16} fontSize={11} fill={v.color} fontFamily="monospace" fontWeight="700">{v.label}</text>
                  <text x={zx+8} y={zy+30} fontSize={9} fill={`${v.color}80`} fontFamily="monospace">{cnt} trays</text>
                </g>
              );
            })}

            {/* UWB anchors */}
            {[[80,30],[500,30],[920,30],[80,300],[920,300],[80,520],[500,520],[920,520]].map(([ax,ay],i)=>(
              <g key={i}>
                <circle cx={ax} cy={ay} r={6} fill="#1E3A5F" stroke="#3B82F6" strokeWidth={1.5}/>
                <text x={ax} y={ay+18} textAnchor="middle" fontSize={7} fill="#3B82F640" fontFamily="monospace">A{i+1}</text>
              </g>
            ))}

            {/* Tray dots */}
            {visibleTrays.map(t=>{
              const p=getUWBPos(t);
              const px=p.x*1000, py=p.y*550;
              const s=TRAY_STATES[t.state];
              const isSel=selectedTray===t.id;
              const isHov=hovered===t.id;
              return(
                <g key={t.id} style={{cursor:"pointer"}} onClick={()=>setSelectedTray(isSel?null:t.id)} onMouseEnter={()=>setHovered(t.id)} onMouseLeave={()=>setHovered(null)}>
                  {isSel&&<circle cx={px} cy={py} r={16} fill="none" stroke="#93C5FD" strokeWidth={2} opacity={0.8}/>}
                  {t.rush&&<circle cx={px} cy={py} r={12} fill="none" stroke="#EF4444" strokeWidth={1.5} opacity={0.7}/>}
                  <circle cx={px} cy={py} r={isSel?8:isHov?7:5} fill={s.color} opacity={t.state==="IDLE"?0.4:0.9}/>
                  {(isSel||isHov)&&(
                    <text x={px} y={py-12} textAnchor="middle" fontSize={9} fill="#E2E8F0" fontFamily="monospace" fontWeight="700">{t.id}</text>
                  )}
                  {t.rush&&<text x={px+8} y={py-3} fontSize={8} fill="#EF4444">!</text>}
                </g>
              );
            })}

            {/* Selected tray position ring */}
            {selPos&&(
              <circle cx={selPos.x*1000} cy={selPos.y*550} r={20} fill="none" stroke="#93C5FD" strokeWidth={1} strokeDasharray="4 3" opacity={0.6}/>
            )}
          </svg>

          {/* Legend */}
          <div style={{position:"absolute",bottom:10,right:12,display:"flex",gap:12,flexWrap:"wrap",justifyContent:"flex-end"}}>
            {Object.entries(TRAY_STATES).slice(0,6).map(([k,v])=>(
              <div key={k} style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:8,height:8,borderRadius:"50%",background:v.color}}/>
                <span style={{fontSize:9,color:"#64748B",fontFamily:"monospace"}}>{v.label}</span>
              </div>
            ))}
            <div style={{display:"flex",alignItems:"center",gap:4}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:"transparent",border:"1.5px solid #EF4444"}}/>
              <span style={{fontSize:9,color:"#64748B",fontFamily:"monospace"}}>RUSH</span>
            </div>
          </div>
        </Card>

        <div style={{display:"flex",gap:10,marginTop:10}}>
          <Card style={{flex:1,padding:"10px 14px",textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:800,color:T.blue,fontFamily:mono}}>{visibleTrays.length}</div>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Trays Visible</div>
          </Card>
          <Card style={{flex:1,padding:"10px 14px",textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:800,color:T.red,fontFamily:mono}}>{rushTrays.length}</div>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Rush Active</div>
          </Card>
          <Card style={{flex:1,padding:"10px 14px",textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:800,color:T.green,fontFamily:mono}}>±15cm</div>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>UWB Accuracy</div>
          </Card>
          <Card style={{flex:1,padding:"10px 14px",textAlign:"center"}}>
            <div style={{fontSize:20,fontWeight:800,color:T.amber,fontFamily:mono}}>8</div>
            <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Anchors Online</div>
          </Card>
        </div>
      </div>

      {/* Right panel */}
      <div style={{display:"flex",flexDirection:"column",gap:14}}>
        {/* Selected tray detail */}
        {sel&&selPos?(
          <Card style={{borderTop:`3px solid ${TRAY_STATES[sel.state].color}`}}>
            <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
              <div style={{fontSize:18,fontWeight:800,color:T.text,fontFamily:mono}}>{sel.id}</div>
              {sel.rush&&<span style={{fontSize:9,fontWeight:800,color:T.red,background:`${T.red}20`,padding:"2px 8px",borderRadius:4,fontFamily:mono}}>RUSH</span>}
            </div>
            {[
              ["Zone", LAB_ZONES[selPos.zone]?.label||selPos.zone, TRAY_STATES[sel.state].color],
              ["State", TRAY_STATES[sel.state].label, TRAY_STATES[sel.state].color],
              ["Job", sel.job||"—", T.text],
              ["UWB Accuracy", `±${selPos.accuracy}cm`, T.green],
              ["Signal", `${sel.rssi} dBm`, sel.rssi>-60?T.green:sel.rssi>-75?T.amber:T.red],
              ["Battery", `${sel.battery}%`, sel.battery>50?T.green:sel.battery>20?T.amber:T.red],
              ["Last Seen", `${Math.floor((Date.now()-sel.lastSeen)/1000)}s ago`, T.textDim],
            ].map(([k,v,c])=>(
              <div key={k} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${T.border}`,fontSize:11}}>
                <span style={{color:T.textDim,fontFamily:mono}}>{k}</span>
                <span style={{color:c,fontFamily:mono,fontWeight:700}}>{v}</span>
              </div>
            ))}
          </Card>
        ):(
          <Card style={{textAlign:"center",padding:24}}>
            <div style={{fontSize:11,color:T.textDim}}>Click a tray dot on the map to inspect</div>
          </Card>
        )}

        {/* Rush jobs list */}
        <Card>
          <div style={{fontSize:10,color:T.red,fontFamily:mono,marginBottom:8,fontWeight:700}}>🔴 RUSH JOBS ACTIVE</div>
          {rushTrays.length===0?<div style={{fontSize:11,color:T.textDim,fontFamily:mono}}>None</div>:
          rushTrays.slice(0,8).map(t=>{
            const p=getUWBPos(t);
            return(
              <div key={t.id} onClick={()=>setSelectedTray(t.id)} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 0",borderBottom:`1px solid ${T.border}`,cursor:"pointer"}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:T.red,flexShrink:0}}/>
                <span style={{fontSize:11,fontFamily:mono,color:T.text,fontWeight:700,minWidth:50}}>{t.id}</span>
                <span style={{fontSize:10,color:T.cyan,fontFamily:mono}}>{t.job}</span>
                <span style={{fontSize:9,color:T.textDim,fontFamily:mono,marginLeft:"auto"}}>{LAB_ZONES[p.zone]?.label||p.zone}</span>
              </div>
            );
          })}
        </Card>

        {/* Phase roadmap */}
        <Card>
          <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:10,fontWeight:700}}>SMART TRAY ROADMAP</div>
          {[
            {phase:"Phase 1", label:"UWB Position Only", done:true,  note:"±15cm, 8 anchors, live map"},
            {phase:"Phase 2", label:"E-Ink Display",     done:false, note:"Job barcode + RX on tray"},
            {phase:"Phase 3", label:"UWB + E-Ink Combo", done:false, note:"Full job tracking + display"},
            {phase:"Phase 4", label:"AI Integration",    done:false, note:"Predictive routing, alerts"},
          ].map((r,i)=>(
            <div key={i} style={{display:"flex",alignItems:"flex-start",gap:8,padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
              <div style={{width:16,height:16,borderRadius:"50%",background:r.done?T.green:T.border,display:"flex",alignItems:"center",justifyContent:"center",fontSize:9,color:r.done?"#000":T.textDim,flexShrink:0,marginTop:1}}>{r.done?"✓":i+1}</div>
              <div>
                <div style={{fontSize:11,color:r.done?T.green:T.text,fontFamily:mono,fontWeight:700}}>{r.phase}: {r.label}</div>
                <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{r.note}</div>
              </div>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Put Wall Position Map ─────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function PutWallMapView({positionMap,setPositionMap,trays}){
  const [wall,setWall]=useState("1");
  const [posInput,setPosInput]=useState("");
  const [trayInput,setTrayInput]=useState("");
  const [lastMapped,setLastMapped]=useState(null);
  const [flashPos,setFlashPos]=useState(null);
  const [scanStage,setScanStage]=useState("pos"); // "pos" | "tray"
  const posRef=useRef(null);
  const trayRef=useRef(null);

  const POSITIONS=75;
  const wallKey=p=>`W${wall}-P${String(p).padStart(2,"0")}`;
  const wallMapped=Object.keys(positionMap).filter(k=>k.startsWith(`W${wall}-`)).length;
  const totalMapped=Object.keys(positionMap).length;

  // Parse position from scanned input — accept "23", "P23", "W1-P23", "POS-23"
  const parsePos=(raw)=>{
    const n=parseInt(raw.replace(/[^0-9]/g,""));
    if(isNaN(n)||n<1||n>POSITIONS)return null;
    return n;
  };

  const handlePosEnter=(e)=>{
    if(e.key!=="Enter")return;
    const n=parsePos(posInput);
    if(!n){setPosInput("");return;}
    // Normalize to padded key
    setPosInput(`P${String(n).padStart(2,"0")}`);
    setScanStage("tray");
    setTimeout(()=>trayRef.current?.focus(),50);
  };

  const handleTrayEnter=(e)=>{
    if(e.key!=="Enter")return;
    const trayId=trayInput.trim().toUpperCase();
    const pos=parsePos(posInput);
    if(!trayId||!pos)return;
    const key=wallKey(pos);
    // Check tray not already mapped to another position
    const existingPos=Object.entries(positionMap).find(([k,v])=>v===trayId&&k!==key);
    if(existingPos){
      setLastMapped({ok:false,msg:`${trayId} already mapped to ${existingPos[0]} — clear it first`});
      setTrayInput("");
      setTimeout(()=>trayRef.current?.focus(),50);
      return;
    }
    setPositionMap(prev=>({...prev,[key]:trayId}));
    setLastMapped({ok:true,pos:key,trayId});
    setFlashPos(key);
    setTimeout(()=>setFlashPos(null),1500);
    // Reset for next scan
    setPosInput("");setTrayInput("");setScanStage("pos");
    setTimeout(()=>posRef.current?.focus(),50);
  };

  const clearPosition=(key)=>{
    setPositionMap(prev=>{const n={...prev};delete n[key];return n;});
  };

  const clearWall=()=>{
    setPositionMap(prev=>Object.fromEntries(Object.entries(prev).filter(([k])=>!k.startsWith(`W${wall}-`))));
    setLastMapped(null);
  };

  // Grid layout: 15 cols × 5 rows = 75
  const COLS=15;

  return(
    <div style={{display:"grid",gridTemplateColumns:"320px 1fr",gap:20}}>

      {/* ── Left: Scan Panel ─────────────────────────────────── */}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>

        {/* Wall selector */}
        <Card style={{borderTop:`3px solid ${T.blue}`}}>
          <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:8,letterSpacing:1}}>SELECT WALL</div>
          <div style={{display:"flex",gap:8}}>
            {["1","2"].map(w=>(
              <button key={w} onClick={()=>{setWall(w);setPosInput("");setTrayInput("");setScanStage("pos");setTimeout(()=>posRef.current?.focus(),50);}}
                style={{flex:1,padding:"12px 0",background:wall===w?T.blue:"transparent",border:`2px solid ${wall===w?T.blue:T.border}`,borderRadius:8,color:wall===w?"#fff":T.textMuted,fontWeight:800,fontSize:16,cursor:"pointer",fontFamily:mono}}>
                Wall {w}
                <div style={{fontSize:10,fontWeight:400,color:wall===w?"rgba(255,255,255,0.7)":T.textDim,marginTop:2}}>
                  {Object.keys(positionMap).filter(k=>k.startsWith(`W${w}-`)).length}/{POSITIONS} mapped
                </div>
              </button>
            ))}
          </div>
        </Card>

        {/* Scan inputs */}
        <Card style={{borderTop:`3px solid ${scanStage==="pos"?T.amber:T.green}`}}>
          <SectionHeader>{scanStage==="pos"?"① Scan Position":"② Scan Tray ID"}</SectionHeader>
          <div style={{fontSize:11,color:T.textMuted,marginBottom:14,lineHeight:1.5}}>
            {scanStage==="pos"
              ? "Scan the QR code on the put wall position label, or type position number (1–75)"
              : `Position ${posInput} ready — now scan tray barcode`}
          </div>

          {/* Position input */}
          <div style={{marginBottom:10}}>
            <label style={{fontSize:10,color:scanStage==="pos"?T.amber:T.textDim,fontFamily:mono,display:"block",marginBottom:4,letterSpacing:1}}>
              POSITION {scanStage==="pos"&&"◀ SCAN NOW"}
            </label>
            <input
              ref={posRef}
              value={posInput}
              onChange={e=>{setPosInput(e.target.value);setScanStage("pos");setTrayInput("");}}
              onKeyDown={handlePosEnter}
              placeholder="23  or  P23  or  W1-P23"
              autoFocus
              style={{width:"100%",background:scanStage==="pos"?`${T.amber}15`:T.bg,border:`2px solid ${scanStage==="pos"?T.amber:T.border}`,borderRadius:6,padding:"10px 14px",color:T.text,fontSize:14,fontFamily:mono,outline:"none",boxSizing:"border-box",transition:"all 0.2s"}}
            />
            {posInput&&parsePos(posInput)&&(
              <div style={{fontSize:10,color:T.amber,fontFamily:mono,marginTop:3}}>
                → {wallKey(parsePos(posInput))}
                {positionMap[wallKey(parsePos(posInput))]&&` · currently: ${positionMap[wallKey(parsePos(posInput))]}`}
              </div>
            )}
          </div>

          {/* Tray input */}
          <div style={{marginBottom:14}}>
            <label style={{fontSize:10,color:scanStage==="tray"?T.green:T.textDim,fontFamily:mono,display:"block",marginBottom:4,letterSpacing:1}}>
              TRAY ID {scanStage==="tray"&&"◀ SCAN NOW"}
            </label>
            <input
              ref={trayRef}
              value={trayInput}
              onChange={e=>setTrayInput(e.target.value)}
              onKeyDown={handleTrayEnter}
              placeholder="T-047"
              disabled={scanStage==="pos"||!posInput}
              style={{width:"100%",background:scanStage==="tray"?`${T.green}15`:T.bg,border:`2px solid ${scanStage==="tray"?T.green:T.border}`,borderRadius:6,padding:"10px 14px",color:scanStage==="tray"?T.text:T.textDim,fontSize:14,fontFamily:mono,outline:"none",boxSizing:"border-box",transition:"all 0.2s",opacity:scanStage==="pos"?0.5:1}}
            />
          </div>

          <div style={{fontSize:10,color:T.textDim,fontFamily:mono,lineHeight:1.8,padding:"8px 12px",background:T.bg,borderRadius:6}}>
            Scan position → press Enter → scan tray → press Enter → auto-advances
          </div>
        </Card>

        {/* Last result */}
        {lastMapped&&(
          <div style={{padding:"10px 14px",borderRadius:8,background:lastMapped.ok?`${T.green}15`:`${T.red}15`,border:`1px solid ${lastMapped.ok?T.green:T.red}`,fontSize:12,fontFamily:mono,fontWeight:700,color:lastMapped.ok?T.green:T.red}}>
            {lastMapped.ok?`✓ ${lastMapped.pos} → ${lastMapped.trayId}`:lastMapped.msg}
          </div>
        )}

        {/* Stats + clear */}
        <Card>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <div>
              <div style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>WALL {wall} PROGRESS</div>
              <div style={{fontSize:22,fontWeight:800,color:wallMapped===POSITIONS?T.green:T.blue,fontFamily:mono}}>{wallMapped}<span style={{fontSize:13,color:T.textDim}}>/{POSITIONS}</span></div>
            </div>
            <div style={{textAlign:"right"}}>
              <div style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>BOTH WALLS</div>
              <div style={{fontSize:18,fontWeight:700,color:T.textMuted,fontFamily:mono}}>{totalMapped}<span style={{fontSize:11,color:T.textDim}}>/{POSITIONS*2}</span></div>
            </div>
          </div>
          {/* Progress bar */}
          <div style={{height:6,background:T.border,borderRadius:3,marginBottom:12,overflow:"hidden"}}>
            <div style={{height:"100%",width:`${(wallMapped/POSITIONS)*100}%`,background:wallMapped===POSITIONS?T.green:T.blue,borderRadius:3,transition:"width 0.3s"}}/>
          </div>
          <button onClick={clearWall} style={{width:"100%",padding:"8px",background:"transparent",border:`1px solid ${T.red}40`,borderRadius:6,color:T.red,fontSize:11,cursor:"pointer",fontFamily:mono,fontWeight:700}}>
            CLEAR WALL {wall} MAP
          </button>
        </Card>
      </div>

      {/* ── Right: Position Grid ──────────────────────────────── */}
      <div>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12}}>
          <SectionHeader>Wall {wall} — Position Map</SectionHeader>
          <div style={{display:"flex",gap:16,fontSize:11,color:T.textDim}}>
            <span><span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:T.green,marginRight:4}}/>Mapped</span>
            <span><span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:T.border,marginRight:4}}/>Empty</span>
            <span><span style={{display:"inline-block",width:10,height:10,borderRadius:2,background:T.amber,marginRight:4}}/>Active scan</span>
          </div>
        </div>

        <Card style={{padding:12}}>
          <div style={{display:"grid",gridTemplateColumns:`repeat(${COLS},1fr)`,gap:4}}>
            {Array.from({length:POSITIONS},(_,i)=>{
              const posNum=i+1;
              const key=wallKey(posNum);
              const trayId=positionMap[key];
              const isActive=flashPos===key;
              const isScanning=parsePos(posInput)===posNum&&scanStage==="tray";
              const bgColor=isActive?`${T.green}80`:isScanning?`${T.amber}40`:trayId?`${T.green}25`:T.surface;
              const borderColor=isActive?T.green:isScanning?T.amber:trayId?`${T.green}60`:T.border;
              return(
                <div key={key}
                  title={trayId?`${key}: ${trayId} — click to clear`:`${key}: empty`}
                  onClick={()=>trayId&&clearPosition(key)}
                  style={{
                    position:"relative",
                    aspectRatio:"1",
                    background:bgColor,
                    border:`1px solid ${borderColor}`,
                    borderRadius:4,
                    display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",
                    cursor:trayId?"pointer":"default",
                    transition:"all 0.2s",
                    minHeight:0,
                  }}>
                  <div style={{fontSize:8,color:trayId?T.textMuted:T.textDim,fontFamily:mono,lineHeight:1}}>{posNum}</div>
                  {trayId&&(
                    <div style={{fontSize:7,color:T.green,fontFamily:mono,fontWeight:700,lineHeight:1,marginTop:1,textAlign:"center",wordBreak:"break-all"}}>
                      {trayId.replace("T-","")}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <div style={{marginTop:10,fontSize:10,color:T.textDim,fontFamily:mono,textAlign:"center"}}>
            Click any mapped position to clear it · {POSITIONS-wallMapped} positions remaining on Wall {wall}
          </div>
        </Card>

        {/* Mapped list — quick reference */}
        {wallMapped>0&&(
          <div style={{marginTop:16}}>
            <SectionHeader>Mapped Positions — Wall {wall}</SectionHeader>
            <Card style={{maxHeight:160,overflowY:"auto",padding:"8px 12px"}}>
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
                {Object.entries(positionMap)
                  .filter(([k])=>k.startsWith(`W${wall}-`))
                  .sort(([a],[b])=>a.localeCompare(b))
                  .map(([pos,tray])=>(
                    <div key={pos} style={{display:"flex",justifyContent:"space-between",padding:"4px 8px",background:T.bg,borderRadius:4,fontSize:11,fontFamily:mono}}>
                      <span style={{color:T.textDim}}>{pos.split("-")[1]}</span>
                      <span style={{color:T.green,fontWeight:700}}>{tray}</span>
                    </div>
                  ))}
              </div>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}

function TrayFleetTab({trays,setTrays}){
  const [subView,setSubView]=useState("fleet");
  const [selectedTray,setSelectedTray]=useState(null);
  const [scanTrayInput,setScanTrayInput]=useState("");
  const [scanJobInput,setScanJobInput]=useState("");
  const [sortBy,setSortBy]=useState("id");
  const [filterState,setFilterState]=useState("ALL");
  const [lightFlashing,setLightFlashing]=useState({});
  const [soundPlaying,setSoundPlaying]=useState({});
  const [positionMap,setPositionMap]=useState(()=>{
    try{return JSON.parse(localStorage.getItem("la_position_map")||"{}");}catch{return {};}
  });
  // Persist position map to localStorage
  useEffect(()=>{try{localStorage.setItem("la_position_map",JSON.stringify(positionMap));}catch{};},[positionMap]);

  const counts={};trays.forEach(t=>{counts[t.state]=(counts[t.state]||0)+1;});
  const lowBattery=trays.filter(t=>t.battery<20).length;
  const avgBattery=Math.round(trays.reduce((s,t)=>s+t.battery,0)/trays.length);

  const filtered=filterState==="ALL"?trays:filterState.startsWith("dept_")?trays.filter(t=>t.department===filterState.replace("dept_","")):trays.filter(t=>t.state===filterState);
  const sorted=[...filtered].sort((a,b)=>{
    if(sortBy==="battery")return a.battery-b.battery;
    if(sortBy==="state")return a.state.localeCompare(b.state);
    if(sortBy==="department")return(a.department||"").localeCompare(b.department||"");
    if(sortBy==="lastSeen")return b.lastSeen-a.lastSeen;
    return a.id.localeCompare(b.id);
  });

  const [bindResult,setBindResult]=useState(null); // {ok, trayId, job}

  const handleScanBind=()=>{
    if(!scanTrayInput.trim()||!scanJobInput.trim())return;
    const posKey=scanTrayInput.trim().toUpperCase();
    const job=scanJobInput.trim();

    // Resolve tray from position map
    const mappedTrayId=positionMap[posKey];
    if(!mappedTrayId){
      setBindResult({ok:false,msg:`Position ${posKey} not in map — go to Put Wall Map tab and pre-load trays first`});
      return;
    }
    const exists=trays.find(t=>t.id===mappedTrayId);
    if(!exists){
      setBindResult({ok:false,msg:`Tray "${mappedTrayId}" mapped to ${posKey} but not found in fleet`});
      return;
    }
    setTrays(prev=>prev.map(t=>t.id===mappedTrayId?{...t,job,state:"BOUND",updatedAt:Date.now(),rx:genRx(),einkPages:3,coatingType:pick(COATING_TYPES),department:"PICKING",coatingStage:null,machine:null,batchId:null,position:posKey}:t));
    setBindResult({ok:true,trayId:mappedTrayId,job,msg:`✓ ${job} → ${posKey} → ${mappedTrayId} bound`});
    setSelectedTray(mappedTrayId);
    setScanTrayInput("");setScanJobInput("");
    setTimeout(()=>setBindResult(null),6000);
  };

  const handleLightUp=(trayId)=>{
    setLightFlashing(p=>({...p,[trayId]:true}));
    setTrays(prev=>prev.map(t=>t.id===trayId?{...t,lightOn:true}:t));
    setTimeout(()=>{
      setLightFlashing(p=>({...p,[trayId]:false}));
      setTrays(prev=>prev.map(t=>t.id===trayId?{...t,lightOn:false}:t));
    },3000);
  };

  const handlePlaySound=(trayId)=>{
    setSoundPlaying(p=>({...p,[trayId]:true}));
    // Three-beep pattern like a real tray locator
    playBeep(880,0.15,"sine");
    setTimeout(()=>playBeep(880,0.15,"sine"),250);
    setTimeout(()=>playBeep(1100,0.3,"sine"),500);
    setTimeout(()=>setSoundPlaying(p=>({...p,[trayId]:false})),900);
  };

  const sel=trays.find(t=>t.id===selectedTray);

  return(
    <div>
      <div style={{display:"flex",gap:4,marginBottom:16}}>
        {[{id:"fleet",label:"Fleet Overview",icon:"◈"},{id:"uwb",label:"UWB Position Map",icon:"📡"},{id:"scan",label:"Scan → Bind Job",icon:"⊞"},{id:"putwall",label:"Put Wall Map",icon:"⬡"}].map(sv=>(
          <button key={sv.id} onClick={()=>setSubView(sv.id)} style={{background:subView===sv.id?T.blueDark:"transparent",border:`1px solid ${subView===sv.id?T.blue:"transparent"}`,borderRadius:8,padding:"10px 20px",cursor:"pointer",color:subView===sv.id?T.blue:T.textMuted,fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:8,fontFamily:sans}}><span>{sv.icon}</span>{sv.label}</button>
        ))}
      </div>

      {subView==="fleet"?(
        <div style={{display:"grid",gridTemplateColumns:"1fr 340px",gap:20}}>
          <div>
            <div style={{display:"flex",gap:14,marginBottom:16,flexWrap:"wrap"}}>
              <KPICard label="Total Fleet" value={trays.length} accent={T.blue}/>
              <KPICard label="Active" value={trays.filter(t=>t.state!=="IDLE").length} accent={T.green}/>
              <KPICard label="Avg Battery" value={`${avgBattery}%`} accent={avgBattery>50?T.green:T.amber}/>
              <KPICard label="Low Battery" value={lowBattery} sub="< 20%" accent={T.red}/>
            </div>
            {/* Dept filter */}
            <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:6}}>
              <span style={{fontSize:10,color:T.textDim,fontFamily:mono,lineHeight:"24px",marginRight:4}}>DEPT:</span>
              {Object.entries(DEPARTMENTS).map(([k,v])=>{
                const cnt=trays.filter(t=>t.department===k).length;
                if(!cnt)return null;
                return(<button key={k} onClick={()=>setFilterState(filterState===`dept_${k}`?"ALL":`dept_${k}`)} style={{padding:"3px 8px",borderRadius:4,fontSize:9,fontFamily:mono,cursor:"pointer",background:filterState===`dept_${k}`?`${v.color}20`:T.bg,border:`1px solid ${filterState===`dept_${k}`?v.color:T.border}`,color:filterState===`dept_${k}`?v.color:T.textDim,fontWeight:700}}>{v.icon} {v.label} ({cnt})</button>);
              })}
            </div>
            <div style={{display:"flex",flexWrap:"wrap",gap:3,marginBottom:10}}>
              <button onClick={()=>setFilterState("ALL")} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontFamily:mono,cursor:"pointer",background:filterState==="ALL"?T.blueDark:T.bg,border:`1px solid ${filterState==="ALL"?T.blue:T.border}`,color:filterState==="ALL"?T.blue:T.textDim,fontWeight:700}}>ALL ({trays.length})</button>
              {Object.entries(TRAY_STATES).map(([k,v])=>(
                <button key={k} onClick={()=>setFilterState(k)} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontFamily:mono,cursor:"pointer",background:filterState===k?v.bg:T.bg,border:`1px solid ${filterState===k?v.color:T.border}`,color:filterState===k?v.color:T.textDim,fontWeight:700}}>{v.label} ({counts[k]||0})</button>
              ))}
            </div>
            <div style={{display:"flex",gap:4,marginBottom:10}}>
              <span style={{fontSize:10,color:T.textDim,fontFamily:mono,lineHeight:"28px"}}>SORT:</span>
              {["id","battery","state","department","lastSeen"].map(s=>(
                <button key={s} onClick={()=>setSortBy(s)} style={{padding:"4px 10px",borderRadius:4,fontSize:10,fontFamily:mono,cursor:"pointer",background:sortBy===s?T.card:"transparent",border:`1px solid ${sortBy===s?T.borderLight:"transparent"}`,color:sortBy===s?T.text:T.textDim,fontWeight:600}}>{s==="lastSeen"?"Last Seen":s==="department"?"Dept":s.charAt(0).toUpperCase()+s.slice(1)}</button>
              ))}
            </div>
            <Card style={{maxHeight:520,overflowY:"auto",padding:0}}>
              {sorted.map(t=>{
                const s=TRAY_STATES[t.state];
                const ago=Math.floor((Date.now()-t.lastSeen)/60000);
                const isFlashing=lightFlashing[t.id];
                return(
                  <div key={t.id} onClick={()=>setSelectedTray(t.id)} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",background:selectedTray===t.id?T.cardHover:isFlashing?`${T.amber}15`:"transparent",transition:"background 0.3s"}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:isFlashing?T.amber:s.color,flexShrink:0,boxShadow:isFlashing?`0 0 12px ${T.amber}`:`0 0 6px ${s.color}40`,animation:isFlashing?"pulse 0.5s infinite":""}}/>
                    <div style={{flex:1}}>
                      <div style={{display:"flex",alignItems:"center",gap:7}}>
                        <span style={{fontSize:13,color:T.text,fontWeight:700,fontFamily:mono}}>{t.id}</span>
                        <Pill color={s.color}>{s.label}</Pill>
                        {t.rush&&<Pill color={T.red}>RUSH</Pill>}
                        {isFlashing&&<Pill color={T.amber} bg={`${T.amber}30`}>💡 LIT</Pill>}
                      </div>
                      <div style={{fontSize:10,color:T.textDim,marginTop:2}}>
                        {t.job?`Job: ${t.job}`:"No job"}{t.coatingType?` • ${t.coatingType}`:""}
                        {t.department&&DEPARTMENTS[t.department]&&<span style={{color:DEPARTMENTS[t.department].color}}> • {DEPARTMENTS[t.department].label}</span>}
                        {t.coatingStage&&COATING_STAGES[t.coatingStage]&&<span style={{color:COATING_STAGES[t.coatingStage].color}}> › {COATING_STAGES[t.coatingStage].label}</span>}
                      </div>
                    </div>
                    {/* Battery icon */}
                    <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:3,flexShrink:0}}>
                      <BatteryIcon level={t.battery} size={14}/>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{ago}m ago</div>
                    </div>
                  </div>
                );
              })}
            </Card>
          </div>

          {/* Detail Panel */}
          <div>
            {sel?(
              <Card style={{borderTop:`3px solid ${TRAY_STATES[sel.state].color}`,position:"sticky",top:80}}>
                <SectionHeader>{sel.id} Details</SectionHeader>

                {/* Battery prominent display */}
                <div style={{display:"flex",alignItems:"center",gap:14,padding:"14px",background:T.bg,borderRadius:8,marginBottom:14,border:`1px solid ${T.border}`}}>
                  <BatteryIcon level={sel.battery} size={24}/>
                  <div>
                    <div style={{fontSize:22,fontWeight:800,color:sel.battery<20?T.red:sel.battery<50?T.amber:T.green,fontFamily:mono}}>{sel.battery}%</div>
                    <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{sel.battery<20?"LOW — charge soon":sel.battery<50?"Moderate":"Good"}</div>
                  </div>
                  <div style={{marginLeft:"auto",textAlign:"right"}}>
                    <div style={{fontSize:11,color:T.textDim,fontFamily:mono}}>RSSI</div>
                    <div style={{fontSize:14,fontWeight:700,color:T.textMuted,fontFamily:mono}}>{sel.rssi} dBm</div>
                  </div>
                </div>

                {/* Tray controls — Light Up + Sound */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:14}}>
                  <button onClick={()=>handleLightUp(sel.id)}
                    style={{padding:"12px 8px",borderRadius:8,border:`2px solid ${lightFlashing[sel.id]?T.amber:T.border}`,background:lightFlashing[sel.id]?`${T.amber}25`:T.bg,color:lightFlashing[sel.id]?T.amber:T.textMuted,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:mono,transition:"all 0.2s",boxShadow:lightFlashing[sel.id]?`0 0 16px ${T.amber}50`:"none"}}>
                    {lightFlashing[sel.id]?"💡 GLOWING...":"💡 LIGHT UP"}
                  </button>
                  <button onClick={()=>handlePlaySound(sel.id)}
                    style={{padding:"12px 8px",borderRadius:8,border:`2px solid ${soundPlaying[sel.id]?T.cyan:T.border}`,background:soundPlaying[sel.id]?`${T.cyan}20`:T.bg,color:soundPlaying[sel.id]?T.cyan:T.textMuted,fontWeight:700,fontSize:12,cursor:"pointer",fontFamily:mono,transition:"all 0.2s",boxShadow:soundPlaying[sel.id]?`0 0 16px ${T.cyan}50`:"none"}}>
                    {soundPlaying[sel.id]?"🔊 BEEPING...":"🔊 PLAY SOUND"}
                  </button>
                </div>

                {/* Tray details grid */}
                <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:"5px 12px",fontSize:12,marginBottom:14}}>
                  {[
                    ["State",TRAY_STATES[sel.state].label,TRAY_STATES[sel.state].color],
                    ["Job",sel.job||"—",T.text],
                    ["Dept",sel.department&&DEPARTMENTS[sel.department]?DEPARTMENTS[sel.department].label:"—",sel.department&&DEPARTMENTS[sel.department]?DEPARTMENTS[sel.department].color:T.textDim],
                    ...(sel.coatingStage&&COATING_STAGES[sel.coatingStage]?[["Stage",COATING_STAGES[sel.coatingStage].label,COATING_STAGES[sel.coatingStage].color]]:[]),
                    ...(sel.machine?[["Machine",sel.machine,T.amber]]:[]),
                    ...(sel.batchId?[["Batch",sel.batchId,T.cyan]]:[]),
                    ["Coating",sel.coatingType||"—",T.amber],
                    ["Pages",String(sel.einkPages),T.text],
                    ...(sel.breakType?[["Break",sel.breakType,T.red]]:[]),
                  ].map(([label,val,col],idx)=>(
                    <><span key={idx+"l"} style={{color:T.textDim,fontFamily:mono}}>{label}:</span><span key={idx+"v"} style={{color:col,fontWeight:700,fontFamily:mono}}>{val}</span></>
                  ))}
                </div>

                {/* E-ink preview */}
                {sel.job&&(
                  <div>
                    <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginBottom:6}}>E-INK DISPLAY PREVIEW</div>
                    {[
                      {page:"1/3",title:"JOB BARCODE",content:(
                        <div style={{textAlign:"center"}}>
                          <div style={{display:"flex",justifyContent:"center",gap:1,marginBottom:4,padding:"0 4px"}}>
                            {Array.from({length:36},(_,i)=>{
                              const c=(sel.job||"X").charCodeAt(i%Math.max(1,(sel.job||"X").length));
                              const wide=(c+i*7)%3===0;
                              return <div key={i} style={{width:wide?3:1,height:28,background:"#111",flexShrink:0}}/>;
                            })}
                          </div>
                          <div style={{fontSize:13,fontWeight:900,color:"#111",fontFamily:mono,letterSpacing:1.5}}>{sel.job}</div>
                        </div>
                      )},
                      sel.rx?{page:"2/3",title:"RX DATA",content:(
                        <div style={{fontFamily:mono,fontSize:11,color:"#111"}}>
                          <div>SPH: {sel.rx.sph}  CYL: {sel.rx.cyl}</div>
                          <div>AXIS: {sel.rx.axis}°{sel.rx.add?`  ADD: +${sel.rx.add}`:""}</div>
                          <div style={{marginTop:4,fontSize:10,color:"#555"}}>{sel.coatingType} coating</div>
                        </div>
                      )}:null,
                      {page:"3/3",title:"ROUTING",content:(
                        <div style={{fontFamily:mono,fontSize:10,color:"#111"}}>
                          <div>ROUTE: SURF → COAT → EDGE</div>
                          <div>PRIORITY: {sel.rush?"🔴 RUSH":"STANDARD"}</div>
                          <div style={{marginTop:3,fontSize:9,color:"#555"}}>Tray: {sel.id}</div>
                        </div>
                      )},
                    ].filter(Boolean).map(pg=>(
                      <div key={pg.page} style={{background:"#E8E4D8",borderRadius:6,padding:10,marginBottom:6,border:"2px solid #B8B4A8"}}>
                        <div style={{fontSize:8,color:"#666",fontFamily:mono,marginBottom:4}}>PAGE {pg.page} — {pg.title}</div>
                        {pg.content}
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            ):<Card style={{textAlign:"center",padding:40}}><div style={{fontSize:12,color:T.textDim}}>Select a tray to view details, light it up, or play a sound</div></Card>}
          </div>
        </div>
      ):subView==="uwb"?(
        /* UWB Position Map — Phase 1 */
        <UWBPositionView trays={trays} selectedTray={selectedTray} setSelectedTray={setSelectedTray}/>
      ):subView==="putwall"?(
        <PutWallMapView positionMap={positionMap} setPositionMap={setPositionMap} trays={trays}/>
      ):(
        <div style={{display:"grid",gridTemplateColumns:"400px 1fr",gap:20}}>
          <Card style={{borderTop:`3px solid ${T.green}`}}>
            <SectionHeader>Scan → Bind Job to Position</SectionHeader>
            <div style={{fontSize:11,color:T.textMuted,marginBottom:16,lineHeight:1.6}}>
              Scan thermal job label, then scan put wall position QR.<br/>
              Tray resolved automatically from position map.
            </div>

            {/* ① Job label */}
            <div style={{marginBottom:12}}>
              <label style={{fontSize:10,color:scanJobInput?T.green:T.amber,fontFamily:mono,display:"block",marginBottom:4,letterSpacing:1}}>
                ① SCAN THERMAL JOB LABEL {!scanJobInput&&"◀"}
              </label>
              <input
                value={scanJobInput}
                onChange={e=>{setScanJobInput(e.target.value);setBindResult(null);}}
                onKeyDown={e=>{if(e.key==="Enter")document.getElementById("posInput")?.focus();}}
                placeholder="J21694"
                autoFocus
                style={{width:"100%",background:scanJobInput?`${T.green}10`:T.bg,border:`2px solid ${scanJobInput?T.green:T.amber}`,borderRadius:6,padding:"10px 14px",color:T.text,fontSize:16,fontFamily:mono,outline:"none",boxSizing:"border-box",transition:"all 0.2s"}}
              />
              {scanJobInput&&<div style={{fontSize:10,color:T.green,fontFamily:mono,marginTop:3}}>✓ Job {scanJobInput.trim()}</div>}
            </div>

            {/* ② Position QR */}
            <div style={{marginBottom:6}}>
              <label style={{fontSize:10,color:scanJobInput?(scanTrayInput?T.green:T.amber):T.textDim,fontFamily:mono,display:"block",marginBottom:4,letterSpacing:1}}>
                ② SCAN PUT WALL POSITION QR {scanJobInput&&!scanTrayInput&&"◀"}
              </label>
              <input
                id="posInput"
                value={scanTrayInput}
                onChange={e=>{setScanTrayInput(e.target.value);setBindResult(null);}}
                onKeyDown={e=>{if(e.key==="Enter")handleScanBind();}}
                placeholder="W1-P23"
                disabled={!scanJobInput.trim()}
                style={{width:"100%",background:scanTrayInput?`${T.green}10`:T.bg,border:`2px solid ${scanJobInput?(scanTrayInput?T.green:T.amber):T.border}`,borderRadius:6,padding:"10px 14px",color:scanJobInput?T.text:T.textDim,fontSize:16,fontFamily:mono,outline:"none",boxSizing:"border-box",transition:"all 0.2s",opacity:scanJobInput?1:0.5}}
              />
              {(()=>{
                const raw=scanTrayInput.trim().toUpperCase();
                const mappedTray=positionMap[raw];
                const trayObj=mappedTray?trays.find(t=>t.id===mappedTray):null;
                if(raw&&mappedTray)return <div style={{fontSize:10,color:T.green,fontFamily:mono,marginTop:3}}>✓ Position {raw} → {mappedTray} {trayObj?`(${TRAY_STATES[trayObj.state].label})`:""}</div>;
                if(raw&&!mappedTray&&raw.match(/W[12]-P\d+/))return <div style={{fontSize:10,color:T.amber,fontFamily:mono,marginTop:3}}>⚠ {raw} not in position map — run pre-load first</div>;
                return null;
              })()}
            </div>

            <div style={{fontSize:10,color:T.textDim,fontFamily:mono,padding:"6px 10px",background:T.bg,borderRadius:5,marginBottom:14,lineHeight:1.7}}>
              Position map: {Object.keys(positionMap).length} positions loaded
              {Object.keys(positionMap).length===0&&<span style={{color:T.amber}}> · Go to Put Wall Map tab to pre-load trays</span>}
            </div>

            <button onClick={handleScanBind} disabled={!scanTrayInput.trim()||!scanJobInput.trim()} style={{width:"100%",padding:"14px",background:(scanTrayInput.trim()&&scanJobInput.trim())?T.green:T.border,border:"none",borderRadius:8,color:(scanTrayInput.trim()&&scanJobInput.trim())?"#000":T.textDim,fontWeight:800,fontSize:14,cursor:(scanTrayInput.trim()&&scanJobInput.trim())?"pointer":"default",fontFamily:mono,letterSpacing:1}}>
              BIND JOB → POSITION
            </button>

            {bindResult&&(
              <div style={{marginTop:12,padding:"10px 14px",borderRadius:8,background:bindResult.ok?`${T.green}15`:`${T.red}15`,border:`1px solid ${bindResult.ok?T.green:T.red}`,fontSize:12,color:bindResult.ok?T.green:T.red,fontFamily:mono,fontWeight:700}}>
                {bindResult.msg}
              </div>
            )}

            <div style={{marginTop:14,fontSize:10,color:T.textDim,lineHeight:1.9,padding:"8px 12px",background:T.bg,borderRadius:6}}>
              <strong style={{color:T.textMuted}}>What happens on bind:</strong><br/>
              1. Job number linked to position + tray<br/>
              2. Tray state → BOUND, zone → PICKING<br/>
              3. BLE zone tracking begins<br/>
              4. Job visible in fleet + AI queries
            </div>
          </Card>
          <div>
            {/* Live E-Ink Preview — renders as you scan */}
            <SectionHeader>E-Ink Display Preview</SectionHeader>
            {(scanTrayInput||scanJobInput)?(
              <div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:20}}>
                {[
                  {page:1,title:"JOB BARCODE",content:(
                    <div style={{textAlign:"center",padding:"12px 0"}}>
                      <div style={{display:"flex",justifyContent:"center",gap:1,marginBottom:8}}>
                        {Array.from({length:36},(_,i)=>{
                          const job=scanJobInput||"J_____";
                          const c=job.charCodeAt(i%Math.max(1,job.length));
                          const wide=(c+i*7)%3===0;
                          return <div key={i} style={{width:wide?3:1,height:40,background:"#111",flexShrink:0}}/>;
                        })}
                      </div>
                      <div style={{fontSize:20,fontWeight:900,color:"#111",fontFamily:mono,letterSpacing:2}}>{scanJobInput||"J_____"}</div>
                    </div>
                  )},
                  {page:2,title:"RX DATA",content:(
                    <div style={{fontFamily:mono,fontSize:13,color:"#111",padding:"8px 0"}}>
                      <div>SPH: {scanTrayInput?"-2.50":"—"}  CYL: {scanTrayInput?"-1.25":"—"}</div>
                      <div>AXIS: {scanTrayInput?"90°":"—"}{scanTrayInput?"  ADD: +2.00":""}</div>
                      <div style={{marginTop:8,fontSize:11,color:"#555"}}>{scanTrayInput?"AR Coating • Standard":"Scan tray to load RX"}</div>
                    </div>
                  )},
                  {page:3,title:"ROUTING",content:(
                    <div style={{fontFamily:mono,fontSize:12,color:"#111",padding:"8px 0"}}>
                      <div>SURF → COAT → EDGE → QC</div>
                      <div style={{marginTop:6}}>PRIORITY: STANDARD</div>
                      <div style={{marginTop:6,fontSize:10,color:"#555"}}>Tray: {scanTrayInput||"T-___"}</div>
                    </div>
                  )},
                ].map(pg=>(
                  <div key={pg.page} style={{background:"#E8E4D8",borderRadius:8,padding:16,width:250,border:"3px solid #B8B4A8",flex:"1 1 220px"}}>
                    <div style={{fontSize:9,color:"#888",fontFamily:mono,marginBottom:6}}>PAGE {pg.page} — {pg.title}</div>
                    {pg.content}
                  </div>
                ))}
              </div>
            ):(
              <Card style={{textAlign:"center",padding:32,marginBottom:20}}>
                <div style={{fontSize:12,color:T.textDim}}>Scan a tray and job ID to preview e-ink pages live</div>
              </Card>
            )}

            {/* Recent Bindings */}
            <SectionHeader>Recent Bindings</SectionHeader>
            <Card style={{maxHeight:260,overflowY:"auto"}}>
              {[...trays.filter(t=>t.state==="BOUND")].sort((a,b)=>b.updatedAt-a.updatedAt).slice(0,15).map((t,idx)=>(
                <div key={t.id} onClick={()=>setSelectedTray(t.id)} style={{display:"flex",alignItems:"center",gap:12,padding:"8px 0",borderBottom:`1px solid ${T.border}`,cursor:"pointer",background:idx===0&&(Date.now()-t.updatedAt)<10000?`${T.green}10`:"transparent",transition:"background 0.5s"}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:idx===0&&(Date.now()-t.updatedAt)<10000?T.green:T.blue,flexShrink:0,boxShadow:idx===0&&(Date.now()-t.updatedAt)<10000?`0 0 8px ${T.green}`:""}}/>
                  <span style={{fontSize:12,color:T.text,fontFamily:mono,fontWeight:700}}>{t.id}</span>
                  <span style={{fontSize:11,color:T.textDim}}>→</span>
                  <span style={{fontSize:12,color:T.cyan,fontFamily:mono,fontWeight:700}}>{t.job}</span>
                  {t.coatingType&&<span style={{fontSize:10,color:T.amber,fontFamily:mono}}>{t.coatingType}</span>}
                  <span style={{fontSize:10,color:T.textDim,marginLeft:"auto",flexShrink:0}}>{new Date(t.updatedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
                </div>
              ))}
              {trays.filter(t=>t.state==="BOUND").length===0&&(
                <div style={{textAlign:"center",padding:20,fontSize:12,color:T.textDim}}>No bindings yet — scan a tray above</div>
              )}
            </Card>
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Production Analytics Tab ──────────────────────────────────
// ══════════════════════════════════════════════════════════════

// Simulated 30-day historical batch data — replace with DVI/MES API in production
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

// Mini horizontal bar inside a row
function MiniBar({pct,color}){
  return(
    <div style={{display:"flex",alignItems:"center",gap:6}}>
      <div style={{width:60,height:5,background:"#1E293B",borderRadius:3,overflow:"hidden",flexShrink:0}}>
        <div style={{height:"100%",width:`${pct}%`,background:color,borderRadius:3}}/>
      </div>
      <span style={{fontFamily:"'JetBrains Mono',monospace",fontSize:10,color,fontWeight:700}}>{pct}%</span>
    </div>
  );
}

// Simple SVG bar chart
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

// Tiny inline sparkline
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

function AnalyticsTab({batches,trays,ovenServerUrl,settings}){
  const mono="'JetBrains Mono',monospace";
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

// ── SETTINGS TAB ──────────────────────────────────────────────────────────────
function SettingsTab({settings,setSettings,ovenServerUrl}){
  const mono="'JetBrains Mono',monospace";
  const [sub,setSub]=useState("equipment");
  const [pinInput,setPinInput]=useState("");
  const [pinMode,setPinMode]=useState(null); // null, 'set', 'change', 'verify'
  const [pinError,setPinError]=useState("");
  const [pinAttempts,setPinAttempts]=useState(0);
  const [lockoutUntil,setLockoutUntil]=useState(null);
  const [editingCategory,setEditingCategory]=useState(null);
  const [editingEquipment,setEditingEquipment]=useState(null);
  const [categoryFilter,setCategoryFilter]=useState("all");
  const [serverStatus,setServerStatus]=useState(null);
  const [testingServer,setTestingServer]=useState(false);
  const [gatewayStatus,setGatewayStatus]=useState(null);
  const [testingGateway,setTestingGateway]=useState(false);
  const [gatewayData,setGatewayData]=useState(null);
  const [gatewayRequests,setGatewayRequests]=useState([]);
  const [loadingGateway,setLoadingGateway]=useState(false);
  const [editingLimits,setEditingLimits]=useState(false);
  const [limitsForm,setLimitsForm]=useState(null);
  const [requestFilter,setRequestFilter]=useState({source:'all',status:'all',agent:'all'});
  const [statsPeriod,setStatsPeriod]=useState('24h');

  // Check for lockout
  const isLockedOut = lockoutUntil && Date.now() < lockoutUntil;
  const lockoutRemaining = isLockedOut ? Math.ceil((lockoutUntil - Date.now()) / 1000) : 0;

  // Test server connection
  const testServerConnection = async () => {
    setTestingServer(true);
    try {
      const resp = await fetch(`${settings.serverUrl || ovenServerUrl}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) {
        const data = await resp.json();
        setServerStatus({ ok: true, message: `Connected — ${data.runs || 0} runs, ${data.liveRacks || 0} live racks` });
      } else {
        setServerStatus({ ok: false, message: `HTTP ${resp.status}` });
      }
    } catch (e) {
      setServerStatus({ ok: false, message: e.message || 'Connection failed' });
    }
    setTestingServer(false);
  };

  // Test gateway connection
  const testGatewayConnection = async () => {
    setTestingGateway(true);
    try {
      const resp = await fetch(`${settings.gatewayUrl || 'http://localhost:3001'}/health`, {
        signal: AbortSignal.timeout(5000)
      });
      if (resp.ok) {
        const data = await resp.json();
        setGatewayStatus({
          ok: data.status === 'healthy',
          message: `${data.status} — DB: ${data.database}, Circuit: ${data.circuit_breaker}`,
          uptime: data.uptime
        });
      } else {
        setGatewayStatus({ ok: false, message: `HTTP ${resp.status}` });
      }
    } catch (e) {
      setGatewayStatus({ ok: false, message: e.message || 'Connection failed' });
    }
    setTestingGateway(false);
  };

  // Load gateway dashboard data
  const loadGatewayData = async () => {
    setLoadingGateway(true);
    const gwUrl = settings.gatewayUrl || 'http://localhost:3001';
    try {
      const [statsRes, reqsRes] = await Promise.all([
        fetch(`${gwUrl}/gateway/stats/detailed?since=${statsPeriod}`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${gwUrl}/gateway/requests?limit=100`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (statsRes.ok) {
        const data = await statsRes.json();
        setGatewayData(data);
        if (!limitsForm) setLimitsForm(data.limits);
      }
      if (reqsRes.ok) {
        const data = await reqsRes.json();
        setGatewayRequests(data.requests || []);
      }
    } catch (e) {
      console.error('Failed to load gateway data:', e);
    }
    setLoadingGateway(false);
  };

  // Save updated rate limits
  const saveLimits = async () => {
    const gwUrl = settings.gatewayUrl || 'http://localhost:3001';
    try {
      const resp = await fetch(`${gwUrl}/gateway/config/limits`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(limitsForm),
      });
      if (resp.ok) {
        setEditingLimits(false);
        loadGatewayData();
      } else {
        alert('Failed to save limits');
      }
    } catch (e) {
      alert(`Error: ${e.message}`);
    }
  };

  // PIN verification
  const handlePinSubmit = () => {
    if (isLockedOut) return;

    if (pinMode === 'verify') {
      if (pinInput === settings.pin) {
        setPinMode(null);
        setPinInput("");
        setPinError("");
        setPinAttempts(0);
      } else {
        const newAttempts = pinAttempts + 1;
        setPinAttempts(newAttempts);
        setPinError(`Incorrect PIN (${3 - newAttempts} attempts remaining)`);
        setPinInput("");
        if (newAttempts >= 3) {
          setLockoutUntil(Date.now() + 30000);
          setPinError("Too many attempts. Locked for 30 seconds.");
        }
      }
    } else if (pinMode === 'set' || pinMode === 'change') {
      if (pinInput.length < 4 || pinInput.length > 6) {
        setPinError("PIN must be 4-6 digits");
        return;
      }
      if (!/^\d+$/.test(pinInput)) {
        setPinError("PIN must be numbers only");
        return;
      }
      setSettings(prev => ({ ...prev, pin: pinInput, pinEnabled: true }));
      setPinMode(null);
      setPinInput("");
      setPinError("");
    }
  };

  const disablePin = () => {
    setSettings(prev => ({ ...prev, pin: null, pinEnabled: false }));
  };

  // Category CRUD
  const addCategory = () => {
    const id = `cat_${Date.now()}`;
    setSettings(prev => ({
      ...prev,
      equipmentCategories: [...prev.equipmentCategories, { id, name: 'New Category', icon: '⚙️', color: '#64748B' }]
    }));
    setEditingCategory(id);
  };

  const updateCategory = (id, updates) => {
    setSettings(prev => ({
      ...prev,
      equipmentCategories: prev.equipmentCategories.map(c => c.id === id ? { ...c, ...updates } : c)
    }));
  };

  const deleteCategory = (id) => {
    if (!confirm(`Delete this category? Equipment in this category will be moved to "Uncategorized".`)) return;
    setSettings(prev => ({
      ...prev,
      equipmentCategories: prev.equipmentCategories.filter(c => c.id !== id),
      equipment: prev.equipment.map(e => e.categoryId === id ? { ...e, categoryId: null } : e)
    }));
  };

  // Equipment CRUD
  const addEquipment = () => {
    const id = `eq_${Date.now()}`;
    const defaultCat = settings.equipmentCategories[0]?.id || null;
    setSettings(prev => ({
      ...prev,
      equipment: [...prev.equipment, { id, categoryId: defaultCat, name: 'New Equipment', serialNumber: '', location: '' }]
    }));
    setEditingEquipment(id);
  };

  const updateEquipment = (id, updates) => {
    setSettings(prev => ({
      ...prev,
      equipment: prev.equipment.map(e => e.id === id ? { ...e, ...updates } : e)
    }));
  };

  const deleteEquipment = (id) => {
    if (!confirm(`Delete this equipment?`)) return;
    setSettings(prev => ({
      ...prev,
      equipment: prev.equipment.filter(e => e.id !== id)
    }));
    if (editingEquipment === id) setEditingEquipment(null);
  };

  // Available icons for picker
  const ICONS = ['⚙️','🌡','🔥','✂️','💿','⚡','📡','🔲','🔳','📐','🔧','🛠️','⚗️','🔬','📦','🏭','💡','🔌'];

  // Filter equipment
  const filteredEquipment = categoryFilter === 'all'
    ? settings.equipment
    : settings.equipment.filter(e => e.categoryId === categoryFilter);

  // Get category by ID
  const getCat = (id) => settings.equipmentCategories.find(c => c.id === id) || { name: 'Uncategorized', icon: '❓', color: '#64748B' };

  // Top nav
  const topBar = (
    <div style={{display:"flex",alignItems:"center",gap:4,marginBottom:18,flexWrap:"wrap"}}>
      {[
        {id:"equipment",icon:"⚙️",label:"Equipment"},
        {id:"categories",icon:"📦",label:"Categories"},
        {id:"server",icon:"🔗",label:"Server"},
        {id:"gateway",icon:"🌐",label:"Gateway"},
        {id:"ai",icon:"🤖",label:"AI"},
        {id:"security",icon:"🔒",label:"Security"},
      ].map(n=>(
        <button key={n.id} onClick={()=>setSub(n.id)}
          style={{background:sub===n.id?T.blueDark:"transparent",border:`1px solid ${sub===n.id?T.blue:"transparent"}`,
          borderRadius:8,padding:"9px 18px",cursor:"pointer",color:sub===n.id?"#93C5FD":T.textMuted,
          fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:7,fontFamily:"'DM Sans',sans-serif",transition:"all 0.2s"}}>
          {n.icon} {n.label}
        </button>
      ))}
    </div>
  );

  return(
    <div>
      <div style={{marginBottom:20}}>
        <div style={{fontSize:22,fontWeight:800,color:T.text,marginBottom:4}}>Settings</div>
        <div style={{fontSize:12,color:T.textMuted}}>Configure equipment, categories, and server connections</div>
      </div>

      {topBar}

      {/* ══ EQUIPMENT ══ */}
      {sub==="equipment"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>FILTER:</span>
              <select value={categoryFilter} onChange={e=>setCategoryFilter(e.target.value)}
                style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 10px",color:T.text,fontSize:12,fontFamily:mono}}>
                <option value="all">All Categories</option>
                {settings.equipmentCategories.map(c=>(
                  <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                ))}
              </select>
            </div>
            <button onClick={addEquipment}
              style={{background:T.blue,border:"none",borderRadius:8,padding:"8px 16px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
              + Add Equipment
            </button>
          </div>

          <Card style={{padding:0}}>
            <div style={{maxHeight:500,overflowY:"auto"}}>
              {filteredEquipment.length === 0 ? (
                <div style={{padding:40,textAlign:"center",color:T.textDim}}>
                  <div style={{fontSize:32,marginBottom:10}}>⚙️</div>
                  <div style={{fontSize:13}}>No equipment in this category</div>
                  <button onClick={addEquipment} style={{marginTop:12,background:"transparent",border:`1px solid ${T.blue}`,borderRadius:6,padding:"6px 14px",color:T.blue,fontSize:12,cursor:"pointer"}}>
                    + Add Equipment
                  </button>
                </div>
              ) : (
                filteredEquipment.map(eq => {
                  const cat = getCat(eq.categoryId);
                  const isEditing = editingEquipment === eq.id;
                  return(
                    <div key={eq.id} style={{borderBottom:`1px solid ${T.border}`,padding:"14px 16px",background:isEditing?`${T.blue}08`:'transparent'}}>
                      {isEditing ? (
                        <div style={{display:"flex",flexDirection:"column",gap:12}}>
                          <div style={{display:"flex",gap:10}}>
                            <div style={{flex:1}}>
                              <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:4}}>NAME</label>
                              <input value={eq.name} onChange={e=>updateEquipment(eq.id,{name:e.target.value})}
                                style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 10px",color:T.text,fontSize:13}}/>
                            </div>
                            <div style={{width:180}}>
                              <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:4}}>CATEGORY</label>
                              <select value={eq.categoryId||''} onChange={e=>updateEquipment(eq.id,{categoryId:e.target.value})}
                                style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 10px",color:T.text,fontSize:12}}>
                                <option value="">Uncategorized</option>
                                {settings.equipmentCategories.map(c=>(
                                  <option key={c.id} value={c.id}>{c.icon} {c.name}</option>
                                ))}
                              </select>
                            </div>
                          </div>
                          <div style={{display:"flex",gap:10}}>
                            <div style={{flex:1}}>
                              <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:4}}>SERIAL NUMBER</label>
                              <input value={eq.serialNumber||''} onChange={e=>updateEquipment(eq.id,{serialNumber:e.target.value})} placeholder="Optional"
                                style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 10px",color:T.text,fontSize:13}}/>
                            </div>
                            <div style={{flex:1}}>
                              <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:4}}>LOCATION</label>
                              <input value={eq.location||''} onChange={e=>updateEquipment(eq.id,{location:e.target.value})} placeholder="Optional"
                                style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 10px",color:T.text,fontSize:13}}/>
                            </div>
                          </div>
                          <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                            <button onClick={()=>deleteEquipment(eq.id)} style={{background:"transparent",border:`1px solid ${T.red}`,borderRadius:6,padding:"6px 12px",color:T.red,fontSize:11,cursor:"pointer"}}>Delete</button>
                            <button onClick={()=>setEditingEquipment(null)} style={{background:T.blue,border:"none",borderRadius:6,padding:"6px 16px",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer"}}>Done</button>
                          </div>
                        </div>
                      ) : (
                        <div style={{display:"flex",alignItems:"center",gap:12}}>
                          <div style={{width:36,height:36,borderRadius:8,background:`${cat.color}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{cat.icon}</div>
                          <div style={{flex:1}}>
                            <div style={{fontSize:14,fontWeight:700,color:T.text}}>{eq.name}</div>
                            <div style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>{cat.name}{eq.location ? ` · ${eq.location}` : ''}</div>
                          </div>
                          {eq.serialNumber && <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>S/N: {eq.serialNumber}</span>}
                          <button onClick={()=>setEditingEquipment(eq.id)} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 12px",color:T.textMuted,fontSize:11,cursor:"pointer"}}>Edit</button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </Card>
        </div>
      )}

      {/* ══ CATEGORIES ══ */}
      {sub==="categories"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{fontSize:12,color:T.textMuted}}>{settings.equipmentCategories.length} categories</div>
            <button onClick={addCategory}
              style={{background:T.blue,border:"none",borderRadius:8,padding:"8px 16px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",display:"flex",alignItems:"center",gap:6}}>
              + Add Category
            </button>
          </div>

          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:12}}>
            {settings.equipmentCategories.map(cat => {
              const isEditing = editingCategory === cat.id;
              const eqCount = settings.equipment.filter(e => e.categoryId === cat.id).length;
              return(
                <Card key={cat.id} style={{padding:isEditing?16:14,borderLeft:`4px solid ${cat.color}`}}>
                  {isEditing ? (
                    <div style={{display:"flex",flexDirection:"column",gap:12}}>
                      <div>
                        <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:4}}>NAME</label>
                        <input value={cat.name} onChange={e=>updateCategory(cat.id,{name:e.target.value})}
                          style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 10px",color:T.text,fontSize:13}}/>
                      </div>
                      <div>
                        <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:4}}>ICON</label>
                        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                          {ICONS.map(icon=>(
                            <button key={icon} onClick={()=>updateCategory(cat.id,{icon})}
                              style={{width:32,height:32,borderRadius:6,border:cat.icon===icon?`2px solid ${T.blue}`:`1px solid ${T.border}`,background:cat.icon===icon?T.blueDark:"transparent",cursor:"pointer",fontSize:16}}>
                              {icon}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div>
                        <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:4}}>COLOR</label>
                        <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
                          {['#EF4444','#F97316','#F59E0B','#84CC16','#10B981','#06B6D4','#3B82F6','#8B5CF6','#EC4899','#64748B'].map(c=>(
                            <button key={c} onClick={()=>updateCategory(cat.id,{color:c})}
                              style={{width:28,height:28,borderRadius:6,background:c,border:cat.color===c?`2px solid #fff`:'none',cursor:"pointer",boxShadow:cat.color===c?'0 0 0 2px #3B82F6':'none'}}/>
                          ))}
                        </div>
                      </div>
                      <div style={{display:"flex",justifyContent:"space-between",marginTop:4}}>
                        <button onClick={()=>deleteCategory(cat.id)} style={{background:"transparent",border:`1px solid ${T.red}`,borderRadius:6,padding:"6px 12px",color:T.red,fontSize:11,cursor:"pointer"}}>Delete</button>
                        <button onClick={()=>setEditingCategory(null)} style={{background:T.blue,border:"none",borderRadius:6,padding:"6px 16px",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer"}}>Done</button>
                      </div>
                    </div>
                  ) : (
                    <div style={{display:"flex",alignItems:"center",gap:12}}>
                      <div style={{width:44,height:44,borderRadius:10,background:`${cat.color}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:22}}>{cat.icon}</div>
                      <div style={{flex:1}}>
                        <div style={{fontSize:15,fontWeight:700,color:T.text}}>{cat.name}</div>
                        <div style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>{eqCount} equipment</div>
                      </div>
                      <button onClick={()=>setEditingCategory(cat.id)} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 12px",color:T.textMuted,fontSize:11,cursor:"pointer"}}>Edit</button>
                    </div>
                  )}
                </Card>
              );
            })}
          </div>
        </div>
      )}

      {/* ══ SERVER SETTINGS ══ */}
      {sub==="server"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <SectionHeader>Server Connection</SectionHeader>
            <div style={{display:"flex",flexDirection:"column",gap:16}}>
              <div>
                <label style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:6}}>OVEN/MAINTENANCE SERVER URL</label>
                <div style={{display:"flex",gap:8}}>
                  <input value={settings.serverUrl||''} onChange={e=>setSettings(prev=>({...prev,serverUrl:e.target.value}))}
                    placeholder="http://localhost:3002"
                    style={{flex:1,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 12px",color:T.text,fontSize:13,fontFamily:mono}}/>
                  <button onClick={testServerConnection} disabled={testingServer}
                    style={{background:T.blue,border:"none",borderRadius:8,padding:"10px 16px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",opacity:testingServer?0.7:1}}>
                    {testingServer ? "Testing..." : "Test"}
                  </button>
                </div>
                {serverStatus && (
                  <div style={{marginTop:8,display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:serverStatus.ok?T.green:T.red}}/>
                    <span style={{fontSize:11,color:serverStatus.ok?T.green:T.red,fontFamily:mono}}>{serverStatus.message}</span>
                  </div>
                )}
              </div>

              <div>
                <label style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:6}}>MCP GATEWAY URL</label>
                <div style={{display:"flex",gap:8}}>
                  <input value={settings.gatewayUrl||''} onChange={e=>setSettings(prev=>({...prev,gatewayUrl:e.target.value}))}
                    placeholder="http://localhost:3001"
                    style={{flex:1,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 12px",color:T.text,fontSize:13,fontFamily:mono}}/>
                  <button onClick={testGatewayConnection} disabled={testingGateway}
                    style={{background:T.purple,border:"none",borderRadius:8,padding:"10px 16px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",opacity:testingGateway?0.7:1}}>
                    {testingGateway ? "Testing..." : "Test"}
                  </button>
                </div>
                {gatewayStatus && (
                  <div style={{marginTop:8,display:"flex",alignItems:"center",gap:6}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:gatewayStatus.ok?T.green:T.red}}/>
                    <span style={{fontSize:11,color:gatewayStatus.ok?T.green:T.red,fontFamily:mono}}>{gatewayStatus.message}</span>
                  </div>
                )}
                <div style={{fontSize:10,color:T.textDim,marginTop:4}}>AI gateway for Claude agents and MCP tools</div>
              </div>

              <div>
                <label style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1,display:"block",marginBottom:6}}>SLACK WEBHOOK URL</label>
                <input value={settings.slackWebhook||''} onChange={e=>setSettings(prev=>({...prev,slackWebhook:e.target.value}))}
                  placeholder="https://hooks.slack.com/services/..."
                  style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 12px",color:T.text,fontSize:13,fontFamily:mono}}/>
                <div style={{fontSize:10,color:T.textDim,marginTop:4}}>Used for sending alerts to Slack</div>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHeader>Connection Status</SectionHeader>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12}}>
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:serverStatus?.ok?T.green:T.textDim}}/>
                  <span style={{fontSize:12,fontWeight:700,color:T.text}}>Oven Server</span>
                </div>
                <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>{settings.serverUrl || 'Not configured'}</div>
              </div>
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:gatewayStatus?.ok?T.green:T.textDim}}/>
                  <span style={{fontSize:12,fontWeight:700,color:T.text}}>MCP Gateway</span>
                </div>
                <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>{settings.gatewayUrl || 'http://localhost:3001'}</div>
                {gatewayStatus?.uptime && <div style={{fontSize:9,color:T.textDim,marginTop:4}}>Uptime: {Math.round(gatewayStatus.uptime/60)}m</div>}
              </div>
              <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                  <div style={{width:10,height:10,borderRadius:"50%",background:settings.slackWebhook?T.green:T.textDim}}/>
                  <span style={{fontSize:12,fontWeight:700,color:T.text}}>Slack</span>
                </div>
                <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>{settings.slackWebhook ? 'Configured' : 'Not configured'}</div>
              </div>
            </div>
          </Card>
        </div>
      )}

      {/* ══ GATEWAY ══ */}
      {sub==="gateway"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          {/* Load data on mount */}
          {!gatewayData && !loadingGateway && (
            <div style={{textAlign:"center",padding:40}}>
              <button onClick={loadGatewayData} style={{background:T.purple,border:"none",borderRadius:10,padding:"14px 28px",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>
                Load Gateway Dashboard
              </button>
            </div>
          )}

          {loadingGateway && (
            <div style={{textAlign:"center",padding:40,color:T.textMuted}}>Loading gateway data...</div>
          )}

          {gatewayData && (
            <>
              {/* Stats Overview */}
              <Card>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                  <SectionHeader style={{margin:0}}>Gateway Statistics</SectionHeader>
                  <div style={{display:"flex",gap:6}}>
                    {['1h','24h','7d'].map(p=>(
                      <button key={p} onClick={()=>{setStatsPeriod(p);loadGatewayData();}}
                        style={{background:statsPeriod===p?T.purple:'transparent',border:`1px solid ${statsPeriod===p?T.purple:T.border}`,borderRadius:6,padding:"5px 12px",color:statsPeriod===p?'#fff':T.textMuted,fontSize:11,fontWeight:600,cursor:"pointer"}}>{p}</button>
                    ))}
                    <button onClick={loadGatewayData} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 12px",color:T.textMuted,fontSize:11,cursor:"pointer"}}>↻ Refresh</button>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12}}>
                  <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                    <div style={{fontSize:24,fontWeight:800,color:T.blue}}>{gatewayData.stats?.total||0}</div>
                    <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>TOTAL REQUESTS</div>
                  </div>
                  <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                    <div style={{fontSize:24,fontWeight:800,color:T.green}}>{Math.round(gatewayData.stats?.avg_duration_ms||0)}ms</div>
                    <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>AVG DURATION</div>
                  </div>
                  <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                    <div style={{fontSize:24,fontWeight:800,color:gatewayData.circuit?.is_open?T.red:T.green}}>{gatewayData.circuit?.is_open?'OPEN':'CLOSED'}</div>
                    <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>CIRCUIT BREAKER</div>
                  </div>
                  <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"14px 16px"}}>
                    <div style={{fontSize:24,fontWeight:800,color:T.amber}}>{Object.keys(gatewayData.concurrent||{}).length}</div>
                    <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>ACTIVE AGENTS</div>
                  </div>
                </div>
              </Card>

              {/* Stats Breakdown */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12}}>
                <Card>
                  <SectionHeader>By Source</SectionHeader>
                  {Object.entries(gatewayData.stats?.by_source||{}).map(([src,cnt])=>(
                    <div key={src} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
                      <span style={{fontSize:12,color:T.text,textTransform:"capitalize"}}>{src}</span>
                      <span style={{fontSize:12,fontWeight:700,color:T.blue,fontFamily:mono}}>{cnt}</span>
                    </div>
                  ))}
                  {!Object.keys(gatewayData.stats?.by_source||{}).length && <div style={{fontSize:12,color:T.textDim}}>No requests</div>}
                </Card>
                <Card>
                  <SectionHeader>By Agent</SectionHeader>
                  {Object.entries(gatewayData.stats?.by_agent||{}).map(([agent,cnt])=>(
                    <div key={agent} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
                      <span style={{fontSize:11,color:T.text}}>{agent.replace('Agent','')}</span>
                      <span style={{fontSize:12,fontWeight:700,color:T.purple,fontFamily:mono}}>{cnt}</span>
                    </div>
                  ))}
                  {!Object.keys(gatewayData.stats?.by_agent||{}).length && <div style={{fontSize:12,color:T.textDim}}>No requests</div>}
                </Card>
                <Card>
                  <SectionHeader>By Status</SectionHeader>
                  {Object.entries(gatewayData.stats?.by_status||{}).map(([status,cnt])=>(
                    <div key={status} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:`1px solid ${T.border}`}}>
                      <span style={{fontSize:12,color:status==='success'?T.green:status==='error'?T.red:T.amber}}>{status}</span>
                      <span style={{fontSize:12,fontWeight:700,fontFamily:mono,color:status==='success'?T.green:status==='error'?T.red:T.amber}}>{cnt}</span>
                    </div>
                  ))}
                  {!Object.keys(gatewayData.stats?.by_status||{}).length && <div style={{fontSize:12,color:T.textDim}}>No requests</div>}
                </Card>
              </div>

              {/* Rate Limits */}
              <Card>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                  <SectionHeader style={{margin:0}}>Rate Limits</SectionHeader>
                  {!editingLimits ? (
                    <button onClick={()=>{setLimitsForm(gatewayData.limits);setEditingLimits(true);}} style={{background:T.blue,border:"none",borderRadius:6,padding:"6px 14px",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer"}}>Edit Limits</button>
                  ) : (
                    <div style={{display:"flex",gap:8}}>
                      <button onClick={()=>setEditingLimits(false)} style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 14px",color:T.textMuted,fontSize:11,cursor:"pointer"}}>Cancel</button>
                      <button onClick={saveLimits} style={{background:T.green,border:"none",borderRadius:6,padding:"6px 14px",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer"}}>Save</button>
                    </div>
                  )}
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16}}>
                  {['slack','web','rest'].map(src=>{
                    const limits = editingLimits ? limitsForm?.[src] : gatewayData.limits?.[src];
                    const perKey = src==='rest' ? 'perApiKey' : 'perUser';
                    return(
                      <div key={src} style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:14}}>
                        <div style={{fontSize:12,fontWeight:700,color:T.text,textTransform:"uppercase",marginBottom:12}}>{src}</div>
                        <div style={{display:"flex",flexDirection:"column",gap:10}}>
                          <div>
                            <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1}}>PER {src==='rest'?'API KEY':'USER'} (req/min)</label>
                            {editingLimits ? (
                              <input type="number" value={limits?.[perKey]?.requests||0}
                                onChange={e=>setLimitsForm(prev=>({...prev,[src]:{...prev[src],[perKey]:{...prev[src]?.[perKey],requests:parseInt(e.target.value)||0}}}))}
                                style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 10px",color:T.text,fontSize:13,fontFamily:mono,marginTop:4}}/>
                            ) : (
                              <div style={{fontSize:16,fontWeight:700,color:T.blue}}>{limits?.[perKey]?.requests||0}</div>
                            )}
                          </div>
                          <div>
                            <label style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1}}>GLOBAL (req/min)</label>
                            {editingLimits ? (
                              <input type="number" value={limits?.global?.requests||0}
                                onChange={e=>setLimitsForm(prev=>({...prev,[src]:{...prev[src],global:{...prev[src]?.global,requests:parseInt(e.target.value)||0}}}))}
                                style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"6px 10px",color:T.text,fontSize:13,fontFamily:mono,marginTop:4}}/>
                            ) : (
                              <div style={{fontSize:16,fontWeight:700,color:T.purple}}>{limits?.global?.requests||0}</div>
                            )}
                          </div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </Card>

              {/* Recent Requests */}
              <Card>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
                  <SectionHeader style={{margin:0}}>Recent Requests</SectionHeader>
                  <div style={{display:"flex",gap:8}}>
                    <select value={requestFilter.source} onChange={e=>setRequestFilter(prev=>({...prev,source:e.target.value}))}
                      style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 10px",color:T.text,fontSize:11}}>
                      <option value="all">All Sources</option>
                      <option value="web">Web</option>
                      <option value="slack">Slack</option>
                      <option value="rest">REST</option>
                    </select>
                    <select value={requestFilter.status} onChange={e=>setRequestFilter(prev=>({...prev,status:e.target.value}))}
                      style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 10px",color:T.text,fontSize:11}}>
                      <option value="all">All Status</option>
                      <option value="success">Success</option>
                      <option value="error">Error</option>
                      <option value="rate_limited">Rate Limited</option>
                    </select>
                  </div>
                </div>
                <div style={{maxHeight:300,overflowY:"auto"}}>
                  {gatewayRequests
                    .filter(r=>(requestFilter.source==='all'||r.source===requestFilter.source)&&(requestFilter.status==='all'||r.status===requestFilter.status))
                    .slice(0,50)
                    .map((req,i)=>(
                    <div key={req.id||i} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",borderBottom:`1px solid ${T.border}`,background:i%2===0?'transparent':T.bg}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:req.status==='success'?T.green:req.status==='error'?T.red:T.amber}}/>
                      <div style={{width:50,fontSize:10,color:T.textMuted,fontFamily:mono,textTransform:"uppercase"}}>{req.source}</div>
                      <div style={{width:120,fontSize:11,color:T.purple,fontFamily:mono}}>{req.agent_name?.replace('Agent','')}</div>
                      <div style={{flex:1,fontSize:11,color:T.text,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{req.input_text?.slice(0,60)}</div>
                      <div style={{width:60,fontSize:10,color:T.textDim,fontFamily:mono,textAlign:"right"}}>{req.duration_ms?`${req.duration_ms}ms`:'-'}</div>
                      <div style={{width:70,fontSize:9,color:T.textDim,fontFamily:mono}}>{new Date(req.created_at).toLocaleTimeString()}</div>
                    </div>
                  ))}
                  {!gatewayRequests.length && <div style={{padding:20,textAlign:"center",color:T.textDim}}>No requests recorded</div>}
                </div>
              </Card>
            </>
          )}
        </div>
      )}

      {/* ══ AI ══ */}
      {sub==="ai"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <SectionHeader>Claude AI Configuration</SectionHeader>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:13,color:T.textMuted,marginBottom:12}}>
                Enter your Anthropic API key to enable AI features. You can get an API key from{' '}
                <a href="https://console.anthropic.com/settings/keys" target="_blank" rel="noopener noreferrer" style={{color:T.blue}}>console.anthropic.com</a>
              </div>
              <div style={{marginBottom:16}}>
                <label style={{fontSize:10,color:T.textDim,fontFamily:mono,display:"block",marginBottom:6,letterSpacing:1}}>ANTHROPIC API KEY</label>
                <input
                  type="password"
                  value={settings.anthropicApiKey||""}
                  onChange={e=>setSettings(prev=>({...prev,anthropicApiKey:e.target.value}))}
                  placeholder="sk-ant-api03-..."
                  style={{width:"100%",maxWidth:500,background:T.bg,border:`1px solid ${T.border}`,borderRadius:8,padding:"12px 14px",color:T.text,fontSize:13,fontFamily:mono,outline:"none",boxSizing:"border-box"}}
                />
              </div>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:10,height:10,borderRadius:"50%",background:settings.anthropicApiKey?T.green:T.textDim}}/>
                <span style={{fontSize:12,color:settings.anthropicApiKey?T.green:T.textMuted,fontFamily:mono}}>
                  {settings.anthropicApiKey?"API Key configured":"No API key set — AI features will not work"}
                </span>
              </div>
            </div>
          </Card>
          <Card>
            <SectionHeader>AI Features</SectionHeader>
            <div style={{fontSize:13,color:T.textMuted}}>
              <p style={{marginBottom:8}}>When configured, AI is available in:</p>
              <ul style={{margin:0,paddingLeft:20,lineHeight:1.8}}>
                <li><strong>AI Assistant tab</strong> — Full chat with pre-loaded report prompts</li>
                <li><strong>Production tabs</strong> — Embedded specialists in Surfacing, Cutting, Coating, Assembly, Shipping</li>
                <li><strong>Support tabs</strong> — Embedded specialists in Inventory and Maintenance</li>
              </ul>
            </div>
          </Card>
        </div>
      )}

      {/* ══ SECURITY ══ */}
      {sub==="security"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <Card>
            <SectionHeader>PIN Protection</SectionHeader>
            <div style={{marginBottom:16}}>
              <div style={{fontSize:13,color:T.textMuted,marginBottom:12}}>
                {settings.pinEnabled
                  ? "Settings are protected with a PIN. You'll need to enter the PIN when accessing Settings."
                  : "No PIN set. Anyone can access and modify settings."}
              </div>

              {isLockedOut ? (
                <div style={{background:`${T.red}15`,border:`1px solid ${T.red}`,borderRadius:10,padding:"16px 20px",textAlign:"center"}}>
                  <div style={{fontSize:13,color:T.red,fontWeight:700}}>Locked Out</div>
                  <div style={{fontSize:11,color:T.textMuted,marginTop:4}}>Too many incorrect attempts. Try again in {lockoutRemaining} seconds.</div>
                </div>
              ) : pinMode ? (
                <div style={{background:T.bg,border:`1px solid ${T.border}`,borderRadius:10,padding:"20px 24px",maxWidth:300}}>
                  <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:12}}>
                    {pinMode === 'set' ? 'Set New PIN' : pinMode === 'change' ? 'Enter New PIN' : 'Enter Current PIN'}
                  </div>
                  <div style={{display:"flex",gap:8,marginBottom:12}}>
                    <input
                      type="password"
                      inputMode="numeric"
                      pattern="[0-9]*"
                      maxLength={6}
                      value={pinInput}
                      onChange={e=>setPinInput(e.target.value.replace(/\D/g,''))}
                      onKeyDown={e=>e.key==='Enter'&&handlePinSubmit()}
                      placeholder="4-6 digits"
                      style={{flex:1,background:T.surface,border:`1px solid ${pinError?T.red:T.border}`,borderRadius:8,padding:"12px 14px",color:T.text,fontSize:18,fontFamily:mono,textAlign:"center",letterSpacing:8}}
                    />
                  </div>
                  {pinError && <div style={{fontSize:11,color:T.red,marginBottom:8}}>{pinError}</div>}
                  <div style={{display:"flex",gap:8}}>
                    <button onClick={()=>{setPinMode(null);setPinInput("");setPinError("");}}
                      style={{flex:1,background:"transparent",border:`1px solid ${T.border}`,borderRadius:6,padding:"8px",color:T.textMuted,fontSize:12,cursor:"pointer"}}>Cancel</button>
                    <button onClick={handlePinSubmit} disabled={pinInput.length<4}
                      style={{flex:1,background:T.blue,border:"none",borderRadius:6,padding:"8px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",opacity:pinInput.length<4?0.5:1}}>
                      {pinMode === 'verify' ? 'Unlock' : 'Set PIN'}
                    </button>
                  </div>
                </div>
              ) : (
                <div style={{display:"flex",gap:10}}>
                  {settings.pinEnabled ? (
                    <>
                      <button onClick={()=>setPinMode('change')} style={{background:T.blue,border:"none",borderRadius:8,padding:"10px 20px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>Change PIN</button>
                      <button onClick={disablePin} style={{background:"transparent",border:`1px solid ${T.red}`,borderRadius:8,padding:"10px 20px",color:T.red,fontSize:12,fontWeight:700,cursor:"pointer"}}>Disable PIN</button>
                    </>
                  ) : (
                    <button onClick={()=>setPinMode('set')} style={{background:T.blue,border:"none",borderRadius:8,padding:"10px 20px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer"}}>Set PIN</button>
                  )}
                </div>
              )}
            </div>

            <div style={{borderTop:`1px solid ${T.border}`,paddingTop:16}}>
              <div style={{display:"flex",alignItems:"center",gap:12}}>
                <div style={{width:40,height:40,borderRadius:10,background:settings.pinEnabled?`${T.green}20`:`${T.textDim}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>
                  {settings.pinEnabled ? '🔒' : '🔓'}
                </div>
                <div>
                  <div style={{fontSize:13,fontWeight:700,color:T.text}}>Status: {settings.pinEnabled ? 'Protected' : 'Unprotected'}</div>
                  <div style={{fontSize:11,color:T.textMuted}}>{settings.pinEnabled ? `PIN: ${'•'.repeat(settings.pin?.length || 4)}` : 'No PIN configured'}</div>
                </div>
              </div>
            </div>
          </Card>

          <Card>
            <SectionHeader>Data Management</SectionHeader>
            <div style={{display:"flex",gap:10}}>
              <button onClick={()=>{
                if(confirm('Reset all settings to defaults? This cannot be undone.')){
                  setSettings(DEFAULT_SETTINGS);
                }
              }} style={{background:"transparent",border:`1px solid ${T.amber}`,borderRadius:8,padding:"10px 16px",color:T.amber,fontSize:12,fontWeight:700,cursor:"pointer"}}>
                Reset to Defaults
              </button>
              <button onClick={()=>{
                const data = JSON.stringify(settings, null, 2);
                const blob = new Blob([data], { type: 'application/json' });
                const a = document.createElement('a');
                a.href = URL.createObjectURL(blob);
                a.download = `lab-assistant-settings-${new Date().toISOString().slice(0,10)}.json`;
                a.click();
              }} style={{background:"transparent",border:`1px solid ${T.blue}`,borderRadius:8,padding:"10px 16px",color:T.blue,fontSize:12,fontWeight:700,cursor:"pointer"}}>
                Export Settings
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

// ── INVENTORY TAB ─────────────────────────────────────────────────────────────
function InventoryTab({ovenServerUrl,settings}){
  const mono="'JetBrains Mono',monospace";
  const [sub,setSub]=useState("inventory");
  const [inventory,setInventory]=useState({materials:[],lastSync:null,status:'pending',alertCount:0,warehouses:[],warehouseStats:{},vlmStats:{}});
  const [picks,setPicks]=useState({picks:[],recent:[],count:0,byWarehouse:{}});
  const [alerts,setAlerts]=useState({alerts:[],critical:0,high:0,low:0});
  const [vlms,setVlms]=useState({vlmStats:{},locations:[]});
  const [loading,setLoading]=useState(true);
  const [searchQuery,setSearchQuery]=useState("");
  const [filterCoating,setFilterCoating]=useState("All");
  const [sortCol,setSortCol]=useState("qty");
  const [sortDir,setSortDir]=useState("asc");

  // Fetch all inventory data
  useEffect(()=>{
    if(!ovenServerUrl)return;
    const go=async()=>{
      try{
        const [invResp,picksResp,alertsResp,vlmsResp]=await Promise.all([
          fetch(`${ovenServerUrl}/api/inventory`).then(r=>r.json()),
          fetch(`${ovenServerUrl}/api/inventory/picks`).then(r=>r.json()),
          fetch(`${ovenServerUrl}/api/inventory/alerts`).then(r=>r.json()),
          fetch(`${ovenServerUrl}/api/inventory/vlms`).then(r=>r.json()),
        ]);
        setInventory(invResp);
        setPicks(picksResp);
        setAlerts(alertsResp);
        setVlms(vlmsResp);
        setLoading(false);
      }catch(e){
        console.error('[Inventory] Fetch error:',e);
        setLoading(false);
      }
    };
    go();
    const iv=setInterval(go,30000);
    return()=>clearInterval(iv);
  },[ovenServerUrl]);

  // Filter and sort materials
  const filteredMaterials=useMemo(()=>{
    let items=[...(inventory.materials||[])];
    if(searchQuery){
      const q=searchQuery.toLowerCase();
      items=items.filter(m=>
        m.sku?.toLowerCase().includes(q)||
        m.name?.toLowerCase().includes(q)||
        m.coatingType?.toLowerCase().includes(q)||
        m.location?.toLowerCase().includes(q)
      );
    }
    if(filterCoating!=="All"){
      items=items.filter(m=>m.coatingType===filterCoating);
    }
    items.sort((a,b)=>{
      const av=a[sortCol],bv=b[sortCol];
      if(typeof av==="number"&&typeof bv==="number")return sortDir==="asc"?av-bv:bv-av;
      return sortDir==="asc"?String(av||"").localeCompare(String(bv||"")):String(bv||"").localeCompare(String(av||""));
    });
    return items;
  },[inventory.materials,searchQuery,filterCoating,sortCol,sortDir]);

  // Get unique coating types for filter
  const coatingTypes=useMemo(()=>{
    const types=new Set((inventory.materials||[]).map(m=>m.coatingType).filter(Boolean));
    return ["All",...Array.from(types).sort()];
  },[inventory.materials]);

  // Stats
  const totalSKUs=(inventory.materials||[]).length;
  const totalQty=(inventory.materials||[]).reduce((s,m)=>s+(m.qty||0),0);
  const outOfStock=(inventory.materials||[]).filter(m=>m.qty===0).length;
  const lowStock=alerts.critical+alerts.high;

  const toggleSort=col=>{if(sortCol===col)setSortDir(d=>d==="asc"?"desc":"asc");else{setSortCol(col);setSortDir("asc");}};

  const SHdr=({col,children,align="left"})=>(
    <th onClick={()=>toggleSort(col)} style={{fontFamily:mono,fontSize:9,color:sortCol===col?T.amber:T.textDim,letterSpacing:1.5,
      textAlign:align,padding:"9px 12px",borderBottom:`2px solid ${T.border}`,textTransform:"uppercase",whiteSpace:"nowrap",cursor:"pointer",userSelect:"none"}}>
      {children}{sortCol===col?<span style={{marginLeft:3}}>{sortDir==="asc"?"▲":"▼"}</span>:null}
    </th>
  );

  const SubNav=()=>(
    <div style={{display:"flex",gap:4,marginBottom:20}}>
      {[{id:"inventory",label:"📦 Inventory"},{id:"warehouses",label:"🏭 Warehouses"},{id:"picks",label:"📋 Picks"},{id:"alerts",label:"⚠️ Alerts"},{id:"search",label:"🔍 Lens Search"}].map(t=>(
        <button key={t.id} onClick={()=>setSub(t.id)} style={{background:sub===t.id?T.blueDark:"transparent",border:`1px solid ${sub===t.id?T.blue:T.border}`,
          borderRadius:6,padding:"8px 16px",color:sub===t.id?T.blue:T.textMuted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:mono}}>
          {t.label}
          {t.id==="alerts"&&alerts.critical>0?<span style={{marginLeft:6,background:T.red,color:"#fff",borderRadius:10,padding:"2px 6px",fontSize:9}}>{alerts.critical}</span>:null}
          {t.id==="picks"&&picks.count>0?<span style={{marginLeft:6,background:T.amber,color:"#000",borderRadius:10,padding:"2px 6px",fontSize:9}}>{picks.count}</span>:null}
        </button>
      ))}
    </div>
  );

  const contextData={
    totalSKUs,totalQty,outOfStock,lowStock,
    criticalAlerts:alerts.critical,highAlerts:alerts.high,
    activePicks:picks.count,
    status:inventory.status,
    warehouses:inventory.warehouses,
    warehouseStats:inventory.warehouseStats,
    vlmStats:vlms.vlmStats,
    picksByWarehouse:picks.byWarehouse
  };

  if(loading){
    return(<div style={{padding:32,textAlign:"center",color:T.textMuted,fontFamily:mono}}>Loading inventory data...</div>);
  }

  return(
    <ProductionStageTab domain="inventory" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
    <div>
      <SubNav/>

      {sub==="inventory"&&(
        <div>
          {/* Summary cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:16,marginBottom:24}}>
            <Card style={{padding:16,textAlign:"center"}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>TOTAL SKUS</div>
              <div style={{fontSize:28,fontWeight:800,color:T.text,fontFamily:mono}}>{totalSKUs.toLocaleString()}</div>
            </Card>
            <Card style={{padding:16,textAlign:"center"}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>TOTAL QTY</div>
              <div style={{fontSize:28,fontWeight:800,color:T.blue,fontFamily:mono}}>{totalQty.toLocaleString()}</div>
            </Card>
            <Card style={{padding:16,textAlign:"center"}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>OUT OF STOCK</div>
              <div style={{fontSize:28,fontWeight:800,color:outOfStock>0?T.red:T.green,fontFamily:mono}}>{outOfStock}</div>
            </Card>
            <Card style={{padding:16,textAlign:"center"}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>LOW STOCK</div>
              <div style={{fontSize:28,fontWeight:800,color:lowStock>0?T.amber:T.green,fontFamily:mono}}>{lowStock}</div>
            </Card>
          </div>

          {/* Filters */}
          <div style={{display:"flex",gap:12,marginBottom:16,alignItems:"center"}}>
            <input type="text" placeholder="Search SKU, name, location..." value={searchQuery} onChange={e=>setSearchQuery(e.target.value)}
              style={{flex:1,maxWidth:300,padding:"8px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,fontSize:12,fontFamily:mono}}/>
            <select value={filterCoating} onChange={e=>setFilterCoating(e.target.value)}
              style={{padding:"8px 12px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,fontSize:12,fontFamily:mono}}>
              {coatingTypes.map(c=><option key={c} value={c}>{c}</option>)}
            </select>
            <div style={{fontSize:11,color:T.textDim,fontFamily:mono}}>
              {filteredMaterials.length} of {totalSKUs} SKUs
            </div>
          </div>

          {/* Inventory table */}
          <Card style={{overflow:"auto"}}>
            <table style={{width:"100%",borderCollapse:"collapse"}}>
              <thead>
                <tr style={{background:T.bg}}>
                  <SHdr col="sku">SKU</SHdr>
                  <SHdr col="name">Description</SHdr>
                  <SHdr col="coatingType">Type</SHdr>
                  <SHdr col="qty" align="right">Qty</SHdr>
                  <SHdr col="location">Location</SHdr>
                  <SHdr col="index">Index</SHdr>
                </tr>
              </thead>
              <tbody>
                {filteredMaterials.slice(0,100).map(m=>{
                  const isLow=m.qty<=(m.reorderPoint||10);
                  const isOut=m.qty===0;
                  return(
                    <tr key={m.id||m.sku} style={{borderBottom:`1px solid ${T.border}`,background:isOut?`${T.red}08`:isLow?`${T.amber}08`:"transparent"}}>
                      <td style={{padding:"10px 12px",fontFamily:mono,fontSize:11,color:T.text,fontWeight:600}}>{m.sku}</td>
                      <td style={{padding:"10px 12px",fontSize:12,color:T.textMuted,maxWidth:300,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{m.name}</td>
                      <td style={{padding:"10px 12px"}}>
                        {m.coatingType&&<Pill color={T.blue} bg={`${T.blue}15`}>{m.coatingType}</Pill>}
                      </td>
                      <td style={{padding:"10px 12px",fontFamily:mono,fontSize:13,fontWeight:700,textAlign:"right",
                        color:isOut?T.red:isLow?T.amber:T.green}}>
                        {m.qty}
                      </td>
                      <td style={{padding:"10px 12px",fontFamily:mono,fontSize:11,color:T.textDim}}>{m.location||"—"}</td>
                      <td style={{padding:"10px 12px",fontFamily:mono,fontSize:11,color:T.textMuted}}>{m.index||"—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {filteredMaterials.length>100&&(
              <div style={{padding:12,textAlign:"center",color:T.textDim,fontSize:11,fontFamily:mono}}>
                Showing 100 of {filteredMaterials.length} items. Refine your search to see more.
              </div>
            )}
          </Card>
        </div>
      )}

      {sub==="warehouses"&&(
        <div>
          {/* Hourly Picks Chart - Bold totals at top */}
          <Card style={{marginBottom:24,padding:20}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
              <div style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:mono}}>TODAY'S PICKS BY HOUR</div>
              <div style={{display:"flex",gap:24}}>
                {['WH1','WH2'].map(wh=>{
                  const total=Object.values(inventory.hourlyStats?.[wh]||{}).reduce((s,v)=>s+v,0);
                  const color=wh==='WH1'?T.blue:T.green;
                  return(
                    <div key={wh} style={{display:"flex",alignItems:"center",gap:8}}>
                      <div style={{width:12,height:12,borderRadius:3,background:color}}/>
                      <span style={{fontFamily:mono,fontSize:12,color:T.textMuted}}>{wh}:</span>
                      <span style={{fontFamily:mono,fontSize:20,fontWeight:900,color:color}}>{total}</span>
                    </div>
                  );
                })}
              </div>
            </div>
            {/* Horizontal bar chart */}
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {['WH1','WH2'].map(wh=>{
                const hourData=inventory.hourlyStats?.[wh]||{};
                const maxVal=Math.max(1,...Object.values(hourData));
                const color=wh==='WH1'?T.blue:T.green;
                const currentHour=new Date().getHours();
                return(
                  <div key={wh}>
                    <div style={{fontFamily:mono,fontSize:11,fontWeight:700,color:color,marginBottom:4}}>{wh}</div>
                    <div style={{display:"flex",gap:2,alignItems:"flex-end",height:50,paddingTop:16}}>
                      {Array.from({length:24},(_, h)=>{
                        const val=hourData[h]||hourData[String(h)]||0;
                        const barHeight=val>0?Math.max(6,Math.round((val/maxVal)*34)):2;
                        const isNow=h===currentHour;
                        return(
                          <div key={h} style={{flex:1,position:"relative"}}>
                            {val>0&&<div style={{position:"absolute",bottom:barHeight+2,left:"50%",transform:"translateX(-50%)",fontSize:9,fontWeight:700,color:color,fontFamily:mono,whiteSpace:"nowrap"}}>{val}</div>}
                            <div style={{
                              width:"100%",
                              height:barHeight,
                              background:val>0?color:`${color}30`,
                              borderRadius:2,
                              border:isNow?`2px solid ${T.amber}`:'none'
                            }}/>
                          </div>
                        );
                      })}
                    </div>
                    <div style={{display:"flex",gap:2,marginTop:2}}>
                      {Array.from({length:24},(_,h)=>(
                        <div key={h} style={{flex:1,textAlign:"center",fontSize:8,color:h===currentHour?T.amber:T.textDim,fontFamily:mono,fontWeight:h===currentHour?700:400}}>
                          {h%3===0?h:''}
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>

          {/* Warehouse breakdown */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginBottom:24}}>
            {(inventory.warehouses||[]).map(wh=>{
              const stats=inventory.warehouseStats?.[wh.name]||{activeOrders:0,untouchedOrders:0,totalLines:0,totalQty:0,todayPicks:0};
              return(
                <Card key={wh.id} style={{padding:20,borderLeft:`4px solid ${wh.name==='WH1'?T.blue:wh.name==='WH2'?T.green:T.amber}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{fontSize:20,fontWeight:800,color:T.text,fontFamily:mono}}>{wh.name}</div>
                    <div style={{fontSize:11,color:T.textDim,fontFamily:mono}}>{stats.todayPicks||0} picks today</div>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12}}>
                    <div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1}}>ACTIVE</div>
                      <div style={{fontSize:24,fontWeight:800,color:stats.activeOrders>0?T.amber:T.textDim,fontFamily:mono}}>{stats.activeOrders}</div>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1}}>QUEUED</div>
                      <div style={{fontSize:24,fontWeight:800,color:T.blue,fontFamily:mono}}>{stats.untouchedOrders}</div>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1}}>LINES</div>
                      <div style={{fontSize:18,fontWeight:700,color:T.textMuted,fontFamily:mono}}>{stats.totalLines}</div>
                    </div>
                    <div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1}}>UNITS</div>
                      <div style={{fontSize:18,fontWeight:700,color:T.textMuted,fontFamily:mono}}>{stats.totalQty}</div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>

          {/* Carousel Inventory Chart - matches ItemPath dashboard */}
          {inventory.carouselStats && Object.keys(inventory.carouselStats).length > 0 && (
            <Card style={{marginBottom:24,padding:20}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20}}>
                <div style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:mono}}>CAROUSEL INVENTORY</div>
                <div style={{fontSize:12,fontFamily:mono,color:T.textDim}}>
                  Total: <span style={{fontWeight:800,color:T.orange}}>{Object.values(inventory.carouselStats).reduce((s,v)=>s+v,0).toLocaleString()}</span>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"repeat(6,1fr)",gap:12}}>
                {['CAR-1','CAR-2','CAR-3','CAR-4','CAR-5','CAR-6'].map(car=>{
                  const qty=inventory.carouselStats[car]||0;
                  const maxQty=Math.max(...Object.values(inventory.carouselStats),1);
                  const pct=Math.round((qty/maxQty)*100);
                  return(
                    <div key={car} style={{textAlign:"center"}}>
                      <div style={{height:140,display:"flex",flexDirection:"column",justifyContent:"flex-end",alignItems:"center",marginBottom:8}}>
                        <div style={{
                          width:"70%",
                          height:`${Math.max(pct,5)}%`,
                          background:T.orange,
                          borderRadius:"4px 4px 0 0",
                          position:"relative",
                          display:"flex",
                          alignItems:"center",
                          justifyContent:"center"
                        }}>
                          <span style={{
                            fontSize:11,
                            fontWeight:800,
                            color:"#fff",
                            fontFamily:mono,
                            textShadow:"0 1px 2px rgba(0,0,0,0.3)"
                          }}>{qty.toLocaleString()}</span>
                        </div>
                      </div>
                      <div style={{fontSize:11,fontWeight:700,color:T.textMuted,fontFamily:mono}}>{car}</div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* VLM Inventory */}
          <Card style={{marginBottom:20}}>
            <SectionHeader right={`${Object.keys(vlms.vlmStats||{}).length} VLMs`}>VLM Inventory</SectionHeader>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:16}}>
              {Object.entries(vlms.vlmStats||{}).map(([vlm,stats])=>(
                <div key={vlm} style={{padding:16,background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <div style={{fontFamily:mono,fontSize:16,fontWeight:800,color:T.text}}>{vlm}</div>
                    <Pill color={T.cyan}>{stats.locationCount} bins</Pill>
                  </div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:22,fontWeight:800,color:T.blue,fontFamily:mono}}>{stats.totalQty?.toLocaleString()}</div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>TOTAL QTY</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:22,fontWeight:800,color:T.green,fontFamily:mono}}>{stats.filledLocations}</div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>FILLED</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:22,fontWeight:800,color:T.textDim,fontFamily:mono}}>{stats.locationCount-stats.filledLocations}</div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>EMPTY</div>
                    </div>
                  </div>
                  {/* Fill bar */}
                  <div style={{marginTop:12,height:6,background:T.border,borderRadius:3,overflow:"hidden"}}>
                    <div style={{height:"100%",width:`${Math.round((stats.filledLocations/stats.locationCount)*100)}%`,background:T.green,borderRadius:3}}/>
                  </div>
                  <div style={{marginTop:4,fontSize:10,color:T.textDim,textAlign:"right",fontFamily:mono}}>
                    {Math.round((stats.filledLocations/stats.locationCount)*100)}% utilized
                  </div>
                </div>
              ))}
            </div>
          </Card>

          {/* Active orders by warehouse */}
          <Card>
            <SectionHeader>Active Orders by Warehouse</SectionHeader>
            {Object.keys(picks.byWarehouse||{}).length>0?(
              <div style={{display:"flex",flexDirection:"column",gap:16}}>
                {Object.entries(picks.byWarehouse).map(([wh,orders])=>(
                  <div key={wh}>
                    <div style={{fontFamily:mono,fontSize:14,fontWeight:700,color:T.text,marginBottom:8,display:"flex",alignItems:"center",gap:8}}>
                      <span style={{width:12,height:12,borderRadius:3,background:wh==='WH1'?T.blue:wh==='WH2'?T.green:T.amber}}/>
                      {wh}
                      <span style={{fontSize:11,color:T.textDim,fontWeight:400}}>({orders.length} orders)</span>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(300px,1fr))",gap:8}}>
                      {orders.slice(0,6).map(p=>(
                        <div key={p.orderId} style={{padding:10,background:T.bg,borderRadius:6,border:`1px solid ${T.border}`}}>
                          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                            <span style={{fontFamily:mono,fontSize:11,fontWeight:600,color:T.text}}>{p.reference}</span>
                            <span style={{fontSize:10,color:T.amber,fontFamily:mono}}>{p.lines?.length||0} items</span>
                          </div>
                          <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>
                            {p.lines?.slice(0,2).map(l=>l.name).join(', ')}
                            {(p.lines?.length||0)>2?'...':''}
                          </div>
                        </div>
                      ))}
                      {orders.length>6&&(
                        <div style={{padding:10,textAlign:"center",color:T.textDim,fontSize:11,fontFamily:mono}}>
                          +{orders.length-6} more orders
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ):(
              <div style={{padding:20,textAlign:"center",color:T.textDim}}>No active orders</div>
            )}
          </Card>
        </div>
      )}

      {sub==="picks"&&(
        <div>
          {/* Active picks */}
          <Card style={{marginBottom:20}}>
            <SectionHeader right={`${picks.count} active`}>Active Pick Orders</SectionHeader>
            {picks.picks?.length>0?(
              <div style={{display:"flex",flexDirection:"column",gap:12}}>
                {picks.picks.map(p=>(
                  <div key={p.orderId} style={{padding:14,background:T.bg,borderRadius:8,border:`1px solid ${T.border}`}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                      <div>
                        <span style={{fontFamily:mono,fontSize:13,fontWeight:700,color:T.text}}>{p.reference}</span>
                        {p.warehouse&&<Pill style={{marginLeft:8}} color={p.warehouse==='WH1'?T.blue:p.warehouse==='WH2'?T.green:T.amber}>{p.warehouse}</Pill>}
                      </div>
                      <Pill color={p.status==="In Process"?T.amber:T.green}>{p.status}</Pill>
                    </div>
                    {p.lines?.map((l,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",fontSize:12}}>
                        <span style={{color:T.textMuted}}>{l.name} <span style={{fontFamily:mono,color:T.textDim}}>({l.sku})</span></span>
                        <span style={{fontFamily:mono,color:l.pending>0?T.amber:T.green}}>{l.picked}/{l.qty} picked</span>
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ):(
              <div style={{padding:20,textAlign:"center",color:T.textDim}}>No active pick orders</div>
            )}
          </Card>

          {/* Recent transactions */}
          <Card>
            <SectionHeader right={`Last 2 hours`}>Recent Picks</SectionHeader>
            {picks.recent?.length>0?(
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{background:T.bg}}>
                    <th style={{padding:"8px 12px",textAlign:"left",fontSize:10,color:T.textDim,fontFamily:mono}}>TIME</th>
                    <th style={{padding:"8px 12px",textAlign:"left",fontSize:10,color:T.textDim,fontFamily:mono}}>SKU</th>
                    <th style={{padding:"8px 12px",textAlign:"left",fontSize:10,color:T.textDim,fontFamily:mono}}>ITEM</th>
                    <th style={{padding:"8px 12px",textAlign:"right",fontSize:10,color:T.textDim,fontFamily:mono}}>QTY</th>
                    <th style={{padding:"8px 12px",textAlign:"left",fontSize:10,color:T.textDim,fontFamily:mono}}>PICKER</th>
                  </tr>
                </thead>
                <tbody>
                  {picks.recent.map(t=>(
                    <tr key={t.id} style={{borderBottom:`1px solid ${T.border}`}}>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim}}>
                        {new Date(t.completedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}
                      </td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.text}}>{t.sku}</td>
                      <td style={{padding:"8px 12px",fontSize:11,color:T.textMuted}}>{t.name}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:12,fontWeight:600,textAlign:"right",color:T.text}}>{t.qty}</td>
                      <td style={{padding:"8px 12px",fontSize:11,color:T.textMuted}}>{t.picker||"—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ):(
              <div style={{padding:20,textAlign:"center",color:T.textDim}}>No recent picks</div>
            )}
          </Card>
        </div>
      )}

      {sub==="alerts"&&(
        <div>
          {/* Alert summary */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:16,marginBottom:24}}>
            <Card style={{padding:16,textAlign:"center",borderLeft:`4px solid ${T.red}`}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>CRITICAL</div>
              <div style={{fontSize:32,fontWeight:800,color:alerts.critical>0?T.red:T.green,fontFamily:mono}}>{alerts.critical}</div>
            </Card>
            <Card style={{padding:16,textAlign:"center",borderLeft:`4px solid ${T.amber}`}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>HIGH</div>
              <div style={{fontSize:32,fontWeight:800,color:alerts.high>0?T.amber:T.green,fontFamily:mono}}>{alerts.high}</div>
            </Card>
            <Card style={{padding:16,textAlign:"center",borderLeft:`4px solid ${T.blue}`}}>
              <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1}}>LOW</div>
              <div style={{fontSize:32,fontWeight:800,color:T.blue,fontFamily:mono}}>{alerts.low}</div>
            </Card>
          </div>

          {/* Alerts list */}
          <Card>
            <SectionHeader right={`${alerts.alerts?.length||0} total`}>Low Stock Alerts</SectionHeader>
            {alerts.alerts?.length>0?(
              <div style={{display:"flex",flexDirection:"column",gap:8}}>
                {alerts.alerts.map((a,i)=>{
                  const sevColor={CRITICAL:T.red,HIGH:T.amber,LOW:T.blue}[a.severity]||T.textDim;
                  return(
                    <div key={i} style={{display:"flex",alignItems:"center",gap:12,padding:12,background:T.bg,borderRadius:6,borderLeft:`4px solid ${sevColor}`}}>
                      <div style={{flex:1}}>
                        <div style={{fontFamily:mono,fontSize:12,fontWeight:600,color:T.text}}>{a.name}</div>
                        <div style={{fontSize:11,color:T.textDim}}>{a.sku} • {a.location||"No location"}</div>
                      </div>
                      <div style={{textAlign:"right"}}>
                        <div style={{fontFamily:mono,fontSize:16,fontWeight:800,color:sevColor}}>{a.qty}</div>
                        <div style={{fontSize:9,color:T.textDim}}>threshold: {a.threshold}</div>
                      </div>
                      <Pill color={sevColor} bg={`${sevColor}15`}>{a.severity}</Pill>
                    </div>
                  );
                })}
              </div>
            ):(
              <div style={{padding:20,textAlign:"center",color:T.green}}>✓ No low stock alerts</div>
            )}
          </Card>
        </div>
      )}

      {sub==="search"&&(
        <Card>
          <SectionHeader>Lens Blank Search</SectionHeader>
          <p style={{color:T.textMuted,fontSize:12,marginBottom:16}}>
            Search for lens blanks by coating type, index, or prescription range.
          </p>
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
            <div>
              <label style={{fontSize:10,color:T.textDim,fontFamily:mono,display:"block",marginBottom:4}}>COATING TYPE</label>
              <select style={{width:"100%",padding:"8px 10px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,fontSize:12}}>
                <option value="">Any</option>
                {coatingTypes.filter(c=>c!=="All").map(c=><option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div>
              <label style={{fontSize:10,color:T.textDim,fontFamily:mono,display:"block",marginBottom:4}}>INDEX</label>
              <select style={{width:"100%",padding:"8px 10px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,fontSize:12}}>
                <option value="">Any</option>
                <option value="1.50">1.50</option>
                <option value="1.56">1.56</option>
                <option value="1.67">1.67</option>
                <option value="1.74">1.74</option>
              </select>
            </div>
            <div>
              <label style={{fontSize:10,color:T.textDim,fontFamily:mono,display:"block",marginBottom:4}}>SPHERE</label>
              <input type="text" placeholder="-2.00" style={{width:"100%",padding:"8px 10px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,fontSize:12,fontFamily:mono}}/>
            </div>
            <div>
              <label style={{fontSize:10,color:T.textDim,fontFamily:mono,display:"block",marginBottom:4}}>CYLINDER</label>
              <input type="text" placeholder="-1.00" style={{width:"100%",padding:"8px 10px",background:T.bg,border:`1px solid ${T.border}`,borderRadius:6,color:T.text,fontSize:12,fontFamily:mono}}/>
            </div>
          </div>
          <button style={{background:T.blue,border:"none",borderRadius:6,padding:"10px 24px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",fontFamily:mono}}>
            Search Inventory
          </button>
          <div style={{marginTop:24,padding:20,background:T.bg,borderRadius:8,textAlign:"center",color:T.textDim}}>
            Enter search criteria above and click Search to find matching lens blanks.
          </div>
        </Card>
      )}

      {/* Sync status footer */}
      <div style={{marginTop:20,display:"flex",justifyContent:"space-between",alignItems:"center",padding:"12px 16px",background:T.bg,borderRadius:8}}>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:inventory.status==="ok"||inventory.status==="mock"?T.green:T.red}}/>
          <span style={{fontSize:11,color:T.textDim,fontFamily:mono}}>
            {inventory.status==="mock"?"Mock Mode":"ItemPath"} • {inventory.lastSync?new Date(inventory.lastSync).toLocaleTimeString():"Not synced"}
          </span>
        </div>
        <span style={{fontSize:10,color:T.textDim}}>Auto-refresh every 30s</span>
      </div>
    </div>
    </ProductionStageTab>
  );
}

// ── MAINTENANCE & FACILITIES TAB ──────────────────────────────────────────────
function MaintenanceTab({ovenServerUrl,settings}){
  const mono="'JetBrains Mono',monospace";
  const [sub,setSub]=useState("overview");
  const [maintenance,setMaintenance]=useState({assets:[],tasks:[],downtime:[],parts:[],stats:{},lastSync:null,status:'pending'});
  const [loading,setLoading]=useState(true);
  const [selectedTask,setSelectedTask]=useState(null);  // For work order detail modal

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
      {[{id:"overview",icon:"◉",label:"Overview"},{id:"equipment",icon:"⚙️",label:"Equipment"},
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
    <ProductionStageTab domain="maintenance" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
    <div>
      {topBar}

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
                  {maintenance.parts?.map(p=>(
                    <tr key={p.id} style={{borderBottom:`1px solid ${T.border}`,background:p.lowStock?`${T.red}08`:''}}>
                      <td style={{padding:"8px 12px",fontSize:12,color:T.text,fontWeight:600}}>{p.name}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textDim}}>{p.partNum||'—'}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:13,fontWeight:800,color:p.lowStock?T.red:T.text,textAlign:"right"}}>{p.qty}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim,textAlign:"right"}}>{p.minQty}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textMuted}}>{p.location||'—'}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:10,color:T.textMuted}}>{p.vendor||'—'}</td>
                      <td style={{padding:"8px 12px",fontFamily:mono,fontSize:11,color:T.textDim,textAlign:"right"}}>{p.cost?`$${p.cost.toFixed(2)}`:'—'}</td>
                    </tr>
                  ))}
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
    </div>
    </ProductionStageTab>
  );
}


// ── Main App ─────────────────────────────────────────────────
// ── MODE DETECTION ────────────────────────────────────────────────────────────
// ?mode=tablet   → Manager tablet view (full access, bottom nav, touch-optimised)
// ?mode=corporate → Corporate read-only viewer (AI + dashboards, no controls)
function getMode(){
  try{const p=new URLSearchParams(window.location.search);return p.get("mode")||"desktop";}
  catch{return "desktop";}
}

// ── CORPORATE VIEWER ──────────────────────────────────────────────────────────
function CorporateViewer({trays,batches,events,settings}){
  const [aiInput,setAiInput]=useState("");
  const [aiMessages,setAiMessages]=useState([
    {from:"ai",text:"Corporate view active. I have read-only access to lab data — ask me anything about throughput, yield, coating status, or tray activity.",time:new Date()},
  ]);
  const [aiLoading,setAiLoading]=useState(false);
  const [corpView,setCorpView]=useState("overview");
  const aiRef=useRef(null);

  const running=batches.filter(b=>b.status==="running");
  const hold=batches.filter(b=>b.status==="hold");
  const totalTrays=trays.length;
  const activeTrays=trays.filter(t=>t.state!=="IDLE"&&t.state!=="COMPLETE").length;
  const qcHold=trays.filter(t=>t.state==="QC_HOLD").length;
  const broken=trays.filter(t=>t.state==="BROKEN").length;
  const coatingActive=trays.filter(t=>t.state==="COATING_IN_PROCESS").length;

  // Zone counts for floor map
  const zones=["PICKING","SURFACING","CUTTING","COATING","ASSEMBLY","QC","SHIPPING"];
  const zoneCounts=zones.map(z=>({
    zone:z,
    count:trays.filter(t=>(t.dept||"").toUpperCase()===z||t.state?.includes(z.slice(0,4))).length
  }));

  const CORP_QUICK=[
    "How many jobs are in coating right now?",
    "What's our current QC hold rate?",
    "Show throughput trend this week",
    "Which coating type is running most?",
    "Are there any rush jobs delayed?",
    "What's the average coating dwell time today?",
  ];

  async function askAI(q){
    const question=q||aiInput.trim();
    if(!question)return;
    setAiMessages(prev=>[...prev,{from:"user",text:question,time:new Date()}]);
    setAiInput(""); setAiLoading(true);
    const ctx=`Lab context: ${totalTrays} total trays. ${activeTrays} active. ${running.length} batches running, ${hold.length} on hold. ${coatingActive} in coating. ${qcHold} QC hold. ${broken} broken. Recent events: ${events.slice(0,5).map(e=>e.message).join("; ")}. You are a read-only corporate analytics assistant. Provide clear, concise operational insights. Be direct and data-driven. Format numbers clearly.`;
    try{
      const result = await callGateway(settings, question, { context: ctx });
      const text = result?.response || "Unable to retrieve data.";
      setAiMessages(prev=>[...prev,{from:"ai",text,time:new Date()}]);
    }catch(e){
      setAiMessages(prev=>[...prev,{from:"ai",text:`Connection error: ${e.message}`,time:new Date()}]);
    }
    setAiLoading(false);
    setTimeout(()=>aiRef.current?.scrollTo({top:9999,behavior:"smooth"}),100);
  }

  const navItems=[
    {id:"overview",label:"Overview",icon:"◉"},
    {id:"floor",   label:"Floor Map",icon:"🏭"},
    {id:"coating", label:"Coating",  icon:"◎"},
    {id:"ai",      label:"AI Query", icon:"🤖"},
  ];

  return(
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:sans}}>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700;800;900&family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet"/>
      {/* Header */}
      <div style={{background:T.surface,borderBottom:`2px solid #1E3A5F`,padding:"14px 28px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:100}}>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          <div style={{width:44,height:44,borderRadius:10,background:"linear-gradient(135deg,#1E3A5F,#2E5FA3)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:900,color:"#93C5FD",fontFamily:mono}}>PE</div>
          <div>
            <div style={{fontSize:20,fontWeight:800,letterSpacing:-0.5}}>Pair Eyewear</div>
            <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,letterSpacing:2}}>LAB OPERATIONS — CORPORATE VIEW</div>
          </div>
          <div style={{marginLeft:16,background:"#0A1F40",border:"1px solid #3B82F6",borderRadius:6,padding:"4px 12px",fontSize:10,color:"#60A5FA",fontFamily:mono,fontWeight:700}}>READ ONLY</div>
        </div>
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          {navItems.map(n=>n.type==="separator"?(
            <div key={n.id} style={{width:1,height:24,background:T.border,margin:"0 6px"}}/>
          ):(
            <button key={n.id} onClick={()=>setCorpView(n.id)} style={{background:corpView===n.id?"#1E3A5F":"transparent",border:`1px solid ${corpView===n.id?"#3B82F6":"transparent"}`,borderRadius:8,padding:"8px 16px",cursor:"pointer",color:corpView===n.id?"#93C5FD":T.textMuted,fontSize:13,fontWeight:700,fontFamily:sans,display:"flex",alignItems:"center",gap:6}}>
              <span>{n.icon}</span>{n.label}
            </button>
          ))}
        </div>
        <span style={{fontSize:12,color:T.textDim,fontFamily:mono}}>{new Date().toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
      </div>

      <div style={{padding:"24px 28px",maxWidth:1600,margin:"0 auto"}}>

        {/* ── OVERVIEW ── */}
        {corpView==="overview"&&(
          <div>
            {/* KPI row */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:16,marginBottom:28}}>
              {[
                {label:"Active Trays",    value:activeTrays,   sub:`of ${totalTrays} total`,  color:T.blue},
                {label:"Batches Running", value:running.length, sub:"in production",            color:T.green},
                {label:"Batches on Hold", value:hold.length,    sub:"need attention",           color:hold.length>0?T.amber:T.textDim},
                {label:"In Coating",      value:coatingActive,  sub:"coating process",          color:T.purple},
                {label:"QC Hold",         value:qcHold,         sub:"awaiting review",          color:qcHold>0?T.amber:T.textDim},
                {label:"Broken / Scrap",  value:broken,         sub:"this period",              color:broken>0?T.red:T.textDim},
              ].map(k=>(
                <div key={k.label} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:"18px 20px"}}>
                  <div style={{fontSize:36,fontWeight:800,color:k.color,fontFamily:mono,lineHeight:1}}>{k.value}</div>
                  <div style={{fontSize:13,fontWeight:600,color:T.text,marginTop:6}}>{k.label}</div>
                  <div style={{fontSize:11,color:T.textMuted,marginTop:2}}>{k.sub}</div>
                </div>
              ))}
            </div>

            {/* Recent events feed */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:20}}>
                <div style={{fontSize:13,fontWeight:700,color:T.textMuted,fontFamily:mono,letterSpacing:1,marginBottom:14}}>LIVE EVENTS</div>
                {events.slice(0,12).map(e=>(
                  <div key={e.id} style={{display:"flex",gap:10,padding:"7px 0",borderBottom:`1px solid ${T.border}`}}>
                    <span style={{fontSize:14}}>{e.icon}</span>
                    <span style={{fontSize:12,color:T.text,flex:1}}>{e.message}</span>
                    <span style={{fontSize:10,color:T.textDim,fontFamily:mono,flexShrink:0}}>{new Date(e.time).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
                  </div>
                ))}
              </div>

              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:20}}>
                <div style={{fontSize:13,fontWeight:700,color:T.textMuted,fontFamily:mono,letterSpacing:1,marginBottom:14}}>BATCH STATUS</div>
                {batches.slice(0,10).map(b=>(
                  <div key={b.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 0",borderBottom:`1px solid ${T.border}`}}>
                    <div style={{width:8,height:8,borderRadius:"50%",background:b.status==="running"?T.green:b.status==="hold"?T.red:T.amber,flexShrink:0}}/>
                    <span style={{fontSize:12,fontFamily:mono,color:T.textMuted,minWidth:80}}>{b.id}</span>
                    <span style={{fontSize:12,color:T.text,flex:1}}>{b.coatingType} — {b.lensType}</span>
                    <span style={{fontSize:11,color:b.status==="running"?T.green:b.status==="hold"?T.red:T.amber,fontFamily:mono,fontWeight:700}}>{(b.status||"").toUpperCase()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* ── FLOOR MAP ── */}
        {corpView==="floor"&&(
          <div>
            <div style={{fontSize:18,fontWeight:700,marginBottom:20}}>Floor Activity — Read Only</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:14}}>
              {zones.map(z=>{
                const count=trays.filter(t=>(t.dept||"").toUpperCase()===z).length;
                const colors={PICKING:T.blue,SURFACING:T.purple,CUTTING:T.amber,COATING:"#8B5CF6",ASSEMBLY:T.green,QC:T.amber,SHIPPING:T.textMuted};
                const c=colors[z]||T.blue;
                return(
                  <div key={z} style={{background:T.card,border:`2px solid ${count>0?c:T.border}`,borderRadius:14,padding:"20px 20px",textAlign:"center",boxShadow:count>0?`0 0 20px ${c}20`:"none"}}>
                    <div style={{fontSize:40,fontWeight:800,color:c,fontFamily:mono,lineHeight:1}}>{count}</div>
                    <div style={{fontSize:13,fontWeight:700,color:T.text,marginTop:8,letterSpacing:1}}>{z}</div>
                    <div style={{fontSize:10,color:T.textMuted,marginTop:4}}>trays active</div>
                  </div>
                );
              })}
            </div>
            <div style={{marginTop:20,background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16}}>
              <div style={{fontSize:11,color:T.textMuted,fontFamily:mono,marginBottom:10,letterSpacing:1}}>TRAY STATUS DISTRIBUTION</div>
              <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                {Object.entries(TRAY_STATES).map(([state,cfg])=>{
                  const cnt=trays.filter(t=>t.state===state).length;
                  if(!cnt)return null;
                  return(
                    <div key={state} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:"6px 12px",display:"flex",gap:8,alignItems:"center"}}>
                      <div style={{width:8,height:8,borderRadius:"50%",background:cfg.color}}/>
                      <span style={{fontSize:11,color:T.textMuted}}>{state.replace(/_/g," ")}</span>
                      <span style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:mono}}>{cnt}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        )}

        {/* ── COATING ── */}
        {corpView==="coating"&&(
          <div>
            <div style={{fontSize:18,fontWeight:700,marginBottom:20}}>Coating Operations — Read Only</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(240px,1fr))",gap:16,marginBottom:24}}>
              {["AR","Blue Cut","Hard Coat","Mirror","Polarized","Transitions"].map(ct=>{
                const cnt=batches.filter(b=>b.coatingType===ct&&b.status==="running").length;
                return(
                  <div key={ct} style={{background:T.card,border:`1px solid ${cnt>0?T.blue:T.border}`,borderRadius:12,padding:16}}>
                    <div style={{fontSize:13,fontWeight:700,color:T.text}}>{ct}</div>
                    <div style={{fontSize:28,fontWeight:800,fontFamily:mono,color:cnt>0?T.green:T.textDim,marginTop:4}}>{cnt}</div>
                    <div style={{fontSize:11,color:T.textMuted}}>batches running</div>
                  </div>
                );
              })}
            </div>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:20}}>
              <div style={{fontSize:13,fontWeight:700,color:T.textMuted,fontFamily:mono,letterSpacing:1,marginBottom:14}}>ALL ACTIVE BATCHES</div>
              {batches.filter(b=>b.status==="running"||b.status==="hold").map(b=>(
                <div key={b.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:b.status==="running"?T.green:T.red}}/>
                  <span style={{fontFamily:mono,fontSize:12,color:T.textMuted,minWidth:90}}>{b.id}</span>
                  <span style={{fontSize:13,color:T.text,flex:1}}>{b.coatingType} / {b.lensType}</span>
                  <span style={{fontSize:11,color:T.textMuted}}>Rack {b.rack||"—"}</span>
                  <span style={{fontSize:11,fontWeight:700,color:b.status==="running"?T.green:T.red,fontFamily:mono}}>{(b.status||"").toUpperCase()}</span>
                  {/* NO control buttons in corporate view */}
                </div>
              ))}
              {batches.filter(b=>b.status==="running"||b.status==="hold").length===0&&(
                <div style={{textAlign:"center",padding:24,color:T.textDim,fontFamily:mono,fontSize:12}}>No active batches</div>
              )}
            </div>
          </div>
        )}

        {/* ── AI QUERY ── */}
        {corpView==="ai"&&(
          <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:20,height:"calc(100vh - 160px)"}}>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,display:"flex",flexDirection:"column",overflow:"hidden"}}>
              <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:10}}>
                <span style={{fontSize:16}}>🤖</span>
                <span style={{fontSize:14,fontWeight:700}}>Lab AI — Corporate Query</span>
                <span style={{fontSize:10,color:"#60A5FA",fontFamily:mono,background:"#0A1F40",border:"1px solid #3B82F6",borderRadius:4,padding:"2px 8px",marginLeft:8}}>READ ONLY</span>
              </div>
              <div ref={aiRef} style={{flex:1,overflow:"auto",padding:16,display:"flex",flexDirection:"column",gap:12}}>
                {aiMessages.map((m,i)=>(
                  <div key={i} style={{display:"flex",justifyContent:m.from==="user"?"flex-end":"flex-start"}}>
                    <div style={{maxWidth:"80%",background:m.from==="user"?T.blueDark:T.surface,border:`1px solid ${m.from==="user"?T.blue:T.border}`,borderRadius:12,padding:"10px 14px"}}>
                      <div style={{fontSize:13,color:T.text,lineHeight:1.55,whiteSpace:"pre-wrap"}}>{m.text}</div>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginTop:4}}>{m.time.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</div>
                    </div>
                  </div>
                ))}
                {aiLoading&&<div style={{display:"flex",gap:6,padding:"10px 14px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:12,width:"fit-content"}}>
                  {[0,1,2].map(i=><div key={i} style={{width:6,height:6,borderRadius:"50%",background:T.blue,animation:`pulse ${0.9+i*0.15}s infinite`}}/>)}
                </div>}
              </div>
              <div style={{padding:14,borderTop:`1px solid ${T.border}`,display:"flex",gap:8}}>
                <input value={aiInput} onChange={e=>setAiInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&!e.shiftKey&&askAI()} placeholder="Ask about throughput, yield, coating status…" style={{flex:1,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",color:T.text,fontSize:13,fontFamily:sans,outline:"none"}}/>
                <button onClick={()=>askAI()} disabled={aiLoading} style={{background:T.blue,border:"none",borderRadius:8,padding:"10px 18px",color:"#fff",fontWeight:700,fontSize:13,cursor:"pointer"}}>Ask</button>
              </div>
            </div>
            {/* Quick prompts */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:14,padding:16}}>
              <div style={{fontSize:11,fontWeight:700,color:T.textMuted,fontFamily:mono,letterSpacing:1,marginBottom:14}}>QUICK QUERIES</div>
              {CORP_QUICK.map((q,i)=>(
                <button key={i} onClick={()=>askAI(q)} style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 12px",color:T.text,fontSize:12,cursor:"pointer",marginBottom:8,textAlign:"left",fontFamily:sans}}>
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <style>{`*{box-sizing:border-box;margin:0;padding:0;}::-webkit-scrollbar{width:5px;}::-webkit-scrollbar-track{background:${T.bg};}::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px;}input::placeholder{color:${T.textDim};}input:focus{border-color:${T.blue}!important;}@keyframes pulse{0%,100%{opacity:1;}50%{opacity:0.3;}}`}</style>
    </div>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────────────
export default function LabAssistantV2(){
  const appMode=getMode(); // "desktop" | "tablet" | "corporate"
  const [view,setView]=useState("overview");
  const [trays,setTrays]=useState(()=>initTrays(120));
  const [putWall,setPutWall]=useState(()=>initPutWall(20));
  const [batches,setBatches]=useState(()=>initBatches());
  const [events,setEvents]=useState(()=>initEvents());
  const [messages,setMessages]=useState(()=>initMessages());
  const [inspections]=useState(()=>initInspections());
  const [breakage,setBreakage]=useState(()=>initBreakage());
  const [connected]=useState(true);
  const [ovenServerUrl,setOvenServerUrl]=useState(()=>{ try{return JSON.parse(localStorage.getItem("la_slack_v2")||"{}").ovenServer||"http://localhost:3002";}catch{return "http://localhost:3002";} });
  const [clock,setClock]=useState(new Date());

  // Settings state with localStorage persistence
  const [settings,setSettings]=useState(()=>{
    try{
      const stored=localStorage.getItem("la_settings_v1");
      if(stored){
        const parsed=JSON.parse(stored);
        // Merge with defaults to handle new fields
        return {...DEFAULT_SETTINGS,...parsed};
      }
    }catch{}
    return DEFAULT_SETTINGS;
  });

  // Persist settings to localStorage
  useEffect(()=>{
    try{localStorage.setItem("la_settings_v1",JSON.stringify(settings));}catch{}
  },[settings]);

  // Derive coater machines from settings (fallback to MACHINES constant)
  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  const sendMessage=useCallback((text)=>{
    setMessages(prev=>[{id:Date.now(),from:"Dashboard",text,time:new Date(),priority:text.toLowerCase().includes("rush")||text.toLowerCase().includes("hot")?"high":"normal"},...prev].slice(0,20));
  },[]);

  const handleBatchControl=useCallback((batchId,newState)=>{
    setBatches(prev=>prev.map(b=>{
      if(b.id!==batchId)return b;
      const status=newState==="running"?"running":newState==="hold"?"hold":"waiting";
      return{...b,controlState:newState,status,startedAt:newState==="running"?Date.now():b.startedAt,eta:newState==="running"?Date.now()+3600000:b.eta};
    }));
    const actionLabels={running:"▶ STARTED",hold:"⏸ ON HOLD",waiting:"⏳ WAITING"};
    const colors={running:T.green,hold:T.red,waiting:T.amber};
    setEvents(prev=>[{id:Date.now(),time:new Date(),icon:newState==="running"?"▶":newState==="hold"?"⏸":"⏳",message:`Batch ${batchId}: ${actionLabels[newState]} by operator`},...prev.slice(0,30)]);
  },[]);

  useEffect(()=>{
    const iv=setInterval(()=>{
      setClock(new Date());
      setTrays(prev=>{
        const next=[...prev];
        const idx=Math.floor(Math.random()*next.length);
        const states=Object.keys(TRAY_STATES);
        const newState=pick(states);
        let dept;
        if(newState==="IDLE")dept=pick(["PICKING","SHIPPING"]);
        else if(newState==="COATING_STAGED"||newState==="COATING_IN_PROCESS")dept="COATING";
        else if(newState==="QC_HOLD"||newState==="BROKEN")dept="QC";
        else if(newState==="COMPLETE")dept=pick(["ASSEMBLY","SHIPPING"]);
        else dept=pick(["PICKING","SURFACING","CUTTING","COATING","ASSEMBLY","QC"]);
        let coatingStage=null,machine=null,batchId=null;
        if(dept==="COATING"){
          const stages=Object.keys(COATING_STAGES);
          if(newState==="COATING_STAGED")coatingStage=pick(["QUEUE","DIP","SCAN_IN"]);
          else if(newState==="COATING_IN_PROCESS")coatingStage=pick(["OVEN","COATER","COOL_DOWN"]);
          else coatingStage=pick(stages);
          if(["OVEN","COATER"].includes(coatingStage))machine=pick(coaterMachines);
          if(coatingStage!=="QUEUE")batchId=pick(["B01","B02","B03"]);
          if(["OVEN","COATER"].includes(coatingStage)&&!next[idx].stageEnteredAt)next[idx]={...next[idx],stageEnteredAt:Date.now()};
        }
        next[idx]={...next[idx],state:newState,updatedAt:Date.now(),lastSeen:Date.now(),department:dept,coatingStage,machine,batchId};
        return next;
      });
      if(Math.random()<0.3){
        setPutWall(prev=>{
          const next=[...prev];const idx=Math.floor(Math.random()*next.length);
          if(next[idx].trayId&&Math.random()<0.4){next[idx]={...next[idx],trayId:null,job:null,rush:false,since:null,source:null,coatingType:null};}
          else if(!next[idx].trayId){next[idx]={...next[idx],trayId:genTray(),job:genJob(),rush:Math.random()<0.1,since:Date.now(),source:pick(["DVI","Lab Assistant","Kardex"]),coatingType:pick(COATING_TYPES)};}
          return next;
        });
      }
      setBatches(prev=>prev.map(b=>{
        if(b.controlState==="hold")return b;
        if(b.controlState==="waiting")return b;
        if(b.status==="loading"&&b.loaded<b.capacity){const nl=Math.min(b.loaded+Math.floor(Math.random()*5)+1,b.capacity);if(nl>=b.capacity)return{...b,loaded:b.capacity,status:"running",startedAt:Date.now(),eta:Date.now()+3600000};return{...b,loaded:nl};}
        if(b.status==="running"&&b.eta&&Date.now()>b.eta)return{...b,status:"complete",controlState:"idle"};
        if(b.status==="complete"&&Math.random()<0.05)return{...b,status:"loading",loaded:0,coatingType:pick(COATING_TYPES),startedAt:null,eta:null,controlState:"idle"};
        if(b.status==="idle"&&Math.random()<0.1)return{...b,status:"loading",loaded:0,coatingType:pick(COATING_TYPES),controlState:"idle"};
        return b;
      }));
      if(Math.random()<0.3){
        const types=[
          {icon:"📥",msg:()=>`${genJob()} bound to ${genTray()} at Slot ${Math.floor(Math.random()*20)+1}`},
          {icon:"⚡",msg:()=>`RUSH ${genJob()} routed to Rush Wall`},
          {icon:"✅",msg:()=>`Batch ${pick(["B01","B02","B03"])} verified: ${Math.floor(Math.random()*10)+130}/140`},
          {icon:"🔄",msg:()=>`${genJob()} re-trayed → cutting`},
          {icon:"🔬",msg:()=>`QC pass: ${genJob()} — ${pick(COATING_TYPES)}`},
          {icon:"💥",msg:()=>`Break: ${genJob()} — ${pick(BREAK_TYPES)}`},
        ];
        const t=pick(types);
        setEvents(prev=>[{id:Date.now(),time:new Date(),icon:t.icon,message:t.msg()},...prev.slice(0,30)]);
      }
    },2500);
    return()=>clearInterval(iv);
  },[]);

  // Corporate mode — render read-only viewer
  if(appMode==="corporate"){
    return <CorporateViewer trays={trays} batches={batches} events={events} settings={settings}/>;
  }

  const isTablet = appMode==="tablet";

  // Navigation structure: Overview | Production Flow | Support | Settings
  const navItems=[
    // System
    {id:"overview",    label:"Overview",    icon:"◉",  group:"system"},
    // Production flow (separator before)
    {id:"separator1",  type:"separator"},
    {id:"surfacing",   label:"Surfacing",   icon:"🌀", group:"production"},
    {id:"cutting",     label:"Cutting",     icon:"✂️", group:"production"},
    {id:"coating",     label:"Coating",     icon:"🌡", group:"production"},
    {id:"assembly",    label:"Assembly",    icon:"🔧", group:"production"},
    {id:"shipping",    label:"Shipping",    icon:"📤", group:"production"},
    // Support (separator before)
    {id:"separator2",  type:"separator"},
    {id:"putwall",     label:"Put Wall",    icon:"⬡",  group:"support"},
    {id:"trays",       label:"Tray Fleet",  icon:"📡", group:"support"},
    {id:"inventory",   label:"Inventory",   icon:"📦", group:"support"},
    {id:"maintenance", label:"Maintenance", icon:"🔩", group:"support"},
    // Analytics & QC (separator before)
    {id:"separator3",  type:"separator"},
    {id:"analytics",   label:"Analytics",   icon:"📊", group:"analytics"},
    {id:"qc",          label:"QC",          icon:"✓",  group:"analytics"},
    {id:"ai",          label:"AI Assistant",icon:"🤖", group:"analytics"},
    // Settings (separator before)
    {id:"separator4",  type:"separator"},
    {id:"settings",    label:"Settings",    icon:"⚙️", group:"system"},
  ];

  return(
    <div style={{minHeight:"100vh",background:T.bg,color:T.text,fontFamily:sans}}>
      <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;600;700;800;900&family=JetBrains+Mono:wght@400;500;700;800&display=swap" rel="stylesheet"/>

      {/* DESKTOP HEADER */}
      {!isTablet&&(
        <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"12px 28px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:100}}>
          <div style={{display:"flex",alignItems:"center",gap:16}}>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{width:42,height:42,borderRadius:10,background:`linear-gradient(135deg,${T.blue},${T.blueGlow})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:17,fontWeight:900,color:"#fff",fontFamily:mono,boxShadow:`0 0 24px ${T.blue}30`}}>LA</div>
              <div>
                <div style={{fontSize:19,fontWeight:800,color:T.text,letterSpacing:-0.5}}>Lab_Assistant</div>
                <div style={{fontSize:10,color:T.textDim,fontFamily:mono,letterSpacing:1.5}}>MES v2.1 — OPTICAL MANUFACTURING</div>
              </div>
            </div>
            <div style={{display:"flex",gap:3,marginLeft:24,alignItems:"center"}}>
              {navItems.map(n=>n.type==="separator"?(
                <div key={n.id} style={{width:1,height:24,background:T.border,margin:"0 8px"}}/>
              ):(
                <button key={n.id} onClick={()=>setView(n.id)} style={{background:view===n.id?T.blueDark:"transparent",border:`1px solid ${view===n.id?T.blue:"transparent"}`,borderRadius:8,padding:"8px 16px",cursor:"pointer",color:view===n.id?"#93C5FD":T.textMuted,fontSize:13,fontWeight:700,fontFamily:sans,display:"flex",alignItems:"center",gap:6,transition:"all 0.2s"}}><span style={{fontSize:15}}>{n.icon}</span>{n.label}</button>
              ))}
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:18}}>
            <div style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={{width:9,height:9,borderRadius:"50%",background:connected?T.green:T.red,boxShadow:`0 0 10px ${connected?T.green:T.red}`}}/>
              <span style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>{connected?"MQTT LIVE":"DISCONNECTED"}</span>
            </div>
            <span style={{fontSize:13,color:T.textDim,fontFamily:mono,fontWeight:600}}>{clock.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit",second:"2-digit"})}</span>
          </div>
        </div>
      )}

      {/* TABLET COMPACT HEADER */}
      {isTablet&&(
        <div style={{background:T.surface,borderBottom:`1px solid ${T.border}`,padding:"10px 16px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:100}}>
          <div style={{display:"flex",alignItems:"center",gap:10}}>
            <div style={{width:38,height:38,borderRadius:9,background:`linear-gradient(135deg,${T.blue},${T.blueGlow})`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14,fontWeight:900,color:"#fff",fontFamily:mono}}>LA</div>
            <div>
              <div style={{fontSize:16,fontWeight:800,letterSpacing:-0.5}}>Lab_Assistant</div>
              <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1.5}}>MANAGER VIEW — FULL ACCESS</div>
            </div>
          </div>
          <div style={{display:"flex",alignItems:"center",gap:12}}>
            <div style={{display:"flex",alignItems:"center",gap:5}}>
              <div style={{width:8,height:8,borderRadius:"50%",background:connected?T.green:T.red,boxShadow:`0 0 8px ${connected?T.green:T.red}`}}/>
              <span style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>LIVE</span>
            </div>
            <span style={{fontSize:14,color:T.textDim,fontFamily:mono,fontWeight:700}}>{clock.toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"})}</span>
          </div>
        </div>
      )}

      {/* CONTENT */}
      <div style={{padding:isTablet?"14px 12px 90px":"22px 28px",maxWidth:3600,margin:"0 auto"}}>
        {view==="overview"&&<OverviewTab trays={trays} putWall={putWall} batches={batches} events={events} messages={messages} onSendMessage={sendMessage} onBatchControl={handleBatchControl} settings={settings}/>}
        {view==="putwall"&&<PutWallTab putWall={putWall} setPutWall={setPutWall} events={events}/>}
        {view==="coating"&&<CoatingTab batches={batches} trays={trays} inspections={inspections} onBatchControl={handleBatchControl} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="surfacing"&&<SurfacingTab trays={trays} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="cutting"&&<CuttingTab trays={trays} breakage={breakage} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="assembly"&&<AssemblyTab trays={trays} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="shipping"&&<ShippingTab trays={trays} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="inventory"&&<InventoryTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="maintenance"&&<MaintenanceTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="analytics"&&<AnalyticsTab batches={batches} trays={trays} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="qc"&&<QCTab trays={trays} breakage={breakage} setBreakage={setBreakage}/>}
        {view==="trays"&&<TrayFleetTab trays={trays} setTrays={setTrays}/>}
        {view==="ai"&&<AIAssistantTab trays={trays} batches={batches} settings={settings}/>}
        {view==="settings"&&<SettingsTab settings={settings} setSettings={setSettings} ovenServerUrl={ovenServerUrl}/>}
      </div>

      {/* TABLET BOTTOM NAV */}
      {isTablet&&(
        <div style={{position:"fixed",bottom:0,left:0,right:0,background:T.surface,borderTop:`1px solid ${T.border}`,display:"flex",zIndex:200,boxShadow:"0 -4px 24px #00000060"}}>
          {navItems.filter(n=>n.type!=="separator").map(n=>(
            <button key={n.id} onClick={()=>setView(n.id)} style={{flex:1,padding:"10px 2px 14px",background:"transparent",border:"none",cursor:"pointer",display:"flex",flexDirection:"column",alignItems:"center",gap:3,borderTop:`3px solid ${view===n.id?T.blue:"transparent"}`,WebkitTapHighlightColor:"transparent",transition:"all 0.15s"}}>
              <span style={{fontSize:19}}>{n.icon}</span>
              <span style={{fontSize:8,fontWeight:700,fontFamily:sans,color:view===n.id?"#93C5FD":T.textMuted,letterSpacing:0.5,textTransform:"uppercase"}}>{n.label.split(" ")[0]}</span>
            </button>
          ))}
        </div>
      )}

      {/* DESKTOP FOOTER */}
      {!isTablet&&(
        <div style={{padding:"12px 28px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between"}}>
          <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Lab_Assistant v2.1.0 — Custom MES for Optical Manufacturing</span>
          <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>WS: ws://localhost:8080 | MQTT: mqtt://localhost:1883 | BLE PAwR: nRF52833</span>
        </div>
      )}

      <style>{`
        @keyframes pulse { 0%,100%{opacity:1;} 50%{opacity:0.3;} }
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:5px;}
        ::-webkit-scrollbar-track{background:${T.bg};}
        ::-webkit-scrollbar-thumb{background:${T.border};border-radius:3px;}
        input::placeholder{color:${T.textDim};}
        input:focus,select:focus{border-color:${T.blue}!important;}
        select{appearance:none;}
        ${isTablet?`button{min-height:44px;} input,select{min-height:44px;font-size:16px!important;}`:""}
      `}</style>
    </div>
  );
}
