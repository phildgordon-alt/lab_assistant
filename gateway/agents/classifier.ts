/**
 * Intent Classifier
 * Maps user questions to the appropriate agent
 */

// Keyword-based classification (v1)
// Will be replaced with LLM classification in v2
const AGENT_KEYWORDS: Record<string, string[]> = {
  CodingAgent: [
    'coding', 'barcode', 'data matrix', 'datamatrix', 'scan', 'marking',
    'engraving', 'label', 'laser', 'code', 'coded', 'ecc200',
  ],
  PickingAgent: [
    'pick', 'picking', 'kardex', 'put wall', 'putwall', 'tray', 'dispensing',
    'dispense', 'carousel', 'storage', 'bin', 'lens blank', 'inventory',
  ],
  SurfacingAgent: [
    'surfacing', 'coating', 'ar', 'anti-reflective', 'blue light', 'bluecut',
    'photochromic', 'transitions', 'polarized', 'hard coat', 'mirror',
    'yield', 'defect', 'crazing', 'pinholes', 'delamination', 'haze',
    'coater', 'satis', 'opticoat',
  ],
  CuttingAgent: [
    'cutting', 'edging', 'single vision', 'sv', 'edger', 'lens cut',
    'edge', 'cut', 'shape', 'frame shape', 'breakage',
  ],
  AssemblyAgent: [
    'assembly', 'assemble', 'frame', 'mounting', 'finishing', 'finish',
    'mount', 'final', 'station', 'assembler', 'bench',
  ],
  MaintenanceAgent: [
    'maintenance', 'machine down', 'down', 'fault', 'repair', 'uptime',
    'equipment', 'broken', 'fix', 'pm', 'preventive', 'mtbf', 'mttr',
    'limble', 'work order', 'asset',
  ],
  ShiftReportAgent: [
    'shift', 'report', 'summary', 'briefing', 'overnight', 'daily',
    'morning', 'evening', 'handoff', 'status', 'overview', 'kpi',
    'throughput', 'performance', 'today', 'yesterday', 'week',
  ],
};

// Default agent when no match is found
const DEFAULT_AGENT = 'ShiftReportAgent';

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
  return agentName in AGENT_KEYWORDS;
}
