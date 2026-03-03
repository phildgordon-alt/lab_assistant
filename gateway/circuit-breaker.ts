/**
 * Circuit Breaker
 * Monitors Lab Assistant API health and prevents cascading failures
 */

import { getCircuitState, incrementErrorCount, resetErrorCount, openCircuit, closeCircuit, CircuitState } from './db/client.js';
import { log } from './logger.js';

// Configuration
const CONFIG = {
  errorThreshold: 5,              // Number of errors before opening circuit
  errorWindowMs: 5 * 60 * 1000,   // 5 minute window for counting errors
  healthCheckIntervalMs: 30_000,  // Check health every 30 seconds when open
  halfOpenTimeout: 60_000,        // Try one request after this time when open
};

// In-memory state for faster access
let cachedState: CircuitState | null = null;
let lastStateCheck = 0;
let healthCheckInterval: NodeJS.Timeout | null = null;

// Callbacks
let onCircuitOpen: (() => void) | null = null;
let onCircuitClose: (() => void) | null = null;

/**
 * Initialize the circuit breaker
 */
export async function initCircuitBreaker(options?: {
  onOpen?: () => void;
  onClose?: () => void;
}): Promise<void> {
  if (options?.onOpen) onCircuitOpen = options.onOpen;
  if (options?.onClose) onCircuitClose = options.onClose;

  try {
    cachedState = await getCircuitState();
  } catch (err) {
    log.warn('Failed to load circuit state from DB, using defaults');
    cachedState = {
      is_open: false,
      error_count: 0,
      last_checked_at: new Date(),
      opened_at: null,
      recovered_at: null,
    };
  }
  lastStateCheck = Date.now();

  log.info(`Circuit breaker initialized: ${cachedState.is_open ? 'OPEN' : 'CLOSED'}`);

  // Start health check loop if circuit is open
  if (cachedState.is_open) {
    startHealthCheckLoop();
  }
}

/**
 * Check if the circuit is currently open (blocking requests)
 */
export async function isCircuitOpen(): Promise<boolean> {
  // Refresh state periodically
  if (Date.now() - lastStateCheck > 5000 || !cachedState) {
    cachedState = await getCircuitState();
    lastStateCheck = Date.now();
  }

  return cachedState.is_open;
}

/**
 * Record a successful request (resets error count)
 */
export async function recordSuccess(): Promise<void> {
  if (cachedState?.error_count && cachedState.error_count > 0) {
    await resetErrorCount();
    cachedState = await getCircuitState();
  }

  // If we were open and this succeeded, close the circuit
  if (cachedState?.is_open) {
    log.info('Circuit breaker: Request succeeded, closing circuit');
    await closeCircuit();
    cachedState = await getCircuitState();
    stopHealthCheckLoop();
    onCircuitClose?.();
  }
}

/**
 * Record a failed request
 */
export async function recordFailure(error: string): Promise<void> {
  const errorCount = await incrementErrorCount();
  cachedState = await getCircuitState();

  log.warn(`Circuit breaker: Error recorded (${errorCount}/${CONFIG.errorThreshold}): ${error}`);

  if (errorCount >= CONFIG.errorThreshold && !cachedState.is_open) {
    log.error('Circuit breaker: Threshold exceeded, opening circuit');
    await openCircuit();
    cachedState = await getCircuitState();
    startHealthCheckLoop();
    onCircuitOpen?.();
  }
}

/**
 * Get the current circuit state for monitoring
 */
export async function getState(): Promise<{
  isOpen: boolean;
  errorCount: number;
  lastChecked: Date;
  openedAt: Date | null;
  recoveredAt: Date | null;
  status: 'healthy' | 'degraded' | 'down';
}> {
  const state = await getCircuitState();

  let status: 'healthy' | 'degraded' | 'down' = 'healthy';
  if (state.is_open) {
    status = 'down';
  } else if (state.error_count > 0) {
    status = 'degraded';
  }

  return {
    isOpen: state.is_open,
    errorCount: state.error_count,
    lastChecked: state.last_checked_at,
    openedAt: state.opened_at,
    recoveredAt: state.recovered_at,
    status,
  };
}

/**
 * Force a health check of the Lab Assistant API
 */
export async function forceHealthCheck(): Promise<boolean> {
  const labAssistantUrl = process.env.LAB_ASSISTANT_API_URL || 'http://localhost:3002';

  try {
    const response = await fetch(`${labAssistantUrl}/api/health`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000),
    });

    if (response.ok) {
      log.info('Health check passed');
      await recordSuccess();
      return true;
    } else {
      log.warn(`Health check failed: HTTP ${response.status}`);
      return false;
    }
  } catch (error) {
    log.error(`Health check failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    return false;
  }
}

/**
 * Start periodic health checks when circuit is open
 */
function startHealthCheckLoop(): void {
  if (healthCheckInterval) return;

  healthCheckInterval = setInterval(async () => {
    const healthy = await forceHealthCheck();
    if (healthy) {
      log.info('Circuit breaker: Health restored, closing circuit');
    }
  }, CONFIG.healthCheckIntervalMs);

  log.info('Started health check loop');
}

/**
 * Stop periodic health checks
 */
function stopHealthCheckLoop(): void {
  if (healthCheckInterval) {
    clearInterval(healthCheckInterval);
    healthCheckInterval = null;
    log.info('Stopped health check loop');
  }
}

/**
 * Wrapper to execute a function with circuit breaker protection
 */
export async function withCircuitBreaker<T>(
  fn: () => Promise<T>,
  fallback?: () => T | Promise<T>
): Promise<T> {
  if (await isCircuitOpen()) {
    if (fallback) {
      return fallback();
    }
    throw new Error('Circuit breaker is open. Lab Assistant API is currently unavailable.');
  }

  try {
    const result = await fn();
    await recordSuccess();
    return result;
  } catch (error) {
    await recordFailure(error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

/**
 * Cleanup on shutdown
 */
export function shutdownCircuitBreaker(): void {
  stopHealthCheckLoop();
}
