# Lab Assistant — Claude Code Agent Files

Five domain-expert CLAUDE.md files for building Lab Assistant v2 in Claude Code.
Each file gives Claude Code deep context in a specific domain so you don't have to
re-explain the stack, the lab, or the manufacturing context every session.

---

## Files

| File | Domain | Use When |
|------|--------|----------|
| `CLAUDE_ARCHITECT.md` | Full stack, system coherence | Starting a new session, cross-module work, any time you need Claude Code to understand the whole system |
| `CLAUDE_VISION.md` | OCR, Data Matrix, camera, lens marking | Working on LensScanner, barcode decode, reunification workflow, vision pipeline |
| `CLAUDE_MANUFACTURING.md` | Yield, OEE, throughput, department flows | Building metrics, shift reports, EWS triggers, any manufacturing KPI feature |
| `CLAUDE_AUTOMATION.md` | Kardex, PLCs, BLE trays, equipment APIs | Integrating equipment, writing adapters, BLE zone tracking, OPC-UA |
| `CLAUDE_DATA.md` | SQL, DVI, demand sensing, ETL, EWS data layer | Writing queries, demand model work, ETL, safety stock, data quality |

---

## How to Use in Claude Code

### Option 1 — Drop in project root (simplest)
Copy the relevant CLAUDE.md file(s) into the root of your Lab Assistant project directory.
Claude Code will automatically read `CLAUDE.md` on session start.

If using multiple agents in one session, concatenate the relevant files:
```bash
cat CLAUDE_ARCHITECT.md CLAUDE_DATA.md > CLAUDE.md
```

### Option 2 — Subdirectory CLAUDE.md files
Place each file in the relevant subdirectory so Claude Code picks up context
automatically when working in that directory:

```
/lab-assistant
  CLAUDE.md                  ← CLAUDE_ARCHITECT.md (always present at root)
  /src
    /components
      CLAUDE.md              ← CLAUDE_ARCHITECT.md (frontend context)
  /agents
    CLAUDE.md                ← CLAUDE_MANUFACTURING.md + CLAUDE_DATA.md
  /server
    CLAUDE.md                ← CLAUDE_AUTOMATION.md + CLAUDE_DATA.md
  /vision
    CLAUDE.md                ← CLAUDE_VISION.md
```

### Option 3 — Reference at session start
Paste the content of the relevant file(s) at the start of your Claude Code session
as system context before describing your task.

---

## Recommended Combinations by Task

| Task | Use These Files |
|------|----------------|
| New feature (any department) | Architect + Manufacturing |
| DVI integration / SQL queries | Architect + Data |
| Assembly Dashboard | Architect + Manufacturing + Data |
| LensScanner / vision work | Architect + Vision |
| Kardex / ItemPath adapter | Architect + Automation + Data |
| EWS new trigger | Architect + Manufacturing + Data |
| Demand Sensing module | Data + Manufacturing |
| BLE tray tracking | Automation |
| Shift Report agent | Manufacturing + Data |
| Nightly ETL | Data |
| Network / NOC dashboard | Architect |

---

## Notes
- Architect file should almost always be included — it has the stack, conventions, env vars
- Manufacturing and Data files pair well for any agent that surfaces metrics to users
- Vision file is standalone — only needed for optical/scan work
- Automation file is standalone — only needed for equipment integration work
- These files are handoff artifacts — keep them updated as the system evolves
