/**
 * MCP Server
 * Wraps Lab Assistant REST API as MCP tools for agents
 *
 * Architecture:
 * - Tools defined in tools/definitions.ts with WHEN/WHAT/HOW/NOT descriptions
 * - Agent configs in agents/index.ts define tool subsets per department
 * - System prompts in prompts.ts with department-specific behavioral rules
 * - This file handles tool execution and SQLite queries
 */

import { log } from '../logger.js';
import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

// Import from new modular structure
import { ALL_TOOLS } from './tools/definitions.js';
import {
  getAgentConfig,
  getAgentTools,
  getAgentSystemPrompt,
  applyAgentDefaults,
  getAvailableAgents,
  type AgentConfig,
} from './agents/index.js';
import { AGENT_PROMPTS } from './prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// Settings (loaded from settings.toml)
// ─────────────────────────────────────────────────────────────────────────────

const SETTINGS_FILE = join(__dirname, 'settings.toml');
let settings: Record<string, any> = {};

function loadSettings(): void {
  try {
    if (existsSync(SETTINGS_FILE)) {
      const content = readFileSync(SETTINGS_FILE, 'utf-8');
      // Simple TOML parser for our flat structure
      const lines = content.split('\n');
      let currentSection = '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          currentSection = trimmed.slice(1, -1);
          settings[currentSection] = settings[currentSection] || {};
        } else if (trimmed.includes('=')) {
          const [key, ...valueParts] = trimmed.split('=');
          let value: any = valueParts.join('=').trim();
          // Parse value type
          if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1);
          } else if (value === 'true') {
            value = true;
          } else if (value === 'false') {
            value = false;
          } else if (!isNaN(parseFloat(value))) {
            value = parseFloat(value);
          }
          if (currentSection) {
            settings[currentSection][key.trim()] = value;
          } else {
            settings[key.trim()] = value;
          }
        }
      }
      log.info('[MCP] Settings loaded from settings.toml');
    }
  } catch (e: any) {
    log.warn('[MCP] Failed to load settings.toml:', e.message);
  }
}

loadSettings();

export function getSettings(section?: string): Record<string, any> {
  if (section) {
    return settings[section] || {};
  }
  return settings;
}

// ─────────────────────────────────────────────────────────────────────────────
// SQLite Database
// ─────────────────────────────────────────────────────────────────────────────

const DB_FILE = join(__dirname, '..', '..', 'data', 'lab_assistant.db');
let db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!db) {
    if (!existsSync(DB_FILE)) {
      log.warn('[MCP] SQLite database not found, queries will return empty results');
      throw new Error('Database not initialized. Lab server must run first to create it.');
    }
    db = new Database(DB_FILE, { readonly: true });
  }
  return db;
}

// Fallback to lab server for endpoints not in SQLite
const LAB_SERVER_URL = process.env.LAB_ASSISTANT_API_URL || 'http://localhost:3002';
const LAB_ASSISTANT_KEY = process.env.LAB_ASSISTANT_API_KEY;

// ─────────────────────────────────────────────────────────────────────────────
// Re-export from new modular structure
// ─────────────────────────────────────────────────────────────────────────────

export {
  getAgentConfig,
  getAgentTools,
  getAgentSystemPrompt,
  applyAgentDefaults,
  getAvailableAgents,
  AGENT_PROMPTS,
};
export type { AgentConfig };

// ─────────────────────────────────────────────────────────────────────────────
// Tool Definitions (for Claude API tools parameter)
// Now imported from tools/definitions.ts with WHEN/WHAT/HOW/NOT descriptions
// ─────────────────────────────────────────────────────────────────────────────

// Legacy export for backwards compatibility
export const MCP_TOOLS = ALL_TOOLS;

/**
 * Get all tool definitions with metadata for UI
 * Includes both built-in and custom tools
 */
export function getAllToolDefinitions(): Array<{
  name: string;
  description: string;
  category: string;
  inputSchema: any;
  custom?: boolean;
}> {
  const categories: Record<string, string[]> = {
    'WIP & Jobs': ['get_wip_snapshot', 'get_wip_jobs', 'get_job_detail'],
    'Reports': ['get_aging_report', 'get_throughput_trend', 'get_remake_rate'],
    'Breakage': ['get_breakage_summary', 'get_breakage_events', 'get_breakage_by_position'],
    'Coating': ['get_coating_queue', 'get_coating_wait_summary'],
    'Inventory': ['get_inventory_summary', 'get_inventory_detail'],
    'Maintenance': ['get_maintenance_summary', 'get_maintenance_tasks'],
    'Catalog': ['get_lens_catalog', 'get_frame_catalog', 'get_opc_history'],
    'Settings': ['get_settings', 'update_setting'],
    'Generic': ['query_database', 'call_api', 'think_aloud'],
  };

  const categoryMap: Record<string, string> = {};
  for (const [cat, tools] of Object.entries(categories)) {
    for (const t of tools) categoryMap[t] = cat;
  }

  const builtInTools = ALL_TOOLS.map(tool => ({
    name: tool.name,
    description: tool.description,
    category: categoryMap[tool.name] || 'Other',
    inputSchema: tool.input_schema,
    custom: false,
  }));

  // Load custom tools from file
  const customToolsFile = join(__dirname, 'custom-tools.json');
  let customTools: any[] = [];
  if (existsSync(customToolsFile)) {
    try {
      customTools = JSON.parse(readFileSync(customToolsFile, 'utf-8')).map((t: any) => ({
        name: t.name,
        description: t.description,
        category: t.category || 'Custom',
        inputSchema: t.input_schema,
        custom: true,
      }));
    } catch { /* ignore */ }
  }

  return [...builtInTools, ...customTools];
}

/**
 * Get all MCP agent configurations for UI
 */
export function getAllAgentConfigs(): Array<{
  name: string;
  description: string;
  department: string | null;
  tools: string[];
}> {
  const agents = getAvailableAgents();
  return agents.map(name => {
    const config = getAgentConfig(name);
    return {
      name: config.name,
      description: config.description,
      department: config.department || null,
      tools: config.tools.map((t: any) => t.name),
    };
  });
}

/**
 * Get tools for a specific agent (department-scoped)
 * This is the preferred way to get tools - each agent sees only relevant tools
 */
export function getToolsForAgent(agentName: string): any[] {
  return getAgentTools(agentName);
}

/**
 * Handle tool call with agent context
 * Applies department defaults from agent config before execution
 */
export async function handleAgentToolCall(
  agentName: string,
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<unknown> {
  // Apply agent defaults (e.g., department filter)
  const augmentedInput = applyAgentDefaults(agentName, toolName, toolInput as Record<string, any>);
  log.debug(`[MCP] Agent ${agentName} calling ${toolName}`, augmentedInput);

  return handleToolCall(toolName, augmentedInput);
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool Handlers
// ─────────────────────────────────────────────────────────────────────────────

export async function handleToolCall(
  toolName: string,
  toolInput: Record<string, unknown>
): Promise<unknown> {
  log.debug(`MCP tool call: ${toolName}`, toolInput);

  switch (toolName) {
    // ─────────────────────────────────────────────────────────────────────────
    // WIP & JOB TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_wip_snapshot':
      return handleGetWipSnapshot(toolInput.summary_only as boolean ?? true);

    case 'get_wip_jobs':
      return handleGetWipJobs(toolInput);

    case 'get_job_detail':
      return handleGetJobDetail(toolInput.invoice as string);

    // ─────────────────────────────────────────────────────────────────────────
    // AGING & THROUGHPUT REPORTS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_aging_report':
      return handleGetAgingReport(toolInput.threshold_hours as number ?? 48);

    case 'get_throughput_trend':
      return handleGetThroughputTrend(toolInput.days as number ?? 7);

    case 'get_remake_rate':
      return handleGetRemakeRate(
        toolInput.period as string ?? 'week',
        toolInput.group_by as string ?? 'department'
      );

    // ─────────────────────────────────────────────────────────────────────────
    // BREAKAGE TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_breakage_summary':
      return handleGetBreakageSummary(
        toolInput.department as string | undefined,
        toolInput.since_days as number ?? 7
      );

    case 'get_breakage_events':
      return handleGetBreakageEvents(toolInput);

    case 'get_breakage_by_position':
      return handleGetBreakageByPosition(
        toolInput.department as string,
        toolInput.since_days as number ?? 7
      );

    // ─────────────────────────────────────────────────────────────────────────
    // COATING TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_coating_queue':
    case 'get_coating_queue_aged':
      return handleGetCoatingQueueAged(toolInput.min_wait_days as number ?? toolInput.min_days as number ?? 0);

    case 'get_coating_wait_summary':
      return handleGetCoatingWaitSummary();

    case 'get_coating_intelligence':
      return handleGetCoatingIntelligence();

    case 'get_coating_batch_history':
      return handleGetCoatingBatchHistory(toolInput.limit as number ?? 50);

    case 'submit_coating_batch_plan':
      return handleSubmitCoatingBatchPlan(toolInput.plan as Record<string, unknown>);

    case 'get_oven_rack_status':
      return handleGetOvenRackStatus();

    // ─────────────────────────────────────────────────────────────────────────
    // INVENTORY TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_inventory_summary':
      return handleGetInventorySummary();

    case 'get_inventory_detail':
      return handleGetInventoryDetail(toolInput);

    // ─────────────────────────────────────────────────────────────────────────
    // MAINTENANCE TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_maintenance_summary':
      return handleGetMaintenanceSummary();

    case 'get_maintenance_tasks':
      return handleGetMaintenanceTasks(toolInput);

    // ─────────────────────────────────────────────────────────────────────────
    // CATALOG TOOLS (SCD Type 2)
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_lens_catalog':
      return handleGetLensCatalog(toolInput);

    case 'get_frame_catalog':
      return handleGetFrameCatalog(toolInput);

    case 'get_opc_history':
      return handleGetOpcHistory(toolInput.opc as string);

    // ─────────────────────────────────────────────────────────────────────────
    // SETTINGS TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_settings':
      return handleGetSettings(toolInput.section as string | undefined);

    case 'update_setting':
      return handleUpdateSetting(
        toolInput.section as string,
        toolInput.key as string,
        toolInput.value as string,
        toolInput.confirm as boolean ?? false
      );

    // ─────────────────────────────────────────────────────────────────────────
    // GENERIC TOOLS (fallback)
    // ─────────────────────────────────────────────────────────────────────────
    case 'query_database':
      return handleQueryDatabase(toolInput.query as string);

    // ─────────────────────────────────────────────────────────────────────────
    // TIME AT LAB TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_time_at_lab_summary':
      return handleCallApi('GET', `/api/time-at-lab/summary?period=${toolInput.period || '7d'}`);

    case 'get_time_at_lab_job':
      return handleCallApi('GET', `/api/time-at-lab/job/${encodeURIComponent(toolInput.job_id as string)}`);

    case 'get_time_at_lab_histogram': {
      const params = new URLSearchParams();
      if (toolInput.mode) params.set('mode', toolInput.mode as string);
      if (toolInput.lensType) params.set('lensType', toolInput.lensType as string);
      if (toolInput.coating) params.set('coating', toolInput.coating as string);
      if (toolInput.stage) params.set('stage', toolInput.stage as string);
      if (toolInput.period) params.set('period', toolInput.period as string);
      return handleCallApi('GET', `/api/time-at-lab/histogram?${params}`);
    }

    case 'get_sla_at_risk':
      return handleCallApi('GET', '/api/time-at-lab/at-risk');

    // ─────────────────────────────────────────────────────────────────────────
    // MACHINE & OPERATOR TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_som_status':
      return handleCallApi('GET', '/api/som/devices');

    case 'get_dvi_operator_data':
      return handleCallApi('GET', `/api/dvi/data${toolInput.department ? '?department=' + toolInput.department : ''}`);

    case 'get_backlog_catchup':
      return handleCallApi('GET', `/api/lab/catchup${toolInput.department ? '?department=' + toolInput.department : ''}`);

    // ─────────────────────────────────────────────────────────────────────────
    // GENERIC TOOLS
    // ─────────────────────────────────────────────────────────────────────────
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

    // ─────────────────────────────────────────────────────────────────────────
    // KNOWLEDGE BASE TOOLS
    // ─────────────────────────────────────────────────────────────────────────
    case 'search_knowledge':
      return handleSearchKnowledge(
        toolInput.query as string,
        toolInput.category as string | undefined,
        toolInput.limit as number ?? 5
      );

    case 'get_knowledge_doc':
      return handleGetKnowledgeDoc(toolInput.doc_id as string);

    case 'generate_csv_report':
      return handleGenerateCsvReport(
        toolInput.title as string,
        toolInput.headers as string[],
        toolInput.rows as string[][]
      );

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

  // Execute query against SQLite
  try {
    const database = getDb();
    const rows = database.prepare(query).all();
    return {
      success: true,
      rowCount: rows.length,
      rows,
    };
  } catch (e: any) {
    log.error('query_database failed:', e.message);
    return {
      success: false,
      error: e.message,
      query,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NARROW TOOL HANDLERS (agent-sized results)
// ─────────────────────────────────────────────────────────────────────────────

function handleGetWipSnapshot(summaryOnly: boolean): unknown {
  try {
    const database = getDb();

    const stats = database.prepare(`
      SELECT
        COUNT(*) as total_wip,
        SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush_count,
        ROUND(AVG(days_in_lab), 1) as avg_days,
        MAX(days_in_lab) as max_days
      FROM dvi_jobs
      WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')
    `).get() as { total_wip: number; rush_count: number; avg_days: number; max_days: number };

    const byStage = database.prepare(`
      SELECT stage, COUNT(*) as count
      FROM dvi_jobs
      WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')
      GROUP BY stage ORDER BY count DESC LIMIT 10
    `).all();

    return {
      totalWip: stats.total_wip,
      rushCount: stats.rush_count,
      avgDays: stats.avg_days,
      maxDays: stats.max_days,
      byStage,
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetCoatingQueueAged(minDays: number): unknown {
  try {
    const database = getDb();

    const jobs = database.prepare(`
      SELECT id, invoice, tray, stage, coating, days_in_lab, rush, entry_date
      FROM dvi_jobs
      WHERE archived = 0
        AND (stage LIKE '%COAT%' OR stage LIKE '%AR%' OR stage LIKE '%BLU%')
        AND days_in_lab >= ?
      ORDER BY days_in_lab DESC
      LIMIT 25
    `).all(minDays);

    const summary = database.prepare(`
      SELECT coating, COUNT(*) as count, AVG(days_in_lab) as avg_days
      FROM dvi_jobs
      WHERE archived = 0 AND (stage LIKE '%COAT%' OR stage LIKE '%AR%' OR stage LIKE '%BLU%')
      GROUP BY coating
      ORDER BY count DESC
    `).all();

    return {
      jobs,
      summary,
      filter: { minDays },
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetBreakageSummary(department: string | undefined, sinceDays: number): unknown {
  try {
    const database = getDb();
    const deptFilter = department ? `AND department = '${department}'` : '';

    const summary = database.prepare(`
      SELECT department, reason, COUNT(*) as count
      FROM breakage_events
      WHERE occurred_at >= datetime('now', '-${sinceDays} days') ${deptFilter}
      GROUP BY department, reason
      ORDER BY count DESC
      LIMIT 15
    `).all();

    const recentEvents = database.prepare(`
      SELECT job_id, invoice, department, reason, occurred_at
      FROM breakage_events
      WHERE occurred_at >= datetime('now', '-${sinceDays} days') ${deptFilter}
      ORDER BY occurred_at DESC
      LIMIT 5
    `).all();

    const total = database.prepare(`
      SELECT COUNT(*) as count FROM breakage_events
      WHERE occurred_at >= datetime('now', '-${sinceDays} days') ${deptFilter}
    `).get() as { count: number };

    return {
      totalBreakages: total.count,
      summary,
      recentEvents,
      filter: { department, sinceDays },
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetJobDetail(invoice: string): unknown {
  try {
    const database = getDb();

    // Check active jobs first
    const job = database.prepare(`SELECT * FROM dvi_jobs WHERE invoice = ?`).get(invoice);

    if (job) {
      const breakages = database.prepare(`
        SELECT * FROM breakage_events WHERE invoice = ? ORDER BY occurred_at DESC
      `).all(invoice);

      return {
        job,
        breakages,
        status: (job as any).archived ? 'archived' : 'active',
        source: 'sqlite'
      };
    }

    // Check history
    const historical = database.prepare(`
      SELECT * FROM dvi_jobs_history WHERE invoice = ? ORDER BY shipped_at DESC LIMIT 1
    `).get(invoice);

    if (historical) {
      return {
        job: historical,
        status: 'shipped',
        source: 'sqlite'
      };
    }

    return {
      job: null,
      status: 'not_found',
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetAgingReport(thresholdHours: number): unknown {
  try {
    const database = getDb();
    const thresholdDays = thresholdHours / 24;

    // Get aging buckets
    const buckets = [
      { name: '0-1d', min: 0, max: 1 },
      { name: '1-2d', min: 1, max: 2 },
      { name: '2-3d', min: 2, max: 3 },
      { name: '3-5d', min: 3, max: 5 },
      { name: '5-7d', min: 5, max: 7 },
      { name: '7d+', min: 7, max: 9999 }
    ];

    const bucketCounts = buckets.map(bucket => {
      const result = database.prepare(`
        SELECT COUNT(*) as count, SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush
        FROM dvi_jobs
        WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')
          AND days_in_lab >= ? AND days_in_lab < ?
      `).get(bucket.min, bucket.max) as { count: number; rush: number };
      return { bucket: bucket.name, count: result.count, rush: result.rush };
    });

    const overThreshold = database.prepare(`
      SELECT invoice, stage, days_in_lab, rush, entry_date
      FROM dvi_jobs
      WHERE archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED') AND days_in_lab >= ?
      ORDER BY days_in_lab DESC
      LIMIT 20
    `).all(thresholdDays);

    return {
      buckets: bucketCounts,
      overThreshold,
      thresholdHours,
      thresholdDays,
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetThroughputTrend(days: number): unknown {
  try {
    const database = getDb();

    // Try throughput_daily first (warm layer)
    const warmData = database.prepare(`
      SELECT stat_date, jobs_shipped, jobs_in_surfacing, jobs_in_coating,
             jobs_in_cutting, jobs_in_assembly, avg_days_in_lab
      FROM throughput_daily
      WHERE stat_date >= date('now', '-${days} days')
      ORDER BY stat_date DESC
    `).all();

    if (warmData.length > 0) {
      return { trend: warmData, days, source: 'sqlite_warm' };
    }

    // Fallback to computing from history
    const historyData = database.prepare(`
      SELECT date(shipped_at) as stat_date, COUNT(*) as jobs_shipped,
             SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush_shipped,
             ROUND(AVG(days_in_lab), 1) as avg_days
      FROM dvi_jobs_history
      WHERE shipped_at >= datetime('now', '-${days} days')
      GROUP BY date(shipped_at)
      ORDER BY stat_date DESC
    `).all();

    return { trend: historyData, days, source: 'sqlite_history' };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetInventorySummary(): unknown {
  try {
    const database = getDb();

    const total = database.prepare('SELECT COUNT(*) as count, SUM(qty) as qty FROM inventory').get() as { count: number; qty: number };
    const lowStock = database.prepare('SELECT COUNT(*) as c FROM inventory WHERE qty <= 5 AND qty > 0').get() as { c: number };
    const outOfStock = database.prepare('SELECT COUNT(*) as c FROM inventory WHERE qty = 0').get() as { c: number };

    const alerts = database.prepare(`
      SELECT sku, name, qty, severity FROM inventory_alerts
      ORDER BY CASE severity WHEN 'CRITICAL' THEN 1 WHEN 'HIGH' THEN 2 ELSE 3 END, qty
      LIMIT 15
    `).all();

    const byCoating = database.prepare(`
      SELECT coating_type, COUNT(*) as sku_count, SUM(qty) as total_qty
      FROM inventory
      WHERE coating_type IS NOT NULL AND coating_type != ''
      GROUP BY coating_type
      ORDER BY total_qty DESC
      LIMIT 10
    `).all();

    return {
      totalSkus: total.count,
      totalUnits: total.qty || 0,
      lowStock: lowStock.c,
      outOfStock: outOfStock.c,
      alerts,
      byCoating,
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetMaintenanceSummary(): unknown {
  try {
    const database = getDb();

    const open = database.prepare(`
      SELECT COUNT(*) as c FROM maintenance_tasks WHERE status NOT IN ('Complete', 'Closed', 'Completed')
    `).get() as { c: number };

    const critical = database.prepare(`
      SELECT COUNT(*) as c FROM maintenance_tasks
      WHERE priority IN ('Critical', 'High', 'Urgent') AND status NOT IN ('Complete', 'Closed', 'Completed')
    `).get() as { c: number };

    const overdue = database.prepare(`
      SELECT COUNT(*) as c FROM maintenance_tasks
      WHERE status NOT IN ('Complete', 'Closed', 'Completed') AND due_date < datetime('now')
    `).get() as { c: number };

    const lowParts = database.prepare(`SELECT COUNT(*) as c FROM spare_parts WHERE qty <= min_qty`).get() as { c: number };

    const urgentTasks = database.prepare(`
      SELECT id, title, asset_name, priority, status, due_date
      FROM maintenance_tasks
      WHERE priority IN ('Critical', 'High', 'Urgent') AND status NOT IN ('Complete', 'Closed', 'Completed')
      ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 ELSE 3 END, due_date
      LIMIT 10
    `).all();

    return {
      openTaskCount: open.c,
      criticalTaskCount: critical.c,
      overdueTaskCount: overdue.c,
      lowStockParts: lowParts.c,
      urgentTasks,
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// NEW TOOL HANDLERS (from definitions.ts)
// ─────────────────────────────────────────────────────────────────────────────

function handleGetWipJobs(input: Record<string, unknown>): unknown {
  try {
    const database = getDb();
    const limit = Math.min((input.limit as number) || 25, 50);

    let whereClause = "archived = 0 AND stage NOT IN ('CANCELED', 'SHIPPED')";
    const params: any[] = [];

    if (input.department) {
      whereClause += ` AND stage LIKE ?`;
      params.push(`%${input.department}%`);
    }
    if (input.invoice) {
      whereClause += ` AND invoice = ?`;
      params.push(input.invoice);
    }
    if (input.frame_name) {
      whereClause += ` AND frame_name LIKE ?`;
      params.push(`%${input.frame_name}%`);
    }
    if (input.entry_date) {
      whereClause += ` AND entry_date = ?`;
      params.push(input.entry_date);
    }
    if (input.has_rush) {
      whereClause += ` AND rush = 'Y'`;
    }
    if (input.stage) {
      whereClause += ` AND stage = ?`;
      params.push(input.stage);
    }
    if (input.coating) {
      whereClause += ` AND coating LIKE ?`;
      params.push(`%${input.coating}%`);
    }

    const jobs = database.prepare(`
      SELECT id, invoice, tray, stage, station, status, rush, entry_date,
             days_in_lab, coating, frame_name
      FROM dvi_jobs
      WHERE ${whereClause}
      ORDER BY days_in_lab DESC
      LIMIT ?
    `).all(...params, limit);

    return { jobs, count: jobs.length, source: 'sqlite' };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetRemakeRate(period: string, groupBy: string): unknown {
  try {
    const database = getDb();
    const days = period === 'day' ? 1 : period === 'month' ? 30 : 7;

    // Count remakes (jobs with original_invoice)
    const remakes = database.prepare(`
      SELECT COUNT(*) as count FROM dvi_jobs_history
      WHERE shipped_at >= datetime('now', '-${days} days')
    `).get() as { count: number };

    // For now return placeholder - remake tracking needs additional schema
    return {
      period,
      groupBy,
      days,
      totalShipped: remakes.count,
      remakeCount: 0,
      remakeRate: 0,
      note: 'Remake tracking requires OriginalInvoice field in DVI data',
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetBreakageEvents(input: Record<string, unknown>): unknown {
  try {
    const database = getDb();
    const limit = Math.min((input.limit as number) || 25, 50);

    let whereClause = '1=1';
    const params: any[] = [];

    if (input.department) {
      whereClause += ` AND department = ?`;
      params.push(input.department);
    }
    if (input.reason_code) {
      whereClause += ` AND reason = ?`;
      params.push(input.reason_code);
    }
    if (input.since_date) {
      whereClause += ` AND occurred_at >= ?`;
      params.push(input.since_date);
    }

    const events = database.prepare(`
      SELECT id, job_id, invoice, department, reason, stage, operator, occurred_at, notes
      FROM breakage_events
      WHERE ${whereClause}
      ORDER BY occurred_at DESC
      LIMIT ?
    `).all(...params, limit);

    return { events, count: events.length, source: 'sqlite' };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetBreakageByPosition(department: string, sinceDays: number): unknown {
  try {
    const database = getDb();

    const byPosition = database.prepare(`
      SELECT stage as position, reason, COUNT(*) as count
      FROM breakage_events
      WHERE department = ? AND occurred_at >= datetime('now', '-${sinceDays} days')
      GROUP BY stage, reason
      ORDER BY count DESC
      LIMIT 20
    `).all(department);

    const total = database.prepare(`
      SELECT COUNT(*) as c FROM breakage_events
      WHERE department = ? AND occurred_at >= datetime('now', '-${sinceDays} days')
    `).get(department) as { c: number };

    return {
      department,
      sinceDays,
      byPosition,
      totalEvents: total.c,
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetCoatingWaitSummary(): unknown {
  try {
    const database = getDb();
    const thresholds = getSettings('thresholds');
    const warnDays = thresholds.coating_wait_warn_days || 2;
    const criticalDays = thresholds.coating_wait_critical_days || 4;

    const total = database.prepare(`
      SELECT COUNT(*) as c FROM dvi_jobs
      WHERE archived = 0 AND (stage LIKE '%COAT%' OR stage LIKE '%AR%' OR stage LIKE '%BLU%')
    `).get() as { c: number };

    const avgWait = database.prepare(`
      SELECT AVG(days_in_lab) as avg FROM dvi_jobs
      WHERE archived = 0 AND (stage LIKE '%COAT%' OR stage LIKE '%AR%' OR stage LIKE '%BLU%')
    `).get() as { avg: number };

    const pastWarn = database.prepare(`
      SELECT COUNT(*) as c FROM dvi_jobs
      WHERE archived = 0 AND (stage LIKE '%COAT%' OR stage LIKE '%AR%' OR stage LIKE '%BLU%')
        AND days_in_lab >= ?
    `).get(warnDays) as { c: number };

    const pastCritical = database.prepare(`
      SELECT COUNT(*) as c FROM dvi_jobs
      WHERE archived = 0 AND (stage LIKE '%COAT%' OR stage LIKE '%AR%' OR stage LIKE '%BLU%')
        AND days_in_lab >= ?
    `).get(criticalDays) as { c: number };

    const byCoatType = database.prepare(`
      SELECT coating, COUNT(*) as count, AVG(days_in_lab) as avg_wait
      FROM dvi_jobs
      WHERE archived = 0 AND (stage LIKE '%COAT%' OR stage LIKE '%AR%' OR stage LIKE '%BLU%')
      GROUP BY coating
      ORDER BY count DESC
    `).all();

    return {
      totalInQueue: total.c,
      avgWaitDays: avgWait.avg ? Math.round(avgWait.avg * 10) / 10 : 0,
      pastWarnThreshold: pastWarn.c,
      pastCriticalThreshold: pastCritical.c,
      byCoatType,
      thresholds: { warnDays, criticalDays },
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetInventoryDetail(input: Record<string, unknown>): unknown {
  try {
    const database = getDb();
    const limit = Math.min((input.limit as number) || 25, 50);

    let whereClause = '1=1';
    const params: any[] = [];

    if (input.sku) {
      whereClause += ` AND sku LIKE ?`;
      params.push(`%${input.sku}%`);
    }
    if (input.coating_type) {
      whereClause += ` AND coating_type = ?`;
      params.push(input.coating_type);
    }
    if (input.low_stock_only) {
      whereClause += ` AND qty <= 5`;
    }

    const items = database.prepare(`
      SELECT sku, name, qty, qty_available, location, warehouse, coating_type
      FROM inventory
      WHERE ${whereClause}
      ORDER BY qty ASC
      LIMIT ?
    `).all(...params, limit);

    return { items, count: items.length, source: 'sqlite' };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetMaintenanceTasks(input: Record<string, unknown>): unknown {
  try {
    const database = getDb();
    const limit = Math.min((input.limit as number) || 25, 50);

    let whereClause = "status NOT IN ('Complete', 'Closed', 'Completed')";
    const params: any[] = [];

    if (input.asset_name) {
      whereClause += ` AND asset_name LIKE ?`;
      params.push(`%${input.asset_name}%`);
    }
    if (input.priority) {
      whereClause += ` AND priority = ?`;
      params.push(input.priority);
    }
    if (input.status) {
      whereClause += ` AND status = ?`;
      params.push(input.status);
    }

    const tasks = database.prepare(`
      SELECT id, title, asset_name, priority, status, type, assigned_to, due_date, created_at
      FROM maintenance_tasks
      WHERE ${whereClause}
      ORDER BY CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Urgent' THEN 3 ELSE 4 END
      LIMIT ?
    `).all(...params, limit);

    return { tasks, count: tasks.length, source: 'sqlite' };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetLensCatalog(input: Record<string, unknown>): unknown {
  try {
    const database = getDb();
    const activeOnly = input.active_only !== false;

    let whereClause = activeOnly ? 'valid_to IS NULL' : '1=1';
    const params: any[] = [];

    if (input.opc) {
      whereClause += ` AND opc = ?`;
      params.push(input.opc);
    }
    if (input.material) {
      whereClause += ` AND material = ?`;
      params.push(input.material);
    }
    if (input.style) {
      whereClause += ` AND style = ?`;
      params.push(input.style);
    }

    const lenses = database.prepare(`
      SELECT opc, material, style, coating_type, base_curve, diameter, manufacturer, cost, valid_from, valid_to
      FROM lens_catalog
      WHERE ${whereClause}
      ORDER BY opc
      LIMIT 50
    `).all(...params);

    return { lenses, count: lenses.length, activeOnly, source: 'sqlite' };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetFrameCatalog(input: Record<string, unknown>): unknown {
  try {
    const database = getDb();
    const activeOnly = input.active_only !== false;

    let whereClause = activeOnly ? 'valid_to IS NULL' : '1=1';
    const params: any[] = [];

    if (input.frame_name) {
      whereClause += ` AND frame_name LIKE ?`;
      params.push(`%${input.frame_name}%`);
    }
    if (input.material) {
      whereClause += ` AND material = ?`;
      params.push(input.material);
    }

    const frames = database.prepare(`
      SELECT frame_code, frame_name, brand, style, color, size, material, cost, valid_from, valid_to
      FROM frame_catalog
      WHERE ${whereClause}
      ORDER BY frame_name
      LIMIT 50
    `).all(...params);

    return { frames, count: frames.length, activeOnly, source: 'sqlite' };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetOpcHistory(opc: string): unknown {
  try {
    const database = getDb();

    const history = database.prepare(`
      SELECT opc, material, style, coating_type, valid_from, valid_to, deprecated_reason
      FROM lens_catalog
      WHERE opc = ?
      ORDER BY valid_from DESC
    `).all(opc);

    if (history.length === 0) {
      return { opc, found: false, source: 'sqlite' };
    }

    return {
      opc,
      found: true,
      history,
      currentlyActive: (history[0] as any).valid_to === null,
      source: 'sqlite'
    };
  } catch (e: any) {
    return { error: e.message, source: 'sqlite' };
  }
}

function handleGetSettings(section: string | undefined): unknown {
  const allSettings = getSettings();
  if (section) {
    return { section, settings: allSettings[section] || {}, source: 'settings.toml' };
  }
  return { settings: allSettings, source: 'settings.toml' };
}

function handleUpdateSetting(section: string, key: string, value: string, confirm: boolean): unknown {
  // Preview mode
  if (!confirm) {
    return {
      preview: true,
      section,
      key,
      newValue: value,
      currentValue: settings[section]?.[key],
      message: 'Call with confirm=true to apply this change'
    };
  }

  // For now, settings are read-only (would need fs.writeFileSync to update)
  return {
    success: false,
    error: 'Runtime settings update not yet implemented. Edit settings.toml manually.',
    section,
    key,
    value
  };
}

// Handle data endpoints using SQLite (fast, no HTTP calls)
function handleDataEndpoint(endpoint: string): unknown {
  try {
    const database = getDb();

    if (endpoint === '/api/wip/summary') {
      const total = database.prepare(`
        SELECT COUNT(*) as count FROM dvi_jobs
        WHERE stage NOT IN ('CANCELED', 'SHIPPED') AND (status IS NULL OR status != 'CANCELED')
      `).get() as { count: number };

      const byStageRows = database.prepare(`
        SELECT stage, COUNT(*) as count FROM dvi_jobs
        WHERE stage NOT IN ('CANCELED', 'SHIPPED') AND (status IS NULL OR status != 'CANCELED')
        GROUP BY stage ORDER BY count DESC
      `).all() as { stage: string; count: number }[];

      const rushCount = database.prepare(`
        SELECT COUNT(*) as count FROM dvi_jobs
        WHERE rush = 'Y' AND stage NOT IN ('CANCELED', 'SHIPPED')
      `).get() as { count: number };

      const oldest = database.prepare(`
        SELECT * FROM dvi_jobs
        WHERE stage NOT IN ('CANCELED', 'SHIPPED') AND (status IS NULL OR status != 'CANCELED')
        ORDER BY days_in_lab DESC, entry_date ASC
        LIMIT 20
      `).all();

      const byStage: Record<string, number> = {};
      byStageRows.forEach(r => { byStage[r.stage] = r.count; });

      return {
        totalWIP: total.count,
        byStage,
        rushJobs: rushCount.count,
        oldestJobs: oldest,
        stageSummary: byStageRows.slice(0, 10).map(r => `${r.stage}: ${r.count}`).join(', '),
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/production/status') {
      const stages = ['SURFACING', 'CUTTING', 'COATING', 'ASSEMBLY', 'SHIPPING'];
      const status: Record<string, { count: number; rush: number }> = {};

      for (const s of stages) {
        const count = database.prepare(`
          SELECT COUNT(*) as c FROM dvi_jobs
          WHERE UPPER(stage) LIKE ? AND stage != 'CANCELED'
        `).get(`%${s}%`) as { c: number };

        const rush = database.prepare(`
          SELECT COUNT(*) as c FROM dvi_jobs
          WHERE UPPER(stage) LIKE ? AND rush = 'Y' AND stage != 'CANCELED'
        `).get(`%${s}%`) as { c: number };

        status[s] = { count: count.c, rush: rush.c };
      }

      const totalActive = database.prepare(`
        SELECT COUNT(*) as c FROM dvi_jobs
        WHERE stage NOT IN ('CANCELED', 'SHIPPED')
      `).get() as { c: number };

      return {
        status: 'ok',
        totalActive: totalActive.c,
        stages: status,
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/dvi/stats') {
      const total = database.prepare('SELECT COUNT(*) as c FROM dvi_jobs').get() as { c: number };
      const byStatus = database.prepare(`
        SELECT status, COUNT(*) as count FROM dvi_jobs GROUP BY status
      `).all() as { status: string; count: number }[];
      const byStage = database.prepare(`
        SELECT stage, COUNT(*) as count FROM dvi_jobs GROUP BY stage
      `).all() as { stage: string; count: number }[];
      const rush = database.prepare(`SELECT COUNT(*) as c FROM dvi_jobs WHERE rush = 'Y'`).get() as { c: number };

      return {
        stats: {
          totalJobs: total.c,
          byStatus: Object.fromEntries(byStatus.map(r => [r.status, r.count])),
          byStage: Object.fromEntries(byStage.map(r => [r.stage, r.count])),
          rushJobs: rush.c,
        },
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/inventory' || endpoint === '/api/inventory/summary') {
      const total = database.prepare('SELECT COUNT(*) as count, SUM(qty) as qty FROM inventory').get() as { count: number; qty: number };
      const lowStock = database.prepare('SELECT COUNT(*) as c FROM inventory WHERE qty <= 5').get() as { c: number };
      const outOfStock = database.prepare('SELECT COUNT(*) as c FROM inventory WHERE qty = 0').get() as { c: number };
      const alerts = database.prepare('SELECT * FROM inventory_alerts ORDER BY severity, qty LIMIT 15').all();

      // Get top items by coating type for context
      const byCoating = database.prepare(`
        SELECT coating_type, COUNT(*) as sku_count, SUM(qty) as total_qty
        FROM inventory
        WHERE coating_type IS NOT NULL AND coating_type != ''
        GROUP BY coating_type
        ORDER BY total_qty DESC
        LIMIT 10
      `).all();

      // Get critical low stock items
      const criticalItems = database.prepare(`
        SELECT sku, name, qty, coating_type, location
        FROM inventory
        WHERE qty <= 5 AND qty > 0
        ORDER BY qty ASC
        LIMIT 20
      `).all();

      return {
        totalSkus: total.count,
        totalUnits: total.qty || 0,
        lowStock: lowStock.c,
        outOfStock: outOfStock.c,
        alerts,
        byCoatingType: byCoating,
        criticalItems,
        note: 'Summary for AI context - use query_database for specific searches',
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/inventory/alerts') {
      const alerts = database.prepare(`
        SELECT * FROM inventory_alerts ORDER BY severity, qty LIMIT 50
      `).all();

      return {
        alerts,
        count: alerts.length,
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/inventory/picks') {
      const picks = database.prepare(`
        SELECT sku, name, SUM(qty) as total_qty, SUM(picked) as total_picked, SUM(pending) as total_pending
        FROM picks
        GROUP BY sku
        ORDER BY total_qty DESC
        LIMIT 50
      `).all();

      const stats = database.prepare(`
        SELECT COUNT(DISTINCT order_id) as orders, COUNT(*) as lines, SUM(qty) as qty FROM picks
      `).get() as { orders: number; lines: number; qty: number };

      return {
        picks,
        totalOrders: stats.orders,
        totalLines: stats.lines,
        totalQty: stats.qty || 0,
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/maintenance/summary' || endpoint === '/api/maintenance/stats') {
      const open = database.prepare(`
        SELECT COUNT(*) as c FROM maintenance_tasks WHERE status NOT IN ('Complete', 'Closed', 'Completed')
      `).get() as { c: number };

      const critical = database.prepare(`
        SELECT COUNT(*) as c FROM maintenance_tasks
        WHERE priority IN ('Critical', 'High', 'Urgent') AND status NOT IN ('Complete', 'Closed', 'Completed')
      `).get() as { c: number };

      const overdue = database.prepare(`
        SELECT COUNT(*) as c FROM maintenance_tasks
        WHERE status NOT IN ('Complete', 'Closed', 'Completed') AND due_date < datetime('now')
      `).get() as { c: number };

      const lowParts = database.prepare(`SELECT COUNT(*) as c FROM spare_parts WHERE qty <= min_qty`).get() as { c: number };
      const totalAssets = database.prepare(`SELECT COUNT(*) as c FROM maintenance_assets`).get() as { c: number };

      const criticalTasks = database.prepare(`
        SELECT id, title, asset_name, priority, status, due_date FROM maintenance_tasks
        WHERE priority IN ('Critical', 'High', 'Urgent') AND status NOT IN ('Complete', 'Closed', 'Completed')
        ORDER BY priority, due_date
        LIMIT 15
      `).all();

      return {
        openTaskCount: open.c,
        criticalTaskCount: critical.c,
        overdueTaskCount: overdue.c,
        lowStockParts: lowParts.c,
        totalAssets: totalAssets.c,
        urgentTasks: criticalTasks,
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/maintenance/tasks') {
      // Return only open tasks, limited for AI context
      const tasks = database.prepare(`
        SELECT id, title, asset_name, priority, status, type, assigned_to, due_date, created_at
        FROM maintenance_tasks
        WHERE status NOT IN ('Complete', 'Closed', 'Completed')
        ORDER BY
          CASE priority WHEN 'Critical' THEN 1 WHEN 'High' THEN 2 WHEN 'Urgent' THEN 3 ELSE 4 END,
          due_date
        LIMIT 50
      `).all();

      const total = database.prepare(`
        SELECT COUNT(*) as c FROM maintenance_tasks WHERE status NOT IN ('Complete', 'Closed', 'Completed')
      `).get() as { c: number };

      return {
        tasks,
        totalOpen: total.c,
        showing: tasks.length,
        note: 'Limited to 50 highest priority open tasks for AI context',
        source: 'sqlite'
      };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HISTORICAL DATA ENDPOINTS
    // ─────────────────────────────────────────────────────────────────────────

    if (endpoint === '/api/history/shipped' || endpoint === '/api/dvi/shipped') {
      const daily = database.prepare(`
        SELECT date(shipped_at) as ship_date, COUNT(*) as count,
               SUM(CASE WHEN rush = 'Y' THEN 1 ELSE 0 END) as rush_count,
               AVG(days_in_lab) as avg_days
        FROM dvi_jobs_history
        WHERE shipped_at >= datetime('now', '-7 days')
        GROUP BY date(shipped_at)
        ORDER BY ship_date DESC
      `).all();

      const total = database.prepare(`
        SELECT COUNT(*) as c FROM dvi_jobs_history WHERE shipped_at >= datetime('now', '-7 days')
      `).get() as { c: number };

      const recentJobs = database.prepare(`
        SELECT job_id, invoice, stage, coating, rush, days_in_lab, shipped_at
        FROM dvi_jobs_history
        WHERE shipped_at >= datetime('now', '-24 hours')
        ORDER BY shipped_at DESC
        LIMIT 50
      `).all();

      return {
        dailyStats: daily,
        totalShipped7Days: total.c,
        recentJobs,
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/history/picks' || endpoint === '/api/picks/history') {
      const daily = database.prepare(`
        SELECT date(completed_at) as pick_date, COUNT(*) as order_count,
               SUM(qty) as total_qty, COUNT(DISTINCT sku) as unique_skus
        FROM picks_history
        WHERE completed_at >= datetime('now', '-7 days')
        GROUP BY date(completed_at)
        ORDER BY pick_date DESC
      `).all();

      const topSkus = database.prepare(`
        SELECT sku, name, SUM(qty) as total_qty, COUNT(*) as pick_count
        FROM picks_history
        WHERE completed_at >= datetime('now', '-7 days')
        GROUP BY sku
        ORDER BY total_qty DESC
        LIMIT 20
      `).all();

      return {
        dailyStats: daily,
        topSkus,
        note: 'Last 7 days of completed picks',
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/history/stats' || endpoint === '/api/daily-stats') {
      const stats = database.prepare(`
        SELECT * FROM daily_stats
        WHERE stat_date >= date('now', '-30 days')
        ORDER BY stat_date DESC
      `).all();

      return {
        stats,
        days: 30,
        source: 'sqlite'
      };
    }

    if (endpoint === '/api/history/inventory' || endpoint === '/api/inventory/trend') {
      const trend = database.prepare(`
        SELECT * FROM inventory_snapshots
        WHERE snapshot_date >= date('now', '-30 days')
        ORDER BY snapshot_date DESC
      `).all();

      return {
        snapshots: trend,
        days: 30,
        source: 'sqlite'
      };
    }

  } catch (e: any) {
    log.error(`SQLite query failed for ${endpoint}:`, e.message);
    return { error: e.message, source: 'sqlite' };
  }

  return null;
}

async function handleCallApi(
  method: string,
  endpoint: string,
  body?: Record<string, unknown>
): Promise<unknown> {
  // Handle data endpoints locally via SQLite to avoid gateway calling itself
  const dataEndpoints = [
    '/api/wip/summary',
    '/api/production/status',
    '/api/dvi/stats',
    '/api/inventory',
    '/api/inventory/summary',
    '/api/inventory/picks',
    '/api/inventory/alerts',
    '/api/maintenance/summary',
    '/api/maintenance/stats',
    '/api/maintenance/tasks',
    // Historical data endpoints
    '/api/history/shipped',
    '/api/dvi/shipped',
    '/api/history/picks',
    '/api/picks/history',
    '/api/history/stats',
    '/api/daily-stats',
    '/api/history/inventory',
    '/api/inventory/trend'
  ];
  if (method === 'GET' && dataEndpoints.includes(endpoint)) {
    const result = handleDataEndpoint(endpoint);
    if (result) {
      log.debug(`call_api ${endpoint} handled via SQLite`);
      return result;
    }
  }

  // Redirect full inventory to summary endpoint (avoid 10K+ items)
  let actualEndpoint = endpoint;
  if (endpoint === '/api/inventory') {
    log.info('Redirecting /api/inventory to /api/inventory/ai-context for AI use');
    actualEndpoint = '/api/inventory/ai-context';
  }

  // For other endpoints, call the lab server (3002)
  const url = `${LAB_SERVER_URL}${actualEndpoint}`;

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

// ─────────────────────────────────────────────────────────────────────────────
// COATING INTELLIGENCE TOOLS — Batch optimization + learning loop
// ─────────────────────────────────────────────────────────────────────────────

// Ensure batch history table exists
function ensureBatchHistoryTable(): void {
  try {
    const DB_PATH = join(__dirname, '..', '..', 'data', 'lab_assistant.db');
    if (!existsSync(DB_PATH)) return;
    const writeDb = new Database(DB_PATH);
    writeDb.exec(`
      CREATE TABLE IF NOT EXISTS coating_batch_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT DEFAULT (datetime('now')),
        plan_json TEXT NOT NULL,
        timing TEXT,
        timing_reason TEXT,
        notes TEXT,
        queue_size INTEGER,
        surfacing_incoming INTEGER,
        outcome_json TEXT,
        operator_feedback TEXT,
        feedback_rating INTEGER,
        completed_at TEXT
      )
    `);
    writeDb.close();
  } catch (e: any) {
    log.warn('[Coating] Could not ensure batch history table:', e.message);
  }
}
ensureBatchHistoryTable();

async function handleGetCoatingIntelligence(): Promise<unknown> {
  try {
    const res = await fetch(`${LAB_SERVER_URL}/api/coating/intelligence`);
    const data = await res.json() as any;
    if (!data.ok) throw new Error(data.error || 'Intelligence endpoint failed');

    // Return a focused summary for the AI — not the raw payload
    const q = data.queue || {};
    const o = data.ovens || {};
    const up = data.upstream || {};

    return {
      timestamp: new Date().toISOString(),
      totalWip: data.totalWip,
      coatingQueue: {
        total: q.total,
        rushCount: q.rushCount,
        byType: q.byType,
        jobs: (q.jobs || []).map((j: any) => ({
          jobId: j.jobId, coating: j.coating, lensType: j.lensType,
          lensStyle: j.lensStyle, lensMat: j.lensMat, eyeSize: j.eyeSize,
          rush: j.rush, station: j.station, waitMin: j.waitMin,
          daysInLab: j.daysInLab,
        })),
      },
      upstream: {
        surfacing: up.surfacing,
        totalUpstream: up.totalUpstream,
      },
      coaters: data.coaters,
      ovens: {
        racksInUse: o.racksInUse,
        racksAvailable: o.racksAvailable,
        ovenIncoming: o.ovenIncoming,
        layout: (o.layout || []).map((ov: any) => ({
          ovenId: ov.ovenId,
          racks: ov.racks.map((r: any) => ({
            rackIndex: r.rackIndex, state: r.state,
            remainingMin: r.remainingMin, jobs: r.jobs || [],
            coating: r.coating,
          })),
        })),
      },
      avgStageMins: data.avgStageMins,
      recommendation: data.recommendation,
      activeCoatingRuns: Object.values(data.coatingRuns || {}),
    };
  } catch (e: any) {
    log.error('[Coating] Intelligence fetch failed:', e.message);
    return { error: e.message, hint: 'Lab server may not be running on port 3002' };
  }
}

async function handleGetCoatingBatchHistory(limit: number): Promise<unknown> {
  try {
    const database = getDb();
    const rows = database.prepare(`
      SELECT id, created_at, plan_json, timing, timing_reason, notes,
             queue_size, surfacing_incoming, outcome_json, operator_feedback,
             feedback_rating, completed_at
      FROM coating_batch_plans
      ORDER BY created_at DESC
      LIMIT ?
    `).all(limit);

    return {
      total: rows.length,
      plans: rows.map((r: any) => ({
        ...r,
        plan: r.plan_json ? JSON.parse(r.plan_json) : null,
        outcome: r.outcome_json ? JSON.parse(r.outcome_json) : null,
      })),
      learnings: rows.length > 5 ? summarizeLearnings(rows as any[]) : 'Not enough history yet. Keep making recommendations and collecting feedback.',
    };
  } catch (e: any) {
    return { total: 0, plans: [], learnings: 'No batch history available yet. This is the first time the coating AI advisor is being used.' };
  }
}

function summarizeLearnings(rows: any[]): string {
  const withFeedback = rows.filter((r: any) => r.feedback_rating !== null);
  if (withFeedback.length < 3) return `${rows.length} plans recorded, ${withFeedback.length} with feedback. Need more feedback to identify patterns.`;

  const avgRating = withFeedback.reduce((s: number, r: any) => s + (r.feedback_rating || 0), 0) / withFeedback.length;
  const good = withFeedback.filter((r: any) => r.feedback_rating >= 4).length;
  const bad = withFeedback.filter((r: any) => r.feedback_rating <= 2).length;

  return `${rows.length} plans, ${withFeedback.length} rated. Avg rating: ${avgRating.toFixed(1)}/5. ${good} good, ${bad} poor. Review poor-rated plans to identify what went wrong.`;
}

async function handleSubmitCoatingBatchPlan(plan: Record<string, unknown>): Promise<unknown> {
  try {
    const DB_PATH = join(__dirname, '..', '..', 'data', 'lab_assistant.db');
    const writeDb = new Database(DB_PATH);

    const stmt = writeDb.prepare(`
      INSERT INTO coating_batch_plans (plan_json, timing, timing_reason, notes, queue_size, surfacing_incoming)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = stmt.run(
      JSON.stringify(plan.coaters || plan),
      (plan as any).timing || '',
      (plan as any).timing_reason || '',
      (plan as any).notes || '',
      (plan as any).queue_size || 0,
      (plan as any).surfacing_incoming || 0,
    );

    writeDb.close();

    log.info(`[Coating] Batch plan recorded: id=${result.lastInsertRowid}`);
    return {
      success: true,
      planId: result.lastInsertRowid,
      message: 'Batch plan recorded. It will be matched with actual run outcomes for learning.',
    };
  } catch (e: any) {
    log.error('[Coating] Failed to save batch plan:', e.message);
    return { success: false, error: e.message };
  }
}

async function handleGetOvenRackStatus(): Promise<unknown> {
  try {
    // Get oven data from lab server
    const [intelRes, rackJobsRes] = await Promise.all([
      fetch(`${LAB_SERVER_URL}/api/coating/intelligence`).then(r => r.json()).catch(() => null) as Promise<any>,
      fetch(`${LAB_SERVER_URL}/api/oven/rack/jobs`).then(r => r.json()).catch(() => null) as Promise<any>,
    ]);

    const ovens = intelRes?.ovens || {} as any;
    return {
      layout: ovens.layout || [],
      racksInUse: ovens.racksInUse || 0,
      racksAvailable: ovens.racksAvailable || 0,
      ovenIncoming: ovens.ovenIncoming || [],
      trackedRacks: rackJobsRes?.racks || {},
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE HANDLERS
// ─────────────────────────────────────────────────────────────────────────────

async function handleSearchKnowledge(
  query: string,
  category: string | undefined,
  limit: number
): Promise<unknown> {
  try {
    const params = new URLSearchParams({ q: query, limit: String(limit) });
    if (category) params.set('category', category);
    const res = await fetch(`${LAB_SERVER_URL}/api/knowledge/search?${params}`);
    const data = await res.json() as any;
    if (!data.results || data.results.length === 0) {
      return { message: `No documents found for "${query}". The knowledge base may not have documents on this topic yet.`, query, results: [] };
    }
    // Return results with text excerpts
    const results = [];
    for (const doc of data.results) {
      // Fetch text content for each result
      let excerpt = '';
      try {
        const docRes = await fetch(`${LAB_SERVER_URL}/api/knowledge/doc/${doc.id}`);
        const docData = await docRes.json() as any;
        if (docData.textContent) {
          // Find relevant excerpt around search terms
          const text = docData.textContent;
          const lowerText = text.toLowerCase();
          const terms = query.toLowerCase().split(/\s+/);
          let bestPos = 0;
          for (const term of terms) {
            const idx = lowerText.indexOf(term);
            if (idx !== -1) { bestPos = idx; break; }
          }
          const start = Math.max(0, bestPos - 200);
          const end = Math.min(text.length, bestPos + 800);
          excerpt = (start > 0 ? '...' : '') + text.substring(start, end) + (end < text.length ? '...' : '');
        }
      } catch { /* skip excerpt */ }

      results.push({
        id: doc.id,
        title: doc.title,
        category: doc.category,
        tags: doc.tags,
        description: doc.description,
        excerpt: excerpt || doc.description || '(no text preview)',
        relevance: doc._score,
      });
    }
    return { query, total: results.length, results };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function handleGetKnowledgeDoc(docId: string): Promise<unknown> {
  try {
    const res = await fetch(`${LAB_SERVER_URL}/api/knowledge/doc/${docId}`);
    const data = await res.json() as any;
    if (data.error) return { error: data.error };
    return {
      id: data.id,
      title: data.title,
      category: data.category,
      tags: data.tags,
      description: data.description,
      content: data.textContent || '(no text content available — this may be a binary file like PDF/DOCX)',
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

async function handleGenerateCsvReport(
  title: string,
  headers: string[],
  rows: string[][]
): Promise<unknown> {
  try {
    const res = await fetch(`${LAB_SERVER_URL}/api/knowledge/generate-csv`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, headers, rows }),
    });
    const data = await res.json() as any;
    if (!data.ok) return { error: data.error || 'Failed to generate CSV' };
    return {
      message: `CSV report "${title}" generated successfully with ${data.rows} rows.`,
      filename: data.filename,
      downloadUrl: `${LAB_SERVER_URL}${data.path}`,
      downloadPath: data.path,
      rows: data.rows,
      size: data.size,
    };
  } catch (e: any) {
    return { error: e.message };
  }
}
