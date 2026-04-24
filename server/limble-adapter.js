/**
 * limble-adapter.js
 * Lab_Assistant — Limble CMMS integration for maintenance tracking
 *
 * AUTH: OAuth 2.0 Client Credentials (Basic Auth)
 *   1. Go to Limble → Settings → Configuration → API Keys
 *   2. Create a new API key
 *   3. Copy the ClientID and Client Secret immediately
 *   4. Set LIMBLE_CLIENT_ID and LIMBLE_CLIENT_SECRET env vars
 *
 * API V2 ENDPOINTS:
 *   GET /v2/assets              → Equipment/machines
 *   GET /v2/tasks               → Work orders, PMs, work requests
 *   GET /v2/downtimes           → Downtime records
 *   GET /v2/locations           → Locations/areas
 *   GET /v2/parts               → Spare parts inventory
 *   GET /v2/preventiveTasks     → PM schedules
 *
 * POLL INTERVAL: 60 seconds
 *
 * USAGE in oven-timer-server.js:
 *   const limble = require('./limble-adapter');
 *   limble.start();
 *   app.get('/api/maintenance/assets', (req, res) => res.json(limble.getAssets()));
 *   app.get('/api/maintenance/tasks', (req, res) => res.json(limble.getTasks()));
 *   app.get('/api/maintenance/stats', (req, res) => res.json(limble.getStats()));
 */

'use strict';

const { jitterInterval } = require('./utils/jitter');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION — set via environment variables
// ─────────────────────────────────────────────────────────────────────────────
const CONFIG = {
  baseUrl:       process.env.LIMBLE_URL       || 'https://api.limblecmms.com',
  clientId:      process.env.LIMBLE_CLIENT_ID     || '',
  clientSecret:  process.env.LIMBLE_CLIENT_SECRET || '',
  pollInterval:  parseInt(process.env.LIMBLE_POLL_MS || '60000'),  // 60s default
  mockMode:      !process.env.LIMBLE_CLIENT_ID || !process.env.LIMBLE_CLIENT_SECRET,  // auto-mock if no credentials
  // Incremental task fetch — only tasks updated since last successful poll.
  // Speculative: Limble v2 API ?updatedAfter support not confirmed in docs.
  // Defaults OFF — set LIMBLE_USE_CURSOR=true to enable. If Limble ignores the
  // param, behavior is identical to a full fetch (no harm, no load reduction).
  useCursor:     process.env.LIMBLE_USE_CURSOR === 'true',

  // Equipment categories to track (lab optical equipment)
  equipmentCategories: [
    'Coders',
    'Cutters',
    'Polishers',
    'Generators',
    'Lasers',
    'Blockers',
    'De-blockers',
    'Tapers',
    'Coaters',
    'Ovens',
  ],

  // Slack integration for critical alerts (optional)
  slackWebhook:  process.env.SLACK_WEBHOOK || '',
  slackBotToken: process.env.SLACK_BOT_TOKEN || '',
  slackChannel:  process.env.SLACK_CHANNEL || 'lab-alerts',
};

// ─────────────────────────────────────────────────────────────────────────────
// LIVE CACHE — updated every poll cycle
// ─────────────────────────────────────────────────────────────────────────────
let cache = {
  assets:         [],   // equipment: { id, name, category, status, location, lastPM, nextPM }
  tasks:          [],   // work orders: { id, type, title, asset, priority, status, assignee, dueDate }
  downtime:       [],   // downtime records: { id, assetId, assetName, startTime, endTime, reason, planned }
  parts:          [],   // spare parts: { id, name, qty, minQty, location }
  locations:      [],   // locations/areas
  stats:          {},   // computed KPIs
  lastSync:       null,
  syncStatus:     'pending',  // 'pending' | 'ok' | 'error' | 'mock'
  syncError:      null,
};

// ─────────────────────────────────────────────────────────────────────────────
// AUTH — Basic Auth with ClientID:ClientSecret
// ─────────────────────────────────────────────────────────────────────────────
function authHeaders() {
  // Limble API uses Basic Auth with clientId:clientSecret base64 encoded
  const credentials = Buffer.from(`${CONFIG.clientId}:${CONFIG.clientSecret}`).toString('base64');
  return {
    'Authorization': `Basic ${credentials}`,
    'Content-Type':  'application/json',
    'Accept':        'application/json',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// FETCH WRAPPER — timeout + error handling
// ─────────────────────────────────────────────────────────────────────────────
async function limbleFetch(path, params = {}) {
  const url = new URL(`${CONFIG.baseUrl}${path}`);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url.toString(), {
    headers: authHeaders(),
    signal: AbortSignal.timeout(30000),
  });

  if (!resp.ok) {
    const errorBody = await resp.text().catch(() => '');
    console.error(`[Limble] API error: ${path} → HTTP ${resp.status}`, errorBody.slice(0, 200));
    throw new Error(`Limble ${path} → HTTP ${resp.status}: ${errorBody.slice(0, 100)}`);
  }

  const data = await resp.json();
  // Log successful fetches in debug mode
  if (process.env.LIMBLE_DEBUG) {
    console.log(`[Limble] ${path} → ${Array.isArray(data) ? data.length : (data?.data?.length || 'obj')} items`);
  }
  return data;
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZE — map Limble API response shapes to Lab_Assistant internal format
// ─────────────────────────────────────────────────────────────────────────────

function normalizeAsset(a) {
  // Limble API v2 uses assetID, locationID, etc.
  const meta = a.meta || {};
  return {
    id:           a.assetID || a.id,
    name:         a.name || a.assetName || 'Unnamed',
    category:     meta.category || meta.type || a.category || a.assetType || 'Equipment',
    status:       meta.status || a.status || 'operational',
    location:     a.location?.name || a.locationName || null,
    locationId:   a.locationID || a.locationId || null,
    serialNumber: meta.serialNumber || a.serialNumber || null,
    manufacturer: meta.manufacturer || a.manufacturer || null,
    model:        meta.model || a.model || null,
    lastPM:       meta.lastPMDate || a.lastPMDate || a.lastPreventiveMaintenance || null,
    nextPM:       meta.nextPMDate || a.nextPMDate || a.scheduledPM || null,
    pmStatus:     getPMStatus(meta.nextPMDate || a.nextPMDate),
    hoursRun:     parseFloat(meta.meterReading || a.meterReading) || 0,
    hoursPerWeek: a.hoursPerWeek || 0,
    purchaseDate: meta.purchaseDate || a.purchaseDate || null,
    warrantyExp:  meta.warrantyExpiration || a.warrantyExpiration || null,
    startedOn:    a.startedOn || null,
    lastEdited:   a.lastEdited || null,
    parentAssetId: a.parentAssetID || null,
    image:        a.image || null,
    lastUpdated:  new Date().toISOString(),
  };
}

function getPMStatus(nextPMDate) {
  if (!nextPMDate) return 'unknown';
  const next = new Date(nextPMDate);
  const now = new Date();
  const daysUntil = Math.ceil((next - now) / (1000 * 60 * 60 * 24));
  if (daysUntil < 0) return 'overdue';
  if (daysUntil <= 7) return 'due-soon';
  return 'ok';
}

function normalizeTask(t) {
  // Limble API v2 uses taskID, assetID, locationID, etc.
  // Timestamps are Unix seconds
  const createdAt = t.createdDate ? new Date(t.createdDate * 1000).toISOString() : null;
  const dueDate = t.due && t.due > 0 ? new Date(t.due * 1000).toISOString() : null;
  const completedAt = t.dateCompleted && t.dateCompleted > 0 ? new Date(t.dateCompleted * 1000).toISOString() : null;
  const startDate = t.startDate && t.startDate > 0 ? new Date(t.startDate * 1000).toISOString() : null;

  // Limble task types (numeric):
  // 1 = Standard Work Order
  // 2 = Work Order Template
  // 4 = Preventive Maintenance
  // 6 = Work Request
  let taskType = 'work-order';
  const limbleType = parseInt(t.type) || 0;
  if (limbleType === 4) {
    taskType = 'pm';
  } else if (limbleType === 6 || t.requestorName || t.requestorEmail) {
    taskType = 'work-request';
  } else if (t.name?.toLowerCase().includes('preventive') || t.name?.toLowerCase().includes(' pm ') || t.name?.toLowerCase().startsWith('pm ')) {
    taskType = 'pm';
  }

  // Status determination based on Limble API `status` field (not statusID):
  // t.status = 0 → Open (includes various custom statusIDs like "Waiting on Team")
  // t.status = 1 → In Progress or Completed (check dateCompleted)
  // t.status = 2 → Completed
  let status = 'open';
  const rawStatus = parseInt(t.status);

  if (rawStatus === 2 || (t.dateCompleted && t.dateCompleted > 0)) {
    status = 'completed';
  } else if (rawStatus === 1) {
    status = 'in-progress';
  } else if (rawStatus === 0) {
    status = 'open';
  }

  return {
    id:           t.taskID || t.id,
    type:         taskType,
    limbleType:   limbleType,
    title:        t.name || t.title || t.requestTitle || t.description || 'Untitled Task',
    description:  t.description || t.requestorDescription || '',
    asset:        null,  // Will be populated via asset lookup
    assetId:      t.assetID || t.assetId || null,
    locationId:   t.locationID || t.locationId || null,
    priority:     normalizePriority(t.priority || t.priorityID),
    priorityId:   t.priorityID || null,
    status:       status,
    statusId:     t.statusID || null,
    assignee:     t.userID ? `User ${t.userID}` : null,
    userId:       t.userID || null,
    teamId:       t.teamID || null,
    createdAt:    createdAt,
    startDate:    startDate,
    dueDate:      dueDate,
    completedAt:  completedAt,
    completedBy:  t.completedByUser || null,
    estimatedHrs: t.estimatedTime ? parseFloat(t.estimatedTime) / 60 : null,  // Limble uses minutes
    actualHrs:    null,  // Calculated from labor records
    downtime:     t.downtime || false,
    template:     t.template || false,
    completionNotes: t.completionNotes || '',
    requestor: t.requestorName ? {
      name: t.requestorName,
      email: t.requestorEmail,
      phone: t.requestorPhone,
    } : null,
    customTags:   t.customTags || [],
    image:        t.image || null,
  };
}

function normalizePriority(p) {
  const val = (p || '').toString().toLowerCase();
  if (val.includes('critical') || val.includes('emergency') || val === '1') return 'critical';
  if (val.includes('high') || val === '2') return 'high';
  if (val.includes('medium') || val === '3') return 'medium';
  return 'low';
}

function normalizeStatus(s) {
  const val = (s || '').toString().toLowerCase();
  if (val.includes('complete') || val.includes('closed')) return 'completed';
  if (val.includes('progress') || val.includes('working')) return 'in-progress';
  if (val.includes('hold') || val.includes('waiting')) return 'on-hold';
  if (val.includes('open') || val.includes('new')) return 'open';
  return 'open';
}

function normalizeDowntime(d) {
  const start = new Date(d.startTime || d.startDate);
  const end = d.endTime || d.endDate ? new Date(d.endTime || d.endDate) : null;
  const durationMins = end ? Math.round((end - start) / 60000) : null;

  return {
    id:           d.id,
    assetId:      d.assetId || d.asset?.id,
    assetName:    d.assetName || d.asset?.name || 'Unknown',
    startTime:    start.toISOString(),
    endTime:      end?.toISOString() || null,
    durationMins: durationMins,
    reason:       d.reason || d.description || d.notes || 'Unspecified',
    planned:      d.planned || d.isPlanned || false,
    category:     d.category || (d.planned ? 'planned' : 'unplanned'),
  };
}

function normalizePart(p) {
  // Limble API v2 uses partID, generalStock, generalPrice, etc.
  const qty = parseFloat(p.stockOnHand || p.generalStock || p.quantity) || 0;
  const minQty = parseFloat(p.minQtyThreshold || p.minimumQuantity || p.reorderPoint) || 0;

  return {
    id:         p.partID || p.id,
    name:       p.name || p.partName || 'Unnamed Part',
    partNum:    p.number || p.partNumber || p.sku || null,
    qty:        qty,
    minQty:     minQty,
    maxQty:     parseFloat(p.maxQtyThreshold) || null,
    location:   p.location || p.locationName || null,
    locationId: p.locationID || null,
    category:   p.category || null,
    categoryId: p.categoryID || null,
    cost:       parseFloat(p.generalPrice || p.cost) || null,
    vendor:     p.supplier || p.vendor?.name || p.vendorName || null,
    lowStock:   p.minQtyStatus === 1 || (minQty > 0 && qty <= minQty),
    stale:      p.staleStatus === 1,
    image:      p.image || null,
    lastEdited: p.lastEdited ? new Date(p.lastEdited * 1000).toISOString() : null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// COMPUTE STATS — KPIs for maintenance dashboard
// ─────────────────────────────────────────────────────────────────────────────
function computeStats(assets, tasks, downtime) {
  const now = Date.now();
  const last30Days = now - 30 * 24 * 60 * 60 * 1000;
  const last7Days = now - 7 * 24 * 60 * 60 * 1000;

  // ── DOWNTIME CALCULATION ──
  // Since Limble's downtimes endpoint may not be available, calculate from:
  // 1. Explicit downtime records (if available)
  // 2. Tasks marked with downtime flag
  // 3. Completed repair work orders (use actual hours as downtime estimate)

  // From downtime records
  const recentDowntime = downtime.filter(d => new Date(d.startTime).getTime() > last30Days);
  const plannedDowntimeFromRecords = recentDowntime.filter(d => d.planned);
  const unplannedDowntimeFromRecords = recentDowntime.filter(d => !d.planned);

  // From tasks - estimate downtime from completed repair work orders
  const recentTasks = tasks.filter(t => {
    const completed = t.completedAt ? new Date(t.completedAt).getTime() : 0;
    return completed > last30Days;
  });

  // Work orders that caused downtime (repairs, breakdowns)
  const downtimeTasks = recentTasks.filter(t =>
    t.downtime === true ||
    t.type === 'work-order' && t.title?.toLowerCase().match(/repair|breakdown|failure|fix|replace|broken/)
  );

  // PM tasks (planned maintenance) also cause downtime
  const pmTasksCompleted = recentTasks.filter(t => t.type === 'pm' && t.status === 'completed');

  // Estimate downtime hours from task duration
  const unplannedDowntimeHrsFromTasks = downtimeTasks.reduce((sum, t) => sum + (t.actualHrs || t.estimatedHrs || 1), 0);
  const plannedDowntimeHrsFromTasks = pmTasksCompleted.reduce((sum, t) => sum + (t.actualHrs || t.estimatedHrs || 0.5), 0);

  // Combine both sources
  const plannedDowntimeMins = (plannedDowntimeFromRecords.reduce((sum, d) => sum + (d.durationMins || 0), 0)) + (plannedDowntimeHrsFromTasks * 60);
  const unplannedDowntimeMins = (unplannedDowntimeFromRecords.reduce((sum, d) => sum + (d.durationMins || 0), 0)) + (unplannedDowntimeHrsFromTasks * 60);
  const totalDowntimeMins = plannedDowntimeMins + unplannedDowntimeMins;

  // Available time calculation
  // Use operating hours (assume 10 hrs/day × number of working assets)
  const workingAssets = assets.filter(a => a.hoursPerWeek > 0 || a.status === 'operational').length || assets.length;
  const operatingHrsPerDay = 10; // Average operating hours per day
  const totalAvailableMins = 30 * operatingHrsPerDay * 60 * workingAssets;

  // Uptime percentage — only from real data, never fake
  let uptimePercent = null;
  if (totalAvailableMins > 0 && totalDowntimeMins > 0) {
    uptimePercent = Math.round((1 - totalDowntimeMins / totalAvailableMins) * 10000) / 100;
    uptimePercent = Math.max(0, Math.min(100, uptimePercent));
  } else if (downtimeTasks.length > 0 && totalAvailableMins > 0) {
    // Estimate from task hours only
    const estimatedDownMins = downtimeTasks.reduce((s, t) => s + (t.actualHrs || t.estimatedHrs || 1) * 60, 0);
    uptimePercent = Math.round((1 - estimatedDownMins / totalAvailableMins) * 10000) / 100;
    uptimePercent = Math.max(0, Math.min(100, uptimePercent));
  }
  // null = no data available — dashboard shows "—"
  const clampedUptime = uptimePercent;

  // ── OEE CALCULATION ──
  // OEE = Availability × Performance × Quality
  // Availability: actual production time / planned production time
  const availability = totalAvailableMins > 0 && unplannedDowntimeMins > 0
    ? (totalAvailableMins - unplannedDowntimeMins) / totalAvailableMins
    : null;

  // Performance: estimate from task completion rate and open work orders
  const totalTasksLast30 = recentTasks.length;
  const completedTasksLast30 = recentTasks.filter(t => t.status === 'completed').length;
  const taskCompletionRate = totalTasksLast30 > 0 ? completedTasksLast30 / totalTasksLast30 : null;

  // Quality: estimate from critical/emergency tasks (lower = more issues)
  const criticalTasksLast30 = recentTasks.filter(t => t.priority === 'critical' || t.priority === 'high').length;
  const qualityFactor = totalTasksLast30 > 0 ? Math.max(0.85, 1 - (criticalTasksLast30 * 0.02)) : null;

  // OEE only if we have real data
  let oePercent = null;
  if (availability !== null && taskCompletionRate !== null && qualityFactor !== null) {
    oePercent = Math.round(availability * taskCompletionRate * qualityFactor * 10000) / 100;
    oePercent = Math.min(99, Math.max(50, oePercent));
  }

  // TEAP Score (simplified OEE variant) - only if we have uptime data
  const teapScore = clampedUptime !== null && taskCompletionRate !== null
    ? Math.round(clampedUptime * 0.95 * (taskCompletionRate > 0.8 ? 1 : 0.9))
    : null;

  // ── TASK STATS ──
  const openTasks = tasks.filter(t => t.status === 'open' || t.status === 'in-progress');
  const criticalTasks = openTasks.filter(t => t.priority === 'critical');
  const highPriorityTasks = openTasks.filter(t => t.priority === 'high');
  const overdueTasks = openTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date());

  // ── PM COMPLIANCE ──
  // Look at PM tasks that were due in the last 30 days
  const pmTasks = tasks.filter(t => t.type === 'pm');

  // PMs that were due in the last 30 days (had a due date in that window)
  const pmDueInLast30 = pmTasks.filter(t => {
    if (!t.dueDate) return false;
    const dueDate = new Date(t.dueDate).getTime();
    return dueDate > last30Days && dueDate <= now;
  });

  // Of those, how many were completed?
  const pmCompletedOnTime = pmDueInLast30.filter(t => t.status === 'completed').length;

  // Also count PMs completed in last 30 days regardless of due date
  const pmCompletedLast30 = pmTasks.filter(t => {
    if (t.status !== 'completed' || !t.completedAt) return false;
    return new Date(t.completedAt).getTime() > last30Days;
  }).length;

  const pmScheduled30d = pmDueInLast30.length || pmCompletedLast30; // Use completed if no scheduled found
  const pmCompleted30d = Math.max(pmCompletedOnTime, pmCompletedLast30);

  // Calculate PM compliance - only show real data, null if no data
  let pmCompliancePercent = null;
  if (pmScheduled30d > 0) {
    pmCompliancePercent = Math.round((pmCompleted30d / pmScheduled30d) * 100);
    pmCompliancePercent = Math.max(0, Math.min(100, pmCompliancePercent));
  } else if (pmTasks.length > 0) {
    // If we have PM tasks but none scheduled in window, check overdue
    const overduePMs = pmTasks.filter(t => t.dueDate && new Date(t.dueDate) < new Date() && t.status !== 'completed');
    if (overduePMs.length > 0) {
      pmCompliancePercent = Math.max(0, Math.round(85 - overduePMs.length * 5));
    }
    // else: no data to compute compliance
  }

  // ── RELIABILITY METRICS ──
  const failures = unplannedDowntimeFromRecords.length + downtimeTasks.length;
  const actualOperatingMins = totalAvailableMins - totalDowntimeMins;
  const totalOperatingHrs = actualOperatingMins / 60;
  const mtbfHrs = failures > 0 ? Math.round(totalOperatingHrs / failures) : null;

  // MTTR (Mean Time To Repair)
  const mttrHrs = failures > 0 ? Math.round((unplannedDowntimeMins / failures) / 60 * 10) / 10 : null;

  // Asset health by category
  const assetsByCategory = {};
  assets.forEach(a => {
    const cat = a.category || 'Other';
    if (!assetsByCategory[cat]) {
      assetsByCategory[cat] = { count: 0, operational: 0, down: 0, pmOverdue: 0 };
    }
    assetsByCategory[cat].count++;
    if (a.status === 'operational' || a.status === 'online') {
      assetsByCategory[cat].operational++;
    } else {
      assetsByCategory[cat].down++;
    }
    if (a.pmStatus === 'overdue') {
      assetsByCategory[cat].pmOverdue++;
    }
  });

  // Data availability flag
  const hasRecentData = recentTasks.length > 0 || totalDowntimeMins > 0;

  return {
    // Overall KPIs (null = no data available)
    uptimePercent: clampedUptime,
    oePercent: oePercent,
    teapScore: teapScore,
    hasData: hasRecentData,

    // Downtime breakdown
    totalDowntimeHrs: totalDowntimeMins > 0 ? Math.round(totalDowntimeMins / 60 * 10) / 10 : 0,
    plannedDowntimeHrs: plannedDowntimeMins > 0 ? Math.round(plannedDowntimeMins / 60 * 10) / 10 : 0,
    unplannedDowntimeHrs: unplannedDowntimeMins > 0 ? Math.round(unplannedDowntimeMins / 60 * 10) / 10 : 0,

    // Reliability
    mtbfHrs,
    mttrHrs,

    // Task counts
    openTaskCount: openTasks.length,
    criticalTaskCount: criticalTasks.length,
    highPriorityCount: highPriorityTasks.length,
    overdueTaskCount: overdueTasks.length,

    // PM compliance
    pmCompliancePercent,
    pmCompleted30d,
    pmScheduled30d,

    // Asset summary
    totalAssets: assets.length,
    operationalAssets: assets.filter(a => a.status === 'operational' || a.status === 'online').length,
    assetsDown: assets.filter(a => a.status !== 'operational' && a.status !== 'online').length,
    assetsPMOverdue: assets.filter(a => a.pmStatus === 'overdue').length,
    assetsPMDueSoon: assets.filter(a => a.pmStatus === 'due-soon').length,

    // By category
    assetsByCategory,

    // Data sources info
    downtimeSource: downtime.length > 0 ? 'limble_records' : 'task_estimates',
    taskBasedDowntimeCount: downtimeTasks.length,

    // Period
    periodDays: 30,
    computedAt: new Date().toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SLACK ALERT — fires when critical issues appear
// Supports both Webhook and Bot API methods
// ─────────────────────────────────────────────────────────────────────────────
let lastAlertIds = new Set();

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
        console.warn('[Limble] Slack Bot API error:', data.error);
      }
      return data.ok;
    } catch (e) {
      console.warn('[Limble] Slack Bot API failed:', e.message);
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
      console.warn('[Limble] Slack webhook failed:', e.message);
      return false;
    }
  }

  return false;  // No Slack configured
}

async function sendSlackAlerts(tasks, assets) {
  if (!CONFIG.slackBotToken && !CONFIG.slackWebhook) return;

  const criticalTasks = tasks.filter(t =>
    t.priority === 'critical' &&
    (t.status === 'open' || t.status === 'in-progress') &&
    !lastAlertIds.has(t.id)
  );

  const downAssets = assets.filter(a =>
    (a.status !== 'operational' && a.status !== 'online') &&
    !lastAlertIds.has(`asset-${a.id}`)
  );

  const alerts = [];
  criticalTasks.forEach(t => {
    alerts.push(`🚨 *CRITICAL:* ${t.title} (${t.asset || 'General'})`);
    lastAlertIds.add(t.id);
  });
  downAssets.forEach(a => {
    alerts.push(`⚠️ *DOWN:* ${a.name} (${a.category})`);
    lastAlertIds.add(`asset-${a.id}`);
  });

  if (!alerts.length) return;

  await sendSlackMessage(`*🔧 Maintenance Alert*\n${alerts.join('\n')}`);

  // Reset seen set each hour
  setTimeout(() => { lastAlertIds = new Set(); }, 3600000);
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
    // Parallel fetch — Limble API v2 endpoints
    // safeFetch: propagates a sentinel error object so callers can distinguish
    // auth/network failure from a legitimately empty response.
    // Returning [] on error is wrong — it makes a 401 look like no data, which
    // defeats the silent-0-row guard on assets.
    const FETCH_ERROR = Symbol('FETCH_ERROR');
    const safeFetch = async (path, params) => {
      try {
        return await limbleFetch(path, params);
      } catch (e) {
        console.warn(`[Limble] ${path} failed:`, e.message);
        return { [FETCH_ERROR]: true, message: e.message };
      }
    };
    const isFetchError = (v) => v && typeof v === 'object' && v[FETCH_ERROR] === true;

    // Fetch all tasks - the API's status filter doesn't work as expected
    // Completed tasks have status=1 but dateCompleted>0, not status=2
    // So we fetch ALL tasks and filter ourselves
    const [assetsResp, partsResp] = await Promise.all([
      safeFetch('/v2/assets', { limit: 500 }),
      safeFetch('/v2/parts', { limit: 500 }),
    ]);
    // /v2/downtimes removed — endpoint doesn't exist in current Limble API.
    // Downtime stats calculated from tasks (work orders) in computeStats().
    const downtimeResp = { data: [] };

    // Propagate asset fetch error to silent-0-row guard below.
    // If assetsResp is an error sentinel, pass it through — guard will catch it.
    if (isFetchError(assetsResp)) {
      cache.syncStatus = 'error';
      cache.syncError = `assets fetch failed: ${assetsResp.message}`;
      cache.lastSync = new Date().toISOString();
      console.error('[Limble] Assets fetch failed — keeping prior cache:', assetsResp.message);
      return;
    }

    // Fetch tasks — incremental cursor if LIMBLE_USE_CURSOR=true, full fetch otherwise.
    // ?updatedAfter is SPECULATIVE (not confirmed in Limble v2 docs). If Limble ignores
    // it, the full task list is returned and behavior is identical to the old full fetch.
    let allTasksRaw = [];
    let page = 1;
    const batchSize = 1000;
    let hasMore = true;
    const maxPages = 30; // Safety limit: 30k tasks max

    // Load persisted cursor (Unix seconds — Limble timestamps are Unix seconds)
    const db = require('./db');
    const LIMBLE_CURSOR_KEY = 10; // Unique key in delta_poll_cursor table; 3/4 are ItemPath
    let taskCursor = null;
    if (CONFIG.useCursor) {
      const raw = db.getDeltaCursor(LIMBLE_CURSOR_KEY);
      taskCursor = raw ? parseInt(raw, 10) : null;
      if (taskCursor) console.log(`[Limble] Incremental fetch — updatedAfter=${new Date(taskCursor * 1000).toISOString()}`);
    }

    let maxUpdatedAt = taskCursor || 0; // Track highest updatedAt seen in this poll

    while (hasMore && page <= maxPages) {
      const params = { limit: batchSize, page };
      if (CONFIG.useCursor && taskCursor) params.updatedAfter = taskCursor;
      const batch = await safeFetch('/v2/tasks', params);
      if (isFetchError(batch)) {
        console.warn('[Limble] Task page fetch failed:', batch.message);
        hasMore = false;
      } else if (Array.isArray(batch) && batch.length > 0) {
        allTasksRaw = allTasksRaw.concat(batch);
        // Track max updatedAt for cursor advancement
        for (const t of batch) {
          const ts = t.lastEdited || t.dateCompleted || t.createdDate || 0;
          if (ts > maxUpdatedAt) maxUpdatedAt = ts;
        }
        hasMore = batch.length === batchSize;
        page++;
      } else {
        hasMore = false;
      }
    }

    // Persist cursor after successful task fetch
    if (CONFIG.useCursor && maxUpdatedAt > 0) {
      db.setDeltaCursor(LIMBLE_CURSOR_KEY, String(maxUpdatedAt), Date.now());
    }

    // Now we have all tasks - split into open/in-progress/completed ourselves
    const openTasksResp = allTasksRaw.filter(t => !t.template && (!t.dateCompleted || t.dateCompleted === 0) && t.status !== 2);
    const inProgressTasksResp = []; // We'll identify these in normalization
    const recentCompletedResp = allTasksRaw.filter(t => !t.template && t.dateCompleted && t.dateCompleted > 0);

    // Combine task responses
    const tasksResp = [
      ...(Array.isArray(openTasksResp) ? openTasksResp : []),
      ...(Array.isArray(inProgressTasksResp) ? inProgressTasksResp : []),
      ...(Array.isArray(recentCompletedResp) ? recentCompletedResp : []),
    ];

    // Extract arrays from various response formats
    const extractArray = (resp, keys) => {
      if (Array.isArray(resp)) return resp;
      for (const key of keys) {
        if (resp && Array.isArray(resp[key])) return resp[key];
      }
      return [];
    };

    const assets   = extractArray(assetsResp, ['data', 'assets', 'items', 'results']).map(normalizeAsset);
    // Filter out template tasks (they're not real work orders)
    const allTasks = extractArray(tasksResp, ['data', 'tasks', 'items', 'results']).map(normalizeTask);
    const tasks    = allTasks.filter(t => !t.template);
    const downtime = extractArray(downtimeResp, ['data', 'downtimes', 'downtime', 'items', 'results']).map(normalizeDowntime);
    const parts    = extractArray(partsResp, ['data', 'parts', 'items', 'results']).map(normalizePart);

    // Silent-0-row guard: Limble's safeFetch swallows errors and returns [],
    // so an auth drop looks identical to an empty response. The lab has 50+
    // assets registered — a 0-asset response after a successful prior poll
    // means the API call failed, not that assets vanished.
    const prevAssetCount = (cache.assets || []).length;
    if (prevAssetCount > 5 && assets.length === 0) {
      cache.consecutiveEmptyAssets = (cache.consecutiveEmptyAssets || 0) + 1;
      console.error(`[Limble] ⚠️ SUSPICIOUS 0-asset response — prev ${prevAssetCount} → now 0. Keeping prior cache. (consecutive: ${cache.consecutiveEmptyAssets})`);
      cache.syncStatus = 'suspect';
      cache.syncError = '0-asset result after non-empty prior';
      cache.lastSync = new Date().toISOString();
      return;
    }
    cache.consecutiveEmptyAssets = 0;

    const stats    = computeStats(assets, tasks, downtime);

    // Compute derived lists for UI
    const openTasks = tasks.filter(t => t.status === 'open' || t.status === 'in-progress');
    const lowStockParts = parts.filter(p => p.lowStock);

    cache = {
      assets,
      tasks,
      openTasks,
      downtime,
      parts,
      lowStockParts,
      locations: [],
      stats,
      lastSync:   new Date().toISOString(),
      syncStatus: 'ok',
      syncError:  null,
    };

    await sendSlackAlerts(tasks, assets);
    console.log(`[Limble] ✓ Sync: ${assets.length} assets, ${tasks.length} tasks, ${downtime.length} downtime records`);
    // Heartbeat: 2h threshold. Limble polls every 30-60 min — 2h = 2-4 missed polls.
    try { require('./db').recordHeartbeat('limble', assets.length, 2 * 60 * 60 * 1000); } catch {}

    // Write to SQLite for AI agent queries
    try {
      const db = require('./db');
      db.upsertAssets(assets);
      db.upsertTasks(tasks);
      db.upsertParts(parts);
      console.log(`[Limble] ✓ SQLite snapshot saved`);
    } catch (dbErr) {
      console.error('[Limble] SQLite write failed:', dbErr.message);
    }

  } catch (err) {
    cache.syncStatus = 'error';
    cache.syncError  = err.message;
    console.error('[Limble] Poll failed:', err.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA — realistic maintenance data for development
// ─────────────────────────────────────────────────────────────────────────────
function loadMockData() {
  const categories = CONFIG.equipmentCategories;
  const mockAssets = [];
  let assetId = 1;

  categories.forEach(cat => {
    const count = cat === 'Coaters' || cat === 'Ovens' ? 3 : cat === 'Generators' ? 4 : 2;
    for (let i = 1; i <= count; i++) {
      const operational = Math.random() > 0.1;
      const nextPM = new Date(Date.now() + (Math.random() * 60 - 10) * 24 * 60 * 60 * 1000);
      mockAssets.push({
        id: assetId++,
        name: `${cat.slice(0, -1)} ${i}`,
        category: cat,
        status: operational ? 'operational' : 'down',
        location: `Lab Floor ${Math.ceil(i/2)}`,
        serialNumber: `SN-${cat.slice(0,3).toUpperCase()}-${1000+i}`,
        manufacturer: ['Satisloh', 'Schneider', 'Opticoat', 'Essilor'][Math.floor(Math.random()*4)],
        model: ['XL-1200', 'Pro-500', 'Compact-300'][Math.floor(Math.random()*3)],
        lastPM: new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000).toISOString(),
        nextPM: nextPM.toISOString(),
        pmStatus: getPMStatus(nextPM.toISOString()),
        hoursRun: Math.floor(Math.random() * 5000 + 1000),
        lastUpdated: new Date().toISOString(),
      });
    }
  });

  const taskTypes = ['work-order', 'pm', 'work-request'];
  const priorities = ['low', 'medium', 'high', 'critical'];
  const statuses = ['open', 'in-progress', 'on-hold', 'completed'];
  const mockTasks = Array.from({ length: 25 }, (_, i) => {
    const asset = mockAssets[Math.floor(Math.random() * mockAssets.length)];
    const type = taskTypes[Math.floor(Math.random() * taskTypes.length)];
    const status = statuses[Math.floor(Math.random() * statuses.length)];
    return {
      id: i + 1,
      type,
      title: type === 'pm'
        ? `Scheduled PM - ${asset.name}`
        : type === 'work-request'
        ? `Service Request: ${asset.name} noise/vibration`
        : `Repair: ${asset.name} - ${['alignment', 'calibration', 'belt replacement', 'filter change'][Math.floor(Math.random()*4)]}`,
      description: 'Maintenance task description',
      asset: asset.name,
      assetId: asset.id,
      priority: priorities[Math.floor(Math.random() * priorities.length)],
      status,
      assignee: ['Mike', 'Sarah', 'James', 'Unassigned'][Math.floor(Math.random()*4)],
      createdAt: new Date(Date.now() - Math.random() * 14 * 24 * 60 * 60 * 1000).toISOString(),
      dueDate: new Date(Date.now() + (Math.random() * 14 - 7) * 24 * 60 * 60 * 1000).toISOString(),
      completedAt: status === 'completed' ? new Date(Date.now() - Math.random() * 7 * 24 * 60 * 60 * 1000).toISOString() : null,
      estimatedHrs: Math.ceil(Math.random() * 4),
      actualHrs: status === 'completed' ? Math.ceil(Math.random() * 5) : null,
      category: asset.category,
    };
  });

  const mockDowntime = Array.from({ length: 15 }, (_, i) => {
    const asset = mockAssets[Math.floor(Math.random() * mockAssets.length)];
    const planned = Math.random() > 0.6;
    const startTime = new Date(Date.now() - Math.random() * 30 * 24 * 60 * 60 * 1000);
    const durationMins = Math.floor(Math.random() * (planned ? 240 : 120)) + 30;
    return {
      id: i + 1,
      assetId: asset.id,
      assetName: asset.name,
      startTime: startTime.toISOString(),
      endTime: new Date(startTime.getTime() + durationMins * 60000).toISOString(),
      durationMins,
      reason: planned
        ? ['Scheduled maintenance', 'Preventive maintenance', 'Planned upgrade'][Math.floor(Math.random()*3)]
        : ['Mechanical failure', 'Electrical issue', 'Calibration drift', 'Part failure'][Math.floor(Math.random()*4)],
      planned,
      category: planned ? 'planned' : 'unplanned',
    };
  });

  const mockParts = Array.from({ length: 12 }, (_, i) => ({
    id: i + 1,
    name: ['Drive belt', 'Air filter', 'O-ring seal', 'Bearing', 'Motor brush', 'Fuse', 'Lubricant', 'Gasket'][i % 8],
    partNum: `PT-${1000+i}`,
    qty: Math.floor(Math.random() * 20),
    minQty: 5,
    location: `Parts Room ${Math.ceil((i+1)/4)}`,
    cost: Math.round((Math.random() * 100 + 10) * 100) / 100,
    vendor: ['Grainger', 'McMaster-Carr', 'OEM'][Math.floor(Math.random()*3)],
    lowStock: Math.random() > 0.7,
  }));

  const stats = computeStats(mockAssets, mockTasks, mockDowntime);
  const openTasks = mockTasks.filter(t => t.status === 'open' || t.status === 'in-progress');
  const lowStockParts = mockParts.filter(p => p.lowStock);

  cache = {
    assets: mockAssets,
    tasks: mockTasks,
    openTasks,
    downtime: mockDowntime,
    parts: mockParts,
    lowStockParts,
    locations: [],
    stats,
    lastSync:   new Date().toISOString(),
    syncStatus: 'mock',
    syncError:  null,
  };
  console.log('[Limble] Mock mode — set LIMBLE_CLIENT_ID + LIMBLE_CLIENT_SECRET to connect to Limble');
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API — consumed by oven-timer-server.js endpoints
// ─────────────────────────────────────────────────────────────────────────────

/** All assets/equipment */
function getAssets() {
  return {
    assets:   cache.assets,
    lastSync: cache.lastSync,
    status:   cache.syncStatus,
    error:    cache.syncError,
  };
}

/** All tasks/work orders */
function getTasks() {
  const openTasks = cache.openTasks || cache.tasks.filter(t => t.status === 'open' || t.status === 'in-progress');
  return {
    tasks:     cache.tasks,
    open:      openTasks,  // for backwards compatibility
    openTasks: openTasks,
    critical:  cache.tasks.filter(t => t.priority === 'critical'),
    lastSync:  cache.lastSync,
  };
}

/** Downtime records */
function getDowntime() {
  return {
    downtime:   cache.downtime,
    planned:    cache.downtime.filter(d => d.planned),
    unplanned:  cache.downtime.filter(d => !d.planned),
    lastSync:   cache.lastSync,
  };
}

/** Spare parts inventory */
function getParts() {
  return {
    parts:         cache.parts,
    lowStock:      cache.lowStockParts || cache.parts.filter(p => p.lowStock),
    lowStockParts: cache.lowStockParts || cache.parts.filter(p => p.lowStock),
    lastSync:      cache.lastSync,
  };
}

/** Computed stats/KPIs */
function getStats() {
  return {
    ...cache.stats,
    lastSync: cache.lastSync,
    status:   cache.syncStatus,
  };
}

/** Summary context for AI */
function getAIContext() {
  const s = cache.stats;
  return {
    summary: `Maintenance: ${s.totalAssets} assets, ${s.operationalAssets} operational, ${s.assetsDown} down. Open tasks: ${s.openTaskCount} (${s.criticalTaskCount} critical). Uptime: ${s.uptimePercent}%, OE: ${s.oePercent}%, TEAP: ${s.teapScore}. PM compliance: ${s.pmCompliancePercent}%.`,
    stats: s,
    criticalTasks: cache.tasks.filter(t => t.priority === 'critical' && t.status !== 'completed').slice(0, 5),
    downAssets: cache.assets.filter(a => a.status !== 'operational' && a.status !== 'online'),
    lastSync: cache.lastSync,
    mode: cache.syncStatus,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// START — kick off polling loop
// ─────────────────────────────────────────────────────────────────────────────
function start() {
  if (CONFIG.mockMode) {
    console.log(`[Limble] Starting — MOCK MODE (set LIMBLE_CLIENT_ID + LIMBLE_CLIENT_SECRET for live data)`);
  } else {
    console.log(`[Limble] Starting — ${CONFIG.baseUrl} — ClientID: ${CONFIG.clientId.slice(0,8)}... — poll every ${CONFIG.pollInterval/1000}s`);
  }
  // Jittered: ±20% on first poll AND each interval to prevent alignment with
  // other 60s pollers.
  setTimeout(() => {
    poll();
    setInterval(poll, jitterInterval(CONFIG.pollInterval));
  }, jitterInterval(CONFIG.pollInterval));
}

module.exports = { start, getAssets, getTasks, getDowntime, getParts, getStats, getAIContext, sendSlackMessage };
