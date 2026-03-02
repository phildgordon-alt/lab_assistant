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
  // Customize these to match your actual reorder points
  lowStockThresholds: {
    'AR':           30,   // AR coating blanks
    'BLUE_CUT':     20,
    'HARD_COAT':    25,
    'MIRROR':       15,
    'POLARIZED':    20,
    'TRANSITIONS':  20,
    'PREMIUM_AR':   15,
    'DEFAULT':      10,   // fallback for any SKU not listed above
  },

  // Slack webhook for low stock alerts (optional — same one used for oven timer)
  slackWebhook: process.env.SLACK_WEBHOOK || '',
};

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CACHE — updated every poll cycle
// ─────────────────────────────────────────────────────────────────────────────
let cache = {
  materials:        [],   // normalized inventory: { sku, name, qty, unit, location, coatingType, rxSpec, lastUpdated }
  activePicks:      [],   // active orders in progress: { orderId, sku, name, qty, picker, startedAt, status }
  recentTransactions: [], // completed picks last 2hrs: { id, sku, qty, type, completedAt, picker }
  alerts:           [],   // low stock alerts: { sku, name, qty, threshold, severity }
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
    signal: AbortSignal.timeout(8000),
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
  // material.name / material.code / material.quantity / material.unit
  // material.properties = array of { name, value } custom fields
  // We look for properties like "coating_type", "rx_sphere", "rx_cylinder", "index"
  const props = {};
  (m.properties || []).forEach(p => { props[p.name?.toLowerCase().replace(/\s+/g,'_')] = p.value; });

  return {
    id:           m.id,
    sku:          m.code || m.id,
    name:         m.name,
    qty:          parseFloat(m.quantity) || 0,
    unit:         m.unit || 'EA',
    location:     m.location || m.bin || null,
    coatingType:  props['coating_type'] || props['coating'] || null,
    index:        props['index'] || props['lens_index'] || null,
    rxSphere:     props['sphere'] || props['rx_sphere'] || null,
    rxCylinder:   props['cylinder'] || props['rx_cylinder'] || null,
    rxAdd:        props['add'] || props['rx_add'] || null,
    rawProps:     props,
    lastUpdated:  new Date().toISOString(),
  };
}

function normalizeOrder(o) {
  return {
    orderId:   o.id,
    reference: o.reference || o.name,
    status:    o.status,
    startedAt: o.created_at || o.started_at,
    lines:     (o.lines || []).map(l => ({
      sku:     l.material_code || l.sku,
      name:    l.material_name || l.name,
      qty:     parseFloat(l.quantity) || 0,
      picked:  parseFloat(l.quantity_picked || l.picked || 0),
      pending: Math.max(0, (parseFloat(l.quantity)||0) - (parseFloat(l.quantity_picked||0))),
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
// ─────────────────────────────────────────────────────────────────────────────
let lastAlertSkus = new Set();

async function sendSlackAlerts(alerts) {
  if (!CONFIG.slackWebhook) return;
  const newAlerts = alerts.filter(a =>
    (a.severity === 'CRITICAL' || a.severity === 'HIGH') && !lastAlertSkus.has(a.sku)
  );
  if (!newAlerts.length) return;

  const lines = newAlerts.map(a => {
    const icon = a.severity === 'CRITICAL' ? '🔴' : '🟠';
    return `${icon} *${a.name}* (${a.sku}) — ${a.qty} remaining (threshold: ${a.threshold})`;
  });

  try {
    await fetch(CONFIG.slackWebhook, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: `*⚠ Kardex Low Stock Alert*\n${lines.join('\n')}`,
      }),
    });
  } catch (e) {
    console.warn('[ItemPath] Slack alert failed:', e.message);
  }

  newAlerts.forEach(a => lastAlertSkus.add(a.sku));
  // Reset seen set each hour so alerts can re-fire
  setTimeout(() => { lastAlertSkus = new Set(); }, 3600000);
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN POLL — fetches all three endpoints in parallel
// ─────────────────────────────────────────────────────────────────────────────
async function poll() {
  if (CONFIG.mockMode) {
    loadMockData();
    return;
  }

  try {
    const twoHrsAgo = new Date(Date.now() - 2 * 3600 * 1000).toISOString();

    // Parallel fetch — materials, active orders, recent transactions
    const [materialsResp, ordersResp, txResp] = await Promise.all([
      ipFetch('/api/materials', { limit: 1000 }),
      ipFetch('/api/orders',    { status: 'in_progress', limit: 200 }),
      ipFetch('/api/transactions', { after: twoHrsAgo, limit: 500 }),
    ]);

    const materials   = (materialsResp.data   || materialsResp  || []).map(normalizeMaterial);
    const activePicks = (ordersResp.data       || ordersResp     || []).map(normalizeOrder);
    const recentTx    = (txResp.data           || txResp         || []).map(normalizeTransaction);
    const alerts      = detectAlerts(materials);

    cache = {
      materials,
      activePicks,
      recentTransactions: recentTx,
      alerts,
      lastSync:   new Date().toISOString(),
      syncStatus: 'ok',
      syncError:  null,
    };

    await sendSlackAlerts(alerts);
    console.log(`[ItemPath] ✓ Sync: ${materials.length} SKUs, ${activePicks.length} active orders, ${alerts.length} alerts`);

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
    materials:  cache.materials,
    lastSync:   cache.lastSync,
    status:     cache.syncStatus,
    error:      cache.syncError,
    alertCount: cache.alerts.length,
  };
}

/** Active picks in progress */
function getPicks() {
  return {
    picks:     cache.activePicks,
    count:     cache.activePicks.length,
    lastSync:  cache.lastSync,
    recent:    cache.recentTransactions.slice(0, 20),
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

module.exports = { start, getInventory, getPicks, getAlerts, findBlank, getAIContext };
