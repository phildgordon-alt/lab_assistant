const m = require('mysql2/promise');
(async () => {
  const c = await m.createConnection({ host: '192.168.0.155', port: 3306, user: 'root', password: 'schneider', database: 'som_lms' });
  const [tables] = await c.query('SHOW TABLES');
  console.log('Tables:', tables.map(r => Object.values(r)[0]).join(', '));

  // Check for lens/count data in likely tables
  for (const t of tables) {
    const name = Object.values(t)[0];
    if (/oee|count|lens|hour|hist|log|stat/i.test(name)) {
      try {
        const [cols] = await c.query(`DESCRIBE ${name}`);
        console.log(`\n${name}:`, cols.map(c => c.Field).join(', '));
        const [sample] = await c.query(`SELECT * FROM ${name} LIMIT 2`);
        if (sample.length > 0) console.log('  Sample:', JSON.stringify(sample[0]).substring(0, 200));
        else console.log('  (empty)');
      } catch (e) { console.log(`  Error: ${e.message}`); }
    }
  }
  await c.end();
})();
