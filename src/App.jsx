import { useState, useEffect, useCallback, useMemo, useRef, Component } from "react";
// WIPFeed removed — WIP monitoring now in EWS + Analytics tabs
// Extracted tab components (reduces App.jsx by ~5,600 lines)
import SettingsTab from "./components/tabs/SettingsTab";
import OverviewTab from "./components/tabs/OverviewTab";
import InventoryTab from "./components/tabs/InventoryTab";
import MaintenanceTab from "./components/tabs/MaintenanceTab";
import AnalyticsTab from "./components/tabs/AnalyticsTab";
import LensScanner from "./components/LensScanner";

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
  const gatewayUrl = settings?.gatewayUrl || `http://${window.location.hostname}:3001`;

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
  gatewayUrl: `http://${window.location.hostname}:3001`, // MCP Gateway URL — uses current hostname for network access
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
  serverUrl: `http://${window.location.hostname}:3002`,
  slackWebhook: '',
  demoMode: false,
};

const mono = "'JetBrains Mono','Fira Code',monospace";
const sans = "'Outfit','DM Sans',system-ui,sans-serif";


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

// No mock data generators — all data comes from live APIs

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
    const gwUrl = settings?.gatewayUrl || `http://${window.location.hostname}:3001`;
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
  const gwUrl=settings?.gatewayUrl||`http://${window.location.hostname}:3001`;

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
  const gwUrl=settings?.gatewayUrl||`http://${window.location.hostname}:3001`;
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
  assembled_today:   { label: "Assembled",       desc: "Jobs assembled today",          accent: T.green,  category: "Department" },
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
  picks_today:       { label: "Picks Today",     desc: "Kardex picks completed today",  accent: T.blue,   category: "Production" },
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
  // NOTE: coating_wip = DVI stage COAT + stations CCL/CCP (jobs physically in coating zone)
  // This is distinct from oven rack count which tracks batches currently in oven
  // trays-based KPIs (qc_holds, active_trays) fall back to DVI data when trays not yet wired
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
      case 'assembled_today': { const as=data?.assemblyStats||{}; return {value:as.assembledToday||0,sub:`pass: ${as.passToday||0} · fail: ${as.failToday||0}`}; }
      case 'surfacing_wip': return {value:dviByStage('SURF')+dviJobs.filter(j=>(j.station||'').includes('GENERATOR')).length,sub:"in surfacing"};
      case 'qc_wip': return {value:dviByStage('QC'),sub:"in QC"};
      case 'breakage': return {value:dviJobs.filter(j=>(j.station||'').toUpperCase().includes('BREAKAGE')).length,sub:"today",accent:T.red};
      case 'rush_jobs': return {value:dviJobs.filter(j=>j.rush==='Y'||j.Rush==='Y'||j.priority==='RUSH').length,sub:"in system"};
      case 'qc_holds': return {value:dviJobs.filter(j=>(j.station||'').toUpperCase().includes('QC_HOLD')||((j.stage||'').toUpperCase()==='QC'&&(j.status||'').toUpperCase()==='HOLD')).length,sub:"held"};
      case 'active_trays': return {value:dviJobs.filter(j=>j.status!=='Completed'&&j.status!=='SHIPPED').length,sub:"active jobs"};
      case 'avg_batch_fill': return {value:`${batches.length>0?Math.round(batches.reduce((s,b)=>s+(b.jobs||0),0)/batches.length*100/14):0}%`,sub:"of capacity"}; // 14 = max jobs per coating batch rack
      case 'pm_compliance': return {value:maintenance.stats?.pmCompliancePercent!=null?`${maintenance.stats.pmCompliancePercent}%`:'—',sub:"on schedule"};
      case 'open_work_orders': return {value:maintenance.stats?.openWorkOrders||0,sub:"open"};
      case 'equipment_uptime': return {value:maintenance.stats?.uptimePercent!=null?`${maintenance.stats.uptimePercent}%`:'—',sub:"availability"};
      case 'picks_today': { const ps=data.pickStats||{}; const total=(ps.WH1||0)+(ps.WH2||0); return {value:total,sub:`WH1: ${ps.WH1||0} · WH2: ${ps.WH2||0}`}; }
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
      const context=`KPI: ${KPI_METRICS[modalKpi]?.label}\nUse your MCP tools to get real data for this KPI. Do not use any sample or mock data.`;
      const res=await fetch(`http://${window.location.hostname}:3001/web/ask-sync`,{
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
    proxyUrl:`http://${window.location.hostname}:3001/api/slack/messages?channel=C0AJH9LG96D`,
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
      const sendUrl=cfg.proxyUrl?.replace('/messages','/send').split('?')[0] || `http://${window.location.hostname}:3001/api/slack/send`;
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
  { type:"kardex_picks",       label:"Kardex Picks",          icon:"📦", desc:"Pick jobs today + hourly bar chart by warehouse (WH1/WH2)" },
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
        const res=await fetch(`http://${window.location.hostname}:3002/api/inventory/putwall`);
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

const COATING_CONFIG_DEFAULTS={rackSize:36,ovenCount:6,racksPerOven:7,ovenRunHours:3,eb9Capacity:114,e14Capacity:274,runNowPct:75,runPartialPct:50,waitWindowMin:30};

function CoatingTab({batches,trays,dviJobs=[],inspections,onBatchControl,ovenServerUrl,settings}){
  const [subView,setSubView]=useState("intelligence");
  const [intel,setIntel]=useState(null);
  const [intelError,setIntelError]=useState(null);
  const [batchEdits,setBatchEdits]=useState(()=>{try{return JSON.parse(localStorage.getItem("la_coating_batches")||"{}")}catch{return{}}});
  const [lastFetch,setLastFetch]=useState(null);
  const [coatingConfig,setCoatingConfig]=useState(()=>{try{return{...COATING_CONFIG_DEFAULTS,...JSON.parse(localStorage.getItem("la_coating_config")||"{}")}}catch{return{...COATING_CONFIG_DEFAULTS}}});

  // Persist config
  useEffect(()=>{localStorage.setItem("la_coating_config",JSON.stringify(coatingConfig));},[coatingConfig]);

  // Poll coating intelligence endpoint with config as query params
  useEffect(()=>{
    const base=ovenServerUrl||`http://${window.location.hostname}:3002`;
    let active=true;
    const poll=async()=>{
      try{
        const params=new URLSearchParams();
        Object.entries(coatingConfig).forEach(([k,v])=>params.set(k,v));
        const r=await fetch(`${base}/api/coating/intelligence?${params}`);
        if(!r.ok) throw new Error(`${r.status}`);
        const data=await r.json();
        if(active){setIntel(data);setIntelError(null);setLastFetch(Date.now());}
      }catch(e){if(active)setIntelError(e.message);}
    };
    poll();
    const iv=setInterval(poll,30000);
    return()=>{active=false;clearInterval(iv);};
  },[ovenServerUrl,coatingConfig]);

  // Save batch edits to localStorage
  useEffect(()=>{localStorage.setItem("la_coating_batches",JSON.stringify(batchEdits));},[batchEdits]);

  const coatingJobs=useMemo(()=>{
    return dviJobs.filter(j=>{
      if(j.status==='SHIPPED'||j.stage==='SHIP'||(j.station||'').toUpperCase().includes('SHIP')) return false;
      const stage=(j.stage||j.Stage||'').toUpperCase();
      const station=(j.station||'').toUpperCase();
      return stage==='COATING'||station.includes('CCL')||station.includes('CCP')||station.includes('COATING')||station.includes('RECEIVED COAT');
    });
  },[dviJobs]);

  const rushJobs=coatingJobs.filter(j=>j.rush==='Y'||j.Rush==='Y');
  const contextData={
    jobs:coatingJobs,
    stagedCount:coatingJobs.length,
    rushCount:rushJobs.length,
    intel,
    dviJobCount:coatingJobs.length,
  };

  return(
    <ProductionStageTab domain="coating" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
    <div>
      <div style={{display:"flex",gap:4,marginBottom:16}}>
        {[{id:"intelligence",label:"Coating",icon:"🎨"},{id:"pipeline",label:"Pipeline",icon:"🔗"},{id:"config",label:"Rules",icon:"⚙"}].map(sv=>(
          <button key={sv.id} onClick={()=>setSubView(sv.id)} style={{background:subView===sv.id?T.blueDark:"transparent",border:`1px solid ${subView===sv.id?T.blue:"transparent"}`,borderRadius:8,padding:"10px 20px",cursor:"pointer",color:subView===sv.id?T.blue:T.textMuted,fontSize:13,fontWeight:700,display:"flex",alignItems:"center",gap:8,fontFamily:sans}}><span>{sv.icon}</span>{sv.label}</button>
        ))}
      </div>
      {subView==="intelligence"&&<CoatingIntelView intel={intel} error={intelError} lastFetch={lastFetch} serverUrl={ovenServerUrl} batchEdits={batchEdits} setBatchEdits={setBatchEdits}/>}
      {subView==="pipeline"&&<CoatingPipelineView serverUrl={ovenServerUrl} settings={settings}/>}
      {subView==="config"&&<CoatingConfigView config={coatingConfig} setConfig={setCoatingConfig}/>}
    </div>
    </ProductionStageTab>
  );
}

// ── Coating Pipeline (Container Inheritance) ─────────────────
function CoatingPipelineView({serverUrl,settings}){
  const base=serverUrl||`http://${window.location.hostname}:3002`;
  const mono="'JetBrains Mono',monospace";
  const isDemo=settings?.demoMode||false;

  const [data,setData]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  const [selectedContainer,setSelectedContainer]=useState(null);
  const [manifest,setManifest]=useState(null);
  const [lastRefresh,setLastRefresh]=useState(null);

  // Tool session form
  const [newToolId,setNewToolId]=useState("");
  const [newOperator,setNewOperator]=useState("");
  const [addJobTool,setAddJobTool]=useState("");
  const [addJobNumber,setAddJobNumber]=useState("");
  const [addJobEye,setAddJobEye]=useState("L");
  const [actionMsg,setActionMsg]=useState(null);

  // Transfer forms
  const [xferToolIds,setXferToolIds]=useState("");
  const [xferTrayId,setXferTrayId]=useState("");
  const [batchTrayIds,setBatchTrayIds]=useState("");
  const [batchId,setBatchId]=useState("");
  const [batchMachine,setBatchMachine]=useState("EB9 #1");
  const [batchCoatingType,setBatchCoatingType]=useState("AR");
  const [intelligence,setIntelligence]=useState(null);

  // Demo data
  const DEMO={
    tools:[
      {id:"TOOL-006",status:"open",job_count:8,operator_id:"javier",created_at:new Date(Date.now()-3600000).toISOString(),coating_type:"AR",material:"PLY"},
      {id:"TOOL-007",status:"closed",job_count:6,operator_id:"alex",created_at:new Date(Date.now()-7200000).toISOString(),closed_at:new Date(Date.now()-1800000).toISOString(),coating_type:"AR",material:"PLY"},
      {id:"TOOL-008",status:"open",job_count:3,operator_id:"jose",created_at:new Date(Date.now()-1200000).toISOString(),coating_type:"Blue Cut",material:"H67"},
      {id:"TOOL-009",status:"closed",job_count:4,operator_id:"maria",created_at:new Date(Date.now()-5400000).toISOString(),closed_at:new Date(Date.now()-900000).toISOString(),coating_type:"AR",material:"PLY"},
      {id:"TOOL-010",status:"closed",job_count:5,operator_id:"alex",created_at:new Date(Date.now()-4800000).toISOString(),closed_at:new Date(Date.now()-600000).toISOString(),coating_type:"Blue Cut",material:"H67"},
    ],
    oven_trays:[
      {id:"TRAY-003",status:"closed",job_count:14,children:["TOOL-004","TOOL-005"],created_at:new Date(Date.now()-10800000).toISOString(),coating_type:"AR",material:"PLY"},
      {id:"TRAY-004",status:"open",job_count:6,children:["TOOL-007"],created_at:new Date(Date.now()-5400000).toISOString(),coating_type:"AR",material:"PLY"},
      {id:"TRAY-005",status:"closed",job_count:10,children:["TOOL-003"],created_at:new Date(Date.now()-7200000).toISOString(),coating_type:"Blue Cut",material:"H67"},
    ],
    coating_batches:[
      {id:"BATCH-041",status:"open",job_count:28,machine_id:"CCL-1",coating_type:"AR",material:"PLY",children:["TRAY-001","TRAY-002"],created_at:new Date(Date.now()-14400000).toISOString()},
    ],
  };

  const fetchData=useCallback(async()=>{
    if(isDemo){setData(DEMO);setIntelligence({recommendation:{batchSuggestions:[{coatingType:"AR",material:"PLY",jobCount:18,lensCount:36,rushCount:1,fillPct:82,ready:true,suggestedCoater:"EB9 #1"},{coatingType:"Blue Cut",material:"H67",jobCount:8,lensCount:16,rushCount:0,fillPct:45,ready:false,suggestedCoater:"E1400"}]}});setLoading(false);setLastRefresh(new Date());return;}
    try{
      const [cRes,iRes]=await Promise.all([
        fetch(`${base}/api/containers/active`),
        fetch(`${base}/api/coating/intelligence`).catch(()=>null),
      ]);
      if(cRes.ok){setData(await cRes.json());setError(null);}
      else setError(`Server error: ${cRes.status}`);
      if(iRes?.ok) setIntelligence(await iRes.json());
    }catch(e){setError(e.message);}
    finally{setLoading(false);setLastRefresh(new Date());}
  },[base,isDemo]);

  useEffect(()=>{fetchData();const t=setInterval(fetchData,15000);return()=>clearInterval(t);},[fetchData]);

  // Fetch manifest for selected container
  useEffect(()=>{
    if(!selectedContainer||isDemo){
      if(isDemo&&selectedContainer) setManifest([
        {job_number:"407428",eye_side:"L",source_tool:"TOOL-006",entry_method:"ocr",ocr_confidence:0.94},
        {job_number:"407428",eye_side:"R",source_tool:"TOOL-006",entry_method:"ocr",ocr_confidence:0.91},
        {job_number:"408112",eye_side:"L",source_tool:"TOOL-006",entry_method:"manual",ocr_confidence:null},
        {job_number:"408112",eye_side:"R",source_tool:"TOOL-006",entry_method:"ocr",ocr_confidence:0.88},
        {job_number:"409001",eye_side:"L",source_tool:"TOOL-007",entry_method:"ocr",ocr_confidence:0.96},
        {job_number:"409001",eye_side:"R",source_tool:"TOOL-007",entry_method:"ocr",ocr_confidence:0.93},
      ]);
      return;
    }
    fetch(`${base}/api/containers/${encodeURIComponent(selectedContainer)}/manifest`)
      .then(r=>r.ok?r.json():null).then(d=>{if(d)setManifest(d.jobs||[]);}).catch(()=>{});
  },[selectedContainer,base,isDemo]);

  // Actions
  const openTool=async()=>{
    if(!newToolId.trim())return;
    try{
      const r=await fetch(`${base}/api/containers/tool-session/open`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_id:newToolId.trim().toUpperCase(),operator_id:newOperator.trim()||null})});
      const d=await r.json();
      if(r.ok){setActionMsg({type:"ok",text:`Tool ${newToolId} opened`});setNewToolId("");setNewOperator("");fetchData();}
      else setActionMsg({type:"err",text:d.error||"Failed"});
    }catch(e){setActionMsg({type:"err",text:e.message});}
    setTimeout(()=>setActionMsg(null),4000);
  };

  const addJob=async()=>{
    if(!addJobTool.trim()||!addJobNumber.trim())return;
    try{
      const r=await fetch(`${base}/api/containers/tool-session/add-job`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_id:addJobTool.trim().toUpperCase(),job_number:addJobNumber.trim().toUpperCase(),eye_side:addJobEye,entry_method:"manual"})});
      const d=await r.json();
      if(r.ok){setActionMsg({type:"ok",text:`Job ${addJobNumber} (${addJobEye}) added to ${addJobTool}`});setAddJobNumber("");fetchData();}
      else setActionMsg({type:"err",text:d.error||"Failed"});
    }catch(e){setActionMsg({type:"err",text:e.message});}
    setTimeout(()=>setActionMsg(null),4000);
  };

  const closeTool=async(toolId)=>{
    try{
      const r=await fetch(`${base}/api/containers/tool-session/close`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tool_id:toolId})});
      if(r.ok){setActionMsg({type:"ok",text:`Tool ${toolId} closed`});fetchData();}
      else{const d=await r.json();setActionMsg({type:"err",text:d.error||"Failed"});}
    }catch(e){setActionMsg({type:"err",text:e.message});}
    setTimeout(()=>setActionMsg(null),4000);
  };

  // Transfer: Tools → Tray
  const transferToolsToTray=async()=>{
    if(!xferTrayId.trim()||!xferToolIds.trim())return;
    const toolIds=xferToolIds.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
    try{
      const r=await fetch(`${base}/api/containers/transfer/tool-to-tray`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tray_id:xferTrayId.trim().toUpperCase(),tool_ids:toolIds,operator_id:null})});
      const d=await r.json();
      if(r.ok){const msg=`Loaded ${d.loaded?.length||0} tools → ${xferTrayId}`;const rej=d.rejected?.length?` | ${d.rejected.length} rejected: ${d.rejected.map(r=>r.id+": "+r.reason).join("; ")}`:"";setActionMsg({type:d.rejected?.length?"warn":"ok",text:msg+rej});setXferToolIds("");setXferTrayId("");fetchData();}
      else setActionMsg({type:"err",text:d.error||"Failed"});
    }catch(e){setActionMsg({type:"err",text:e.message});}
    setTimeout(()=>setActionMsg(null),6000);
  };

  // Close Tray
  const closeTrayAction=async(trayId)=>{
    try{
      const r=await fetch(`${base}/api/containers/tray/close`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({tray_id:trayId})});
      if(r.ok){setActionMsg({type:"ok",text:`Tray ${trayId} closed — ready for batch`});fetchData();}
      else{const d=await r.json();setActionMsg({type:"err",text:d.error||"Failed"});}
    }catch(e){setActionMsg({type:"err",text:e.message});}
    setTimeout(()=>setActionMsg(null),4000);
  };

  // Transfer: Trays → Batch
  const assignTraysToBatch=async()=>{
    if(!batchId.trim()||!batchTrayIds.trim())return;
    const trayIds=batchTrayIds.split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
    try{
      const r=await fetch(`${base}/api/containers/transfer/tray-to-batch`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({batch_id:batchId.trim().toUpperCase(),tray_ids:trayIds,machine_id:batchMachine,coating_type:batchCoatingType,operator_id:null})});
      const d=await r.json();
      if(r.ok){const msg=`Assigned ${d.loaded?.length||0} trays → ${batchId}`;const rej=d.rejected?.length?` | ${d.rejected.length} rejected: ${d.rejected.map(r=>r.id+": "+r.reason).join("; ")}`:"";setActionMsg({type:d.rejected?.length?"warn":"ok",text:msg+rej});setBatchTrayIds("");setBatchId("");fetchData();}
      else setActionMsg({type:"err",text:d.error||"Failed"});
    }catch(e){setActionMsg({type:"err",text:e.message});}
    setTimeout(()=>setActionMsg(null),6000);
  };

  const timeSince=(iso)=>{if(!iso)return"—";const diff=Date.now()-new Date(iso).getTime();const m=Math.floor(diff/60000);if(m<60)return`${m}m`;const h=Math.floor(m/60);return`${h}h`;};

  const statusColor=(s)=>s==="open"?T.blue:s==="closed"?T.amber:T.textDim;
  const statusLabel=(s)=>s==="open"?"OPEN":s==="closed"?"READY":"USED";

  // Badge helpers
  const coatingColor=(ct)=>{const m={"AR":"#3b82f6","Blue Cut":"#06b6d4","Mirror":"#a855f7","Transitions":"#f97316","Polarized":"#ec4899","Hard Coat":"#84cc16"};return m[ct]||T.textMuted;};
  const coatingBg=(ct)=>{const m={"AR":"#1e3a5f","Blue Cut":"#164e63","Mirror":"#581c87","Transitions":"#7c2d12","Polarized":"#831843","Hard Coat":"#365314"};return m[ct]||T.surface;};
  const coatingBadge=(ct)=>ct?<span style={{fontSize:8,padding:"1px 6px",borderRadius:2,background:coatingBg(ct),color:coatingColor(ct),fontWeight:700,letterSpacing:"0.05em"}}>{ct}</span>:null;
  const materialBadge=(mat)=>mat?<span style={{fontSize:8,padding:"1px 6px",borderRadius:2,background:"#1e293b",color:"#cbd5e1",border:"1px solid #334155",fontWeight:600}}>{mat}</span>:null;
  const rushBadge=()=><span style={{fontSize:8,padding:"1px 6px",borderRadius:2,background:"#7c2d12",color:"#f97316",fontWeight:700}}>RUSH</span>;

  if(loading)return <div style={{textAlign:"center",padding:40,color:T.textMuted,fontFamily:mono,fontSize:12}}>Loading pipeline...</div>;

  const tools=(data?.tools||[]);
  const trays=(data?.oven_trays||[]);
  const batches=(data?.coating_batches||[]);

  return(
    <div style={{fontFamily:mono}}>
      {/* Action feedback */}
      {actionMsg&&<div style={{padding:"8px 12px",marginBottom:12,borderRadius:4,background:actionMsg.type==="ok"?T.greenDark:T.redDark,border:`1px solid ${actionMsg.type==="ok"?T.green:T.red}33`,fontSize:11,color:actionMsg.type==="ok"?T.green:T.red}}>{actionMsg.text}</div>}

      {error&&<div style={{padding:"8px 12px",marginBottom:12,borderRadius:4,background:T.redDark,border:`1px solid ${T.red}33`,fontSize:11,color:T.red}}>Connection error: {error}</div>}

      {/* Quick actions — 4 groups */}
      <div style={{display:"flex",gap:10,marginBottom:16,flexWrap:"wrap",alignItems:"flex-end"}}>
        <div>
          <div style={{fontSize:8,color:T.textDim,letterSpacing:"0.1em",marginBottom:3}}>OPEN TOOL</div>
          <div style={{display:"flex",gap:3}}>
            <input value={newToolId} onChange={e=>setNewToolId(e.target.value)} placeholder="TOOL-009" style={{width:90,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <input value={newOperator} onChange={e=>setNewOperator(e.target.value)} placeholder="operator" style={{width:70,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <button onClick={openTool} style={{padding:"5px 10px",background:T.blue,border:"none",borderRadius:3,color:"#fff",fontFamily:mono,fontSize:9,fontWeight:700,cursor:"pointer"}}>OPEN</button>
          </div>
        </div>
        <div>
          <div style={{fontSize:8,color:T.textDim,letterSpacing:"0.1em",marginBottom:3}}>ADD JOB TO TOOL</div>
          <div style={{display:"flex",gap:3}}>
            <input value={addJobTool} onChange={e=>setAddJobTool(e.target.value)} placeholder="TOOL-006" style={{width:80,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <input value={addJobNumber} onChange={e=>setAddJobNumber(e.target.value)} placeholder="Job #" style={{width:70,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <button onClick={()=>setAddJobEye(addJobEye==="L"?"R":"L")} style={{padding:"5px 8px",background:addJobEye==="L"?T.blueDark:T.purpleDark,border:`1px solid ${addJobEye==="L"?T.blue:T.purple}`,borderRadius:3,color:addJobEye==="L"?T.blue:T.purple,fontFamily:mono,fontSize:10,fontWeight:700,cursor:"pointer"}}>{addJobEye}</button>
            <button onClick={addJob} style={{padding:"5px 10px",background:T.green,border:"none",borderRadius:3,color:"#000",fontFamily:mono,fontSize:9,fontWeight:700,cursor:"pointer"}}>ADD</button>
          </div>
        </div>
        <div>
          <div style={{fontSize:8,color:T.textDim,letterSpacing:"0.1em",marginBottom:3}}>LOAD TOOLS → TRAY</div>
          <div style={{display:"flex",gap:3}}>
            <input value={xferTrayId} onChange={e=>setXferTrayId(e.target.value)} placeholder="TRAY-003" style={{width:85,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <input value={xferToolIds} onChange={e=>setXferToolIds(e.target.value)} placeholder="TOOL-007,TOOL-009" style={{width:140,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <button onClick={transferToolsToTray} style={{padding:"5px 10px",background:T.amber,border:"none",borderRadius:3,color:"#000",fontFamily:mono,fontSize:9,fontWeight:700,cursor:"pointer"}}>LOAD</button>
          </div>
        </div>
        <div>
          <div style={{fontSize:8,color:T.textDim,letterSpacing:"0.1em",marginBottom:3}}>ASSIGN TRAYS → BATCH</div>
          <div style={{display:"flex",gap:3}}>
            <input value={batchId} onChange={e=>setBatchId(e.target.value)} placeholder="BATCH-042" style={{width:90,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <input value={batchTrayIds} onChange={e=>setBatchTrayIds(e.target.value)} placeholder="TRAY-003,TRAY-005" style={{width:140,padding:"5px 7px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <select value={batchMachine} onChange={e=>setBatchMachine(e.target.value)} style={{padding:"5px 4px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:9}}>
              <option>EB9 #1</option><option>EB9 #2</option><option>E1400</option>
            </select>
            <select value={batchCoatingType} onChange={e=>setBatchCoatingType(e.target.value)} style={{padding:"5px 4px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:9}}>
              {["AR","Blue Cut","Mirror","Transitions","Polarized","Hard Coat"].map(c=><option key={c}>{c}</option>)}
            </select>
            <button onClick={assignTraysToBatch} style={{padding:"5px 10px",background:"#a855f7",border:"none",borderRadius:3,color:"#fff",fontFamily:mono,fontSize:9,fontWeight:700,cursor:"pointer"}}>ASSIGN</button>
          </div>
        </div>
        <div style={{marginLeft:"auto",fontSize:9,color:T.textDim}}>
          {lastRefresh&&lastRefresh.toLocaleTimeString()}
        </div>
      </div>

      {/* Three-column pipeline with badges + transfer buttons */}
      {(()=>{
        // Match closed trays to ready batch suggestions for auto-fill highlighting
        const suggestions=intelligence?.recommendation?.batchSuggestions||[];
        const matchedTrays=new Map();
        for(const s of suggestions){
          if(!s.ready)continue;
          trays.filter(t=>t.status==="closed"&&t.coating_type===s.coatingType&&t.material===s.material)
            .forEach(t=>matchedTrays.set(t.id,s));
        }
        // Group by coating::material
        const groupKey=(c)=>`${c.coating_type||"?"}::${c.material||"?"}`;
        const toolsByGroup={};
        tools.forEach(t=>{const k=groupKey(t);if(!toolsByGroup[k])toolsByGroup[k]=[];toolsByGroup[k].push(t);});
        const sortedToolGroups=Object.entries(toolsByGroup).sort(([a],[b])=>a.localeCompare(b));
        // Sort within groups: closed first, then by age
        for(const[,arr]of sortedToolGroups)arr.sort((a,b)=>(a.status==="closed"?0:1)-(b.status==="closed"?0:1)||new Date(a.created_at)-new Date(b.created_at));

        return(
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,alignItems:"start"}}>

        {/* TOOLS */}
        <div>
          <div style={{fontSize:9,color:T.textDim,letterSpacing:"0.14em",marginBottom:8}}>TOOLS ({tools.length})</div>
          {tools.length===0&&<div style={{fontSize:10,color:T.textDim,padding:16,textAlign:"center",background:T.card,borderRadius:4,border:`1px solid ${T.border}`}}>No active tools</div>}
          {sortedToolGroups.map(([gk,gTools])=>(
            <div key={gk}>
              <div style={{display:"flex",gap:4,alignItems:"center",marginBottom:4,marginTop:8}}>
                {coatingBadge(gTools[0]?.coating_type)}{materialBadge(gTools[0]?.material)}
                <span style={{fontSize:9,color:T.textDim,marginLeft:4}}>{gTools.length}</span>
              </div>
              {gTools.map(c=>(
                <div key={c.id} onClick={()=>setSelectedContainer(selectedContainer===c.id?null:c.id)} style={{
                  padding:"8px 10px",marginBottom:4,borderRadius:4,cursor:"pointer",
                  background:selectedContainer===c.id?T.blueDark:T.card,
                  border:`1px solid ${selectedContainer===c.id?T.blue:T.border}`,
                }}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:statusColor(c.status)}}/>
                    <span style={{fontSize:12,fontWeight:700,color:T.text}}>{c.id}</span>
                    <span style={{fontSize:8,color:statusColor(c.status),letterSpacing:"0.1em",marginLeft:"auto"}}>{statusLabel(c.status)}</span>
                  </div>
                  <div style={{display:"flex",gap:8,fontSize:9,color:T.textMuted,flexWrap:"wrap",alignItems:"center"}}>
                    <span>{c.job_count} jobs</span>
                    {c.operator&&<span>op: {c.operator}</span>}
                    <span>{timeSince(c.opened_at||c.created_at)}</span>
                  </div>
                  <div style={{display:"flex",gap:4,marginTop:4}}>
                    {c.status==="open"&&(
                      <button onClick={e=>{e.stopPropagation();closeTool(c.id);}} style={{padding:"3px 10px",background:"transparent",border:`1px solid ${T.amber}44`,borderRadius:2,color:T.amber,fontSize:9,fontFamily:mono,cursor:"pointer"}}>CLOSE TOOL</button>
                    )}
                    {c.status==="closed"&&(
                      <button onClick={e=>{e.stopPropagation();setXferToolIds(prev=>prev?prev+","+c.id:c.id);}} style={{padding:"3px 10px",background:"transparent",border:`1px solid ${T.green}44`,borderRadius:2,color:T.green,fontSize:9,fontFamily:mono,cursor:"pointer"}}>▶ ADD TO TRAY</button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* OVEN TRAYS */}
        <div>
          <div style={{fontSize:9,color:T.textDim,letterSpacing:"0.14em",marginBottom:8}}>OVEN TRAYS ({trays.length})</div>
          {trays.length===0&&<div style={{fontSize:10,color:T.textDim,padding:16,textAlign:"center",background:T.card,borderRadius:4,border:`1px solid ${T.border}`}}>No active trays</div>}
          {trays.map(c=>{
            const matched=matchedTrays.get(c.id);
            return(
              <div key={c.id} onClick={()=>setSelectedContainer(selectedContainer===c.id?null:c.id)} style={{
                padding:"8px 10px",marginBottom:4,borderRadius:4,cursor:"pointer",
                background:selectedContainer===c.id?T.blueDark:matched?"rgba(16,185,129,0.04)":T.card,
                border:`1px solid ${selectedContainer===c.id?T.blue:matched?"rgba(16,185,129,0.2)":T.border}`,
              }}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:statusColor(c.status)}}/>
                  <span style={{fontSize:12,fontWeight:700,color:T.text}}>{c.id}</span>
                  {coatingBadge(c.coating_type)}{materialBadge(c.material)}
                  <span style={{fontSize:8,color:statusColor(c.status),letterSpacing:"0.1em",marginLeft:"auto"}}>{statusLabel(c.status)}</span>
                </div>
                <div style={{display:"flex",gap:8,fontSize:9,color:T.textMuted}}>
                  <span>{c.job_count} jobs</span>
                  <span>{(c.tools||c.children||[]).length} tools</span>
                  <span>{timeSince(c.opened_at||c.created_at)}</span>
                </div>
                {(c.tools||c.children||[]).length>0&&(
                  <div style={{marginTop:3,display:"flex",gap:3,flexWrap:"wrap"}}>
                    {(c.tools||c.children||[]).map(ch=>(
                      <span key={ch} style={{fontSize:8,padding:"1px 5px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:2,color:T.textMuted}}>{ch}</span>
                    ))}
                  </div>
                )}
                {matched&&(
                  <div style={{marginTop:4,padding:"2px 8px",borderRadius:3,background:"rgba(16,185,129,0.08)",border:"1px solid rgba(16,185,129,0.2)",fontSize:9,color:T.green}}>
                    READY — matches {matched.coatingType} batch ({matched.suggestedCoater})
                  </div>
                )}
                <div style={{display:"flex",gap:4,marginTop:4}}>
                  {c.status==="open"&&(
                    <button onClick={e=>{e.stopPropagation();closeTrayAction(c.id);}} style={{padding:"3px 10px",background:"transparent",border:`1px solid ${T.amber}44`,borderRadius:2,color:T.amber,fontSize:9,fontFamily:mono,cursor:"pointer"}}>CLOSE TRAY</button>
                  )}
                  {c.status==="closed"&&(
                    <button onClick={e=>{e.stopPropagation();setBatchTrayIds(prev=>prev?prev+","+c.id:c.id);if(matched){setBatchCoatingType(matched.coatingType);setBatchMachine(matched.suggestedCoater);}}} style={{padding:"3px 10px",background:"transparent",border:`1px solid ${T.purple}44`,borderRadius:2,color:T.purple,fontSize:9,fontFamily:mono,cursor:"pointer"}}>▶ ADD TO BATCH</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>

        {/* COATING BATCHES */}
        <div>
          <div style={{fontSize:9,color:T.textDim,letterSpacing:"0.14em",marginBottom:8}}>BATCHES ({batches.length})</div>
          {batches.length===0&&<div style={{fontSize:10,color:T.textDim,padding:16,textAlign:"center",background:T.card,borderRadius:4,border:`1px solid ${T.border}`}}>No active batches</div>}
          {batches.map(c=>(
            <div key={c.id} onClick={()=>setSelectedContainer(selectedContainer===c.id?null:c.id)} style={{
              padding:"8px 10px",marginBottom:4,borderRadius:4,cursor:"pointer",
              background:selectedContainer===c.id?T.blueDark:T.card,
              border:`1px solid ${selectedContainer===c.id?T.blue:T.border}`,
            }}>
              <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                <div style={{width:6,height:6,borderRadius:"50%",background:statusColor(c.status)}}/>
                <span style={{fontSize:12,fontWeight:700,color:T.text}}>{c.id}</span>
                {coatingBadge(c.coating_type)}{materialBadge(c.material)}
                <span style={{fontSize:8,color:statusColor(c.status),letterSpacing:"0.1em",marginLeft:"auto"}}>{statusLabel(c.status)}</span>
              </div>
              <div style={{display:"flex",gap:8,fontSize:9,color:T.textMuted}}>
                <span>{c.job_count} jobs</span>
                {c.machine&&<span>{c.machine}</span>}
                <span>{(c.trays||c.children||[]).length} trays</span>
                <span>{timeSince(c.opened_at||c.created_at)}</span>
              </div>
              {(c.trays||c.children||[]).length>0&&(
                <div style={{marginTop:3,display:"flex",gap:3,flexWrap:"wrap"}}>
                  {(c.trays||c.children||[]).map(ch=>(
                    <span key={ch} style={{fontSize:8,padding:"1px 5px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:2,color:T.textMuted}}>{ch}</span>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
        </div>);
      })()}

      {/* Manifest panel */}
      {selectedContainer&&manifest&&(
        <div style={{marginTop:16,background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
            <span style={{fontSize:10,color:T.textDim,letterSpacing:"0.14em"}}>MANIFEST — {selectedContainer} ({manifest.length} jobs)</span>
            <button onClick={()=>{setSelectedContainer(null);setManifest(null);}} style={{fontSize:9,color:T.textDim,background:"none",border:"none",cursor:"pointer"}}>✕ CLOSE</button>
          </div>
          {manifest.length===0&&<div style={{fontSize:10,color:T.textDim,padding:8}}>No jobs in this container</div>}
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:4,maxHeight:250,overflowY:"auto"}}>
            {manifest.map((j,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 8px",background:T.surface,borderRadius:3,border:`1px solid ${T.border}`}}>
                <span style={{fontSize:12,fontWeight:700,color:j.rush?T.orange:T.green,fontFamily:mono}}>{j.job_number}</span>
                <span style={{fontSize:10,color:j.eye_side==="L"?T.blue:T.purple,fontWeight:700}}>{j.eye_side}</span>
                {j.coating&&coatingBadge(j.coating)}
                {j.material&&materialBadge(j.material)}
                {j.rush===1&&rushBadge()}
                <span style={{fontSize:8,color:T.textDim,marginLeft:"auto"}}>{j.source_tool}</span>
                <span style={{fontSize:8,color:j.entry_method==="ocr"?T.cyan:T.amber}}>{j.entry_method==="ocr"?"OCR":"MAN"}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Coating Rules Configuration ─────────────────────────────
function CoatingConfigView({config,setConfig}){
  const update=(k,v)=>setConfig(prev=>({...prev,[k]:parseInt(v)||0}));
  const reset=()=>setConfig({...COATING_CONFIG_DEFAULTS});

  const fields=[
    {section:"Coaters",items:[
      {key:"eb9Capacity",label:"EB9 lens capacity (each)",min:50,max:200,desc:"Lenses per run for each EB9 coater (2 machines)"},
      {key:"e14Capacity",label:"E1400 lens capacity",min:100,max:500,step:10,desc:"Lenses per run for the E1400 coater (1 machine)"},
    ]},
    {section:"Ovens",items:[
      {key:"rackSize",label:"Lenses per rack",min:1,max:100,desc:"How many lenses fit on one oven rack"},
      {key:"ovenCount",label:"Number of ovens",min:1,max:12,desc:"Total ovens available"},
      {key:"racksPerOven",label:"Racks per oven",min:1,max:20,desc:"Rack slots in each oven"},
      {key:"ovenRunHours",label:"Oven run time (hours)",min:1,max:8,desc:"Standard oven cycle duration"},
    ]},
    {section:"AI Recommendation Thresholds",items:[
      {key:"runNowPct",label:"RUN NOW threshold (%)",min:25,max:100,desc:"Last rack fill % to recommend running immediately"},
      {key:"runPartialPct",label:"RUN PARTIAL threshold (%)",min:10,max:100,desc:"Last rack fill % to recommend partial run (if no ovens finishing soon)"},
      {key:"waitWindowMin",label:"Wait window (minutes)",min:5,max:120,desc:"Look-ahead window — if an oven rack finishes within this time, recommend waiting"},
    ]},
  ];

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div style={{fontSize:13,color:T.textMuted,fontFamily:mono,fontWeight:600,textTransform:"uppercase",letterSpacing:1.5}}>Coating Rules & Capacity</div>
        <button onClick={reset} style={{padding:"8px 16px",borderRadius:8,border:`1px solid ${T.border}`,background:"transparent",color:T.textMuted,fontFamily:mono,fontSize:11,cursor:"pointer"}}>Reset Defaults</button>
      </div>
      {fields.map(section=>(
        <Card key={section.section}>
          <SectionHeader>{section.section}</SectionHeader>
          <div style={{display:"flex",flexDirection:"column",gap:12}}>
            {section.items.map(f=>(
              <div key={f.key} style={{display:"flex",alignItems:"center",gap:16}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,color:T.text,fontWeight:600}}>{f.label}</div>
                  <div style={{fontSize:10,color:T.textDim,marginTop:2}}>{f.desc}</div>
                </div>
                <input type="range" min={f.min} max={f.max} step={f.step||1} value={config[f.key]}
                  onChange={e=>update(f.key,e.target.value)}
                  style={{width:160,accentColor:T.blue}}/>
                <div style={{minWidth:50,textAlign:"right",fontFamily:mono,fontSize:14,fontWeight:700,color:T.blue}}>{config[f.key]}</div>
              </div>
            ))}
          </div>
        </Card>
      ))}
      <Card style={{borderLeft:`4px solid ${T.amber}`}}>
        <SectionHeader>How Recommendations Work</SectionHeader>
        <div style={{fontSize:12,color:T.textMuted,lineHeight:1.8,fontFamily:mono}}>
          <div><span style={{color:T.red,fontWeight:700}}>RUSH</span> jobs always trigger <span style={{color:T.green,fontWeight:700}}>RUN NOW</span> regardless of fill level</div>
          <div>Last rack fill ≥ <span style={{color:T.green,fontWeight:700}}>{config.runNowPct}%</span> → <span style={{color:T.green,fontWeight:700}}>RUN NOW</span></div>
          <div>Last rack fill ≥ <span style={{color:T.blue,fontWeight:700}}>{config.runPartialPct}%</span> + no oven finishing within {config.waitWindowMin}m → <span style={{color:T.blue,fontWeight:700}}>RUN PARTIAL</span></div>
          <div>Last rack fill ≥ <span style={{color:T.blue,fontWeight:700}}>{config.runPartialPct}%</span> + oven finishing within {config.waitWindowMin}m → <span style={{color:T.amber,fontWeight:700}}>WAIT</span></div>
          <div>Last rack fill &lt; <span style={{color:T.amber,fontWeight:700}}>{config.runPartialPct}%</span> → <span style={{color:T.amber,fontWeight:700}}>WAIT</span> (accumulate more jobs)</div>
        </div>
      </Card>
    </div>
  );
}

// ── Coating Intelligence — Unified View ─────────────────────
function CoatingIntelView({intel,error,lastFetch,serverUrl,batchEdits,setBatchEdits}){
  const [showJobs,setShowJobs]=useState(false);
  const [activeRuns,setActiveRuns]=useState({});
  const [rackPopup,setRackPopup]=useState(null); // {ovenId, rackIndex, jobs, state, coating, remainingMin}
  const [expandedBatch,setExpandedBatch]=useState(null); // "AR::PLY" key to show job list
  const [aiAdvice,setAiAdvice]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);

  // Poll active coating runs
  useEffect(()=>{
    if(!serverUrl) return;
    const poll=()=>fetch(`${serverUrl}/api/coating/runs`).then(r=>r.json()).then(d=>{if(d.ok) setActiveRuns(d.active||{});}).catch(()=>{});
    poll();
    const iv=setInterval(poll,5000);
    return()=>clearInterval(iv);
  },[serverUrl]);

  if(error) return <Card style={{borderLeft:`4px solid ${T.red}`}}><div style={{color:T.red,fontFamily:mono,fontSize:13}}>Failed to load coating intelligence: {error}</div><div style={{color:T.textDim,fontSize:11,marginTop:8}}>Server: {serverUrl}/api/coating/intelligence</div></Card>;
  if(!intel) return <Card><div style={{color:T.textDim,fontFamily:mono,fontSize:13,textAlign:"center",padding:40}}>Loading coating intelligence...</div></Card>;

  const q=intel.queue||{};
  const o=intel.ovens||{};
  const up=intel.upstream||{};
  const rec=intel.recommendation||{};
  const recColors={"RUN NOW":T.green,"WAIT":T.amber,"RUN PARTIAL":T.blue};
  const staleStr=lastFetch?`${Math.round((Date.now()-lastFetch)/1000)}s ago`:"—";
  const coaters=intel.coaters||[];
  const coatingJobs=q.jobs||[];
  const rushInQueue=q.rushCount||0;
  const ovenIncoming=o.ovenIncoming||[];
  const ovenIncomingJobs=ovenIncoming.reduce((s,r)=>s+r.jobCount,0);

  // Batch state
  const batches=batchEdits._batch||{};
  const assignedIds=new Set(Object.values(batches).flat().map(j=>j.jobId||j));
  const unassigned=coatingJobs.filter(j=>!assignedIds.has(j.jobId));

  const autoBatchCoater=(coaterId)=>{
    const coaterDef=coaters.find(ct=>ct.id===coaterId);
    if(!coaterDef) return;
    const existing=batches[coaterId]||[];
    const slotsLeft=coaterDef.orderCapacity-existing.length;
    if(slotsLeft<=0) return;
    const toAdd=unassigned.slice(0,slotsLeft);
    setBatchEdits(prev=>({...prev,_batch:{...(prev._batch||{}),[coaterId]:[...existing,...toAdd]}}));
  };

  const autoBatchAll=()=>{
    const remaining=[...unassigned];
    const nb={...(batchEdits._batch||{})};
    const sorted=[...coaters].sort((a,b)=>b.orderCapacity-a.orderCapacity);
    for(const ct of sorted){
      if(remaining.length<=0) break;
      const existing=nb[ct.id]||[];
      const slotsLeft=ct.orderCapacity-existing.length;
      if(slotsLeft<=0) continue;
      nb[ct.id]=[...existing,...remaining.splice(0,slotsLeft)];
    }
    while(remaining.length>0){
      let placed=false;
      for(const ct of sorted){
        if(remaining.length<=0) break;
        const key=`${ct.id}_R2`;
        const existing=nb[key]||[];
        const slotsLeft=ct.orderCapacity-existing.length;
        if(slotsLeft<=0) continue;
        nb[key]=[...existing,...remaining.splice(0,slotsLeft)];
        placed=true;
      }
      if(!placed) break;
    }
    setBatchEdits(prev=>({...prev,_batch:nb}));
  };

  const clearCoater=(coaterId)=>{
    setBatchEdits(prev=>{const nb={...(prev._batch||{})};delete nb[coaterId];return{...prev,_batch:nb};});
  };

  const removeJob=(coaterId,jobId)=>{
    setBatchEdits(prev=>{
      const nb={...(prev._batch||{})};
      nb[coaterId]=(nb[coaterId]||[]).filter(j=>(j.jobId||j)!==jobId);
      if(nb[coaterId].length===0) delete nb[coaterId];
      return{...prev,_batch:nb};
    });
  };

  const addToCoater=(coaterId,job)=>{
    setBatchEdits(prev=>{
      const nb={...(prev._batch||{})};
      nb[coaterId]=[...(nb[coaterId]||[]),job];
      return{...prev,_batch:nb};
    });
  };

  const totalAssigned=Object.values(batches).reduce((s,arr)=>s+arr.length,0);

  // Fill a pre-work batch group into its suggested coater
  const fillBatchGroup=(bs)=>{
    const coaterDef=coaters.find(ct=>ct.name===bs.suggestedCoater);
    if(!coaterDef) return;
    const coaterId=coaterDef.id;
    const existing=batches[coaterId]||[];
    const slotsLeft=coaterDef.orderCapacity-existing.length;
    if(slotsLeft<=0) return;
    const groupJobs=(bs.jobs||[]).filter(j=>!assignedIds.has(j.jobId));
    const toAdd=groupJobs.slice(0,slotsLeft);
    if(toAdd.length===0) return;
    setBatchEdits(prev=>({...prev,_batch:{...(prev._batch||{}),[coaterId]:[...existing,...toAdd]}}));
  };

  // Start coating run
  const startCoatingRun=(ct,jobs)=>{
    fetch(`${serverUrl}/api/coating/run/start`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({coaterId:ct.id,coaterName:ct.name,jobs:jobs.map(j=>j.jobId||j),targetSec:ct.runHours*3600})
    }).then(r=>r.json()).then(d=>{
      if(d.ok){setActiveRuns(prev=>({...prev,[ct.id]:d.run}));clearCoater(ct.id);}
      else alert(d.error);
    }).catch(e=>alert('Failed: '+e.message));
  };

  // Stop coating run
  const stopCoatingRun=(coaterId)=>{
    fetch(`${serverUrl}/api/coating/run/stop`,{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({coaterId})
    }).then(r=>r.json()).then(d=>{
      if(d.ok){setActiveRuns(prev=>{const n={...prev};delete n[coaterId];return n;});}
    }).catch(()=>{});
  };

  const fmtTimer=(sec)=>{const m=Math.floor(sec/60);const s=sec%60;return`${m}:${String(s).padStart(2,'0')}`;};

  // AI Batch Advisor — streams from gateway CoatingAgent via SSE
  const getAiBatchAdvice=async()=>{
    setAiLoading(true);setAiAdvice("");
    try{
      const gatewayUrl=`http://${window.location.hostname}:3001`;
      const r=await fetch(`${gatewayUrl}/web/ask`,{
        method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          question:'Analyze the current coating queue and recommend optimal batching. Call get_coating_intelligence first, then get_coating_batch_history to learn from past decisions. Give me specific job IDs for each coater, grouped by coating type and material. Submit your plan via submit_coating_batch_plan when done.',
          agent:'coating',
          userId:'coating-intel-panel',
          context:{source:'coating-batch-advisor'}
        })
      });
      if(!r.ok){const err=await r.json().catch(()=>({message:r.statusText}));throw new Error(err.message||'Gateway error');}
      const reader=r.body.getReader();
      const decoder=new TextDecoder();
      let full="";
      while(true){
        const{done,value}=await reader.read();
        if(done) break;
        const chunk=decoder.decode(value,{stream:true});
        for(const line of chunk.split('\n')){
          if(line.startsWith('data: ')){
            try{
              const d=JSON.parse(line.slice(6));
              if(d.text){full+=d.text;setAiAdvice(full);}
              if(d.message) throw new Error(d.message);
            }catch(e){if(e.message&&!e.message.includes('JSON')) throw e;}
          }
        }
      }
    }catch(e){setAiAdvice(prev=>(prev||"")+'\n\nError: '+e.message);}
    setAiLoading(false);
  };

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* ── TOP BAR: Lab status + sub-stage breakdown + incoming flow ── */}
      <Card>
        <div style={{display:"flex",alignItems:"center",gap:16,flexWrap:"wrap"}}>
          <div style={{background:T.bg,borderRadius:8,padding:"10px 16px",border:`1px solid ${T.border}`,textAlign:"center"}}>
            <div style={{fontSize:9,color:T.textDim,fontFamily:mono,textTransform:"uppercase",letterSpacing:1}}>LAB WIP</div>
            <div style={{fontSize:28,fontWeight:800,color:T.text,fontFamily:mono}}>{intel.totalWip||0}</div>
          </div>
          <div style={{background:T.bg,borderRadius:8,padding:"10px 16px",border:`1px solid ${T.amber}33`,textAlign:"center"}}>
            <div style={{fontSize:9,color:T.textDim,fontFamily:mono,textTransform:"uppercase",letterSpacing:1}}>Coating Total</div>
            <div style={{fontSize:28,fontWeight:800,color:T.amber,fontFamily:mono}}>{q.total||0}</div>
            <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{(q.total||0)*2} lenses</div>
          </div>
          {/* Sub-stage breakdown — where are these jobs ACTUALLY? */}
          {q.bySubStage&&Object.keys(q.bySubStage).length>0&&(
            <div style={{display:"flex",gap:6,flex:1,flexWrap:"wrap"}}>
              {Object.entries(q.bySubStage).sort((a,b)=>b[1]-a[1]).map(([sub,cnt])=>{
                const labels={QUEUE:"Waiting",IN_COATER:"In Coater",COAT_QC:"Coat QC",IN_OVEN:"In Oven"};
                const colors={QUEUE:T.amber,IN_COATER:T.green,COAT_QC:T.blue,IN_OVEN:T.orange};
                return(
                  <div key={sub} style={{background:T.bg,borderRadius:8,padding:"8px 14px",border:`1px solid ${(colors[sub]||T.border)}44`,textAlign:"center",minWidth:80}}>
                    <div style={{fontSize:9,color:colors[sub]||T.textDim,fontFamily:mono,textTransform:"uppercase",letterSpacing:.5}}>{labels[sub]||sub}</div>
                    <div style={{fontSize:22,fontWeight:800,color:T.text,fontFamily:mono}}>{cnt}</div>
                  </div>
                );
              })}
            </div>
          )}
          <div style={{color:T.textDim,fontSize:18}}>◀</div>
          <div style={{textAlign:"center"}}>
            <div style={{fontSize:9,color:T.textDim,fontFamily:mono,textTransform:"uppercase"}}>Incoming</div>
            <div style={{fontSize:24,fontWeight:800,color:"#f72585",fontFamily:mono}}>{up.surfacing?.count||0}</div>
            <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>~{up.surfacing?.etaMin||0}min</div>
          </div>
          <div style={{color:T.textDim,fontSize:18}}>◀</div>
          <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>from surfacing</div>
          {ovenIncoming.length>0&&(
            <div style={{background:`${T.green}11`,borderRadius:8,padding:"8px 14px",border:`1px solid ${T.green}44`,textAlign:"center"}}>
              <div style={{fontSize:9,color:T.green,fontFamily:mono,textTransform:"uppercase",letterSpacing:1}}>From Ovens</div>
              <div style={{fontSize:20,fontWeight:800,color:T.green,fontFamily:mono}}>{ovenIncomingJobs}</div>
              <div style={{fontSize:8,color:T.textDim,fontFamily:mono}}>
                {ovenIncoming.map(r=>`${r.ovenId} R${r.rackIndex} ${r.remainingMin}m`).join(" · ")}
              </div>
            </div>
          )}
          {rushInQueue>0&&<Pill color={T.red} style={{fontSize:13,padding:"6px 14px"}}>{rushInQueue} RUSH</Pill>}
          <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{staleStr}</div>
        </div>
        {/* Station breakdown — exact DVI station names */}
        {q.byStation&&Object.keys(q.byStation).length>0&&(
          <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap"}}>
            {Object.entries(q.byStation).sort((a,b)=>b[1]-a[1]).map(([stn,cnt])=>(
              <div key={stn} style={{padding:"4px 10px",borderRadius:6,background:`${T.amber}11`,border:`1px solid ${T.border}`,fontFamily:mono,fontSize:10}}>
                <span style={{color:T.textMuted}}>{stn}</span>
                <span style={{color:T.text,fontWeight:800,marginLeft:6}}>{cnt}</span>
              </div>
            ))}
          </div>
        )}
        {(q.byType||[]).length>0&&(
          <div style={{display:"flex",gap:8,marginTop:8,flexWrap:"wrap"}}>
            {(q.byType||[]).map(t=>(
              <div key={t.type} style={{padding:"6px 14px",borderRadius:8,background:T.bg,border:`1px solid ${T.amber}44`,fontFamily:mono,fontSize:12}}>
                <span style={{color:T.amber,fontWeight:700}}>{t.type}</span>
                <span style={{color:T.text,fontWeight:800,marginLeft:8}}>{t.count}</span>
                <span style={{color:T.textDim,marginLeft:4}}>jobs</span>
                {t.rushCount>0&&<span style={{color:T.red,marginLeft:6}}>({t.rushCount} rush)</span>}
              </div>
            ))}
          </div>
        )}
      </Card>

      {/* ── PRE-WORK: Batch groups by Coating + Material (hard constraint) ── */}
      <Card style={{borderLeft:`4px solid ${T.blue}`}}>
        <SectionHeader right={`${(rec.batchSuggestions||[]).length} batch group(s) · material is a hard constraint`}>Batch Pre-Work</SectionHeader>
        {(rec.batchSuggestions||[]).length>0?(
          <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:10}}>
            {(rec.batchSuggestions||[]).map(bs=>{
              const batchKey=`${bs.coatingType}::${bs.material}`;
              const isExpanded=expandedBatch===batchKey;
              const fillColor=bs.ready?T.green:bs.fillPct>=50?T.amber:T.border;
              const jobs=bs.jobs||[];
              return(
              <div key={batchKey} style={{background:T.bg,borderRadius:10,border:`1px solid ${fillColor}44`,overflow:"hidden"}}>
                {/* Header row — click to expand/collapse job list */}
                <div onClick={()=>setExpandedBatch(isExpanded?null:batchKey)}
                  style={{display:"flex",alignItems:"center",gap:14,padding:"12px 16px",cursor:"pointer",position:"relative"}}>
                  {/* Fill bar */}
                  <div style={{position:"absolute",left:0,bottom:0,height:3,width:`${Math.min(100,bs.fillPct||0)}%`,background:fillColor,opacity:.5}}/>
                  {/* Coating + Material */}
                  <div style={{minWidth:120}}>
                    <div style={{fontSize:15,fontWeight:800,color:T.amber,fontFamily:mono}}>{bs.coatingType}</div>
                    <div style={{fontSize:13,fontWeight:700,color:T.blue,fontFamily:mono}}>{bs.material==='?'?'Unknown':bs.material}</div>
                  </div>
                  {/* Job count */}
                  <div style={{textAlign:"center",minWidth:70}}>
                    <div style={{fontSize:22,fontWeight:800,color:T.text,fontFamily:mono}}>{bs.jobCount}</div>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{bs.lensCount} lenses</div>
                  </div>
                  {/* Fill % */}
                  <div style={{textAlign:"center",minWidth:60}}>
                    <div style={{fontSize:18,fontWeight:800,color:bs.fillPct>=75?T.green:bs.fillPct>=50?T.amber:T.textDim,fontFamily:mono}}>{bs.fillPct}%</div>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>fill</div>
                  </div>
                  {/* Coater suggestion */}
                  <div style={{fontSize:11,color:T.text,fontFamily:mono,minWidth:60}}>{bs.suggestedCoater}</div>
                  {/* Wait times */}
                  <div style={{fontSize:11,fontFamily:mono,minWidth:80}}>
                    <span style={{color:bs.avgWaitMin>60?T.red:bs.avgWaitMin>30?T.amber:T.textDim}}>avg {bs.avgWaitMin}m</span>
                    {bs.maxWaitMin>0&&<div style={{fontSize:9,color:bs.maxWaitMin>90?T.red:T.textDim}}>max {bs.maxWaitMin}m</div>}
                  </div>
                  {/* Lens types */}
                  <div style={{display:"flex",gap:6,flex:1}}>
                    {Object.entries(bs.lensTypeBreakdown||{}).map(([lt,c])=>(
                      <span key={lt} style={{fontSize:10,fontFamily:mono,color:T.textDim,padding:"2px 6px",borderRadius:4,background:`${T.border}44`}}>
                        {lt==='P'?'Prog':lt==='S'?'SV':lt==='B'?'BF':lt}: {String(c)}
                      </span>
                    ))}
                  </div>
                  {/* Status pills + Fill button */}
                  <div style={{display:"flex",gap:4,alignItems:"center"}} onClick={e=>e.stopPropagation()}>
                    {bs.ready&&<Pill color={T.green} style={{fontSize:9,padding:"2px 8px"}}>READY</Pill>}
                    {bs.rushCount>0&&<Pill color={T.red} style={{fontSize:9,padding:"2px 8px"}}>{bs.rushCount} RUSH</Pill>}
                    <button onClick={()=>fillBatchGroup(bs)}
                      style={{padding:"4px 12px",borderRadius:6,border:`1px solid ${T.green}`,background:`${T.green}18`,color:T.green,fontFamily:mono,fontSize:10,cursor:"pointer",fontWeight:700,whiteSpace:"nowrap"}}>
                      Fill → {bs.suggestedCoater}
                    </button>
                    <span style={{fontSize:12,color:T.textDim,fontFamily:mono,cursor:"pointer"}} onClick={(e)=>{e.stopPropagation();setExpandedBatch(isExpanded?null:batchKey);}}>{isExpanded?"▲":"▼"}</span>
                  </div>
                </div>
                {/* Expanded job list */}
                {isExpanded&&jobs.length>0&&(
                  <div style={{borderTop:`1px solid ${T.border}`,padding:"8px 16px",maxHeight:400,overflowY:"auto"}}>
                    <div style={{display:"grid",gridTemplateColumns:"80px 50px 50px 50px 1fr 60px",gap:"2px 10px",fontSize:11,fontFamily:mono}}>
                      <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>JOB</div>
                      <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>TYPE</div>
                      <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>EYE</div>
                      <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>RUSH</div>
                      <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>STATION</div>
                      <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0",textAlign:"right"}}>WAIT</div>
                      {jobs.map(j=>(
                        <div key={j.jobId} style={{display:"contents"}}>
                          <div style={{color:j.rush?T.red:T.text,padding:"3px 0",fontWeight:600}}>{j.jobId}</div>
                          <div style={{color:T.textDim,padding:"3px 0"}}>{j.lensType==='P'?'Prog':j.lensType==='S'?'SV':j.lensType==='B'?'BF':j.lensType||'—'}</div>
                          <div style={{color:T.textDim,padding:"3px 0"}}>{j.eyeSize||'—'}</div>
                          <div style={{color:j.rush?T.red:T.textDim,padding:"3px 0"}}>{j.rush?'YES':'—'}</div>
                          <div style={{color:T.textMuted,padding:"3px 0"}}>{j.station||'—'}</div>
                          <div style={{color:j.waitMin>60?T.red:j.waitMin>30?T.amber:T.textDim,padding:"3px 0",textAlign:"right"}}>{j.waitMin}m</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );})}
          </div>
        ):(
          <div style={{textAlign:"center",padding:"24px 0",color:T.textDim,fontFamily:mono,fontSize:12}}>
            No coating jobs in queue — batch groups will appear here when jobs arrive
          </div>
        )}
      </Card>

      {/* ── AUTO BATCHING: 3 coater cards side by side ── */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:-8}}>
        <div style={{fontSize:13,fontFamily:mono,fontWeight:700,color:T.textMuted,textTransform:"uppercase",letterSpacing:1.5}}>Auto Batching</div>
        <div style={{display:"flex",gap:8}}>
          <Pill color={recColors[rec.action]||T.textDim}>{rec.action||"—"}</Pill>
          <span style={{fontSize:11,color:T.textMuted,fontFamily:mono}}>{rec.reason||""}</span>
        </div>
      </div>
      <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-start"}}>
        {coaters.map(ct=>{
          const run=activeRuns[ct.id];
          const isRunning=run&&run.status==='running';
          const assigned=batches[ct.id]||[];
          const fillPct=ct.orderCapacity>0?Math.round(assigned.length/ct.orderCapacity*100):0;
          const lenses=assigned.length*2;
          const hasRush=assigned.some(j=>j.rush);
          const fillColor=isRunning?T.green:fillPct>=100?T.green:fillPct>=75?T.blue:fillPct>0?T.amber:T.border;
          return(
            <Card key={ct.id} style={{flex:1,minWidth:260,borderLeft:`4px solid ${fillColor}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <div style={{fontSize:16,fontWeight:800,color:T.text,fontFamily:mono}}>{ct.name}</div>
                  <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{ct.lensCapacity}L capacity · {ct.runHours}h run</div>
                </div>
                {isRunning?(
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:24,fontWeight:800,color:T.green,fontFamily:mono}}>{fmtTimer(run.remainingSec||0)}</div>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{run.jobCount} jobs running</div>
                  </div>
                ):(
                  <div style={{textAlign:"right"}}>
                    <div style={{fontSize:28,fontWeight:800,color:fillColor,fontFamily:mono}}>{assigned.length}</div>
                    <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>/{ct.orderCapacity} orders</div>
                  </div>
                )}
              </div>
              {/* Fill bar or run progress */}
              {isRunning?(
                <div style={{height:8,background:T.bg,borderRadius:4,overflow:"hidden",margin:"10px 0"}}>
                  <div style={{height:"100%",width:`${Math.min(100,Math.round(run.elapsedSec/(run.targetSec||7200)*100))}%`,borderRadius:4,background:T.green,transition:"width 1s"}}/>
                </div>
              ):(
                <div style={{height:8,background:T.bg,borderRadius:4,overflow:"hidden",margin:"10px 0"}}>
                  <div style={{height:"100%",width:`${Math.min(100,fillPct)}%`,borderRadius:4,background:fillColor,transition:"width .3s"}}/>
                </div>
              )}
              {isRunning?(
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,fontFamily:mono,color:T.textDim}}>
                  <span>{Math.round(run.elapsedSec/60)}min elapsed · {run.remainingMin||0}min left</span>
                  <button onClick={()=>stopCoatingRun(ct.id)} style={{padding:"4px 10px",borderRadius:6,border:`1px solid ${T.red}`,background:"transparent",color:T.red,fontFamily:mono,fontSize:10,cursor:"pointer"}}>Stop</button>
                </div>
              ):(
                <>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:10,fontFamily:mono,color:T.textDim}}>
                    <span>{lenses}/{ct.lensCapacity} lenses · {fillPct}%</span>
                    {hasRush&&<span style={{color:T.red}}>RUSH</span>}
                  </div>
                  {/* Action buttons */}
                  <div style={{display:"flex",gap:6,marginTop:10}}>
                    <button onClick={()=>autoBatchCoater(ct.id)} style={{flex:1,padding:"6px 0",borderRadius:6,border:`1px solid ${T.blue}`,background:T.blueDark,color:T.blue,fontFamily:mono,fontSize:11,cursor:"pointer",fontWeight:700}}>Auto Fill</button>
                    {assigned.length>0&&<button onClick={()=>startCoatingRun(ct,assigned)} style={{flex:1,padding:"6px 0",borderRadius:6,border:`1px solid ${T.green}`,background:`${T.green}22`,color:T.green,fontFamily:mono,fontSize:11,cursor:"pointer",fontWeight:700}}>{fillPct>=100?"Run":"Run Partial"}</button>}
                    {assigned.length>0&&<button onClick={()=>clearCoater(ct.id)} style={{padding:"6px 12px",borderRadius:6,border:`1px solid ${T.red}`,background:"transparent",color:T.red,fontFamily:mono,fontSize:11,cursor:"pointer"}}>Clear</button>}
                  </div>
                  {/* Job list — always visible when jobs assigned */}
                  {assigned.length>0&&(
                    <div style={{marginTop:10,borderTop:`1px solid ${T.border}`,paddingTop:8}}>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginBottom:4,textTransform:"uppercase",letterSpacing:1}}>Jobs to pull ({assigned.length})</div>
                      <div style={{maxHeight:300,overflowY:"auto"}}>
                        {assigned.map((j,ji)=>(
                          <div key={j.jobId||ji} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${T.border}`,fontSize:11,fontFamily:mono}}>
                            <span style={{color:j.rush?T.red:T.text,fontWeight:600}}>{j.rush?"🚨 ":""}{j.jobId}</span>
                            <span style={{color:T.textDim,fontSize:10}}>{j.station||""}</span>
                            <span style={{color:T.textDim,fontSize:10}}>{j.tray?`T${j.tray}`:""}</span>
                            <button onClick={()=>removeJob(ct.id,j.jobId)} style={{background:"none",border:"none",color:T.red,cursor:"pointer",fontSize:10,padding:"2px 4px"}}>✕</button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  {/* Add jobs manually */}
                  {unassigned.length>0&&assigned.length<ct.orderCapacity&&(
                    <div style={{marginTop:assigned.length>0?6:10,paddingTop:6,borderTop:assigned.length>0?`1px solid ${T.border}`:"none"}}>
                      <div style={{fontSize:9,color:T.textDim,fontFamily:mono,marginBottom:4}}>Add job:</div>
                      <div style={{display:"flex",flexWrap:"wrap",gap:3,maxHeight:80,overflowY:"auto"}}>
                        {unassigned.slice(0,20).map(j=>(
                          <button key={j.jobId} onClick={()=>addToCoater(ct.id,j)}
                            style={{padding:"2px 6px",borderRadius:4,border:`1px solid ${j.rush?T.red:T.blue}`,background:"transparent",color:j.rush?T.red:T.blue,cursor:"pointer",fontSize:9,fontFamily:mono}}>{j.jobId}</button>
                        ))}
                        {unassigned.length>20&&<span style={{fontSize:9,color:T.textDim,fontFamily:mono,padding:"2px 4px"}}>+{unassigned.length-20}</span>}
                      </div>
                    </div>
                  )}
                  {assigned.length===0&&unassigned.length===0&&(
                    <div style={{marginTop:10,color:T.textDim,fontSize:11,fontFamily:mono,textAlign:"center",padding:12,background:T.bg,borderRadius:6}}>No jobs in queue</div>
                  )}
                </>
              )}
            </Card>
          );
        })}
      </div>
      {/* Batch status line */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",fontFamily:mono,fontSize:11}}>
        <span style={{color:unassigned.length===0&&coatingJobs.length>0?T.green:T.textDim}}>
          {totalAssigned}/{coatingJobs.length} jobs batched · {unassigned.length} unassigned
        </span>
        <div style={{display:"flex",gap:8}}>
          <button onClick={autoBatchAll} style={{padding:"4px 12px",borderRadius:6,border:`1px solid ${T.blue}`,background:"transparent",color:T.blue,cursor:"pointer",fontSize:10,fontWeight:700}}>Auto-Batch All</button>
          {totalAssigned>0&&<button onClick={()=>setBatchEdits(prev=>({...prev,_batch:{}}))} style={{padding:"4px 12px",borderRadius:6,border:`1px solid ${T.red}`,background:"transparent",color:T.red,cursor:"pointer",fontSize:10}}>Clear All</button>}
        </div>
      </div>

      {/* ── AI BATCH ADVISOR ── */}
      <Card style={{borderLeft:`4px solid #7c3aed`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <SectionHeader right={aiLoading?"analyzing...":aiAdvice?"updated":"ready"}>AI Batch Advisor</SectionHeader>
          <button onClick={getAiBatchAdvice} disabled={aiLoading}
            style={{padding:"8px 20px",borderRadius:8,border:`1px solid #7c3aed`,background:aiLoading?"transparent":`#7c3aed22`,color:"#7c3aed",fontFamily:mono,fontSize:12,cursor:aiLoading?"wait":"pointer",fontWeight:700,opacity:aiLoading?.6:1}}>
            {aiLoading?"Analyzing WIP...":"Analyze & Recommend"}
          </button>
        </div>
        <div style={{fontSize:10,color:T.textDim,fontFamily:mono,marginTop:4}}>
          Claude AI agent with MCP tools: analyzes WIP, queue by coating type/material/size, oven loads, incoming flow, and past batch outcomes. Learns from feedback over time.
        </div>
        {aiAdvice&&(
          <div style={{marginTop:12}}>
            <div style={{padding:16,background:T.bg,borderRadius:8,border:`1px solid #7c3aed33`,maxHeight:500,overflowY:"auto"}}>
              <pre style={{margin:0,whiteSpace:"pre-wrap",wordBreak:"break-word",fontSize:12,fontFamily:mono,color:T.text,lineHeight:1.6}}>{aiAdvice}</pre>
            </div>
            {!aiLoading&&(
              <div style={{display:"flex",alignItems:"center",gap:12,marginTop:10,paddingTop:10,borderTop:`1px solid ${T.border}`}}>
                <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Rate this recommendation:</span>
                {[1,2,3,4,5].map(n=>(
                  <button key={n} onClick={()=>{
                    fetch(`http://${window.location.hostname}:3001/web/ask-sync`,{
                      method:'POST',headers:{'Content-Type':'application/json'},
                      body:JSON.stringify({question:`Record feedback rating ${n}/5 for the most recent batch plan. Call get_coating_batch_history to find the latest plan ID, then note this rating.`,agent:'coating',userId:'coating-feedback'})
                    }).catch(()=>{});
                    setAiAdvice(prev=>prev+`\n\n--- Rated ${n}/5 ---`);
                  }}
                    style={{width:36,height:36,borderRadius:8,border:`1px solid ${n<=2?T.red:n===3?T.amber:T.green}`,background:"transparent",color:n<=2?T.red:n===3?T.amber:T.green,fontSize:14,fontWeight:700,cursor:"pointer",fontFamily:mono}}>{n}</button>
                ))}
                <span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>1=poor 5=great</span>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* ── OVENS: wide cards with racks underneath, click rack for job list popup ── */}
      <Card style={{borderLeft:`4px solid ${T.orange}`}}>
        <SectionHeader right={`${o.racksInUse||0} running · ${o.racksAvailable||0} available · Live from OvenTimer`}>Ovens</SectionHeader>
        <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:14,marginTop:10}}>
          {(o.layout||[]).map(oven=>{
            const runCount=oven.racks.filter(r=>r.state==='running'||r.state==='paused').length;
            const jobTotal=oven.racks.reduce((s,r)=>(r.jobs?.length||0)+s,0);
            const nextDone=runCount>0?Math.min(...oven.racks.filter(r=>r.state==='running').map(r=>r.remainingMin||999)):null;
            return(
              <div key={oven.ovenId} style={{background:T.bg,borderRadius:12,padding:14,border:`1px solid ${runCount>0?T.amber+'44':T.border}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:15,fontWeight:800,color:T.text,fontFamily:mono}}>{oven.ovenId}</div>
                  <div style={{display:"flex",gap:8,alignItems:"center"}}>
                    {jobTotal>0&&<span style={{fontSize:10,color:T.blue,fontFamily:mono,fontWeight:700}}>{jobTotal} jobs</span>}
                    <span style={{fontSize:10,color:runCount>0?T.amber:T.textDim,fontFamily:mono}}>{runCount}/{oven.racks.length}</span>
                    {nextDone!==null&&<span style={{fontSize:10,color:T.green,fontFamily:mono}}>next {nextDone}m</span>}
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:4}}>
                  {oven.racks.map(rack=>{
                    const isRunning=rack.state==='running'||rack.state==='paused';
                    const pct=isRunning&&rack.target>0?Math.round(rack.elapsed/rack.target*100):0;
                    const nearDone=isRunning&&rack.remainingMin<=15;
                    const rackColor=nearDone?T.green:isRunning?T.amber:T.border;
                    const jobs=rack.jobs||[];
                    const hasJobs=jobs.length>0;
                    return(
                      <div key={rack.rackIndex}
                        onClick={()=>{if(hasJobs||isRunning) setRackPopup({ovenId:oven.ovenId,rackIndex:rack.rackIndex,jobs,state:rack.state,coating:rack.coating,remainingMin:rack.remainingMin,elapsed:rack.elapsed,target:rack.target});}}
                        style={{background:isRunning?`${rackColor}12`:T.card,borderRadius:6,padding:"6px 4px",border:`1.5px solid ${rackColor}`,textAlign:"center",cursor:(hasJobs||isRunning)?"pointer":"default",transition:"all .2s",minHeight:52,display:"flex",flexDirection:"column",justifyContent:"center",gap:2}}>
                        <div style={{fontSize:10,color:isRunning?rackColor:T.textDim,fontFamily:mono,fontWeight:800}}>R{rack.rackIndex}</div>
                        {isRunning?(
                          <div style={{display:"flex",flexDirection:"column",gap:2}}>
                            <div style={{fontSize:14,fontWeight:800,color:nearDone?T.green:T.amber,fontFamily:mono}}>{rack.remainingMin}m</div>
                            <div style={{height:3,background:T.bg,borderRadius:2,overflow:"hidden",margin:"0 2px"}}>
                              <div style={{height:"100%",width:`${Math.min(100,pct)}%`,borderRadius:2,background:nearDone?T.green:T.blue,transition:"width 1s"}}/>
                            </div>
                            {hasJobs&&<div style={{fontSize:8,color:T.blue,fontFamily:mono}}>{jobs.length} jobs</div>}
                          </div>
                        ):(
                          hasJobs?<div style={{fontSize:8,color:T.blue,fontFamily:mono}}>{jobs.length} jobs</div>
                          :<div style={{fontSize:8,color:T.textDim,fontFamily:mono,opacity:.3}}>--</div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── RACK JOBS POPUP (click a rack to see job list) ── */}
      {rackPopup&&(
        <div style={{position:"fixed",inset:0,zIndex:9999,background:"rgba(0,0,0,0.7)",display:"flex",alignItems:"center",justifyContent:"center"}}
          onClick={(e)=>{if(e.target===e.currentTarget)setRackPopup(null);}}>
          <div style={{background:T.surface,borderRadius:16,padding:24,minWidth:320,maxWidth:480,maxHeight:"80vh",overflowY:"auto",border:`2px solid ${rackPopup.state==='running'?T.amber:T.border}`}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
              <div>
                <div style={{fontSize:18,fontWeight:800,color:T.text,fontFamily:mono}}>{rackPopup.ovenId} — Rack {rackPopup.rackIndex}</div>
                <div style={{fontSize:12,color:T.textDim,fontFamily:mono,marginTop:2}}>
                  {rackPopup.state==='running'?`Running · ${rackPopup.remainingMin}m remaining`
                    :rackPopup.state==='paused'?'Paused':'Idle'}
                  {rackPopup.coating&&` · ${rackPopup.coating}`}
                </div>
              </div>
              <button onClick={()=>setRackPopup(null)}
                style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:8,color:T.text,fontSize:18,width:36,height:36,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
            {rackPopup.state==='running'&&rackPopup.target>0&&(
              <div style={{marginBottom:14}}>
                <div style={{display:"flex",justifyContent:"space-between",fontSize:10,fontFamily:mono,color:T.textDim,marginBottom:4}}>
                  <span>{Math.floor((rackPopup.elapsed||0)/60)}m elapsed</span>
                  <span>{Math.round((rackPopup.elapsed||0)/(rackPopup.target||1)*100)}%</span>
                </div>
                <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden"}}>
                  <div style={{height:"100%",width:`${Math.min(100,Math.round((rackPopup.elapsed||0)/(rackPopup.target||1)*100))}%`,borderRadius:3,background:rackPopup.remainingMin<=15?T.green:T.blue,transition:"width 1s"}}/>
                </div>
              </div>
            )}
            <div style={{fontSize:12,fontWeight:700,color:T.textDim,fontFamily:mono,marginBottom:8}}>
              {rackPopup.jobs.length>0?`${rackPopup.jobs.length} Jobs`:'No jobs entered on OvenTimer'}
            </div>
            {rackPopup.jobs.length>0?(
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {rackPopup.jobs.map((j,i)=>(
                  <div key={j+i} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 10px",background:T.bg,borderRadius:6,border:`1px solid ${T.border}`}}>
                    <span style={{fontSize:10,color:T.textDim,fontFamily:mono,minWidth:20}}>{i+1}.</span>
                    <span style={{fontSize:13,color:T.text,fontFamily:mono,fontWeight:600}}>{j}</span>
                  </div>
                ))}
              </div>
            ):(
              <div style={{color:T.textDim,fontFamily:mono,fontSize:12,textAlign:"center",padding:20,opacity:.5}}>
                Job numbers are entered by operators on the OvenTimer tablet
              </div>
            )}
          </div>
        </div>
      )}

      {/* ── QUEUE DETAIL (expandable) ── */}
      <Card style={{borderLeft:`4px solid ${T.amber}`}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",cursor:"pointer"}} onClick={()=>setShowJobs(!showJobs)}>
          <SectionHeader right={`${q.total||0} jobs · ${showJobs?"▲ hide":"▼ show"}`}>Coating Queue</SectionHeader>
        </div>
        {showJobs&&(
          <div style={{maxHeight:400,overflowY:"auto",marginTop:8}}>
            <div style={{display:"grid",gridTemplateColumns:"80px 80px 1fr 60px 60px 60px",gap:"2px 8px",fontSize:11,fontFamily:mono}}>
              <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>JOB</div>
              <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>COAT</div>
              <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>STATION</div>
              <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>TYPE</div>
              <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0"}}>MAT</div>
              <div style={{color:T.textDim,fontWeight:700,borderBottom:`1px solid ${T.border}`,padding:"4px 0",textAlign:"right"}}>WAIT</div>
              {coatingJobs.map(j=>(
                <div key={j.jobId} style={{display:"contents"}}>
                  <div style={{color:j.rush?T.red:assignedIds.has(j.jobId)?T.green:T.text,padding:"3px 0",fontWeight:600}}>{j.rush?"! ":assignedIds.has(j.jobId)?"+ ":""}{j.jobId}</div>
                  <div style={{color:T.amber,padding:"3px 0"}}>{j.coating||"AR"}</div>
                  <div style={{color:T.textMuted,padding:"3px 0"}}>{j.station}</div>
                  <div style={{color:T.textDim,padding:"3px 0"}}>{j.lensType==='P'?'Prog':j.lensType==='S'?'SV':j.lensType==='B'?'BF':j.lensType||'—'}</div>
                  <div style={{color:T.textDim,padding:"3px 0"}}>{j.lensMat||'—'}</div>
                  <div style={{color:j.waitMin>60?T.red:j.waitMin>30?T.amber:T.textDim,padding:"3px 0",textAlign:"right"}}>{j.waitMin}m</div>
                </div>
              ))}
            </div>
          </div>
        )}
      </Card>
    </div>
  );
}

// ── Batch Builder — Assign all jobs to coater runs ──────────
function BatchBuilderView({intel,batchEdits,setBatchEdits,serverUrl}){
  const [selectedType,setSelectedType]=useState(null);
  if(!intel) return <Card><div style={{color:T.textDim,fontFamily:mono,fontSize:13,textAlign:"center",padding:40}}>Loading...</div></Card>;

  const q=intel.queue||{};
  const coaters=intel.coaters||[];
  const allJobs=q.jobs||[];
  const types=(q.byType||[]);

  // Auto-select first type (or "ALL" if only one type)
  const activeType=selectedType||(types.length>1?types[0]?.type:"ALL");
  const jobs=activeType==="ALL"?allJobs:allJobs.filter(j=>j.coating===activeType);

  // Current batch assignments for this type — keyed by coater ID
  const batchKey=activeType||"ALL";
  const batches=batchEdits[batchKey]||{};
  const assignedIds=new Set(Object.values(batches).flat().map(j=>j.jobId||j));
  const unassigned=jobs.filter(j=>!assignedIds.has(j.jobId));

  // Auto-batch: fill coaters largest-first (E1400 then EB9s)
  const autoBatch=()=>{
    const remaining=[...unassigned];
    const newBatches={...batches};
    const sorted=[...coaters].sort((a,b)=>b.orderCapacity-a.orderCapacity);
    for(const coater of sorted){
      if(remaining.length<=0) break;
      const existing=newBatches[coater.id]||[];
      const slotsLeft=coater.orderCapacity-existing.length;
      if(slotsLeft<=0) continue;
      const toAdd=remaining.splice(0,slotsLeft);
      newBatches[coater.id]=[...existing,...toAdd];
    }
    while(remaining.length>0){
      let placed=false;
      for(const coater of sorted){
        if(remaining.length<=0) break;
        const key=`${coater.id}_R2`;
        const existing=newBatches[key]||[];
        const slotsLeft=coater.orderCapacity-existing.length;
        if(slotsLeft<=0) continue;
        const toAdd=remaining.splice(0,slotsLeft);
        newBatches[key]=[...existing,...toAdd];
        placed=true;
      }
      if(!placed) break;
    }
    setBatchEdits(prev=>({...prev,[batchKey]:newBatches}));
  };

  const clearBatches=()=>{
    setBatchEdits(prev=>{const next={...prev};delete next[batchKey];return next;});
  };

  const removeFromCoater=(coaterId,jobId)=>{
    setBatchEdits(prev=>{
      const next={...prev};
      const cb={...(next[batchKey]||{})};
      cb[coaterId]=(cb[coaterId]||[]).filter(j=>(j.jobId||j)!==jobId);
      if(cb[coaterId].length===0) delete cb[coaterId];
      next[batchKey]=cb;
      return next;
    });
  };

  const addToCoater=(coaterId,job)=>{
    setBatchEdits(prev=>{
      const next={...prev};
      const cb={...(next[batchKey]||{})};
      cb[coaterId]=[...(cb[coaterId]||[]),job];
      next[batchKey]=cb;
      return next;
    });
  };

  const totalAssigned=Object.values(batches).reduce((s,arr)=>s+arr.length,0);
  const coaterCount=Object.keys(batches).filter(k=>(batches[k]||[]).length>0).length;
  const totalJobs=jobs.length;
  const allAssigned=unassigned.length===0&&totalJobs>0;

  const coaterKeys=[...new Set([...coaters.map(ct=>ct.id),...Object.keys(batches)])];

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Coating type selector */}
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        <button onClick={()=>setSelectedType("ALL")}
          style={{padding:"10px 18px",borderRadius:8,cursor:"pointer",fontFamily:mono,fontSize:12,fontWeight:700,
            background:activeType==="ALL"?T.blueDark:"transparent",
            border:`1px solid ${activeType==="ALL"?T.blue:T.border}`,
            color:activeType==="ALL"?T.blue:T.textMuted}}>
          ALL ({allJobs.length})
        </button>
        {types.map(t=>{
          const tb=batchEdits[t.type]||{};
          const ta=Object.values(tb).reduce((s,arr)=>s+arr.length,0);
          const complete=ta>=t.count&&t.count>0;
          return(
            <button key={t.type} onClick={()=>setSelectedType(t.type)}
              style={{padding:"10px 18px",borderRadius:8,cursor:"pointer",fontFamily:mono,fontSize:12,fontWeight:700,
                background:t.type===activeType?T.blueDark:"transparent",
                border:`1px solid ${complete?T.green:t.type===activeType?T.blue:T.border}`,
                color:t.type===activeType?T.blue:complete?T.green:T.textMuted}}>
              {t.type} ({t.count}) {complete&&"✓"}
            </button>
          );
        })}
      </div>

      {/* Status bar */}
      <Card style={{borderLeft:`4px solid ${allAssigned?T.green:totalJobs===0?T.textDim:T.amber}`}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
          <div>
            <div style={{fontSize:14,fontWeight:700,color:allAssigned?T.green:totalJobs===0?T.textDim:T.text}}>
              {totalJobs===0?"No jobs in coating queue":allAssigned?`All ${totalJobs} jobs assigned — ready to run`:"Assign all jobs to coaters before running"}
            </div>
            <div style={{fontSize:11,color:T.textDim,fontFamily:mono,marginTop:4}}>
              {totalAssigned}/{totalJobs} jobs assigned · {coaterCount} coater{coaterCount!==1?"s":""} loaded · {unassigned.length} unassigned
            </div>
          </div>
          <div style={{display:"flex",gap:8}}>
            {totalJobs>0&&<button onClick={autoBatch} style={{padding:"8px 16px",borderRadius:8,border:`1px solid ${T.blue}`,background:T.blueDark,color:T.blue,fontFamily:mono,fontSize:11,cursor:"pointer",fontWeight:700}}>Auto-Batch</button>}
            {coaterCount>0&&<button onClick={clearBatches} style={{padding:"8px 16px",borderRadius:8,border:`1px solid ${T.red}`,background:"transparent",color:T.red,fontFamily:mono,fontSize:11,cursor:"pointer"}}>Clear All</button>}
          </div>
        </div>
        {totalJobs>0&&(
          <div style={{marginTop:10}}>
            <div style={{height:8,background:T.bg,borderRadius:4,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${Math.round(totalAssigned/totalJobs*100)}%`,borderRadius:4,background:allAssigned?T.green:T.amber,transition:"width .3s"}}/>
            </div>
          </div>
        )}
      </Card>

      {/* Coater cards */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:12}}>
        {coaterKeys.map(coaterId=>{
          const coaterDef=coaters.find(ct=>ct.id===coaterId);
          const coaterName=coaterDef?.name||coaterId.replace(/_R\d+$/," Run 2");
          const capacity=coaterDef?.orderCapacity||137;
          const lensCapacity=coaterDef?.lensCapacity||274;
          const assigned=batches[coaterId]||[];
          const lenses=assigned.length*2;
          const fillPct=capacity>0?Math.round(assigned.length/capacity*100):0;
          const hasRush=assigned.some(j=>j.rush);
          return(
            <Card key={coaterId} style={{borderLeft:`4px solid ${fillPct>=100?T.green:fillPct>=75?T.blue:assigned.length>0?T.amber:T.border}`}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <div style={{fontFamily:mono,fontWeight:700,fontSize:14,color:T.text}}>{coaterName} {hasRush&&<span style={{color:T.red}}>🚨</span>}</div>
                <div style={{fontFamily:mono,fontSize:11,color:fillPct>=100?T.green:T.textDim}}>{assigned.length}/{capacity} orders · {lenses}/{lensCapacity} lenses · {fillPct}%</div>
              </div>
              <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden",marginBottom:8}}>
                <div style={{height:"100%",width:`${Math.min(100,fillPct)}%`,background:fillPct>=100?T.green:fillPct>=75?T.blue:T.amber,borderRadius:3}}/>
              </div>
              <div style={{maxHeight:220,overflowY:"auto"}}>
                {assigned.map((j,ji)=>(
                  <div key={j.jobId||ji} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"3px 0",borderBottom:`1px solid ${T.border}`,fontSize:11,fontFamily:mono}}>
                    <span style={{color:j.rush?T.red:T.textMuted}}>{j.rush?"🚨 ":""}{j.jobId}</span>
                    <span style={{color:T.textDim}}>{j.station||""}</span>
                    <button onClick={()=>removeFromCoater(coaterId,j.jobId)} style={{background:"none",border:"none",color:T.red,cursor:"pointer",fontSize:10,padding:"2px 4px"}}>✕</button>
                  </div>
                ))}
                {assigned.length===0&&<div style={{color:T.textDim,fontSize:11,fontFamily:mono,textAlign:"center",padding:12}}>Empty — use Auto-Batch or add jobs below</div>}
              </div>
            </Card>
          );
        })}
      </div>

      {/* Unassigned jobs */}
      {unassigned.length>0&&(
        <Card style={{borderLeft:`4px solid ${T.red}`}}>
          <SectionHeader right={`${unassigned.length} remaining`}>Unassigned Jobs{activeType!=="ALL"?` — ${activeType}`:""}</SectionHeader>
          <div style={{maxHeight:400,overflowY:"auto"}}>
            {unassigned.slice(0,200).map(j=>(
              <div key={j.jobId} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"4px 0",borderBottom:`1px solid ${T.border}`,fontSize:11,fontFamily:mono}}>
                <span style={{color:j.rush?T.red:T.text,minWidth:70}}>{j.rush?"🚨 ":""}{j.jobId}</span>
                <span style={{color:T.amber,minWidth:60}}>{j.coating}</span>
                <span style={{color:T.textDim,flex:1}}>{j.station}</span>
                <span style={{color:T.textDim,minWidth:50}}>{j.waitMin>0?`${j.waitMin}m`:""}</span>
                <div style={{display:"flex",gap:4}}>
                  {coaters.map(ct=>(
                    <button key={ct.id} onClick={()=>addToCoater(ct.id,j)}
                      style={{padding:"2px 8px",borderRadius:4,border:`1px solid ${T.blue}`,background:"transparent",color:T.blue,cursor:"pointer",fontSize:10,fontWeight:700}}>+{ct.name}</button>
                  ))}
                </div>
              </div>
            ))}
            {unassigned.length>200&&<div style={{color:T.textDim,fontSize:11,fontFamily:mono,textAlign:"center",padding:8}}>Showing first 200 of {unassigned.length}</div>}
          </div>
        </Card>
      )}
    </div>
  );
}

// ── Oven Status — Live rack timers ──────────────────────────
function OvenStatusView({intel,serverUrl}){
  const [ovenHistory,setOvenHistory]=useState([]);
  useEffect(()=>{
    const base=serverUrl||`http://${window.location.hostname}:3002`;
    fetch(`${base}/api/oven-runs?limit=50`).then(r=>r.json()).then(d=>setOvenHistory(d.runs||[])).catch(()=>{});
  },[serverUrl]);

  if(!intel) return <Card><div style={{color:T.textDim,fontFamily:mono,fontSize:13,textAlign:"center",padding:40}}>Loading...</div></Card>;
  const o=intel.ovens||{};
  const c=intel.capacity||{};
  const running=o.racksRunning||[];

  return(
    <div style={{display:"flex",flexDirection:"column",gap:16}}>
      {/* Running racks */}
      <Card style={{borderLeft:`4px solid ${T.orange}`}}>
        <SectionHeader right={`${running.length} active`}>Running Oven Racks</SectionHeader>
        {running.length===0?
          <div style={{color:T.textDim,fontFamily:mono,fontSize:12,textAlign:"center",padding:20}}>No oven racks currently running</div>
        :
          <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:10}}>
            {running.map((r,i)=>{
              const pct=r.target>0?Math.round(r.elapsed/r.target*100):0;
              const nearDone=r.remainingMin<=15;
              return(
                <div key={i} style={{background:T.bg,borderRadius:8,padding:14,border:`1px solid ${nearDone?T.green:T.border}`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <span style={{fontSize:13,fontWeight:700,color:T.text}}>{r.ovenId} — {r.rackLabel}</span>
                    <Pill color={nearDone?T.green:T.orange}>{r.state}</Pill>
                  </div>
                  <div style={{marginTop:8,fontFamily:mono,fontSize:12,color:T.amber}}>{r.coating}</div>
                  <div style={{marginTop:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:10,fontFamily:mono,color:T.textDim,marginBottom:3}}>
                      <span>{Math.floor(r.elapsed/60)}m elapsed</span>
                      <span>{r.remainingMin}m remaining</span>
                    </div>
                    <div style={{height:8,background:T.card,borderRadius:4,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${Math.min(100,pct)}%`,borderRadius:4,background:nearDone?T.green:pct>80?T.amber:T.blue,transition:"width 1s"}}/>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        }
      </Card>

      {/* Oven capacity */}
      <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
        <KPICard label="Racks In Use" value={o.racksInUse||0} sub={`of ${c.totalRacks||54}`} accent={T.orange}/>
        <KPICard label="Available" value={o.racksAvailable||0} sub="racks" accent={T.green}/>
        <KPICard label="Today Runs" value={o.todayRuns||0} sub="completed" accent={T.blue}/>
      </div>

      {/* Recent completed runs */}
      <Card>
        <SectionHeader right="Last 50">Completed Oven Runs</SectionHeader>
        {ovenHistory.length===0?
          <div style={{color:T.textDim,fontFamily:mono,fontSize:12,textAlign:"center",padding:20}}>No completed runs yet</div>
        :
          <div style={{maxHeight:400,overflowY:"auto"}}>
            {ovenHistory.slice(0,50).map((r,i)=>{
              const mins=Math.round((r.actualSecs||0)/60);
              const targetMins=Math.round((r.targetSecs||0)/60);
              const overTime=r.actualSecs>r.targetSecs;
              return(
                <div key={r.id||i} style={{display:"flex",alignItems:"center",gap:10,padding:"6px 0",borderBottom:`1px solid ${T.border}`,fontSize:11,fontFamily:mono}}>
                  <span style={{color:T.textMuted,minWidth:80}}>{r.ovenName||r.ovenId}</span>
                  <span style={{color:T.textDim,minWidth:40}}>{r.rackLabel||r.rack}</span>
                  <span style={{color:T.amber,minWidth:80}}>{r.coating||"?"}</span>
                  <span style={{color:overTime?T.red:T.green}}>{mins}m{targetMins?` / ${targetMins}m`:""}</span>
                  <span style={{color:T.textDim,marginLeft:"auto"}}>{r.completedAt?new Date(r.completedAt).toLocaleTimeString([],{hour:"2-digit",minute:"2-digit"}):""}</span>
                </div>
              );
            })}
          </div>
        }
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
  // Handle **bold**, [links](url), and download links inline
  const parts=text.split(/(\*\*[^*]+\*\*|\[[^\]]+\]\([^)]+\)|https?:\/\/\S+)/);
  return <>{parts.map((p,i)=>{
    if(p.startsWith("**")&&p.endsWith("**")&&p.length>4)
      return <strong key={i} style={{color:"#E2E8F0"}}>{p.slice(2,-2)}</strong>;
    const linkMatch=p.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if(linkMatch){
      const isDownload=linkMatch[2].includes('/api/knowledge/download/')||linkMatch[2].endsWith('.csv');
      return <a key={i} href={linkMatch[2]} target="_blank" rel="noopener noreferrer" download={isDownload||undefined}
        style={{color:"#60A5FA",textDecoration:"underline",cursor:"pointer"}}>{isDownload?"📥 ":""}{linkMatch[1]}</a>;
    }
    if(/^https?:\/\//.test(p)&&p.includes('/api/knowledge/download/')){
      return <a key={i} href={p} download style={{color:"#60A5FA",textDecoration:"underline",cursor:"pointer"}}>📥 Download Report</a>;
    }
    return <span key={i}>{p}</span>;
  })}</>;
}

// ══════════════════════════════════════════════════════════════
// ── Domain AI Configurations ──────────────────────────────────
// ══════════════════════════════════════════════════════════════

const DOMAIN_CONFIGS = {
  surfacing: {
    title: "Surfacing AI",
    greeting: "I'm your Surfacing specialist. I can help with machine alerts, error analysis, queue priority, and defect troubleshooting. I monitor SOM machine status in real-time.",
    quickPrompts: [
      { icon: "🚨", label: "Machine Alerts", text: "Use get_som_status() to check all Schneider machine errors and warnings. Which ones are repeating? What maintenance actions should we take?" },
      { icon: "📋", label: "Queue Status", text: "Use get_wip_jobs(department='S') and get_wip_snapshot() to summarize current surfacing queue status and priorities." },
      { icon: "🔴", label: "Rush Jobs", text: "Use get_wip_jobs(department='S') to list all rush jobs in surfacing. Show recommended priority order." },
      { icon: "⏱", label: "Time at Lab", text: "Use get_time_at_lab_summary() to show avg time-at-lab, stage dwell times, and the current bottleneck. What's the surfacing dwell time vs other departments?", isReport: true },
      { icon: "👤", label: "Operator Stats", text: "Use get_dvi_operator_data(department='S') to show operator performance. Who has the most jobs today? Rank by volume.", isReport: true },
      { icon: "📊", label: "Machine Health", text: "Use get_som_status() to generate a machine health report — uptime, error patterns, which machines need attention.", isReport: true },
      { icon: "📈", label: "Backlog Catch-Up", text: "Run a backlog catch-up analysis for Surfacing. Use get_backlog_catchup(department='surfacing') for the projection data. Then give me: current backlog, net daily gain/loss, days to clear, clear date, and weekly milestones. If we're falling behind, tell me exactly what output rate we need to catch up within 2 weeks.", isReport: true },
    ],
    buildContext: () => `You are the Surfacing Specialist AI for Pair Eyewear's lens lab.
TIMESTAMP: ${new Date().toLocaleString()}

IMPORTANT: Use your MCP tools to get ALL data. Do NOT invent any data.

KEY TOOLS FOR SURFACING:
- get_som_status() — SOM machine status, errors, conveyor health
- get_dvi_operator_data(department="S") — operator performance data
- get_time_at_lab_summary(period="7d") — time-at-lab, bottleneck ID
- get_time_at_lab_histogram(stage="SURFACING") — surfacing dwell distribution
- get_backlog_catchup(department="surfacing") — backlog recovery projection
- get_wip_jobs(department="S") — all surfacing jobs
- get_breakage_summary(department="S") — breakage stats
- get_throughput_trend(days=14) — daily throughput

SURFACING LINE ORDER: Blocking (CCU/CU1/CBB) → Generators (HSC) → Polishing (CCP) → Deblocking (DBA) → Fining (DNL) → Cleaning (CCS/LC1)

Schneider errors: "Waiting for trays"=starved, "Backflow"=jam, "BDEL timeout"=conveyor, "Polishing liquid"=temp, "Maintenance interval"=PM overdue.
Be direct and technical. Flag urgent issues first.`,
  },

  cutting: {
    title: "Cutting AI",
    greeting: "I'm your Cutting/Edging specialist. I can help with edge quality, frame fit, breakage analysis, and axis verification.",
    quickPrompts: [
      { icon: "📋", label: "Queue Status", text: "Use get_wip_jobs(department='E') to show current cutting queue depth and priorities." },
      { icon: "💥", label: "Recent Breaks", text: "Use get_breakage_events(department='E') to list all breaks in cutting today with causes and positions." },
      { icon: "🔴", label: "Rush Priority", text: "Use get_sla_at_risk() to show which rush jobs need immediate edging attention." },
      { icon: "⏱", label: "Time at Lab", text: "Use get_time_at_lab_summary() to show cutting dwell times and SLA compliance.", isReport: true },
      { icon: "👤", label: "Operator Stats", text: "Use get_dvi_operator_data(department='E') to rank cutting operators by jobs completed.", isReport: true },
      { icon: "📈", label: "Backlog Catch-Up", text: "Run a backlog catch-up analysis for Cutting. Use get_backlog_catchup(department='cutting'). Give me: current backlog, net daily gain/loss, days to clear, clear date, milestones. What output rate do we need to catch up in 2 weeks?", isReport: true },
    ],
    buildContext: () => `You are the Cutting/Edging Specialist AI for Pair Eyewear's lens lab.
TIMESTAMP: ${new Date().toLocaleString()}

IMPORTANT: Use your MCP tools to get ALL data. Do NOT invent any data.

KEY TOOLS FOR CUTTING:
- get_dvi_operator_data(department="E") — operator performance
- get_time_at_lab_summary(period="7d") — time-at-lab, bottleneck
- get_time_at_lab_histogram(stage="CUTTING") — cutting dwell distribution
- get_backlog_catchup(department="cutting") — backlog recovery
- get_wip_jobs(department="E") — all cutting jobs
- get_breakage_summary(department="E") — cutting breakage stats
- get_throughput_trend(days=14) — daily throughput

Help with: edge quality, frame-to-lens fit, axis verification, breakage analysis.`,
  },

  coating: {
    title: "Coating AI",
    greeting: "I'm your Coating specialist. I can help with batch timing, yield analysis, defect patterns, and oven/coater optimization.",
    quickPrompts: [
      { icon: "📊", label: "Batch Status", text: "Use get_coating_intelligence() to summarize all active coating batches, fill %, and recommendations." },
      { icon: "⏱", label: "Fill Prediction", text: "Use get_coating_intelligence() to predict when we should run the next batch for each coating type. Show fill % and ETA to full." },
      { icon: "📉", label: "Yield Analysis", text: "Use get_breakage_summary(department='C') to analyze coating yield rates. Flag anything below 90%.", isReport: true },
      { icon: "🌡", label: "Oven Timing", text: "Use get_oven_rack_status() to review current oven dwell times and recommend adjustments." },
      { icon: "🔴", label: "Rush Coating", text: "Use get_sla_at_risk() and get_coating_queue() to show rush jobs in coating and their ETA." },
      { icon: "👤", label: "Operator Stats", text: "Use get_dvi_operator_data(department='C') to rank coating operators by performance.", isReport: true },
      { icon: "📈", label: "Backlog Catch-Up", text: "Run a backlog catch-up analysis for Coating. Use get_backlog_catchup(department='coating'). Give me: current backlog, net daily gain/loss, days to clear, clear date, milestones. What output rate do we need?", isReport: true },
    ],
    buildContext: () => `You are the Coating Specialist AI for Pair Eyewear's lens lab.
TIMESTAMP: ${new Date().toLocaleString()}

IMPORTANT: Use your MCP tools to get ALL data. Do NOT invent any data.

KEY TOOLS FOR COATING:
- get_coating_intelligence() — batch suggestions, fill %, queue by coating+material
- get_coating_queue() — jobs waiting for coating
- get_oven_rack_status() — oven rack timers
- get_dvi_operator_data(department="C") — operator performance
- get_time_at_lab_summary(period="7d") — time-at-lab, bottleneck
- get_time_at_lab_histogram(stage="COATING") — coating dwell distribution
- get_backlog_catchup(department="coating") — backlog recovery
- get_wip_jobs(department="C") — all coating jobs
- get_breakage_summary(department="C") — coating rejects

Expert in AR, Blue Cut, Mirror, Transitions, Polarized, and Hard Coat.
Flag anything below 90% yield as a concern.`,
  },

  assembly: {
    title: "Assembly AI",
    greeting: "I'm your Assembly specialist. I can help with station optimization, operator performance, QC returns, and frame troubleshooting.",
    quickPrompts: [
      { icon: "📋", label: "Station Status", text: "Use get_wip_jobs(department='A') to show current assembly queue depth and job assignments by station." },
      { icon: "🏆", label: "Top Performers", text: "Use get_dvi_operator_data(department='A') to rank assembly operators by jobs completed today. Show top 5 with jobs/hour rate.", isReport: true },
      { icon: "🔴", label: "Rush Priority", text: "Use get_sla_at_risk() and get_wip_jobs(department='A') to list rush jobs needing immediate assembly attention." },
      { icon: "⏱", label: "Time at Lab", text: "Use get_time_at_lab_summary() to show assembly dwell times and overall SLA compliance. Where's the bottleneck?", isReport: true },
      { icon: "📊", label: "Shift Report", text: "Use get_throughput_trend(days=1), get_breakage_summary(department='A'), and get_dvi_operator_data(department='A') to generate a current shift summary.", isReport: true },
      { icon: "💥", label: "QC Returns", text: "Use get_breakage_summary(department='A') and get_breakage_events(department='A') to analyze recent QC returns and patterns." },
      { icon: "📈", label: "Backlog Catch-Up", text: "Run a backlog catch-up analysis for Assembly. Use get_backlog_catchup(department='assembly'). Give me: current backlog, net daily gain/loss, days to clear, clear date, milestones. What output rate do we need?", isReport: true },
    ],
    buildContext: () => `You are the Assembly Specialist AI for Pair Eyewear's lens lab.
TIMESTAMP: ${new Date().toLocaleString()}

IMPORTANT: Use your MCP tools to get ALL data. Do NOT invent any data.

KEY TOOLS FOR ASSEMBLY:
- get_dvi_operator_data(department="A") — jobs with operator assignments for performance ranking
- get_time_at_lab_summary(period="7d") — time-at-lab stats, stage dwell times, bottleneck
- get_time_at_lab_histogram(stage="ASSEMBLY") — how many jobs at each day-in-lab mark
- get_sla_at_risk() — jobs approaching or past SLA deadline
- get_backlog_catchup(department="assembly") — backlog recovery projection
- get_throughput_trend(days=14) — daily throughput for 2 weeks
- get_wip_jobs(department="A") — all assembly jobs
- get_breakage_summary(department="A") — assembly breakage stats

For "top assemblers" or operator performance: use get_dvi_operator_data — group results by operator field.

Help with: station optimization, operator performance, frame issues, QC returns, rush prioritization.`,
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
      { icon: "📈", label: "Backlog Catch-Up", text: "Run a backlog catch-up analysis for the full lab. Use get_backlog_catchup() for lab-wide data. Give me: current backlog, net daily gain/loss, days to clear, clear date, milestones. What daily ship rate do we need?", isReport: true },
    ],
    buildContext: () => `You are the Shipping Specialist AI for Pair Eyewear's lens lab.
TIMESTAMP: ${new Date().toLocaleString()}

IMPORTANT: Use your MCP tools to get ALL data. Call get_wip_jobs with stage="SHIP" or department="SH" for shipping jobs. Do NOT invent any data.

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
    buildContext: () => `You are the Inventory Specialist AI for Pair Eyewear's lens lab.
TIMESTAMP: ${new Date().toLocaleString()}

IMPORTANT: Use your MCP tools to get ALL data. Call get_inventory_summary for stock levels. Call get_inventory_detail for specific materials. Do NOT invent any data.

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
    buildContext: () => `You are the Maintenance Specialist AI for Pair Eyewear's lens lab.
TIMESTAMP: ${new Date().toLocaleString()}

IMPORTANT: Use your MCP tools to get ALL data. Call get_maintenance_summary for asset status. Call get_maintenance_tasks for work orders. Do NOT invent any data.

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
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  <button onClick={() => { setReportDownloading(i+10000); fetch(`${serverUrl}/api/report/visual`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:domain+' Report',narrative:m.content})}).then(r=>r.blob()).then(b=>{const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=`${domain}_Report_${new Date().toISOString().slice(0,10)}.html`;a.click();URL.revokeObjectURL(u);}).catch(e=>alert(e.message)).finally(()=>setReportDownloading(null)); }} disabled={reportDownloading != null}
                    style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", background: `${T.green}20`, border: `1px solid ${T.green}`, borderRadius: 4, color: T.green, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                    {reportDownloading === i+10000 ? "⏳..." : "📊 Visual"}
                  </button>
                  <button onClick={() => downloadWordReport(m, i)} disabled={reportDownloading != null}
                    style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", background: `${T.blue}20`, border: `1px solid ${T.blue}`, borderRadius: 4, color: T.blue, fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                    {reportDownloading === i ? "⏳..." : "📄 Word"}
                  </button>
                  <button onClick={() => { setReportDownloading(i+20000); fetch(`${serverUrl}/api/report/csv`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({title:domain+' Report'})}).then(r=>r.blob()).then(b=>{const u=URL.createObjectURL(b);const a=document.createElement('a');a.href=u;a.download=`${domain}_Report_${new Date().toISOString().slice(0,10)}.csv`;a.click();URL.revokeObjectURL(u);}).catch(e=>alert(e.message)).finally(()=>setReportDownloading(null)); }} disabled={reportDownloading != null}
                    style={{ alignSelf: "flex-start", display: "flex", alignItems: "center", gap: 4, padding: "4px 8px", background: `${T.amber || '#F59E0B'}20`, border: `1px solid ${T.amber || '#F59E0B'}`, borderRadius: 4, color: T.amber || '#F59E0B', fontSize: 9, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                    {reportDownloading === i+20000 ? "⏳..." : "📋 CSV"}
                  </button>
                </div>
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
        <input value={input} onChange={e => setInput(e.target.value)} onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey && !loading) { e.preventDefault(); sendMessage(); } }}
          placeholder={loading ? "Thinking..." : "Ask a question..."}
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
  const [somData,setSomData]=useState({devices:[],conveyors:[],zones:[],allTimeZones:[],activeJobs:null,todayTotal:0,total:0,isLive:false,lastPoll:null});

  // Fetch SOM machine + job data
  useEffect(()=>{
    const fetchSom=async()=>{
      try{
        const [devRes,convRes,ordRes,activeRes]=await Promise.all([
          fetch(`${ovenServerUrl}/api/som/devices`),
          fetch(`${ovenServerUrl}/api/som/conveyors`),
          fetch(`${ovenServerUrl}/api/som/orders`),
          fetch(`${ovenServerUrl}/api/jobs/active`)
        ]);
        const devData=devRes.ok?await devRes.json():{};
        const convData=convRes.ok?await convRes.json():{};
        const ordData=ordRes.ok?await ordRes.json():{};
        const activeData=activeRes.ok?await activeRes.json():null;
        const zones=(ordData.orders?.today||[]).map(d=>({departmentId:d.departmentId,name:d.departmentName,zone:d.zone,count:d.jobs}));
        const allTimeZones=(ordData.orders?.byDepartment||[]).map(d=>({departmentId:d.departmentId,name:d.departmentName,zone:d.zone,jobs:d.jobs}));
        setSomData(prev=>({
          devices:devData.devices||prev.devices,
          conveyors:convData.conveyors||prev.conveyors,
          zones:zones.length>0?zones:prev.zones,
          allTimeZones:allTimeZones.length>0?allTimeZones:prev.allTimeZones,
          activeJobs:activeData||prev.activeJobs,
          todayTotal:ordData.orders?.todayTotal||prev.todayTotal,
          total:ordData.orders?.total||prev.total,
          isLive:devData.isLive||ordData.isLive||false,
          lastPoll:devData.lastSuccessfulPoll||ordData.lastSuccessfulPoll||prev.lastPoll,
        }));
      }catch(e){ console.warn('SOM fetch:',e.message); }
    };
    fetchSom();
    const iv=setInterval(fetchSom,30000);
    return()=>clearInterval(iv);
  },[ovenServerUrl]);

  // Surfacing-related SOM categories
  const surfCategories = ['blocking','generators','polishing','deblocking','fining','cleaning'];
  const surfDevices = somData.devices.filter(d=>surfCategories.includes(d.category));
  const errorConveyors = somData.conveyors.filter(c=>c.status===4||c.statusLabel==='Error');

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

  // Build SOM machine context for AI
  const somErrors = surfDevices.filter(d => d.led?.status === 'error' || d.led?.status === 'warning');
  const somErrorSummary = surfDevices.map(d => ({
    id: d.id, name: d.name, category: d.category,
    status: d.statusLabel || d.status, event: d.event,
    ledStatus: d.led?.status, cycleTime: d.cycleTime,
    count: d.counts?.count1, lastOrder: (d.lastOrder||'').trim()
  }));

  const contextData = {
    jobs: surfacingJobs,
    queueCount: surfacingJobs.length,
    inProcessCount: inProcess.length,
    rushCount: rushJobs.length,
    holdCount: 0,
    somDevices: somErrorSummary,
    somErrors: somErrors.length,
    conveyorErrors: errorConveyors.map(c => ({ position: c.position, event: c.event })),
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
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file at /api/dvi/upload or check DVI Trace connection.' : 'No jobs in surfacing'}
          </div>
        )}
      </Card>

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}

      {/* SOM Production Status */}
      {(surfDevices.length > 0 || somData.zones.length > 0) && (
        <Card style={{ marginTop: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <SectionHeader>SOM Production Status</SectionHeader>
              <div style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <div style={{ width: 8, height: 8, borderRadius: '50%', background: somData.isLive ? T.green : T.red, boxShadow: somData.isLive ? `0 0 6px ${T.green}` : `0 0 6px ${T.red}` }} />
                <span style={{ fontSize: 10, fontFamily: mono, color: somData.isLive ? T.green : T.red, fontWeight: 600 }}>{somData.isLive ? 'LIVE' : 'OFFLINE'}</span>
              </div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 20, fontWeight: 800, color: T.text, fontFamily: mono }}>{somData.todayTotal || 0}</div>
              <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>JOBS TODAY</div>
            </div>
          </div>

          {/* Jobs by Stage (Today) */}
          {somData.zones.length > 0 && (() => {
            const ZONE_STYLES = { surfacing: { color: '#3B82F6', label: 'Production' }, ship: { color: '#22C55E', label: 'Complete' }, picking: { color: '#94A3B8', label: 'Unassigned' }, error: { color: '#EF4444', label: 'Error' }, coating: { color: '#F59E0B', label: 'Processing' }, control: { color: '#64748B', label: 'Control' } };
            const activeZones = somData.zones.filter(z => z.count > 0);
            return activeZones.length > 0 ? (
              <div style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>Jobs by Stage (Today)</div>
                <div style={{ display: 'grid', gridTemplateColumns: `repeat(${Math.min(activeZones.length, 4)}, 1fr)`, gap: 8 }}>
                  {activeZones.map(z => {
                    const zs = ZONE_STYLES[z.zone] || { color: '#64748B', label: z.name };
                    return (
                      <div key={z.zone} style={{ textAlign: 'center', padding: 10, background: T.bg, borderRadius: 8, border: `1px solid ${zs.color}30` }}>
                        <div style={{ fontSize: 9, fontWeight: 700, color: zs.color, fontFamily: mono }}>{zs.label}</div>
                        <div style={{ fontSize: 20, fontWeight: 800, color: T.text, fontFamily: mono }}>{z.count}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null;
          })()}

          {/* Active WIP breakdown */}
          {somData.activeJobs && (() => {
            const aj = somData.activeJobs;
            const zones = Object.values(aj.byZone || {}).filter(z => z.zone !== 'ship').sort((a, b) => b.jobs.length - a.jobs.length);
            if (zones.length === 0) return null;
            const ZONE_LABELS = { surfacing: { color: '#3B82F6', label: 'Production' }, ship: { color: '#22C55E', label: 'Complete' }, picking: { color: '#94A3B8', label: 'Unassigned' }, error: { color: '#EF4444', label: 'Error' }, coating: { color: '#F59E0B', label: 'Processing' }, control: { color: '#64748B', label: 'Control' } };
            const COAT_COLORS = { AR: '#3B82F6', BC: '#8B5CF6', HC: '#22C55E', MR: '#EC4899', PL: '#F59E0B', TR: '#06B6D4', DERA: '#14B8A6' };
            return (
              <div style={{ marginBottom: 16, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                  <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, textTransform: 'uppercase', letterSpacing: 1 }}>Active WIP ({aj.total?.toLocaleString()} jobs)</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>{aj.matchRate}/{aj.total} matched</div>
                </div>
                {zones.map(z => {
                  const zs = ZONE_LABELS[z.zone] || { color: '#64748B', label: z.deptName };
                  const zCoatings = {};
                  z.jobs.forEach(j => { if (j.dvi?.coating) zCoatings[j.dvi.coating] = (zCoatings[j.dvi.coating] || 0) + 1; });
                  const coatEntries = Object.entries(zCoatings).sort((a, b) => b[1] - a[1]);
                  return (
                    <div key={z.zone} style={{ marginBottom: 8, padding: 10, background: T.bg, borderRadius: 8, border: `1px solid ${zs.color}25` }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: coatEntries.length > 0 ? 6 : 0 }}>
                        <span style={{ fontSize: 11, fontWeight: 700, color: zs.color, fontFamily: mono }}>{zs.label}</span>
                        <span style={{ fontSize: 14, fontWeight: 800, color: T.text, fontFamily: mono }}>{z.jobs.length.toLocaleString()}</span>
                      </div>
                      {coatEntries.length > 0 && (
                        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {coatEntries.map(([coat, cnt]) => (
                            <span key={coat} style={{ fontSize: 9, fontFamily: mono, padding: '2px 6px', borderRadius: 4, background: (COAT_COLORS[coat] || '#475569') + '20', color: COAT_COLORS[coat] || '#94A3B8', fontWeight: 600 }}>{coat} {cnt}</span>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            );
          })()}

          {/* All-time totals */}
          {somData.allTimeZones.length > 0 && (
            <div style={{ marginBottom: 16, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, marginBottom: 8, textTransform: 'uppercase', letterSpacing: 1 }}>All-Time Jobs ({(somData.total || 0).toLocaleString()} total)</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {somData.allTimeZones.filter(z => z.jobs > 0).map(z => {
                  const ZONE_LABELS = { surfacing: { color: '#3B82F6', label: 'Production' }, ship: { color: '#22C55E', label: 'Complete' }, picking: { color: '#94A3B8', label: 'Unassigned' }, error: { color: '#EF4444', label: 'Error' }, coating: { color: '#F59E0B', label: 'Processing' }, control: { color: '#64748B', label: 'Control' } };
                  const zs = ZONE_LABELS[z.zone] || { color: '#64748B', label: z.name };
                  return (
                    <div key={z.zone} style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: T.bg, borderRadius: 6, border: `1px solid ${zs.color}25` }}>
                      <span style={{ fontSize: 10, color: zs.color, fontFamily: mono, fontWeight: 600 }}>{zs.label}</span>
                      <span style={{ fontSize: 12, fontWeight: 800, color: T.text, fontFamily: mono }}>{z.jobs.toLocaleString()}</span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {somData.lastPoll && (
            <div style={{ fontSize: 9, color: T.textDim, textAlign: 'center', marginBottom: 16, fontFamily: mono }}>
              Last updated: {new Date(somData.lastPoll).toLocaleTimeString()}
            </div>
          )}

          {/* Machines by category */}
          {surfDevices.length > 0 && <div style={{ paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
          <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>Surfacing Machines ({surfDevices.length})</div>
          {surfCategories.map(cat => {
            const devs = surfDevices.filter(d => d.category === cat);
            if (devs.length === 0) return null;
            const catLabel = cat.charAt(0).toUpperCase() + cat.slice(1);
            return (
              <div key={cat} style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>{catLabel} ({devs.length})</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
                  {devs.map(d => {
                    const ledColor = d.led?.status === 'error' ? T.red : d.led?.status === 'warning' ? T.amber : d.led?.green ? T.green : T.textDim;
                    return (
                      <div key={d.id} style={{ background: T.bg, border: `1px solid ${ledColor}30`, borderRadius: 8, padding: '10px 14px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <div style={{ width: 8, height: 8, borderRadius: '50%', background: ledColor, boxShadow: `0 0 6px ${ledColor}60` }} />
                            <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: mono }}>{d.name}</span>
                          </div>
                          <span style={{ fontSize: 10, color: ledColor, fontWeight: 600, fontFamily: mono }}>{d.statusLabel || d.status}</span>
                        </div>
                        <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono, marginBottom: 4 }}>{d.typeDescription || d.model}</div>
                        {d.event && <div style={{ fontSize: 9, color: d.led?.status === 'error' ? T.red : T.textDim, fontFamily: mono, marginBottom: 4, lineHeight: 1.4 }}>{d.event}</div>}
                        <div style={{ display: 'flex', gap: 12, fontSize: 9, color: T.textDim, fontFamily: mono }}>
                          {d.cycleTime && <span>Cycle: {d.cycleTime}s</span>}
                          {d.counts?.count1 > 0 && <span>Count: {d.counts.count1.toLocaleString()}</span>}
                          {d.lastOrder && d.lastOrder.trim() && <span>Last: #{d.lastOrder.trim()}</span>}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}

          </div>}

          {/* Conveyor errors */}
          {errorConveyors.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
              <div style={{ fontSize: 10, color: T.red, fontFamily: mono, letterSpacing: 1, marginBottom: 8 }}>CONVEYOR ERRORS ({errorConveyors.length})</div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {errorConveyors.map(c => (
                  <div key={c.id} style={{ background: `${T.red}10`, border: `1px solid ${T.red}30`, borderRadius: 6, padding: '6px 10px' }}>
                    <span style={{ fontSize: 10, fontWeight: 600, color: T.red, fontFamily: mono }}>{c.position}</span>
                    <div style={{ fontSize: 8, color: T.textDim, fontFamily: mono, marginTop: 2 }}>{c.event}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Maintenance Alert Board — repeating issues, warnings, suggestions */}
      {surfDevices.length > 0 && (() => {
        // Known Schneider error patterns → severity + suggestion
        const ERROR_PATTERNS = [
          { match: /backflow|rueckstau|rückstau/i, severity: 'critical', label: 'Tray Backup/Jam', suggestion: 'Clear tray jam at machine. Check conveyor upstream for blockages.' },
          { match: /BDEL timeout/i, severity: 'critical', label: 'Delivery Timeout', suggestion: 'Tray delivery failed. Check conveyor belt and upstream machine output.' },
          { match: /backup at belt|error.*belt/i, severity: 'critical', label: 'Conveyor Belt Error', suggestion: 'Belt jam is blocking the line. Physical intervention needed immediately.' },
          { match: /maintenance interval/i, severity: 'warning', label: 'PM Overdue', suggestion: 'Scheduled preventive maintenance is overdue. Create a work order in Limble.' },
          { match: /temperature.*not.*reached|setpoint temperature/i, severity: 'warning', label: 'Temp Not At Setpoint', suggestion: 'Fluid temperature below setpoint. Check heater, thermostat, and fluid level.' },
          { match: /water level min/i, severity: 'warning', label: 'Low Water Level', suggestion: 'Water level is at minimum. Refill tank before it triggers a shutdown.' },
          { match: /set up mode/i, severity: 'info', label: 'Setup Mode', suggestion: 'Machine is in setup mode — not processing jobs. Operator action needed to resume.' },
          { match: /unknown status/i, severity: 'warning', label: 'Unknown Status', suggestion: 'SOM cannot determine machine state. May need a reset or reconnection.' },
        ];

        const alerts = [];
        // Check all surfacing devices for known patterns
        for (const d of surfDevices) {
          const ev = d.event || '';
          if (!ev || ev.toLowerCase().includes('waiting for trays') || ev.toLowerCase().includes('reset by deviceserver')) continue;
          // Check if event is processing (not an issue)
          if (ev.toLowerCase().includes('tray(s) in process')) continue;

          let matched = false;
          for (const pat of ERROR_PATTERNS) {
            if (pat.match.test(ev)) {
              alerts.push({ machine: d.name, category: d.category, event: ev, led: d.led?.status, ...pat });
              matched = true;
              break;
            }
          }
          // Unmatched errors/warnings
          if (!matched && (d.led?.status === 'error' || d.led?.status === 'warning')) {
            alerts.push({ machine: d.name, category: d.category, event: ev, led: d.led?.status, severity: d.led?.status === 'error' ? 'warning' : 'info', label: 'Unusual Event', suggestion: 'Review machine event log. May need operator attention.' });
          }
        }
        // Add conveyor errors
        for (const c of errorConveyors) {
          for (const pat of ERROR_PATTERNS) {
            if (pat.match.test(c.event || '')) {
              alerts.push({ machine: c.position, category: 'conveyor', event: c.event, led: 'error', ...pat });
              break;
            }
          }
        }

        // Group by label to find repeating issues
        const grouped = {};
        alerts.forEach(a => {
          const key = a.label;
          if (!grouped[key]) grouped[key] = { ...a, machines: [a.machine], count: 1 };
          else { grouped[key].machines.push(a.machine); grouped[key].count++; }
        });
        const sortedAlerts = Object.values(grouped).sort((a, b) => {
          const sev = { critical: 0, warning: 1, info: 2 };
          return (sev[a.severity] || 3) - (sev[b.severity] || 3) || b.count - a.count;
        });

        if (sortedAlerts.length === 0) return null;

        const sevColor = { critical: T.red, warning: T.amber, info: T.blue };
        const sevIcon = { critical: '🔴', warning: '🟡', info: '🔵' };

        return (
          <Card style={{ marginTop: 20 }}>
            <SectionHeader right={`${alerts.length} issue${alerts.length !== 1 ? 's' : ''}`}>Maintenance Alerts</SectionHeader>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {sortedAlerts.map((a, i) => {
                const color = sevColor[a.severity] || T.textDim;
                return (
                  <div key={i} style={{ background: `${color}08`, border: `1px solid ${color}30`, borderRadius: 8, padding: '12px 16px', borderLeft: `4px solid ${color}` }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <span style={{ fontSize: 14 }}>{sevIcon[a.severity]}</span>
                        <span style={{ fontSize: 13, fontWeight: 700, color, fontFamily: mono }}>{a.label}</span>
                        {a.count > 1 && <span style={{ fontSize: 10, fontWeight: 700, color: T.text, background: `${color}25`, padding: '2px 8px', borderRadius: 10, fontFamily: mono }}>x{a.count}</span>}
                      </div>
                      <span style={{ fontSize: 10, color: T.textDim, fontFamily: mono, textTransform: 'uppercase' }}>{a.severity}</span>
                    </div>
                    <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono, marginBottom: 6 }}>
                      {a.count > 1 ? a.machines.join(', ') : a.machine} — {a.event}
                    </div>
                    <div style={{ fontSize: 11, color: T.text, fontFamily: mono, padding: '6px 10px', background: T.bg, borderRadius: 6, borderLeft: `2px solid ${color}` }}>
                      {a.suggestion}
                    </div>
                  </div>
                );
              })}
            </div>
          </Card>
        );
      })()}
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
  const [somDevices,setSomDevices]=useState([]);

  // Fetch SOM cutting machines
  useEffect(()=>{
    const fetchSom=async()=>{
      try{
        const res=await fetch(`${ovenServerUrl}/api/som/devices`);
        if(res.ok){ const d=await res.json(); setSomDevices(d.devices||[]); }
      }catch(e){ console.warn('SOM fetch:',e.message); }
    };
    fetchSom();
    const iv=setInterval(fetchSom,30000);
    return()=>clearInterval(iv);
  },[ovenServerUrl]);

  const cutterDevices = somDevices.filter(d=>d.category==='cutters');

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
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file or check DVI Trace connection.' : 'No jobs in cutting'}
          </div>
        )}
      </Card>

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}

      {/* SOM Cutting Machines */}
      {cutterDevices.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <SectionHeader right={`${cutterDevices.filter(d=>d.led?.green && !d.led?.red).length}/${cutterDevices.length} running`}>Cutting Machines (SOM)</SectionHeader>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 8 }}>
            {cutterDevices.map(d => {
              const ledColor = d.led?.status === 'error' ? T.red : d.led?.status === 'warning' ? T.amber : d.led?.green ? T.green : T.textDim;
              const isProcessing = (d.event||'').toLowerCase().includes('process');
              return (
                <div key={d.id} style={{ background: T.bg, border: `1px solid ${ledColor}30`, borderRadius: 8, padding: '10px 14px' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <div style={{ width: 8, height: 8, borderRadius: '50%', background: ledColor, boxShadow: `0 0 6px ${ledColor}60` }} />
                      <span style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: mono }}>{d.name}</span>
                    </div>
                    <span style={{ fontSize: 10, color: isProcessing ? T.green : ledColor, fontWeight: 600, fontFamily: mono }}>{isProcessing ? 'CUTTING' : d.statusLabel || d.status}</span>
                  </div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono, marginBottom: 4 }}>{d.typeDescription || d.model}</div>
                  {d.event && <div style={{ fontSize: 9, color: d.led?.status === 'error' ? T.red : T.textDim, fontFamily: mono, marginBottom: 4, lineHeight: 1.4 }}>{d.event}</div>}
                  <div style={{ display: 'flex', gap: 12, fontSize: 9, color: T.textDim, fontFamily: mono }}>
                    {d.cycleTime && <span>Cycle: {d.cycleTime}s</span>}
                    {d.counts?.count1 > 0 && <span>Count: {d.counts.count1.toLocaleString()}</span>}
                    {d.lastOrder && d.lastOrder.trim() && d.lastOrder.trim() !== 'XXXXXX' && <span>Last: #{d.lastOrder.trim()}</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </Card>
      )}

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
                <div style={{ fontFamily: mono, fontSize: 11, color: T.amber }}>{b.dept}</div>
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
const ASM_STATIONS = [
  {id:'STN-01',name:'Station 1',bench:'A',dvi:'ASSEMBLY #1'},
  {id:'STN-02',name:'Station 2',bench:'A',dvi:'ASSEMBLY #2'},
  {id:'STN-03',name:'Station 3',bench:'A',dvi:'ASSEMBLY #3'},
  {id:'STN-04',name:'Station 4',bench:'B',dvi:'ASSEMBLY #4'},
  {id:'STN-05',name:'Station 5',bench:'B',dvi:'ASSEMBLY #5'},
  {id:'STN-06',name:'Station 6',bench:'B',dvi:'ASSEMBLY #6'},
  {id:'STN-07',name:'Station 7',bench:'C',dvi:'ASSEMBLY #7'},
  {id:'STN-08',name:'Station 8',bench:'C',dvi:'ASSEMBLY #8'},
  {id:'STN-09',name:'Station 9',bench:'C',dvi:'ASSEMBLY #9'},
  {id:'STN-10',name:'Station 10',bench:'D',dvi:'ASSEMBLY #10'},
  {id:'STN-11',name:'Station 11',bench:'D',dvi:'ASSEMBLY #11'},
  {id:'STN-12',name:'Station 12',bench:'D',dvi:'ASSEMBLY #12'},
  {id:'STN-13',name:'Station 13',bench:'D',dvi:'ASSEMBLY #13'},
  {id:'STN-14',name:'Station 14',bench:'E',dvi:'ASSEMBLY #14'},
  {id:'STN-15',name:'Station 15',bench:'E',dvi:'ASSEMBLY #15'},
];

function AssemblyTab({ trays, dviJobs=[], ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";
  const [selectedJob, setSelectedJob] = useState(null);
  const [search,setSearch]=useState('');
  const [asmData,setAsmData]=useState(null);
  const [asmConfig,setAsmConfig]=useState(null);
  const [showAssign,setShowAssign]=useState(false);
  const [localAssignments,setLocalAssignments]=useState({});
  const [localOpMap,setLocalOpMap]=useState({});
  const [editingStn,setEditingStn]=useState(null);
  const [editName,setEditName]=useState('');
  const [asmHistory,setAsmHistory]=useState([]);

  // Fetch assembly leaderboard data + operator config
  useEffect(()=>{
    const fetchAsm=async()=>{
      try{
        const [jobsRes, cfgRes, histRes] = await Promise.all([
          fetch(`${ovenServerUrl}/api/assembly/jobs`),
          fetch(`${ovenServerUrl}/api/assembly/config`),
          fetch(`${ovenServerUrl}/api/assembly/history?days=30`),
        ]);
        if(jobsRes.ok) setAsmData(await jobsRes.json());
        if(histRes.ok){const hd=await histRes.json();setAsmHistory(hd.history||[]);}
        if(cfgRes.ok){
          const cfg = await cfgRes.json();
          setAsmConfig(cfg);
          if(cfg.assignments && Object.keys(cfg.assignments).length > 0){
            setLocalAssignments(cfg.assignments);
          }
          if(cfg.operatorMap && Object.keys(cfg.operatorMap).length > 0){
            setLocalOpMap(cfg.operatorMap);
          }
        }
      }catch(e){ console.warn('Assembly fetch:',e.message); }
    };
    fetchAsm();
    const iv=setInterval(fetchAsm,30000);
    return()=>clearInterval(iv);
  },[ovenServerUrl]);

  // Save assignments to server
  const saveAssignments = async (newAssign, newOpMap) => {
    const a = newAssign || localAssignments;
    const m = newOpMap || localOpMap;
    setLocalAssignments(a);
    setLocalOpMap(m);
    try {
      await fetch(`${ovenServerUrl}/api/assembly/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ assignments: a, operatorMap: m })
      });
    } catch(e) { console.warn('Save assignments:', e.message); }
  };

  const assignOperator = (stnId, name) => {
    const color = ['#8B5CF6','#3B82F6','#10B981','#F59E0B','#EF4444','#EC4899','#06B6D4','#84CC16','#F97316','#A78BFA'][Math.abs([...name].reduce((h,c)=>((h<<5)-h)+c.charCodeAt(0),0)) % 10];
    const newA = { ...localAssignments, [stnId]: { operatorName: name, color, status: 'busy', startTime: Date.now() } };
    saveAssignments(newA);
  };

  const clearStation = (stnId) => {
    const newA = { ...localAssignments };
    delete newA[stnId];
    saveAssignments(newA);
  };

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
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>ASSEMBLED</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{asmData?.completedToday || 0}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>PASSED</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{asmData?.passFailToday?.pass || passJobs.length}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>FAILED</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: (asmData?.passFailToday?.fail || failJobs.length) > 0 ? T.red : T.green, fontFamily: mono }}>{asmData?.passFailToday?.fail || failJobs.length}</div>
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
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file or check DVI Trace connection.' : 'No jobs in assembly'}
          </div>
        )}
      </Card>

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}

      {/* Operator Station Assignments */}
      <Card style={{ marginBottom: 20 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <SectionHeader>Station Assignments</SectionHeader>
          <button onClick={()=>setShowAssign(!showAssign)}
            style={{ background: showAssign ? `${T.blue}20` : 'transparent', border: `1px solid ${showAssign ? T.blue : T.border}`, borderRadius: 6, padding: '6px 12px', color: showAssign ? T.blue : T.textDim, fontSize: 11, fontFamily: mono, cursor: 'pointer' }}>
            {showAssign ? 'Done' : 'Edit Assignments'}
          </button>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8, marginTop: 12 }}>
          {ASM_STATIONS.map(stn => {
            const a = localAssignments[stn.id];
            const stnComp = asmData?.stationCompletions || {};
            const completed = stnComp[stn.dvi] || 0;
            const isEditing = editingStn === stn.id;
            return (
              <div key={stn.id} style={{ background: a ? `${a.color || T.blue}15` : T.bg, border: `1px solid ${a ? (a.color || T.blue) + '40' : T.border}`, borderRadius: 8, padding: '10px 12px', position: 'relative' }}>
                <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>{stn.dvi}</div>
                {a ? (
                  <div>
                    <div style={{ fontSize: 13, fontWeight: 700, color: a.color || T.blue, fontFamily: mono, marginTop: 4 }}>{a.operatorName}</div>
                    <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>{completed} jobs</div>
                    {showAssign && <button onClick={()=>clearStation(stn.id)} style={{ position: 'absolute', top: 4, right: 6, background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 12 }}>x</button>}
                  </div>
                ) : (
                  <div>
                    {showAssign ? (
                      isEditing ? (
                        <form onSubmit={e=>{e.preventDefault();if(editName.trim()){assignOperator(stn.id,editName.trim());setEditingStn(null);setEditName('');}}} style={{ marginTop: 4 }}>
                          <input autoFocus value={editName} onChange={e=>setEditName(e.target.value)} onBlur={()=>{if(!editName.trim())setEditingStn(null);}} placeholder="Name..."
                            style={{ width: '100%', background: T.surface, border: `1px solid ${T.blue}`, borderRadius: 4, padding: '4px 6px', color: T.text, fontSize: 11, fontFamily: mono }} />
                        </form>
                      ) : (
                        <button onClick={()=>{setEditingStn(stn.id);setEditName('');}} style={{ marginTop: 4, background: 'none', border: `1px dashed ${T.border}`, borderRadius: 4, padding: '4px 8px', color: T.textDim, fontSize: 10, fontFamily: mono, cursor: 'pointer', width: '100%' }}>+ Assign</button>
                      )
                    ) : (
                      <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono, marginTop: 4 }}>—</div>
                    )}
                    {completed > 0 && <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>{completed} jobs</div>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Operator Merge — map DVI initials to operator names */}
      {showAssign && (
        <Card style={{ marginBottom: 20 }}>
          <SectionHeader>Operator Merge (DVI Initials → Name)</SectionHeader>
          <p style={{ fontSize: 11, color: T.textDim, fontFamily: mono, margin: '4px 0 12px' }}>
            Map DVI initials to an operator name. Jobs from those initials merge into that operator's count.
          </p>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 12 }}>
            {Object.entries(localOpMap).map(([init, name]) => (
              <div key={init} style={{ display: 'flex', alignItems: 'center', gap: 6, background: `${T.purple}15`, border: `1px solid ${T.purple}40`, borderRadius: 6, padding: '4px 10px' }}>
                <span style={{ fontSize: 12, fontWeight: 700, color: T.purple, fontFamily: mono }}>{init}</span>
                <span style={{ fontSize: 10, color: T.textDim }}>→</span>
                <span style={{ fontSize: 12, color: T.text, fontFamily: mono }}>{name}</span>
                <button onClick={() => { const m = { ...localOpMap }; delete m[init]; saveAssignments(null, m); }}
                  style={{ background: 'none', border: 'none', color: T.red, cursor: 'pointer', fontSize: 11, padding: '0 2px' }}>×</button>
              </div>
            ))}
          </div>
          <form onSubmit={e => {
            e.preventDefault();
            const fd = new FormData(e.target);
            const init = (fd.get('init') || '').trim().toUpperCase();
            const name = (fd.get('name') || '').trim();
            if (init && name) {
              const m = { ...localOpMap, [init]: name };
              saveAssignments(null, m);
              e.target.reset();
            }
          }} style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
            <input name="init" placeholder="Initials (e.g. AF)" maxLength={4}
              style={{ width: 80, padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 11, fontFamily: mono }} />
            <span style={{ color: T.textDim, fontSize: 11 }}>→</span>
            <input name="name" placeholder="Operator name" list="asm-op-names"
              style={{ width: 150, padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 11, fontFamily: mono }} />
            <datalist id="asm-op-names">
              {[...new Set(Object.values(localAssignments).map(a => a.operatorName))].map(n => <option key={n} value={n} />)}
            </datalist>
            <button type="submit" style={{ padding: '6px 12px', background: T.purple, border: 'none', borderRadius: 6, color: '#fff', fontSize: 11, fontFamily: mono, cursor: 'pointer', fontWeight: 700 }}>+ Merge</button>
          </form>
          {/* Show unmatched initials from DVI trace */}
          {asmData?.operatorStats && (() => {
            const mapped = new Set(Object.keys(localOpMap).map(k => k.toUpperCase()));
            const assigned = new Set(Object.values(localAssignments).map(a => a.operatorName.toUpperCase()));
            const unmatched = Object.keys(asmData.operatorStats).filter(init => !mapped.has(init.toUpperCase()) && !assigned.has(init.toUpperCase()));
            if (unmatched.length === 0) return null;
            return (
              <div style={{ marginTop: 10, padding: '8px 10px', background: `${T.amber}10`, borderRadius: 6, border: `1px solid ${T.amber}30` }}>
                <div style={{ fontSize: 10, fontWeight: 700, color: T.amber, marginBottom: 4, fontFamily: mono }}>UNMERGED DVI INITIALS:</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {unmatched.map(init => (
                    <span key={init} style={{ fontSize: 11, color: T.text, fontFamily: mono, background: T.bg, padding: '2px 8px', borderRadius: 4, border: `1px solid ${T.border}` }}>
                      {init} ({asmData.operatorStats[init]?.jobs || 0} jobs)
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}
        </Card>
      )}

      {/* Leaderboard — uses station assignments to attribute completions */}
      {asmData && (() => {
        const stnComp = asmData.stationCompletions || {};
        const stnOps = asmData.stationOperators || {}; // 'ASSEMBLY #7' → 'AF' (from DVI trace)
        const shiftCfg = JSON.parse(localStorage.getItem('asy_cfg') || '{}');
        const [sh, sm] = (shiftCfg.shiftStart || '07:00').split(':').map(Number);
        const shiftMs = new Date(); shiftMs.setHours(sh, sm, 0, 0);
        const shiftH = Math.max(0.5, (Date.now() - shiftMs.getTime()) / 3600000);

        // Build per-operator stats: assignments first, then DVI trace operator data
        const opStats = {};
        // 1. Attribute via station assignments (primary source)
        Object.entries(localAssignments).forEach(([stnId, a]) => {
          if (!a?.operatorName) return;
          const stn = ASM_STATIONS.find(s => s.id === stnId);
          if (!stn) return;
          const completed = stnComp[stn.dvi] || 0;
          const key = a.operatorName;
          if (!opStats[key]) opStats[key] = { name: a.operatorName, initials: a.operatorName.slice(0,2).toUpperCase(), jobs: 0, color: a.color, stations: [] };
          opStats[key].jobs += completed;
          if (completed > 0) opStats[key].stations.push(stn.dvi.replace('ASSEMBLY ',''));
        });
        // 2. Add trace operator data for unassigned stations
        const assignedDviStations = new Set(Object.entries(localAssignments).filter(([,a])=>a?.operatorName).map(([stnId])=>{const s=ASM_STATIONS.find(x=>x.id===stnId);return s?.dvi;}).filter(Boolean));
        if (asmData.operatorStats) {
          Object.entries(asmData.operatorStats).forEach(([init, stats]) => {
            const name = localOpMap[init.toUpperCase()] || init;
            if (!opStats[name]) opStats[name] = { name, initials: init, jobs: 0, stations: [] };
            opStats[name].jobs += (stats.jobs || 0);
          });
        }
        // 3. Unassigned station completions
        Object.entries(stnComp).forEach(([stn, count]) => {
          if (count <= 0 || assignedDviStations.has(stn)) return;
          const init = stnOps[stn];
          if (init && opStats[localOpMap[init.toUpperCase()] || init]) return; // already counted via trace
          const label = stn.replace('ASSEMBLY ','Stn ');
          if (!opStats[stn]) opStats[stn] = { name: label, initials: stn.match(/#(\d+)/)?.[1] || '?', jobs: 0, stations: [stn.replace('ASSEMBLY ','')] };
          opStats[stn].jobs += count;
        });
        Object.values(opStats).forEach(o => { o.jobsPerHour = o.jobs / shiftH; });
        const ops = Object.values(opStats).filter(o=>o.jobs>0).sort((a,b)=>b.jobs-a.jobs);
        const medals = ['🥇','🥈','🥉'];
        const rankColors = [T.amber, '#C0C0C0', '#CD7F32'];
        const maxJobs = Math.max(1, ...ops.map(o=>o.jobs));
        const winner = ops[0];
        return ops.length > 0 ? (
          <Card style={{ marginTop: 20 }}>
            <SectionHeader right={`${ops.length} stations`}>Leaderboard</SectionHeader>

            {/* Winner banner */}
            {winner && winner.jobs > 0 && (
              <div style={{ background: 'linear-gradient(135deg, #2A2200, #1A1000)', border: `2px solid ${T.amber}`, borderRadius: 14, padding: 16, display: 'flex', alignItems: 'center', gap: 16, marginBottom: 16 }}>
                <div style={{ fontSize: 40 }}>🏆</div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 18, fontWeight: 800, color: T.amber, fontFamily: mono, letterSpacing: 1 }}>{winner.name}</div>
                  <div style={{ fontSize: 10, color: T.amber, fontFamily: mono }}>TODAY'S LEADER · {winner.jobs} JOBS · {(winner.jobsPerHour||0).toFixed(1)}/HR</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 32, fontWeight: 800, color: T.amber, fontFamily: mono }}>{winner.jobs}</div>
                  <div style={{ fontSize: 9, color: T.amber, fontFamily: mono }}>JOBS</div>
                </div>
              </div>
            )}

            {/* Ranked rows */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {ops.map((op, i) => {
                const isTop3 = i < 3;
                const barPct = Math.round((op.jobs / maxJobs) * 100);
                const color = isTop3 ? rankColors[i] : T.blue;
                return (
                  <div key={op.name} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '10px 14px', background: T.bg, borderRadius: 8, border: isTop3 ? `1px solid ${color}40` : `1px solid ${T.border}` }}>
                    <div style={{ width: 28, textAlign: 'center', fontSize: 20 }}>{medals[i] || ''}</div>
                    <div style={{ width: 36, height: 36, borderRadius: '50%', background: isTop3 ? `${color}30` : `${T.blue}20`, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 13, fontWeight: 700, color: isTop3 ? color : T.blue, fontFamily: mono }}>{(op.initials || op.name || '??').slice(0,2).toUpperCase()}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 13, fontWeight: 700, color: T.text, fontFamily: mono, marginBottom: 4 }}>{op.name}{op.station ? <span style={{color:T.textDim,fontWeight:400}}> · {op.station}</span> : ''}</div>
                      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                        <div style={{ flex: 1, height: 6, background: T.surface, borderRadius: 3, overflow: 'hidden' }}>
                          <div style={{ width: `${barPct}%`, height: '100%', background: color, borderRadius: 3, transition: 'width 0.5s' }} />
                        </div>
                        <span style={{ fontSize: 9, color: T.textDim, fontFamily: mono, whiteSpace: 'nowrap' }}>{(op.jobsPerHour||0).toFixed(1)}/hr</span>
                      </div>
                    </div>
                    <div style={{ textAlign: 'right', minWidth: 40 }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: isTop3 ? color : T.green, fontFamily: mono }}>{op.jobs}</div>
                      <div style={{ fontSize: 8, color: T.textDim, fontFamily: mono }}>TODAY</div>
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Station completions */}
            {asmData.byStation && (() => {
              const stations = Object.values(asmData.byStation).filter(s=>s.completedToday>0).sort((a,b)=>b.completedToday-a.completedToday);
              return stations.length > 0 ? (
                <div style={{ marginTop: 16, paddingTop: 12, borderTop: `1px solid ${T.border}` }}>
                  <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1, marginBottom: 8, textTransform: 'uppercase' }}>Station Completions Today</div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                    {stations.map(s => (
                      <div key={s.station} style={{ background: T.bg, border: `1px solid ${T.border}`, borderRadius: 8, padding: '8px 14px', textAlign: 'center', minWidth: 90 }}>
                        <div style={{ fontSize: 10, fontWeight: 600, color: T.textMuted, fontFamily: mono }}>{s.station.replace('ASSEMBLY ','')}</div>
                        <div style={{ fontSize: 18, fontWeight: 800, color: T.green, fontFamily: mono }}>{s.completedToday}</div>
                      </div>
                    ))}
                  </div>
                </div>
              ) : null;
            })()}
          </Card>
        ) : null;
      })()}

      {/* Historical Assembly Data — daily totals with per-operator breakdown */}
      {asmHistory.length>0&&(
        <Card style={{marginTop:20}}>
          <SectionHeader>Assembly History — Daily Totals</SectionHeader>
          <div style={{maxHeight:400,overflowY:"auto"}}>
            <table style={{width:"100%",fontSize:10,fontFamily:mono,borderCollapse:"collapse"}}>
              <thead>
                <tr style={{borderBottom:`1px solid ${T.border}`,position:"sticky",top:0,background:T.card}}>
                  {["Date","Jobs","Events","Operators","Top Performers"].map(h=><th key={h} style={{padding:"6px 10px",textAlign:"left",color:T.textMuted,fontSize:9,letterSpacing:"0.08em"}}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {asmHistory.map(day=>{
                  const ops=Object.entries(day.byOperator||{}).sort((a,b)=>b[1]-a[1]);
                  return(
                    <tr key={day.date} style={{borderBottom:`1px solid #0d1117`}}>
                      <td style={{padding:"6px 10px",color:T.text,fontWeight:600}}>{day.date}</td>
                      <td style={{padding:"6px 10px",color:T.green,fontWeight:700,fontSize:14}}>{day.jobs}</td>
                      <td style={{padding:"6px 10px",color:"#475569"}}>{day.events}</td>
                      <td style={{padding:"6px 10px",color:T.blue}}>{day.operators}</td>
                      <td style={{padding:"6px 10px"}}>
                        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                          {ops.slice(0,5).map(([name,count],i)=>(
                            <span key={name} style={{fontSize:9,padding:"1px 6px",borderRadius:3,background:i===0?`${T.green}22`:T.surface,border:`1px solid ${i===0?`${T.green}44`:T.border}`,color:i===0?T.green:T.text}}>
                              {name}: {count}
                            </span>
                          ))}
                          {ops.length>5&&<span style={{fontSize:9,color:T.textDim}}>+{ops.length-5} more</span>}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Incoming Tab ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function IncomingTab({ ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";
  const [data, setData] = useState(null);
  const [days, setDays] = useState(30);

  useEffect(() => {
    if (!ovenServerUrl) return;
    const go = async () => {
      try {
        const resp = await fetch(`${ovenServerUrl}/api/dvi/incoming?days=${days}`);
        if (resp.ok) setData(await resp.json());
      } catch {}
    };
    go();
    const iv = setInterval(go, 60000);
    return () => clearInterval(iv);
  }, [ovenServerUrl, days]);

  const daysList = data?.days || [];
  const maxCount = Math.max(1, ...daysList.map(d => d.count));
  const today = new Date().toISOString().slice(0, 10);
  const todayCount = daysList.find(d => d.date === today)?.count || 0;

  return (
    <ProductionStageTab domain="incoming" contextData={{ incomingToday: todayCount, avg: data?.avg || 0 }} serverUrl={ovenServerUrl} settings={settings}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>Incoming Work</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Daily incoming job count from DVI</p>
        </div>
        <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>TODAY</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{todayCount}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>DAILY AVG</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{data?.avg || 0}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>TOTAL ({data?.dayCount || 0}d)</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.textMuted, fontFamily: mono }}>{(data?.total || 0).toLocaleString()}</div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            {[14, 30, 60, 90].map(d => (
              <button key={d} onClick={() => setDays(d)} style={{
                padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                background: days === d ? T.blue : 'transparent',
                color: days === d ? '#fff' : T.textMuted,
                border: `1px solid ${days === d ? T.blue : T.border}`
              }}>{d}d</button>
            ))}
          </div>
        </div>
      </div>

      {/* Bar Chart */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${daysList.length} days`}>Incoming Jobs by Day</SectionHeader>
        <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          {daysList.map(d => {
            const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
            const barPct = Math.round((d.count / maxCount) * 100);
            const isToday = d.date === today;
            const isWeekend = [0, 6].includes(new Date(d.date + 'T12:00:00').getDay());
            return (
              <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 12px', background: isToday ? `${T.blue}15` : T.bg, borderRadius: 6, border: `1px solid ${isToday ? T.blue : T.border}` }}>
                <div style={{ width: 120, fontSize: 11, fontWeight: isToday ? 700 : 600, color: isToday ? T.blue : isWeekend ? T.textDim : T.textMuted, fontFamily: mono }}>{isToday ? 'TODAY' : dayName}</div>
                <div style={{ flex: 1, height: 8, background: T.surface, borderRadius: 4, overflow: 'hidden' }}>
                  <div style={{ width: `${barPct}%`, height: '100%', background: isToday ? T.blue : d.count >= (data?.avg || 0) ? T.green : T.amber, borderRadius: 4, transition: 'width 0.5s' }} />
                </div>
                <div style={{ minWidth: 50, textAlign: 'right', fontSize: 16, fontWeight: 800, color: isToday ? T.blue : d.count > 0 ? T.text : T.textDim, fontFamily: mono }}>{d.count}</div>
              </div>
            );
          })}
        </div>
        {daysList.length === 0 && (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No incoming data available</div>
        )}
      </Card>
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
  const [shippedHistory,setShippedHistory]=useState([]);

  // Fetch shipped history
  useEffect(()=>{
    const fetchHistory=async()=>{
      try{
        const res=await fetch(`${ovenServerUrl}/api/shipping/history?days=14`);
        if(res.ok){ const d=await res.json(); setShippedHistory(d.history||[]); }
      }catch{}
    };
    fetchHistory();
    const iv=setInterval(fetchHistory,60000);
    return()=>clearInterval(iv);
  },[ovenServerUrl]);

  // Filter DVI jobs in shipping (SH CONVEY stations) - exclude already shipped jobs (they're in DB)
  const shippingJobs = useMemo(() => {
    return dviJobs.filter(j => {
      const stage = (j.stage || j.Stage || '').toUpperCase();
      const station = (j.station || '').toUpperCase();
      // Only include jobs in shipping stage that haven't been shipped yet
      return (stage === 'SHIPPING' || station.includes('SH CONVEY')) && j.status !== 'SHIPPED';
    });
  }, [dviJobs]);

  // Shipped jobs today — from server API (dviJobs has shipped filtered out for WIP display)
  const shippedJobs = shippedStats.todayJobs || [];

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
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>THIS WEEK</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: T.textMuted, fontFamily: mono }}>{shippedStats.thisWeek || 0}</div>
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
            {dviJobs.length===0 ? 'No DVI data loaded. Upload a file or check DVI Trace connection.' : 'No jobs in shipping'}
          </div>
        )}
      </Card>

      {/* Shipped Today */}
      <Card style={{ marginBottom: 20 }}>
        <SectionHeader right={`${shippedJobs.length} jobs`}>Shipped Today</SectionHeader>
        {shippedJobs.length > 0 ? (
          <div style={{ maxHeight: 400, overflowY: 'auto' }}>
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
                {shippedJobs.slice(0, 100).map((j,i) => (
                  <tr key={j.job_id||j.invoice||i} onClick={()=>setSelectedJob(j)} style={{ borderBottom: `1px solid ${T.border}`, cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e=>e.currentTarget.style.background=`${T.green}08`} onMouseLeave={e=>e.currentTarget.style.background='transparent'}>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 12, fontWeight: 700, color: T.text }}>
                      {j.job_id || j.invoice || "—"}
                    </td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.station || j.stage || "—"}</td>
                    <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{j.date || j.entryDate || "—"}</td>
                    <td style={{ padding: "10px 12px" }}><Pill color={T.green}>SHIPPED</Pill></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div style={{ padding: 20, textAlign: "center", color: T.textDim, fontFamily: mono, fontSize: 12 }}>
            No shipped jobs today
          </div>
        )}
      </Card>

      {/* Shipped History — past days */}
      {shippedHistory.length > 0 && (
        <Card style={{ marginBottom: 20 }}>
          <SectionHeader right={`${shippedHistory.length} days`}>Shipped History</SectionHeader>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            {shippedHistory.filter(d=>d.date!==new Date().toISOString().slice(0,10)).map(d => {
              const dayName = new Date(d.date+'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
              const maxShipped = Math.max(1, ...shippedHistory.map(h=>h.shipped));
              const barPct = Math.round((d.shipped / maxShipped) * 100);
              return (
                <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '8px 12px', background: T.bg, borderRadius: 6, border: `1px solid ${T.border}` }}>
                  <div style={{ width: 100, fontSize: 11, fontWeight: 600, color: T.textMuted, fontFamily: mono }}>{dayName}</div>
                  <div style={{ flex: 1, height: 6, background: T.surface, borderRadius: 3, overflow: 'hidden' }}>
                    <div style={{ width: `${barPct}%`, height: '100%', background: d.shipped > 0 ? T.green : T.textDim, borderRadius: 3, transition: 'width 0.5s' }} />
                  </div>
                  <div style={{ minWidth: 50, textAlign: 'right', fontSize: 16, fontWeight: 800, color: d.shipped > 0 ? T.green : T.textDim, fontFamily: mono }}>{d.shipped}</div>
                  {d.rush > 0 && <Pill color={T.red}>{d.rush} rush</Pill>}
                </div>
              );
            })}
          </div>
        </Card>
      )}

      {/* Job Detail Panel */}
      {selectedJob && <JobDetailPanel job={selectedJob} onClose={()=>setSelectedJob(null)} />}
    </ProductionStageTab>
  );
}

// ══════════════════════════════════════════════════════════════
// ── Claude AI Assistant Tab ───────────────────────────────────
// ══════════════════════════════════════════════════════════════
// ══════════════════════════════════════════════════════════════
// ── Aging Jobs Tab ──────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function AgingJobsTab({ ovenServerUrl, settings }) {
  const mono = "'JetBrains Mono',monospace";
  const [data, setData] = useState(null);
  const [filter, setFilter] = useState('all');
  const [search, setSearch] = useState('');

  useEffect(() => {
    if (!ovenServerUrl) return;
    const go = () => fetch(`${ovenServerUrl}/api/aging/jobs`).then(r => r.json()).then(setData).catch(() => {});
    go();
    const iv = setInterval(go, 60000);
    return () => clearInterval(iv);
  }, [ovenServerUrl]);

  const jobs = data?.jobs || [];
  const sm = data?.summary || {};
  let filtered = jobs;
  if (filter === 'Single Vision' || filter === 'Surfacing') filtered = filtered.filter(j => j.jobType === filter);
  else if (filter !== 'all') filtered = filtered.filter(j => j.zone === filter);
  if (search) {
    const q = search.toLowerCase();
    filtered = filtered.filter(j => (j.job_id||'').toLowerCase().includes(q) || (j.station||'').toLowerCase().includes(q) || (j.coating||'').toLowerCase().includes(q));
  }

  const zoneColors = { GREEN: T.green, YELLOW: T.amber, RED: T.red, CRITICAL: '#cc0000' };

  return (
    <ProductionStageTab domain="aging" contextData={{ avgDays: sm.avgDays, outlierPct: sm.outlierPct }} serverUrl={ovenServerUrl} settings={settings}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: 24, fontWeight: 800, color: T.text }}>Aging Jobs</h2>
          <p style={{ margin: "4px 0 0", color: T.textMuted, fontSize: 13 }}>Active WIP jobs by time in lab</p>
        </div>
        <div style={{ display: "flex", gap: 16 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>AVG DAYS</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{sm.avgDays || 0}</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>OUTLIER %</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: (sm.outlierPct || 0) > 5 ? T.red : T.green, fontFamily: mono }}>{sm.outlierPct || 0}%</div>
          </div>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>TOTAL WIP</div>
            <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{sm.total || 0}</div>
          </div>
        </div>
      </div>

      {/* Zone cards with action descriptions */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 16 }}>
        {[
          { zone: 'GREEN', label: '0-1 days', color: T.green, action: 'On track. No action needed.' },
          { zone: 'YELLOW', label: '1-2 days', color: T.amber, action: 'Watch list. Check if these jobs are stuck at a station.' },
          { zone: 'RED', label: '2-3 days', color: T.red, action: 'Supervisor review. Find out why these jobs haven\'t moved. Check for holds, breakage, or missing materials.' },
          { zone: 'CRITICAL', label: '3+ days', color: '#cc0000', action: 'Immediate escalation. These jobs are past SLA. Identify the blocker and resolve today.' },
        ].map(z => (
          <Card key={z.zone} onClick={() => setFilter(filter === z.zone ? 'all' : z.zone)}
            style={{ padding: 14, borderLeft: `4px solid ${z.color}`, cursor: 'pointer', background: filter === z.zone ? `${z.color}10` : T.card }}>
            <div style={{ textAlign: 'center', marginBottom: 6 }}>
              <div style={{ fontSize: 28, fontWeight: 800, color: z.color, fontFamily: mono }}>{sm[z.zone.toLowerCase()] || 0}</div>
              <div style={{ fontSize: 10, fontWeight: 700, color: z.color, fontFamily: mono }}>{z.zone} ({z.label})</div>
            </div>
            <div style={{ fontSize: 10, color: T.textMuted, lineHeight: 1.4 }}>{z.action}</div>
          </Card>
        ))}
      </div>

      {/* Outlier explainer */}
      <Card style={{ padding: 12, marginBottom: 16, background: (sm.outlierPct || 0) > 5 ? `${T.red}10` : T.bg, border: `1px solid ${(sm.outlierPct || 0) > 5 ? T.red + '30' : T.border}` }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: (sm.outlierPct || 0) > 5 ? T.red : T.green }}>
              Outlier Rate: {sm.outlierPct || 0}% {(sm.outlierPct || 0) > 5 ? '— ABOVE THRESHOLD' : '— Within target'}
            </div>
            <div style={{ fontSize: 11, color: T.textMuted, marginTop: 4 }}>
              <strong>What this means:</strong> {sm.outlierPct || 0}% of active WIP jobs ({sm.red + sm.critical || 0} jobs) have been in the lab 2 or more days.
              Our target is under 5%. {(sm.outlierPct || 0) > 5
                ? 'We are above target — review the Red and Critical jobs below to identify bottlenecks. Common causes: machine downtime, missing materials, breakage rework, or jobs stuck on hold.'
                : 'We are within target. Continue monitoring.'}
            </div>
          </div>
          <div style={{ textAlign: 'center', minWidth: 80 }}>
            <div style={{ fontSize: 32, fontWeight: 800, color: (sm.outlierPct || 0) > 5 ? T.red : T.green, fontFamily: mono }}>{sm.outlierPct || 0}%</div>
            <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>TARGET: 5%</div>
          </div>
        </div>
      </Card>

      {/* SV vs Surfacing breakdown */}
      {(() => {
        const svData = data?.singleVision || {};
        const surfData = data?.surfacing || {};
        return (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, marginBottom: 16 }}>
            <Card style={{ padding: 14, borderLeft: `4px solid ${T.cyan}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.cyan }}>Single Vision</div>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>SLA: {svData.slaTarget || 2} days</div>
              </div>
              <div style={{ display: 'flex', gap: 16, fontFamily: mono }}>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{svData.total || 0}</div><div style={{ fontSize: 8, color: T.textDim }}>TOTAL</div></div>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{svData.avgDays || 0}</div><div style={{ fontSize: 8, color: T.textDim }}>AVG DAYS</div></div>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: svData.overSLA > 0 ? T.red : T.green }}>{svData.overSLA || 0}</div><div style={{ fontSize: 8, color: T.textDim }}>OVER SLA</div></div>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: (svData.outlierPct || 0) > 5 ? T.red : T.green }}>{svData.outlierPct || 0}%</div><div style={{ fontSize: 8, color: T.textDim }}>OUTLIER</div></div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: T.green }}>{svData.green || 0}</span>
                  <span style={{ fontSize: 10, color: T.amber }}>{svData.yellow || 0}</span>
                  <span style={{ fontSize: 10, color: T.red }}>{svData.red || 0}</span>
                  <span style={{ fontSize: 10, color: '#cc0000' }}>{svData.critical || 0}</span>
                </div>
              </div>
            </Card>
            <Card style={{ padding: 14, borderLeft: `4px solid ${T.purple || '#9b6ee0'}` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.purple || '#9b6ee0' }}>Surfacing</div>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>SLA: {surfData.slaTarget || 3} days</div>
              </div>
              <div style={{ display: 'flex', gap: 16, fontFamily: mono }}>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{surfData.total || 0}</div><div style={{ fontSize: 8, color: T.textDim }}>TOTAL</div></div>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: T.text }}>{surfData.avgDays || 0}</div><div style={{ fontSize: 8, color: T.textDim }}>AVG DAYS</div></div>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: surfData.overSLA > 0 ? T.red : T.green }}>{surfData.overSLA || 0}</div><div style={{ fontSize: 8, color: T.textDim }}>OVER SLA</div></div>
                <div style={{ textAlign: 'center' }}><div style={{ fontSize: 20, fontWeight: 800, color: (surfData.outlierPct || 0) > 5 ? T.red : T.green }}>{surfData.outlierPct || 0}%</div><div style={{ fontSize: 8, color: T.textDim }}>OUTLIER</div></div>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 10, color: T.green }}>{surfData.green || 0}</span>
                  <span style={{ fontSize: 10, color: T.amber }}>{surfData.yellow || 0}</span>
                  <span style={{ fontSize: 10, color: T.red }}>{surfData.red || 0}</span>
                  <span style={{ fontSize: 10, color: '#cc0000' }}>{surfData.critical || 0}</span>
                </div>
              </div>
            </Card>
          </div>
        );
      })()}

      {/* Search + filter by type */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input type="text" placeholder="Search job ID, station, coating..." value={search} onChange={e => setSearch(e.target.value)}
          style={{ flex: 1, maxWidth: 400, padding: "10px 14px", background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }} />
        {['all', 'Single Vision', 'Surfacing'].map(f => (
          <button key={f} onClick={() => setFilter(f)} style={{
            padding: '8px 14px', borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: 'pointer',
            background: filter === f ? T.blue : 'transparent', color: filter === f ? '#fff' : T.textMuted,
            border: `1px solid ${filter === f ? T.blue : T.border}`
          }}>{f === 'all' ? 'All' : f}</button>
        ))}
      </div>

      {/* Job table */}
      <Card>
        <SectionHeader right={`${filtered.length} jobs`}>Job List</SectionHeader>
        <div style={{ maxHeight: 600, overflowY: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: mono }}>
            <thead>
              <tr style={{ background: T.bg, position: 'sticky', top: 0, zIndex: 1 }}>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>JOB ID</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>TYPE</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>ZONE</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>DAYS</th>
                <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SLA</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>STAGE</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>STATION</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>COATING</th>
                <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>ENTERED</th>
                <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>RUSH</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 200).map(j => (
                <tr key={j.job_id} style={{ borderBottom: `1px solid ${T.border}22`, background: j.zone === 'CRITICAL' ? `${'#cc0000'}08` : j.zone === 'RED' ? `${T.red}06` : 'transparent' }}>
                  <td style={{ padding: '6px 12px', fontWeight: 600, color: T.text }}>{j.job_id}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'center' }}>
                    <span style={{ fontSize: 8, padding: '2px 5px', borderRadius: 3, fontWeight: 700, background: j.jobType === 'Surfacing' ? `${T.purple || '#9b6ee0'}20` : `${T.cyan}20`, color: j.jobType === 'Surfacing' ? (T.purple || '#9b6ee0') : T.cyan }}>{j.jobType === 'Surfacing' ? 'SURF' : 'SV'}</span>
                  </td>
                  <td style={{ padding: '6px 12px', textAlign: 'center' }}>
                    <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700, background: `${zoneColors[j.zone]}20`, color: zoneColors[j.zone] }}>{j.zone}</span>
                  </td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 700, color: zoneColors[j.zone] }}>{j.daysInLab}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'right', color: j.overSLA ? T.red : T.textDim }}>{j.slaTarget}d</td>
                  <td style={{ padding: '6px 12px', color: T.textMuted }}>{j.stage}</td>
                  <td style={{ padding: '6px 12px', color: T.textMuted }}>{j.station}</td>
                  <td style={{ padding: '6px 12px', color: T.textMuted }}>{j.coating || '—'}</td>
                  <td style={{ padding: '6px 12px', color: T.textDim }}>{j.enteredAt}</td>
                  <td style={{ padding: '6px 12px', textAlign: 'center' }}>{j.rush === 'Y' ? <span style={{ color: T.red }}>RUSH</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {filtered.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: T.textDim }}>No aging jobs</div>}
        </div>
      </Card>
    </ProductionStageTab>
  );
}

function AIAssistantTab({trays,batches,dviJobs=[],breakage=[],ovenServerUrl=`http://${window.location.hostname}:3002`,settings}){
  // Get coater machines from settings (fallback to MACHINES constant)
  const coaterMachines=useMemo(()=>{
    const coaters=settings?.equipment?.filter(e=>e.categoryId==='coaters')||[];
    return coaters.length>0 ? coaters.map(e=>e.name) : MACHINES;
  },[settings?.equipment]);

  // Fetch SOM machine data for AI context
  const [somDevices,setSomDevices]=useState([]);
  useEffect(()=>{
    const fetchSom=async()=>{
      try{
        const res=await fetch(`${ovenServerUrl}/api/som/devices`);
        if(res.ok){ const d=await res.json(); setSomDevices(d.devices||[]); }
      }catch(e){}
    };
    fetchSom();
    const iv=setInterval(fetchSom,60000);
    return()=>clearInterval(iv);
  },[ovenServerUrl]);


  const [messages,setMessages]=useState([
    {role:"assistant",content:"Hello! I'm your Lab_Assistant AI. I have full context on your tray fleet, coating batches, and production data.\n\nAsk me anything — job lookups, yield analysis, shift reports — or click a quick action. For reports, I'll also offer a **Download as Word** button so you can share them directly."}
  ]);
  const [input,setInput]=useState("");
  const [loading,setLoading]=useState(false);
  const [reportDownloading,setReportDownloading]=useState(null); // messageIdx
  const [serverUrl,setServerUrl]=useState(`http://${window.location.hostname}:3002`);
  const chatRef=useRef(null);

  const REPORT_KEYWORDS=["report","summary","analysis","generate","write up","breakdown","overview"];
  const isReportRequest=(text)=>REPORT_KEYWORDS.some(k=>text.toLowerCase().includes(k));

  const QUICK_PROMPTS=[
    {icon:"🔍", label:"Find a job",          text:"Look up job "},
    {icon:"📊", label:"Shift report",         text:"Generate a shift summary report for today including DVI job counts by stage, coating batch counts, yield rates by machine, breakage summary, and any notable issues. Format with sections and bullet points.", isReport:true},
    {icon:"⏱",  label:"WIP Aging Report",    text:"__WIP_AGING__", isReport:true},
    {icon:"💥", label:"Breakage analysis",    text:"Analyze all breakage data. What types are repeating? Which departments have the most breaks? Are there patterns by coating type or lens? Give specific suggestions to reduce breakage."},
    {icon:"🚨", label:"Error & hold jobs",    text:"List all DVI jobs currently in FAIL, HOLD, or ERROR status. For each one, explain what likely went wrong and what the next step should be."},
    {icon:"🏭", label:"Machine alerts",       text:"Analyze SOM machine status. Which machines have errors or warnings? Are there repeating issues? What maintenance should we schedule?"},
    {icon:"🔴", label:"Rush jobs",            text:"List all current rush jobs from DVI and their exact stage/station in the lab. Suggest priority routing for any that are behind schedule."},
    {icon:"📋", label:"End of day report",    text:"Generate a comprehensive end-of-day production report including DVI job counts by stage, jobs shipped, breakage summary with root cause patterns, machine alerts, and recommendations for tomorrow's shift.", isReport:true},
    {icon:"📈", label:"Backlog catch-up",     text:"Run a full backlog catch-up analysis. Use get_backlog_catchup() for each department (surfacing, cutting, coating, assembly) and lab-wide. For each, report: current backlog, daily incoming vs output, net gain/loss, days to clear, projected clear date. Flag any department falling behind RED. Format as a table.", isReport:true},
  ];

  const buildAgingPrompt=()=>{
    // Use MCP tools for real data — no mock tray data
    return `Generate a WIP Aging Report for the Pair Eyewear lens lab.

REPORT DATE: ${new Date().toLocaleString()}

INSTRUCTIONS: Call get_aging_report first to get real aging data from the database. Then call get_wip_snapshot for summary stats. Use ONLY the data returned by those tools.

Generate a professional WIP Aging Report with these sections:
## WIP Aging Summary
A brief 2–3 sentence overview of the current WIP state based on tool data.

## Aging Detail Table
Present jobs as a clean text table with columns: Job | Days In Lab | Stage | Station | Status | Flag
Sort by Days In Lab descending. Flag overdue jobs with ⚠, rush with 🔴.

## Concerns
List any jobs requiring immediate attention with specific job numbers and reasons.

## Recommended Actions
3–5 specific actions the floor supervisor should take right now, ordered by priority.

Be precise with job IDs and times. Use ONLY data from your tool calls — do not invent numbers.`;
  };

  const buildContext=()=>{
    // ALL data must come from MCP tools — no frontend context injection
    return `You are Lab_Assistant AI, an expert optical manufacturing analyst embedded in the Pair Eyewear lens lab MES.
TIMESTAMP: ${new Date().toLocaleString()}

CRITICAL: Get ALL data from your MCP tools. Do NOT invent or fabricate any data.

Start every query by calling get_wip_snapshot() for a real-time summary of active jobs.
Use get_wip_jobs() with filters for department-specific data.
Use get_aging_report() for WIP aging analysis.
Use get_breakage_summary() and get_breakage_events() for breakage data.
Use call_api with endpoint /api/som/devices for machine status.
Use get_coating_intelligence() for coating pipeline data.

When analyzing:
- Cross-reference breakage patterns with specific DVI stages to identify root causes
- Flag repeating breakage types and suggest corrective actions
- If a job is stuck (HOLD/FAIL), explain likely causes and next steps
- For rush jobs, suggest priority routing through the lab

When generating reports: use ## for main sections, ### for subsections, - for bullet points, **bold** for key metrics. Be specific with actual numbers from tool data only. Flag anything below 90% pass rate as a concern.`;
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

  const downloadVisualReport=async(msg,idx)=>{
    setReportDownloading(idx+10000); // offset to distinguish from word download
    try{
      const title=msg.prompt
        ? msg.prompt.replace(/^generate\s+a?\s*/i,"").replace(/report.*/i,"Report").trim().slice(0,60)
        : "Shift Report";
      const res=await fetch(`${serverUrl}/api/report/visual`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ title, narrative:msg.content }),
      });
      if(!res.ok) throw new Error("Server error");
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download=`ShiftReport_${new Date().toISOString().slice(0,10)}.html`;
      a.click();
      URL.revokeObjectURL(url);
    }catch(e){
      alert(`Visual report failed: ${e.message}`);
    }
    setReportDownloading(null);
  };

  const downloadCsvReport=async(msg,idx)=>{
    setReportDownloading(idx+20000);
    try{
      const title=msg.prompt
        ? msg.prompt.replace(/^generate\s+a?\s*/i,"").replace(/report.*/i,"Report").trim().slice(0,60)
        : "Shift Report";
      const res=await fetch(`${serverUrl}/api/report/csv`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({ title }),
      });
      if(!res.ok) throw new Error("Server error");
      const blob=await res.blob();
      const url=URL.createObjectURL(blob);
      const a=document.createElement("a");
      a.href=url;a.download=`ShiftReport_${new Date().toISOString().slice(0,10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    }catch(e){
      alert(`CSV export failed: ${e.message}`);
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
                    <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                      <button
                        onClick={()=>downloadVisualReport(m,i)}
                        disabled={reportDownloading!=null}
                        style={{alignSelf:"flex-start",display:"flex",alignItems:"center",gap:6,padding:"6px 12px",background:reportDownloading===i+10000?T.border:`${T.green}20`,border:`1px solid ${reportDownloading===i+10000?T.border:T.green}`,borderRadius:6,color:reportDownloading===i+10000?T.textDim:T.green,fontSize:11,fontWeight:700,cursor:reportDownloading!=null?"not-allowed":"pointer",fontFamily:mono,transition:"all 0.2s"}}>
                        {reportDownloading===i+10000?"⏳ Generating...":"📊 Visual Report (Charts)"}
                      </button>
                      <button
                        onClick={()=>downloadWordReport(m,i)}
                        disabled={reportDownloading!=null}
                        style={{alignSelf:"flex-start",display:"flex",alignItems:"center",gap:6,padding:"6px 12px",background:reportDownloading===i?T.border:`${T.blue}20`,border:`1px solid ${reportDownloading===i?T.border:T.blue}`,borderRadius:6,color:reportDownloading===i?T.textDim:T.blue,fontSize:11,fontWeight:700,cursor:reportDownloading!=null?"not-allowed":"pointer",fontFamily:mono,transition:"all 0.2s"}}>
                        {reportDownloading===i?"⏳ Generating...":"📄 Word (.docx)"}
                      </button>
                      <button
                        onClick={()=>downloadCsvReport(m,i)}
                        disabled={reportDownloading!=null}
                        style={{alignSelf:"flex-start",display:"flex",alignItems:"center",gap:6,padding:"6px 12px",background:reportDownloading===i+20000?T.border:`${T.amber||'#F59E0B'}20`,border:`1px solid ${reportDownloading===i+20000?T.border:T.amber||'#F59E0B'}`,borderRadius:6,color:reportDownloading===i+20000?T.textDim:T.amber||'#F59E0B',fontSize:11,fontWeight:700,cursor:reportDownloading!=null?"not-allowed":"pointer",fontFamily:mono,transition:"all 0.2s"}}>
                        {reportDownloading===i+20000?"⏳ Generating...":"📋 CSV (Data)"}
                      </button>
                    </div>
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

// ── Breakage History Component ────────────────────────────────
function BreakageHistory({breakage}){
  const [expanded,setExpanded]=useState(null);
  // Aggregate breakage by day
  const dailyData=useMemo(()=>{
    const byDay={};
    for(const b of breakage){
      const d=new Date(b.time);
      if(isNaN(d.getTime()))continue;
      const key=d.toISOString().slice(0,10);
      if(!byDay[key])byDay[key]={date:key,total:0,active:0,resolved:0,byStage:{},byCoating:{},jobs:[]};
      byDay[key].total++;
      if(b.resolved)byDay[key].resolved++;else byDay[key].active++;
      const st=b.dept||'UNKNOWN';byDay[key].byStage[st]=(byDay[key].byStage[st]||0)+1;
      const ct=b.coating||'Unknown';byDay[key].byCoating[ct]=(byDay[key].byCoating[ct]||0)+1;
      byDay[key].jobs.push(b);
    }
    return Object.values(byDay).sort((a,b)=>b.date.localeCompare(a.date));
  },[breakage]);

  const maxDay=dailyData.length?Math.max(...dailyData.map(d=>d.total)):1;

  if(!dailyData.length)return null;

  return(
    <Card>
      <SectionHeader right={`${dailyData.length} days tracked`}>Breakage History by Day</SectionHeader>
      <div style={{maxHeight:500,overflowY:"auto"}}>
        {dailyData.map(day=>{
          const isToday=day.date===new Date().toISOString().slice(0,10);
          const isExp=expanded===day.date;
          const dayLabel=new Date(day.date+'T12:00:00').toLocaleDateString([],{weekday:'short',month:'short',day:'numeric'});
          const topStages=Object.entries(day.byStage).sort((a,b)=>b[1]-a[1]).slice(0,3);
          return(
            <div key={day.date} style={{marginBottom:2}}>
              <div onClick={()=>setExpanded(isExp?null:day.date)} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 12px",background:isToday?`${T.red}10`:T.bg,borderRadius:8,border:`1px solid ${isToday?T.red+'30':T.border}`,cursor:"pointer",transition:"background 0.15s"}}>
                {/* Date */}
                <div style={{minWidth:100}}>
                  <div style={{fontSize:12,color:isToday?T.red:T.text,fontFamily:mono,fontWeight:700}}>{dayLabel}</div>
                  <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{day.date}</div>
                </div>
                {/* Bar */}
                <div style={{flex:1,display:"flex",alignItems:"center",gap:8}}>
                  <div style={{flex:1,height:8,background:T.surface,borderRadius:4,overflow:"hidden"}}>
                    <div style={{display:"flex",height:"100%"}}>
                      <div style={{width:`${(day.active/maxDay)*100}%`,background:T.red,borderRadius:day.resolved?'4px 0 0 4px':'4px',transition:"width 0.3s"}}/>
                      <div style={{width:`${(day.resolved/maxDay)*100}%`,background:T.green,borderRadius:day.active?'0 4px 4px 0':'4px',opacity:0.6,transition:"width 0.3s"}}/>
                    </div>
                  </div>
                </div>
                {/* Count */}
                <div style={{minWidth:50,textAlign:"right"}}>
                  <span style={{fontSize:16,fontWeight:800,color:T.text,fontFamily:mono}}>{day.total}</span>
                </div>
                {/* Active / Resolved */}
                <div style={{minWidth:80,textAlign:"right"}}>
                  {day.active>0&&<span style={{fontSize:10,color:T.red,fontFamily:mono,fontWeight:700,marginRight:6}}>{day.active} open</span>}
                  <span style={{fontSize:10,color:T.green,fontFamily:mono,opacity:0.7}}>{day.resolved} ok</span>
                </div>
                {/* Top stages */}
                <div style={{minWidth:120,display:"flex",gap:4,flexWrap:"wrap"}}>
                  {topStages.map(([st,ct])=>{const d=DEPARTMENTS[st];return(
                    <span key={st} style={{fontSize:9,padding:"2px 6px",borderRadius:4,background:`${d?.color||T.textMuted}15`,color:d?.color||T.textMuted,fontFamily:mono,fontWeight:600}}>{d?.label||st} {ct}</span>
                  );})}
                </div>
                {/* Expand arrow */}
                <span style={{fontSize:10,color:T.textDim,transform:isExp?'rotate(180deg)':'rotate(0)',transition:'transform 0.2s'}}>▼</span>
              </div>
              {/* Expanded job list */}
              {isExp&&(
                <div style={{padding:"8px 12px 12px 24px",background:T.surface,borderRadius:"0 0 8px 8px",borderLeft:`2px solid ${T.red}30`}}>
                  <div style={{display:"grid",gridTemplateColumns:"80px 80px 80px 80px 60px 1fr",gap:4,marginBottom:6}}>
                    {["Job","Stage","Coating","Operator","Status","Note"].map(h=>(
                      <div key={h} style={{fontSize:9,color:T.textDim,fontFamily:mono,textTransform:"uppercase",fontWeight:600}}>{h}</div>
                    ))}
                  </div>
                  <div style={{maxHeight:200,overflowY:"auto"}}>
                    {day.jobs.map((b,i)=>(
                      <div key={b.id||i} style={{display:"grid",gridTemplateColumns:"80px 80px 80px 80px 60px 1fr",gap:4,padding:"4px 0",borderBottom:`1px solid ${T.border}`}}>
                        <div style={{fontSize:11,color:T.text,fontFamily:mono,fontWeight:700}}>{b.job}</div>
                        <div style={{fontSize:10,color:DEPARTMENTS[b.dept]?.color||T.textMuted,fontFamily:mono}}>{b.dept}</div>
                        <div style={{fontSize:10,color:T.blue,fontFamily:mono}}>{b.coating||'—'}</div>
                        <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>{b.operator||'—'}</div>
                        <div style={{fontSize:10,color:b.resolved?T.green:T.red,fontFamily:mono,fontWeight:700}}>{b.resolved?'OK':'OPEN'}</div>
                        <div style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{b.note||''}</div>
                      </div>
                    ))}
                  </div>
                  {/* Day summary */}
                  <div style={{display:"flex",gap:12,marginTop:8,paddingTop:8,borderTop:`1px solid ${T.border}`}}>
                    <div style={{fontSize:10,color:T.textDim}}>Coatings: {Object.entries(day.byCoating).sort((a,b)=>b[1]-a[1]).map(([c,n])=>`${c}(${n})`).join(', ')}</div>
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
}

// ── Network Operations Tab ───────────────────────────────────
function NetworkTab({ovenServerUrl,settings}){
  const base=ovenServerUrl||`http://${window.location.hostname}:3002`;
  const mono="'JetBrains Mono',monospace";
  const gwBase=settings?.gatewayUrl||`http://${window.location.hostname}:3001`;

  const [status,setStatus]=useState(null);
  const [devices,setDevices]=useState({irvine1:[],irvine2:[]});
  const [events,setEvents]=useState([]);
  const [vlans,setVlans]=useState([]);
  const [netAlerts,setNetAlerts]=useState([]);
  const [health,setHealth]=useState(null);
  const [teleport,setTeleport]=useState(null);
  const [wanData,setWanData]=useState(null);
  const [switchPorts,setSwitchPorts]=useState(null);
  const [switchPortsLoading,setSwitchPortsLoading]=useState(false);
  const [selectedDevice,setSelectedDevice]=useState(null);
  const [netSearch,setNetSearch]=useState("");
  const [selectedClient,setSelectedClient]=useState(null);
  const [activeSite,setActiveSite]=useState("irvine1");
  const [vlanFilter,setVlanFilter]=useState("all");
  const [lastRefresh,setLastRefresh]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  const [agentOpen,setAgentOpen]=useState(true);
  const [messages,setMessages]=useState([{role:"assistant",content:"NOC Agent online. 30 years in the wire and I've seen it all.\n\nI'm watching **Irvine 1** and **Irvine 2** across 8 VLAN segments. I already see a few things that need your attention — run **Analyze Logs** or ask me directly.\n\nCurrent hot items:\n• UAP-AC-LR-CAM is **down** on VLAN 10 (Cameras)\n• US-24-OT port 14 had **two STP role changes** — that's not random noise\n• Port 22 on the Kardex segment had a 12-second link drop\n\nThat last one is the one that'd keep me up at night."}]);
  const [input,setInput]=useState("");
  const [thinking,setThinking]=useState(false);
  const chatEndRef=useRef(null);

  const isDemo=settings?.demoMode||false;

  // ── VLAN DEFINITIONS ──
  const VLAN_DEFS=[
    {id:10,name:"Cameras",color:"#f59e0b",segment:"10.x.10.x"},
    {id:20,name:"Door Access",color:"#8b5cf6",segment:"10.x.20.x"},
    {id:30,name:"OT/Industrial",color:"#ef4444",segment:"10.x.30.x"},
    {id:40,name:"NAS",color:"#06b6d4",segment:"10.x.40.x"},
    {id:50,name:"Staff WiFi",color:"#10b981",segment:"10.x.50.x"},
    {id:60,name:"EV Charging",color:"#84cc16",segment:"10.x.60.x"},
    {id:1,name:"Main LAN",color:"#3b82f6",segment:"10.x.1.x"},
    {id:99,name:"Management",color:"#e2e8f0",segment:"10.x.99.x"},
  ];

  // ── DEMO DATA ──
  const DEMO_DEVICES={
    irvine1:[
      {id:"d1",name:"USG-Pro-4",model:"USG-Pro-4",type:"ugw",ip:"10.0.99.1",mac:"f0:9f:c2:00:01:01",status:"online",uptime:2345678,cpu_pct:23,mem_pct:45,tx_bytes:45200000000,rx_bytes:38900000000},
      {id:"d2",name:"US-48-Pro",model:"US-48-500W",type:"usw",ip:"10.0.99.10",mac:"f0:9f:c2:00:01:10",status:"online",uptime:2345678,cpu_pct:12,mem_pct:38,tx_bytes:12300000000,rx_bytes:11800000000},
      {id:"d3",name:"US-24-OT",model:"US-24-250W",type:"usw",ip:"10.0.99.11",mac:"f0:9f:c2:00:01:11",status:"online",uptime:2344000,cpu_pct:18,mem_pct:42,tx_bytes:8900000000,rx_bytes:7600000000},
      {id:"d4",name:"UAP-AC-HD-1",model:"UAP-AC-HD",type:"uap",ip:"10.0.50.10",mac:"f0:9f:c2:00:01:20",status:"online",uptime:2100000,cpu_pct:31,mem_pct:52,tx_bytes:1200000000,rx_bytes:980000000},
      {id:"d5",name:"UAP-AC-HD-2",model:"UAP-AC-HD",type:"uap",ip:"10.0.50.11",mac:"f0:9f:c2:00:01:21",status:"online",uptime:2098000,cpu_pct:28,mem_pct:48,tx_bytes:1100000000,rx_bytes:890000000},
      {id:"d6",name:"UAP-AC-LR-CAM",model:"UAP-AC-LR",type:"uap",ip:"10.0.10.12",mac:"f0:9f:c2:00:01:22",status:"offline",uptime:0,cpu_pct:0,mem_pct:0,tx_bytes:0,rx_bytes:0},
    ],
    irvine2:[
      {id:"d7",name:"USW-Flex-XG",model:"USW-Flex-XG",type:"usw",ip:"10.1.99.10",mac:"f0:9f:c2:00:02:10",status:"online",uptime:1234567,cpu_pct:15,mem_pct:35,tx_bytes:9800000000,rx_bytes:8700000000},
      {id:"d8",name:"US-24-Irvine2",model:"US-24-250W",type:"usw",ip:"10.1.99.11",mac:"f0:9f:c2:00:02:11",status:"online",uptime:1230000,cpu_pct:11,mem_pct:30,tx_bytes:4500000000,rx_bytes:4100000000},
      {id:"d9",name:"UAP-AC-Pro-1",model:"UAP-AC-Pro",type:"uap",ip:"10.1.50.10",mac:"f0:9f:c2:00:02:20",status:"online",uptime:1200000,cpu_pct:22,mem_pct:41,tx_bytes:980000000,rx_bytes:760000000},
      {id:"d10",name:"UAP-AC-Pro-2",model:"UAP-AC-Pro",type:"uap",ip:"10.1.50.11",mac:"f0:9f:c2:00:02:21",status:"online",uptime:1198000,cpu_pct:19,mem_pct:38,tx_bytes:870000000,rx_bytes:710000000},
    ],
  };
  const DEMO_EVENTS=[
    {datetime:new Date(Date.now()-120000).toISOString(),severity:"error",msg:"UAP-AC-LR-CAM (10.0.10.12) disconnected — VLAN 10 Cameras",subsystem:"wlan",site:"irvine1"},
    {datetime:new Date(Date.now()-340000).toISOString(),severity:"warning",msg:"US-24-OT port 14 STP role change — VLAN 30 OT segment",subsystem:"lan",site:"irvine1"},
    {datetime:new Date(Date.now()-780000).toISOString(),severity:"warning",msg:"Unknown device (MAC: 7c:83:34:a1:b2:c3) joined Staff WiFi VLAN 50",subsystem:"wlan",site:"irvine2"},
    {datetime:new Date(Date.now()-1200000).toISOString(),severity:"info",msg:"Admin login from 10.0.99.45",subsystem:"admin",site:"irvine1"},
    {datetime:new Date(Date.now()-2100000).toISOString(),severity:"error",msg:"US-24-OT port 22 link down — Kardex segment drop (12s)",subsystem:"lan",site:"irvine1"},
    {datetime:new Date(Date.now()-3600000).toISOString(),severity:"error",msg:"DVI VISION host heartbeat timeout — MSSQL watchdog triggered",subsystem:"lan",site:"irvine1"},
    {datetime:new Date(Date.now()-7200000).toISOString(),severity:"info",msg:"Phrozen Gateway rejoined OT VLAN — IP reassigned 10.0.30.51",subsystem:"lan",site:"irvine1"},
    {datetime:new Date(Date.now()-14400000).toISOString(),severity:"warning",msg:"US-24-OT port 14 STP role change — second occurrence",subsystem:"lan",site:"irvine1"},
  ];
  const DEMO_VLANS=[
    {id:50,name:"Staff WiFi",clients:24,pct:78,color:"#10b981"},
    {id:10,name:"Cameras",clients:16,pct:65,color:"#f59e0b"},
    {id:1,name:"Main LAN",clients:12,pct:45,color:"#3b82f6"},
    {id:30,name:"OT/Industrial",clients:6,pct:38,color:"#ef4444"},
    {id:20,name:"Door Access",clients:3,pct:15,color:"#8b5cf6"},
    {id:60,name:"EV Charging",clients:3,pct:12,color:"#84cc16"},
    {id:40,name:"NAS",clients:2,pct:8,color:"#06b6d4"},
    {id:99,name:"Management",clients:2,pct:5,color:"#e2e8f0"},
  ];
  const DEMO_STATUS={irvine1:{devicesUp:5,devicesDown:1,devicesTotal:6,clients:54},irvine2:{devicesUp:4,devicesDown:0,devicesTotal:4,clients:14}};
  const DEMO_HEALTH={isLive:false,mock:true,lastPoll:new Date().toISOString(),pollCount:0};
  const DEMO_TELEPORT={enabled:true,status:"active",server_ip:"10.0.99.1",port:3478,protocol:"WireGuard",sessions:[{name:"Phil's iPhone",user:"phil@paireyewear.com",ip:"10.0.99.201",remote_ip:"73.x.x.x",connected_at:new Date(Date.now()-7200000).toISOString(),rx_bytes:8400000,tx_bytes:2100000,state:"connected"}],total_ever:14,last_handshake:new Date(Date.now()-45000).toISOString()};
  const DEMO_WAN={irvine1:{status:"ok",wan_ip:"203.0.113.10",isp:"Cox",latency:8,uptime:2592000,tx_rate:45000,rx_rate:62000},irvine2:{status:"ok",wan_ip:"203.0.113.20",isp:"Spectrum",latency:11,uptime:2592000,tx_rate:22000,rx_rate:35000}};
  const DEMO_CLIENTS=[
    // Main LAN (1) — 8 site1, 4 site2 = 12
    ...Array.from({length:8},((_,i)=>({hostname:`lab-ws-${i+1}`,ip:`10.0.1.${100+i}`,vlan:1,is_wired:true,mac:`f0:9f:c2:10:01:${String(i+1).padStart(2,"0")}`,site:"irvine1"}))),
    ...Array.from({length:4},((_,i)=>({hostname:`irv2-ws-${i+1}`,ip:`10.1.1.${100+i}`,vlan:1,is_wired:true,mac:`f0:9f:c2:10:02:${String(i+1).padStart(2,"0")}`,site:"irvine2"}))),
    // Cameras (10) — 12 site1, 4 site2 = 16
    ...["lobby","lab-floor","assembly","coating","shipping","picking","entrance-n","entrance-s","parking-a","parking-b","dock","hallway"].map((n,i)=>({hostname:`cam-${n}`,ip:`10.0.10.${100+i}`,vlan:10,is_wired:true,mac:`f0:9f:c2:20:01:${String(i+1).padStart(2,"0")}`,site:"irvine1"})),
    ...["entrance","floor","dock","lot"].map((n,i)=>({hostname:`cam-irv2-${n}`,ip:`10.1.10.${100+i}`,vlan:10,is_wired:true,mac:`f0:9f:c2:20:02:${String(i+1).padStart(2,"0")}`,site:"irvine2"})),
    // Door Access (20) — 3 site1 = 3
    {hostname:"door-ctrl-main",ip:"10.0.20.100",vlan:20,is_wired:true,mac:"f0:9f:c2:20:03:01",site:"irvine1"},
    {hostname:"door-ctrl-lab",ip:"10.0.20.101",vlan:20,is_wired:true,mac:"f0:9f:c2:20:03:02",site:"irvine1"},
    {hostname:"door-ctrl-dock",ip:"10.0.20.102",vlan:20,is_wired:true,mac:"f0:9f:c2:20:03:03",site:"irvine1"},
    // OT/Industrial (30) — 6 site1 = 6
    {hostname:"plc-kardex",ip:"10.0.30.100",vlan:30,is_wired:true,mac:"f0:9f:c2:30:01:01",site:"irvine1"},
    {hostname:"plc-schneider-kms",ip:"10.0.30.101",vlan:30,is_wired:true,mac:"f0:9f:c2:30:01:02",site:"irvine1"},
    {hostname:"plc-coater-1",ip:"10.0.30.102",vlan:30,is_wired:true,mac:"f0:9f:c2:30:01:03",site:"irvine1"},
    {hostname:"plc-coater-2",ip:"10.0.30.103",vlan:30,is_wired:true,mac:"f0:9f:c2:30:01:04",site:"irvine1"},
    {hostname:"dvi-vision",ip:"10.0.30.104",vlan:30,is_wired:true,mac:"f0:9f:c2:30:01:05",site:"irvine1"},
    {hostname:"phrozen-gw",ip:"10.0.30.51",vlan:30,is_wired:true,mac:"f0:9f:c2:30:01:06",site:"irvine1"},
    // NAS (40) — 2 site1 = 2
    {hostname:"nas-primary",ip:"10.0.40.100",vlan:40,is_wired:true,mac:"f0:9f:c2:40:01:01",site:"irvine1"},
    {hostname:"nas-backup",ip:"10.0.40.101",vlan:40,is_wired:true,mac:"f0:9f:c2:40:01:02",site:"irvine1"},
    // Staff WiFi (50) — 18 site1, 6 site2 = 24
    ...Array.from({length:18},((_,i)=>({hostname:i<10?`iphone-staff-${i+1}`:`android-staff-${i-9}`,ip:`10.0.50.${100+i}`,vlan:50,is_wired:false,mac:`f0:9f:c2:50:01:${String(i+1).padStart(2,"0")}`,site:"irvine1"}))),
    ...Array.from({length:6},((_,i)=>({hostname:`irv2-phone-${i+1}`,ip:`10.1.50.${100+i}`,vlan:50,is_wired:false,mac:`f0:9f:c2:50:02:${String(i+1).padStart(2,"0")}`,site:"irvine2"}))),
    // EV Charging (60) — 3 site1 = 3
    ...Array.from({length:3},((_,i)=>({hostname:`ev-charger-${i+1}`,ip:`10.0.60.${100+i}`,vlan:60,is_wired:true,mac:`f0:9f:c2:60:01:${String(i+1).padStart(2,"0")}`,site:"irvine1"}))),
    // Management (99) — 2 site1 = 2
    {hostname:"mgmt-controller",ip:"10.0.99.100",vlan:99,is_wired:true,mac:"f0:9f:c2:99:01:01",site:"irvine1"},
    {hostname:"mgmt-backup",ip:"10.0.99.101",vlan:99,is_wired:true,mac:"f0:9f:c2:99:01:02",site:"irvine1"},
  ]; // Total: 68 (54 site1 + 14 site2)
  const [clientList,setClientList]=useState(DEMO_CLIENTS);

  // Helpers
  const fmtBytes=(b)=>{if(!b)return"0 B";const k=1024,s=["B","KB","MB","GB","TB"];const i=Math.floor(Math.log(b)/Math.log(k));return(b/Math.pow(k,i)).toFixed(1)+" "+s[i];};
  const fmtUptime=(s)=>{if(!s)return"—";const d=Math.floor(s/86400),h=Math.floor((s%86400)/3600);return d>0?`${d}d ${h}h`:`${h}h`;};
  const timeSince=(iso)=>{if(!iso)return"—";const diff=Date.now()-new Date(iso).getTime();const m=Math.floor(diff/60000);if(m<60)return`${m}m ago`;const h=Math.floor(m/60);if(h<24)return`${h}h ago`;return`${Math.floor(h/24)}d ago`;};
  const devIcon=(t)=>t==="ugw"||t==="udm"?"⬡":t==="usw"?"⊞":t==="uap"?"◎":"◆";

  // Expert system prompt
  const EXPERT_SYSTEM=`You are a senior network engineer and IT infrastructure specialist with 30 years of hands-on experience in enterprise networking, switching, large-scale factory automation systems, and OT/IT convergence. You've designed and maintained networks for manufacturing facilities, lens labs, pharmaceutical clean rooms, and automated production lines globally.\n\nYour current assignment is the Pair Eyewear lens lab network across two Irvine, California sites (Irvine 1 and Irvine 2), connected via UniFi Site Magic SD-WAN. The network runs on Ubiquiti UniFi hardware with 8 VLAN segments:\n- VLAN 10: Security Cameras\n- VLAN 20: Door Access Control\n- VLAN 30: OT/Industrial (Kardex automated storage, Schneider KMS conveyor, ItemPath middleware, DVI VISION LMS on MSSQL, Phrozen 3D printer network)\n- VLAN 40: NAS storage\n- VLAN 50: Staff WiFi\n- VLAN 60: EV Charging\n- VLAN 1: Main LAN\n- VLAN 99: Management\n\nCritical systems on the OT/Industrial VLAN include:\n- DVI VISION (Lens Management System, MSSQL) - daily PAIRRX.XML job files\n- Kardex Power Pick automated storage retrieval\n- ItemPath middleware (MSSQL + REST)\n- Schneider KMS conveyor/material flow (MariaDB)\n- Phrozen 3D printer fleet (network gateway)\n\nWhen analyzing logs or device data, you:\n1. Identify root causes, not just symptoms\n2. Flag OT segment issues with HIGH PRIORITY since downtime = production loss\n3. Reference specific UniFi CLI commands or controller UI paths when relevant\n4. Distinguish between transient noise and systemic problems\n5. Quantify impact in manufacturing terms where possible (jobs delayed, throughput affected)\n6. Give concrete remediation steps with priority order\n\nTone: Direct, experienced, no-nonsense. You've seen every failure mode. You don't hedge unnecessarily. When you don't have enough data, you say exactly what additional data you need.`;

  // Fetch data
  const fetchData=useCallback(async()=>{
    if(isDemo){
      setDevices(DEMO_DEVICES);setEvents(DEMO_EVENTS);setVlans(DEMO_VLANS);
      setStatus(DEMO_STATUS);setHealth(DEMO_HEALTH);setNetAlerts([]);
      setTeleport(DEMO_TELEPORT);setWanData(DEMO_WAN);setClientList(DEMO_CLIENTS);
      setLastRefresh(new Date());setLoading(false);setError(null);return;
    }
    try{
      const[sRes,dRes,eRes,vRes,aRes,hRes,tRes,wRes,cRes]=await Promise.allSettled([
        fetch(`${base}/api/network/status`),fetch(`${base}/api/network/devices`),
        fetch(`${base}/api/network/events`),fetch(`${base}/api/network/vlans`),
        fetch(`${base}/api/network/alerts`),fetch(`${base}/api/network/health`),
        fetch(`${base}/api/network/teleport`),fetch(`${base}/api/network/wan`),
        fetch(`${base}/api/network/clients`),
      ]);
      if(sRes.status==="fulfilled"&&sRes.value.ok){
        const sd=await sRes.value.json();
        // API returns {sites:{default:{...},site2:{...}}} — normalize to {irvine1:{...},irvine2:{...}}
        if(sd.sites){
          const keys=Object.keys(sd.sites);
          const mapped={};
          keys.forEach((k,i)=>{mapped[i===0?"irvine1":"irvine2"]=sd.sites[k];});
          setStatus(mapped);
        }else setStatus(sd);
      }
      if(dRes.status==="fulfilled"&&dRes.value.ok){
        const dd=await dRes.value.json();
        // API returns {devices:[...]} flat array with site field — group by site
        if(dd.devices&&Array.isArray(dd.devices)){
          const grouped={irvine1:[],irvine2:[]};
          for(const d of dd.devices){
            const s=d.site||"default";
            const key=s.includes("2")||s==="site2"?"irvine2":"irvine1";
            grouped[key].push(d);
          }
          setDevices(grouped);
        }else if(dd.irvine1||dd.irvine2){
          setDevices(dd); // already keyed by site
        }else{
          setDevices({irvine1:dd.devices||[],irvine2:[]});
        }
      }
      if(eRes.status==="fulfilled"&&eRes.value.ok){
        const ed=await eRes.value.json();
        const evts=(ed.events||ed||[]).map(e=>({...e,
          severity:e.severity||(e.is_negative?"error":(e.key||"").includes("WARN")?"warning":"info"),
          site:e.site||"irvine1",
        }));
        setEvents(evts);
      }
      if(vRes.status==="fulfilled"&&vRes.value.ok){
        const vd=await vRes.value.json();
        const vlanColors={30:"#ef4444",1:"#3b82f6",50:"#10b981",40:"#06b6d4",10:"#f59e0b",20:"#8b5cf6",60:"#84cc16",99:"#e2e8f0"};
        const raw=vd.vlans||vd||[];
        const maxClients=Math.max(...raw.map(v=>v.clientCount||v.clients||1),1);
        setVlans(raw.map(v=>({id:v.id,name:v.name,clients:v.clientCount||v.clients||0,pct:Math.round(((v.clientCount||v.clients||0)/maxClients)*100),color:vlanColors[v.id]||"#334155",violations:v.violations||0})));
      }
      if(aRes.status==="fulfilled"&&aRes.value.ok) setNetAlerts(await aRes.value.json());
      if(hRes.status==="fulfilled"&&hRes.value.ok) setHealth(await hRes.value.json());
      if(tRes.status==="fulfilled"&&tRes.value.ok){const td=await tRes.value.json();setTeleport(td.teleport||td);}
      if(wRes.status==="fulfilled"&&wRes.value.ok){const wd=await wRes.value.json();setWanData(wd.wan||wd);}
      if(cRes.status==="fulfilled"&&cRes.value.ok){const cd=await cRes.value.json();setClientList(cd.clients||[]);}
      setLastRefresh(new Date());setError(null);
    }catch(e){setError(e.message);}
    finally{setLoading(false);}
  },[base,isDemo]);

  useEffect(()=>{fetchData();const t=setInterval(fetchData,30000);return()=>clearInterval(t);},[fetchData]);
  useEffect(()=>{chatEndRef.current?.scrollIntoView({behavior:"smooth"});},[messages]);

  // Switch port fetch
  const fetchSwitchPorts=async(mac,name)=>{
    setSwitchPortsLoading(true);
    if(isDemo){
      // Generate mock port data client-side for demo
      const portCount=name?.includes("48")?48:24;
      const profiles=[
        {name:"Kardex PLC",vlan:30,speed:1000,state:"forwarding",poe:true},
        {name:"Schneider KMS",vlan:30,speed:1000,state:"forwarding",poe:false},
        {name:"DVI VISION",vlan:30,speed:1000,state:"forwarding",poe:false},
        {name:"Coater-1 PLC",vlan:30,speed:100,state:"forwarding",poe:true},
        {name:"Coater-2 PLC",vlan:30,speed:100,state:"forwarding",poe:true},
        {name:"cam-lobby",vlan:10,speed:100,state:"forwarding",poe:true},
        {name:"cam-lab-floor",vlan:10,speed:100,state:"forwarding",poe:true},
        {name:"cam-assembly",vlan:10,speed:100,state:"forwarding",poe:true},
        {name:"cam-coating",vlan:10,speed:100,state:"forwarding",poe:true},
        {name:"door-ctrl-1",vlan:20,speed:100,state:"forwarding",poe:true},
        {name:"door-ctrl-2",vlan:20,speed:100,state:"forwarding",poe:true},
        {name:"lab-ws-1",vlan:1,speed:1000,state:"forwarding",poe:false},
        {name:"lab-ws-2",vlan:1,speed:1000,state:"forwarding",poe:false},
        {name:"lab-ws-3",vlan:1,speed:1000,state:"forwarding",poe:false},
        {name:"NAS-primary",vlan:40,speed:1000,state:"forwarding",poe:false},
        {name:"ev-charger-1",vlan:60,speed:100,state:"forwarding",poe:false},
        {name:"",vlan:null,speed:0,state:"disabled",poe:false},
        {name:"",vlan:null,speed:0,state:"link_down",poe:false},
        {name:"SFP+ Uplink",vlan:99,speed:10000,state:"forwarding",poe:false},
      ];
      const ports=Array.from({length:portCount},(_,i)=>{
        const p=i<profiles.length?profiles[i]:{name:"",vlan:null,speed:0,state:i%5===0?"link_down":"disabled",poe:false};
        const isUp=p.state==="forwarding";
        return{port_idx:i+1,name:p.name||`Port ${i+1}`,state:p.state,speed:p.speed,is_uplink:i>=portCount-2,poe_enable:p.poe,poe_power:p.poe&&isUp?(5+Math.random()*20).toFixed(1):"0.0",vlan:p.vlan,vlan_name:p.vlan?VLAN_DEFS.find(v=>v.id===p.vlan)?.name||`VLAN ${p.vlan}`:null,tx_bytes:isUp?Math.floor(Math.random()*1e9):0,rx_bytes:isUp?Math.floor(Math.random()*1e9):0,stp_state:isUp?"forwarding":"disabled",mac_count:isUp?Math.floor(Math.random()*5)+1:0};
      });
      setSwitchPorts({mac,device:name||"Switch",ports,portCount});
      setSwitchPortsLoading(false);return;
    }
    try{
      const r=await fetch(`${base}/api/network/switch-ports?mac=${encodeURIComponent(mac)}`);
      if(r.ok) setSwitchPorts(await r.json());
    }catch(e){console.error("Switch ports fetch failed:",e);}
    setSwitchPortsLoading(false);
  };

  // AI NOC Agent
  const sendNocMessage=async(userMsg)=>{
    const newMsgs=[...messages,{role:"user",content:userMsg}];
    setMessages(newMsgs);setInput("");setThinking(true);
    const siteDevs=(devices[activeSite]||[]);
    const downDevs=siteDevs.filter(d=>d.status==="offline");
    const errEvts=(events||[]).filter(e=>e.severity==="error");
    const tp=teleport||DEMO_TELEPORT;
    const wan=wanData||DEMO_WAN;
    const ctx=`CURRENT NETWORK STATE (${activeSite.toUpperCase()}):
Devices: ${siteDevs.length} total, ${downDevs.length} DOWN
Active clients: ${clientList.length}
Last refresh: ${lastRefresh?.toLocaleTimeString()||"—"}

TELEPORT VPN (UDM-Pro / WireGuard):
Status: ${(tp.status||"inactive").toUpperCase()}
Active sessions: ${(tp.sessions||[]).length}
${(tp.sessions||[]).map(s=>`  - ${s.name} (${s.user}) @ ${s.ip} — connected ${timeSince(s.connected_at)} — ↓${fmtBytes(s.rx_bytes)} ↑${fmtBytes(s.tx_bytes)}`).join("\n")||"  None"}
Last handshake: ${timeSince(tp.last_handshake)}

WAN HEALTH:
${Object.entries(wan).map(([site,w])=>`  ${site}: ${w.isp} — ${w.latency}ms latency — ${w.status} — WAN IP ${w.wan_ip}`).join("\n")}

DOWN DEVICES:
${downDevs.map(d=>`  - ${d.name} (${d.model}) @ ${d.ip}`).join("\n")||"  None"}

RECENT ERROR/WARNING EVENTS (last 4h):
${errEvts.slice(0,8).map(e=>`  [${timeSince(e.datetime)}] [${(e.severity||"info").toUpperCase()}] ${e.msg}`).join("\n")||"  None"}

FULL RECENT LOG:
${(events||[]).slice(0,12).map(e=>`  [${timeSince(e.datetime)}] [${e.severity}] ${e.msg}`).join("\n")}

VLANs: ${(vlans||DEMO_VLANS).map(v=>`${v.name}: ${v.clients} clients, ${v.pct}%`).join(", ")}`;
    try{
      const res=await fetch(`${gwBase}/web/ask-sync`,{
        method:"POST",headers:{"Content-Type":"application/json"},
        body:JSON.stringify({question:`${EXPERT_SYSTEM}\n\n${ctx}\n\n---\nUser query: ${userMsg}`,agent:"network"}),
      });
      if(res.ok){const d=await res.json();setMessages(p=>[...p,{role:"assistant",content:d.response||d.text||JSON.stringify(d)}]);}
      else setMessages(p=>[...p,{role:"assistant",content:`Gateway error: ${res.status}`}]);
    }catch(e){setMessages(p=>[...p,{role:"assistant",content:`Error: ${e.message}`}]);}
    setThinking(false);
  };

  const analyzeLogs=()=>{
    const ec=(events||[]).filter(e=>e.severity==="error").length;
    const wc=(events||[]).filter(e=>e.severity==="warning").length;
    sendNocMessage(`Analyze the current network logs for Irvine 1 and Irvine 2. I'm seeing ${ec} errors and ${wc} warnings in the recent event log. Give me a prioritized breakdown of what's going on, root causes where you can infer them, and specific remediation steps. Focus especially on anything touching the OT/Industrial VLAN (30) since Kardex, DVI VISION, and the conveyor are on that segment.`);
  };
  const analyzeInfra=()=>{
    sendNocMessage(`Look at the current device inventory and network topology for both Irvine sites. Given what you know about the 8-VLAN architecture and the OT/industrial systems running here (DVI VISION MSSQL, Kardex Power Pick, ItemPath, Schneider KMS, Phrozen 3D printer fleet), what improvements or risk mitigations would you recommend? Think about redundancy, segmentation, and anything that could cause production downtime.`);
  };

  const curDevices=devices[activeSite]||[];
  const upCount=curDevices.filter(d=>d.status==="online").length;
  const downCount=curDevices.filter(d=>d.status==="offline").length;
  const errEvents=(events||[]).filter(e=>e.severity==="error");
  const warnEvents=(events||[]).filter(e=>e.severity==="warning");
  const siteStatus=status||{};
  const s1=siteStatus.irvine1||{};
  const s2=siteStatus.irvine2||{};
  const tp=teleport||DEMO_TELEPORT;
  const wan=wanData||DEMO_WAN;
  const filteredClients=(vlanFilter==="all"?clientList:clientList.filter(c=>c.vlan===parseInt(vlanFilter))).filter(c=>{if(!netSearch)return true;const q=netSearch.toLowerCase();return(c.hostname||"").toLowerCase().includes(q)||(c.ip||"").includes(q)||(c.mac||"").toLowerCase().includes(q);});

  if(loading&&!lastRefresh)return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:400,color:T.textMuted}}>
      <div style={{textAlign:"center"}}><div style={{fontSize:24,marginBottom:8}}>🔀</div>
        <div style={{fontFamily:mono,fontSize:12,letterSpacing:"0.1em"}}>CONNECTING TO NETWORK ADAPTER...</div>
      </div>
    </div>
  );

  // Port color helper
  const portColor=(state)=>state==="forwarding"?"#10b981":state==="link_down"?"#ef4444":state==="disabled"?"#334155":"#f59e0b";
  const portVlanColor=(vlan)=>{const v=VLAN_DEFS.find(vd=>vd.id===vlan);return v?v.color:"#334155";};

  return(
    <div style={{fontFamily:mono,position:"relative"}}>
      {/* CSS animations */}
      <style>{`
        .noc-blink{animation:noc-blink 1.4s step-end infinite}
        @keyframes noc-blink{50%{opacity:0}}
        .noc-pulse{animation:noc-pulse 2s ease-in-out infinite}
        @keyframes noc-pulse{0%,100%{opacity:1}50%{opacity:0.4}}
        .noc-scanline{background:repeating-linear-gradient(0deg,transparent,transparent 2px,rgba(0,0,0,0.03) 2px,rgba(0,0,0,0.03) 4px);pointer-events:none;position:absolute;inset:0;z-index:0}
        .noc-chat-msg{animation:noc-fadeUp 0.2s ease}
        @keyframes noc-fadeUp{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:translateY(0)}}
        .noc-dev:hover{background:rgba(59,130,246,0.06)!important}
        .noc-evt:hover{background:rgba(255,255,255,0.03)!important}
        .noc-btn{transition:all 0.15s;cursor:pointer;border:none}
        .noc-btn:hover{filter:brightness(1.2)}
        .noc-btn:active{transform:scale(0.98)}
        .noc-agent-panel{transition:width 0.28s cubic-bezier(0.4,0,0.2,1),opacity 0.2s ease;overflow:hidden}
        .noc-agent-tab{transition:all 0.15s;cursor:pointer;writing-mode:vertical-rl}
        .noc-agent-tab:hover{background:rgba(59,130,246,0.08)!important}
      `}</style>
      <div className="noc-scanline"/>

      {/* HEADER */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:12,flexWrap:"wrap",position:"relative",zIndex:2}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:8,height:8,borderRadius:"50%",background:downCount>0?"#ef4444":"#10b981",boxShadow:`0 0 8px ${downCount>0?"#ef4444":"#10b981"}`}} className="noc-pulse"/>
          <span style={{color:T.blue,fontWeight:600,letterSpacing:"0.12em",fontSize:13}}>NETWORK OPERATIONS</span>
        </div>
        <div style={{display:"flex",gap:6}}>
          {["irvine1","irvine2"].map(s=>(
            <button key={s} className="noc-btn" onClick={()=>setActiveSite(s)} style={{
              padding:"4px 12px",fontSize:11,fontFamily:mono,
              background:activeSite===s?T.blueDark:"transparent",
              color:activeSite===s?"#7dd3fc":"#475569",
              border:`1px solid ${activeSite===s?T.blue:T.border}`,borderRadius:3,letterSpacing:"0.1em",
            }}>{s==="irvine1"?"IRVINE 1":"IRVINE 2"}</button>
          ))}
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",background:"#0d1f0d",border:"1px solid #1a3d1a",borderRadius:3}}>
            <div style={{width:6,height:6,borderRadius:"50%",background:"#10b981"}}/>
            <span style={{fontSize:10,color:"#10b981",letterSpacing:"0.1em"}}>{health?.isLive?"LIVE":isDemo?"DEMO":"POLLING"}</span>
          </div>
          {errEvents.length>0&&(
            <div style={{display:"flex",alignItems:"center",gap:5,padding:"3px 10px",background:"#1f0d0d",border:"1px solid #3d1a1a",borderRadius:3}}>
              <div style={{width:6,height:6,borderRadius:"50%",background:"#ef4444"}} className="noc-blink"/>
              <span style={{fontSize:10,color:"#ef4444",letterSpacing:"0.1em"}}>{errEvents.length} ERRORS</span>
            </div>
          )}
        </div>
        <div style={{marginLeft:"auto",fontSize:10,color:"#334155",letterSpacing:"0.05em"}}>
          {lastRefresh?.toLocaleTimeString()}
        </div>
      </div>

      {error&&<div style={{padding:"8px 12px",background:T.redDark,border:`1px solid ${T.red}33`,borderRadius:4,marginBottom:12,fontSize:11,color:T.red,position:"relative",zIndex:2}}>Connection error: {error}</div>}

      {/* THREE-PANEL LAYOUT */}
      <div style={{display:"grid",gridTemplateColumns:`300px 1fr ${agentOpen?"380px":"0px"} ${agentOpen?"0px":"32px"}`,gap:0,position:"relative",zIndex:1,overflow:"hidden",height:"calc(100vh - 180px)",transition:"grid-template-columns 0.28s cubic-bezier(0.4,0,0.2,1)"}}>

        {/* ═══ LEFT SIDEBAR ═══ */}
        <div style={{borderRight:`1px solid ${T.border}`,display:"flex",flexDirection:"column",overflow:"hidden"}}>
          {/* VLAN Legend */}
          <div style={{padding:"12px 14px",borderBottom:`1px solid ${T.border}`}}>
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>VLAN SEGMENTS — {activeSite==="irvine1"?"IRVINE 1":"IRVINE 2"}</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4px"}}>
              {VLAN_DEFS.map(v=>(
                <div key={v.id} style={{display:"flex",alignItems:"center",gap:5,padding:"3px 6px",background:"#0d1117",borderRadius:2,cursor:"pointer"}} onClick={()=>setVlanFilter(vlanFilter===String(v.id)?"all":String(v.id))}>
                  <div style={{width:6,height:6,borderRadius:1,background:v.color,flexShrink:0}}/>
                  <span style={{fontSize:9,color:vlanFilter===String(v.id)?"#c8d6e5":"#64748b",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis",fontWeight:vlanFilter===String(v.id)?600:400}}>
                    {v.id<10?`0${v.id}`:v.id} {v.name}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* Device List */}
          <div style={{padding:"12px 14px 6px",flexShrink:0}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>DEVICES</div>
              <div style={{fontSize:9,color:"#334155"}}>{upCount}/{curDevices.length} UP · {activeSite==="irvine1"?(s1.clients||47):(s2.clients||31)} CLIENTS</div>
            </div>
            <input value={netSearch} onChange={e=>setNetSearch(e.target.value)} placeholder="Search IP, name, MAC..." style={{width:"100%",padding:"6px 10px",background:"#0a0f14",border:"1px solid #111827",borderRadius:4,color:"#c8d6e5",fontFamily:mono,fontSize:10,marginBottom:6,outline:"none"}}/>
          </div>
          <div style={{overflowY:"auto",flex:"1 1 0",minHeight:0,padding:"0 14px 14px"}}>
            {curDevices.filter(d=>{if(!netSearch)return true;const q=netSearch.toLowerCase();return(d.name||"").toLowerCase().includes(q)||(d.ip||"").includes(q)||(d.mac||"").toLowerCase().includes(q)||(d.model||"").toLowerCase().includes(q);}).map(d=>(
              <div key={d.id||d.name} className="noc-dev" onClick={()=>{setSelectedDevice(selectedDevice?.id===d.id?null:d);if(d.type==="usw")fetchSwitchPorts(d.mac||d.id,d.name);}} style={{
                padding:"8px 8px",borderRadius:3,marginBottom:4,cursor:"pointer",
                background:selectedDevice?.id===d.id?"rgba(59,130,246,0.08)":d.status==="offline"?"rgba(239,68,68,0.05)":"rgba(255,255,255,0.01)",
                border:`1px solid ${selectedDevice?.id===d.id?"#1e3a5f":d.status==="offline"?"rgba(239,68,68,0.2)":"#111827"}`,
              }}>
                <div style={{display:"flex",alignItems:"center",gap:7,marginBottom:4}}>
                  <div style={{width:6,height:6,borderRadius:"50%",background:d.status==="online"?"#10b981":"#ef4444",flexShrink:0,boxShadow:`0 0 5px ${d.status==="online"?"#10b981":"#ef4444"}`}}/>
                  <span style={{fontSize:11,color:d.status==="online"?T.text:"#ef4444",fontWeight:500}}>{d.name}</span>
                  <span style={{fontSize:10,color:"#475569",marginLeft:"auto"}}>{devIcon(d.type)}</span>
                </div>
                <div style={{fontSize:9,color:"#475569",paddingLeft:13}}>{d.model} · {d.ip}</div>
                {d.status==="online"&&(
                  <div style={{fontSize:9,color:"#334155",paddingLeft:13,marginTop:2}}>
                    ↑{fmtBytes(d.tx_bytes)} ↓{fmtBytes(d.rx_bytes)} · up {fmtUptime(d.uptime)}
                    {d.cpu_pct>0&&<span style={{marginLeft:8,color:d.cpu_pct>85?T.red:d.cpu_pct>60?T.amber:"#334155"}}>CPU {d.cpu_pct}%</span>}
                  </div>
                )}
                {d.status==="offline"&&<div style={{fontSize:9,color:"#ef4444",paddingLeft:13,marginTop:2}}>● DISCONNECTED</div>}
                {/* Expanded detail for selected device */}
                {selectedDevice?.id===d.id&&(
                  <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid #111827"}}>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
                      {[
                        {l:"TYPE",v:d.type==="ugw"||d.type==="udm"?"Gateway":d.type==="usw"?"Switch":d.type==="uap"?"Access Point":d.type},
                        {l:"MAC",v:d.mac||"—"},
                        {l:"IP",v:d.ip||"—"},
                        {l:"MODEL",v:d.model||"—"},
                        {l:"UPTIME",v:fmtUptime(d.uptime)},
                        {l:"STATUS",v:d.status==="online"?"Online":"Offline"},
                        {l:"CPU",v:d.cpu_pct!=null?d.cpu_pct+"%":"—"},
                        {l:"MEM",v:d.mem_pct!=null?d.mem_pct+"%":"—"},
                        {l:"TX",v:fmtBytes(d.tx_bytes)},
                        {l:"RX",v:fmtBytes(d.rx_bytes)},
                      ].map(item=>(
                        <div key={item.l} style={{background:"#0a0f14",border:"1px solid #111827",borderRadius:2,padding:"3px 6px"}}>
                          <div style={{fontSize:7,color:"#334155",letterSpacing:"0.1em"}}>{item.l}</div>
                          <div style={{fontSize:9,color:"#7dd3fc"}}>{item.v}</div>
                        </div>
                      ))}
                    </div>
                    {d.type==="usw"&&<div style={{fontSize:8,color:"#334155",marginTop:4,textAlign:"center"}}>Click again for port detail overlay</div>}
                    <button onClick={e=>{e.stopPropagation();sendNocMessage(`Tell me about device ${d.name} (${d.model}) at ${d.ip}. What should I know about its health and role in the network?`);}} style={{marginTop:6,width:"100%",padding:"4px",background:"transparent",border:"1px solid #1e2d3d",color:"#334155",borderRadius:3,fontSize:8,fontFamily:mono,letterSpacing:"0.06em",cursor:"pointer"}}>⬡ ASK AGENT ABOUT THIS DEVICE</button>
                  </div>
                )}
              </div>
            ))}
          </div>

          {/* TELEPORT VPN PANEL */}
          <div style={{borderTop:`1px solid ${T.border}`,flexShrink:0,padding:"12px 14px"}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <div style={{width:7,height:7,borderRadius:"50%",background:tp.status==="active"?"#10b981":tp.status==="error"?"#ef4444":"#475569",boxShadow:tp.status==="active"?"0 0 6px #10b981":"none"}} className={tp.status==="active"?"noc-pulse":""}/>
                <span style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>TELEPORT VPN</span>
              </div>
              <div style={{marginLeft:"auto",fontSize:8,padding:"2px 7px",borderRadius:2,letterSpacing:"0.1em",background:tp.status==="active"?"#0d1f0d":"#1f0d0d",border:`1px solid ${tp.status==="active"?"#1a3d1a":"#3d1a1a"}`,color:tp.status==="active"?"#10b981":"#ef4444"}}>{(tp.status||"inactive").toUpperCase()}</div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"5px",marginBottom:10}}>
              {[{label:"PROTOCOL",value:tp.protocol||"WireGuard"},{label:"GATEWAY",value:tp.server_ip||"10.0.99.1"},{label:"PORT",value:tp.port||3478},{label:"HANDSHAKE",value:timeSince(tp.last_handshake)}].map(item=>(
                <div key={item.label} style={{background:"#0a0f14",border:"1px solid #111827",borderRadius:2,padding:"4px 7px"}}>
                  <div style={{fontSize:7,color:"#334155",letterSpacing:"0.12em",marginBottom:2}}>{item.label}</div>
                  <div style={{fontSize:10,color:"#7dd3fc"}}>{item.value}</div>
                </div>
              ))}
            </div>
            <div style={{fontSize:8,color:"#334155",letterSpacing:"0.12em",marginBottom:6}}>ACTIVE SESSIONS ({(tp.sessions||[]).length})</div>
            {(tp.sessions||[]).length===0?(
              <div style={{fontSize:9,color:"#1e3a5f",padding:"6px 0"}}>No active sessions</div>
            ):(
              (tp.sessions||[]).map((s,i)=>(
                <div key={i} style={{padding:"7px 8px",background:"#0a0f14",border:"1px solid #0f2d1a",borderRadius:3,marginBottom:5}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:4}}>
                    <div style={{width:5,height:5,borderRadius:"50%",background:"#10b981",boxShadow:"0 0 4px #10b981",flexShrink:0}}/>
                    <span style={{fontSize:10,color:"#c8d6e5",fontWeight:500}}>{s.name}</span>
                    <span style={{fontSize:8,color:"#334155",marginLeft:"auto"}}>{timeSince(s.connected_at)}</span>
                  </div>
                  <div style={{fontSize:9,color:"#475569",paddingLeft:11,marginBottom:3}}>{s.user}</div>
                  <div style={{display:"flex",gap:8,paddingLeft:11}}>
                    <div style={{fontSize:8,color:"#1e3a5f"}}><span style={{color:"#334155"}}>VPN IP</span> {s.ip}</div>
                    <div style={{fontSize:8,color:"#1e3a5f",marginLeft:"auto"}}>↓{fmtBytes(s.rx_bytes)} ↑{fmtBytes(s.tx_bytes)}</div>
                  </div>
                </div>
              ))
            )}
            {(tp.sessions||[]).length>0&&(
              <button className="noc-btn" onClick={()=>sendNocMessage(`I can see ${tp.sessions[0].name} is connected via Teleport VPN from ${tp.sessions[0].remote_ip}. What should I know about managing or monitoring this session from a security standpoint?`)} style={{width:"100%",padding:"5px",marginTop:2,background:"transparent",border:`1px solid ${T.border}`,color:"#334155",borderRadius:3,fontSize:9,fontFamily:mono,letterSpacing:"0.08em"}}>
                ⬡ ASK AGENT ABOUT VPN SESSION
              </button>
            )}
          </div>
        </div>

        {/* ═══ CENTER CONTENT ═══ */}
        <div style={{display:"flex",flexDirection:"column",overflow:"hidden",borderRight:`1px solid ${T.border}`}}>
          {/* KPI Row + Analyze buttons */}
          <div style={{padding:"14px 18px",borderBottom:`1px solid ${T.border}`,display:"flex",gap:16,flexWrap:"wrap",alignItems:"center"}}>
            {[
              {label:"DEVICES UP",value:`${upCount}/${curDevices.length}`,color:downCount>0?T.amber:T.green},
              {label:"CLIENTS",value:activeSite==="irvine1"?(s1.clients||47):(s2.clients||31),color:T.blue},
              {label:"ERRORS (24H)",value:errEvents.length,color:errEvents.length>0?T.red:T.green},
              {label:"WARNINGS",value:warnEvents.length,color:warnEvents.length>0?T.amber:T.green},
              {label:"VLANS",value:8,color:T.purple},
              {label:"SD-WAN",value:"ACTIVE",color:T.green},
              {label:"WAN LATENCY",value:`${wan?.irvine1?.latency||wan?.[activeSite]?.latency||8}ms`,color:(wan?.[activeSite]?.latency||8)>20?T.amber:T.green},
              {label:"TELEPORT",value:(tp.sessions||[]).length>0?"ACTIVE":"IDLE",color:(tp.sessions||[]).length>0?T.green:"#475569"},
            ].map((stat,i)=>(
              <div key={i} style={{textAlign:"center",minWidth:65}}>
                <div style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",marginBottom:4}}>{stat.label}</div>
                <div style={{fontSize:18,fontWeight:600,color:stat.color,lineHeight:1}}>{stat.value}</div>
              </div>
            ))}
            <div style={{marginLeft:"auto",display:"flex",gap:8}}>
              <button className="noc-btn" onClick={analyzeLogs} style={{padding:"6px 14px",background:"#0f1f3d",border:"1px solid #1e3a5f",color:"#7dd3fc",borderRadius:3,fontSize:10,fontFamily:mono,letterSpacing:"0.1em"}}>⟳ ANALYZE LOGS</button>
              <button className="noc-btn" onClick={analyzeInfra} style={{padding:"6px 14px",background:"#1a0f3d",border:"1px solid #3d1a5f",color:"#c084fc",borderRadius:3,fontSize:10,fontFamily:mono,letterSpacing:"0.1em"}}>⬡ ANALYZE INFRA</button>
            </div>
          </div>

          {/* Scrollable center content */}
          <div style={{flex:1,overflowY:"auto",padding:"12px 18px"}}>
            {/* WAN Metrics */}
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
              {[{label:"IRVINE 1",site:"irvine1"},{label:"IRVINE 2",site:"irvine2"}].map(({label,site})=>{
                const w=wan?.[site]||{};
                return(
                  <div key={site} style={{background:"#0a0f14",border:`1px solid ${activeSite===site?"#1e3a5f":"#111827"}`,borderRadius:4,padding:"12px 14px"}}>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                      <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>{label} — WAN</div>
                      <div style={{marginLeft:"auto",fontSize:8,padding:"2px 7px",borderRadius:2,background:w.status==="ok"?"#0d1f0d":"#1f0d0d",border:`1px solid ${w.status==="ok"?"#1a3d1a":"#3d1a1a"}`,color:w.status==="ok"?"#10b981":"#ef4444",letterSpacing:"0.1em"}}>{(w.status||"OK").toUpperCase()}</div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
                      {[{l:"ISP",v:w.isp||"—"},{l:"LATENCY",v:`${w.latency||"—"}ms`},{l:"UPTIME",v:fmtUptime(w.uptime)},{l:"WAN IP",v:w.wan_ip||"—"},{l:"TX RATE",v:fmtBytes(w.tx_rate||0)+"/s"},{l:"RX RATE",v:fmtBytes(w.rx_rate||0)+"/s"}].map(item=>(
                        <div key={item.l}>
                          <div style={{fontSize:7,color:"#334155",letterSpacing:"0.12em",marginBottom:2}}>{item.l}</div>
                          <div style={{fontSize:10,color:"#7dd3fc"}}>{item.v}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>

            {/* VLAN Traffic Bars */}
            <div style={{marginBottom:16}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>VLAN TRAFFIC VOLUME (RELATIVE)</div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                {(vlans||DEMO_VLANS).map(v=>(
                  <div key={v.id} style={{display:"flex",alignItems:"center",gap:8}}>
                    <div style={{width:80,fontSize:9,color:"#475569",textAlign:"right",flexShrink:0}}>{v.name}</div>
                    <div style={{flex:1,height:12,background:"#0d1117",borderRadius:2,overflow:"hidden",border:"1px solid #111827"}}>
                      <div style={{height:"100%",width:`${v.pct}%`,background:`linear-gradient(90deg,${v.color}55,${v.color}aa)`,borderRadius:2,transition:"width 0.3s"}}/>
                    </div>
                    <div style={{width:55,fontSize:9,color:"#334155"}}>{v.pct}% · {v.clients}</div>
                  </div>
                ))}
              </div>
            </div>

            {/* Client List with VLAN filter */}
            <div style={{marginBottom:16}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>CLIENTS</div>
                <select value={vlanFilter} onChange={e=>setVlanFilter(e.target.value)} style={{fontSize:9,background:"#0d1117",border:`1px solid ${T.border}`,color:"#7dd3fc",borderRadius:3,padding:"2px 6px",fontFamily:mono}}>
                  <option value="all">ALL VLANs</option>
                  {VLAN_DEFS.map(v=><option key={v.id} value={v.id}>{v.name} ({v.id})</option>)}
                </select>
                <span style={{fontSize:9,color:"#334155"}}>{filteredClients.length} devices</span>
              </div>
              <div style={{minHeight:100,maxHeight:"60vh",height:200,overflowY:"auto",resize:"vertical",border:`1px solid ${T.border}`,borderRadius:4}}>
                <table style={{width:"100%",fontSize:9,borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:`1px solid ${T.border}`,background:"#0a0f14"}}>
                      {["Hostname","IP","VLAN","Type","MAC"].map(h=><th key={h} style={{padding:"5px 8px",textAlign:"left",color:"#475569",letterSpacing:"0.1em",fontWeight:500}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {filteredClients.slice(0,50).flatMap((c,i)=>{
                      const vdef=VLAN_DEFS.find(v=>v.id===c.vlan);
                      const isOT=c.vlan===30;
                      const isSel=selectedClient===i;
                      const rows=[
                        <tr key={`c${i}`} className="noc-evt" onClick={()=>setSelectedClient(isSel?null:i)} style={{borderBottom:"1px solid #0d1117",background:isSel?"rgba(59,130,246,0.08)":isOT?"rgba(239,68,68,0.02)":"transparent",cursor:"pointer"}}>
                          <td style={{padding:"4px 8px",color:isOT?"#ef4444":"#c8d6e5"}}>{c.hostname}</td>
                          <td style={{padding:"4px 8px",color:"#7dd3fc"}}>{c.ip}</td>
                          <td style={{padding:"4px 8px"}}><span style={{display:"inline-flex",alignItems:"center",gap:4}}><span style={{width:6,height:6,borderRadius:1,background:vdef?.color||"#334155",display:"inline-block"}}/><span style={{color:vdef?.color||"#475569"}}>{vdef?.name||c.vlan}</span></span></td>
                          <td style={{padding:"4px 8px",color:"#475569"}}>{c.is_wired?"Wired":"WiFi"}</td>
                          <td style={{padding:"4px 8px",color:"#334155"}}>{c.mac}</td>
                        </tr>
                      ];
                      if(isSel)rows.push(
                        <tr key={`d${i}`}><td colSpan={5} style={{padding:"8px 10px",background:"#0a0f14",borderBottom:"1px solid #1e2d3d"}}>
                          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                            {[
                              {l:"HOSTNAME",v:c.hostname||"—"},{l:"IP ADDRESS",v:c.ip||"—"},{l:"MAC",v:c.mac||"—"},
                              {l:"VLAN",v:vdef?`${vdef.id} — ${vdef.name}`:(c.vlan||"—")},{l:"TYPE",v:c.is_wired?"Wired":"Wireless"},{l:"SIGNAL",v:c.signal?`${c.signal} dBm`:"N/A"},
                              {l:"TX",v:c.tx_bytes?fmtBytes(c.tx_bytes):"—"},{l:"RX",v:c.rx_bytes?fmtBytes(c.rx_bytes):"—"},{l:"UPTIME",v:c.uptime?fmtUptime(c.uptime):"—"},
                            ].map(item=>(
                              <div key={item.l} style={{background:"#070a0f",border:"1px solid #111827",borderRadius:2,padding:"3px 6px"}}>
                                <div style={{fontSize:7,color:"#334155",letterSpacing:"0.1em"}}>{item.l}</div>
                                <div style={{fontSize:9,color:"#7dd3fc"}}>{item.v}</div>
                              </div>
                            ))}
                          </div>
                          <button onClick={e=>{e.stopPropagation();sendNocMessage(`Tell me about client ${c.hostname||c.mac} at IP ${c.ip} on VLAN ${vdef?.name||c.vlan}. Is it expected on this VLAN? Any concerns?`);}} style={{marginTop:6,width:"100%",padding:"4px",background:"transparent",border:"1px solid #1e2d3d",color:"#334155",borderRadius:3,fontSize:8,fontFamily:mono,letterSpacing:"0.06em",cursor:"pointer"}}>⬡ ASK AGENT ABOUT THIS CLIENT</button>
                        </td></tr>
                      );
                      return rows;
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Event Log — resizable */}
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:10}}>EVENT LOG — BOTH SITES</div>
            <div style={{minHeight:100,maxHeight:"60vh",height:250,overflowY:"auto",resize:"vertical",border:`1px solid ${T.border}`,borderRadius:4,padding:4}}>
            {(events||[]).map((ev,i)=>{
              const col=ev.severity==="error"?"#ef4444":ev.severity==="warning"?"#f59e0b":"#475569";
              const bg=ev.severity==="error"?"rgba(239,68,68,0.04)":ev.severity==="warning"?"rgba(245,158,11,0.03)":"transparent";
              return(
                <div key={i} className="noc-evt" style={{display:"flex",gap:10,padding:"6px 6px",borderBottom:"1px solid #0d1117",background:bg,borderRadius:2}}>
                  <div style={{fontSize:9,color:"#334155",width:55,flexShrink:0,paddingTop:1}}>{timeSince(ev.datetime)}</div>
                  <div style={{width:6,height:6,borderRadius:"50%",background:col,marginTop:3,flexShrink:0}}/>
                  <div style={{flex:1}}>
                    <div style={{fontSize:10,color:col==="#475569"?"#6b7280":col,lineHeight:1.4}}>{ev.msg}</div>
                    <div style={{fontSize:9,color:"#1e3a5f",marginTop:2}}>{ev.subsystem?.toUpperCase()} · {ev.site?.toUpperCase()}</div>
                  </div>
                  <div style={{fontSize:8,padding:"2px 6px",borderRadius:2,background:ev.severity==="error"?"#1f0d0d":ev.severity==="warning"?"#1f1505":"#0d1117",color:col,alignSelf:"flex-start",letterSpacing:"0.1em",flexShrink:0}}>{ev.severity?.toUpperCase()}</div>
                </div>
              );
            })}
            </div>
          </div>
        </div>

        {/* ═══ RIGHT: NOC AGENT (collapsible) ═══ */}
        <div className="noc-agent-panel" style={{display:"flex",flexDirection:"column",width:agentOpen?380:0,opacity:agentOpen?1:0,borderLeft:agentOpen?`1px solid ${T.border}`:"none",pointerEvents:agentOpen?"all":"none"}}>
          <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:8}}>
            <div style={{width:28,height:28,borderRadius:"50%",background:"#0f1f3d",border:"1px solid #1e3a5f",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13}}>⬡</div>
            <div>
              <div style={{fontSize:11,color:"#7dd3fc",fontWeight:600,letterSpacing:"0.05em"}}>NOC AGENT</div>
              <div style={{fontSize:9,color:"#334155"}}>30yr · Network / OT / Factory Systems</div>
            </div>
            <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
              <div style={{fontSize:9,color:"#334155",textAlign:"right"}}>
                <div>IRVINE 1 + 2</div>
                <div>8 VLANs</div>
              </div>
              <button className="noc-btn" onClick={()=>setAgentOpen(false)} style={{width:22,height:22,padding:0,background:"transparent",border:`1px solid ${T.border}`,borderRadius:3,color:"#334155",fontSize:11,display:"flex",alignItems:"center",justifyContent:"center"}} title="Collapse agent panel">›</button>
            </div>
          </div>

          {/* Chat messages */}
          <div style={{flex:1,overflowY:"auto",padding:"14px 14px"}}>
            {messages.map((m,i)=>(
              <div key={i} className="noc-chat-msg" style={{marginBottom:14,display:"flex",flexDirection:"column",alignItems:m.role==="user"?"flex-end":"flex-start"}}>
                {m.role==="assistant"&&<div style={{fontSize:8,color:"#1e3a5f",letterSpacing:"0.12em",marginBottom:4}}>NOC AGENT</div>}
                <div style={{maxWidth:"92%",padding:"8px 12px",borderRadius:4,background:m.role==="user"?"#0f1f3d":"#0d1117",border:`1px solid ${m.role==="user"?"#1e3a5f":T.border}`,fontSize:11,color:m.role==="user"?"#7dd3fc":"#b0c4d8",lineHeight:1.6,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{m.content}</div>
              </div>
            ))}
            {thinking&&(
              <div style={{display:"flex",alignItems:"center",gap:6,padding:"6px 0"}}>
                <div style={{display:"flex",gap:3}}>
                  {[0,1,2].map(j=><div key={j} style={{width:4,height:4,borderRadius:"50%",background:"#3b82f6",animation:`noc-pulse 1.2s ease-in-out ${j*0.2}s infinite`}}/>)}
                </div>
                <span style={{fontSize:9,color:"#334155"}}>analyzing...</span>
              </div>
            )}
            <div ref={chatEndRef}/>
          </div>

          {/* Quick prompts */}
          <div style={{padding:"8px 14px",borderTop:"1px solid #0d1117",display:"flex",flexWrap:"wrap",gap:4}}>
            {["STP loop risk?","OT VLAN hardening","Kardex link stability","DVI VISION latency","WiFi coverage gaps","SD-WAN failover","Teleport VPN security","VPN split tunneling?"].map(q=>(
              <button key={q} className="noc-btn" onClick={()=>sendNocMessage(q)} style={{padding:"3px 8px",background:"transparent",border:`1px solid ${T.border}`,color:"#475569",borderRadius:2,fontSize:9,fontFamily:mono,letterSpacing:"0.06em"}}>{q}</button>
            ))}
          </div>

          {/* Input */}
          <div style={{padding:"10px 14px",borderTop:`1px solid ${T.border}`,display:"flex",gap:8}}>
            <textarea value={input} onChange={e=>setInput(e.target.value)} onKeyDown={e=>{if(e.key==="Enter"&&!e.shiftKey&&input.trim()){e.preventDefault();sendNocMessage(input.trim());}}} placeholder="Ask the NOC agent..." rows={2} style={{flex:1,padding:"8px 10px",background:"#0d1117",border:`1px solid ${T.border}`,color:"#c8d6e5",borderRadius:3,fontSize:11,fontFamily:mono,lineHeight:1.5,resize:"none"}}/>
            <button className="noc-btn" onClick={()=>input.trim()&&sendNocMessage(input.trim())} style={{padding:"0 12px",background:"#0f1f3d",border:"1px solid #1e3a5f",color:"#3b82f6",borderRadius:3,fontSize:14,alignSelf:"stretch"}}>⮕</button>
          </div>
        </div>

        {/* ═══ COLLAPSED AGENT TAB ═══ */}
        {!agentOpen&&(
          <div className="noc-agent-tab" onClick={()=>setAgentOpen(true)} style={{width:32,borderLeft:`1px solid ${T.border}`,background:"#0a0f14",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",gap:8,cursor:"pointer",userSelect:"none"}} title="Expand NOC Agent">
            {thinking&&<div style={{width:7,height:7,borderRadius:"50%",background:"#3b82f6",boxShadow:"0 0 6px #3b82f6"}} className="noc-pulse"/>}
            {!thinking&&messages.length>1&&(
              <div style={{width:16,height:16,borderRadius:"50%",background:"#1e3a5f",border:"1px solid #3b82f6",fontSize:8,color:"#7dd3fc",display:"flex",alignItems:"center",justifyContent:"center"}}>{messages.filter(m=>m.role==="assistant").length}</div>
            )}
            <span style={{fontSize:9,color:"#475569",letterSpacing:"0.18em",writingMode:"vertical-rl",textOrientation:"mixed",transform:"rotate(180deg)"}}>NOC AGENT</span>
            <span style={{fontSize:12,color:"#1e3a5f"}}>‹</span>
          </div>
        )}
      </div>

      {/* ═══ SWITCH PORT OVERLAY ═══ */}
      {switchPorts&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.7)",zIndex:100,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>setSwitchPorts(null)}>
          <div style={{background:"#0d1117",border:`1px solid ${T.border}`,borderRadius:8,padding:24,maxWidth:800,width:"90%",maxHeight:"80vh",overflow:"auto"}} onClick={e=>e.stopPropagation()}>
            <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:16}}>
              <span style={{fontSize:13}}>⊞</span>
              <div>
                <div style={{fontSize:13,color:"#7dd3fc",fontWeight:600}}>{switchPorts.device}</div>
                <div style={{fontSize:9,color:"#475569"}}>{switchPorts.portCount} ports · {switchPorts.mac}</div>
              </div>
              <button className="noc-btn" onClick={()=>setSwitchPorts(null)} style={{marginLeft:"auto",background:"transparent",border:`1px solid ${T.border}`,borderRadius:3,color:"#475569",width:28,height:28,fontSize:14,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
            </div>
            <div style={{display:"grid",gridTemplateColumns:`repeat(${switchPorts.portCount<=24?12:16},1fr)`,gap:4}}>
              {(switchPorts.ports||[]).map(p=>(
                <div key={p.port_idx} title={`${p.name}\n${p.vlan_name||"—"}\n${p.state} · ${p.speed?p.speed+"Mbps":"—"}\nPoE: ${p.poe_enable?p.poe_power+"W":"off"}\nMACs: ${p.mac_count}`} style={{
                  width:"100%",aspectRatio:"1",borderRadius:3,display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",cursor:"default",
                  background:p.state==="forwarding"?`${portVlanColor(p.vlan)}18`:"#0a0f14",
                  border:`2px solid ${portColor(p.state)}`,
                }}>
                  <div style={{fontSize:8,fontWeight:600,color:portColor(p.state)}}>{p.port_idx}</div>
                  {p.state==="forwarding"&&p.vlan&&<div style={{width:4,height:4,borderRadius:1,background:portVlanColor(p.vlan),marginTop:1}}/>}
                </div>
              ))}
            </div>
            <div style={{display:"flex",gap:12,marginTop:12,flexWrap:"wrap"}}>
              {[{label:"Forwarding",color:"#10b981"},{label:"Link Down",color:"#ef4444"},{label:"Disabled",color:"#334155"}].map(l=>(
                <div key={l.label} style={{display:"flex",alignItems:"center",gap:4}}>
                  <div style={{width:10,height:10,borderRadius:2,border:`2px solid ${l.color}`}}/>
                  <span style={{fontSize:9,color:"#475569"}}>{l.label}</span>
                </div>
              ))}
              <div style={{marginLeft:16,display:"flex",gap:8,flexWrap:"wrap"}}>
                {VLAN_DEFS.filter(v=>(switchPorts.ports||[]).some(p=>p.vlan===v.id)).map(v=>(
                  <div key={v.id} style={{display:"flex",alignItems:"center",gap:3}}>
                    <div style={{width:6,height:6,borderRadius:1,background:v.color}}/>
                    <span style={{fontSize:8,color:"#475569"}}>{v.name}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Early Warning System Tab ─────────────────────────────────
// ── Vision Dashboard ─────────────────────────────────────────
function VisionDashboard({ovenServerUrl,settings,isTablet}){
  const base=ovenServerUrl||`http://${window.location.hostname}:3002`;
  const mono="'JetBrains Mono',monospace";
  const isDemo=settings?.demoMode||false;

  const [sub,setSub]=useState("dashboard");
  const [accuracy,setAccuracy]=useState(null);
  const [exceptions,setExceptions]=useState([]);
  const [recentReads,setRecentReads]=useState([]);
  const [period,setPeriod]=useState("7d");
  const [loading,setLoading]=useState(true);
  const [resolveId,setResolveId]=useState(null);
  const [resolveJob,setResolveJob]=useState("");

  const DEMO_ACCURACY={period:"7d",successRate:92.4,totalScans:1847,matchedScans:1707,avgConfidence:0.82,exceptionsPending:12,totalAllTime:8934,
    byStation:[{station_id:"DIP-1",total:923,matched:862,success_rate:93.4},{station_id:"DIP-2",total:924,matched:845,success_rate:91.5}],
    byDay:[{day:"2026-03-20",total:294,matched:276,success_rate:93.9,avg_confidence:0.84},{day:"2026-03-19",total:312,matched:288,success_rate:92.3,avg_confidence:0.81},{day:"2026-03-18",total:298,matched:272,success_rate:91.3,avg_confidence:0.80},{day:"2026-03-17",total:276,matched:254,success_rate:92.0,avg_confidence:0.83},{day:"2026-03-16",total:320,matched:298,success_rate:93.1,avg_confidence:0.82},{day:"2026-03-15",total:182,matched:168,success_rate:92.3,avg_confidence:0.79},{day:"2026-03-14",total:165,matched:151,success_rate:91.5,avg_confidence:0.81}],
    confidenceDistribution:[{bucket:"90-100",count:842,matched:838},{bucket:"80-90",count:534,matched:510},{bucket:"70-80",count:298,matched:248},{bucket:"60-70",count:112,matched:78},{bucket:"50-60",count:42,matched:22},{bucket:"below-50",count:19,matched:11}],
    labelCounts:{good_read:1707,bad_read:140},model:null};
  const DEMO_EXCEPTIONS=[
    {id:1,capture_id:"scan_001",job_number:"301215",eye_side:"L",ocr_confidence:0.42,raw_text:"30I2I5L",validation_reason:"job_not_found",station_id:"DIP-1",scanned_at:"2026-03-20T08:14:00"},
    {id:2,capture_id:"scan_002",job_number:"407",eye_side:null,ocr_confidence:0.31,raw_text:"407",validation_reason:"job_not_found",station_id:"DIP-2",scanned_at:"2026-03-20T07:52:00"},
    {id:3,capture_id:"scan_003",job_number:"421695",eye_side:"R",ocr_confidence:0.68,raw_text:"42I695R",validation_reason:"job_not_found",station_id:"DIP-1",scanned_at:"2026-03-19T16:30:00"},
  ];

  const fetchData=useCallback(async()=>{
    if(isDemo){setAccuracy(DEMO_ACCURACY);setExceptions(DEMO_EXCEPTIONS);setLoading(false);return;}
    try{
      const days=period==="24h"?1:period==="30d"?30:7;
      const [aRes,eRes,rRes]=await Promise.all([
        fetch(`${base}/api/vision/accuracy?days=${days}`),
        fetch(`${base}/api/vision/exceptions?limit=50`),
        fetch(`${base}/api/vision/reads?limit=20`),
      ]);
      if(aRes.ok) setAccuracy(await aRes.json());
      if(eRes.ok) setExceptions(await eRes.json());
      if(rRes.ok) setRecentReads(await rRes.json());
    }catch(e){console.error("Vision fetch:",e);}
    finally{setLoading(false);}
  },[base,period,isDemo]);

  useEffect(()=>{fetchData();const t=setInterval(fetchData,30000);return()=>clearInterval(t);},[fetchData]);

  const resolveException=async(id)=>{
    if(!resolveJob.trim())return;
    try{
      await fetch(`${base}/api/vision/exceptions/${id}/resolve`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({correct_job:resolveJob.trim()})});
      setResolveId(null);setResolveJob("");fetchData();
    }catch(e){console.error(e);}
  };

  const a=accuracy||DEMO_ACCURACY;
  const sColor=(r)=>r>=95?T.green:r>=85?T.amber:T.red;

  if(loading)return <div style={{textAlign:"center",padding:60,color:T.textMuted,fontFamily:mono}}>Loading vision data...</div>;

  return(
    <div style={{padding:isTablet?"14px 12px":"22px 28px",maxWidth:3600,margin:"0 auto"}}>
      {/* Sub-tabs */}
      <div style={{display:"flex",gap:6,marginBottom:16,alignItems:"center"}}>
        <span style={{fontSize:20,marginRight:4}}>👁</span>
        <span style={{color:T.blue,fontWeight:600,letterSpacing:"0.12em",fontSize:13,marginRight:12}}>VISION SYSTEM</span>
        {[{id:"dashboard",label:"Dashboard"},{id:"exceptions",label:`Exceptions (${a.exceptionsPending})`},{id:"scanner",label:"Scanner"}].map(tab=>(
          <button key={tab.id} onClick={()=>setSub(tab.id)} style={{
            background:sub===tab.id?T.blueDark:"transparent",border:`1px solid ${sub===tab.id?T.blue:"transparent"}`,
            borderRadius:6,padding:"7px 16px",cursor:"pointer",color:sub===tab.id?"#93C5FD":T.textMuted,
            fontSize:11,fontWeight:600,fontFamily:mono,
          }}>{tab.label.toUpperCase()}</button>
        ))}
        <div style={{marginLeft:"auto",display:"flex",gap:6}}>
          {["24h","7d","30d"].map(p=>(
            <button key={p} onClick={()=>{setPeriod(p);setLoading(true);}} style={{padding:"4px 10px",fontSize:10,fontFamily:mono,background:period===p?T.blueDark:"transparent",color:period===p?"#7dd3fc":"#475569",border:`1px solid ${period===p?T.blue:T.border}`,borderRadius:3,cursor:"pointer"}}>{p.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* ═══ DASHBOARD ═══ */}
      {sub==="dashboard"&&(
        <div>
          {/* KPI Row */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:16}}>
            {[
              {label:"SUCCESS RATE",value:`${a.successRate}%`,color:sColor(a.successRate)},
              {label:"TOTAL SCANS",value:a.totalScans,color:T.blue},
              {label:"EXCEPTIONS",value:a.exceptionsPending,color:a.exceptionsPending>10?T.red:a.exceptionsPending>0?T.amber:T.green},
              {label:"AVG CONFIDENCE",value:`${Math.round(a.avgConfidence*100)}%`,color:a.avgConfidence>=0.8?T.green:a.avgConfidence>=0.6?T.amber:T.red},
              {label:"ALL-TIME SCANS",value:a.totalAllTime,color:T.purple},
            ].map(k=>(
              <div key={k.label} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:"12px 14px",textAlign:"center"}}>
                <div style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",marginBottom:4}}>{k.label}</div>
                <div style={{fontSize:22,fontWeight:700,color:k.color,lineHeight:1}}>{k.value}</div>
              </div>
            ))}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
            {/* Daily Trend */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:10}}>DAILY SUCCESS RATE</div>
              <div style={{display:"flex",alignItems:"flex-end",gap:4,height:120}}>
                {(a.byDay||[]).slice().reverse().map((d,i)=>{
                  const pct=Math.max(4,d.success_rate);
                  return(
                    <div key={i} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}} title={`${d.day}: ${d.success_rate}% (${d.total} scans)`}>
                      <div style={{fontSize:8,color:sColor(d.success_rate),fontWeight:600}}>{d.success_rate}%</div>
                      <div style={{width:"100%",height:`${pct}%`,background:sColor(d.success_rate),borderRadius:"3px 3px 0 0",minHeight:4,opacity:0.7}}/>
                      <div style={{fontSize:7,color:"#334155"}}>{(d.day||"").slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Confidence Distribution */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:10}}>CONFIDENCE DISTRIBUTION</div>
              {(a.confidenceDistribution||[]).map(b=>{
                const maxCount=Math.max(...(a.confidenceDistribution||[]).map(x=>x.count),1);
                const pct=Math.round((b.count/maxCount)*100);
                const matchPct=b.count>0?Math.round((b.matched/b.count)*100):0;
                return(
                  <div key={b.bucket} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                    <div style={{width:60,fontSize:9,color:"#475569",textAlign:"right"}}>{b.bucket}%</div>
                    <div style={{flex:1,height:14,background:"#0d1117",borderRadius:3,overflow:"hidden",border:"1px solid #111827",position:"relative"}}>
                      <div style={{height:"100%",width:`${pct}%`,background:T.blue,borderRadius:3,opacity:0.6}}/>
                      <div style={{position:"absolute",top:0,height:"100%",width:`${pct*matchPct/100}%`,background:T.green,borderRadius:3,opacity:0.8}}/>
                    </div>
                    <div style={{width:40,fontSize:9,color:"#334155"}}>{b.count}</div>
                  </div>
                );
              })}
              <div style={{display:"flex",gap:12,marginTop:6,justifyContent:"center"}}>
                <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:8,height:8,borderRadius:2,background:T.blue,opacity:0.6}}/><span style={{fontSize:8,color:"#475569"}}>Total</span></div>
                <div style={{display:"flex",alignItems:"center",gap:4}}><div style={{width:8,height:8,borderRadius:2,background:T.green,opacity:0.8}}/><span style={{fontSize:8,color:"#475569"}}>Matched</span></div>
              </div>
            </div>
          </div>

          {/* By Station */}
          {(a.byStation||[]).length>0&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14,marginTop:16}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>ACCURACY BY STATION</div>
              <table style={{width:"100%",fontSize:10,fontFamily:mono,borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
                  {["Station","Scans","Matched","Rate"].map(h=><th key={h} style={{padding:"5px 8px",textAlign:"left",color:"#475569",fontSize:9}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {(a.byStation||[]).map(s=>(
                    <tr key={s.station_id} style={{borderBottom:`1px solid #0d1117`}}>
                      <td style={{padding:"5px 8px",color:T.text,fontWeight:600}}>{s.station_id}</td>
                      <td style={{padding:"5px 8px",color:"#7dd3fc"}}>{s.total}</td>
                      <td style={{padding:"5px 8px",color:T.green}}>{s.matched}</td>
                      <td style={{padding:"5px 8px",color:sColor(s.success_rate),fontWeight:600}}>{s.success_rate}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Training Data Stats */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginTop:16}}>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12,textAlign:"center"}}>
              <div style={{fontSize:20,fontWeight:700,color:T.green}}>{a.labelCounts?.good_read||0}</div>
              <div style={{fontSize:9,color:"#475569",marginTop:2}}>GOOD READ LABELS</div>
            </div>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12,textAlign:"center"}}>
              <div style={{fontSize:20,fontWeight:700,color:T.red}}>{a.labelCounts?.bad_read||0}</div>
              <div style={{fontSize:9,color:"#475569",marginTop:2}}>BAD READ LABELS</div>
            </div>
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12,textAlign:"center"}}>
              <div style={{fontSize:20,fontWeight:700,color:T.purple}}>{(a.labelCounts?.good_read||0)+(a.labelCounts?.bad_read||0)}</div>
              <div style={{fontSize:9,color:"#475569",marginTop:2}}>TOTAL TRAINING SAMPLES</div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ EXCEPTIONS ═══ */}
      {sub==="exceptions"&&(
        <div>
          <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:12}}>UNRESOLVED EXCEPTIONS — OPERATOR REVIEW NEEDED</div>
          {exceptions.length===0&&<div style={{textAlign:"center",padding:40,color:"#334155",fontFamily:mono,fontSize:11}}>No pending exceptions. All reads resolved.</div>}
          {exceptions.map(ex=>(
            <div key={ex.id} style={{background:T.card,border:`1px solid ${ex.ocr_confidence<0.5?"rgba(239,68,68,0.2)":T.border}`,borderRadius:4,padding:14,marginBottom:8}}>
              <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:6}}>
                <span style={{fontSize:14,fontWeight:700,color:T.red,fontFamily:mono}}>{ex.job_number||"—"}</span>
                {ex.eye_side&&<span style={{fontSize:10,color:ex.eye_side==="L"?T.blue:T.purple,fontWeight:700}}>{ex.eye_side}</span>}
                <span style={{fontSize:9,color:"#475569"}}>{ex.validation_reason}</span>
                <span style={{fontSize:9,color:"#334155",marginLeft:"auto"}}>{ex.station_id||"—"}</span>
                <span style={{fontSize:9,color:"#334155"}}>{ex.scanned_at?new Date(ex.scanned_at).toLocaleString():""}</span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:8}}>
                <span style={{fontSize:9,color:"#475569"}}>Confidence: {Math.round((ex.ocr_confidence||0)*100)}%</span>
                {ex.raw_text&&<span style={{fontSize:9,color:"#334155"}}>Raw: "{ex.raw_text}"</span>}
              </div>
              {resolveId===ex.id?(
                <div style={{display:"flex",gap:6,marginTop:8}}>
                  <input value={resolveJob} onChange={e=>setResolveJob(e.target.value)} placeholder="Correct job #" onKeyDown={e=>{if(e.key==="Enter")resolveException(ex.id);}}
                    style={{flex:1,padding:"6px 10px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:12}}/>
                  <button onClick={()=>resolveException(ex.id)} style={{padding:"6px 14px",background:T.green,border:"none",borderRadius:3,color:"#000",fontFamily:mono,fontSize:10,fontWeight:700,cursor:"pointer"}}>RESOLVE</button>
                  <button onClick={()=>{setResolveId(null);setResolveJob("");}} style={{padding:"6px 10px",background:"transparent",border:`1px solid ${T.border}`,borderRadius:3,color:"#475569",fontFamily:mono,fontSize:10,cursor:"pointer"}}>CANCEL</button>
                </div>
              ):(
                <button onClick={()=>setResolveId(ex.id)} style={{marginTop:6,padding:"5px 12px",background:"transparent",border:`1px solid ${T.amber}44`,borderRadius:3,color:T.amber,fontFamily:mono,fontSize:9,cursor:"pointer"}}>CORRECT THIS READ</button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* ═══ SCANNER ═══ */}
      {sub==="scanner"&&(
        <div style={{height:isTablet?"calc(100dvh - 160px)":"calc(100dvh - 130px)",overflow:"hidden"}}>
          <LensScanner/>
        </div>
      )}
    </div>
  );
}

// ── Time at Lab Tab ──────────────────────────────────────────
function TimeAtLabTab({ovenServerUrl,settings}){
  const base=ovenServerUrl||`http://${window.location.hostname}:3002`;
  const mono="'JetBrains Mono',monospace";
  const isDemo=settings?.demoMode||false;

  const [summary,setSummary]=useState(null);
  const [period,setPeriod]=useState("7d");
  const [jobSearch,setJobSearch]=useState("");
  const [selectedJob,setSelectedJob]=useState(null);
  const [recentJobs,setRecentJobs]=useState([]);
  const [histogram,setHistogram]=useState({mode:"active",totalJobs:0,buckets:[]});
  const [histFilter,setHistFilter]=useState({lensType:"",coating:"",stage:"",mode:"active"});
  const [loading,setLoading]=useState(true);
  const [lastRefresh,setLastRefresh]=useState(null);

  // Demo data
  const DEMO_SUMMARY={period:"7d",shipped:{total:842,avgDays:1.8,minDays:0.3,maxDays:4.2,slaCompliance:94.2,slaMet:793,slaMissed:49},
    stageDwells:[{stage:"COATING",avg_min:142,min_min:45,max_min:380,transitions:890},{stage:"SURFACING",avg_min:98,min_min:22,max_min:240,transitions:845},{stage:"ASSEMBLY",avg_min:52,min_min:12,max_min:180,transitions:830},{stage:"CUTTING",avg_min:38,min_min:8,max_min:120,transitions:840},{stage:"QC",avg_min:24,min_min:5,max_min:90,transitions:825},{stage:"INCOMING",avg_min:18,min_min:2,max_min:60,transitions:842}],
    bottleneck:{stage:"COATING",avgMinutes:142},
    wip:[{stage:"INCOMING",count:22,avgDays:0.03,oldestDays:0.13},{stage:"SURFACING",count:45,avgDays:0.09,oldestDays:0.28},{stage:"COATING",count:68,avgDays:0.14,oldestDays:0.5},{stage:"CUTTING",count:34,avgDays:0.05,oldestDays:0.19},{stage:"ASSEMBLY",count:52,avgDays:0.08,oldestDays:0.34},{stage:"QC",count:18,avgDays:0.03,oldestDays:0.09}],
    atRisk:[{jobId:"421690",coating:"TRANS",stage:"COATING",daysElapsed:2.4,daysRemaining:0.6,slaDays:3,status:"critical"},{jobId:"421672",coating:"AR",stage:"ASSEMBLY",daysElapsed:1.8,daysRemaining:0.2,slaDays:2,status:"critical"},{jobId:"421688",coating:"POLAR",stage:"SURFACING",daysElapsed:1.2,daysRemaining:1.8,slaDays:3,status:"at_risk"}],
    totalTracked:2847};
  const DEMO_RECENT=Array.from({length:20},(_,i)=>({job_id:`42${1695-i}`,coating:["AR","Blue Cut","Hard Coat","Transitions","Mirror"][i%5],lens_material:["PLY","H67","CR39"][i%3],lens_type:["P","S","B"][i%3],is_rush:i%7===0?1:0,total_days:Math.round((0.5+Math.random()*3)*10)/10,sla_met:Math.random()>0.1?1:0,shipped_at:Date.now()-i*86400000,entered_lab_at:Date.now()-(i+1.5)*86400000}));

  const fetchData=useCallback(async()=>{
    if(isDemo){setSummary(DEMO_SUMMARY);setRecentJobs(DEMO_RECENT);setHistogram({mode:"active",totalJobs:239,buckets:[{day:0,count:82,byCoating:{AR:35,"Blue Cut":20,"Hard Coat":15,Transitions:8,Mirror:4},byLensType:{P:40,S:32,B:10},byStage:{SURFACING:25,COATING:30,CUTTING:15,ASSEMBLY:8,QC:4}},{day:1,count:68,byCoating:{AR:28,"Blue Cut":18,"Hard Coat":12,Transitions:6,Mirror:4},byLensType:{P:35,S:25,B:8},byStage:{COATING:28,ASSEMBLY:20,QC:12,CUTTING:8}},{day:2,count:42,byCoating:{AR:18,"Blue Cut":10,Transitions:8,"Hard Coat":4,Mirror:2},byLensType:{P:22,S:15,B:5},byStage:{COATING:18,ASSEMBLY:14,QC:10}},{day:3,count:24,byCoating:{AR:10,Transitions:6,"Blue Cut":4,"Hard Coat":3,Polarized:1},byLensType:{P:14,S:8,B:2},byStage:{COATING:12,ASSEMBLY:8,QC:4}},{day:4,count:12,byCoating:{Transitions:5,AR:4,"Blue Cut":2,Mirror:1},byLensType:{P:8,S:3,B:1},byStage:{COATING:8,ASSEMBLY:4}},{day:5,count:6,byCoating:{Transitions:3,Polarized:2,AR:1},byLensType:{P:5,S:1},byStage:{COATING:4,HOLD:2}},{day:6,count:3,byCoating:{Transitions:2,Polarized:1},byLensType:{P:3},byStage:{HOLD:2,COATING:1}},{day:7,count:2,byCoating:{Transitions:1,Polarized:1},byLensType:{P:2},byStage:{HOLD:2}}]});setLoading(false);setLastRefresh(new Date());return;}
    try{
      const histParams=new URLSearchParams({mode:histFilter.mode,period});
      if(histFilter.lensType)histParams.set("lensType",histFilter.lensType);
      if(histFilter.coating)histParams.set("coating",histFilter.coating);
      if(histFilter.stage)histParams.set("stage",histFilter.stage);
      const [sRes,rRes,hRes]=await Promise.all([
        fetch(`${base}/api/time-at-lab/summary?period=${period}`),
        fetch(`${base}/api/time-at-lab/recent?limit=25`),
        fetch(`${base}/api/time-at-lab/histogram?${histParams}`),
      ]);
      if(sRes.ok) setSummary(await sRes.json());
      if(rRes.ok) setRecentJobs(await rRes.json());
      if(hRes.ok) setHistogram(await hRes.json()); else setHistogram({mode:"active",totalJobs:0,buckets:[]});
      setLastRefresh(new Date());
    }catch(e){console.error("TAL fetch error:",e);}
    finally{setLoading(false);}
  },[base,period,isDemo,histFilter]);

  useEffect(()=>{fetchData();const t=setInterval(fetchData,30000);return()=>clearInterval(t);},[fetchData]);

  const searchJob=async()=>{
    if(!jobSearch.trim())return;
    if(isDemo){setSelectedJob({job_id:jobSearch,coating:"AR",lens_material:"PLY",lens_type:"P",daysElapsed:1.8,current_stage:"ASSEMBLY",slaStatus:"on_track",stageDurations:{INCOMING:12,SURFACING:95,COATING:140,CUTTING:35,ASSEMBLY:28},transitions:[{from_stage:"INCOMING",to_stage:"SURFACING",transition_at:Date.now()-1.8*86400000,dwell_minutes:12},{from_stage:"SURFACING",to_stage:"COATING",transition_at:Date.now()-1.5*86400000,dwell_minutes:95},{from_stage:"COATING",to_stage:"CUTTING",transition_at:Date.now()-0.8*86400000,dwell_minutes:140},{from_stage:"CUTTING",to_stage:"ASSEMBLY",transition_at:Date.now()-0.5*86400000,dwell_minutes:35}]});return;}
    try{
      const r=await fetch(`${base}/api/time-at-lab/job/${encodeURIComponent(jobSearch.trim())}`);
      if(r.ok) setSelectedJob(await r.json()); else setSelectedJob(null);
    }catch(e){setSelectedJob(null);}
  };

  const fmtDays=(d)=>{if(d==null)return"—";const abs=Math.abs(d);const neg=d<0?"-":"";if(abs<0.05)return`${neg}${Math.round(abs*24*60)}m`;if(abs<1)return`${neg}${Math.round(abs*24)}h`;return`${neg}${Math.round(abs*10)/10}d`;};
  const stageColor=(s)=>({INCOMING:"#64748b",SURFACING:"#06b6d4",COATING:"#f59e0b",CUTTING:"#3b82f6",ASSEMBLY:"#8b5cf6",QC:"#10b981",SHIPPED:"#10b981"}[s]||"#475569");
  const slaColor=(s)=>s==="met"||s==="on_track"?"#10b981":s==="at_risk"?"#f59e0b":s==="critical"||s==="breached"?"#ef4444":"#475569";

  if(loading)return <div style={{textAlign:"center",padding:60,color:T.textMuted,fontFamily:mono,fontSize:12}}>Loading time-at-lab data...</div>;

  const s=summary||DEMO_SUMMARY;
  const totalWip=s.wip.reduce((sum,w)=>sum+w.count,0);
  const maxDwell=Math.max(...(s.stageDwells||[]).map(d=>d.avg_min),1);

  return(
    <div style={{fontFamily:mono}}>
      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:16,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:20}}>⏱</span>
          <span style={{color:T.blue,fontWeight:600,letterSpacing:"0.12em",fontSize:13}}>TIME AT LAB</span>
        </div>
        <div style={{display:"flex",gap:6}}>
          {["24h","7d","30d"].map(p=>(
            <button key={p} onClick={()=>{setPeriod(p);setLoading(true);}} style={{
              padding:"4px 12px",fontSize:11,fontFamily:mono,
              background:period===p?T.blueDark:"transparent",color:period===p?"#7dd3fc":"#475569",
              border:`1px solid ${period===p?T.blue:T.border}`,borderRadius:3,cursor:"pointer",letterSpacing:"0.1em",
            }}>{p.toUpperCase()}</button>
          ))}
        </div>
        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          <input value={jobSearch} onChange={e=>setJobSearch(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")searchJob();}}
            placeholder="Search job #..." style={{padding:"5px 10px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:11,width:140}}/>
          <button onClick={searchJob} style={{padding:"5px 10px",background:T.blue,border:"none",borderRadius:3,color:"#fff",fontFamily:mono,fontSize:10,cursor:"pointer"}}>FIND</button>
          {lastRefresh&&<span style={{fontSize:10,color:"#334155"}}>{lastRefresh.toLocaleTimeString()}</span>}
        </div>
      </div>

      {/* KPI Row */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:16}}>
        {[
          {label:"AVG TIME",value:fmtDays(s.shipped.avgDays),color:s.shipped.avgDays>3?T.red:s.shipped.avgDays>2?T.amber:T.green},
          {label:"SLA COMPLIANCE",value:`${s.shipped.slaCompliance}%`,color:s.shipped.slaCompliance>=95?T.green:s.shipped.slaCompliance>=90?T.amber:T.red},
          {label:"SHIPPED",value:s.shipped.total,color:T.blue},
          {label:"TOTAL WIP",value:totalWip,color:T.purple},
          {label:"BOTTLENECK",value:s.bottleneck?.stage||"—",color:T.amber},
        ].map(k=>(
          <div key={k.label} style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:"12px 14px",textAlign:"center"}}>
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",marginBottom:4}}>{k.label}</div>
            <div style={{fontSize:22,fontWeight:700,color:k.color,lineHeight:1}}>{k.value}</div>
          </div>
        ))}
      </div>

      {/* Histogram: Jobs by Days in Lab */}
      {histogram&&(
        <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14,marginBottom:16}}>
          <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:12,flexWrap:"wrap"}}>
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>JOBS BY DAYS IN LAB</div>
            <div style={{fontSize:10,color:T.text,fontWeight:600}}>{histogram.totalJobs} jobs</div>
            <div style={{marginLeft:"auto",display:"flex",gap:6,flexWrap:"wrap"}}>
              <select value={histFilter.lensType} onChange={e=>{setHistFilter(p=>({...p,lensType:e.target.value}));setLoading(true);}} style={{padding:"3px 6px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:9}}>
                <option value="">All Lens Types</option>
                <option value="P">Progressive</option>
                <option value="S">Single Vision</option>
                <option value="B">Bifocal</option>
              </select>
              <select value={histFilter.coating} onChange={e=>{setHistFilter(p=>({...p,coating:e.target.value}));setLoading(true);}} style={{padding:"3px 6px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:9}}>
                <option value="">All Coatings</option>
                {["AR","Blue Cut","Hard Coat","Transitions","Mirror","Polarized"].map(c=><option key={c} value={c}>{c}</option>)}
              </select>
              <select value={histFilter.stage} onChange={e=>{setHistFilter(p=>({...p,stage:e.target.value}));setLoading(true);}} style={{padding:"3px 6px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:9}}>
                <option value="">All Departments</option>
                {["SURFACING","COATING","CUTTING","ASSEMBLY","QC"].map(s=><option key={s} value={s}>{s}</option>)}
              </select>
              <select value={histFilter.mode} onChange={e=>{setHistFilter(p=>({...p,mode:e.target.value}));setLoading(true);}} style={{padding:"3px 6px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:9}}>
                <option value="active">Active WIP</option>
                <option value="shipped">Shipped</option>
              </select>
            </div>
          </div>
          {/* Bar chart */}
          {(!histogram.buckets||histogram.buckets.length===0)&&(
            <div style={{textAlign:"center",padding:30,color:"#334155",fontSize:11,fontFamily:mono}}>No jobs found with current filters. Try changing the filter or switching to Active WIP mode.</div>
          )}
          {histogram.buckets&&histogram.buckets.length>0&&(()=>{
            const maxCount=Math.max(...histogram.buckets.map(b=>b.count),1);
            return(
              <div style={{display:"flex",alignItems:"flex-end",gap:2,height:140,paddingBottom:20,position:"relative"}}>
                {histogram.buckets.map(b=>{
                  const pct=Math.max(4,(b.count/maxCount)*100);
                  const color=b.day<=1?"#10b981":b.day<=2?"#3b82f6":b.day<=3?"#f59e0b":"#ef4444";
                  return(
                    <div key={b.day} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}} title={`Day ${b.day}: ${b.count} jobs\n${Object.entries(b.byLensType||{}).map(([k,v])=>`${k}:${v}`).join(", ")}`}>
                      <div style={{fontSize:9,color:T.text,fontWeight:600}}>{b.count}</div>
                      <div style={{width:"100%",height:`${pct}%`,background:color,borderRadius:"3px 3px 0 0",minHeight:4}}/>
                      <div style={{fontSize:8,color:"#475569",fontFamily:mono,position:"absolute",bottom:0}}>
                        {b.day}d
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })()}
          {histogram.buckets&&histogram.buckets.length>0&&<>
          {/* Legend */}
          <div style={{display:"flex",gap:12,marginTop:8,justifyContent:"center"}}>
            {[{label:"0-1 day",color:"#10b981"},{label:"1-2 days",color:"#3b82f6"},{label:"2-3 days",color:"#f59e0b"},{label:"3+ days",color:"#ef4444"}].map(l=>(
              <div key={l.label} style={{display:"flex",alignItems:"center",gap:4}}>
                <div style={{width:10,height:10,borderRadius:2,background:l.color}}/>
                <span style={{fontSize:8,color:"#475569"}}>{l.label}</span>
              </div>
            ))}
          </div>
          </>}
        </div>
      )}

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,alignItems:"start"}}>
        {/* Left: Stage Breakdown + WIP */}
        <div>
          {/* Stage Dwell Times */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14,marginBottom:12}}>
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:10}}>AVG DWELL TIME BY STAGE</div>
            {(s.stageDwells||[]).map(d=>{
              const pct=Math.round((d.avg_min/maxDwell)*100);
              return(
                <div key={d.stage} style={{display:"flex",alignItems:"center",gap:8,marginBottom:6}}>
                  <div style={{width:80,fontSize:9,color:stageColor(d.stage),textAlign:"right",fontWeight:600}}>{d.stage}</div>
                  <div style={{flex:1,height:14,background:"#0d1117",borderRadius:3,overflow:"hidden",border:"1px solid #111827"}}>
                    <div style={{height:"100%",width:`${pct}%`,background:stageColor(d.stage),borderRadius:3,opacity:0.7}}/>
                  </div>
                  <div style={{width:50,fontSize:10,color:T.text,fontWeight:600,textAlign:"right"}}>{d.avg_min>=60?`${Math.round(d.avg_min/6)/10}h`:`${d.avg_min}m`}</div>
                </div>
              );
            })}
          </div>

          {/* Current WIP */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14}}>
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:10}}>CURRENT WIP BY STAGE</div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:6}}>
              {(s.wip||[]).map(w=>(
                <div key={w.stage} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:4,padding:"8px 10px",textAlign:"center"}}>
                  <div style={{fontSize:18,fontWeight:700,color:stageColor(w.stage)}}>{w.count}</div>
                  <div style={{fontSize:8,color:"#475569",letterSpacing:"0.1em",marginTop:2}}>{w.stage}</div>
                  <div style={{fontSize:9,color:"#334155",marginTop:2}}>avg {fmtDays(w.avgDays)}</div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Right: At-Risk + Recent */}
        <div>
          {/* SLA At Risk */}
          {(s.atRisk||[]).length>0&&(
            <div style={{background:"rgba(239,68,68,0.04)",border:"1px solid rgba(239,68,68,0.15)",borderRadius:4,padding:14,marginBottom:12}}>
              <div style={{fontSize:9,color:"#ef4444",letterSpacing:"0.14em",marginBottom:8}}>SLA AT RISK ({s.atRisk.length})</div>
              {s.atRisk.map(j=>(
                <div key={j.jobId} onClick={()=>{setJobSearch(j.jobId);searchJob();}} style={{display:"flex",alignItems:"center",gap:8,padding:"6px 8px",background:"rgba(0,0,0,0.2)",borderRadius:3,marginBottom:4,cursor:"pointer"}}>
                  <span style={{fontSize:11,fontWeight:700,color:slaColor(j.status),fontFamily:mono}}>{j.jobId}</span>
                  <span style={{fontSize:9,color:stageColor(j.stage)}}>{j.stage}</span>
                  <span style={{fontSize:9,color:"#475569"}}>{j.coating}</span>
                  <span style={{fontSize:9,color:slaColor(j.status),marginLeft:"auto",fontWeight:600}}>{fmtDays(j.daysRemaining)} left</span>
                </div>
              ))}
            </div>
          )}

          {/* Recent Shipped */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:14}}>
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>RECENT SHIPPED</div>
            <div style={{maxHeight:300,overflowY:"auto"}}>
              {recentJobs.map(j=>(
                <div key={j.job_id} onClick={()=>{setJobSearch(j.job_id);setSelectedJob(null);searchJob();}} style={{display:"flex",alignItems:"center",gap:6,padding:"5px 6px",borderBottom:`1px solid ${T.border}`,cursor:"pointer",fontSize:10}}>
                  <span style={{fontWeight:700,color:T.green,width:60}}>{j.job_id}</span>
                  <span style={{color:"#475569",width:60}}>{j.coating}</span>
                  <span style={{color:"#334155",width:30}}>{j.lens_type}</span>
                  <span style={{color:j.sla_met?T.green:T.red,fontWeight:600,marginLeft:"auto"}}>{j.total_days}d</span>
                  {j.is_rush===1&&<span style={{fontSize:8,color:T.amber,fontWeight:700}}>RUSH</span>}
                  <span style={{width:14,textAlign:"center"}}>{j.sla_met?<span style={{color:T.green}}>✓</span>:<span style={{color:T.red}}>✗</span>}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Job Detail (search result) */}
      {selectedJob&&(
        <div style={{marginTop:16,background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:16}}>
          <div style={{display:"flex",alignItems:"center",gap:12,marginBottom:12}}>
            <span style={{fontSize:18,fontWeight:700,color:T.green,fontFamily:mono}}>{selectedJob.job_id}</span>
            <span style={{fontSize:10,color:stageColor(selectedJob.current_stage),fontWeight:600,padding:"2px 8px",background:`${stageColor(selectedJob.current_stage)}22`,borderRadius:3}}>{selectedJob.current_stage}</span>
            {selectedJob.coating&&<span style={{fontSize:10,color:"#7dd3fc"}}>{selectedJob.coating}</span>}
            {selectedJob.lens_material&&<span style={{fontSize:10,color:"#475569"}}>{selectedJob.lens_material}</span>}
            <span style={{fontSize:10,color:slaColor(selectedJob.slaStatus),marginLeft:"auto",fontWeight:600}}>SLA: {selectedJob.slaStatus?.toUpperCase()}</span>
            <span style={{fontSize:11,fontWeight:700,color:T.text}}>{fmtDays(selectedJob.daysElapsed)} total</span>
            <button onClick={()=>setSelectedJob(null)} style={{background:"none",border:`1px solid ${T.border}`,borderRadius:3,color:"#334155",width:22,height:22,cursor:"pointer",fontSize:11}}>✕</button>
          </div>

          {/* Stage timeline bar */}
          {selectedJob.stageDurations&&(
            <div style={{display:"flex",height:28,borderRadius:6,overflow:"hidden",marginBottom:12,border:`1px solid ${T.border}`}}>
              {Object.entries(selectedJob.stageDurations).map(([stage,min])=>{
                const totalMin=Object.values(selectedJob.stageDurations).reduce((s,v)=>s+v,0);
                const pct=totalMin>0?Math.max(2,(min/totalMin)*100):0;
                return(
                  <div key={stage} title={`${stage}: ${min}m`} style={{width:`${pct}%`,background:stageColor(stage),display:"flex",alignItems:"center",justifyContent:"center",overflow:"hidden",minWidth:pct>8?undefined:0}}>
                    {pct>10&&<span style={{fontSize:8,color:"#fff",fontWeight:700,textShadow:"0 0 3px rgba(0,0,0,0.5)"}}>{stage.substring(0,4)}</span>}
                  </div>
                );
              })}
            </div>
          )}

          {/* Transition log */}
          {selectedJob.transitions&&selectedJob.transitions.length>0&&(
            <div style={{maxHeight:200,overflowY:"auto"}}>
              <table style={{width:"100%",fontSize:9,borderCollapse:"collapse"}}>
                <thead><tr style={{borderBottom:`1px solid ${T.border}`}}>
                  {["From","To","Time","Dwell"].map(h=><th key={h} style={{padding:"4px 8px",textAlign:"left",color:"#475569"}}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {selectedJob.transitions.map((t,i)=>(
                    <tr key={i} style={{borderBottom:`1px solid #0d1117`}}>
                      <td style={{padding:"4px 8px",color:stageColor(t.from_stage)}}>{t.from_stage||"—"}</td>
                      <td style={{padding:"4px 8px",color:stageColor(t.to_stage)}}>{t.to_stage}</td>
                      <td style={{padding:"4px 8px",color:"#7dd3fc"}}>{t.transition_at?new Date(t.transition_at).toLocaleString():""}</td>
                      <td style={{padding:"4px 8px",color:T.text}}>{t.dwell_minutes?`${t.dwell_minutes}m`:"—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════
// FLOW AGENT TAB — Work Release Control System
// ═══════════════════════════════════════════════════════════════════

function FlowAgentTab({ovenServerUrl,settings}){
  const base=ovenServerUrl||`http://${window.location.hostname}:3002`;
  const mono="'JetBrains Mono',monospace";

  const [snapshot,setSnapshot]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  const [subTab,setSubTab]=useState("pipeline");
  const [expandedStage,setExpandedStage]=useState(null);
  const [recommendations,setRecommendations]=useState([]);
  const [pushHistory,setPushHistory]=useState([]);
  const [stageConfigs,setStageConfigs]=useState([]);
  const [lineConfigs,setLineConfigs]=useState([]);
  const [catchUp,setCatchUp]=useState(null);
  const [catchUpLine,setCatchUpLine]=useState("all");
  const [trendData,setTrendData]=useState(null);
  const [trendLine,setTrendLine]=useState("sv");
  const [health,setHealth]=useState(null);
  const [showConfig,setShowConfig]=useState(false);
  const [editingStage,setEditingStage]=useState(null);
  const [stageEdits,setStageEdits]=useState({});
  const [pushForm,setPushForm]=useState({line_id:"sv",qty:"",operator:"",note:""});
  const [expiredRecs,setExpiredRecs]=useState([]);
  const [showExpired,setShowExpired]=useState(false);
  const [catchUpScenario,setCatchUpScenario]=useState({assemblers:"",jobsPerAssemblerHr:"",shiftHours:"",shifts:"",incomingPerDay:"",targetDays:"",targetBacklog:""});
  const [lastRefresh,setLastRefresh]=useState(null);
  const [putList,setPutList]=useState(null);
  const [putListExpanded,setPutListExpanded]=useState(null);
  const [nelData,setNelData]=useState(null);
  const [readiness,setReadiness]=useState(null);

  // Fetch snapshot + recs on mount and every 60s
  useEffect(()=>{
    let mounted=true;
    const load=async()=>{
      try{
        const [snapRes,recRes,histRes,healthRes,expRes]=await Promise.all([
          fetch(`${base}/api/flow/snapshot`),
          fetch(`${base}/api/flow/recommendations?status=pending`),
          fetch(`${base}/api/flow/history?hours=24`),
          fetch(`${base}/api/flow/health`),
          fetch(`${base}/api/flow/recommendations?status=expired`),
        ]);
        if(!mounted)return;
        if(snapRes.ok){const d=await snapRes.json();setSnapshot(d);}
        if(recRes.ok){const d=await recRes.json();setRecommendations(d);}
        if(histRes.ok){const d=await histRes.json();setPushHistory(d);}
        if(healthRes.ok){const d=await healthRes.json();setHealth(d);}
        if(expRes.ok){const d=await expRes.json();setExpiredRecs(d);}
        setLoading(false);setError(null);
        setLastRefresh(new Date());
      }catch(e){if(mounted){setError(e.message);setLoading(false);}}
    };
    load();
    const iv=setInterval(load,60000);
    return()=>{mounted=false;clearInterval(iv);};
  },[base]);

  // Load configs when config drawer opens
  useEffect(()=>{
    if(!showConfig)return;
    fetch(`${base}/api/flow/config/stages`).then(r=>r.json()).then(setStageConfigs).catch(()=>{});
    fetch(`${base}/api/flow/config/lines`).then(r=>r.json()).then(setLineConfigs).catch(()=>{});
  },[showConfig,base]);

  // Load catch-up when tab switches or scenario changes
  const loadCatchUp=useCallback(()=>{
    if(subTab!=="catchup")return;
    const body={};
    if(catchUpScenario.assemblers)body.assemblers=parseInt(catchUpScenario.assemblers);
    if(catchUpScenario.jobsPerAssemblerHr)body.jobsPerAssemblerHr=parseFloat(catchUpScenario.jobsPerAssemblerHr);
    if(catchUpScenario.shiftHours)body.shiftHours=parseFloat(catchUpScenario.shiftHours);
    if(catchUpScenario.shifts)body.shifts=parseInt(catchUpScenario.shifts);
    if(catchUpScenario.incomingPerDay)body.incomingPerDay=parseInt(catchUpScenario.incomingPerDay);
    if(catchUpScenario.targetDays)body.targetDays=parseFloat(catchUpScenario.targetDays);
    if(catchUpScenario.targetBacklog)body.targetBacklog=parseInt(catchUpScenario.targetBacklog);
    if(catchUpScenario.workDays)body.workDays=catchUpScenario.workDays;
    const hasOverrides=Object.keys(body).length>0;
    if(hasOverrides){
      fetch(`${base}/api/flow/catchup/${catchUpLine}`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)}).then(r=>r.json()).then(setCatchUp).catch(()=>{});
    }else{
      fetch(`${base}/api/flow/catchup/${catchUpLine}`).then(r=>r.json()).then(setCatchUp).catch(()=>{});
    }
  },[subTab,catchUpLine,base,catchUpScenario]);
  useEffect(()=>{loadCatchUp();},[loadCatchUp]);

  // History analysis
  const [historyData,setHistoryData]=useState(null);
  const [historyDays,setHistoryDays]=useState(7);
  const [historyStage,setHistoryStage]=useState("ASSEMBLY");
  useEffect(()=>{
    if(subTab!=="history-analysis")return;
    fetch(`${base}/api/flow/history-analysis?days=${historyDays}`).then(r=>r.json()).then(setHistoryData).catch(()=>{});
  },[subTab,historyDays,base]);

  // Load trend when tab switches
  useEffect(()=>{
    if(subTab!=="trend")return;
    fetch(`${base}/api/flow/line/${trendLine}/trend?hours=8`).then(r=>r.json()).then(setTrendData).catch(()=>{});
  },[subTab,trendLine,base]);

  const ackRec=async(id)=>{
    await fetch(`${base}/api/flow/recommendations/${id}/ack`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operator:"dashboard"})});
    setRecommendations(prev=>prev.filter(r=>r.id!==id));
  };

  const completeRec=async(id)=>{
    await fetch(`${base}/api/flow/recommendations/${id}/complete`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({operator:"dashboard"})});
    setRecommendations(prev=>prev.filter(r=>r.id!==id));
  };

  const logPush=async()=>{
    if(!pushForm.qty)return;
    await fetch(`${base}/api/flow/push`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({line_id:pushForm.line_id,qty:parseInt(pushForm.qty),operator:pushForm.operator,note:pushForm.note})});
    setPushForm(p=>({...p,qty:"",note:""}));
    fetch(`${base}/api/flow/history?hours=24`).then(r=>r.json()).then(setPushHistory).catch(()=>{});
  };

  const saveStageConfig=async(stageId)=>{
    await fetch(`${base}/api/flow/config/stages/${stageId}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(stageEdits)});
    setEditingStage(null);setStageEdits({});
    fetch(`${base}/api/flow/config/stages`).then(r=>r.json()).then(setStageConfigs).catch(()=>{});
  };

  // Status colors
  const statusColor=(s)=>({critical:"#ef4444",warning:"#f59e0b",watch:"#06b6d4",healthy:"#22c55e"}[s]||"#6b7280");
  const statusBg=(s)=>({critical:"rgba(239,68,68,0.12)",warning:"rgba(245,158,11,0.10)",watch:"rgba(6,182,212,0.08)",healthy:"rgba(34,197,94,0.08)"}[s]||"rgba(107,114,128,0.08)");

  // Sub-tab buttons
  const subTabs=[
    {id:"put-list",label:"Put List",icon:"📥"},
    {id:"nel",label:"NEL",icon:"🚫"},
    {id:"pipeline",label:"Pipeline",icon:"🌊"},
    {id:"recommendations",label:"Recommendations",icon:"📋"},
    {id:"catchup",label:"Catch-Up",icon:"📈"},
    {id:"trend",label:"8hr Trend",icon:"📊"},
    {id:"history-analysis",label:"Flow History",icon:"🔥"},
    {id:"history",label:"Push History",icon:"📜"},
  ];

  if(loading)return(<div style={{textAlign:"center",padding:60,color:"#9ca3af",fontFamily:mono}}>Loading Flow Agent...</div>);
  if(error)return(<div style={{textAlign:"center",padding:60,color:"#ef4444",fontFamily:mono}}>Flow Agent Error: {error}</div>);

  const stages=snapshot?.stages||[];
  const ovenETAs=snapshot?.ovenETAs||[];
  const pacing=snapshot?.slaPacing||{};

  return(
    <div>
      {/* HEADER */}
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:18}}>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          <span style={{fontSize:28}}>🌊</span>
          <div>
            <h2 style={{margin:0,fontFamily:"'Bebas Neue',sans-serif",fontSize:28,letterSpacing:1,color:"#e5e7eb"}}>Flow Agent</h2>
            <span style={{fontSize:11,color:"#6b7280",fontFamily:mono}}>Work Release Control — Pipeline Wave Model</span>
          </div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:12}}>
          {health&&<span style={{fontSize:11,fontFamily:mono,color:health.running?"#22c55e":"#ef4444"}}>{health.running?"RUNNING":"STOPPED"} · Poll #{health.pollCount} · {health.lastPollMs}ms</span>}
          <button onClick={()=>setShowConfig(!showConfig)} style={{background:"rgba(255,255,255,0.06)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:6,padding:"6px 12px",color:"#9ca3af",cursor:"pointer",fontSize:12}}>⚙ Config</button>
        </div>
      </div>

      {/* SUB-TAB NAV */}
      <div style={{display:"flex",gap:4,marginBottom:16,borderBottom:"1px solid rgba(255,255,255,0.06)",paddingBottom:8}}>
        {subTabs.map(t=>(
          <button key={t.id} onClick={()=>setSubTab(t.id)} style={{background:subTab===t.id?"rgba(59,130,246,0.15)":"transparent",border:subTab===t.id?"1px solid rgba(59,130,246,0.3)":"1px solid transparent",borderRadius:6,padding:"6px 14px",color:subTab===t.id?"#60a5fa":"#9ca3af",cursor:"pointer",fontFamily:mono,fontSize:12,display:"flex",alignItems:"center",gap:6}}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>

      {/* ═══════ PUT LIST VIEW ═══════ */}
      {subTab==="put-list"&&(()=>{
        if(!putList){
          fetch(`${base}/api/flow/put-list`).then(r=>r.json()).then(d=>{
            if(d&&!d.error)setPutList(d); else setPutList({error:d?.error||'No data',summary:{},warehouses:[]});
          }).catch(()=>setPutList({error:'Server not responding',summary:{},warehouses:[]}));
          return <div style={{textAlign:"center",padding:40,color:"#6b7280",fontFamily:mono}}>Loading put list...</div>;
        }
        if(putList.error) return <div style={{textAlign:"center",padding:40}}><div style={{color:"#ef4444",fontSize:13,fontFamily:mono,marginBottom:12}}>{putList.error}</div><button onClick={()=>setPutList(null)} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:6,padding:"6px 16px",color:"#60a5fa",fontSize:11,cursor:"pointer",fontFamily:mono}}>Retry</button></div>;
        const sm=putList.summary||{};
        const whs=putList.warehouses||[];
        const whColors={WH1:"#3b82f6",WH2:"#a855f7"};
        return(
        <div>
          {/* DVI sending discontinued OPCs alert */}
          {(putList.dviDiscontinuedAlerts||[]).length>0&&(
            <div style={{background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:8,padding:"10px 14px",marginBottom:16,fontFamily:mono}}>
              <div style={{fontSize:11,fontWeight:700,color:"#ef4444",marginBottom:6}}>DVI ROUTING TO DISCONTINUED OPCs — UPDATE DVI LENS TABLE</div>
              {putList.dviDiscontinuedAlerts.map((a,i)=>(
                <div key={i} style={{fontSize:10,color:"#d1d5db",padding:"2px 0"}}>
                  <span style={{color:"#ef4444",fontWeight:700}}>{a.opc}</span>
                  <span style={{color:"#6b7280"}}> — {a.coating} {a.material} — </span>
                  <span style={{color:"#f59e0b"}}>{a.jobCount} active jobs using this OPC</span>
                </div>
              ))}
            </div>
          )}

          {/* Summary KPIs */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(7,1fr)",gap:8,marginBottom:16}}>
            {[
              {label:"Demand Jobs",value:sm.totalDemandJobs||0,color:"#e5e7eb"},
              {label:"Lenses Needed",value:sm.totalLensesNeeded||0,color:"#f59e0b"},
              {label:"In Stock",value:sm.totalInStock||0,color:"#22c55e"},
              {label:"Shortfall (PUT)",value:sm.totalShortfall||0,color:sm.totalShortfall>0?"#ef4444":"#22c55e"},
              {label:"Out of Stock",value:sm.outOfStockJobs||0,color:(sm.outOfStockJobs||0)>0?"#ef4444":"#22c55e",sub:`${sm.outOfStockCount||0} OPCs — reorder`},
              {label:"WH1 Jobs",value:sm.wh1Jobs||0,color:"#3b82f6"},
              {label:"WH2 Jobs",value:sm.wh2Jobs||0,color:"#a855f7"},
            ].map((k,i)=>(
              <div key={i} style={{background:"rgba(0,0,0,0.2)",borderRadius:6,padding:10,textAlign:"center"}}>
                <div style={{fontSize:9,color:"#6b7280",fontFamily:mono,marginBottom:2}}>{k.label}</div>
                <div style={{fontSize:20,fontWeight:700,color:k.color,fontFamily:mono}}>{(k.value||0).toLocaleString()}</div>
                {k.sub&&<div style={{fontSize:8,color:"#6b7280",fontFamily:mono,marginTop:1}}>{k.sub}</div>}
              </div>
            ))}
          </div>

          {/* Fulfillment + time */}
          <div style={{background:"rgba(0,0,0,0.2)",borderRadius:8,padding:12,marginBottom:16}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:4}}>
              <span>Fulfillment: {sm.fulfillablePct||0}%</span>
              <span>Est. {putList.totalEstimatedHours||0}h total — alternate WH1/WH2 to go faster</span>
            </div>
            <div style={{height:8,background:"rgba(255,255,255,0.06)",borderRadius:4,overflow:"hidden"}}>
              <div style={{height:"100%",width:`${sm.fulfillablePct||0}%`,background:sm.fulfillablePct>=90?"#22c55e":sm.fulfillablePct>=70?"#f59e0b":"#ef4444",borderRadius:4}}/>
            </div>
          </div>

          {/* Per-warehouse plans side by side */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16,marginBottom:16}}>
            {whs.map(wh=>{
              const color=whColors[wh.warehouse]||"#6b7280";
              return(
              <div key={wh.warehouse} style={{background:"rgba(0,0,0,0.15)",borderRadius:10,border:`2px solid ${color}30`,overflow:"hidden"}}>
                {/* Warehouse header */}
                <div style={{background:`${color}15`,padding:"12px 14px",borderBottom:`1px solid ${color}20`}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <div style={{fontSize:14,fontWeight:800,color:color,fontFamily:mono}}>{wh.warehouse}</div>
                      <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>Carousels {wh.carousels} — {wh.putWall}</div>
                    </div>
                    <div style={{textAlign:"right"}}>
                      <div style={{fontSize:20,fontWeight:800,color:"#e5e7eb",fontFamily:mono}}>{wh.totalJobs}</div>
                      <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>jobs ({wh.wallLoads} wall load{wh.wallLoads>1?"s":""})</div>
                    </div>
                  </div>
                  <div style={{display:"flex",gap:12,marginTop:8,fontSize:10,fontFamily:mono}}>
                    <span style={{color:"#3b82f6"}}>SV: {wh.svJobs}</span>
                    <span style={{color:"#a855f7"}}>Surf: {wh.surfJobs}</span>
                    {wh.rushJobs>0&&<span style={{color:"#ef4444"}}>Rush: {wh.rushJobs}</span>}
                    {wh.nelJobs>0&&<span style={{color:"#ef4444"}}>NEL: {wh.nelJobs}</span>}
                    {wh.totalPutLenses>0&&<span style={{color:"#f59e0b"}}>Put: {wh.totalPutLenses} lenses</span>}
                  </div>
                </div>

                {/* Put items + out of stock for this warehouse */}
                {(wh.putItems.length>0||(putList.outOfStock||[]).length>0)&&(
                  <div style={{padding:"8px 14px",borderBottom:"1px solid rgba(255,255,255,0.05)"}}>
                    {wh.putItems.length>0&&<div style={{fontSize:9,color:"#ef4444",fontFamily:mono,fontWeight:700,letterSpacing:1,marginBottom:4}}>LENSES TO PUT AWAY</div>}
                    {wh.putItems.slice(0,15).map((p,i)=>(
                      <div key={i} style={{display:"flex",justifyContent:"space-between",fontSize:10,fontFamily:mono,padding:"3px 0",color:"#d1d5db",borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
                        <span>{p.coating} — {p.opc}</span>
                        <span style={{color:"#ef4444",fontWeight:700}}>{p.putQty} lenses</span>
                      </div>
                    ))}
                    {/* Out of stock items that can't be put */}
                    {(()=>{
                      const whOos=putList.outOfStock||[];
                      if(whOos.length===0)return null;
                      return(<>
                        <div style={{fontSize:9,color:"#ef4444",fontFamily:mono,fontWeight:700,letterSpacing:1,marginTop:8,marginBottom:4}}>OUT OF STOCK — CANNOT PUT</div>
                        {whOos.slice(0,10).map((oos,i)=>(
                          <div key={`oos-${i}`} style={{display:"flex",gap:8,alignItems:"center",fontSize:10,fontFamily:mono,padding:"4px 0",borderBottom:"1px solid rgba(239,68,68,0.1)",background:"rgba(239,68,68,0.04)",borderRadius:3,paddingLeft:4,marginBottom:2}}>
                            <span style={{color:"#ef4444",fontWeight:700,minWidth:14}}>!</span>
                            <span style={{color:"#e5e7eb",minWidth:90}}>{oos.opc}</span>
                            <span style={{color:"#9ca3af"}}>{oos.coating} {oos.material}</span>
                            <span style={{color:"#f59e0b"}}>{oos.jobCount}j / {oos.lensesNeeded}L</span>
                            {oos.rushCount>0&&<span style={{color:"#ef4444",fontWeight:700}}>RUSH</span>}
                            <span style={{flex:1,textAlign:"right",fontSize:9,fontWeight:600,color:oos.canSubstitute?"#22c55e":"#f59e0b"}}>
                              {oos.canSubstitute&&oos.alternatives?.length>0?`USE ${oos.alternatives[0].sku} (${oos.alternatives[0].qty})`:oos.canSubstitute?'FIND ALT BASE':'REORDER'}
                            </span>
                          </div>
                        ))}
                      </>);
                    })()}
                  </div>
                )}

                {/* Demand by coating (expandable) */}
                <div style={{padding:"8px 14px"}}>
                  <button onClick={()=>setPutListExpanded(putListExpanded===wh.warehouse?null:wh.warehouse)} style={{width:"100%",background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:4,padding:"6px 10px",color:"#9ca3af",fontSize:10,cursor:"pointer",fontFamily:mono,textAlign:"left"}}>
                    {putListExpanded===wh.warehouse?"Hide":"Show"} demand by coating ({wh.byCoating?.length||0} types) {putListExpanded===wh.warehouse?"▲":"▼"}
                  </button>
                  {putListExpanded===wh.warehouse&&(
                    <div style={{marginTop:6,maxHeight:250,overflowY:"auto"}}>
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:mono}}>
                        <thead><tr>
                          <th style={{padding:"3px 6px",textAlign:"left",color:"#6b7280",fontSize:8}}>COATING</th>
                          <th style={{padding:"3px 6px",textAlign:"left",color:"#6b7280",fontSize:8}}>MATERIAL</th>
                          <th style={{padding:"3px 6px",textAlign:"right",color:"#6b7280",fontSize:8}}>JOBS</th>
                          <th style={{padding:"3px 6px",textAlign:"right",color:"#6b7280",fontSize:8}}>LENSES</th>
                          <th style={{padding:"3px 6px",textAlign:"center",color:"#6b7280",fontSize:8}}>RUSH</th>
                        </tr></thead>
                        <tbody>{(wh.byCoating||[]).map((c,i)=>(
                          <tr key={i} style={{borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
                            <td style={{padding:"3px 6px",color:"#e5e7eb"}}>{c.coating}</td>
                            <td style={{padding:"3px 6px",color:"#9ca3af"}}>{c.material}</td>
                            <td style={{padding:"3px 6px",textAlign:"right",color:"#e5e7eb"}}>{c.jobs}</td>
                            <td style={{padding:"3px 6px",textAlign:"right",color:"#f59e0b"}}>{c.lenses}</td>
                            <td style={{padding:"3px 6px",textAlign:"center",color:c.rush?"#ef4444":"#6b7280"}}>{c.rush||""}</td>
                          </tr>
                        ))}</tbody>
                      </table>
                    </div>
                  )}
                </div>

                {/* Cycles for this warehouse */}
                {wh.cycles?.length>0&&(
                  <div style={{padding:"8px 14px",borderTop:"1px solid rgba(255,255,255,0.05)"}}>
                    <div style={{fontSize:9,color:color,fontFamily:mono,fontWeight:700,letterSpacing:1,marginBottom:6}}>PUT-THEN-PICK CYCLES ({wh.cycles.length})</div>
                    {wh.cycles.map(c=>(
                      <div key={c.cycle} style={{display:"flex",gap:8,marginBottom:6,fontSize:10,fontFamily:mono}}>
                        <div style={{minWidth:24,color:color,fontWeight:700}}>#{c.cycle}</div>
                        <div style={{flex:1}}>
                          {c.putPhase.totalLenses>0&&<div style={{color:"#ef4444"}}>PUT {c.putPhase.totalLenses} lenses ({c.putPhase.estimatedMinutes}m){c.putPhase.items.map(p=>` ${p.coating}`).join(',')}</div>}
                          <div style={{color:"#22c55e"}}>PICK {c.pickPhase.jobs} jobs ({c.pickPhase.estimatedMinutes}m){c.pickPhase.rushCount>0?` [${c.pickPhase.rushCount} rush]`:""}</div>
                        </div>
                        <div style={{color:"#6b7280",minWidth:40,textAlign:"right"}}>{c.totalMinutes}m</div>
                      </div>
                    ))}
                    <div style={{fontSize:9,color:"#6b7280",fontFamily:mono,marginTop:4}}>~{Math.round(wh.totalMinutes/60*10)/10}h total for {wh.warehouse}</div>
                  </div>
                )}
              </div>);
            })}
          </div>

          {/* Actions */}
          <div style={{display:"flex",justifyContent:"center",gap:12}}>
            <button onClick={()=>window.open(`${base}/api/flow/put-list/report`,'_blank')} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:6,padding:"6px 16px",color:"#60a5fa",fontSize:11,cursor:"pointer",fontFamily:mono}}>Export CSV</button>
            <button onClick={()=>{setPutList(null);fetch(`${base}/api/flow/put-list`).then(r=>r.json()).then(setPutList).catch(()=>{});}} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:6,padding:"6px 16px",color:"#9ca3af",fontSize:11,cursor:"pointer",fontFamily:mono}}>Refresh</button>
          </div>
        </div>);
      })()}

      {/* ═══════ NEL VIEW ═══════ */}
      {subTab==="nel"&&(()=>{
        if(!nelData){
          fetch(`${base}/api/flow/nel`).then(r=>r.json()).then(d=>setNelData(d&&!d.error?d:{error:d?.error,total:0,jobs:[]})).catch(()=>setNelData({error:'Failed to load',total:0,jobs:[]}));
          return <div style={{textAlign:"center",padding:40,color:"#6b7280",fontFamily:mono}}>Loading NEL analysis...</div>;
        }
        if(nelData.error)return <div style={{textAlign:"center",padding:40}}><div style={{color:"#ef4444",fontSize:13,fontFamily:mono,marginBottom:12}}>{nelData.error}</div><button onClick={()=>setNelData(null)} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:6,padding:"6px 16px",color:"#60a5fa",fontSize:11,cursor:"pointer",fontFamily:mono}}>Retry</button></div>;
        const jobs=nelData.jobs||[];
        return(
        <div>
          {/* KPIs */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:10,marginBottom:16}}>
            {[
              {label:"Total NEL",value:nelData.total,color:"#ef4444"},
              {label:"Surfacing (can change)",value:nelData.surfCount,color:"#a855f7"},
              {label:"SV (must reorder)",value:nelData.svCount,color:"#3b82f6"},
              {label:"With Alternatives",value:nelData.withAlternatives,color:"#22c55e"},
              {label:"Rush",value:nelData.rushCount,color:nelData.rushCount>0?"#ef4444":"#6b7280"},
            ].map((k,i)=>(
              <div key={i} style={{background:"rgba(0,0,0,0.2)",borderRadius:6,padding:10,textAlign:"center"}}>
                <div style={{fontSize:9,color:"#6b7280",fontFamily:mono,marginBottom:2}}>{k.label}</div>
                <div style={{fontSize:20,fontWeight:700,color:k.color,fontFamily:mono}}>{(k.value||0).toLocaleString()}</div>
              </div>
            ))}
          </div>

          {/* Actions */}
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            <button onClick={()=>window.open(`${base}/api/flow/nel/export`,'_blank')} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:6,padding:"6px 16px",color:"#60a5fa",fontSize:11,cursor:"pointer",fontFamily:mono}}>Export CSV for DVI Changes</button>
            <button onClick={()=>setNelData(null)} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:6,padding:"6px 16px",color:"#9ca3af",fontSize:11,cursor:"pointer",fontFamily:mono}}>Refresh</button>
          </div>

          {/* Job list */}
          <div style={{background:"rgba(0,0,0,0.15)",borderRadius:10,overflow:"hidden"}}>
            <table style={{width:"100%",borderCollapse:"collapse",fontSize:11,fontFamily:mono}}>
              <thead>
                <tr style={{background:"rgba(0,0,0,0.3)"}}>
                  <th style={{padding:"8px 10px",textAlign:"left",color:"#6b7280",fontSize:9}}>JOB</th>
                  <th style={{padding:"8px 10px",textAlign:"left",color:"#6b7280",fontSize:9}}>OPC</th>
                  <th style={{padding:"8px 10px",textAlign:"left",color:"#6b7280",fontSize:9}}>COATING</th>
                  <th style={{padding:"8px 10px",textAlign:"left",color:"#6b7280",fontSize:9}}>MATERIAL</th>
                  <th style={{padding:"8px 10px",textAlign:"left",color:"#6b7280",fontSize:9}}>TYPE</th>
                  <th style={{padding:"8px 10px",textAlign:"right",color:"#6b7280",fontSize:9}}>DAYS</th>
                  <th style={{padding:"8px 10px",textAlign:"left",color:"#22c55e",fontSize:9}}>ACTION</th>
                </tr>
              </thead>
              <tbody>
                {jobs.slice(0,200).map((j,i)=>(
                  <tr key={i} style={{borderBottom:"1px solid rgba(255,255,255,0.04)",background:j.rush?"rgba(239,68,68,0.06)":j.isSurfacing&&j.alternatives?.length>0?"rgba(34,197,94,0.04)":"transparent"}}>
                    <td style={{padding:"6px 10px",color:"#e5e7eb",fontWeight:600}}>{j.jobId}{j.rush&&<span style={{color:"#ef4444",marginLeft:6,fontSize:9,fontWeight:700}}>RUSH</span>}</td>
                    <td style={{padding:"6px 10px",color:"#9ca3af"}}>{j.opc||'—'}</td>
                    <td style={{padding:"6px 10px",color:"#f59e0b"}}>{j.coating}</td>
                    <td style={{padding:"6px 10px",color:"#9ca3af"}}>{j.material}</td>
                    <td style={{padding:"6px 10px",color:j.isSurfacing?"#a855f7":"#3b82f6"}}>{j.isSurfacing?'SURF':'SV'}</td>
                    <td style={{padding:"6px 10px",textAlign:"right",color:j.daysInLab>3?"#ef4444":j.daysInLab>1?"#f59e0b":"#6b7280"}}>{Math.round(j.daysInLab*10)/10}d</td>
                    <td style={{padding:"6px 10px",fontSize:10,fontWeight:600,color:j.alternatives?.length>0?"#22c55e":j.isSurfacing?"#f59e0b":"#6b7280"}}>{j.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {jobs.length===0&&<div style={{padding:20,textAlign:"center",color:"#6b7280",fontFamily:mono}}>No NEL jobs</div>}
            {jobs.length>200&&<div style={{padding:10,textAlign:"center",color:"#6b7280",fontFamily:mono,fontSize:10}}>Showing 200 of {jobs.length} — export CSV for full list</div>}
          </div>
        </div>);
      })()}

      {/* ═══════ PIPELINE VIEW ═══════ */}
      {subTab==="pipeline"&&(
        <div>
          {/* Readiness dashboard — what can we process NOW */}
          {(()=>{
            if(!readiness) fetch(`${base}/api/flow/readiness`).then(r=>r.ok?r.json():null).then(setReadiness).catch(()=>{});
            const r=readiness;
            if(!r||!r.totalWip)return null;
            const greenPct=r.totalWip>0?Math.round(((r.inProcess+r.readyToProcess)/r.totalWip)*100):0;
            const amberPct=r.totalWip>0?Math.round((r.needAlternative/r.totalWip)*100):0;
            const redPct=r.totalWip>0?Math.round((r.trueOutOfStock/r.totalWip)*100):0;
            return(
            <div style={{background:"rgba(0,0,0,0.2)",borderRadius:10,padding:16,marginBottom:16}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:"#e5e7eb",letterSpacing:1}}>WIP READINESS — {r.totalWip.toLocaleString()} JOBS</div>
                <button onClick={()=>{setReadiness(null);fetch(`${base}/api/flow/readiness`).then(x=>x.json()).then(setReadiness).catch(()=>{});}} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:4,padding:"3px 10px",color:"#6b7280",fontSize:9,cursor:"pointer",fontFamily:mono}}>Refresh</button>
              </div>
              {/* Stacked bar */}
              <div style={{height:12,background:"rgba(255,255,255,0.06)",borderRadius:6,overflow:"hidden",display:"flex",marginBottom:10}}>
                <div style={{width:`${greenPct}%`,background:"#22c55e",transition:"width 0.3s"}} title={`In process + ready: ${r.inProcess+r.readyToProcess}`}/>
                <div style={{width:`${amberPct}%`,background:"#f59e0b",transition:"width 0.3s"}} title={`Need alternative: ${r.needAlternative}`}/>
                <div style={{width:`${redPct}%`,background:"#ef4444",transition:"width 0.3s"}} title={`True out of stock: ${r.trueOutOfStock}`}/>
              </div>
              {/* Numbers */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(5,1fr)",gap:8}}>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:20,fontWeight:800,color:"#22c55e",fontFamily:mono}}>{(r.inProcess||0).toLocaleString()}</div>
                  <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>IN PROCESS</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:20,fontWeight:800,color:"#22c55e",fontFamily:mono}}>{(r.readyToProcess||0).toLocaleString()}</div>
                  <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>READY TO PUSH</div>
                  <div style={{fontSize:8,color:"#6b7280",fontFamily:mono}}>SV:{r.readyJobs?.sv||0} Surf:{r.readyJobs?.surf||0}</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:20,fontWeight:800,color:"#f59e0b",fontFamily:mono}}>{(r.needAlternative||0).toLocaleString()}</div>
                  <div style={{fontSize:9,color:"#f59e0b",fontFamily:mono}}>NEED ALT BASE</div>
                  <div style={{fontSize:8,color:"#6b7280",fontFamily:mono}}>change base → go</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:20,fontWeight:800,color:"#ef4444",fontFamily:mono}}>{(r.trueOutOfStock||0).toLocaleString()}</div>
                  <div style={{fontSize:9,color:"#ef4444",fontFamily:mono}}>OUT OF STOCK</div>
                  <div style={{fontSize:8,color:"#6b7280",fontFamily:mono}}>{r.reorderList?.length||0} OPCs need reorder</div>
                </div>
                <div style={{textAlign:"center"}}>
                  <div style={{fontSize:20,fontWeight:800,color:r.rushBlocked>0?"#ef4444":"#6b7280",fontFamily:mono}}>{r.rushBlocked||0}</div>
                  <div style={{fontSize:9,color:r.rushBlocked>0?"#ef4444":"#6b7280",fontFamily:mono}}>RUSH BLOCKED</div>
                </div>
              </div>
              {/* Processable summary */}
              <div style={{marginTop:10,padding:"8px 12px",background:"rgba(34,197,94,0.08)",borderRadius:6,border:"1px solid rgba(34,197,94,0.15)",textAlign:"center",fontFamily:mono}}>
                <span style={{fontSize:12,color:"#22c55e",fontWeight:700}}>{r.processablePct}% PROCESSABLE NOW</span>
                <span style={{fontSize:11,color:"#9ca3af",marginLeft:12}}>({r.processableNow.toLocaleString()} of {r.totalWip.toLocaleString()} jobs can move)</span>
                {r.needAlternative>0&&<span style={{fontSize:11,color:"#f59e0b",marginLeft:12}}>+{r.needAlternative} if bases changed</span>}
              </div>
              {/* SV vs Surfacing breakdown */}
              {r.sv&&r.surfacing&&(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}>
                  {[{label:"SINGLE VISION",data:r.sv,color:"#3b82f6"},{label:"SURFACING",data:r.surfacing,color:"#a855f7"}].map(line=>{
                    const d=line.data;
                    const greenPct=d.total>0?Math.round(((d.inProcess+d.readyToProcess)/d.total)*100):0;
                    const amberPct=d.total>0?Math.round((d.needAlternative/d.total)*100):0;
                    const redPct=d.total>0?Math.round((d.trueOutOfStock/d.total)*100):0;
                    return(
                    <div key={line.label} style={{background:"rgba(0,0,0,0.15)",borderRadius:8,padding:12,borderLeft:`3px solid ${line.color}`}}>
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
                        <span style={{fontSize:11,fontWeight:700,color:line.color,fontFamily:mono}}>{line.label}</span>
                        <span style={{fontSize:11,fontWeight:700,color:"#e5e7eb",fontFamily:mono}}>{d.total.toLocaleString()} jobs</span>
                      </div>
                      <div style={{height:6,background:"rgba(255,255,255,0.06)",borderRadius:3,overflow:"hidden",display:"flex",marginBottom:8}}>
                        <div style={{width:`${greenPct}%`,background:"#22c55e"}}/>
                        <div style={{width:`${amberPct}%`,background:"#f59e0b"}}/>
                        <div style={{width:`${redPct}%`,background:"#ef4444"}}/>
                      </div>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4,fontSize:10,fontFamily:mono}}>
                        <div style={{textAlign:"center"}}><div style={{fontSize:14,fontWeight:700,color:"#22c55e"}}>{d.inProcess}</div><div style={{fontSize:7,color:"#6b7280"}}>IN PROC</div></div>
                        <div style={{textAlign:"center"}}><div style={{fontSize:14,fontWeight:700,color:"#22c55e"}}>{d.readyToProcess}</div><div style={{fontSize:7,color:"#6b7280"}}>READY</div></div>
                        <div style={{textAlign:"center"}}><div style={{fontSize:14,fontWeight:700,color:"#f59e0b"}}>{d.needAlternative}</div><div style={{fontSize:7,color:"#6b7280"}}>ALT BASE</div></div>
                        <div style={{textAlign:"center"}}><div style={{fontSize:14,fontWeight:700,color:"#ef4444"}}>{d.trueOutOfStock}</div><div style={{fontSize:7,color:"#6b7280"}}>OOS</div></div>
                      </div>
                      <div style={{marginTop:6,textAlign:"center",fontSize:10,color:line.color,fontFamily:mono,fontWeight:700}}>{d.processablePct}% processable{d.rushBlocked>0?` — ${d.rushBlocked} rush blocked`:''}</div>
                    </div>);
                  })}
                </div>
              )}
            </div>);
          })()}

          {/* Recommendation banner */}
          {recommendations.length>0&&(
            <div style={{background:"rgba(245,158,11,0.08)",border:"1px solid rgba(245,158,11,0.25)",borderRadius:10,padding:16,marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:"#f59e0b",marginBottom:8,letterSpacing:1}}>PUSH RECOMMENDATIONS</div>
              {recommendations.map(r=>(
                <div key={r.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"8px 0",borderBottom:"1px solid rgba(255,255,255,0.04)"}}>
                  <div style={{flex:1}}>
                    <span style={{fontFamily:mono,fontSize:13,color:r.urgency==="now"?"#ef4444":"#f59e0b",fontWeight:700}}>
                      {r.urgency==="now"?"PUSH NOW":"PUSH BY "+r.push_by}:
                    </span>
                    <span style={{fontFamily:mono,fontSize:13,color:"#e5e7eb",marginLeft:8}}>
                      {r.push_qty} {r.line_id.toUpperCase()} jobs
                    </span>
                    <div style={{fontSize:11,color:"#9ca3af",fontFamily:mono,marginTop:2}}>{r.reason}</div>
                    {r.constrained_by&&r.constrained_by!=="none"&&(
                      <span style={{fontSize:10,color:"#ef4444",fontFamily:mono}}>⚠ Constrained: {r.constrained_by}</span>
                    )}
                  </div>
                  <div style={{display:"flex",gap:6}}>
                    <button onClick={()=>ackRec(r.id)} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:4,padding:"4px 10px",color:"#60a5fa",cursor:"pointer",fontSize:11,fontFamily:mono}}>ACK</button>
                    <button onClick={()=>completeRec(r.id)} style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:4,padding:"4px 10px",color:"#22c55e",cursor:"pointer",fontSize:11,fontFamily:mono}}>DONE</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Pipeline diagram */}
          <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:20,marginBottom:16,overflowX:"auto"}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#6b7280",marginBottom:12,letterSpacing:1}}>SURFACING PATH</div>
            <div style={{display:"flex",alignItems:"center",gap:0,minWidth:900}}>
              {stages.filter(s=>["blocking","surfacing","detray","dip_coat","oven","coating"].includes(s.stage_id)).map((s,i,arr)=>(
                <div key={s.stage_id} style={{display:"flex",alignItems:"center",gap:0}}>
                  <div onClick={()=>setExpandedStage(expandedStage===s.stage_id?null:s.stage_id)} style={{background:statusBg(s.status),border:`1px solid ${statusColor(s.status)}40`,borderRadius:8,padding:"10px 14px",minWidth:120,cursor:"pointer",textAlign:"center",position:"relative"}}>
                    <div style={{fontFamily:mono,fontSize:11,color:"#9ca3af",marginBottom:4}}>{s.label}</div>
                    <div style={{fontFamily:mono,fontSize:22,fontWeight:700,color:statusColor(s.status)}}>{s.current_count}</div>
                    <div style={{fontFamily:mono,fontSize:10,color:"#6b7280",marginTop:2}}>
                      {s.drain_time_minutes!=null?`drains ${s.drain_time_minutes}m`:"—"}
                    </div>
                    <div style={{fontFamily:mono,fontSize:10,color:"#6b7280"}}>{s.completion_rate}/hr</div>
                    {s.gap_minutes!=null&&s.gap_minutes>0&&(
                      <div style={{position:"absolute",top:-8,right:-8,background:"#ef4444",borderRadius:10,padding:"1px 5px",fontSize:9,fontFamily:mono,color:"#fff"}}>gap {s.gap_minutes}m</div>
                    )}
                    {s.stage_id==="oven"&&ovenETAs.length>0&&(
                      <div style={{fontSize:9,fontFamily:mono,color:"#a78bfa",marginTop:2}}>next batch {ovenETAs[0].etaTime}</div>
                    )}
                  </div>
                  {i<arr.length-1&&<div style={{width:24,height:2,background:"rgba(255,255,255,0.15)",flexShrink:0}}/>}
                </div>
              ))}
            </div>

            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#6b7280",marginTop:20,marginBottom:12,letterSpacing:1}}>SHARED STAGES (SV + SURFACING CONVERGE)</div>
            <div style={{display:"flex",alignItems:"center",gap:0}}>
              {stages.filter(s=>["cutting","assembly"].includes(s.stage_id)).map((s,i,arr)=>(
                <div key={s.stage_id} style={{display:"flex",alignItems:"center",gap:0}}>
                  <div onClick={()=>setExpandedStage(expandedStage===s.stage_id?null:s.stage_id)} style={{background:statusBg(s.status),border:`1px solid ${statusColor(s.status)}40`,borderRadius:8,padding:"10px 14px",minWidth:160,cursor:"pointer",textAlign:"center",position:"relative"}}>
                    <div style={{fontFamily:mono,fontSize:11,color:"#9ca3af",marginBottom:4}}>{s.label}</div>
                    <div style={{display:"flex",justifyContent:"center",gap:16}}>
                      <div>
                        <div style={{fontSize:9,color:"#60a5fa",fontFamily:mono}}>SV</div>
                        <div style={{fontFamily:mono,fontSize:18,fontWeight:700,color:"#60a5fa"}}>{s.by_line?.sv||0}</div>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#a78bfa",fontFamily:mono}}>SURF</div>
                        <div style={{fontFamily:mono,fontSize:18,fontWeight:700,color:"#a78bfa"}}>{s.by_line?.surfacing||0}</div>
                      </div>
                      <div>
                        <div style={{fontSize:9,color:"#9ca3af",fontFamily:mono}}>TOTAL</div>
                        <div style={{fontFamily:mono,fontSize:18,fontWeight:700,color:statusColor(s.status)}}>{s.current_count}</div>
                      </div>
                    </div>
                    <div style={{fontFamily:mono,fontSize:10,color:"#6b7280",marginTop:4}}>
                      {s.drain_time_minutes!=null?`drains ${s.drain_time_minutes}m`:"—"} · {s.completion_rate}/hr
                    </div>
                    {s.gap_minutes!=null&&s.gap_minutes>0&&(
                      <div style={{position:"absolute",top:-8,right:-8,background:"#ef4444",borderRadius:10,padding:"1px 5px",fontSize:9,fontFamily:mono,color:"#fff"}}>gap {s.gap_minutes}m</div>
                    )}
                  </div>
                  {i<arr.length-1&&<div style={{width:24,height:2,background:"rgba(255,255,255,0.15)",flexShrink:0}}/>}
                </div>
              ))}
            </div>
          </div>

          {/* Expanded stage detail */}
          {expandedStage&&(()=>{
            const s=stages.find(s=>s.stage_id===expandedStage);
            if(!s)return null;
            // Build flow chain: find what feeds this stage and what it feeds
            const stageOrder=["blocking","surfacing","detray","dip_coat","oven","coating","cutting","assembly"];
            const idx=stageOrder.indexOf(s.stage_id);
            const upstream=idx>0?stages.find(x=>x.stage_id===stageOrder[idx-1]):null;
            const downstream=idx<stageOrder.length-1?stages.find(x=>x.stage_id===stageOrder[idx+1]):null;
            // For cutting: also gets fed by SV (not just coating)
            const isCutting=s.stage_id==="cutting";
            const isAssembly=s.stage_id==="assembly";
            return(
              <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:10,padding:16,marginBottom:16}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#e5e7eb",letterSpacing:1}}>{s.label} DETAIL</span>
                  <button onClick={()=>setExpandedStage(null)} style={{background:"none",border:"none",color:"#6b7280",cursor:"pointer",fontSize:14}}>✕</button>
                </div>

                {/* Flow between stages */}
                <div style={{background:"rgba(0,0,0,0.15)",borderRadius:8,padding:14,marginBottom:12}}>
                  <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:8,letterSpacing:1}}>JOBS FLOWING BETWEEN STAGES</div>
                  <div style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8,flexWrap:"wrap"}}>
                    {upstream&&(
                      <div style={{textAlign:"center",padding:"8px 14px",background:"rgba(167,139,250,0.08)",border:"1px solid rgba(167,139,250,0.2)",borderRadius:6}}>
                        <div style={{fontSize:9,color:"#a78bfa",fontFamily:mono}}>{upstream.label}</div>
                        <div style={{fontSize:20,fontWeight:700,color:"#a78bfa",fontFamily:mono}}>{upstream.current_count}</div>
                        <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>{upstream.completion_rate}/hr out</div>
                      </div>
                    )}
                    {upstream&&<div style={{fontSize:18,color:"#6b7280"}}>→</div>}
                    <div style={{textAlign:"center",padding:"10px 18px",background:statusBg(s.status),border:`2px solid ${statusColor(s.status)}`,borderRadius:8}}>
                      <div style={{fontSize:9,color:statusColor(s.status),fontFamily:mono,fontWeight:700}}>{s.label}</div>
                      <div style={{fontSize:24,fontWeight:700,color:statusColor(s.status),fontFamily:mono}}>{s.current_count}</div>
                      <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>{s.completion_rate}/hr through</div>
                    </div>
                    {downstream&&<div style={{fontSize:18,color:"#6b7280"}}>→</div>}
                    {downstream&&(
                      <div style={{textAlign:"center",padding:"8px 14px",background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.2)",borderRadius:6}}>
                        <div style={{fontSize:9,color:"#22c55e",fontFamily:mono}}>{downstream.label}</div>
                        <div style={{fontSize:20,fontWeight:700,color:"#22c55e",fontFamily:mono}}>{downstream.current_count}</div>
                        <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>waiting</div>
                      </div>
                    )}
                  </div>
                  {/* Summary: how many need to move */}
                  <div style={{display:"flex",gap:16,justifyContent:"center",marginTop:10,flexWrap:"wrap"}}>
                    {upstream&&(
                      <div style={{fontSize:11,fontFamily:mono,color:"#e5e7eb"}}>
                        <span style={{color:"#a78bfa"}}>{upstream.current_count}</span> jobs in {upstream.label} → need to come out to {s.label}
                      </div>
                    )}
                    {downstream&&s.current_count>0&&(
                      <div style={{fontSize:11,fontFamily:mono,color:"#e5e7eb"}}>
                        <span style={{color:statusColor(s.status)}}>{s.current_count}</span> jobs in {s.label} → need to move to {downstream.label}
                      </div>
                    )}
                    {(isCutting||isAssembly)&&(
                      <div style={{fontSize:11,fontFamily:mono,color:"#e5e7eb"}}>
                        <span style={{color:"#60a5fa"}}>{s.by_line?.sv||0} SV</span> + <span style={{color:"#a78bfa"}}>{s.by_line?.surfacing||0} surfaced</span> = {s.current_count} total
                      </div>
                    )}
                  </div>
                </div>

                <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:12}}>
                  {[
                    {label:"Rate",value:`${s.completion_rate}/hr`,color:"#22c55e"},
                    {label:"Drain",value:s.drain_time_minutes!=null?`${s.drain_time_minutes}m`:"—",color:statusColor(s.status)},
                    {label:"Next Wave",value:s.next_wave_eta_minutes!=null?`${s.next_wave_eta_minutes}m`:"—",color:"#06b6d4"},
                    {label:"Gap",value:s.gap_minutes!=null?`${s.gap_minutes}m`:"—",color:s.gap_minutes>0?"#ef4444":"#22c55e"},
                    {label:"Machines Up",value:s.machines?.active||0,color:"#22c55e"},
                    {label:"Machines Down",value:s.machines?.down||0,color:s.machines?.down?"#ef4444":"#6b7280"},
                    {label:"No Demand",value:s.machines?.no_demand||0,color:s.machines?.no_demand?"#f59e0b":"#6b7280"},
                  ].map((m,i)=>(
                    <div key={i} style={{background:"rgba(0,0,0,0.2)",borderRadius:6,padding:10,textAlign:"center"}}>
                      <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>{m.label}</div>
                      <div style={{fontSize:16,fontWeight:700,color:m.color,fontFamily:mono}}>{m.value}</div>
                    </div>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* SLA Pacing cards */}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
            {[{key:"sv",label:"Single Vision",sla:"2-day SLA",color:"#60a5fa"},{key:"surfacing",label:"Surfacing",sla:"3-day SLA",color:"#a78bfa"}].map(l=>{
              const p=pacing[l.key]||{};
              return(
                <div key={l.key} style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:14}}>
                  <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:l.color,letterSpacing:1,marginBottom:6}}>{l.label} — {l.sla}</div>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(3,1fr)",gap:8}}>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>WIP</div>
                      <div style={{fontSize:18,fontWeight:700,color:"#e5e7eb",fontFamily:mono}}>{p.wip||0}</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>Target/hr</div>
                      <div style={{fontSize:18,fontWeight:700,color:l.color,fontFamily:mono}}>{p.hourlyTarget||0}</div>
                    </div>
                    <div style={{textAlign:"center"}}>
                      <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>At Risk</div>
                      <div style={{fontSize:18,fontWeight:700,color:p.atRiskCount?"#ef4444":"#22c55e",fontFamily:mono}}>{p.atRiskCount||0}</div>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Oven ETAs */}
          {ovenETAs.length>0&&(
            <div style={{background:"rgba(167,139,250,0.06)",border:"1px solid rgba(167,139,250,0.2)",borderRadius:10,padding:14,marginBottom:16}}>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#a78bfa",letterSpacing:1,marginBottom:8}}>OVEN BATCH ETAs</div>
              <div style={{display:"flex",gap:12,flexWrap:"wrap"}}>
                {ovenETAs.map((e,i)=>(
                  <div key={i} style={{background:"rgba(0,0,0,0.2)",borderRadius:6,padding:"8px 12px",fontFamily:mono,fontSize:12}}>
                    <span style={{color:"#a78bfa"}}>{e.ovenId} R{e.rackIndex}</span>
                    <span style={{color:"#6b7280",margin:"0 6px"}}>·</span>
                    <span style={{color:"#e5e7eb"}}>{e.jobs} jobs</span>
                    <span style={{color:"#6b7280",margin:"0 6px"}}>·</span>
                    <span style={{color:e.etaMinutes<30?"#22c55e":"#f59e0b"}}>{e.etaTime} ({Math.round(e.etaMinutes)}m)</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* ═══════ RECOMMENDATIONS VIEW ═══════ */}
      {subTab==="recommendations"&&(
        <div>
          {/* Manual push form */}
          <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:16,marginBottom:16}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#6b7280",letterSpacing:1,marginBottom:10}}>LOG MANUAL PUSH</div>
            <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"flex-end"}}>
              <div>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>Line</div>
                <select value={pushForm.line_id} onChange={e=>setPushForm(p=>({...p,line_id:e.target.value}))} style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:4,padding:"6px 10px",color:"#e5e7eb",fontFamily:mono,fontSize:12}}>
                  <option value="sv">SV</option>
                  <option value="surfacing">Surfacing</option>
                  <option value="edits">Edits</option>
                </select>
              </div>
              <div>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>Qty</div>
                <input type="number" value={pushForm.qty} onChange={e=>setPushForm(p=>({...p,qty:e.target.value}))} placeholder="20" style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:4,padding:"6px 10px",color:"#e5e7eb",fontFamily:mono,fontSize:12,width:60}}/>
              </div>
              <div>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>Operator</div>
                <input value={pushForm.operator} onChange={e=>setPushForm(p=>({...p,operator:e.target.value}))} placeholder="Name" style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:4,padding:"6px 10px",color:"#e5e7eb",fontFamily:mono,fontSize:12,width:100}}/>
              </div>
              <div style={{flex:1}}>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>Note</div>
                <input value={pushForm.note} onChange={e=>setPushForm(p=>({...p,note:e.target.value}))} placeholder="Optional note" style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:4,padding:"6px 10px",color:"#e5e7eb",fontFamily:mono,fontSize:12,width:"100%"}}/>
              </div>
              <button onClick={logPush} disabled={!pushForm.qty} style={{background:pushForm.qty?"rgba(34,197,94,0.15)":"rgba(255,255,255,0.04)",border:`1px solid ${pushForm.qty?"rgba(34,197,94,0.3)":"rgba(255,255,255,0.06)"}`,borderRadius:6,padding:"6px 16px",color:pushForm.qty?"#22c55e":"#6b7280",cursor:pushForm.qty?"pointer":"default",fontFamily:mono,fontSize:12}}>LOG PUSH</button>
            </div>
          </div>

          {/* Active recommendations */}
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#6b7280",letterSpacing:1,marginBottom:8}}>PENDING RECOMMENDATIONS ({recommendations.length})</div>
          {recommendations.length===0?(
            <div style={{textAlign:"center",padding:40,color:"#6b7280",fontFamily:mono,fontSize:13}}>No pending recommendations — pipeline is balanced</div>
          ):recommendations.map(r=>(
            <div key={r.id} style={{background:r.urgency==="now"?"rgba(239,68,68,0.06)":"rgba(245,158,11,0.06)",border:`1px solid ${r.urgency==="now"?"rgba(239,68,68,0.2)":"rgba(245,158,11,0.2)"}`,borderRadius:8,padding:14,marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <div>
                  <span style={{fontFamily:mono,fontSize:14,fontWeight:700,color:r.urgency==="now"?"#ef4444":"#f59e0b"}}>{r.urgency==="now"?"PUSH NOW":"PUSH BY "+r.push_by}</span>
                  <span style={{fontFamily:mono,fontSize:14,color:"#e5e7eb",marginLeft:10}}>{r.push_qty} {r.line_id.toUpperCase()} jobs</span>
                </div>
                <div style={{display:"flex",gap:6}}>
                  <button onClick={()=>ackRec(r.id)} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:4,padding:"4px 12px",color:"#60a5fa",cursor:"pointer",fontSize:11,fontFamily:mono}}>ACKNOWLEDGE</button>
                  <button onClick={()=>completeRec(r.id)} style={{background:"rgba(34,197,94,0.15)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:4,padding:"4px 12px",color:"#22c55e",cursor:"pointer",fontSize:11,fontFamily:mono}}>COMPLETE</button>
                </div>
              </div>
              <div style={{fontSize:12,color:"#9ca3af",fontFamily:mono,marginTop:4}}>{r.reason}</div>
              {r.constrained_by&&r.constrained_by!=="none"&&<div style={{fontSize:11,color:"#ef4444",fontFamily:mono,marginTop:2}}>Constraint: {r.constrained_by}</div>}
              <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginTop:4}}>Created {r.created_at}{r.expires_at&&` · Expires ${r.expires_at.split("T")[1]?.slice(0,5)||r.expires_at}`}</div>
            </div>
          ))}

          {/* Expired (archived) recommendations */}
          {expiredRecs.length>0&&(
            <div style={{marginTop:20}}>
              <button onClick={()=>setShowExpired(!showExpired)} style={{background:"none",border:"none",color:"#6b7280",cursor:"pointer",fontFamily:mono,fontSize:12,padding:0,marginBottom:8}}>
                {showExpired?"▼":"▶"} EXPIRED / UNACKNOWLEDGED ({expiredRecs.length})
              </button>
              {showExpired&&expiredRecs.map(r=>(
                <div key={r.id} style={{background:"rgba(107,114,128,0.06)",border:"1px solid rgba(107,114,128,0.15)",borderRadius:8,padding:12,marginBottom:6,opacity:0.6}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div>
                      <span style={{fontFamily:mono,fontSize:12,color:"#6b7280",textDecoration:"line-through"}}>{r.push_qty} {r.line_id.toUpperCase()} jobs — {r.push_by}</span>
                    </div>
                    <span style={{fontSize:10,fontFamily:mono,color:"#6b7280",background:"rgba(107,114,128,0.15)",borderRadius:4,padding:"2px 6px"}}>EXPIRED</span>
                  </div>
                  <div style={{fontSize:11,color:"#6b7280",fontFamily:mono,marginTop:2}}>{r.reason}</div>
                  <div style={{fontSize:10,color:"#4b5563",fontFamily:mono,marginTop:2}}>Created {r.created_at?.split("T")[1]?.slice(0,5)||""} · Expired {r.expires_at?.split("T")[1]?.slice(0,5)||""}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ═══════ CATCH-UP VIEW ═══════ */}
      {subTab==="catchup"&&(
        <div>

          {/* Live data banner */}
          {catchUp&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
              <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:14,textAlign:"center"}}>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>LIVE WIP</div>
                <div style={{fontSize:28,fontWeight:700,color:"#e5e7eb",fontFamily:mono}}>{catchUp.currentWip}</div>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>active jobs in {catchUp.label}</div>
              </div>
              <div style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.08)",borderRadius:8,padding:14,textAlign:"center"}}>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>LIVE INCOMING</div>
                <div style={{fontSize:28,fontWeight:700,color:"#f59e0b",fontFamily:mono}}>{catchUp.liveIncomingPerDay}</div>
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>est. jobs/day entering lab</div>
              </div>
            </div>
          )}

          {/* Scenario inputs */}
          <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:16,marginBottom:16}}>
            <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#6b7280",letterSpacing:1,marginBottom:10}}>SCENARIO INPUTS</div>
            <div style={{display:"flex",gap:12,flexWrap:"wrap",alignItems:"flex-end"}}>
              {[
                {key:"assemblers",label:"Assemblers",placeholder:String(catchUp?.assemblers??6),width:90},
                {key:"jobsPerAssemblerHr",label:"Jobs/Person/Hr",placeholder:String(catchUp?.jobsPerAssemblerHr??4),width:110},
                {key:"shiftHours",label:"Hrs/Shift",placeholder:String(catchUp?.shiftHours??8),width:80},
                {key:"shifts",label:"Shifts/Day",placeholder:String(catchUp?.shifts??2),width:80},
                {key:"incomingPerDay",label:"Incoming/Day",placeholder:String(catchUp?.incomingPerDay??0),width:100},
                {key:"targetBacklog",label:"Target Backlog",placeholder:String(catchUp?.targetBacklog??500),width:110},
                {key:"targetDays",label:"Clear in Days",placeholder:String(catchUp?.targetDays??2),width:100},
              ].map(f=>(
                <div key={f.key}>
                  <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>{f.label}</div>
                  <input type="number" step="any" value={catchUpScenario[f.key]} onChange={e=>setCatchUpScenario(p=>({...p,[f.key]:e.target.value}))} placeholder={f.placeholder} style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:4,padding:"6px 8px",color:"#e5e7eb",fontFamily:mono,fontSize:13,width:f.width}}/>
                </div>
              ))}
              <button onClick={loadCatchUp} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:6,padding:"6px 14px",color:"#60a5fa",cursor:"pointer",fontFamily:mono,fontSize:12}}>RECALC</button>
              <button onClick={()=>{setCatchUpScenario({assemblers:"",shiftHours:"",shifts:"",incomingPerDay:"",targetDays:"",jobsPerAssemblerHr:"",targetBacklog:"",workDays:null});}} style={{background:"rgba(255,255,255,0.04)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"6px 14px",color:"#9ca3af",cursor:"pointer",fontFamily:mono,fontSize:12}}>RESET</button>
            </div>
            {/* Work days toggle */}
            <div style={{display:"flex",alignItems:"center",gap:8,marginTop:12}}>
              <span style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>WORK DAYS:</span>
              {["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d,i)=>{
                const active=(catchUpScenario.workDays||catchUp?.workDays||[1,2,3,4,5]).includes(i);
                return <button key={i} onClick={()=>{
                  const current=catchUpScenario.workDays||catchUp?.workDays||[1,2,3,4,5];
                  const next=active?current.filter(x=>x!==i):[...current,i].sort();
                  setCatchUpScenario(p=>({...p,workDays:next}));
                }} style={{background:active?"rgba(59,130,246,0.2)":"rgba(255,255,255,0.03)",border:`1px solid ${active?"rgba(59,130,246,0.4)":"rgba(255,255,255,0.08)"}`,borderRadius:4,padding:"4px 8px",color:active?"#60a5fa":"#6b7280",cursor:"pointer",fontFamily:mono,fontSize:11,fontWeight:active?700:400,minWidth:36,textAlign:"center"}}>{d}</button>;
              })}
              <span style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginLeft:4}}>({(catchUpScenario.workDays||catchUp?.workDays||[1,2,3,4,5]).length} days/wk)</span>
            </div>
          </div>

          {catchUp?(
            <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:20}}>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#e5e7eb",letterSpacing:1,marginBottom:16}}>PROJECTION</div>

              {/* Calculated results */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:20}}>
                {[
                  {label:"Ship/hr",value:catchUp.outputPerHr,color:"#22c55e"},
                  {label:"Ship/work day",value:catchUp.outputPerDay,color:"#22c55e"},
                  {label:"Incoming/day (7d)",value:catchUp.incomingPerDay,color:"#f59e0b"},
                  {label:"Net/week",value:catchUp.netPerWeek,color:catchUp.netPerWeek>0?"#22c55e":"#ef4444"},
                  {label:`Hrs/day (${catchUp.shifts}×${catchUp.shiftHours}h)`,value:catchUp.hoursPerDay,color:"#a78bfa"},
                  {label:`Work days/wk`,value:catchUp.workDaysPerWeek,color:"#60a5fa"},
                  {label:"Calendar days",value:catchUp.daysToClear!=null?catchUp.daysToClear:"Falling behind",color:catchUp.daysToClear!=null?"#60a5fa":"#ef4444",small:catchUp.daysToClear==null},
                ].map((m,i)=>(
                  <div key={i} style={{background:"rgba(0,0,0,0.2)",borderRadius:6,padding:10,textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginBottom:2}}>{m.label}</div>
                    <div style={{fontSize:m.small?13:18,fontWeight:700,color:m.color,fontFamily:mono}}>{m.value}</div>
                  </div>
                ))}
              </div>

              {/* What's needed to hit target */}
              <div style={{background:"rgba(59,130,246,0.06)",border:"1px solid rgba(59,130,246,0.2)",borderRadius:8,padding:14,marginBottom:16}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:13,color:"#60a5fa",letterSpacing:1,marginBottom:8}}>BURN DOWN {catchUp.wipToClear||0} JOBS TO {catchUp.targetBacklog} IN {catchUp.targetDays} WORK DAYS</div>
                <div style={{display:"flex",gap:20,flexWrap:"wrap",alignItems:"flex-end"}}>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>Keep-up rate</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#f59e0b",fontFamily:mono}}>{catchUp.steadyStatePerWorkDay}</div>
                    <div style={{fontSize:8,color:"#6b7280",fontFamily:mono}}>jobs/work day</div>
                  </div>
                  <div style={{fontSize:14,color:"#6b7280",padding:"0 4px"}}>+</div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>Burn-down rate</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#a78bfa",fontFamily:mono}}>{catchUp.burnDownPerWorkDay}</div>
                    <div style={{fontSize:8,color:"#6b7280",fontFamily:mono}}>{catchUp.wipToClear} ÷ {catchUp.targetDays}d</div>
                  </div>
                  <div style={{fontSize:14,color:"#6b7280",padding:"0 4px"}}>=</div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#60a5fa",fontFamily:mono,fontWeight:700}}>REQUIRED</div>
                    <div style={{fontSize:24,fontWeight:800,color:"#60a5fa",fontFamily:mono}}>{catchUp.requiredPerWorkDay}</div>
                    <div style={{fontSize:8,color:"#6b7280",fontFamily:mono}}>jobs/work day</div>
                  </div>
                  <div style={{width:1,height:36,background:"rgba(255,255,255,0.1)",margin:"0 8px"}}/>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>Ship/hr</div>
                    <div style={{fontSize:18,fontWeight:700,color:"#60a5fa",fontFamily:mono}}>{catchUp.requiredPerHr}</div>
                  </div>
                  <div style={{textAlign:"center"}}>
                    <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>People needed</div>
                    <div style={{fontSize:18,fontWeight:700,color:catchUp.requiredAssemblers>catchUp.assemblers?"#ef4444":"#22c55e",fontFamily:mono}}>{catchUp.requiredAssemblers}</div>
                  </div>
                </div>
              </div>

              {/* Weekly milestones */}
              {catchUp.weeklyMilestones&&catchUp.weeklyMilestones.length>0&&(
                <div>
                  <div style={{fontFamily:mono,fontSize:11,color:"#6b7280",marginBottom:8}}>WEEKLY MILESTONES</div>
                  <div style={{display:"flex",gap:8}}>
                    {catchUp.weeklyMilestones.map(w=>(
                      <div key={w.week} style={{background:w.atTarget?"rgba(34,197,94,0.08)":"rgba(0,0,0,0.2)",border:w.atTarget?"1px solid rgba(34,197,94,0.2)":"1px solid transparent",borderRadius:6,padding:"8px 14px",textAlign:"center",flex:1}}>
                        <div style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>Week {w.week}</div>
                        <div style={{fontSize:18,fontWeight:700,color:w.atTarget?"#22c55e":"#e5e7eb",fontFamily:mono}}>{w.projectedWip.toLocaleString()}</div>
                        <div style={{fontSize:9,color:w.atTarget?"#22c55e":"#6b7280",fontFamily:mono,marginTop:2}}>{w.atTarget?"AT TARGET":"remaining"}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ):(
            <div style={{textAlign:"center",padding:40,color:"#6b7280",fontFamily:mono}}>Loading catch-up data...</div>
          )}
        </div>
      )}

      {/* ═══════ TREND VIEW ═══════ */}
      {subTab==="trend"&&(
        <div>
          <div style={{display:"flex",gap:8,marginBottom:16}}>
            {["sv","surfacing"].map(l=>(
              <button key={l} onClick={()=>setTrendLine(l)} style={{background:trendLine===l?"rgba(59,130,246,0.15)":"transparent",border:trendLine===l?"1px solid rgba(59,130,246,0.3)":"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"6px 14px",color:trendLine===l?"#60a5fa":"#9ca3af",cursor:"pointer",fontFamily:mono,fontSize:12}}>{l.toUpperCase()}</button>
            ))}
          </div>
          {trendData&&trendData.trends?(
            <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:20}}>
              <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:16,color:"#e5e7eb",letterSpacing:1,marginBottom:16}}>8-HOUR BUFFER TREND — {trendLine.toUpperCase()}</div>
              {Object.entries(trendData.trends).map(([stageId,points])=>{
                if(!points||points.length===0)return null;
                const max=Math.max(...points.map(p=>p.current_count||0),1);
                const barW=Math.max(2,Math.floor(600/points.length));
                return(
                  <div key={stageId} style={{marginBottom:16}}>
                    <div style={{fontFamily:mono,fontSize:11,color:"#9ca3af",marginBottom:4}}>{stageId}</div>
                    <div style={{display:"flex",alignItems:"flex-end",gap:1,height:60,background:"rgba(0,0,0,0.2)",borderRadius:4,padding:"4px 2px",overflow:"hidden"}}>
                      {points.map((p,i)=>{
                        const h=Math.max(2,(p.current_count/max)*52);
                        const clr=p.status==="critical"?"#ef4444":p.status==="warning"?"#f59e0b":"#22c55e";
                        return <div key={i} style={{width:barW,height:h,background:clr,borderRadius:1,opacity:0.7}} title={`${p.current_count} jobs at ${p.ts}`}/>;
                      })}
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#6b7280",fontFamily:mono,marginTop:2}}>
                      <span>{points[0]?.ts?.split("T")[1]?.slice(0,5)||""}</span>
                      <span>{points[points.length-1]?.ts?.split("T")[1]?.slice(0,5)||""}</span>
                    </div>
                  </div>
                );
              })}
            </div>
          ):(
            <div style={{textAlign:"center",padding:40,color:"#6b7280",fontFamily:mono}}>Loading trend data...</div>
          )}
        </div>
      )}

      {/* ═══════ FLOW HISTORY ANALYSIS ═══════ */}
      {subTab==="history-analysis"&&(
        <div>
          {/* Controls */}
          <div style={{display:"flex",gap:12,marginBottom:16,alignItems:"center",flexWrap:"wrap"}}>
            <div style={{display:"flex",gap:4}}>
              {[7,14,30].map(d=>(
                <button key={d} onClick={()=>setHistoryDays(d)} style={{background:historyDays===d?"rgba(59,130,246,0.15)":"transparent",border:historyDays===d?"1px solid rgba(59,130,246,0.3)":"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"5px 12px",color:historyDays===d?"#60a5fa":"#9ca3af",cursor:"pointer",fontFamily:mono,fontSize:11}}>{d}d</button>
              ))}
            </div>
            <div style={{display:"flex",gap:4}}>
              {(historyData?.stages||["INCOMING","SURFACING","COATING","CUTTING","ASSEMBLY","SHIPPING"]).map(s=>(
                <button key={s} onClick={()=>setHistoryStage(s)} style={{background:historyStage===s?"rgba(59,130,246,0.15)":"transparent",border:historyStage===s?"1px solid rgba(59,130,246,0.3)":"1px solid rgba(255,255,255,0.06)",borderRadius:6,padding:"5px 10px",color:historyStage===s?"#60a5fa":"#9ca3af",cursor:"pointer",fontFamily:mono,fontSize:10}}>{s}</button>
              ))}
            </div>
            {historyData&&<span style={{fontSize:10,color:"#6b7280",fontFamily:mono}}>{historyData.totalTransitions.toLocaleString()} transitions across {historyData.days} days</span>}
          </div>

          {historyData&&historyData.heatmap[historyStage]?(
            <div>
              {/* Average hourly pattern */}
              <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:16,marginBottom:16}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#e5e7eb",letterSpacing:1,marginBottom:12}}>TYPICAL DAILY PATTERN — {historyStage}</div>
                <div style={{display:"flex",alignItems:"flex-end",gap:2,height:120,padding:"0 4px"}}>
                  {(historyData.hourlyAvg[historyStage]||[]).map(h=>{
                    const maxAvg=Math.max(...(historyData.hourlyAvg[historyStage]||[]).map(x=>x.avg),1);
                    const barH=Math.max(2,(h.avg/maxAvg)*100);
                    const intensity=h.avg/maxAvg;
                    const color=intensity<0.3?"#ef4444":intensity<0.6?"#f59e0b":"#22c55e";
                    return(
                      <div key={h.hour} style={{flex:1,display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
                        <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>{Math.round(h.avg)}</div>
                        <div style={{width:"100%",height:barH,background:color,borderRadius:2,opacity:0.8,position:"relative"}} title={`${h.hour}:00 — avg ${h.avg}, min ${h.min}, max ${h.max}`}>
                          {/* Range indicator */}
                          <div style={{position:"absolute",top:-(h.max/maxAvg)*100+barH,left:"50%",width:1,height:(h.max-h.min)/maxAvg*100,background:"rgba(255,255,255,0.2)",transform:"translateX(-50%)"}}/>
                        </div>
                        <div style={{fontSize:8,color:"#6b7280",fontFamily:mono}}>{h.hour>12?h.hour-12+"p":h.hour+"a"}</div>
                      </div>
                    );
                  })}
                </div>
                <div style={{display:"flex",justifyContent:"space-between",marginTop:8}}>
                  <span style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>🔴 Low activity (drying out)</span>
                  <span style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>🟡 Moderate</span>
                  <span style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>🟢 High activity</span>
                </div>
              </div>

              {/* Day-by-day heatmap */}
              <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,padding:16}}>
                <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#e5e7eb",letterSpacing:1,marginBottom:12}}>DAILY HEATMAP — {historyStage}</div>
                <div style={{overflowX:"auto"}}>
                  {/* Hour headers */}
                  <div style={{display:"flex",gap:2,marginBottom:4,paddingLeft:80}}>
                    {(historyData.hours||[]).map(h=>(
                      <div key={h} style={{width:32,textAlign:"center",fontSize:8,color:"#6b7280",fontFamily:mono}}>{h>12?h-12+"p":h+"a"}</div>
                    ))}
                    <div style={{width:50,textAlign:"center",fontSize:8,color:"#6b7280",fontFamily:mono,fontWeight:700}}>TOTAL</div>
                  </div>
                  {/* Day rows */}
                  {(historyData.heatmap[historyStage]||[]).map(day=>{
                    const maxCount=Math.max(...day.hours.map(h=>h.count),1);
                    const globalMax=Math.max(...(historyData.heatmap[historyStage]||[]).flatMap(d=>d.hours.map(h=>h.count)),1);
                    return(
                      <div key={day.date} style={{display:"flex",gap:2,marginBottom:2,alignItems:"center"}}>
                        <div style={{width:80,fontSize:10,fontFamily:mono,color:"#9ca3af",flexShrink:0}}>
                          {day.dayOfWeek} {day.date.slice(5)}
                        </div>
                        {day.hours.map(h=>{
                          const intensity=h.count/globalMax;
                          const bg=h.count===0?"rgba(255,255,255,0.02)":
                            intensity<0.25?`rgba(239,68,68,${0.15+intensity*0.4})`:
                            intensity<0.5?`rgba(245,158,11,${0.15+intensity*0.4})`:
                            `rgba(34,197,94,${0.15+intensity*0.4})`;
                          return(
                            <div key={h.hour} style={{width:32,height:24,borderRadius:3,background:bg,display:"flex",alignItems:"center",justifyContent:"center"}} title={`${day.date} ${h.hour}:00 — ${h.count} jobs`}>
                              <span style={{fontSize:9,fontFamily:mono,color:h.count>0?"#e5e7eb":"#333",fontWeight:h.count>0?600:400}}>{h.count||""}</span>
                            </div>
                          );
                        })}
                        <div style={{width:50,textAlign:"center",fontSize:11,fontFamily:mono,color:"#e5e7eb",fontWeight:700}}>{day.total}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ):(
            <div style={{textAlign:"center",padding:40,color:"#6b7280",fontFamily:mono}}>Loading historical data...</div>
          )}
        </div>
      )}

      {/* ═══════ PUSH HISTORY VIEW ═══════ */}
      {subTab==="history"&&(
        <div>
          <div style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:14,color:"#6b7280",letterSpacing:1,marginBottom:8}}>PUSH HISTORY (24H)</div>
          {pushHistory.length===0?(
            <div style={{textAlign:"center",padding:40,color:"#6b7280",fontFamily:mono}}>No push history in last 24 hours</div>
          ):(
            <div style={{background:"rgba(255,255,255,0.02)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:10,overflow:"hidden"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontFamily:mono,fontSize:12}}>
                <thead>
                  <tr style={{borderBottom:"1px solid rgba(255,255,255,0.06)"}}>
                    {["Time","Line","Qty","Operator","Note"].map(h=>(
                      <th key={h} style={{padding:"8px 12px",textAlign:"left",color:"#6b7280",fontSize:10,fontWeight:600}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {pushHistory.map((p,i)=>(
                    <tr key={i} style={{borderBottom:"1px solid rgba(255,255,255,0.03)"}}>
                      <td style={{padding:"6px 12px",color:"#9ca3af"}}>{p.ts?.split("T")[1]?.slice(0,5)||p.ts}</td>
                      <td style={{padding:"6px 12px",color:"#60a5fa"}}>{p.line_id?.toUpperCase()}</td>
                      <td style={{padding:"6px 12px",color:"#e5e7eb",fontWeight:700}}>{p.push_qty}</td>
                      <td style={{padding:"6px 12px",color:"#9ca3af"}}>{p.operator||"—"}</td>
                      <td style={{padding:"6px 12px",color:"#6b7280"}}>{p.note||"—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ═══════ CONFIG DRAWER ═══════ */}
      {showConfig&&(
        <div style={{position:"fixed",top:0,right:0,width:420,height:"100vh",background:"#0D1117",borderLeft:"1px solid rgba(255,255,255,0.1)",padding:20,overflowY:"auto",zIndex:1000}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
            <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#e5e7eb",letterSpacing:1}}>STAGE CONFIG</span>
            <button onClick={()=>setShowConfig(false)} style={{background:"none",border:"none",color:"#6b7280",cursor:"pointer",fontSize:18}}>✕</button>
          </div>
          {stageConfigs.map(s=>(
            <div key={s.stage_id} style={{background:"rgba(255,255,255,0.03)",border:"1px solid rgba(255,255,255,0.06)",borderRadius:8,padding:12,marginBottom:8}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:editingStage===s.stage_id?8:0}}>
                <span style={{fontFamily:mono,fontSize:12,color:"#e5e7eb"}}>{s.label}</span>
                <button onClick={()=>{if(editingStage===s.stage_id){saveStageConfig(s.stage_id);}else{setEditingStage(s.stage_id);setStageEdits({cycle_time_min:s.cycle_time_min,cycle_time_max:s.cycle_time_max,typical_batch_size:s.typical_batch_size});}}} style={{background:"rgba(59,130,246,0.15)",border:"1px solid rgba(59,130,246,0.3)",borderRadius:4,padding:"2px 8px",color:"#60a5fa",cursor:"pointer",fontSize:10,fontFamily:mono}}>{editingStage===s.stage_id?"SAVE":"EDIT"}</button>
              </div>
              {editingStage===s.stage_id?(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:6}}>
                  <div>
                    <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>Min (min)</div>
                    <input type="number" value={stageEdits.cycle_time_min||""} onChange={e=>setStageEdits(p=>({...p,cycle_time_min:parseFloat(e.target.value)}))} style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:3,padding:4,color:"#e5e7eb",fontFamily:mono,fontSize:11,width:"100%"}}/>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>Max (min)</div>
                    <input type="number" value={stageEdits.cycle_time_max||""} onChange={e=>setStageEdits(p=>({...p,cycle_time_max:parseFloat(e.target.value)}))} style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:3,padding:4,color:"#e5e7eb",fontFamily:mono,fontSize:11,width:"100%"}}/>
                  </div>
                  <div>
                    <div style={{fontSize:9,color:"#6b7280",fontFamily:mono}}>Batch Size</div>
                    <input type="number" value={stageEdits.typical_batch_size||""} onChange={e=>setStageEdits(p=>({...p,typical_batch_size:parseInt(e.target.value)||null}))} style={{background:"rgba(0,0,0,0.3)",border:"1px solid rgba(255,255,255,0.1)",borderRadius:3,padding:4,color:"#e5e7eb",fontFamily:mono,fontSize:11,width:"100%"}}/>
                  </div>
                </div>
              ):(
                <div style={{fontSize:10,color:"#6b7280",fontFamily:mono,marginTop:4}}>
                  {s.cycle_time_min}–{s.cycle_time_max||s.cycle_time_min}min · {s.is_batch?"Batch ("+s.typical_batch_size+")":"Continuous"} · {s.path} · → {s.feeds_stage||"end"}
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function EarlyWarningTab({ovenServerUrl,settings}){
  const base=ovenServerUrl||`http://${window.location.hostname}:3002`;
  const mono="'JetBrains Mono',monospace";

  const [alerts,setAlerts]=useState([]);
  const [health,setHealth]=useState(null);
  const [baselines,setBaselines]=useState([]);
  const [filter,setFilter]=useState("all");
  const [expanded,setExpanded]=useState(null);
  const [lastRefresh,setLastRefresh]=useState(null);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState(null);
  const [selectedMetric,setSelectedMetric]=useState(null);
  const [metricHistory,setMetricHistory]=useState([]);
  const [situationReport,setSituationReport]=useState(null);
  const [aiLoading,setAiLoading]=useState(false);

  // Sub-tab state
  const [ewsSub,setEwsSub]=useState("alerts");

  // Settings sub-tab state
  const [ewsRules,setEwsRules]=useState([]);
  const [selectedRule,setSelectedRule]=useState(null);
  const [ruleDetail,setRuleDetail]=useState(null);
  const [ruleEdits,setRuleEdits]=useState({});
  const [ruleSaving,setRuleSaving]=useState(false);
  const [ruleTestResult,setRuleTestResult]=useState(null);
  const [globalConfig,setGlobalConfig]=useState({});
  const [configEdits,setConfigEdits]=useState({});
  const [ruleSearch,setRuleSearch]=useState("");
  const [ruleFilter,setRuleFilter]=useState("all");

  // Baselines sub-tab state
  const [labBaselines,setLabBaselines]=useState([]);
  const [labSchedule,setLabSchedule]=useState([]);
  const [baselineDept,setBaselineDept]=useState("surfacing");
  const [editingCell,setEditingCell]=useState(null);
  const [editingValue,setEditingValue]=useState("");
  const [baselineHistory,setBaselineHistory]=useState([]);

  // Backlog sub-tab state
  const [backlog,setBacklog]=useState([]);
  const [backlogTrend,setBacklogTrend]=useState([]);
  const [backlogDept,setBacklogDept]=useState("surfacing");
  const [catchupTargetRate,setCatchupTargetRate]=useState(40);
  const [catchupAvailHours,setCatchupAvailHours]=useState(8);

  // Tier config
  const TIER={
    P1:{color:"#ef4444",bg:"rgba(239,68,68,0.08)",border:"rgba(239,68,68,0.25)",label:"CRITICAL",pulse:true},
    P2:{color:"#f59e0b",bg:"rgba(245,158,11,0.06)",border:"rgba(245,158,11,0.2)",label:"WARNING",pulse:false},
    P3:{color:"#3b82f6",bg:"rgba(59,130,246,0.05)",border:"rgba(59,130,246,0.15)",label:"WATCH",pulse:false},
    P4:{color:"#334155",bg:"transparent",border:"#1e2d3d",label:"INFO",pulse:false},
  };

  // ── DEMO DATA ──────────────────────────────────────────────
  const DEMO_ALERTS=[
    {id:"demo_som_error",tier:"P1",status:"firing",system:"SOM",metric:"som_devices_in_error",
      message:"CRITICAL: 2 machines in error state — CCL-2 (SERR) and DBA-1 (SERR). Production line at risk.",
      detail:"Two Schneider machines reporting error status. Check SOM Control Center for fault codes. CCL-2 last ran 14 min ago. DBA-1 showing E-047 (spindle overtemp).",
      deviation:4.2,baseline:0.1,current_val:2,unit:"devices",fired_at:new Date(Date.now()-420000).toISOString(),acknowledged_at:null,
      sparkline:[0,0,0,0,0,1,1,0,1,2,2,2]},
    {id:"demo_throughput",tier:"P1",status:"firing",system:"DVI",metric:"dvi_throughput_per_hour",
      message:"DVI throughput 12 jobs/hr — 3.1σ below baseline (normal: 38±8 jobs/hr)",
      detail:"Production throughput dropped sharply in the last 30 minutes. Correlates with SOM machine errors. Surfacing queue building — 11 jobs waiting.",
      deviation:3.1,baseline:38,current_val:12,unit:"jobs/hr",fired_at:new Date(Date.now()-600000).toISOString(),acknowledged_at:null,
      sparkline:[42,39,41,38,36,33,28,24,19,16,14,12]},
    {id:"demo_pattern_cascade",tier:"P1",status:"firing",system:"Pattern",metric:"cascade-queue-buildup",
      message:"AI PATTERN: Cascade queue buildup — WIP piling in surfacing, throughput dropping, total WIP rising",
      detail:"Pattern match: 3/3 conditions met (100% confidence). Surfacing zone bottleneck propagating downstream. Recommend redistributing staff and throttling picking until surfacing clears.",
      deviation:1.0,baseline:null,current_val:null,unit:null,fired_at:new Date(Date.now()-480000).toISOString(),acknowledged_at:null,auto_correlated:"cascade-queue-buildup"},
    {id:"demo_wip_pileup",tier:"P2",status:"firing",system:"DVI",metric:"dvi_wip_pileup",
      message:"WARNING: 47 jobs piled up in SURFACING zone — 2.8σ above normal",
      detail:"WIP accumulating in surfacing. Downstream from picking, upstream of coating. Likely caused by machine downtime in surfacing.",
      deviation:2.8,baseline:18,current_val:47,unit:"jobs in single zone",fired_at:new Date(Date.now()-540000).toISOString(),acknowledged_at:null,
      sparkline:[15,17,20,22,26,30,33,37,41,44,46,47]},
    {id:"demo_breakage",tier:"P2",status:"firing",system:"Production",metric:"breakage_rate",
      message:"WARNING: 7 breakages today — 2.4σ above baseline (normal: 2.1±2.0/day)",
      detail:"Elevated breakage rate. 4 in surfacing (SUR-01 surface scratch), 2 in cutting (EDG-01 chip), 1 in assembly. Surfacing breakage correlates with tool wear pattern.",
      deviation:2.4,baseline:2.1,current_val:7,unit:"breaks/day",fired_at:new Date(Date.now()-1800000).toISOString(),acknowledged_at:null,
      sparkline:[1,1,2,2,3,3,4,4,5,6,6,7]},
    {id:"demo_consumption",tier:"P2",status:"firing",system:"ItemPath",metric:"itempath_consumption_rate",
      message:"WARNING: Lens blank consumption 42 picks/hr — 2.1σ above normal (baseline: 28±6.5/hr)",
      detail:"Excessive lens consumption likely driven by elevated breakage/remake rate. Check if remakes are inflating pick counts.",
      deviation:2.1,baseline:28,current_val:42,unit:"picks/hr",fired_at:new Date(Date.now()-3600000).toISOString(),acknowledged_at:null,
      sparkline:[26,28,30,31,33,35,36,38,39,40,41,42]},
    {id:"demo_network_latency",tier:"P2",status:"firing",system:"Network",metric:"network_latency_avg",
      message:"WARNING: WAN latency elevated — 67ms avg across sites (normal: 10±3ms)",
      detail:"Latency spike on Cox WAN link at Irvine 1. ItemPath API calls timing out intermittently. Check ISP status page.",
      deviation:2.3,baseline:10,current_val:67,unit:"ms",fired_at:new Date(Date.now()-300000).toISOString(),acknowledged_at:null,
      sparkline:[8,9,11,10,12,15,24,38,52,61,67,67]},
    {id:"demo_som_oee",tier:"P2",status:"firing",system:"SOM",metric:"som_oee",
      message:"WARNING: OEE at 54% — below 60% threshold (baseline: 78±8%)",
      detail:"OEE degraded due to machine errors on CCL-2 and DBA-1. Availability component is 68% (normally 92%).",
      deviation:3.0,baseline:78,current_val:54,unit:"%",fired_at:new Date(Date.now()-1200000).toISOString(),acknowledged_at:null,
      sparkline:[82,79,80,76,72,68,62,58,55,54,54,54]},
    {id:"demo_pattern_tool_wear",tier:"P2",status:"firing",system:"Pattern",metric:"tool-wear-degradation",
      message:"AI PATTERN: Tool wear degradation detected in Surfacing — cycle time up + breakage up + throughput down",
      detail:"Pattern match: 3/3 conditions met (100% confidence). Recommend immediate tool inspection on surfacing lathes. Check diamond point hours since last change.",
      deviation:1.0,baseline:null,current_val:null,unit:null,fired_at:new Date(Date.now()-900000).toISOString(),acknowledged_at:null,auto_correlated:"tool-wear-degradation"},
    {id:"demo_total_wip",tier:"P2",status:"firing",system:"DVI",metric:"dvi_total_wip",
      message:"WARNING: Total WIP at 112 jobs — exceeding 100 job threshold",
      detail:"WIP building due to coating and surfacing bottleneck. 47 in surfacing, 38 in coating, rest distributed.",
      deviation:2.1,baseline:65,current_val:112,unit:"jobs",fired_at:new Date(Date.now()-2400000).toISOString(),acknowledged_at:null,
      sparkline:[58,62,67,72,78,84,91,96,102,108,112,112]},
    {id:"demo_cycle_time",tier:"P3",status:"watch",system:"Surfacing",metric:"cycle_time_surfacing",
      message:"Surfacing avg cycle time trending up — 1.6σ above 30d baseline (23.4 min vs 18.2 normal)",
      detail:"Cycle time drift over last 2 hours. Consistent with tool wear pattern. Check diamond point condition on CNC lathes.",
      deviation:1.6,baseline:18.2,current_val:23.4,unit:"min/job",fired_at:new Date(Date.now()-7200000).toISOString(),acknowledged_at:null,
      sparkline:[17.8,18.0,18.5,19.1,19.8,20.4,21.0,21.6,22.1,22.7,23.1,23.4]},
    {id:"demo_maintenance_wo",tier:"P3",status:"watch",system:"Maintenance",metric:"maintenance_open_work_orders",
      message:"Maintenance backlog at 8 open work orders — 1.7σ above normal",
      detail:"3 PM work orders overdue (CCL-1 filter change, DBA-1 coolant flush, conveyor belt inspection). 5 corrective WOs open.",
      deviation:1.7,baseline:3,current_val:8,unit:"work orders",fired_at:new Date(Date.now()-14400000).toISOString(),acknowledged_at:null,
      sparkline:[3,3,4,4,5,5,6,6,7,7,8,8]},
    {id:"demo_resolved",tier:"P2",status:"resolved",system:"ItemPath",metric:"itempath_stockouts",
      message:"RESOLVED: Stockout on CR39-SV-70-AR cleared — replenishment received",
      detail:"Kardex bin restocked at 09:47. 120 units received from Philippines shipment.",
      deviation:null,baseline:null,current_val:0,unit:"SKUs",fired_at:new Date(Date.now()-86400000).toISOString(),resolved_at:new Date(Date.now()-82800000).toISOString(),acknowledged_at:new Date(Date.now()-85000000).toISOString()},
  ];
  const DEMO_HEALTH={status:"warning",lastPoll:new Date().toISOString(),lastPollDuration:245,pollCount:48,pollInterval:300,
    collectors:["som_machines","itempath_inventory","dvi_production","breakage","maintenance","oven_timers","network","cycle_times"],
    totalReadings:2143,totalAlertsFired:18,activeAlerts:{p1:3,p2:7,p3:2,total:12},thresholds:{P1:3.5,P2:2.5,P3:1.5},baselineDays:30};
  const DEMO_BASELINES=[
    {metric:"dvi_throughput_per_hour",shift_slot:"morning",day_of_week:1,mean:38,stddev:8,sample_n:84},
    {metric:"breakage_rate",shift_slot:"morning",day_of_week:1,mean:2.1,stddev:2.0,sample_n:84},
    {metric:"itempath_consumption_rate",shift_slot:"morning",day_of_week:1,mean:28,stddev:6.5,sample_n:84},
    {metric:"som_devices_in_error",shift_slot:"morning",day_of_week:1,mean:0.1,stddev:0.3,sample_n:84},
    {metric:"cycle_time_surfacing",shift_slot:"morning",day_of_week:1,mean:18.2,stddev:3.2,sample_n:84},
    {metric:"dvi_wip_pileup",shift_slot:"morning",day_of_week:1,mean:18,stddev:10,sample_n:84},
    {metric:"network_latency_avg",shift_slot:"morning",day_of_week:1,mean:10,stddev:3,sample_n:84},
    {metric:"som_oee",shift_slot:"morning",day_of_week:1,mean:78,stddev:8,sample_n:84},
    {metric:"dvi_total_wip",shift_slot:"morning",day_of_week:1,mean:65,stddev:22,sample_n:84},
    {metric:"maintenance_open_work_orders",shift_slot:"morning",day_of_week:1,mean:3,stddev:2.9,sample_n:84},
    {metric:"cycle_time_coating",shift_slot:"morning",day_of_week:1,mean:45,stddev:8,sample_n:84},
    {metric:"cycle_time_cutting",shift_slot:"morning",day_of_week:1,mean:12,stddev:2.5,sample_n:84},
    {metric:"cycle_time_assembly",shift_slot:"morning",day_of_week:1,mean:8.5,stddev:2,sample_n:84},
    {metric:"network_devices_offline",shift_slot:"morning",day_of_week:1,mean:0.2,stddev:0.4,sample_n:84},
    {metric:"oven_overdue_racks",shift_slot:"morning",day_of_week:1,mean:0.3,stddev:0.5,sample_n:84},
  ];
  const isDemo=settings?.demoMode||false;

  // Fetch alerts + health
  const fetchData=useCallback(async()=>{
    if(isDemo){
      setAlerts(DEMO_ALERTS);setHealth(DEMO_HEALTH);setBaselines(DEMO_BASELINES);
      setLastRefresh(new Date());setLoading(false);setError(null);return;
    }
    try{
      const[aRes,hRes,bRes]=await Promise.all([
        fetch(`${base}/api/ews/alerts?filter=${filter==="resolved"?"all":"active"}`),
        fetch(`${base}/api/ews/health`),
        fetch(`${base}/api/ews/baselines`),
      ]);
      if(aRes.ok){const d=await aRes.json();setAlerts(Array.isArray(d)?d:[]);}
      if(hRes.ok) setHealth(await hRes.json());
      if(bRes.ok) setBaselines(await bRes.json());
      setLastRefresh(new Date());
      setError(null);
    }catch(e){setError(e.message);}
    finally{setLoading(false);}
  },[base,filter,isDemo]);

  useEffect(()=>{fetchData();const t=setInterval(fetchData,15000);return()=>clearInterval(t);},[fetchData]);

  // Fetch metric history when selected
  useEffect(()=>{
    if(!selectedMetric)return;
    if(isDemo){
      // Generate synthetic history for demo
      const bl=DEMO_BASELINES.find(b=>b.metric===selectedMetric);
      const mean=bl?.mean||50,std=bl?.stddev||10;
      const hist=Array.from({length:24},(_,i)=>({
        metric:selectedMetric,value:Math.round((mean+(Math.random()-0.4)*std*2)*10)/10,
        unit:bl?.unit||"",ts:new Date(Date.now()-(23-i)*300000).toISOString()
      }));
      setMetricHistory(hist);return;
    }
    fetch(`${base}/api/ews/history?metric=${encodeURIComponent(selectedMetric)}&limit=48`)
      .then(r=>r.ok?r.json():[]).then(setMetricHistory).catch(()=>{});
  },[selectedMetric,base,isDemo]);

  // Fetch sub-tab data when switching
  useEffect(()=>{
    if(ewsSub==="settings"&&ewsRules.length===0){
      if(isDemo){
        // Generate demo rules from DEMO_ALERTS metrics
        setEwsRules([
          {id:1,metric:"som_devices_in_error",op:">=",threshold:2,tier:"P1",message:"CRITICAL: 2+ machines in error",category:"machine",department:"equipment",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-420000).toISOString(),fire_count:3},
          {id:2,metric:"som_devices_in_error",op:">=",threshold:1,tier:"P2",message:"WARNING: Machine in error state",category:"machine",department:"equipment",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-3600000).toISOString(),fire_count:8},
          {id:3,metric:"som_conveyor_errors",op:">=",threshold:3,tier:"P1",message:"CRITICAL: 3+ conveyor errors",category:"machine",department:"equipment",enabled:1,cooldown_min:30,window_min:5,last_fired_at:null,fire_count:0},
          {id:4,metric:"som_downtime_minutes",op:">=",threshold:5,tier:"P2",message:"WARNING: 5+ device-minutes downtime",category:"machine",department:"equipment",enabled:1,cooldown_min:30,window_min:5,last_fired_at:null,fire_count:0},
          {id:5,metric:"itempath_stockouts",op:">=",threshold:5,tier:"P1",message:"CRITICAL: 5+ SKUs stocked out",category:"inventory",department:"picking",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-86400000).toISOString(),fire_count:2},
          {id:6,metric:"itempath_stockouts",op:">=",threshold:2,tier:"P2",message:"WARNING: 2+ SKUs stocked out",category:"inventory",department:"picking",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-43200000).toISOString(),fire_count:5},
          {id:7,metric:"dvi_jobs_in_error",op:">=",threshold:10,tier:"P1",message:"CRITICAL: 10+ jobs in error",category:"production",department:"lab-wide",enabled:1,cooldown_min:30,window_min:5,last_fired_at:null,fire_count:0},
          {id:8,metric:"dvi_jobs_in_error",op:">=",threshold:5,tier:"P2",message:"WARNING: 5+ jobs in error",category:"production",department:"lab-wide",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-7200000).toISOString(),fire_count:4},
          {id:9,metric:"dvi_throughput_per_hour",op:"<=",threshold:15,tier:"P1",message:"CRITICAL: Throughput below 15 jobs/hr",category:"production",department:"lab-wide",enabled:0,cooldown_min:60,window_min:10,last_fired_at:null,fire_count:0,suppress_until:null},
          {id:10,metric:"breakage_rate",op:">=",threshold:10,tier:"P1",message:"CRITICAL: 10+ breakages today",category:"quality",department:"lab-wide",enabled:1,cooldown_min:30,window_min:5,last_fired_at:null,fire_count:0},
          {id:11,metric:"breakage_rate",op:">=",threshold:5,tier:"P2",message:"WARNING: 5+ breakages today",category:"quality",department:"lab-wide",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-1800000).toISOString(),fire_count:7},
          {id:12,metric:"coating_reject_rate",op:">=",threshold:15,tier:"P1",message:"CRITICAL: 15%+ coating reject rate",category:"quality",department:"coating",enabled:1,cooldown_min:30,window_min:5,last_fired_at:null,fire_count:0},
          {id:13,metric:"coating_reject_rate",op:">=",threshold:8,tier:"P2",message:"WARNING: 8%+ coating reject rate",category:"quality",department:"coating",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-14400000).toISOString(),fire_count:3},
          {id:14,metric:"network_devices_offline",op:">=",threshold:3,tier:"P1",message:"CRITICAL: 3+ devices offline",category:"network",department:"network",enabled:1,cooldown_min:30,window_min:5,last_fired_at:null,fire_count:0},
          {id:15,metric:"network_latency_avg",op:">=",threshold:50,tier:"P2",message:"WARNING: WAN latency >50ms",category:"network",department:"network",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-300000).toISOString(),fire_count:2},
          {id:16,metric:"som_oee",op:"<=",threshold:60,tier:"P2",message:"WARNING: OEE below 60%",category:"machine",department:"equipment",enabled:1,cooldown_min:30,window_min:5,last_fired_at:new Date(Date.now()-1200000).toISOString(),fire_count:1},
          {id:17,metric:"oven_overdue_racks",op:">=",threshold:3,tier:"P1",message:"CRITICAL: 3+ oven racks overdue",category:"oven",department:"coating",enabled:1,cooldown_min:30,window_min:5,last_fired_at:null,fire_count:0},
          {id:18,metric:"maintenance_open_work_orders",op:">=",threshold:10,tier:"P2",message:"WARNING: 10+ open work orders",category:"maintenance",department:"maintenance",enabled:1,cooldown_min:60,window_min:15,last_fired_at:null,fire_count:0},
        ]);
        setGlobalConfig({p1_sigma:"3.5",p2_sigma:"2.5",p3_sigma:"1.5",poll_interval_sec:"300",baseline_days:"30",auto_resolve_hours:"4",min_baseline_samples:"10",dedup_window_min:"30"});
        return;
      }
      fetch(`${base}/api/ews/rules`).then(r=>r.ok?r.json():[]).then(setEwsRules).catch(()=>{});
      fetch(`${base}/api/ews/config`).then(r=>r.ok?r.json():{}).then(d=>{setGlobalConfig(d);setConfigEdits(d);}).catch(()=>{});
    }
    if(ewsSub==="baselines"&&labBaselines.length===0){
      if(isDemo){
        setLabBaselines([
          {department:"surfacing",shift:"morning",metric:"throughput",value:40,unit:"jobs/hr"},
          {department:"surfacing",shift:"morning",metric:"yield",value:96,unit:"%"},
          {department:"surfacing",shift:"morning",metric:"labor_rate",value:8,unit:"operators"},
          {department:"surfacing",shift:"afternoon",metric:"throughput",value:35,unit:"jobs/hr"},
          {department:"surfacing",shift:"afternoon",metric:"yield",value:95,unit:"%"},
          {department:"surfacing",shift:"afternoon",metric:"labor_rate",value:7,unit:"operators"},
          {department:"cutting",shift:"morning",metric:"throughput",value:45,unit:"jobs/hr"},
          {department:"cutting",shift:"morning",metric:"yield",value:97,unit:"%"},
          {department:"cutting",shift:"morning",metric:"labor_rate",value:6,unit:"operators"},
          {department:"cutting",shift:"afternoon",metric:"throughput",value:40,unit:"jobs/hr"},
          {department:"cutting",shift:"afternoon",metric:"yield",value:96,unit:"%"},
          {department:"cutting",shift:"afternoon",metric:"labor_rate",value:5,unit:"operators"},
          {department:"coating",shift:"morning",metric:"throughput",value:30,unit:"jobs/hr"},
          {department:"coating",shift:"morning",metric:"yield",value:92,unit:"%"},
          {department:"coating",shift:"morning",metric:"labor_rate",value:6,unit:"operators"},
          {department:"coating",shift:"afternoon",metric:"throughput",value:25,unit:"jobs/hr"},
          {department:"coating",shift:"afternoon",metric:"yield",value:91,unit:"%"},
          {department:"coating",shift:"afternoon",metric:"labor_rate",value:5,unit:"operators"},
          {department:"assembly",shift:"morning",metric:"throughput",value:35,unit:"jobs/hr"},
          {department:"assembly",shift:"morning",metric:"yield",value:98,unit:"%"},
          {department:"assembly",shift:"morning",metric:"labor_rate",value:8,unit:"operators"},
          {department:"assembly",shift:"afternoon",metric:"throughput",value:30,unit:"jobs/hr"},
          {department:"assembly",shift:"afternoon",metric:"yield",value:97,unit:"%"},
          {department:"assembly",shift:"afternoon",metric:"labor_rate",value:7,unit:"operators"},
          {department:"picking",shift:"morning",metric:"throughput",value:50,unit:"jobs/hr"},
          {department:"picking",shift:"morning",metric:"yield",value:99,unit:"%"},
          {department:"picking",shift:"morning",metric:"labor_rate",value:4,unit:"operators"},
          {department:"picking",shift:"afternoon",metric:"throughput",value:45,unit:"jobs/hr"},
          {department:"picking",shift:"afternoon",metric:"yield",value:99,unit:"%"},
          {department:"picking",shift:"afternoon",metric:"labor_rate",value:3,unit:"operators"},
          {department:"print",shift:"morning",metric:"throughput",value:60,unit:"jobs/hr"},
          {department:"print",shift:"morning",metric:"yield",value:99,unit:"%"},
          {department:"print",shift:"morning",metric:"labor_rate",value:2,unit:"operators"},
          {department:"print",shift:"afternoon",metric:"throughput",value:55,unit:"jobs/hr"},
          {department:"print",shift:"afternoon",metric:"yield",value:99,unit:"%"},
          {department:"print",shift:"afternoon",metric:"labor_rate",value:2,unit:"operators"},
        ]);
        return;
      }
      fetch(`${base}/api/lab/baselines`).then(r=>r.ok?r.json():[]).then(setLabBaselines).catch(()=>{});
      fetch(`${base}/api/lab/baselines/history?limit=20`).then(r=>r.ok?r.json():[]).then(setBaselineHistory).catch(()=>{});
    }
    if(ewsSub==="backlog"&&backlog.length===0){
      if(isDemo){
        setBacklog([
          {department:"surfacing",backlog:47,throughput:28,baseline_throughput:40,recovery_hours:1.7,color:"green",shift:"morning"},
          {department:"cutting",backlog:12,throughput:42,baseline_throughput:45,recovery_hours:0.3,color:"green",shift:"morning"},
          {department:"coating",backlog:38,throughput:18,baseline_throughput:30,recovery_hours:2.1,color:"amber",shift:"morning"},
          {department:"assembly",backlog:84,throughput:22,baseline_throughput:35,recovery_hours:3.8,color:"amber",shift:"morning"},
        ]);
        setBacklogTrend(Array.from({length:30},(_,i)=>({day:`2026-02-${String(17+i>28?17+i-28:17+i).padStart(2,"0")}`,avg_backlog:Math.round(20+Math.random()*40),max_backlog:Math.round(40+Math.random()*50),samples:12})));
        return;
      }
      fetch(`${base}/api/lab/backlog`).then(r=>r.ok?r.json():[]).then(setBacklog).catch(()=>{});
      fetch(`${base}/api/lab/backlog/trend?department=${backlogDept}&days=30`).then(r=>r.ok?r.json():[]).then(setBacklogTrend).catch(()=>{});
    }
  },[ewsSub,base,isDemo]);

  // Filtered alerts
  const filtered=useMemo(()=>{
    if(!Array.isArray(alerts))return[];
    return alerts.filter(a=>{
      if(filter==="all")return a.status!=="resolved";
      if(filter==="resolved")return a.status==="resolved";
      if(filter==="firing")return a.status==="firing";
      if(filter==="watch")return a.status==="watch";
      return a.tier===filter&&a.status!=="resolved";
    });
  },[alerts,filter]);

  // Alert counts
  const p1=alerts.filter(a=>a.tier==="P1"&&a.status==="firing").length;
  const p2=alerts.filter(a=>a.tier==="P2"&&a.status==="firing").length;
  const p3=alerts.filter(a=>a.tier==="P3"&&a.status!=="resolved").length;
  const firing=alerts.filter(a=>a.status==="firing").length;
  const unacked=alerts.filter(a=>!a.acknowledged_at&&a.status==="firing").length;
  const watching=alerts.filter(a=>a.status==="watch").length;
  const resolved=alerts.filter(a=>a.status==="resolved").length;

  // Acknowledge / resolve
  const ack=async(id)=>{
    await fetch(`${base}/api/ews/alerts/${encodeURIComponent(id)}/ack`,{method:"POST"});
    fetchData();
  };
  const resolve=async(id)=>{
    await fetch(`${base}/api/ews/alerts/${encodeURIComponent(id)}/resolve`,{method:"POST"});
    fetchData();
  };
  const forceRefresh=async()=>{
    setLoading(true);
    await fetch(`${base}/api/ews/refresh`,{method:"POST"});
    await fetchData();
  };

  // Time since helper
  const timeSince=(iso)=>{
    if(!iso)return"—";
    const diff=Date.now()-new Date(iso).getTime();
    const m=Math.floor(diff/60000);
    if(m<1)return"just now";
    if(m<60)return`${m}m ago`;
    const h=Math.floor(m/60);
    if(h<24)return`${h}h ago`;
    return`${Math.floor(h/24)}d ago`;
  };

  // Sparkline SVG — supports custom width/height for inline use
  const Sparkline=({data,color,width:sw,height:sh})=>{
    if(!data||data.length<2)return null;
    const w=sw||120,h=sh||32,pad=2;
    const vals=data.map(d=>typeof d==="object"?d.value:d);
    const min=Math.min(...vals),max=Math.max(...vals),range=max-min||1;
    const pts=vals.map((v,i)=>{
      const x=pad+(i/(vals.length-1))*(w-pad*2);
      const y=h-pad-((v-min)/range)*(h-pad*2);
      return`${x},${y}`;
    }).join(" ");
    const last=pts.split(" ").pop().split(",");
    return(
      <svg width={w} height={h} style={{display:"block"}}>
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" strokeLinejoin="round" opacity="0.7"/>
        <circle cx={last[0]} cy={last[1]} r={sw&&sw<80?"1.5":"2.5"} fill={color}/>
      </svg>
    );
  };

  // Collector → primary metric lookup
  const COLLECTOR_PRIMARY_METRICS={som_machines:"som_devices_in_error",itempath_inventory:"itempath_consumption_rate",dvi_production:"dvi_throughput_per_hour",breakage:"breakage_rate",maintenance:"maintenance_open_work_orders",oven_timers:"oven_overdue_racks",network:"network_devices_offline",cycle_times:"cycle_time_surfacing"};

  // AI Situation Report
  const getSituationReport=async()=>{
    setAiLoading(true);setSituationReport(null);
    const activeAlerts=alerts.filter(a=>a.status==="firing");
    const prompt=`You are a senior manufacturing operations engineer monitoring the Pair Eyewear lens lab in Irvine, CA.

ACTIVE EWS ALERTS:
${activeAlerts.map(a=>`[${a.tier}] ${a.system} — ${a.message}${a.deviation?` (${a.deviation}σ deviation)`:""}`).join("\n")||"None"}

ENGINE HEALTH:
${health?`Status: ${health.status}, Collectors: ${(health.collectors||[]).join(", ")}, Last poll: ${health.lastPoll}, Total readings: ${health.totalReadings}`:"Unknown"}

Generate a concise situation report:
1. SITUATION SUMMARY (2-3 sentences)
2. ROOT CAUSE ASSESSMENT (most likely single root cause)
3. IMMEDIATE ACTIONS (numbered, specific, by priority)
4. WATCH LIST (next 30 minutes)

Be direct. No hedging. This is a live production environment.`;
    try{
      const gwBase=`http://${window.location.hostname}:3001`;
      const res=await fetch(`${gwBase}/web/ask-sync`,{
        method:"POST",
        headers:{"Content-Type":"application/json"},
        body:JSON.stringify({question:prompt,agent:"lab"}),
      });
      if(res.ok){const d=await res.json();setSituationReport(d.response||d.text||JSON.stringify(d));}
      else setSituationReport(`Gateway error: ${res.status}`);
    }catch(e){setSituationReport(`Error: ${e.message}. Is the gateway running on port 3001?`);}
    setAiLoading(false);
  };

  // Unique metrics for dropdown
  const metricOptions=useMemo(()=>{
    const s=new Set();
    baselines.forEach(b=>s.add(b.metric));
    alerts.forEach(a=>s.add(a.metric));
    return[...s].sort();
  },[baselines,alerts]);

  if(loading&&!lastRefresh)return(
    <div style={{display:"flex",alignItems:"center",justifyContent:"center",height:400,color:T.textMuted}}>
      <div style={{textAlign:"center"}}>
        <div style={{fontSize:24,marginBottom:8}}>⚡</div>
        <div style={{fontFamily:mono,fontSize:12,letterSpacing:"0.1em"}}>CONNECTING TO EWS ENGINE...</div>
      </div>
    </div>
  );

  return(
    <div style={{fontFamily:mono}}>
      {/* ── HEADER ── */}
      <div style={{display:"flex",alignItems:"center",gap:16,marginBottom:20,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {p1>0&&<div style={{width:8,height:8,borderRadius:"50%",background:"#ef4444",boxShadow:"0 0 10px #ef4444",animation:"pulse 1.8s ease-in-out infinite"}}/>}
          {p1===0&&<div style={{width:8,height:8,borderRadius:"50%",background:"#10b981",boxShadow:"0 0 8px #10b981"}}/>}
          <span style={{color:T.blue,fontWeight:600,letterSpacing:"0.12em",fontSize:13}}>EARLY WARNING SYSTEM</span>
        </div>

        {/* Tier badges */}
        <div style={{display:"flex",gap:6}}>
          {[{tier:"P1",count:p1,color:"#ef4444"},{tier:"P2",count:p2,color:"#f59e0b"},{tier:"P3",count:p3,color:"#3b82f6"}].map(b=>(
            <button key={b.tier} onClick={()=>setFilter(filter===b.tier?"all":b.tier)} style={{
              padding:"3px 10px",background:filter===b.tier?`${b.color}11`:"transparent",
              border:`1px solid ${filter===b.tier?`${b.color}44`:T.border}`,borderRadius:3,
              display:"flex",alignItems:"center",gap:6,cursor:"pointer",
            }}>
              <div style={{width:5,height:5,borderRadius:"50%",background:b.count>0?b.color:"#334155"}}/>
              <span style={{fontSize:10,color:b.count>0?b.color:"#334155",letterSpacing:"0.1em",fontFamily:mono}}>{b.tier} · {b.count}</span>
            </button>
          ))}
        </div>

        <div style={{marginLeft:"auto",display:"flex",gap:8,alignItems:"center"}}>
          <button onClick={getSituationReport} style={{
            padding:"5px 14px",background:"#1a0f3d",border:"1px solid #3d1a5f",
            color:"#c084fc",borderRadius:3,fontSize:10,fontFamily:mono,letterSpacing:"0.1em",cursor:"pointer",
          }}>⬡ SITUATION REPORT</button>
          <button onClick={forceRefresh} style={{
            padding:"5px 14px",background:"transparent",border:`1px solid ${T.border}`,
            color:T.textMuted,borderRadius:3,fontSize:10,fontFamily:mono,letterSpacing:"0.1em",cursor:"pointer",
          }}>↻ REFRESH</button>
          {health&&<span style={{fontSize:10,color:health.status==="ok"?T.green:health.status==="warning"?T.amber:T.red}}>
            ● {health.status.toUpperCase()}
          </span>}
          {lastRefresh&&<span style={{fontSize:10,color:"#334155"}}>{lastRefresh.toLocaleTimeString()}</span>}
        </div>
      </div>

      {error&&<div style={{padding:"8px 12px",background:T.redDark,border:`1px solid ${T.red}33`,borderRadius:4,marginBottom:12,fontSize:11,color:T.red}}>Connection error: {error}</div>}

      {/* ── SUB-TAB BAR ── */}
      <div style={{display:"flex",gap:6,marginBottom:16}}>
        {[{id:"alerts",label:"Alerts",icon:"⚡"},{id:"settings",label:"Settings",icon:"⚙"},{id:"baselines",label:"Baselines",icon:"◊"},{id:"backlog",label:"Backlog",icon:"▤"}].map(tab=>(
          <button key={tab.id} onClick={()=>setEwsSub(tab.id)} style={{
            background:ewsSub===tab.id?T.blueDark:"transparent",border:`1px solid ${ewsSub===tab.id?T.blue:"transparent"}`,
            borderRadius:6,padding:"7px 16px",cursor:"pointer",color:ewsSub===tab.id?"#93C5FD":T.textMuted,
            fontSize:11,fontWeight:600,fontFamily:mono,letterSpacing:"0.06em",display:"flex",alignItems:"center",gap:6,
          }}><span>{tab.icon}</span>{tab.label.toUpperCase()}</button>
        ))}
      </div>

      {/* ═══ ALERTS SUB-TAB ═══ */}
      {ewsSub==="alerts"&&<div style={{display:"grid",gridTemplateColumns:"1fr 380px",gap:16,alignItems:"start"}}>

        {/* ── LEFT: ALERTS + BASELINES ── */}
        <div>
          {/* Filter bar (sticky) */}
          <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:12,position:"sticky",top:0,zIndex:10,background:T.bg,paddingTop:4,paddingBottom:8}}>
            <span style={{fontSize:9,color:"#475569",letterSpacing:"0.12em",marginRight:4}}>FILTER</span>
            {["all","firing","watch","P1","P2","P3","resolved"].map(f=>(
              <button key={f} onClick={()=>setFilter(f)} style={{
                padding:"3px 9px",fontSize:9,fontFamily:mono,letterSpacing:"0.08em",
                background:filter===f?T.blueDark:"transparent",
                color:filter===f?"#7dd3fc":"#334155",
                border:`1px solid ${filter===f?T.blue:T.border}`,borderRadius:2,cursor:"pointer",
              }}>{f.toUpperCase()}</button>
            ))}
            <span style={{marginLeft:"auto",fontSize:9,color:"#334155"}}>{filtered.length} alerts</span>
          </div>

          {/* Alert list */}
          <div style={{maxHeight:"60vh",overflowY:"auto"}}>
            {filtered.length===0&&(
              <div style={{textAlign:"center",padding:"40px 0",color:"#1e3a5f",fontSize:11}}>
                {filter==="all"?"No active alerts — all systems nominal":"No alerts matching this filter"}
              </div>
            )}
            {filtered.map(alert=>{
              const tc=TIER[alert.tier]||TIER.P4;
              const isExp=expanded===alert.id;
              return(
                <div key={alert.id} onClick={()=>setExpanded(isExp?null:alert.id)} style={{
                  marginBottom:8,borderRadius:4,cursor:"pointer",
                  background:tc.bg,border:`1px solid ${tc.border}`,
                  opacity:alert.status==="resolved"?0.5:1,
                  transition:"background 0.15s",
                }}>
                  <div style={{padding:"10px 12px",display:"flex",alignItems:"flex-start",gap:10}}>
                    {/* Tier badge */}
                    <div style={{
                      padding:"2px 7px",borderRadius:2,fontSize:8,letterSpacing:"0.12em",
                      background:alert.status==="resolved"?"transparent":tc.bg,
                      border:`1px solid ${tc.border}`,color:tc.color,flexShrink:0,marginTop:1,
                      animation:tc.pulse&&alert.status==="firing"?"blink 1.2s step-end infinite":undefined,
                    }}>{tc.label}</div>

                    <div style={{flex:1,minWidth:0}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{fontSize:10,color:"#64748b",letterSpacing:"0.08em"}}>{alert.system}</span>
                        <span style={{fontSize:9,color:"#1e3a5f"}}>·</span>
                        <span style={{fontSize:9,color:"#334155"}}>{alert.id.substring(0,20)}</span>
                        {alert.acknowledged_at&&<span style={{fontSize:8,color:"#334155",marginLeft:"auto"}}>ACK</span>}
                        <span style={{fontSize:9,color:"#334155",marginLeft:alert.acknowledged_at?0:"auto"}}>{timeSince(alert.fired_at)}</span>
                      </div>
                      <div style={{fontSize:11,color:alert.status==="resolved"?"#475569":tc.color,lineHeight:1.5,fontWeight:alert.tier==="P1"?500:400}}>
                        {alert.message}
                      </div>
                      {alert.deviation&&alert.status!=="resolved"&&(
                        <div style={{marginTop:6,display:"flex",alignItems:"center",gap:8}}>
                          {alert.sparkline&&alert.sparkline.length>=2&&<Sparkline data={alert.sparkline} color={tc.color} width={60} height={20}/>}
                          <div style={{flex:1,height:4,background:"#0d1117",borderRadius:2,overflow:"hidden"}}>
                            <div style={{height:"100%",width:`${Math.min(100,(alert.deviation/5)*100)}%`,background:alert.deviation>=3.5?"#ef4444":alert.deviation>=2.5?"#f59e0b":"#10b981",borderRadius:2,boxShadow:`0 0 6px ${alert.deviation>=3.5?"#ef4444":alert.deviation>=2.5?"#f59e0b":"#10b981"}`}}/>
                          </div>
                          <span style={{fontSize:10,color:tc.color,fontWeight:600,width:44,flexShrink:0,fontFamily:mono}}>{alert.deviation.toFixed(1)}σ</span>
                          {alert.current_val!=null&&(
                            <span style={{fontSize:9,color:"#475569"}}>
                              {alert.current_val} {alert.unit} <span style={{color:"#334155"}}>vs {alert.baseline}</span>
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                    <div style={{fontSize:12,color:"#334155",flexShrink:0,transition:"transform 0.15s",transform:isExp?"rotate(90deg)":"rotate(0deg)"}}>›</div>
                  </div>

                  {/* Expanded detail */}
                  {isExp&&(
                    <div style={{padding:"0 12px 12px",borderTop:"1px solid rgba(255,255,255,0.04)"}} onClick={e=>e.stopPropagation()}>
                      <div style={{fontSize:10,color:"#64748b",lineHeight:1.6,margin:"10px 0 8px"}}>{alert.detail}</div>
                      {alert.status!=="resolved"&&(
                        <div style={{display:"flex",gap:6,marginTop:10}}>
                          {!alert.acknowledged_at&&(
                            <button onClick={()=>ack(alert.id)} style={{
                              padding:"4px 12px",fontSize:9,fontFamily:mono,letterSpacing:"0.08em",
                              background:"transparent",border:`1px solid ${T.border}`,color:"#475569",borderRadius:2,cursor:"pointer",
                            }}>✓ ACKNOWLEDGE</button>
                          )}
                          <button onClick={()=>resolve(alert.id)} style={{
                            padding:"4px 12px",fontSize:9,fontFamily:mono,letterSpacing:"0.08em",
                            background:"transparent",border:`1px solid ${T.blueDark}`,color:T.blue,borderRadius:2,cursor:"pointer",
                          }}>◆ RESOLVE</button>
                          <button onClick={()=>{setSelectedMetric(alert.metric);}} style={{
                            padding:"4px 12px",fontSize:9,fontFamily:mono,letterSpacing:"0.08em",
                            background:"transparent",border:`1px solid ${T.border}`,color:"#475569",borderRadius:2,cursor:"pointer",
                          }}>📈 HISTORY</button>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Metric history chart */}
          {selectedMetric&&metricHistory.length>0&&(
            <div style={{marginTop:16,background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:8}}>
                <span style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>METRIC HISTORY — {selectedMetric.replace(/_/g," ").toUpperCase()}</span>
                <button onClick={()=>setSelectedMetric(null)} style={{fontSize:9,color:"#334155",background:"none",border:"none",cursor:"pointer"}}>✕</button>
              </div>
              <Sparkline data={metricHistory} color={T.blue}/>
              <div style={{display:"flex",gap:16,marginTop:6}}>
                {metricHistory.slice(0,1).map((r,i)=>(
                  <span key={i} style={{fontSize:9,color:"#475569"}}>Latest: {typeof r==="object"?r.value:r} {typeof r==="object"?r.unit:""}</span>
                ))}
                <span style={{fontSize:9,color:"#334155"}}>{metricHistory.length} readings</span>
              </div>
            </div>
          )}
        </div>

        {/* ── RIGHT: HEALTH + SUMMARY + HEATMAP + PATTERNS + AI REPORT ── */}
        <div style={{display:"flex",flexDirection:"column",gap:12,maxHeight:"80vh",overflowY:"auto"}}>

          {/* System Health Grid */}
          {health&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>SYSTEM HEALTH</div>
                <div style={{marginLeft:"auto",fontSize:9,color:"#334155"}}>
                  {health.pollCount} polls · {health.totalReadings} readings · {health.pollInterval}s
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:4}}>
                {(health.collectors||[]).map(c=>{
                  const pm=COLLECTOR_PRIMARY_METRICS[c];
                  const bl=baselines.find(b=>b.metric===pm);
                  const al=alerts.find(a=>a.metric===pm&&a.status==="firing");
                  const sc=al?(al.tier==="P1"?"#ef4444":al.tier==="P2"?"#f59e0b":"#3b82f6"):"#10b981";
                  return(
                    <div key={c} onClick={()=>setFilter(c.split("_")[0])} style={{
                      padding:"6px 8px",borderRadius:3,background:"rgba(255,255,255,0.01)",
                      border:`1px solid ${T.border}`,cursor:"pointer",
                    }}>
                      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                        <div style={{width:6,height:6,borderRadius:"50%",background:sc,boxShadow:`0 0 5px ${sc}`}}/>
                        <span style={{fontSize:8,color:"#64748b",flex:1,textTransform:"uppercase",letterSpacing:"0.08em",overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{c.replace(/_/g," ")}</span>
                      </div>
                      {bl&&<div style={{fontSize:8,color:"#334155",paddingLeft:12}}>μ={bl.mean.toFixed(1)} σ={bl.stddev.toFixed(1)} n={bl.sample_n}</div>}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Alert summary */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12}}>
            <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>ALERT SUMMARY</div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6}}>
              {[
                {label:"FIRING",value:firing,color:T.red},
                {label:"UNACKED",value:unacked,color:T.amber},
                {label:"WATCHING",value:watching,color:T.blue},
                {label:"RESOLVED",value:resolved,color:T.green},
              ].map(s=>(
                <div key={s.label} style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,padding:"8px 10px",textAlign:"center"}}>
                  <div style={{fontSize:18,fontWeight:600,color:s.color,lineHeight:1}}>{s.value}</div>
                  <div style={{fontSize:8,color:"#334155",marginTop:3,letterSpacing:"0.1em"}}>{s.label}</div>
                </div>
              ))}
            </div>
          </div>

          {/* Metric Heatmap */}
          {metricOptions.length>0&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>METRIC HEATMAP</div>
              <div style={{display:"flex",flexWrap:"wrap",gap:3}}>
                {metricOptions.map(m=>{
                  const a=alerts.find(x=>x.metric===m&&x.status==="firing");
                  const dev=a?.deviation||0;
                  const bg=dev>=3.5?"rgba(239,68,68,0.3)":dev>=2.5?"rgba(245,158,11,0.25)":dev>=1.5?"rgba(245,158,11,0.1)":"rgba(16,185,129,0.08)";
                  const color=dev>=3.5?"#ef4444":dev>=2.5?"#f59e0b":dev>=1.5?"#a3a3a3":"#334155";
                  return(
                    <div key={m} onClick={()=>setSelectedMetric(m)} title={m} style={{
                      padding:"3px 6px",borderRadius:2,background:bg,cursor:"pointer",
                      fontSize:8,color,fontFamily:mono,letterSpacing:"0.04em",
                      border:`1px solid ${dev>=2.5?color+"33":"transparent"}`,
                    }}>
                      {m.replace(/_/g," ").substring(0,18)}{dev>0?` ${dev.toFixed(1)}σ`:""}
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Active Patterns */}
          {(()=>{
            const patAlerts=alerts.filter(a=>a.auto_correlated||a.id?.startsWith("pattern_"));
            if(patAlerts.length===0)return null;
            return(
              <div style={{background:"rgba(139,92,246,0.04)",border:"1px solid rgba(139,92,246,0.15)",borderRadius:4,padding:12}}>
                <div style={{fontSize:9,color:"#8b5cf6",letterSpacing:"0.14em",marginBottom:8}}>AI PATTERNS ACTIVE</div>
                {patAlerts.map(p=>(
                  <div key={p.id} style={{marginBottom:8,padding:"6px 8px",background:"rgba(139,92,246,0.06)",borderRadius:3}}>
                    <div style={{fontSize:10,color:"#c084fc",fontWeight:500,marginBottom:4}}>{p.auto_correlated||p.metric}</div>
                    <div style={{fontSize:9,color:"#94a3b8",lineHeight:1.5}}>{p.message}</div>
                    {p.deviation!=null&&(
                      <div style={{marginTop:4,display:"flex",alignItems:"center",gap:6}}>
                        <span style={{fontSize:8,color:"#7c3aed"}}>CONFIDENCE</span>
                        <div style={{flex:1,height:3,background:"#1a0f3d",borderRadius:2,overflow:"hidden"}}>
                          <div style={{height:"100%",width:`${Math.min(100,p.deviation*100)}%`,background:"#8b5cf6",borderRadius:2}}/>
                        </div>
                        <span style={{fontSize:9,color:"#8b5cf6"}}>{Math.round(p.deviation*100)}%</span>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            );
          })()}

          {/* Metric selector */}
          {metricOptions.length>0&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>INSPECT METRIC</div>
              <select value={selectedMetric||""} onChange={e=>setSelectedMetric(e.target.value||null)} style={{
                width:"100%",padding:"6px 8px",background:T.surface,border:`1px solid ${T.border}`,
                borderRadius:3,color:T.text,fontFamily:mono,fontSize:10,
              }}>
                <option value="">Select metric...</option>
                {metricOptions.map(m=><option key={m} value={m}>{m.replace(/_/g," ")}</option>)}
              </select>
            </div>
          )}

          {/* AI Situation Report */}
          <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12}}>
            <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
              <span style={{fontSize:9,color:"#475569",letterSpacing:"0.14em"}}>AI SITUATION REPORT</span>
              {aiLoading&&<div style={{width:6,height:6,borderRadius:"50%",background:"#8b5cf6",animation:"pulse 1.8s ease-in-out infinite"}}/>}
            </div>
            {!situationReport&&!aiLoading&&(
              <div style={{textAlign:"center",padding:"16px 0"}}>
                <div style={{fontSize:10,color:"#1e3a5f",marginBottom:10,lineHeight:1.6}}>
                  {p1>0?`${p1} critical alert${p1>1?"s":""} active. Generate a situation report.`:"No critical alerts. Generate a report to review state."}
                </div>
                <button onClick={getSituationReport} style={{
                  padding:"7px 18px",background:"#1a0f3d",border:"1px solid #3d1a5f",
                  color:"#c084fc",borderRadius:3,fontSize:10,fontFamily:mono,letterSpacing:"0.1em",cursor:"pointer",
                }}>⬡ GENERATE REPORT</button>
              </div>
            )}
            {aiLoading&&(
              <div style={{display:"flex",alignItems:"center",gap:8,padding:"10px 0"}}>
                <span style={{fontSize:9,color:"#334155"}}>Correlating alerts...</span>
              </div>
            )}
            {situationReport&&(
              <div>
                <div style={{fontSize:10,color:"#94a3b8",lineHeight:1.7,whiteSpace:"pre-wrap",maxHeight:250,overflowY:"auto"}}>{situationReport}</div>
                <button onClick={getSituationReport} style={{
                  width:"100%",padding:"5px",background:"transparent",marginTop:8,
                  border:`1px solid ${T.border}`,color:"#334155",borderRadius:2,
                  fontSize:9,fontFamily:mono,letterSpacing:"0.08em",cursor:"pointer",
                }}>↻ REFRESH REPORT</button>
              </div>
            )}
          </div>
        </div>
      </div>}

      {/* ═══ SETTINGS SUB-TAB ═══ */}
      {ewsSub==="settings"&&(
        <div style={{display:"grid",gridTemplateColumns:"300px 1fr",gap:16,alignItems:"start"}}>
          {/* Left: Rule list */}
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            <input value={ruleSearch} onChange={e=>setRuleSearch(e.target.value)} placeholder="Search rules..." style={{padding:"6px 10px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
            <div style={{display:"flex",gap:4,flexWrap:"wrap"}}>
              {["all","machine","production","quality","inventory","network","maintenance","oven"].map(f=>(
                <button key={f} onClick={()=>setRuleFilter(f)} style={{padding:"2px 8px",fontSize:8,fontFamily:mono,background:ruleFilter===f?T.blueDark:"transparent",color:ruleFilter===f?"#7dd3fc":"#475569",border:`1px solid ${ruleFilter===f?T.blue:T.border}`,borderRadius:2,cursor:"pointer",letterSpacing:"0.06em"}}>{f.toUpperCase()}</button>
              ))}
            </div>
            <div style={{maxHeight:"65vh",overflowY:"auto",display:"flex",flexDirection:"column",gap:4}}>
              {ewsRules.filter(r=>{
                if(ruleSearch&&!r.metric.toLowerCase().includes(ruleSearch.toLowerCase())&&!r.message.toLowerCase().includes(ruleSearch.toLowerCase()))return false;
                if(ruleFilter!=="all"&&r.category!==ruleFilter)return false;
                return true;
              }).sort((a,b)=>{
                if(a.last_fired_at&&!b.last_fired_at)return -1;
                if(!a.last_fired_at&&b.last_fired_at)return 1;
                if(a.last_fired_at&&b.last_fired_at)return new Date(b.last_fired_at)-new Date(a.last_fired_at);
                return a.id-b.id;
              }).map(r=>{
                const dotColor=!r.enabled?"#334155":r.fire_count>5?"#ef4444":r.last_fired_at?"#f59e0b":"#10b981";
                return(
                  <div key={r.id} onClick={()=>{setSelectedRule(r.id);setRuleDetail(r);setRuleEdits({...r});setRuleTestResult(null);}} style={{
                    padding:"8px 10px",borderRadius:3,cursor:"pointer",
                    background:selectedRule===r.id?"rgba(59,130,246,0.08)":T.card,
                    border:`1px solid ${selectedRule===r.id?T.blue:T.border}`,
                  }}>
                    <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:3}}>
                      <div style={{width:6,height:6,borderRadius:"50%",background:dotColor,flexShrink:0}}/>
                      <span style={{fontSize:10,color:r.enabled?T.text:"#475569",flex:1,overflow:"hidden",whiteSpace:"nowrap",textOverflow:"ellipsis"}}>{r.metric}</span>
                      <span style={{fontSize:8,padding:"1px 5px",borderRadius:2,background:r.tier==="P1"?"#1f0d0d":"#1f1505",color:r.tier==="P1"?"#ef4444":"#f59e0b",letterSpacing:"0.1em"}}>{r.tier}</span>
                    </div>
                    <div style={{fontSize:9,color:"#475569",paddingLeft:12}}>
                      {r.op} {r.threshold} · {r.last_fired_at?`fired ${timeSince(r.last_fired_at)}`:"never fired"} · {r.fire_count} fires
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: Rule detail editor */}
          <div>
            {!ruleDetail&&<div style={{padding:40,textAlign:"center",color:"#1e3a5f",fontSize:11}}>Select a rule from the list to view and edit</div>}
            {ruleDetail&&(
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:16}}>
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:16}}>
                  <span style={{fontSize:13,color:T.blue,fontWeight:600}}>{ruleEdits.metric}</span>
                  <span style={{fontSize:8,color:"#334155",fontFamily:mono,marginLeft:"auto"}}>{ruleEdits.category} · {ruleEdits.department}</span>
                </div>

                {/* Editable fields */}
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:16}}>
                  {[
                    {label:"THRESHOLD",key:"threshold",type:"number"},
                    {label:"OPERATOR",key:"op",type:"select",options:[">=","<=",">","<"]},
                    {label:"TIER",key:"tier",type:"select",options:["P1","P2","P3"]},
                  ].map(f=>(
                    <div key={f.key}>
                      <div style={{fontSize:8,color:"#475569",letterSpacing:"0.12em",marginBottom:4}}>{f.label}</div>
                      {f.type==="number"&&<input type="number" value={ruleEdits[f.key]||""} onChange={e=>setRuleEdits(p=>({...p,[f.key]:parseFloat(e.target.value)}))} style={{width:"100%",padding:"6px 8px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:11}}/>}
                      {f.type==="select"&&<select value={ruleEdits[f.key]||""} onChange={e=>setRuleEdits(p=>({...p,[f.key]:e.target.value}))} style={{width:"100%",padding:"6px 8px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:11}}>{f.options.map(o=><option key={o} value={o}>{o}</option>)}</select>}
                    </div>
                  ))}
                </div>

                <div style={{marginBottom:16}}>
                  <div style={{fontSize:8,color:"#475569",letterSpacing:"0.12em",marginBottom:4}}>MESSAGE</div>
                  <input value={ruleEdits.message||""} onChange={e=>setRuleEdits(p=>({...p,message:e.target.value}))} style={{width:"100%",padding:"6px 8px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
                </div>

                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12,marginBottom:16}}>
                  {[
                    {label:"COOLDOWN (MIN)",key:"cooldown_min",type:"number"},
                    {label:"WINDOW (MIN)",key:"window_min",type:"number"},
                    {label:"ENABLED",key:"enabled",type:"toggle"},
                  ].map(f=>(
                    <div key={f.key}>
                      <div style={{fontSize:8,color:"#475569",letterSpacing:"0.12em",marginBottom:4}}>{f.label}</div>
                      {f.type==="number"&&<input type="number" value={ruleEdits[f.key]||""} onChange={e=>setRuleEdits(p=>({...p,[f.key]:parseInt(e.target.value)}))} style={{width:"100%",padding:"6px 8px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:11}}/>}
                      {f.type==="toggle"&&<button onClick={()=>setRuleEdits(p=>({...p,enabled:p.enabled?0:1}))} style={{padding:"6px 16px",background:ruleEdits.enabled?T.green+"22":"#1f0d0d",border:`1px solid ${ruleEdits.enabled?T.green+"44":"#3d1a1a"}`,color:ruleEdits.enabled?T.green:"#ef4444",borderRadius:3,fontSize:10,fontFamily:mono,cursor:"pointer",width:"100%"}}>{ruleEdits.enabled?"ENABLED":"DISABLED"}</button>}
                    </div>
                  ))}
                </div>

                {/* Suppress */}
                {ruleDetail.suppress_until&&new Date(ruleDetail.suppress_until)>new Date()?(
                  <div style={{padding:"8px 12px",background:"rgba(245,158,11,0.06)",border:"1px solid rgba(245,158,11,0.2)",borderRadius:3,marginBottom:12,display:"flex",alignItems:"center",gap:8}}>
                    <span style={{fontSize:10,color:T.amber}}>Suppressed until {new Date(ruleDetail.suppress_until).toLocaleString()}</span>
                    {ruleDetail.suppress_reason&&<span style={{fontSize:9,color:"#475569"}}>— {ruleDetail.suppress_reason}</span>}
                    <button onClick={async()=>{if(isDemo)return;await fetch(`${base}/api/ews/rules/${ruleDetail.id}/suppress`,{method:"DELETE"});const r=await(await fetch(`${base}/api/ews/rules/${ruleDetail.id}`)).json();setRuleDetail(r);setRuleEdits({...r});}} style={{marginLeft:"auto",padding:"3px 10px",background:"transparent",border:`1px solid ${T.border}`,color:"#475569",borderRadius:2,fontSize:9,fontFamily:mono,cursor:"pointer"}}>UNSUPPRESS</button>
                  </div>
                ):(
                  <div style={{display:"flex",gap:6,marginBottom:12}}>
                    {[{label:"1h",min:60},{label:"4h",min:240},{label:"8h",min:480},{label:"24h",min:1440}].map(s=>(
                      <button key={s.label} onClick={async()=>{const until=new Date(Date.now()+s.min*60000).toISOString();if(isDemo){setRuleDetail(p=>({...p,suppress_until:until}));return;}await fetch(`${base}/api/ews/rules/${ruleDetail.id}/suppress`,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({until,reason:`Snoozed ${s.label}`})});const r=await(await fetch(`${base}/api/ews/rules/${ruleDetail.id}`)).json();setRuleDetail(r);setRuleEdits({...r});}} style={{padding:"4px 10px",background:"transparent",border:`1px solid ${T.border}`,color:"#475569",borderRadius:2,fontSize:9,fontFamily:mono,cursor:"pointer"}}>Snooze {s.label}</button>
                    ))}
                  </div>
                )}

                {/* Test + Save buttons */}
                <div style={{display:"flex",gap:8,marginBottom:12}}>
                  <button onClick={async()=>{if(isDemo){setRuleTestResult({would_fire:ruleEdits.threshold<=5,readings_evaluated:12,violations:ruleEdits.threshold<=5?3:0});return;}const r=await fetch(`${base}/api/ews/rules/${ruleDetail.id}/test`,{method:"POST"});if(r.ok)setRuleTestResult(await r.json());}} style={{padding:"6px 14px",background:"#0f1f3d",border:"1px solid #1e3a5f",color:"#7dd3fc",borderRadius:3,fontSize:10,fontFamily:mono,cursor:"pointer",letterSpacing:"0.06em"}}>TEST LAST 60 MIN</button>
                  <button onClick={async()=>{setRuleSaving(true);if(isDemo){setTimeout(()=>{setRuleSaving(false);setEwsRules(p=>p.map(r=>r.id===ruleDetail.id?{...r,...ruleEdits}:r));},500);return;}await fetch(`${base}/api/ews/rules/${ruleDetail.id}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(ruleEdits)});setRuleSaving(false);const updated=await(await fetch(`${base}/api/ews/rules`)).json();setEwsRules(updated);}} disabled={ruleSaving} style={{padding:"6px 14px",background:T.green+"22",border:`1px solid ${T.green}44`,color:T.green,borderRadius:3,fontSize:10,fontFamily:mono,cursor:"pointer",letterSpacing:"0.06em"}}>{ruleSaving?"SAVING...":"SAVE CHANGES"}</button>
                </div>

                {/* Test result */}
                {ruleTestResult&&(
                  <div style={{padding:"8px 12px",background:ruleTestResult.would_fire?"rgba(239,68,68,0.06)":"rgba(16,185,129,0.06)",border:`1px solid ${ruleTestResult.would_fire?"rgba(239,68,68,0.2)":"rgba(16,185,129,0.2)"}`,borderRadius:3,marginBottom:12}}>
                    <span style={{fontSize:10,color:ruleTestResult.would_fire?"#ef4444":"#10b981",fontWeight:500}}>
                      {ruleTestResult.would_fire?`WOULD FIRE — ${ruleTestResult.violations} violations in ${ruleTestResult.readings_evaluated} readings`:`WOULD NOT FIRE — ${ruleTestResult.readings_evaluated} readings evaluated, 0 violations`}
                    </span>
                  </div>
                )}

                {/* Rule history */}
                {ruleDetail.history&&ruleDetail.history.length>0&&(
                  <div>
                    <div style={{fontSize:8,color:"#475569",letterSpacing:"0.12em",marginBottom:6}}>CHANGE HISTORY</div>
                    <div style={{maxHeight:150,overflowY:"auto"}}>
                      {ruleDetail.history.map((h,i)=>(
                        <div key={i} style={{fontSize:9,color:"#475569",padding:"3px 0",borderBottom:`1px solid ${T.border}`}}>
                          <span style={{color:"#334155"}}>{h.changed_at}</span> — {h.field}: {h.old_value} → <span style={{color:T.blue}}>{h.new_value}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Global config */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:16,marginTop:16}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:12}}>GLOBAL EWS SETTINGS</div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:10}}>
                {[
                  {label:"P1 SIGMA",key:"p1_sigma"},{label:"P2 SIGMA",key:"p2_sigma"},{label:"P3 SIGMA",key:"p3_sigma"},
                  {label:"POLL (SEC)",key:"poll_interval_sec"},{label:"BASELINE DAYS",key:"baseline_days"},
                  {label:"AUTO-RESOLVE (HR)",key:"auto_resolve_hours"},{label:"MIN SAMPLES",key:"min_baseline_samples"},
                  {label:"DEDUP (MIN)",key:"dedup_window_min"},
                ].map(f=>(
                  <div key={f.key}>
                    <div style={{fontSize:7,color:"#334155",letterSpacing:"0.1em",marginBottom:3}}>{f.label}</div>
                    <input type="number" step="0.1" value={configEdits[f.key]||""} onChange={e=>setConfigEdits(p=>({...p,[f.key]:e.target.value}))} style={{width:"100%",padding:"5px 6px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:10}}/>
                  </div>
                ))}
              </div>
              <button onClick={async()=>{if(isDemo){setGlobalConfig({...configEdits});return;}await fetch(`${base}/api/ews/config`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(configEdits)});const c=await(await fetch(`${base}/api/ews/config`)).json();setGlobalConfig(c);setConfigEdits(c);}} style={{marginTop:10,padding:"6px 14px",background:T.green+"22",border:`1px solid ${T.green}44`,color:T.green,borderRadius:3,fontSize:10,fontFamily:mono,cursor:"pointer"}}>SAVE GLOBAL CONFIG</button>
            </div>
          </div>
        </div>
      )}

      {/* ═══ BASELINES SUB-TAB ═══ */}
      {ewsSub==="baselines"&&(
        <div>
          {/* Department tabs */}
          <div style={{display:"flex",gap:6,marginBottom:16}}>
            {["surfacing","cutting","coating","assembly","picking","print"].map(d=>(
              <button key={d} onClick={()=>setBaselineDept(d)} style={{
                padding:"5px 14px",fontSize:10,fontFamily:mono,letterSpacing:"0.08em",
                background:baselineDept===d?T.blueDark:"transparent",color:baselineDept===d?"#7dd3fc":"#475569",
                border:`1px solid ${baselineDept===d?T.blue:T.border}`,borderRadius:3,cursor:"pointer",textTransform:"uppercase",
              }}>{d}</button>
            ))}
          </div>

          <div style={{display:"grid",gridTemplateColumns:"1fr 300px",gap:16}}>
            {/* Baseline table */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,overflow:"hidden"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:10,fontFamily:mono}}>
                <thead>
                  <tr style={{borderBottom:`1px solid ${T.border}`,background:"#0a0f14"}}>
                    <th style={{padding:"8px 12px",textAlign:"left",color:"#475569",letterSpacing:"0.1em",fontSize:9}}>METRIC</th>
                    {["morning","afternoon","night"].map(s=><th key={s} style={{padding:"8px 12px",textAlign:"center",color:"#475569",letterSpacing:"0.1em",fontSize:9}}>{s.toUpperCase()}</th>)}
                    <th style={{padding:"8px 12px",textAlign:"left",color:"#475569",letterSpacing:"0.1em",fontSize:9}}>UNIT</th>
                  </tr>
                </thead>
                <tbody>
                  {["throughput","yield","labor_rate"].map(metric=>{
                    const rows=labBaselines.filter(b=>b.department===baselineDept&&b.metric===metric);
                    const unit=rows[0]?.unit||"—";
                    return(
                      <tr key={metric} style={{borderBottom:`1px solid ${T.border}`}}>
                        <td style={{padding:"8px 12px",color:T.text,fontWeight:500}}>{metric.replace(/_/g," ")}</td>
                        {["morning","afternoon","night"].map(shift=>{
                          const row=rows.find(r=>r.shift===shift);
                          const val=row?.value||0;
                          const cellKey=`${baselineDept}_${shift}_${metric}`;
                          const isEditing=editingCell===cellKey;
                          return(
                            <td key={shift} style={{padding:"4px 8px",textAlign:"center"}} onClick={()=>{if(!isEditing){setEditingCell(cellKey);setEditingValue(String(val));}}}>
                              {isEditing?(
                                <input autoFocus type="number" value={editingValue} onChange={e=>setEditingValue(e.target.value)}
                                  onBlur={async()=>{
                                    const nv=parseFloat(editingValue);
                                    if(!isNaN(nv)&&nv!==val){
                                      if(!isDemo){
                                        await fetch(`${base}/api/lab/baselines`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify({department:baselineDept,shift,metric,value:nv,unit})});
                                        const updated=await(await fetch(`${base}/api/lab/baselines`)).json();
                                        setLabBaselines(updated);
                                        const hist=await(await fetch(`${base}/api/lab/baselines/history?department=${baselineDept}&limit=20`)).json();
                                        setBaselineHistory(hist);
                                      }else{
                                        setLabBaselines(p=>p.map(b=>b.department===baselineDept&&b.shift===shift&&b.metric===metric?{...b,value:nv}:b));
                                        setBaselineHistory(p=>[{department:baselineDept,shift,metric,old_value:val,new_value:nv,changed_by:"user",changed_at:new Date().toISOString()},...p]);
                                      }
                                    }
                                    setEditingCell(null);
                                  }}
                                  onKeyDown={e=>{if(e.key==="Enter")e.target.blur();if(e.key==="Escape")setEditingCell(null);}}
                                  style={{width:60,padding:"4px 6px",background:T.surface,border:`1px solid ${T.blue}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:11,textAlign:"center"}}
                                />
                              ):(
                                <span style={{cursor:"pointer",color:val>0?"#7dd3fc":"#334155",padding:"4px 8px",borderRadius:3}} title="Click to edit">{val||"—"}</span>
                              )}
                            </td>
                          );
                        })}
                        <td style={{padding:"8px 12px",color:"#475569",fontSize:9}}>{unit}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Change history */}
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:12}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8}}>CHANGE HISTORY</div>
              <div style={{maxHeight:300,overflowY:"auto"}}>
                {baselineHistory.length===0&&<div style={{fontSize:9,color:"#1e3a5f",padding:"12px 0"}}>No changes recorded</div>}
                {baselineHistory.map((h,i)=>(
                  <div key={i} style={{fontSize:9,color:"#475569",padding:"5px 0",borderBottom:`1px solid ${T.border}`}}>
                    <div style={{color:"#334155",marginBottom:2}}>{h.changed_at?new Date(h.changed_at).toLocaleString():""}</div>
                    <div><span style={{color:T.text}}>{h.department}</span> · {h.shift} · {h.metric}: <span style={{color:"#ef4444"}}>{h.old_value}</span> → <span style={{color:T.green}}>{h.new_value}</span></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ═══ BACKLOG SUB-TAB ═══ */}
      {ewsSub==="backlog"&&(
        <div>
          {/* Department cards */}
          <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12,marginBottom:20}}>
            {backlog.map(dept=>{
              const bg=dept.color==="red"?"rgba(239,68,68,0.06)":dept.color==="amber"?"rgba(245,158,11,0.06)":"rgba(16,185,129,0.04)";
              const bc=dept.color==="red"?"rgba(239,68,68,0.2)":dept.color==="amber"?"rgba(245,158,11,0.15)":"rgba(16,185,129,0.1)";
              const tc2=dept.color==="red"?"#ef4444":dept.color==="amber"?"#f59e0b":"#10b981";
              return(
                <div key={dept.department} onClick={()=>setBacklogDept(dept.department)} style={{
                  background:bg,border:`1px solid ${bc}`,borderRadius:6,padding:"16px 14px",cursor:"pointer",
                  outline:backlogDept===dept.department?`2px solid ${T.blue}`:"none",outlineOffset:2,
                }}>
                  <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:8,textTransform:"uppercase"}}>{dept.department}</div>
                  <div style={{fontSize:28,fontWeight:700,color:tc2,lineHeight:1,marginBottom:6}}>{dept.backlog}</div>
                  <div style={{fontSize:9,color:"#475569",marginBottom:2}}>jobs in queue</div>
                  <div style={{marginTop:8,display:"flex",justifyContent:"space-between",fontSize:9}}>
                    <div><span style={{color:"#334155"}}>Throughput</span> <span style={{color:"#7dd3fc"}}>{dept.throughput}</span><span style={{color:"#334155"}}> / {dept.baseline_throughput} jobs/hr</span></div>
                  </div>
                  <div style={{marginTop:6,fontSize:11,fontWeight:600,color:tc2}}>
                    {dept.recovery_hours!=null?`Recovery: ${dept.recovery_hours}h`:"No data"}
                  </div>
                </div>
              );
            })}
            {backlog.length===0&&<div style={{gridColumn:"1/-1",textAlign:"center",padding:40,color:"#1e3a5f",fontSize:11}}>No backlog data available — DVI queue metrics required</div>}
          </div>

          {/* Catch-up calculator */}
          {backlog.length>0&&(()=>{
            const dept=backlog.find(d=>d.department===backlogDept)||backlog[0];
            if(!dept)return null;
            const needed=dept.backlog>0&&catchupAvailHours>0?Math.ceil(dept.backlog/catchupAvailHours*10)/10:0;
            const daysAtCurrent=dept.throughput>0?Math.round(dept.backlog/dept.throughput/8*10)/10:null;
            const daysAtBaseline=dept.baseline_throughput>0?Math.round(dept.backlog/dept.baseline_throughput/8*10)/10:null;
            const daysAtTarget=catchupTargetRate>0?Math.round(dept.backlog/catchupTargetRate/8*10)/10:null;
            return(
              <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:16,marginBottom:16}}>
                <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:12}}>CATCH-UP CALCULATOR — {dept.department.toUpperCase()}</div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:12,marginBottom:12}}>
                  <div>
                    <div style={{fontSize:8,color:"#334155",marginBottom:3}}>TARGET RATE (JOBS/HR)</div>
                    <input type="number" value={catchupTargetRate} onChange={e=>setCatchupTargetRate(parseFloat(e.target.value)||0)} style={{width:"100%",padding:"6px 8px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:11}}/>
                  </div>
                  <div>
                    <div style={{fontSize:8,color:"#334155",marginBottom:3}}>HOURS AVAILABLE</div>
                    <input type="number" value={catchupAvailHours} onChange={e=>setCatchupAvailHours(parseFloat(e.target.value)||0)} style={{width:"100%",padding:"6px 8px",background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,color:T.text,fontFamily:mono,fontSize:11}}/>
                  </div>
                  <div>
                    <div style={{fontSize:8,color:"#334155",marginBottom:3}}>CURRENT BACKLOG</div>
                    <div style={{padding:"6px 8px",fontSize:14,fontWeight:600,color:"#7dd3fc"}}>{dept.backlog} jobs</div>
                  </div>
                  <div>
                    <div style={{fontSize:8,color:"#334155",marginBottom:3}}>JOBS/HR NEEDED</div>
                    <div style={{padding:"6px 8px",fontSize:14,fontWeight:600,color:needed>dept.baseline_throughput?"#ef4444":"#10b981"}}>{needed}</div>
                  </div>
                </div>
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:12}}>
                  <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:16,fontWeight:600,color:"#7dd3fc"}}>{daysAtCurrent!=null?`${daysAtCurrent}d`:"—"}</div>
                    <div style={{fontSize:8,color:"#334155",marginTop:2}}>AT CURRENT RATE</div>
                  </div>
                  <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:16,fontWeight:600,color:T.green}}>{daysAtBaseline!=null?`${daysAtBaseline}d`:"—"}</div>
                    <div style={{fontSize:8,color:"#334155",marginTop:2}}>AT BASELINE RATE</div>
                  </div>
                  <div style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:3,padding:"8px 10px",textAlign:"center"}}>
                    <div style={{fontSize:16,fontWeight:600,color:T.purple}}>{daysAtTarget!=null?`${daysAtTarget}d`:"—"}</div>
                    <div style={{fontSize:8,color:"#334155",marginTop:2}}>AT TARGET RATE</div>
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Backlog trend chart */}
          {backlogTrend.length>0&&(
            <div style={{background:T.card,border:`1px solid ${T.border}`,borderRadius:4,padding:16}}>
              <div style={{fontSize:9,color:"#475569",letterSpacing:"0.14em",marginBottom:12}}>30-DAY BACKLOG TREND — {backlogDept.toUpperCase()}</div>
              {(()=>{
                const w=700,h=180,pad=40;
                const vals=backlogTrend.map(d=>d.avg_backlog);
                const max=Math.max(...vals,1);
                const pts=vals.map((v,i)=>{
                  const x=pad+(i/(vals.length-1))*(w-pad*2);
                  const y=h-pad-((v/max)*(h-pad*2));
                  return`${x},${y}`;
                }).join(" ");
                return(
                  <svg width={w} height={h} style={{display:"block",width:"100%",height:"auto"}} viewBox={`0 0 ${w} ${h}`}>
                    {/* Reference lines */}
                    <line x1={pad} y1={h-pad-((80/max)*(h-pad*2))} x2={w-pad} y2={h-pad-((80/max)*(h-pad*2))} stroke="#f59e0b" strokeWidth="1" strokeDasharray="4,4" opacity="0.3"/>
                    <text x={w-pad+4} y={h-pad-((80/max)*(h-pad*2))+3} fill="#f59e0b" fontSize="8" opacity="0.5">8hr</text>
                    <line x1={pad} y1={h-pad-((20/max)*(h-pad*2))} x2={w-pad} y2={h-pad-((20/max)*(h-pad*2))} stroke="#10b981" strokeWidth="1" strokeDasharray="4,4" opacity="0.3"/>
                    <text x={w-pad+4} y={h-pad-((20/max)*(h-pad*2))+3} fill="#10b981" fontSize="8" opacity="0.5">2hr</text>
                    {/* Data line */}
                    <polyline points={pts} fill="none" stroke="#3b82f6" strokeWidth="2" strokeLinejoin="round"/>
                    {/* Axis labels */}
                    {backlogTrend.filter((_,i)=>i%7===0).map((d,i)=>(
                      <text key={i} x={pad+(i*7/(vals.length-1))*(w-pad*2)} y={h-8} fill="#334155" fontSize="8" textAnchor="middle">{d.day?.slice(5)}</text>
                    ))}
                  </svg>
                );
              })()}
            </div>
          )}
        </div>
      )}

      {/* CSS animations */}
      <style>{`
        @keyframes blink{50%{opacity:0}}
        @keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
      `}</style>
    </div>
  );
}

// ── QC & Breakage Tab ────────────────────────────────────────
function QCTab({trays,dviJobs=[],breakage,setBreakage}){
  const [subView,setSubView]=useState("live");
  const [newBreak,setNewBreak]=useState({job:"",dept:"ASSEMBLY",type:BREAK_TYPES[0],lens:"OD",coating:COATING_TYPES[0],note:""});
  const [showForm,setShowForm]=useState(false);

  // Real hold jobs from DVI trace (stage=HOLD or station includes HOLD)
  const qcHolds=useMemo(()=>dviJobs.filter(j=>{
    const st=(j.stage||'').toUpperCase();
    const stn=(j.station||'').toUpperCase();
    return st==='HOLD'||st==='QC'||stn.includes('HOLD')||stn.includes('QC HOLD');
  }),[dviJobs]);
  const todayBreaks=breakage.filter(b=>{const today=new Date();const d=new Date(b.time);return d.toDateString()===today.toDateString();});
  const totalBreaks=breakage.length;
  const byType={};breakage.forEach(b=>{byType[b.type]=(byType[b.type]||0)+1;});
  const sortedTypes=Object.entries(byType).sort((a,b)=>b[1]-a[1]);

  const handleLogBreak=()=>{
    if(!newBreak.job.trim())return;
    setBreakage(prev=>[{id:`BRK-${String(prev.length+1).padStart(3,"0")}`,job:newBreak.job,dept:newBreak.dept,type:newBreak.type,lens:newBreak.lens,coating:newBreak.coating,time:new Date(),resolved:false,note:newBreak.note},...prev]);
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
            <KPICard label="Total Breaks" value={totalBreaks} sub="all time" accent={T.amber}/>
          </div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
            <Card>
              <SectionHeader right={`${qcHolds.length} jobs`}>QC Hold Queue</SectionHeader>
              {qcHolds.length===0?<div style={{fontSize:12,color:T.textDim,textAlign:"center",padding:24}}>✓ No jobs on QC hold</div>:
                <div style={{maxHeight:400,overflowY:"auto"}}>
                  {qcHolds.map(t=>(
                    <div key={t.job_id||t.id} style={{display:"flex",gap:10,padding:"10px",marginBottom:6,background:T.bg,borderRadius:8,border:`1px solid ${T.pink}30`}}>
                      <div style={{width:10,height:10,borderRadius:"50%",background:T.pink,marginTop:4,flexShrink:0,boxShadow:`0 0 8px ${T.pink}60`}}/>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",gap:6,alignItems:"center",marginBottom:2}}>
                          <span style={{fontSize:13,color:T.text,fontWeight:700,fontFamily:mono}}>{t.job_id||t.invoice||t.id}</span>
                          {(t.rush==='Y'||t.Rush==='Y'||t.priority==='RUSH')&&<Pill color={T.red}>RUSH</Pill>}
                        </div>
                        <div style={{fontSize:10,color:T.textDim}}>Station: {t.station||'—'} • {t.coating||t.coatType||"Unknown"}</div>
                        <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>
                          {t.daysInLab!=null?`${Math.round(t.daysInLab*10)/10}d in lab`:''}
                          {t.operator?` • Op: ${t.operator}`:''}
                        </div>
                      </div>
                      <div style={{display:"flex",flexDirection:"column",gap:4}}>
                        <button onClick={()=>alert(`Releasing ${t.job_id||t.id} — integrate with DVI to update status`)} style={{fontSize:10,padding:"4px 8px",background:T.greenDark,border:`1px solid ${T.green}`,borderRadius:5,color:T.green,cursor:"pointer",fontFamily:mono,fontWeight:700}}>RELEASE</button>
                        <button onClick={()=>alert(`Scrapping ${t.job_id||t.id}`)} style={{fontSize:10,padding:"4px 8px",background:T.redDark,border:`1px solid ${T.red}`,borderRadius:5,color:T.red,cursor:"pointer",fontFamily:mono,fontWeight:700}}>SCRAP</button>
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
                      <div style={{fontSize:11,color:T.red,fontFamily:mono,fontWeight:700}}>{b.type}</div>
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
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          <BreakageHistory breakage={breakage}/>
          <Card>
            <SectionHeader right={`${breakage.length} total breaks logged`}>All Breakage Events</SectionHeader>
            <div style={{maxHeight:500,overflowY:"auto"}}>
              {breakage.map(b=>(
                <div key={b.id} style={{display:"flex",gap:12,padding:"10px",marginBottom:4,background:T.bg,borderRadius:8,border:`1px solid ${b.resolved?T.border:T.red+"30"}`}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:b.resolved?T.green:T.red,marginTop:5,flexShrink:0}}/>
                  <div style={{flex:1,display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:4}}>
                    {[["Job",b.job,T.text],["Stage",b.dept,DEPARTMENTS[b.dept]?.color||T.textMuted],["Operator",b.operator||'—',T.textMuted],["Coating",b.coating,T.blue],["Time",new Date(b.time).toLocaleString([],{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}),T.textDim],["Status",b.resolved?"Resolved":"Open",b.resolved?T.green:T.red],["Days",b.daysInLab?`${Math.round(b.daysInLab*10)/10}d`:'—',T.textMuted]].map(([l,v,c])=>(
                      <div key={l}><div style={{fontSize:8,color:T.textDim,fontFamily:mono}}>{l}</div><div style={{fontSize:11,color:c,fontFamily:mono,fontWeight:600}}>{v}</div></div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {subView==="analytics"&&(
        <div style={{display:"flex",flexDirection:"column",gap:20}}>
          <div style={{display:"flex",gap:14,flexWrap:"wrap"}}>
            <KPICard label="Total Breaks" value={breakage.length} sub="all time" accent={T.red}/>
            <KPICard label="Today" value={todayBreaks.length} sub="breaks today" accent={T.orange}/>
            <KPICard label="Top Type" value={sortedTypes.length>0?sortedTypes[0][0]:'—'} sub={sortedTypes.length>0?`${sortedTypes[0][1]} occurrences`:'none'} accent={T.amber}/>
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
              <SectionHeader>Breaks by Stage</SectionHeader>
              {(()=>{const byDept={};breakage.forEach(b=>{const d=b.dept||'UNKNOWN';byDept[d]=(byDept[d]||0)+1;});const sorted=Object.entries(byDept).sort((a,b)=>b[1]-a[1]);const max=sorted[0]?sorted[0][1]:1;return sorted.map(([dept,count])=>{const d=DEPARTMENTS[dept];return(
                  <div key={dept} style={{marginBottom:8}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}><span style={{color:d?.color||T.textMuted}}>{d?.label||dept}</span><span style={{color:T.text,fontFamily:mono,fontWeight:700}}>{count}</span></div>
                    <div style={{height:6,background:T.bg,borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:`${(count/max)*100}%`,background:d?.color||T.textMuted,borderRadius:3}}/></div>
                  </div>
                );});})()}
            </Card>
          </div>
          <BreakageHistory breakage={breakage}/>
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
    setTrays(prev=>prev.map(t=>t.id===mappedTrayId?{...t,job,state:"BOUND",updatedAt:Date.now(),einkPages:3,department:"PICKING",coatingStage:null,machine:null,batchId:null,position:posKey}:t));
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
// Historical batch data comes from nightly ETL / live APIs — no mock generation

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
    const ctx=`You are a read-only corporate analytics assistant for Pair Eyewear's lens lab. Use your MCP tools (get_wip_snapshot, get_aging_report, get_throughput_trend) to get real production data. Provide clear, concise operational insights. Be direct and data-driven. Format numbers clearly. Do not invent data.`;
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
  const [trays,setTrays]=useState([]);
  const [putWall,setPutWall]=useState([]);
  const [batches,setBatches]=useState([]);
  const [events,setEvents]=useState([]);
  const [messages,setMessages]=useState([]);
  const [inspections]=useState([]);
  const [breakage,setBreakage]=useState([]);
  const [connected]=useState(true);
  const [ovenServerUrl,setOvenServerUrl]=useState(()=>{ try{return JSON.parse(localStorage.getItem("la_slack_v2")||"{}").ovenServer||`http://${window.location.hostname}:3002`;}catch{return `http://${window.location.hostname}:3002`;} });
  const [clock,setClock]=useState(new Date());

  // DVI jobs from gateway + shipped stats
  const [dviJobs,setDviJobs]=useState([]);
  const [shippedStats,setShippedStats]=useState({today:0,yesterday:0,thisWeek:0});
  const [assemblyStats,setAssemblyStats]=useState({assembledToday:0,passToday:0,failToday:0});
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

  // Fetch DVI job data from lab server (trace file watcher)
  useEffect(()=>{
    const fetchDvi=async()=>{
      try{
        const res=await fetch(`http://${window.location.hostname}:3002/api/dvi/jobs`);
        if(res.ok){
          const data=await res.json();
          // Filter out CANCELED and SHIPPED jobs — only active WIP
          const jobs=(data?.jobs||[]).filter(j=>j.stage!=='CANCELED'&&j.station!=='CANCELED'&&j.status!=='SHIPPED'&&j.stage!=='SHIPPED'&&!(j.station||'').toUpperCase().includes('SHIPPED'));
          setDviJobs(jobs);
          // Update shipped stats if available
          if(data.shipped){
            setShippedStats(data.shipped);
          }
          if(data.assembly){
            setAssemblyStats(data.assembly);
          }
        }
      }catch(e){ console.warn("DVI fetch:",e.message); }
    };
    fetchDvi();
    const iv=setInterval(fetchDvi,10000); // 10s to match trace watcher cadence
    return()=>clearInterval(iv);
  },[]);

  // Fetch real breakage data from DVI trace
  useEffect(()=>{
    const fetchBreakage=async()=>{
      try{
        const res=await fetch(`http://${window.location.hostname}:3002/api/breakage`);
        if(res.ok){
          const data=await res.json();
          setBreakage(data.breakage||[]);
        }
      }catch(e){ console.warn("Breakage fetch:",e.message); }
    };
    fetchBreakage();
    const iv=setInterval(fetchBreakage,30000); // refresh every 30s
    return()=>clearInterval(iv);
  },[]);

  // System health polling
  const [systemHealth,setSystemHealth]=useState(null);
  useEffect(()=>{
    const fetchHealth=async()=>{
      try{
        const res=await fetch(`http://${window.location.hostname}:3002/api/health`);
        if(res.ok) setSystemHealth(await res.json());
      }catch(e){ setSystemHealth({status:'down',systems:{server:{status:'down',message:e.message}}}); }
    };
    fetchHealth();
    const iv=setInterval(fetchHealth,15000); // every 15s
    return()=>clearInterval(iv);
  },[]);

  // Live event feed from DVI trace + SOM
  const lastEventTs=useRef(null);
  useEffect(()=>{
    const stageIcon=(s)=>({INCOMING:"📥",NEL:"🔍",AT_KARDEX:"📦",SURFACING:"⚙",COATING:"🌡",CUTTING:"✂",ASSEMBLY:"🔧",QC:"🔬",SHIPPING:"📤",BREAKAGE:"💥",HOLD:"⏸"}[s]||"📡");
    const fetchEvents=async()=>{
      try{
        const res=await fetch(`http://${window.location.hostname}:3002/api/dvi/trace/events?limit=20`);
        if(!res.ok)return;
        const data=await res.json();
        const evts=(data.events||data||[]);
        if(evts.length===0)return;
        const newEvts=lastEventTs.current?evts.filter(e=>(e.timestamp||0)>lastEventTs.current):evts.slice(0,10);
        if(newEvts.length>0){
          lastEventTs.current=Math.max(...evts.map(e=>e.timestamp||0));
          const mapped=newEvts.map(e=>({
            id:`dvi-${e.jobId}-${e.timestamp}`,
            time:new Date(e.timestamp),
            icon:stageIcon(e.stage||''),
            message:`${e.jobId} → ${e.station}${e.operator?' ('+e.operator+')':''}`
          }));
          setEvents(prev=>[...mapped,...prev].slice(0,50));
        }else if(!lastEventTs.current){
          lastEventTs.current=Math.max(...evts.map(e=>e.timestamp||0));
          const mapped=evts.slice(0,10).map(e=>({
            id:`dvi-${e.jobId}-${e.timestamp}`,
            time:new Date(e.timestamp),
            icon:stageIcon(e.stage||''),
            message:`${e.jobId} → ${e.station}${e.operator?' ('+e.operator+')':''}`
          }));
          setEvents(mapped);
        }
      }catch{}
    };
    fetchEvents();
    const iv=setInterval(fetchEvents,5000);
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

  // Clock tick only — no mock simulation
  useEffect(()=>{
    const iv=setInterval(()=>setClock(new Date()),2500);
    return()=>clearInterval(iv);
  },[]);

  // Corporate mode — render read-only viewer
  if(appMode==="corporate"){
    return <CorporateViewer trays={trays} batches={batches} events={events} settings={settings}/>;
  }

  const isTablet = appMode==="tablet";

  // Navigation: dropdown menus to keep header clean
  const [openMenu,setOpenMenu]=useState(null);
  const navMenus=[
    {id:"overview",label:"Overview",icon:"◉",type:"button"},
    {id:"production",label:"Production",icon:"🏭",type:"dropdown",items:[
      {id:"incoming",label:"Incoming",icon:"📥"},
      {id:"surfacing",label:"Surfacing",icon:"🌀"},
      {id:"cutting",label:"Cutting",icon:"✂️"},
      {id:"coating",label:"Coating",icon:"🌡"},
      {id:"assembly",label:"Assembly",icon:"🔧"},
      {id:"shipping",label:"Shipping",icon:"📤"},
    ]},
    {id:"inventory_menu",label:"Inventory",icon:"📦",type:"dropdown",items:[
      {id:"putwall",label:"Put Wall",icon:"⬡"},
      {id:"inventory",label:"Inventory",icon:"📦"},
      {id:"maintenance",label:"Maintenance",icon:"🔩"},
    ]},
    {id:"analytics_menu",label:"Analytics",icon:"📊",type:"dropdown",items:[
      {id:"analytics",label:"Analytics",icon:"📊"},
      {id:"aging",label:"Aging Jobs",icon:"⏳"},
      {id:"qc",label:"QC & Breakage",icon:"✓"},
    ]},
    {id:"intelligence",label:"Intelligence",icon:"🧠",type:"dropdown",items:[
      {id:"flow",label:"Flow Agent",icon:"🌊"},
      {id:"ai",label:"AI Assistant",icon:"🤖"},
      {id:"ews",label:"Early Warning",icon:"⚡"},
      {id:"network",label:"Network NOC",icon:"🔀"},
      {id:"vision",label:"Vision",icon:"👁"},
    ]},
    {id:"settings",label:"Settings",icon:"⚙️",type:"button"},
  ];
  // Check if current view is in a menu (for highlighting the parent)
  const menuForView=(v)=>{for(const m of navMenus){if(m.items){for(const i of m.items)if(i.id===v)return m.id;}if(m.id===v)return m.id;}return null;};
  // Close dropdown on any click — the menu items handle their own clicks via stopPropagation
  useEffect(()=>{
    if(!openMenu)return;
    const close=()=>setOpenMenu(null);
    // Delay to avoid closing on the same click that opened it
    const timer=setTimeout(()=>document.addEventListener("click",close),10);
    return()=>{clearTimeout(timer);document.removeEventListener("click",close);};
  },[openMenu]);

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
              {navMenus.map(m=>{
                const isActive=m.type==="button"?view===m.id:menuForView(view)===m.id;
                if(m.type==="button"){
                  return <button key={m.id} onClick={()=>{setView(m.id);setOpenMenu(null);}} style={{background:isActive?T.blueDark:"transparent",border:`1px solid ${isActive?T.blue:"transparent"}`,borderRadius:8,padding:"8px 16px",cursor:"pointer",color:isActive?"#93C5FD":T.textMuted,fontSize:13,fontWeight:700,fontFamily:sans,display:"flex",alignItems:"center",gap:6,transition:"all 0.2s"}}><span style={{fontSize:15}}>{m.icon}</span>{m.label}</button>;
                }
                return(
                  <div key={m.id} style={{position:"relative"}}>
                    <button onClick={e=>{e.stopPropagation();setOpenMenu(openMenu===m.id?null:m.id);}} style={{background:isActive?T.blueDark:"transparent",border:`1px solid ${isActive?T.blue:"transparent"}`,borderRadius:8,padding:"8px 16px",cursor:"pointer",color:isActive?"#93C5FD":T.textMuted,fontSize:13,fontWeight:700,fontFamily:sans,display:"flex",alignItems:"center",gap:6,transition:"all 0.2s"}}>
                      <span style={{fontSize:15}}>{m.icon}</span>{m.label}<span style={{fontSize:10,marginLeft:2,opacity:0.5}}>▾</span>
                    </button>
                    {openMenu===m.id&&(
                      <div style={{position:"absolute",top:"100%",left:0,marginTop:4,background:T.card,border:`1px solid ${T.border}`,borderRadius:10,padding:4,minWidth:180,zIndex:200,boxShadow:"0 8px 32px rgba(0,0,0,0.4)"}} onClick={e=>e.stopPropagation()}>
                        {m.items.map(item=>(
                          <button key={item.id} onClick={()=>{setView(item.id);setOpenMenu(null);}} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"10px 14px",background:view===item.id?T.blueDark:"transparent",border:"none",borderRadius:6,cursor:"pointer",color:view===item.id?"#93C5FD":T.text,fontSize:13,fontWeight:view===item.id?700:500,fontFamily:sans,textAlign:"left",transition:"background 0.15s"}}>
                            <span style={{fontSize:15,width:22,textAlign:"center"}}>{item.icon}</span>{item.label}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
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
      {view==="vision"?(
        <VisionDashboard ovenServerUrl={ovenServerUrl} settings={settings} isTablet={isTablet}/>
      ):(
      <div style={{padding:isTablet?"14px 12px 90px":"22px 28px",maxWidth:3600,margin:"0 auto",position:"relative",zIndex:1}}>
        {view==="overview"&&<OverviewTab trays={trays} putWall={putWall} batches={batches} events={events} messages={messages} onSendMessage={sendMessage} onBatchControl={handleBatchControl} settings={settings} breakage={breakage} dviJobs={mergedJobs} wipJobs={wipJobs} shippedStats={shippedStats} assemblyStats={assemblyStats}/>}
        {view==="putwall"&&<PutWallTab putWall={putWall} setPutWall={setPutWall} events={events} wipJobs={wipJobs}/>}
        {view==="coating"&&<CoatingTab batches={batches} trays={trays} dviJobs={mergedJobs} inspections={inspections} onBatchControl={handleBatchControl} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="surfacing"&&<SurfacingTab trays={trays} dviJobs={mergedJobs} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="cutting"&&<CuttingTab trays={trays} dviJobs={mergedJobs} breakage={breakage} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="assembly"&&<AssemblyTab trays={trays} dviJobs={mergedJobs} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="incoming"&&<IncomingTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="shipping"&&<ShippingTab trays={trays} dviJobs={dviJobs} shippedStats={shippedStats} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="inventory"&&<InventoryTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="maintenance"&&<MaintenanceTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="analytics"&&<AnalyticsTab batches={batches} trays={trays} dviJobs={mergedJobs} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="qc"&&<QCTab trays={trays} dviJobs={mergedJobs} breakage={breakage} setBreakage={setBreakage}/>}
        {view==="trays"&&<TrayFleetTab trays={trays} setTrays={setTrays}/>}
        {view==="ai"&&<AIAssistantTab trays={trays} batches={batches} dviJobs={dviJobs} breakage={breakage} ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="aging"&&<AgingJobsTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="timeatlab"&&<TimeAtLabTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="flow"&&<FlowAgentTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="ews"&&<EarlyWarningTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="network"&&<NetworkTab ovenServerUrl={ovenServerUrl} settings={settings}/>}
        {view==="settings"&&<SettingsTab settings={settings} setSettings={setSettings} ovenServerUrl={ovenServerUrl} onNavigate={setView}/>}
      </div>
      )}

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

      {/* SYSTEM HEALTH FOOTER */}
      {(()=>{
        const h=systemHealth;
        const sys=h?.systems||{};
        const dot=(s)=>s==='ok'?T.green:s==='stale'?T.amber:s==='error'||s==='down'?T.red:T.textDim;
        const items=[
          {key:'dvi_trace',label:'DVI Trace',s:sys.dvi_trace},
          {key:'itempath',label:'ItemPath',s:sys.itempath},
          {key:'som',label:'SOM',s:sys.som},
          {key:'server',label:'Server',s:sys.server},
        ];
        return(
          <div style={{padding:isTablet?"8px 16px":"8px 28px",borderTop:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
            <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Lab_Assistant v2.2.0</span>
            <div style={{display:"flex",gap:isTablet?8:16,alignItems:"center",flexWrap:"wrap"}}>
              {items.map(({key,label,s})=>{
                const status=s?.status||'unknown';
                const msg=s?.message||'';
                return(
                  <div key={key} title={msg} style={{display:"flex",alignItems:"center",gap:5,cursor:"default"}}>
                    <div style={{width:7,height:7,borderRadius:"50%",background:dot(status),boxShadow:status==='ok'?'none':`0 0 6px ${dot(status)}80`,animation:status==='stale'||status==='error'||status==='down'?'pulse 2s infinite':'none'}}/>
                    <span style={{fontSize:10,color:status==='ok'?T.textDim:status==='stale'?T.amber:status==='down'||status==='error'?T.red:T.textDim,fontFamily:mono,fontWeight:status!=='ok'?700:400}}>
                      {label}{status!=='ok'&&status!=='unknown'?` · ${status.toUpperCase()}`:''}
                    </span>
                    {key==='dvi_trace'&&s?.lastEvent&&<span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{s.jobs} jobs</span>}
                    {key==='server'&&s?.uptime!=null&&<span style={{fontSize:9,color:T.textDim,fontFamily:mono}}>{Math.floor(s.uptime/3600)}h{Math.floor((s.uptime%3600)/60)}m</span>}
                  </div>
                );
              })}
            </div>
          </div>
        );
      })()}

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

      {/* PIN Prompt Modal */}
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
