/**
 * Rate Limiter
 * Per-user and per-source rate limiting with configurable limits
 */

import { Request, Response, NextFunction } from 'express';
import { recordRateHit, getRateCount } from './db/client.js';
import { log } from './logger.js';

// Rate limit configuration per source (mutable for runtime config)
let RATE_LIMITS = {
  slack: {
    perUser: { requests: 10, windowMs: 60_000 },      // 10/min per user
    global:  { requests: 60, windowMs: 60_000 },      // 60/min total
  },
  web: {
    perUser: { requests: 30, windowMs: 60_000 },      // 30/min per user
    global:  { requests: 200, windowMs: 60_000 },     // 200/min total
  },
  rest: {
    perApiKey: { requests: 100, windowMs: 60_000 },   // 100/min per API key
    global:    { requests: 500, windowMs: 60_000 },   // 500/min total
  },
  perAgent: {
    MaintenanceAgent: { concurrent: 5 },
    default:          { concurrent: 20 },
  } as Record<string, { concurrent: number }>,
};

/**
 * Get current rate limit configuration
 */
export function getRateLimits() {
  return JSON.parse(JSON.stringify(RATE_LIMITS));
}

/**
 * Update rate limit configuration
 */
export function updateRateLimits(updates: Partial<typeof RATE_LIMITS>): void {
  if (updates.slack) RATE_LIMITS.slack = { ...RATE_LIMITS.slack, ...updates.slack };
  if (updates.web) RATE_LIMITS.web = { ...RATE_LIMITS.web, ...updates.web };
  if (updates.rest) RATE_LIMITS.rest = { ...RATE_LIMITS.rest, ...updates.rest };
  if (updates.perAgent) RATE_LIMITS.perAgent = { ...RATE_LIMITS.perAgent, ...updates.perAgent };
  log.info('Rate limits updated', RATE_LIMITS);
}

// In-memory concurrent request tracking
const concurrentRequests: Record<string, number> = {};

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetMs: number;
  reason?: string;
}

/**
 * Check if a request should be rate limited
 */
export async function checkRateLimit(
  source: 'slack' | 'web' | 'rest',
  identifier: string,
  agentName?: string
): Promise<RateLimitResult> {
  const config = RATE_LIMITS[source];
  const windowMs = 'perUser' in config ? config.perUser.windowMs : config.perApiKey.windowMs;
  const maxRequests = 'perUser' in config ? config.perUser.requests : config.perApiKey.requests;

  // Check per-user/per-key limit
  const userKey = `${source}:${identifier}`;
  const userCount = await getRateCount(userKey, windowMs);

  if (userCount >= maxRequests) {
    log.warn(`Rate limited: ${userKey} (${userCount}/${maxRequests})`);
    return {
      allowed: false,
      remaining: 0,
      resetMs: windowMs,
      reason: `Rate limit exceeded. Try again in ${Math.ceil(windowMs / 1000)} seconds.`,
    };
  }

  // Check global limit
  const globalKey = `${source}:global`;
  const globalCount = await getRateCount(globalKey, config.global.windowMs);

  if (globalCount >= config.global.requests) {
    log.warn(`Global rate limit hit: ${source} (${globalCount}/${config.global.requests})`);
    return {
      allowed: false,
      remaining: 0,
      resetMs: config.global.windowMs,
      reason: 'System is busy. Please try again shortly.',
    };
  }

  // Check agent concurrent limit
  if (agentName) {
    const agentConfig = RATE_LIMITS.perAgent[agentName as keyof typeof RATE_LIMITS.perAgent]
      || RATE_LIMITS.perAgent.default;
    const concurrent = concurrentRequests[agentName] || 0;

    if (concurrent >= agentConfig.concurrent) {
      log.warn(`Agent concurrent limit: ${agentName} (${concurrent}/${agentConfig.concurrent})`);
      return {
        allowed: false,
        remaining: 0,
        resetMs: 5000,
        reason: `${agentName} is busy. Please wait a moment.`,
      };
    }
  }

  // Record the hit
  await recordRateHit(userKey, source);
  await recordRateHit(globalKey, source);

  return {
    allowed: true,
    remaining: maxRequests - userCount - 1,
    resetMs: windowMs,
  };
}

/**
 * Increment concurrent request count for an agent
 */
export function incrementConcurrent(agentName: string): void {
  concurrentRequests[agentName] = (concurrentRequests[agentName] || 0) + 1;
}

/**
 * Decrement concurrent request count for an agent
 */
export function decrementConcurrent(agentName: string): void {
  if (concurrentRequests[agentName]) {
    concurrentRequests[agentName]--;
    if (concurrentRequests[agentName] <= 0) {
      delete concurrentRequests[agentName];
    }
  }
}

/**
 * Get current concurrent counts (for monitoring)
 */
export function getConcurrentCounts(): Record<string, number> {
  return { ...concurrentRequests };
}

/**
 * Express middleware for REST rate limiting
 */
export function rateLimitMiddleware(source: 'slack' | 'web' | 'rest') {
  return async (req: Request, res: Response, next: NextFunction) => {
    const identifier = req.headers['x-api-key'] as string
      || req.headers.authorization?.replace('Bearer ', '')
      || req.ip
      || 'unknown';

    const result = await checkRateLimit(source, identifier);

    if (!result.allowed) {
      res.status(429).json({
        error: 'rate_limited',
        message: result.reason,
        retry_after_ms: result.resetMs,
      });
      return;
    }

    // Add rate limit headers
    res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
    res.setHeader('X-RateLimit-Reset', (Date.now() + result.resetMs).toString());

    next();
  };
}
