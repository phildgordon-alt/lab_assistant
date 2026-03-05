console.log('[1] Starting...');
import Database from 'better-sqlite3';
console.log('[2] better-sqlite3 imported');
const db = new Database(':memory:');
console.log('[3] In-memory database created');
db.exec('SELECT 1');
console.log('[4] Query executed');
console.log('[5] SUCCESS');
process.exit(0);
