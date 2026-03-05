import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
import WIPFeed from "./components/WIPFeed";
// Extracted tab components (reduces App.jsx by ~5,600 lines)
import SettingsTab from "./components/tabs/SettingsTab";
import OverviewTab from "./components/tabs/OverviewTab";
import InventoryTab from "./components/tabs/InventoryTab";
import MaintenanceTab from "./components/tabs/MaintenanceTab";
import AnalyticsTab from "./components/tabs/AnalyticsTab";

// ── Error Boundary — catches render errors and shows fallback UI ───────────────
class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, errorInfo) {
    console.error('React Error Boundary caught:', error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          minHeight: '100vh', background: '#080C18', color: '#F1F5F9',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          padding: 40, fontFamily: 'system-ui, sans-serif'
        }}>
          <div style={{ fontSize: 48, marginBottom: 20 }}>⚠️</div>
          <h1 style={{ fontSize: 24, marginBottom: 12, color: '#EF4444' }}>Something went wrong</h1>
          <p style={{ color: '#94A3B8', marginBottom: 20, textAlign: 'center', maxWidth: 500 }}>
            The app encountered an error. Click below to reload, or check the console for details.
          </p>
          <div style={{
            background: '#1E293B', padding: 16, borderRadius: 8, marginBottom: 20,
            maxWidth: 600, overflow: 'auto', fontSize: 13, fontFamily: 'monospace', color: '#F87171'
          }}>
            {this.state.error?.toString()}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{
              background: '#3B82F6', color: '#fff', border: 'none', padding: '12px 24px',
              borderRadius: 8, fontSize: 15, cursor: 'pointer', fontWeight: 600
            }}
          >
            Reload App
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

// Global error handlers to prevent blank screen
if (typeof window !== 'undefined') {
  window.onerror = (msg, url, line, col, error) => {
    console.error('Global error:', msg, url, line, col, error);
    return false; // Let default handler run too
  };
  window.onunhandledrejection = (event) => {
    console.error('Unhandled promise rejection:', event.reason);
  };
}

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
  // API Connections
  itempathUrl: '',
  itempathToken: '',
  dviUrl: '',
  dviApiKey: '',
  limbleUrl: '',
  limbleApiKey: '',
  slackBotToken: '',
  slackSigningSecret: '',
  slackAppToken: '',
  databaseUrl: '',
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

// DevOps AI Card for Settings/Connections
function DevOpsAICard({settings,connections}){
  const [query,setQuery]=useState('');
  const [response,setResponse]=useState('');
  const [loading,setLoading]=useState(false);
  const mono="'JetBrains Mono',monospace";

  const askDevOps = async (q) => {
    const question = q || query;
    if(!question.trim()) return;
    setLoading(true);
    setResponse('');
    const gwUrl = settings?.gatewayUrl || 'http://localhost:3001';
    try {
      // Build context from connections
      const ctx = connections ? `Current connection status:\n${JSON.stringify(connections.connections,null,2)}` : '';
      const resp = await fetch(`${gwUrl}/web/ask`, {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({question,agent:'DevOpsAgent',context:ctx})
      });
      if(!resp.ok) throw new Error(`HTTP ${resp.status}`);
      // SSE streaming
      const reader = resp.body.getReader();
      const decoder = new TextDecoder();
      let text = '';
      while(true){
        const {done,value} = await reader.read();
        if(done) break;
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n');
        for(const line of lines){
          if(line.startsWith('data: ')){
            try{
              const data = JSON.parse(line.slice(6));
              if(data.text) { text += data.text; setResponse(text); }
            }catch{}
          }
        }
      }
    } catch(e) {
      setResponse(`Error: ${e.message}\n\nMake sure the MCP Gateway is running on ${gwUrl}`);
    }
    setLoading(false);
  };

  const quickPrompts = [
    "Why is Lab Backend disconnected?",
    "How do I configure ItemPath?",
    "What env vars do I need?",
    "Debug gateway startup"
  ];

  return(
    <Card style={{background:`${T.purple}10`,border:`1px solid ${T.purple}40`,padding:0,overflow:'hidden'}}>
      <div style={{padding:16,borderBottom:`1px solid ${T.purple}30`}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
          <span style={{fontSize:24}}>🤖</span>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:T.text}}>DevOps AI Assistant</div>
            <div style={{fontSize:11,color:T.textMuted}}>Ask about APIs, gateway, config, or troubleshooting</div>
          </div>
        </div>
        <div style={{display:"flex",gap:8}}>
          <input
            value={query}
            onChange={e=>setQuery(e.target.value)}
            onKeyDown={e=>e.key==='Enter'&&askDevOps()}
            placeholder="Ask about connections, APIs, or configuration..."
            style={{flex:1,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:"10px 14px",color:T.text,fontSize:13}}
          />
          <button onClick={()=>askDevOps()} disabled={loading||!query.trim()}
            style={{background:T.purple,border:"none",borderRadius:8,padding:"0 20px",color:"#fff",fontSize:13,fontWeight:700,cursor:"pointer",opacity:loading||!query.trim()?0.5:1}}>
            {loading?"...":"Ask"}
          </button>
        </div>
        <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:10}}>
          {quickPrompts.map(q=>(
            <button key={q} onClick={()=>{setQuery(q);askDevOps(q);}}
              style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"5px 10px",color:T.textMuted,fontSize:10,cursor:"pointer"}}>
              {q}
            </button>
          ))}
        </div>
      </div>
      {(response || loading) && (
        <div style={{padding:16,background:T.bg,maxHeight:300,overflowY:'auto'}}>
          {loading && !response && <div style={{color:T.textMuted,fontSize:12}}>Thinking...</div>}
          {response && (
            <pre style={{margin:0,whiteSpace:'pre-wrap',fontSize:12,color:T.text,fontFamily:mono,lineHeight:1.5}}>{response}</pre>
          )}
        </div>
      )}
    </Card>
  );
}

// ── Agents Management Panel ───────────────────────────────────────────────────
function AgentsPanel({settings}){
  const mono="'JetBrains Mono',monospace";
  const [agents,setAgents]=useState([]);
  const [loading,setLoading]=useState(true);
  const [selectedAgent,setSelectedAgent]=useState(null);
  const [editContent,setEditContent]=useState('');
  const [saving,setSaving]=useState(false);
  const [showCreate,setShowCreate]=useState(false);
  const [newAgentName,setNewAgentName]=useState('');
  const [newAgentContent,setNewAgentContent]=useState('');
  const gwUrl=settings?.gatewayUrl||'http://localhost:3001';

  // Load agents on mount
  useEffect(()=>{
    loadAgents();
  },[]);

  const loadAgents=async()=>{
    setLoading(true);
    try{
      const resp=await fetch(`${gwUrl}/gateway/agents/prompts`);
      if(resp.ok){
        const data=await resp.json();
        setAgents(data.agents||[]);
        if(data.agents?.length>0&&!selectedAgent){
          setSelectedAgent(data.agents[0].name);
          setEditContent(data.agents[0].content);
        }
      }
    }catch(e){
      console.error('Failed to load agents:',e);
    }
    setLoading(false);
  };

  const selectAgent=(name)=>{
    const agent=agents.find(a=>a.name===name);
    if(agent){
      setSelectedAgent(name);
      setEditContent(agent.content);
    }
  };

  const saveAgent=async()=>{
    if(!selectedAgent||!editContent.trim())return;
    setSaving(true);
    try{
      const resp=await fetch(`${gwUrl}/gateway/agents/prompts/${selectedAgent}`,{
        method:'PUT',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({content:editContent})
      });
      if(resp.ok){
        // Update local state
        setAgents(prev=>prev.map(a=>a.name===selectedAgent?{...a,content:editContent}:a));
      }
    }catch(e){
      console.error('Failed to save agent:',e);
    }
    setSaving(false);
  };

  const createAgent=async()=>{
    if(!newAgentName.trim()||!newAgentContent.trim())return;
    setSaving(true);
    try{
      const resp=await fetch(`${gwUrl}/gateway/agents/prompts`,{
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:newAgentName.trim(),content:newAgentContent})
      });
      if(resp.ok){
        setShowCreate(false);
        setNewAgentName('');
        setNewAgentContent('');
        await loadAgents();
      }else{
        const err=await resp.json();
        alert(err.error||'Failed to create agent');
      }
    }catch(e){
      console.error('Failed to create agent:',e);
    }
    setSaving(false);
  };

  const deleteAgent=async(name)=>{
    if(!confirm(`Delete agent "${name}"? This cannot be undone.`))return;
    try{
      const resp=await fetch(`${gwUrl}/gateway/agents/prompts/${name}`,{method:'DELETE'});
      if(resp.ok){
        await loadAgents();
        if(selectedAgent===name){
          setSelectedAgent(null);
          setEditContent('');
        }
      }
    }catch(e){
      console.error('Failed to delete agent:',e);
    }
  };

  // Default template for new agents
  const defaultTemplate=`# AgentName — Lab Assistant Specialist

You are a specialist agent for Pair Eyewear's lens lab operations. You help with [AREA] operations.

## Your Responsibilities

1. **Primary Function** — Describe main purpose
2. **Data Analysis** — What data you analyze
3. **Recommendations** — What advice you provide

## Key Metrics to Monitor

- Metric 1
- Metric 2
- Metric 3

## Response Style

- Be concise and data-driven
- Use specific numbers when available
- Recommend actionable next steps

## MCP Tools Available

- \`query_database\` — Run read-only SQL queries
- \`call_api\` — Call Lab Assistant REST API endpoints
- \`think_aloud\` — Structure your reasoning
`;

  if(loading){
    return(
      <Card style={{padding:40,textAlign:'center'}}>
        <div style={{color:T.textMuted}}>Loading agents...</div>
      </Card>
    );
  }

  return(
    <div style={{display:'flex',flexDirection:'column',gap:16}}>
      {/* Header */}
      <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
        <div>
          <div style={{fontSize:16,fontWeight:700,color:T.text}}>AI Agents</div>
          <div style={{fontSize:11,color:T.textMuted}}>{agents.length} agents configured</div>
        </div>
        <button onClick={()=>{setShowCreate(true);setNewAgentContent(defaultTemplate);}}
          style={{background:T.blue,border:'none',borderRadius:8,padding:'10px 20px',color:'#fff',fontSize:13,fontWeight:700,cursor:'pointer',display:'flex',alignItems:'center',gap:8}}>
          + Create Agent
        </button>
      </div>

      {/* Create Agent Modal */}
      {showCreate&&(
        <Card style={{background:`${T.green}10`,border:`1px solid ${T.green}40`}}>
          <div style={{marginBottom:12}}>
            <label style={{fontSize:10,color:T.textMuted,fontFamily:mono,letterSpacing:1}}>AGENT NAME</label>
            <input value={newAgentName} onChange={e=>setNewAgentName(e.target.value.replace(/[^a-zA-Z0-9_]/g,''))}
              placeholder="MyNewAgent"
              style={{width:'100%',marginTop:4,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 14px',color:T.text,fontSize:14,fontFamily:mono}}/>
            <div style={{fontSize:10,color:T.textDim,marginTop:4}}>Letters, numbers, and underscores only. Will be saved as {newAgentName||'AgentName'}.md</div>
          </div>
          <div style={{marginBottom:12}}>
            <label style={{fontSize:10,color:T.textMuted,fontFamily:mono,letterSpacing:1}}>SYSTEM PROMPT (MARKDOWN)</label>
            <textarea value={newAgentContent} onChange={e=>setNewAgentContent(e.target.value)}
              rows={15}
              style={{width:'100%',marginTop:4,background:T.surface,border:`1px solid ${T.border}`,borderRadius:8,padding:'12px 14px',color:T.text,fontSize:12,fontFamily:mono,lineHeight:1.6,resize:'vertical'}}/>
          </div>
          <div style={{display:'flex',gap:10}}>
            <button onClick={createAgent} disabled={saving||!newAgentName.trim()||!newAgentContent.trim()}
              style={{background:T.green,border:'none',borderRadius:8,padding:'10px 24px',color:'#fff',fontSize:13,fontWeight:700,cursor:'pointer',opacity:saving?0.5:1}}>
              {saving?'Creating...':'Create Agent'}
            </button>
            <button onClick={()=>setShowCreate(false)}
              style={{background:'transparent',border:`1px solid ${T.border}`,borderRadius:8,padding:'10px 24px',color:T.textMuted,fontSize:13,cursor:'pointer'}}>
              Cancel
            </button>
          </div>
        </Card>
      )}

      {/* Agent List + Editor */}
      <div style={{display:'grid',gridTemplateColumns:'280px 1fr',gap:16}}>
        {/* Agent List */}
        <Card style={{padding:0,maxHeight:600,overflowY:'auto'}}>
          {agents.map(agent=>(
            <div key={agent.name} onClick={()=>selectAgent(agent.name)}
              style={{padding:'14px 16px',borderBottom:`1px solid ${T.border}`,cursor:'pointer',
                background:selectedAgent===agent.name?`${T.blue}15`:'transparent',
                borderLeft:selectedAgent===agent.name?`3px solid ${T.blue}`:'3px solid transparent'}}>
              <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
                <div>
                  <div style={{fontSize:13,fontWeight:600,color:selectedAgent===agent.name?T.blue:T.text}}>{agent.name}</div>
                  <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{agent.filename}</div>
                </div>
                <button onClick={e=>{e.stopPropagation();deleteAgent(agent.name);}}
                  style={{background:'transparent',border:'none',color:T.red,fontSize:14,cursor:'pointer',opacity:0.6,padding:4}}
                  title="Delete agent">×</button>
              </div>
            </div>
          ))}
          {agents.length===0&&(
            <div style={{padding:30,textAlign:'center',color:T.textMuted}}>
              <div style={{fontSize:24,marginBottom:8}}>🧠</div>
              <div style={{fontSize:12}}>No agents configured</div>
            </div>
          )}
        </Card>

        {/* Editor */}
        <Card style={{padding:0,display:'flex',flexDirection:'column'}}>
          {selectedAgent?(
            <>
              <div style={{padding:'12px 16px',borderBottom:`1px solid ${T.border}`,display:'flex',justifyContent:'space-between',alignItems:'center',background:T.surface}}>
                <div>
                  <div style={{fontSize:14,fontWeight:700,color:T.text}}>{selectedAgent}</div>
                  <div style={{fontSize:10,color:T.textDim}}>Edit system prompt below</div>
                </div>
                <button onClick={saveAgent} disabled={saving}
                  style={{background:T.green,border:'none',borderRadius:6,padding:'8px 20px',color:'#fff',fontSize:12,fontWeight:700,cursor:'pointer',opacity:saving?0.5:1}}>
                  {saving?'Saving...':'Save Changes'}
                </button>
              </div>
              <textarea value={editContent} onChange={e=>setEditContent(e.target.value)}
                style={{flex:1,minHeight:450,background:T.bg,border:'none',padding:'16px',color:T.text,fontSize:12,fontFamily:mono,lineHeight:1.6,resize:'none'}}/>
            </>
          ):(
            <div style={{padding:60,textAlign:'center',color:T.textMuted}}>
              <div style={{fontSize:32,marginBottom:12}}>←</div>
              <div style={{fontSize:13}}>Select an agent to edit its system prompt</div>
            </div>
          )}
        </Card>
      </div>

      {/* Help Text */}
      <Card style={{background:`${T.purple}08`,border:`1px solid ${T.purple}30`}}>
        <div style={{fontSize:12,color:T.textMuted,lineHeight:1.6}}>
          <strong style={{color:T.text}}>Agent Prompts Guide:</strong><br/>
          • Each agent has a system prompt that defines its personality and capabilities<br/>
          • Use Markdown formatting for structure (headers, lists, code blocks)<br/>
          • Include specific data sources and metrics the agent should reference<br/>
          • Define the response style (concise, detailed, data-driven, etc.)<br/>
          • List available MCP tools the agent can use
        </div>
      </Card>
    </div>
  );
}

// ── Data Import Panel (DVI file upload) ───────────────────────────────────────
function DataImportPanel({settings}){
  const mono="'JetBrains Mono',monospace";
  const [dragOver,setDragOver]=useState(false);
  const [uploading,setUploading]=useState(false);
  const [uploadResult,setUploadResult]=useState(null);
  const [dviData,setDviData]=useState(null);
  const [uploads,setUploads]=useState({uploads:[],missingDates:[],missingCount:0});
  const [error,setError]=useState(null);
  const gwUrl=settings?.gatewayUrl||'http://localhost:3001';
  const fileInputRef=useRef(null);

  // Load existing DVI data and upload history on mount
  useEffect(()=>{
    loadDVIData();
    loadUploads();
  },[]);

  const loadDVIData=async()=>{
    try{
      const resp=await fetch(`${gwUrl}/api/dvi/data`);
      if(resp.ok){
        const data=await resp.json();
        setDviData(data);
      }
    }catch(e){
      console.error('Failed to load DVI data:',e);
    }
  };

  const loadUploads=async()=>{
    try{
      const resp=await fetch(`${gwUrl}/api/dvi/uploads`);
      if(resp.ok){
        const data=await resp.json();
        setUploads(data);
      }
    }catch(e){
      console.error('Failed to load uploads:',e);
    }
  };

  const handleDrop=async(e)=>{
    e.preventDefault();
    setDragOver(false);
    const file=e.dataTransfer?.files?.[0];
    if(file) await uploadFile(file);
  };

  const handleFileSelect=async(e)=>{
    const file=e.target.files?.[0];
    if(file) await uploadFile(file);
  };

  const uploadFile=async(file)=>{
    setUploading(true);
    setError(null);
    setUploadResult(null);

    try{
      // Read file content
      const content=await file.text();

      const resp=await fetch(`${gwUrl}/api/dvi/upload`,{
        method:'POST',
        headers:{
          'Content-Type':'text/csv',
          'X-Filename':file.name
        },
        body:content
      });

      if(resp.ok){
        const result=await resp.json();
        setUploadResult(result);
        await loadDVIData();
        await loadUploads();
      }else{
        const err=await resp.json();
        setError(err.error||'Upload failed');
      }
    }catch(e){
      setError(e.message||'Upload failed');
    }
    setUploading(false);
  };

  return(
    <div style={{display:'flex',flexDirection:'column',gap:16}}>
      {/* Header */}
      <div>
        <div style={{fontSize:16,fontWeight:700,color:T.text}}>Data Import</div>
        <div style={{fontSize:11,color:T.textMuted}}>Upload DVI data files for processing (CSV format)</div>
      </div>

      {/* Upload Area */}
      <Card
        onDragOver={e=>{e.preventDefault();setDragOver(true);}}
        onDragLeave={()=>setDragOver(false)}
        onDrop={handleDrop}
        onClick={()=>fileInputRef.current?.click()}
        style={{
          padding:40,
          textAlign:'center',
          cursor:'pointer',
          border:`2px dashed ${dragOver?T.blue:T.border}`,
          background:dragOver?`${T.blue}10`:T.card,
          transition:'all 0.2s'
        }}>
        <input ref={fileInputRef} type="file" accept=".xml,.csv,.txt" onChange={handleFileSelect} style={{display:'none'}}/>
        {uploading?(
          <>
            <div style={{fontSize:32,marginBottom:12}}>⏳</div>
            <div style={{fontSize:14,fontWeight:600,color:T.text}}>Uploading...</div>
          </>
        ):(
          <>
            <div style={{fontSize:32,marginBottom:12}}>📥</div>
            <div style={{fontSize:14,fontWeight:600,color:T.text}}>Drop DVI file here (XML or CSV)</div>
            <div style={{fontSize:12,color:T.textMuted,marginTop:4}}>or click to browse</div>
          </>
        )}
      </Card>

      {/* Error */}
      {error&&(
        <Card style={{background:`${T.red}15`,border:`1px solid ${T.red}40`,padding:16}}>
          <div style={{color:T.red,fontWeight:600,fontSize:13}}>Error: {error}</div>
        </Card>
      )}

      {/* Upload Result */}
      {uploadResult&&(
        <Card style={{background:`${T.green}10`,border:`1px solid ${T.green}40`}}>
          <div style={{display:'flex',alignItems:'center',gap:10,marginBottom:12}}>
            <span style={{fontSize:20}}>✓</span>
            <div>
              <div style={{fontSize:14,fontWeight:700,color:T.green}}>Upload Successful</div>
              <div style={{fontSize:11,color:T.textMuted}}>{uploadResult.filename}</div>
            </div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'repeat(3,1fr)',gap:12}}>
            <div style={{background:T.surface,borderRadius:8,padding:12,textAlign:'center'}}>
              <div style={{fontSize:20,fontWeight:700,color:T.text}}>{uploadResult.rowCount}</div>
              <div style={{fontSize:10,color:T.textMuted}}>Rows Imported</div>
            </div>
            <div style={{background:T.surface,borderRadius:8,padding:12,textAlign:'center'}}>
              <div style={{fontSize:20,fontWeight:700,color:T.text}}>{uploadResult.columns?.length||0}</div>
              <div style={{fontSize:10,color:T.textMuted}}>Columns</div>
            </div>
            <div style={{background:T.surface,borderRadius:8,padding:12,textAlign:'center'}}>
              <div style={{fontSize:10,fontWeight:600,color:T.text,wordBreak:'break-all'}}>{new Date(uploadResult.uploadedAt).toLocaleString()}</div>
              <div style={{fontSize:10,color:T.textMuted}}>Uploaded</div>
            </div>
          </div>
          {uploadResult.columns&&(
            <div style={{marginTop:12}}>
              <div style={{fontSize:10,color:T.textMuted,marginBottom:6}}>COLUMNS DETECTED:</div>
              <div style={{fontSize:11,color:T.text,fontFamily:mono,background:T.surface,padding:8,borderRadius:6,wordBreak:'break-all'}}>
                {uploadResult.columns.join(', ')}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Current Data Status */}
      <Card>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:T.text}}>Current DVI Data</div>
          {dviData?.uploadedAt&&(
            <button onClick={async()=>{
              if(!confirm('Clear current DVI data? (Previous uploads will be archived)'))return;
              try{
                await fetch(`${gwUrl}/api/dvi/data`,{method:'DELETE'});
                setDviData(null);
                setUploadResult(null);
                await loadDVIData();
                await loadUploads();
              }catch(e){console.error(e);}
            }}
            style={{background:'transparent',border:`1px solid ${T.red}40`,borderRadius:6,padding:'6px 12px',color:T.red,fontSize:11,cursor:'pointer'}}>
              Clear Data
            </button>
          )}
        </div>
        {dviData?.uploadedAt?(
          <div>
            <div style={{background:`${T.green}15`,border:`1px solid ${T.green}40`,borderRadius:8,padding:10,marginBottom:12,display:'flex',alignItems:'center',gap:8}}>
              <span style={{fontSize:16}}>✓</span>
              <div>
                <div style={{fontSize:12,fontWeight:600,color:T.green}}>Real Data Loaded</div>
                <div style={{fontSize:10,color:T.textMuted}}>All mock data has been replaced with your uploaded data</div>
              </div>
            </div>
            <div style={{display:'grid',gridTemplateColumns:'repeat(4,1fr)',gap:12,marginBottom:12}}>
              <div style={{background:T.surface,borderRadius:8,padding:12,textAlign:'center'}}>
                <div style={{fontSize:24,fontWeight:700,color:T.blue}}>{dviData.jobs?.length||0}</div>
                <div style={{fontSize:10,color:T.textMuted}}>Total Jobs</div>
              </div>
              <div style={{background:T.surface,borderRadius:8,padding:12,textAlign:'center'}}>
                <div style={{fontSize:24,fontWeight:700,color:T.green}}>Real</div>
                <div style={{fontSize:10,color:T.textMuted}}>Data Source</div>
              </div>
              <div style={{background:T.surface,borderRadius:8,padding:12,textAlign:'center'}}>
                <div style={{fontSize:12,fontWeight:600,color:T.text}}>{dviData.filename||'—'}</div>
                <div style={{fontSize:10,color:T.textMuted}}>Source File</div>
              </div>
              <div style={{background:T.surface,borderRadius:8,padding:12,textAlign:'center'}}>
                <div style={{fontSize:10,fontWeight:600,color:T.text}}>{dviData.uploadedAt?new Date(dviData.uploadedAt).toLocaleString():'—'}</div>
                <div style={{fontSize:10,color:T.textMuted}}>Last Updated</div>
              </div>
            </div>
            {dviData.jobs?.length>0&&(
              <div>
                <div style={{fontSize:10,color:T.textMuted,marginBottom:6}}>SAMPLE DATA (first 5 rows):</div>
                <div style={{background:T.surface,borderRadius:8,padding:12,overflowX:'auto',maxHeight:200}}>
                  <pre style={{margin:0,fontSize:10,color:T.text,fontFamily:mono}}>
                    {JSON.stringify(dviData.jobs.slice(0,5),null,2)}
                  </pre>
                </div>
              </div>
            )}
          </div>
        ):(
          <div style={{textAlign:'center',padding:20,color:T.textMuted}}>
            <div style={{fontSize:24,marginBottom:8}}>📄</div>
            <div style={{fontSize:12}}>No DVI data uploaded</div>
            <div style={{fontSize:11,marginTop:4}}>Upload an XML or CSV file to see real production data</div>
          </div>
        )}
      </Card>

      {/* Upload History */}
      <Card>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:T.text}}>Upload History</div>
          <div style={{fontSize:11,color:T.textMuted}}>{uploads.totalUploads||0} uploads archived</div>
        </div>

        {/* Missing Dates Warning */}
        {uploads.missingCount>0&&(
          <div style={{background:`${T.amber}15`,border:`1px solid ${T.amber}40`,borderRadius:8,padding:12,marginBottom:12}}>
            <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:8}}>
              <span style={{fontSize:16}}>⚠️</span>
              <div style={{fontSize:12,fontWeight:600,color:T.amber}}>Missing {uploads.missingCount} days in last 30 days</div>
            </div>
            <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,display:'flex',flexWrap:'wrap',gap:4}}>
              {uploads.missingDates?.slice(0,10).map(d=>(
                <span key={d} style={{background:T.surface,padding:'2px 6px',borderRadius:4}}>{d}</span>
              ))}
              {uploads.missingDates?.length>10&&<span style={{color:T.textDim}}>+{uploads.missingDates.length-10} more</span>}
            </div>
          </div>
        )}

        {/* Upload List */}
        {uploads.uploads?.length>0?(
          <div style={{maxHeight:250,overflowY:'auto'}}>
            <table style={{width:'100%',borderCollapse:'collapse',fontSize:11}}>
              <thead>
                <tr style={{background:T.surface,position:'sticky',top:0}}>
                  <th style={{textAlign:'left',padding:'8px 10px',color:T.textMuted,fontWeight:600}}>Data Date</th>
                  <th style={{textAlign:'left',padding:'8px 10px',color:T.textMuted,fontWeight:600}}>Filename</th>
                  <th style={{textAlign:'right',padding:'8px 10px',color:T.textMuted,fontWeight:600}}>Jobs</th>
                  <th style={{textAlign:'right',padding:'8px 10px',color:T.textMuted,fontWeight:600}}>Uploaded</th>
                </tr>
              </thead>
              <tbody>
                {uploads.uploads.map((u,i)=>(
                  <tr key={u.id||i} style={{borderBottom:`1px solid ${T.border}`,background:u.isCurrent?`${T.green}10`:'transparent'}}>
                    <td style={{padding:'8px 10px',fontFamily:mono}}>
                      <span style={{color:u.dataDate?T.text:T.textDim}}>{u.dataDate||'—'}</span>
                      {u.isCurrent&&<span style={{marginLeft:6,fontSize:9,background:T.green,color:'#fff',padding:'1px 4px',borderRadius:3}}>CURRENT</span>}
                    </td>
                    <td style={{padding:'8px 10px',color:T.textMuted,maxWidth:200,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{u.filename}</td>
                    <td style={{padding:'8px 10px',textAlign:'right',fontFamily:mono,color:T.text}}>{u.rowCount?.toLocaleString()}</td>
                    <td style={{padding:'8px 10px',textAlign:'right',color:T.textDim,fontSize:10}}>{u.uploadedAt?new Date(u.uploadedAt).toLocaleString():''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ):(
          <div style={{textAlign:'center',padding:20,color:T.textMuted}}>
            <div style={{fontSize:11}}>No uploads yet</div>
          </div>
        )}
      </Card>

      {/* Help */}
      <Card style={{background:`${T.amber}08`,border:`1px solid ${T.amber}30`}}>
        <div style={{fontSize:12,color:T.textMuted,lineHeight:1.6}}>
          <strong style={{color:T.text}}>DVI Data Import Guide:</strong><br/>
          • Export your DVI data as CSV (comma-separated values)<br/>
          • First row should contain column headers<br/>
          • Common columns: job_id, order_id, stage, status, rx_type, operator, created_at<br/>
          • Data is stored in memory until live API connection is established<br/>
          • Uploaded data will be used by AI agents for analysis
        </div>
      </Card>
    </div>
  );
}

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

// ── KPI Metrics Registry ──────────────────────────────────────────────────────
// All available KPI metrics that can be added to the customizable KPI row
const KPI_METRICS = {
  incoming_jobs:     { label: "Incoming Jobs",    desc: "Yesterday's incoming work",      accent: T.blue,   category: "Production" },
  total_wip:         { label: "Total WIP",        desc: "Jobs in all queues",            accent: T.cyan,   category: "Production" },
  nel_jobs:          { label: "NEL",              desc: "Not Enough Lens - awaiting stock", accent: T.amber, category: "Production" },
  at_kardex:         { label: "At Kardex",        desc: "Jobs at Kardex pickup",         accent: T.orange, category: "Production" },
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

// Default KPI configuration (user's requested defaults)
const DEFAULT_KPIS = ['incoming_jobs', 'total_wip', 'nel_jobs', 'at_kardex', 'shipped_jobs', 'surfacing_wip', 'coating_wip', 'cutting_wip', 'assembly_wip', 'breakage'];

// KPI to AI Agent mapping
const KPI_AGENTS = {
  incoming_jobs: 'ShiftReportAgent',
  total_wip: 'ShiftReportAgent',
  nel_jobs: 'PickingAgent',
  at_kardex: 'PickingAgent',
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

// Configurable KPI Row Component
function ConfigurableKPIRow({data, settings, cardConfig, onConfigChange}){
  const [editing,setEditing]=useState(false);
  const [selectedKpis,setSelectedKpis]=useState(cardConfig?.kpis || DEFAULT_KPIS);
  const [modalKpi,setModalKpi]=useState(null); // Which KPI's job list to show
  const [modalSearch,setModalSearch]=useState('');
  const [selectedJob,setSelectedJob]=useState(null); // Selected job for detail view
  const [aiQuery,setAiQuery]=useState('');
  const [aiResponse,setAiResponse]=useState('');
  const [aiLoading,setAiLoading]=useState(false);
  const mono="'JetBrains Mono',monospace";

  // Get jobs for a specific KPI (handles both WIP XML and DVI CSV formats)
  const getJobsForKPI=(kpiId)=>{
    const {trays=[],batches=[],dviJobs=[],breakage=[],wipJobs=[]}=data||{};
    const jobs=dviJobs; // Already merged in parent
    const byStage=(stage)=>jobs.filter(j=>(j.stage||j.Stage||j.station||j.department||'').toLowerCase().includes(stage.toLowerCase()));

    switch(kpiId){
      case 'incoming_jobs': return jobs.filter(j=>{
        const station=(j.station||'').toUpperCase();
        // WIP data: check daysInLab=0 or 1
        if(j.daysInLab!==undefined) return j.daysInLab<=1;
        return station.includes('INITIATE')||station.includes('NEW WORK')||station.includes('RECEIVED');
      });
      case 'total_wip': return jobs.filter(j=>j.status!=='Completed'&&j.status!=='SHIPPED');
      case 'nel_jobs': return jobs.filter(j=>{const s=(j.station||'').toUpperCase();return s.includes('NE LENS')||s.includes('NEL')||s.includes('NOT ENOUGH');});
      case 'at_kardex': return jobs.filter(j=>{const s=(j.station||'').toUpperCase();return s.includes('AT KARDEX')||s.includes('MAN2KARDX');});
      case 'shipped_jobs': return jobs.filter(j=>(j.status==='SHIPPED'||j.stage==='SHIP'));
      case 'coating_wip':
        // WIP XML has inCoatingQueue flag
        return jobs.filter(j=>j.inCoatingQueue||byStage('COAT').includes(j)||byStage('CCL').includes(j)||byStage('CCP').includes(j));
      case 'cutting_wip': return byStage('CUT').concat(byStage('EDGER')).concat(byStage('LCU'));
      case 'assembly_wip': return byStage('ASSEMBL');
      case 'surfacing_wip': return byStage('SURF').concat(byStage('GENERATOR'));
      case 'qc_wip': return byStage('QC');
      case 'breakage':
        // WIP XML has hasBreakage flag
        return jobs.filter(j=>j.hasBreakage||(j.station||'').toUpperCase().includes('BREAKAGE'));
      case 'rush_jobs': return jobs.filter(j=>j.rush==='Y'||j.Rush==='Y'||j.priority==='RUSH');
      case 'qc_holds': return jobs.filter(j=>(j.station||'').toUpperCase().includes('QC_HOLD')||(j.status||'').includes('HOLD'));
      default: return [];
    }
  };

  // Compute KPI values from data
  const getKPIValue=(kpiId)=>{
    const {trays=[],batches=[],dviJobs=[],breakage=[],maintenance={},shippedStats={}}=data||{};
    const dviByStage=(stage)=>dviJobs.filter(j=>(j.stage||j.Stage||'').toLowerCase().includes(stage.toLowerCase())).length;

    switch(kpiId){
      case 'incoming_jobs': return {value:dviJobs.filter(j=>{const s=(j.station||'').toUpperCase();return s.includes('INITIATE')||s.includes('NEW WORK')||s.includes('INCOMING');}).length,sub:"incoming"};
      case 'total_wip': return {value:dviJobs.filter(j=>j.status!=='Completed'&&j.status!=='SHIPPED').length,sub:"in queues"};
      case 'nel_jobs': return {value:dviJobs.filter(j=>{const s=(j.station||'').toUpperCase();return s.includes('NE LENS')||s.includes('NEL')||s.includes('NOT ENOUGH');}).length,sub:"awaiting lens"};
      case 'at_kardex': return {value:dviJobs.filter(j=>{const s=(j.station||'').toUpperCase();return s.includes('AT KARDEX')||s.includes('MAN2KARDX');}).length,sub:"at pickup"};
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

  // Ask AI agent about this KPI's jobs
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
      const data=await res.json();
      setAiResponse(data.response||data.error||'No response');
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

  // Get filtered modal jobs
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
      {/* KPI Cards */}
      <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
        {selectedKpis.map(kpiId=>{
          const metric=KPI_METRICS[kpiId];
          if(!metric)return null;
          const val=getKPIValue(kpiId);
          const hasJobs=['incoming_jobs','total_wip','nel_jobs','at_kardex','shipped_jobs','coating_wip','cutting_wip','assembly_wip','surfacing_wip','qc_wip','breakage','rush_jobs'].includes(kpiId);
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

      {/* Edit Controls */}
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

      {/* Add KPI Panel */}
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

      {/* Job List Modal */}
      {modalKpi&&(
        <div style={{position:'fixed',top:0,left:0,right:0,bottom:0,background:'rgba(0,0,0,0.8)',zIndex:9999,display:'flex',alignItems:'center',justifyContent:'center',padding:20}} onClick={()=>setModalKpi(null)}>
          <div style={{background:T.surface,borderRadius:16,width:'100%',maxWidth:1200,maxHeight:'90vh',display:'flex',overflow:'hidden',border:`1px solid ${T.border}`}} onClick={e=>e.stopPropagation()}>
            {/* Job List Panel */}
            <div style={{flex:2,display:'flex',flexDirection:'column',borderRight:`1px solid ${T.border}`}}>
              {/* Header */}
              <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',gap:12}}>
                <div style={{width:12,height:12,borderRadius:3,background:KPI_METRICS[modalKpi]?.accent||T.blue}}></div>
                <div>
                  <h3 style={{margin:0,fontSize:18,fontWeight:700,color:T.text}}>{KPI_METRICS[modalKpi]?.label}</h3>
                  <p style={{margin:0,fontSize:12,color:T.textMuted}}>{modalJobs.length} jobs • {KPI_METRICS[modalKpi]?.desc}</p>
                </div>
                <button onClick={()=>setModalKpi(null)} style={{marginLeft:'auto',background:'transparent',border:'none',color:T.textDim,fontSize:20,cursor:'pointer',padding:4}}>×</button>
              </div>

              {/* Search */}
              <div style={{padding:'12px 20px',borderBottom:`1px solid ${T.border}`}}>
                <input
                  type="text"
                  placeholder="Search jobs by ID, station, date..."
                  value={modalSearch}
                  onChange={e=>setModalSearch(e.target.value)}
                  style={{width:'100%',padding:'10px 14px',background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:13,fontFamily:mono}}
                />
              </div>

              {/* Job List */}
              <div style={{flex:1,overflowY:'auto',padding:0}}>
                {modalJobs.length>0?(
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead style={{position:'sticky',top:0,background:T.surface}}>
                      <tr>
                        <th style={{padding:'10px 20px',textAlign:'left',fontSize:10,color:T.textDim,fontFamily:mono,borderBottom:`1px solid ${T.border}`}}>JOB ID</th>
                        <th style={{padding:'10px 12px',textAlign:'left',fontSize:10,color:T.textDim,fontFamily:mono,borderBottom:`1px solid ${T.border}`}}>STATION</th>
                        <th style={{padding:'10px 12px',textAlign:'left',fontSize:10,color:T.textDim,fontFamily:mono,borderBottom:`1px solid ${T.border}`}}>DATE</th>
                        <th style={{padding:'10px 12px',textAlign:'left',fontSize:10,color:T.textDim,fontFamily:mono,borderBottom:`1px solid ${T.border}`}}>STATUS</th>
                      </tr>
                    </thead>
                    <tbody>
                      {modalJobs.slice(0,100).map((j,i)=>(
                        <tr
                          key={j.job_id||i}
                          onClick={()=>setSelectedJob(j)}
                          style={{
                            borderBottom:`1px solid ${T.border}22`,
                            cursor:'pointer',
                            background:selectedJob?.job_id===j.job_id?`${KPI_METRICS[modalKpi]?.accent||T.blue}15`:'transparent',
                          }}
                          onMouseEnter={e=>{if(selectedJob?.job_id!==j.job_id)e.currentTarget.style.background=`${T.blue}08`;}}
                          onMouseLeave={e=>{if(selectedJob?.job_id!==j.job_id)e.currentTarget.style.background='transparent';}}
                        >
                          <td style={{padding:'10px 20px',fontFamily:mono,fontSize:12,fontWeight:600,color:T.text}}>{j.job_id||j.invoice||'—'}</td>
                          <td style={{padding:'10px 12px',fontFamily:mono,fontSize:11,color:T.textMuted}}>{j.station||j.stage||'—'}</td>
                          <td style={{padding:'10px 12px',fontFamily:mono,fontSize:11,color:T.textMuted}}>{j.date||'—'}</td>
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

            {/* Sidebar - Job Details or AI Agent */}
            <div style={{flex:1,minWidth:360,display:'flex',flexDirection:'column',background:T.bg}}>
              {selectedJob ? (
                /* Job Detail View */
                <>
                  {/* Header */}
                  <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`,display:'flex',alignItems:'center',justifyContent:'space-between'}}>
                    <div>
                      <div style={{fontSize:16,fontWeight:700,color:T.text,fontFamily:mono}}>{selectedJob.job_id||selectedJob.invoice||'Job Details'}</div>
                      <div style={{fontSize:11,color:T.textMuted}}>{selectedJob.station||selectedJob.stage||'—'}</div>
                    </div>
                    <button onClick={()=>setSelectedJob(null)} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:'6px 12px',fontSize:11,color:T.text,cursor:'pointer'}}>
                      ← Back
                    </button>
                  </div>

                  {/* Job Fields */}
                  <div style={{flex:1,padding:16,overflowY:'auto'}}>
                    <div style={{display:'grid',gap:12}}>
                      {Object.entries(selectedJob).filter(([k,v])=>v&&k!=='rawXml'&&typeof v!=='object').map(([key,value])=>(
                        <div key={key} style={{background:T.card,borderRadius:8,padding:'10px 14px'}}>
                          <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:4}}>{key.toUpperCase().replace(/_/g,' ')}</div>
                          <div style={{fontSize:13,color:T.text,fontFamily:mono,wordBreak:'break-all'}}>{String(value)}</div>
                        </div>
                      ))}
                      {/* Nested objects like rightEye, leftEye, frame */}
                      {Object.entries(selectedJob).filter(([k,v])=>v&&typeof v==='object'&&!Array.isArray(v)).map(([key,obj])=>(
                        <div key={key} style={{background:T.card,borderRadius:8,padding:'10px 14px'}}>
                          <div style={{fontSize:9,color:T.textDim,fontFamily:mono,letterSpacing:1,marginBottom:8}}>{key.toUpperCase().replace(/_/g,' ')}</div>
                          <div style={{display:'grid',gridTemplateColumns:'repeat(2,1fr)',gap:8}}>
                            {Object.entries(obj).map(([subKey,subVal])=>(
                              <div key={subKey}>
                                <div style={{fontSize:8,color:T.textDim,fontFamily:mono}}>{subKey}</div>
                                <div style={{fontSize:12,color:T.text,fontFamily:mono}}>{String(subVal)}</div>
                              </div>
                            ))}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>

                  {/* Ask AI about this job */}
                  <div style={{padding:16,borderTop:`1px solid ${T.border}`}}>
                    <button
                      onClick={()=>{setAiQuery(`Tell me about job ${selectedJob.job_id||selectedJob.invoice}`);setSelectedJob(null);}}
                      style={{width:'100%',padding:'10px 16px',background:T.blue,border:'none',borderRadius:8,color:'#fff',fontSize:12,fontWeight:600,cursor:'pointer'}}
                    >
                      🤖 Ask AI about this job
                    </button>
                  </div>
                </>
              ) : (
                /* AI Agent View */
                <>
                  {/* Agent Header */}
                  <div style={{padding:'16px 20px',borderBottom:`1px solid ${T.border}`}}>
                    <div style={{display:'flex',alignItems:'center',gap:8}}>
                      <span style={{fontSize:18}}>🤖</span>
                      <div>
                        <div style={{fontSize:13,fontWeight:700,color:T.text}}>{KPI_AGENTS[modalKpi]||'ShiftReportAgent'}</div>
                        <div style={{fontSize:10,color:T.textMuted}}>AI Assistant for {KPI_METRICS[modalKpi]?.label}</div>
                      </div>
                    </div>
                  </div>

                  {/* Quick Prompts */}
                  <div style={{padding:'12px 16px',borderBottom:`1px solid ${T.border}`}}>
                    <div style={{fontSize:10,color:T.textDim,marginBottom:8,fontFamily:mono}}>QUICK PROMPTS</div>
                    <div style={{display:'flex',flexWrap:'wrap',gap:6}}>
                      {[
                        `Summarize ${KPI_METRICS[modalKpi]?.label} status`,
                        'Any issues or concerns?',
                        'What needs attention?',
                        'Trend analysis'
                      ].map((prompt,i)=>(
                        <button key={i} onClick={()=>setAiQuery(prompt)} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:6,padding:'6px 10px',fontSize:10,color:T.text,cursor:'pointer'}}>
                          {prompt}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* AI Response */}
                  <div style={{flex:1,padding:16,overflowY:'auto'}}>
                    {aiResponse?(
                      <div style={{background:T.card,borderRadius:8,padding:14}}>
                        <div style={{fontSize:10,color:T.textDim,marginBottom:8,fontFamily:mono}}>AI RESPONSE</div>
                        <div style={{fontSize:13,color:T.text,lineHeight:1.5,whiteSpace:'pre-wrap'}}>{aiResponse}</div>
                      </div>
                    ):aiLoading?(
                      <div style={{textAlign:'center',color:T.textMuted,padding:20}}>
                        <div style={{fontSize:24,marginBottom:8}}>⏳</div>
                        Thinking...
                      </div>
                    ):(
                      <div style={{textAlign:'center',color:T.textDim,padding:20,fontSize:12}}>
                        Click a job to see details, or ask about these {modalJobs.length} jobs
                      </div>
                    )}
                  </div>

                  {/* Input */}
                  <div style={{padding:16,borderTop:`1px solid ${T.border}`}}>
                    <div style={{display:'flex',gap:8}}>
                      <input
                        type="text"
                        placeholder="Ask the AI agent..."
                        value={aiQuery}
                        onChange={e=>setAiQuery(e.target.value)}
                        onKeyDown={e=>{if(e.key==='Enter')askAgent();}}
                        style={{flex:1,padding:'10px 14px',background:T.card,border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:12}}
                      />
                      <button
                        onClick={askAgent}
                        disabled={aiLoading||!aiQuery.trim()}
                        style={{padding:'10px 16px',background:aiLoading||!aiQuery.trim()?T.border:T.blue,border:'none',borderRadius:8,color:'#fff',fontSize:12,fontWeight:600,cursor:aiLoading?'wait':'pointer'}}
                      >
                        Ask
                      </button>
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

  // Post outgoing via server proxy (uses bot token)
  const post=useCallback(async(text)=>{
    setStatus("sending");
    try{
      // Use server proxy endpoint which has the bot token
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
        // Filter out AI/agent queries and bot responses
        // Show regular team messages only (no /ai, @ai, /lab, or bot responses)
        const allMsgs=(data.messages||[]).filter(m=>
          m.type==="message" &&
          m.text &&
          !m.bot_id && // Exclude bot responses
          !m.text.match(/^(?:\/ai|@ai|ai:|\/lab)\b/i) && // Exclude AI commands
          !m.text.match(/<@U[A-Z0-9]+>/i) // Exclude @mentions of bots
        );

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

// ── Put Wall Tab ─────────────────────────────────────────────
function PutWallTab({putWall,setPutWall,events,wipJobs=[]}){
  const [activeWall,setActiveWall]=useState('WH1');
  const [selectedOrder,setSelectedOrder]=useState(null);

  // Fetch live Put Wall data from ItemPath
  const [putWallData,setPutWallData]=useState({WH1:{putWallCount:0,laptopCount:0,manualCount:0,totalOrders:0,putWallOrders:[]},WH2:{putWallCount:0,laptopCount:0,manualCount:0,totalOrders:0,putWallOrders:[]},status:"pending",lastSync:null});
  useEffect(()=>{
    const fetchPutWall=async()=>{
      try{
        const res=await fetch("http://localhost:3002/api/inventory/putwall");
        const data=await res.json();
        setPutWallData({
          WH1:data.WH1||{putWallCount:0,laptopCount:0,manualCount:0,totalOrders:0,putWallOrders:[]},
          WH2:data.WH2||{putWallCount:0,laptopCount:0,manualCount:0,totalOrders:0,putWallOrders:[]},
          status:data.status||"ok",
          lastSync:data.lastSync,
          note:data.note
        });
      }catch(e){
        setPutWallData(prev=>({...prev,status:"error"}));
      }
    };
    fetchPutWall();
    const iv=setInterval(fetchPutWall,10000); // Poll every 10s
    return()=>clearInterval(iv);
  },[]);

  // Calculate At Kardex count
  const atKardexJobs = wipJobs.filter(j => {
    const s = (j.station || '').toUpperCase();
    return s.includes('AT KARDEX') || s.includes('MAN2KARDX');
  });
  const atKardexCount = atKardexJobs.length;

  // Get current warehouse data
  const currentData = activeWall === 'WH1' ? putWallData.WH1 : putWallData.WH2;
  const putWallOrders = currentData?.putWallOrders || [];

  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 320px",gap:20}}>
      <div>
        {/* At Kardex header */}
        <Card style={{marginBottom:16,padding:"12px 16px",background:atKardexCount>0?`${T.amber}10`:T.card,borderColor:atKardexCount>0?T.amber:T.border}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:12}}>
              <span style={{fontSize:20}}>📦</span>
              <div>
                <div style={{fontSize:11,color:T.textMuted,fontFamily:mono,letterSpacing:1}}>AT KARDEX</div>
                <div style={{fontSize:9,color:T.textDim}}>Jobs waiting for pick</div>
              </div>
            </div>
            <div style={{fontSize:32,fontWeight:800,color:atKardexCount>0?T.amber:T.textDim,fontFamily:mono}}>{atKardexCount}</div>
          </div>
        </Card>

        {/* Wall selector tabs */}
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          {['WH1','WH2'].map(wh=>{
            const data = wh === 'WH1' ? putWallData.WH1 : putWallData.WH2;
            return(
              <button key={wh} onClick={()=>{setActiveWall(wh);setSelectedOrder(null);}} style={{
                flex:1,padding:"10px 16px",borderRadius:6,fontSize:12,fontWeight:700,fontFamily:mono,cursor:"pointer",
                background:activeWall===wh?T.blueDark:T.bg,
                border:`1px solid ${activeWall===wh?T.blue:T.border}`,
                color:activeWall===wh?T.blue:T.textMuted
              }}>
                {wh === 'WH1' ? 'WALL 1' : 'WALL 2'} ({data?.totalOrders || 0} orders)
              </button>
            );
          })}
        </div>

        {/* Order breakdown by type */}
        <Card>
          <SectionHeader right={<span style={{color:T.green,fontFamily:mono}}>{currentData?.totalOrders||0} total</span>}>
            {activeWall === 'WH1' ? 'Wall 1' : 'Wall 2'} — Active Orders
          </SectionHeader>

          {/* Stats row */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:12,marginBottom:16}}>
            <div style={{background:T.bg,borderRadius:8,padding:12,border:`1px solid ${T.green}30`,textAlign:"center"}}>
              <div style={{fontSize:24,fontWeight:800,color:T.green,fontFamily:mono}}>{currentData?.putWallCount||0}</div>
              <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,marginTop:4}}>PUT WALL</div>
            </div>
            <div style={{background:T.bg,borderRadius:8,padding:12,border:`1px solid ${T.blue}30`,textAlign:"center"}}>
              <div style={{fontSize:24,fontWeight:800,color:T.blue,fontFamily:mono}}>{currentData?.laptopCount||0}</div>
              <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,marginTop:4}}>LAPTOP</div>
            </div>
            <div style={{background:T.bg,borderRadius:8,padding:12,border:`1px solid ${T.amber}30`,textAlign:"center"}}>
              <div style={{fontSize:24,fontWeight:800,color:T.amber,fontFamily:mono}}>{currentData?.manualCount||0}</div>
              <div style={{fontSize:10,color:T.textMuted,fontFamily:mono,marginTop:4}}>MANUAL</div>
            </div>
          </div>

          {/* Put Wall orders list */}
          <div style={{marginBottom:8}}>
            <div style={{fontSize:11,color:T.textMuted,fontFamily:mono,marginBottom:8}}>PUT WALL ORDERS ({putWallOrders.length})</div>
            <div style={{maxHeight:300,overflowY:"auto"}}>
              {putWallOrders.length > 0 ? putWallOrders.slice(0,20).map((o,i)=>(
                <div key={o.orderId} onClick={()=>setSelectedOrder(o)} style={{
                  display:"flex",justifyContent:"space-between",alignItems:"center",
                  padding:"8px 10px",background:selectedOrder?.orderId===o.orderId?T.blueDark:T.bg,
                  borderRadius:6,marginBottom:4,cursor:"pointer",
                  border:`1px solid ${selectedOrder?.orderId===o.orderId?T.blue:T.border}`
                }}>
                  <div>
                    <div style={{fontSize:12,fontWeight:600,color:T.text,fontFamily:mono}}>{o.reference}</div>
                    <div style={{fontSize:10,color:T.textDim}}>{o.lineCount} lines · {o.totalQty} qty</div>
                  </div>
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:11,color:o.pendingQty>0?T.amber:T.green,fontFamily:mono}}>{o.pendingQty} pending</div>
                  </div>
                </div>
              )) : (
                <div style={{textAlign:"center",padding:24,color:T.textDim,fontSize:12}}>No Put Wall orders in queue</div>
              )}
              {putWallOrders.length > 20 && (
                <div style={{textAlign:"center",padding:8,color:T.textMuted,fontSize:10,fontFamily:mono}}>
                  +{putWallOrders.length - 20} more orders
                </div>
              )}
            </div>
          </div>

          {/* Kardex integration note */}
          <div style={{padding:"10px 12px",background:`${T.blue}10`,borderRadius:6,border:`1px dashed ${T.blue}40`,marginTop:12}}>
            <div style={{fontSize:10,color:T.blue,fontFamily:mono,textAlign:"center"}}>
              Position grid requires Kardex API integration
            </div>
          </div>
        </Card>
        <div style={{marginTop:16}}><EventLog events={events}/></div>
      </div>

      {/* Right sidebar - order details */}
      <div style={{display:"flex",flexDirection:"column",gap:12}}>
        <Card style={{borderTop:`3px solid ${T.cyan}`}}>
          <SectionHeader>{selectedOrder?`Order ${selectedOrder.reference}`:"Select an Order"}</SectionHeader>
          {selectedOrder?(
            <div>
              <div style={{fontSize:11,color:T.green,marginBottom:10,fontFamily:mono}}>● PUT WALL ORDER</div>
              <div style={{display:"grid",gridTemplateColumns:"auto 1fr",gap:"5px 12px",fontSize:12}}>
                <span style={{color:T.textDim,fontFamily:mono}}>Reference:</span>
                <span style={{color:T.text,fontWeight:700,fontFamily:mono}}>{selectedOrder.reference}</span>
                <span style={{color:T.textDim,fontFamily:mono}}>Lines:</span>
                <span style={{color:T.cyan,fontWeight:700,fontFamily:mono}}>{selectedOrder.lineCount}</span>
                <span style={{color:T.textDim,fontFamily:mono}}>Total Qty:</span>
                <span style={{color:T.amber,fontWeight:700,fontFamily:mono}}>{selectedOrder.totalQty}</span>
                <span style={{color:T.textDim,fontFamily:mono}}>Pending:</span>
                <span style={{color:selectedOrder.pendingQty>0?T.red:T.green,fontWeight:700,fontFamily:mono}}>{selectedOrder.pendingQty}</span>
                <span style={{color:T.textDim,fontFamily:mono}}>Started:</span>
                <span style={{color:T.text,fontFamily:mono,fontSize:10}}>{selectedOrder.startedAt?new Date(selectedOrder.startedAt).toLocaleString():'-'}</span>
              </div>
              <div style={{marginTop:12,padding:10,background:`${T.amber}10`,borderRadius:6,border:`1px solid ${T.amber}30`}}>
                <div style={{fontSize:10,color:T.amber,fontFamily:mono,textAlign:"center"}}>
                  Position assignment requires Kardex
                </div>
              </div>
            </div>
          ):<div style={{fontSize:12,color:T.textDim,textAlign:"center",padding:24}}>Click an order to view details</div>}
        </Card>

        <Card>
          <SectionHeader>Warehouse Summary</SectionHeader>
          {['WH1','WH2'].map(wh=>{
            const data = wh === 'WH1' ? putWallData.WH1 : putWallData.WH2;
            const total = data?.totalOrders || 0;
            const putWallPct = total > 0 ? ((data?.putWallCount || 0) / total) * 100 : 0;
            return(
              <div key={wh} style={{marginBottom:12}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                  <span style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>{wh === 'WH1' ? 'Wall 1' : 'Wall 2'}</span>
                  <span style={{fontSize:14,fontWeight:700,color:T.text,fontFamily:mono}}>{total}</span>
                </div>
                <div style={{display:"flex",gap:4}}>
                  <div style={{flex:data?.putWallCount||1,height:6,background:T.green,borderRadius:2}} title={`Put Wall: ${data?.putWallCount||0}`}/>
                  <div style={{flex:data?.laptopCount||0,height:6,background:T.blue,borderRadius:2}} title={`Laptop: ${data?.laptopCount||0}`}/>
                  <div style={{flex:data?.manualCount||0,height:6,background:T.amber,borderRadius:2}} title={`Manual: ${data?.manualCount||0}`}/>
                </div>
              </div>
            );
          })}
          <div style={{display:"flex",gap:12,marginTop:8,justifyContent:"center"}}>
            <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:8,height:8,background:T.green,borderRadius:2}}/><span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>Put Wall</span></div>
            <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:8,height:8,background:T.blue,borderRadius:2}}/><span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>Laptop</span></div>
            <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:8,height:8,background:T.amber,borderRadius:2}}/><span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>Manual</span></div>
          </div>
        </Card>

        {putWallData.lastSync && (
          <Card style={{padding:10,textAlign:"center"}}>
            <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>
              Last sync: {new Date(putWallData.lastSync).toLocaleTimeString()}
            </div>
            <div style={{fontSize:9,color:putWallData.status==="ok"?T.green:T.amber,fontFamily:mono}}>
              Status: {putWallData.status}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}

function CoatingTab({batches,trays,dviJobs=[],inspections,onBatchControl,ovenServerUrl,settings}){
  const [subView,setSubView]=useState("predictive");
  // Get coater machines from settings
  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  // Filter DVI jobs in coating (CCL, CCP, Coating stations) - exclude shipped
  const coatingJobs=useMemo(()=>{
    return dviJobs.filter(j=>{
      // Exclude shipped jobs
      if (j.status === 'SHIPPED' || j.stage === 'SHIP' || (j.station||'').toUpperCase().includes('SHIP')) return false;
      const stage=(j.stage||j.Stage||'').toUpperCase();
      const station=(j.station||'').toUpperCase();
      return stage==='COATING'||station.includes('CCL')||station.includes('CCP')||station.includes('COATING')||station.includes('RECEIVED COAT');
    });
  },[dviJobs]);

  const inProcess=coatingJobs.filter(j=>j.status==='In Progress');
  const rushJobs=coatingJobs.filter(j=>j.rush==='Y'||j.Rush==='Y');
  const contextData={
    jobs:coatingJobs,
    stagedCount:coatingJobs.length,
    inProcessCount:inProcess.length,
    rushCount:rushJobs.length,
    batches:batches,
    machines:coaterMachines,
    dviJobCount:coatingJobs.length,
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
export function ProductionStageTab({ domain, children, contextData, serverUrl, settings }) {
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
// ── Job Detail Panel (reusable across production tabs) ───────
// ══════════════════════════════════════════════════════════════
function JobDetailPanel({ job, onClose }) {
  const mono = "'JetBrains Mono',monospace";
  if (!job) return null;

  // Group fields for display
  const orderFields = ['invoice', 'tray', 'reference', 'rxNumber', 'operator', 'jobOrigin'];
  const dateFields = ['entryDate', 'entryTime', 'shipDate', 'shipTime', 'daysInLab'];
  const lensFields = ['matR', 'matL', 'styleR', 'typeR', 'pickR', 'pickL', 'coatR', 'coatL'];
  const frameFields = ['frameName', 'frameColor'];
  const statusFields = ['department', 'station', 'stage', 'status', 'inCoatingQueue', 'coatingWaitDays'];

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

  const renderSection = (title, fields) => {
    const items = fields.map(f => renderField(f, job[f])).filter(Boolean);
    if (items.length === 0) return null;
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>{title}</div>
        {items}
      </div>
    );
  };

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: T.surface, borderLeft: `1px solid ${T.border}`, zIndex: 1000, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px #00000040' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{job.invoice || job.job_id || 'Job Details'}</div>
          <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>{job.frameName || job.station || ''}</div>
        </div>
        <button onClick={onClose} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 12px', color: T.textMuted, cursor: 'pointer', fontSize: 12 }}>✕ Close</button>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {renderSection('Order Info', orderFields)}
        {renderSection('Dates', dateFields)}
        {renderSection('Lens', lensFields)}
        {renderSection('Frame', frameFields)}
        {renderSection('Status', statusFields)}

        {/* Breakage info if present */}
        {job.hasBreakage && (
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 10, fontWeight: 700, color: T.red, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>⚠ BREAKAGE ({job.breakageCount})</div>
            {job.breakageItems?.map((b, i) => (
              <div key={i} style={{ background: `${T.red}11`, border: `1px solid ${T.red}33`, borderRadius: 6, padding: 10, marginBottom: 8, fontSize: 11, fontFamily: mono }}>
                <div style={{ color: T.text }}>{b.date} {b.time} — {b.dept}</div>
                <div style={{ color: T.textMuted }}>Reason: {b.reason} | Part: {b.part} | Inspector: {b.inspector || '—'}</div>
              </div>
            ))}
          </div>
        )}

        {/* All other fields */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>All Fields</div>
          {Object.entries(job).filter(([k]) => !['breakageItems'].includes(k)).map(([k, v]) => renderField(k, v))}
        </div>
      </div>
    </div>
  );
}

// ── Item Image Component (handles Limble image format) ────────
// ══════════════════════════════════════════════════════════════
function ItemImage({ item }) {
  const [imgState, setImgState] = useState('loading'); // loading, loaded, error, none

  // Extract image URL from various formats
  let imageUrl = null;
  if (Array.isArray(item.image) && item.image.length > 0) {
    // Limble format: [{fileName: "...", link: "https://..."}]
    imageUrl = item.image[0]?.link || item.image[0]?.url || item.image[0];
  } else if (typeof item.image === 'string' && item.image) {
    imageUrl = item.image;
  } else if (item.imageUrl) {
    imageUrl = item.imageUrl;
  } else if (item.imageURL) {
    imageUrl = item.imageURL;
  } else if (item.photo) {
    imageUrl = Array.isArray(item.photo) ? (item.photo[0]?.link || item.photo[0]) : item.photo;
  } else if (item.thumbnail) {
    imageUrl = item.thumbnail;
  } else if (item.images && Array.isArray(item.images) && item.images.length > 0) {
    imageUrl = item.images[0]?.link || item.images[0]?.url || item.images[0];
  }

  // Also check for Limble-style fields
  if (!imageUrl && item.partImages && Array.isArray(item.partImages) && item.partImages.length > 0) {
    imageUrl = item.partImages[0]?.link || item.partImages[0];
  }

  useEffect(() => {
    if (!imageUrl) {
      setImgState('none');
    } else {
      setImgState('loading');
    }
  }, [imageUrl]);

  if (!imageUrl) return null;

  return (
    <div style={{ marginBottom: 20, textAlign: 'center' }}>
      {imgState === 'loading' && (
        <div style={{ padding: 20, background: T.card, borderRadius: 8, border: `1px solid ${T.border}`, color: T.textDim, fontSize: 12 }}>
          Loading image...
        </div>
      )}
      {imgState === 'error' && imageUrl && (
        <div style={{ padding: 16, background: `${T.card}`, borderRadius: 8, border: `1px solid ${T.border}`, textAlign: 'center' }}>
          <div style={{ color: T.textDim, fontSize: 11, marginBottom: 10 }}>Image blocked by browser (CORS)</div>
          <a
            href={imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '8px 16px',
              background: T.blue,
              color: '#fff',
              borderRadius: 6,
              textDecoration: 'none',
              fontSize: 12,
              fontWeight: 600
            }}
          >
            🖼️ View Image in New Tab
          </a>
        </div>
      )}
      <img
        src={imageUrl}
        alt={item.name || item.sku || 'Part image'}
        style={{
          maxWidth: '100%',
          maxHeight: 200,
          borderRadius: 8,
          border: `1px solid ${T.border}`,
          objectFit: 'contain',
          background: T.bg,
          display: imgState === 'loaded' ? 'inline-block' : 'none'
        }}
        onLoad={() => setImgState('loaded')}
        onError={() => setImgState('error')}
      />
    </div>
  );
}

// ── Inventory Detail Panel (reusable for inventory/parts) ─────
// ══════════════════════════════════════════════════════════════
export function InventoryDetailPanel({ item, onClose, title = "Item Details" }) {
  const mono = "'JetBrains Mono',monospace";
  if (!item) return null;

  // Group fields for display
  const identFields = ['sku', 'id', 'name', 'description', 'barcode', 'partNumber'];
  const stockFields = ['qty', 'qtyAvailable', 'qtyReserved', 'reorderPoint', 'minQty', 'maxQty', 'safetyStock'];
  const locationFields = ['location', 'warehouse', 'bin', 'zone', 'aisle', 'shelf', 'vlm', 'carousel'];
  const categoryFields = ['coatingType', 'index', 'material', 'category', 'type', 'class', 'group'];
  const supplierFields = ['supplier', 'vendor', 'leadTime', 'cost', 'price', 'lastPurchase'];
  const physicalFields = ['diameter', 'thickness', 'weight', 'dimensions', 'uom', 'unit'];

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

  // Determine stock status
  const isOutOfStock = item.qty === 0;
  const isLowStock = item.qty > 0 && item.qty <= (item.reorderPoint || 10);
  const stockColor = isOutOfStock ? T.red : isLowStock ? T.amber : T.green;
  const stockLabel = isOutOfStock ? 'OUT OF STOCK' : isLowStock ? 'LOW STOCK' : 'IN STOCK';

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: T.surface, borderLeft: `1px solid ${T.border}`, zIndex: 1000, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px #00000040' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{item.sku || item.name || title}</div>
          <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono, marginTop: 2 }}>{item.name?.slice(0, 50) || item.description?.slice(0, 50) || ''}</div>
        </div>
        <button onClick={onClose} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 12px', color: T.textMuted, cursor: 'pointer', fontSize: 12 }}>✕ Close</button>
      </div>

      {/* Stock Status Banner */}
      <div style={{ padding: '12px 20px', background: `${stockColor}15`, borderBottom: `1px solid ${stockColor}40`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: stockColor }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: stockColor, fontFamily: mono }}>{stockLabel}</span>
        </div>
        <div style={{ fontSize: 28, fontWeight: 900, color: stockColor, fontFamily: mono }}>{item.qty ?? '—'}</div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        {/* Item Image */}
        <ItemImage item={item} />

        {renderSection('Identification', identFields)}
        {renderSection('Stock Levels', stockFields)}
        {renderSection('Location', locationFields)}
        {renderSection('Category', categoryFields)}
        {renderSection('Physical', physicalFields)}
        {renderSection('Supplier', supplierFields)}

        {/* All other fields */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>All Fields</div>
          {Object.entries(item).map(([k, v]) => renderField(k, v))}
        </div>
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Surfacing Tab ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function SurfacingTab({ trays, dviJobs=[], ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";
  const [selectedJob, setSelectedJob] = useState(null);
  const [search,setSearch]=useState('');

  // Filter DVI jobs in surfacing (GENERATOR, AUTO BLKER, DIGITAL CALC stations) - exclude shipped
  const surfacingJobs = useMemo(() => {
    return dviJobs.filter(j => {
      // Exclude shipped jobs
      if (j.status === 'SHIPPED' || j.stage === 'SHIP' || (j.station||'').toUpperCase().includes('SHIP')) return false;
      const stage = (j.stage || j.Stage || '').toUpperCase();
      const station = (j.station || '').toUpperCase();
      return stage === 'SURFACING' || station.includes('GENERATOR') || station.includes('AUTO BLKER') || station.includes('DIGITAL CALC');
    });
  }, [dviJobs]);

  // Search filter
  const filteredJobs = useMemo(() => {
    if (!search) return surfacingJobs;
    const q = search.toLowerCase();
    return surfacingJobs.filter(j =>
      (j.job_id||'').toLowerCase().includes(q) ||
      (j.station||'').toLowerCase().includes(q) ||
      (j.invoice||'').toLowerCase().includes(q)
    );
  }, [surfacingJobs, search]);

  const rushJobs = surfacingJobs.filter(j => j.rush === 'Y' || j.Rush === 'Y');
  const inProcess = surfacingJobs.filter(j => j.status === 'In Progress');

  const contextData = {
    jobs: surfacingJobs,
    queueCount: surfacingJobs.length,
    inProcessCount: inProcess.length,
    rushCount: rushJobs.length,
    holdCount: 0,
  };

  return (
    <ProductionStageTab domain="surfacing" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>🌀 Surfacing</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Lens surfacing and grinding operations • {surfacingJobs.length} jobs from DVI</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>TOTAL WIP</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{surfacingJobs.length}</div>
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

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search jobs by ID, station, invoice..."
          value={search}
          onChange={e=>setSearch(e.target.value)}
          style={{ width: '100%', maxWidth: 400, padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }}
        />
      </div>

      {/* WIP Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${filteredJobs.length} jobs`}>WIP Queue</SectionHeader>
        {filteredJobs.length > 0 ? (
          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: 'sticky', top: 0, background: T.surface }}>
                <tr style={{ background: T.bg }}>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB ID</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATION</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>DATE</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.slice(0, 50).map((j,i) => (
                  <tr key={j.job_id||j.invoice||i} onClick={()=>setSelectedJob(j)} style={{ borderBottom: `1px solid ${T.border}`, background: selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : "transparent", cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e=>e.currentTarget.style.background=`${T.blue}10`} onMouseLeave={e=>e.currentTarget.style.background=selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : 'transparent'}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {j.job_id || j.invoice || "—"} {(j.rush==='Y') && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.station || j.stage || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.date || j.entryDate || "—"}</td>
                    <td style={{ padding: "10px 12px" }}><Pill color={j.status==='SHIPPED'?T.green:T.blue}>{j.status||'WIP'}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file at /api/dvi/upload or check DVI SOAP connection.' : 'No jobs in surfacing'}
          </div>
        )}
      </Card>

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Cutting Tab ───────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function CuttingTab({ trays, dviJobs=[], breakage, ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";
  const [selectedJob, setSelectedJob] = useState(null);
  const [search,setSearch]=useState('');

  // Filter DVI jobs in cutting (EDGER, LCU stations) - exclude shipped
  const cuttingJobs = useMemo(() => {
    return dviJobs.filter(j => {
      // Exclude shipped jobs
      if (j.status === 'SHIPPED' || j.stage === 'SHIP' || (j.station||'').toUpperCase().includes('SHIP')) return false;
      const stage = (j.stage || j.Stage || '').toUpperCase();
      const station = (j.station || '').toUpperCase();
      return stage === 'CUTTING' || station.includes('EDGER') || station.includes('LCU');
    });
  }, [dviJobs]);

  // Search filter
  const filteredJobs = useMemo(() => {
    if (!search) return cuttingJobs;
    const q = search.toLowerCase();
    return cuttingJobs.filter(j =>
      (j.job_id||'').toLowerCase().includes(q) ||
      (j.station||'').toLowerCase().includes(q) ||
      (j.invoice||'').toLowerCase().includes(q)
    );
  }, [cuttingJobs, search]);

  const rushJobs = cuttingJobs.filter(j => j.rush === 'Y' || j.Rush === 'Y');
  const inProcess = cuttingJobs.filter(j => j.status === 'In Progress');

  // Recent breaks in cutting
  const cuttingBreaks = (breakage || []).filter(b => b.dept === "CUTTING").slice(0, 10);

  const contextData = {
    jobs: cuttingJobs,
    queueCount: cuttingJobs.length,
    inProcessCount: inProcess.length,
    rushCount: rushJobs.length,
    holdCount: 0,
    recentBreaks: cuttingBreaks,
  };

  return (
    <ProductionStageTab domain="cutting" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>✂️ Cutting / Edging</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Lens cutting and edging operations • {cuttingJobs.length} jobs from DVI</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>TOTAL WIP</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{cuttingJobs.length}</div>
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

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search jobs by ID, station, invoice..."
          value={search}
          onChange={e=>setSearch(e.target.value)}
          style={{ width: '100%', maxWidth: 400, padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }}
        />
      </div>

      {/* WIP Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${filteredJobs.length} jobs`}>WIP Queue</SectionHeader>
        {filteredJobs.length > 0 ? (
          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: 'sticky', top: 0, background: T.surface }}>
                <tr style={{ background: T.bg }}>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB ID</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATION</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>DATE</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.slice(0, 50).map((j,i) => (
                  <tr key={j.job_id||j.invoice||i} onClick={()=>setSelectedJob(j)} style={{ borderBottom: `1px solid ${T.border}`, background: selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : "transparent", cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e=>e.currentTarget.style.background=`${T.blue}10`} onMouseLeave={e=>e.currentTarget.style.background=selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : 'transparent'}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {j.job_id || j.invoice || "—"} {(j.rush==='Y') && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.station || j.stage || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.date || j.entryDate || "—"}</td>
                    <td style={{ padding: "10px 12px" }}><Pill color={j.status==='SHIPPED'?T.green:T.blue}>{j.status||'WIP'}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file or check DVI SOAP connection.' : 'No jobs in cutting'}
          </div>
        )}
      </Card>

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}

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
function AssemblyTab({ trays, dviJobs=[], ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";
  const [selectedJob, setSelectedJob] = useState(null);
  const [search,setSearch]=useState('');

  // Filter DVI jobs in assembly (ASSEMBLY stations) - exclude shipped
  const assemblyJobs = useMemo(() => {
    return dviJobs.filter(j => {
      // Exclude shipped jobs
      if (j.status === 'SHIPPED' || j.stage === 'SHIP' || (j.station||'').toUpperCase().includes('SHIP')) return false;
      const stage = (j.stage || j.Stage || '').toUpperCase();
      const station = (j.station || '').toUpperCase();
      return stage === 'ASSEMBLY' || station.includes('ASSEMBLY');
    });
  }, [dviJobs]);

  // Search filter
  const filteredJobs = useMemo(() => {
    if (!search) return assemblyJobs;
    const q = search.toLowerCase();
    return assemblyJobs.filter(j =>
      (j.job_id||'').toLowerCase().includes(q) ||
      (j.station||'').toLowerCase().includes(q) ||
      (j.invoice||'').toLowerCase().includes(q)
    );
  }, [assemblyJobs, search]);

  const rushJobs = assemblyJobs.filter(j => j.rush === 'Y' || j.Rush === 'Y');
  const passJobs = assemblyJobs.filter(j => (j.station||'').includes('PASS'));
  const failJobs = assemblyJobs.filter(j => (j.station||'').includes('FAIL'));

  const contextData = {
    jobs: assemblyJobs,
    queueCount: assemblyJobs.length,
    inProcessCount: assemblyJobs.length - passJobs.length - failJobs.length,
    rushCount: rushJobs.length,
    holdCount: failJobs.length,
    completedToday: passJobs.length,
  };

  return (
    <ProductionStageTab domain="assembly" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>🔧 Assembly</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Frame assembly and final inspection • {assemblyJobs.length} jobs from DVI</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>TOTAL WIP</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{assemblyJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>PASSED</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{passJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>FAILED</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: failJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{failJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>RUSH</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: rushJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{rushJobs.length}</div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search jobs by ID, station, invoice..."
          value={search}
          onChange={e=>setSearch(e.target.value)}
          style={{ width: '100%', maxWidth: 400, padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }}
        />
      </div>

      {/* WIP Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${filteredJobs.length} jobs`}>WIP Queue</SectionHeader>
        {filteredJobs.length > 0 ? (
          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: 'sticky', top: 0, background: T.surface }}>
                <tr style={{ background: T.bg }}>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB ID</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATION</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>DATE</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.slice(0, 50).map((j,i) => (
                  <tr key={j.job_id||j.invoice||i} onClick={()=>setSelectedJob(j)} style={{ borderBottom: `1px solid ${T.border}`, background: selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : (j.station||'').includes('FAIL') ? `${T.amber}08` : "transparent", cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e=>e.currentTarget.style.background=`${T.blue}10`} onMouseLeave={e=>e.currentTarget.style.background=selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : (j.station||'').includes('FAIL') ? `${T.amber}08` : 'transparent'}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {j.job_id || j.invoice || "—"} {(j.rush==='Y') && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.station || j.stage || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.date || j.entryDate || "—"}</td>
                    <td style={{ padding: "10px 12px" }}>
                      <Pill color={(j.station||'').includes('PASS')?T.green:(j.station||'').includes('FAIL')?T.red:T.blue}>
                        {(j.station||'').includes('PASS')?'PASS':(j.station||'').includes('FAIL')?'FAIL':'WIP'}
                      </Pill>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file or check DVI SOAP connection.' : 'No jobs in assembly'}
          </div>
        )}
      </Card>

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Shipping Tab ──────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function ShippingTab({ trays, dviJobs=[], shippedStats={}, ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";
  const [selectedJob, setSelectedJob] = useState(null);
  const [search,setSearch]=useState('');

  // Filter DVI jobs in shipping (SH CONVEY stations) - exclude already shipped jobs (they're in DB)
  const shippingJobs = useMemo(() => {
    return dviJobs.filter(j => {
      const stage = (j.stage || j.Stage || '').toUpperCase();
      const station = (j.station || '').toUpperCase();
      // Only include jobs in shipping stage that haven't been shipped yet
      return (stage === 'SHIPPING' || station.includes('SH CONVEY')) && j.status !== 'SHIPPED';
    });
  }, [dviJobs]);

  // Search filter
  const filteredJobs = useMemo(() => {
    if (!search) return shippingJobs;
    const q = search.toLowerCase();
    return shippingJobs.filter(j =>
      (j.job_id||'').toLowerCase().includes(q) ||
      (j.station||'').toLowerCase().includes(q) ||
      (j.invoice||'').toLowerCase().includes(q)
    );
  }, [shippingJobs, search]);

  const rushJobs = shippingJobs.filter(j => j.rush === 'Y' || j.Rush === 'Y');

  const contextData = {
    jobs: shippingJobs,
    readyCount: shippingJobs.length,
    inProcessCount: shippingJobs.length,
    rushCount: rushJobs.length,
    overdueCount: 0,
    shippedToday: shippedStats.today || 0,
  };

  return (
    <ProductionStageTab domain="shipping" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      {/* Stage Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>📤 Shipping</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Final QC and shipment processing • {shippingJobs.length} jobs from DVI</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>IN QUEUE</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{shippingJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>SHIPPED TODAY</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{shippedStats.today || 0}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>YESTERDAY</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.textMuted, fontFamily: mono }}>{shippedStats.yesterday || 0}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>RUSH</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: rushJobs.length > 0 ? T.red : T.green, fontFamily: mono }}>{rushJobs.length}</div>
          </div>
        </div>
      </div>

      {/* Search */}
      <div style={{ marginBottom: 16 }}>
        <input
          type="text"
          placeholder="Search jobs by ID, station, invoice..."
          value={search}
          onChange={e=>setSearch(e.target.value)}
          style={{ width: '100%', maxWidth: 400, padding: '10px 14px', background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }}
        />
      </div>

      {/* Jobs Queue */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${filteredJobs.length} jobs`}>Shipping Queue</SectionHeader>
        {filteredJobs.length > 0 ? (
          <div style={{ maxHeight: 500, overflowY: 'auto' }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead style={{ position: 'sticky', top: 0, background: T.surface }}>
                <tr style={{ background: T.bg }}>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>JOB ID</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATION</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>DATE</th>
                  <th style={{ padding: "10px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>STATUS</th>
                </tr>
              </thead>
              <tbody>
                {filteredJobs.slice(0, 50).map((j,i) => (
                  <tr key={j.job_id||j.invoice||i} onClick={()=>setSelectedJob(j)} style={{ borderBottom: `1px solid ${T.border}`, background: selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : "transparent", cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e=>e.currentTarget.style.background=`${T.blue}10`} onMouseLeave={e=>e.currentTarget.style.background=selectedJob?.invoice===j.invoice ? `${T.blue}15` : (j.rush==='Y') ? `${T.red}08` : 'transparent'}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {j.job_id || j.invoice || "—"} {(j.rush==='Y') && <span style={{ color: T.red }}>🔴</span>}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.station || j.stage || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.date || j.entryDate || "—"}</td>
                    <td style={{ padding: "10px 12px" }}><Pill color={j.status==='SHIPPED'?T.green:T.blue}>{j.status||'WIP'}</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file or check DVI SOAP connection.' : 'No jobs in shipping'}
          </div>
        )}
      </Card>

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}
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
function LabAssistantV2(){
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

  // DVI jobs from gateway + shipped stats
  const [dviJobs,setDviJobs]=useState([]);
  const [shippedStats,setShippedStats]=useState({today:0,yesterday:0,thisWeek:0});
  const [wipJobs,setWipJobs]=useState([]);

  // Load WIP data from localStorage (populated by WIPFeed component)
  useEffect(()=>{
    const loadWipData=()=>{
      try{
        const saved=localStorage.getItem('la_wip_data_v1');
        if(saved){
          const parsed=JSON.parse(saved);
          if(parsed.jobs&&parsed.jobs.length>0){
            setWipJobs(parsed.jobs);
            console.log(`[App] Loaded ${parsed.jobs.length} WIP jobs from localStorage`);
          }
        }
      }catch(e){
        console.warn("WIP load failed:",e.message);
      }
    };
    loadWipData();
    // Listen for storage changes
    const handleStorage=(e)=>{ if(e.key==='la_wip_data_v1') loadWipData(); };
    window.addEventListener('storage',handleStorage);
    const iv=setInterval(loadWipData,30000);
    return()=>{ window.removeEventListener('storage',handleStorage); clearInterval(iv); };
  },[]);

  // Fetch DVI data from gateway
  useEffect(()=>{
    const fetchDvi=async()=>{
      try{
        const res=await fetch("http://localhost:3001/api/dvi/data");
        if(res.ok){
          const data=await res.json();
          // Filter out CANCELED jobs
          const jobs=(data?.jobs||[]).filter(j=>j.stage!=='CANCELED'&&j.station!=='CANCELED');
          setDviJobs(jobs);
          // Update shipped stats if available
          if(data.shipped){
            setShippedStats(data.shipped);
          }
        }
      }catch(e){ console.warn("DVI fetch:",e.message); }
    };
    fetchDvi();
    const iv=setInterval(fetchDvi,120000);
    return()=>clearInterval(iv);
  },[]);

  // Use DVI jobs as single source of truth (from /api/dvi/data)
  // localStorage WIP data is deprecated - API now handles all WIP
  const mergedJobs=useMemo(()=>{
    // Filter out CANCELED and SHIPPED jobs for WIP display
    const wip = dviJobs.filter(j => {
      if (j.station === 'CANCELED' || j.stage === 'CANCELED') return false;
      if (j.status === 'SHIPPED' || j.stage === 'SHIPPED') return false;
      return true;
    });
    console.log(`[App] WIP jobs from API: ${wip.length} (total dviJobs: ${dviJobs.length})`);
    return wip;
  },[dviJobs]);

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
    {id:"wip",         label:"WIP Feed",    icon:"📋", group:"analytics"},
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
        {view==="overview"&&<OverviewTab trays={trays} putWall={putWall} batches={batches} events={events} messages={messages} onSendMessage={sendMessage} onBatchControl={handleBatchControl} settings={settings} breakage={breakage} dviJobs={mergedJobs} wipJobs={wipJobs} shippedStats={shippedStats}/>}
        {view==="putwall"&&<PutWallTab putWall={putWall} setPutWall={setPutWall} events={events} wipJobs={wipJobs}/>}
        {view==="coating"&&<CoatingTab batches={batches} trays={trays} dviJobs={mergedJobs} inspections={inspections} onBatchControl={handleBatchControl} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="surfacing"&&<SurfacingTab trays={trays} dviJobs={mergedJobs} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="cutting"&&<CuttingTab trays={trays} dviJobs={mergedJobs} breakage={breakage} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="assembly"&&<AssemblyTab trays={trays} dviJobs={mergedJobs} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="shipping"&&<ShippingTab trays={trays} dviJobs={mergedJobs} shippedStats={shippedStats} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="inventory"&&<InventoryTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="maintenance"&&<MaintenanceTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="analytics"&&<AnalyticsTab batches={batches} trays={trays} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="qc"&&<QCTab trays={trays} breakage={breakage} setBreakage={setBreakage}/>}
        {view==="wip"&&<WIPFeed/>}
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

// Wrap the entire app in ErrorBoundary at export level
export default function App() {
  return (
    <ErrorBoundary>
      <LabAssistantV2 />
    </ErrorBoundary>
  );
}
