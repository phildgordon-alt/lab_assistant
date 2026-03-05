// Simple test script to check gateway startup
console.log('Test starting...');

try {
  console.log('1. Loading db/client...');
  const db = await import('./db/client.js');
  console.log('   DB loaded:', Object.keys(db));

  console.log('2. Loading circuit-breaker...');
  const cb = await import('./circuit-breaker.js');
  console.log('   Circuit breaker loaded');

  console.log('3. Loading logger...');
  const logger = await import('./logger.js');
  console.log('   Logger loaded');

  console.log('4. Loading limiter...');
  const limiter = await import('./limiter.js');
  console.log('   Limiter loaded');

  console.log('5. Loading MCP server...');
  const mcp = await import('./mcp/server.js');
  console.log('   MCP server loaded');

  console.log('All modules loaded successfully!');
} catch (err) {
  console.error('Error loading modules:', err);
}
