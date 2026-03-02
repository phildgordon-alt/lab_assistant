# CLAUDE.md — Lab_Assistant Project Context
# Pair Eyewear · Irvine, CA · VP R&D: Phil
# Last updated: March 2026 · Handed off from claude.ai chat sessions

---

## What This Is

Lab_Assistant is an internal MES (Manufacturing Execution System) built for Pair Eyewear's
optical lens lab in Irvine, CA. It is a React single-page app backed by a Node.js server,
deployed on tablets and desktops on the lab floor.

The lab is a 54-person automated lens lab that Phil designed and built. It processes
prescription eyewear jobs through: Picking → Surfacing → Cutting/Edging → Coating → Assembly → QC → Ship.

Phil has 30 years of manufacturing experience and communicates in direct, data-driven terms.
He is the primary stakeholder and daily user. Do not over-explain. Be specific and technical.

---

## Architecture Overview

```
Browser (React SPA)          Server (Node.js)            External APIs
─────────────────────        ────────────────────        ──────────────
src/App.jsx                  server/oven-timer-server.js  ItemPath/Kardex (live, 60s poll)
  ├─ Main app + all tabs       ├─ REST API (:3002)         DVI (jobs, 90s poll)
  ├─ ?mode=tablet              ├─ WebSocket (timers)       Looker (nightly ETL 2AM)
  └─ ?mode=corporate           ├─ /api/report (Word gen)   Slack (webhooks)
                               ├─ /api/dvi/*
Standalone HTML                ├─ /api/itempath/*
─────────────────────          └─ /api/report
standalone/OvenTimer.html
standalone/CoatingTimer.html  server/dvi-adapter.js       → DVI API
standalone/AssemblyDashboard.html  server/itempath-adapter.js  → ItemPath API
                              server/nightly-etl.js       → Looker + email IMAP
                              server/slack-proxy.js       → Slack webhooks
                              server/nightly-etl.js       → cron 2AM ETL
```

**URL modes (App.jsx):**
- `/` — Full desktop app, all features, all controls
- `/?mode=tablet` — Manager tablet, same features, touch-optimized (44px targets, bottom nav)
- `/?mode=corporate` — Read-only corporate viewer, 4 tabs only, no write operations

---

## File Map — Every File and What It Does

### `src/App.jsx` (229KB — the main app)
The entire React frontend. Single file. Contains:

**Tabs:**
1. **Overview** — KPI cards, live activity feed, zone map
2. **Put Wall** — 75-position binding grid (2 walls), scan-to-bind workflow
3. **Coating Intel** — Coating machine status, batch controls, yield tracking
4. **Smart Trays** — Tray fleet management, BLE zone detection, tray locator, QR generator
5. **Analytics** — 4 sub-views: Throughput, Yield, Cycle Times, Operator Performance
6. **AI Assistant** — Claude-powered chat with live lab context. Quick prompts include WIP Aging Report.
7. **Smart Tray Map** — UWB/BLE position map, SVG floor plan, 7 zones, 8 anchors

**Key components:**
- `AIAssistantTab` — Calls Anthropic API directly from browser. Builds system prompt from live tray/batch data. Quick prompts: Shift Report, WIP Aging Report, Overdue Trays, Machine Analysis, Coating Yield, Rush Jobs, EOD Report. WIP Aging Report computes days-in-lab + due date for every active tray and sends full data to Claude.
- `PutWallTab` — Two-scan binding: scan thermal label barcode + scan position QR → binds job to position to tray. Position map persists to localStorage.
- `CoatingIntelTab` — Manual batch controls, QC tracking, oven timers with 6 racks each
- `SmartTraysTab` — Tray binding, Recent Bindings (sorted by timestamp), tray locator, e-ink preview

**URL modes:** Detected at render time via `new URLSearchParams(window.location.search).get('mode')`.
- Tablet mode: compact header, bottom nav bar, 44px touch targets
- Corporate mode: CorporateViewer component, read-only, 4 tabs only

**Data sources in App.jsx:**
- All tray/batch data is currently **mock** (generated in-memory on load)
- Designed to swap mock generators for live API calls to `server/oven-timer-server.js`
- AI Assistant calls Anthropic API directly: `https://api.anthropic.com/v1/messages`
- Model: `claude-sonnet-4-20250514`, max_tokens: 2000 for reports

### `server/oven-timer-server.js` (29KB)
Main Node.js backend. Express + WebSocket.
- REST endpoints for oven timers, tray state, QC events
- `/api/report` — accepts JSON, generates Word .docx via docx.js, returns binary
- WebSocket for real-time timer sync across tablets
- **Add 4 lines to integrate DVI adapter** (see dvi-adapter.js header comments)
- **Add 4 lines to integrate ItemPath adapter** (see itempath-adapter.js header comments)
- Runs on port 3002

### `server/dvi-adapter.js` (20KB)
Polls DVI API every 90 seconds for assembly job data.
- Auth: API key (`X-API-Key` header) or Basic Auth — set via `DVI_AUTH` env var
- Normalizes DVI field names (variants documented inline — DVI schemas differ by install)
- `DVI_ASSEMBLY_STAGE` env var controls what DVI calls the assembly step (default: 'ASSEMBLY')
- **Currently not integrated** into oven-timer-server.js — add 4 lines (see file header)
- Mock mode activates when `DVI_URL` not set — generates 60 realistic jobs with 6 operators
- Exports: `start()`, `getJobs(query)`, `getStats()`, `getOperatorStats(name)`, `getAIContext()`

**IMPORTANT — DVI field mapping:** DVI installs vary. Before going live, get a sample JSON
response from your DVI admin to verify field names match the normalization map in the file.
Common variants are documented inline (e.g., `job_id` vs `order_number` vs `lab_order_id`).

### `server/itempath-adapter.js` (21KB)
Polls ItemPath/Kardex API every 60 seconds for live lens blank inventory.
- Auth: Non-expiring application token (Bearer header)
- To generate application token: create "application" type user in ItemPath → login to get
  refreshToken → POST to `/api/users/application-token`
- Polls: `/api/materials`, `/api/orders`, `/api/transactions` in parallel
- Low-stock alerts via Slack: CRITICAL (qty=0), HIGH (qty ≤ 50% threshold), LOW (≤ threshold)
- Configurable thresholds per coating type (AR:30, BLUE_CUT:20, HARD_COAT:25, etc.)
- Mock mode when `ITEMPATH_TOKEN` not set
- Exports: `start()`, `getInventory()`, `getPicks()`, `getAlerts()`, `findBlank(query)`, `getAIContext()`

### `server/nightly-etl.js` (19KB)
Runs at 2:00 AM via cron. Pulls historical data from Looker and/or DVI.
- Looker: OAuth2 client credentials → fetches 3 Looks (throughput, yield, cycle times)
- DVI: API key → completed jobs endpoint
- Email/IMAP: Parses CSV attachments from scheduled Looker/DVI email reports
- Writes JSON files to `/data/historical/` (one per data type per day)
- Logs to `sync-log.json` (last 90 days)
- Sends Slack summary after each run
- Exports: `readHistorical(type, days)` for server to answer AI queries

### `server/slack-proxy.js` (4KB)
Simple Express proxy for Slack webhooks. Handles CORS for browser-side Slack calls.

### `standalone/AssemblyDashboard.html` (50KB)
Standalone tablet app for the assembly zone. No build step — open directly in browser.
- **Data source:** DVI via Lab_Assistant server `/api/dvi/jobs` (polls every 2 min)
- **4 tabs:** Live Floor (8 stations, 7 KPIs), Leaderboard, Job Queue, Operators
- **7 KPI tiles:** Stations Active, Incoming Today, Shipped Today, Assembled Today, Total WIP, On Hold, Rush Active
- **Setup (⚙ button):** Server URL, DVI URL, DVI API key, shift start time — all persisted to localStorage
- **Mock mode:** Works immediately without DVI credentials — 60 sample jobs, 6 operators
- **Operator tracking:** Assign operators to stations, track jobs/hour, avg minutes, rush count
- **Leaderboard:** Gold/silver/bronze, winner banner, animated progress bars
- Currently runs standalone — when DVI adapter is live, point Setup to your server URL

### `standalone/OvenTimer.html` (58KB)
Standalone tablet app for coating oven operators. One per oven tablet.
- 6 rack timers per oven, configurable target times per coating type
- Sends events to oven-timer-server.js via WebSocket
- Setup modal for oven identity + server URL
- Offline-capable (timers continue if connection drops)

### `standalone/CoatingTimer.html` (39KB)
Standalone tablet app for individual coaters. One tablet per coater.
- Single large timer, full-screen
- 9 coating types with custom default target times
- Custom coating type management (add/edit/delete)
- Setup modal: coater identity, operator name, server URL — persists forever on that tablet

### `public/` — Put Wall QR Codes
- `PutWall_1_QR_Codes.html` — 75 QR codes for Wall 1 positions P01–P75
- `PutWall_2_QR_Codes.html` — 75 QR codes for Wall 2 positions P01–P75
- `PutWall_QR_Index.html` — Landing page linking to both
- Print on Brother QL-820NWB label printer, laminate, attach to put wall positions

### `docs/` — Reference Documents
- `LabAssistant_Master_Catalog.docx` — Complete index of all 24 deliverables
- `SmartTray_Platform_Architecture.docx` — Strategic case for Smart Tray as data sovereignty layer
- `LabAssistant_DataIntegration_Architecture.docx` — Full integration architecture, all data sources
- `LabAssistant_AI_Architecture_FutureState.docx` — External customer / SaaS path (deferred)
- `UWB_Vendor_Evaluation_PairEyewear.docx` — Pozyx recommended if upgrading from BLE to UWB
- `BLE_ZoneReader_Hardware_BOM.docx` — Zone-based BLE hardware, ~$500 for 10 readers
- `SmartTray_Retrofit_BOM.docx` — Minew E7 beacons, ~$12/tray, 140 trays = ~$1,880

---

## What's Live vs Mock

| Component | Status | Notes |
|---|---|---|
| React app UI | ✅ COMPLETE | All tabs, all modes |
| Tray/batch data | 🟡 MOCK | Generated in-memory. Wire to server APIs. |
| Oven timers | ✅ LIVE | oven-timer-server.js + WebSocket |
| Word report export | ✅ LIVE | `/api/report` endpoint in server |
| AI Assistant | ✅ LIVE | Calls Anthropic API directly |
| ItemPath adapter | 🟡 MOCK | Written, not integrated. Needs `ITEMPATH_TOKEN`. |
| DVI adapter | 🟡 MOCK | Written, not integrated. Needs `DVI_URL` + `DVI_API_KEY`. |
| Assembly Dashboard | 🟡 MOCK | Standalone, works. Wire to dvi-adapter when ready. |
| Nightly ETL | 🟡 STUB | Written, not scheduled. Needs Looker credentials. |
| BLE zone readers | 📋 PLANNED | Hardware BOM done. Raspberry Pi Zero 2W + ASUS USB-BT500. |
| Smart Tray BLE tags | 📋 PLANNED | Minew E7 beacons, retrofit BOM done. |
| Slack alerts | ✅ LIVE | slack-proxy.js + SLACK_WEBHOOK env var |

---

## Lab Physical Layout

**Pair Eyewear Irvine — two adjacent sites, same building complex**

Zones (what BLE readers will cover):
1. **Picking / Put Wall** — 2 walls × 75 positions = 150 total. Operators pick jobs here.
2. **Surfacing** — Lens generation/surfacing line (1 BLE reader covers whole zone)
3. **Coating** — 3 coating machines. AR, Blue Cut, Hard Coat, Mirror, Polarized, Transitions.
4. **Cutting / Edging** — Lens edging to frame shape
5. **Assembly** — 8 stations (STN-01 through STN-08, benches A/B/C). AssemblyDashboard.html lives here.
6. **QC** — Inspection
7. **Ship** — Final pack and ship

Put Wall workflow:
1. Front operator picks job → presses green/blue button → position lights up on back side
2. Back operator presses button → thermal label prints with job ticket
3. Operator scans thermal label barcode + scans position QR on wall → Lab_Assistant binds job→position→tray

---

## Smart Tray Strategy (Key Insight)

Smart Tray is a **data sovereignty play**, not just a tracking feature. Currently 5 vendor
systems each own a slice of the production data (DVI, ItemPath, coating machines, oven PLC,
QC system). Smart Tray makes the tray itself the system of record — every event streams
through the tray, and the lab owns that event stream.

**Phase 1 (recommended):** BLE Zone Detection
- Raspberry Pi Zero 2W + ASUS USB-BT500 adapter at each zone (~$50/reader)
- Minew E7 BLE beacons on trays (~$12/tray retrofit)
- Zone-level detection (not machine-level) — "tray is in Coating" is sufficient for Phase 1
- 10 readers total, ~$500 hardware, ~$1,880 for 140 trays
- Delivers 80% of UWB value at 15% of UWB cost

**Phase 2:** Machine-level detection or UWB upgrade (Pozyx recommended if needed)
**Phase 3:** E-ink display on tray (job info visible on tray surface)
**Phase 4:** Custom PCB with BLE + NFC + e-ink (full smart tray)

---

## Known Issues / Technical Debt

1. **App.jsx is a single massive file (229KB, ~3,800 lines).** Works fine but should be
   split into components when doing significant future work. Split by tab.

2. **All tray/batch data is mock.** The app generates data in-memory on load. The integration
   path is: server adapters poll APIs → expose via `/api/*` endpoints → App.jsx polls those
   instead of generating mock data. The adapter modules are written and ready.

3. **DVI field mapping needs verification.** The dvi-adapter.js normalizes fields but DVI
   installs vary. Get a sample API response from the DVI admin before going live.

4. **Nightly ETL cron not configured.** nightly-etl.js is written but not scheduled.
   Add to crontab: `0 2 * * * node /path/to/server/nightly-etl.js`

5. **oven-timer-server.js needs 4-line additions** to integrate DVI and ItemPath adapters.
   See integration comments at top of each adapter file.

6. **React #310 error was fixed** — there was an illegal `useState` inside an IIFE in JSX
   in the Put Wall binding section. Removed. No functional impact.

---

## How to Run Locally

```bash
# 1. Install frontend deps
npm install

# 2. Install server deps
cd server && npm install express cors node-fetch ws qrcode && cd ..

# 3. Copy env file and fill in credentials
cp .env.example .env

# 4. Start server (terminal 1)
npm run server

# 5. Start frontend dev server (terminal 2)
npm run dev

# App at http://localhost:5173
# Tablet mode: http://localhost:5173/?mode=tablet
# Corporate: http://localhost:5173/?mode=corporate

# Standalone apps — just open directly in browser, no server needed for mock mode:
# standalone/AssemblyDashboard.html
# standalone/OvenTimer.html
# standalone/CoatingTimer.html
```

---

## Immediate Next Work Items (in priority order)

1. **Wire DVI adapter into server** — 4 lines in oven-timer-server.js. Get DVI URL + API key
   from DVI admin. Verify field names against a sample response. Point AssemblyDashboard
   Setup to server URL. Assembly floor goes live.

2. **Wire ItemPath adapter into server** — 4 lines in oven-timer-server.js. Phil to generate
   application token in ItemPath. Lens blank inventory becomes live in AI context and Overview.

3. **Replace mock tray data in App.jsx** — App.jsx currently generates trays in-memory.
   Add polling to `/api/trays` and `/api/batches` once server exposes those from DVI/ItemPath.

4. **Schedule nightly ETL** — Add crontab entry for nightly-etl.js. Get Looker client
   credentials from BI team. Historical data enables AI to answer trend questions.

5. **BLE hardware purchase** — Order per BLE_ZoneReader_Hardware_BOM.docx (~$500).
   Set up 10 Raspberry Pi Zero 2W readers at zone entry points. Add `/api/ble/event`
   endpoint to server to receive zone crossing events.

6. **Smart Tray retrofit** — Order per SmartTray_Retrofit_BOM.docx (~$1,880 for 140 trays).
   Minew E7 beacons, 3M VHB tape, Brother QL-820NWB labels. 4-hour retrofit session.

7. **Split App.jsx into components** — When doing significant work on any tab, extract it
   to `src/components/[TabName]Tab.jsx`. Reduces file size and makes Claude Code sessions
   more manageable.

---

## Coding Conventions

- **React functional components only**, hooks at top level, never inside conditionals or IIFEs
- **Single-file approach** maintained for standalone HTML apps (OvenTimer, CoatingTimer, AssemblyDashboard)
- **Dark theme throughout** — CSS vars defined in `:root`: `--bg:#070A0F`, `--surface:#0D1117`, etc.
- **Font stack:** Bebas Neue (display headers), JetBrains Mono (data/metrics), DM Sans (body)
- **Color language:** green=good/active, amber=warning/pending, red=hold/critical, blue=info, purple=assembly, teal=incoming
- **No external state library** — useState/useEffect/useRef only
- **localStorage keys:**
  - `la_slack_v2` — server URL, shift start, Slack config
  - `la_position_map` — put wall position→tray bindings
  - `asy_assignments` — Assembly Dashboard station assignments
  - `asy_operators` — Assembly Dashboard operator roster
  - `asy_cfg` — Assembly Dashboard config

---

## Custom Card System (Overview Tab)

The Overview tab uses a HA Lovelace-inspired custom card system. Cards are fully user-configurable — add, remove, reorder by drag-and-drop. Layout persists to localStorage under key `la_cards_v1`.

### Card Data Model
```js
// Each card in the cards[] array:
{ id: "c1",              // unique ID (genId() — timestamp+random)
  type: "kpi_row",       // maps to CARD_REGISTRY type
  title: "KPI Row",      // display label in card header
  config: {}             // card-specific config (e.g. thresholdHours for aging_alert)
}
```

### Available Card Types (CARD_REGISTRY)
| type | Description |
|---|---|
| `kpi_row` | 6 KPI tiles — active trays, quick bind, coating WIP, batch fill, rush, QC/breaks |
| `slack_feed` | Slack messages + compose + configure drawer |
| `coating_machines` | All 3 BatchCard components with expand/controls |
| `putwall_grid` | Quick bind 5×4 grid + EventLog side by side |
| `fleet_dept` | Tray dot-matrix by department with coating legend |
| `rush_queue` | Live rush jobs with location and time-in-system |
| `aging_alert` | WIP jobs over threshold — configurable (2/4/6/8/12/24/48h via dropdown, saved to card.config.thresholdHours) |
| `inventory` | Lens blank stock levels (mock; wire to ItemPath adapter) |
| `ai_query` | Embedded `OverviewAICard` — single-question AI widget |
| `custom_metric` | Polls any REST endpoint, displays returned value. Config: url, field (JSON key), intervalSec, label |

### Adding New Card Types
1. Add entry to `CARD_REGISTRY` array (type, label, icon, desc)
2. Add `case "your_type":` in `renderCardContent(card)` switch
3. Done — it appears in the Add Card picker automatically

### Default Layout
Five cards on fresh load (no localStorage): kpi_row → slack_feed → coating_machines → putwall_grid → fleet_dept

### localStorage Key
`la_cards_v1` — JSON array of card objects. Changing the key version resets all users to DEFAULT_CARDS.

---

## Backend Architecture Direction — Home Assistant Patterns

Lab_Assistant's backend should be modeled **after** Home Assistant's architecture as an
influence, not built on or dependent on Home Assistant itself. HA was chosen as the reference
because its core architecture is almost perfectly analogous to what a mature Lab_Assistant needs.

### Five HA Patterns to Adopt Directly

**1. Entity + State Machine Model**
Everything trackable is an "entity" with a canonical state and validated transitions.
Trays are the primary entity:

```
IDLE → BOUND → IN_SURFACING → IN_CUTTING → IN_COATING → IN_ASSEMBLY → IN_QC → COMPLETE → IDLE
```

No ad-hoc state mutations. A tray cannot jump from IDLE to COMPLETE without traversing
the correct stages. This gives you validated transitions AND a built-in audit trail.
The entity registry is a central in-memory store (backed by SQLite) of all tray states.

**2. Event Bus (pub/sub)**
Every state change fires a named event on a central bus. Any module can subscribe without
being tightly wired to any other module. Node.js `EventEmitter` is sufficient to start.

Example flow:
```
coating_machine → fires BATCH_COMPLETE event
  ├── Slack notifier picks it up → posts alert
  ├── Analytics recorder picks it up → writes to SQLite
  └── Tray state updater picks it up → advances tray state
```

Currently Lab_Assistant has events scattered and tightly wired between components.
The event bus decouples everything. New integrations just subscribe — they don't
require changes to existing code.

**3. Service Calls**
Every operation is a named service with a defined input schema. External systems
(DVI, Kardex, coating machines, BLE readers) call services — they don't directly
mutate state. The service handler validates, updates the entity, and fires the event.

Core Lab_Assistant services:
- `tray.bind(trayId, jobId, operatorId)`
- `tray.advance(trayId, newState, location)`
- `batch.start(batchId, coatingType, machineId, operatorId)`
- `batch.complete(batchId, passRate)`
- `oven.rack_complete(ovenId, rackId, coatingType, durationMin)`
- `ble.zone_event(beaconId, zoneId, eventType)` ← when BLE hardware is live

**4. Recorder / State History (SQLite)**
Append-only log of every state change. This is a compliance requirement for a
prescription lens lab — regulators and QC audits can ask "where was this job at
what time and who touched it."

Schema:
```sql
CREATE TABLE state_history (
  id INTEGER PRIMARY KEY,
  entity_type TEXT,        -- 'tray', 'batch', 'oven_rack'
  entity_id TEXT,          -- 'T-047', 'B-023'
  old_state TEXT,
  new_state TEXT,
  triggered_by TEXT,       -- service name that caused the change
  operator_id TEXT,
  metadata TEXT,           -- JSON blob for extra context
  recorded_at INTEGER      -- Unix timestamp ms
);
```

Every `tray.bind`, `batch.start`, `oven.rack_complete` service call writes a row.
Query: "Show me the complete journey of job J21634" → join on job_id across tray history.

**5. WebSocket Push (not polling)**
The dashboard connects once via WebSocket and receives state change events in real time.
No polling. Sub-second latency. The oven timer is already a polling version of this —
the goal is to unify everything under one WebSocket server.

Event envelope pushed to all connected clients:
```json
{
  "event": "state_changed",
  "entity_type": "tray",
  "entity_id": "T-047",
  "old_state": "BOUND",
  "new_state": "IN_COATING",
  "timestamp": 1709312400000,
  "metadata": { "machine": "Coater-2", "coating": "AR" }
}
```

Dashboard React components subscribe to relevant event types and update local state
without polling. `oven-timer-server.js` already has the WebSocket server — extend it.

### One HA Pattern Explicitly NOT Adopted

**YAML configuration flows / multi-integration plugin system.** HA needs that complexity
to support hundreds of arbitrary third-party devices from unknown vendors. Lab_Assistant
is a closed environment — DVI, Kardex, three coating machines, BLE readers. Use a simple,
strongly-typed integration layer instead. Each data source gets one adapter module
(already done: `dvi-adapter.js`, `itempath-adapter.js`) with a clear interface contract.

### The Target Server Architecture

The current `oven-timer-server.js` is already a single-entity version of this pattern.
The goal is to unify everything into one "Lab_Assistant Core" service:

```
server/
  core/
    entity-registry.js   ← in-memory entity store, validates state transitions
    event-bus.js         ← EventEmitter wrapper, typed events
    recorder.js          ← SQLite append-only state history
    service-handler.js   ← routes service calls, validates, fires events
  integrations/
    dvi-adapter.js       ← already written
    itempath-adapter.js  ← already written
    ble-adapter.js       ← to build when hardware arrives
    nightly-etl.js       ← already written
  api/
    rest.js              ← Express REST endpoints
    websocket.js         ← WebSocket server, pushes events to dashboard
  oven-timer-server.js   ← current monolith, refactor into above over time
```

**Refactor strategy:** Don't rewrite `oven-timer-server.js` all at once. Add the entity
registry, event bus, and recorder as new modules alongside it. Migrate endpoints one at
a time. The dashboard doesn't need to know — it just talks to the same WebSocket and REST API.



See `.env.example` for full list. Key ones:

| Variable | Used By | Description |
|---|---|---|
| `PORT` | oven-timer-server.js | Server port (default 3002) |
| `SLACK_WEBHOOK` | All adapters | Slack incoming webhook URL |
| `ITEMPATH_URL` | itempath-adapter.js | ItemPath base URL |
| `ITEMPATH_TOKEN` | itempath-adapter.js | Non-expiring application token |
| `DVI_URL` | dvi-adapter.js | DVI API base URL |
| `DVI_API_KEY` | dvi-adapter.js | DVI API key |
| `DVI_ASSEMBLY_STAGE` | dvi-adapter.js | What DVI calls assembly (default: ASSEMBLY) |
| `LOOKER_URL` | nightly-etl.js | Looker instance URL |
| `LOOKER_CLIENT_ID` | nightly-etl.js | Looker OAuth2 client ID |
| `LOOKER_CLIENT_SECRET` | nightly-etl.js | Looker OAuth2 client secret |

---

## People / Context

- **Phil** — VP R&D, Manufacturing, Logistics, Supply Chain at Pair Eyewear. Built this system
  from scratch over 14 chat sessions. Direct communicator. Knows manufacturing deeply.
  Based in Rancho Santa Margarita. Pair HQ + lab in Irvine, CA.
- **Pair Eyewear** — DTC prescription eyewear, interchangeable magnetic top frames.
  ~54-person lens lab. Previous manufacturing in China, migrated to Vietnam + Philippines.
  Lab running in Irvine processes US orders.
- **DVI** — Their lab management / Rx routing system. Source of truth for job/prescription data.
- **ItemPath** — WMS running the Kardex (automated vertical carousel) for lens blank inventory.
- **Looker** — BI tool for historical reporting (throughput, yield, cycle times).

---

*This file is the primary context document for Claude Code. Read it fully at the start of
every session. All implementation decisions, naming conventions, and priorities described
here reflect explicit decisions made by Phil over 14 sessions of development.*
