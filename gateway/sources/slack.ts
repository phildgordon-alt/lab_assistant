/**
 * Slack Source Handler
 * Handles /lab slash commands and @LabAssistant mentions
 *
 * NOTE: Uses lazy loading for @slack/bolt to prevent import hang
 */

import { checkRateLimit } from '../limiter.js';
import { isCircuitOpen } from '../circuit-breaker.js';
import { startLog, completeLog, errorLog, log } from '../logger.js';
import { classifyIntent } from '../agents/classifier.js';
import { runAgent } from '../agents/runner.js';

// Lazy-loaded Slack types and app
type App = import('@slack/bolt').App;
let slackApp: App | null = null;
let slackInitialized = false;

/**
 * Initialize Slack Bolt app (lazy-loads @slack/bolt)
 */
export async function initSlack(): Promise<App | null> {
  if (slackInitialized) {
    return slackApp;
  }
  slackInitialized = true;

  const token = process.env.SLACK_BOT_TOKEN;
  const signingSecret = process.env.SLACK_SIGNING_SECRET;
  const appToken = process.env.SLACK_APP_TOKEN;

  if (!token || !signingSecret) {
    log.warn('Slack disabled — missing SLACK_BOT_TOKEN or SLACK_SIGNING_SECRET');
    return null;
  }

  try {
    // Dynamically import @slack/bolt to prevent blocking on module load
    const { App, LogLevel } = await import('@slack/bolt');

    slackApp = new App({
      token,
      signingSecret,
      appToken,
      socketMode: !!appToken,
      logLevel: LogLevel.WARN,
    });

    // Register handlers
    registerSlashCommand(slackApp);
    registerMention(slackApp);

    log.info('Slack integration initialized');
    return slackApp;
  } catch (error) {
    log.error('Failed to initialize Slack:', error);
    return null;
  }
}

/**
 * Handle /lab slash command
 * Usage: /lab [agent-hint] question
 * Examples:
 *   /lab coding how's yield on AR?
 *   /lab what's the shift summary?
 */
function registerSlashCommand(app: App): void {
  app.command('/lab', async ({ command, ack, respond }) => {
    await ack();

    const userId = command.user_id;
    const text = command.text.trim();

    if (!text) {
      await respond({
        response_type: 'ephemeral',
        text: '❓ Usage: `/lab [question]`\n\nExamples:\n• `/lab what\'s the shift summary?`\n• `/lab coding how\'s yield on AR?`\n• `/lab maintenance any machines down?`',
      });
      return;
    }

    await handleSlackQuery(userId, text, respond);
  });
}

/**
 * Handle @LabAssistant mentions
 */
function registerMention(app: App): void {
  app.event('app_mention', async ({ event, say }) => {
    const userId = event.user || 'unknown';
    // Remove the bot mention from the text
    const text = event.text.replace(/<@[A-Z0-9]+>/g, '').trim();

    if (!text) {
      await say({
        thread_ts: event.ts,
        text: '👋 How can I help? Just ask me a question about the lab.',
      });
      return;
    }

    await handleSlackQuery(userId, text, async (response) => {
      const formatted = formatSlackResponse(response);
      await say({
        thread_ts: event.ts,
        text: formatted.text || 'Response from Lab Assistant',
        blocks: formatted.blocks as any,
      });
    });
  });
}

/**
 * Core handler for Slack queries
 */
async function handleSlackQuery(
  userId: string,
  text: string,
  respond: (response: SlackResponse) => Promise<void>
): Promise<void> {
  // Parse optional agent hint from first word
  const parts = text.split(/\s+/);
  let agentHint: string | undefined;
  let question = text;

  const possibleHints = ['lab', 'coding', 'picking', 'surfacing', 'cutting', 'assembly', 'maintenance', 'shift', 'devops', 'qc'];
  if (parts.length > 1 && possibleHints.includes(parts[0].toLowerCase())) {
    agentHint = parts[0].toLowerCase();
    question = parts.slice(1).join(' ');
  }

  // Check rate limit
  const rateResult = await checkRateLimit('slack', userId);
  if (!rateResult.allowed) {
    await respond({
      response_type: 'ephemeral',
      text: `⏳ ${rateResult.reason}`,
    });
    return;
  }

  // Check circuit breaker
  if (await isCircuitOpen()) {
    await respond({
      response_type: 'ephemeral',
      text: '⚠️ Lab Assistant is currently unavailable. The team has been notified.',
    });
    return;
  }

  // Classify intent and select agent
  const agentName = agentHint
    ? `${agentHint.charAt(0).toUpperCase()}${agentHint.slice(1)}Agent`
    : classifyIntent(question);

  // Start logging
  const logCtx = await startLog('slack', agentName, userId, question);

  try {
    // Show typing indicator
    await respond({
      response_type: 'ephemeral',
      text: `🔍 *${agentName}* is thinking...`,
    });

    // Run the agent
    const result = await runAgent(agentName, question, userId, 'slack');

    // Log success
    await completeLog(logCtx, result.response);

    // Send response
    await respond(formatSlackResponse({
      agentName,
      response: result.response,
      durationMs: Date.now() - logCtx.startTime,
    }));

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await errorLog(logCtx, errorMessage);

    await respond({
      response_type: 'ephemeral',
      text: `❌ Something went wrong. Try rephrasing your question.\n\n_Error: ${errorMessage}_`,
    });
  }
}

interface SlackResponse {
  response_type?: 'ephemeral' | 'in_channel';
  text?: string;
  blocks?: unknown[];
}

interface AgentResponse {
  agentName: string;
  response: string;
  durationMs: number;
}

/**
 * Format agent response for Slack
 */
function formatSlackResponse(result: AgentResponse | SlackResponse): SlackResponse {
  if ('blocks' in result || !('agentName' in result)) {
    return result as SlackResponse;
  }

  const { agentName, response, durationMs } = result;
  const durationSec = (durationMs / 1000).toFixed(1);

  // Short responses: simple text
  if (response.length < 300) {
    return {
      response_type: 'in_channel',
      text: `🔬 *${agentName}* | ${durationSec}s\n\n${response}`,
    };
  }

  // Longer responses: use blocks for better formatting
  return {
    response_type: 'in_channel',
    blocks: [
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `🔬 *${agentName}* | ${durationSec}s`,
          },
        ],
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: response.substring(0, 2900), // Slack block limit
        },
      },
    ],
  };
}

/**
 * Start Slack app (for Socket Mode)
 */
export async function startSlack(): Promise<void> {
  if (slackApp && process.env.SLACK_APP_TOKEN) {
    try {
      await slackApp.start();
      log.info('Slack Socket Mode connected');
    } catch (error) {
      log.error('Slack Socket Mode failed to start:', error);
    }
  }
}

/**
 * Get the Slack app instance
 */
export function getSlackApp(): App | null {
  return slackApp;
}
