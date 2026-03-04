/**
 * itempath-adapter.js
 * Lab_Assistant — ItemPath/Kardex live inventory integration
 * 
 * AUTH: Application token (non-expiring) — generate once:
 *   1. Create a user in ItemPath with type = "application"
 *   2. POST /api/users/login  →  get refreshToken
 *   3. POST /api/users/application-token (with refreshToken as Bearer)  →  applicationToken
 *   4. Set ITEMPATH_TOKEN env var to that applicationToken — done forever
 * 
 * ENDPOINTS USED:
 *   GET /api/materials              → lens blank inventory (SKU, qty on hand)
 *   GET /api/transactions           → recent picks (last 2 hours)
 *   GET /api/orders                 → active pick orders in progress
 *   GET /api/order-lines            → line items on active orders
 *   GET /api/location-contents      → what's physically in each Kardex bin
 *
 * POLL INTERVAL: 60 seconds (picks happen every few minutes — this gives near-real-time)
 *
 * USAGE in oven-timer-server.js:
 *   const itempath = require('./itempath-adapter');
 *   itempath.start();
 *   app.get('/api/inventory', (req, res) => res.json(itempath.getInventory()));
 *   app.get('/api/inventory/picks', (req, res) => res.json(itempath.getPicks()));
 *   app.get('/api/inventory/alerts', (req, res) => res.json(itempath.getAlerts()));
 *   app.get('/api/inventory/blank', (req, res) => res.json(itempath.findBlank(req.query)));
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — set via environment variables or edit defaults here
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:       process.env.ITEMPATH_URL    || 'https://your-itempath-instance.com',
  appToken:      process.env.ITEMPATH_TOKEN  || '',   // non-expiring application token
  pollInterval:  parseInt(process.env.ITEMPATH_POLL_MS || '60000'),  // 60s default
  mockMode:      !process.env.ITEMPATH_TOKEN,          // auto-mock if no token configured

  // Low stock thresholds — SKU type → minimum qty before alert fires
  // These control dashboard display. Slack alerts use separate filtering below.
  lowStockThresholds: {
    'AR':           5,
    'BLUE_CUT':     5,
    'HARD_COAT':    5,
    'MIRROR':       3,
    'POLARIZED':    5,
    'TRANSITIONS':  5,
    'PREMIUM_AR':   3,
    'DEFAULT':      2,   // Only alert when nearly out
  },

  // Slack alert filtering — prevent alert floods
  slackWebhook:  process.env.SLACK_WEBHOOK || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackChannel:  process.env.SLACK_CHANNEL || 'lab-assistant',
  slackMaxAlertsPerHour: 10,  // Max alerts to send per hour
  slackMinQtyDrop: 5,         // Only alert if item dropped BY at least this much
  // Only send Slack alerts for these coating types (empty = all)
  slackAlertCoatings: ['TRANSITIONS', 'POLARIZED', 'PREMIUM_AR', 'MIRROR'],
};

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CACHE — updated every poll cycle
// ─────────────────────────────────────────────────────────────────────────────
let cache = {
  materials:        [],   // normalized inventory: { sku, name, qty, unit, location, coatingType, rxSpec, lastUpdated }
  activePicks:      [],   // active orders in progress: { orderId, sku, name, qty, picker, startedAt, status }
  recentTransactions: [], // completed picks last 2hrs: { id, sku, qty, type, completedAt, picker }
  alerts:           [],   // low stock alerts: { sku, name, qty, threshold, severity }
  warehouses:       [],   // warehouse list: { id, name }
  warehouseStats:   {},   // stats by warehouse: { WH1: { activeOrders, totalLines, totalQty }, ... }
  hourlyStats:      {},   // hourly picks by warehouse: { WH1: { 0: qty, 1: qty, ... }, WH2: {...} }
  vlmStats:         {},   // VLM breakdown: { KITCHEN01: { locationCount, totalQty }, ... }
  carouselStats:    {},   // carousel inventory: { 'CAR-1': qty, 'CAR-2': qty, ... }
  locations:        [],   // VLM locations: { id, name, vlm, qty }
  lastSync:         null,
  syncStatus:       'pending',  // 'pending' | 'ok' | 'error' | 'mock'
  syncError:        null,
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — application token is non-expiring, just attach as Bearer
// ─────────────────────────────────────────────────────────────────────────────
function authHeaders() {
  return {
    'Authorization': `Bearer ${CONFIG.appToken}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH WRAPPER — timeout + error handling
// ─────────────────────────────────────────────────────────────────────────────
async function ipFetch(path, params = {}) {
  const url = new URL(`${CONFIG.baseUrl}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(60000),  // 60s timeout for large fetches
  });

  if (!resp.ok) {
    throw new Error(`ItemPath ${path} → HTTP ${resp.status}`);
  }
  return resp.json();
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZE — map ItemPath API response shapes to Lab_Assistant internal format
// ─────────────────────────────────────────────────────────────────────────────

function normalizeMaterial(m) {
  // ItemPath materials = lens blanks in Kardex
  // Actual ItemPath fields:
  //   id, name (OPC code), currentQuantity, Info1-Info5 (product details)
  //   Info1=type (BLY SV), Info2=color (CLR), Info3=index (HK 76), Info4=sphere, Info5=cylinder

  // Build description from Info fields
  const infoParts = [m.Info1, m.Info2, m.Info3].filter(Boolean);
  const description = infoParts.join(' ') || m.name;

  return {
    id:           m.id,
    sku:          m.name,  // OPC code is in 'name' field
    name:         description,  // Build readable name from Info fields
    qty:          parseFloat(m.currentQuantity) || 0,  // ItemPath uses currentQuantity
    unit:         m.unitOfMeasure || 'EA',
    location:     m.location || m.bin || null,
    coatingType:  m.Info1 || null,  // e.g., "BLY SV"
    index:        m.Info3 || null,  // e.g., "HK 76"
    rxSphere:     m.Info4 || null,  // e.g., "-8.00"
    rxCylinder:   m.Info5 || null,  // e.g., "-2.00"
    rxAdd:        null,
    reorderPoint: parseFloat(m.reOrderPoint) || 10,
    rawProps:     { Info1: m.Info1, Info2: m.Info2, Info3: m.Info3, Info4: m.Info4, Info5: m.Info5 },
    lastUpdated:  new Date().toISOString(),
  };
}

function normalizeOrder(o) {
  // ItemPath uses order_lines (not lines)
  const lines = o.order_lines || o.lines || [];
  return {
    orderId:   o.id,
    reference: o.reference || o.name,
    status:    o.status,
    warehouse: o.warehouseName || null,
    startedAt: o.modifiedDate || o.created_at || o.started_at,
    hasStock:  o.hasStock,
    lines:     lines.map(l => ({
      sku:     l.materialName || l.material_code || l.sku,
      name:    l.Info3 ? `${l.Info3} ${l.Info1 || ''}`.trim() : (l.materialName || l.material_name || l.name),
      qty:     parseFloat(l.quantity) || 0,
      picked:  parseFloat(l.quantity_picked || l.picked || 0),
      pending: Math.max(0, (parseFloat(l.quantity)||0) - (parseFloat(l.quantity_picked||0))),
      rxInfo:  l.Info1 || null,  // e.g., "R: -0.88  -0.55  89  225"
      sizing:  l.Info2 || null,  // e.g., "30.5  28.0  3.4  19.4  -----"
    })),
  };
}

function normalizeTransaction(t) {
  return {
    id:          t.id,
    sku:         t.material_code || t.sku,
    name:        t.material_name || t.name,
    qty:         Math.abs(parseFloat(t.quantity) || 0),
    type:        t.type || (parseFloat(t.quantity) < 0 ? 'PICK' : 'REPLENISH'),
    completedAt: t.completed_at || t.created_at,
    picker:      t.user || t.operator || null,
    orderId:     t.order_id || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// LOW STOCK DETECTION
// ─────────────────────────────────────────────────────────────────────────────
function detectAlerts(materials) {
  const alerts = [];
  for (const m of materials) {
    // Match threshold by coating type if available, else by SKU pattern, else default
    let threshold = CONFIG.lowStockThresholds['DEFAULT'];
    if (m.coatingType) {
      const key = m.coatingType.toUpperCase().replace(/\s+/g,'_').replace(/-/g,'_');
      if (CONFIG.lowStockThresholds[key] !== undefined) {
        threshold = CONFIG.lowStockThresholds[key];
      }
    }
    // Also check SKU name patterns
    Object.keys(CONFIG.lowStockThresholds).forEach(k => {
      if (m.name?.toUpperCase().includes(k) || m.sku?.toUpperCase().includes(k)) {
        threshold = CONFIG.lowStockThresholds[k];
      }
    });

    if (m.qty <= threshold) {
      alerts.push({
        sku:       m.sku,
        name:      m.name,
        qty:       m.qty,
        threshold,
        severity:  m.qty === 0 ? 'CRITICAL' : m.qty <= threshold * 0.5 ? 'HIGH' : 'LOW',
        coatingType: m.coatingType,
        location:  m.location,
      });
    }
  }
  // Sort critical first
  return alerts.sort((a,b) => {
    const s = {CRITICAL:0, HIGH:1, LOW:2};
    return (s[a.severity]||3) - (s[b.severity]||3);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// SLACK ALERT — fires when new critical/high alerts appear
// Supports both Bot Token (preferred) and Webhook methods
// ─────────────────────────────────────────────────────────────────────────────
let lastAlertSkus = new Set();

async function sendSlackMessage(message) {
  // Method 1: Bot Token (preferred)
  if (CONFIG.slackBotToken) {
    try {
      const resp = await fetch('https://slack.com/api/chat.postMessage', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${CONFIG.slackBotToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          channel: CONFIG.slackChannel,
          text: message,
          mrkdwn: true,
        }),
      });
      const data = await resp.json();
      if (!data.ok) {
        console.warn('[ItemPath] Slack Bot API error:', data.error);
      }
      return data.ok;
    } catch (e) {
      console.warn('[ItemPath] Slack Bot API failed:', e.message);
      return false;
    }
  }

  // Method 2: Webhook (legacy)
  if (CONFIG.slackWebhook) {
    try {
      await fetch(CONFIG.slackWebhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: message }),
      });
      return true;
    } catch (e) {
      console.warn('[ItemPath] Slack webhook failed:', e.message);
      return false;
    }
  }

  return false;
}

// Track previous quantities to detect drops (not always-0 items)
let previousQty = {};  // sku → last known qty
let slackAlertsSentThisHour = 0;
let lastHourReset = Date.now();

async function sendSlackAlerts(alerts) {
  if (!CONFIG.slackBotToken && !CONFIG.slackWebhook) return;

  // Reset hourly counter
  if (Date.now() - lastHourReset > 3600000) {
    slackAlertsSentThisHour = 0;
    lastAlertSkus = new Set();
    lastHourReset = Date.now();
  }

  // Check if we've hit the hourly limit
  if (slackAlertsSentThisHour >= CONFIG.slackMaxAlertsPerHour) return;

  // Filter alerts:
  // 1. Only CRITICAL or HIGH severity
  // 2. Not already alerted this hour
  // 3. If coating filter set, only matching coatings
  // 4. Only items that DROPPED (were previously stocked)
  const newAlerts = alerts.filter(a => {
    if (a.severity !== 'CRITICAL' && a.severity !== 'HIGH') return false;
    if (lastAlertSkus.has(a.sku)) return false;

    // Filter by coating type if configured
    if (CONFIG.slackAlertCoatings.length > 0) {
      const coating = (a.coatingType || '').toUpperCase().replace(/\s+/g, '_');
      const matchesCoating = CONFIG.slackAlertCoatings.some(c =>
        coating.includes(c) || (a.name || '').toUpperCase().includes(c)
      );
      if (!matchesCoating) return false;
    }

    // Only alert if item dropped (was previously stocked)
    const prevQty = previousQty[a.sku];
    if (prevQty === undefined) return false;  // First time seeing this SKU, skip
    if (prevQty === 0 && a.qty === 0) return false;  // Was already 0, skip
    if (prevQty - a.qty < CONFIG.slackMinQtyDrop) return false;  // Didn't drop enough

    return true;
  });

  if (!newAlerts.length) return;

  // Limit to remaining quota
  const toSend = newAlerts.slice(0, CONFIG.slackMaxAlertsPerHour - slackAlertsSentThisHour);

  const lines = toSend.map(a => {
    const icon = a.severity === 'CRITICAL' ? '🔴' : '🟠';
    const dropAmt = (previousQty[a.sku] || 0) - a.qty;
    return `${icon} *${a.name}* (${a.sku}) — ${a.qty} left (dropped ${dropAmt})`;
  });

  await sendSlackMessage(`*📦 Kardex Stock Alert*\n${lines.join('\n')}`);

  toSend.forEach(a => lastAlertSkus.add(a.sku));
  slackAlertsSentThisHour += toSend.length;
}

// Called after each poll to track qty changes
function updatePreviousQty(materials) {
  for (const m of materials) {
    previousQty[m.sku] = m.qty;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN POLL — fetches all endpoints in parallel
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
  if (CONFIG.mockMode) {
    loadMockData();
    return;
  }

  try {
    const twoHrsAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
    // Get today's start for pick transactions
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();

    // Parallel fetch — materials, active orders, transactions, warehouses, locations
    // Note: Need 20000+ locations to capture all carousel bins
    // type=4 transactions are completed picks
    const [materialsResp, ordersResp, txResp, pickTxResp, warehousesResp, locationsResp] = await Promise.all([
      ipFetch('/api/materials', { limit: 10000 }),
      // ItemPath uses "In Process" status (not "in_progress")
      ipFetch('/api/orders',    { limit: 500 }),  // Fetch all, filter by status client-side
      ipFetch('/api/transactions', { after: twoHrsAgo, limit: 500 }).catch(() => ({ transactions: [] })),
      // Today's pick transactions (type=4) for hourly stats
      ipFetch('/api/transactions', { type: 4, after: todayStart, limit: 2000 }).catch(() => ({ transactions: [] })),
      ipFetch('/api/warehouses').catch(() => ({ warehouses: [] })),
      ipFetch('/api/locations', { limit: 20000 }).catch(() => ({ locations: [] })),
    ]);

    const materials   = (materialsResp.materials || materialsResp.data || materialsResp || []).map(normalizeMaterial);

    // Filter orders by "In Process" status (active picks)
    const allOrders   = (ordersResp.orders || ordersResp.data || ordersResp || []);
    const activeOrders = allOrders.filter(o => o.status === 'In Process');
    const activePicks = activeOrders.map(normalizeOrder);

    const recentTx    = (txResp.transactions || txResp.data || txResp || []).map(normalizeTransaction);
    const pickTxList  = (pickTxResp.transactions || pickTxResp.data || pickTxResp || []);
    const alerts      = detectAlerts(materials);
    const warehouses  = (warehousesResp.warehouses || []).map(w => ({ id: w.id, name: w.name }));

    // Calculate hourly pick stats from type=4 transactions (completed picks)
    const hourlyStats = { WH1: {}, WH2: {} };
    for (let h = 0; h < 24; h++) {
      hourlyStats.WH1[h] = 0;
      hourlyStats.WH2[h] = 0;
    }
    let todayPicksTotal = { WH1: 0, WH2: 0 };

    for (const tx of pickTxList) {
      const wh = tx.warehouseName || 'Unknown';
      const date = tx.creationDate || '';
      if (date && (wh === 'WH1' || wh === 'WH2')) {
        const hour = parseInt(date.substring(11, 13)) || 0;
        // Count jobs (transactions), not quantities
        hourlyStats[wh][hour] += 1;
        todayPicksTotal[wh] += 1;
      }
    }

    // Calculate warehouse stats from orders (active/queued counts)
    const warehouseStats = {};

    for (const order of allOrders) {
      const wh = order.warehouseName || 'Unknown';
      if (!warehouseStats[wh]) {
        warehouseStats[wh] = { activeOrders: 0, untouchedOrders: 0, totalLines: 0, totalQty: 0, todayPicks: 0 };
      }

      if (order.status === 'In Process') {
        warehouseStats[wh].activeOrders++;
      } else if (order.status === 'Untouched') {
        warehouseStats[wh].untouchedOrders++;
      }
      const lines = order.order_lines || [];
      warehouseStats[wh].totalLines += lines.length;
      warehouseStats[wh].totalQty += lines.reduce((sum, l) => sum + (parseFloat(l.quantity) || 0), 0);
    }

    // Set today's picks from completed transactions
    if (warehouseStats.WH1) warehouseStats.WH1.todayPicks = todayPicksTotal.WH1;
    if (warehouseStats.WH2) warehouseStats.WH2.todayPicks = todayPicksTotal.WH2;

    // Calculate VLM and carousel stats from locations
    const locations = (locationsResp.locations || []);
    const vlmStats = {};
    const carouselStats = {};  // { 'CAR-1': qty, 'CAR-2': qty, ... }
    const normalizedLocations = [];

    for (const loc of locations) {
      const name = loc.name || '';
      const qty = parseFloat(loc.currentQuantity) || 0;

      // Extract storage unit identifier
      // CAR-6/ Shelf 058/ Position 01 -> CAR-6
      // KITCHEN01-xxx -> KITCHEN01
      // IRV02-xxx -> IRV02
      let storageUnit = 'Unknown';
      const carMatch = name.match(/^(CAR-\d+)/);
      if (carMatch) {
        storageUnit = carMatch[1];
        // Track carousel inventory separately
        if (!carouselStats[storageUnit]) {
          carouselStats[storageUnit] = 0;
        }
        carouselStats[storageUnit] += qty;
      } else if (name.startsWith('IRV')) {
        storageUnit = 'IRV02';
      } else if (name.startsWith('KITCHEN')) {
        storageUnit = 'KITCHEN01';
      } else {
        storageUnit = name.split('-')[0] || 'Unknown';
      }

      if (!vlmStats[storageUnit]) {
        vlmStats[storageUnit] = { locationCount: 0, totalQty: 0, filledLocations: 0 };
      }
      vlmStats[storageUnit].locationCount++;
      vlmStats[storageUnit].totalQty += qty;
      if (qty > 0) vlmStats[storageUnit].filledLocations++;

      normalizedLocations.push({
        id: loc.id,
        name: loc.name,
        vlm: storageUnit,
        qty: qty,
        fillLevel: loc.fillLevel || 0,
        type: loc.typeDescription || 'Bin',
      });
    }

    cache = {
      materials,
      activePicks,
      recentTransactions: recentTx,
      alerts,
      warehouses,
      warehouseStats,
      hourlyStats,
      vlmStats,
      carouselStats,  // { 'CAR-1': qty, 'CAR-2': qty, ... }
      locations: normalizedLocations,
      lastSync:   new Date().toISOString(),
      syncStatus: 'ok',
      syncError:  null,
    };

    await sendSlackAlerts(alerts);
    updatePreviousQty(materials);  // Track for next poll's drop detection
    console.log(`[ItemPath] ✓ Sync: ${materials.length} SKUs, ${activePicks.length} active orders, ${alerts.length} alerts`);

    // Write to SQLite for AI agent queries
    try {
      const db = require('./db');
      db.upsertInventory(materials);
      db.upsertAlerts(alerts);
      db.upsertPicks(activePicks);
      console.log(`[ItemPath] ✓ SQLite snapshot saved`);
    } catch (dbErr) {
      console.error('[ItemPath] SQLite write failed:', dbErr.message);
    }

  } catch (err) {
    cache.syncStatus = 'error';
    cache.syncError  = err.message;
    console.error('[ItemPath] Poll failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA — realistic lens blank inventory for development
// ─────────────────────────────────────────────────────────────────────────────
function loadMockData() {
  const mockMaterials = [
    { sku:'LB-167-AR-SV',  name:'1.67 Hi-Index AR Single Vision',      qty:47,  unit:'EA', coatingType:'AR',       index:'1.67', rxSphere:'-2.00', location:'K-A12' },
    { sku:'LB-167-AR-BI',  name:'1.67 Hi-Index AR Bifocal',            qty:23,  unit:'EA', coatingType:'AR',       index:'1.67', rxSphere:'-3.00', location:'K-A13' },
    { sku:'LB-156-BC-SV',  name:'1.56 Blue Cut Single Vision',          qty:8,   unit:'EA', coatingType:'BLUE_CUT', index:'1.56', rxSphere:'+1.00', location:'K-B04' },
    { sku:'LB-150-HC-SV',  name:'1.50 Hard Coat Standard SV',           qty:112, unit:'EA', coatingType:'HARD_COAT',index:'1.50', rxSphere:'0.00',  location:'K-C01' },
    { sku:'LB-174-MIR-SV', name:'1.74 Ultra-Thin Mirror SV',            qty:6,   unit:'EA', coatingType:'MIRROR',   index:'1.74', rxSphere:'-5.00', location:'K-D02' },
    { sku:'LB-156-POL-SV', name:'1.56 Polarized Single Vision',         qty:31,  unit:'EA', coatingType:'POLARIZED',index:'1.56', rxSphere:'+0.50', location:'K-E07' },
    { sku:'LB-167-TR-SV',  name:'1.67 Transitions Gen 8 SV',            qty:19,  unit:'EA', coatingType:'TRANSITIONS',index:'1.67',rxSphere:'-1.50', location:'K-F03' },
    { sku:'LB-174-PAR-SV', name:'1.74 Premium AR Ultra-Thin SV',        qty:0,   unit:'EA', coatingType:'PREMIUM_AR',index:'1.74',rxSphere:'-6.00', location:'K-G01' },
    { sku:'LB-150-CLR-SV', name:'1.50 Clear Standard SV',               qty:204, unit:'EA', coatingType:'CLEAR',    index:'1.50', rxSphere:'0.00',  location:'K-H01' },
    { sku:'LB-167-AR-PAL', name:'1.67 AR Progressive',                  qty:14,  unit:'EA', coatingType:'AR',       index:'1.67', rxSphere:'-1.00', location:'K-A20' },
  ].map((m, i) => ({ ...m, id: `M-${1000+i}`, lastUpdated: new Date().toISOString() }));

  const mockPicks = [
    { orderId:'ORD-2847', reference:'J21694 blanks', status:'in_progress', startedAt: new Date(Date.now()-600000).toISOString(),
      lines:[{ sku:'LB-167-AR-SV', name:'1.67 Hi-Index AR SV', qty:2, picked:1, pending:1 }] },
    { orderId:'ORD-2848', reference:'J21700 blanks', status:'in_progress', startedAt: new Date(Date.now()-180000).toISOString(),
      lines:[{ sku:'LB-150-CLR-SV', name:'1.50 Clear SV', qty:4, picked:4, pending:0 }] },
  ];

  const mockTx = Array.from({length:12}, (_, i) => ({
    id: `TX-${5000+i}`,
    sku: mockMaterials[i % mockMaterials.length].sku,
    name: mockMaterials[i % mockMaterials.length].name,
    qty: Math.ceil(Math.random()*3),
    type: 'PICK',
    completedAt: new Date(Date.now() - i * 600000).toISOString(),
    picker: ['Maria','James','Sofia'][i%3],
    orderId: `ORD-${2840+i}`,
  }));

  const alerts = detectAlerts(mockMaterials);

  cache = {
    materials: mockMaterials,
    activePicks: mockPicks,
    recentTransactions: mockTx,
    alerts,
    lastSync:   new Date().toISOString(),
    syncStatus: 'mock',
    syncError:  null,
  };
  console.log('[ItemPath] Mock mode — set ITEMPATH_URL + ITEMPATH_TOKEN to go live');
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — consumed by oven-timer-server.js endpoints
// ─────────────────────────────────────────────────────────────────────────────

/** Full normalized inventory */
function getInventory() {
  return {
    materials:      cache.materials,
    warehouses:     cache.warehouses,
    warehouseStats: cache.warehouseStats,
    hourlyStats:    cache.hourlyStats,
    vlmStats:       cache.vlmStats,
    carouselStats:  cache.carouselStats,  // { 'CAR-1': qty, 'CAR-2': qty, ... }
    lastSync:       cache.lastSync,
    status:         cache.syncStatus,
    error:          cache.syncError,
    alertCount:     cache.alerts.length,
  };
}

/** Active picks in progress */
function getPicks() {
  // Group active picks by warehouse
  const byWarehouse = {};
  for (const pick of cache.activePicks) {
    const wh = pick.warehouse || 'Unknown';
    if (!byWarehouse[wh]) byWarehouse[wh] = [];
    byWarehouse[wh].push(pick);
  }

  return {
    picks:       cache.activePicks,
    count:       cache.activePicks.length,
    byWarehouse: byWarehouse,
    lastSync:    cache.lastSync,
    recent:      cache.recentTransactions.slice(0, 20),
  };
}

/** Warehouse breakdown */
function getWarehouses() {
  return {
    warehouses:     cache.warehouses,
    warehouseStats: cache.warehouseStats,
    lastSync:       cache.lastSync,
  };
}

/** VLM breakdown */
function getVLMs() {
  return {
    vlmStats:  cache.vlmStats,
    locations: cache.locations,
    lastSync:  cache.lastSync,
  };
}

/** Low stock alerts */
function getAlerts() {
  return {
    alerts:   cache.alerts,
    critical: cache.alerts.filter(a => a.severity === 'CRITICAL').length,
    high:     cache.alerts.filter(a => a.severity === 'HIGH').length,
    low:      cache.alerts.filter(a => a.severity === 'LOW').length,
    lastSync: cache.lastSync,
  };
}

/**
 * Find blanks matching an Rx spec or coating type
 * Query params: coatingType, index, sphere, cylinder, sku (partial match)
 */
function findBlank(query = {}) {
  let results = [...cache.materials];

  if (query.coatingType) {
    const ct = query.coatingType.toUpperCase().replace(/\s+/g,'_').replace(/-/g,'_');
    results = results.filter(m =>
      m.coatingType?.toUpperCase().replace(/\s+/g,'_') === ct ||
      m.name?.toUpperCase().includes(query.coatingType.toUpperCase())
    );
  }
  if (query.index)    results = results.filter(m => m.index === query.index);
  if (query.sphere)   results = results.filter(m => m.rxSphere === query.sphere);
  if (query.cylinder) results = results.filter(m => m.rxCylinder === query.cylinder);
  if (query.sku)      results = results.filter(m =>
    m.sku?.toLowerCase().includes(query.sku.toLowerCase()) ||
    m.name?.toLowerCase().includes(query.sku.toLowerCase())
  );

  return {
    query,
    results: results.sort((a,b) => b.qty - a.qty),  // highest stock first
    totalQty: results.reduce((s,m) => s+m.qty, 0),
    available: results.filter(m => m.qty > 0).length,
    outOfStock: results.filter(m => m.qty === 0).length,
    lastSync: cache.lastSync,
  };
}

/** Summary context for AI — compact enough to fit in a system prompt */
function getAIContext() {
  const top10 = cache.materials
    .sort((a,b) => a.qty - b.qty)  // lowest stock first (most interesting)
    .slice(0, 10)
    .map(m => `${m.name}: ${m.qty} ${m.unit} @ ${m.location||'?'}`)
    .join('; ');

  const alertSummary = cache.alerts.slice(0,5)
    .map(a => `${a.severity}: ${a.name} (${a.qty} left)`)
    .join('; ');

  const activePicks = cache.activePicks
    .map(o => o.lines.map(l => `${l.name} ×${l.pending} pending`).join(', '))
    .join(' | ');

  return {
    inventorySummary: top10,
    alertsSummary: alertSummary || 'No alerts',
    activePicksSummary: activePicks || 'No active picks',
    totalSKUs: cache.materials.length,
    alertCount: cache.alerts.length,
    criticalCount: cache.alerts.filter(a=>a.severity==='CRITICAL').length,
    lastSync: cache.lastSync,
    mode: cache.syncStatus,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// START — kick off polling loop
// ─────────────────────────────────────────────────────────────────────────────
function start() {
  console.log(`[ItemPath] Starting — ${CONFIG.mockMode ? 'MOCK MODE' : CONFIG.baseUrl} — poll every ${CONFIG.pollInterval/1000}s`);
  poll();  // immediate first fetch
  setInterval(poll, CONFIG.pollInterval);
}

module.exports = { start, getInventory, getPicks, getAlerts, getWarehouses, getVLMs, getAIContext };
