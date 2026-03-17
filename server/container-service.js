/**
 * container-service.js — Container Inheritance Service for Coating Pipeline
 *
 * Tracks jobs through: Tool → Oven Tray → Coating Batch
 * Three-table model: containers, container_jobs, container_contents
 * Manifests are always computed by walking the tree, never copied.
 *
 * All functions are synchronous (better-sqlite3).
 * All IDs are strings (e.g. 'TOOL-006', 'TRAY-003', 'BATCH-041').
 */

'use strict';

const db = require('./db');

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
    INSERT INTO containers (id, type, status, operator_id, machine_id, coating_type, notes)
    VALUES (@id, @type, @status, @operator_id, @machine_id, @coating_type, @notes)
  `),

  updateContainerStatus: db.prepare(`
    UPDATE containers SET status = @status, closed_at = @closed_at, consumed_at = @consumed_at
    WHERE id = @id
  `),

  getJobsByContainer: db.prepare('SELECT * FROM container_jobs WHERE container_id = ?'),

  insertJob: db.prepare(`
    INSERT INTO container_jobs (container_id, job_number, eye_side, ocr_confidence, entry_method)
    VALUES (@container_id, @job_number, @eye_side, @ocr_confidence, @entry_method)
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

  findOrphans: db.prepare(`
    SELECT * FROM containers
    WHERE type = 'tool' AND status = 'open'
    AND created_at < datetime('now', '-' || ? || ' hours')
  `),
};

// ─────────────────────────────────────────────────────────────────────────────
// 1. getManifest(containerId)
// ─────────────────────────────────────────────────────────────────────────────

function getManifest(containerId) {
  const container = stmts.getContainer.get(containerId);
  if (!container) fail('CONTAINER_NOT_FOUND', `Container ${containerId} not found`);

  if (container.type === 'tool') {
    // Base case: jobs live directly on tools
    const jobs = stmts.getJobsByContainer.all(containerId);
    return jobs.map(j => ({
      job_number: j.job_number,
      eye_side: j.eye_side,
      source_tool: containerId,
      entry_method: j.entry_method,
      ocr_confidence: j.ocr_confidence,
      created_at: j.created_at,
    }));
  }

  // Recursive case: collect from children
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

  // Take the most recent entry
  const entry = entries[0];
  const toolId = entry.tool_id;

  // Walk up the tree: tool → tray → batch
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
    notes: null,
  });

  return stmts.getContainer.get(toolId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 4. addJobToTool(toolId, jobNumber, eyeSide, ocrConfidence, entryMethod)
// ─────────────────────────────────────────────────────────────────────────────

function addJobToTool(toolId, jobNumber, eyeSide, ocrConfidence, entryMethod) {
  // Validate eye side
  if (eyeSide !== 'L' && eyeSide !== 'R') {
    fail('INVALID_EYE_SIDE', `eye_side must be L or R, got '${eyeSide}'`);
  }

  // Validate tool is open
  const tool = stmts.findOpenToolSession.get(toolId);
  if (!tool) {
    fail('TOOL_NOT_OPEN', `Tool ${toolId} is not open or does not exist`);
  }

  // Cross-tool dedup: check if job+eye exists on any other open tool
  const duplicate = stmts.findJobOnOpenTools.get(jobNumber, eyeSide);
  if (duplicate) {
    fail('JOB_ALREADY_ON_TOOL', `Job ${jobNumber} ${eyeSide} is already on open tool ${duplicate.tool_id}`);
  }

  stmts.insertJob.run({
    container_id: toolId,
    job_number: jobNumber,
    eye_side: eyeSide,
    ocr_confidence: ocrConfidence != null ? ocrConfidence : null,
    entry_method: entryMethod || 'ocr',
  });

  return stmts.getJobsByContainer.all(toolId);
}

// ─────────────────────────────────────────────────────────────────────────────
// 5. closeToolSession(toolId)
// ─────────────────────────────────────────────────────────────────────────────

function closeToolSession(toolId) {
  const tool = stmts.getContainer.get(toolId);
  if (!tool) fail('CONTAINER_NOT_FOUND', `Tool ${toolId} not found`);
  if (tool.type !== 'tool') fail('NOT_A_TOOL', `Container ${toolId} is type '${tool.type}', not 'tool'`);
  if (tool.status !== 'open') fail('TOOL_NOT_OPEN', `Tool ${toolId} status is '${tool.status}', expected 'open'`);

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
// 6. transferToolsToTray(trayId, toolIds, operatorId)
// ─────────────────────────────────────────────────────────────────────────────

const _transferToolsToTray = db.transaction((trayId, toolIds, operatorId) => {
  // Create tray if it doesn't exist
  let tray = stmts.getContainer.get(trayId);
  if (!tray) {
    stmts.insertContainer.run({
      id: trayId,
      type: 'oven_tray',
      status: 'open',
      operator_id: operatorId || null,
      machine_id: null,
      coating_type: null,
      notes: null,
    });
    tray = stmts.getContainer.get(trayId);
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
// 8. transferTraysToatch(batchId, trayIds, machineId, coatingType, operatorId)
// ─────────────────────────────────────────────────────────────────────────────

const _transferTraysToBatch = db.transaction((batchId, trayIds, machineId, coatingType, operatorId) => {
  // Create batch if it doesn't exist
  let batch = stmts.getContainer.get(batchId);
  if (!batch) {
    stmts.insertContainer.run({
      id: batchId,
      type: 'coating_batch',
      status: 'open',
      operator_id: operatorId || null,
      machine_id: machineId || null,
      coating_type: coatingType || null,
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
// 9. getActiveContainers()
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
