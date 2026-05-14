#!/usr/bin/env node
// Phil 2026-05-13 — Power Pick BC/diameter discovery.
// Inspects every column of Materialbase + extended Materialproperty rows
// for a single SV donor SKU so we can find where base_curve / diameter
// actually live in Kardex.
//
// Usage:  node scripts/powerpick-inspect-sku.js [SKU]
// Default SKU: 0620411082 (one of the 1.74 NPI donor SKUs)

'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const sql = require('mssql');

const HOST     = process.env.POWERPICK_HOST;
const PORT     = parseInt(process.env.POWERPICK_PORT || '1433', 10);
const DATABASE = process.env.POWERPICK_DATABASE;
const USER     = process.env.POWERPICK_USER;
const PASSWORD = process.env.POWERPICK_PASSWORD;
const ENCRYPT  = (process.env.POWERPICK_ENCRYPT || 'false').toLowerCase() === 'true';

const SKU = process.argv[2] || '0620411082';

if (!HOST || !DATABASE || !USER || !PASSWORD) {
  console.error('Missing POWERPICK_* env vars. Need: POWERPICK_HOST, POWERPICK_DATABASE, POWERPICK_USER, POWERPICK_PASSWORD');
  process.exit(1);
}

(async () => {
  const pool = await sql.connect({
    server: HOST, port: PORT, database: DATABASE,
    user: USER, password: PASSWORD,
    options: { encrypt: ENCRYPT, trustServerCertificate: true },
    requestTimeout: 30000,
  });

  console.log('━'.repeat(72));
  console.log(`Power Pick SKU inspection: ${SKU}`);
  console.log(`db: ${DATABASE}@${HOST}:${PORT}`);
  console.log('━'.repeat(72));

  // 1) Full Materialbase row
  console.log('\n## dbo.Materialbase row\n');
  const mbRes = await pool.request()
    .input('sku', sql.NVarChar, SKU)
    .query(`SELECT TOP 1 * FROM dbo.Materialbase WHERE MaterialName = @sku`);
  if (mbRes.recordset.length === 0) {
    console.log(`(no row found for MaterialName = '${SKU}')`);
  } else {
    for (const [k, v] of Object.entries(mbRes.recordset[0])) {
      console.log(`  ${k.padEnd(28)} = ${v === null ? 'NULL' : String(v)}`);
    }
  }

  // 2) Materialproperty — schema for extended attributes
  console.log('\n## dbo.Materialproperty (8 rows total — schema for extended attributes)\n');
  const mpCols = await pool.request().query(`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'Materialproperty' AND table_schema = 'dbo'
    ORDER BY ordinal_position
  `);
  console.log(`  columns: ${mpCols.recordset.map(c => c.column_name).join(', ')}`);
  const mpRes = await pool.request().query(`SELECT * FROM dbo.Materialproperty`);
  for (const row of mpRes.recordset) {
    console.log('  ---');
    for (const [k, v] of Object.entries(row)) {
      if (v !== null && v !== '') console.log(`    ${k.padEnd(28)} = ${String(v).slice(0, 80)}`);
    }
  }

  // 3) Any join from Materialbase → property values for this SKU
  console.log('\n## Property values for this SKU (via PublicMaterialpropertyId / PrivateMaterialpropertyId)\n');
  const mbProp = await pool.request()
    .input('sku', sql.NVarChar, SKU)
    .query(`
      SELECT
        mb.MaterialName,
        pub.* AS PublicProperty,
        prv.* AS PrivateProperty
      FROM dbo.Materialbase mb
      LEFT JOIN dbo.Materialproperty pub ON pub.MaterialpropertyId = mb.PublicMaterialpropertyId
      LEFT JOIN dbo.Materialproperty prv ON prv.MaterialpropertyId = mb.PrivateMaterialpropertyId
      WHERE mb.MaterialName = @sku
    `).catch(e => ({ recordset: [], error: e.message }));
  if (mbProp.error) {
    console.log(`  (join failed: ${mbProp.error} — trying separate property fetches)`);
    const mb = mbRes.recordset[0];
    if (mb && mb.PublicMaterialpropertyId) {
      const pub = await pool.request()
        .input('id', sql.UniqueIdentifier, mb.PublicMaterialpropertyId)
        .query(`SELECT * FROM dbo.Materialproperty WHERE MaterialpropertyId = @id`);
      console.log('  --- Public property ---');
      for (const [k, v] of Object.entries(pub.recordset[0] || {})) {
        if (v !== null && v !== '') console.log(`    ${k.padEnd(28)} = ${String(v).slice(0, 80)}`);
      }
    }
    if (mb && mb.PrivateMaterialpropertyId) {
      const prv = await pool.request()
        .input('id', sql.UniqueIdentifier, mb.PrivateMaterialpropertyId)
        .query(`SELECT * FROM dbo.Materialproperty WHERE MaterialpropertyId = @id`);
      console.log('  --- Private property ---');
      for (const [k, v] of Object.entries(prv.recordset[0] || {})) {
        if (v !== null && v !== '') console.log(`    ${k.padEnd(28)} = ${String(v).slice(0, 80)}`);
      }
    }
  } else {
    for (const row of mbProp.recordset) {
      for (const [k, v] of Object.entries(row)) {
        if (v !== null && v !== '') console.log(`    ${k.padEnd(28)} = ${String(v).slice(0, 80)}`);
      }
    }
  }

  // 4) List ALL tables — see if there's a base_curve / diameter / spec table we missed
  console.log('\n## Tables in Power Pick db with "curve", "diameter", "spec", or "attribute" in the name\n');
  const tblRes = await pool.request().query(`
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_type = 'BASE TABLE'
      AND (table_name LIKE '%urve%' OR table_name LIKE '%iameter%' OR table_name LIKE '%pec%'
        OR table_name LIKE '%ttribute%' OR table_name LIKE '%ase%')
    ORDER BY table_name
  `);
  for (const r of tblRes.recordset) console.log(`  ${r.table_schema}.${r.table_name}`);

  console.log('\n━'.repeat(72));
  await pool.close();
})().catch(err => {
  console.error('FATAL:', err.message);
  process.exit(1);
});
