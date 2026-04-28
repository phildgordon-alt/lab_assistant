#!/usr/bin/env node
/**
 * probe-unifi-cloud-v2.js — find per-site /devices and /clients endpoints
 * now that we know /ea/sites returns site IDs.
 *
 * Run after probe-unifi-cloud.js confirmed /ea/sites works:
 *   UNIFI_CLOUD_KEY=<key> node scripts/probe-unifi-cloud-v2.js
 */

'use strict';

const https = require('https');

const KEY = process.env.UNIFI_CLOUD_KEY || process.argv[2];
if (!KEY) { console.error('Set UNIFI_CLOUD_KEY env var.'); process.exit(1); }

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
  console.log('[probe2] Listing sites...');
  const sitesResp = await get('https://api.ui.com/ea/sites');
  if (sitesResp.status !== 200) { console.error('sites failed', sitesResp); process.exit(2); }
  const sites = JSON.parse(sitesResp.body).data || [];
  console.log(`[probe2] Found ${sites.length} sites:`);
  for (const s of sites) {
    console.log(`         siteId=${s.siteId}  hostId=${s.hostId}  name="${s?.meta?.desc}"`);
  }
  console.log('');

  // Try common sub-paths for each site
  const subpaths = [
    'devices', 'clients', 'wifi-clients', 'wired-clients',
    'health', 'alarms', 'events', 'wlans', 'lans', 'wans',
  ];

  for (const site of sites) {
    console.log(`[probe2] === site '${site?.meta?.desc}' (siteId=${site.siteId}) ===`);
    for (const sub of subpaths) {
      // Try both /ea/sites/{id}/sub and /v1/sites/{id}/sub
      for (const base of ['ea', 'v1']) {
        const url = `https://api.ui.com/${base}/sites/${site.siteId}/${sub}`;
        const r = await get(url);
        if (r.status === 200 || r.status === 404) {
          // Only log non-404 OR show the first 404 to confirm shape
          const tag = r.status === 200 ? '✓ 200' : '404';
          if (r.status === 200) {
            console.log(`  ${tag}  ${url}`);
            console.log(`         → ${summarize(r.body).slice(0, 200)}`);
          }
        } else {
          console.log(`  ${r.status}  ${url}  → ${summarize(r.body).slice(0, 100)}`);
        }
      }
    }

    // Also try host-scoped variants
    for (const sub of ['devices', 'clients']) {
      const url = `https://api.ui.com/ea/hosts/${site.hostId}/sites/${site.siteId}/${sub}`;
      const r = await get(url);
      if (r.status === 200) {
        console.log(`  ✓ 200  ${url}`);
        console.log(`         → ${summarize(r.body).slice(0, 200)}`);
      }
    }
    console.log('');
  }
  console.log('[probe2] Done. ✓ 200 rows are wireable.');
}

main();
