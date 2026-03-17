/**
 * ews-patterns.js — AI Inference Pattern Library (EWS Layer 3)
 *
 * Multi-signal pattern matching that detects root causes by correlating
 * multiple metric anomalies. Each pattern defines conditions across metrics
 * that, when met together, point to a specific root cause.
 *
 * The pattern engine runs on every poll cycle. For each pattern, it checks
 * all conditions against live readings + baselines. A pattern fires when
 * the fraction of satisfied conditions >= confidence_required.
 *
 * USAGE in ews-engine.js or oven-timer-server.js:
 *   const { evaluatePatterns, PATTERNS } = require('./ews-patterns');
 *   const patternAlerts = evaluatePatterns(readings, getBaseline);
 *   // patternAlerts is an array of fired pattern objects
 *
 * Condition types:
 *   z_score  — checks z-score direction + threshold against baseline
 *   absolute — checks raw value against a fixed threshold
 *   exists   — fires if the metric is present in readings at all
 */

'use strict';

// ─── PATTERN DEFINITIONS ─────────────────────────────────────────────────────

const PATTERNS = [

  // ══════════════════════════════════════════════════════════════════════════
  // 1. Assembly station equipment or operator failure
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'station-equipment-failure',
    name: 'Assembly Station Failure',
    dept: 'Assembly',
    severity: 'P1',
    confidence_required: 0.6, // 2 of 3
    conditions: [
      {
        metric: 'dvi_throughput_per_hour',
        type: 'z_score',
        direction: 'below',
        threshold: 2.0,
        label: 'Throughput dropping',
      },
      {
        metric: 'dvi_wip_pileup',
        type: 'z_score',
        direction: 'above',
        threshold: 2.0,
        label: 'Queue building up in assembly',
      },
      {
        metric: 'dvi_hold_count',
        type: 'z_score',
        direction: 'above',
        threshold: 1.5,
        label: 'Jobs going on hold',
      },
    ],
    message: 'Assembly station likely down — throughput dropping while queue builds.',
    recommended_action: 'Check Assembly Dashboard for idle stations. Verify operator assignments. Look for equipment faults on STN-01 through STN-08.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 2. Tool wear degradation in surfacing
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'tool-wear-degradation',
    name: 'Surfacing Tool Wear',
    dept: 'Surfacing',
    severity: 'P2',
    confidence_required: 0.6, // 2 of 3
    conditions: [
      {
        metric: 'cycle_time_surfacing',
        type: 'z_score',
        direction: 'above',
        threshold: 1.8,
        label: 'Surfacing cycle time creeping up',
      },
      {
        metric: 'breakage_surfacing',
        type: 'z_score',
        direction: 'above',
        threshold: 1.5,
        label: 'Surfacing breakage rising',
      },
      {
        metric: 'dvi_throughput_per_hour',
        type: 'z_score',
        direction: 'below',
        threshold: 1.5,
        label: 'Overall throughput declining',
      },
    ],
    message: 'Surfacing tool wear suspected — cycle times rising with increasing breakage.',
    recommended_action: 'Inspect DBA generator cutting tools for wear. Check coolant levels and spindle condition. Review breakage_events for surfacing-specific failures. Schedule tool replacement if confirmed.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 3. Coating oven temperature drift
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'coating-temp-drift',
    name: 'Coating Temperature Drift',
    dept: 'Coating',
    severity: 'P1',
    confidence_required: 0.5, // 1 of 2 (either signal is serious)
    conditions: [
      {
        metric: 'oven_overdue_racks',
        type: 'absolute',
        direction: 'above',
        threshold: 2,
        label: 'Multiple oven racks running past target time',
      },
      {
        metric: 'coating_reject_rate',
        type: 'z_score',
        direction: 'above',
        threshold: 2.0,
        label: 'Coating reject rate spiking',
      },
    ],
    message: 'Coating oven temperature drift — overdue racks and/or rising reject rate.',
    recommended_action: 'Check oven temperature logs vs setpoint. Inspect thermocouple readings. Review coating solution age and humidity. Pull current batch for QC inspection before continuing.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 4. Kardex retrieval slowdown
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'kardex-retrieval-slowdown',
    name: 'Kardex Retrieval Slowdown',
    dept: 'Picking',
    severity: 'P2',
    confidence_required: 0.5, // 1 of 2
    conditions: [
      {
        metric: 'itempath_consumption_rate',
        type: 'z_score',
        direction: 'below',
        threshold: 2.0,
        label: 'Pick rate dropping below normal',
      },
      {
        metric: 'itempath_stockouts',
        type: 'z_score',
        direction: 'above',
        threshold: 1.5,
        label: 'Stockout SKUs increasing',
      },
    ],
    message: 'Kardex retrieval slowdown — pick rate below normal with stockouts rising.',
    recommended_action: 'Check Kardex carousel for mechanical issues or sensor faults. Verify ItemPath connectivity. Review operator pick queue for stuck orders. Check if carousel is in maintenance mode.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 5. Cascade queue buildup (cross-department bottleneck)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'cascade-queue-buildup',
    name: 'Cascade Queue Buildup',
    dept: 'Production',
    severity: 'P1',
    confidence_required: 0.6, // 2 of 3
    conditions: [
      {
        metric: 'dvi_wip_pileup',
        type: 'z_score',
        direction: 'above',
        threshold: 2.5,
        label: 'WIP accumulating in one zone',
      },
      {
        metric: 'dvi_throughput_per_hour',
        type: 'z_score',
        direction: 'below',
        threshold: 2.0,
        label: 'Throughput dropping',
      },
      {
        metric: 'dvi_total_wip',
        type: 'z_score',
        direction: 'above',
        threshold: 1.8,
        label: 'Total WIP rising above normal',
      },
    ],
    message: 'Cascade queue buildup — WIP piling up with throughput dropping. Bottleneck propagating across departments.',
    recommended_action: 'Identify the zone with highest WIP from DVI data. Check that zone for machine downtime, staffing gaps, or capacity limits. Temporarily redistribute staff to the bottleneck zone. Consider pausing upstream input if backup is severe.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 6. Vision scan failure spike (stub — metric not yet collected)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'scan-failure-spike',
    name: 'Vision Scan Failure Spike',
    dept: 'Vision',
    severity: 'P2',
    confidence_required: 1.0, // Only 1 condition — must be definitive
    conditions: [
      {
        metric: 'vision_scan_fail_rate',
        type: 'z_score',
        direction: 'above',
        threshold: 2.5,
        label: 'Scan failure rate above normal',
      },
    ],
    message: 'Vision scan failure rate spiking — likely camera or lighting issue.',
    recommended_action: 'Check vision system camera lens for debris. Verify lighting conditions at scan station. Review recent scan failures for common patterns (lens type, coating, etc.). Restart vision controller if needed.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 7. End-of-shift production cliff
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'end-of-shift-cliff',
    name: 'End-of-Shift Cliff',
    dept: 'Production',
    severity: 'P3',
    confidence_required: 0.5, // 1 of 2
    conditions: [
      {
        metric: 'dvi_throughput_per_hour',
        type: 'z_score',
        direction: 'below',
        threshold: 2.0,
        label: 'Throughput dropping sharply',
      },
      {
        metric: 'dvi_shipped_per_hour',
        type: 'z_score',
        direction: 'below',
        threshold: 2.0,
        label: 'Ship rate falling off',
      },
    ],
    message: 'End-of-shift production cliff — throughput and/or ship rate dropping sharply.',
    recommended_action: 'Check if operators are wrapping up early. Review shift schedule for early departures. If within last 2 hours of shift, this may be normal wind-down but verify it is not premature.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 8. Repeated machine failures (SOM)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'machine-repeated-failure',
    name: 'Machine Repeated Failure',
    dept: 'SOM',
    severity: 'P1',
    confidence_required: 0.5, // 1 of 2 — either signal alone is serious
    conditions: [
      {
        metric: 'som_repeated_failures',
        type: 'z_score',
        direction: 'above',
        threshold: 2.0,
        label: 'Multiple devices failing repeatedly',
      },
      {
        metric: 'som_downtime_minutes',
        type: 'z_score',
        direction: 'above',
        threshold: 2.5,
        label: 'Downtime minutes well above normal',
      },
    ],
    message: 'Machine experiencing repeated failures — not recovering from restarts.',
    recommended_action: 'Check SOM Control Center for specific device fault codes. Do NOT just restart — repeated failures indicate a root cause (jam, sensor, motor). Create Limble work order. Pull machine offline if it has failed 3+ times in the last hour.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 9. Yield crash (multi-department breakage)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'yield-crash',
    name: 'Production Yield Crash',
    dept: 'Production',
    severity: 'P1',
    confidence_required: 0.5, // 2 of 4
    conditions: [
      {
        metric: 'breakage_rate',
        type: 'z_score',
        direction: 'above',
        threshold: 2.5,
        label: 'Overall breakage rate spiking',
      },
      {
        metric: 'breakage_surfacing',
        type: 'z_score',
        direction: 'above',
        threshold: 2.0,
        label: 'Surfacing breakage up',
      },
      {
        metric: 'breakage_coating',
        type: 'z_score',
        direction: 'above',
        threshold: 2.0,
        label: 'Coating breakage up',
      },
      {
        metric: 'coating_reject_rate',
        type: 'z_score',
        direction: 'above',
        threshold: 2.0,
        label: 'Coating reject rate elevated',
      },
    ],
    message: 'Yield crash — breakage rate spiking across departments.',
    recommended_action: 'Pull breakage_events by department to identify the source. Check if a specific lens material or coating type is failing. Review whether incoming blank quality has changed. Escalate if breakage > 5% of daily throughput.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 10. Lens consumption runaway (ItemPath)
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'lens-consumption-runaway',
    name: 'Lens Consumption Runaway',
    dept: 'ItemPath',
    severity: 'P2',
    confidence_required: 0.5, // 1 of 2
    conditions: [
      {
        metric: 'itempath_consumption_rate',
        type: 'z_score',
        direction: 'above',
        threshold: 3.0,
        label: 'Consumption rate way above normal',
      },
      {
        metric: 'itempath_daily_consumption',
        type: 'z_score',
        direction: 'above',
        threshold: 2.5,
        label: 'Daily consumption well above baseline',
      },
    ],
    message: 'Lens blank consumption running far above normal — stock will deplete faster than expected.',
    recommended_action: 'Check if high consumption is driven by remakes (breakage) or genuine demand. Review ItemPath transactions for duplicate picks or mis-picks. If remakes, fix root cause first. If demand, check stock runway and escalate to purchasing if < 2 days of safety stock.',
  },

  // ══════════════════════════════════════════════════════════════════════════
  // 11. Network outage causing production impact
  // ══════════════════════════════════════════════════════════════════════════
  {
    id: 'network-outage-production-impact',
    name: 'Network Outage Production Impact',
    dept: 'Network',
    severity: 'P1',
    confidence_required: 0.5, // 2 of 4 — network issue + any production drop
    conditions: [
      {
        metric: 'network_devices_offline',
        type: 'absolute',
        direction: 'above',
        threshold: 1,
        label: 'Network device(s) offline',
      },
      {
        metric: 'network_wan_status',
        type: 'absolute',
        direction: 'below',
        threshold: 1,
        label: 'WAN link down',
      },
      {
        metric: 'dvi_throughput_per_hour',
        type: 'z_score',
        direction: 'below',
        threshold: 1.5,
        label: 'Production throughput dropping',
      },
      {
        metric: 'dvi_shipped_per_hour',
        type: 'z_score',
        direction: 'below',
        threshold: 1.5,
        label: 'Ship rate declining',
      },
    ],
    message: 'Network outage correlated with production loss — network issue likely causing DVI/ItemPath/SOM connectivity failures.',
    recommended_action: 'Check UniFi controller for offline devices and WAN status. Verify that DVI, ItemPath, and SOM adapters can reach their endpoints. If WAN is down, check ISP status and failover. Production systems on affected VLANs will stall until connectivity is restored.',
  },

];

// ─── PATTERN EVALUATION ENGINE ───────────────────────────────────────────────

/**
 * Compute z-score for a value against a baseline.
 * @param {number} value - Current metric value
 * @param {object} baseline - { mean, stddev }
 * @returns {number} z-score (signed)
 */
function zScore(value, baseline) {
  if (!baseline || baseline.stddev == null || baseline.stddev < 0.001) return 0;
  return (value - baseline.mean) / baseline.stddev;
}

/**
 * Check whether a single condition is satisfied.
 * @param {object} condition - Pattern condition definition
 * @param {Map} readingMap - metric -> { value, ... }
 * @param {function} getBaseline - (metric) => { mean, stddev } | null
 * @returns {boolean}
 */
function checkCondition(condition, readingMap, getBaseline) {
  const reading = readingMap.get(condition.metric);
  if (!reading) return false;

  const value = reading.value;

  if (condition.type === 'absolute') {
    if (condition.direction === 'above') return value > condition.threshold;
    if (condition.direction === 'below') return value < condition.threshold;
    return false;
  }

  if (condition.type === 'z_score') {
    const baseline = getBaseline(condition.metric);
    if (!baseline || baseline.stddev == null || baseline.stddev < 0.001) return false;

    const z = zScore(value, baseline);

    if (condition.direction === 'above') return z >= condition.threshold;
    if (condition.direction === 'below') return z <= -condition.threshold;
    return Math.abs(z) >= condition.threshold;
  }

  if (condition.type === 'exists') {
    return true; // metric is present in readings
  }

  return false;
}

/**
 * Evaluate all patterns against current readings.
 *
 * @param {Array<{metric, system, value, unit}>} readings - Current poll cycle readings
 * @param {function} getBaseline - (metric) => { mean, stddev } | null
 * @returns {Array<{id, name, severity, message, recommended_action, conditions_met, conditions_total, confidence}>}
 */
function evaluatePatterns(readings, getBaseline) {
  if (!readings || readings.length === 0) return [];

  // Build lookup map: metric -> reading
  const readingMap = new Map();
  for (const r of readings) {
    readingMap.set(r.metric, r);
  }

  const fired = [];

  for (const pattern of PATTERNS) {
    const total = pattern.conditions.length;
    if (total === 0) continue;

    let met = 0;
    const conditionResults = [];

    for (const condition of pattern.conditions) {
      const satisfied = checkCondition(condition, readingMap, getBaseline);
      if (satisfied) met++;
      conditionResults.push({
        metric: condition.metric,
        label: condition.label,
        satisfied,
      });
    }

    const confidence = met / total;

    if (confidence >= pattern.confidence_required) {
      fired.push({
        id: pattern.id,
        name: pattern.name,
        dept: pattern.dept,
        severity: pattern.severity,
        message: pattern.message,
        recommended_action: pattern.recommended_action,
        conditions_met: met,
        conditions_total: total,
        confidence: Math.round(confidence * 100) / 100,
        conditions_detail: conditionResults,
      });
    }
  }

  // Sort by severity (P1 > P2 > P3), then by confidence descending
  fired.sort((a, b) => {
    const sevOrder = { P1: 1, P2: 2, P3: 3 };
    const sa = sevOrder[a.severity] || 9;
    const sb = sevOrder[b.severity] || 9;
    if (sa !== sb) return sa - sb;
    return b.confidence - a.confidence;
  });

  return fired;
}

module.exports = { PATTERNS, evaluatePatterns };
