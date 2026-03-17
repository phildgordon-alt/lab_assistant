# CLAUDE.md — Coating Container Inheritance System
## Lab Assistant | Coating Agent Module

---

## What You Are Building

A container inheritance tracking system for the Pair Eyewear lens coating workflow. Lenses move through a physical pipeline: scan station → dip coater tool → oven tray → coating machine batch. Right now there is zero tracking of jobs through this process. You are building the data model, API layer, and UI that captures this flow.

The scan station is where job identity is captured once using OCR on the CO2 laser mark on each lens. Every step after that is container-to-container inheritance — tools load into trays, trays load into batches. The manifest of any container is always computed live by walking the hierarchy tree. Jobs are never copied.

This system lives inside the existing Lab Assistant FastAPI/React application and connects to the same SQL database already in use. The Coating Agent is one of the nine department agents already in the system. You are extending it.

---

## Architecture Overview

### The Three-Table Model

Everything is built on three tables. Do not add more tables without a clear reason.

**`containers`** — one row per physical container, any type
**`container_jobs`** — job numbers written here once, at tool level only, at scan station
**`container_contents`** — parent/child relationships between containers

That's the entire data model. Manifests are always computed by querying these three tables. Nothing is ever copied or snapshotted.

### Container Type Hierarchy

```
coding_batch  (largest — one per machine run)
    └── oven_tray  (medium — one per oven rack position)
            └── tool  (smallest — one per dip coater tool)
                    └── [jobs written here, container_jobs table]
```

Jobs only exist at the tool level in `container_jobs`. Every level above is just a tree of container IDs in `container_contents`. A batch manifest is computed by walking two levels down the tree.

### Stack

- Backend: FastAPI (Python) — existing app, add new router
- Database: existing SQL database already connected to Lab Assistant (check current connection, likely SQLAlchemy)
- Frontend: React — existing Lab Assistant UI, add new screens to Coating Agent
- Existing Coating Agent is already in the system — extend it, do not replace it

---

## Database Schema

Run these migrations against the existing Lab Assistant database. Check whether Alembic is already set up in the project — if yes, create migration files. If no, run SQL directly.

```sql
-- Container registry
CREATE TABLE containers (
    id VARCHAR(50) PRIMARY KEY,           -- e.g. TOOL-006, TRAY-003, BATCH-041
    type VARCHAR(20) NOT NULL,            -- tool | oven_tray | coating_batch
    status VARCHAR(20) NOT NULL DEFAULT 'open',  -- open | closed | consumed
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    closed_at DATETIME NULL,
    consumed_at DATETIME NULL,
    operator_id VARCHAR(50) NULL,
    notes VARCHAR(500) NULL
);

-- Jobs written once at scan station, tool level only
CREATE TABLE container_jobs (
    id INT PRIMARY KEY AUTO_INCREMENT,
    container_id VARCHAR(50) NOT NULL REFERENCES containers(id),
    job_number VARCHAR(50) NOT NULL,
    eye_side CHAR(1) NOT NULL,            -- L or R
    ocr_confidence FLOAT NULL,            -- null if manually entered
    entry_method VARCHAR(10) NOT NULL DEFAULT 'ocr',  -- ocr | manual
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_job_eye (container_id, job_number, eye_side)
);

-- Parent/child container relationships
CREATE TABLE container_contents (
    id INT PRIMARY KEY AUTO_INCREMENT,
    parent_id VARCHAR(50) NOT NULL REFERENCES containers(id),
    child_id VARCHAR(50) NOT NULL REFERENCES containers(id),
    loaded_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_parent_child (parent_id, child_id)
);

-- Indexes
CREATE INDEX idx_container_jobs_container ON container_jobs(container_id);
CREATE INDEX idx_container_jobs_job ON container_jobs(job_number);
CREATE INDEX idx_container_contents_parent ON container_contents(parent_id);
CREATE INDEX idx_container_contents_child ON container_contents(child_id);
CREATE INDEX idx_containers_type_status ON containers(type, status);
```

---

## Backend — FastAPI Router

Create file: `routers/containers.py`

Add to main app: `app.include_router(containers.router, prefix="/api/containers", tags=["containers"])`

### Manifest Query Function

This is the core of the system. Implement this first. Everything else depends on it.

```python
def get_manifest(container_id: str, db: Session) -> list[dict]:
    """
    Walk the container hierarchy tree and return all jobs.
    Works for any container type at any depth.
    """
    container = db.query(Container).filter(Container.id == container_id).first()
    if not container:
        raise HTTPException(404, f"Container {container_id} not found")

    if container.type == "tool":
        # Base case: jobs live here directly
        jobs = db.query(ContainerJob).filter(
            ContainerJob.container_id == container_id
        ).all()
        return [{"job_number": j.job_number, "eye_side": j.eye_side,
                 "source_tool": container_id, "entry_method": j.entry_method,
                 "created_at": j.created_at} for j in jobs]

    else:
        # Recursive case: get children and collect their manifests
        children = db.query(ContainerContents).filter(
            ContainerContents.parent_id == container_id
        ).all()
        all_jobs = []
        for child in children:
            all_jobs.extend(get_manifest(child.child_id, db))
        return all_jobs
```

### Endpoints to Implement

#### GET /api/containers/{container_id}/manifest
Returns full job manifest for any container at any level.

Response:
```json
{
  "container_id": "BATCH-041",
  "container_type": "coating_batch",
  "status": "open",
  "job_count": 34,
  "jobs": [
    {
      "job_number": "JOB-48291",
      "eye_side": "L",
      "source_tool": "TOOL-006",
      "entry_method": "ocr",
      "created_at": "2026-03-17T08:42:00"
    }
  ]
}
```

#### GET /api/containers/{container_id}/location
For a given job number, returns where it currently is in the coating pipeline. Used by re-tray lookup and Coating Agent.

Query param: `?job_number=JOB-48291`

Response:
```json
{
  "job_number": "JOB-48291",
  "eye_side": "L",
  "current_container": "BATCH-041",
  "container_type": "coating_batch",
  "status": "open",
  "source_tool": "TOOL-006",
  "lineage": ["TOOL-006", "TRAY-003", "BATCH-041"]
}
```

#### POST /api/containers/tool-session/open
Creates a new tool container and opens a session.

Request:
```json
{
  "tool_id": "TOOL-006",
  "operator_id": "javier"
}
```

Validation: check no active open session already exists for this tool_id. If one exists, return 409 with the existing session details.

#### POST /api/containers/tool-session/add-job
Adds a job to an open tool session. Called once per lens at scan station.

Request:
```json
{
  "tool_id": "TOOL-006",
  "job_number": "JOB-48291",
  "eye_side": "L",
  "ocr_confidence": 0.94,
  "entry_method": "ocr"
}
```

Validation:
- Tool session must be open status
- Reject duplicate job_number + eye_side combination on this tool
- eye_side must be L or R

#### POST /api/containers/tool-session/close
Closes a tool session. Tool is ready to load into oven.

Request:
```json
{
  "tool_id": "TOOL-006"
}
```

Sets status to `closed`, stamps `closed_at`.

#### POST /api/containers/transfer/tool-to-tray
Loads one or more tools into an oven tray. Creates the tray container if it doesn't exist.

Request:
```json
{
  "tray_id": "TRAY-003",
  "tool_ids": ["TOOL-006", "TOOL-007"],
  "operator_id": "alex"
}
```

Logic:
- Create tray container if not exists (status: open)
- For each tool_id: verify status is `closed`, insert row into container_contents (parent=tray, child=tool), mark tool status as `consumed`
- Partial loads supported — tool_ids can be a subset of what will eventually go into the tray

Validation: all tool_ids must be status `closed`. Reject any that are `open` or already `consumed`.

#### POST /api/containers/transfer/tray-to-batch
Loads one or more oven trays into a coating batch. Creates the batch container if it doesn't exist.

Request:
```json
{
  "batch_id": "BATCH-041",
  "machine_id": "MACHINE-1",
  "tray_ids": ["TRAY-003", "TRAY-004"],
  "operator_id": "jose"
}
```

Logic:
- Create batch container if not exists, store machine_id in notes field
- For each tray_id: verify status is `closed`, insert into container_contents (parent=batch, child=tray), mark tray as `consumed`

#### POST /api/containers/tray/close
Closes an oven tray — ready to load into batch.

Request: `{ "tray_id": "TRAY-003" }`

#### GET /api/containers/active
Returns all currently active containers grouped by type. Used by Coating Agent dashboard.

Response:
```json
{
  "tools": [
    { "id": "TOOL-006", "status": "open", "job_count": 8, "operator": "javier", "opened_at": "..." }
  ],
  "oven_trays": [
    { "id": "TRAY-003", "status": "closed", "job_count": 14, "tools": ["TOOL-006", "TOOL-007"] }
  ],
  "coating_batches": [
    { "id": "BATCH-041", "status": "open", "job_count": 34, "machine": "MACHINE-1" }
  ]
}
```

---

## Frontend — React Screens

Add these screens to the existing Coating Agent in Lab Assistant. Use the existing component patterns, styling, and API client already in the project. Do not introduce new UI libraries.

### Screen 1: Scan Station

Route: `/coating/scan-station`

This is the operator-facing screen at the physical de-tray station. Optimized for tablet use. Large touch targets.

**State machine:**

```
NO_SESSION → [scan tool QR] → SESSION_OPEN → [scan lens] → CONFIRM_JOB → SESSION_OPEN
SESSION_OPEN → [close session] → NO_SESSION
```

**UI elements:**

Tool session status bar at top — shows current tool ID, job count on this tool, session open/closed indicator

Scan tool QR button — opens tool session via POST /tool-session/open. Display tool ID prominently once open.

Camera view — live feed from fixed USB camera. Capture button triggers OCR call. Show confidence score on result.

Job confirm card — shows detected job number, eye side, confidence. Green if confidence above threshold (set as config value, start at 0.85). Yellow if below threshold with manual override input visible. Red and block if eye_side is ambiguous.

Manual override — text input for job number and L/R selector. Visible when OCR confidence is low or operator taps "Override."

Running manifest list — scrollable list of jobs confirmed on current tool. Shows job number, L/R, entry method (ocr/manual), timestamp. Most recent at top.

Close session button — confirms job count before closing. Shows "Close session — 12 jobs on TOOL-006?" confirmation before posting.

**OCR integration:**

The LensScanner component already exists in the codebase. Find it and extend it:
- Add USB camera input mode (not mobile camera)
- Return both job_number and eye_side parsed from the mark
- Return confidence score
- Keep mobile mode intact — do not break existing usage

**Error handling:**
- Tool already has open session: show existing session details, ask operator to confirm they want to resume it
- Duplicate job on tool: warn operator, do not write duplicate
- Network error on write: show error prominently, do not advance manifest display until write confirms

---

### Screen 2: Container Transfer

Route: `/coating/transfers`

Used by operators to move containers up the hierarchy. Three sections on one screen.

**Section A — Load Tools into Tray**

QR scan input for tray ID (or type-in). QR scan input for tool IDs — can scan multiple. Shows running list of tools added. Shows computed job count for the tray so far. "Close Tray" button when loading complete.

**Section B — Load Trays into Batch**

QR scan input for batch ID / machine selection dropdown. QR scan input for tray IDs — can scan multiple. Shows trays added and total job count. "Open Batch" button to confirm.

**Section C — Active Containers Status**

Live list from GET /api/containers/active. Shows all open tools, closed trays waiting for oven, open batches on machines. Color coded: open=blue, closed=amber, consumed=grey. Tapping any container shows its full manifest in a slide-out panel.

---

### Screen 3: Re-Tray Lookup

Route: `/coating/retray`

Simple single-purpose screen for re-tray operators. Camera view, scan lens, get result.

Scan lens → OCR reads job number → call GET /containers/{id}/location?job_number=X → display:

```
JOB-48291 — LEFT
Bin: BIN-047
Zone: Rack C, Shelf 2
```

Large text, high contrast. One action per scan. No other UI clutter.

If job not found in container system: display "Job not in coating system — check DVI" in amber.

---

### Screen 4: Coating Agent Dashboard Addition

The existing Coating Agent dashboard should gain a new "Pipeline" tab or section showing the container hierarchy in real time.

Display format: three columns — Tools | Oven Trays | Batches. Each column shows active containers with job counts and timestamps. Clicking any container shows its manifest.

This gives the Coating Agent and supervisors full live visibility into where every job is in the coating pipeline without any additional operator action.

---

## Coating Agent Intelligence Integration

The existing Coating Agent reasoning and batch recommendation logic does not change. You are adding new data it can query, not changing how it thinks.

After implementing the container system, expose two things to the Coating Agent's context:

**1. Container status summary** — include in the agent's system prompt refresh (however the existing agents receive their context updates): current count of jobs on open tools, jobs in oven, jobs in active batches. Keep it brief — just counts and timestamps.

**2. Location query tool** — add to the Coating Agent's MCP tool list:

```python
@tool
def get_job_coating_location(job_number: str) -> dict:
    """Returns current location of a job in the coating pipeline.
    Returns container ID, type, status, and estimated availability if in oven."""
    # call GET /api/containers/active location endpoint
```

Do not change any existing Coating Agent tools, prompts, or logic. Add only.

---

## Configuration

Add to Lab Assistant config / environment:

```
OCR_CONFIDENCE_THRESHOLD=0.85      # Below this, prompt manual override
CONTAINER_ID_PREFIX_TOOL=TOOL-     # Prefix for tool QR codes
CONTAINER_ID_PREFIX_TRAY=TRAY-     # Prefix for oven tray QR codes
CONTAINER_ID_PREFIX_BATCH=BATCH-   # Prefix for coating batch IDs
```

---

## Implementation Order

Do these in order. Each step is testable before moving to the next.

1. Run database migrations — verify three tables created with correct schema
2. Implement SQLAlchemy models for all three tables
3. Implement `get_manifest()` function — write unit tests for tool, tray, and batch levels
4. Implement all backend endpoints — test with curl or Postman before touching frontend
5. Implement Scan Station screen — test OCR integration with LensScanner component
6. Implement Container Transfer screen
7. Implement Re-Tray Lookup screen
8. Add Pipeline tab to existing Coating Agent dashboard
9. Add location query tool to Coating Agent MCP tool list
10. End-to-end test: open tool session → add jobs → close → transfer to tray → transfer to batch → verify manifest at batch level matches all jobs entered at scan station

---

## What Not to Touch

- DVI integration — read only, no changes
- Existing Coating Agent prompts or batch recommendation logic
- Other department agents (Picking, Surfacing, Cutting, Assembly, Maintenance, Shift Report, Print, EWS)
- Existing LensScanner mobile camera mode
- Any existing database tables
- NetworkAgent NOC dashboard
- Early Warning System anomaly detection

---

## Key Constraints and Edge Cases to Handle

**Partial tool splits** — a tool's jobs may be split across two oven trays. The transfer endpoint accepts a `job_subset` array. If provided, only those jobs are associated with this tray load. The remaining jobs stay on the tool in `container_jobs` — they are not removed, just not yet transferred. Build this even if it seems unlikely — manifest drift from unhandled splits is very hard to debug after the fact.

**Duplicate job protection** — the same job number + eye_side cannot appear on two open tools. If an operator scans a job that already exists on another active tool, block it and show which tool it's already on.

**Orphaned containers** — if a tool session is opened but never closed, it will never transfer. Add a background check or dashboard warning for tool sessions open longer than N hours (make N configurable).

**OCR failure rate tracking** — log every OCR attempt with confidence score and whether it required manual override. Surface this as a metric on the Coating Agent dashboard. High manual override rate signals lighting needs adjustment at the scan station.

**Container ID format** — QR codes on physical tools are already formatted as TOOL-NNN. Tray and batch IDs should follow the same pattern. The system should accept any string as a container ID — do not hardcode format validation beyond the prefix check.
