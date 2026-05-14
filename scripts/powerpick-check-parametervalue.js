#!/usr/bin/env node
// Phil 2026-05-13 — last Power Pick stone: ParameterValue (1037 rows).
// Kardex's user-defined parameters live here. If BC is anywhere in
// Power Pick, this is the only place left.

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');

(async () => {
  const pool = await sql.connect({
    server: process.env.POWERPICK_HOST, port: parseInt(process.env.POWERPICK_PORT || '1433', 10),
    database: process.env.POWERPICK_DATABASE, user: process.env.POWERPICK_USER, password: process.env.POWERPICK_PASSWORD,
    options: { encrypt: (process.env.POWERPICK_ENCRYPT || 'false').toLowerCase() === 'true', trustServerCertificate: true },
    requestTimeout: 60000,
  });

  console.log('━'.repeat(72));
  console.log('Power Pick ParameterValue / ParameterTable / ParameterGroup probe');
  console.log('━'.repeat(72));

  for (const tbl of ['ParameterGroup', 'ParameterTable', 'Parametervalue', 'Supplement', 'UserTable', 'Storageunit']) {
    console.log(`\n## dbo.${tbl}\n`);
    const cols = await pool.request().query(`
      SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = '${tbl}' AND table_schema = 'dbo'
      ORDER BY ordinal_position
    `);
    console.log(`  columns: ${cols.recordset.map(c => `${c.column_name}(${c.data_type})`).join(', ')}`);
    const rows = await pool.request().query(`SELECT TOP 15 * FROM dbo.${tbl}`);
    console.log(`  rows shown: ${rows.recordset.length}`);
    for (const r of rows.recordset) {
      const compact = {};
      for (const [k, v] of Object.entries(r)) {
        if (v !== null && v !== '') compact[k] = String(v).slice(0, 60);
      }
      console.log(' ', JSON.stringify(compact));
    }
  }

  // Targeted: any ParameterValue row that mentions BC / curve / our test SKU
  console.log('\n## ParameterValue rows mentioning BC / curve / SKU 0620411082\n');
  try {
    const hits = await pool.request().query(`
      SELECT TOP 30 *
      FROM dbo.Parametervalue
      WHERE CAST(* AS nvarchar(max)) LIKE '%curve%'
         OR CAST(* AS nvarchar(max)) LIKE '%BC%'
         OR CAST(* AS nvarchar(max)) LIKE '%0620411082%'
    `);
    for (const r of hits.recordset) console.log(' ', JSON.stringify(r));
  } catch (e) {
    console.log(`  (CAST trick failed: ${e.message} — falling back to per-text-column scan)`);
    const cols = await pool.request().query(`
      SELECT column_name FROM information_schema.columns
      WHERE table_name = 'Parametervalue' AND table_schema = 'dbo'
        AND data_type IN ('nvarchar','varchar','text','ntext')
    `);
    for (const c of cols.recordset) {
      const cn = c.column_name;
      const hits = await pool.request().query(`
        SELECT TOP 5 * FROM dbo.Parametervalue
        WHERE ${cn} LIKE '%curve%' OR ${cn} LIKE '%BC%' OR ${cn} LIKE '%0620411082%'
      `).catch(() => null);
      if (hits && hits.recordset.length > 0) {
        console.log(`  --- matches in column ${cn} ---`);
        for (const r of hits.recordset) console.log(' ', JSON.stringify(r));
      }
    }
  }

  console.log('\n━'.repeat(72));
  await pool.close();
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
