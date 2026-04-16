/**
 * knowledge-adapter.js — Lab Knowledge Base
 * ──────────────────────────────────────────
 * Stores and retrieves documents for AI agent training:
 *   - SOPs, reports, recipes, general docs
 *   - Per-agent tagging (which agents see which docs)
 *   - Text extraction for AI context injection
 *   - Search by keyword, category, agent
 *
 * Storage: server/knowledge/{category}/{filename}
 * Index:   server/knowledge/index.json
 *
 * REST API (mounted in oven-timer-server.js):
 *   POST   /api/knowledge/upload     ← Upload doc (multipart)
 *   GET    /api/knowledge/list       ← List all docs (optional ?agent=&category=)
 *   GET    /api/knowledge/search     ← Search docs (?q=keyword&agent=)
 *   GET    /api/knowledge/doc/:id    ← Get doc metadata + content
 *   GET    /api/knowledge/file/:id   ← Download original file
 *   DELETE /api/knowledge/doc/:id    ← Remove doc
 *   PATCH  /api/knowledge/doc/:id    ← Update metadata (tags, agents, always_on)
 *   GET    /api/knowledge/context    ← Get always-on context for an agent (?agent=)
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const KNOWLEDGE_DIR = path.join(__dirname, 'knowledge');
const INDEX_FILE = path.join(KNOWLEDGE_DIR, 'index.json');

// Valid categories
const CATEGORIES = ['sops', 'reports', 'recipes', 'general'];

// Agent names that can be tagged
const VALID_AGENTS = [
  'LabAgent', 'CoatingAgent', 'SurfacingAgent', 'CuttingAgent',
  'AssemblyAgent', 'QCAgent', 'ShippingAgent', 'PickingAgent',
  'MaintenanceAgent', 'DirectorAgent', 'DevOpsAgent', 'OfficeAgent',
  'ShiftReportAgent', 'CodingAgent'
];

// ─────────────────────────────────────────────────────────────────────────────
// INDEX MANAGEMENT
// ─────────────────────────────────────────────────────────────────────────────

let index = [];

function loadIndex() {
  try {
    if (fs.existsSync(INDEX_FILE)) {
      index = JSON.parse(fs.readFileSync(INDEX_FILE, 'utf-8'));
    }
  } catch (e) {
    console.error('[Knowledge] Failed to load index:', e.message);
    index = [];
  }
}

function saveIndex() {
  try {
    fs.writeFileSync(INDEX_FILE, JSON.stringify(index, null, 2));
  } catch (e) {
    console.error('[Knowledge] Failed to save index:', e.message);
  }
}

loadIndex();
console.log(`[Knowledge] Loaded ${index.length} documents`);

// ─────────────────────────────────────────────────────────────────────────────
// TEXT EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

function extractText(filePath, mimeType) {
  try {
    // Plain text files
    if (mimeType?.startsWith('text/') || /\.(txt|md|csv|json|xml|html|log|toml|yaml|yml)$/i.test(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    // For PDF/DOCX — store raw, extract on demand or use filename + description
    // In v1, we rely on user-provided description + title for non-text files
    return null;
  } catch (e) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCUMENT OPERATIONS
// ─────────────────────────────────────────────────────────────────────────────

function generateId() {
  return 'kb_' + crypto.randomBytes(6).toString('hex');
}

/**
 * Add a document to the knowledge base
 */
function addDocument({ filename, category, title, description, agents, tags, alwaysOn, content, mimeType }) {
  if (!CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: ${category}. Must be one of: ${CATEGORIES.join(', ')}`);
  }

  const id = generateId();
  const destDir = path.join(KNOWLEDGE_DIR, category);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  // Save file
  const safeFilename = `${id}_${filename.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
  const destPath = path.join(destDir, safeFilename);

  if (Buffer.isBuffer(content)) {
    fs.writeFileSync(destPath, content);
  } else {
    fs.writeFileSync(destPath, content, 'utf-8');
  }

  // Extract text content for search/AI
  const textContent = extractText(destPath, mimeType);

  // Save extracted text alongside original
  if (textContent) {
    fs.writeFileSync(destPath + '.txt', textContent, 'utf-8');
  }

  const doc = {
    id,
    filename: safeFilename,
    originalName: filename,
    category,
    title: title || filename,
    description: description || '',
    agents: (agents || []).filter(a => VALID_AGENTS.includes(a)),
    tags: tags || [],
    alwaysOn: alwaysOn || false,
    mimeType: mimeType || 'application/octet-stream',
    size: Buffer.isBuffer(content) ? content.length : Buffer.byteLength(content, 'utf-8'),
    hasText: !!textContent,
    uploadedAt: Date.now(),
    updatedAt: Date.now(),
  };

  index.push(doc);
  saveIndex();
  console.log(`[Knowledge] Added: ${doc.title} (${doc.category}) → ${doc.agents.join(', ') || 'all agents'}`);
  return doc;
}

/**
 * Get document metadata by ID
 */
function getDocument(id) {
  return index.find(d => d.id === id) || null;
}

/**
 * Get document text content
 */
function getDocumentText(id) {
  const doc = getDocument(id);
  if (!doc) return null;

  const txtPath = path.join(KNOWLEDGE_DIR, doc.category, doc.filename + '.txt');
  if (fs.existsSync(txtPath)) {
    return fs.readFileSync(txtPath, 'utf-8');
  }

  // Try reading original if text-based
  const origPath = path.join(KNOWLEDGE_DIR, doc.category, doc.filename);
  return extractText(origPath, doc.mimeType);
}

/**
 * Get original file path for download
 */
function getFilePath(id) {
  const doc = getDocument(id);
  if (!doc) return null;
  return path.join(KNOWLEDGE_DIR, doc.category, doc.filename);
}

/**
 * Delete a document
 */
function deleteDocument(id) {
  const doc = getDocument(id);
  if (!doc) return false;

  const filePath = path.join(KNOWLEDGE_DIR, doc.category, doc.filename);
  try { fs.unlinkSync(filePath); } catch (e) { console.warn('[Knowledge] Failed to delete file:', e.message); }
  try { fs.unlinkSync(filePath + '.txt'); } catch (e) { console.warn('[Knowledge] Failed to delete txt sidecar:', e.message); }

  index = index.filter(d => d.id !== id);
  saveIndex();
  console.log(`[Knowledge] Deleted: ${doc.title}`);
  return true;
}

/**
 * Update document metadata
 */
function updateDocument(id, updates) {
  const doc = getDocument(id);
  if (!doc) return null;

  if (updates.title !== undefined) doc.title = updates.title;
  if (updates.description !== undefined) doc.description = updates.description;
  if (updates.agents !== undefined) doc.agents = updates.agents.filter(a => VALID_AGENTS.includes(a));
  if (updates.tags !== undefined) doc.tags = updates.tags;
  if (updates.alwaysOn !== undefined) doc.alwaysOn = updates.alwaysOn;
  if (updates.category !== undefined && CATEGORIES.includes(updates.category)) {
    // Move file to new category
    const oldPath = path.join(KNOWLEDGE_DIR, doc.category, doc.filename);
    const newDir = path.join(KNOWLEDGE_DIR, updates.category);
    if (!fs.existsSync(newDir)) fs.mkdirSync(newDir, { recursive: true });
    const newPath = path.join(newDir, doc.filename);
    try {
      fs.renameSync(oldPath, newPath);
      if (fs.existsSync(oldPath + '.txt')) fs.renameSync(oldPath + '.txt', newPath + '.txt');
    } catch (e) { console.warn('[Knowledge] Failed to move file to new category:', e.message); }
    doc.category = updates.category;
  }
  doc.updatedAt = Date.now();

  saveIndex();
  return doc;
}

/**
 * List documents with optional filters
 */
function listDocuments({ agent, category, tag } = {}) {
  let results = [...index];
  if (agent) results = results.filter(d => d.agents.length === 0 || d.agents.includes(agent));
  if (category) results = results.filter(d => d.category === category);
  if (tag) results = results.filter(d => d.tags.includes(tag));
  return results.sort((a, b) => b.uploadedAt - a.uploadedAt);
}

/**
 * Search documents by keyword (searches title, description, tags, and text content)
 */
function searchDocuments(query, { agent, category, limit = 10 } = {}) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];

  let candidates = listDocuments({ agent, category });

  const scored = candidates.map(doc => {
    let score = 0;
    const titleLower = (doc.title || '').toLowerCase();
    const descLower = (doc.description || '').toLowerCase();
    const tagsLower = (doc.tags || []).join(' ').toLowerCase();

    for (const term of terms) {
      if (titleLower.includes(term)) score += 10;
      if (descLower.includes(term)) score += 5;
      if (tagsLower.includes(term)) score += 8;
    }

    // Search text content if available
    if (score === 0 || terms.length > 0) {
      const text = getDocumentText(doc.id);
      if (text) {
        const textLower = text.toLowerCase();
        for (const term of terms) {
          const count = (textLower.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
          if (count > 0) score += Math.min(count, 20);
        }
      }
    }

    return { doc, score };
  }).filter(r => r.score > 0);

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map(r => ({ ...r.doc, _score: r.score }));
}

/**
 * Get always-on context for a specific agent
 * Returns concatenated text of all always-on docs tagged for this agent
 */
function getAlwaysOnContext(agentName) {
  const docs = index.filter(d =>
    d.alwaysOn &&
    (d.agents.length === 0 || d.agents.includes(agentName))
  );

  if (docs.length === 0) return null;

  const sections = [];
  for (const doc of docs) {
    const text = getDocumentText(doc.id);
    if (text) {
      // Truncate long docs to keep context manageable
      const truncated = text.length > 3000 ? text.substring(0, 3000) + '\n...[truncated]' : text;
      sections.push(`### ${doc.title} (${doc.category})\n${truncated}`);
    }
  }

  if (sections.length === 0) return null;

  return `## Lab Knowledge Base — Always-On Documents\n\n${sections.join('\n\n---\n\n')}`;
}

/**
 * Get AI context summary for all knowledge docs
 */
function getAIContext(agentName) {
  const docs = listDocuments({ agent: agentName });
  const alwaysOn = docs.filter(d => d.alwaysOn);
  const onDemand = docs.filter(d => !d.alwaysOn);

  return {
    summary: `Knowledge base: ${docs.length} docs available (${alwaysOn.length} always-on, ${onDemand.length} on-demand)`,
    alwaysOnDocs: alwaysOn.map(d => ({ id: d.id, title: d.title, category: d.category })),
    availableDocs: onDemand.map(d => ({ id: d.id, title: d.title, category: d.category, tags: d.tags })),
    categories: CATEGORIES,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// REPORT GENERATION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Generate a CSV file and store it for download
 * Returns the download URL path
 */
function generateCSV({ title, headers, rows, agent }) {
  const id = 'rpt_' + crypto.randomBytes(6).toString('hex');
  const filename = `${title.replace(/[^a-zA-Z0-9_-]/g, '_')}_${new Date().toISOString().slice(0, 10)}.csv`;

  // Build CSV
  const escapeCsv = (val) => {
    const s = String(val ?? '');
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
  };

  const lines = [
    headers.map(escapeCsv).join(','),
    ...rows.map(row => row.map(escapeCsv).join(','))
  ];
  const csvContent = lines.join('\n');

  // Store in knowledge/reports for download
  const reportsDir = path.join(KNOWLEDGE_DIR, '_generated');
  if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });
  const filePath = path.join(reportsDir, `${id}_${filename}`);
  fs.writeFileSync(filePath, csvContent, 'utf-8');

  console.log(`[Knowledge] CSV generated: ${filename} (${rows.length} rows)`);

  return {
    id,
    filename,
    storedFilename: `${id}_${filename}`,
    path: `/api/knowledge/download/${id}`,
    rows: rows.length,
    size: Buffer.byteLength(csvContent, 'utf-8'),
    generatedAt: Date.now(),
  };
}

/**
 * Get a generated report file path
 */
function getGeneratedFile(id) {
  const dir = path.join(KNOWLEDGE_DIR, '_generated');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter(f => f.startsWith(id + '_'));
  if (files.length === 0) return null;
  return {
    path: path.join(dir, files[0]),
    filename: files[0].substring(id.length + 1),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────────────────────────

module.exports = {
  addDocument,
  getDocument,
  getDocumentText,
  getFilePath,
  deleteDocument,
  updateDocument,
  listDocuments,
  searchDocuments,
  getAlwaysOnContext,
  getAIContext,
  generateCSV,
  getGeneratedFile,
  CATEGORIES,
  VALID_AGENTS,
};
