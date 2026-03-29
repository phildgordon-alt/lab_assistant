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
  const allItems = [];
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

    // Category: NetSuite first, then lens prefix detection, then Unknown
    const isLensPrefix = /^(4800|062|026|001|5[0-9]{3}|8820|1008|1130|1140|2650|3500|6201|6203|6204|CR39)/.test(sku);
    const isFramePrefix = /^(1960|1969|8100|8503|850[0-9])/.test(sku);
    const nsCat = inventory[sku]?.category;
    const itemCat = (nsCat && nsCat !== 'Other') ? nsCat : (isLensPrefix ? 'Lenses' : isFramePrefix ? 'Frames' : 'Unknown');
    const item = {
      sku,
      name: inventory[sku]?.name || '',
      category: itemCat,
      className: inventory[sku]?.className || '',
      wh1: wh1Qty,
      wh2: wh2Qty,
      wh3: wh3Qty,
      netsuite: nsQty,
      itempath: ipQty,
      diff,
      pctDiff: nsQty > 0 ? Math.round((diff / nsQty) * 100) : (ipQty > 0 ? 100 : 0),
      severity: Math.abs(diff) > 50 ? 'critical' : Math.abs(diff) > 10 ? 'high' : Math.abs(diff) > 0.5 ? 'low' : 'match',
      isMatch: Math.abs(diff) <= 0.5,
    };

    allItems.push(item);
    if (Math.abs(diff) > 0.5) {
      discrepancies.push(item);
    } else {
      matchCount++;
    }
  }

  // Sort by absolute difference descending
  discrepancies.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));

  // Check for discontinued SKUs (abc_class = 'X' in lens_sku_params)
  let discontinuedSkus = new Set();
  try {
    const db = require('./db');
    const discRows = db.db.prepare("SELECT sku FROM lens_sku_params WHERE abc_class = 'X'").all();
    discontinuedSkus = new Set(discRows.map(r => r.sku));
  } catch {}

  // Mark discontinued on each discrepancy
  for (const d of discrepancies) {
    d.discontinued = discontinuedSkus.has(d.sku);
  }

  // Category-level totals (all SKUs, not just discrepancies)
  const byCategory = {};
  for (const sku of allSkus) {
    const isLensPfx = /^(4800|062|026|001|5[0-9]{3}|8820|1008|1130|1140|2650|3500|6201|6203|6204|CR39)/.test(sku);
    const isFramePfx = /^(1960|1969|8100|8503|850[0-9])/.test(sku);
    const nsCat2 = inventory[sku]?.category;
    const cat = (nsCat2 && nsCat2 !== 'Other') ? nsCat2 : (isLensPfx ? 'Lenses' : isFramePfx ? 'Frames' : 'Unknown');
    const nsQty = inventory[sku]?.qty || 0;
    const ipQty = ipTotal[sku] || 0;
    const disc = discontinuedSkus.has(sku);
    if (!byCategory[cat]) byCategory[cat] = { category: cat, itempath: 0, netsuite: 0, diff: 0, skus: 0, itempath_disc: 0, netsuite_disc: 0 };
    if (disc) {
      byCategory[cat].itempath_disc += ipQty;
      byCategory[cat].netsuite_disc += nsQty;
    } else {
      byCategory[cat].itempath += ipQty;
      byCategory[cat].netsuite += nsQty;
      byCategory[cat].diff += (ipQty - nsQty);
    }
    byCategory[cat].skus++;
  }
  // Round
  for (const c of Object.values(byCategory)) {
    c.itempath = Math.round(c.itempath);
    c.netsuite = Math.round(c.netsuite);
    c.diff = Math.round(c.diff);
    c.itempath_disc = Math.round(c.itempath_disc);
    c.netsuite_disc = Math.round(c.netsuite_disc);
  }

  // Active totals (excluding discontinued)
  const activeDiscrepancies = discrepancies.filter(d => !d.discontinued);
  const discDiscrepancies = discrepancies.filter(d => d.discontinued);
  const activeTotalIP = Math.round(totalItemPath - [...discontinuedSkus].reduce((s, sku) => s + (ipTotal[sku] || 0), 0));
  const activeTotalNS = Math.round(totalNetSuite - [...discontinuedSkus].reduce((s, sku) => s + (inventory[sku]?.qty || 0), 0));

  return {
    summary: {
      totalSkus: allSkus.size,
      matched: matchCount,
      discrepancies: discrepancies.length,
      matchRate: allSkus.size > 0 ? Math.round((matchCount / allSkus.size) * 100) : 0,
      totalNetSuite: Math.round(totalNetSuite),
      totalItemPath: Math.round(totalItemPath),
      totalDiff: Math.round(totalItemPath - totalNetSuite),
      // Active (excluding discontinued)
      activeItemPath: activeTotalIP,
      activeNetSuite: activeTotalNS,
      activeDiff: activeTotalIP - activeTotalNS,
      discontinuedCount: discontinuedSkus.size,
      netsuiteSkus: Object.keys(inventory).length,
      itempathSkus: Object.keys(ipTotal).length,
      critical: discrepancies.filter(d => d.severity === 'critical').length,
      high: discrepancies.filter(d => d.severity === 'high').length,
      low: discrepancies.filter(d => d.severity === 'low').length,
    },
    byCategory: Object.values(byCategory).sort((a, b) => b.itempath - a.itempath),
    discrepancies: discrepancies.slice(0, 200),
    allItems,
    lastSync,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOOKUP — Get NetSuite data for a specific SKU
// ─────────────────────────────────────────────────────────────────────────────
function lookupSku(sku) {
  return inventory[sku] || null;
}

function getSkuCategory(sku) {
  const item = inventory[sku];
  if (item) return item.category; // Lenses, Frames, Tops, Other
  return null; // unknown — not in NetSuite
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
    // Get open PO headers (entity join separately to avoid field errors)
    const headers = await suiteql(`
      SELECT t.id, t.tranId AS poNumber, t.tranDate AS date, t.status,
             t.memo, t.entity AS entityId, t.shipDate
      FROM transaction t
      WHERE t.type = 'PurchOrd' AND t.status IN ('A','B','C','D','E','F')
      ORDER BY t.tranDate DESC
    `);

    // Get vendor names
    const entityIds = [...new Set(headers.map(h => h.entityid).filter(Boolean))];
    const vendorMap = {};
    if (entityIds.length > 0) {
      try {
        const vendors = await suiteql(`SELECT id, entityId FROM entity WHERE id IN (${entityIds.join(',')})`);
        for (const v of vendors) vendorMap[v.id] = v.entityid;
      } catch (e) { console.error('[NetSuite] Vendor lookup error:', e.message); }
    }

    // Get line items for open POs
    // Try multiple field names for received quantity
    let lines;
    let receivedFieldAvailable = false;
    // Try quantityshiprecv first (NetSuite's actual PO line received field)
    try {
      lines = await suiteql(`
        SELECT tl.transaction AS poId, item.itemId AS sku, item.displayName AS name,
               item.class AS classId, tl.quantity, tl.quantityshiprecv AS qtyReceived,
               tl.rate, tl.amount
        FROM transactionLine tl
        JOIN transaction t ON t.id = tl.transaction
        JOIN item ON item.id = tl.item
        WHERE t.type = 'PurchOrd' AND t.status IN ('A','B','C','D','E','F')
          AND tl.quantity > 0
        ORDER BY t.tranDate DESC
      `);
      receivedFieldAvailable = true;
      console.log('[NetSuite] PO lines: using quantityshiprecv for received qty');
    } catch (e1) {
      // Try quantityreceived
      try {
        lines = await suiteql(`
          SELECT tl.transaction AS poId, item.itemId AS sku, item.displayName AS name,
                 item.class AS classId, tl.quantity, tl.quantityreceived AS qtyReceived,
                 tl.rate, tl.amount
          FROM transactionLine tl
          JOIN transaction t ON t.id = tl.transaction
          JOIN item ON item.id = tl.item
          WHERE t.type = 'PurchOrd' AND t.status IN ('A','B','C','D','E','F')
            AND tl.quantity > 0
          ORDER BY t.tranDate DESC
        `);
        receivedFieldAvailable = true;
        console.log('[NetSuite] PO lines: using quantityreceived for received qty');
      } catch (e2) {
        // Fall back to no received field
        console.log('[NetSuite] No received qty field available, inferring from status. Errors:', e1.message, e2.message);
        lines = await suiteql(`
          SELECT tl.transaction AS poId, item.itemId AS sku, item.displayName AS name,
                 item.class AS classId, tl.quantity, tl.rate, tl.amount
          FROM transactionLine tl
          JOIN transaction t ON t.id = tl.transaction
          JOIN item ON item.id = tl.item
          WHERE t.type = 'PurchOrd' AND t.status IN ('A','B','C','D','E','F')
            AND tl.quantity > 0
          ORDER BY t.tranDate DESC
        `);
      }
    }
    // Log first line keys to see what's available
    if (lines.length > 0) console.log('[NetSuite] PO line keys:', Object.keys(lines[0]).join(', '));

    const CLASS_MAP = { '1': 'Frames', '2': 'Frames', '3': 'Lenses', '4': 'Lenses', '5': 'Tops', '6': 'Tops', '7': 'Tops', '9': 'Tops' };
    const STATUS_MAP = { 'A': 'Pending Approval', 'B': 'Pending Receipt', 'C': 'Partially Received', 'D': 'Pending Bill', 'E': 'Partially Approved', 'F': 'Pending Billing' };

    // Query Item Receipts linked to these POs — shows shipment splits
    const receiptsByPO = {};
    try {
      const poIds = headers.map(h => h.id);
      // Item Receipts reference PO via createdFrom
      const receipts = await suiteql(`
        SELECT t.id, t.tranId AS receiptNumber, t.tranDate AS receiptDate,
               t.createdFrom AS poId, t.status,
               SUM(tl.quantity) AS totalQty
        FROM transaction t
        JOIN transactionLine tl ON tl.transaction = t.id
        WHERE t.type = 'ItemRcpt' AND t.createdFrom IN (${poIds.join(',') || '0'})
          AND tl.quantity > 0
        GROUP BY t.id, t.tranId, t.tranDate, t.createdFrom, t.status
        ORDER BY t.tranDate
      `);
      for (const r of receipts) {
        const poId = r.poid;
        if (!receiptsByPO[poId]) receiptsByPO[poId] = [];
        receiptsByPO[poId].push({
          receiptNumber: r.receiptnumber,
          date: r.receiptdate,
          qty: parseFloat(r.totalqty) || 0,
        });
      }
      console.log(`[NetSuite] Item Receipts: ${receipts.length} receipts across ${Object.keys(receiptsByPO).length} POs`);
    } catch (e) {
      console.log('[NetSuite] Item receipt query failed (non-critical):', e.message);
    }

    // Build status lookup for POs (to infer received from status)
    const poStatusMap = {};
    for (const h of headers) poStatusMap[h.id] = h.status;

    // Group lines by PO
    const linesByPO = {};
    for (const line of lines) {
      const poId = line.poid;
      if (!linesByPO[poId]) linesByPO[poId] = [];
      const ordered = parseFloat(line.quantity) || 0;
      // Use received field if available, otherwise infer from PO status
      let received = parseFloat(line.qtyreceived) || 0;
      if (!receivedFieldAvailable || received === 0) {
        const poStatus = poStatusMap[poId];
        // D=Pending Bill, F=Pending Billing → fully received (waiting on invoice)
        if (poStatus === 'D' || poStatus === 'F') received = ordered;
        // C=Partially Received → we don't know exact amount without the field
        // B=Pending Receipt → 0 received (correct)
      }
      linesByPO[poId].push({
        sku: line.sku,
        name: line.name,
        category: CLASS_MAP[line.classid] || 'Other',
        qty: ordered,
        received,
        remaining: ordered - received,
        rate: parseFloat(line.rate) || 0,
        amount: parseFloat(line.amount) || 0,
        fulfillPct: ordered > 0 ? Math.round((received / ordered) * 100) : 0,
      });
    }

    const orders = headers.map(h => {
      // Determine phase: WIP (not shipped), On the Water (shipped, not received), Received
      let phase = 'WIP';
      if (h.status === 'B' || h.status === 'C') phase = h.shipdate ? 'On the Water' : 'Pending';
      else if (h.status === 'D' || h.status === 'F') phase = 'Received';
      return {
        id: h.id,
        poNumber: h.ponumber,
        date: h.date,
        shipDate: h.shipdate || null,
        status: STATUS_MAP[h.status] || h.status,
        statusCode: h.status,
        phase,
        vendor: vendorMap[h.entityid] || '',
        memo: h.memo || '',
        lines: linesByPO[h.id] || [],
        lineCount: (linesByPO[h.id] || []).length,
        receipts: receiptsByPO[h.id] || [],
        receiptCount: (receiptsByPO[h.id] || []).length,
        totalQty: (linesByPO[h.id] || []).reduce((s, l) => s + l.qty, 0),
        totalReceived: (linesByPO[h.id] || []).reduce((s, l) => s + l.received, 0),
        totalRemaining: (linesByPO[h.id] || []).reduce((s, l) => s + l.remaining, 0),
        totalAmount: (linesByPO[h.id] || []).reduce((s, l) => s + l.amount, 0),
      };
    });

    poCache = { orders, lastSync: new Date().toISOString() };
    console.log(`[NetSuite] POs: ${orders.length} open, ${lines.length} line items`);

    // Save to SQLite
    try {
      const db = require('./db');
      const upsert = db.db.prepare(`INSERT OR REPLACE INTO purchase_orders (id, po_number, date, status, status_code, vendor, memo, line_count, total_qty, total_received, total_remaining, total_amount, lines_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      const hist = db.db.prepare(`INSERT INTO purchase_orders_history (po_id, po_number, status, total_qty, vendor) VALUES (?, ?, ?, ?, ?)`);
      const save = db.db.transaction(() => {
        for (const o of orders) {
          upsert.run(o.id, o.poNumber, o.date, o.status, o.statusCode, o.vendor, o.memo, o.lineCount, o.totalQty, o.totalReceived, o.totalRemaining, o.totalAmount, JSON.stringify(o.lines));
          hist.run(o.id, o.poNumber, o.status, o.totalQty, o.vendor);
        }
      });
      save();
    } catch (e) { console.error('[NetSuite] PO save error:', e.message); }
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
    totalReceived: orders.reduce((s, o) => s + o.lines.reduce((s2, l) => s2 + (l.received || 0), 0), 0),
    totalRemaining: orders.reduce((s, o) => s + o.lines.reduce((s2, l) => s2 + (l.remaining || 0), 0), 0),
    totalAmount: orders.reduce((s, o) => s + o.lines.reduce((s2, l) => s2 + l.amount, 0), 0),
    byStatus: {},
    byCategory: {},
    byCategoryReceived: {},
  };

  for (const o of orders) {
    summary.byStatus[o.status] = (summary.byStatus[o.status] || 0) + 1;
    for (const l of o.lines) {
      summary.byCategory[l.category] = (summary.byCategory[l.category] || 0) + l.qty;
      summary.byCategoryReceived[l.category] = (summary.byCategoryReceived[l.category] || 0) + (l.received || 0);
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
  // Consumption sync after 60s (heavy query, let everything else start first)
  setTimeout(() => syncConsumption(), 60000);
  // Inventory every 5 minutes, POs every 10 minutes, consumption every 30 minutes
  pollTimer = setInterval(() => poll(), POLL_INTERVAL);
  setInterval(() => fetchOpenPOs(), 600000);
  setInterval(() => syncConsumption(), 1800000);
}

// ─────────────────────────────────────────────────────────────────────────────
// CONSUMPTION — YTD transaction lines (negative qty = consumed)
// Fetched from NetSuite, saved to SQLite, served from SQLite
// ─────────────────────────────────────────────────────────────────────────────
let consumptionSyncing = false;

async function syncConsumption() {
  if (!CONSUMER_KEY || !TOKEN_ID || consumptionSyncing) return;
  consumptionSyncing = true;

  try {
    const db = require('./db');

    // Find latest date we have in SQLite to only fetch new data
    const latest = db.db.prepare('SELECT MAX(tran_date) as latest FROM netsuite_consumption_daily').get();
    const year = new Date().getFullYear();
    const startDate = latest?.latest || `${year}-01-01`;
    const endDate = new Date().toISOString().slice(0, 10);

    // Break into monthly chunks to avoid loading 342K rows at once
    const chunks = [];
    let d = new Date(startDate + 'T00:00:00');
    const end = new Date(endDate + 'T00:00:00');
    while (d <= end) {
      const from = d.toISOString().slice(0, 10);
      // Move to end of month or endDate, whichever is sooner
      const monthEnd = new Date(d.getFullYear(), d.getMonth() + 1, 0);
      const to = monthEnd > end ? endDate : monthEnd.toISOString().slice(0, 10);
      chunks.push({ from, to });
      d = new Date(d.getFullYear(), d.getMonth() + 1, 1);
    }

    console.log(`[NetSuite] Syncing consumption: ${chunks.length} month chunk(s) from ${startDate} to ${endDate}`);

    const CLASS_TO_CAT = { '1': 'Frames', '2': 'Frames', '3': 'Lenses', '4': 'Lenses', '5': 'Tops', '6': 'Tops', '7': 'Tops', '9': 'Tops' };
    const deleteStmt = db.db.prepare('DELETE FROM netsuite_consumption_daily WHERE tran_date >= ? AND tran_date <= ?');
    const insertStmt = db.db.prepare('INSERT INTO netsuite_consumption_daily (tran_date, sku, qty, lines, category) VALUES (?, ?, ?, ?, ?)');

    for (const chunk of chunks) {
      try {
        console.log(`[NetSuite] Fetching consumption ${chunk.from} to ${chunk.to}...`);
        // Aggregate on NetSuite's side — includes class for category filtering
        const rows = await suiteql(`
          SELECT t.trandate, i.itemId AS itemid, i.class AS classid, SUM(ABS(tl.quantity)) AS qty, COUNT(*) AS lines
          FROM transactionline tl
          INNER JOIN transaction t ON t.id = tl.transaction
          INNER JOIN item i ON i.id = tl.item
          WHERE tl.location = ${LOCATION_ID}
            AND t.trandate >= TO_DATE('${chunk.from}', 'YYYY-MM-DD')
            AND t.trandate <= TO_DATE('${chunk.to}', 'YYYY-MM-DD')
            AND tl.quantity < 0
          GROUP BY t.trandate, i.itemId, i.class
          ORDER BY t.trandate DESC
        `);

        // Save to SQLite — convert NetSuite date format (M/D/YYYY) to ISO (YYYY-MM-DD)
        const toISO = (d) => {
          if (!d) return '';
          if (d.includes('-') && d.startsWith('20')) return d; // already ISO
          const parts = d.split('/');
          if (parts.length === 3) return `${parts[2]}-${parts[0].padStart(2,'0')}-${parts[1].padStart(2,'0')}`;
          return d;
        };
        const save = db.db.transaction(() => {
          deleteStmt.run(chunk.from, chunk.to);
          for (const row of rows) {
            const sku = row.itemid || '';
            const qty = parseInt(row.qty) || 0;
            const lines = parseInt(row.lines) || 0;
            const date = toISO(row.trandate || '');
            const cat = CLASS_TO_CAT[row.classid] || 'Other';
            if (sku && qty > 0 && date) insertStmt.run(date, sku, qty, lines, cat);
          }
        });
        save();

        console.log(`[NetSuite] Chunk ${chunk.from}–${chunk.to}: ${rows.length} aggregated rows saved`);
      } catch (e) {
        console.error(`[NetSuite] Chunk ${chunk.from}–${chunk.to} error:`, e.message);
      }
    }

    const totalRows = db.db.prepare('SELECT COUNT(*) as cnt FROM netsuite_consumption_daily').get();
    console.log(`[NetSuite] Consumption sync complete: ${totalRows.cnt} total aggregates in SQLite`);
  } catch (e) {
    console.error('[NetSuite] Consumption sync error:', e.message);
  }
  consumptionSyncing = false;
}

function getConsumption(fromDate, toDate) {
  const db = require('./db');
  const from = fromDate || `${new Date().getFullYear()}-01-01`;
  const to = toDate || new Date().toISOString().slice(0, 10);

  // Read from SQLite
  const bySku = {};
  const byDate = {};
  let total = 0;

  const rows = db.db.prepare(`
    SELECT tran_date, sku, qty, lines, category FROM netsuite_consumption_daily
    WHERE tran_date >= ? AND tran_date <= ?
      AND category IN ('Lenses', 'Frames')
  `).all(from, to);

  let lenses = 0, frames = 0;

  for (const r of rows) {
    total += r.qty;
    if (r.category === 'Lenses') lenses += r.qty; else frames += r.qty;
    if (!bySku[r.sku]) bySku[r.sku] = { qty: 0, lines: 0, category: r.category };
    bySku[r.sku].qty += r.qty;
    bySku[r.sku].lines += r.lines;
    if (!byDate[r.tran_date]) byDate[r.tran_date] = { qty: 0, lines: 0 };
    byDate[r.tran_date].qty += r.qty;
    byDate[r.tran_date].lines += r.lines;
  }

  return { bySku, byDate, total, lenses, frames, from, to, skuCount: Object.keys(bySku).length, dayCount: Object.keys(byDate).length };
}

module.exports = {
  start,
  getInventory,
  getHealth,
  reconcile,
  lookupSku,
  getSkuCategory,
  getOpenPOs,
  fetchOpenPOs,
  syncConsumption,
  getConsumption,
  poll,
};
