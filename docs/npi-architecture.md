# NPI (New Product Introduction) — Architecture Notes

Context for future Claude Code sessions. How the NPI module is wired, what the flow looks like in prod, and where the scars are.

---

## What this module does

Phil introduces new lens products (e.g. 1.74 TOG high-index) that need to be ordered from a supplier, received into the lab, and merged with existing inventory. The NPI module covers the full lifecycle:

1. **Project demand** — either by cannibalizing existing SKUs (new product replaces current ones) or by applying a Standard Rx Profile (net-new, no cannibalization).
2. **Place order** — emit a per-job Rx list CSV for the supplier; one row per expected lens unit with full prescription + placeholder SKU.
3. **Receive physical inventory** — quarantined under placeholder codes (real supplier SKUs aren't known until receiving).
4. **Map placeholder → real SKU** — on receipt, operator assigns real SKU; lens_sku_params inherits scenario params; quarantine releases with ItemPath dedup snapshot.
5. **Reconcile** — operator confirms the quarantine+ItemPath merge after checking physical count.
6. **Track variance** — post-activation, compare projected vs actual cannibalization per source SKU.

---

## Key principle: no data imports

The Excel workbook `Lens_Planning_V3.xlsx` was the *spec* for what this module does — it's not a data source. All properties (material, base curve, Rx distributions) come from **live data the app already collects**: DVI XML jobs, `picks_history`, `lens_consumption_weekly`. Do NOT import the spreadsheet. The app is the lens planner.

---

## Tables

### Core

- `npi_scenarios` — one row per NPI plan. Columns include `source_type` (prefix/skus/proxy/null_opc/standard_profile), `adoption_pct`, lead-time weeks, `safety_stock_weeks` (nullable — null = derive from ABC), `abc_class` (nullable — null = auto-classify from projected volume), `standard_profile_template_id`, `standard_profile_qty`, `status`.
- `npi_cannibalization` — projected per-source-SKU impact (current_weekly, lost_weekly, new_weekly). Populated by `computeCannibalization()`. Empty for `source_type='standard_profile'`.

### Properties (aggregated from live data)

- `lens_sku_properties` — per-SKU empirical: material (modal), lens_type_modal (S/C/P), sph/cyl/add ranges (min/max), sample_job_count, last_aggregated_at. Populated by `scripts/backfill-lens-sku-properties.js` (nightly / on-demand). **Source of truth for semi-finished classification** — `lens_type_modal='P'` means puck.
- `rx_profile_templates` — "Standard SV" + "Standard Surfacing" auto-derived from 12 months of jobs. Editable.
- `rx_profile_buckets` — distribution buckets for each template. SV: sph/cyl/add ranges with pct_of_total. Surfacing: base_curve with pct_of_total (pucks have no Rx).

### Placeholder + quarantine

- `npi_placeholder_skus` — PK `placeholder_code` ('NPI-{scenario_id}-V{n}'). Orders go out under these codes. `real_sku` null until mapped.
- `npi_quarantine_receipts` — physical batches received under a placeholder. Status transitions: `quarantined` → `released` (auto on placeholder map, with ItemPath qty snapshot) → `reconciled` (operator confirms merge).

---

## Flow per source_type

### `prefix` / `skus` / `proxy` — cannibalizing

- `computeCannibalization()` queries `lens_consumption_weekly` for matching SKUs, applies `adoption_pct`, writes rows to `npi_cannibalization`.
- `initialOrderQty = ceil((leadTime + safetyWeeks) * projectedWeeklyLenses)`.
- ABC class and safety_stock_weeks derived from projected monthly volume + `SAFETY_BY_CLASS` map (A=6, B=4, C=3), unless scenario overrides either.

### `null_opc` — CR39

- Queries `looker_jobs WHERE opc IS NULL` for total volume. Cannibalizes against all 4800%/062% SKUs as the source pool.
- Kept because CR39 is the free option — no specific SKU, just the absence of an OPC on a job.

### `standard_profile` — non-cannibalizing

- No source SKUs, no cannibalization rows.
- User specifies `standard_profile_template_id` + `standard_profile_qty`.
- `initialOrderQty = standard_profile_qty` directly (user already stated the target).
- Per-job expansion draws from the template's buckets weighted by `pct_of_total`.

---

## Per-job Rx list CSV — the primary order artifact

`GET /api/npi/scenarios/:id/rx-list.csv`

One row per expected lens unit. Columns:
```
line, placeholder_sku, real_sku, source_sku, lens_type, material, base_curve, diameter, sph, cyl, axis, add, pd, confidence
```

Header block at the top of the CSV (Excel renders # lines as plain text):
```
# NPI Rx List — <scenario name>
# TOTAL LENSES TO ORDER: N
# SV: X   Surfacing: Y
# By placeholder: NPI-xxx-V1=... | NPI-xxx-V2=...
# By material: PLY=... | H67=...
# Lead time + safety + ABC
# Generated: <iso>
```

Cannibalizing scenarios: replay historical Rx samples per source SKU (cycling with replacement) to hit the per-SKU allocated share of `initialOrderQty`.

Standard profile: allocate qty across buckets by `pct_of_total`, emit one row per unit at bucket midpoint.

---

## Placeholder SKU workflow

1. `createScenario` auto-inserts V1 placeholder (`NPI-{id}-V1`).
2. Operator can add more variants from the UI (one per variant material/base_curve/add combo).
3. Orders reference placeholder codes.
4. On receipt, operator enters real supplier SKU via `POST /placeholder-skus/:code/map`. This:
   - Updates placeholder: `real_sku`, `supplier_sku`, `status='mapped'`, `mapped_at`.
   - `INSERT OR IGNORE` into `lens_sku_params` for real SKU with scenario's abc_class / safety_stock_weeks / mfg / transit / fda. (Existing row preserved if present.)
   - Auto-releases any `quarantined` receipts for this placeholder, stamps `release_real_sku` + `itempath_qty_at_release`.
   - Returns `{ quarantineReleased, quarantineTotalQty, itempathQtySnapshot, proposedTotal, needsReconcile }`.
5. Placeholder row preserved after mapping — audit trail.

---

## Quarantine → reconciliation

- Physical lenses arrive at the lab before the supplier's SKU codes are confirmed. Operator clicks **+ Receive** in the NPI panel, enters placeholder code + qty.
- Inserts into `npi_quarantine_receipts` with `status='quarantined'`. Does NOT touch ItemPath.
- When the placeholder is mapped (above), all its quarantined receipts flip to `released` with the current ItemPath qty snapshotted. The UI displays the proposed merge total: `itempath_qty + quarantine_qty`.
- Operator verifies physical count matches, clicks **Reconcile** → `POST /quarantine-receipts/:id/reconcile` → `status='reconciled'`.
- ItemPath is the source of truth for inventory math. The quarantine badge is read-side only; no writes go back to ItemPath. Merge confirmation is for the human, not the machine.

---

## Variance tracking (Phase 6)

`GET /api/npi/scenarios/:id/cannibalization-variance?weeks=N`

For each source SKU in `npi_cannibalization`:
- Queries `lens_consumption_weekly` for the last N weeks
- Computes `actual_weekly = SUM/COUNT(DISTINCT week_start)`
- Compares to `projected_new_weekly` (what was stored at projection time — i.e. expected post-cannibalization)
- Returns `delta_vs_expected_pct` and `implied_adoption_pct`

v1 is read-only / on-demand — the "Variance" button in the NPI panel shows a quick alert with top 30 rows. No auto-adjust of safety_stock_weeks; operator reviews and decides whether to re-run the scenario.

---

## Scars + gotchas

- **Route shadowing** — the `GET /api/npi/scenarios/:id` catch-all matches any path under `/api/npi/scenarios/`. Every new suffix (`/compute`, `/export`, `/activate`, `/rx-list.csv`, `/cannibalization-variance`, `/variant-skus`, `/placeholder-skus`, `/quarantine-receipts`, `/po-document`) must be added to the exclusion list at the top of the handler. Commit `104cbfa` taught this the hard way.
- **`defaultValue` on scenario edit form** — React only reads `defaultValue` on mount. Switching scenarios without remounting leaves stale values. Fix: `key={sc.id}` on the panel wrapper forces remount. Commit `7882ad7`.
- **PT ≠ UTC** — lab is in Irvine (America/Los_Angeles). `datetime('now')` in SQLite is UTC. When bucketing by lab day, use `substr(col, 1, 10)` for offset-form strings (like `picks_history.completed_at`) or `date(col, 'localtime')` for naive UTC columns (like `dvi_jobs_history.shipped_at`). `ptNowIso()` in db.js gives PT-local ISO for new writes.
- **Surfacing base curves not in DVI XML** — `lensStyle` is an enum (`SV`, `ASPHERIC-SV`, `ENDLESS STDY`, `ENDLESS PLUS 075`). No numeric BC. The Surfacing standard template's buckets will be empty until Phil edits them via the UI or the seed list is expanded. Known gap.
- **Lens_Planning_V3.xlsx is NOT imported** — it was the spec, not a data source. If asked to import it, push back.
- **Placeholder code format is load-bearing** — `NPI-{scenario_id}-V{n}`. Don't change without a migration. Variant index is 1-based.
- **Quarantine does not write to ItemPath** — ItemPath is the vendor's source of truth. Quarantine + release is read-side only; the operator confirms the merge with physical count before reconciliation.

---

## Files

| Purpose | File |
|---|---|
| Table schemas + helpers | `server/db.js` |
| Scenario + projection + expansion | `server/npi-engine.js` |
| HTTP endpoints | `server/oven-timer-server.js` (search for `/api/npi/scenarios`) |
| UI | `src/components/tabs/InventoryTab.jsx` (NPI sub-tab) |
| Property + template backfill (one-shot) | `scripts/backfill-lens-sku-properties.js` |
| Tests | `scripts/test-npi.js` |

Endpoints (canonical list):
```
GET    /api/npi/scenarios
POST   /api/npi/scenarios
GET    /api/npi/scenarios/:id
PUT    /api/npi/scenarios/:id
DELETE /api/npi/scenarios/:id
POST   /api/npi/scenarios/:id/compute
POST   /api/npi/scenarios/:id/activate
GET    /api/npi/scenarios/:id/export                   — summary CSV
GET    /api/npi/scenarios/:id/rx-list.csv              — per-job CSV (primary)
GET    /api/npi/scenarios/:id/cannibalization-variance — projected-vs-actual
GET    /api/npi/scenarios/:id/placeholder-skus
POST   /api/npi/scenarios/:id/placeholder-skus
POST   /api/npi/scenarios/:id/placeholder-skus/:code/map
DELETE /api/npi/scenarios/:id/placeholder-skus/:code
GET    /api/npi/scenarios/:id/quarantine-receipts
POST   /api/npi/scenarios/:id/quarantine-receipts
POST   /api/npi/scenarios/:id/quarantine-receipts/:id/reconcile
DELETE /api/npi/scenarios/:id/quarantine-receipts/:id
GET    /api/rx-profile-templates
GET    /api/rx-profile-templates/:id
```

---

## Commits (session 2026-04-22, Phases 1–7)

- `1680b06` Phase 1 — `lens_sku_properties` + `rx_profile_templates` + replace hardcoded semifinished Sets
- `6dd30fe` Phase 2 — `standard_profile` source type + per-job Rx CSV
- `7882ad7` Phase 3 — UI: scenario-switch fix, standard profile dropdown, Per-Job CSV button
- `771b402` Phase 4 — placeholder SKU workflow
- `0c3d417` Phase 5 — quarantine inventory + release-on-map
- `4c1d19d` Phase 6 — variance tracking + SKU paste UX + CSV summary totals
- `?` Phase 7 — tests (`scripts/test-npi.js`) + this doc
