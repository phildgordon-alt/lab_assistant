/**
 * Semi-finished SKU seed — material + base_curve per known puck SKU.
 *
 * Source: Phil's Lens_Planning_V3.xlsx Semi_finSkus sheet (2026-04-22).
 * The workbook is NOT imported live — this is a one-time transcription of
 * the static reference data Phil maintains there. Update here when the
 * sheet changes; we do not re-import the file.
 *
 * Used by:
 *   - db.js startup seed (upserts into lens_sku_properties)
 *   - backfill-lens-sku-properties.js (COALESCE over DVI XML aggregation)
 *
 * Fields:
 *   sku (PK), material (PLY/BLY/H67/B67/SPY/S67), base_curve (null OK for
 *   photochromic variants that don't have a BC assigned yet — Phil fills
 *   those in post-hoc in the UI).
 *
 * Material codes:
 *   PLY = Polycarbonate
 *   BLY = Poly Blue Light
 *   H67 = 1.67
 *   B67 = 1.67 Blue Light
 *   SPY = Photochromic Poly
 *   S67 = Photochromic 1.67
 */

'use strict';

const SEMI_FINISHED_SEED = [
  // Semi Poly
  { sku: '4800135412', material: 'PLY', base_curve: 0.5,  description: 'SF PLY BC 0.5' },
  { sku: '4800135420', material: 'PLY', base_curve: 2.5,  description: 'SF PLY BC 2.5' },
  { sku: '4800135438', material: 'PLY', base_curve: 4.5,  description: 'SF PLY BC 4.5' },
  { sku: '4800154660', material: 'PLY', base_curve: 5.25, description: 'SF PLY BC 5.25' },
  // Semi Poly Blue Light
  { sku: '4800135339', material: 'BLY', base_curve: 0.25, description: 'SF BLY BC 0.25' },
  { sku: '4800135347', material: 'BLY', base_curve: 2.0,  description: 'SF BLY BC 2.0' },
  { sku: '4800135354', material: 'BLY', base_curve: 2.0,  description: 'SF BLY BC 2.0' },
  { sku: '4800135362', material: 'BLY', base_curve: 5.25, description: 'SF BLY BC 5.25' },
  // Semi 1.67
  { sku: '4800150924', material: 'H67', base_curve: 0.5,  description: 'SF H67 BC 0.5' },
  { sku: '4800150932', material: 'H67', base_curve: 1.0,  description: 'SF H67 BC 1.0' },
  { sku: '4800135305', material: 'H67', base_curve: 3.0,  description: 'SF H67 BC 3.0' },
  { sku: '4800150940', material: 'H67', base_curve: 5.0,  description: 'SF H67 BC 5.0' },
  { sku: '4800150957', material: 'H67', base_curve: 6.0,  description: 'SF H67 BC 6.0' },
  // Semi 1.67 Blue Light
  { sku: '4800150882', material: 'B67', base_curve: 0.5,  description: 'SF B67 BC 0.5' },
  { sku: '4800150890', material: 'B67', base_curve: 1.0,  description: 'SF B67 BC 1.0' },
  { sku: '4800135297', material: 'B67', base_curve: 3.0,  description: 'SF B67 BC 3.0' },
  { sku: '4800150908', material: 'B67', base_curve: 5.0,  description: 'SF B67 BC 5.0' },
  { sku: '4800150916', material: 'B67', base_curve: 6.0,  description: 'SF B67 BC 6.0' },
  { sku: '4800150965', material: 'B67', base_curve: null, description: 'SF B67 (new — BC TBD)' },
  // Photochromic Poly
  { sku: '265007922', material: 'SPY', base_curve: null, description: 'SF Photochromic PLY' },
  { sku: '265007930', material: 'SPY', base_curve: null, description: 'SF Photochromic PLY' },
  { sku: '265007948', material: 'SPY', base_curve: null, description: 'SF Photochromic PLY' },
  { sku: '265007955', material: 'SPY', base_curve: null, description: 'SF Photochromic PLY' },
  { sku: '265007963', material: 'SPY', base_curve: null, description: 'SF Photochromic PLY' },
  { sku: '265007971', material: 'SPY', base_curve: null, description: 'SF Photochromic PLY' },
  { sku: '265007989', material: 'SPY', base_curve: null, description: 'SF Photochromic PLY' },
  // Photochromic 1.67
  { sku: '265008466', material: 'S67', base_curve: null, description: 'SF Photochromic 1.67' },
  { sku: '265008474', material: 'S67', base_curve: null, description: 'SF Photochromic 1.67' },
  { sku: '265008482', material: 'S67', base_curve: null, description: 'SF Photochromic 1.67' },
  { sku: '265008490', material: 'S67', base_curve: null, description: 'SF Photochromic 1.67' },
  { sku: '265008508', material: 'S67', base_curve: null, description: 'SF Photochromic 1.67' },
];

module.exports = { SEMI_FINISHED_SEED };
