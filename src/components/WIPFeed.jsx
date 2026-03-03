import { useState, useCallback, useMemo } from "react";

// ─── Palette & shared styles ──────────────────────────────────────────────────
const C = {
  bg:       "#0a0c0f",
  panel:    "#111418",
  border:   "#1e2530",
  borderHi: "#2e3d52",
  amber:    "#f5a623",
  amberDim: "#7a5312",
  green:    "#22c55e",
  red:      "#ef4444",
  blue:     "#3b82f6",
  muted:    "#4a5568",
  text:     "#c9d1d9",
  textDim:  "#6b7280",
  heading:  "#e2e8f0",
};

const mono = { fontFamily: "'JetBrains Mono', 'Fira Code', 'Courier New', monospace" };

// ─── XML Parser ───────────────────────────────────────────────────────────────
export function parseWIP(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  const root = doc.documentElement;

  const meta = {
    lab:       root.getAttribute("Lab"),
    cycleDate: root.getAttribute("CycleDate"),
    version:   root.getAttribute("Version"),
  };

  const jobs = [];

  for (const order of doc.querySelectorAll("RxOrder")) {
    const od    = order.querySelector("OrderData");
    const re    = order.querySelector("RightEye");
    const le    = order.querySelector("LeftEye");
    const frame = order.querySelector("Frame");
    const waits = [...order.querySelectorAll("Wait")];
    const bk    = order.querySelector("Breakage");
    const bkItems = bk ? [...bk.querySelectorAll("BreakageItem")] : [];

    const coatR = re?.querySelector("Coat")?.textContent || "";
    const coatL = le?.querySelector("Coat")?.textContent || "";

    // Breakage summary
    let breakageCount = 0;
    if (bk) {
      const nums = ["OfficeBreakageRight","OfficeBreakageLeft","SurfaceBreakageRight",
                    "SurfaceBreakageLeft","FinishBreakageRight","FinishBreakageLeft","FrameBreakage"];
      nums.forEach(k => { breakageCount += parseInt(bk.getAttribute(k) || "0"); });
    }

    jobs.push({
      uid:          order.getAttribute("uid"),
      department:   order.getAttribute("Department"),
      daysInLab:    parseInt(order.getAttribute("DaysInLab") || "0"),
      invoice:      od?.getAttribute("Invoice"),
      tray:         od?.getAttribute("Tray"),
      reference:    od?.getAttribute("Reference"),
      rxNumber:     od?.getAttribute("RxNumber"),
      entryDate:    od?.getAttribute("EntryDate"),
      entryTime:    od?.getAttribute("EntryTime"),
      shipDate:     od?.getAttribute("ShipDate"),
      shipTime:     od?.getAttribute("ShipTime"),
      jobOrigin:    od?.getAttribute("JobOrigin"),
      originalInvoice: od?.getAttribute("OriginalInvoice") || null,
      operator:     od?.getAttribute("Operator"),

      matR:   re?.getAttribute("Material"),
      matL:   le?.getAttribute("Material"),
      styleR: re?.getAttribute("Style"),
      pickR:  re?.getAttribute("Pick"),
      pickL:  le?.getAttribute("Pick"),
      typeR:  re?.getAttribute("Type"),
      coatR,  coatL,

      frameName:  frame?.getAttribute("Name"),
      frameColor: frame?.getAttribute("Color"),

      inCoatingQueue: waits.length > 0,
      coatingWaitDays: waits.reduce((s, w) => s + parseInt(w.getAttribute("Days") || "0"), 0),

      hasBreakage:   breakageCount > 0,
      breakageCount,
      breakageItems: bkItems.map(b => ({
        date:       b.getAttribute("Date"),
        time:       b.getAttribute("Time"),
        dept:       b.getAttribute("Department"),
        position:   b.getAttribute("Position"),
        reason:     b.getAttribute("Reason"),
        part:       b.getAttribute("Part"),
        material:   b.getAttribute("LensMaterial"),
        semifinished: b.getAttribute("Semifinished"),
        inspector:  b.getAttribute("Inspector"),
      })),
    });
  }

  return { meta, jobs };
}

// ─── Subcomponents ────────────────────────────────────────────────────────────
function StatCard({ label, value, color = C.amber, sub }) {
  return (
    <div style={{
      background: C.panel, border: `1px solid ${C.border}`,
      borderTop: `2px solid ${color}`,
      padding: "16px 20px", borderRadius: 4, minWidth: 130,
    }}>
      <div style={{ color: C.textDim, fontSize: 10, letterSpacing: "0.12em",
                    textTransform: "uppercase", ...mono }}>{label}</div>
      <div style={{ color, fontSize: 28, fontWeight: 700, lineHeight: 1.2,
                    marginTop: 6, ...mono }}>{value}</div>
      {sub && <div style={{ color: C.muted, fontSize: 11, marginTop: 4, ...mono }}>{sub}</div>}
    </div>
  );
}

function Badge({ label, color = C.muted, bg }) {
  return (
    <span style={{
      background: bg || color + "22",
      color,
      border: `1px solid ${color}44`,
      borderRadius: 3,
      padding: "1px 6px",
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: "0.08em",
      ...mono,
    }}>{label}</span>
  );
}

const DEPT_COLOR = { POLY: C.amber, HIRES: C.blue, PLASTIC: C.green };
const PICK_LABEL = { S: "STOCK", F: "FINISH", N: "NONE", C: "CUT" };

function JobTable({ jobs }) {
  const [sort, setSort] = useState({ key: "entryDate", dir: 1 });
  const [filter, setFilter] = useState("");

  const sorted = useMemo(() => {
    let rows = jobs;
    if (filter) {
      const f = filter.toLowerCase();
      rows = rows.filter(j =>
        (j.invoice || "").includes(f) ||
        (j.frameName || "").toLowerCase().includes(f) ||
        (j.rxNumber || "").toLowerCase().includes(f) ||
        (j.matR || "").toLowerCase().includes(f) ||
        (j.department || "").toLowerCase().includes(f)
      );
    }
    return [...rows].sort((a, b) => {
      let av = a[sort.key], bv = b[sort.key];
      if (sort.key === "daysInLab") { av = +av; bv = +bv; }
      if (sort.key === "entryDate") {
        av = new Date(av); bv = new Date(bv);
      }
      if (av < bv) return -sort.dir;
      if (av > bv) return sort.dir;
      return 0;
    });
  }, [jobs, sort, filter]);

  const th = (label, key, width) => (
    <th
      onClick={() => setSort(s => ({ key, dir: s.key === key ? -s.dir : 1 }))}
      style={{
        ...mono, fontSize: 10, fontWeight: 600, color: sort.key === key ? C.amber : C.muted,
        textTransform: "uppercase", letterSpacing: "0.1em",
        padding: "8px 12px", textAlign: "left", cursor: "pointer",
        borderBottom: `1px solid ${C.border}`, width,
        whiteSpace: "nowrap", userSelect: "none",
      }}
    >
      {label} {sort.key === key ? (sort.dir === 1 ? "▲" : "▼") : ""}
    </th>
  );

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <input
          placeholder="Filter by invoice, frame, Rx, material, dept..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          style={{
            background: C.panel, border: `1px solid ${C.borderHi}`,
            color: C.text, borderRadius: 4, padding: "7px 12px",
            width: "100%", fontSize: 12, outline: "none", ...mono,
          }}
        />
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {th("Invoice", "invoice", 80)}
              {th("Entry Date", "entryDate", 90)}
              {th("Days", "daysInLab", 55)}
              {th("Dept", "department", 75)}
              {th("Material", "matR", 80)}
              {th("Style", "styleR", 120)}
              {th("Frame", "frameName", 130)}
              {th("Pick", "pickR", 65)}
              <th style={{ ...mono, fontSize: 10, color: C.muted, padding: "8px 12px",
                           borderBottom: `1px solid ${C.border}`, textAlign: "left",
                           textTransform: "uppercase", letterSpacing: "0.1em" }}>Flags</th>
              {th("Ship Date", "shipDate", 90)}
            </tr>
          </thead>
          <tbody>
            {sorted.map((j, i) => (
              <tr key={j.uid} style={{
                background: i % 2 === 0 ? "transparent" : "#0d1117",
                borderBottom: `1px solid ${C.border}22`,
              }}>
                <td style={{ ...mono, color: C.amber, padding: "7px 12px", fontSize: 11 }}>{j.invoice}</td>
                <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{j.entryDate}</td>
                <td style={{ ...mono, padding: "7px 12px" }}>
                  <span style={{
                    color: j.daysInLab >= 10 ? C.red : j.daysInLab >= 5 ? C.amber : C.green,
                    fontWeight: 700, fontSize: 13,
                  }}>{j.daysInLab}</span>
                </td>
                <td style={{ padding: "7px 12px" }}>
                  <Badge label={j.department} color={DEPT_COLOR[j.department] || C.muted} />
                </td>
                <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{j.matR}{j.matL && j.matL !== j.matR ? `/${j.matL}` : ""}</td>
                <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 10 }}>{j.styleR}</td>
                <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{j.frameName}</td>
                <td style={{ padding: "7px 12px" }}>
                  <Badge
                    label={PICK_LABEL[j.pickR] || j.pickR}
                    color={j.pickR === "S" ? C.green : j.pickR === "F" ? C.blue : C.muted}
                  />
                </td>
                <td style={{ padding: "7px 12px", display: "flex", gap: 4, flexWrap: "wrap", alignItems: "center" }}>
                  {j.originalInvoice && <Badge label="REMAKE" color={C.amber} />}
                  {j.hasBreakage && <Badge label={`BRK×${j.breakageCount}`} color={C.red} />}
                  {j.inCoatingQueue && <Badge label="COAT" color={C.blue} />}
                </td>
                <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 11 }}>{j.shipDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <div style={{ color: C.muted, textAlign: "center", padding: 32, ...mono, fontSize: 12 }}>
            No jobs match filter.
          </div>
        )}
      </div>
    </div>
  );
}

function BreakageTable({ jobs }) {
  const rows = useMemo(() => {
    const out = [];
    jobs.forEach(j => {
      j.breakageItems.forEach(b => out.push({ ...b, invoice: j.invoice, frameName: j.frameName, department: j.department }));
    });
    return out.sort((a, b) => (a.date + a.time < b.date + b.time ? 1 : -1));
  }, [jobs]);

  const DEPT_MAP = {
    S: "SURFACE", O: "OFFICE", E: "EDGE", C: "COAT", "R&D": "R&D"
  };
  const REASON_MAP = {
    "03": "SCRATCH", "04": "CHIP", "08": "POWER", "18": "COSMETIC", "NF": "NOT FOUND"
  };

  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {["Date","Time","Invoice","Frame","Dept","Position","Reason","Part","Material","Inspector"].map(h => (
              <th key={h} style={{
                ...mono, fontSize: 10, fontWeight: 600, color: C.muted,
                textTransform: "uppercase", letterSpacing: "0.1em",
                padding: "8px 12px", textAlign: "left", borderBottom: `1px solid ${C.border}`,
                whiteSpace: "nowrap",
              }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} style={{ background: i % 2 === 0 ? "transparent" : "#0d1117", borderBottom: `1px solid ${C.border}22` }}>
              <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{r.date}</td>
              <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 11 }}>{r.time}</td>
              <td style={{ ...mono, color: C.amber, padding: "7px 12px", fontSize: 11 }}>{r.invoice}</td>
              <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{r.frameName}</td>
              <td style={{ padding: "7px 12px" }}>
                <Badge label={DEPT_MAP[r.dept] || r.dept || "—"} color={DEPT_COLOR[r.dept] || C.muted} />
              </td>
              <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 11 }}>{r.position || "—"}</td>
              <td style={{ padding: "7px 12px" }}>
                <Badge label={REASON_MAP[r.reason] || r.reason || "—"} color={C.red} />
              </td>
              <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>
                {r.part === "R" ? "RIGHT" : r.part === "L" ? "LEFT" : r.part || "—"}
              </td>
              <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{r.material || "—"}</td>
              <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 11 }}>{r.inspector || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CoatingQueue({ jobs }) {
  const queued = jobs.filter(j => j.inCoatingQueue)
    .sort((a, b) => b.coatingWaitDays - a.coatingWaitDays);

  return (
    <div>
      <div style={{ color: C.textDim, ...mono, fontSize: 11, marginBottom: 16 }}>
        {queued.length} jobs currently staged at COATING
      </div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
          <thead>
            <tr>
              {["Invoice","Frame","Dept","Material","Style","Wait Days","Entry Date","Ship Date"].map(h => (
                <th key={h} style={{
                  ...mono, fontSize: 10, color: C.muted, textTransform: "uppercase",
                  letterSpacing: "0.1em", padding: "8px 12px", textAlign: "left",
                  borderBottom: `1px solid ${C.border}`,
                }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {queued.map((j, i) => (
              <tr key={j.uid} style={{ background: i % 2 === 0 ? "transparent" : "#0d1117", borderBottom: `1px solid ${C.border}22` }}>
                <td style={{ ...mono, color: C.amber, padding: "7px 12px", fontSize: 11 }}>{j.invoice}</td>
                <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{j.frameName}</td>
                <td style={{ padding: "7px 12px" }}>
                  <Badge label={j.department} color={DEPT_COLOR[j.department] || C.muted} />
                </td>
                <td style={{ ...mono, color: C.text, padding: "7px 12px", fontSize: 11 }}>{j.matR}</td>
                <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 10 }}>{j.styleR}</td>
                <td style={{ ...mono, padding: "7px 12px" }}>
                  <span style={{ color: j.coatingWaitDays >= 2 ? C.red : j.coatingWaitDays === 1 ? C.amber : C.green, fontWeight: 700 }}>
                    {j.coatingWaitDays}d
                  </span>
                </td>
                <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 11 }}>{j.entryDate}</td>
                <td style={{ ...mono, color: C.textDim, padding: "7px 12px", fontSize: 11 }}>{j.shipDate}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Main Component ───────────────────────────────────────────────────────────
export default function WIPFeed() {
  const [data, setData] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [tab, setTab] = useState("wip");
  const [error, setError] = useState(null);

  const loadXML = useCallback((text) => {
    try {
      const parsed = parseWIP(text);
      setData(parsed);
      setError(null);
    } catch (e) {
      setError("Failed to parse XML: " + e.message);
    }
  }, []);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDragging(false);
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadXML(ev.target.result);
    reader.readAsText(file);
  }, [loadXML]);

  const onFile = useCallback((e) => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => loadXML(ev.target.result);
    reader.readAsText(file);
  }, [loadXML]);

  // ── Stats derived from data ──
  const stats = useMemo(() => {
    if (!data) return null;
    const { jobs } = data;
    const byDept = {};
    const byMat = {};
    jobs.forEach(j => {
      byDept[j.department] = (byDept[j.department] || 0) + 1;
      byMat[j.matR] = (byMat[j.matR] || 0) + 1;
    });
    return {
      total: jobs.length,
      withBreakage: jobs.filter(j => j.hasBreakage).length,
      totalBreakageItems: jobs.reduce((s, j) => s + j.breakageCount, 0),
      inCoating: jobs.filter(j => j.inCoatingQueue).length,
      remakes: jobs.filter(j => j.originalInvoice).length,
      aged: jobs.filter(j => j.daysInLab >= 5).length,
      byDept, byMat,
    };
  }, [data]);

  const TABS = [
    { id: "wip",      label: "WIP FEED",      count: stats?.total },
    { id: "coating",  label: "COATING QUEUE",  count: stats?.inCoating },
    { id: "breakage", label: "BREAKAGE",       count: stats?.totalBreakageItems },
  ];

  // ── Drop zone ──
  if (!data) {
    return (
      <div style={{ background: C.bg, minHeight: "100vh", display: "flex",
                    alignItems: "center", justifyContent: "center", padding: 40 }}>
        <div style={{ textAlign: "center", maxWidth: 480 }}>
          <div style={{ ...mono, color: C.amber, fontSize: 11, letterSpacing: "0.25em",
                        textTransform: "uppercase", marginBottom: 16 }}>
            LAB_ASSISTANT · WIP FEED
          </div>
          <div style={{ color: C.heading, fontSize: 28, fontWeight: 700, marginBottom: 8,
                        fontFamily: "'Georgia', serif", letterSpacing: "-0.02em" }}>
            Load Daily XML
          </div>
          <div style={{ color: C.textDim, fontSize: 13, marginBottom: 40, lineHeight: 1.6 }}>
            Drop the PAIRRX.XML file from DVI VISION to parse WIP, breakage, and coating queue.
          </div>

          <div
            onDrop={onDrop}
            onDragOver={e => { e.preventDefault(); setDragging(true); }}
            onDragLeave={() => setDragging(false)}
            style={{
              border: `2px dashed ${dragging ? C.amber : C.borderHi}`,
              borderRadius: 8,
              padding: "48px 32px",
              background: dragging ? C.amber + "08" : C.panel,
              transition: "all 0.2s",
              cursor: "pointer",
            }}
            onClick={() => document.getElementById("xmlinput").click()}
          >
            <div style={{ fontSize: 40, marginBottom: 16 }}>📂</div>
            <div style={{ ...mono, color: dragging ? C.amber : C.text, fontSize: 13 }}>
              {dragging ? "Drop to load..." : "Drag & drop PAIRRX.XML here"}
            </div>
            <div style={{ ...mono, color: C.muted, fontSize: 11, marginTop: 8 }}>
              or click to browse
            </div>
            <input id="xmlinput" type="file" accept=".xml" style={{ display: "none" }} onChange={onFile} />
          </div>

          {error && (
            <div style={{ ...mono, color: C.red, fontSize: 12, marginTop: 20, padding: 16,
                          background: C.red + "11", border: `1px solid ${C.red}44`, borderRadius: 4 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  const { meta, jobs } = data;

  return (
    <div style={{ background: C.bg, minHeight: "100vh", color: C.text, ...mono }}>
      {/* Header */}
      <div style={{
        background: C.panel, borderBottom: `1px solid ${C.border}`,
        padding: "12px 24px", display: "flex", alignItems: "center",
        justifyContent: "space-between", position: "sticky", top: 0, zIndex: 10,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 20 }}>
          <div>
            <span style={{ color: C.amber, fontWeight: 700, fontSize: 13, letterSpacing: "0.1em" }}>
              LAB_ASSISTANT
            </span>
            <span style={{ color: C.muted, fontSize: 11, marginLeft: 8 }}>WIP FEED</span>
          </div>
          <div style={{ width: 1, height: 24, background: C.border }} />
          <div style={{ color: C.textDim, fontSize: 11 }}>
            {meta.lab} · CYCLE {meta.cycleDate}
          </div>
        </div>
        <button
          onClick={() => { setData(null); setTab("wip"); }}
          style={{
            background: "transparent", border: `1px solid ${C.border}`,
            color: C.muted, borderRadius: 4, padding: "5px 12px",
            cursor: "pointer", fontSize: 11, ...mono,
          }}
        >
          ↑ LOAD NEW FILE
        </button>
      </div>

      {/* Stat cards */}
      <div style={{ padding: "20px 24px", display: "flex", gap: 12, flexWrap: "wrap" }}>
        <StatCard label="Total Jobs" value={stats.total} color={C.amber} />
        <StatCard label="Coating Queue" value={stats.inCoating} color={C.blue} sub={`${Math.round(stats.inCoating/stats.total*100)}% of WIP`} />
        <StatCard label="Remakes" value={stats.remakes} color={C.amber} sub="w/ OriginalInvoice" />
        <StatCard label="Jobs w/ Breakage" value={stats.withBreakage} color={C.red} sub={`${stats.totalBreakageItems} total events`} />
        <StatCard label="Aged ≥5 Days" value={stats.aged} color={stats.aged > 20 ? C.red : C.amber} />
        <div style={{ flex: 1, minWidth: 200, background: C.panel, border: `1px solid ${C.border}`,
                      borderTop: `2px solid ${C.border}`, padding: "16px 20px", borderRadius: 4 }}>
          <div style={{ color: C.textDim, fontSize: 10, letterSpacing: "0.12em",
                        textTransform: "uppercase", marginBottom: 10 }}>BY DEPT</div>
          {Object.entries(stats.byDept).map(([d, n]) => (
            <div key={d} style={{ display: "flex", justifyContent: "space-between",
                                  marginBottom: 6, alignItems: "center" }}>
              <Badge label={d} color={DEPT_COLOR[d] || C.muted} />
              <span style={{ color: C.text, fontSize: 13, fontWeight: 700 }}>{n}</span>
            </div>
          ))}
        </div>
        <div style={{ flex: 1, minWidth: 200, background: C.panel, border: `1px solid ${C.border}`,
                      borderTop: `2px solid ${C.border}`, padding: "16px 20px", borderRadius: 4 }}>
          <div style={{ color: C.textDim, fontSize: 10, letterSpacing: "0.12em",
                        textTransform: "uppercase", marginBottom: 10 }}>BY MATERIAL</div>
          {Object.entries(stats.byMat).sort((a,b) => b[1]-a[1]).map(([m, n]) => (
            <div key={m} style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
              <span style={{ color: C.textDim, fontSize: 11 }}>{m}</span>
              <span style={{ color: C.text, fontSize: 11, fontWeight: 700 }}>{n}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Tabs */}
      <div style={{ borderBottom: `1px solid ${C.border}`, padding: "0 24px",
                    display: "flex", gap: 0 }}>
        {TABS.map(t => (
          <button key={t.id} onClick={() => setTab(t.id)} style={{
            background: "transparent",
            border: "none",
            borderBottom: `2px solid ${tab === t.id ? C.amber : "transparent"}`,
            color: tab === t.id ? C.amber : C.muted,
            padding: "10px 20px",
            cursor: "pointer",
            fontSize: 11,
            letterSpacing: "0.1em",
            ...mono,
            marginBottom: -1,
            transition: "color 0.15s",
          }}>
            {t.label}
            {t.count != null && (
              <span style={{
                marginLeft: 8, background: tab === t.id ? C.amber + "22" : C.border,
                color: tab === t.id ? C.amber : C.textDim,
                borderRadius: 10, padding: "1px 7px", fontSize: 10,
              }}>{t.count}</span>
            )}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div style={{ padding: "20px 24px" }}>
        {tab === "wip"      && <JobTable jobs={jobs} />}
        {tab === "breakage" && <BreakageTable jobs={jobs} />}
        {tab === "coating"  && <CoatingQueue jobs={jobs} />}
      </div>
    </div>
  );
}
