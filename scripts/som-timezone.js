const m = require('mysql2/promise');
(async () => {
  const c = await m.createConnection({ host: '192.168.0.155', port: 3306, user: 'root', password: 'schneider', database: 'som_lms' });
  const [tz] = await c.query("SELECT @@global.time_zone, @@session.time_zone, NOW() as server_now, UTC_TIMESTAMP() as utc_now");
  console.log(tz[0]);
  await c.end();
})();
