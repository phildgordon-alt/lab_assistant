/**
 * Request Logger Middleware
 * Logs all gateway requests to Postgres with timing and response data
 */

import { Request, Response, NextFunction } from 'express';
import { logRequest, updateRequestResponse, markRequestError } from './db/client.js';

export interface LogContext {
  requestId: string;
  startTime: number;
  source: 'slack' | 'web' | 'rest';
  agentName: string;
  userId: string | null;
  inputText: string;
}

// Extend Express Request to include log context
declare global {
  namespace Express {
    interface Request {
      logCtx?: LogContext;
    }
  }
}

/**
 * Start logging a request - call at the beginning of request handling
 */
export async function startLog(
  source: 'slack' | 'web' | 'rest',
  agentName: string,
  userId: string | null,
  inputText: string
): Promise<LogContext> {
  const requestId = await logRequest({
    source,
    agent_name: agentName,
    user_id: userId,
    input_text: inputText,
    response_text: null,
    status: 'success', // Will be updated on completion
    duration_ms: null,
    error_message: null,
  });

  return {
    requestId,
    startTime: Date.now(),
    source,
    agentName,
    userId,
    inputText,
  };
}

/**
 * Complete logging a successful request
 */
export async function completeLog(ctx: LogContext, responseText: string): Promise<void> {
  const duration = Date.now() - ctx.startTime;
  await updateRequestResponse(ctx.requestId, responseText, duration);
  console.log(`[Gateway] ✓ ${ctx.source}/${ctx.agentName} (${duration}ms) - ${ctx.userId || 'anonymous'}`);
}

/**
 * Log an error for a request
 */
export async function errorLog(ctx: LogContext, error: string): Promise<void> {
  const duration = Date.now() - ctx.startTime;
  await markRequestError(ctx.requestId, error, duration);
  console.error(`[Gateway] ✗ ${ctx.source}/${ctx.agentName} (${duration}ms) - ${error}`);
}

/**
 * Express middleware that attaches timing info to requests
 */
export function requestTimingMiddleware(req: Request, res: Response, next: NextFunction): void {
  const startTime = Date.now();

  res.on('finish', () => {
    const duration = Date.now() - startTime;
    const status = res.statusCode;
    const method = req.method;
    const path = req.path;

    if (status >= 400) {
      console.log(`[HTTP] ${method} ${path} → ${status} (${duration}ms)`);
    }
  });

  next();
}

/**
 * Simple console logger for non-DB events
 */
export const log = {
  info: (msg: string, ...args: unknown[]) => console.log(`[Gateway] ${msg}`, ...args),
  warn: (msg: string, ...args: unknown[]) => console.warn(`[Gateway] ⚠ ${msg}`, ...args),
  error: (msg: string, ...args: unknown[]) => console.error(`[Gateway] ✗ ${msg}`, ...args),
  debug: (msg: string, ...args: unknown[]) => {
    if (process.env.NODE_ENV !== 'production') {
      console.log(`[Gateway] 🔍 ${msg}`, ...args);
    }
  },
};
