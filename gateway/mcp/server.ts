/**
 * MCP Server
 * Wraps Lab Assistant REST API as MCP tools for agents
 *
 * Uses SQLite for fast AI queries - data synced from ItemPath, Limble, DVI
 */

import { log } from '../logger.js';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import Database from 'better-sqlite3';

const __dirname = dirname(fileURLToPath(import.meta.url));

// SQLite database for AI queries (populated by adapters)
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
// Tool Definitions (for Claude API tools parameter)
// ─────────────────────────────────────────────────────────────────────────────

export const MCP_TOOLS = [
  // ─────────────────────────────────────────────────────────────────────────────
  // NARROW SEMANTIC TOOLS (agent-sized results, predicate-based)
  // ─────────────────────────────────────────────────────────────────────────────
  {
    name: 'get_wip_snapshot',
    description: 'Get current WIP summary with counts by stage. Returns ~10 rows. Use for "how many jobs in WIP?" questions.',
    input_schema: {
      type: 'object',
      properties: {
        summary_only: {
          type: 'boolean',
          description: 'If true, returns counts only. Default true.',
          default: true,
        },
      },
    },
  },
  {
    name: 'get_coating_queue_aged',
    description: 'Get jobs in coating stages, optionally filtered by minimum age. Returns max 25 rows.',
    input_schema: {
      type: 'object',
      properties: {
        min_days: {
          type: 'number',
          description: 'Minimum days in lab to filter by. Default 0 (all).',
          default: 0,
        },
      },
    },
  },
  {
    name: 'get_breakage_summary',
    description: 'Get breakage summary by department/reason with top 5 recent events. Use for breakage analysis.',
    input_schema: {
      type: 'object',
      properties: {
        department: {
          type: 'string',
          description: 'Filter by department: S=Surfacing, C=Coating, E=Edging, A=Assembly. Optional.',
        },
        since_days: {
          type: 'number',
          description: 'Look back N days. Default 7.',
          default: 7,
        },
      },
    },
  },
  {
    name: 'get_job_detail',
    description: 'Get full detail for a single job by invoice number. Includes breakage history.',
    input_schema: {
      type: 'object',
      properties: {
        invoice: {
          type: 'string',
          description: 'Invoice number to look up.',
        },
      },
      required: ['invoice'],
    },
  },
  {
    name: 'get_aging_report',
    description: 'Get WIP aging report with bucketed counts and jobs over threshold. Use for "show me old jobs" questions.',
    input_schema: {
      type: 'object',
      properties: {
        threshold_hours: {
          type: 'number',
          description: 'Age threshold in hours for flagging. Default 48.',
          default: 48,
        },
      },
    },
  },
  {
    name: 'get_throughput_trend',
    description: 'Get daily throughput trend (shipped, by stage). Use for trend/historical questions.',
    input_schema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: 'Number of days to look back. Default 7.',
          default: 7,
        },
      },
    },
  },
  {
    name: 'get_inventory_summary',
    description: 'Get inventory summary with low stock alerts. Use for "what is inventory status?" questions.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  {
    name: 'get_maintenance_summary',
    description: 'Get maintenance summary with open tasks and critical items. Use for "how is maintenance?" questions.',
    input_schema: {
      type: 'object',
      properties: {},
    },
  },
  // ─────────────────────────────────────────────────────────────────────────────
  // GENERIC TOOLS (for flexibility, use narrow tools when possible)
  // ─────────────────────────────────────────────────────────────────────────────
  {
    name: 'query_database',
    description: 'Run a custom read-only SQL query. Use narrow tools above when possible. This is for complex queries not covered by other tools.',
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
    description: 'Call a Lab Assistant REST API endpoint. Use for real-time data (DVI SOAP) or endpoints not in SQLite.',
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
          description: 'API endpoint path',
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
    // ─────────────────────────────────────────────────────────────────────────
    // NARROW SEMANTIC TOOLS (preferred - agent-sized results)
    // ─────────────────────────────────────────────────────────────────────────
    case 'get_wip_snapshot':
      return handleGetWipSnapshot(toolInput.summary_only as boolean ?? true);

    case 'get_coating_queue_aged':
      return handleGetCoatingQueueAged(toolInput.min_days as number ?? 0);

    case 'get_breakage_summary':
      return handleGetBreakageSummary(
        toolInput.department as string | undefined,
        toolInput.since_days as number ?? 7
      );

    case 'get_job_detail':
      return handleGetJobDetail(toolInput.invoice as string);

    case 'get_aging_report':
      return handleGetAgingReport(toolInput.threshold_hours as number ?? 48);

    case 'get_throughput_trend':
      return handleGetThroughputTrend(toolInput.days as number ?? 7);

    case 'get_inventory_summary':
      return handleGetInventorySummary();

    case 'get_maintenance_summary':
      return handleGetMaintenanceSummary();

    // ─────────────────────────────────────────────────────────────────────────
    // GENERIC TOOLS (fallback)
    // ─────────────────────────────────────────────────────────────────────────
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
