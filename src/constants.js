// ── Theme colors ─────────────────────────────────────────────────────────────
export const T = {
  bg: "#080C18", surface: "#0F1629", card: "#141B2D", cardHover: "#1A2340",
  border: "#1E293B", borderLight: "#334155",
  text: "#F1F5F9", textMuted: "#94A3B8", textDim: "#475569",
  blue: "#3B82F6", blueGlow: "#2563EB", blueDark: "#1E3A5F",
  green: "#10B981", greenDark: "#064E3B",
  amber: "#F59E0B", amberDark: "#78350F",
  red: "#EF4444", redDark: "#7F1D1D",
  purple: "#8B5CF6", purpleDark: "#4C1D95",
  pink: "#EC4899", pinkDark: "#831843",
  cyan: "#06B6D4", cyanDark: "#164E63",
  lime: "#84CC16", limeDark: "#365314",
  orange: "#F97316", orangeDark: "#7C2D12",
};

export const TRAY_STATES = {
  IDLE: { label: "Idle", color: "#64748B", bg: "#1E293B" },
  BOUND: { label: "Bound", color: T.blue, bg: T.blueDark },
  ACTIVE: { label: "Active", color: T.green, bg: T.greenDark },
  COATING_STAGED: { label: "Staged", color: T.amber, bg: T.amberDark },
  COATING_IN_PROCESS: { label: "Coating", color: T.red, bg: T.redDark },
  RE_TRAY: { label: "Re-Tray", color: T.purple, bg: T.purpleDark },
  QC_HOLD: { label: "QC Hold", color: T.pink, bg: T.pinkDark },
  BROKEN: { label: "Broken", color: T.orange, bg: T.orangeDark },
  COMPLETE: { label: "Complete", color: T.lime, bg: T.limeDark },
};

export const COATING_TYPES = ["AR", "Blue Cut", "Mirror", "Transitions", "Polarized", "Hard Coat"];
export const MACHINES = ["Satis 1200", "Satis 1200-B", "Opticoat S"];
export const DEFECT_TYPES = ["Crazing", "Pinholes", "Delamination", "Haze", "Scratches", "Color Shift", "Adhesion Fail"];
export const BREAK_TYPES = ["Edge chip", "Surface scratch", "Coating fail", "Edging crack", "Assembly break", "Prescription error"];

export const DEPARTMENTS = {
  PICKING:    { label: "Picking",    color: "#94A3B8", icon: "📦" },
  SURFACING:  { label: "Surfacing",  color: "#3B82F6", icon: "🌀" },
  CUTTING:    { label: "Cutting",    color: "#8B5CF6", icon: "✂️" },
  COATING:    { label: "Coating",    color: "#F59E0B", icon: "🌡" },
  ASSEMBLY:   { label: "Assembly",   color: "#EC4899", icon: "🔧" },
  QC:         { label: "QC",         color: "#F97316", icon: "🔬" },
  SHIPPING:   { label: "Shipping",   color: "#10B981", icon: "📤" },
};

export const COATING_STAGES = {
  QUEUE:     { label: "Queue",      color: "#64748B", desc: "Waiting for batch" },
  DIP:       { label: "Dip",        color: "#06B6D4", desc: "Chemical dip in progress" },
  SCAN_IN:   { label: "LMS Scan",   color: "#3B82F6", desc: "Scanned into coater" },
  OVEN:      { label: "Oven",       color: "#F59E0B", desc: "In oven — OD verified" },
  COATER:    { label: "Coater",     color: "#EF4444", desc: "In coater — OD verified" },
  COOL_DOWN: { label: "Cool Down",  color: "#8B5CF6", desc: "Post-coat cooling" },
  UNLOAD:    { label: "Unload",     color: "#10B981", desc: "Ready for unload" },
};

export const COATING_COLORS = {
  "AR":          { color: "#3B82F6", bg: "#1E3A5F" },
  "Blue Cut":    { color: "#06B6D4", bg: "#164E63" },
  "Mirror":      { color: "#A855F7", bg: "#581C87" },
  "Transitions": { color: "#F97316", bg: "#7C2D12" },
  "Polarized":   { color: "#EC4899", bg: "#831843" },
  "Hard Coat":   { color: "#84CC16", bg: "#365314" },
};

export const BATCH_STATES = { running: "RUNNING", hold: "HOLD", waiting: "WAITING", complete: "COMPLETE", idle: "IDLE", loading: "LOADING" };

// ── Default settings ─────────────────────────────────────────────────────────
export const DEFAULT_SETTINGS = {
  pin: null,
  pinEnabled: false,
  anthropicApiKey: '',
  gatewayUrl: 'http://localhost:3001',
  itempathUrl: '',
  itempathToken: '',
  dviUrl: '',
  dviApiKey: '',
  limbleUrl: '',
  limbleApiKey: '',
  slackBotToken: '',
  slackSigningSecret: '',
  slackAppToken: '',
  databaseUrl: '',
  equipmentCategories: [
    { id: 'coaters', name: 'Coaters', icon: '🌡', color: '#F59E0B' },
    { id: 'ovens', name: 'Ovens', icon: '🔥', color: '#EF4444' },
    { id: 'cutters', name: 'Cutters', icon: '✂️', color: '#8B5CF6' },
    { id: 'polishers', name: 'Polishers', icon: '💿', color: '#06B6D4' },
    { id: 'generators', name: 'Generators', icon: '⚡', color: '#10B981' },
    { id: 'lasers', name: 'Lasers', icon: '📡', color: '#EC4899' },
    { id: 'blockers', name: 'Blockers', icon: '🔲', color: '#3B82F6' },
    { id: 'deblockers', name: 'De-blockers', icon: '🔳', color: '#64748B' },
    { id: 'tapers', name: 'Tapers', icon: '📐', color: '#84CC16' },
  ],
  equipment: [
    { id: 'eq1', categoryId: 'coaters', name: 'Satis 1200', serialNumber: '', location: 'Lab Floor 1' },
    { id: 'eq2', categoryId: 'coaters', name: 'Satis 1200-B', serialNumber: '', location: 'Lab Floor 1' },
    { id: 'eq3', categoryId: 'coaters', name: 'Opticoat S', serialNumber: '', location: 'Lab Floor 2' },
  ],
  serverUrl: 'http://localhost:3002',
  slackWebhook: '',
};

// ── Font stacks ──────────────────────────────────────────────────────────────
export const mono = "'JetBrains Mono','Fira Code',monospace";
export const sans = "'Outfit','DM Sans',system-ui,sans-serif";

// ── Utility functions ────────────────────────────────────────────────────────
export function genJob() { return `J${String(Math.floor(Math.random()*90000)+10000)}`; }
export function genTray() { return `T-${String(Math.floor(Math.random()*900)+100)}`; }
export function pick(a) { return a[Math.floor(Math.random()*a.length)]; }
export function genRx() {
  return { sph: (Math.random()*8-4).toFixed(2), cyl: (Math.random()*-4).toFixed(2), axis: Math.floor(Math.random()*180), add: Math.random()>0.5?(Math.random()*3).toFixed(2):null };
}
