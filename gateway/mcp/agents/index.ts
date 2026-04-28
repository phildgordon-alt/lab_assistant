/**
 * MCP Agent Configurations
 * Each department agent gets a scoped tool set + system prompt
 * Prompts are loaded from MD files in gateway/agents/prompts/
 */

import { readFileSync, existsSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  get_wip_snapshot,
  get_wip_jobs,
  get_job_detail,
  get_aging_report,
  get_throughput_trend,
  get_remake_rate,
  get_breakage_summary,
  get_breakage_events,
  get_breakage_by_position,
  get_coating_queue,
  get_coating_wait_summary,
  get_inventory_summary,
  get_inventory_detail,
  get_consumption_history,
  get_binning_swap,
  get_binning_consolidation,
  get_binning_adjacency,
  get_reconciliation_summary,
  get_reconciliation_detail,
  get_maintenance_summary,
  get_maintenance_tasks,
  get_lens_catalog,
  get_frame_catalog,
  get_opc_history,
  get_settings,
  query_database,
  call_api,
  think_aloud,
  get_coating_intelligence,
  get_coating_batch_history,
  submit_coating_batch_plan,
  get_oven_rack_status,
  search_knowledge,
  get_knowledge_doc,
  generate_csv_report,
  get_time_at_lab_summary,
  get_time_at_lab_job,
  get_time_at_lab_histogram,
  get_sla_at_risk,
  get_som_status,
  get_dvi_operator_data,
  get_backlog_catchup,
  get_operator_leaderboard,
  read_file,
  write_file,
  git_status,
  git_diff,
  git_commit,
  git_push,
  restart_service,
  ALL_TOOLS,
} from '../tools/definitions.js';

// Fallback prompts for agents without MD files
import {
  SURFACE_AGENT_PROMPT,
  COATING_AGENT_PROMPT,
  OFFICE_AGENT_PROMPT,
  EDGE_AGENT_PROMPT,
  ASSEMBLY_AGENT_PROMPT,
  QC_AGENT_PROMPT,
  DIRECTOR_AGENT_PROMPT,
  LAB_AGENT_PROMPT,
  DEVOPS_AGENT_PROMPT,
  MAINTENANCE_AGENT_PROMPT,
  SHIFT_REPORT_AGENT_PROMPT,
  PICKING_AGENT_PROMPT,
} from '../prompts.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = join(__dirname, '..', '..', 'agents', 'prompts');

// Cache for loaded MD prompts
const promptCache: Map<string, { content: string; loadedAt: number }> = new Map();
const CACHE_TTL = 60_000; // 1 minute

/**
 * Load agent prompt from MD file if it exists, otherwise use fallback
 */
function loadAgentPrompt(agentName: string, fallbackPrompt: string): string {
  const cached = promptCache.get(agentName);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL) {
    return cached.content;
  }

  const mdFile = join(PROMPTS_DIR, `${agentName}.md`);
  if (existsSync(mdFile)) {
    const content = readFileSync(mdFile, 'utf-8');
    promptCache.set(agentName, { content, loadedAt: Date.now() });
    return content;
  }

  return fallbackPrompt;
}

/**
 * Get all available MD prompt files
 */
export function getAvailableMDPrompts(): string[] {
  if (!existsSync(PROMPTS_DIR)) return [];
  return readdirSync(PROMPTS_DIR)
    .filter(f => f.endsWith('.md'))
    .map(f => f.replace('.md', ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// Agent Configuration Type
// ─────────────────────────────────────────────────────────────────────────────

export interface AgentConfig {
  name: string;
  description: string;
  department?: string;           // Department code (S, C, E, A, Q, O) or null for cross-dept
  systemPrompt: string;
  tools: any[];                  // Tool definitions this agent can use
  defaultFilters?: Record<string, any>;  // Default params applied to tool calls
}

// ─────────────────────────────────────────────────────────────────────────────
// Department Agents
// ─────────────────────────────────────────────────────────────────────────────

export const SURFACE_AGENT: AgentConfig = {
  name: 'SurfacingAgent',
  description: 'Surfacing department: lens generation, breakage, inventory',
  department: 'S',
  systemPrompt: SURFACE_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_aging_report,
    get_breakage_summary,
    get_breakage_events,
    get_breakage_by_position,
    get_lens_catalog,
    get_inventory_summary,
    get_maintenance_summary,
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    get_sla_at_risk,
    get_som_status,
    get_dvi_operator_data,
    get_backlog_catchup,
    get_throughput_trend,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {
    department: 'S',
  },
};

export const COATING_AGENT: AgentConfig = {
  name: 'CoatingAgent',
  description: 'Coating department: intelligent batching, oven tracking, queue optimization, AR/Blue/Hard coat',
  department: 'C',
  systemPrompt: COATING_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_coating_queue,
    get_coating_wait_summary,
    get_coating_intelligence,
    get_coating_batch_history,
    submit_coating_batch_plan,
    get_oven_rack_status,
    get_aging_report,
    get_throughput_trend,
    get_breakage_summary,
    get_breakage_events,
    get_lens_catalog,
    get_maintenance_summary,
    get_som_status,            // coater machine health
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    get_sla_at_risk,
    get_dvi_operator_data,
    get_operator_leaderboard,
    get_backlog_catchup,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {
    department: 'C',
  },
};

export const OFFICE_AGENT: AgentConfig = {
  name: 'OfficeAgent',
  description: 'Front office: order entry, remakes, data issues',
  department: 'O',
  systemPrompt: OFFICE_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_aging_report,
    get_remake_rate,
    get_breakage_summary,
    get_lens_catalog,
    get_frame_catalog,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {
    department: 'O',
  },
};

export const CUTTING_AGENT: AgentConfig = {
  name: 'CuttingAgent',
  description: 'Cutting/Edging department: lens cutting, edging, frame mounting prep',
  department: 'E',
  systemPrompt: EDGE_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_aging_report,
    get_throughput_trend,
    get_breakage_summary,
    get_breakage_events,
    get_breakage_by_position,
    get_frame_catalog,
    get_maintenance_summary,
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    get_sla_at_risk,
    get_dvi_operator_data,
    get_operator_leaderboard,
    get_backlog_catchup,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {
    department: 'E',
  },
};

// Alias for backward compatibility
export const EDGE_AGENT = CUTTING_AGENT;

export const ASSEMBLY_AGENT: AgentConfig = {
  name: 'AssemblyAgent',
  description: 'Assembly department: station performance, operator metrics',
  department: 'A',
  systemPrompt: ASSEMBLY_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_aging_report,
    get_throughput_trend,
    get_breakage_summary,
    get_breakage_events,
    get_frame_catalog,
    get_maintenance_summary,
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    get_sla_at_risk,
    get_dvi_operator_data,
    get_operator_leaderboard,
    get_backlog_catchup,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {
    department: 'A',
  },
};

export const QC_AGENT: AgentConfig = {
  name: 'QCAgent',
  description: 'QC department: inspection, pass rates, defect tracking',
  department: 'Q',
  systemPrompt: QC_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_aging_report,
    get_throughput_trend,
    get_remake_rate,
    get_breakage_summary,
    get_breakage_events,
    get_breakage_by_position,
    get_time_at_lab_summary,
    get_sla_at_risk,
    get_dvi_operator_data,
    get_lens_catalog,
    get_frame_catalog,
    get_maintenance_summary,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {
    department: 'Q',
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Cross-Department Agents
// ─────────────────────────────────────────────────────────────────────────────

export const DIRECTOR_AGENT: AgentConfig = {
  name: 'DirectorAgent',
  description: 'Lab director: cross-department reports, bottleneck identification',
  department: undefined,
  systemPrompt: DIRECTOR_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,              // drill into specific jobs
    get_job_detail,            // full job detail
    get_aging_report,
    get_throughput_trend,
    get_remake_rate,
    get_breakage_summary,
    get_coating_wait_summary,
    get_coating_intelligence,  // coating pipeline visibility
    get_inventory_summary,
    get_maintenance_summary,
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    get_sla_at_risk,
    get_som_status,
    get_dvi_operator_data,
    get_operator_leaderboard,
    get_backlog_catchup,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
    generate_csv_report,
  ],
  defaultFilters: {},  // No defaults - cross-department view
};

export const LAB_AGENT: AgentConfig = {
  name: 'LabAgent',
  description: 'General lab assistant: all tools, no department restrictions',
  department: undefined,
  systemPrompt: LAB_AGENT_PROMPT,
  tools: ALL_TOOLS,
  defaultFilters: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Specialized Agents
// ─────────────────────────────────────────────────────────────────────────────

export const DEVOPS_AGENT: AgentConfig = {
  name: 'DevOpsAgent',
  description: 'System administration: connections, health, configuration',
  department: undefined,
  systemPrompt: DEVOPS_AGENT_PROMPT,
  tools: [
    // DevOps needs API access and settings, not production data tools
    get_settings,
    call_api,
    think_aloud,
  ],
  defaultFilters: {},
};

export const MAINTENANCE_AGENT: AgentConfig = {
  name: 'MaintenanceAgent',
  description: 'Equipment maintenance: work orders, uptime, parts',
  department: undefined,
  systemPrompt: MAINTENANCE_AGENT_PROMPT,
  tools: [
    get_maintenance_summary,
    get_maintenance_tasks,
    get_som_status,          // CRITICAL: real-time Schneider machine health
    get_wip_snapshot,
    get_breakage_summary,
    get_time_at_lab_summary, // downtime impact on throughput
    get_settings,
    call_api,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {},
};

export const SHIFT_REPORT_AGENT: AgentConfig = {
  name: 'ShiftReportAgent',
  description: 'Shift summaries: cross-department reports, KPIs',
  department: undefined,
  systemPrompt: SHIFT_REPORT_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_aging_report,
    get_throughput_trend,
    get_remake_rate,
    get_breakage_summary,
    get_coating_wait_summary,
    get_inventory_summary,
    get_maintenance_summary,
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    get_sla_at_risk,
    get_som_status,
    get_dvi_operator_data,
    get_operator_leaderboard,
    get_backlog_catchup,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
    generate_csv_report,
  ],
  defaultFilters: {},
};

export const PICKING_AGENT: AgentConfig = {
  name: 'PickingAgent',
  description: 'Picking/inventory: Kardex, put wall, lens blanks',
  department: undefined,
  systemPrompt: PICKING_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_inventory_summary,
    get_inventory_detail,
    get_lens_catalog,
    get_time_at_lab_summary,
    get_backlog_catchup,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {},
};

export const CODING_AGENT: AgentConfig = {
  name: 'CodingAgent',
  description: 'Senior software engineer: React, Node.js, Java, JavaScript. Reads, edits, commits, pushes, and restarts services. Operator-restricted to Phil.',
  department: undefined,
  systemPrompt: '', // Loaded from CodingAgent.md
  tools: [
    // Read-only context tools (anyone can call)
    call_api,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
    // Code tools — gated to Phil's Slack ID by requireOperator() in handleToolCall
    read_file,
    write_file,
    git_status,
    git_diff,
    git_commit,
    git_push,
    restart_service,
  ],
  defaultFilters: {},
};

export const SHIPPING_AGENT: AgentConfig = {
  name: 'ShippingAgent',
  description: 'Shipping department: final pack, carrier selection, tracking',
  department: undefined,
  systemPrompt: '', // Loaded from ShippingAgent.md
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_aging_report,
    get_throughput_trend,
    get_time_at_lab_summary,
    get_sla_at_risk,
    get_backlog_catchup,
    get_dvi_operator_data,
    get_breakage_summary,
    get_settings,
    call_api,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
  ],
  defaultFilters: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent Registry
// ─────────────────────────────────────────────────────────────────────────────

export const INVENTORY_AGENT: AgentConfig = {
  name: 'InventoryAgent',
  description: 'Inventory & stocking: consumption analysis, reorder plans, SKU-level stock management',
  department: undefined,
  systemPrompt: '', // Loaded from InventoryAgent.md
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_inventory_summary,
    get_inventory_detail,
    get_consumption_history,
    get_binning_swap,
    get_binning_consolidation,
    get_binning_adjacency,
    get_reconciliation_summary,
    get_reconciliation_detail,
    get_lens_catalog,
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    get_sla_at_risk,
    get_backlog_catchup,
    get_throughput_trend,
    get_settings,
    think_aloud,
    search_knowledge,
    get_knowledge_doc,
    generate_csv_report,
  ],
  defaultFilters: {},
};

// NOC (Network Operations) — scoped to read-only diagnostic tools the
// network agent actually needs. NocAgent.md (gateway/agents/prompts/)
// supplies the persona; this config supplies the tool budget.
export const NOC_AGENT: AgentConfig = {
  name: 'NocAgent',
  description: 'Network Operations: UniFi devices, VLANs, WAN/LAN, Site Magic SD-WAN, Wi-Fi, OT segment health',
  department: undefined,
  systemPrompt: '', // Loaded from NocAgent.md
  tools: [
    // Read-only context tools — NocAgent diagnoses, doesn't write
    get_settings,
    query_database,
    search_knowledge,
    get_knowledge_doc,
    think_aloud,
    call_api,
  ],
  defaultFilters: {},
};

// WipAgingAgent — strict-pivot WIP aging report (Excel-paste format).
// Split out from LabAgent.md 2026-04-28; the pivot column structure and
// station ordering are too specific to share with general-purpose
// queries.
export const WIP_AGING_AGENT: AgentConfig = {
  name: 'WipAgingAgent',
  description: 'Strict-pivot WIP aging report by station × days-in-WIP, with active-only grand total',
  department: undefined,
  systemPrompt: '', // Loaded from WipAgingAgent.md
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_aging_report,
    get_time_at_lab_summary,
    get_time_at_lab_histogram,
    query_database,
    think_aloud,
  ],
  defaultFilters: {},
};

export const AGENT_REGISTRY: Record<string, AgentConfig> = {
  // Department agents (production flow order)
  surface: SURFACE_AGENT,
  surfacing: SURFACE_AGENT,
  cutting: CUTTING_AGENT,
  edge: CUTTING_AGENT,      // alias
  edging: CUTTING_AGENT,    // alias
  coding: CODING_AGENT,     // laser marking
  coating: COATING_AGENT,
  assembly: ASSEMBLY_AGENT,
  qc: QC_AGENT,
  shipping: SHIPPING_AGENT,
  // Office/support agents
  office: OFFICE_AGENT,
  picking: PICKING_AGENT,
  inventory: INVENTORY_AGENT,
  // Cross-department agents
  director: DIRECTOR_AGENT,
  lab: LAB_AGENT,
  // Specialized agents
  devops: DEVOPS_AGENT,
  maintenance: MAINTENANCE_AGENT,
  shiftreport: SHIFT_REPORT_AGENT,
  shift: SHIFT_REPORT_AGENT,
  noc: NOC_AGENT,
  network: NOC_AGENT,       // alias — frontend posts agent:'network' historically
  wipaging: WIP_AGING_AGENT,
  'wip-aging': WIP_AGING_AGENT,  // alias for hyphenated form
  // Default fallback
  default: LAB_AGENT,
};

/**
 * Get agent configuration by name
 * Returns registry config if exists, otherwise creates dynamic config from MD file
 */
export function getAgentConfig(agentName: string): AgentConfig {
  const normalized = agentName.toLowerCase().replace(/agent$/i, '');

  // Check registry first
  if (AGENT_REGISTRY[normalized]) {
    return AGENT_REGISTRY[normalized];
  }

  // Check for MD file-only agent
  const mdAgents = getAvailableMDPrompts();
  const mdMatch = mdAgents.find(name =>
    name.toLowerCase().replace(/agent$/i, '') === normalized
  );

  if (mdMatch) {
    // Create dynamic config for MD-only agent
    const mdFile = join(PROMPTS_DIR, `${mdMatch}.md`);
    const content = existsSync(mdFile) ? readFileSync(mdFile, 'utf-8') : '';
    return {
      name: mdMatch,
      description: `${mdMatch} - loaded from ${mdMatch}.md`,
      systemPrompt: content,
      tools: ALL_TOOLS, // MD-only agents get all tools
    };
  }

  return AGENT_REGISTRY.default;
}

/**
 * Get all available agent names (deduplicated)
 * Returns unique agent names by config.name, merging registry and MD-only agents
 */
export function getAvailableAgents(): string[] {
  // Get unique agent names from registry (not aliases)
  const seenNames = new Set<string>();
  const uniqueKeys: string[] = [];

  for (const key of Object.keys(AGENT_REGISTRY)) {
    if (key === 'default') continue;
    const config = AGENT_REGISTRY[key];
    if (!seenNames.has(config.name)) {
      seenNames.add(config.name);
      uniqueKeys.push(key);
    }
  }

  // Add MD-only agents not already in registry (case-insensitive check)
  const seenNamesLower = new Set([...seenNames].map(n => n.toLowerCase()));
  const mdAgents = getAvailableMDPrompts()
    .map(name => name.replace(/Agent$/, '').toLowerCase())
    .filter(name => !seenNamesLower.has(name + 'agent') && !uniqueKeys.includes(name));
  return [...uniqueKeys, ...mdAgents];
}

/**
 * Get tools for a specific agent
 */
export function getAgentTools(agentName: string): any[] {
  const config = getAgentConfig(agentName);
  return config.tools;
}

/**
 * Get system prompt for a specific agent
 * First checks for MD file in gateway/agents/prompts/, then falls back to inline prompt
 */
export function getAgentSystemPrompt(agentName: string): string {
  const config = getAgentConfig(agentName);
  // Try to load from MD file first (e.g., CoatingAgent.md)
  return loadAgentPrompt(config.name, config.systemPrompt);
}

/**
 * Apply default filters to tool input based on agent config
 */
export function applyAgentDefaults(
  agentName: string,
  toolName: string,
  toolInput: Record<string, any>
): Record<string, any> {
  const config = getAgentConfig(agentName);
  const defaults = config.defaultFilters || {};

  // Only apply department default if the tool accepts it and it's not already set
  if (defaults.department && !toolInput.department) {
    // Check if tool has department parameter
    const tool = config.tools.find(t => t.name === toolName);
    if (tool?.input_schema?.properties?.department) {
      return { ...defaults, ...toolInput };
    }
  }

  return toolInput;
}
