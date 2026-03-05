// SettingsTab — Settings configuration panel extracted from App.jsx
import { useState, useEffect, useRef } from 'react';
import { T, mono, DEFAULT_SETTINGS } from '../../constants';
import { Card, SectionHeader } from '../shared';

// ── DevOps AI Card ────────────────────────────────────────────────────────────
function DevOpsAICard({settings,connections}){
  const [query,setQuery]=useState('');
  const [response,setResponse]=useState('');
  const [loading,setLoading]=useState(false);

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
                  title="Delete agent">x</button>
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
              <div style={{fontSize:32,marginBottom:12}}>{"<-"}</div>
              <div style={{fontSize:13}}>Select an agent to edit its system prompt</div>
            </div>
          )}
        </Card>
      </div>

      {/* Help Text */}
      <Card style={{background:`${T.purple}08`,border:`1px solid ${T.purple}30`}}>
        <div style={{fontSize:12,color:T.textMuted,lineHeight:1.6}}>
          <strong style={{color:T.text}}>Agent Prompts Guide:</strong><br/>
          - Each agent has a system prompt that defines its personality and capabilities<br/>
          - Use Markdown formatting for structure (headers, lists, code blocks)<br/>
          - Include specific data sources and metrics the agent should reference<br/>
          - Define the response style (concise, detailed, data-driven, etc.)<br/>
          - List available MCP tools the agent can use
        </div>
      </Card>
    </div>
  );
}

// ── Data Import Panel (DVI file upload) ───────────────────────────────────────
function DataImportPanel({settings}){
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
            <div style={{fontSize:32,marginBottom:12}}>&#8987;</div>
            <div style={{fontSize:14,fontWeight:600,color:T.text}}>Uploading...</div>
          </>
        ):(
          <>
            <div style={{fontSize:32,marginBottom:12}}>&#128229;</div>
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
            <span style={{fontSize:20}}>&#10003;</span>
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
              <span style={{fontSize:16}}>&#10003;</span>
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
            <div style={{fontSize:24,marginBottom:8}}>&#128196;</div>
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
              <span style={{fontSize:16}}>&#9888;</span>
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
          - Export your DVI data as CSV (comma-separated values)<br/>
          - First row should contain column headers<br/>
          - Common columns: job_id, order_id, stage, status, rx_type, operator, created_at<br/>
          - Data is stored in memory until live API connection is established<br/>
          - Uploaded data will be used by AI agents for analysis
        </div>
      </Card>
    </div>
  );
}

// ── Settings Tab (Main Component) ─────────────────────────────────────────────
function SettingsTab({settings,setSettings,ovenServerUrl}){
  const [sub,setSub]=useState("connections");
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
  const [connections,setConnections]=useState(null);
  const [loadingConnections,setLoadingConnections]=useState(false);
  const [expandedService,setExpandedService]=useState(null);
  const [showApiKeys,setShowApiKeys]=useState({});
  // Slack cleanup state
  const [cleaningSlack,setCleaningSlack]=useState(false);
  const [slackCleanResult,setSlackCleanResult]=useState(null);
  const [deleteAllSlackMsgs,setDeleteAllSlackMsgs]=useState(false);

  // MCP Tools state
  const [mcpTools,setMcpTools]=useState([]);
  const [mcpAgents,setMcpAgents]=useState([]);
  const [loadingMcp,setLoadingMcp]=useState(false);
  const [selectedTool,setSelectedTool]=useState(null);
  const [toolTestInput,setToolTestInput]=useState("{}");
  const [toolTestResult,setToolTestResult]=useState(null);
  const [testingTool,setTestingTool]=useState(false);
  const [mcpFilter,setMcpFilter]=useState({category:"all",search:""});
  const [mcpView,setMcpView]=useState("tools"); // tools | agents | tester | create
  const [newTool,setNewTool]=useState({name:"",description:"",category:"Custom",input_schema:"{}"});
  const [savingTool,setSavingTool]=useState(false);

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

  // Clean up Slack messages (bot-only or all)
  const cleanupSlackMessages = async () => {
    setCleaningSlack(true);
    setSlackCleanResult(null);
    try {
      const gwUrl = settings.gatewayUrl || 'http://localhost:3001';
      const url = deleteAllSlackMsgs ? `${gwUrl}/api/slack/messages?all=true` : `${gwUrl}/api/slack/messages`;
      const resp = await fetch(url, {
        method: 'DELETE',
        signal: AbortSignal.timeout(60000) // 60s timeout for batch delete
      });
      const data = await resp.json();
      if (data.ok) {
        const modeLabel = data.mode === 'all' ? 'messages' : 'bot messages';
        setSlackCleanResult({ ok: true, message: `Deleted ${data.deleted} of ${data.found} ${modeLabel}` });
      } else {
        setSlackCleanResult({ ok: false, message: data.error || 'Failed to delete messages' });
      }
    } catch (e) {
      setSlackCleanResult({ ok: false, message: e.message || 'Request failed' });
    }
    setCleaningSlack(false);
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

  // Load connections status
  const loadConnections = async () => {
    setLoadingConnections(true);
    const gwUrl = settings.gatewayUrl || 'http://localhost:3001';
    try {
      const resp = await fetch(`${gwUrl}/gateway/connections`, { signal: AbortSignal.timeout(15000) });
      if (resp.ok) {
        const data = await resp.json();
        setConnections(data);
      }
    } catch (e) {
      setConnections({ error: e.message });
    }
    setLoadingConnections(false);
  };

  // Auto-load connections when on connections tab
  useEffect(() => {
    if (sub === 'connections') {
      loadConnections();
      const interval = setInterval(loadConnections, 10000); // Refresh every 10s
      return () => clearInterval(interval);
    }
  }, [sub, settings.gatewayUrl]);

  // Load MCP tools and agents
  const loadMcpData = async () => {
    setLoadingMcp(true);
    const gwUrl = settings.gatewayUrl || 'http://localhost:3001';
    try {
      const [toolsRes, agentsRes] = await Promise.all([
        fetch(`${gwUrl}/gateway/tools`, { signal: AbortSignal.timeout(5000) }),
        fetch(`${gwUrl}/gateway/mcp/agents`, { signal: AbortSignal.timeout(5000) }),
      ]);
      if (toolsRes.ok) {
        const data = await toolsRes.json();
        setMcpTools(data.tools || []);
      }
      if (agentsRes.ok) {
        const data = await agentsRes.json();
        setMcpAgents(data.agents || []);
      }
    } catch (e) {
      console.error('Failed to load MCP data:', e);
    }
    setLoadingMcp(false);
  };

  // Auto-load MCP data when on mcptools tab
  useEffect(() => {
    if (sub === 'mcptools') {
      loadMcpData();
    }
  }, [sub, settings.gatewayUrl]);

  // Test a tool
  const testTool = async () => {
    if (!selectedTool) return;
    setTestingTool(true);
    setToolTestResult(null);
    const gwUrl = settings.gatewayUrl || 'http://localhost:3001';
    try {
      let input = {};
      try { input = JSON.parse(toolTestInput); } catch { input = {}; }
      const resp = await fetch(`${gwUrl}/gateway/tools/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tool: selectedTool.name, input }),
      });
      const data = await resp.json();
      setToolTestResult(data);
    } catch (e) {
      setToolTestResult({ success: false, error: e.message });
    }
    setTestingTool(false);
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
        {id:"connections",icon:"📡",label:"Connections"},
        {id:"agents",icon:"🧠",label:"Agents"},
        {id:"mcptools",icon:"🔧",label:"MCP Tools"},
        {id:"dataimport",icon:"📥",label:"Data Import"},
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

      {/* ══ CONNECTIONS ══ */}
      {sub==="connections"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:15,fontWeight:700,color:T.text}}>API & Service Connections</div>
              <div style={{fontSize:11,color:T.textMuted}}>Real-time status of all integrated services</div>
            </div>
            <button onClick={loadConnections} disabled={loadingConnections}
              style={{background:T.blue,border:"none",borderRadius:8,padding:"8px 16px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",opacity:loadingConnections?0.6:1}}>
              {loadingConnections?"Refreshing...":"↻ Refresh"}
            </button>
          </div>

          {connections?.error ? (
            <Card style={{background:`${T.red}15`,border:`1px solid ${T.red}40`}}>
              <div style={{display:"flex",alignItems:"center",gap:12,color:T.red}}>
                <span style={{fontSize:24}}>&#9888;</span>
                <div>
                  <div style={{fontWeight:700}}>Gateway Not Reachable</div>
                  <div style={{fontSize:12,opacity:0.8}}>{connections.error}</div>
                </div>
              </div>
            </Card>
          ) : connections ? (
            <>
              {/* Summary Cards */}
              <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:12}}>
                {[
                  {label:"Connected",value:connections.summary?.connected||0,color:T.green,icon:"✓"},
                  {label:"Mock Mode",value:connections.summary?.mock||0,color:T.amber,icon:"⚡"},
                  {label:"Disconnected",value:connections.summary?.disconnected||0,color:T.red,icon:"✗"},
                  {label:"Unconfigured",value:connections.summary?.unconfigured||0,color:T.textMuted,icon:"○"},
                ].map(s=>(
                  <Card key={s.label} style={{textAlign:"center",padding:"16px 12px"}}>
                    <div style={{fontSize:28,fontWeight:800,color:s.color,fontFamily:mono}}>{s.value}</div>
                    <div style={{fontSize:11,color:T.textMuted,marginTop:4}}>{s.icon} {s.label}</div>
                  </Card>
                ))}
              </div>

              {/* Connection Details */}
              <Card style={{padding:0}}>
                <div style={{padding:"12px 16px",borderBottom:`1px solid ${T.border}`,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                  <span style={{fontSize:10,fontWeight:700,color:T.textDim,letterSpacing:1,fontFamily:mono}}>SERVICE STATUS</span>
                  <span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>Last updated: {new Date(connections.timestamp).toLocaleTimeString()}</span>
                </div>
                {connections.connections && Object.entries(connections.connections).map(([key,conn])=>{
                  const statusColors = {connected:T.green,mock:T.amber,disconnected:T.red,unconfigured:T.textMuted};
                  const serviceNames = {
                    gateway:"MCP Gateway",
                    database:"Database (SQLite)",
                    lab_backend:"Lab Backend Server",
                    slack:"Slack Integration",
                    anthropic:"Anthropic Claude API",
                    itempath:"ItemPath/Kardex",
                    dvi:"DVI Lab System",
                    limble:"Limble CMMS"
                  };
                  const serviceIcons = {
                    gateway:"🌐",database:"🗄️",lab_backend:"🔧",slack:"💬",
                    anthropic:"🤖",itempath:"📦",dvi:"🔬",limble:"🛠️"
                  };
                  const startCommands = {
                    lab_backend: "npm run server",
                    gateway: "cd gateway && npm run dev"
                  };
                  // Config fields for each service
                  const serviceConfigs = {
                    gateway: [{key:'gatewayUrl',label:'Gateway URL',type:'url'}],
                    database: [{key:'databaseUrl',label:'DATABASE_URL',type:'password'}],
                    lab_backend: [{key:'serverUrl',label:'Server URL',type:'url'}],
                    slack: [
                      {key:'slackBotToken',label:'SLACK_BOT_TOKEN',type:'password'},
                      {key:'slackSigningSecret',label:'SLACK_SIGNING_SECRET',type:'password'},
                      {key:'slackAppToken',label:'SLACK_APP_TOKEN',type:'password'}
                    ],
                    anthropic: [{key:'anthropicApiKey',label:'ANTHROPIC_API_KEY',type:'password'}],
                    itempath: [
                      {key:'itempathUrl',label:'ITEMPATH_URL',type:'url'},
                      {key:'itempathToken',label:'ITEMPATH_TOKEN',type:'password'}
                    ],
                    dvi: [
                      {key:'dviUrl',label:'DVI_URL',type:'url'},
                      {key:'dviApiKey',label:'DVI_API_KEY',type:'password'}
                    ],
                    limble: [
                      {key:'limbleUrl',label:'LIMBLE_URL',type:'url'},
                      {key:'limbleApiKey',label:'LIMBLE_API_KEY',type:'password'}
                    ]
                  };
                  const isExpanded = expandedService === key;
                  const configs = serviceConfigs[key] || [];
                  return(
                    <div key={key} style={{borderBottom:`1px solid ${T.border}`}}>
                      <div style={{padding:"14px 16px",display:"flex",alignItems:"center",justifyContent:"space-between",cursor:configs.length?'pointer':'default',background:isExpanded?`${T.blue}08`:'transparent'}}
                        onClick={()=>configs.length && setExpandedService(isExpanded?null:key)}>
                        <div style={{display:"flex",alignItems:"center",gap:12}}>
                          <span style={{fontSize:20}}>{serviceIcons[key]||"⚙️"}</span>
                          <div>
                            <div style={{fontSize:13,fontWeight:600,color:T.text,display:"flex",alignItems:"center",gap:8}}>
                              {serviceNames[key]||key}
                              <span style={{width:8,height:8,borderRadius:"50%",background:statusColors[conn.status]}}/>
                            </div>
                            <div style={{fontSize:11,color:T.textMuted}}>{conn.message}</div>
                          </div>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:10}}>
                          {conn.latency !== undefined && conn.latency > 0 && (
                            <span style={{fontSize:11,color:T.textDim,fontFamily:mono}}>{conn.latency}ms</span>
                          )}
                          {conn.status === 'disconnected' && startCommands[key] && (
                            <button onClick={(e)=>{e.stopPropagation();navigator.clipboard.writeText(startCommands[key]).then(()=>alert(`Copied: ${startCommands[key]}`))}}
                              style={{background:T.green,border:"none",borderRadius:6,padding:"5px 10px",color:"#fff",fontSize:10,fontWeight:700,cursor:"pointer"}}>
                              ▶ Start
                            </button>
                          )}
                          <span style={{fontSize:10,fontWeight:700,padding:"4px 10px",borderRadius:4,
                            background:`${statusColors[conn.status]}20`,color:statusColors[conn.status],fontFamily:mono}}>
                            {conn.status.toUpperCase()}
                          </span>
                          {configs.length > 0 && (
                            <span style={{fontSize:12,color:T.textDim,transform:isExpanded?'rotate(180deg)':'rotate(0)',transition:'transform 0.2s'}}>▼</span>
                          )}
                        </div>
                      </div>
                      {isExpanded && configs.length > 0 && (
                        <div style={{padding:"12px 16px 16px 52px",background:`${T.blue}05`,borderTop:`1px solid ${T.border}`}}>
                          <div style={{fontSize:10,fontWeight:700,color:T.textDim,marginBottom:10,letterSpacing:1,fontFamily:mono}}>CONFIGURATION</div>
                          <div style={{display:"flex",flexDirection:"column",gap:10}}>
                            {configs.map(cfg=>(
                              <div key={cfg.key} style={{display:"flex",alignItems:"center",gap:10}}>
                                <label style={{fontSize:11,color:T.textMuted,minWidth:140,fontFamily:mono}}>{cfg.label}</label>
                                <div style={{flex:1,display:"flex",gap:6}}>
                                  <input
                                    type={cfg.type==='password' && !showApiKeys[cfg.key] ? 'password' : 'text'}
                                    value={settings[cfg.key]||''}
                                    onChange={e=>setSettings(prev=>({...prev,[cfg.key]:e.target.value}))}
                                    placeholder={cfg.type==='url'?'https://...':'Enter value...'}
                                    style={{flex:1,background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 10px",color:T.text,fontSize:12,fontFamily:mono}}
                                  />
                                  {cfg.type==='password' && (
                                    <button onClick={()=>setShowApiKeys(prev=>({...prev,[cfg.key]:!prev[cfg.key]}))}
                                      style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"0 10px",color:T.textMuted,fontSize:14,cursor:"pointer"}}>
                                      {showApiKeys[cfg.key]?'🙈':'👁'}
                                    </button>
                                  )}
                                </div>
                              </div>
                            ))}
                            <div style={{fontSize:10,color:T.textDim,marginTop:4}}>
                              💡 Changes are saved automatically. Gateway uses env vars from <code style={{background:T.surface,padding:"2px 4px",borderRadius:3}}>gateway/.env</code> — update there for production.
                            </div>
                            {/* Slack-specific cleanup action */}
                            {key === 'slack' && conn.status === 'connected' && (
                              <div style={{marginTop:12,paddingTop:12,borderTop:`1px solid ${T.border}`}}>
                                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:12}}>
                                  <div>
                                    <div style={{fontSize:11,fontWeight:600,color:T.text}}>🧹 Clean Up Messages</div>
                                    <div style={{fontSize:10,color:T.textMuted}}>
                                      {deleteAllSlackMsgs ? "Delete ALL messages (requires user token)" : "Delete bot messages only"}
                                    </div>
                                  </div>
                                  <div style={{display:"flex",alignItems:"center",gap:8}}>
                                    <label style={{display:"flex",alignItems:"center",gap:6,fontSize:10,color:T.textMuted,cursor:"pointer"}}>
                                      <input type="checkbox" checked={deleteAllSlackMsgs} onChange={e=>setDeleteAllSlackMsgs(e.target.checked)}
                                        style={{width:14,height:14,cursor:"pointer"}} />
                                      Include user msgs
                                    </label>
                                    <button onClick={cleanupSlackMessages} disabled={cleaningSlack}
                                      style={{background:T.red,border:"none",borderRadius:6,padding:"8px 16px",color:"#fff",fontSize:11,fontWeight:700,cursor:"pointer",opacity:cleaningSlack?0.6:1,whiteSpace:"nowrap"}}>
                                      {cleaningSlack ? "Deleting..." : "Delete"}
                                    </button>
                                  </div>
                                </div>
                                {slackCleanResult && (
                                  <div style={{marginTop:8,padding:"8px 10px",borderRadius:6,fontSize:11,
                                    background:slackCleanResult.ok?`${T.green}15`:`${T.red}15`,
                                    color:slackCleanResult.ok?T.green:T.red,fontFamily:mono}}>
                                    {slackCleanResult.ok ? "✓" : "✗"} {slackCleanResult.message}
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </Card>

              {/* DevOps AI Assistant */}
              <DevOpsAICard settings={settings} connections={connections} />

              {/* Help Text */}
              <Card style={{background:`${T.blue}08`,border:`1px solid ${T.blue}30`}}>
                <div style={{fontSize:12,color:T.textMuted,lineHeight:1.6}}>
                  <strong style={{color:T.text}}>Connection Status Guide:</strong><br/>
                  - <span style={{color:T.green}}>Connected</span> — Service is running and reachable<br/>
                  - <span style={{color:T.amber}}>Mock Mode</span> — Using simulated data (credentials not configured)<br/>
                  - <span style={{color:T.red}}>Disconnected</span> — Service is configured but not reachable<br/>
                  - <span style={{color:T.textMuted}}>Unconfigured</span> — Environment variables not set
                </div>
              </Card>
            </>
          ) : (
            <Card style={{textAlign:"center",padding:40}}>
              <div style={{fontSize:32,marginBottom:10}}>📡</div>
              <div style={{color:T.textMuted}}>Loading connection status...</div>
            </Card>
          )}
        </div>
      )}

      {/* ══ AGENTS ══ */}
      {sub==="agents"&&(
        <AgentsPanel settings={settings} />
      )}

      {/* ══ MCP TOOLS ══ */}
      {sub==="mcptools"&&(
        <div style={{display:"flex",flexDirection:"column",gap:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <div>
              <div style={{fontSize:15,fontWeight:700,color:T.text}}>MCP Tools & Agent Configurations</div>
              <div style={{fontSize:11,color:T.textMuted}}>Browse tools, test them, and see which agents use what</div>
            </div>
            <button onClick={loadMcpData} disabled={loadingMcp}
              style={{background:T.blue,border:"none",borderRadius:8,padding:"8px 16px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",opacity:loadingMcp?0.6:1}}>
              {loadingMcp?"Loading...":"↻ Refresh"}
            </button>
          </div>

          {/* Sub-navigation */}
          <div style={{display:"flex",gap:8}}>
            {[{id:"tools",label:`Tools (${mcpTools.length})`},{id:"agents",label:`Agents (${mcpAgents.length})`},{id:"tester",label:"Tool Tester"},{id:"create",label:"+ New Tool"}].map(v=>(
              <button key={v.id} onClick={()=>setMcpView(v.id)}
                style={{background:mcpView===v.id?T.blueDark:"transparent",border:`1px solid ${mcpView===v.id?T.blue:T.border}`,
                borderRadius:6,padding:"8px 16px",color:mcpView===v.id?T.blue:T.textMuted,fontSize:12,fontWeight:600,cursor:"pointer",fontFamily:mono}}>
                {v.label}
              </button>
            ))}
          </div>

          {/* Tools List */}
          {mcpView==="tools"&&(
            <div>
              <div style={{display:"flex",gap:10,marginBottom:12}}>
                <input placeholder="Search tools..." value={mcpFilter.search} onChange={e=>setMcpFilter(f=>({...f,search:e.target.value}))}
                  style={{flex:1,background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 12px",color:T.text,fontSize:12}}/>
                <select value={mcpFilter.category} onChange={e=>setMcpFilter(f=>({...f,category:e.target.value}))}
                  style={{background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"8px 12px",color:T.text,fontSize:12}}>
                  <option value="all">All Categories</option>
                  {[...new Set(mcpTools.map(t=>t.category))].map(c=>(
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <Card style={{padding:0,maxHeight:500,overflowY:"auto"}}>
                {mcpTools
                  .filter(t=>mcpFilter.category==="all"||t.category===mcpFilter.category)
                  .filter(t=>!mcpFilter.search||t.name.toLowerCase().includes(mcpFilter.search.toLowerCase())||t.description.toLowerCase().includes(mcpFilter.search.toLowerCase()))
                  .map(tool=>(
                  <div key={tool.name} style={{borderBottom:`1px solid ${T.border}`,padding:"12px 16px",cursor:"pointer",background:selectedTool?.name===tool.name?`${T.blue}15`:"transparent"}}
                    onClick={()=>{setSelectedTool(tool);setMcpView("tester");setToolTestInput(JSON.stringify(tool.inputSchema?.properties?Object.fromEntries(Object.keys(tool.inputSchema.properties).map(k=>[k,""])):{},null,2));}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                      <div style={{flex:1}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:13,fontWeight:700,color:T.text,fontFamily:mono}}>{tool.name}</span>
                          <span style={{fontSize:9,background:`${T.blue}20`,color:T.blue,padding:"2px 6px",borderRadius:4,fontFamily:mono}}>{tool.category}</span>
                          {tool.custom&&<span style={{fontSize:8,background:`${T.green}20`,color:T.green,padding:"2px 5px",borderRadius:3,fontFamily:mono}}>CUSTOM</span>}
                        </div>
                        <div style={{fontSize:11,color:T.textMuted,marginTop:4,lineHeight:1.4}}>{tool.description.split('\n')[0].slice(0,120)}...</div>
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:8}}>
                        {tool.custom&&(
                          <button onClick={async(e)=>{
                            e.stopPropagation();
                            if(!confirm(`Delete custom tool "${tool.name}"?`))return;
                            const gwUrl=settings.gatewayUrl||'http://localhost:3001';
                            await fetch(`${gwUrl}/gateway/tools/custom/${tool.name}`,{method:'DELETE'});
                            const resp=await fetch(`${gwUrl}/gateway/tools`,{signal:AbortSignal.timeout(5000)});
                            if(resp.ok){const data=await resp.json();setMcpTools(data.tools||[]);}
                          }} style={{background:`${T.red}20`,border:"none",borderRadius:4,padding:"4px 8px",color:T.red,fontSize:10,cursor:"pointer"}}>
                            Delete
                          </button>
                        )}
                        <span style={{fontSize:10,color:T.textDim}}>→ Test</span>
                      </div>
                    </div>
                  </div>
                ))}
              </Card>
            </div>
          )}

          {/* Agents List */}
          {mcpView==="agents"&&(
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(320px,1fr))",gap:12}}>
              {mcpAgents.map(agent=>(
                <Card key={agent.name} style={{padding:16}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:10}}>
                    <div style={{width:36,height:36,borderRadius:8,background:agent.department?`${T.blue}20`:`${T.purple}20`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16}}>
                      {agent.department?"🏭":"🤖"}
                    </div>
                    <div>
                      <div style={{fontSize:14,fontWeight:700,color:T.text}}>{agent.name}</div>
                      <div style={{fontSize:10,color:T.textMuted,fontFamily:mono}}>{agent.department?`Dept ${agent.department}`:"Cross-department"}</div>
                    </div>
                  </div>
                  <div style={{fontSize:11,color:T.textMuted,marginBottom:10}}>{agent.description}</div>
                  <div style={{fontSize:10,color:T.textDim,fontFamily:mono}}>
                    <span style={{fontWeight:600}}>{agent.tools.length} tools:</span>{" "}
                    {agent.tools.slice(0,5).join(", ")}{agent.tools.length>5?`, +${agent.tools.length-5} more`:""}
                  </div>
                </Card>
              ))}
            </div>
          )}

          {/* Tool Tester */}
          {mcpView==="tester"&&(
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:16}}>
              <Card style={{padding:16}}>
                <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:12}}>Select Tool & Input</div>
                <select value={selectedTool?.name||""} onChange={e=>{const t=mcpTools.find(x=>x.name===e.target.value);setSelectedTool(t);if(t)setToolTestInput(JSON.stringify(t.inputSchema?.properties?Object.fromEntries(Object.keys(t.inputSchema.properties).map(k=>[k,""])):{},null,2));}}
                  style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",color:T.text,fontSize:12,marginBottom:12}}>
                  <option value="">Choose a tool...</option>
                  {mcpTools.map(t=><option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
                {selectedTool&&(
                  <>
                    <div style={{fontSize:11,color:T.textMuted,marginBottom:8,padding:10,background:`${T.blue}10`,borderRadius:6}}>{selectedTool.description.split('\n')[0]}</div>
                    <div style={{fontSize:10,fontWeight:600,color:T.textDim,marginBottom:6,fontFamily:mono}}>INPUT (JSON)</div>
                    <textarea value={toolTestInput} onChange={e=>setToolTestInput(e.target.value)} rows={8}
                      style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:10,color:T.text,fontSize:11,fontFamily:mono,resize:"vertical"}}/>
                    <button onClick={testTool} disabled={testingTool}
                      style={{marginTop:12,width:"100%",background:T.green,border:"none",borderRadius:8,padding:"10px 16px",color:"#fff",fontSize:12,fontWeight:700,cursor:"pointer",opacity:testingTool?0.6:1}}>
                      {testingTool?"Running...":"▶ Run Tool"}
                    </button>
                  </>
                )}
              </Card>
              <Card style={{padding:16}}>
                <div style={{fontSize:12,fontWeight:700,color:T.text,marginBottom:12}}>Result</div>
                {toolTestResult?(
                  <div>
                    <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:10}}>
                      <span style={{fontSize:16}}>{toolTestResult.success?"✅":"❌"}</span>
                      <span style={{fontSize:12,fontWeight:600,color:toolTestResult.success?T.green:T.red}}>{toolTestResult.success?"Success":"Error"}</span>
                      {toolTestResult.durationMs&&<span style={{fontSize:10,color:T.textDim,fontFamily:mono}}>{toolTestResult.durationMs}ms</span>}
                    </div>
                    <div style={{background:T.surface,borderRadius:6,padding:12,maxHeight:350,overflowY:"auto"}}>
                      <pre style={{margin:0,fontSize:10,color:T.text,fontFamily:mono,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>
                        {JSON.stringify(toolTestResult.result||toolTestResult.error,null,2)}
                      </pre>
                    </div>
                  </div>
                ):(
                  <div style={{padding:40,textAlign:"center",color:T.textDim}}>
                    <div style={{fontSize:32,marginBottom:10}}>🧪</div>
                    <div style={{fontSize:12}}>Select a tool and run it to see results</div>
                  </div>
                )}
              </Card>
            </div>
          )}

          {/* Create Tool Form */}
          {mcpView==="create"&&(
            <Card style={{padding:20}}>
              <div style={{fontSize:14,fontWeight:700,color:T.text,marginBottom:16}}>Create Custom Tool</div>
              <div style={{display:"flex",flexDirection:"column",gap:14}}>
                <div>
                  <label style={{fontSize:11,color:T.textMuted,display:"block",marginBottom:4}}>Tool Name *</label>
                  <input value={newTool.name} onChange={e=>setNewTool(t=>({...t,name:e.target.value.replace(/[^a-z0-9_]/gi,'_').toLowerCase()}))}
                    placeholder="my_custom_tool" style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",color:T.text,fontSize:13,fontFamily:mono}}/>
                </div>
                <div>
                  <label style={{fontSize:11,color:T.textMuted,display:"block",marginBottom:4}}>Category</label>
                  <select value={newTool.category} onChange={e=>setNewTool(t=>({...t,category:e.target.value}))}
                    style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",color:T.text,fontSize:13}}>
                    <option value="Custom">Custom</option>
                    <option value="WIP & Jobs">WIP & Jobs</option>
                    <option value="Reports">Reports</option>
                    <option value="Inventory">Inventory</option>
                    <option value="Maintenance">Maintenance</option>
                    <option value="Generic">Generic</option>
                  </select>
                </div>
                <div>
                  <label style={{fontSize:11,color:T.textMuted,display:"block",marginBottom:4}}>Description *</label>
                  <textarea value={newTool.description} onChange={e=>setNewTool(t=>({...t,description:e.target.value}))}
                    placeholder="Describe when to use this tool, what it does, and what it returns..."
                    rows={4} style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",color:T.text,fontSize:12,resize:"vertical",fontFamily:"inherit"}}/>
                </div>
                <div>
                  <label style={{fontSize:11,color:T.textMuted,display:"block",marginBottom:4}}>Input Schema (JSON)</label>
                  <textarea value={newTool.input_schema} onChange={e=>setNewTool(t=>({...t,input_schema:e.target.value}))}
                    placeholder='{"type":"object","properties":{"param1":{"type":"string","description":"..."}}}'
                    rows={6} style={{width:"100%",background:T.surface,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",color:T.text,fontSize:11,resize:"vertical",fontFamily:mono}}/>
                </div>
                <div style={{display:"flex",gap:10,marginTop:4}}>
                  <button disabled={!newTool.name||!newTool.description||savingTool}
                    onClick={async()=>{
                      setSavingTool(true);
                      try{
                        const gwUrl=settings.gatewayUrl||'http://localhost:3001';
                        let schema={type:"object",properties:{}};
                        try{schema=JSON.parse(newTool.input_schema);}catch{}
                        const resp=await fetch(`${gwUrl}/gateway/tools/custom`,{
                          method:'POST',
                          headers:{'Content-Type':'application/json'},
                          body:JSON.stringify({name:newTool.name,description:newTool.description,category:newTool.category,input_schema:schema})
                        });
                        if(resp.ok){
                          setNewTool({name:"",description:"",category:"Custom",input_schema:"{}"});
                          setMcpView("tools");
                          // Refresh tools list
                          const toolsResp=await fetch(`${gwUrl}/gateway/tools`,{signal:AbortSignal.timeout(5000)});
                          if(toolsResp.ok){const data=await toolsResp.json();setMcpTools(data.tools||[]);}
                        }
                      }catch(e){console.error(e);}
                      setSavingTool(false);
                    }}
                    style={{flex:1,background:T.blue,border:"none",borderRadius:8,padding:"12px 20px",color:"#fff",fontSize:13,fontWeight:700,cursor:(!newTool.name||!newTool.description||savingTool)?"not-allowed":"pointer",opacity:(!newTool.name||!newTool.description||savingTool)?0.5:1}}>
                    {savingTool?"Saving...":"Create Tool"}
                  </button>
                  <button onClick={()=>{setNewTool({name:"",description:"",category:"Custom",input_schema:"{}"});setMcpView("tools");}}
                    style={{background:"transparent",border:`1px solid ${T.border}`,borderRadius:8,padding:"12px 20px",color:T.textMuted,fontSize:13,cursor:"pointer"}}>
                    Cancel
                  </button>
                </div>
              </div>
            </Card>
          )}
        </div>
      )}

      {/* ══ DATA IMPORT ══ */}
      {sub==="dataimport"&&(
        <DataImportPanel settings={settings} />
      )}

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
                  <div style={{fontSize:11,color:T.textMuted}}>{settings.pinEnabled ? `PIN: ${'*'.repeat(settings.pin?.length || 4)}` : 'No PIN configured'}</div>
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

export default SettingsTab;
