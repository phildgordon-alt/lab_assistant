/**
 * ews-collectors.js — EWS Data Collectors
 *
 * Taps into existing Lab_Assistant adapters to collect metrics for the
 * Early Warning System. Each collector returns an array of { metric, system, value, unit }.
 *
 * Collectors:
 *   1. SOM (Schneider) — machine downtime, errors, conveyor stops, OEE
 *   2. ItemPath — lens consumption rate, stock levels, pick anomalies
 *   3. DVI Trace — throughput, WIP pileup, hold/error counts, cycle times
 *   4. Oven Timers — temperature compliance, batch timing
 *   5. Maintenance (Limble) — unplanned downtime events
 *   6. Breakage — breakage rate from SQLite
 *
 * USAGE:
 *   const ews = require('./ews-engine');
 *   require('./ews-collectors').register(ews, { som, itempath, dviTrace, labDb });
 */

'use strict';

/**
 * Register all collectors with the EWS engine.
 * @param {object} ews - The ews-engine module
 * @param {object} adapters - References to live adapters
 * @param {object} adapters.som - SOM adapter (server/som-adapter.js)
 * @param {object} adapters.itempath - ItemPath adapter (server/itempath-adapter.js)
 * @param {object} adapters.dviTrace - DVI Trace module (server/dvi-trace.js)
 * @param {object} adapters.labDb - SQLite database (server/db.js)
 * @param {object} adapters.limble - Limble adapter (server/limble-adapter.js)
 * @param {object} adapters.getOvenState - function returning live oven state
 */
function register(ews, adapters) {
  const { som, itempath, dviTrace, labDb, limble, getOvenState } = adapters;

  // ═══════════════════════════════════════════════════════════════════════════
  // 1. SOM (Schneider) — Machine Health
  // ═══════════════════════════════════════════════════════════════════════════

  if (som) {
    ews.registerCollector('som_machines', async () => {
      const readings = [];
      try {
        const deviceData = som.getDevices();
        if (!deviceData.isLive) return readings;

        const summary = deviceData.summary || {};
        const devices = deviceData.devices || [];

        // Devices in error state
        readings.push({
          metric: 'som_devices_in_error',
          system: 'SOM',
          value: summary.errors || 0,
          unit: 'devices',
        });

        // Devices blocked (upstream/downstream flow issue)
        readings.push({
          metric: 'som_devices_blocked',
          system: 'SOM',
          value: summary.warnings || 0,
          unit: 'devices',
        });

        // Conveyor errors
        const convData = som.getConveyors();
        const convSummary = convData.summary || {};
        readings.push({
          metric: 'som_conveyor_errors',
          system: 'SOM',
          value: convSummary.errors || 0,
          unit: 'errors',
        });

        // Machine downtime — count devices NOT in running/idle state
        const downDevices = devices.filter(d =>
          d.statusCode === 'SERR' || d.statusCode === 'SOFF'
        );
        // Approximate downtime: each down device × poll interval (30s converted to minutes)
        // This is a running indicator — will accumulate over time in baselines
        readings.push({
          metric: 'som_downtime_minutes',
          system: 'SOM',
          value: downDevices.length * 0.5, // ~30s per poll = 0.5 min
          unit: 'device-minutes',
        });

        // Repeated failures — devices that have been in error multiple times
        // Track by looking at error devices (the baseline will catch spikes)
        const errorDeviceIds = downDevices.map(d => d.id || d.deviceId).filter(Boolean);
        readings.push({
          metric: 'som_repeated_failures',
          system: 'SOM',
          value: errorDeviceIds.length,
          unit: 'devices',
        });

        // OEE from SOM
        const oeeData = som.getOEE();
        if (oeeData.oee && oeeData.oee.length > 0) {
          // Use most recent OEE value
          const latest = oeeData.oee[oeeData.oee.length - 1];
          if (latest && typeof latest.oee === 'number') {
            readings.push({
              metric: 'som_oee',
              system: 'SOM',
              value: latest.oee,
              unit: '%',
            });
          }
        }
      } catch (e) {
        console.error('[EWS:SOM] Collection error:', e.message);
      }
      return readings;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 2. ItemPath — Inventory & Consumption
  // ═══════════════════════════════════════════════════════════════════════════

  if (itempath) {
    ews.registerCollector('itempath_inventory', async () => {
      const readings = [];
      try {
        const health = itempath.getHealth();
        if (!health.connected && health.status === 'mock') return readings;

        // Consumption rate — picks per hour (current rate)
        const picks = itempath.getPicks();
        const dailyPicks = itempath.getDailyPicks();
        const currentHour = new Date().getHours();
        const wh1Hourly = dailyPicks.hourlyPicks?.WH1?.[currentHour] || 0;
        const wh2Hourly = dailyPicks.hourlyPicks?.WH2?.[currentHour] || 0;
        const totalPicksThisHour = wh1Hourly + wh2Hourly;

        readings.push({
          metric: 'itempath_consumption_rate',
          system: 'ItemPath',
          value: totalPicksThisHour,
          unit: 'picks/hr',
        });

        // Stock levels and stockouts
        const alerts = itempath.getAlerts();
        const criticalCount = alerts.critical || 0;
        const stockouts = (alerts.alerts || []).filter(a =>
          a.severity === 'CRITICAL' || a.qty === 0
        ).length;

        readings.push({
          metric: 'itempath_stockouts',
          system: 'ItemPath',
          value: stockouts,
          unit: 'SKUs',
        });

        readings.push({
          metric: 'itempath_stock_level',
          system: 'ItemPath',
          value: criticalCount > 0 ? -criticalCount : 0, // Negative = bad
          unit: 'critical_alerts',
        });

        // Total daily consumption (both warehouses)
        const totalDailyPicks = (dailyPicks.WH1 || 0) + (dailyPicks.WH2 || 0);
        readings.push({
          metric: 'itempath_daily_consumption',
          system: 'ItemPath',
          value: totalDailyPicks,
          unit: 'picks/day',
        });

      } catch (e) {
        console.error('[EWS:ItemPath] Collection error:', e.message);
      }
      return readings;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 3. DVI Trace — Production Flow
  // ═══════════════════════════════════════════════════════════════════════════

  if (dviTrace) {
    ews.registerCollector('dvi_production', async () => {
      const readings = [];
      try {
        const status = dviTrace.getStatus ? dviTrace.getStatus() : null;
        if (!status) return readings;

        const jobs = dviTrace.getJobs ? dviTrace.getJobs() : [];
        if (jobs.length === 0) return readings;

        const activeJobs = jobs.filter(j => j.status !== 'SHIPPED' && j.stage !== 'CANCELED');

        // ── Throughput (shipped in last hour) ──
        const oneHourAgo = Date.now() - 3600000;
        const recentShipped = jobs.filter(j =>
          j.status === 'SHIPPED' && j.lastSeen && j.lastSeen > oneHourAgo
        );
        readings.push({
          metric: 'dvi_throughput_per_hour',
          system: 'DVI',
          value: recentShipped.length,
          unit: 'jobs/hr',
        });

        readings.push({
          metric: 'dvi_shipped_per_hour',
          system: 'DVI',
          value: recentShipped.length,
          unit: 'jobs/hr',
        });

        // ── Jobs in error ──
        const errorJobs = activeJobs.filter(j =>
          j.status === 'ERROR' || j.status === 'HOLD' || j.stage === 'ERROR'
        );
        readings.push({
          metric: 'dvi_jobs_in_error',
          system: 'DVI',
          value: errorJobs.length,
          unit: 'jobs',
        });

        // ── Hold count ──
        const onHold = activeJobs.filter(j => j.status === 'HOLD' || j.stage === 'HOLD');
        readings.push({
          metric: 'dvi_hold_count',
          system: 'DVI',
          value: onHold.length,
          unit: 'jobs',
        });

        // ── WIP pileup by zone ──
        // Detect if any single zone has disproportionate WIP
        const zoneCounts = {};
        for (const j of activeJobs) {
          const zone = (j.stage || 'UNKNOWN').toUpperCase();
          zoneCounts[zone] = (zoneCounts[zone] || 0) + 1;
        }
        const maxZoneCount = Math.max(...Object.values(zoneCounts), 0);
        readings.push({
          metric: 'dvi_wip_pileup',
          system: 'DVI',
          value: maxZoneCount,
          unit: 'jobs in single zone',
        });

        // ── Total WIP ──
        readings.push({
          metric: 'dvi_total_wip',
          system: 'DVI',
          value: activeJobs.length,
          unit: 'jobs',
        });

        // ── WIP aging — jobs older than 3 days ──
        const threeDaysAgo = Date.now() - (3 * 86400000);
        const agedJobs = activeJobs.filter(j => j.firstSeen && j.firstSeen < threeDaysAgo);
        readings.push({
          metric: 'dvi_aged_wip',
          system: 'DVI',
          value: agedJobs.length,
          unit: 'jobs >3d',
        });

      } catch (e) {
        console.error('[EWS:DVI] Collection error:', e.message);
      }
      return readings;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 4. Breakage — From SQLite breakage_events
  // ═══════════════════════════════════════════════════════════════════════════

  if (labDb) {
    ews.registerCollector('breakage', async () => {
      const readings = [];
      try {
        // Today's breakage count
        const today = new Date().toISOString().split('T')[0];
        const breakageRow = labDb.db.prepare(`
          SELECT COUNT(*) as cnt FROM breakage_events
          WHERE occurred_at >= ?
        `).get(today);

        readings.push({
          metric: 'breakage_rate',
          system: 'Production',
          value: breakageRow?.cnt || 0,
          unit: 'breaks/day',
        });

        // Breakage by department (detect if one dept is spiking)
        const deptBreakage = labDb.db.prepare(`
          SELECT department, COUNT(*) as cnt FROM breakage_events
          WHERE occurred_at >= ?
          GROUP BY department ORDER BY cnt DESC
        `).all(today);

        for (const row of deptBreakage) {
          if (row.department) {
            readings.push({
              metric: `breakage_${row.department.toLowerCase()}`,
              system: 'Production',
              value: row.cnt,
              unit: 'breaks/day',
            });
          }
        }

        // Coating reject rate from warm layer
        const coatingYield = labDb.db.prepare(`
          SELECT SUM(jobs_failed) as failed, SUM(jobs_attempted) as total
          FROM coating_yield_daily WHERE stat_date = ?
        `).get(today);

        if (coatingYield && coatingYield.total > 0) {
          const rejectRate = (coatingYield.failed / coatingYield.total) * 100;
          readings.push({
            metric: 'coating_reject_rate',
            system: 'Coating',
            value: rejectRate,
            unit: '%',
          });
        }

      } catch (e) {
        console.error('[EWS:Breakage] Collection error:', e.message);
      }
      return readings;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 5. Maintenance (Limble) — Unplanned Downtime
  // ═══════════════════════════════════════════════════════════════════════════

  if (limble) {
    ews.registerCollector('maintenance', async () => {
      const readings = [];
      try {
        // Limble adapter exports: getDowntime(), getTasks() — no getHealth()
        const downtime = limble.getDowntime();
        if (downtime && downtime.records) {
          // Count active unplanned downtime events
          const activeDown = downtime.records.filter(d =>
            d.status === 'active' || d.status === 'open'
          );
          readings.push({
            metric: 'maintenance_active_downtime',
            system: 'Maintenance',
            value: activeDown.length,
            unit: 'events',
          });
        }

        // Open work orders (indicates maintenance load)
        const tasks = limble.getTasks();
        if (tasks && tasks.tasks) {
          const openWOs = tasks.tasks.filter(t =>
            t.status === 'open' || t.status === 'inProgress'
          );
          readings.push({
            metric: 'maintenance_open_work_orders',
            system: 'Maintenance',
            value: openWOs.length,
            unit: 'work orders',
          });
        }
      } catch (e) {
        console.error('[EWS:Maintenance] Collection error:', e.message);
      }
      return readings;
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // 6. Oven Timers — Temperature & Timing Compliance
  // ═══════════════════════════════════════════════════════════════════════════

  if (getOvenState) {
    ews.registerCollector('oven_timers', async () => {
      const readings = [];
      try {
        const state = getOvenState();
        if (!state || typeof state !== 'object') return readings;

        // Check for overdue racks (running past target time)
        let overdueCount = 0;
        for (const [ovenId, oven] of Object.entries(state)) {
          if (!oven.racks) continue;
          for (const rack of Object.values(oven.racks)) {
            if (rack.running && rack.elapsed && rack.target) {
              if (rack.elapsed > rack.target * 1.1) { // >10% over target
                overdueCount++;
              }
            }
          }
        }

        if (overdueCount > 0) {
          readings.push({
            metric: 'oven_overdue_racks',
            system: 'Coating',
            value: overdueCount,
            unit: 'racks',
          });
        }
      } catch (e) {
        console.error('[EWS:Oven] Collection error:', e.message);
      }
      return readings;
    });
  }

  console.log(`[EWS] All collectors registered`);
}

module.exports = { register };
