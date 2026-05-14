#!/usr/bin/env node
// Phil 2026-05-13 — find BASE CURVE anywhere in Power Pick.
// Searches every column of every table for names matching BC patterns,
// then samples rows for any match found. Also does a grep-style scan
// of Info1-5 across Materialbase to see if any SKUs put BC there.

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');

const HOST     = process.env.POWERPICK_HOST;
const PORT     = parseInt(process.env.POWERPICK_PORT || '1433', 10);
const DATABASE = process.env.POWERPICK_DATABASE;
const USER     = process.env.POWERPICK_USER;
const PASSWORD = process.env.POWERPICK_PASSWORD;
const ENCRYPT  = (process.env.POWERPICK_ENCRYPT || 'false').toLowerCase() === 'true';

(async () => {
  const pool = await sql.connect({
    server: HOST, port: PORT, database: DATABASE,
    user: USER, password: PASSWORD,
    options: { encrypt: ENCRYPT, trustServerCertificate: true },
    requestTimeout: 60000,
  });

  console.log('━'.repeat(72));
  console.log(`Power Pick BC search — ${DATABASE}@${HOST}:${PORT}`);
  console.log('━'.repeat(72));

  // 1) Every column whose NAME matches BC patterns
  console.log('\n## Columns with BC-like names\n');
  const colRes = await pool.request().query(`
    SELECT table_schema, table_name, column_name, data_type
    FROM information_schema.columns
    WHERE lower(column_name) LIKE '%curve%'
       OR lower(column_name) LIKE '%basec%'
       OR lower(column_name) LIKE '%base_c%'
       OR column_name = 'BC'
       OR lower(column_name) LIKE 'bc[_-]%'
       OR lower(column_name) LIKE '%diam%'
       OR lower(column_name) LIKE '%spec%'
       OR lower(column_name) LIKE '%attr%'
       OR lower(column_name) LIKE '%lens%'
    ORDER BY table_name, column_name
  `);
  if (colRes.recordset.length === 0) {
    console.log('  (no matching columns anywhere in the database)');
  } else {
    for (const r of colRes.recordset) {
      console.log(`  ${r.table_schema}.${r.table_name}.${r.column_name}  (${r.data_type})`);
    }
  }

  // 2) Distinct Info1-5 patterns across Materialbase to spot BC encoding
  console.log('\n## Info3 patterns across all Materialbase rows (top 30 most-common)\n');
  const i3 = await pool.request().query(`
    SELECT TOP 30 Info3, COUNT(*) AS n
    FROM dbo.Materialbase
    WHERE Info3 IS NOT NULL
    GROUP BY Info3
    ORDER BY COUNT(*) DESC
  `);
  for (const r of i3.recordset) console.log(`  ${String(r.Info3).padEnd(30)} ${r.n}`);

  console.log('\n## Info5 patterns (top 30) — possibly carries BC for some SKUs\n');
  const i5 = await pool.request().query(`
    SELECT TOP 30 Info5, COUNT(*) AS n
    FROM dbo.Materialbase
    WHERE Info5 IS NOT NULL
    GROUP BY Info5
    ORDER BY COUNT(*) DESC
  `);
  for (const r of i5.recordset) console.log(`  ${String(r.Info5).padEnd(30)} ${r.n}`);

  // 3) Search Info1-5 raw text for anything matching "BC" or curve-like number
  console.log('\n## SV donor SKUs where Info5 OR Blockreason contains BC text or a 0-9 BC range\n');
  const svBc = await pool.request().query(`
    SELECT TOP 20 MaterialName, Info1, Info2, Info3, Info4, Info5
    FROM dbo.Materialbase
    WHERE Info1 LIKE '%SV%'
      AND (Info5 LIKE '%BC%' OR Info5 LIKE '%curve%'
        OR Info4 LIKE '%BC%' OR Info4 LIKE '%curve%')
  `);
  if (svBc.recordset.length === 0) {
    console.log('  (no SV SKUs have BC mention in any Info field)');
  } else {
    for (const r of svBc.recordset) {
      console.log(`  ${r.MaterialName}  Info1=${r.Info1}  Info2=${r.Info2}  Info3=${r.Info3}  Info4=${r.Info4}  Info5=${r.Info5}`);
    }
  }

  // 4) Materialcode + Materialfamily + MaterialbaseToSupplement — small tables
  console.log('\n## dbo.Materialcode (4 cols)\n');
  const mc = await pool.request().query(`SELECT TOP 20 * FROM dbo.Materialcode`);
  console.log(`  rows: ${mc.recordset.length}`);
  for (const r of mc.recordset) console.log(' ', JSON.stringify(r));

  console.log('\n## dbo.Materialfamily (8 cols)\n');
  const mf = await pool.request().query(`SELECT TOP 20 * FROM dbo.Materialfamily`);
  console.log(`  rows: ${mf.recordset.length}`);
  for (const r of mf.recordset) console.log(' ', JSON.stringify(r));

  console.log('\n## dbo.MaterialbaseToSupplement (3 cols)\n');
  const ms = await pool.request().query(`SELECT TOP 20 * FROM dbo.MaterialbaseToSupplement`);
  console.log(`  rows: ${ms.recordset.length}`);
  for (const r of ms.recordset) console.log(' ', JSON.stringify(r));

  // 5) Brute force — list all tables we haven't peeked at
  console.log('\n## All user tables in Power Pick db\n');
  const tbls = await pool.request().query(`
    SELECT t.name AS table_name, p.rows
    FROM sys.tables t
    JOIN sys.partitions p ON p.object_id = t.object_id AND p.index_id IN (0,1)
    ORDER BY p.rows DESC
  `);
  for (const r of tbls.recordset) console.log(`  ${String(r.table_name).padEnd(40)} ${r.rows}`);

  console.log('\n━'.repeat(72));
  await pool.close();
})().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
