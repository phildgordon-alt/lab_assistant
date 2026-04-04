/**
 * auth.js — Authentication & Authorization
 *
 * Validates Cloudflare Access JWT tokens, manages sessions,
 * enforces role-based access control.
 *
 * Flow:
 * 1. Cloudflare Access validates Okta login at the edge
 * 2. Passes CF-Access-JWT header to our server
 * 3. We decode the JWT to get email + groups
 * 4. Map to local user record + role
 * 5. Check role against endpoint requirements
 */

'use strict';

const crypto = require('crypto');

// Role hierarchy
const ROLES = { admin: 3, operator: 2, viewer: 1 };

// All POST/PUT/DELETE require admin
const WRITE_ROLE = 'admin';

let db;
function init(database) {
  db = database;

  // Create default admin user if none exists (for dev/initial setup)
  const adminEmail = process.env.ADMIN_EMAIL || 'phil@paireyewear.com';
  const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(adminEmail);
  if (!existing) {
    db.prepare('INSERT INTO users (email, name, role) VALUES (?, ?, ?)').run(
      adminEmail, 'Phil Gordon', 'admin'
    );
    console.log(`[Auth] Created default admin user: ${adminEmail}`);
  }
}

/**
 * Extract user from request.
 * Checks (in order):
 * 1. Cloudflare Access JWT (CF-Access-JWT-Assertion header)
 * 2. Session token (Authorization: Bearer xxx)
 * 3. Dev mode auto-login (ADMIN_EMAIL env var)
 *
 * Returns { user, session, role } or null
 */
function authenticate(req) {
  if (!db) return null;

  // 1. Cloudflare Access JWT
  const cfJwt = req.headers['cf-access-jwt-assertion'];
  if (cfJwt) {
    return authenticateCloudflare(cfJwt, req);
  }

  // 2. Session token
  const authHeader = req.headers['authorization'];
  if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return authenticateToken(token);
  }

  // 3. Dev mode — auto-login as admin when no Cloudflare/Okta configured
  if (!process.env.CF_ACCESS_TEAM && !process.env.OKTA_CLIENT_ID) {
    const email = process.env.ADMIN_EMAIL || 'phil@paireyewear.com';
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (user) return { user, role: user.role, source: 'dev' };
  }

  return null;
}

/**
 * Authenticate via Cloudflare Access JWT.
 * The JWT contains: email, iat, exp, iss, sub
 * Groups come from Okta via Cloudflare Access policies.
 */
function authenticateCloudflare(jwt, req) {
  try {
    // Decode JWT payload (Cloudflare already validated the signature at the edge)
    const parts = jwt.split('.');
    if (parts.length !== 3) return null;
    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString());

    const email = payload.email;
    if (!email) return null;

    // Find or create user
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      db.prepare('INSERT INTO users (email, name, role, okta_id) VALUES (?, ?, ?, ?)').run(
        email, payload.name || email.split('@')[0], 'viewer', payload.sub
      );
      user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    }

    // Update last login
    db.prepare('UPDATE users SET last_login = datetime("now") WHERE id = ?').run(user.id);

    // Get or create session
    let session = db.prepare(
      'SELECT * FROM user_sessions WHERE user_id = ? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1'
    ).get(user.id);

    if (!session) {
      const token = crypto.randomBytes(32).toString('hex');
      db.prepare(
        'INSERT INTO user_sessions (user_id, token, source, ip_address, user_agent) VALUES (?, ?, ?, ?, ?)'
      ).run(user.id, token, 'okta', req.socket?.remoteAddress, req.headers['user-agent']);
      session = db.prepare('SELECT * FROM user_sessions WHERE token = ?').get(token);
    } else {
      db.prepare('UPDATE user_sessions SET last_activity = datetime("now") WHERE id = ?').run(session.id);
    }

    return { user, session, role: user.role, source: 'okta' };
  } catch (e) {
    console.error('[Auth] Cloudflare JWT error:', e.message);
    return null;
  }
}

/**
 * Authenticate via session token
 */
function authenticateToken(token) {
  try {
    const session = db.prepare(
      'SELECT s.*, u.email, u.name, u.role FROM user_sessions s JOIN users u ON s.user_id = u.id WHERE s.token = ? AND s.ended_at IS NULL'
    ).get(token);
    if (!session) return null;

    db.prepare('UPDATE user_sessions SET last_activity = datetime("now") WHERE id = ?').run(session.id);

    return {
      user: { id: session.user_id, email: session.email, name: session.name, role: session.role },
      session,
      role: session.role,
      source: session.source
    };
  } catch (e) {
    return null;
  }
}

/**
 * Check if a request is authorized for the given method.
 * GET/OPTIONS → always allowed (read-only)
 * POST/PUT/DELETE → requires admin role
 *
 * Returns { allowed, reason }
 */
function authorize(auth, method) {
  // Read operations always allowed
  if (method === 'GET' || method === 'OPTIONS' || method === 'HEAD') {
    return { allowed: true };
  }

  // No auth context → deny writes
  if (!auth) {
    return { allowed: false, reason: 'Authentication required for write operations' };
  }

  // Check role
  const userLevel = ROLES[auth.role] || 0;
  const requiredLevel = ROLES[WRITE_ROLE] || 0;

  if (userLevel < requiredLevel) {
    return { allowed: false, reason: `Role '${auth.role}' cannot perform write operations (requires '${WRITE_ROLE}')` };
  }

  return { allowed: true };
}

/**
 * Log user activity
 */
function logActivity(userId, sessionId, action, detail, metadata) {
  if (!db) return;
  try {
    db.prepare(
      'INSERT INTO user_activity (user_id, session_id, action, detail, metadata) VALUES (?, ?, ?, ?, ?)'
    ).run(userId, sessionId, action, detail, typeof metadata === 'string' ? metadata : JSON.stringify(metadata));
  } catch (e) {
    // Don't let activity logging failures break the app
  }
}

/**
 * Get user activity stats (for admin dashboard)
 */
function getActivityStats(days = 7) {
  if (!db) return {};
  try {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    const since = cutoff.toISOString();

    const activeUsers = db.prepare(
      'SELECT COUNT(DISTINCT user_id) as count FROM user_activity WHERE timestamp >= ?'
    ).get(since);

    const aiQueries = db.prepare(
      'SELECT COUNT(*) as count FROM user_activity WHERE action = "ai_query" AND timestamp >= ?'
    ).get(since);

    const topUsers = db.prepare(`
      SELECT u.email, u.name, u.role, COUNT(*) as actions,
             SUM(CASE WHEN a.action = 'ai_query' THEN 1 ELSE 0 END) as ai_queries,
             MAX(a.timestamp) as last_active
      FROM user_activity a JOIN users u ON a.user_id = u.id
      WHERE a.timestamp >= ?
      GROUP BY u.id ORDER BY actions DESC LIMIT 20
    `).all(since);

    const byAction = db.prepare(`
      SELECT action, COUNT(*) as count FROM user_activity
      WHERE timestamp >= ? GROUP BY action ORDER BY count DESC
    `).all(since);

    const byTab = db.prepare(`
      SELECT detail as tab, COUNT(*) as views FROM user_activity
      WHERE action = 'page_view' AND timestamp >= ?
      GROUP BY detail ORDER BY views DESC
    `).all(since);

    return { activeUsers: activeUsers.count, aiQueries: aiQueries.count, topUsers, byAction, byTab, days };
  } catch (e) {
    return { error: e.message };
  }
}

/**
 * Get all users (admin only)
 */
function getUsers() {
  if (!db) return [];
  return db.prepare('SELECT id, email, name, role, okta_id, last_login, created_at FROM users ORDER BY role, name').all();
}

/**
 * Update user role (admin only)
 */
function setUserRole(email, role) {
  if (!db) return false;
  if (!ROLES[role]) return false;
  db.prepare('UPDATE users SET role = ? WHERE email = ?').run(role, email);
  return true;
}

module.exports = { init, authenticate, authorize, logActivity, getActivityStats, getUsers, setUserRole, ROLES };
