#!/usr/bin/env node
/**
 * probe-unifi-cloud.js — find the UniFi Site Manager API endpoint shape
 * that lets us reach into a remote console (Irvine 2 UDM) for devices/clients.
 *
 * UniFi's Site Manager API at api.ui.com/ea has several proxy patterns
 * documented in different places. This script tries each common shape
 * with the cloud key and reports which one returns 200 with non-trivial
 * data. Once we know, we wire that one into network-adapter.js.
 *
 * Usage:  UNIFI_CLOUD_KEY=<key> node scripts/probe-unifi-cloud.js
 */

'use strict';

const https = require('https');

const KEY = process.env.UNIFI_CLOUD_KEY || process.argv[2];
if (!KEY) {
  console.error('Set UNIFI_CLOUD_KEY env var or pass as arg.');
  process.exit(1);
}
const TARGET_HOSTNAME = process.env.UNIFI_CLOUD_IRVINE2_HOST || 'Irvine2';

function get(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const req = https.request({
      method: 'GET',
      hostname: u.hostname,
      path: u.pathname + u.search,
      headers: { 'X-API-KEY': KEY, 'Accept': 'application/json' },
      timeout: 10000,
    }, (res) => {
      let body = '';
      res.on('data', c => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    });
    req.on('error', e => resolve({ status: 0, body: `ERR: ${e.message}` }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, body: 'TIMEOUT' }); });
    req.end();
  });
}

function summarize(body) {
  if (!body) return '(empty)';
  let parsed;
  try { parsed = JSON.parse(body); } catch { return `(non-json, ${body.length}b)`; }
  if (parsed.error) return `ERROR: ${parsed.error.code} ${parsed.error.message}`;
  if (Array.isArray(parsed)) return `array of ${parsed.length}`;
  if (parsed.data && Array.isArray(parsed.data)) return `data[]: ${parsed.data.length} entries`;
  if (parsed.data && typeof parsed.data === 'object') return `data{}: keys=${Object.keys(parsed.data).slice(0,8).join(',')}`;
  return `keys=${Object.keys(parsed).slice(0,10).join(',')}`;
}

async function main() {
  console.log(`[probe] Looking up host id for hostname='${TARGET_HOSTNAME}'...`);
  const hostsResp = await get('https://api.ui.com/ea/hosts');
  if (hostsResp.status !== 200) {
    console.error(`[probe] /ea/hosts failed: ${hostsResp.status} ${hostsResp.body.slice(0,200)}`);
    process.exit(2);
  }
  let hosts;
  try { hosts = JSON.parse(hostsResp.body).data || []; } catch (e) { console.error('parse failed', e); process.exit(2); }
  const target = hosts.find(h => (h?.reportedState?.hostname || h?.reportedState?.name) === TARGET_HOSTNAME);
  if (!target) {
    console.error(`[probe] No host with hostname='${TARGET_HOSTNAME}'. Got: ${hosts.map(h => h?.reportedState?.hostname).join(',')}`);
    process.exit(3);
  }
  const hostId = target.id;
  console.log(`[probe] Found '${TARGET_HOSTNAME}' → id=${hostId}`);
  console.log('');

  // Try every plausible endpoint shape. For each, log status + a one-line summary.
  const candidates = [
    // Direct host detail (we know /ea/hosts works; try the singular)
    `https://api.ui.com/ea/hosts/${hostId}`,
    // Sites list under the host
    `https://api.ui.com/ea/hosts/${hostId}/sites`,
    // Cross-host sites (V1 + EA shapes)
    `https://api.ui.com/ea/sites`,
    `https://api.ui.com/v1/sites`,
    // Devices under the host (some UniFi docs reference this)
    `https://api.ui.com/ea/hosts/${hostId}/devices`,
    // Network application proxy (newer "applications" API)
    `https://api.ui.com/ea/v2/applications/network/sites`,
    `https://api.ui.com/ea/applications/network/sites`,
    // Remote-proxy SNI patterns (older docs reference this for site invocation)
    `https://api.ui.com/ea/sni/${hostId}/proxy/network/integration/v1/sites`,
    `https://api.ui.com/ea/sni/${hostId}/proxy/network/api/s/default/stat/device`,
    // Direct proxy under host
    `https://api.ui.com/ea/hosts/${hostId}/proxy/network/api/s/default/stat/device`,
    `https://api.ui.com/ea/hosts/${hostId}/proxy/network/integration/v1/sites`,
    // Integration v1 cross-account (newer surface)
    `https://api.ui.com/ea/integration/v1/sites`,
    `https://api.ui.com/ea/integration/v1/hosts/${hostId}/devices`,
  ];

  for (const url of candidates) {
    const r = await get(url);
    const tag = r.status === 200 ? '✓ 200' : `${r.status}`;
    console.log(`${tag.padEnd(8)} ${url}`);
    console.log(`         → ${summarize(r.body).slice(0, 200)}`);
  }
  console.log('');
  console.log('[probe] Done. Look for any "✓ 200" rows above whose summary mentions devices/sites/data — those are the wireable endpoints.');
}

main();
