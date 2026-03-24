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
    // Query inventory with UPC code for matching to ItemPath OPC
    const rows = await suiteql(`
      SELECT item.itemId AS itemid, item.displayName AS name,
             item.upcCode AS upc,
             invbal.quantityOnHand AS qty, invbal.quantityAvailable AS available,
             item.class AS classId
      FROM inventoryBalance invbal
      INNER JOIN item ON item.id = invbal.item
      WHERE invbal.location = ${LOCATION_ID}
        AND invbal.quantityOnHand > 0
      ORDER BY item.itemId
    `);

    // Count UPC coverage
    const withUpc = rows.filter(r => r.upc && r.upc !== r.itemid).length;
    console.log(`[NetSuite] UPC coverage: ${withUpc}/${rows.length} items have UPC codes`);

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

    // Build inventory map
    // Lenses (class 3,4): itemId IS the OPC code — matches ItemPath directly
    // Frames/Tops (class 1,2,5,6,7,9): use upcCode for matching
    const newInventory = {};
    for (const row of rows) {
      const classId = row.classid || '';
      const isLens = classId === '3' || classId === '4';

      // For lenses: itemId is the OPC code (4800xxx, 06xxx, 001xxx)
      // For frames/tops: upcCode is the matching key (12-digit UPC)
      const sku = isLens ? (row.itemid || '') : (row.upc || row.itemid || '');
      if (!sku) continue;

      newInventory[sku] = {
        sku,
        itemId: row.itemid,
        upc: row.upc || null,
        name: row.name,
        qty: parseFloat(row.qty) || 0,
        available: parseFloat(row.available) || 0,
        category: CLASS_MAP[classId] || 'Other',
        className: CLASS_NAMES[classId] || 'Unknown',
        classId: classId,
      };
    }

    // Log matching key stats
    const lensCount = Object.values(newInventory).filter(i => i.category === 'Lenses').length;
    const frameTopCount = Object.values(newInventory).filter(i => i.category !== 'Lenses' && i.category !== 'Other').length;
    console.log(`[NetSuite] Lenses: ${lensCount} (matched by OPC itemId), Frames/Tops: ${frameTopCount} (matched by UPC)`);

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
function reconcile(itempath, category = null, topsData = null) {
  const ipWarehouseStock = itempath.getWarehouseStock();

  // Build ItemPath total by SKU (WH1 + WH2 + WH3 + TOPS manual count)
  const ipTotal = {};
  for (const wh of ['WH1', 'WH2', 'WH3']) {
    for (const [sku, qty] of Object.entries(ipWarehouseStock[wh] || {})) {
      ipTotal[sku] = (ipTotal[sku] || 0) + qty;
    }
  }
  // Add TOPS manual count
  if (topsData) {
    for (const { sku, qty } of topsData) {
      ipTotal[sku] = (ipTotal[sku] || 0) + qty;
    }
  }

  // Compare
  let allSkus = new Set([...Object.keys(inventory), ...Object.keys(ipTotal)]);

  // Filter by category if specified — only include SKUs where NetSuite knows the category
  if (category) {
    allSkus = new Set([...allSkus].filter(sku => {
      const nsItem = inventory[sku];
      if (nsItem) return nsItem.category === category;
      return false; // ItemPath-only items don't have categories — exclude from filtered view
    }));
  }
  console.log(`[NetSuite] Reconcile: ${allSkus.size} SKUs${category ? ` (category: ${category})` : ''}`);
  const discrepancies = [];
  let matchCount = 0;
  let totalNetSuite = 0;
  let totalItemPath = 0;

  for (const sku of allSkus) {
    const nsQty = inventory[sku]?.qty || 0;
    const ipQty = ipTotal[sku] || 0;
    const wh1Qty = ipWarehouseStock.WH1?.[sku] || 0;
    const wh2Qty = ipWarehouseStock.WH2?.[sku] || 0;
    const wh3Qty = ipWarehouseStock.WH3?.[sku] || 0;
    totalNetSuite += nsQty;
    totalItemPath += ipQty;
    const diff = ipQty - nsQty;

    if (Math.abs(diff) > 0.5) {
      discrepancies.push({
        sku,
        name: inventory[sku]?.name || '',
        category: inventory[sku]?.category || 'Unknown',
        className: inventory[sku]?.className || '',
        wh1: wh1Qty,
        wh2: wh2Qty,
        wh3: wh3Qty,
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

// ─────────────────────────────────────────────────────────────────────────────
// PURCHASE ORDERS — Open POs from NetSuite
// ─────────────────────────────────────────────────────────────────────────────
let poCache = { orders: [], lastSync: null };

async function fetchOpenPOs() {
  if (!CONSUMER_KEY || !TOKEN_ID) return;

  try {
    // Get open PO headers
    const headers = await suiteql(`
      SELECT t.id, t.tranId AS poNumber, t.tranDate AS date, t.status,
             t.memo, e.entityId AS vendorId, e.companyName AS vendor
      FROM transaction t
      LEFT JOIN entity e ON e.id = t.entity
      WHERE t.type = 'PurchOrd' AND t.status IN ('A','B','C','D')
      ORDER BY t.tranDate DESC
    `);

    // Get line items for open POs
    const lines = await suiteql(`
      SELECT tl.transaction AS poId, item.itemId AS sku, item.displayName AS name,
             item.class AS classId, tl.quantity, tl.quantityReceived AS received,
             tl.rate, tl.amount
      FROM transactionLine tl
      JOIN transaction t ON t.id = tl.transaction
      JOIN item ON item.id = tl.item
      WHERE t.type = 'PurchOrd' AND t.status IN ('A','B','C','D')
        AND tl.quantity > 0 AND tl.itemType = 'InvtPart'
      ORDER BY t.tranDate DESC
    `);

    const CLASS_MAP = { '1': 'Frames', '2': 'Frames', '3': 'Lenses', '4': 'Lenses', '5': 'Tops', '6': 'Tops', '7': 'Tops', '9': 'Tops' };
    const STATUS_MAP = { 'A': 'Pending Approval', 'B': 'Pending Receipt', 'C': 'Partially Received', 'D': 'Pending Bill' };

    // Group lines by PO
    const linesByPO = {};
    for (const line of lines) {
      const poId = line.poid;
      if (!linesByPO[poId]) linesByPO[poId] = [];
      linesByPO[poId].push({
        sku: line.sku,
        name: line.name,
        category: CLASS_MAP[line.classid] || 'Other',
        qty: parseFloat(line.quantity) || 0,
        received: parseFloat(line.received) || 0,
        remaining: (parseFloat(line.quantity) || 0) - (parseFloat(line.received) || 0),
        rate: parseFloat(line.rate) || 0,
        amount: parseFloat(line.amount) || 0,
      });
    }

    const orders = headers.map(h => ({
      id: h.id,
      poNumber: h.ponumber,
      date: h.date,
      status: STATUS_MAP[h.status] || h.status,
      statusCode: h.status,
      vendor: h.vendor || h.vendorid || '',
      memo: h.memo || '',
      lines: linesByPO[h.id] || [],
      lineCount: (linesByPO[h.id] || []).length,
      totalQty: (linesByPO[h.id] || []).reduce((s, l) => s + l.qty, 0),
      totalReceived: (linesByPO[h.id] || []).reduce((s, l) => s + l.received, 0),
      totalRemaining: (linesByPO[h.id] || []).reduce((s, l) => s + l.remaining, 0),
      totalAmount: (linesByPO[h.id] || []).reduce((s, l) => s + l.amount, 0),
    }));

    poCache = { orders, lastSync: new Date().toISOString() };
    console.log(`[NetSuite] POs: ${orders.length} open, ${lines.length} line items`);
  } catch (err) {
    console.error(`[NetSuite] PO fetch error: ${err.message}`);
  }
}

function getOpenPOs(category = null) {
  let orders = poCache.orders;
  if (category) {
    orders = orders.map(o => ({
      ...o,
      lines: o.lines.filter(l => l.category === category),
    })).filter(o => o.lines.length > 0);
  }

  const summary = {
    totalPOs: orders.length,
    totalLines: orders.reduce((s, o) => s + o.lines.length, 0),
    totalQty: orders.reduce((s, o) => s + o.lines.reduce((s2, l) => s2 + l.qty, 0), 0),
    totalRemaining: orders.reduce((s, o) => s + o.lines.reduce((s2, l) => s2 + l.remaining, 0), 0),
    totalAmount: orders.reduce((s, o) => s + o.lines.reduce((s2, l) => s2 + l.amount, 0), 0),
    byStatus: {},
    byCategory: {},
  };

  for (const o of orders) {
    summary.byStatus[o.status] = (summary.byStatus[o.status] || 0) + 1;
    for (const l of o.lines) {
      summary.byCategory[l.category] = (summary.byCategory[l.category] || 0) + l.remaining;
    }
  }

  return { orders, summary, lastSync: poCache.lastSync };
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
  setTimeout(() => { poll(); fetchOpenPOs(); }, 10000);
  // Inventory every 5 minutes, POs every 10 minutes
  pollTimer = setInterval(() => poll(), POLL_INTERVAL);
  setInterval(() => fetchOpenPOs(), 600000);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMPTION — YTD transaction lines (negative qty = consumed)
// ─────────────────────────────────────────────────────────────────────────────
let consumptionCache = { bySku: {}, byDate: {}, lastSync: null, total: 0 };

async function fetchConsumption(fromDate, toDate) {
  if (!CONSUMER_KEY || !TOKEN_ID) return null;

  const from = fromDate || `${new Date().getFullYear()}-01-01`;
  const to = toDate || new Date().toISOString().slice(0, 10);

  console.log(`[NetSuite] Fetching consumption ${from} to ${to}...`);
  const allRows = await suiteql(`
    SELECT t.trandate, i.itemId AS itemid, ABS(tl.quantity) AS qty, t.type
    FROM transactionline tl
    INNER JOIN transaction t ON t.id = tl.transaction
    INNER JOIN item i ON i.id = tl.item
    WHERE tl.location = ${LOCATION_ID}
      AND t.trandate >= TO_DATE('${from}', 'YYYY-MM-DD')
      AND t.trandate <= TO_DATE('${to}', 'YYYY-MM-DD')
      AND tl.quantity < 0
    ORDER BY t.trandate DESC
  `);

  console.log(`[NetSuite] Consumption: ${allRows.length} lines fetched`);

  const bySku = {};
  const byDate = {};
  let total = 0;

  for (const row of allRows) {
    const sku = row.itemid || '';
    const qty = parseInt(row.qty) || 0;
    const date = row.trandate || '';
    if (!sku || qty <= 0) continue;

    total += qty;

    if (!bySku[sku]) bySku[sku] = { qty: 0, lines: 0 };
    bySku[sku].qty += qty;
    bySku[sku].lines++;

    if (!byDate[date]) byDate[date] = { qty: 0, lines: 0 };
    byDate[date].qty += qty;
    byDate[date].lines++;
  }

  consumptionCache = { bySku, byDate, lastSync: new Date().toISOString(), total, from, to, skuCount: Object.keys(bySku).length, dayCount: Object.keys(byDate).length };
  console.log(`[NetSuite] Consumption cached: ${total} units, ${Object.keys(bySku).length} SKUs, ${Object.keys(byDate).length} days`);
  return consumptionCache;
}

function getConsumption() {
  return consumptionCache;
}

module.exports = {
  start,
  getInventory,
  getHealth,
  reconcile,
  lookupSku,
  getOpenPOs,
  fetchOpenPOs,
  fetchConsumption,
  getConsumption,
  poll,
};
