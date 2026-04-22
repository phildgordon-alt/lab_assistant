'use strict';

/**
 * Binning Intelligence & Blue Bin Swapping
 *
 * Three pillars:
 * 1. Blue Bin Swap Monitor — bins approaching swap threshold, pre-build recommendations
 * 2. Bin Consolidation — same-SKU partial bins that can be merged
 * 3. Adjacency Optimization — co-picked SKUs on distant shelves, recommend moves
 *
 * Usage in oven-timer-server.js:
 *   const binning = require('./binning-intelligence');
 *   binning.start(itempath);
 *   app.get('/api/inventory/binning/summary', (req, res) => res.json(binning.getSummary()));
 */

const { db } = require('./db');

let lastAnalysis = null;
let analysisInterval = null;
let _binTypeMap = {}; // binKey → { skus: Set, totalQty, carousel, warehouse }

// ─────────────────────────────────────────────────────────────────────────────
// PARSE LOCATION NAMES
// "CAR-3/ Shelf 042/ Position 02- Depth 04" → { carousel: "CAR-3", shelf: "042", position: "02" }
// "KITCHEN01-005/01-06/03" → { carousel: "KITCHEN01", shelf: "005", position: "01-06" }
// ─────────────────────────────────────────────────────────────────────────────
function parseLocation(locationName) {
  if (!locationName) return { carousel: null, shelf: null, position: null, depth: null, binKey: null };

  // CAR-N/ Shelf NNN/ Position NN- Depth NN
  const carMatch = locationName.match(/^(CAR-\d+)\/?.*Shelf\s*(\d+)\/?.*Position\s*(\d+)(?:.*Depth\s*(\d+))?/i);
  if (carMatch) {
    const binKey = `${carMatch[1]}/S${carMatch[2]}/P${carMatch[3]}`; // without depth
    return { carousel: carMatch[1], shelf: carMatch[2], position: carMatch[3], depth: carMatch[4] || null, binKey };
  }

  // KITCHEN01-XXX/YY-ZZ/WW
  const kitMatch = locationName.match(/^(KITCHEN\d+|IRV\d+)/i);
  if (kitMatch) {
    return { carousel: kitMatch[1], shelf: locationName, position: null, depth: null, binKey: locationName };
  }

  return { carousel: locationName.split('/')[0]?.trim(), shelf: null, position: null, depth: null, binKey: locationName };
}

// ─────────────────────────────────────────────────────────────────────────────
// REBUILD BIN CONTENTS from location_contents API data
// ─────────────────────────────────────────────────────────────────────────────
function rebuildBinContents(locationContents, matIdToSku) {
  if (!locationContents || locationContents.length === 0) return;

  const now = new Date().toISOString();

  db.prepare('DELETE FROM bin_contents').run();

  const insert = db.prepare(`
    INSERT INTO bin_contents (location_name, carousel, shelf, position, warehouse, material_id, sku, qty, last_sync)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((items) => {
    for (const lc of items) {
      const qty = parseFloat(lc.currentQuantity) || 0;
      if (qty <= 0) continue;

      const parsed = parseLocation(lc.locationName);
      const sku = matIdToSku[lc.materialId] || lc.materialId;

      insert.run(
        lc.locationName,
        parsed.carousel,
        parsed.shelf,
        parsed.position,
        lc.warehouseName || 'WH1',
        lc.materialId,
        sku,
        qty,
        now
      );
    }
  });

  // Also build bin_key → sku_count mapping for bin type classification
  // bin_key = carousel/shelf/position (without depth)
  const binSkuMap = {};
  for (const lc of locationContents) {
    const qty = parseFloat(lc.currentQuantity) || 0;
    if (qty <= 0) continue;
    const parsed = parseLocation(lc.locationName);
    if (!parsed.binKey) continue;
    const sku = matIdToSku[lc.materialId] || lc.materialId;
    if (!binSkuMap[parsed.binKey]) binSkuMap[parsed.binKey] = { skus: new Set(), totalQty: 0, carousel: parsed.carousel, warehouse: lc.warehouseName || 'WH1' };
    binSkuMap[parsed.binKey].skus.add(sku);
    binSkuMap[parsed.binKey].totalQty += qty;
  }

  // Store bin type summary globally for queries
  _binTypeMap = binSkuMap;

  insertMany(locationContents);
  console.log(`[Binning] Rebuilt bin_contents: ${locationContents.length} records`);
}

// ─────────────────────────────────────────────────────────────────────────────
// PILLAR 1: Blue Bin Swap Analysis
// Find bins approaching swap threshold based on consumption rate
// ─────────────────────────────────────────────────────────────────────────────
function analyzeSwapThresholds(daysThreshold = 3) {
  // Get current bin contents grouped by location
  const bins = db.prepare(`
    SELECT carousel, shelf, position, warehouse, sku,
           SUM(qty) as qty, location_name,
           COUNT(DISTINCT sku) as sku_count
    FROM bin_contents
    WHERE carousel LIKE 'CAR-%'
    GROUP BY location_name
    ORDER BY qty ASC
  `).all();

  // Get consumption rates from picks_history (last 14 days). Use substr(col,1,10)
  // for PT-local date distinction; date(col) evaluates in UTC and over-counts
  // active_days when evening picks straddle UTC midnight.
  const consumption = db.prepare(`
    SELECT sku, SUM(qty) as total_consumed,
           COUNT(DISTINCT substr(completed_at, 1, 10)) as active_days,
           ROUND(CAST(SUM(qty) AS REAL) / NULLIF(COUNT(DISTINCT substr(completed_at, 1, 10)), 0), 2) as daily_rate
    FROM picks_history
    WHERE completed_at >= datetime('now', '-14 days')
    GROUP BY sku
    HAVING daily_rate > 0
  `).all();

  const rateMap = {};
  for (const c of consumption) rateMap[c.sku] = c;

  const urgent = [];
  const upcoming = [];

  for (const bin of bins) {
    const rate = rateMap[bin.sku];
    if (!rate) continue;

    const daysOfSupply = rate.daily_rate > 0 ? Math.round(bin.qty / rate.daily_rate * 10) / 10 : null;
    if (daysOfSupply === null) continue;

    // Look up bin type from binTypeMap (keyed without depth)
    const parsed = parseLocation(bin.location_name);
    const binInfo = parsed.binKey ? _binTypeMap[parsed.binKey] : null;
    const binSkuCount = binInfo ? binInfo.skus.size : 1;
    const binType = binSkuCount === 1 ? 'full' : binSkuCount === 2 ? 'half' : binSkuCount <= 4 ? 'quarter' : 'mixed';

    const entry = {
      sku: bin.sku,
      location: bin.location_name,
      carousel: bin.carousel,
      shelf: bin.shelf,
      warehouse: bin.warehouse,
      qty: bin.qty,
      daily_rate: rate.daily_rate,
      days_of_supply: daysOfSupply,
      sku_count: bin.sku_count,
      bin_type: binType,
    };

    if (daysOfSupply <= daysThreshold) {
      urgent.push(entry);
    } else if (daysOfSupply <= daysThreshold * 2) {
      upcoming.push(entry);
    }
  }

  // Pre-build recommendations for Kitchen
  // Build type matches existing bin — you replace a full with a full, half with half, etc.
  const prebuildList = urgent.map(b => ({
    sku: b.sku,
    qty_needed: Math.ceil(b.daily_rate * 7), // 1 week supply
    current_qty: b.qty,
    daily_rate: b.daily_rate,
    days_left: b.days_of_supply,
    bin_type: b.bin_type,
    carousel: b.carousel,
  }));

  return {
    urgent,
    upcoming,
    prebuild_list: prebuildList,
    summary: {
      bins_near_swap: urgent.length,
      bins_upcoming: upcoming.length,
      skus_to_prebuild: [...new Set(prebuildList.map(p => p.sku))].length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PILLAR 2: Bin Consolidation
// Find same-SKU partial bins that can be merged
// ─────────────────────────────────────────────────────────────────────────────
function findConsolidationOpportunities() {
  // Find SKUs that appear in multiple locations within production carousels
  const multiLocation = db.prepare(`
    SELECT sku, COUNT(DISTINCT location_name) as bin_count,
           SUM(qty) as total_qty,
           GROUP_CONCAT(DISTINCT carousel) as carousels,
           GROUP_CONCAT(location_name || ':' || CAST(qty AS TEXT), ' | ') as locations
    FROM bin_contents
    WHERE carousel LIKE 'CAR-%'
    GROUP BY sku
    HAVING bin_count > 1
    ORDER BY bin_count DESC
  `).all();

  const opportunities = multiLocation.map(row => {
    const locations = row.locations.split(' | ').map(l => {
      const [loc, qty] = l.split(':');
      return { location: loc, qty: parseFloat(qty) || 0 };
    });

    // Calculate how many bins we could consolidate to
    // Simple: if total fits in fewer bins (assume ~20 per full bin)
    const currentBins = locations.length;
    const targetBins = Math.max(1, Math.ceil(row.total_qty / 20));
    const shelvesFreed = currentBins - targetBins;

    return {
      sku: row.sku,
      current_bins: currentBins,
      target_bins: targetBins,
      shelves_freed: shelvesFreed > 0 ? shelvesFreed : 0,
      total_qty: row.total_qty,
      carousels: row.carousels,
      locations,
    };
  }).filter(o => o.shelves_freed > 0);

  return {
    opportunities: opportunities.slice(0, 50),
    summary: {
      total_opportunities: opportunities.length,
      total_shelves_freed: opportunities.reduce((s, o) => s + o.shelves_freed, 0),
      skus_affected: opportunities.length,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// PILLAR 3: Adjacency Optimization
// Analyze co-pick patterns and recommend bin moves
// ─────────────────────────────────────────────────────────────────────────────
function analyzePickAdjacency(days = 14, minCoPicks = 5) {
  // Build co-pick sequences from picks_history
  // Find orders where multiple SKUs were picked close together in time
  const picks = db.prepare(`
    SELECT sku, order_id, completed_at, warehouse
    FROM picks_history
    WHERE completed_at >= datetime('now', '-' || ? || ' days')
      AND order_id IS NOT NULL
    ORDER BY order_id, completed_at
  `).all(days);

  // Group by order_id to find co-picked SKUs
  const orderSkus = {};
  for (const pick of picks) {
    if (!pick.order_id) continue;
    if (!orderSkus[pick.order_id]) orderSkus[pick.order_id] = new Set();
    orderSkus[pick.order_id].add(pick.sku);
  }

  // Count co-pick pairs
  const pairCounts = {};
  for (const skuSet of Object.values(orderSkus)) {
    const skus = [...skuSet];
    for (let i = 0; i < skus.length; i++) {
      for (let j = i + 1; j < skus.length; j++) {
        const key = [skus[i], skus[j]].sort().join('|');
        pairCounts[key] = (pairCounts[key] || 0) + 1;
      }
    }
  }

  // Get current bin locations for each SKU
  const skuLocations = db.prepare(`
    SELECT sku, carousel, shelf
    FROM bin_contents
    WHERE carousel LIKE 'CAR-%'
    GROUP BY sku
    ORDER BY qty DESC
  `).all();

  const locationMap = {};
  for (const sl of skuLocations) {
    if (!locationMap[sl.sku]) locationMap[sl.sku] = { carousel: sl.carousel, shelf: sl.shelf };
  }

  // Build recommendations for frequently co-picked SKUs on different carousels/shelves
  const pairs = Object.entries(pairCounts)
    .filter(([, count]) => count >= minCoPicks)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 50)
    .map(([key, count]) => {
      const [skuA, skuB] = key.split('|');
      const locA = locationMap[skuA];
      const locB = locationMap[skuB];

      const sameCarousel = locA && locB && locA.carousel === locB.carousel;
      const sameShelf = sameCarousel && locA.shelf === locB.shelf;

      return {
        sku_a: skuA,
        sku_b: skuB,
        co_picks: count,
        loc_a: locA ? `${locA.carousel}/Shelf ${locA.shelf}` : 'Unknown',
        loc_b: locB ? `${locB.carousel}/Shelf ${locB.shelf}` : 'Unknown',
        same_carousel: sameCarousel,
        same_shelf: sameShelf,
        action: !locA || !locB ? 'unknown' :
                sameShelf ? 'optimal' :
                sameCarousel ? 'move_adjacent_shelf' :
                'move_same_carousel',
      };
    });

  const moveRecommendations = pairs.filter(p => p.action !== 'optimal' && p.action !== 'unknown');

  return {
    pairs,
    move_recommendations: moveRecommendations,
    summary: {
      pairs_analyzed: Object.keys(pairCounts).length,
      frequent_pairs: pairs.length,
      move_recommendations: moveRecommendations.length,
      days_analyzed: days,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMBINED SUMMARY
// ─────────────────────────────────────────────────────────────────────────────
function getSummary() {
  const swap = analyzeSwapThresholds();
  const consolidation = findConsolidationOpportunities();
  const adjacency = analyzePickAdjacency();

  // Bin utilization stats
  const utilization = db.prepare(`
    SELECT warehouse, carousel,
           COUNT(*) as total_bins,
           SUM(qty) as total_units,
           COUNT(DISTINCT sku) as unique_skus
    FROM bin_contents
    GROUP BY warehouse, carousel
    ORDER BY carousel
  `).all();

  const binTypes = getBinTypes();

  return {
    swap: swap.summary,
    consolidation: consolidation.summary,
    adjacency: adjacency.summary,
    binTypes: binTypes.summary,
    byCarousel: binTypes.byCarousel,
    utilization,
    lastAnalysis,
  };
}

function getSwapAnalysis(carousel) {
  const result = analyzeSwapThresholds();
  if (carousel) {
    result.urgent = result.urgent.filter(b => b.carousel === carousel);
    result.upcoming = result.upcoming.filter(b => b.carousel === carousel);
    result.prebuild_list = result.prebuild_list.filter(b => b.carousel === carousel);
  }
  return result;
}

function getConsolidation(warehouse) {
  const result = findConsolidationOpportunities();
  if (warehouse) {
    result.opportunities = result.opportunities.filter(o => o.carousels.includes(warehouse));
  }
  return result;
}

function getAdjacency(days, minCoPicks) {
  return analyzePickAdjacency(days || 14, minCoPicks || 5);
}

// ─────────────────────────────────────────────────────────────────────────────
// BIN TYPE ANALYSIS
// Classify each physical bin position as full/half/quarter
// ─────────────────────────────────────────────────────────────────────────────
function getBinTypes(carousel) {
  const bins = [];
  for (const [binKey, info] of Object.entries(_binTypeMap)) {
    if (carousel && info.carousel !== carousel) continue;
    const skuCount = info.skus.size;
    const binType = skuCount === 1 ? 'full' : skuCount === 2 ? 'half' : skuCount <= 4 ? 'quarter' : 'mixed';
    bins.push({
      bin: binKey,
      carousel: info.carousel,
      warehouse: info.warehouse,
      sku_count: skuCount,
      bin_type: binType,
      skus: [...info.skus],
      total_qty: info.totalQty,
    });
  }

  bins.sort((a, b) => b.sku_count - a.sku_count);

  const summary = {
    total_bins: bins.length,
    full: bins.filter(b => b.bin_type === 'full').length,
    half: bins.filter(b => b.bin_type === 'half').length,
    quarter: bins.filter(b => b.bin_type === 'quarter').length,
    mixed: bins.filter(b => b.bin_type === 'mixed').length,
  };

  // Group by carousel for overview
  const byCarousel = {};
  for (const b of bins) {
    if (!byCarousel[b.carousel]) byCarousel[b.carousel] = { full: 0, half: 0, quarter: 0, mixed: 0, total: 0 };
    byCarousel[b.carousel][b.bin_type]++;
    byCarousel[b.carousel].total++;
  }

  return { bins: bins.slice(0, 100), summary, byCarousel };
}

function getRecommendations(type) {
  let sql = 'SELECT * FROM binning_recommendations WHERE status = ?';
  const params = ['pending'];
  if (type) {
    sql += ' AND type = ?';
    params.push(type);
  }
  sql += ' ORDER BY created_at DESC LIMIT 50';
  return db.prepare(sql).all(...params);
}

function acknowledgeRecommendation(id, status) {
  db.prepare('UPDATE binning_recommendations SET status = ?, resolved_at = datetime(?) WHERE id = ?')
    .run(status, new Date().toISOString(), id);
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// START — called from oven-timer-server.js after ItemPath adapter starts
// ─────────────────────────────────────────────────────────────────────────────
function start(itempath) {
  console.log('[Binning] Starting binning intelligence');

  // Rebuild bin contents whenever ItemPath polls (every 60s)
  // The itempath adapter stores locationContents in cache
  const rebuild = () => {
    try {
      const ws = itempath.getWarehouseStock();
      const lc = itempath.getLocationContents ? itempath.getLocationContents() : null;
      if (lc && lc.length > 0) {
        // Build materialId → SKU map from inventory
        const inventory = itempath.getInventory();
        const matIdToSku = {};
        for (const m of (inventory.materials || [])) {
          matIdToSku[m.id] = m.sku;
        }
        rebuildBinContents(lc, matIdToSku);
        lastAnalysis = new Date().toISOString();
      }
    } catch (e) {
      console.error(`[Binning] Rebuild error: ${e.message}`);
    }
  };

  // Run initial analysis after a delay (let ItemPath poll first)
  setTimeout(rebuild, 90000);
  // Then every 5 minutes
  analysisInterval = setInterval(rebuild, 300000);
}

module.exports = {
  start,
  rebuildBinContents,
  getSummary,
  getSwapAnalysis,
  getConsolidation,
  getAdjacency,
  getBinTypes,
  getRecommendations,
  acknowledgeRecommendation,
};
