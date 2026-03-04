/**
 * MCP Agent Configurations
 * Each department agent gets a scoped tool set + system prompt
 */

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
  get_maintenance_summary,
  get_maintenance_tasks,
  get_lens_catalog,
  get_frame_catalog,
  get_opc_history,
  get_settings,
  query_database,
  call_api,
  think_aloud,
  ALL_TOOLS,
} from '../tools/definitions.js';

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
    get_settings,
    think_aloud,
  ],
  defaultFilters: {
    department: 'S',
  },
};

export const COATING_AGENT: AgentConfig = {
  name: 'CoatingAgent',
  description: 'Coating department: queue, wait times, AR/Blue/Hard coat processes',
  department: 'C',
  systemPrompt: COATING_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_coating_queue,
    get_coating_wait_summary,
    get_aging_report,
    get_breakage_summary,
    get_breakage_events,
    get_lens_catalog,
    get_maintenance_summary,
    get_settings,
    think_aloud,
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
  ],
  defaultFilters: {
    department: 'O',
  },
};

export const EDGE_AGENT: AgentConfig = {
  name: 'EdgingAgent',
  description: 'Edging/Cutting department: lens cutting, frame mounting prep',
  department: 'E',
  systemPrompt: EDGE_AGENT_PROMPT,
  tools: [
    get_wip_snapshot,
    get_wip_jobs,
    get_job_detail,
    get_aging_report,
    get_breakage_summary,
    get_breakage_events,
    get_breakage_by_position,
    get_frame_catalog,
    get_maintenance_summary,
    get_settings,
    think_aloud,
  ],
  defaultFilters: {
    department: 'E',
  },
};

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
    get_breakage_summary,
    get_breakage_events,
    get_frame_catalog,
    get_maintenance_summary,
    get_settings,
    think_aloud,
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
    get_breakage_summary,
    get_breakage_events,
    get_lens_catalog,
    get_frame_catalog,
    get_settings,
    think_aloud,
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
  department: undefined,  // No department filter - sees everything
  systemPrompt: DIRECTOR_AGENT_PROMPT,
  tools: [
    // Summary and report tools only - no raw data access
    get_wip_snapshot,
    get_aging_report,
    get_throughput_trend,
    get_remake_rate,
    get_breakage_summary,
    get_coating_wait_summary,
    get_inventory_summary,
    get_maintenance_summary,
    get_settings,
    think_aloud,
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
    get_wip_snapshot,  // For production impact context
    get_breakage_summary,  // Breakage often relates to equipment issues
    get_settings,
    think_aloud,
  ],
  defaultFilters: {},
};

export const SHIFT_REPORT_AGENT: AgentConfig = {
  name: 'ShiftReportAgent',
  description: 'Shift summaries: cross-department reports, KPIs',
  department: undefined,
  systemPrompt: SHIFT_REPORT_AGENT_PROMPT,
  tools: [
    // Summary and report tools only - no raw data
    get_wip_snapshot,
    get_aging_report,
    get_throughput_trend,
    get_breakage_summary,
    get_coating_wait_summary,
    get_inventory_summary,
    get_maintenance_summary,
    get_settings,
    think_aloud,
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
    get_inventory_summary,
    get_inventory_detail,
    get_lens_catalog,
    get_settings,
    think_aloud,
  ],
  defaultFilters: {},
};

// ─────────────────────────────────────────────────────────────────────────────
// Agent Registry
// ─────────────────────────────────────────────────────────────────────────────

export const AGENT_REGISTRY: Record<string, AgentConfig> = {
  // Department agents
  surface: SURFACE_AGENT,
  surfacing: SURFACE_AGENT,
  coating: COATING_AGENT,
  office: OFFICE_AGENT,
  edge: EDGE_AGENT,
  edging: EDGE_AGENT,
  assembly: ASSEMBLY_AGENT,
  qc: QC_AGENT,
  // Cross-department agents
  director: DIRECTOR_AGENT,
  lab: LAB_AGENT,
  // Specialized agents
  devops: DEVOPS_AGENT,
  maintenance: MAINTENANCE_AGENT,
  shiftreport: SHIFT_REPORT_AGENT,
  shift: SHIFT_REPORT_AGENT,
  picking: PICKING_AGENT,
  // Default fallback
  default: LAB_AGENT,
};

/**
 * Get agent configuration by name
 */
export function getAgentConfig(agentName: string): AgentConfig {
  const normalized = agentName.toLowerCase().replace(/agent$/i, '');
  return AGENT_REGISTRY[normalized] || AGENT_REGISTRY.default;
}

/**
 * Get all available agent names
 */
export function getAvailableAgents(): string[] {
  return Object.keys(AGENT_REGISTRY).filter(k => k !== 'default');
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
 */
export function getAgentSystemPrompt(agentName: string): string {
  const config = getAgentConfig(agentName);
  return config.systemPrompt;
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
