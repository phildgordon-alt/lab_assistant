/**
 * REST Source Handler
 * External API endpoint with JWT authentication
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { checkRateLimit } from '../limiter.js';
import { isCircuitOpen } from '../circuit-breaker.js';
import { startLog, completeLog, errorLog, log } from '../logger.js';
import { classifyIntent } from '../agents/classifier.js';
import { runAgent } from '../agents/runner.js';

const router = Router();

// JWT verification middleware
function verifyJwt(req: Request, res: Response, next: () => void): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid Authorization header' });
    return;
  }

  const token = authHeader.substring(7);
  const secret = process.env.JWT_SECRET;

  if (!secret) {
    log.error('JWT_SECRET not configured');
    res.status(500).json({ error: 'server_error', message: 'Authentication not configured' });
    return;
  }

  try {
    const decoded = jwt.verify(token, secret) as { sub: string; [key: string]: unknown };
    (req as AuthenticatedRequest).userId = decoded.sub;
    next();
  } catch (error) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid or expired token' });
  }
}

interface AuthenticatedRequest extends Request {
  userId?: string;
}

/**
 * POST /api/ask
 * Main query endpoint for external REST clients
 *
 * Request body:
 * {
 *   "question": "What's the shift summary?",
 *   "agent": "ShiftReportAgent"  // optional
 * }
 *
 * Response:
 * {
 *   "agent": "ShiftReportAgent",
 *   "response": "...",
 *   "duration_ms": 1234
 * }
 */
router.post('/ask', verifyJwt, async (req: Request, res: Response) => {
  const { question, agent } = req.body;
  const userId = (req as AuthenticatedRequest).userId || 'unknown';

  if (!question || typeof question !== 'string') {
    res.status(400).json({
      error: 'bad_request',
      message: 'Missing required field: question',
    });
    return;
  }

  // Check rate limit
  const rateResult = await checkRateLimit('rest', userId);
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
      message: 'Lab Assistant API is currently unavailable. Please try again later.',
    });
    return;
  }

  // Select agent
  const agentName = agent || classifyIntent(question);

  // Start logging
  const logCtx = await startLog('rest', agentName, userId, question);

  try {
    // Run the agent
    const result = await runAgent(agentName, question, userId, 'rest');

    // Log success
    const durationMs = Date.now() - logCtx.startTime;
    await completeLog(logCtx, result.response);

    res.json({
      agent: agentName,
      response: result.response,
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

/**
 * GET /api/agents
 * List available agents - pulls from MCP registry for consistency
 */
router.get('/agents', async (_req: Request, res: Response) => {
  try {
    // Import dynamically to avoid circular dependencies
    const { getAllAgentConfigs } = await import('../mcp/server.js');
    const agentConfigs = getAllAgentConfigs();

    // Return simplified agent list with name and description
    const agents = agentConfigs.map(config => ({
      name: config.name,
      description: config.description,
      department: config.department,
      toolCount: config.tools.length,
    }));

    res.json({ agents, count: agents.length });
  } catch (error: any) {
    log.error('Failed to get agents:', error);
    res.status(500).json({ error: 'server_error', message: error.message });
  }
});

/**
 * POST /api/token
 * Generate a JWT token (for testing/internal use)
 * Requires API key authentication
 */
router.post('/token', (req: Request, res: Response) => {
  const apiKey = req.headers['x-api-key'];

  if (apiKey !== process.env.LAB_ASSISTANT_API_KEY) {
    res.status(401).json({ error: 'unauthorized', message: 'Invalid API key' });
    return;
  }

  const { sub, expiresIn = '24h' } = req.body;

  if (!sub) {
    res.status(400).json({ error: 'bad_request', message: 'Missing required field: sub' });
    return;
  }

  const secret = process.env.JWT_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'server_error', message: 'JWT not configured' });
    return;
  }

  const token = jwt.sign({ sub }, secret, { expiresIn });
  res.json({ token, expires_in: expiresIn });
});

export function initRestRouter(): Router {
  log.info('REST API initialized');
  return router;
}
