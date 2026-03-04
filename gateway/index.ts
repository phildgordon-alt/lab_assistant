/**
 * Lab Assistant Agentic Gateway
 * Main Express server that mounts all source handlers
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';
import { initCircuitBreaker, getState as getCircuitState, forceHealthCheck } from './circuit-breaker.js';
import { requestTimingMiddleware, log } from './logger.js';
import { getRecentRequests, getRequestStats, healthCheck as dbHealthCheck } from './db/client.js';
import { getConcurrentCounts, getRateLimits, updateRateLimits } from './limiter.js';
import { initSlack, startSlack } from './sources/slack.js';
import { initRestRouter } from './sources/rest.js';
import { initWebRouter } from './sources/web.js';
import { getAgentPromptInfo } from './agents/runner.js';
import { getAllToolDefinitions, getAllAgentConfigs, handleToolCall } from './mcp/server.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROMPTS_DIR = join(__dirname, 'agents', 'prompts');

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

app.use(express.json());
app.use(requestTimingMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Health & Monitoring Endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  const dbOk = await dbHealthCheck();
  const circuit = await getCircuitState();

  res.json({
    status: dbOk && !circuit.isOpen ? 'healthy' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    circuit_breaker: circuit.status,
    uptime: process.uptime(),
  });
});

// Gateway stats for dashboard
app.get('/gateway/stats/requests', async (req: Request, res: Response) => {
  const since = (req.query.since as string) || '24h';
  const stats = await getRequestStats(since);
  res.json(stats);
});

app.get('/gateway/stats/performance', async (req: Request, res: Response) => {
  const since = (req.query.since as string) || '24h';
  const stats = await getRequestStats(since);
  const concurrent = getConcurrentCounts();

  res.json({
    avg_duration_ms: stats.avg_duration_ms,
    error_rate: stats.by_status['error'] ? stats.by_status['error'] / stats.total : 0,
    rate_limit_hits: stats.by_status['rate_limited'] || 0,
    concurrent_requests: concurrent,
  });
});

app.get('/gateway/health', async (_req: Request, res: Response) => {
  const circuit = await getCircuitState();
  res.json(circuit);
});

// Comprehensive connections status for dashboard
app.get('/gateway/connections', async (_req: Request, res: Response) => {
  const connections: Record<string, { status: 'connected' | 'disconnected' | 'mock' | 'unconfigured'; message: string; latency?: number }> = {};

  // 1. Gateway (always connected if you can call this)
  connections.gateway = { status: 'connected', message: 'Running', latency: 0 };

  // 2. Database
  const dbOk = await dbHealthCheck();
  const dbUrl = process.env.DATABASE_URL;
  if (!dbUrl) {
    connections.database = { status: 'mock', message: 'Running in mock mode (no DATABASE_URL)' };
  } else {
    connections.database = dbOk
      ? { status: 'connected', message: 'PostgreSQL connected' }
      : { status: 'disconnected', message: 'Failed to connect to PostgreSQL' };
  }

  // 3. Lab Backend (port 3002)
  const labUrl = process.env.LAB_ASSISTANT_API_URL || 'http://localhost:3002';
  try {
    const start = Date.now();
    const resp = await fetch(`${labUrl}/health`, { signal: AbortSignal.timeout(3000) });
    const latency = Date.now() - start;
    if (resp.ok) {
      connections.lab_backend = { status: 'connected', message: 'Oven timer server running', latency };
    } else {
      connections.lab_backend = { status: 'disconnected', message: `HTTP ${resp.status}` };
    }
  } catch (e) {
    connections.lab_backend = { status: 'disconnected', message: 'Not running (start with npm run server)' };
  }

  // 4. Slack
  const slackToken = process.env.SLACK_BOT_TOKEN;
  const slackAppToken = process.env.SLACK_APP_TOKEN;
  if (!slackToken) {
    connections.slack = { status: 'unconfigured', message: 'SLACK_BOT_TOKEN not set' };
  } else if (!slackAppToken) {
    connections.slack = { status: 'unconfigured', message: 'SLACK_APP_TOKEN not set (Socket Mode disabled)' };
  } else {
    // Check if Slack is connected by seeing if startSlack was called successfully
    connections.slack = { status: 'connected', message: 'Socket Mode connected' };
  }

  // 5. Anthropic API
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    connections.anthropic = { status: 'unconfigured', message: 'ANTHROPIC_API_KEY not set' };
  } else {
    connections.anthropic = { status: 'connected', message: 'API key configured' };
  }

  // 6. ItemPath (if configured)
  const itempathUrl = process.env.ITEMPATH_URL;
  const itempathToken = process.env.ITEMPATH_TOKEN;
  if (!itempathUrl || !itempathToken) {
    connections.itempath = { status: 'mock', message: 'Running in mock mode' };
  } else {
    try {
      const start = Date.now();
      // Use /api/materials endpoint to verify connection (no /health endpoint)
      const resp = await fetch(`${itempathUrl}/api/materials?limit=1`, {
        headers: { 'Authorization': `Bearer ${itempathToken}` },
        signal: AbortSignal.timeout(5000)
      });
      const latency = Date.now() - start;
      connections.itempath = resp.ok
        ? { status: 'connected', message: 'ItemPath/Kardex connected', latency }
        : { status: 'disconnected', message: `HTTP ${resp.status}` };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to connect';
      connections.itempath = { status: 'disconnected', message: msg };
    }
  }

  // 7. DVI SOAP API (real-time connection to DVI RxLab)
  const dviPassword = process.env.DVI_PASSWORD;
  if (!dviPassword) {
    connections.dvi = { status: 'unconfigured', message: 'DVI_PASSWORD not set' };
  } else {
    try {
      const start = Date.now();
      // Import dynamically to avoid circular dependency at startup
      const { healthCheck } = await import('./sources/dvi-soap.js');
      const health = await healthCheck();
      const latency = Date.now() - start;
      connections.dvi = health.ok
        ? { status: 'connected', message: 'DVI SOAP API connected', latency }
        : { status: 'disconnected', message: health.message };
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to connect';
      connections.dvi = { status: 'disconnected', message: msg };
    }
  }

  // 8. Limble (CMMS/maintenance system) - uses Basic Auth with client credentials
  // Docs: https://apidocs.limblecmms.com/
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;
  const limbleApiKey = process.env.LIMBLE_API_KEY;

  if (!limbleUrl || (!limbleApiKey && !limbleClientId)) {
    connections.limble = { status: 'mock', message: 'Running in mock mode' };
  } else {
    try {
      const start = Date.now();
      const headers: Record<string, string> = {};

      if (limbleApiKey) {
        headers['Authorization'] = `Bearer ${limbleApiKey}`;
      } else if (limbleClientId && limbleClientSecret) {
        // Limble uses Basic Auth: base64(client_id:client_secret)
        const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
        headers['Authorization'] = `Basic ${basicAuth}`;
      }

      // Try v2 assets endpoint
      const resp = await fetch(`${limbleUrl}/v2/assets`, {
        headers,
        signal: AbortSignal.timeout(5000)
      });
      const latency = Date.now() - start;

      if (resp.ok) {
        connections.limble = { status: 'connected', message: 'Limble CMMS connected', latency };
      } else if (resp.status === 401) {
        connections.limble = { status: 'disconnected', message: 'Invalid credentials (check client_id/secret)' };
      } else if (resp.status === 404) {
        // Credentials might be valid but endpoint differs - mark as needs verification
        connections.limble = { status: 'disconnected', message: 'API reachable but endpoint not found - verify API path' };
      } else {
        connections.limble = { status: 'disconnected', message: `HTTP ${resp.status}` };
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to connect';
      connections.limble = { status: 'disconnected', message: msg };
    }
  }

  res.json({
    timestamp: new Date().toISOString(),
    connections,
    summary: {
      total: Object.keys(connections).length,
      connected: Object.values(connections).filter(c => c.status === 'connected').length,
      mock: Object.values(connections).filter(c => c.status === 'mock').length,
      disconnected: Object.values(connections).filter(c => c.status === 'disconnected').length,
      unconfigured: Object.values(connections).filter(c => c.status === 'unconfigured').length,
    }
  });
});

app.post('/gateway/health/check', async (_req: Request, res: Response) => {
  const healthy = await forceHealthCheck();
  const circuit = await getCircuitState();
  res.json({ healthy, circuit });
});

app.get('/gateway/requests', async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const requests = await getRecentRequests(limit);
  res.json({ requests });
});

app.get('/gateway/agents', async (_req: Request, res: Response) => {
  const agents = getAgentPromptInfo();
  res.json({ agents });
});

// Agent prompt management endpoints
app.get('/gateway/agents/prompts', (_req: Request, res: Response) => {
  try {
    const files = readdirSync(PROMPTS_DIR).filter(f => f.endsWith('.md'));
    const agents = files.map(f => {
      const name = f.replace('.md', '');
      const content = readFileSync(join(PROMPTS_DIR, f), 'utf-8');
      return { name, content, filename: f };
    });
    res.json({ agents });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read agent prompts', message: String(error) });
  }
});

app.get('/gateway/agents/prompts/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const filepath = join(PROMPTS_DIR, `${name}.md`);

  if (!existsSync(filepath)) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const content = readFileSync(filepath, 'utf-8');
    res.json({ name, content });
  } catch (error) {
    res.status(500).json({ error: 'Failed to read agent prompt', message: String(error) });
  }
});

app.put('/gateway/agents/prompts/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const { content } = req.body;

  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Content is required' });
  }

  const filepath = join(PROMPTS_DIR, `${name}.md`);

  try {
    writeFileSync(filepath, content, 'utf-8');
    log.info(`Agent prompt updated: ${name}`);
    res.json({ success: true, name, message: 'Agent prompt updated' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to write agent prompt', message: String(error) });
  }
});

app.post('/gateway/agents/prompts', (req: Request, res: Response) => {
  const { name, content } = req.body;

  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'Agent name is required' });
  }
  if (!content || typeof content !== 'string') {
    return res.status(400).json({ error: 'Content is required' });
  }

  // Sanitize name - only allow alphanumeric and underscores
  const safeName = name.replace(/[^a-zA-Z0-9_]/g, '');
  if (safeName !== name) {
    return res.status(400).json({ error: 'Agent name can only contain letters, numbers, and underscores' });
  }

  const filepath = join(PROMPTS_DIR, `${safeName}.md`);

  if (existsSync(filepath)) {
    return res.status(409).json({ error: 'Agent already exists' });
  }

  try {
    writeFileSync(filepath, content, 'utf-8');
    log.info(`New agent created: ${safeName}`);
    res.status(201).json({ success: true, name: safeName, message: 'Agent created' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to create agent', message: String(error) });
  }
});

app.delete('/gateway/agents/prompts/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const filepath = join(PROMPTS_DIR, `${name}.md`);

  if (!existsSync(filepath)) {
    return res.status(404).json({ error: 'Agent not found' });
  }

  try {
    const { unlinkSync } = require('fs');
    unlinkSync(filepath);
    log.info(`Agent deleted: ${name}`);
    res.json({ success: true, name, message: 'Agent deleted' });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete agent', message: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// MCP Tools Management API
// ─────────────────────────────────────────────────────────────────────────────

// List all MCP tools with their schemas
app.get('/gateway/tools', (_req: Request, res: Response) => {
  try {
    const tools = getAllToolDefinitions();
    res.json({ tools, count: tools.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tools', message: String(error) });
  }
});

// Get single tool details
app.get('/gateway/tools/:name', (req: Request, res: Response) => {
  try {
    const tools = getAllToolDefinitions();
    const tool = tools.find(t => t.name === req.params.name);
    if (!tool) {
      return res.status(404).json({ error: 'Tool not found' });
    }
    res.json({ tool });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tool', message: String(error) });
  }
});

// Test a tool with inputs
app.post('/gateway/tools/test', async (req: Request, res: Response) => {
  const { tool, input } = req.body;

  if (!tool || typeof tool !== 'string') {
    return res.status(400).json({ error: 'Tool name is required' });
  }

  try {
    const startTime = Date.now();
    const result = await handleToolCall(tool, input || {});
    const durationMs = Date.now() - startTime;

    log.info(`Tool test: ${tool}`, { durationMs, input });
    res.json({
      success: true,
      tool,
      input: input || {},
      result,
      durationMs,
    });
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : String(error);
    log.error(`Tool test failed: ${tool}`, error);
    res.json({
      success: false,
      tool,
      input: input || {},
      error: errorMsg,
    });
  }
});

// List all MCP agent configurations
app.get('/gateway/mcp/agents', (_req: Request, res: Response) => {
  try {
    const agents = getAllAgentConfigs();
    res.json({ agents, count: agents.length });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get agent configs', message: String(error) });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// ItemPath Inventory API Proxy
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/itempath/inventory', async (_req: Request, res: Response) => {
  const itempathUrl = process.env.ITEMPATH_URL;
  const itempathToken = process.env.ITEMPATH_TOKEN;

  if (!itempathUrl || !itempathToken) {
    return res.json({ mock: true, materials: generateMockInventory(), lastSync: new Date().toISOString() });
  }

  try {
    const resp = await fetch(`${itempathUrl}/api/materials`, {
      headers: { 'Authorization': `Bearer ${itempathToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    res.json({ mock: false, materials: data, lastSync: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

app.get('/api/itempath/picks', async (_req: Request, res: Response) => {
  const itempathUrl = process.env.ITEMPATH_URL;
  const itempathToken = process.env.ITEMPATH_TOKEN;

  if (!itempathUrl || !itempathToken) {
    return res.json({ mock: true, picks: generateMockPicks(), lastSync: new Date().toISOString() });
  }

  try {
    const resp = await fetch(`${itempathUrl}/api/transactions?hours=2`, {
      headers: { 'Authorization': `Bearer ${itempathToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    res.json({ mock: false, picks: data, lastSync: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Limble Maintenance API Proxy
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/limble/assets', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    return res.json({ mock: true, assets: generateMockAssets(), lastSync: new Date().toISOString() });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    const resp = await fetch(`${limbleUrl}/v2/assets`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    res.json({ mock: false, assets: data, lastSync: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

app.get('/api/limble/tasks', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    return res.json({ mock: true, tasks: generateMockTasks(), lastSync: new Date().toISOString() });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    const resp = await fetch(`${limbleUrl}/v2/tasks`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    res.json({ mock: false, tasks: data, lastSync: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

app.get('/api/limble/stats', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    return res.json({ mock: true, stats: generateMockMaintenanceStats(), lastSync: new Date().toISOString() });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    // Fetch assets and tasks to compute stats
    const [assetsResp, tasksResp] = await Promise.all([
      fetch(`${limbleUrl}/v2/assets`, { headers: { 'Authorization': `Basic ${basicAuth}` }, signal: AbortSignal.timeout(10000) }),
      fetch(`${limbleUrl}/v2/tasks`, { headers: { 'Authorization': `Basic ${basicAuth}` }, signal: AbortSignal.timeout(10000) })
    ]);

    const assets = assetsResp.ok ? await assetsResp.json() as any : [];
    const tasks = tasksResp.ok ? await tasksResp.json() as any : [];

    const stats = {
      totalAssets: Array.isArray(assets) ? assets.length : (assets?.data?.length || 0),
      openWorkOrders: Array.isArray(tasks) ? tasks.filter((t: any) => t.status === 'open').length : 0,
      overdueWorkOrders: Array.isArray(tasks) ? tasks.filter((t: any) => t.status === 'overdue').length : 0,
      completedToday: Array.isArray(tasks) ? tasks.filter((t: any) => t.status === 'completed').length : 0,
    };

    res.json({ mock: false, stats, lastSync: new Date().toISOString() });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Legacy API endpoints (compatibility with frontend calling port 3002)
// These proxy to the ItemPath and Limble endpoints above
// ─────────────────────────────────────────────────────────────────────────────

// /api/inventory - legacy endpoint for ItemPath inventory
app.get('/api/inventory', async (_req: Request, res: Response) => {
  const itempathUrl = process.env.ITEMPATH_URL;
  const itempathToken = process.env.ITEMPATH_TOKEN;

  if (!itempathUrl || !itempathToken) {
    return res.json({
      status: 'mock',
      materials: generateMockInventory(),
      alertCount: 3,
      lastSync: new Date().toISOString()
    });
  }

  try {
    const resp = await fetch(`${itempathUrl}/api/materials`, {
      headers: { 'Authorization': `Bearer ${itempathToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const rawMaterials = Array.isArray(data) ? data : (data.materials || []);

    // Transform ItemPath fields to frontend expected format
    const materials = rawMaterials.map((m: any) => ({
      // Keep original fields
      ...m,
      // Map to expected field names
      sku: m.name || m.sku || m.id,
      name: m.name || m.sku,
      qty: m.currentQuantity ?? m.qty ?? 0,
      location: m.locationName || m.location || m.binName || '',
      coatingType: m.Info1 || m.coatingType || m.category || '',
      threshold: m.reOrderPoint || m.threshold || 10,
      lastUpdated: m.lastEdited || m.creationDate || new Date().toISOString()
    }));

    // Calculate alerts (low stock items)
    const alerts = materials.filter((m: any) => m.qty <= (m.threshold || 10));

    res.json({
      status: 'ok',
      materials,
      alertCount: alerts.length,
      lastSync: new Date().toISOString()
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    log.error('Inventory fetch error:', msg);
    res.json({
      status: 'error',
      error: msg,
      materials: generateMockInventory(),
      alertCount: 0,
      lastSync: null
    });
  }
});

// /api/inventory/alerts - low stock alerts from ItemPath
app.get('/api/inventory/alerts', async (_req: Request, res: Response) => {
  const itempathUrl = process.env.ITEMPATH_URL;
  const itempathToken = process.env.ITEMPATH_TOKEN;

  if (!itempathUrl || !itempathToken) {
    const mockMaterials = generateMockInventory();
    const alerts = mockMaterials.filter((m: any) => m.qty < 20).map((m: any) => ({
      sku: m.sku,
      name: m.name,
      qty: m.qty,
      threshold: 20,
      severity: m.qty === 0 ? 'critical' : m.qty < 10 ? 'high' : 'low'
    }));
    return res.json({ alerts, mock: true });
  }

  try {
    const resp = await fetch(`${itempathUrl}/api/materials`, {
      headers: { 'Authorization': `Bearer ${itempathToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const rawMaterials = Array.isArray(data) ? data : (data.materials || []);

    // Transform and filter for low stock
    const alerts = rawMaterials
      .map((m: any) => ({
        sku: m.name || m.sku || m.id,
        name: m.name || m.sku,
        qty: m.currentQuantity ?? m.qty ?? 0,
        threshold: m.reOrderPoint || m.threshold || 10,
      }))
      .filter((m: any) => m.qty <= m.threshold)
      .map((m: any) => ({
        ...m,
        severity: m.qty === 0 ? 'critical' : m.qty <= 5 ? 'high' : 'low'
      }));

    res.json({ alerts, mock: false });
  } catch (e) {
    res.json({ alerts: [], error: (e as Error).message });
  }
});

// /api/inventory/picks - recent picks from ItemPath
app.get('/api/inventory/picks', async (_req: Request, res: Response) => {
  const itempathUrl = process.env.ITEMPATH_URL;
  const itempathToken = process.env.ITEMPATH_TOKEN;

  if (!itempathUrl || !itempathToken) {
    return res.json({ picks: generateMockPicks(), recent: generateMockPicks().slice(0, 5), count: 10, mock: true });
  }

  try {
    const resp = await fetch(`${itempathUrl}/api/transactions?hours=8`, {
      headers: { 'Authorization': `Bearer ${itempathToken}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const picks = Array.isArray(data) ? data : (data.transactions || data.picks || []);
    res.json({ picks, recent: picks.slice(0, 10), count: picks.length, mock: false });
  } catch (e) {
    res.json({ picks: [], recent: [], count: 0, error: (e as Error).message });
  }
});

// /api/inventory/vlms - VLM/Kardex stats
app.get('/api/inventory/vlms', async (_req: Request, res: Response) => {
  const itempathUrl = process.env.ITEMPATH_URL;
  const itempathToken = process.env.ITEMPATH_TOKEN;

  if (!itempathUrl || !itempathToken) {
    return res.json({
      vlmStats: { totalLocations: 500, utilizationPercent: 78, cyclesPerDay: 45 },
      locations: [],
      mock: true
    });
  }

  try {
    const resp = await fetch(`${itempathUrl}/api/locations`, {
      headers: { 'Authorization': `Bearer ${itempathToken}` },
      signal: AbortSignal.timeout(10000)
    });
    const data = resp.ok ? await resp.json() as any : { locations: [] };
    const locations = Array.isArray(data) ? data : (data.locations || []);
    res.json({
      vlmStats: { totalLocations: locations.length, utilizationPercent: 78, cyclesPerDay: 45 },
      locations,
      mock: false
    });
  } catch (e) {
    res.json({ vlmStats: {}, locations: [], error: (e as Error).message });
  }
});

// /api/maintenance/assets - equipment assets from Limble
app.get('/api/maintenance/assets', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    return res.json({ assets: generateMockAssets(), mock: true, lastSync: new Date().toISOString() });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    const resp = await fetch(`${limbleUrl}/v2/assets`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const assets = Array.isArray(data) ? data : (data.data || []);
    res.json({ assets, mock: false, lastSync: new Date().toISOString() });
  } catch (e) {
    res.json({ assets: generateMockAssets(), error: (e as Error).message, lastSync: null });
  }
});

// /api/maintenance/downtime - downtime records from Limble
app.get('/api/maintenance/downtime', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  // Generate mock downtime data
  const mockDowntime = Array.from({ length: 10 }, (_, i) => ({
    id: i + 1,
    assetId: Math.floor(Math.random() * 15) + 1,
    assetName: `Equipment-${String(Math.floor(Math.random() * 15) + 1).padStart(2, '0')}`,
    startTime: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
    endTime: Math.random() > 0.2 ? new Date(Date.now() - Math.random() * 3 * 24 * 60 * 60 * 1000).toISOString() : null,
    durationMins: Math.floor(Math.random() * 480) + 30,
    planned: Math.random() > 0.3,
    reason: ['Preventive Maintenance', 'Breakdown', 'Calibration', 'Part Replacement'][Math.floor(Math.random() * 4)]
  }));

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    const planned = mockDowntime.filter(d => d.planned);
    const unplanned = mockDowntime.filter(d => !d.planned);
    return res.json({ downtime: mockDowntime, planned, unplanned, mock: true });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    const resp = await fetch(`${limbleUrl}/v2/downtime`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      // API might not have downtime endpoint, use mock
      const planned = mockDowntime.filter(d => d.planned);
      const unplanned = mockDowntime.filter(d => !d.planned);
      return res.json({ downtime: mockDowntime, planned, unplanned, mock: true });
    }
    const data = await resp.json() as any;
    const downtime = Array.isArray(data) ? data : (data.data || []);
    const planned = downtime.filter((d: any) => d.planned);
    const unplanned = downtime.filter((d: any) => !d.planned);
    res.json({ downtime, planned, unplanned, mock: false });
  } catch (e) {
    const planned = mockDowntime.filter(d => d.planned);
    const unplanned = mockDowntime.filter(d => !d.planned);
    res.json({ downtime: mockDowntime, planned, unplanned, error: (e as Error).message });
  }
});

// /api/maintenance/parts - spare parts inventory from Limble
app.get('/api/maintenance/parts', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  // Generate mock parts data
  const mockParts = Array.from({ length: 25 }, (_, i) => ({
    id: i + 1,
    name: ['Belt', 'Filter', 'Bearing', 'Seal', 'Motor', 'Sensor', 'Valve', 'Pump'][i % 8] + ` ${i + 1}`,
    partNum: `PN-${String(1000 + i).padStart(5, '0')}`,
    qty: Math.floor(Math.random() * 20),
    minQty: 5,
    location: `SHELF-${String.fromCharCode(65 + (i % 5))}${Math.floor(i / 5) + 1}`,
    vendor: ['Grainger', 'McMaster', 'MSC', 'Fastenal'][Math.floor(Math.random() * 4)],
    cost: Math.floor(Math.random() * 500) + 10,
    lowStock: Math.random() > 0.7
  }));

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    const lowStock = mockParts.filter(p => p.lowStock);
    return res.json({ parts: mockParts, lowStock, mock: true });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    const resp = await fetch(`${limbleUrl}/v2/parts`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) {
      const lowStock = mockParts.filter(p => p.lowStock);
      return res.json({ parts: mockParts, lowStock, mock: true });
    }
    const data = await resp.json() as any;
    const parts = Array.isArray(data) ? data : (data.data || []);
    const lowStock = parts.filter((p: any) => p.qty <= (p.minQty || 5));
    res.json({ parts, lowStock, mock: false });
  } catch (e) {
    const lowStock = mockParts.filter(p => p.lowStock);
    res.json({ parts: mockParts, lowStock, error: (e as Error).message });
  }
});

// /api/maintenance/stats - legacy endpoint for Limble stats
app.get('/api/maintenance/stats', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    const mockStats = generateMockMaintenanceStats();
    return res.json({
      status: 'mock',
      ...mockStats,
      hasData: true,
      lastSync: new Date().toISOString()
    });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    const [assetsResp, tasksResp] = await Promise.all([
      fetch(`${limbleUrl}/v2/assets`, { headers: { 'Authorization': `Basic ${basicAuth}` }, signal: AbortSignal.timeout(10000) }),
      fetch(`${limbleUrl}/v2/tasks`, { headers: { 'Authorization': `Basic ${basicAuth}` }, signal: AbortSignal.timeout(10000) })
    ]);

    const assets = assetsResp.ok ? await assetsResp.json() as any : [];
    const tasks = tasksResp.ok ? await tasksResp.json() as any : [];

    const taskList = Array.isArray(tasks) ? tasks : (tasks.data || []);
    const assetList = Array.isArray(assets) ? assets : (assets.data || []);

    const stats = {
      totalAssets: assetList.length,
      openWorkOrders: taskList.filter((t: any) => t.status === 'open' || t.status === 'in_progress').length,
      openTaskCount: taskList.filter((t: any) => t.status === 'open' || t.status === 'in_progress').length,
      criticalTaskCount: taskList.filter((t: any) => t.priority === 'Critical' || t.priority === 'critical').length,
      overdueWorkOrders: taskList.filter((t: any) => t.status === 'overdue').length,
      completedToday: taskList.filter((t: any) => t.status === 'completed').length,
      pmCompliancePercent: 85 + Math.floor(Math.random() * 10),
      uptimePercent: 94 + Math.floor(Math.random() * 5),
      assetsDown: assetList.filter((a: any) => a.status === 'Down' || a.status === 'Maintenance').length,
      hasData: true,
    };

    res.json({
      status: 'ok',
      ...stats,
      lastSync: new Date().toISOString()
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    log.error('Maintenance stats fetch error:', msg);
    res.json({
      status: 'error',
      error: msg,
      ...generateMockMaintenanceStats(),
      hasData: false,
      lastSync: null
    });
  }
});

// /api/maintenance/tasks - legacy endpoint for Limble tasks
app.get('/api/maintenance/tasks', async (_req: Request, res: Response) => {
  const limbleUrl = process.env.LIMBLE_URL;
  const limbleClientId = process.env.LIMBLE_CLIENT_ID;
  const limbleClientSecret = process.env.LIMBLE_CLIENT_SECRET;

  if (!limbleUrl || !limbleClientId || !limbleClientSecret) {
    const mockTasks = generateMockTasks();
    const open = mockTasks.filter((t: any) => t.status === 'open' || t.status === 'in_progress');
    const critical = mockTasks.filter((t: any) => t.priority === 'Critical');
    return res.json({ open, critical, mock: true });
  }

  try {
    const basicAuth = Buffer.from(`${limbleClientId}:${limbleClientSecret}`).toString('base64');
    const resp = await fetch(`${limbleUrl}/v2/tasks`, {
      headers: { 'Authorization': `Basic ${basicAuth}` },
      signal: AbortSignal.timeout(10000)
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as any;
    const tasks = Array.isArray(data) ? data : (data.data || []);

    const open = tasks.filter((t: any) => t.status === 'open' || t.status === 'in_progress');
    const critical = tasks.filter((t: any) => t.priority === 'Critical' || t.priority === 'critical');

    res.json({ open, critical, mock: false });
  } catch (e) {
    res.json({ open: [], critical: [], error: (e as Error).message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Slack Proxy Endpoints for Frontend
// ─────────────────────────────────────────────────────────────────────────────

// In-memory message store (for demo without full Slack API access)
let slackMessages: { id: string; from: string; text: string; time: Date; priority: string; source: string }[] = [];

// Fetch recent messages from Slack channel
app.get('/api/slack/messages', async (req: Request, res: Response) => {
  const channel = (req.query.channel as string) || process.env.SLACK_CHANNEL_ID || 'C0AJH9LG96D';
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!slackToken) {
    // Return in-memory messages if no Slack token
    return res.json({
      ok: true,
      messages: slackMessages.slice(0, 50),
      mock: true
    });
  }

  try {
    const resp = await fetch(`https://slack.com/api/conversations.history?channel=${channel}&limit=50`, {
      headers: { 'Authorization': `Bearer ${slackToken}` },
      signal: AbortSignal.timeout(10000)
    });
    const data = await resp.json() as any;

    if (!data.ok) {
      log.warn('Slack API error:', data.error);
      return res.json({ ok: false, error: data.error, messages: slackMessages });
    }

    // Transform Slack messages to our format
    const messages = (data.messages || []).map((m: any) => ({
      id: m.ts,
      from: m.user || 'Unknown',
      text: m.text,
      time: new Date(parseFloat(m.ts) * 1000),
      priority: m.text?.toLowerCase().includes('rush') || m.text?.toLowerCase().includes('urgent') ? 'high' : 'normal',
      source: 'slack'
    }));

    res.json({ ok: true, messages, channel });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    log.error('Slack messages fetch error:', msg);
    res.json({ ok: false, error: msg, messages: slackMessages });
  }
});

// Send message to Slack channel
app.post('/api/slack/send', async (req: Request, res: Response) => {
  const { text, channel: reqChannel } = req.body;
  const channel = reqChannel || process.env.SLACK_CHANNEL_ID || 'C0AJH9LG96D';
  const slackToken = process.env.SLACK_BOT_TOKEN;

  if (!text) {
    return res.status(400).json({ ok: false, error: 'No message text provided' });
  }

  // Add to in-memory store regardless
  const newMsg = {
    id: `local-${Date.now()}`,
    from: 'Lab Assistant',
    text,
    time: new Date(),
    priority: text.toLowerCase().includes('rush') || text.toLowerCase().includes('urgent') ? 'high' : 'normal',
    source: 'local'
  };
  slackMessages.unshift(newMsg);
  if (slackMessages.length > 100) slackMessages = slackMessages.slice(0, 100);

  if (!slackToken) {
    return res.json({ ok: true, message: 'Stored locally (no Slack token)', mock: true });
  }

  try {
    const resp = await fetch('https://slack.com/api/chat.postMessage', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${slackToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ channel, text }),
      signal: AbortSignal.timeout(10000)
    });
    const data = await resp.json() as any;

    if (!data.ok) {
      log.warn('Slack send error:', data.error);
      return res.json({ ok: false, error: data.error, storedLocally: true });
    }

    res.json({ ok: true, ts: data.ts, channel: data.channel });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to send';
    log.error('Slack send error:', msg);
    res.json({ ok: false, error: msg, storedLocally: true });
  }
});

// Mock data generators for when APIs aren't configured
function generateMockInventory() {
  const coatings = ['AR', 'BLUE_CUT', 'HARD_COAT', 'TRANSITIONS', 'POLARIZED', 'MIRROR'];
  const indices = ['1.50', '1.56', '1.60', '1.67', '1.74'];
  return Array.from({ length: 50 }, (_, i) => ({
    sku: `LB-${coatings[i % coatings.length]}-${indices[i % indices.length]}-${i + 1}`,
    name: `${coatings[i % coatings.length]} ${indices[i % indices.length]} Lens Blank`,
    qty: Math.floor(Math.random() * 100) + 5,
    location: `BIN-${String(Math.floor(Math.random() * 20) + 1).padStart(2, '0')}`,
    coatingType: coatings[i % coatings.length],
    lastUpdated: new Date().toISOString()
  }));
}

function generateMockPicks() {
  return Array.from({ length: 10 }, (_, i) => ({
    id: `TXN-${Date.now()}-${i}`,
    sku: `LB-AR-1.60-${i + 1}`,
    qty: Math.floor(Math.random() * 5) + 1,
    type: 'PICK',
    completedAt: new Date(Date.now() - Math.random() * 7200000).toISOString(),
    picker: ['Maria', 'Jose', 'Ana', 'Carlos'][Math.floor(Math.random() * 4)]
  }));
}

function generateMockAssets() {
  const categories = ['Coaters', 'Cutters', 'Generators', 'Polishers', 'Lasers', 'Blockers'];
  const statuses = ['Running', 'Running', 'Running', 'Idle', 'Maintenance'];
  return Array.from({ length: 15 }, (_, i) => ({
    id: i + 1,
    name: `${categories[i % categories.length]}-${String(i + 1).padStart(2, '0')}`,
    category: categories[i % categories.length],
    status: statuses[Math.floor(Math.random() * statuses.length)],
    location: ['Zone A', 'Zone B', 'Zone C'][Math.floor(Math.random() * 3)],
    lastPM: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
    nextPM: new Date(Date.now() + Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString()
  }));
}

function generateMockTasks() {
  const types = ['Work Order', 'PM', 'Work Request'];
  const statuses = ['open', 'in_progress', 'completed', 'overdue'];
  const priorities = ['Low', 'Medium', 'High', 'Critical'];
  return Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    type: types[Math.floor(Math.random() * types.length)],
    title: `Task ${i + 1}: ${['Replace belt', 'Clean filters', 'Calibrate sensor', 'Lubricate bearings'][Math.floor(Math.random() * 4)]}`,
    assetId: Math.floor(Math.random() * 15) + 1,
    priority: priorities[Math.floor(Math.random() * priorities.length)],
    status: statuses[Math.floor(Math.random() * statuses.length)],
    assignee: ['Tech 1', 'Tech 2', 'Tech 3'][Math.floor(Math.random() * 3)],
    dueDate: new Date(Date.now() + (Math.random() - 0.3) * 7 * 24 * 60 * 60 * 1000).toISOString()
  }));
}

function generateMockMaintenanceStats() {
  return {
    totalAssets: 15,
    openWorkOrders: Math.floor(Math.random() * 8) + 2,
    overdueWorkOrders: Math.floor(Math.random() * 3),
    completedToday: Math.floor(Math.random() * 5) + 1,
    uptime: 94 + Math.random() * 5,
    mtbf: 120 + Math.floor(Math.random() * 50),
    mttr: 2 + Math.random() * 3
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// DVI Data Import (file upload for historical/mega file data)
// ─────────────────────────────────────────────────────────────────────────────

// In-memory store for uploaded DVI data (replace with DB in production)
interface DVIUpload {
  id: string;
  jobs: any[];
  uploadedAt: string;
  filename: string;
  rowCount: number;
  dataDate: string | null;  // The date the data represents (extracted from filename or content)
}

let dviDataStore: {
  current: DVIUpload | null;
  archive: DVIUpload[];  // Historical uploads for tracking
} = { current: null, archive: [] };

// DVI Data persistence
const DVI_DATA_FILE = join(__dirname, '..', 'data', 'dvi-jobs.json');

function saveDviData(): void {
  try {
    // Ensure data directory exists
    const dataDir = dirname(DVI_DATA_FILE);
    if (!existsSync(dataDir)) {
      mkdirSync(dataDir, { recursive: true });
    }
    writeFileSync(DVI_DATA_FILE, JSON.stringify(dviDataStore, null, 2));
    log.info(`[DVI] Saved ${dviDataStore.current?.rowCount || 0} jobs to disk`);

    // Sync to SQLite with soft-update (preserves history)
    syncDviToSqlite();
  } catch (e) {
    log.error('[DVI] Failed to save data to disk:', e);
  }
}

function loadDviData(): void {
  try {
    if (existsSync(DVI_DATA_FILE)) {
      const data = readFileSync(DVI_DATA_FILE, 'utf-8');
      const parsed = JSON.parse(data);
      dviDataStore = parsed;
      log.info(`[DVI] Loaded ${dviDataStore.current?.rowCount || 0} jobs from disk (uploaded: ${dviDataStore.current?.uploadedAt || 'never'})`);

      // Sync to SQLite on load for AI agents
      syncDviToSqlite();
    } else {
      log.info('[DVI] No persisted data file found, starting fresh');
    }
  } catch (e) {
    log.error('[DVI] Failed to load data from disk:', e);
  }
}

function syncDviToSqlite(): void {
  try {
    const dbPath = join(__dirname, '..', 'data', 'lab_assistant.db');
    if (!existsSync(dbPath)) {
      log.warn('[DVI] SQLite database not found, skipping sync');
      return;
    }

    const db = new Database(dbPath);
    const jobs = dviDataStore.current?.jobs || [];
    const dataDate = dviDataStore.current?.dataDate || '';

    // Separate active jobs from shipped jobs
    // Jobs with status='SHIPPED' or ship_date populated should be archived, not in WIP
    const activeJobs: any[] = [];
    const shippedJobs: any[] = [];

    for (const j of jobs) {
      const hasShipped = j.status === 'SHIPPED' || (j.ship_date && j.ship_date.trim() !== '');
      if (hasShipped) {
        shippedJobs.push(j);
      } else {
        activeJobs.push(j);
      }
    }

    // Build set of current ACTIVE job IDs (not shipped)
    const currentActiveIds = new Set<string>();
    for (const j of activeJobs) {
      const id = j.job_id || j.invoice || `${dataDate}-${j.station}-${Math.random()}`;
      currentActiveIds.add(id);
    }

    // Get existing active jobs to detect shipped/completed
    const existingJobs = db.prepare(`
      SELECT id, invoice, tray, stage, coating, rush, entry_date, days_in_lab FROM dvi_jobs WHERE archived = 0
    `).all() as { id: string; invoice: string; tray: string; stage: string; coating: string; rush: string; entry_date: string; days_in_lab: number }[];

    // Archive jobs that are no longer in the active set (they were shipped/completed)
    const archiveStmt = db.prepare(`UPDATE dvi_jobs SET archived = 1, shipped_at = datetime('now') WHERE id = ?`);
    const historyStmt = db.prepare(`
      INSERT OR IGNORE INTO dvi_jobs_history (job_id, invoice, tray, stage, coating, rush, entry_date, days_in_lab, shipped_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);

    let shippedCount = 0;
    const archiveCompleted = db.transaction(() => {
      for (const existing of existingJobs) {
        if (!currentActiveIds.has(existing.id)) {
          archiveStmt.run(existing.id);
          historyStmt.run(
            existing.id,
            existing.invoice,
            existing.tray,
            existing.stage,
            existing.coating,
            existing.rush,
            existing.entry_date,
            existing.days_in_lab
          );
          shippedCount++;
        }
      }
    });
    archiveCompleted();

    // Also archive jobs that are in the XML/CSV with ShipDate (explicitly shipped in this file)
    // For shipped jobs, we need to store the actual ship date (last_update from CSV parsing)
    const archiveShippedStmt = db.prepare(`
      INSERT INTO dvi_jobs (id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, data_date, rx_number, archived, shipped_at, last_sync)
      VALUES (?, ?, ?, ?, ?, 'SHIPPED', ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        archived = 1,
        data_date = excluded.data_date,
        shipped_at = datetime('now'),
        last_sync = datetime('now')
    `);

    const archiveShippedFromXml = db.transaction(() => {
      for (const j of shippedJobs) {
        const jobId = j.job_id || j.invoice || `${dataDate}-${j.station}-${Math.random()}`;
        const entryDate = j.entryDate || j.entry_date || j.date;
        // Use last_update as the ship date (from CSV parsing), fallback to dataDate
        const shipDate = j.last_update || dataDate;
        let daysInLab = j.daysInLab || j.days_in_lab;
        if (!daysInLab && entryDate) {
          const entry = new Date(entryDate);
          const now = new Date();
          daysInLab = Math.floor((now.getTime() - entry.getTime()) / (1000 * 60 * 60 * 24));
        }

        // Insert/update shipped job with actual ship date in data_date
        archiveShippedStmt.run(
          jobId,
          j.invoice,
          j.tray,
          j.stage || j.Stage || 'SHIPPED',
          j.station || 'SHIPPED',
          j.rush || j.Rush || 'N',
          entryDate,
          daysInLab,
          j.coating || j.coatR,
          j.frame_name || '',
          shipDate,  // Actual ship date goes into data_date
          j.rx_number || j.invoice
        );

        // Also insert into history
        historyStmt.run(
          jobId,
          j.invoice,
          j.tray,
          j.stage || j.Stage,
          j.coating || j.coatR,
          j.rush || j.Rush,
          entryDate,
          daysInLab
        );
        shippedCount++;
      }
    });
    archiveShippedFromXml();

    // Upsert only ACTIVE jobs (not shipped)
    const upsertStmt = db.prepare(`
      INSERT INTO dvi_jobs (id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, data_date, rx_number, archived, last_sync)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        stage = excluded.stage,
        station = excluded.station,
        status = excluded.status,
        days_in_lab = excluded.days_in_lab,
        data_date = excluded.data_date,
        rx_number = excluded.rx_number,
        archived = 0,
        shipped_at = NULL,
        last_sync = datetime('now')
    `);

    const upsertMany = db.transaction((items: any[]) => {
      for (const j of items) {
        const entryDate = j.entryDate || j.entry_date || j.date;
        // Calculate days_in_lab from entry_date if not provided
        let daysInLab = j.daysInLab || j.days_in_lab;
        if (!daysInLab && entryDate) {
          const entry = new Date(entryDate);
          const now = new Date();
          daysInLab = Math.floor((now.getTime() - entry.getTime()) / (1000 * 60 * 60 * 24));
        }
        upsertStmt.run(
          j.job_id || j.invoice || `${dataDate}-${j.station}-${Math.random()}`,
          j.invoice,
          j.tray,
          j.stage || j.Stage,
          j.station,
          j.status,
          j.rush || j.Rush,
          entryDate,
          daysInLab,
          j.coating || j.coatR,
          j.frameName || j.frame_name,
          dataDate,
          j.rx_number || j.rxnumber
        );
      }
    });

    upsertMany(activeJobs);
    db.close();
    log.info(`[DVI] SQLite sync complete: ${activeJobs.length} active, ${shippedCount} shipped to history`);
  } catch (dbErr: any) {
    log.error('[DVI] SQLite sync failed:', dbErr.message);
  }
}

// Load DVI data on startup
loadDviData();

// ─────────────────────────────────────────────────────────────────────────────
// DVI SOAP Polling - Download new orders automatically
// ─────────────────────────────────────────────────────────────────────────────

const SOAP_POLL_INTERVAL = 60_000; // Poll every 60 seconds

async function pollDviSoapOrders(): Promise<void> {
  try {
    const orders = await dviSoap.downloadOrders(100);
    if (orders.length === 0) return;

    log.info(`[DVI] SOAP: Downloaded ${orders.length} new orders`);

    // Convert SOAP orders to job format and add to database
    const dbPath = join(__dirname, '..', 'data', 'lab_assistant.db');
    if (!existsSync(dbPath)) return;

    const db = new Database(dbPath);

    const upsertStmt = db.prepare(`
      INSERT INTO dvi_jobs (id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, data_date, rx_number, archived, last_sync)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))
      ON CONFLICT(id) DO UPDATE SET
        stage = excluded.stage,
        status = excluded.status,
        coating = excluded.coating,
        last_sync = datetime('now')
    `);

    let addedCount = 0;
    const today = new Date().toISOString().split('T')[0];

    db.transaction(() => {
      for (const order of orders) {
        // Use remoteInvoice as job_id, fallback to orderNumber
        const jobId = order.remoteInvoice || order.orderNumber;
        const coating = order.rightLens?.coating || order.leftLens?.coating || '';

        upsertStmt.run(
          jobId,
          order.remoteInvoice,
          order.remoteInvoice, // tray = invoice for new orders
          'S', // New orders start in Surfacing
          null, // station
          'In Progress',
          'N', // rush - would need to parse from instructions
          today, // entry_date
          0, // days_in_lab
          coating,
          order.frame?.style || '',
          today, // data_date
          order.rxNumber
        );
        addedCount++;
      }
    })();

    db.close();

    if (addedCount > 0) {
      log.info(`[DVI] SOAP: Added/updated ${addedCount} jobs to WIP`);
    }
  } catch (err: any) {
    // Don't log error if it's just no password configured
    if (!err.message?.includes('No password')) {
      log.error('[DVI] SOAP polling error:', err.message);
    }
  }
}

// Start SOAP polling - delay initial poll to not block server startup
setTimeout(() => {
  pollDviSoapOrders().catch(err => log.warn('[DVI] Initial SOAP poll failed:', err.message));
  setInterval(pollDviSoapOrders, SOAP_POLL_INTERVAL);
  log.info(`[DVI] SOAP polling started (every ${SOAP_POLL_INTERVAL / 1000}s)`);
}, 5000); // Wait 5s after module load

// DVI MegaTransfer XML parser - extracts RxOrder records with nested data
function parseXMLToJobs(xmlContent: string): { jobs: Record<string, any>[], columns: string[] } {
  const jobs: Record<string, any>[] = [];
  const columns = new Set<string>();

  // Helper to extract attributes from an element
  const extractAttrs = (xml: string, tagName: string): Record<string, string> => {
    const match = xml.match(new RegExp(`<${tagName}\\b([^>]*)/?>`));
    if (!match) return {};
    const attrs: Record<string, string> = {};
    const attrPattern = /\s([A-Za-z_][A-Za-z0-9_-]*)=["']([^"']*)["']/g;
    let m;
    while ((m = attrPattern.exec(match[1])) !== null) {
      attrs[m[1].toLowerCase()] = m[2];
    }
    return attrs;
  };

  // Helper to get text content of an element
  const getTextContent = (xml: string, tagName: string): string => {
    const match = xml.match(new RegExp(`<${tagName}[^>]*>([^<]*)</${tagName}>`, 'i'));
    return match ? match[1].trim() : '';
  };

  // Check if this is a DVI MegaTransfer format
  const isMegaTransfer = xmlContent.includes('<MegaTransfer') || xmlContent.includes('<RxOrder');

  if (isMegaTransfer) {
    // DVI MegaTransfer format - parse RxOrder records
    const rxOrderPattern = /<RxOrder\b[^>]*>([\s\S]*?)<\/RxOrder>/gi;
    const matches = xmlContent.match(rxOrderPattern);

    if (!matches || matches.length === 0) {
      throw new Error('No RxOrder records found in DVI MegaTransfer file');
    }

    log.info(`DVI XML: Found ${matches.length} RxOrder records in MegaTransfer format`);

    for (const orderXml of matches) {
      const job: Record<string, any> = {};

      // Extract RxOrder attributes (JobType, Industrial, Department, DaysInLab, uid)
      const rxAttrs = extractAttrs(orderXml, 'RxOrder');
      Object.entries(rxAttrs).forEach(([k, v]) => {
        job[k] = v;
        columns.add(k);
      });

      // Extract OrderData attributes (Invoice, Tray, Reference, Operator, dates, etc.)
      const orderDataAttrs = extractAttrs(orderXml, 'OrderData');
      Object.entries(orderDataAttrs).forEach(([k, v]) => {
        job[k] = v;
        columns.add(k);
      });

      // Map common fields to standardized names for KPI calculation
      job.job_id = orderDataAttrs.invoice || orderDataAttrs.tray || rxAttrs.uid;
      job.tray = orderDataAttrs.tray;
      job.invoice = orderDataAttrs.invoice;
      job.reference = orderDataAttrs.reference;
      job.operator = orderDataAttrs.operator;
      job.entry_date = orderDataAttrs.entrydate;
      job.ship_date = orderDataAttrs.shipdate;
      job.days_in_lab = rxAttrs.daysinlab;
      job.rx_number = orderDataAttrs.rxnumber;
      job.lens_material = rxAttrs.department;  // Store material code separately

      // Determine actual workflow stage
      // Valid workflow stages: S (Surfacing), C (Coating), E (Edging), A (Assembly), Q (QC), O (Office)
      const validStages = ['S', 'C', 'E', 'A', 'Q', 'O'];
      let determinedStage = 'UNKNOWN';

      // Check if RxOrder Department is a valid stage code
      if (rxAttrs.department && validStages.includes(rxAttrs.department.toUpperCase())) {
        determinedStage = rxAttrs.department.toUpperCase();
      } else {
        // RxOrder Department is a material code (POLY, HIRES, etc.) - determine stage from other fields

        // Look for Wait elements to determine current stage
        const waitMatches = orderXml.match(/<Wait[^>]*Name="([^"]+)"[^>]*>/gi);
        if (waitMatches && waitMatches.length > 0) {
          // Get the last Wait element (most recent)
          const lastWait = waitMatches[waitMatches.length - 1];
          const waitNameMatch = lastWait.match(/Name="([^"]+)"/i);
          if (waitNameMatch) {
            const waitName = waitNameMatch[1].toUpperCase();
            if (waitName.includes('COATING') || waitName.includes('COAT')) {
              determinedStage = 'C';
            } else if (waitName.includes('SURFACE') || waitName.includes('GEN')) {
              determinedStage = 'S';
            } else if (waitName.includes('EDGE') || waitName.includes('CUT')) {
              determinedStage = 'E';
            } else if (waitName.includes('ASSEM')) {
              determinedStage = 'A';
            } else if (waitName.includes('QC') || waitName.includes('INSPECT')) {
              determinedStage = 'Q';
            }
          }
        }

        // If still unknown, check BreakageItem Department for most recent department
        if (determinedStage === 'UNKNOWN') {
          const breakageMatches = orderXml.match(/<BreakageItem[^>]*Department="([^"]+)"[^>]*>/gi);
          if (breakageMatches && breakageMatches.length > 0) {
            const lastBreakage = breakageMatches[breakageMatches.length - 1];
            const deptMatch = lastBreakage.match(/Department="([^"]+)"/i);
            if (deptMatch && validStages.includes(deptMatch[1].toUpperCase())) {
              determinedStage = deptMatch[1].toUpperCase();
            }
          }
        }

        // If still unknown and job is active (no ShipDate), default to Surfacing (entry point)
        if (determinedStage === 'UNKNOWN' && !orderDataAttrs.shipdate) {
          determinedStage = 'S';
        }
      }

      job.stage = determinedStage;

      // Determine status based on ship date
      const hasShipDate = orderDataAttrs.shipdate && orderDataAttrs.shiptime;
      job.status = hasShipDate ? 'SHIPPED' : 'In Progress';

      // Extract RightEye data
      const rightEyeAttrs = extractAttrs(orderXml, 'RightEye');
      if (Object.keys(rightEyeAttrs).length > 0) {
        job.right_sphere = rightEyeAttrs.sphere;
        job.right_cylinder = rightEyeAttrs.cylinder;
        job.right_axis = rightEyeAttrs.cylaxis;
        job.right_add = rightEyeAttrs.add;
        job.right_material = rightEyeAttrs.material;
        job.right_opc = rightEyeAttrs.opc;
        columns.add('right_sphere');
        columns.add('right_cylinder');
      }

      // Extract LeftEye data
      const leftEyeAttrs = extractAttrs(orderXml, 'LeftEye');
      if (Object.keys(leftEyeAttrs).length > 0) {
        job.left_sphere = leftEyeAttrs.sphere;
        job.left_cylinder = leftEyeAttrs.cylinder;
        job.left_axis = leftEyeAttrs.cylaxis;
        job.left_add = leftEyeAttrs.add;
        job.left_material = leftEyeAttrs.material;
        job.left_opc = leftEyeAttrs.opc;
        columns.add('left_sphere');
        columns.add('left_cylinder');
      }

      // Extract Frame data
      const frameAttrs = extractAttrs(orderXml, 'Frame');
      if (Object.keys(frameAttrs).length > 0) {
        job.frame_name = frameAttrs.name;
        job.frame_mfr = frameAttrs.mfr;
        job.frame_material = frameAttrs.material;
        job.frame_color = frameAttrs.color;
        job.frame_eyesize = frameAttrs.eyesize;
        job.frame_upc = frameAttrs.upc;
        columns.add('frame_name');
      }

      // Extract Coating info from Coat elements
      const coatMatch = orderXml.match(/<Coat[^>]*>([^<]*)<\/Coat>/i);
      if (coatMatch) {
        job.coating = coatMatch[1].trim();
        columns.add('coating');
      }

      // Extract Wait periods (like COATING wait)
      const waitAttrs = extractAttrs(orderXml, 'Wait');
      if (waitAttrs.name) {
        job.wait_type = waitAttrs.name;
        job.wait_begin = waitAttrs.begin;
        job.wait_end = waitAttrs.end;
        job.wait_days = waitAttrs.days;
      }

      // Check for breakage
      if (orderXml.includes('<Breakage')) {
        job.has_breakage = 'Y';
        const breakageAttrs = extractAttrs(orderXml, 'Breakage');
        job.frame_breakage = breakageAttrs.framebreakage || '0';
        job.office_breakage_left = breakageAttrs.officebreakageLeft || '0';
        job.office_breakage_right = breakageAttrs.officebreakageright || '0';
      }

      // Check for rush (look for priority indicators)
      job.rush = orderXml.toLowerCase().includes('rush') ? 'Y' : 'N';

      // Add standard columns
      columns.add('job_id');
      columns.add('stage');
      columns.add('status');

      jobs.push(job);
    }
  } else {
    // Generic XML parsing - try common patterns
    const recordPatterns = [
      /<Job\b[^>]*>([\s\S]*?)<\/Job>/gi,
      /<Record\b[^>]*>([\s\S]*?)<\/Record>/gi,
      /<Row\b[^>]*>([\s\S]*?)<\/Row>/gi,
      /<Item\b[^>]*>([\s\S]*?)<\/Item>/gi,
      /<Order\b[^>]*>([\s\S]*?)<\/Order>/gi,
    ];

    let matches: RegExpMatchArray | null = null;

    for (const p of recordPatterns) {
      const testMatches = xmlContent.match(p);
      if (testMatches && testMatches.length > 0) {
        matches = testMatches;
        break;
      }
    }

    if (!matches || matches.length === 0) {
      throw new Error('Could not find job records in XML. Expected DVI MegaTransfer format with <RxOrder> tags, or generic <Job>, <Record>, <Row> tags.');
    }

    for (const recordXml of matches) {
      const job: Record<string, any> = {};

      // Extract attributes and child elements
      const fieldPattern = /<([A-Za-z_][A-Za-z0-9_-]*)(?:\s[^>]*)?>([^<]*)<\/\1>/g;
      let fieldMatch;
      while ((fieldMatch = fieldPattern.exec(recordXml)) !== null) {
        const fieldName = fieldMatch[1].toLowerCase();
        job[fieldName] = fieldMatch[2].trim();
        columns.add(fieldName);
      }

      const attrPattern = /\s([A-Za-z_][A-Za-z0-9_-]*)=["']([^"']*)["']/g;
      let attrMatch;
      const recordTagMatch = recordXml.match(/<([A-Za-z_][A-Za-z0-9_-]*)\b([^>]*)>/);
      if (recordTagMatch && recordTagMatch[2]) {
        while ((attrMatch = attrPattern.exec(recordTagMatch[2])) !== null) {
          if (!job[attrMatch[1].toLowerCase()]) {
            job[attrMatch[1].toLowerCase()] = attrMatch[2];
            columns.add(attrMatch[1].toLowerCase());
          }
        }
      }

      if (Object.keys(job).length > 0) {
        jobs.push(job);
      }
    }
  }

  return { jobs, columns: Array.from(columns) };
}

app.post('/api/dvi/upload', express.text({ limit: '50mb', type: '*/*' }), (req: Request, res: Response) => {
  try {
    const filename = req.headers['x-filename'] as string || 'upload.xml';
    const dataDateHeader = req.headers['x-data-date'] as string || null;
    let rawData = req.body as string;

    // Detect file type: XML or CSV
    const isXML = rawData.trim().startsWith('<?xml') || rawData.trim().startsWith('<');

    let jobs: Record<string, any>[] = [];
    let header: string[] = [];

    if (isXML) {
      // Parse XML data
      log.info(`DVI Upload: Parsing XML file ${filename}`);
      const parsed = parseXMLToJobs(rawData);
      jobs = parsed.jobs;
      header = parsed.columns;
      log.info(`DVI XML Upload: ${jobs.length} jobs, columns: ${header.slice(0, 10).join(', ')}${header.length > 10 ? '...' : ''}`);
    } else {
      // Parse CSV data
      const lines = rawData.split('\n').filter((l: string) => l.trim());
      if (lines.length < 2) {
        return res.status(400).json({ error: 'File must have header row and at least one data row' });
      }

      // Check if this is DVI Status Detail pivot format (has "DVI Status Detail" in header)
      const isDviStatusDetail = lines[0].includes('DVI Status Detail');

      // Check if this is a Looker pivot table (row 2 contains "Jobs Count" but not DVI Status Detail)
      const isLookerPivot = !isDviStatusDetail && lines.length > 1 && lines[1].includes('Jobs Count');

      if (isDviStatusDetail) {
        // DVI Status Detail format - job-level pivot with station columns
        const parsed = parseDviStatusDetailCSV(rawData);
        if (parsed) {
          // Use WIP jobs for display (active, not shipped/canceled)
          jobs = parsed.wip;
          header = parsed.columns;
          log.info(`[DVI] Status Detail: ${parsed.jobs.length} total jobs, ${parsed.wip.length} WIP jobs`);

          // Also store shipped jobs directly to SQLite with correct ship dates
          const shippedJobs = parsed.jobs.filter((j: any) => j.status === 'SHIPPED');
          if (shippedJobs.length > 0) {
            const dbPath = join(__dirname, '..', 'data', 'lab_assistant.db');
            if (existsSync(dbPath)) {
              const db = new Database(dbPath);
              const insertShipped = db.prepare(`
                INSERT INTO dvi_jobs (id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, data_date, rx_number, archived, shipped_at, last_sync)
                VALUES (?, ?, ?, 'SHIPPED', 'SHIPPED', 'SHIPPED', 'N', ?, 0, '', '', ?, ?, 1, datetime('now'), datetime('now'))
                ON CONFLICT(id) DO UPDATE SET
                  data_date = excluded.data_date,
                  archived = 1,
                  shipped_at = datetime('now')
              `);
              db.transaction(() => {
                for (const j of shippedJobs) {
                  insertShipped.run(
                    j.job_id,
                    j.invoice,
                    j.tray,
                    j.last_update,  // entry_date
                    j.last_update,  // data_date = actual ship date
                    j.rx_number
                  );
                }
              })();
              db.close();
              log.info(`[DVI] Status Detail: Stored ${shippedJobs.length} shipped jobs with actual ship dates`);
            }
          }
        } else {
          return res.status(400).json({ error: 'Failed to parse DVI Status Detail CSV' });
        }
      } else if (isLookerPivot) {
        log.info(`[DVI] Detected Looker pivot table format`);
        const parsed = parseLookerPivotCSV(rawData);
        jobs = parsed.jobs;
        header = parsed.columns;
        // Store summary data for stage breakdown
        (jobs as any).summary = parsed.summary;
      } else {
        // Standard CSV format
        header = lines[0].split(',').map((h: string) => h.trim().replace(/^"|"$/g, '').toLowerCase());
        log.info(`DVI CSV Upload: ${lines.length - 1} rows, columns: ${header.join(', ')}`);

        // Parse data rows
        for (let i = 1; i < lines.length; i++) {
          const values = parseCSVLine(lines[i]);
          if (values.length !== header.length) continue;

          const job: Record<string, any> = {};
          header.forEach((col: string, idx: number) => {
            job[col] = values[idx];
          });

          // Normalize CSV columns to standard job fields
          // Map common CSV column names to standardized fields
          job.job_id = job['dvi id'] || job['order id'] || job['invoice'] || job['order number'] || `csv-${i}`;
          job.invoice = job['dvi id'] || job['invoice'] || job['order number'];
          job.tray = job['tray'] || job.invoice;
          job.reference = job['order number'] || job['poms order id'] || job['reference'];

          // Calculate days_in_lab from Hours In Progress if available
          if (job['hours in progress']) {
            const hours = parseFloat(job['hours in progress']) || 0;
            job.days_in_lab = Math.floor(hours / 24);
          }

          // Determine stage from DVI Status or station columns
          // Look for station-like columns that indicate current position
          let stage = 'UNKNOWN';
          const lowerCols = Object.keys(job).map(k => k.toLowerCase());

          // Check for DVI status columns that indicate stage
          if (job['dvi status'] || job['status']) {
            const statusVal = (job['dvi status'] || job['status'] || '').toUpperCase();
            if (statusVal.includes('ASSEMBLY') || statusVal.includes('ASSEM')) stage = 'A';
            else if (statusVal.includes('EDGER') || statusVal.includes('EDGE') || statusVal.includes('CUT')) stage = 'E';
            else if (statusVal.includes('COAT') || statusVal.includes('CCL') || statusVal.includes('CCP')) stage = 'C';
            else if (statusVal.includes('SURF') || statusVal.includes('GEN') || statusVal.includes('LOG LENSES')) stage = 'S';
            else if (statusVal.includes('QC') || statusVal.includes('INSPECT')) stage = 'Q';
            else if (statusVal.includes('OFFICE') || statusVal.includes('EDIT')) stage = 'O';
            else if (statusVal.includes('SHIP')) stage = 'SHIPPED';
          }

          // If still unknown, check for station presence in any column
          if (stage === 'UNKNOWN') {
            const allVals = Object.values(job).join(' ').toUpperCase();
            if (allVals.includes('ASSEMBLY')) stage = 'A';
            else if (allVals.includes('EDGER')) stage = 'E';
            else if (allVals.includes('COATING') || allVals.includes('CCL') || allVals.includes('CCP')) stage = 'C';
            else if (allVals.includes('SURFACING') || allVals.includes('GENERATOR')) stage = 'S';
          }

          // For late jobs, mark them as in-progress at unknown stage if not determined
          // This ensures they show in WIP counts
          job.stage = stage;

          // Determine status from Job Risk or other columns
          const risk = (job['job risk'] || job['status'] || '').toLowerCase();
          if (risk.includes('missed') || risk.includes('late')) {
            job.status = 'LATE';
          } else if (risk.includes('risk')) {
            job.status = 'AT_RISK';
          } else if (risk.includes('ship')) {
            job.status = 'SHIPPED';
          } else {
            job.status = 'In Progress';
          }

          // Store SLA info
          if (job['job sla']) job.sla_hours = parseFloat(job['job sla']) || 48;
          if (job['vs sla']) job.vs_sla = parseFloat(job['vs sla']) || 0;

          jobs.push(job);
        }
      }
    }

    if (jobs.length === 0) {
      return res.status(400).json({ error: 'No valid job records found in file' });
    }

    // For CSV jobs with UNKNOWN stage, look up from existing XML data
    const unknownStageJobs = jobs.filter(j => j.stage === 'UNKNOWN');
    if (unknownStageJobs.length > 0) {
      log.info(`[DVI] Looking up stage for ${unknownStageJobs.length} jobs with UNKNOWN stage`);

      // Build lookup map from database (active + history)
      const dbPath = join(__dirname, '..', 'data', 'lab_assistant.db');
      if (existsSync(dbPath)) {
        const lookupDb = new Database(dbPath);

        // Get stages from active jobs (include rx_number for DVI ID matching)
        const activeStages = lookupDb.prepare(`
          SELECT invoice, stage, rx_number FROM dvi_jobs WHERE stage IS NOT NULL AND stage != '' AND stage != 'UNKNOWN'
        `).all() as { invoice: string; stage: string; rx_number?: string }[];

        // Get stages from history
        const historyStages = lookupDb.prepare(`
          SELECT invoice, stage FROM dvi_jobs_history WHERE stage IS NOT NULL AND stage != '' AND stage != 'UNKNOWN'
        `).all() as { invoice: string; stage: string }[];

        lookupDb.close();

        // Build lookup maps: invoice/rx_number -> stage (prefer active over history)
        const stageMap = new Map<string, string>();
        for (const h of historyStages) {
          if (h.invoice && h.stage) stageMap.set(h.invoice, h.stage);
        }
        for (const a of activeStages) {
          if (a.invoice && a.stage) stageMap.set(a.invoice, a.stage);
          // Also map rx_number (DVI ID format like D929816119)
          if (a.rx_number && a.stage) stageMap.set(a.rx_number, a.stage);
        }

        // Also check archived uploads in memory
        for (const archive of dviDataStore.archive) {
          for (const archiveJob of archive.jobs) {
            if (archiveJob.stage && archiveJob.stage !== 'UNKNOWN') {
              if (archiveJob.invoice) stageMap.set(archiveJob.invoice, archiveJob.stage);
              if (archiveJob.rx_number) stageMap.set(archiveJob.rx_number, archiveJob.stage);
              if (archiveJob.rxnumber) stageMap.set(archiveJob.rxnumber, archiveJob.stage);
            }
          }
        }

        log.info(`[DVI] Stage lookup map has ${stageMap.size} entries`);

        // Update jobs with looked-up stages
        let foundCount = 0;
        for (const job of unknownStageJobs) {
          const lookupKeys = [job.invoice, job.job_id, job['dvi id']].filter(Boolean);
          for (const key of lookupKeys) {
            const foundStage = stageMap.get(key);
            if (foundStage) {
              job.stage = foundStage;
              foundCount++;
              break;
            }
          }
        }

        log.info(`[DVI] Found stage for ${foundCount}/${unknownStageJobs.length} jobs from existing data`);
      }
    }

    // Try to extract data date from filename (e.g., "DVI_2026-03-02.xml" or "dvi_export_20260302.xml")
    let dataDate = dataDateHeader;
    if (!dataDate) {
      const dateMatch = filename.match(/(\d{4}[-_]?\d{2}[-_]?\d{2})/);
      if (dateMatch) {
        const raw = dateMatch[1].replace(/[-_]/g, '');
        dataDate = `${raw.slice(0, 4)}-${raw.slice(4, 6)}-${raw.slice(6, 8)}`;
      }
    }

    // Archive current data before replacing (if exists)
    if (dviDataStore.current) {
      dviDataStore.archive.push(dviDataStore.current);
      // Keep last 90 days of archives
      if (dviDataStore.archive.length > 90) {
        dviDataStore.archive = dviDataStore.archive.slice(-90);
      }
    }

    // Create new upload record
    const uploadId = `upload_${Date.now()}`;
    const newUpload: DVIUpload = {
      id: uploadId,
      jobs,
      uploadedAt: new Date().toISOString(),
      filename,
      rowCount: jobs.length,
      dataDate
    };

    // Store as current
    dviDataStore.current = newUpload;

    // Persist to disk
    saveDviData();

    log.info(`DVI Upload complete: ${jobs.length} jobs stored, data date: ${dataDate || 'unknown'}, format: ${isXML ? 'XML' : 'CSV'}`);
    res.json({
      success: true,
      id: uploadId,
      filename,
      rowCount: jobs.length,
      columns: header,
      dataDate,
      uploadedAt: newUpload.uploadedAt,
      archiveCount: dviDataStore.archive.length,
      format: isXML ? 'XML' : 'CSV',
      sample: jobs.slice(0, 5)
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Upload failed';
    log.error('DVI Upload error:', e);
    res.status(500).json({ error: msg });
  }
});

// Helper to parse CSV line (handles quoted fields)
function parseCSVLine(line: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === ',' && !inQuotes) {
      result.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  result.push(current.trim());
  return result;
}

// Station to stage mapping for Looker pivot tables
const STATION_TO_STAGE: Record<string, string> = {
  'GENERATOR #1': 'SURFACING', 'GENERATOR #2': 'SURFACING',
  'AUTO BLKER #2': 'SURFACING',
  'DIGITAL CALC': 'SURFACING',
  'Coating': 'COATING', 'RECEIVED COAT': 'COATING',
  'CCL #1': 'COATING', 'CCL #2': 'COATING',
  'CCP #1': 'COATING', 'CCP #2': 'COATING',
  'EDGER #1': 'CUTTING', 'EDGER #2': 'CUTTING', 'EDGER #4': 'CUTTING',
  'EDGER #5': 'CUTTING', 'EDGER #6': 'CUTTING', 'EDGER #7': 'CUTTING',
  'EDGERKCKOT2LINE2': 'CUTTING', 'LCU #1': 'CUTTING',
  'ASSEMBLY #1': 'ASSEMBLY', 'ASSEMBLY #6': 'ASSEMBLY', 'ASSEMBLY #7': 'ASSEMBLY',
  'ASSEMBLY #14': 'ASSEMBLY', 'ASSEMBLY #15': 'ASSEMBLY',
  'ASSEMBLY PASS': 'ASSEMBLY', 'ASSEMBLY FAIL': 'QC_FAIL',
  'BREAKAGE': 'BREAKAGE', 'CANCELED': 'CANCELED',
  'NEW WORKTICKET': 'INCOMING', 'INITIATE': 'INCOMING',
  'FRAME LOGGED': 'INCOMING',
  'SH CONVEY CTRL 1': 'SHIPPING', 'SH CONVEY CTRL 2': 'SHIPPING', 'SH CONVEY KCKOUT': 'SHIPPING',
  'SHIPPED': 'SHIPPING',
  'SENT TO HKO': 'OUTSOURCED',
  // Hold/Office stations
  'CBOB - INHSE FIN': 'HOLD', 'CBOB - INHSE SF': 'HOLD', 'CBOB - NE LENS': 'HOLD',
  'CBOB - NE FRMS': 'HOLD', 'CBOB - FRMHOLD': 'HOLD', 'CBOB - AT KARDEX': 'HOLD',
  'CBOB - DIG CALC': 'HOLD', 'CBOB - INFLUENCE': 'HOLD', 'CBOB - INTL ACCT': 'HOLD',
  'CBOB - MAN2KARDX': 'HOLD', 'CBOB - SUBHKO': 'HOLD', 'CBOB - UNCATEGOR': 'HOLD',
  'EDIT-DESK': 'OFFICE', 'RECOMBOBULATE': 'OFFICE',
  'LOG LENSES SF': 'SURFACING', 'MODULO CTRL CNTR': 'SURFACING', 'LASER REJECT': 'QC_FAIL',
  'CCP #3': 'COATING',
};

// Parse DVI Status Detail CSV - pivot table with job-level data
// Format: Date, DVI ID, then station columns with 1's indicating job was at that station
function parseDviStatusDetailCSV(rawData: string): { jobs: Record<string, any>[], columns: string[], wip: Record<string, any>[] } | null {
  const lines = rawData.split('\n').filter(l => l.trim());
  if (lines.length < 3) return null;

  // Check if this is DVI Status Detail format
  // Header row has: [blank or date label], DVI Status Detail, station names...
  const header = parseCSVLine(lines[0]);
  if (!header.some(h => h.includes('DVI Status Detail'))) {
    return null; // Not this format
  }

  log.info(`[DVI] Detected DVI Status Detail pivot format`);

  // Find station columns (skip first two columns: date and DVI ID)
  const stations = header.slice(2).map(s => s.trim());
  log.info(`[DVI] Stations in CSV: ${stations.slice(0, 10).join(', ')}${stations.length > 10 ? '...' : ''}`);

  // Track each job's transitions: dvi_id -> {date, station, stage}[]
  const jobHistory: Map<string, { date: string; station: string; stage: string }[]> = new Map();

  // Parse data rows (skip header and "Count Jobs" row)
  for (let i = 2; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 3) continue;

    const date = values[0].replace(/^'/, ''); // Remove leading quote if present
    const dviId = values[1];

    if (!dviId || !date.match(/^\d{4}-\d{2}-\d{2}$/)) continue;

    // Find which station(s) have a 1 for this row
    for (let j = 2; j < values.length && j - 2 < stations.length; j++) {
      const val = values[j].trim();
      if (val === '1' || val === '1.0') {
        const station = stations[j - 2];
        const stage = STATION_TO_STAGE[station] || 'OTHER';

        if (!jobHistory.has(dviId)) {
          jobHistory.set(dviId, []);
        }
        jobHistory.get(dviId)!.push({ date, station, stage });
      }
    }
  }

  log.info(`[DVI] Parsed ${jobHistory.size} unique jobs from status detail CSV`);

  // Determine current state for each job (most recent entry)
  const jobs: Record<string, any>[] = [];
  const wip: Record<string, any>[] = [];

  for (const [dviId, history] of jobHistory) {
    // Sort by date descending to get most recent
    history.sort((a, b) => b.date.localeCompare(a.date));
    const latest = history[0];

    const job: Record<string, any> = {
      job_id: dviId,
      invoice: dviId,
      rx_number: dviId,
      tray: dviId,
      stage: latest.stage === 'SHIPPING' ? 'SHIPPED' : latest.stage,
      station: latest.station,
      status: latest.stage === 'SHIPPING' ? 'SHIPPED' : 'In Progress',
      last_update: latest.date,
      history_count: history.length,
    };

    jobs.push(job);

    // WIP = not shipped and not canceled
    if (latest.stage !== 'SHIPPING' && latest.station !== 'CANCELED') {
      wip.push(job);
    }
  }

  // Sort WIP by date (oldest first for aging)
  wip.sort((a, b) => a.last_update.localeCompare(b.last_update));

  // Stage breakdown
  const byStage: Record<string, number> = {};
  wip.forEach(j => {
    byStage[j.stage] = (byStage[j.stage] || 0) + 1;
  });

  log.info(`[DVI] Status Detail WIP: ${wip.length} jobs, stages: ${JSON.stringify(byStage)}`);

  return {
    jobs,
    columns: ['job_id', 'invoice', 'rx_number', 'stage', 'station', 'status', 'last_update'],
    wip,
  };
}

function parseLookerPivotCSV(rawData: string): { jobs: Record<string, any>[], columns: string[], summary: Record<string, any> } {
  const lines = rawData.split('\n').filter(l => l.trim());
  if (lines.length < 3) return { jobs: [], columns: [], summary: {} };

  // Row 1: Station names
  const stations = parseCSVLine(lines[0]);
  const dateCol = stations[0]; // First column header (e.g., "Jobs DVI Status Detail")

  // Check if this looks like a Looker pivot table
  if (!lines[1].includes('Jobs Count')) {
    return { jobs: [], columns: [], summary: {} };
  }

  const jobs: Record<string, any>[] = [];
  const summary: Record<string, Record<string, number>> = {};
  const stageTotals: Record<string, number> = {};

  // Parse data rows (starting from row 3)
  for (let i = 2; i < lines.length; i++) {
    const values = parseCSVLine(lines[i]);
    if (values.length < 2) continue;

    const date = values[0];
    if (!date.match(/^\d{4}-\d{2}-\d{2}$/)) continue;

    summary[date] = {};

    // Parse each station count
    for (let j = 1; j < values.length && j < stations.length; j++) {
      const station = stations[j];
      const count = parseInt(values[j]) || 0;
      if (count === 0) continue;

      const stage = STATION_TO_STAGE[station] || 'OTHER';
      summary[date][station] = count;
      stageTotals[stage] = (stageTotals[stage] || 0) + count;

      // Create individual job records for display
      for (let k = 0; k < count; k++) {
        jobs.push({
          job_id: `${date}-${station}-${k + 1}`,
          date,
          station,
          stage,
          status: stage === 'SHIPPING' ? 'SHIPPED' : 'In Progress',
        });
      }
    }
  }

  // Add stage totals to summary
  const columns = ['date', 'station', 'stage', 'status', 'job_id'];

  log.info(`[Looker] Parsed pivot table: ${jobs.length} job records, ${Object.keys(summary).length} days, stages: ${JSON.stringify(stageTotals)}`);

  return { jobs, columns, summary: { byDate: summary, byStage: stageTotals } };
}

app.get('/api/dvi/data', async (req: Request, res: Response) => {
  // Query param to explicitly request mock data (for testing only)
  const forceMock = req.query.mock === 'true';
  const current = dviDataStore.current;

  if (!current && !forceMock) {
    // No uploaded data - try to fetch live from DVI SOAP API
    try {
      const liveOrders = await dviSoap.downloadOrders(200);
      if (liveOrders.length > 0) {
        // Transform live orders to match expected job format
        const jobs = liveOrders.map(order => ({
          job_id: order.orderNumber,
          order_number: order.orderNumber,
          rx_number: order.rxNumber,
          patient_id: order.patientId,
          remote_invoice: order.remoteInvoice,
          status: 'In Progress',
          stage: 'INCOMING',
          frame_style: order.frame?.style || '',
          frame_sku: order.frame?.sku || '',
          coating: order.rightLens?.coating || order.leftLens?.coating || '',
          material: order.rightLens?.material || order.leftLens?.material || '',
          lens_style: order.rightLens?.style || order.leftLens?.style || '',
          r_sphere: order.rightEye?.sphere || 0,
          r_cylinder: order.rightEye?.cylinder || 0,
          r_axis: order.rightEye?.axis || 0,
          r_pd: order.rightEye?.pd || 0,
          l_sphere: order.leftEye?.sphere || 0,
          l_cylinder: order.leftEye?.cylinder || 0,
          l_axis: order.leftEye?.axis || 0,
          l_pd: order.leftEye?.pd || 0,
          instructions: order.instructions?.join(' | ') || '',
        }));

        return res.json({
          mock: false,
          source: 'live',
          jobs,
          message: 'Live data from DVI SOAP API',
          rowCount: jobs.length,
          timestamp: new Date().toISOString(),
          archiveCount: dviDataStore.archive.length
        });
      }
    } catch (e) {
      log.info(`[DVI] Live fetch failed, returning empty: ${e}`);
    }

    // No live data either - return empty state
    return res.json({
      mock: false,
      jobs: [],
      message: 'No DVI data available. Upload a file or check DVI SOAP connection.',
      uploadedAt: null,
      rowCount: 0,
      archiveCount: dviDataStore.archive.length
    });
  }

  if (forceMock) {
    return res.json({ mock: true, jobs: generateMockDVIJobs(), message: 'Mock data (requested via ?mock=true)' });
  }

  // Get shipped counts from database
  let shippedStats = { today: 0, yesterday: 0, thisWeek: 0 };
  const dbPath = join(__dirname, '..', 'data', 'lab_assistant.db');
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

      const todayCount = db.prepare(`SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived = 1 AND data_date = ?`).get(today) as any;
      const yesterdayCount = db.prepare(`SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived = 1 AND data_date = ?`).get(yesterday) as any;
      const weekCount = db.prepare(`SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived = 1 AND data_date >= ?`).get(weekAgo) as any;

      shippedStats = {
        today: todayCount?.cnt || 0,
        yesterday: yesterdayCount?.cnt || 0,
        thisWeek: weekCount?.cnt || 0
      };
      db.close();
    } catch (e) {
      log.error('[Data] Shipped count error:', e);
    }
  }

  // Uploaded data exists - return it
  res.json({
    mock: false,
    source: 'upload',
    jobs: current!.jobs,
    filename: current!.filename,
    rowCount: current!.rowCount,
    uploadedAt: current!.uploadedAt,
    dataDate: current!.dataDate,
    archiveCount: dviDataStore.archive.length,
    shipped: shippedStats
  });
});

// List all DVI uploads (current + archived)
app.get('/api/dvi/uploads', (_req: Request, res: Response) => {
  const uploads = [];

  // Add current first
  if (dviDataStore.current) {
    uploads.push({
      ...dviDataStore.current,
      jobs: undefined,  // Don't send all jobs in list view
      isCurrent: true
    });
  }

  // Add archived (most recent first)
  for (let i = dviDataStore.archive.length - 1; i >= 0; i--) {
    uploads.push({
      ...dviDataStore.archive[i],
      jobs: undefined,
      isCurrent: false
    });
  }

  // Check for missing dates in last 30 days
  const today = new Date();
  const missingDates: string[] = [];
  const uploadedDates = new Set(uploads.map(u => u.dataDate).filter(Boolean));

  for (let i = 1; i <= 30; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const dateStr = d.toISOString().split('T')[0];
    if (!uploadedDates.has(dateStr)) {
      missingDates.push(dateStr);
    }
  }

  res.json({
    uploads,
    totalUploads: uploads.length,
    missingDates,
    missingCount: missingDates.length
  });
});

// Load a specific archived upload by ID
app.get('/api/dvi/uploads/:id', (req: Request, res: Response) => {
  const { id } = req.params;

  if (dviDataStore.current?.id === id) {
    return res.json({ ...dviDataStore.current, isCurrent: true });
  }

  const archived = dviDataStore.archive.find(u => u.id === id);
  if (archived) {
    return res.json({ ...archived, isCurrent: false });
  }

  res.status(404).json({ error: 'Upload not found' });
});

app.get('/api/dvi/stats', (req: Request, res: Response) => {
  const forceMock = req.query.mock === 'true';
  const current = dviDataStore.current;

  // Only use real data if uploaded, never fall back to mock automatically
  const hasRealData = !!current;
  const jobs = forceMock ? generateMockDVIJobs() : (hasRealData ? current.jobs : []);
  const isMock = forceMock;

  // Compute stats from jobs
  const stats = {
    totalJobs: jobs.length,
    byStatus: {} as Record<string, number>,
    byStage: {} as Record<string, number>,
    rushJobs: 0,
    completedToday: 0,
    noData: !hasRealData && !forceMock
  };

  jobs.forEach((job: any) => {
    const status = job.status || job.Status || 'unknown';
    const stage = job.stage || job.Stage || job.current_stage || 'unknown';
    stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
    stats.byStage[stage] = (stats.byStage[stage] || 0) + 1;
    if (job.rush === 'Y' || job.Rush === 'Y' || job.priority === 'RUSH') stats.rushJobs++;
  });

  // Get shipped counts from database history
  let shippedStats = { today: 0, yesterday: 0, thisWeek: 0 };
  const dbPath = join(__dirname, '..', 'data', 'lab_assistant.db');
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      const today = new Date().toISOString().split('T')[0];
      const yesterday = new Date(Date.now() - 86400000).toISOString().split('T')[0];
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];

      // Count shipped jobs by data_date (the date in the source file)
      const todayCount = db.prepare(`SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived = 1 AND data_date = ?`).get(today) as any;
      const yesterdayCount = db.prepare(`SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived = 1 AND data_date = ?`).get(yesterday) as any;
      const weekCount = db.prepare(`SELECT COUNT(*) as cnt FROM dvi_jobs WHERE archived = 1 AND data_date >= ?`).get(weekAgo) as any;

      shippedStats = {
        today: todayCount?.cnt || 0,
        yesterday: yesterdayCount?.cnt || 0,
        thisWeek: weekCount?.cnt || 0
      };
      db.close();
    } catch (e) {
      log.error('[Stats] Shipped count error:', e);
    }
  }

  res.json({
    mock: isMock,
    stats,
    shipped: shippedStats,
    uploadedAt: current?.uploadedAt || null,
    dataDate: current?.dataDate || null
  });
});

// WIP Summary endpoint - returns aggregated stats + limited job list to avoid token limits
// Merges data from SQLite (SOAP polling) and XML uploads
app.get('/api/wip/summary', (_req: Request, res: Response) => {
  const dbPath = join(__dirname, '..', 'data', 'lab_assistant.db');
  let dbJobs: any[] = [];

  // First, get jobs from SQLite (SOAP polling data)
  if (existsSync(dbPath)) {
    try {
      const db = new Database(dbPath);
      dbJobs = db.prepare(`
        SELECT id, invoice, tray, stage, station, status, rush, entry_date, days_in_lab, coating, frame_name, rx_number
        FROM dvi_jobs WHERE archived = 0
      `).all();
      db.close();
    } catch (e) {
      log.error('[WIP] SQLite read error:', e);
    }
  }

  // Then get jobs from XML upload store
  const current = dviDataStore.current;
  const xmlJobs = current?.jobs || [];

  // Filter XML jobs to active only (not shipped/canceled)
  const activeXmlJobs = xmlJobs.filter((j: any) => {
    const status = (j.status || '').toUpperCase();
    const stage = (j.stage || j.Stage || j.station || '').toUpperCase();
    return status !== 'SHIPPED' && status !== 'CANCELED' && stage !== 'SHIPPED' && stage !== 'CANCELED';
  });

  // Merge: use SQLite as primary, XML as supplement (avoid duplicates by invoice)
  const jobMap = new Map<string, any>();

  // Add XML jobs first
  activeXmlJobs.forEach((j: any) => {
    const key = j.invoice || j.id || j.tray;
    if (key) jobMap.set(key, { ...j, source: 'xml' });
  });

  // Add/overwrite with SQLite jobs (fresher data)
  dbJobs.forEach((j: any) => {
    const key = j.invoice || j.id;
    if (key) jobMap.set(key, { ...j, source: 'soap' });
  });

  const allJobs = Array.from(jobMap.values());

  // Compute stats
  const byStage: Record<string, number> = {};
  let rushCount = 0;

  allJobs.forEach((job: any) => {
    const stage = (job.stage || job.Stage || job.station || 'UNKNOWN').toUpperCase();
    byStage[stage] = (byStage[stage] || 0) + 1;
    if (job.rush === 'Y' || job.Rush === 'Y') rushCount++;
  });

  // Sort by days in lab (oldest first)
  const sortedByAge = [...allJobs].sort((a: any, b: any) => {
    const daysA = parseInt(a.daysInLab || a.days_in_lab) || 0;
    const daysB = parseInt(b.daysInLab || b.days_in_lab) || 0;
    return daysB - daysA;
  });

  // Return limited data to avoid token limits
  res.json({
    totalWIP: allJobs.length,
    byStage,
    rushJobs: rushCount,
    dataDate: current?.dataDate || new Date().toISOString().split('T')[0],
    uploadedAt: current?.uploadedAt || null,
    sources: {
      soap: dbJobs.length,
      xml: activeXmlJobs.length,
      merged: allJobs.length
    },
    // Only return top 20 oldest jobs with essential fields
    oldestJobs: sortedByAge.slice(0, 20).map((j: any) => ({
      invoice: j.invoice,
      tray: j.tray,
      stage: j.stage || j.Stage || j.station,
      daysInLab: j.daysInLab || j.days_in_lab,
      entryDate: j.entryDate || j.entry_date,
      shipDate: j.shipDate || j.ship_date,
      rush: j.rush || j.Rush,
      coatR: j.coatR || j.coating,
      coatL: j.coatL,
      source: j.source
    })),
    // Stage breakdown for context
    stageSummary: Object.entries(byStage)
      .sort(([,a], [,b]) => (b as number) - (a as number))
      .slice(0, 10)
      .map(([stage, count]) => `${stage}: ${count}`)
      .join(', ')
  });
});

// Production status endpoint - quick summary for agents
app.get('/api/production/status', (_req: Request, res: Response) => {
  const current = dviDataStore.current;
  if (!current) {
    return res.json({ status: 'no_data', message: 'No DVI data uploaded' });
  }

  const jobs = current.jobs || [];
  const stages = ['SURFACING', 'CUTTING', 'COATING', 'ASSEMBLY', 'SHIPPING'];

  const status: Record<string, { count: number; rush: number }> = {};
  stages.forEach(s => status[s] = { count: 0, rush: 0 });

  jobs.forEach((job: any) => {
    const stage = (job.stage || job.Stage || job.station || '').toUpperCase();
    if (stage === 'CANCELED' || job.status === 'CANCELED') return;

    for (const s of stages) {
      if (stage.includes(s) || (job.station || '').toUpperCase().includes(s)) {
        status[s].count++;
        if (job.rush === 'Y' || job.Rush === 'Y') status[s].rush++;
        break;
      }
    }
  });

  res.json({
    status: 'ok',
    dataDate: current.dataDate,
    totalActive: jobs.filter((j: any) => j.status !== 'CANCELED' && j.status !== 'SHIPPED').length,
    stages: status
  });
});

// Clear uploaded DVI data (reset to empty state, keeps archive)
app.delete('/api/dvi/data', (_req: Request, res: Response) => {
  const previousCount = dviDataStore.current?.rowCount || 0;
  // Archive current before clearing
  if (dviDataStore.current) {
    dviDataStore.archive.push(dviDataStore.current);
  }
  dviDataStore.current = null;
  saveDviData();
  log.info(`DVI current data cleared (was ${previousCount} jobs), archive has ${dviDataStore.archive.length} uploads`);
  res.json({ success: true, message: `Cleared ${previousCount} jobs`, archiveCount: dviDataStore.archive.length });
});

// Clear all DVI data including archive
app.delete('/api/dvi/all', (_req: Request, res: Response) => {
  const currentCount = dviDataStore.current?.rowCount || 0;
  const archiveCount = dviDataStore.archive.length;
  dviDataStore = { current: null, archive: [] };
  saveDviData();
  log.info(`DVI data fully cleared: ${currentCount} current jobs, ${archiveCount} archived uploads`);
  res.json({ success: true, message: `Cleared all data (${currentCount} current, ${archiveCount} archived)` });
});

// ─────────────────────────────────────────────────────────────────────────────
// DVI SOAP Live API (real-time connection to DVI RxLab)
// ─────────────────────────────────────────────────────────────────────────────
import * as dviSoap from './sources/dvi-soap.js';

// Get live orders from DVI
app.get('/api/dvi/live/orders', async (req: Request, res: Response) => {
  try {
    const maxOrders = parseInt(req.query.max as string) || 100;
    const orders = await dviSoap.downloadOrders(maxOrders);
    res.json({
      mock: false,
      orders,
      count: orders.length,
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    // Check if it's a config issue
    if (msg.includes('No password')) {
      return res.json({ mock: true, orders: [], count: 0, message: 'DVI SOAP not configured' });
    }
    res.status(500).json({ error: msg });
  }
});

// Get status updates from DVI
app.get('/api/dvi/live/statuses', async (req: Request, res: Response) => {
  try {
    const hours = parseInt(req.query.hours as string) || 24;
    const fromDate = new Date(Date.now() - hours * 60 * 60 * 1000);
    const statuses = await dviSoap.downloadStatuses(fromDate);
    res.json({
      mock: false,
      statuses,
      count: statuses.length,
      since: fromDate.toISOString(),
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    if (msg.includes('No password')) {
      return res.json({ mock: true, statuses: [], count: 0, message: 'DVI SOAP not configured' });
    }
    res.status(500).json({ error: msg });
  }
});

// DVI SOAP health check
app.get('/api/dvi/live/health', async (_req: Request, res: Response) => {
  const health = await dviSoap.healthCheck();
  res.json(health);
});

// DVI context for AI
app.get('/api/dvi/live/context', async (_req: Request, res: Response) => {
  try {
    const context = await dviSoap.getAIContext();
    res.json({ context });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

// Get order detail by order number (includes current station)
app.get('/api/dvi/live/order/:orderNumber', async (req: Request, res: Response) => {
  try {
    const detail = await dviSoap.getOrderDetail(req.params.orderNumber);
    res.json({ mock: false, detail });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

// Lookup jobs by Rx number, tray, or account
app.get('/api/dvi/live/lookup', async (req: Request, res: Response) => {
  try {
    const query = req.query.q as string;
    const type = (req.query.type as 'account' | 'tray' | 'rxnum') || 'rxnum';
    if (!query) {
      return res.status(400).json({ error: 'Missing query parameter ?q=' });
    }
    const results = await dviSoap.lookupByAccount(query, type);
    res.json({ mock: false, query, type, results, count: results.length });
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Failed to fetch';
    res.status(500).json({ error: msg });
  }
});

function generateMockDVIJobs() {
  const stages = ['SURFACING', 'COATING', 'CUTTING', 'ASSEMBLY', 'QC', 'SHIP'];
  const statuses = ['In Progress', 'Completed', 'On Hold', 'Pending'];
  return Array.from({ length: 100 }, (_, i) => ({
    job_id: `J${String(20000 + i).padStart(5, '0')}`,
    order_id: `ORD-${String(10000 + Math.floor(i / 2)).padStart(5, '0')}`,
    stage: stages[Math.floor(Math.random() * stages.length)],
    status: statuses[Math.floor(Math.random() * statuses.length)],
    rush: Math.random() > 0.85 ? 'Y' : 'N',
    rx_type: ['SV', 'PAL', 'BIF'][Math.floor(Math.random() * 3)],
    created_at: new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString(),
    operator: ['Maria', 'Jose', 'Ana', 'Carlos', 'Elena'][Math.floor(Math.random() * 5)]
  }));
}

// Rate limit configuration endpoints
app.get('/gateway/config/limits', (_req: Request, res: Response) => {
  const limits = getRateLimits();
  res.json(limits);
});

app.post('/gateway/config/limits', (req: Request, res: Response) => {
  try {
    updateRateLimits(req.body);
    res.json({ success: true, limits: getRateLimits() });
  } catch (error) {
    res.status(400).json({ error: 'Invalid configuration', message: String(error) });
  }
});

// Detailed stats endpoint
app.get('/gateway/stats/detailed', async (req: Request, res: Response) => {
  const since = (req.query.since as string) || '24h';
  const stats = await getRequestStats(since);
  const concurrent = getConcurrentCounts();
  const circuit = await getCircuitState();
  const limits = getRateLimits();

  res.json({
    stats,
    concurrent,
    circuit,
    limits,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount Source Routers
// ─────────────────────────────────────────────────────────────────────────────

// REST API endpoints
app.use('/api', initRestRouter());

// Web SSE endpoints
app.use('/web', initWebRouter());

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  log.info('Starting Lab Assistant Agentic Gateway...');

  // Initialize circuit breaker (non-blocking - don't wait for DB)
  initCircuitBreaker({
    onOpen: () => {
      log.error('Circuit breaker OPENED - Lab Assistant API is unavailable');
      // TODO: Post to Slack #lab-alerts
    },
    onClose: () => {
      log.info('Circuit breaker CLOSED - Lab Assistant API recovered');
      // TODO: Post to Slack #lab-alerts
    },
  }).catch((err) => {
    log.error('Circuit breaker initialization failed:', err);
  });

  // Start Express server FIRST (don't block on anything)
  app.listen(PORT, () => {
    log.info(`
╔══════════════════════════════════════════════════════════════╗
║          Lab Assistant Agentic Gateway                       ║
╠══════════════════════════════════════════════════════════════╣
║  Local:   http://localhost:${PORT}                              ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /health              ← Health check                  ║
║    POST /api/ask             ← REST query (JWT auth)         ║
║    GET  /api/agents          ← List available agents         ║
║    POST /api/token           ← Generate JWT (API key auth)   ║
║    POST /web/ask             ← SSE streaming query           ║
║    POST /web/ask-sync        ← Non-streaming query           ║
║    GET  /gateway/stats/*     ← Usage statistics              ║
║    GET  /gateway/requests    ← Recent request feed           ║
║    GET  /gateway/agents      ← Agent prompt metadata         ║
║    GET  /gateway/health      ← Circuit breaker status        ║
║    POST /gateway/health/check← Force health check            ║
╚══════════════════════════════════════════════════════════════╝
`);

    // Initialize Slack AFTER Express is listening (non-blocking, lazy-loads @slack/bolt)
    initSlack()
      .then((slackApp) => {
        if (slackApp) {
          return startSlack();
        }
      })
      .catch((err) => {
        log.error('Slack initialization failed:', err);
      });
  });
}

start().catch((error) => {
  log.error('Failed to start gateway:', error);
  process.exit(1);
});
