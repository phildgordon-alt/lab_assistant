/**
 * MCP Server
 * Wraps Lab Assistant REST API as MCP tools for agents
 */

import { log } from '../logger.js';
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Use lab server (3002) for inventory/maintenance to avoid gateway calling itself
// DVI data is loaded directly from the persisted JSON file
const LAB_SERVER_URL = process.env.LAB_ASSISTANT_API_URL || 'http://localhost:3002';
const LAB_ASSISTANT_KEY = process.env.LAB_ASSISTANT_API_KEY;

// Path to persisted DVI data (same as gateway uses)
const DVI_DATA_FILE = join(__dirname, '..', '..', 'data', 'dvi-jobs.json');

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions (for Claude API tools parameter)
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_TOOLS = [
  {
    name: 'query_database',
    description: 'Run a read-only SQL query against the lab database. Returns rows as JSON array.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'SQL SELECT query to run. Must be read-only.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'call_api',
    description: 'Call a Lab Assistant REST API endpoint. Returns JSON response.',
    input_schema: {
      type: 'object',
      properties: {
        method: {
          type: 'string',
          enum: ['GET', 'POST'],
          description: 'HTTP method',
        },
        endpoint: {
          type: 'string',
          description: 'API endpoint path, e.g. /api/inventory or /api/maintenance/stats',
        },
        body: {
          type: 'object',
          description: 'Request body for POST requests (optional)',
        },
      },
      required: ['method', 'endpoint'],
    },
  },
  {
    name: 'take_action',
    description: 'Execute a write operation in the lab system. Requires confirmation. All actions are audit logged.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          description: 'Action to take, e.g. "bind_tray", "complete_batch", "log_defect"',
        },
        params: {
          type: 'object',
          description: 'Parameters for the action',
        },
        reason: {
          type: 'string',
          description: 'Reason for taking this action (for audit log)',
        },
      },
      required: ['action', 'params', 'reason'],
    },
  },
  {
    name: 'think_aloud',
    description: 'Structure your reasoning before responding. Use this to break down complex problems. Has no side effects.',
    input_schema: {
      type: 'object',
      properties: {
        thought: {
          type: 'string',
          description: 'Your reasoning or analysis',
        },
      },
      required: ['thought'],
    },
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────────────────────

export async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<unknown> {
  log.debug(`MCP tool call: ${toolName}`, toolInput);

  switch (toolName) {
    case 'query_database':
      return handleQueryDatabase(toolInput.query as string);

    case 'call_api':
      return handleCallApi(
        toolInput.method as string,
        toolInput.endpoint as string,
        toolInput.body as Record<string, unknown> | undefined
      );

    case 'take_action':
      return handleTakeAction(
        toolInput.action as string,
        toolInput.params as Record<string, unknown>,
        toolInput.reason as string
      );

    case 'think_aloud':
      return handleThinkAloud(toolInput.thought as string);

    default:
      throw new Error(`Unknown tool: ${toolName}`);
  }
}

async function handleQueryDatabase(query: string): Promise<unknown> {
  // Validate query is read-only
  const upperQuery = query.toUpperCase().trim();
  if (!upperQuery.startsWith('SELECT') && !upperQuery.startsWith('WITH')) {
    throw new Error('Only SELECT queries are allowed');
  }

  // Disallow dangerous keywords
  const dangerousKeywords = ['INSERT', 'UPDATE', 'DELETE', 'DROP', 'CREATE', 'ALTER', 'TRUNCATE'];
  for (const keyword of dangerousKeywords) {
    if (upperQuery.includes(keyword)) {
      throw new Error(`Query contains forbidden keyword: ${keyword}`);
    }
  }

  // Forward to Lab Assistant API (which would have a /api/query endpoint)
  // For now, return a stub
  log.warn('query_database: Not yet connected to real database');
  return {
    success: false,
    error: 'Database query endpoint not yet implemented',
    query,
  };
}

// Load DVI data directly from file (avoids gateway calling itself)
function loadDviData(): { current: any | null; archive: any[] } {
  try {
    if (existsSync(DVI_DATA_FILE)) {
      const data = readFileSync(DVI_DATA_FILE, 'utf-8');
      return JSON.parse(data);
    }
  } catch (e) {
    log.error('Failed to load DVI data from disk:', e);
  }
  return { current: null, archive: [] };
}

// Handle DVI/WIP endpoints locally (without HTTP call to gateway)
function handleDviEndpoint(endpoint: string): unknown {
  const dviData = loadDviData();
  const current = dviData.current;

  if (endpoint === '/api/wip/summary') {
    if (!current) {
      return { totalWIP: 0, byStage: {}, rushJobs: 0, oldestJobs: [], message: 'No DVI data uploaded' };
    }
    const jobs = current.jobs || [];
    const byStage: Record<string, number> = {};
    let rushCount = 0;

    jobs.forEach((job: any) => {
      const stage = (job.stage || job.Stage || job.station || 'UNKNOWN').toUpperCase();
      if (stage === 'CANCELED' || stage === 'SHIPPED' || job.status === 'CANCELED' || job.status === 'SHIPPED') return;
      byStage[stage] = (byStage[stage] || 0) + 1;
      if (job.rush === 'Y' || job.Rush === 'Y') rushCount++;
    });

    const activeJobs = jobs.filter((j: any) => {
      const stage = (j.stage || j.Stage || j.station || '').toUpperCase();
      return stage !== 'CANCELED' && stage !== 'SHIPPED' && j.status !== 'CANCELED' && j.status !== 'SHIPPED';
    });

    const sortedByAge = [...activeJobs].sort((a: any, b: any) => {
      const daysA = parseInt(a.daysInLab) || 0;
      const daysB = parseInt(b.daysInLab) || 0;
      return daysB - daysA;
    });

    return {
      totalWIP: activeJobs.length,
      byStage,
      rushJobs: rushCount,
      dataDate: current.dataDate,
      uploadedAt: current.uploadedAt,
      oldestJobs: sortedByAge.slice(0, 20).map((j: any) => ({
        job_id: j.job_id || j.invoice || j.tray || 'unknown',
        invoice: j.invoice,
        tray: j.tray,
        stage: j.stage || j.Stage || j.station,
        station: j.station,
        date: j.date || j.entryDate || j.entry_date,
        daysInLab: j.daysInLab || j.days_in_lab,
        status: j.status,
        rush: j.rush || j.Rush,
      })),
      stageSummary: Object.entries(byStage)
        .sort(([,a], [,b]) => (b as number) - (a as number))
        .slice(0, 10)
        .map(([stage, count]) => `${stage}: ${count}`)
        .join(', ')
    };
  }

  if (endpoint === '/api/production/status') {
    if (!current) {
      return { status: 'no_data', message: 'No DVI data uploaded' };
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

    return {
      status: 'ok',
      dataDate: current.dataDate,
      totalActive: jobs.filter((j: any) => j.status !== 'CANCELED' && j.status !== 'SHIPPED').length,
      stages: status
    };
  }

  if (endpoint === '/api/dvi/stats') {
    if (!current) {
      return { mock: false, stats: { totalJobs: 0, byStatus: {}, byStage: {}, noData: true } };
    }
    const jobs = current.jobs || [];
    const stats = {
      totalJobs: jobs.length,
      byStatus: {} as Record<string, number>,
      byStage: {} as Record<string, number>,
      rushJobs: 0,
    };
    jobs.forEach((job: any) => {
      const status = job.status || job.Status || 'unknown';
      const stage = job.stage || job.Stage || job.station || 'unknown';
      stats.byStatus[status] = (stats.byStatus[status] || 0) + 1;
      stats.byStage[stage] = (stats.byStage[stage] || 0) + 1;
      if (job.rush === 'Y' || job.Rush === 'Y') stats.rushJobs++;
    });
    return { mock: false, stats, uploadedAt: current.uploadedAt, dataDate: current.dataDate };
  }

  return null;
}

async function handleCallApi(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  // Handle DVI/WIP endpoints locally to avoid gateway calling itself
  const dviEndpoints = ['/api/wip/summary', '/api/production/status', '/api/dvi/stats'];
  if (method === 'GET' && dviEndpoints.includes(endpoint)) {
    const result = handleDviEndpoint(endpoint);
    if (result) {
      log.debug(`call_api ${endpoint} handled locally`);
      return result;
    }
  }

  // For other endpoints, call the lab server (3002)
  const url = `${LAB_SERVER_URL}${endpoint}`;

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (LAB_ASSISTANT_KEY) {
    headers['X-API-Key'] = LAB_ASSISTANT_KEY;
  }

  try {
    const response = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`API error ${response.status}: ${text}`);
    }

    return await response.json();
  } catch (error) {
    log.error(`call_api failed: ${endpoint}`, error);
    throw error;
  }
}

async function handleTakeAction(
  action: string,
  params: Record<string, unknown>,
  reason: string
): Promise<unknown> {
  // Log the action for audit
  log.info(`AUDIT: Action "${action}" requested. Reason: ${reason}`, params);

  // Forward to Lab Assistant API
  return handleCallApi('POST', '/api/actions', {
    action,
    params,
    reason,
    timestamp: new Date().toISOString(),
  });
}

async function handleThinkAloud(thought: string): Promise<unknown> {
  // This tool has no side effects - just returns the thought
  // Useful for the agent to structure reasoning
  return {
    acknowledged: true,
    thought,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Context Builders (for system prompts)
// ─────────────────────────────────────────────────────────────────────────────

export async function getInventoryContext(): Promise<string> {
  try {
    const data = await handleCallApi('GET', '/api/inventory');
    return JSON.stringify(data, null, 2);
  } catch {
    return 'Inventory data unavailable';
  }
}

export async function getMaintenanceContext(): Promise<string> {
  try {
    const data = await handleCallApi('GET', '/api/maintenance/stats');
    return JSON.stringify(data, null, 2);
  } catch {
    return 'Maintenance data unavailable';
  }
}

export async function getOvenContext(): Promise<string> {
  try {
    const data = await handleCallApi('GET', '/api/oven-stats');
    return JSON.stringify(data, null, 2);
  } catch {
    return 'Oven data unavailable';
  }
}
