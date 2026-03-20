/**
 * vision-service.js — Vision Self-Training System
 *
 * Persistent scan logging, accuracy tracking, exception resolution,
 * auto-labeling for training, and confidence model sync across iPads.
 *
 * Every scan makes the system smarter:
 * - DVI-confirmed reads auto-label as good_read
 * - Failed reads enter exception queue for operator correction
 * - Corrected reads feed back as training data
 * - Accuracy trends surface degradation (lighting, lens types)
 */

'use strict';

const { db } = require('./db');
const fs = require('fs');
const path = require('path');

// Ensure image storage directories exist
const IMAGE_DIR = path.join(__dirname, '..', 'data', 'vision');
const RAW_DIR = path.join(IMAGE_DIR, 'raw');
const LABELED_DIR = path.join(IMAGE_DIR, 'labeled');
for (const dir of [IMAGE_DIR, RAW_DIR, path.join(LABELED_DIR, 'good_read'), path.join(LABELED_DIR, 'bad_read')]) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ─── PREPARED STATEMENTS ───────────────────────────────────────────────────

const stmts = {
  insertRead: db.prepare(`
    INSERT INTO vision_reads (capture_id, job_number, eye_side, ocr_confidence, raw_text, device, station_id, operator_id, tool_id, matched, matched_job_id, matched_stage, validation_reason, resolution_type, image_path, model_version, scanned_at)
    VALUES (@capture_id, @job_number, @eye_side, @ocr_confidence, @raw_text, @device, @station_id, @operator_id, @tool_id, @matched, @matched_job_id, @matched_stage, @validation_reason, @resolution_type, @image_path, @model_version, @scanned_at)
  `),

  insertLabel: db.prepare(`
    INSERT INTO vision_labels (capture_id, label, label_source, image_path)
    VALUES (?, ?, ?, ?)
  `),

  getRead: db.prepare('SELECT * FROM vision_reads WHERE id = ?'),
  getReadByCaptureId: db.prepare('SELECT * FROM vision_reads WHERE capture_id = ?'),

  resolveRead: db.prepare(`
    UPDATE vision_reads SET correct_job = ?, resolution_type = 'manual_override', operator_id = COALESCE(?, operator_id)
    WHERE id = ?
  `),

  // Accuracy queries
  getAccuracyTotals: db.prepare(`
    SELECT COUNT(*) as total, SUM(matched) as matched,
      ROUND(AVG(ocr_confidence), 3) as avg_confidence
    FROM vision_reads WHERE scanned_at >= ?
  `),

  getAccuracyByStation: db.prepare(`
    SELECT station_id, COUNT(*) as total, SUM(matched) as matched,
      ROUND(CAST(SUM(matched) AS REAL) / COUNT(*) * 100, 1) as success_rate
    FROM vision_reads WHERE scanned_at >= ? AND station_id IS NOT NULL
    GROUP BY station_id ORDER BY total DESC
  `),

  getAccuracyByDay: db.prepare(`
    SELECT DATE(scanned_at) as day, COUNT(*) as total, SUM(matched) as matched,
      ROUND(CAST(SUM(matched) AS REAL) / COUNT(*) * 100, 1) as success_rate,
      ROUND(AVG(ocr_confidence), 3) as avg_confidence
    FROM vision_reads WHERE scanned_at >= ?
    GROUP BY day ORDER BY day DESC
  `),

  getConfidenceDistribution: db.prepare(`
    SELECT
      CASE
        WHEN ocr_confidence >= 0.9 THEN '90-100'
        WHEN ocr_confidence >= 0.8 THEN '80-90'
        WHEN ocr_confidence >= 0.7 THEN '70-80'
        WHEN ocr_confidence >= 0.6 THEN '60-70'
        WHEN ocr_confidence >= 0.5 THEN '50-60'
        ELSE 'below-50'
      END as bucket,
      COUNT(*) as count, SUM(matched) as matched
    FROM vision_reads WHERE scanned_at >= ?
    GROUP BY bucket ORDER BY bucket DESC
  `),

  getExceptions: db.prepare(`
    SELECT id, capture_id, job_number, eye_side, ocr_confidence, raw_text,
      device, station_id, validation_reason, image_path, scanned_at
    FROM vision_reads
    WHERE matched = 0 AND resolution_type IS NULL
    ORDER BY scanned_at DESC LIMIT ?
  `),

  getExceptionCount: db.prepare(`
    SELECT COUNT(*) as cnt FROM vision_reads
    WHERE matched = 0 AND resolution_type IS NULL
  `),

  getRecentReads: db.prepare(`
    SELECT * FROM vision_reads ORDER BY scanned_at DESC LIMIT ?
  `),

  getLabelCounts: db.prepare(`
    SELECT label, COUNT(*) as count FROM vision_labels GROUP BY label
  `),

  getActiveModel: db.prepare(`
    SELECT * FROM vision_models WHERE status = 'active' ORDER BY id DESC LIMIT 1
  `),

  getConfidenceSync: db.prepare('SELECT * FROM vision_confidence_sync WHERE id = 1'),

  updateConfidenceSync: db.prepare(`
    UPDATE vision_confidence_sync SET threshold = ?, samples = ?, updated_at = datetime('now') WHERE id = 1
  `),

  getTotalReads: db.prepare('SELECT COUNT(*) as cnt FROM vision_reads'),
};

// ─── PUBLIC API ────────────────────────────────────────────────────────────

module.exports = {
  /**
   * Record a scan attempt. Called from /api/vision/scan handler.
   * Returns the inserted read ID.
   */
  recordRead(params) {
    const captureId = params.capture_id || `scan_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    // Save image if provided
    let imagePath = null;
    if (params.image_data) {
      try {
        const buf = Buffer.from(params.image_data, 'base64');
        imagePath = path.join('data', 'vision', 'raw', `${captureId}.jpg`);
        fs.writeFileSync(path.join(__dirname, '..', imagePath), buf);
      } catch (e) {
        console.warn('[VISION] Image save failed:', e.message);
      }
    }

    const result = stmts.insertRead.run({
      capture_id: captureId,
      job_number: params.job_number || null,
      eye_side: params.eye_side || null,
      ocr_confidence: params.ocr_confidence != null ? params.ocr_confidence : null,
      raw_text: params.raw_text || null,
      device: params.device || null,
      station_id: params.station_id || null,
      operator_id: params.operator_id || null,
      tool_id: params.tool_id || null,
      matched: params.matched ? 1 : 0,
      matched_job_id: params.matched_job_id || null,
      matched_stage: params.matched_stage || null,
      validation_reason: params.validation_reason || null,
      resolution_type: params.matched ? 'auto_confirmed' : null,
      image_path: imagePath,
      model_version: params.model_version || null,
      scanned_at: params.scanned_at || new Date().toISOString(),
    });

    // Auto-label
    const label = params.matched ? 'good_read' : 'bad_read';
    const labelSource = params.matched ? 'auto_dvi' : 'auto_dvi';
    try {
      stmts.insertLabel.run(captureId, label, labelSource, imagePath);
    } catch (e) { /* ignore duplicate */ }

    // Copy image to labeled folder
    if (imagePath) {
      try {
        const dest = path.join(LABELED_DIR, label, `${captureId}.jpg`);
        fs.copyFileSync(path.join(__dirname, '..', imagePath), dest);
      } catch (e) { /* ignore */ }
    }

    return { readId: result.lastInsertRowid, captureId, label };
  },

  /**
   * Accuracy metrics for dashboard
   */
  getAccuracy(params = {}) {
    const days = params.days || 7;
    const since = new Date(Date.now() - days * 86400000).toISOString();

    const totals = stmts.getAccuracyTotals.get(since);
    const byStation = stmts.getAccuracyByStation.all(since);
    const byDay = stmts.getAccuracyByDay.all(since);
    const confidence = stmts.getConfidenceDistribution.all(since);
    const exceptions = stmts.getExceptionCount.get();
    const labels = stmts.getLabelCounts.all();
    const model = stmts.getActiveModel.get();
    const totalAll = stmts.getTotalReads.get();

    const successRate = totals.total > 0 ? Math.round((totals.matched / totals.total) * 1000) / 10 : 100;

    return {
      period: `${days}d`,
      successRate,
      totalScans: totals.total,
      matchedScans: totals.matched || 0,
      avgConfidence: totals.avg_confidence || 0,
      exceptionsPending: exceptions.cnt,
      totalAllTime: totalAll.cnt,
      byStation,
      byDay,
      confidenceDistribution: confidence,
      labelCounts: Object.fromEntries(labels.map(l => [l.label, l.count])),
      model: model ? { version: model.version, f1: model.f1_score, status: model.status, sampleCount: model.sample_count } : null,
    };
  },

  /**
   * Exception queue — failed reads needing operator resolution
   */
  getExceptions(limit = 50) {
    return stmts.getExceptions.all(limit);
  },

  /**
   * Resolve an exception — operator provides correct job number
   */
  resolveException(readId, correctJob, operatorId) {
    const read = stmts.getRead.get(readId);
    if (!read) return { error: 'Read not found' };

    stmts.resolveRead.run(correctJob, operatorId || null, readId);

    // Re-label as corrected good_read (feeds training data)
    if (read.capture_id) {
      try {
        stmts.insertLabel.run(read.capture_id, 'good_read', 'operator_corrected', read.image_path);
      } catch (e) { /* ignore duplicate */ }
    }

    return { resolved: true, readId, correctJob };
  },

  /**
   * Recent scans for display
   */
  getRecentReads(limit = 50) {
    return stmts.getRecentReads.all(limit);
  },

  /**
   * Training data export
   */
  getTrainingData(since) {
    const sinceDate = since || new Date(Date.now() - 90 * 86400000).toISOString();
    return db.prepare(`
      SELECT vl.capture_id, vl.label, vl.label_source, vl.image_path,
        vr.ocr_confidence, vr.job_number, vr.scanned_at
      FROM vision_labels vl
      LEFT JOIN vision_reads vr ON vl.capture_id = vr.capture_id
      WHERE vl.created_at >= ?
      ORDER BY vl.created_at DESC
    `).all(sinceDate);
  },

  /**
   * Confidence model sync — get current shared model
   */
  getModelSync() {
    const row = stmts.getConfidenceSync.get();
    return {
      threshold: row?.threshold || 0.5,
      samples: row?.samples ? JSON.parse(row.samples) : [],
      updatedAt: row?.updated_at,
    };
  },

  /**
   * Confidence model sync — upload from iPad, merge
   */
  setModelSync(threshold, samples) {
    const existing = this.getModelSync();
    // Merge samples (deduplicate by keeping most recent)
    const merged = [...existing.samples];
    for (const s of (samples || [])) {
      if (!merged.some(m => m.confidence === s.confidence && m.wasCorrect === s.wasCorrect && m.timestamp === s.timestamp)) {
        merged.push(s);
      }
    }
    // Keep last 500 samples
    const trimmed = merged.slice(-500);
    stmts.updateConfidenceSync.run(threshold, JSON.stringify(trimmed));
    return { threshold, sampleCount: trimmed.length };
  },

  /**
   * AI-ready context for agents
   */
  getAIContext() {
    return this.getAccuracy({ days: 7 });
  },
};
