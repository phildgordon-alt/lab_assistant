/**
 * Intent Classifier
 * Maps user questions to the appropriate agent
 *
 * Production Flow Agents (scoped tools):
 * - SurfacingAgent: Dept S - lens generation, freeform cutting
 * - CuttingAgent: Dept E - lens cutting/edging to frame shape
 * - CodingAgent: Laser marking, data matrix codes, traceability
 * - CoatingAgent: Dept C - AR, blue cut, hard coat, queue management
 * - AssemblyAgent: Dept A - 8 assembly stations
 * - QCAgent: Dept Q - inspection, pass rates
 * - ShippingAgent: Final pack, carrier selection, tracking
 *
 * Support Agents:
 * - OfficeAgent: Dept O - order entry, remakes, data issues
 * - PickingAgent: Kardex, put wall, lens blanks
 *
 * Cross-department:
 * - DirectorAgent: Cross-department reports, bottleneck identification
 * - LabAgent: General fallback, all tools
 *
 * Specialized:
 * - DevOpsAgent: API connections, gateway config
 * - MaintenanceAgent: Equipment, work orders, Limble
 * - ShiftReportAgent: Shift summaries, KPIs
 */

// Keyword-based classification (v1)
// Will be replaced with LLM classification in v2
const AGENT_KEYWORDS: Record<string, string[]> = {
  // ─────────────────────────────────────────────────────────────────────────
  // DEPARTMENT AGENTS (scoped tools, department-specific prompts)
  // ─────────────────────────────────────────────────────────────────────────
  SurfacingAgent: [
    'surfacing', 'generator', 'generation', 'base curve', 'front curve',
    'freeform', 'progressive', 'pal', 'bifocal', 'lens blank', 'blocking',
    'polishing', 'yield', 'defect', 'scratch', 'chip', 'dept s', 'department s',
  ],
  CoatingAgent: [
    'coating', 'coater', 'ar', 'anti-reflective', 'blue light', 'bluecut',
    'photochromic', 'transitions', 'polarized', 'hard coat', 'mirror',
    'crazing', 'pinholes', 'delamination', 'haze', 'satis', 'opticoat',
    'batch', 'oven', 'cure', 'curing', 'rack', 'coating queue', 'wait time',
    'dept c', 'department c',
  ],
  CuttingAgent: [
    'cutting', 'edging', 'single vision', 'sv', 'edger', 'lens cut',
    'edge', 'cut', 'shape', 'frame shape', 'dept e', 'department e',
  ],
  AssemblyAgent: [
    'assembly', 'assemble', 'frame', 'mounting', 'finishing', 'finish',
    'mount', 'final', 'station', 'assembler', 'bench', 'stn-', 'jobs/hour',
    'dept a', 'department a',
  ],
  QCAgent: [
    'qc', 'quality', 'inspection', 'inspect', 'hold', 'holds', 'reject',
    'fail', 'failure', 'pass rate', 'rework', 'scrap', 'verification',
    'verify', 'qa', 'dept q', 'department q',
  ],
  OfficeAgent: [
    'office', 'front office', 'order entry', 'data entry', 'remake',
    'redo', 'original invoice', 'data error', 'customer', 'rx number',
    'dept o', 'department o',
  ],
  // ─────────────────────────────────────────────────────────────────────────
  // CROSS-DEPARTMENT AGENTS
  // ─────────────────────────────────────────────────────────────────────────
  DirectorAgent: [
    'compare', 'comparison', 'all departments', 'across departments',
    'lab-wide', 'bottleneck', 'capacity', 'overall', 'executive',
    'director', 'cross-department', 'which department',
  ],
  LabAgent: [
    'lab', 'wip', 'jobs', 'job', 'production', 'how many', 'what', 'show',
    'tell me', 'give me', 'list', 'count', 'total', 'all', 'everything',
    'status', 'current', 'now', 'latest', 'update', 'rush', 'oldest',
    'aging', 'stage', 'stages', 'department', 'departments',
  ],
  // ─────────────────────────────────────────────────────────────────────────
  // SPECIALIZED AGENTS
  // ─────────────────────────────────────────────────────────────────────────
  DevOpsAgent: [
    'api', 'gateway', 'connection', 'server', 'config', 'environment',
    'env', 'startup', 'port', 'mock', 'database', 'postgres', 'slack',
    'health', 'error', 'not working', 'not loading', 'disconnected',
    'timeout', 'integration', 'setup', 'configure', 'devops', 'debug',
    'limble', 'itempath', 'dvi', 'kardex', 'anthropic',
  ],
  CodingAgent: [
    'coding', 'barcode', 'data matrix', 'datamatrix', 'scan', 'marking',
    'engraving', 'label', 'laser mark', 'code', 'coded', 'ecc200', 'traceability',
  ],
  PickingAgent: [
    'pick', 'picking', 'kardex', 'put wall', 'putwall', 'tray', 'dispensing',
    'dispense', 'carousel', 'storage', 'bin', 'lens blank',
  ],
  InventoryAgent: [
    'inventory', 'stock', 'stocking', 'restock', 'reorder', 'consumption',
    'usage', 'sku', 'blank', 'blanks', 'supply', 'procurement', 'par level',
    'safety stock', 'lead time', 'forecast', 'demand', 'stockout', 'low stock',
    'order quantity', 'days of supply', 'stocking plan',
  ],
  MaintenanceAgent: [
    'maintenance', 'machine down', 'down', 'fault', 'repair', 'uptime',
    'equipment', 'broken', 'fix', 'pm', 'preventive', 'mtbf', 'mttr',
    'limble', 'work order', 'asset', 'breakage',
  ],
  ShiftReportAgent: [
    'shift', 'report', 'summary', 'briefing', 'overnight', 'daily',
    'morning', 'evening', 'handoff', 'status', 'overview', 'kpi',
    'throughput', 'performance', 'today', 'yesterday', 'week',
  ],
  ShippingAgent: [
    'shipping', 'ship', 'shipped', 'carrier', 'ups', 'fedex', 'usps',
    'tracking', 'pack', 'packing', 'label', 'manifest', 'cutoff',
    'delivery', 'outbound',
  ],
  NocAgent: [
    'noc', 'network', 'vlan', 'wifi', 'wi-fi', 'wireless', 'switch', 'switching',
    'unifi', 'udm', 'usw', 'uap', 'wan', 'lan', 'sd-wan', 'site magic',
    'irvine 1', 'irvine 2', 'ap', 'access point', 'poe', 'stp',
    'spanning tree', 'subnet', 'router', 'gateway', 'firewall', 'vpn',
    'teleport', 'wireguard', 'isp', 'cox', 'verizon', 'rssi', 'channel',
    'roaming', 'broadcast storm', 'topology', 'segment', 'segmentation',
    'ot vlan', 'kardex segment', 'door access vlan',
  ],
};

// Default agent when no match is found - LabAgent can answer ANY lab question
const DEFAULT_AGENT = 'LabAgent';

// Map classifier agent names to MCP agent config names
const AGENT_CONFIG_MAP: Record<string, string> = {
  // Department agents (production flow order)
  SurfacingAgent: 'surfacing',
  CuttingAgent: 'cutting',
  CodingAgent: 'coding',
  CoatingAgent: 'coating',
  AssemblyAgent: 'assembly',
  QCAgent: 'qc',
  ShippingAgent: 'shipping',
  // Support agents
  OfficeAgent: 'office',
  PickingAgent: 'picking',
  InventoryAgent: 'inventory',
  // Cross-department agents
  DirectorAgent: 'director',
  LabAgent: 'lab',
  // Specialized agents
  DevOpsAgent: 'devops',
  MaintenanceAgent: 'maintenance',
  ShiftReportAgent: 'shiftreport',
  NocAgent: 'noc',
};

/**
 * Classify a user's question and return the appropriate agent name
 */
export function classifyIntent(question: string): string {
  const lowerQuestion = question.toLowerCase();

  // Score each agent based on keyword matches
  const scores: Record<string, number> = {};

  for (const [agent, keywords] of Object.entries(AGENT_KEYWORDS)) {
    scores[agent] = 0;

    for (const keyword of keywords) {
      if (lowerQuestion.includes(keyword)) {
        // Longer keywords get higher scores (more specific)
        scores[agent] += keyword.length;
      }
    }
  }

  // Find the agent with the highest score
  let bestAgent = DEFAULT_AGENT;
  let bestScore = 0;

  for (const [agent, score] of Object.entries(scores)) {
    if (score > bestScore) {
      bestScore = score;
      bestAgent = agent;
    }
  }

  return bestAgent;
}

/**
 * Get the MCP agent config name for a classified agent
 */
export function getAgentConfigName(classifiedAgent: string): string {
  return AGENT_CONFIG_MAP[classifiedAgent] || 'lab';
}

/**
 * Get all available agents
 */
export function getAgents(): Array<{ name: string; keywords: string[] }> {
  return Object.entries(AGENT_KEYWORDS).map(([name, keywords]) => ({
    name,
    keywords,
  }));
}

/**
 * Check if an agent name is valid
 */
export function isValidAgent(agentName: string): boolean {
  return agentName in AGENT_KEYWORDS || agentName in AGENT_CONFIG_MAP;
}
