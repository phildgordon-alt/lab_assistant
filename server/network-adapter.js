/**
 * UniFi Network Adapter
 *
 * Polls the UniFi Network Application API for both Irvine sites every 30 seconds.
 * Exposes normalized device, client, VLAN, event, and alert data via getter functions.
 *
 * Behavior:
 * - When connected: Pulls live data every 30s, persists to disk
 * - When disconnected: Serves last known data from disk
 * - Mock mode when UNIFI_URL is not set
 *
 * USAGE in oven-timer-server.js:
 *   const network = require('./network-adapter');
 *   network.start();
 *   app.get('/api/network/status', (req, res) => res.json(network.getStatus()));
 *   app.get('/api/network/devices', (req, res) => res.json(network.getDevices(req.query.site)));
 *   app.get('/api/network/clients', (req, res) => res.json(network.getClients(req.query.site)));
 *   app.get('/api/network/vlans', (req, res) => res.json(network.getVlans()));
 *   app.get('/api/network/events', (req, res) => res.json(network.getEvents()));
 *   app.get('/api/network/alerts', (req, res) => res.json(network.getAlerts()));
 *   app.get('/api/network/health', (req, res) => res.json(network.getHealth()));
 *   app.post('/api/network/refresh', async (req, res) => res.json(await network.refresh()));
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ─────────────────────────────────────────────────────────────────────────────
// CONFIGURATION
// ─────────────────────────────────────────────────────────────────────────────
const UNIFI_URL = process.env.UNIFI_URL || '';
const UNIFI_API_KEY = process.env.UNIFI_API_KEY || '';
const UNIFI_SITE = process.env.UNIFI_SITE || 'default';
const UNIFI_SITE_2 = process.env.UNIFI_SITE_2 || '';
const NETWORK_POLL_MS = parseInt(process.env.NETWORK_POLL_MS || '30000');
const MOCK_MODE = !UNIFI_URL;

// Map UniFi site IDs to frontend-friendly keys
// Site Magic merges sites — we split by IP subnet (10.0.x = irvine1, 10.1.x = irvine2)
const SITE_KEY_1 = 'irvine1';
const SITE_KEY_2 = 'irvine2';

// Irvine 2 IP ranges (Site Magic SD-WAN: physically separate site, one
// UniFi controller). Per Phil 2026-04-28: 192.168.11.1 is the Irvine 2
// gateway. 192.168.1.x is NOT Irvine 2 — it's a VLAN at Irvine 1.
function classifySite(ip) {
  if (!ip) return SITE_KEY_1;
  if (ip.startsWith('10.1.') || ip.startsWith('192.168.11.')) return SITE_KEY_2;
  return SITE_KEY_1;
}

// Persistence file
const DATA_FILE = path.join(__dirname, 'network-data.json');

// ─────────────────────────────────────────────────────────────────────────────
// VLAN DEFINITIONS
// ─────────────────────────────────────────────────────────────────────────────
const VLANS = [
  { id: 1,  name: 'Main LAN',      subnet_1: '10.0.1.x',  subnet_2: '10.1.1.x' },
  { id: 10, name: 'Cameras',       subnet_1: '10.0.10.x', subnet_2: '10.1.10.x' },
  { id: 20, name: 'Door Access',   subnet_1: '10.0.20.x', subnet_2: '10.1.20.x' },
  { id: 30, name: 'OT/Industrial', subnet_1: '10.0.30.x', subnet_2: '10.1.30.x' },
  { id: 40, name: 'NAS',           subnet_1: '10.0.40.x', subnet_2: '10.1.40.x' },
  { id: 50, name: 'Staff WiFi',    subnet_1: '10.0.50.x', subnet_2: '10.1.50.x' },
  { id: 60, name: 'EV Charging',   subnet_1: '10.0.60.x', subnet_2: '10.1.60.x' },
  { id: 99, name: 'Management',    subnet_1: '10.0.99.x', subnet_2: '10.1.99.x' },
];

// VLAN bleed rules — which VLANs should NOT have certain client types
// Guest/EV (60) clients on Production/Automation/Lab Assistant VLANs = CRITICAL
// Unknown MACs on OT VLAN (30) = HIGH
const BLEED_RULES = [
  { sourceVlan: 60, targetVlans: [1, 10, 20, 30, 40, 99], severity: 'critical', desc: 'Guest/EV client on restricted VLAN' },
  { sourceVlan: null, targetVlans: [30], severity: 'high', desc: 'Unknown MAC on OT/Industrial VLAN' },
];

// Known OT MACs — devices expected on VLAN 30. Anything else is suspicious.
const KNOWN_OT_MACS = new Set([
  // Populate with known industrial device MACs as they are inventoried
]);

// ─────────────────────────────────────────────────────────────────────────────
// IN-MEMORY STATE
// ─────────────────────────────────────────────────────────────────────────────
let siteData = {
  // keyed by site ID: { devices: [], clients: [], health: [], alarms: [], events: [] }
};
let bleedViolations = [];
let lastPoll = null;
let lastSuccessfulPoll = null;
let pollInterval = null;
let isLive = false;
let connectionError = null;
let pollCount = 0;
let failCount = 0;

// Dynamic import handle for node-fetch
let _fetch = null;
let _httpsAgent = null;

async function getFetch() {
  if (_fetch) return { fetch: _fetch, agent: _httpsAgent };
  const mod = await import('node-fetch');
  _fetch = mod.default;
  // UniFi controllers use self-signed certs
  const https = require('https');
  _httpsAgent = new https.Agent({ rejectUnauthorized: false });
  return { fetch: _fetch, agent: _httpsAgent };
}

// ─────────────────────────────────────────────────────────────────────────────
// NORMALIZATION
// ─────────────────────────────────────────────────────────────────────────────
function normalizeDevice(d) {
  return {
    id: d._id,
    name: d.name || d.hostname || 'Unknown',
    type: d.type,  // 'ugw' | 'usw' | 'uap' | 'udm'
    model: d.model,
    ip: d.ip,
    mac: d.mac,
    uptime: d.uptime,
    status: d.state === 1 ? 'online' : 'offline',
    cpu_pct: d['system-stats']?.cpu || 0,
    mem_pct: d['system-stats']?.mem || 0,
    tx_bytes: d.uplink?.tx_bytes || 0,
    rx_bytes: d.uplink?.rx_bytes || 0,
    tx_rate: d.uplink?.tx_bytes_r || 0,
    rx_rate: d.uplink?.rx_bytes_r || 0,
    last_seen: d.last_seen ? d.last_seen * 1000 : null,
  };
}

function normalizeClient(c) {
  return {
    mac: c.mac,
    hostname: c.hostname || c.name || c.oui || 'Unknown',
    ip: c.ip,
    vlan: c.vlan || c.network_id_vlan || null,
    network: c.network || null,
    is_wired: c.is_wired || false,
    tx_bytes: c.tx_bytes || 0,
    rx_bytes: c.rx_bytes || 0,
    signal: c.signal || null,
    uptime: c.uptime || 0,
    last_seen: c.last_seen ? c.last_seen * 1000 : null,
    ap_mac: c.ap_mac || null,
  };
}

function normalizeEvent(e, site) {
  return {
    id: e._id,
    site,
    key: e.key,
    msg: e.msg,
    subsystem: e.subsystem,
    datetime: e.datetime ? new Date(e.datetime).getTime() : (e.time ? e.time * 1000 : Date.now()),
    is_negative: e.is_negative || false,
  };
}

function normalizeAlarm(a, site) {
  return {
    id: a._id,
    site,
    type: a.type || a.key,
    msg: a.msg,
    severity: a.handled === false ? 'active' : 'resolved',
    datetime: a.datetime ? new Date(a.datetime).getTime() : (a.time ? a.time * 1000 : Date.now()),
    ap_name: a.ap_name || null,
    device_name: a.device_name || null,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// VLAN BLEED DETECTION
// ─────────────────────────────────────────────────────────────────────────────
function detectBleed(allClients) {
  const violations = [];

  for (const client of allClients) {
    const vlan = client.vlan;
    if (vlan == null) continue;

    // Rule 1: Guest/EV (VLAN 60) client appearing on production/restricted VLANs
    if (vlan !== 60) {
      // Check if this client was previously seen on VLAN 60 (Guest/EV)
      // For now, we identify EV/Guest clients by their being on VLAN 60 subnet
      // This check is simplified — in production, maintain a known-guest-MAC set
    }

    // Rule 2: Unknown MAC on OT VLAN 30
    if (vlan === 30 && !KNOWN_OT_MACS.has(client.mac)) {
      violations.push({
        type: 'vlan_bleed',
        severity: 'high',
        mac: client.mac,
        hostname: client.hostname,
        ip: client.ip,
        vlan,
        vlanName: VLANS.find(v => v.id === vlan)?.name || `VLAN ${vlan}`,
        message: `Unknown MAC ${client.mac} (${client.hostname}) on OT/Industrial VLAN 30`,
        detectedAt: Date.now(),
      });
    }
  }

  // Check for clients whose IP doesn't match their VLAN subnet
  for (const client of allClients) {
    if (!client.ip || client.vlan == null) continue;
    const expectedVlan = VLANS.find(v => v.id === client.vlan);
    if (!expectedVlan) continue;

    // Extract third octet from IP to check subnet alignment
    const octets = client.ip.split('.');
    if (octets.length !== 4) continue;
    const thirdOctet = parseInt(octets[2]);

    // Guest/EV VLAN 60 clients on production VLANs
    if (thirdOctet === 60 && client.vlan !== 60) {
      violations.push({
        type: 'vlan_bleed',
        severity: 'critical',
        mac: client.mac,
        hostname: client.hostname,
        ip: client.ip,
        vlan: client.vlan,
        vlanName: VLANS.find(v => v.id === client.vlan)?.name || `VLAN ${client.vlan}`,
        message: `Guest/EV client ${client.mac} (${client.hostname}) on ${VLANS.find(v => v.id === client.vlan)?.name || 'VLAN ' + client.vlan} — VLAN bleed`,
        detectedAt: Date.now(),
      });
    }
  }

  return violations;
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE
// ─────────────────────────────────────────────────────────────────────────────
function loadFromDisk() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
      siteData = data.siteData || {};
      bleedViolations = data.bleedViolations || [];
      lastSuccessfulPoll = data.lastSuccessfulPoll || null;
      const deviceCount = Object.values(siteData).reduce((sum, s) => sum + (s.devices?.length || 0), 0);
      console.log(`[NETWORK] Loaded ${deviceCount} devices from disk (last update: ${lastSuccessfulPoll || 'unknown'})`);
      return true;
    }
  } catch (e) {
    console.warn('[NETWORK] Could not load persisted data:', e.message);
  }
  return false;
}

function saveToDisk() {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify({
      siteData,
      bleedViolations,
      lastSuccessfulPoll,
      savedAt: new Date().toISOString(),
    }, null, 2));
  } catch (e) {
    console.warn('[NETWORK] Could not persist data:', e.message);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// API FETCHING
// ─────────────────────────────────────────────────────────────────────────────
async function fetchUnifi(endpoint) {
  const { fetch, agent } = await getFetch();
  const url = `${UNIFI_URL}${endpoint}`;
  const res = await fetch(url, {
    headers: {
      'X-API-KEY': UNIFI_API_KEY,
      'Content-Type': 'application/json',
    },
    agent,
    timeout: 15000,
  });
  if (!res.ok) {
    throw new Error(`UniFi API ${res.status} ${res.statusText} — ${endpoint}`);
  }
  const json = await res.json();
  return json.data || json;
}

async function pollSite(siteId) {
  const prefix = `/proxy/network/api/s/${siteId}`;
  const [devices, clients, health, alarms, events, vpnSessions] = await Promise.all([
    fetchUnifi(`${prefix}/stat/device`),
    fetchUnifi(`${prefix}/stat/sta`),
    fetchUnifi(`${prefix}/stat/health`),
    fetchUnifi(`${prefix}/list/alarm`),
    fetchUnifi(`${prefix}/stat/event?_limit=50`).catch(() => null),
    fetchUnifi(`${prefix}/stat/remoteuserstat`).catch(() => null),
  ]);

  // Update teleport data from VPN sessions
  if (vpnSessions) {
    teleportData = {
      enabled: true,
      status: vpnSessions.length > 0 ? 'active' : 'inactive',
      server_ip: '10.0.99.1',
      port: 3478,
      protocol: 'WireGuard',
      sessions: (vpnSessions || []).map(s => ({
        name: s.name || s.hostname || 'Unknown',
        user: s.email || s.name || 'unknown',
        ip: s.ip || s.fixed_ip || '—',
        remote_ip: s.remote_ip || '—',
        connected_at: s.start ? new Date(s.start * 1000).toISOString() : new Date().toISOString(),
        rx_bytes: s.rx_bytes || 0,
        tx_bytes: s.tx_bytes || 0,
        state: 'connected',
      })),
      total_ever: vpnSessions.length,
      last_handshake: new Date().toISOString(),
    };
  }

  return {
    devices: (devices || []).map(normalizeDevice),
    clients: (clients || []).map(normalizeClient),
    health: health || [],
    alarms: (alarms || []).map(a => normalizeAlarm(a, siteId)),
    events: (events || []).map(e => normalizeEvent(e, siteId)),
  };
}

async function poll() {
  if (MOCK_MODE) return true; // mock data is static

  lastPoll = new Date().toISOString();
  pollCount++;

  try {
    // Poll site 1
    const site1Raw = await pollSite(UNIFI_SITE);

    // Poll site 2 if configured as separate site
    let site2Raw = null;
    if (UNIFI_SITE_2 && UNIFI_SITE_2 !== UNIFI_SITE) {
      site2Raw = await pollSite(UNIFI_SITE_2);
    }

    if (site2Raw) {
      // Two separate UniFi sites — map directly
      siteData[SITE_KEY_1] = site1Raw;
      siteData[SITE_KEY_2] = site2Raw;
    } else {
      // Single site (Site Magic) — split by IP subnet
      const s1 = { devices: [], clients: [], health: site1Raw.health, alarms: [], events: [] };
      const s2 = { devices: [], clients: [], health: [], alarms: [], events: [] };

      for (const d of site1Raw.devices) {
        (classifySite(d.ip) === SITE_KEY_2 ? s2 : s1).devices.push(d);
      }
      for (const c of site1Raw.clients) {
        (classifySite(c.ip) === SITE_KEY_2 ? s2 : s1).clients.push(c);
      }
      for (const a of site1Raw.alarms) {
        // Alarms don't always have IP, default to site 1
        s1.alarms.push(a);
      }
      for (const e of site1Raw.events) {
        s1.events.push(e);
      }

      siteData[SITE_KEY_1] = s1;
      siteData[SITE_KEY_2] = s2;
    }

    // Run VLAN bleed detection across all clients
    const allClients = Object.values(siteData).flatMap(s => s.clients || []);
    bleedViolations = detectBleed(allClients);

    lastSuccessfulPoll = lastPoll;
    isLive = true;
    connectionError = null;
    failCount = 0;

    saveToDisk();

    const totalDevices = Object.values(siteData).reduce((sum, s) => sum + s.devices.length, 0);
    const totalClients = Object.values(siteData).reduce((sum, s) => sum + s.clients.length, 0);
    const totalAlarms = Object.values(siteData).reduce((sum, s) => sum + s.alarms.length, 0);
    console.log(`[NETWORK] Poll #${pollCount} - LIVE: ${totalDevices} devices, ${totalClients} clients, ${totalAlarms} alarms, ${bleedViolations.length} bleed violations`);
    return true;

  } catch (err) {
    console.error(`[NETWORK] Poll #${pollCount} - ERROR: ${err.message}`);
    isLive = false;
    connectionError = err.message;
    failCount++;
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// MOCK DATA
// ─────────────────────────────────────────────────────────────────────────────
function generateMockData() {
  const now = Date.now();
  const uptime7d = 604800;
  const uptime30d = 2592000;

  const mockSite1 = {
    devices: [
      {
        id: 'mock-udm-1', name: 'UDM-Pro Irvine 1', type: 'udm', model: 'UDM-Pro',
        ip: '10.0.1.1', mac: 'f0:9f:c2:00:01:01', uptime: uptime30d,
        status: 'online', cpu_pct: 12, mem_pct: 45, tx_bytes: 892345678, rx_bytes: 1234567890,
        tx_rate: 45000, rx_rate: 62000, last_seen: now,
      },
      {
        id: 'mock-usw-48-1', name: 'USW-48-PoE Lab Floor', type: 'usw', model: 'USW-48-PoE',
        ip: '10.0.1.10', mac: 'f0:9f:c2:00:01:10', uptime: uptime7d,
        status: 'online', cpu_pct: 8, mem_pct: 32, tx_bytes: 456789012, rx_bytes: 678901234,
        tx_rate: 23000, rx_rate: 31000, last_seen: now,
      },
      {
        id: 'mock-usw-24-1', name: 'USW-24 Office', type: 'usw', model: 'USW-24',
        ip: '10.0.1.11', mac: 'f0:9f:c2:00:01:11', uptime: uptime7d,
        status: 'online', cpu_pct: 5, mem_pct: 28, tx_bytes: 234567890, rx_bytes: 345678901,
        tx_rate: 12000, rx_rate: 18000, last_seen: now,
      },
      {
        id: 'mock-uap-1', name: 'U6-Pro Lab Floor', type: 'uap', model: 'U6-Pro',
        ip: '10.0.1.20', mac: 'f0:9f:c2:00:01:20', uptime: uptime7d,
        status: 'online', cpu_pct: 15, mem_pct: 38, tx_bytes: 123456789, rx_bytes: 234567890,
        tx_rate: 8000, rx_rate: 14000, last_seen: now,
      },
      {
        id: 'mock-uap-2', name: 'U6-Pro Assembly', type: 'uap', model: 'U6-Pro',
        ip: '10.0.1.21', mac: 'f0:9f:c2:00:01:21', uptime: uptime7d,
        status: 'online', cpu_pct: 22, mem_pct: 41, tx_bytes: 98765432, rx_bytes: 187654321,
        tx_rate: 6500, rx_rate: 11000, last_seen: now,
      },
      {
        id: 'mock-uap-3', name: 'U6-Lite Coating', type: 'uap', model: 'U6-Lite',
        ip: '10.0.1.22', mac: 'f0:9f:c2:00:01:22', uptime: uptime7d,
        status: 'online', cpu_pct: 9, mem_pct: 25, tx_bytes: 45678901, rx_bytes: 67890123,
        tx_rate: 3000, rx_rate: 5500, last_seen: now,
      },
      {
        id: 'mock-uap-4', name: 'U6-Mesh Warehouse', type: 'uap', model: 'U6-Mesh',
        ip: '10.0.1.23', mac: 'f0:9f:c2:00:01:23', uptime: 0,
        status: 'offline', cpu_pct: 0, mem_pct: 0, tx_bytes: 12345678, rx_bytes: 23456789,
        tx_rate: 0, rx_rate: 0, last_seen: now - 3600000,
      },
    ],
    clients: [
      // Main LAN (1)
      ...Array.from({ length: 8 }, (_, i) => ({
        mac: `f0:9f:c2:10:01:${String(i + 1).padStart(2, '0')}`, hostname: `lab-ws-${i + 1}`,
        ip: `10.0.1.${100 + i}`, vlan: 1, network: 'Main LAN', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 1e9), rx_bytes: Math.floor(Math.random() * 1e9),
        signal: null, uptime: uptime7d, last_seen: now, ap_mac: null,
      })),
      // Cameras (10)
      ...Array.from({ length: 12 }, (_, i) => ({
        mac: `f0:9f:c2:20:01:${String(i + 1).padStart(2, '0')}`, hostname: `cam-${['lobby', 'lab-floor', 'assembly', 'coating', 'shipping', 'picking', 'entrance-n', 'entrance-s', 'parking-a', 'parking-b', 'dock', 'hallway'][i]}`,
        ip: `10.0.10.${100 + i}`, vlan: 10, network: 'Cameras', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 5e9), rx_bytes: Math.floor(Math.random() * 1e8),
        signal: null, uptime: uptime7d, last_seen: now, ap_mac: null,
      })),
      // OT/Industrial (30)
      ...Array.from({ length: 6 }, (_, i) => ({
        mac: `f0:9f:c2:30:01:${String(i + 1).padStart(2, '0')}`, hostname: `plc-${['kardex', 'schneider-kms', 'coater-1', 'coater-2', 'edger-1', 'blocker'][i]}`,
        ip: `10.0.30.${100 + i}`, vlan: 30, network: 'OT/Industrial', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 5e8), rx_bytes: Math.floor(Math.random() * 5e8),
        signal: null, uptime: uptime30d, last_seen: now, ap_mac: null,
      })),
      // Staff WiFi (50)
      ...Array.from({ length: 18 }, (_, i) => ({
        mac: `f0:9f:c2:50:01:${String(i + 1).padStart(2, '0')}`, hostname: i < 10 ? `iphone-staff-${i + 1}` : `android-staff-${i - 9}`,
        ip: `10.0.50.${100 + i}`, vlan: 50, network: 'Staff WiFi', is_wired: false,
        tx_bytes: Math.floor(Math.random() * 2e8), rx_bytes: Math.floor(Math.random() * 5e8),
        signal: -45 - Math.floor(Math.random() * 30), uptime: Math.floor(Math.random() * 28800),
        last_seen: now, ap_mac: 'f0:9f:c2:00:01:20',
      })),
      // Door Access (20)
      ...Array.from({ length: 3 }, (_, i) => ({
        mac: `f0:9f:c2:20:01:${String(i + 1).padStart(2, '0')}`, hostname: `door-ctrl-${['main', 'lab', 'dock'][i]}`,
        ip: `10.0.20.${100 + i}`, vlan: 20, network: 'Door Access', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 1e7), rx_bytes: Math.floor(Math.random() * 1e7),
        signal: null, uptime: uptime30d, last_seen: now, ap_mac: null,
      })),
      // NAS (40)
      ...Array.from({ length: 2 }, (_, i) => ({
        mac: `f0:9f:c2:40:01:${String(i + 1).padStart(2, '0')}`, hostname: `nas-${['primary', 'backup'][i]}`,
        ip: `10.0.40.${100 + i}`, vlan: 40, network: 'NAS', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 5e8), rx_bytes: Math.floor(Math.random() * 5e8),
        signal: null, uptime: uptime30d, last_seen: now, ap_mac: null,
      })),
      // EV Charging (60)
      ...Array.from({ length: 3 }, (_, i) => ({
        mac: `f0:9f:c2:60:01:${String(i + 1).padStart(2, '0')}`, hostname: `ev-charger-${i + 1}`,
        ip: `10.0.60.${100 + i}`, vlan: 60, network: 'EV Charging', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 1e7), rx_bytes: Math.floor(Math.random() * 1e7),
        signal: null, uptime: uptime30d, last_seen: now, ap_mac: null,
      })),
      // Management (99)
      ...Array.from({ length: 2 }, (_, i) => ({
        mac: `f0:9f:c2:99:01:${String(i + 1).padStart(2, '0')}`, hostname: `mgmt-${['controller', 'backup'][i]}`,
        ip: `10.0.99.${100 + i}`, vlan: 99, network: 'Management', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 1e8), rx_bytes: Math.floor(Math.random() * 1e8),
        signal: null, uptime: uptime30d, last_seen: now, ap_mac: null,
      })),
    ],
    health: [
      { subsystem: 'wan', status: 'ok', num_adopted: 1, wan_ip: '203.0.113.10', isp_name: 'Cox', tx_bytes_r: 45000, rx_bytes_r: 62000, latency: 8, uptime: uptime30d },
      { subsystem: 'lan', status: 'ok', num_adopted: 3, num_user: 54, tx_bytes_r: 120000, rx_bytes_r: 180000 },
      { subsystem: 'wlan', status: 'ok', num_adopted: 4, num_user: 18, tx_bytes_r: 35000, rx_bytes_r: 52000 },
      { subsystem: 'vpn', status: 'ok', num_adopted: 0 },
    ],
    alarms: [
      {
        id: 'mock-alarm-1', site: UNIFI_SITE, type: 'EVT_AP_Lost_Contact',
        msg: 'AP U6-Mesh Warehouse lost contact', severity: 'active',
        datetime: now - 3600000, ap_name: 'U6-Mesh Warehouse', device_name: 'U6-Mesh Warehouse',
      },
    ],
    events: [
      { id: 'mock-evt-1', site: UNIFI_SITE, key: 'EVT_AP_Lost_Contact', msg: 'AP[U6-Mesh Warehouse] was disconnected', subsystem: 'wlan', datetime: now - 3600000, is_negative: true },
      { id: 'mock-evt-2', site: UNIFI_SITE, key: 'EVT_SW_Connected', msg: 'Switch[USW-48-PoE Lab Floor] was connected', subsystem: 'lan', datetime: now - 86400000, is_negative: false },
      { id: 'mock-evt-3', site: UNIFI_SITE, key: 'EVT_GW_WANTransition', msg: 'Gateway WAN transitioned to active', subsystem: 'wan', datetime: now - 172800000, is_negative: false },
      { id: 'mock-evt-4', site: UNIFI_SITE, key: 'EVT_AP_AutoChannelChange', msg: 'AP[U6-Pro Lab Floor] auto-channel changed from 36 to 44', subsystem: 'wlan', datetime: now - 7200000, is_negative: false },
      { id: 'mock-evt-5', site: UNIFI_SITE, key: 'EVT_IPS_Alert', msg: 'IPS alert: port scan detected from 10.0.50.115', subsystem: 'ips', datetime: now - 1800000, is_negative: true },
      { id: 'mock-evt-6', site: UNIFI_SITE, key: 'EVT_TELEPORT_Connected', msg: 'Teleport VPN session started — Phil iPhone', subsystem: 'vpn', datetime: now - 900000, is_negative: false },
    ],
  };

  const mockSite2 = {
    devices: [
      {
        id: 'mock-udm-2', name: 'UDM-SE Irvine 2', type: 'udm', model: 'UDM-SE',
        ip: '10.1.1.1', mac: 'f0:9f:c2:00:02:01', uptime: uptime30d,
        status: 'online', cpu_pct: 8, mem_pct: 38, tx_bytes: 456789012, rx_bytes: 678901234,
        tx_rate: 22000, rx_rate: 35000, last_seen: now,
      },
      {
        id: 'mock-usw-24-2', name: 'USW-24-PoE Irvine 2', type: 'usw', model: 'USW-24-PoE',
        ip: '10.1.1.10', mac: 'f0:9f:c2:00:02:10', uptime: uptime7d,
        status: 'online', cpu_pct: 6, mem_pct: 24, tx_bytes: 123456789, rx_bytes: 234567890,
        tx_rate: 8000, rx_rate: 12000, last_seen: now,
      },
      {
        id: 'mock-uap-5', name: 'U6-Pro Irvine 2 Floor', type: 'uap', model: 'U6-Pro',
        ip: '10.1.1.20', mac: 'f0:9f:c2:00:02:20', uptime: uptime7d,
        status: 'online', cpu_pct: 11, mem_pct: 30, tx_bytes: 67890123, rx_bytes: 98765432,
        tx_rate: 4500, rx_rate: 7500, last_seen: now,
      },
    ],
    clients: [
      ...Array.from({ length: 4 }, (_, i) => ({
        mac: `f0:9f:c2:10:02:${String(i + 1).padStart(2, '0')}`, hostname: `irv2-ws-${i + 1}`,
        ip: `10.1.1.${100 + i}`, vlan: 1, network: 'Main LAN', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 5e8), rx_bytes: Math.floor(Math.random() * 5e8),
        signal: null, uptime: uptime7d, last_seen: now, ap_mac: null,
      })),
      ...Array.from({ length: 6 }, (_, i) => ({
        mac: `f0:9f:c2:50:02:${String(i + 1).padStart(2, '0')}`, hostname: `irv2-phone-${i + 1}`,
        ip: `10.1.50.${100 + i}`, vlan: 50, network: 'Staff WiFi', is_wired: false,
        tx_bytes: Math.floor(Math.random() * 1e8), rx_bytes: Math.floor(Math.random() * 2e8),
        signal: -50 - Math.floor(Math.random() * 25), uptime: Math.floor(Math.random() * 28800),
        last_seen: now, ap_mac: 'f0:9f:c2:00:02:20',
      })),
      ...Array.from({ length: 4 }, (_, i) => ({
        mac: `f0:9f:c2:10:02:${String(10 + i).padStart(2, '0')}`, hostname: `cam-irv2-${['entrance', 'floor', 'dock', 'lot'][i]}`,
        ip: `10.1.10.${100 + i}`, vlan: 10, network: 'Cameras', is_wired: true,
        tx_bytes: Math.floor(Math.random() * 3e9), rx_bytes: Math.floor(Math.random() * 5e7),
        signal: null, uptime: uptime7d, last_seen: now, ap_mac: null,
      })),
    ],
    health: [
      { subsystem: 'wan', status: 'ok', num_adopted: 1, wan_ip: '203.0.113.20', isp_name: 'Spectrum', tx_bytes_r: 22000, rx_bytes_r: 35000, latency: 11, uptime: uptime30d },
      { subsystem: 'lan', status: 'ok', num_adopted: 1, num_user: 14, tx_bytes_r: 45000, rx_bytes_r: 60000 },
      { subsystem: 'wlan', status: 'ok', num_adopted: 1, num_user: 6, tx_bytes_r: 12000, rx_bytes_r: 20000 },
    ],
    alarms: [],
    events: [
      { id: 'mock-evt-s2-1', site: 'site2', key: 'EVT_SW_Connected', msg: 'Switch[USW-24-PoE Irvine 2] was connected', subsystem: 'lan', datetime: now - 43200000, is_negative: false },
      { id: 'mock-evt-s2-2', site: 'site2', key: 'EVT_SITE_MAGIC_UP', msg: 'Site Magic tunnel to Irvine 1 established', subsystem: 'vpn', datetime: now - 86400000, is_negative: false },
    ],
  };

  siteData[SITE_KEY_1] = mockSite1;
  siteData[SITE_KEY_2] = mockSite2;

  bleedViolations = [];
  teleportData = generateMockTeleport();
  isLive = false;
  lastPoll = new Date().toISOString();
  lastSuccessfulPoll = null;
}

// ─────────────────────────────────────────────────────────────────────────────
// TELEPORT VPN DATA
// ─────────────────────────────────────────────────────────────────────────────
let teleportData = null;

function generateMockTeleport() {
  return {
    enabled: true,
    status: 'active',
    server_ip: '10.0.99.1',
    port: 3478,
    protocol: 'WireGuard',
    sessions: [
      {
        name: "Phil's iPhone",
        user: 'phil@paireyewear.com',
        ip: '10.0.99.201',
        remote_ip: '73.x.x.x',
        connected_at: new Date(Date.now() - 7200000).toISOString(),
        rx_bytes: 8400000,
        tx_bytes: 2100000,
        state: 'connected',
      },
    ],
    total_ever: 14,
    last_handshake: new Date(Date.now() - 45000).toISOString(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// SWITCH PORT DATA
// ─────────────────────────────────────────────────────────────────────────────
function generateMockSwitchPorts(mac, deviceName) {
  const portCount = deviceName?.includes('48') ? 48 : 24;
  const ports = [];
  const portProfiles = [
    { name: 'Kardex PLC', vlan: 30, speed: 1000, poe: true, state: 'forwarding' },
    { name: 'Schneider KMS', vlan: 30, speed: 1000, poe: false, state: 'forwarding' },
    { name: 'DVI VISION', vlan: 30, speed: 1000, poe: false, state: 'forwarding' },
    { name: 'Coater-1 PLC', vlan: 30, speed: 100, poe: true, state: 'forwarding' },
    { name: 'Coater-2 PLC', vlan: 30, speed: 100, poe: true, state: 'forwarding' },
    { name: 'cam-lobby', vlan: 10, speed: 100, poe: true, state: 'forwarding' },
    { name: 'cam-lab-floor', vlan: 10, speed: 100, poe: true, state: 'forwarding' },
    { name: 'cam-assembly', vlan: 10, speed: 100, poe: true, state: 'forwarding' },
    { name: 'cam-coating', vlan: 10, speed: 100, poe: true, state: 'forwarding' },
    { name: 'door-ctrl-1', vlan: 20, speed: 100, poe: true, state: 'forwarding' },
    { name: 'door-ctrl-2', vlan: 20, speed: 100, poe: true, state: 'forwarding' },
    { name: 'lab-ws-1', vlan: 1, speed: 1000, poe: false, state: 'forwarding' },
    { name: 'lab-ws-2', vlan: 1, speed: 1000, poe: false, state: 'forwarding' },
    { name: 'lab-ws-3', vlan: 1, speed: 1000, poe: false, state: 'forwarding' },
    { name: 'NAS-primary', vlan: 40, speed: 1000, poe: false, state: 'forwarding' },
    { name: 'ev-charger-1', vlan: 60, speed: 100, poe: false, state: 'forwarding' },
    { name: '', vlan: null, speed: 0, poe: false, state: 'disabled' },
    { name: '', vlan: null, speed: 0, poe: false, state: 'link_down' },
    { name: 'SFP+ Uplink', vlan: 99, speed: 10000, poe: false, state: 'forwarding' },
  ];

  for (let i = 1; i <= portCount; i++) {
    const profile = i <= portProfiles.length ? portProfiles[i - 1] : { name: '', vlan: null, speed: 0, poe: false, state: i % 5 === 0 ? 'link_down' : 'disabled' };
    const isUp = profile.state === 'forwarding';
    ports.push({
      port_idx: i,
      name: profile.name || `Port ${i}`,
      state: profile.state,
      speed: profile.speed,
      is_uplink: i >= portCount - 1,
      poe_enable: profile.poe,
      poe_power: profile.poe && isUp ? (5 + Math.random() * 20).toFixed(1) : '0.0',
      vlan: profile.vlan,
      vlan_name: profile.vlan ? (VLANS.find(v => v.id === profile.vlan)?.name || `VLAN ${profile.vlan}`) : null,
      tx_bytes: isUp ? Math.floor(Math.random() * 1e9) : 0,
      rx_bytes: isUp ? Math.floor(Math.random() * 1e9) : 0,
      stp_state: isUp ? 'forwarding' : 'disabled',
      mac_count: isUp ? Math.floor(Math.random() * 5) + 1 : 0,
    });
  }
  return { mac, device: deviceName || 'Unknown Switch', ports, portCount, timestamp: new Date().toISOString() };
}

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────
function getAllDevices() {
  return Object.entries(siteData).flatMap(([site, data]) =>
    (data.devices || []).map(d => ({ ...d, site }))
  );
}

function getAllClients() {
  return Object.entries(siteData).flatMap(([site, data]) =>
    (data.clients || []).map(c => ({ ...c, site }))
  );
}

function getAllEvents() {
  return Object.values(siteData)
    .flatMap(data => data.events || [])
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
}

function getAllAlarms() {
  return Object.values(siteData)
    .flatMap(data => data.alarms || [])
    .sort((a, b) => (b.datetime || 0) - (a.datetime || 0));
}

function getSiteIds() {
  return Object.keys(siteData);
}

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────
module.exports = {
  /**
   * Start polling UniFi controller
   */
  async start() {
    console.log('[NETWORK] Starting adapter');
    console.log(`[NETWORK] Controller: ${UNIFI_URL || '(mock mode)'}`);
    console.log(`[NETWORK] Site 1: ${UNIFI_SITE}, Site 2: ${UNIFI_SITE_2 || '(not configured)'}`);
    console.log(`[NETWORK] Poll interval: ${NETWORK_POLL_MS}ms`);

    if (MOCK_MODE) {
      console.log('[NETWORK] MOCK MODE — no UNIFI_URL set, serving mock data');
      generateMockData();
      return;
    }

    // Load persisted data first
    loadFromDisk();

    // Initial poll (non-blocking)
    poll().catch(e => console.error('[NETWORK] Initial poll failed:', e.message));

    // Start polling interval
    pollInterval = setInterval(async () => {
      await poll();
    }, NETWORK_POLL_MS);
  },

  /**
   * Stop polling
   */
  stop() {
    if (pollInterval) {
      clearInterval(pollInterval);
      pollInterval = null;
    }
    console.log('[NETWORK] Adapter stopped');
  },

  /**
   * Both-sites summary: devices up/down, client counts, WAN status, alarms
   */
  getStatus() {
    const allDevices = getAllDevices();
    const allClients = getAllClients();
    const allAlarms = getAllAlarms();

    const sites = {};
    for (const [siteId, data] of Object.entries(siteData)) {
      const wan = (data.health || []).find(h => h.subsystem === 'wan');
      sites[siteId] = {
        devices: {
          total: data.devices?.length || 0,
          online: (data.devices || []).filter(d => d.status === 'online').length,
          offline: (data.devices || []).filter(d => d.status === 'offline').length,
        },
        clients: (data.clients || []).length,
        wan: wan ? {
          status: wan.status,
          ip: wan.wan_ip,
          isp: wan.isp_name,
          latency: wan.latency,
          tx_rate: wan.tx_bytes_r,
          rx_rate: wan.rx_bytes_r,
        } : null,
        alarms: (data.alarms || []).length,
      };
    }

    return {
      sites,
      totals: {
        devices: allDevices.length,
        devicesOnline: allDevices.filter(d => d.status === 'online').length,
        devicesOffline: allDevices.filter(d => d.status === 'offline').length,
        clients: allClients.length,
        alarms: allAlarms.length,
        bleedViolations: bleedViolations.length,
      },
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
    };
  },

  /**
   * Normalized device list for a site (or both if site not specified)
   */
  getDevices(site) {
    if (site && siteData[site]) {
      return {
        devices: (siteData[site].devices || []).map(d => ({ ...d, site })),
        isLive,
        isMock: MOCK_MODE,
        lastPoll,
      };
    }
    return {
      devices: getAllDevices(),
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
      summary: {
        total: getAllDevices().length,
        online: getAllDevices().filter(d => d.status === 'online').length,
        offline: getAllDevices().filter(d => d.status === 'offline').length,
        byType: getAllDevices().reduce((acc, d) => {
          acc[d.type] = (acc[d.type] || 0) + 1;
          return acc;
        }, {}),
      },
    };
  },

  /**
   * Client count per site, per VLAN
   */
  getClients(site) {
    const clients = site && siteData[site]
      ? (siteData[site].clients || []).map(c => ({ ...c, site }))
      : getAllClients();

    const byVlan = {};
    for (const v of VLANS) {
      byVlan[v.id] = {
        name: v.name,
        count: clients.filter(c => c.vlan === v.id).length,
      };
    }
    // Catch clients on unknown VLANs
    const knownVlanIds = new Set(VLANS.map(v => v.id));
    const unknownVlan = clients.filter(c => c.vlan != null && !knownVlanIds.has(c.vlan));
    if (unknownVlan.length > 0) {
      byVlan['other'] = { name: 'Other/Unknown', count: unknownVlan.length };
    }

    return {
      clients,
      total: clients.length,
      wired: clients.filter(c => c.is_wired).length,
      wireless: clients.filter(c => !c.is_wired).length,
      byVlan,
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
    };
  },

  /**
   * VLAN health: client count per VLAN, bleed violations
   */
  getVlans() {
    const allClients = getAllClients();

    const vlans = VLANS.map(v => {
      const clientsOnVlan = allClients.filter(c => c.vlan === v.id);
      const violations = bleedViolations.filter(bv => bv.vlan === v.id);
      return {
        ...v,
        clientCount: clientsOnVlan.length,
        violations: violations.length,
        violationDetails: violations,
      };
    });

    return {
      vlans,
      bleedViolations,
      totalViolations: bleedViolations.length,
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
    };
  },

  /**
   * Recent events from both sites, merged and sorted by time desc
   */
  getEvents() {
    return {
      events: getAllEvents(),
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
    };
  },

  /**
   * Active alarms + bleed violations
   */
  getAlerts() {
    const alarms = getAllAlarms();

    // Merge alarms and bleed violations into a single alerts list
    const alerts = [
      ...alarms.map(a => ({
        id: a.id,
        type: 'alarm',
        source: a.device_name || a.ap_name || 'Unknown',
        severity: a.severity === 'active' ? 'warning' : 'resolved',
        message: a.msg,
        site: a.site,
        timestamp: a.datetime,
      })),
      ...bleedViolations.map((bv, i) => ({
        id: `bleed-${i}`,
        type: 'vlan_bleed',
        source: `${bv.hostname} (${bv.mac})`,
        severity: bv.severity,
        message: bv.message,
        site: null,
        timestamp: bv.detectedAt,
      })),
    ];

    // Sort: critical first, then by timestamp desc
    const severityOrder = { critical: 0, high: 1, warning: 2, active: 2, info: 3, resolved: 4 };
    alerts.sort((a, b) => {
      const sev = (severityOrder[a.severity] || 5) - (severityOrder[b.severity] || 5);
      if (sev !== 0) return sev;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    return {
      alerts,
      summary: {
        total: alerts.length,
        critical: alerts.filter(a => a.severity === 'critical').length,
        high: alerts.filter(a => a.severity === 'high').length,
        warning: alerts.filter(a => a.severity === 'warning' || a.severity === 'active').length,
      },
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
    };
  },

  /**
   * Adapter health: isLive, lastPoll, connectionError, pollCount
   */
  getHealth() {
    return {
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
      controller: UNIFI_URL || '(mock)',
      sites: getSiteIds(),
      pollInterval: NETWORK_POLL_MS,
      pollCount,
      failCount,
      deviceCount: getAllDevices().length,
      clientCount: getAllClients().length,
      alarmCount: getAllAlarms().length,
      bleedViolationCount: bleedViolations.length,
    };
  },

  /**
   * Teleport VPN session data
   */
  getTeleport() {
    return {
      teleport: teleportData || { enabled: false, status: 'inactive', sessions: [] },
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
    };
  },

  /**
   * WAN health per site — ISP, latency, uptime, WAN IP, tx/rx rates
   */
  getWan() {
    const wanData = {};
    for (const [siteId, data] of Object.entries(siteData)) {
      const wan = (data.health || []).find(h => h.subsystem === 'wan');
      if (wan) {
        wanData[siteId] = {
          status: wan.status,
          wan_ip: wan.wan_ip,
          isp: wan.isp_name,
          latency: wan.latency,
          uptime: wan.uptime,
          tx_rate: wan.tx_bytes_r,
          rx_rate: wan.rx_bytes_r,
          num_adopted: wan.num_adopted,
        };
      }
    }
    return {
      wan: wanData,
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
    };
  },

  /**
   * Switch port detail for a specific device (by MAC)
   */
  getSwitchPorts(mac) {
    if (!mac) return { error: 'mac parameter required' };

    // In live mode, find the device and return port_table if available
    if (!MOCK_MODE) {
      for (const [siteId, data] of Object.entries(siteData)) {
        const device = (data.devices || []).find(d => d.mac === mac);
        if (device && device.port_table) {
          return {
            mac,
            device: device.name,
            ports: device.port_table,
            portCount: device.port_table.length,
            timestamp: new Date().toISOString(),
            isLive: true,
          };
        }
      }
    }

    // Find device name for mock
    let deviceName = 'Unknown Switch';
    for (const data of Object.values(siteData)) {
      const dev = (data.devices || []).find(d => d.mac === mac || d.id === mac);
      if (dev) { deviceName = dev.name; break; }
    }

    return { ...generateMockSwitchPorts(mac, deviceName), isLive: false, isMock: true };
  },

  /**
   * AI-ready summary for Lab Assistant agents
   */
  getAIContext() {
    const allDevices = getAllDevices();
    const allClients = getAllClients();
    const allAlarms = getAllAlarms();
    const allEvents = getAllEvents();

    const offlineDevices = allDevices.filter(d => d.status === 'offline');
    const negativeEvents = allEvents.filter(e => e.is_negative).slice(0, 5);

    const sitesSummary = {};
    for (const [siteId, data] of Object.entries(siteData)) {
      const wan = (data.health || []).find(h => h.subsystem === 'wan');
      sitesSummary[siteId] = {
        devices: data.devices?.length || 0,
        devicesOnline: (data.devices || []).filter(d => d.status === 'online').length,
        clients: (data.clients || []).length,
        wanStatus: wan?.status || 'unknown',
        wanIsp: wan?.isp_name || 'unknown',
        wanLatency: wan?.latency || null,
        alarms: (data.alarms || []).length,
      };
    }

    // VLAN client distribution
    const vlanDistribution = {};
    for (const v of VLANS) {
      const count = allClients.filter(c => c.vlan === v.id).length;
      if (count > 0) {
        vlanDistribution[`VLAN ${v.id} (${v.name})`] = count;
      }
    }

    return {
      source: 'UniFi Network',
      isLive,
      isMock: MOCK_MODE,
      lastPoll,
      lastSuccessfulPoll,
      connectionStatus: MOCK_MODE ? 'mock' : (isLive ? 'connected' : `disconnected: ${connectionError}`),
      sites: sitesSummary,
      network: {
        totalDevices: allDevices.length,
        devicesOnline: allDevices.filter(d => d.status === 'online').length,
        devicesOffline: offlineDevices.length,
        offlineDevices: offlineDevices.map(d => ({ name: d.name, type: d.type, ip: d.ip, site: d.site })),
        totalClients: allClients.length,
        wiredClients: allClients.filter(c => c.is_wired).length,
        wirelessClients: allClients.filter(c => !c.is_wired).length,
        clientsByVlan: vlanDistribution,
      },
      security: {
        activeAlarms: allAlarms.length,
        bleedViolations: bleedViolations.length,
        bleedDetails: bleedViolations.map(bv => ({
          mac: bv.mac,
          hostname: bv.hostname,
          vlan: bv.vlanName,
          severity: bv.severity,
          message: bv.message,
        })),
      },
      recentIssues: negativeEvents.map(e => ({
        event: e.key,
        msg: e.msg,
        site: e.site,
        when: new Date(e.datetime).toISOString(),
      })),
      vpn: teleportData ? {
        status: teleportData.status,
        activeSessions: teleportData.sessions.length,
        sessions: teleportData.sessions.map(s => ({
          name: s.name,
          user: s.user,
          ip: s.ip,
          connectedAt: s.connected_at,
        })),
      } : { status: 'inactive', activeSessions: 0 },
      wan: Object.fromEntries(
        Object.entries(siteData).map(([siteId, data]) => {
          const wan = (data.health || []).find(h => h.subsystem === 'wan');
          return [siteId, wan ? { status: wan.status, isp: wan.isp_name, latency: wan.latency, wanIp: wan.wan_ip } : null];
        })
      ),
    };
  },

  /**
   * Force immediate poll
   */
  async refresh() {
    if (MOCK_MODE) {
      generateMockData();
      return { success: true, isMock: true, lastPoll };
    }
    const success = await poll();
    return {
      success,
      isLive,
      lastPoll,
      lastSuccessfulPoll,
      connectionError,
    };
  },
};
