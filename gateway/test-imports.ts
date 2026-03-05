// Test imports one by one
console.log('[1] Starting import test...');

console.log('[2] Importing dotenv...');
import 'dotenv/config';

console.log('[3] Importing express...');
import express from 'express';

console.log('[4] Importing cors...');
import cors from 'cors';

console.log('[5] Importing better-sqlite3...');
import Database from 'better-sqlite3';

console.log('[6] Importing circuit-breaker...');
import { initCircuitBreaker } from './circuit-breaker.js';

console.log('[7] Importing logger...');
import { log } from './logger.js';

console.log('[8] Importing db/client...');
import { healthCheck } from './db/client.js';

console.log('[9] Importing limiter...');
import { getConcurrentCounts } from './limiter.js';

console.log('[10] Importing slack source...');
import { initSlack } from './sources/slack.js';

console.log('[11] Importing rest source...');
import { initRestRouter } from './sources/rest.js';

console.log('[12] Importing web source...');
import { initWebRouter } from './sources/web.js';

console.log('[13] Importing runner...');
import { getAgentPromptInfo } from './agents/runner.js';

console.log('[14] Importing mcp/server...');
import { getAllToolDefinitions } from './mcp/server.js';

console.log('=== ALL IMPORTS COMPLETED ===');

// Try creating app
console.log('[15] Creating express app...');
const app = express();
console.log('[16] Express app created!');

// Try listening
console.log('[17] Starting server on port 3001...');
app.listen(3001, () => {
  console.log('[18] SERVER IS LISTENING ON PORT 3001!');
});
