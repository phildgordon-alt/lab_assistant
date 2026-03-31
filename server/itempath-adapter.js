const path = require('path');
const fs = require('fs');

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
// INCREMENTAL PICK/PUT TRACKING — persisted to disk, survives restarts
// Picks: orders disappear from API when completed → count their lines
// Puts: track material qty increases between polls (items received into Kardex)
// ─────────────────────────────────────────────────────────────────────────────
const DAILY_FILE = path.join(__dirname, 'data', 'daily-picks.json');
let previousOrderMap = new Map();  // orderId → { warehouse, lineCount, reference, isPut }
let dailyPickTotals = { WH1: 0, WH2: 0, WH3: 0, date: null };
let dailyPutTotals = { WH1: 0, WH2: 0, WH3: 0, date: null };
// Hourly breakdown — { WH1: { 0:0, 1:0, ... 23:0 }, WH2: { ... }, WH3: { ... } }
function emptyHourly() { const h = {}; for (let i = 0; i < 24; i++) h[i] = 0; return h; }
let hourlyPicks = { WH1: emptyHourly(), WH2: emptyHourly(), WH3: emptyHourly() };
let hourlyPuts = { WH1: emptyHourly(), WH2: emptyHourly(), WH3: emptyHourly() };

// Load persisted daily totals from disk
function loadDailyTotals() {
  try {
    if (fs.existsSync(DAILY_FILE)) {
      const saved = JSON.parse(fs.readFileSync(DAILY_FILE, 'utf8'));
      const today = new Date().toISOString().substring(0, 10);
      if (saved.date === today) {
        dailyPickTotals = { WH1: saved.picks?.WH1 || 0, WH2: saved.picks?.WH2 || 0, WH3: saved.picks?.WH3 || 0, date: today };
        dailyPutTotals = { WH1: saved.puts?.WH1 || 0, WH2: saved.puts?.WH2 || 0, WH3: saved.puts?.WH3 || 0, date: today };
        if (saved.hourlyPicks) { hourlyPicks.WH1 = { ...emptyHourly(), ...saved.hourlyPicks.WH1 }; hourlyPicks.WH2 = { ...emptyHourly(), ...saved.hourlyPicks.WH2 }; hourlyPicks.WH3 = { ...emptyHourly(), ...saved.hourlyPicks?.WH3 }; }
        if (saved.hourlyPuts) { hourlyPuts.WH1 = { ...emptyHourly(), ...saved.hourlyPuts.WH1 }; hourlyPuts.WH2 = { ...emptyHourly(), ...saved.hourlyPuts.WH2 }; hourlyPuts.WH3 = { ...emptyHourly(), ...saved.hourlyPuts?.WH3 }; }
        const totalPickH = Object.values(hourlyPicks.WH1).reduce((a,b)=>a+b,0) + Object.values(hourlyPicks.WH2).reduce((a,b)=>a+b,0) + Object.values(hourlyPicks.WH3).reduce((a,b)=>a+b,0);
        console.log(`[ItemPath] Loaded daily totals from disk: picks WH1=${dailyPickTotals.WH1} WH2=${dailyPickTotals.WH2} WH3=${dailyPickTotals.WH3}, puts WH1=${dailyPutTotals.WH1} WH2=${dailyPutTotals.WH2}, hourly entries=${totalPickH}`);
      } else {
        console.log(`[ItemPath] Saved totals are from ${saved.date}, today is ${today} — starting fresh`);
      }
    }
  } catch(e) {
    console.log(`[ItemPath] Could not load daily totals: ${e.message}`);
  }
}

// Save to disk after every change
function saveDailyTotals() {
  try {
    const dir = path.dirname(DAILY_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(DAILY_FILE, JSON.stringify({
      date: dailyPickTotals.date,
      picks: { WH1: dailyPickTotals.WH1, WH2: dailyPickTotals.WH2, WH3: dailyPickTotals.WH3 },
      puts: { WH1: dailyPutTotals.WH1, WH2: dailyPutTotals.WH2, WH3: dailyPutTotals.WH3 },
      hourlyPicks,
      hourlyPuts,
      savedAt: new Date().toISOString(),
    }));
  } catch(e) { /* ignore write errors */ }
}

function resetDailyIfNeeded() {
  const today = new Date().toISOString().substring(0, 10);
  if (dailyPickTotals.date !== today) {
    dailyPickTotals = { WH1: 0, WH2: 0, WH3: 0, date: today };
    dailyPutTotals = { WH1: 0, WH2: 0, WH3: 0, date: today };
    hourlyPicks = { WH1: emptyHourly(), WH2: emptyHourly(), WH3: emptyHourly() };
    hourlyPuts = { WH1: emptyHourly(), WH2: emptyHourly(), WH3: emptyHourly() };
    previousOrderMap.clear();
    saveDailyTotals();
    console.log(`[ItemPath] Daily pick/put counters reset for ${today}`);
  }
}

function isPutOrder(order) {
  const ref = (order.reference || order.name || '').toLowerCase();
  return ref.includes('put');
}

function trackCompletedOrders(currentOrders) {
  resetDailyIfNeeded();
  const currentIds = new Set(currentOrders.map(o => o.orderId || o.id));

  // Orders that were in previous poll but not in current = completed
  const hour = new Date().getHours();
  let completedPicks = 0;
  let completedPuts = 0;
  if (previousOrderMap.size > 0) {
    for (const [orderId, info] of previousOrderMap) {
      if (!currentIds.has(orderId)) {
        const wh = info.warehouse;
        if (wh === 'WH1' || wh === 'WH2' || wh === 'WH3') {
          if (info.isPut) {
            dailyPutTotals[wh] += info.lineCount;
            hourlyPuts[wh][hour] = (hourlyPuts[wh][hour] || 0) + info.lineCount;
            completedPuts += info.lineCount;
          } else {
            dailyPickTotals[wh] += 1;
            hourlyPicks[wh][hour] = (hourlyPicks[wh][hour] || 0) + 1;
            completedPicks += 1;
          }
        }
      }
    }
  }

  if (completedPicks > 0) {
    console.log(`[ItemPath] +${completedPicks} completed picks (WH1: ${dailyPickTotals.WH1}, WH2: ${dailyPickTotals.WH2}, WH3: ${dailyPickTotals.WH3})`);
  }
  if (completedPuts > 0) {
    console.log(`[ItemPath] +${completedPuts} completed puts (WH1: ${dailyPutTotals.WH1}, WH2: ${dailyPutTotals.WH2}, WH3: ${dailyPutTotals.WH3})`);
  }
  if (completedPicks > 0 || completedPuts > 0) {
    saveDailyTotals();
  }

  // Update map with current orders
  previousOrderMap.clear();
  for (const o of currentOrders) {
    const id = o.orderId || o.id;
    const rawWh = o.warehouseName || o.warehouse || 'Unknown';
    const normWh = /kitchen/i.test(rawWh) || /wh3/i.test(rawWh) ? 'WH3' : /wh2/i.test(rawWh) ? 'WH2' : /wh1/i.test(rawWh) ? 'WH1' : rawWh;
    previousOrderMap.set(id, {
      warehouse: normWh,
      lineCount: (o.order_lines || []).reduce((sum, l) => sum + (parseFloat(l.quantity) || 0), 0) || (o.lines || []).length || 3,
      reference: o.reference || o.name,
      isPut: isPutOrder(o),
    });
  }
}

// Load on module init
loadDailyTotals();

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CACHE — updated every poll cycle
// Track last successful pick sync time — used for order_lines modifiedDate[gte]
// On startup, default to 10 minutes ago — import covers historical data
let lastPickSyncTime = new Date(Date.now() - 10 * 60 * 1000).toISOString();

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
// FETCH WRAPPER — timeout + error handling + payload logging
// ─────────────────────────────────────────────────────────────────────────────
async function ipFetch(endpointPath, params = {}) {
  const url = new URL(`${CONFIG.baseUrl}${endpointPath}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30000),  // 30s timeout (was 120s — fail fast)
  });

  if (!resp.ok) {
    throw new Error(`ItemPath ${endpointPath} → HTTP ${resp.status}`);
  }

  const text = await resp.text();
  const sizeKB = (text.length / 1024).toFixed(1);
  const sizeMB = (text.length / (1024 * 1024)).toFixed(2);
  const label = text.length > 1048576 ? `${sizeMB} MB` : `${sizeKB} KB`;
  console.log(`[ItemPath] ${endpointPath}${url.search} → ${label}`);

  return JSON.parse(text);
}

// ─────────────────────────────────────────────────────────────────────────────
// LOCATIONS CACHE — reference data, refreshes every 60 minutes (not every poll)
// ─────────────────────────────────────────────────────────────────────────────
let locationsCache = { locations: [], loadedAt: 0 };
const LOCATIONS_CACHE_TTL = 60 * 60 * 1000; // 60 minutes

async function getLocationsData() {
  const age = Date.now() - locationsCache.loadedAt;
  if (locationsCache.locations.length > 0 && age < LOCATIONS_CACHE_TTL) {
    console.log(`[ItemPath] Locations: using cache (${locationsCache.locations.length} locations, age ${Math.round(age/60000)}m)`);
    return locationsCache.locations;
  }
  console.log(`[ItemPath] Locations: refreshing cache (age ${Math.round(age/60000)}m)`);
  const resp = await ipFetch('/api/locations', { limit: 20000 });
  locationsCache.locations = resp.locations || [];
  locationsCache.loadedAt = Date.now();
  return locationsCache.locations;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZE — map ItemPath API response shapes to Lab_Assistant internal format
// ─────────────────────────────────────────────────────────────────────────────

// Derive warehouse from location name:
//   CAR-1, CAR-2, CAR-3 → WH1
//   CAR-4, CAR-5, CAR-6 → WH2
//   KITCHEN* → WH3 (Lens Kitchen, extended inventory)
//   IRV02* → WH3 (Irvine 2 inventory, extended inventory)
function deriveWarehouse(location) {
  if (!location) return null;
  const carMatch = location.match(/^CAR-(\d+)/i);
  if (carMatch) {
    const num = parseInt(carMatch[1]);
    return num <= 3 ? 'WH1' : 'WH2';
  }
  if (/^KITCHEN/i.test(location)) return 'WH3';
  if (/^IRV/i.test(location)) return 'WH3';
  return null;
}

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
    warehouse:    deriveWarehouse(m.location || m.bin || null),
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
  const ref = (o.reference || o.name || '').toLowerCase();
  return {
    orderId:   o.id,
    reference: o.reference || o.name,
    isPut:     ref.includes('put'),  // true = receiving INTO Kardex, false = consumption OUT
    status:    o.status,
    warehouse: /kitchen/i.test(o.warehouseName || '') || /wh3/i.test(o.warehouseName || '') ? 'WH3' : /wh2/i.test(o.warehouseName || '') ? 'WH2' : /wh1/i.test(o.warehouseName || '') ? 'WH1' : (o.warehouseName || null),
    station:   o.stationName || null,  // Station/area where order is processed
    startedAt: o.modifiedDate || o.created_at || o.started_at,
    hasStock:  o.hasStock,
    lines:     lines.map(l => ({
      sku:         l.materialName || l.material_code || l.sku,
      name:        l.Info3 ? `${l.Info3} ${l.Info1 || ''}`.trim() : (l.materialName || l.material_name || l.name),
      qty:         parseFloat(l.quantity) || 0,
      picked:      parseFloat(l.quantity_picked || l.picked || 0),
      pending:     Math.max(0, (parseFloat(l.quantity)||0) - (parseFloat(l.quantity_picked||0))),
      rxInfo:      l.Info1 || null,  // e.g., "R: -0.88  -0.55  89  225"
      sizing:      l.Info2 || null,  // e.g., "30.5  28.0  3.4  19.4  -----"
      // Put Wall destination fields
      putLocation: l.putLocation || null,   // Put Wall position (e.g., "P01", "P23")
      putBinName:  l.putBinName || null,    // Put Wall bin/slot
      putHeight:   l.putHeight || null,     // Put Wall height (if multi-level)
      // Pick source fields
      pickLocation: l.pickLocation || null,  // Kardex location
      pickBinName:  l.pickBinName || null,   // Kardex bin
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
    completedAt: t.completed_at || t.created_at || t.creationDate || t.creation_date,
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
let pollCount = 0;
let cachedMaterialsResp = null;

async function poll() {
  if (CONFIG.mockMode) {
    loadMockData();
    return;
  }

  pollCount++;

  try {
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const todayPrefix = todayStart.substring(0, 10);

    const pollStart = Date.now();

    // Materials: refresh every 10 minutes to keep qty current.
    // Single API call (~10K items) — not heavy like location_contents (20K records).
    const materialsStale = !cachedMaterialsResp || (pollCount % 10 === 0);
    if (materialsStale) {
      console.log(`[ItemPath] Poll #${pollCount} — fetching materials catalog...`);
      try {
        // Use longer timeout for initial heavy load
        const matUrl = new URL(`${CONFIG.baseUrl}/api/materials`);
        matUrl.searchParams.set('limit', '10000');
        const matResp = await fetch(matUrl.toString(), {
          headers: authHeaders(),
          signal: AbortSignal.timeout(120000),  // 2 minutes for initial load
        });
        if (!matResp.ok) throw new Error(`HTTP ${matResp.status}`);
        cachedMaterialsResp = await matResp.json();
        console.log(`[ItemPath] Materials loaded: ${(cachedMaterialsResp.materials || []).length} items`);
      } catch (e) {
        console.error(`[ItemPath] Materials fetch failed: ${e.message} — will retry next poll`);
        cachedMaterialsResp = null; // retry on next poll
      }
    }
    const materialsResp = cachedMaterialsResp || { materials: [] };

    // Light calls every 60s: orders + transactions only
    const [ordersResp, txResp, pickTxResp, putTxResp, warehousesResp] = await Promise.all([
      ipFetch('/api/orders',    { limit: 200, status: 'In Process' }),
      ipFetch('/api/transactions', { after: todayStart, limit: 200 }).catch(() => ({ transactions: [] })),
      ipFetch('/api/transactions', { type: 4, after: todayStart, limit: 500 }).catch(() => ({ transactions: [] })),
      ipFetch('/api/transactions', { type: 3, after: todayStart, limit: 500 }).catch(() => ({ transactions: [] })),
      ipFetch('/api/warehouses').catch(() => ({ warehouses: [] })),
    ]);
    // Locations: cached for 60 min — reference data that rarely changes
    const locationsData = await getLocationsData().catch(() => []);
    const locationsResp = { locations: locationsData };

    // Location contents: refresh every 30 minutes. Heavy call (20K records).
    let locationContentsResp = { contents: cache.locationContents || [] };
    const lcStale = !(cache.locationContents && cache.locationContents.length > 0) || (pollCount % 30 === 0);
    if (lcStale) {
      console.log(`[ItemPath] Poll #${pollCount} — fetching location contents...`);
      try {
        const lcUrl = new URL(`${CONFIG.baseUrl}/api/location_contents`);
        lcUrl.searchParams.set('limit', '20000');
        const lcResp = await fetch(lcUrl.toString(), {
          headers: authHeaders(),
          signal: AbortSignal.timeout(120000),  // 2 minutes
        });
        if (!lcResp.ok) throw new Error(`HTTP ${lcResp.status}`);
        locationContentsResp = await lcResp.json();
        console.log(`[ItemPath] Location contents loaded: ${(locationContentsResp.contents || []).length} records`);
      } catch (e) {
        console.error(`[ItemPath] Location contents fetch failed: ${e.message}`);
        locationContentsResp = { contents: [] };
      }
    }

    const fetchMs = Date.now() - pollStart;
    console.log(`[ItemPath] All fetches completed in ${fetchMs}ms`);

    const rawMaterials = materialsResp.materials || materialsResp.data || materialsResp || [];
    const materials   = rawMaterials.map(normalizeMaterial);

    // Filter orders by "In Process" status (active picks)
    const allOrders   = (ordersResp.orders || ordersResp.data || ordersResp || []);
    const activeOrders = allOrders.filter(o => o.status === 'In Process');

    // Track completed orders incrementally (orders that disappear between polls = completed picks/puts)
    trackCompletedOrders(allOrders);

    const activePicks = activeOrders.map(normalizeOrder);

    const recentTx    = (txResp.transactions || txResp.data || txResp || []).map(normalizeTransaction);
    const pickTxList  = (pickTxResp.transactions || pickTxResp.data || pickTxResp || []);
    const putTxList   = (putTxResp.transactions || putTxResp.data || putTxResp || []);
    const alerts      = detectAlerts(materials);
    const warehouses  = (warehousesResp.warehouses || []).map(w => ({ id: w.id, name: w.name }));

    // DEBUG: Log Kitchen/manual pick info from all data sources
    const kitchenOrders = allOrders.filter(o => /kitchen/i.test(o.warehouseName || '') || /manual/i.test(o.reference || o.name || ''));
    const kitchenTx = pickTxList.filter(tx => /kitchen/i.test(tx.warehouseName || '') || /manual/i.test(tx.orderName || ''));
    const kitchenRecentTx = recentTx.filter(tx => /kitchen/i.test(tx.picker || '') || /manual/i.test(tx.orderId || ''));
    if (kitchenOrders.length > 0 || kitchenTx.length > 0) {
      console.log(`[ItemPath] KITCHEN DEBUG: ${kitchenOrders.length} active orders, ${kitchenTx.length} pick txns`);
      if (kitchenOrders.length > 0) console.log(`[ItemPath] KITCHEN order sample: wh="${kitchenOrders[0].warehouseName}" ref="${kitchenOrders[0].reference || kitchenOrders[0].name}" status="${kitchenOrders[0].status}"`);
      if (kitchenTx.length > 0) console.log(`[ItemPath] KITCHEN tx sample: wh="${kitchenTx[0].warehouseName}" order="${kitchenTx[0].orderName}" date="${kitchenTx[0].creationDate}"`);
    } else {
      // Check if ANY warehouse names contain kitchen-like strings in the full tx list
      const allWhNames = [...new Set(pickTxList.map(tx => tx.warehouseName).filter(Boolean))];
      const allOrderWhNames = [...new Set(allOrders.map(o => o.warehouseName).filter(Boolean))];
      console.log(`[ItemPath] KITCHEN DEBUG: 0 kitchen orders, 0 kitchen txns. Order warehouses: [${allOrderWhNames.join(', ')}] Tx warehouses: [${allWhNames.join(', ')}]`);
    }

    // Build hourly stats from transaction data (WH1, WH2, WH3/Lens Kitchen)
    const txHourlyPicks = { WH1: emptyHourly(), WH2: emptyHourly(), WH3: emptyHourly() };
    const txHourlyPuts = { WH1: emptyHourly(), WH2: emptyHourly() };
    let txPicksTotal = { WH1: 0, WH2: 0, WH3: 0 };
    let txPutsTotal = { WH1: 0, WH2: 0 };
    let txManualPicks = 0; // Manual picks from Lens Kitchen (order name ends with M)

    // Picks: count unique jobs (orderName), not individual lines
    // Each job has 2-3 lines (R lens, L lens, frame) — 1 job = 1 pick
    // WH3 = Lens Kitchen / Kardex 3 — manual picks have "M" suffix on order name
    // API already filters to today via `after: todayStart` — no need to re-filter by date
    const seenPickJobs = { WH1: new Map(), WH2: new Map(), WH3: new Map() };
    for (const tx of pickTxList) {
      let wh = tx.warehouseName || 'Unknown';
      // Normalize warehouse names — ItemPath uses "KITCHEN01" for WH3
      if (/kitchen/i.test(wh) || /wh3/i.test(wh)) wh = 'WH3';
      else if (/wh2/i.test(wh)) wh = 'WH2';
      else if (/wh1/i.test(wh)) wh = 'WH1';
      const date = tx.creationDate || '';
      const orderName = tx.orderName || tx.order_name || '';
      if ((wh === 'WH1' || wh === 'WH2' || wh === 'WH3') && orderName) {
        const hr = parseInt((date.substring(11, 13) || String(now.getHours()))) || 0;
        if (!seenPickJobs[wh].has(orderName)) {
          seenPickJobs[wh].set(orderName, hr);
          txHourlyPicks[wh][hr] += 1;
          txPicksTotal[wh] += 1;
          // Track manual picks (ManualPick-KARDEX3-XX pattern)
          if (/ManualPick/i.test(orderName)) txManualPicks += 1;
        }
      }
    }
    // Puts: count by confirmed quantity (each line = X items put away into Kardex)
    // API already filters to today via `after: todayStart`
    for (const tx of putTxList) {
      const wh = tx.warehouseName
        || (tx.orderName && tx.orderName.includes('WH2') ? 'WH2' : null)
        || (tx.orderName && tx.orderName.includes('WH1') ? 'WH1' : null)
        || (tx.locationName && tx.locationName.includes('WH2') ? 'WH2' : 'WH1');
      const date = tx.creationDate || '';
      if (wh === 'WH1' || wh === 'WH2') {
        const hr = parseInt((date.substring(11, 13) || String(now.getHours()))) || 0;
        const qty = Math.abs(parseFloat(tx.quantityConfirmed) || parseFloat(tx.quantity) || 1);
        txHourlyPuts[wh][hr] += qty;
        txPutsTotal[wh] += qty;
      }
    }

    // Pick/put counting: use transaction data if it has results, else incremental
    resetDailyIfNeeded();
    const txPickSum = txPicksTotal.WH1 + txPicksTotal.WH2 + txPicksTotal.WH3;
    const incPickSum = dailyPickTotals.WH1 + dailyPickTotals.WH2;
    const txPutSum = txPutsTotal.WH1 + txPutsTotal.WH2;
    const incPutSum = dailyPutTotals.WH1 + dailyPutTotals.WH2;

    // Log warehouse names from transactions for debugging
    if (pickTxList.length > 0) {
      const whCounts = {};
      for (const tx of pickTxList) {
        const rawWh = tx.warehouseName || 'NULL';
        whCounts[rawWh] = (whCounts[rawWh] || 0) + 1;
      }
      console.log(`[ItemPath] Pick tx warehouse breakdown: ${Object.entries(whCounts).map(([k,v]) => `${k}=${v}`).join(', ')} (${pickTxList.length} total)`);
      // Log any that didn't match WH1/WH2/WH3
      const unmapped = pickTxList.filter(tx => {
        const wh = tx.warehouseName || '';
        return wh !== 'WH1' && wh !== 'WH2' && !/kitchen|lens.kitchen|wh3|irvine.2|irv02/i.test(wh) && !/wh2|warehouse.2/i.test(wh) && !/wh1|warehouse.1/i.test(wh);
      });
      if (unmapped.length > 0) {
        console.log(`[ItemPath] UNMAPPED warehouses (${unmapped.length}): ${[...new Set(unmapped.map(t => t.warehouseName))].join(', ')}`);
        const sample = unmapped[0];
        console.log(`[ItemPath] Sample unmapped: wh="${sample.warehouseName}" order="${sample.orderName}" date="${sample.creationDate}"`);
      }
    }

    // Use transaction count if available, else incremental
    const hourlyStats = txPickSum > 0 ? txHourlyPicks : { WH1: { ...hourlyPicks.WH1 }, WH2: { ...hourlyPicks.WH2 }, WH3: emptyHourly() };
    const hourlyPutStats = txPutSum > 0 ? txHourlyPuts : { WH1: { ...hourlyPuts.WH1 }, WH2: { ...hourlyPuts.WH2 } };
    const finalPicks = txPickSum > 0 ? txPicksTotal : { WH1: dailyPickTotals.WH1, WH2: dailyPickTotals.WH2, WH3: 0 };
    const finalPuts = txPutSum > 0 ? txPutsTotal : { WH1: dailyPutTotals.WH1, WH2: dailyPutTotals.WH2 };

    // Log unique warehouse names for debugging
    const whNames = new Set(pickTxList.map(tx => tx.warehouseName).filter(Boolean));
    console.log(`[ItemPath] Picks: tx=${txPickSum} (WH1:${txPicksTotal.WH1} WH2:${txPicksTotal.WH2} WH3/Kitchen:${txPicksTotal.WH3} manual:${txManualPicks}), inc=${incPickSum}, using ${txPickSum > 0 ? 'txn' : 'incremental'} (${pickTxList.length} tx lines, warehouses: ${[...whNames].join(', ')})`);
    console.log(`[ItemPath] Puts: tx=${txPutSum}, inc=${incPutSum}, using ${txPutSum > 0 ? 'txn' : 'incremental'} (${putTxList.length} tx lines)`);

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

    // Set today's picks and puts (best of transaction data vs incremental tracking)
    if (warehouseStats.WH1) { warehouseStats.WH1.todayPicks = finalPicks.WH1; warehouseStats.WH1.todayPuts = finalPuts.WH1; }
    if (warehouseStats.WH2) { warehouseStats.WH2.todayPicks = finalPicks.WH2; warehouseStats.WH2.todayPuts = finalPuts.WH2; }

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

    // Build per-SKU warehouse stock from locations data
    // Locations have: name (e.g. "CAR-6/Shelf 058/Pos 01"), materialName, currentQuantity
    // Build per-SKU warehouse stock from location_contents API
    // This gives us materialId + warehouseName + currentQuantity per location
    const locationContents = locationContentsResp.contents || [];
    const warehouseStock = { WH1: {}, WH2: {}, WH3: {} };

    // Build materialId → SKU name lookup from materials
    const matIdToSku = {};
    for (const m of rawMaterials) {
      matIdToSku[m.id] = m.name; // m.name = OPC code (SKU)
    }

    for (const lc of locationContents) {
      const qty = parseFloat(lc.currentQuantity) || 0;
      const wh = lc.warehouseName || 'WH1';
      const materialId = lc.materialId;
      const sku = matIdToSku[materialId] || materialId;
      if (qty <= 0) continue;

      if (!warehouseStock[wh]) warehouseStock[wh] = {};
      if (!warehouseStock[wh][sku]) warehouseStock[wh][sku] = 0;
      warehouseStock[wh][sku] += qty;
    }

    for (const wh of ['WH1', 'WH2', 'WH3']) {
      const skus = Object.keys(warehouseStock[wh] || {}).length;
      const total = Object.values(warehouseStock[wh] || {}).reduce((s, q) => s + q, 0);
      console.log(`[ItemPath] ${wh}: ${skus} SKUs, ${Math.round(total)} units`);
    }

    cache = {
      materials,
      activePicks,
      recentTransactions: recentTx,
      alerts,
      warehouses,
      warehouseStats,
      warehouseStock,  // per-SKU stock by warehouse from locations
      locationContents, // raw location_contents for binning intelligence
      hourlyStats,
      hourlyPutStats,
      vlmStats,
      carouselStats,  // { 'CAR-1': qty, 'CAR-2': qty, ... }
      locations: normalizedLocations,
      lastSync:   new Date().toISOString(),
      syncStatus: 'ok',
      syncError:  null,
    };

    await sendSlackAlerts(alerts);
    updatePreviousQty(materials);  // Track for next poll's drop detection

    // Log summary with payload sizes
    const cacheSize = JSON.stringify(cache).length;
    const cacheSizeLabel = cacheSize > 1048576 ? `${(cacheSize/1048576).toFixed(1)} MB` : `${(cacheSize/1024).toFixed(0)} KB`;
    const totalMs = Date.now() - pollStart;
    console.log(`[ItemPath] ✓ Sync: ${materials.length} SKUs, ${activePicks.length} active orders, ${alerts.length} alerts, ${normalizedLocations.length} locations | cache=${cacheSizeLabel} | ${totalMs}ms total`);

    // Write to SQLite for AI agent queries
    try {
      const db = require('./db');
      db.upsertInventory(materials);
      db.upsertAlerts(alerts);
      // CRITICAL: Only write actual picks to SQLite — exclude puts (receiving orders)
      // Puts have reference like "ManualPut-..." and inflate consumption calculations
      const picksOnly = activePicks.filter(o => !o.isPut);
      const putsFiltered = activePicks.length - picksOnly.length;
      if (putsFiltered > 0) {
        console.log(`[ItemPath] Filtered ${putsFiltered} put orders from picks (${picksOnly.length} picks written to SQLite)`);
      }
      db.upsertPicks(picksOnly);

      // Record completed picks via /api/order_lines — reliable, paginated, date-filtered
      // Uses modifiedDate[gte] = last sync time so we catch up after downtime
      try {
        let olPage = 0;
        let olTotal = 0;
        let olInserted = 0;
        const olStmt = db.db.prepare(`
          INSERT OR IGNORE INTO picks_history (pick_id, order_id, sku, name, qty, picked, warehouse, completed_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        while (true) {
          const olUrl = new URL(`${CONFIG.baseUrl}/api/order_lines`);
          olUrl.searchParams.set('directionType', '2');  // picks
          olUrl.searchParams.set('status', 'processed');
          olUrl.searchParams.set('modifiedDate[gte]', lastPickSyncTime);
          olUrl.searchParams.set('limit', '1000');
          olUrl.searchParams.set('page', olPage.toString());

          const olResp = await fetch(olUrl.toString(), {
            headers: authHeaders(),
            signal: AbortSignal.timeout(60000),
          });
          if (!olResp.ok) { console.error(`[ItemPath] order_lines HTTP ${olResp.status}`); break; }
          const olData = await olResp.json();
          const lines = olData.order_lines || [];
          if (lines.length === 0) break;
          olTotal += lines.length;

          const olSave = db.db.transaction(() => {
            for (const line of lines) {
              const sku = line.materialName || '';
              const orderName = line.orderName || line.orderId || '';
              const qty = Math.abs(parseFloat(line.quantityConfirmed) || 0);
              if (!sku || qty <= 0) continue;

              let wh = line.warehouseName || line.costCenterName || '';
              if (/kitchen/i.test(wh) || /wh3/i.test(wh)) wh = 'WH3';
              else if (/wh2/i.test(wh)) wh = 'WH2';
              else if (/wh1/i.test(wh)) wh = 'WH1';

              const completedAt = line.modifiedDate || line.creationDate || new Date().toISOString();
              // Use hist- prefix so it matches import format — same ID = same pick
              const pickId = `hist-${line.id || line.orderLineId || ''}`;

              const result = olStmt.run(pickId, orderName, sku, orderName, qty, qty, wh, completedAt);
              if (result.changes > 0) olInserted++;
            }
          });
          olSave();

          if (lines.length < 1000) break; // last page
          olPage++;
          if (olPage > 5) { console.warn('[ItemPath] ⚠️ order_lines pagination hit 5 pages — stopping, will continue next poll'); break; }
          await new Promise(r => setTimeout(r, 3000)); // 3s delay between pages
        }

        if (olTotal > 0) console.log(`[ItemPath] ✓ ${olTotal} order_lines fetched, ${olInserted} new picks recorded`);
        lastPickSyncTime = new Date().toISOString();
      } catch (olErr) {
        console.error('[ItemPath] order_lines pick recording failed:', olErr.message);
        // Don't update lastPickSyncTime — will retry from same point next poll
      }

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
  // No mock data — return empty state with error indicator
  cache = {
    materials: [],
    activePicks: [],
    recentTransactions: [],
    alerts: [{ level: 'CRITICAL', message: 'ItemPath not configured — set ITEMPATH_URL + ITEMPATH_TOKEN in .env' }],
    lastSync:   new Date().toISOString(),
    syncStatus: 'not_configured',
    syncError:  'ITEMPATH_TOKEN not set',
  };
  console.warn('[ItemPath] NOT CONFIGURED — set ITEMPATH_URL + ITEMPATH_TOKEN in .env to get live inventory data');
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
    hourlyStats: cache.hourlyStats || {},
    hourlyPutStats: cache.hourlyPutStats || {},
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
 * Put Wall status - categorizes active picks by destination type
 * ItemPath doesn't provide Put Wall position assignments (that comes from Kardex)
 * but we can categorize orders by destination type:
 *   - Put Wall: stationName is null (routed to Put Wall for automated dispensing)
 *   - Laptop: stationName contains "LAPTOP" (manual pick via laptop)
 *   - Manual: other non-null stationName values
 */
function getPutWall() {
  // Categorize orders by warehouse and destination type
  const stats = {
    WH1: { putWall: [], laptop: [], manual: [], total: 0 },
    WH2: { putWall: [], laptop: [], manual: [], total: 0 },
  };

  for (const pick of cache.activePicks) {
    const wh = pick.warehouse || 'Unknown';
    if (!stats[wh]) continue;  // Only track WH1 and WH2

    const station = pick.station || '';
    const orderSummary = {
      orderId: pick.orderId,
      reference: pick.reference,
      station: pick.station,
      lineCount: pick.lines.length,
      totalQty: pick.lines.reduce((sum, l) => sum + l.qty, 0),
      pendingQty: pick.lines.reduce((sum, l) => sum + l.pending, 0),
      startedAt: pick.startedAt,
    };

    stats[wh].total++;

    if (!station || station === '') {
      // No station = Put Wall destination (automated Kardex dispensing)
      stats[wh].putWall.push(orderSummary);
    } else if (station.toUpperCase().includes('LAPTOP')) {
      // Laptop pick station
      stats[wh].laptop.push(orderSummary);
    } else {
      // Other manual station
      stats[wh].manual.push(orderSummary);
    }
  }

  return {
    WH1: {
      putWallCount: stats.WH1.putWall.length,
      laptopCount: stats.WH1.laptop.length,
      manualCount: stats.WH1.manual.length,
      totalOrders: stats.WH1.total,
      putWallOrders: stats.WH1.putWall,
      // Position data not available from ItemPath - requires Kardex integration
      positions: [],
      positionsAvailable: false,
    },
    WH2: {
      putWallCount: stats.WH2.putWall.length,
      laptopCount: stats.WH2.laptop.length,
      manualCount: stats.WH2.manual.length,
      totalOrders: stats.WH2.total,
      putWallOrders: stats.WH2.putWall,
      positions: [],
      positionsAvailable: false,
    },
    lastSync: cache.lastSync,
    status: cache.syncStatus,
    note: 'Put Wall position assignments require Kardex integration',
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

  // Load ALL data from SQLite FIRST — instant startup, no API wait
  try {
    const db = require('./db');

    // Materials / Inventory
    const existing = db.db.prepare('SELECT * FROM inventory').all();
    if (existing.length > 0) {
      cache.materials = existing.map(row => ({
        id: row.id, sku: row.sku, name: row.name, qty: row.qty || 0,
        qtyAvailable: row.qty_available || 0, unit: row.unit || 'EA',
        location: row.location, warehouse: row.warehouse,
        coatingType: row.coating_type, index: row.material_index,
        reorderPoint: 10, lastUpdated: row.last_sync,
      }));
      cache.lastSync = existing[0]?.last_sync || new Date().toISOString();
      cache.syncStatus = 'ok';

      cachedMaterialsResp = { materials: existing.map(row => ({
        id: row.id, name: row.sku, currentQuantity: row.qty,
        unitOfMeasure: row.unit, location: row.location,
        Info1: row.coating_type, Info3: row.material_index,
        reOrderPoint: 10,
      }))};

      console.log(`[ItemPath] Loaded ${existing.length} materials from SQLite`);
    }

    // Location contents → warehouse stock (from bin_contents table)
    const binRows = db.db.prepare('SELECT * FROM bin_contents WHERE qty > 0').all();
    if (binRows.length > 0) {
      // Rebuild warehouse stock from bin_contents
      const warehouseStock = { WH1: {}, WH2: {}, WH3: {} };
      const matIdToSku = {};
      for (const m of cache.materials) { matIdToSku[m.id] = m.sku; }

      for (const row of binRows) {
        const wh = row.warehouse || 'WH1';
        const sku = row.sku || matIdToSku[row.material_id] || row.material_id;
        if (!warehouseStock[wh]) warehouseStock[wh] = {};
        if (!warehouseStock[wh][sku]) warehouseStock[wh][sku] = 0;
        warehouseStock[wh][sku] += row.qty;
      }

      cache.warehouseStock = warehouseStock;
      cache.locationContents = binRows.map(r => ({
        materialId: r.material_id,
        currentQuantity: r.qty,
        warehouseName: r.warehouse,
        locationName: r.location_name,
      }));

      for (const wh of ['WH1', 'WH2', 'WH3']) {
        const skus = Object.keys(warehouseStock[wh] || {}).length;
        const total = Object.values(warehouseStock[wh] || {}).reduce((s, q) => s + q, 0);
        console.log(`[ItemPath] SQLite ${wh}: ${skus} SKUs, ${Math.round(total)} units`);
      }
    }

    if (existing.length > 0 || binRows.length > 0) {
      console.log(`[ItemPath] Instant startup from SQLite — ready`);
    }
  } catch (e) {
    console.log(`[ItemPath] No SQLite data yet — will fetch from API: ${e.message}`);
  }

  poll();
  setInterval(poll, CONFIG.pollInterval);
}

function getHealth() {
  return {
    connected: cache.syncStatus === 'ok',
    lastSync: cache.lastSync,
    lastError: cache.syncError,
    materials: cache.materials.length,
    status: cache.syncStatus,
  };
}

function setDailyPicks(wh1, wh2) {
  resetDailyIfNeeded();
  dailyPickTotals.WH1 = wh1 || 0;
  dailyPickTotals.WH2 = wh2 || 0;
  saveDailyTotals();
  console.log(`[ItemPath] Daily picks manually set: WH1=${dailyPickTotals.WH1} WH2=${dailyPickTotals.WH2}`);
}

function setDailyPuts(wh1, wh2) {
  resetDailyIfNeeded();
  dailyPutTotals.WH1 = wh1 || 0;
  dailyPutTotals.WH2 = wh2 || 0;
  saveDailyTotals();
  console.log(`[ItemPath] Daily puts manually set: WH1=${dailyPutTotals.WH1} WH2=${dailyPutTotals.WH2}`);
}

function getDailyPicks() {
  resetDailyIfNeeded();
  return { ...dailyPickTotals, hourlyPicks, hourlyPuts };
}

/** Per-SKU stock breakdown by warehouse (WH1=CAR 1-3, WH2=CAR 4-6, WH3=kitchen+IRV) */
function getWarehouseStock() {
  const ws = cache.warehouseStock || { WH1: {}, WH2: {}, WH3: {} };
  const stats = {};
  for (const wh of ['WH1', 'WH2', 'WH3']) {
    const data = ws[wh] || {};
    stats[`${wh.toLowerCase()}_sku_count`] = Object.keys(data).length;
    stats[`${wh.toLowerCase()}_total_units`] = Object.values(data).reduce((s, q) => s + q, 0);
  }
  return {
    WH1: ws.WH1 || {},
    WH2: ws.WH2 || {},
    WH3: ws.WH3 || {},
    ...stats,
    lastSync: cache.lastSync,
  };
}

function getLocationContents() {
  return cache.locationContents || [];
}

module.exports = { start, getInventory, getPicks, getAlerts, getWarehouses, getVLMs, getPutWall, getAIContext, getHealth, setDailyPicks, setDailyPuts, getDailyPicks, getWarehouseStock, getLocationContents };
