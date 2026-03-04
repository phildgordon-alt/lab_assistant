/**
 * Agent Runner
 * Loads agent system prompts and calls Claude API
 */

import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, existsSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { log } from '../logger.js';
import { incrementConcurrent, decrementConcurrent } from '../limiter.js';
import { withCircuitBreaker } from '../circuit-breaker.js';
import {
  MCP_TOOLS,
  handleToolCall,
  handleAgentToolCall,
  getToolsForAgent,
  getAgentSystemPrompt as getMcpAgentPrompt,
} from '../mcp/server.js';
import { getAgentConfigName } from './classifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Friendly labels for MCP tools (shown during streaming)
const TOOL_LABELS: Record<string, string> = {
  get_wip_snapshot: 'Checking WIP status',
  get_wip_jobs: 'Fetching job details',
  get_job_detail: 'Looking up job',
  get_aging_report: 'Analyzing aging data',
  get_throughput_trend: 'Checking throughput trends',
  get_remake_rate: 'Calculating remake rate',
  get_breakage_summary: 'Reviewing breakage data',
  get_breakage_events: 'Fetching breakage events',
  get_breakage_by_position: 'Analyzing breakage by position',
  get_coating_queue: 'Checking coating queue',
  get_coating_wait_summary: 'Reviewing coating wait times',
  get_inventory_summary: 'Checking inventory levels',
  get_inventory_detail: 'Fetching inventory details',
  get_maintenance_summary: 'Checking maintenance status',
  get_maintenance_tasks: 'Fetching maintenance tasks',
  get_lens_catalog: 'Searching lens catalog',
  get_frame_catalog: 'Searching frame catalog',
  get_opc_history: 'Looking up OPC history',
  get_settings: 'Loading settings',
  query_database: 'Running database query',
  call_api: 'Calling API',
  think_aloud: 'Analyzing',
};

function getToolLabel(toolName: string): string {
  return TOOL_LABELS[toolName] || `Using ${toolName.replace(/_/g, ' ')}`;
}

// Initialize Anthropic client
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// Model to use for all agents
const MODEL = 'claude-sonnet-4-20250514';
const MAX_TOKENS = 2048;

// Cache loaded prompts
const promptCache: Map<string, { content: string; loadedAt: number }> = new Map();
const CACHE_TTL = 60_000; // 1 minute cache

export interface AgentResult {
  response: string;
  agentName: string;
  durationMs: number;
}

/**
 * Load an agent's system prompt from disk
 */
function loadAgentPrompt(agentName: string): string {
  // Check cache first
  const cached = promptCache.get(agentName);
  if (cached && Date.now() - cached.loadedAt < CACHE_TTL) {
    return cached.content;
  }

  // Load from disk
  const promptPath = join(__dirname, 'prompts', `${agentName}.md`);

  if (!existsSync(promptPath)) {
    log.warn(`Agent prompt not found: ${promptPath}, using default`);
    return getDefaultPrompt(agentName);
  }

  const content = readFileSync(promptPath, 'utf-8');
  promptCache.set(agentName, { content, loadedAt: Date.now() });

  return content;
}

/**
 * Get default prompt for an agent without a custom .md file
 */
function getDefaultPrompt(agentName: string): string {
  return `# ${agentName}

You are a helpful assistant for Pair Eyewear's lens lab operations.
You help answer questions about ${agentName.replace('Agent', '').toLowerCase()} operations.

Be concise, specific, and data-driven in your responses.
If you don't have enough information to answer, say so.

Available MCP tools:
- query_database: Run read-only SQL queries against the lab database
- call_api: Call Lab Assistant REST API endpoints
- think_aloud: Structure your reasoning before responding
`;
}

/**
 * Get metadata about loaded agent prompts
 */
export function getAgentPromptInfo(): Array<{
  name: string;
  hasPrompt: boolean;
  lastModified: Date | null;
  size: number;
}> {
  const agents = [
    'DevOpsAgent',
    'CodingAgent',
    'PickingAgent',
    'SurfacingAgent',
    'CuttingAgent',
    'AssemblyAgent',
    'MaintenanceAgent',
    'ShiftReportAgent',
  ];

  return agents.map((name) => {
    const promptPath = join(__dirname, 'prompts', `${name}.md`);
    const exists = existsSync(promptPath);

    if (!exists) {
      return { name, hasPrompt: false, lastModified: null, size: 0 };
    }

    const stats = statSync(promptPath);
    return {
      name,
      hasPrompt: true,
      lastModified: stats.mtime,
      size: stats.size,
    };
  });
}

/**
 * Run an agent with a user question (non-streaming)
 * Supports MCP tool use with agentic loop
 */
export async function runAgent(
  agentName: string,
  userMessage: string,
  userId: string,
  source: string
): Promise<AgentResult> {
  const startTime = Date.now();

  incrementConcurrent(agentName);

  try {
    // Get MCP agent config name and scoped tools
    const mcpAgentName = getAgentConfigName(agentName);
    const agentTools = getToolsForAgent(mcpAgentName);

    // Use MCP agent prompt if available, otherwise load from disk
    let systemPrompt: string;
    try {
      systemPrompt = getMcpAgentPrompt(mcpAgentName);
    } catch {
      systemPrompt = loadAgentPrompt(agentName);
    }

    const result = await withCircuitBreaker(async () => {
      // Build messages array for agentic loop
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: userMessage },
      ];

      // Agentic loop - continue until we get a final text response
      let finalText = '';
      let iterations = 0;
      const MAX_ITERATIONS = 10;

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        const response = await anthropic.messages.create({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          tools: agentTools as Anthropic.Tool[],
          messages,
        });

        // Check if response contains tool use
        const toolUseBlocks = response.content.filter((c) => c.type === 'tool_use');
        const textBlocks = response.content.filter((c) => c.type === 'text');

        // Collect any text output
        for (const block of textBlocks) {
          if (block.type === 'text') {
            finalText += block.text;
          }
        }

        // If no tool use, we're done
        if (toolUseBlocks.length === 0 || response.stop_reason === 'end_turn') {
          break;
        }

        // Handle tool calls with agent context (applies department defaults)
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          if (toolUse.type === 'tool_use') {
            log.info(`MCP Tool call: ${toolUse.name}`, { source, userId, agentName, mcpAgent: mcpAgentName });

            try {
              // Use agent-aware handler to apply department defaults
              const result = await handleAgentToolCall(
                mcpAgentName,
                toolUse.name,
                toolUse.input as Record<string, unknown>
              );
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(result),
              });
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : 'Tool execution failed';
              log.error(`MCP Tool error: ${toolUse.name}`, error);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({ error: errorMsg }),
                is_error: true,
              });
            }
          }
        }

        // Add assistant response and tool results to messages
        messages.push({ role: 'assistant', content: response.content });
        messages.push({ role: 'user', content: toolResults });
      }

      return finalText || 'No response generated.';
    });

    return {
      response: result,
      agentName,
      durationMs: Date.now() - startTime,
    };

  } finally {
    decrementConcurrent(agentName);
  }
}

/**
 * Run an agent with streaming output
 * Supports MCP tool use with agentic loop
 */
export async function runAgentStreaming(
  agentName: string,
  userMessage: string,
  userId: string,
  source: string,
  onChunk: (chunk: string) => void,
  context?: string
): Promise<void> {
  incrementConcurrent(agentName);

  try {
    // Get MCP agent config name and scoped tools
    const mcpAgentName = getAgentConfigName(agentName);
    const agentTools = getToolsForAgent(mcpAgentName);

    // Use MCP agent prompt if available, otherwise load from disk
    let basePrompt: string;
    try {
      basePrompt = getMcpAgentPrompt(mcpAgentName);
    } catch {
      basePrompt = loadAgentPrompt(agentName);
    }

    // If context is provided, prepend it to the system prompt
    const systemPrompt = context
      ? `${basePrompt}\n\n--- LIVE LAB CONTEXT ---\n${context}`
      : basePrompt;

    await withCircuitBreaker(async () => {
      // Build messages array for agentic loop
      const messages: Anthropic.MessageParam[] = [
        { role: 'user', content: userMessage },
      ];

      let iterations = 0;
      const MAX_ITERATIONS = 10;

      while (iterations < MAX_ITERATIONS) {
        iterations++;

        // Collect the full response to check for tool use
        let currentContent: Anthropic.ContentBlock[] = [];
        let stopReason: string | null = null;

        const stream = await anthropic.messages.stream({
          model: MODEL,
          max_tokens: MAX_TOKENS,
          system: systemPrompt,
          tools: agentTools as Anthropic.Tool[],
          messages,
        });

        for await (const event of stream) {
          if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
            onChunk(event.delta.text);
          }
          if (event.type === 'message_delta' && event.delta.stop_reason) {
            stopReason = event.delta.stop_reason;
          }
        }

        // Get the final message to check for tool use
        const finalMessage = await stream.finalMessage();
        currentContent = finalMessage.content;

        // Check for tool use blocks
        const toolUseBlocks = currentContent.filter((c) => c.type === 'tool_use');

        // If no tool use or stop reason is end_turn, we're done
        if (toolUseBlocks.length === 0 || stopReason === 'end_turn') {
          break;
        }

        // Handle tool calls with agent context (applies department defaults)
        const toolResults: Anthropic.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          if (toolUse.type === 'tool_use') {
            // Show progress for each tool
            const toolLabel = getToolLabel(toolUse.name);
            onChunk(`\n\n> ${toolLabel}...\n\n`);

            log.info(`MCP Tool call (streaming): ${toolUse.name}`, { source, userId, agentName, mcpAgent: mcpAgentName });

            try {
              // Use agent-aware handler to apply department defaults
              const result = await handleAgentToolCall(
                mcpAgentName,
                toolUse.name,
                toolUse.input as Record<string, unknown>
              );
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify(result),
              });
            } catch (error) {
              const errorMsg = error instanceof Error ? error.message : 'Tool execution failed';
              log.error(`MCP Tool error (streaming): ${toolUse.name}`, error);
              onChunk(`_(error: ${errorMsg})_\n`);
              toolResults.push({
                type: 'tool_result',
                tool_use_id: toolUse.id,
                content: JSON.stringify({ error: errorMsg }),
                is_error: true,
              });
            }
          }
        }

        // Add assistant response and tool results to messages for next iteration
        messages.push({ role: 'assistant', content: currentContent });
        messages.push({ role: 'user', content: toolResults });
      }
    });

  } finally {
    decrementConcurrent(agentName);
  }
}
