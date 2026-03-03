/**
 * MCP Server
 * Wraps Lab Assistant REST API as MCP tools for agents
 */

import { log } from '../logger.js';

// Gateway has all API endpoints agents need (inventory, maintenance, DVI, WIP)
// Lab server (3002) also has some, but gateway is the unified API layer
const LAB_ASSISTANT_URL = process.env.LAB_ASSISTANT_API_URL || 'http://localhost:3001';
const LAB_ASSISTANT_KEY = process.env.LAB_ASSISTANT_API_KEY;

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

async function handleCallApi(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  const url = `${LAB_ASSISTANT_URL}${endpoint}`;

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
      signal: AbortSignal.timeout(10000),
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
