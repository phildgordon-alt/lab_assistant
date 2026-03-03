/**
 * Web Source Handler
 * SSE streaming endpoint for Lab Assistant React UI
 */

import { Router, Request, Response } from 'express';
import { checkRateLimit } from '../limiter.js';
import { isCircuitOpen } from '../circuit-breaker.js';
import { startLog, completeLog, errorLog, log } from '../logger.js';
import { classifyIntent } from '../agents/classifier.js';
import { runAgentStreaming } from '../agents/runner.js';

const router = Router();

/**
 * POST /web/ask
 * Query endpoint with SSE streaming response
 *
 * Request body:
 * {
 *   "question": "What's the shift summary?",
 *   "agent": "ShiftReportAgent",  // optional
 *   "userId": "phil@pair.com"     // optional
 * }
 *
 * Response: Server-Sent Events stream
 * event: agent
 * data: {"name": "ShiftReportAgent"}
 *
 * event: chunk
 * data: {"text": "The current shift..."}
 *
 * event: done
 * data: {"duration_ms": 1234}
 */
router.post('/ask', async (req: Request, res: Response) => {
  const { question, agent, userId = 'web-anonymous', context } = req.body;

  if (!question || typeof question !== 'string') {
    res.status(400).json({
      error: 'bad_request',
      message: 'Missing required field: question',
    });
    return;
  }

  // Check rate limit
  const rateResult = await checkRateLimit('web', userId);
  if (!rateResult.allowed) {
    res.status(429).json({
      error: 'rate_limited',
      message: rateResult.reason,
      retry_after_ms: rateResult.resetMs,
    });
    return;
  }

  // Check circuit breaker
  if (await isCircuitOpen()) {
    res.status(503).json({
      error: 'service_unavailable',
      message: 'Lab Assistant is currently unavailable. Please try again later.',
    });
    return;
  }

  // Select agent
  const agentName = agent || classifyIntent(question);

  // Start logging
  const logCtx = await startLog('web', agentName, userId, question);

  // Set up SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');

  // Send agent name
  res.write(`event: agent\ndata: ${JSON.stringify({ name: agentName })}\n\n`);

  let fullResponse = '';

  try {
    // Stream the response
    await runAgentStreaming(
      agentName,
      question,
      userId,
      'web',
      (chunk: string) => {
        fullResponse += chunk;
        res.write(`event: chunk\ndata: ${JSON.stringify({ text: chunk })}\n\n`);
      },
      context
    );

    // Log success
    const durationMs = Date.now() - logCtx.startTime;
    await completeLog(logCtx, fullResponse);

    // Send completion event
    res.write(`event: done\ndata: ${JSON.stringify({ duration_ms: durationMs })}\n\n`);
    res.end();

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await errorLog(logCtx, errorMessage);

    res.write(`event: error\ndata: ${JSON.stringify({ message: errorMessage })}\n\n`);
    res.end();
  }
});

/**
 * GET /web/ask (alternative for EventSource clients)
 * Query via GET with query params
 */
router.get('/ask', async (req: Request, res: Response) => {
  const question = req.query.q as string;
  const agent = req.query.agent as string | undefined;
  const userId = (req.query.userId as string) || 'web-anonymous';

  if (!question) {
    res.status(400).json({
      error: 'bad_request',
      message: 'Missing required query param: q',
    });
    return;
  }

  // Forward to POST handler
  req.body = { question, agent, userId };
  return router.handle(req, res, () => {});
});

/**
 * POST /web/ask-sync
 * Non-streaming endpoint for simpler clients
 */
router.post('/ask-sync', async (req: Request, res: Response) => {
  const { question, agent, userId = 'web-anonymous', context } = req.body;

  if (!question || typeof question !== 'string') {
    res.status(400).json({
      error: 'bad_request',
      message: 'Missing required field: question',
    });
    return;
  }

  // Check rate limit
  const rateResult = await checkRateLimit('web', userId);
  if (!rateResult.allowed) {
    res.status(429).json({
      error: 'rate_limited',
      message: rateResult.reason,
      retry_after_ms: rateResult.resetMs,
    });
    return;
  }

  // Check circuit breaker
  if (await isCircuitOpen()) {
    res.status(503).json({
      error: 'service_unavailable',
      message: 'Lab Assistant is currently unavailable.',
    });
    return;
  }

  const agentName = agent || classifyIntent(question);
  const logCtx = await startLog('web', agentName, userId, question);

  try {
    let fullResponse = '';
    await runAgentStreaming(
      agentName,
      question,
      userId,
      'web',
      (chunk: string) => { fullResponse += chunk; },
      context
    );

    const durationMs = Date.now() - logCtx.startTime;
    await completeLog(logCtx, fullResponse);

    res.json({
      agent: agentName,
      response: fullResponse,
      duration_ms: durationMs,
    });

  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    await errorLog(logCtx, errorMessage);

    res.status(500).json({
      error: 'agent_error',
      message: errorMessage,
    });
  }
});

export function initWebRouter(): Router {
  log.info('Web SSE endpoint initialized');
  return router;
}
