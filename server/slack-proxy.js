/**
 * slack-proxy.js — Lab_Assistant Slack Incoming Message Proxy
 * ─────────────────────────────────────────────────────────────
 * Slack's conversations.history API blocks browser CORS requests.
 * This tiny Node.js server sits on your manufacturing server and
 * proxies Slack message history to the Lab_Assistant dashboard.
 *
 * SETUP (one time):
 *   1. Create a Slack App: https://api.slack.com/apps → Create New App
 *   2. Under "OAuth & Permissions" add scopes: channels:history, users:read
 *   3. Install app to workspace → copy the "Bot User OAuth Token" (xoxb-...)
 *   4. Invite the bot to your channel: /invite @YourBotName
 *   5. Set SLACK_BOT_TOKEN and SLACK_CHANNEL_ID below (or as env vars)
 *   6. Run: node slack-proxy.js
 *   7. In Lab_Assistant config set Proxy URL = http://YOUR_SERVER_IP:3001/slack/messages
 *
 * REQUIREMENTS:
 *   - Node.js 18+ (uses built-in fetch)
 *   - No npm packages required
 *
 * RUNNING AS A SERVICE (optional):
 *   pm2 start slack-proxy.js --name slack-proxy
 */

const http = require("http");
const { URL } = require("url");

// ── Config — set these or use environment variables ───────────
const BOT_TOKEN  = process.env.SLACK_BOT_TOKEN  || "xoxb-YOUR-BOT-TOKEN-HERE";
const CHANNEL_ID = process.env.SLACK_CHANNEL_ID || "C0XXXXXXXXX";
const PORT       = parseInt(process.env.PROXY_PORT || "3001", 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || "*"; // restrict to your dashboard domain in production

// ── Cache layer (avoid hammering Slack) ──────────────────────
let cache = { ts: 0, data: null };
const CACHE_TTL_MS = 10_000; // 10 seconds

async function fetchSlackMessages(channelId, oldest) {
  const now = Date.now();
  if (cache.data && now - cache.ts < CACHE_TTL_MS && !oldest) {
    return cache.data;
  }

  const params = new URLSearchParams({ channel: channelId, limit: "20" });
  if (oldest) params.set("oldest", oldest);

  const res = await fetch(`https://slack.com/api/conversations.history?${params}`, {
    headers: { Authorization: `Bearer ${BOT_TOKEN}` },
  });

  if (!res.ok) throw new Error(`Slack API HTTP ${res.status}`);
  const data = await res.json();
  if (!data.ok) throw new Error(`Slack API error: ${data.error}`);

  cache = { ts: now, data };
  return data;
}

// ── HTTP Server ───────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  // CORS headers — allow dashboard origin
  res.setHeader("Access-Control-Allow-Origin", CORS_ORIGIN);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (req.method === "GET" && url.pathname === "/slack/messages") {
    try {
      const channelId = url.searchParams.get("channel") || CHANNEL_ID;
      const oldest    = url.searchParams.get("oldest")  || "";
      const data      = await fetchSlackMessages(channelId, oldest);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (err) {
      console.error("[slack-proxy] Error:", err.message);
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: err.message }));
    }
    return;
  }

  // Health check
  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, service: "slack-proxy", port: PORT }));
    return;
  }

  res.writeHead(404); res.end("Not found");
});

server.listen(PORT, () => {
  console.log(`✅ slack-proxy running on http://localhost:${PORT}`);
  console.log(`   Messages endpoint: http://localhost:${PORT}/slack/messages`);
  console.log(`   Health check:      http://localhost:${PORT}/health`);
  if (BOT_TOKEN === "xoxb-YOUR-BOT-TOKEN-HERE") {
    console.warn("⚠️  BOT_TOKEN not set — set SLACK_BOT_TOKEN env var or edit this file");
  }
});
