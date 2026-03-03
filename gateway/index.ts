/**
 * Lab Assistant Agentic Gateway
 * Main Express server that mounts all source handlers
 */

import 'dotenv/config';
import express, { Request, Response } from 'express';
import cors from 'cors';
import { initCircuitBreaker, getState as getCircuitState, forceHealthCheck } from './circuit-breaker.js';
import { requestTimingMiddleware, log } from './logger.js';
import { getRecentRequests, getRequestStats, healthCheck as dbHealthCheck } from './db/client.js';
import { getConcurrentCounts, getRateLimits, updateRateLimits } from './limiter.js';
import { initSlack, startSlack } from './sources/slack.js';
import { initRestRouter } from './sources/rest.js';
import { initWebRouter } from './sources/web.js';
import { getAgentPromptInfo } from './agents/runner.js';

const app = express();
const PORT = parseInt(process.env.PORT || '3001', 10);

// ─────────────────────────────────────────────────────────────────────────────
// Middleware
// ─────────────────────────────────────────────────────────────────────────────

app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  credentials: true,
}));

app.use(express.json());
app.use(requestTimingMiddleware);

// ─────────────────────────────────────────────────────────────────────────────
// Health & Monitoring Endpoints
// ─────────────────────────────────────────────────────────────────────────────

app.get('/health', async (_req: Request, res: Response) => {
  const dbOk = await dbHealthCheck();
  const circuit = await getCircuitState();

  res.json({
    status: dbOk && !circuit.isOpen ? 'healthy' : 'degraded',
    database: dbOk ? 'connected' : 'disconnected',
    circuit_breaker: circuit.status,
    uptime: process.uptime(),
  });
});

// Gateway stats for dashboard
app.get('/gateway/stats/requests', async (req: Request, res: Response) => {
  const since = (req.query.since as string) || '24h';
  const stats = await getRequestStats(since);
  res.json(stats);
});

app.get('/gateway/stats/performance', async (req: Request, res: Response) => {
  const since = (req.query.since as string) || '24h';
  const stats = await getRequestStats(since);
  const concurrent = getConcurrentCounts();

  res.json({
    avg_duration_ms: stats.avg_duration_ms,
    error_rate: stats.by_status['error'] ? stats.by_status['error'] / stats.total : 0,
    rate_limit_hits: stats.by_status['rate_limited'] || 0,
    concurrent_requests: concurrent,
  });
});

app.get('/gateway/health', async (_req: Request, res: Response) => {
  const circuit = await getCircuitState();
  res.json(circuit);
});

app.post('/gateway/health/check', async (_req: Request, res: Response) => {
  const healthy = await forceHealthCheck();
  const circuit = await getCircuitState();
  res.json({ healthy, circuit });
});

app.get('/gateway/requests', async (req: Request, res: Response) => {
  const limit = parseInt(req.query.limit as string) || 50;
  const requests = await getRecentRequests(limit);
  res.json({ requests });
});

app.get('/gateway/agents', async (_req: Request, res: Response) => {
  const agents = getAgentPromptInfo();
  res.json({ agents });
});

// Rate limit configuration endpoints
app.get('/gateway/config/limits', (_req: Request, res: Response) => {
  const limits = getRateLimits();
  res.json(limits);
});

app.post('/gateway/config/limits', (req: Request, res: Response) => {
  try {
    updateRateLimits(req.body);
    res.json({ success: true, limits: getRateLimits() });
  } catch (error) {
    res.status(400).json({ error: 'Invalid configuration', message: String(error) });
  }
});

// Detailed stats endpoint
app.get('/gateway/stats/detailed', async (req: Request, res: Response) => {
  const since = (req.query.since as string) || '24h';
  const stats = await getRequestStats(since);
  const concurrent = getConcurrentCounts();
  const circuit = await getCircuitState();
  const limits = getRateLimits();

  res.json({
    stats,
    concurrent,
    circuit,
    limits,
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Mount Source Routers
// ─────────────────────────────────────────────────────────────────────────────

// REST API endpoints
app.use('/api', initRestRouter());

// Web SSE endpoints
app.use('/web', initWebRouter());

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function start(): Promise<void> {
  log.info('Starting Lab Assistant Agentic Gateway...');

  // Initialize circuit breaker
  await initCircuitBreaker({
    onOpen: () => {
      log.error('Circuit breaker OPENED - Lab Assistant API is unavailable');
      // TODO: Post to Slack #lab-alerts
    },
    onClose: () => {
      log.info('Circuit breaker CLOSED - Lab Assistant API recovered');
      // TODO: Post to Slack #lab-alerts
    },
  });

  // Initialize Slack (if configured)
  const slackApp = initSlack();
  if (slackApp) {
    // Mount Slack events endpoint for HTTP mode
    // app.use('/slack/events', slackApp.receiver.router);
    await startSlack();
  }

  // Start Express server
  app.listen(PORT, () => {
    log.info(`
╔══════════════════════════════════════════════════════════════╗
║          Lab Assistant Agentic Gateway                       ║
╠══════════════════════════════════════════════════════════════╣
║  Local:   http://localhost:${PORT}                              ║
║                                                              ║
║  Endpoints:                                                  ║
║    GET  /health              ← Health check                  ║
║    POST /api/ask             ← REST query (JWT auth)         ║
║    GET  /api/agents          ← List available agents         ║
║    POST /api/token           ← Generate JWT (API key auth)   ║
║    POST /web/ask             ← SSE streaming query           ║
║    POST /web/ask-sync        ← Non-streaming query           ║
║    GET  /gateway/stats/*     ← Usage statistics              ║
║    GET  /gateway/requests    ← Recent request feed           ║
║    GET  /gateway/agents      ← Agent prompt metadata         ║
║    GET  /gateway/health      ← Circuit breaker status        ║
║    POST /gateway/health/check← Force health check            ║
╚══════════════════════════════════════════════════════════════╝
`);
  });
}

start().catch((error) => {
  log.error('Failed to start gateway:', error);
  process.exit(1);
});
