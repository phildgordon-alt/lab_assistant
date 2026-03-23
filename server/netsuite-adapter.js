'use strict';

/**
 * NetSuite Adapter — Inventory reconciliation
 *
 * Pulls inventory from NetSuite via SuiteQL REST API (OAuth 1.0 TBA)
 * Compares against ItemPath data for discrepancy detection.
 *
 * NetSuite is for RECONCILIATION ONLY — not for restocking or operations.
 * ItemPath is the operational source of truth.
 *
 * Usage in oven-timer-server.js:
 *   const netsuite = require('./netsuite-adapter');
 *   netsuite.start();
 *   app.get('/api/netsuite/inventory', (req, res) => res.json(netsuite.getInventory()));
 *   app.get('/api/netsuite/reconcile', (req, res) => res.json(netsuite.reconcile(itempath)));
 */

const crypto = require('crypto');
const https = require('https');
const querystring = require('querystring');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const ACCOUNT = process.env.NETSUITE_ACCOUNT || '9067036';
const CONSUMER_KEY = process.env.NETSUITE_CONSUMER_KEY || '';
const CONSUMER_SECRET = process.env.NETSUITE_CONSUMER_SECRET || '';
const TOKEN_ID = process.env.NETSUITE_TOKEN_ID || '';
const TOKEN_SECRET = process.env.NETSUITE_TOKEN_SECRET || '';
const POLL_INTERVAL = parseInt(process.env.NETSUITE_POLL_INTERVAL || '300000'); // 5 minutes
const LOCATION_ID = '5'; // Irvine 2 = all inventory (WH1+WH2+WH3)

const BASE_URL = `https://${ACCOUNT}.suitetalk.api.netsuite.com`;

// ─────────────────────────────────────────────────────────────────────────────
// STATE
// ─────────────────────────────────────────────────────────────────────────────
let inventory = {};      // SKU → { qty, name, itemId, lastSync }
let lastSync = null;
let syncError = null;
let pollTimer = null;
let pollCount = 0;

// ─────────────────────────────────────────────────────────────────────────────
// OAUTH 1.0 SIGNATURE (HMAC-SHA256)
// ─────────────────────────────────────────────────────────────────────────────
function generateOAuthHeader(method, url, extraParams = {}) {
  const nonce = crypto.randomUUID().replace(/-/g, '');
  const timestamp = Math.floor(Date.now() / 1000).toString();

  const parsed = new URL(url);
  const baseUrl = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  const queryParams = Object.fromEntries(parsed.searchParams.entries());

  const oauthParams = {
    oauth_consumer_key: CONSUMER_KEY,
    oauth_token: TOKEN_ID,
    oauth_nonce: nonce,
    oauth_timestamp: timestamp,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_version: '1.0',
  };

  const allParams = { ...oauthParams, ...queryParams, ...extraParams };
  const paramStr = Object.keys(allParams).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allParams[k])}`)
    .join('&');

  const baseString = `${method}&${encodeURIComponent(baseUrl)}&${encodeURIComponent(paramStr)}`;
  const signingKey = `${encodeURIComponent(CONSUMER_SECRET)}&${encodeURIComponent(TOKEN_SECRET)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  return `OAuth realm="${ACCOUNT}",oauth_consumer_key="${CONSUMER_KEY}",oauth_token="${TOKEN_ID}",oauth_nonce="${nonce}",oauth_timestamp="${timestamp}",oauth_signature_method="HMAC-SHA256",oauth_version="1.0",oauth_signature="${encodeURIComponent(signature)}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTTP REQUEST
// ─────────────────────────────────────────────────────────────────────────────
function request(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const authHeader = generateOAuthHeader(method, url);
    const parsed = new URL(url);

    const options = {
      hostname: parsed.hostname,
      path: parsed.pathname + parsed.search,
      method,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
        'Prefer': 'transient',
      },
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, data: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, data });
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(); reject(new Error('Timeout')); });

    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SUITEQL QUERY
// ─────────────────────────────────────────────────────────────────────────────
async function suiteql(query) {
  const limit = 1000;
  let offset = 0;
  let allItems = [];
  let hasMore = true;

  while (hasMore) {
    const url = `${BASE_URL}/services/rest/query/v1/suiteql?limit=${limit}&offset=${offset}`;
    const resp = await request('POST', url, { q: query });
    if (resp.status !== 200) {
      throw new Error(`SuiteQL error ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
    }
    const items = resp.data.items || [];
    allItems = allItems.concat(items);
    hasMore = resp.data.hasMore === true;
    offset += limit;
    if (items.length < limit) hasMore = false;
  }

  return allItems;
}

// ─────────────────────────────────────────────────────────────────────────────
// POLL — Fetch all inventory from NetSuite Irvine 2
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
  if (!CONSUMER_KEY || !TOKEN_ID) {
    if (pollCount === 0) console.log('[NetSuite] Not configured — skipping');
    return;
  }

  pollCount++;
  const start = Date.now();

  try {
    // Query all inventory items at Irvine 2 location with qty > 0
    // Use upcCode as primary SKU match (same as ItemPath OPC code)
    const rows = await suiteql(`
      SELECT item.itemId AS itemid, item.displayName AS name,
             item.upcCode AS upc,
             invbal.quantityOnHand AS qty, invbal.quantityAvailable AS available,
             item.class AS classId
      FROM inventoryBalance invbal
      JOIN item ON item.id = invbal.item
      WHERE invbal.location = ${LOCATION_ID}
        AND invbal.quantityOnHand > 0
      ORDER BY item.itemId
    `);

    // Class ID → category mapping
    const CLASS_MAP = {
      '1': 'Frames', '2': 'Frames',                    // Glasses, Base Frames
      '3': 'Lenses',                                     // Lenses/Blanks
      '4': 'Lenses',                                     // Lens Upgrades
      '5': 'Tops', '6': 'Tops', '7': 'Tops', '9': 'Tops', // All top frame types
      '8': 'Other', '10': 'Other', '11': 'Other', '12': 'Other', '13': 'Other',
    };
    const CLASS_NAMES = {
      '1': 'Glasses', '2': 'Base Frames', '3': 'Lenses', '4': 'Lens Upgrades',
      '5': 'Top Frames', '6': 'Printed Tops', '7': 'Blank Tops', '8': 'Ink',
      '9': 'Stock Tops', '10': 'Accessories', '11': 'Packaging', '12': 'Warranties', '13': 'Other',
    };

    // Build inventory map — use UPC (OPC) as the key to match ItemPath
    const newInventory = {};
    for (const row of rows) {
      const classId = row.classid || '';
      // Use upcCode if available, otherwise itemId (both can be OPC codes)
      const sku = row.upc || row.itemid || '';
      if (!sku) continue;
      newInventory[sku] = {
        sku,
        itemId: row.itemid,
        name: row.name,
        qty: parseFloat(row.qty) || 0,
        available: parseFloat(row.available) || 0,
        category: CLASS_MAP[classId] || 'Other',
        className: CLASS_NAMES[classId] || 'Unknown',
        classId: classId,
      };
    }

    inventory = newInventory;
    lastSync = new Date().toISOString();
    syncError = null;

    const elapsed = Date.now() - start;
    const totalQty = Object.values(inventory).reduce((s, i) => s + i.qty, 0);
    console.log(`[NetSuite] Poll #${pollCount}: ${Object.keys(inventory).length} SKUs, ${Math.round(totalQty)} units at Irvine 2 (${elapsed}ms)`);

  } catch (err) {
    syncError = err.message;
    console.error(`[NetSuite] Poll #${pollCount} error: ${err.message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// RECONCILE — Compare NetSuite vs ItemPath
// ─────────────────────────────────────────────────────────────────────────────
function reconcile(itempath) {
  const ipWarehouseStock = itempath.getWarehouseStock();

  // Build ItemPath total by SKU (WH1 + WH2 + WH3)
  const ipTotal = {};
  for (const wh of ['WH1', 'WH2', 'WH3']) {
    for (const [sku, qty] of Object.entries(ipWarehouseStock[wh] || {})) {
      ipTotal[sku] = (ipTotal[sku] || 0) + qty;
    }
  }

  // Compare
  const allSkus = new Set([...Object.keys(inventory), ...Object.keys(ipTotal)]);
  const discrepancies = [];
  let matchCount = 0;
  let totalNetSuite = 0;
  let totalItemPath = 0;

  for (const sku of allSkus) {
    const nsQty = inventory[sku]?.qty || 0;
    const ipQty = ipTotal[sku] || 0;
    totalNetSuite += nsQty;
    totalItemPath += ipQty;
    const diff = ipQty - nsQty;

    if (Math.abs(diff) > 0.5) { // Allow rounding tolerance
      discrepancies.push({
        sku,
        name: inventory[sku]?.name || '',
        category: inventory[sku]?.category || 'Unknown',
        className: inventory[sku]?.className || '',
        netsuite: nsQty,
        itempath: ipQty,
        diff,
        pctDiff: nsQty > 0 ? Math.round((diff / nsQty) * 100) : (ipQty > 0 ? 100 : 0),
        severity: Math.abs(diff) > 50 ? 'critical' : Math.abs(diff) > 10 ? 'high' : 'low',
      });
    } else {
      matchCount++;
    }
  }

  // Sort by absolute difference descending
  discrepancies.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  return {
    summary: {
      totalSkus: allSkus.size,
      matched: matchCount,
      discrepancies: discrepancies.length,
      matchRate: allSkus.size > 0 ? Math.round((matchCount / allSkus.size) * 100) : 0,
      totalNetSuite: Math.round(totalNetSuite),
      totalItemPath: Math.round(totalItemPath),
      totalDiff: Math.round(totalItemPath - totalNetSuite),
      netsuiteSkus: Object.keys(inventory).length,
      itempathSkus: Object.keys(ipTotal).length,
      critical: discrepancies.filter(d => d.severity === 'critical').length,
      high: discrepancies.filter(d => d.severity === 'high').length,
      low: discrepancies.filter(d => d.severity === 'low').length,
    },
    discrepancies: discrepancies.slice(0, 200),
    lastSync,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOKUP — Get NetSuite data for a specific SKU
// ─────────────────────────────────────────────────────────────────────────────
function lookupSku(sku) {
  return inventory[sku] || null;
}

// ─────────────────────────────────────────────────────────────────────────────
// GETTERS
// ─────────────────────────────────────────────────────────────────────────────
function getInventory() {
  return {
    items: Object.values(inventory),
    count: Object.keys(inventory).length,
    totalQty: Math.round(Object.values(inventory).reduce((s, i) => s + i.qty, 0)),
    lastSync,
    syncError,
    location: 'Irvine 2',
  };
}

function getHealth() {
  return {
    configured: !!(CONSUMER_KEY && TOKEN_ID),
    connected: !!lastSync && !syncError,
    lastSync,
    syncError,
    pollCount,
    skuCount: Object.keys(inventory).length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// START
// ─────────────────────────────────────────────────────────────────────────────
function start() {
  if (!CONSUMER_KEY || !TOKEN_ID) {
    console.log('[NetSuite] Not configured — set NETSUITE_CONSUMER_KEY and NETSUITE_TOKEN_ID in .env');
    return;
  }

  console.log(`[NetSuite] Starting adapter — account ${ACCOUNT}, location Irvine 2`);
  console.log(`[NetSuite] Poll interval: ${POLL_INTERVAL}ms`);

  // Initial poll after 10s (let other adapters start first)
  setTimeout(() => poll(), 10000);
  // Then every 5 minutes
  pollTimer = setInterval(() => poll(), POLL_INTERVAL);
}

module.exports = {
  start,
  getInventory,
  getHealth,
  reconcile,
  lookupSku,
  poll,
};
