/**
 * MCP Tool Definitions
 * WHEN/WHAT/HOW/NOT pattern for directive tool selection
 */

// ─────────────────────────────────────────────────────────────────────────────
// WIP / JOB DETAIL TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_wip_snapshot = {
  name: 'get_wip_snapshot',
  description: `USE THIS as the first call for any general status or "how are we doing" question.
WHAT: Returns a single summary object: total jobs in WIP, count by stage, rush count, avg/max days in lab.
HOW: No parameters needed. Never returns raw job rows.
NOT for individual job lookup — use get_job_detail() for that.
NOT for aging analysis — use get_aging_report() for that.`,
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
};

export const get_wip_jobs = {
  name: 'get_wip_jobs',
  description: `USE THIS only when you need individual job records with full Rx and frame detail.
WHAT: Returns up to 50 job records with: invoice, tray, entry_date, days_in_lab, stage, coating, frame, rush, status.
HOW: ALWAYS provide at least one filter (department, invoice, frame_name, material, entry_date). Never call with all params as null.
NOT for counts or summaries — use get_wip_snapshot() instead.
NOT for aging analysis — use get_aging_report() instead.`,
  input_schema: {
    type: 'object',
    properties: {
      department: {
        type: 'string',
        description: 'Filter by department: S=Surfacing, C=Coating, E=Edging, A=Assembly, Q=QC, O=Office',
      },
      invoice: {
        type: 'string',
        description: 'Filter by invoice number (exact match)',
      },
      frame_name: {
        type: 'string',
        description: 'Filter by frame name (partial match)',
      },
      material: {
        type: 'string',
        description: 'Filter by material: POLY, CR39, HI_INDEX, TRIVEX',
      },
      entry_date: {
        type: 'string',
        description: 'Filter by entry date (YYYY-MM-DD)',
      },
      has_breakage: {
        type: 'boolean',
        description: 'If true, only return jobs with breakage events',
      },
      limit: {
        type: 'number',
        description: 'Max rows to return. Default 50, max 100.',
        default: 50,
      },
    },
  },
};

export const get_job_detail = {
  name: 'get_job_detail',
  description: `USE THIS when you need the full record for a single job.
WHAT: Returns everything: Rx params (if available), frame, material, coating, breakage events, stage history, entry/ship dates.
HOW: Requires invoice number. One job, full depth.
NOT for bulk queries — use get_wip_jobs() with filters for that.`,
  input_schema: {
    type: 'object',
    properties: {
      invoice: {
        type: 'string',
        description: 'Invoice number to look up (required)',
      },
    },
    required: ['invoice'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// AGING & THROUGHPUT REPORTS
// ─────────────────────────────────────────────────────────────────────────────

export const get_aging_report = {
  name: 'get_aging_report',
  description: `USE THIS for any question about aging, overdue jobs, days in lab, or WIP velocity.
WHAT: Returns jobs bucketed by age band (0-1d, 1-2d, 2-3d, 3-5d, 5-7d, 7d+) with counts and rush counts, plus top 20 oldest jobs.
HOW: Optional threshold_hours to define "critical" cutoff (default 48 hours = 2 days).
NOT for individual job lookup — use get_job_detail() for that.`,
  input_schema: {
    type: 'object',
    properties: {
      threshold_hours: {
        type: 'number',
        description: 'Age threshold in hours for flagging critical jobs. Default 48.',
        default: 48,
      },
      department: {
        type: 'string',
        description: 'Filter by department: S, C, E, A, Q, O. Optional.',
      },
    },
  },
};

export const get_throughput_trend = {
  name: 'get_throughput_trend',
  description: `USE THIS for questions about production volume, jobs completed, jobs entered, or capacity trends.
WHAT: Returns daily stats: jobs_shipped, jobs by stage, avg days in lab, for the past N days.
HOW: Optional days param (default 7). Data from warm aggregation layer — fast, no raw scanning.
NOT for individual job data — use get_wip_jobs() for that.`,
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
};

export const get_remake_rate = {
  name: 'get_remake_rate',
  description: `USE THIS for questions about remakes, redo rate, or jobs with OriginalInvoice.
WHAT: Returns remake count, total jobs, remake rate percentage, grouped by dimension.
HOW: Optional period (day/week/month) and group_by (department/material/operator).
A remake is any job with an OriginalInvoice value.
NOT for individual remake job detail — use get_wip_jobs(invoice=X) for that.`,
  input_schema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['day', 'week', 'month'],
        description: 'Time period. Default week.',
        default: 'week',
      },
      group_by: {
        type: 'string',
        enum: ['department', 'material', 'operator'],
        description: 'Grouping dimension. Default department.',
        default: 'department',
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// BREAKAGE TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_breakage_summary = {
  name: 'get_breakage_summary',
  description: `USE THIS for any high-level breakage question: rate, trends, worst department, most common reason.
WHAT: Returns breakage count, breakdown by department/reason, top 5 recent events.
HOW: Optional department filter and since_days (default 7).
NOT for individual breakage events — use get_breakage_events() for that.`,
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
};

export const get_breakage_events = {
  name: 'get_breakage_events',
  description: `USE THIS when you need individual breakage event records, not summaries.
WHAT: Returns up to 50 events with: date, time, invoice, department, position, reason code, reason label, operator.
HOW: ALWAYS filter by at least one of: department, reason_code, or since_date.
Reason codes: 03=Scratch, 04=Chip, 08=Power Error, 18=Cosmetic, NF=Not Found.
NOT for rates or trends — use get_breakage_summary() for that.`,
  input_schema: {
    type: 'object',
    properties: {
      department: {
        type: 'string',
        description: 'Filter by department: S, C, E, A, Q, O',
      },
      reason_code: {
        type: 'string',
        description: 'Filter by reason code: 03, 04, 08, 18, NF, BR, CR, WP',
      },
      since_date: {
        type: 'string',
        description: 'Filter events since date (YYYY-MM-DD)',
      },
      limit: {
        type: 'number',
        description: 'Max rows to return. Default 50.',
        default: 50,
      },
    },
  },
};

export const get_breakage_by_position = {
  name: 'get_breakage_by_position',
  description: `USE THIS to identify which specific station (position) within a department is generating the most breakage.
WHAT: Returns position number, event count, most common reason, percentage of dept total.
HOW: Requires department. Use when drilling into a specific dept problem.
Positions are numeric codes within each department (e.g. S-15, O-04).`,
  input_schema: {
    type: 'object',
    properties: {
      department: {
        type: 'string',
        description: 'Department code (required): S, C, E, A, Q, O',
      },
      since_days: {
        type: 'number',
        description: 'Look back N days. Default 7.',
        default: 7,
      },
    },
    required: ['department'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// COATING QUEUE TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_coating_queue = {
  name: 'get_coating_queue',
  description: `USE THIS for questions about jobs waiting at coating, coating backlog, or coating capacity.
WHAT: Returns jobs in coating queue: invoice, frame, department, coating type, wait_days, rush status. Sorted by wait_days desc.
HOW: Optional min_wait_days filter (default 0 = all). Optional coat_type filter (AR, BLUE_CUT, etc).
NOT for coating yield or quality — use get_breakage_summary(department="C") for that.`,
  input_schema: {
    type: 'object',
    properties: {
      min_wait_days: {
        type: 'number',
        description: 'Minimum wait days filter. Default 0 (all jobs).',
        default: 0,
      },
      coat_type: {
        type: 'string',
        description: 'Filter by coating type: AR, BLUE_CUT, HARD_COAT, MIRROR, TRANSITIONS',
      },
    },
  },
};

export const get_coating_wait_summary = {
  name: 'get_coating_wait_summary',
  description: `USE THIS for a quick coating queue status check.
WHAT: Returns single summary: total jobs waiting, average wait days, jobs past warn threshold, jobs past critical threshold, breakdown by coat type.
HOW: No parameters needed.
NOT for individual job records — use get_coating_queue() for that.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// INVENTORY TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_inventory_summary = {
  name: 'get_inventory_summary',
  description: `USE THIS for inventory status questions: stock levels, low stock, out of stock.
WHAT: Returns total SKUs, total units, low stock count, out of stock count, alerts by severity, breakdown by coating type.
HOW: No parameters needed.
NOT for individual SKU lookup — use get_inventory_detail() for that.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export const get_inventory_detail = {
  name: 'get_inventory_detail',
  description: `USE THIS when you need details on a specific SKU or to search inventory.
WHAT: Returns SKU records: sku, name, qty, qty_available, location, warehouse, coating_type.
HOW: Filter by sku, coating_type, or low_stock_only. Always provide at least one filter.
NOT for summary stats — use get_inventory_summary() for that.`,
  input_schema: {
    type: 'object',
    properties: {
      sku: {
        type: 'string',
        description: 'Filter by SKU (partial match)',
      },
      coating_type: {
        type: 'string',
        description: 'Filter by coating type: AR, BLUE_CUT, HARD_COAT, etc.',
      },
      low_stock_only: {
        type: 'boolean',
        description: 'If true, only return items with qty <= 5',
      },
      limit: {
        type: 'number',
        description: 'Max rows to return. Default 50.',
        default: 50,
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// MAINTENANCE TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_maintenance_summary = {
  name: 'get_maintenance_summary',
  description: `USE THIS for maintenance status questions: open tasks, critical items, overdue work.
WHAT: Returns open task count, critical task count, overdue count, low stock parts count, top 10 urgent tasks.
HOW: No parameters needed.
NOT for individual task lookup — use get_maintenance_tasks() for that.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export const get_maintenance_tasks = {
  name: 'get_maintenance_tasks',
  description: `USE THIS when you need individual maintenance task records.
WHAT: Returns up to 50 open tasks: id, title, asset_name, priority, status, due_date, assigned_to.
HOW: Optional filters by asset_name, priority, or status.
NOT for summary stats — use get_maintenance_summary() for that.`,
  input_schema: {
    type: 'object',
    properties: {
      asset_name: {
        type: 'string',
        description: 'Filter by asset name (partial match)',
      },
      priority: {
        type: 'string',
        enum: ['Critical', 'High', 'Medium', 'Low'],
        description: 'Filter by priority level',
      },
      status: {
        type: 'string',
        description: 'Filter by status',
      },
      limit: {
        type: 'number',
        description: 'Max rows to return. Default 50.',
        default: 50,
      },
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// CATALOG TOOLS (SCD Type 2)
// ─────────────────────────────────────────────────────────────────────────────

export const get_lens_catalog = {
  name: 'get_lens_catalog',
  description: `USE THIS to look up lens catalog entries: OPC, material, style, coating, valid dates.
WHAT: Returns lens records: opc, material, style, coating_type, base_curve, diameter, manufacturer, valid_from, valid_to.
HOW: Filter by opc, material, or style. active_only=true (default) returns current lenses only.
NOT for job-level lens data — use get_job_detail() for that.`,
  input_schema: {
    type: 'object',
    properties: {
      opc: {
        type: 'string',
        description: 'Filter by OPC (Optical Product Code)',
      },
      material: {
        type: 'string',
        description: 'Filter by material: CR39, POLY, HI_INDEX, TRIVEX',
      },
      style: {
        type: 'string',
        description: 'Filter by style: SV, PROG, BIFOCAL',
      },
      active_only: {
        type: 'boolean',
        description: 'If true (default), only return currently active lenses. False returns full history.',
        default: true,
      },
    },
  },
};

export const get_frame_catalog = {
  name: 'get_frame_catalog',
  description: `USE THIS to look up frame catalog entries: name, material, color, size, valid dates.
WHAT: Returns frame records: frame_code, frame_name, brand, style, color, size, material, valid_from, valid_to.
HOW: Filter by frame_name or material. active_only=true (default) returns current frames only.`,
  input_schema: {
    type: 'object',
    properties: {
      frame_name: {
        type: 'string',
        description: 'Filter by frame name (partial match)',
      },
      material: {
        type: 'string',
        description: 'Filter by material',
      },
      active_only: {
        type: 'boolean',
        description: 'If true (default), only return currently active frames.',
        default: true,
      },
    },
  },
};

export const get_opc_history = {
  name: 'get_opc_history',
  description: `USE THIS when you need the full lifecycle of a specific OPC.
WHAT: Returns: opc, material, valid_from, valid_to, deprecated_reason, replaced_by_opc, job_count_lifetime.
HOW: Requires opc parameter.
Useful for root-cause analysis on jobs using obsolete OPCs.`,
  input_schema: {
    type: 'object',
    properties: {
      opc: {
        type: 'string',
        description: 'OPC to look up (required)',
      },
    },
    required: ['opc'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_settings = {
  name: 'get_settings',
  description: `USE THIS when you need to know current thresholds or configuration.
WHAT: Returns settings.toml contents: thresholds, retention, mcp limits, department codes, reason codes.
HOW: Optional section filter (thresholds, retention, mcp, departments, reason_codes).
Read-only. Use update_setting() to change values.`,
  input_schema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        enum: ['thresholds', 'retention', 'mcp', 'departments', 'reason_codes', 'escalation'],
        description: 'Specific section to return. Optional.',
      },
    },
  },
};

export const update_setting = {
  name: 'update_setting',
  description: `USE THIS to change a threshold or config value at runtime.
WHAT: Writes to settings.toml and hot-reloads.
HOW: confirm=false (default) returns preview without applying. confirm=true applies the change.
ALWAYS preview before confirming.
NEVER change mcp.max_rows_default above 100.`,
  input_schema: {
    type: 'object',
    properties: {
      section: {
        type: 'string',
        description: 'Settings section (required)',
      },
      key: {
        type: 'string',
        description: 'Setting key (required)',
      },
      value: {
        type: 'string',
        description: 'New value (required)',
      },
      confirm: {
        type: 'boolean',
        description: 'If true, apply the change. If false (default), preview only.',
        default: false,
      },
    },
    required: ['section', 'key', 'value'],
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// GENERIC TOOLS (fallback)
// ─────────────────────────────────────────────────────────────────────────────

export const query_database = {
  name: 'query_database',
  description: `USE THIS only for complex queries not covered by other tools.
WHAT: Runs a custom read-only SQL query against SQLite.
HOW: Must be SELECT or WITH statement. Dangerous keywords (INSERT, UPDATE, DELETE, etc.) are blocked.
Prefer narrow tools above — they are faster and return agent-sized results.`,
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'SQL SELECT query to run',
      },
    },
    required: ['query'],
  },
};

export const call_api = {
  name: 'call_api',
  description: `USE THIS for real-time data or endpoints not in SQLite.
WHAT: Calls Lab Assistant REST API.
HOW: method (GET/POST), endpoint path, optional body for POST.
Most data queries should use SQLite-backed tools instead — faster and context-aware.`,
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
        description: 'Request body for POST (optional)',
      },
    },
    required: ['method', 'endpoint'],
  },
};

export const think_aloud = {
  name: 'think_aloud',
  description: `USE THIS to structure your reasoning before responding.
WHAT: Has no side effects — just returns your thought.
HOW: Pass your reasoning as the thought parameter.
Use this to break down complex problems before calling other tools.`,
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
};

// ─────────────────────────────────────────────────────────────────────────────
// TOOL SETS BY DOMAIN
// ─────────────────────────────────────────────────────────────────────────────

export const WIP_TOOLS = [
  get_wip_snapshot,
  get_wip_jobs,
  get_job_detail,
];

export const REPORT_TOOLS = [
  get_aging_report,
  get_throughput_trend,
  get_remake_rate,
];

export const BREAKAGE_TOOLS = [
  get_breakage_summary,
  get_breakage_events,
  get_breakage_by_position,
];

// ─────────────────────────────────────────────────────────────────────────────
// COATING INTELLIGENCE TOOLS (batching, oven tracking, machine optimization)
// ─────────────────────────────────────────────────────────────────────────────

export const get_coating_intelligence = {
  name: 'get_coating_intelligence',
  description: `USE THIS as the FIRST call for any coating batching, oven, or scheduling question.
WHAT: Returns the full coating department state from the lab server: coating queue with every job (coating type, lens type P/S/B, material, eye size, rush, wait time), upstream flow from surfacing with ETA, oven grid (6 ovens × 7 racks with job numbers and timers), coater capacities (E1400: 274L/137 orders, EB9 #1/2: 114L/57 orders each), active coating runs, and jobs finishing in ovens within 30 min.
HOW: No parameters. Returns a single comprehensive payload from the lab server's /api/coating/intelligence endpoint.
NOT for historical analysis — use get_coating_batch_history() for past outcomes.
NOT for simple queue counts — but this includes that data and more.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export const get_coating_batch_history = {
  name: 'get_coating_batch_history',
  description: `USE THIS to learn from past batching decisions and their outcomes.
WHAT: Returns the last N coating batch recommendations and their outcomes (if feedback was provided). Includes: what was recommended, what was actually run, coating type, coater used, batch size, fill rate, wait time, and any operator feedback.
HOW: Optional limit parameter (default 50). Returns most recent first.
USE THIS to improve future recommendations — look for patterns in what worked and what didn't.`,
  input_schema: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max history entries to return. Default 50.',
        default: 50,
      },
    },
  },
};

export const submit_coating_batch_plan = {
  name: 'submit_coating_batch_plan',
  description: `USE THIS to record your batch recommendation so it can be tracked against actual outcomes.
WHAT: Stores a structured batch plan with reasoning. This creates a record that will later be matched with actual run data to measure recommendation quality.
HOW: Provide the structured plan object with coater assignments, reasoning, and timing advice.
ALWAYS call this after analyzing the coating queue and making a recommendation.`,
  input_schema: {
    type: 'object',
    properties: {
      plan: {
        type: 'object',
        description: 'The batch plan object with coater assignments',
        properties: {
          coaters: {
            type: 'array',
            description: 'Array of coater assignments: [{coaterId, coaterName, jobs: [jobId,...], coatingType, reasoning}]',
          },
          timing: {
            type: 'string',
            description: 'Timing recommendation: RUN_NOW, WAIT, RUN_PARTIAL',
          },
          timing_reason: {
            type: 'string',
            description: 'Why this timing was recommended',
          },
          notes: {
            type: 'string',
            description: 'Any additional efficiency notes or concerns',
          },
        },
      },
    },
    required: ['plan'],
  },
};

export const get_oven_rack_status = {
  name: 'get_oven_rack_status',
  description: `USE THIS to get detailed oven status including which specific jobs are loaded on which racks.
WHAT: Returns all 6 ovens × 7 racks with: running state, timer, remaining minutes, and loaded job numbers. Also returns racks finishing within 30 min (these feed back into the coating queue pipeline).
HOW: No parameters. Data comes from operator-entered job numbers + live timer heartbeats.
USE THIS to predict when oven space will free up and which jobs are completing curing.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export const COATING_TOOLS = [
  get_coating_queue,
  get_coating_wait_summary,
  get_coating_intelligence,
  get_coating_batch_history,
  submit_coating_batch_plan,
  get_oven_rack_status,
];

export const INVENTORY_TOOLS = [
  get_inventory_summary,
  get_inventory_detail,
];

export const MAINTENANCE_TOOLS = [
  get_maintenance_summary,
  get_maintenance_tasks,
];

export const CATALOG_TOOLS = [
  get_lens_catalog,
  get_frame_catalog,
  get_opc_history,
];

export const SETTINGS_TOOLS = [
  get_settings,
  update_setting,
];

export const GENERIC_TOOLS = [
  query_database,
  call_api,
  think_aloud,
];

// ─────────────────────────────────────────────────────────────────────────────
// KNOWLEDGE BASE TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const search_knowledge = {
  name: 'search_knowledge',
  description: `USE THIS when the user asks about SOPs, recipes, procedures, reports, chemical formulas, oven temps, or any lab documentation.
WHAT: Searches the lab knowledge base for documents matching keywords. Returns title, category, text excerpt.
HOW: Provide a search query. Optionally filter by category (sops, reports, recipes, general).
NOT for live production data — use WIP/coating/inventory tools for that.`,
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Search keywords (e.g. "AR coating recipe", "oven temperature SOP", "breakage procedure")',
      },
      category: {
        type: 'string',
        enum: ['sops', 'reports', 'recipes', 'general'],
        description: 'Filter by category. Omit to search all.',
      },
      limit: {
        type: 'number',
        description: 'Max results to return (default 5)',
        default: 5,
      },
    },
    required: ['query'],
  },
};

export const get_knowledge_doc = {
  name: 'get_knowledge_doc',
  description: `USE THIS to retrieve the full text content of a specific knowledge base document.
WHAT: Returns the full text of a document by ID. Use after search_knowledge finds a relevant doc.
HOW: Provide the document ID from search results.
NOT for searching — use search_knowledge first to find the right doc.`,
  input_schema: {
    type: 'object',
    properties: {
      doc_id: {
        type: 'string',
        description: 'Document ID (e.g. "kb_a1b2c3d4e5f6")',
      },
    },
    required: ['doc_id'],
  },
};

export const generate_csv_report = {
  name: 'generate_csv_report',
  description: `USE THIS when the user asks you to create/generate/export a CSV report or spreadsheet.
WHAT: Creates a downloadable CSV file from structured data you provide.
HOW: Provide a title, column headers array, and rows (array of arrays). Returns a download link.
The user can then download the file or you can offer to send it to Google Drive.
NOT for displaying data in chat — just format it as markdown. Only use this for actual file exports.`,
  input_schema: {
    type: 'object',
    properties: {
      title: {
        type: 'string',
        description: 'Report title (used as filename)',
      },
      headers: {
        type: 'array',
        items: { type: 'string' },
        description: 'Column headers (e.g. ["Job ID", "Stage", "Days In Lab", "Due Date"])',
      },
      rows: {
        type: 'array',
        items: {
          type: 'array',
          items: { type: 'string' },
        },
        description: 'Data rows, each an array of cell values matching headers',
      },
    },
    required: ['title', 'headers', 'rows'],
  },
};

export const KNOWLEDGE_TOOLS = [
  search_knowledge,
  get_knowledge_doc,
  generate_csv_report,
];

// ─────────────────────────────────────────────────────────────────────────────
// TIME AT LAB TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_time_at_lab_summary = {
  name: 'get_time_at_lab_summary',
  description: `USE THIS for questions about how long jobs take, time-at-lab metrics, SLA compliance, or bottleneck identification.
WHAT: Returns avg/min/max days in lab, SLA compliance %, stage dwell times, current WIP by stage, bottleneck stage, at-risk jobs.
HOW: Optional period (24h, 7d, 30d). Returns shipped job stats + active WIP stats.
NOT for individual job timelines — use get_time_at_lab_job() for that.`,
  input_schema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['24h', '7d', '30d'],
        description: 'Time period. Default 7d.',
        default: '7d',
      },
    },
  },
};

export const get_time_at_lab_job = {
  name: 'get_time_at_lab_job',
  description: `USE THIS to see the full lifecycle timeline of a specific job — every stage it passed through with timestamps and dwell times.
WHAT: Returns job attributes, per-stage enter/exit timestamps, stage durations, SLA status, transition log.
HOW: Requires job_id (invoice number).
NOT for aggregate stats — use get_time_at_lab_summary() for that.`,
  input_schema: {
    type: 'object',
    properties: {
      job_id: {
        type: 'string',
        description: 'Job/invoice number to look up (required)',
      },
    },
    required: ['job_id'],
  },
};

export const get_time_at_lab_histogram = {
  name: 'get_time_at_lab_histogram',
  description: `USE THIS for distribution analysis — how many jobs at each day-in-lab mark, filterable by lens type, coating, department.
WHAT: Returns job counts bucketed by days in lab (0d, 1d, 2d, 3d...) with breakdowns by coating, lens type, and stage.
HOW: Filter by lensType (P/S/B), coating, stage. Mode: active (current WIP) or shipped (historical).`,
  input_schema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['active', 'shipped'], description: 'active WIP or shipped jobs', default: 'active' },
      lensType: { type: 'string', description: 'Filter: P=Progressive, S=Single Vision, B=Bifocal' },
      coating: { type: 'string', description: 'Filter: AR, Blue Cut, Hard Coat, Transitions, Mirror, Polarized' },
      stage: { type: 'string', description: 'Filter: SURFACING, COATING, CUTTING, ASSEMBLY, QC' },
      period: { type: 'string', description: 'For shipped mode: 7d, 30d, 90d', default: '30d' },
    },
  },
};

export const get_sla_at_risk = {
  name: 'get_sla_at_risk',
  description: `USE THIS to find jobs that are approaching or have exceeded their SLA deadline.
WHAT: Returns list of at-risk and breached jobs with job ID, stage, elapsed time, remaining time, SLA target.
HOW: No parameters needed. Returns up to 50 most urgent jobs.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export const TIME_AT_LAB_TOOLS = [
  get_time_at_lab_summary,
  get_time_at_lab_job,
  get_time_at_lab_histogram,
  get_sla_at_risk,
];

// ─────────────────────────────────────────────────────────────────────────────
// MACHINE & OPERATOR TOOLS
// ─────────────────────────────────────────────────────────────────────────────

export const get_som_status = {
  name: 'get_som_status',
  description: `USE THIS for questions about machine health, conveyor status, OEE, or equipment errors.
WHAT: Returns all SOM (Schneider) machine devices with status, error state, conveyor positions, and health info.
HOW: No parameters needed. Returns devices + conveyors from both sites.
For surfacing questions: machines include generators, polishers, blockers, deblocking units.`,
  input_schema: {
    type: 'object',
    properties: {},
  },
};

export const get_dvi_operator_data = {
  name: 'get_dvi_operator_data',
  description: `USE THIS for questions about operator performance, who is working on what, jobs per operator, or top performers.
WHAT: Returns DVI job data with operator assignments and performance metrics.
HOW: Optional department filter.
IMPORTANT for Assembly (department="A"): Returns pre-aggregated operatorStats with jobs completed, jobsPerHour, rush count, first/last job time per operator. Also returns stationOperators mapping (which operator is at which station) and byStation completion counts. Use operatorStats to answer "who are top performers" directly.
For other departments: Returns job records with operator field for manual grouping.`,
  input_schema: {
    type: 'object',
    properties: {
      department: {
        type: 'string',
        description: 'Filter by department code: S=Surfacing, C=Coating, E=Edging, A=Assembly, Q=QC',
      },
    },
  },
};

export const get_backlog_catchup = {
  name: 'get_backlog_catchup',
  description: `USE THIS for backlog analysis, catch-up projections, and recovery timeline questions.
WHAT: Returns current backlog, net daily gain/loss, days to clear, projected clear date, weekly milestones.
HOW: Optional department. Auto-fills from live DVI queue data if department specified.
For "when will we catch up" or "how far behind are we" questions.`,
  input_schema: {
    type: 'object',
    properties: {
      department: {
        type: 'string',
        description: 'Department: surfacing, cutting, coating, assembly. Omit for lab-wide.',
      },
    },
  },
};

export const get_operator_leaderboard = {
  name: 'get_operator_leaderboard',
  description: `USE THIS for "who are the top performers", "best assemblers", "operator rankings", or any operator comparison question.
WHAT: Returns pre-aggregated operator leaderboard sorted BEST FIRST. Rank 1 = MOST jobs = TOP performer. Rank 2 = second best. The list is already sorted — show rank 1-5 for "top performers".
FIELDS: rank (1=best), operator (initials), totalJobs, jobsPerDay, avgDwellMin.
HOW: Optional days (default 14) and stage filter (ASSEMBLY, SURFACING, COATING, CUTTING, QC).
IMPORTANT: When asked for "top performers", show the FIRST entries (rank 1, 2, 3...). Do NOT reverse or show the bottom.`,
  input_schema: {
    type: 'object',
    properties: {
      days: { type: 'number', description: 'Look back N days. Default 14.', default: 14 },
      stage: { type: 'string', description: 'Filter by stage: ASSEMBLY, SURFACING, COATING, CUTTING, QC. Omit for all.' },
    },
  },
};

export const OPERATIONS_TOOLS = [
  get_som_status,
  get_dvi_operator_data,
  get_backlog_catchup,
  get_operator_leaderboard,
];

// All tools (for backwards compatibility)
export const ALL_TOOLS = [
  ...WIP_TOOLS,
  ...REPORT_TOOLS,
  ...BREAKAGE_TOOLS,
  ...COATING_TOOLS,
  ...INVENTORY_TOOLS,
  ...MAINTENANCE_TOOLS,
  ...CATALOG_TOOLS,
  ...SETTINGS_TOOLS,
  ...GENERIC_TOOLS,
  ...KNOWLEDGE_TOOLS,
  ...TIME_AT_LAB_TOOLS,
  ...OPERATIONS_TOOLS,
];

