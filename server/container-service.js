/**
 * container-service.js — Container Inheritance Service for Coating Pipeline
 *
 * Tracks jobs through: Tool → Oven Tray → Coating Batch
 * Three-table model: containers, container_jobs, container_contents
 * Manifests are always computed by walking the tree, never copied.
 *
 * DVI Enrichment: When jobs are scanned onto tools, coating/material/rush/lens_type
 * are stored alongside the job. This enables material validation at every transfer point.
 *
 * Material is a HARD constraint — all lenses in a batch MUST be same coating + material.
 * Validation happens at: tool close (all-same), tool→tray (match tray), tray→batch (match batch).
 *
 * All functions are synchronous (better-sqlite3).
 * All IDs are strings (e.g. 'TOOL-006', 'TRAY-003', 'BATCH-041').
 */

'use strict';

const { db } = require('./db');

// ─────────────────────────────────────────────────────────────────────────────
// ERROR HELPER
// ─────────────────────────────────────────────────────────────────────────────

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

// ─────────────────────────────────────────────────────────────────────────────
// PREPARED STATEMENTS
// ─────────────────────────────────────────────────────────────────────────────

const stmts = {
  getContainer:        db.prepare('SELECT * FROM containers WHERE id = ?'),
  getContainersByType: db.prepare('SELECT * FROM containers WHERE type = ? AND status != ?'),

  insertContainer: db.prepare(`
    INSERT INTO containers (id, type, status, operator_id, machine_id, coating_type, material, notes)
    VALUES (@id, @type, @status, @operator_id, @machine_id, @coating_type, @material, @notes)
  `),

  updateContainerStatus: db.prepare(`
    UPDATE containers SET status = @status, closed_at = @closed_at, consumed_at = @consumed_at
    WHERE id = @id
  `),

  updateContainerTags: db.prepare(`
    UPDATE containers SET coating_type = ?, material = ? WHERE id = ?
  `),

  getJobsByContainer: db.prepare('SELECT * FROM container_jobs WHERE container_id = ?'),

  insertJob: db.prepare(`
    INSERT INTO container_jobs (container_id, job_number, eye_side, ocr_confidence, entry_method, coating, material, rush, lens_type)
    VALUES (@container_id, @job_number, @eye_side, @ocr_confidence, @entry_method, @coating, @material, @rush, @lens_type)
  `),

  findJobOnOpenTools: db.prepare(`
    SELECT cj.*, c.id AS tool_id, c.status AS tool_status
    FROM container_jobs cj
    JOIN containers c ON c.id = cj.container_id
    WHERE cj.job_number = ? AND cj.eye_side = ? AND c.type = 'tool' AND c.status = 'open'
  `),

  getChildren: db.prepare('SELECT * FROM container_contents WHERE parent_id = ?'),
  getParent:   db.prepare('SELECT * FROM container_contents WHERE child_id = ?'),

  insertContents: db.prepare(`
    INSERT INTO container_contents (parent_id, child_id) VALUES (@parent_id, @child_id)
  `),

  findOpenToolSession: db.prepare(`
    SELECT * FROM containers WHERE id = ? AND type = 'tool' AND status = 'open'
  `),

  getJobEntryByJobNumber: db.prepare(`
    SELECT cj.*, c.id AS tool_id
    FROM container_jobs cj
    JOIN containers c ON c.id = cj.container_id
    WHERE cj.job_number = ?
    ORDER BY cj.created_at DESC
  `),

  countJobsByContainer: db.prepare('SELECT COUNT(*) AS cnt FROM container_jobs WHERE container_id = ?'),

  distinctMaterials: db.prepare('SELECT DISTINCT material FROM container_jobs WHERE container_id = ? AND material IS NOT NULL'),
  distinctCoatings: db.prepare('SELECT DISTINCT coating FROM container_jobs WHERE container_id = ? AND coating IS NOT NULL'),

  findOrphans: db.prepare(`
    SELECT * FROM containers
    WHERE type = 'tool' AND status = 'open'
    AND created_at < datetime('now', '-' || ? || ' hours')
  `),
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. getManifest(containerId) — recursive, enriched with coating/material
// ─────────────────────────────────────────────────────────────────────────────

function getManifest(containerId) {
  const container = stmts.getContainer.get(containerId);
  if (!container) fail('CONTAINER_NOT_FOUND', `Container ${containerId} not found`);

  if (container.type === 'tool') {
    const jobs = stmts.getJobsByContainer.all(containerId);
    return jobs.map(j => ({
      job_number: j.job_number,
      eye_side: j.eye_side,
      source_tool: containerId,
      entry_method: j.entry_method,
      ocr_confidence: j.ocr_confidence,
      coating: j.coating,
      material: j.material,
      rush: j.rush,
      lens_type: j.lens_type,
      created_at: j.created_at,
    }));
  }

  const children = stmts.getChildren.all(containerId);
  const allJobs = [];
  for (const child of children) {
    allJobs.push(...getManifest(child.child_id));
  }
  return allJobs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. getJobLocation(jobNumber)
// ─────────────────────────────────────────────────────────────────────────────

function getJobLocation(jobNumber) {
  const entries = stmts.getJobEntryByJobNumber.all(jobNumber);
  if (entries.length === 0) return null;

  const entry = entries[0];
  const toolId = entry.tool_id;

  const lineage = [toolId];
  let currentId = toolId;
  let topContainer = stmts.getContainer.get(toolId);

  while (true) {
    const parentLink = stmts.getParent.get(currentId);
    if (!parentLink) break;
    lineage.push(parentLink.parent_id);
    currentId = parentLink.parent_id;
    topContainer = stmts.getContainer.get(currentId);
  }

  return {
    job_number: entry.job_number,
    eye_side: entry.eye_side,
    current_container: topContainer.id,
    container_type: topContainer.type,
    status: topContainer.status,
    source_tool: toolId,
    lineage,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. openToolSession(toolId, operatorId)
// ─────────────────────────────────────────────────────────────────────────────

function openToolSession(toolId, operatorId) {
  const existing = stmts.findOpenToolSession.get(toolId);
  if (existing) {
    fail('TOOL_ALREADY_OPEN', `Tool ${toolId} already has an open session (opened ${existing.created_at})`);
  }

  stmts.insertContainer.run({
    id: toolId,
    type: 'tool',
    status: 'open',
    operator_id: operatorId || null,
    machine_id: null,
    coating_type: null,
    material: null,
    notes: null,
  });

  return stmts.getContainer.get(toolId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. addJobToTool(toolId, jobNumber, eyeSide, ocrConfidence, entryMethod, dviData)
//    dviData: { coating, material, rush, lensType } or null
// ─────────────────────────────────────────────────────────────────────────────

function addJobToTool(toolId, jobNumber, eyeSide, ocrConfidence, entryMethod, dviData) {
  if (eyeSide !== 'L' && eyeSide !== 'R') {
    fail('INVALID_EYE_SIDE', `eye_side must be L or R, got '${eyeSide}'`);
  }

  const tool = stmts.findOpenToolSession.get(toolId);
  if (!tool) {
    fail('TOOL_NOT_OPEN', `Tool ${toolId} is not open or does not exist`);
  }

  // Cross-tool dedup
  const duplicate = stmts.findJobOnOpenTools.get(jobNumber, eyeSide);
  if (duplicate) {
    fail('JOB_ALREADY_ON_TOOL', `Job ${jobNumber} ${eyeSide} is already on open tool ${duplicate.tool_id}`);
  }

  // Scan-time material warning (not a hard reject — hard reject happens at close)
  let warning = null;
  if (dviData?.material) {
    const existingMaterials = stmts.distinctMaterials.all(toolId);
    if (existingMaterials.length > 0 && !existingMaterials.some(m => m.material === dviData.material)) {
      warning = `Material mismatch: tool has ${existingMaterials.map(m => m.material).join(',')} but this job is ${dviData.material}. Tool will not close until resolved.`;
    }
  }

  stmts.insertJob.run({
    container_id: toolId,
    job_number: jobNumber,
    eye_side: eyeSide,
    ocr_confidence: ocrConfidence != null ? ocrConfidence : null,
    entry_method: entryMethod || 'ocr',
    coating: dviData?.coating || null,
    material: dviData?.material || null,
    rush: dviData?.rush ? 1 : 0,
    lens_type: dviData?.lensType || null,
  });

  const jobs = stmts.getJobsByContainer.all(toolId);
  if (warning) {
    return { jobs, warning };
  }
  return jobs;
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. closeToolSession(toolId) — all-same material check
// ─────────────────────────────────────────────────────────────────────────────

function closeToolSession(toolId) {
  const tool = stmts.getContainer.get(toolId);
  if (!tool) fail('CONTAINER_NOT_FOUND', `Tool ${toolId} not found`);
  if (tool.type !== 'tool') fail('NOT_A_TOOL', `Container ${toolId} is type '${tool.type}', not 'tool'`);
  if (tool.status !== 'open') fail('TOOL_NOT_OPEN', `Tool ${toolId} status is '${tool.status}', expected 'open'`);

  // All-same material check
  const jobs = stmts.getJobsByContainer.all(toolId);
  if (jobs.length > 0) {
    const nullMat = jobs.filter(j => !j.material);
    if (nullMat.length > 0) {
      fail('UNRESOLVED_MATERIAL', `Tool ${toolId} has ${nullMat.length} job(s) with unresolved material (DVI lookup pending). Jobs: ${nullMat.map(j => j.job_number).join(', ')}`);
    }
    const materials = [...new Set(jobs.map(j => j.material))];
    if (materials.length > 1) {
      fail('MIXED_MATERIAL', `Tool ${toolId} has mixed materials: ${materials.join(', ')}. Remove mismatched lenses before closing.`);
    }
    const coatings = [...new Set(jobs.filter(j => j.coating).map(j => j.coating))];
    if (coatings.length > 1) {
      fail('MIXED_COATING', `Tool ${toolId} has mixed coatings: ${coatings.join(', ')}. Remove mismatched lenses before closing.`);
    }

    // Auto-tag tool with coating + material
    stmts.updateContainerTags.run(coatings[0] || null, materials[0] || null, toolId);
  }

  const now = new Date().toISOString();
  stmts.updateContainerStatus.run({
    id: toolId,
    status: 'closed',
    closed_at: now,
    consumed_at: null,
  });

  return stmts.getContainer.get(toolId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 6. transferToolsToTray(trayId, toolIds, operatorId) — material validation
// ─────────────────────────────────────────────────────────────────────────────

const _transferToolsToTray = db.transaction((trayId, toolIds, operatorId) => {
  let tray = stmts.getContainer.get(trayId);
  if (!tray) {
    stmts.insertContainer.run({
      id: trayId,
      type: 'oven_tray',
      status: 'open',
      operator_id: operatorId || null,
      machine_id: null,
      coating_type: null,
      material: null,
      notes: null,
    });
    tray = stmts.getContainer.get(trayId);
  }

  // Determine tray's current material from existing children
  let trayMaterial = tray.material || null;
  let trayCoating = tray.coating_type || null;
  if (!trayMaterial || !trayCoating) {
    const existingChildren = stmts.getChildren.all(trayId);
    for (const child of existingChildren) {
      const childContainer = stmts.getContainer.get(child.child_id);
      if (childContainer) {
        if (!trayMaterial && childContainer.material) trayMaterial = childContainer.material;
        if (!trayCoating && childContainer.coating_type) trayCoating = childContainer.coating_type;
      }
      if (trayMaterial && trayCoating) break;
    }
  }

  const now = new Date().toISOString();
  const results = { loaded: [], rejected: [] };

  for (const toolId of toolIds) {
    const tool = stmts.getContainer.get(toolId);
    if (!tool) {
      results.rejected.push({ id: toolId, reason: 'not found' });
      continue;
    }
    if (tool.status !== 'closed') {
      results.rejected.push({ id: toolId, reason: `status is '${tool.status}', expected 'closed'` });
      continue;
    }

    // Material validation
    if (trayMaterial && tool.material && tool.material !== trayMaterial) {
      results.rejected.push({ id: toolId, reason: `material mismatch: tool has ${tool.material}, tray requires ${trayMaterial}` });
      continue;
    }
    if (trayCoating && tool.coating_type && tool.coating_type !== trayCoating) {
      results.rejected.push({ id: toolId, reason: `coating mismatch: tool has ${tool.coating_type}, tray requires ${trayCoating}` });
      continue;
    }

    // Set tray material/coating from first valid tool
    if (!trayMaterial && tool.material) trayMaterial = tool.material;
    if (!trayCoating && tool.coating_type) trayCoating = tool.coating_type;

    stmts.insertContents.run({ parent_id: trayId, child_id: toolId });
    stmts.updateContainerStatus.run({
      id: toolId,
      status: 'consumed',
      closed_at: tool.closed_at,
      consumed_at: now,
    });
    results.loaded.push(toolId);
  }

  if (results.loaded.length === 0 && results.rejected.length > 0) {
    fail('NO_TOOLS_TRANSFERRED', `No tools could be transferred: ${JSON.stringify(results.rejected)}`);
  }

  // Auto-tag tray
  if (trayMaterial || trayCoating) {
    stmts.updateContainerTags.run(trayCoating, trayMaterial, trayId);
  }

  results.tray = stmts.getContainer.get(trayId);
  results.manifest = getManifest(trayId);
  return results;
});

function transferToolsToTray(trayId, toolIds, operatorId) {
  return _transferToolsToTray(trayId, toolIds, operatorId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 7. closeTray(trayId)
// ─────────────────────────────────────────────────────────────────────────────

function closeTray(trayId) {
  const tray = stmts.getContainer.get(trayId);
  if (!tray) fail('CONTAINER_NOT_FOUND', `Tray ${trayId} not found`);
  if (tray.type !== 'oven_tray') fail('NOT_A_TRAY', `Container ${trayId} is type '${tray.type}', not 'oven_tray'`);
  if (tray.status !== 'open') fail('TRAY_NOT_OPEN', `Tray ${trayId} status is '${tray.status}', expected 'open'`);

  const now = new Date().toISOString();
  stmts.updateContainerStatus.run({
    id: trayId,
    status: 'closed',
    closed_at: now,
    consumed_at: null,
  });

  return stmts.getContainer.get(trayId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 8. transferTraysToBatch — coating+material validation
// ─────────────────────────────────────────────────────────────────────────────

const _transferTraysToBatch = db.transaction((batchId, trayIds, machineId, coatingType, operatorId) => {
  let batch = stmts.getContainer.get(batchId);
  if (!batch) {
    stmts.insertContainer.run({
      id: batchId,
      type: 'coating_batch',
      status: 'open',
      operator_id: operatorId || null,
      machine_id: machineId || null,
      coating_type: coatingType || null,
      material: null,
      notes: null,
    });
    batch = stmts.getContainer.get(batchId);
  }

  const now = new Date().toISOString();
  const results = { loaded: [], rejected: [] };

  for (const trayId of trayIds) {
    const tray = stmts.getContainer.get(trayId);
    if (!tray) {
      results.rejected.push({ id: trayId, reason: 'not found' });
      continue;
    }
    if (tray.status !== 'closed') {
      results.rejected.push({ id: trayId, reason: `status is '${tray.status}', expected 'closed'` });
      continue;
    }

    // Coating validation
    if (batch.coating_type && tray.coating_type && tray.coating_type !== batch.coating_type) {
      results.rejected.push({ id: trayId, reason: `coating mismatch: tray has ${tray.coating_type}, batch requires ${batch.coating_type}` });
      continue;
    }
    // Material validation
    if (batch.material && tray.material && tray.material !== batch.material) {
      results.rejected.push({ id: trayId, reason: `material mismatch: tray has ${tray.material}, batch requires ${batch.material}` });
      continue;
    }

    // Auto-tag batch material from first valid tray
    if (!batch.material && tray.material) {
      db.prepare('UPDATE containers SET material = ? WHERE id = ?').run(tray.material, batchId);
      batch = stmts.getContainer.get(batchId);
    }

    stmts.insertContents.run({ parent_id: batchId, child_id: trayId });
    stmts.updateContainerStatus.run({
      id: trayId,
      status: 'consumed',
      closed_at: tray.closed_at,
      consumed_at: now,
    });
    results.loaded.push(trayId);
  }

  if (results.loaded.length === 0 && results.rejected.length > 0) {
    fail('NO_TRAYS_TRANSFERRED', `No trays could be transferred: ${JSON.stringify(results.rejected)}`);
  }

  results.batch = stmts.getContainer.get(batchId);
  results.manifest = getManifest(batchId);
  return results;
});

function transferTraysToBatch(batchId, trayIds, machineId, coatingType, operatorId) {
  return _transferTraysToBatch(batchId, trayIds, machineId, coatingType, operatorId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 9. getActiveContainers() — enriched with coating_type + material
// ─────────────────────────────────────────────────────────────────────────────

function getActiveContainers() {
  const tools = stmts.getContainersByType.all('tool', 'consumed').map(c => {
    const cnt = stmts.countJobsByContainer.get(c.id);
    return {
      id: c.id,
      status: c.status,
      job_count: cnt.cnt,
      operator: c.operator_id,
      opened_at: c.created_at,
      coating_type: c.coating_type,
      material: c.material,
    };
  });

  const trays = stmts.getContainersByType.all('oven_tray', 'consumed').map(c => {
    const children = stmts.getChildren.all(c.id);
    const childIds = children.map(ch => ch.child_id);
    const manifest = getManifest(c.id);
    return {
      id: c.id,
      status: c.status,
      job_count: manifest.length,
      tools: childIds,
      operator: c.operator_id,
      opened_at: c.created_at,
      coating_type: c.coating_type,
      material: c.material,
    };
  });

  const batches = stmts.getContainersByType.all('coating_batch', 'consumed').map(c => {
    const children = stmts.getChildren.all(c.id);
    const childIds = children.map(ch => ch.child_id);
    const manifest = getManifest(c.id);
    return {
      id: c.id,
      status: c.status,
      job_count: manifest.length,
      trays: childIds,
      machine: c.machine_id,
      coating_type: c.coating_type,
      material: c.material,
      operator: c.operator_id,
      opened_at: c.created_at,
    };
  });

  return { tools, oven_trays: trays, coating_batches: batches };
}

// ─────────────────────────────────────────────────────────────────────────────
// 10. getContainerDetails(containerId)
// ─────────────────────────────────────────────────────────────────────────────

function getContainerDetails(containerId) {
  const container = stmts.getContainer.get(containerId);
  if (!container) fail('CONTAINER_NOT_FOUND', `Container ${containerId} not found`);

  const manifest = getManifest(containerId);
  const children = stmts.getChildren.all(containerId).map(ch => ch.child_id);

  return {
    ...container,
    job_count: manifest.length,
    manifest,
    children,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// 11. findOrphanedSessions(maxHours)
// ─────────────────────────────────────────────────────────────────────────────

function findOrphanedSessions(maxHours) {
  if (!maxHours || maxHours <= 0) maxHours = 8;
  return stmts.findOrphans.all(String(maxHours));
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  getManifest,
  getJobLocation,
  openToolSession,
  addJobToTool,
  closeToolSession,
  transferToolsToTray,
  closeTray,
  transferTraysToBatch,
  getActiveContainers,
  getContainerDetails,
  findOrphanedSessions,
};
