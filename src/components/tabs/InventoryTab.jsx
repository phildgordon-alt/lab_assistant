import { useState, useEffect, useMemo } from 'react';
import { T, mono } from '../../constants';
import { Card, SectionHeader } from '../shared';

// Local component - Pill (simple styled tag)
const Pill = ({ children, color, bg, style }) => (
  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 10px", borderRadius: 5, background: bg || `${color}20`, color, fontFamily: mono, textTransform: "uppercase", whiteSpace: "nowrap", ...style }}>{children}</span>
);

// Local component - ItemImage (handles various image formats)
function ItemImage({ item }) {
  const [imgState, setImgState] = useState('loading');

  let imageUrl = null;
  if (Array.isArray(item.image) && item.image.length > 0) {
    imageUrl = item.image[0]?.link || item.image[0]?.url || item.image[0];
  } else if (typeof item.image === 'string' && item.image) {
    imageUrl = item.image;
  } else if (item.imageUrl) {
    imageUrl = item.imageUrl;
  } else if (item.imageURL) {
    imageUrl = item.imageURL;
  } else if (item.photo) {
    imageUrl = Array.isArray(item.photo) ? (item.photo[0]?.link || item.photo[0]) : item.photo;
  } else if (item.thumbnail) {
    imageUrl = item.thumbnail;
  } else if (item.images && Array.isArray(item.images) && item.images.length > 0) {
    imageUrl = item.images[0]?.link || item.images[0]?.url || item.images[0];
  }

  if (!imageUrl && item.partImages && Array.isArray(item.partImages) && item.partImages.length > 0) {
    imageUrl = item.partImages[0]?.link || item.partImages[0];
  }

  useEffect(() => {
    if (!imageUrl) {
      setImgState('none');
    } else {
      setImgState('loading');
    }
  }, [imageUrl]);

  if (!imageUrl) return null;

  return (
    <div style={{ marginBottom: 20, textAlign: 'center' }}>
      {imgState === 'loading' && (
        <div style={{ padding: 20, background: T.card, borderRadius: 8, border: `1px solid ${T.border}`, color: T.textDim, fontSize: 12 }}>
          Loading image...
        </div>
      )}
      {imgState === 'error' && imageUrl && (
        <div style={{ padding: 16, background: `${T.card}`, borderRadius: 8, border: `1px solid ${T.border}`, textAlign: 'center' }}>
          <div style={{ color: T.textDim, fontSize: 11, marginBottom: 10 }}>Image blocked by browser (CORS)</div>
          <a
            href={imageUrl}
            target="_blank"
            rel="noopener noreferrer"
            style={{
              display: 'inline-block',
              padding: '8px 16px',
              background: T.blue,
              color: '#fff',
              borderRadius: 6,
              textDecoration: 'none',
              fontSize: 12,
              fontWeight: 600
            }}
          >
            View Image in New Tab
          </a>
        </div>
      )}
      <img
        src={imageUrl}
        alt={item.name || item.sku || 'Part image'}
        style={{
          maxWidth: '100%',
          maxHeight: 200,
          borderRadius: 8,
          border: `1px solid ${T.border}`,
          objectFit: 'contain',
          background: T.bg,
          display: imgState === 'loaded' ? 'inline-block' : 'none'
        }}
        onLoad={() => setImgState('loaded')}
        onError={() => setImgState('error')}
      />
    </div>
  );
}

// Local component - InventoryDetailPanel
function InventoryDetailPanel({ item, onClose, title = "Item Details" }) {
  if (!item) return null;

  const identFields = ['sku', 'id', 'name', 'description', 'barcode', 'partNumber'];
  const stockFields = ['qty', 'qtyAvailable', 'qtyReserved', 'reorderPoint', 'minQty', 'maxQty', 'safetyStock'];
  const locationFields = ['location', 'warehouse', 'bin', 'zone', 'aisle', 'shelf', 'vlm', 'carousel'];
  const categoryFields = ['coatingType', 'index', 'material', 'category', 'type', 'class', 'group'];
  const supplierFields = ['supplier', 'vendor', 'leadTime', 'cost', 'price', 'lastPurchase'];
  const physicalFields = ['diameter', 'thickness', 'weight', 'dimensions', 'uom', 'unit'];

  const renderField = (key, value) => {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'boolean') value = value ? 'Yes' : 'No';
    if (typeof value === 'object') value = JSON.stringify(value);
    return (
      <div key={key} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 0', borderBottom: `1px solid ${T.border}22` }}>
        <span style={{ color: T.textDim, fontSize: 11, fontFamily: mono }}>{key}</span>
        <span style={{ color: T.text, fontSize: 12, fontFamily: mono, fontWeight: 600, maxWidth: '60%', textAlign: 'right', wordBreak: 'break-word' }}>{String(value)}</span>
      </div>
    );
  };

  const renderSection = (sectionTitle, fields) => {
    const items = fields.map(f => renderField(f, item[f])).filter(Boolean);
    if (items.length === 0) return null;
    return (
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>{sectionTitle}</div>
        {items}
      </div>
    );
  };

  const isOutOfStock = item.qty === 0;
  const isLowStock = item.qty > 0 && item.qty <= (item.reorderPoint || 10);
  const stockColor = isOutOfStock ? T.red : isLowStock ? T.amber : T.green;
  const stockLabel = isOutOfStock ? 'OUT OF STOCK' : isLowStock ? 'LOW STOCK' : 'IN STOCK';

  return (
    <div style={{ position: 'fixed', top: 0, right: 0, bottom: 0, width: 420, background: T.surface, borderLeft: `1px solid ${T.border}`, zIndex: 1000, display: 'flex', flexDirection: 'column', boxShadow: '-4px 0 24px #00000040' }}>
      {/* Header */}
      <div style={{ padding: '16px 20px', borderBottom: `1px solid ${T.border}`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ flex: 1 }}>
          <div style={{ fontSize: 18, fontWeight: 800, color: T.text }}>{item.sku || item.name || title}</div>
          <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono, marginTop: 2 }}>{item.name?.slice(0, 50) || item.description?.slice(0, 50) || ''}</div>
        </div>
        <button onClick={onClose} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 12px', color: T.textMuted, cursor: 'pointer', fontSize: 12 }}>Close</button>
      </div>

      {/* Stock Status Banner */}
      <div style={{ padding: '12px 20px', background: `${stockColor}15`, borderBottom: `1px solid ${stockColor}40`, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 12, height: 12, borderRadius: '50%', background: stockColor }} />
          <span style={{ fontSize: 12, fontWeight: 700, color: stockColor, fontFamily: mono }}>{stockLabel}</span>
        </div>
        <div style={{ fontSize: 28, fontWeight: 900, color: stockColor, fontFamily: mono }}>{item.qty ?? '—'}</div>
      </div>

      {/* Content */}
      <div style={{ flex: 1, overflowY: 'auto', padding: 20 }}>
        <ItemImage item={item} />

        {renderSection('Identification', identFields)}
        {renderSection('Stock Levels', stockFields)}
        {renderSection('Location', locationFields)}
        {renderSection('Category', categoryFields)}
        {renderSection('Physical', physicalFields)}
        {renderSection('Supplier', supplierFields)}

        {/* All other fields */}
        <div style={{ marginTop: 20 }}>
          <div style={{ fontSize: 10, fontWeight: 700, color: T.textDim, textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8, fontFamily: mono }}>All Fields</div>
          {Object.entries(item).map(([k, v]) => renderField(k, v))}
        </div>
      </div>
    </div>
  );
}

// Local component - EmbeddedAIPanel (simplified for this context)
function EmbeddedAIPanel({ domain, contextData, serverUrl, onClose, settings }) {
  const [query, setQuery] = useState('');
  const [response, setResponse] = useState('');
  const [loading, setLoading] = useState(false);

  const handleAsk = async () => {
    if (!query.trim() || loading) return;
    setLoading(true);
    setResponse('');

    try {
      const gatewayUrl = settings?.gatewayUrl || 'http://localhost:3001';
      const res = await fetch(`${gatewayUrl}/web/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: query,
          domain,
          context: contextData
        })
      });

      if (res.ok) {
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let text = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.text) {
                  text += data.text;
                  setResponse(text);
                }
              } catch (e) {
                // Ignore parse errors for partial chunks
              }
            }
          }
        }
      }
    } catch (e) {
      setResponse('Error connecting to AI service.');
    }
    setLoading(false);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', padding: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>AI Assistant</div>
        <button onClick={onClose} style={{ background: 'transparent', border: 'none', color: T.textDim, cursor: 'pointer', fontSize: 16 }}>x</button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', marginBottom: 12, padding: 12, background: T.bg, borderRadius: 8, fontSize: 12, color: T.textMuted, whiteSpace: 'pre-wrap' }}>
        {response || 'Ask me about inventory, stock levels, or trends...'}
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && handleAsk()}
          placeholder="Ask about inventory..."
          style={{ flex: 1, padding: '10px 12px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }}
        />
        <button onClick={handleAsk} disabled={loading} style={{ padding: '10px 16px', background: T.blue, border: 'none', borderRadius: 6, color: '#fff', fontSize: 12, fontWeight: 600, cursor: loading ? 'wait' : 'pointer', opacity: loading ? 0.6 : 1 }}>
          {loading ? '...' : 'Ask'}
        </button>
      </div>
    </div>
  );
}

// Local component - ProductionStageTab wrapper with AI sidebar
function ProductionStageTab({ domain, children, contextData, serverUrl, settings }) {
  const [aiPanelOpen, setAIPanelOpen] = useState(false);

  return (
    <div style={{ display: "flex", height: "calc(100vh - 160px)", overflow: "hidden" }}>
      {/* Main Content */}
      <div style={{ flex: 1, overflow: "auto", padding: "22px 28px" }}>
        {children}
      </div>

      {/* AI Toggle Button (when collapsed) */}
      {!aiPanelOpen && (
        <button onClick={() => setAIPanelOpen(true)}
          style={{ position: "fixed", right: 0, top: "50%", transform: "translateY(-50%)", background: T.blue, border: "none", borderRadius: "8px 0 0 8px", padding: "14px 10px", cursor: "pointer", color: "#fff", fontSize: 18, zIndex: 50, boxShadow: `0 0 20px ${T.blue}40` }}>
          AI
        </button>
      )}

      {/* AI Sidebar */}
      <div style={{ width: aiPanelOpen ? 320 : 0, overflow: "hidden", transition: "width 0.3s ease", borderLeft: aiPanelOpen ? `1px solid ${T.border}` : "none", background: T.surface, flexShrink: 0 }}>
        {aiPanelOpen && (
          <EmbeddedAIPanel domain={domain} contextData={contextData} serverUrl={serverUrl} onClose={() => setAIPanelOpen(false)} settings={settings} />
        )}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════
// ── INVENTORY TAB ─────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════
function InventoryTab({ ovenServerUrl, settings }) {
  const [sub, setSub] = useState("inventory");
  const [inventory, setInventory] = useState({ materials: [], lastSync: null, status: 'pending', alertCount: 0, warehouses: [], warehouseStats: {}, vlmStats: {} });
  const [picks, setPicks] = useState({ picks: [], recent: [], count: 0, byWarehouse: {} });
  const [alerts, setAlerts] = useState({ alerts: [], critical: 0, high: 0, low: 0 });
  const [vlms, setVlms] = useState({ vlmStats: {}, locations: [] });
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const [filterCoating, setFilterCoating] = useState("All");
  const [sortCol, setSortCol] = useState("qty");
  const [sortDir, setSortDir] = useState("asc");
  const [selectedItem, setSelectedItem] = useState(null);

  // Fetch all inventory data
  useEffect(() => {
    if (!ovenServerUrl) return;
    const go = async () => {
      try {
        const [invResp, picksResp, alertsResp, vlmsResp] = await Promise.all([
          fetch(`${ovenServerUrl}/api/inventory`).then(r => r.json()),
          fetch(`${ovenServerUrl}/api/inventory/picks`).then(r => r.json()),
          fetch(`${ovenServerUrl}/api/inventory/alerts`).then(r => r.json()),
          fetch(`${ovenServerUrl}/api/inventory/vlms`).then(r => r.json()),
        ]);
        setInventory(invResp);
        setPicks(picksResp);
        setAlerts(alertsResp);
        setVlms(vlmsResp);
        setLoading(false);
      } catch (e) {
        console.error('[Inventory] Fetch error:', e);
        setLoading(false);
      }
    };
    go();
    const iv = setInterval(go, 30000);
    return () => clearInterval(iv);
  }, [ovenServerUrl]);

  // Filter and sort materials
  const filteredMaterials = useMemo(() => {
    let items = [...(inventory.materials || [])];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(m =>
        m.sku?.toLowerCase().includes(q) ||
        m.name?.toLowerCase().includes(q) ||
        m.coatingType?.toLowerCase().includes(q) ||
        m.location?.toLowerCase().includes(q)
      );
    }
    if (filterCoating !== "All") {
      items = items.filter(m => m.coatingType === filterCoating);
    }
    items.sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc" ? String(av || "").localeCompare(String(bv || "")) : String(bv || "").localeCompare(String(av || ""));
    });
    return items;
  }, [inventory.materials, searchQuery, filterCoating, sortCol, sortDir]);

  // Get unique coating types for filter
  const coatingTypes = useMemo(() => {
    const types = new Set((inventory.materials || []).map(m => m.coatingType).filter(Boolean));
    return ["All", ...Array.from(types).sort()];
  }, [inventory.materials]);

  // Stats
  const totalSKUs = (inventory.materials || []).length;
  const totalQty = (inventory.materials || []).reduce((s, m) => s + (m.qty || 0), 0);
  const outOfStock = (inventory.materials || []).filter(m => m.qty === 0).length;
  const lowStock = alerts.critical + alerts.high;

  const toggleSort = col => { if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc"); else { setSortCol(col); setSortDir("asc"); } };

  const SHdr = ({ col, children, align = "left" }) => (
    <th onClick={() => toggleSort(col)} style={{
      fontFamily: mono, fontSize: 9, color: sortCol === col ? T.amber : T.textDim, letterSpacing: 1.5,
      textAlign: align, padding: "9px 12px", borderBottom: `2px solid ${T.border}`, textTransform: "uppercase", whiteSpace: "nowrap", cursor: "pointer", userSelect: "none"
    }}>
      {children}{sortCol === col ? <span style={{ marginLeft: 3 }}>{sortDir === "asc" ? "^" : "v"}</span> : null}
    </th>
  );

  const SubNav = () => (
    <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
      {[{ id: "inventory", label: "Inventory" }, { id: "warehouses", label: "Warehouses" }, { id: "picks", label: "Picks" }, { id: "alerts", label: "Alerts" }, { id: "search", label: "Lens Search" }].map(t => (
        <button key={t.id} onClick={() => setSub(t.id)} style={{
          background: sub === t.id ? T.blueDark : "transparent", border: `1px solid ${sub === t.id ? T.blue : T.border}`,
          borderRadius: 6, padding: "8px 16px", color: sub === t.id ? T.blue : T.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: mono
        }}>
          {t.label}
          {t.id === "alerts" && alerts.critical > 0 ? <span style={{ marginLeft: 6, background: T.red, color: "#fff", borderRadius: 10, padding: "2px 6px", fontSize: 9 }}>{alerts.critical}</span> : null}
          {t.id === "picks" && picks.count > 0 ? <span style={{ marginLeft: 6, background: T.amber, color: "#000", borderRadius: 10, padding: "2px 6px", fontSize: 9 }}>{picks.count}</span> : null}
        </button>
      ))}
    </div>
  );

  const contextData = {
    totalSKUs, totalQty, outOfStock, lowStock,
    totalSkus: totalSKUs, totalUnits: totalQty,
    criticalAlerts: (alerts.alerts || []).filter(a => a.severity === 'CRITICAL' || a.severity === 'critical'),
    highAlerts: (alerts.alerts || []).filter(a => a.severity === 'HIGH' || a.severity === 'high'),
    criticalCount: alerts.critical, highCount: alerts.high,
    activePicks: picks.count,
    recentPicks: picks.picks || picks.activePicks || [],
    byCoatingType: inventory.byCoatingType || {},
    status: inventory.status,
    warehouses: inventory.warehouses,
    warehouseStats: inventory.warehouseStats,
    vlmStats: vlms.vlmStats,
    picksByWarehouse: picks.byWarehouse
  };

  if (loading) {
    return (<div style={{ padding: 32, textAlign: "center", color: T.textMuted, fontFamily: mono }}>Loading inventory data...</div>);
  }

  return (
    <ProductionStageTab domain="inventory" contextData={contextData} serverUrl={ovenServerUrl} settings={settings}>
      <div>
        <SubNav />

        {sub === "inventory" && (
          <div>
            {/* Summary cards */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
              <Card style={{ padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>TOTAL SKUS</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{totalSKUs.toLocaleString()}</div>
              </Card>
              <Card style={{ padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>TOTAL QTY</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{totalQty.toLocaleString()}</div>
              </Card>
              <Card style={{ padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>OUT OF STOCK</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: outOfStock > 0 ? T.red : T.green, fontFamily: mono }}>{outOfStock}</div>
              </Card>
              <Card style={{ padding: 16, textAlign: "center" }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>LOW STOCK</div>
                <div style={{ fontSize: 28, fontWeight: 800, color: lowStock > 0 ? T.amber : T.green, fontFamily: mono }}>{lowStock}</div>
              </Card>
            </div>

            {/* Filters */}
            <div style={{ display: "flex", gap: 12, marginBottom: 16, alignItems: "center" }}>
              <input type="text" placeholder="Search SKU, name, location..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                style={{ flex: 1, maxWidth: 300, padding: "8px 12px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }} />
              <select value={filterCoating} onChange={e => setFilterCoating(e.target.value)}
                style={{ padding: "8px 12px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }}>
                {coatingTypes.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono }}>
                {filteredMaterials.length} of {totalSKUs} SKUs
              </div>
            </div>

            {/* Inventory table */}
            <Card style={{ overflow: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse" }}>
                <thead>
                  <tr style={{ background: T.bg }}>
                    <SHdr col="sku">SKU</SHdr>
                    <SHdr col="name">Description</SHdr>
                    <SHdr col="coatingType">Type</SHdr>
                    <SHdr col="qty" align="right">Qty</SHdr>
                    <SHdr col="location">Location</SHdr>
                    <SHdr col="index">Index</SHdr>
                  </tr>
                </thead>
                <tbody>
                  {filteredMaterials.slice(0, 100).map(m => {
                    const isLow = m.qty <= (m.reorderPoint || 10);
                    const isOut = m.qty === 0;
                    const isSelected = selectedItem?.sku === m.sku;
                    return (
                      <tr key={m.id || m.sku} onClick={() => setSelectedItem(m)} style={{ borderBottom: `1px solid ${T.border}`, background: isSelected ? `${T.blue}15` : isOut ? `${T.red}08` : isLow ? `${T.amber}08` : "transparent", cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e => e.currentTarget.style.background = `${T.blue}10`} onMouseLeave={e => e.currentTarget.style.background = isSelected ? `${T.blue}15` : isOut ? `${T.red}08` : isLow ? `${T.amber}08` : 'transparent'}>
                        <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.text, fontWeight: 600 }}>{m.sku}</td>
                        <td style={{ padding: "10px 12px", fontSize: 12, color: T.textMuted, maxWidth: 300, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{m.name}</td>
                        <td style={{ padding: "10px 12px" }}>
                          {m.coatingType && <Pill color={T.blue} bg={`${T.blue}15`}>{m.coatingType}</Pill>}
                        </td>
                        <td style={{
                          padding: "10px 12px", fontFamily: mono, fontSize: 13, fontWeight: 700, textAlign: "right",
                          color: isOut ? T.red : isLow ? T.amber : T.green
                        }}>
                          {m.qty}
                        </td>
                        <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textDim }}>{m.location || "—"}</td>
                        <td style={{ padding: "10px 12px", fontFamily: mono, fontSize: 11, color: T.textMuted }}>{m.index || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {filteredMaterials.length > 100 && (
                <div style={{ padding: 12, textAlign: "center", color: T.textDim, fontSize: 11, fontFamily: mono }}>
                  Showing 100 of {filteredMaterials.length} items. Refine your search to see more.
                </div>
              )}
            </Card>
          </div>
        )}

        {sub === "warehouses" && (
          <div>
            {/* Hourly Picks Chart - Bold totals at top */}
            <Card style={{ marginBottom: 24, padding: 20 }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: mono }}>TODAY'S PICKS BY HOUR</div>
                <div style={{ display: "flex", gap: 24 }}>
                  {['WH1', 'WH2'].map(wh => {
                    const total = Object.values(inventory.hourlyStats?.[wh] || {}).reduce((s, v) => s + v, 0);
                    const color = wh === 'WH1' ? T.blue : T.green;
                    return (
                      <div key={wh} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <div style={{ width: 12, height: 12, borderRadius: 3, background: color }} />
                        <span style={{ fontFamily: mono, fontSize: 12, color: T.textMuted }}>{wh}:</span>
                        <span style={{ fontFamily: mono, fontSize: 20, fontWeight: 900, color: color }}>{total}</span>
                      </div>
                    );
                  })}
                </div>
              </div>
              {/* Horizontal bar chart */}
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {['WH1', 'WH2'].map(wh => {
                  const hourData = inventory.hourlyStats?.[wh] || {};
                  const maxVal = Math.max(1, ...Object.values(hourData));
                  const color = wh === 'WH1' ? T.blue : T.green;
                  const currentHour = new Date().getHours();
                  return (
                    <div key={wh}>
                      <div style={{ fontFamily: mono, fontSize: 11, fontWeight: 700, color: color, marginBottom: 4 }}>{wh}</div>
                      <div style={{ display: "flex", gap: 2, alignItems: "flex-end", height: 50, paddingTop: 16 }}>
                        {Array.from({ length: 24 }, (_, h) => {
                          const isFuture = h > currentHour;
                          const val = isFuture ? 0 : (hourData[h] || hourData[String(h)] || 0);
                          const barHeight = val > 0 ? Math.max(6, Math.round((val / maxVal) * 34)) : 2;
                          const isNow = h === currentHour;
                          return (
                            <div key={h} style={{ flex: 1, position: "relative", opacity: isFuture ? 0.3 : 1 }}>
                              {val > 0 && <div style={{ position: "absolute", bottom: barHeight + 2, left: "50%", transform: "translateX(-50%)", fontSize: 9, fontWeight: 700, color: color, fontFamily: mono, whiteSpace: "nowrap" }}>{val}</div>}
                              <div style={{
                                width: "100%",
                                height: isFuture ? 2 : barHeight,
                                background: isFuture ? `${color}15` : val > 0 ? color : `${color}30`,
                                borderRadius: 2,
                                border: isNow ? `2px solid ${T.amber}` : 'none'
                              }} />
                            </div>
                          );
                        })}
                      </div>
                      <div style={{ display: "flex", gap: 2, marginTop: 2 }}>
                        {Array.from({ length: 24 }, (_, h) => (
                          <div key={h} style={{ flex: 1, textAlign: "center", fontSize: 8, color: h === currentHour ? T.amber : T.textDim, fontFamily: mono, fontWeight: h === currentHour ? 700 : 400 }}>
                            {h % 3 === 0 ? h : ''}
                          </div>
                        ))}
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>

            {/* Warehouse breakdown */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 24 }}>
              {(inventory.warehouses || []).map(wh => {
                const stats = inventory.warehouseStats?.[wh.name] || { activeOrders: 0, untouchedOrders: 0, totalLines: 0, totalQty: 0, todayPicks: 0 };
                return (
                  <Card key={wh.id} style={{ padding: 20, borderLeft: `4px solid ${wh.name === 'WH1' ? T.blue : wh.name === 'WH2' ? T.green : T.amber}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: T.text, fontFamily: mono }}>{wh.name}</div>
                      <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono }}>{stats.todayPicks || 0} picks today</div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                      <div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>ACTIVE</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: stats.activeOrders > 0 ? T.amber : T.textDim, fontFamily: mono }}>{stats.activeOrders}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>QUEUED</div>
                        <div style={{ fontSize: 24, fontWeight: 800, color: T.blue, fontFamily: mono }}>{stats.untouchedOrders}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>LINES</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: T.textMuted, fontFamily: mono }}>{stats.totalLines}</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>UNITS</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: T.textMuted, fontFamily: mono }}>{stats.totalQty}</div>
                      </div>
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Carousel Inventory Chart - matches ItemPath dashboard */}
            {inventory.carouselStats && Object.keys(inventory.carouselStats).length > 0 && (
              <Card style={{ marginBottom: 24, padding: 20 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 20 }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: mono }}>CAROUSEL INVENTORY</div>
                  <div style={{ fontSize: 12, fontFamily: mono, color: T.textDim }}>
                    Total: <span style={{ fontWeight: 800, color: T.orange }}>{Object.values(inventory.carouselStats).reduce((s, v) => s + v, 0).toLocaleString()}</span>
                  </div>
                </div>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 12 }}>
                  {['CAR-1', 'CAR-2', 'CAR-3', 'CAR-4', 'CAR-5', 'CAR-6'].map(car => {
                    const qty = inventory.carouselStats[car] || 0;
                    const maxQty = Math.max(...Object.values(inventory.carouselStats), 1);
                    const pct = Math.round((qty / maxQty) * 100);
                    return (
                      <div key={car} style={{ textAlign: "center" }}>
                        <div style={{ height: 140, display: "flex", flexDirection: "column", justifyContent: "flex-end", alignItems: "center", marginBottom: 8 }}>
                          <div style={{
                            width: "70%",
                            height: `${Math.max(pct, 5)}%`,
                            background: T.orange,
                            borderRadius: "4px 4px 0 0",
                            position: "relative",
                            display: "flex",
                            alignItems: "center",
                            justifyContent: "center"
                          }}>
                            <span style={{
                              fontSize: 11,
                              fontWeight: 800,
                              color: "#fff",
                              fontFamily: mono,
                              textShadow: "0 1px 2px rgba(0,0,0,0.3)"
                            }}>{qty.toLocaleString()}</span>
                          </div>
                        </div>
                        <div style={{ fontSize: 11, fontWeight: 700, color: T.textMuted, fontFamily: mono }}>{car}</div>
                      </div>
                    );
                  })}
                </div>
              </Card>
            )}

            {/* VLM Inventory */}
            <Card style={{ marginBottom: 20 }}>
              <SectionHeader right={`${Object.keys(vlms.vlmStats || {}).length} VLMs`}>VLM Inventory</SectionHeader>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(280px,1fr))", gap: 16 }}>
                {Object.entries(vlms.vlmStats || {}).map(([vlm, stats]) => (
                  <div key={vlm} style={{ padding: 16, background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
                      <div style={{ fontFamily: mono, fontSize: 16, fontWeight: 800, color: T.text }}>{vlm}</div>
                      <Pill color={T.cyan}>{stats.locationCount} bins</Pill>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: T.blue, fontFamily: mono }}>{stats.totalQty?.toLocaleString()}</div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>TOTAL QTY</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: T.green, fontFamily: mono }}>{stats.filledLocations}</div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>FILLED</div>
                      </div>
                      <div style={{ textAlign: "center" }}>
                        <div style={{ fontSize: 22, fontWeight: 800, color: T.textDim, fontFamily: mono }}>{stats.locationCount - stats.filledLocations}</div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>EMPTY</div>
                      </div>
                    </div>
                    {/* Fill bar */}
                    <div style={{ marginTop: 12, height: 6, background: T.border, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${Math.round((stats.filledLocations / stats.locationCount) * 100)}%`, background: T.green, borderRadius: 3 }} />
                    </div>
                    <div style={{ marginTop: 4, fontSize: 10, color: T.textDim, textAlign: "right", fontFamily: mono }}>
                      {Math.round((stats.filledLocations / stats.locationCount) * 100)}% utilized
                    </div>
                  </div>
                ))}
              </div>
            </Card>

            {/* Active orders by warehouse */}
            <Card>
              <SectionHeader>Active Orders by Warehouse</SectionHeader>
              {Object.keys(picks.byWarehouse || {}).length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
                  {Object.entries(picks.byWarehouse).map(([wh, orders]) => (
                    <div key={wh}>
                      <div style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 8, display: "flex", alignItems: "center", gap: 8 }}>
                        <span style={{ width: 12, height: 12, borderRadius: 3, background: wh === 'WH1' ? T.blue : wh === 'WH2' ? T.green : T.amber }} />
                        {wh}
                        <span style={{ fontSize: 11, color: T.textDim, fontWeight: 400 }}>({orders.length} orders)</span>
                      </div>
                      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(300px,1fr))", gap: 8 }}>
                        {orders.slice(0, 6).map(p => (
                          <div key={p.orderId} style={{ padding: 10, background: T.bg, borderRadius: 6, border: `1px solid ${T.border}` }}>
                            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                              <span style={{ fontFamily: mono, fontSize: 11, fontWeight: 600, color: T.text }}>{p.reference}</span>
                              <span style={{ fontSize: 10, color: T.amber, fontFamily: mono }}>{p.lines?.length || 0} items</span>
                            </div>
                            <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>
                              {p.lines?.slice(0, 2).map(l => l.name).join(', ')}
                              {(p.lines?.length || 0) > 2 ? '...' : ''}
                            </div>
                          </div>
                        ))}
                        {orders.length > 6 && (
                          <div style={{ padding: 10, textAlign: "center", color: T.textDim, fontSize: 11, fontFamily: mono }}>
                            +{orders.length - 6} more orders
                          </div>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No active orders</div>
              )}
            </Card>
          </div>
        )}

        {sub === "picks" && (
          <div>
            {/* Active picks */}
            <Card style={{ marginBottom: 20 }}>
              <SectionHeader right={`${picks.count} active`}>Active Pick Orders</SectionHeader>
              {picks.picks?.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
                  {picks.picks.map(p => (
                    <div key={p.orderId} style={{ padding: 14, background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                        <div>
                          <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: T.text }}>{p.reference}</span>
                          {p.warehouse && <Pill style={{ marginLeft: 8 }} color={p.warehouse === 'WH1' ? T.blue : p.warehouse === 'WH2' ? T.green : T.amber}>{p.warehouse}</Pill>}
                        </div>
                        <Pill color={p.status === "In Process" ? T.amber : T.green}>{p.status}</Pill>
                      </div>
                      {p.lines?.map((l, i) => (
                        <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "4px 0", fontSize: 12 }}>
                          <span style={{ color: T.textMuted }}>{l.name} <span style={{ fontFamily: mono, color: T.textDim }}>({l.sku})</span></span>
                          <span style={{ fontFamily: mono, color: l.pending > 0 ? T.amber : T.green }}>{l.picked}/{l.qty} picked</span>
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ) : (
                <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No active pick orders</div>
              )}
            </Card>

            {/* Recent transactions */}
            <Card>
              <SectionHeader right={`Last 2 hours`}>Recent Picks</SectionHeader>
              {picks.recent?.length > 0 ? (
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ background: T.bg }}>
                      <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>TIME</th>
                      <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>SKU</th>
                      <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>ITEM</th>
                      <th style={{ padding: "8px 12px", textAlign: "right", fontSize: 10, color: T.textDim, fontFamily: mono }}>QTY</th>
                      <th style={{ padding: "8px 12px", textAlign: "left", fontSize: 10, color: T.textDim, fontFamily: mono }}>PICKER</th>
                    </tr>
                  </thead>
                  <tbody>
                    {picks.recent.map(t => (
                      <tr key={t.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                        <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 11, color: T.textDim }}>
                          {new Date(t.completedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </td>
                        <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 11, color: T.text }}>{t.sku}</td>
                        <td style={{ padding: "8px 12px", fontSize: 11, color: T.textMuted }}>{t.name}</td>
                        <td style={{ padding: "8px 12px", fontFamily: mono, fontSize: 12, fontWeight: 600, textAlign: "right", color: T.text }}>{t.qty}</td>
                        <td style={{ padding: "8px 12px", fontSize: 11, color: T.textMuted }}>{t.picker || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No recent picks</div>
              )}
            </Card>
          </div>
        )}

        {sub === "alerts" && (
          <div>
            {/* Alert summary */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 24 }}>
              <Card style={{ padding: 16, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>CRITICAL</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: alerts.critical > 0 ? T.red : T.green, fontFamily: mono }}>{alerts.critical}</div>
              </Card>
              <Card style={{ padding: 16, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>HIGH</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: alerts.high > 0 ? T.amber : T.green, fontFamily: mono }}>{alerts.high}</div>
              </Card>
              <Card style={{ padding: 16, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>LOW</div>
                <div style={{ fontSize: 32, fontWeight: 800, color: T.blue, fontFamily: mono }}>{alerts.low}</div>
              </Card>
            </div>

            {/* Alerts list */}
            <Card>
              <SectionHeader right={`${alerts.alerts?.length || 0} total`}>Low Stock Alerts</SectionHeader>
              {alerts.alerts?.length > 0 ? (
                <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                  {alerts.alerts.map((a, i) => {
                    const sevColor = { CRITICAL: T.red, HIGH: T.amber, LOW: T.blue }[a.severity] || T.textDim;
                    const isSelected = selectedItem?.sku === a.sku;
                    return (
                      <div key={i} onClick={() => setSelectedItem(a)} style={{ display: "flex", alignItems: "center", gap: 12, padding: 12, background: isSelected ? `${T.blue}15` : T.bg, borderRadius: 6, borderLeft: `4px solid ${sevColor}`, cursor: 'pointer', transition: 'background 0.15s' }} onMouseEnter={e => e.currentTarget.style.background = `${T.blue}10`} onMouseLeave={e => e.currentTarget.style.background = isSelected ? `${T.blue}15` : T.bg}>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontFamily: mono, fontSize: 12, fontWeight: 600, color: T.text }}>{a.name}</div>
                          <div style={{ fontSize: 11, color: T.textDim }}>{a.sku} - {a.location || "No location"}</div>
                        </div>
                        <div style={{ textAlign: "right" }}>
                          <div style={{ fontFamily: mono, fontSize: 16, fontWeight: 800, color: sevColor }}>{a.qty}</div>
                          <div style={{ fontSize: 9, color: T.textDim }}>threshold: {a.threshold}</div>
                        </div>
                        <Pill color={sevColor} bg={`${sevColor}15`}>{a.severity}</Pill>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div style={{ padding: 20, textAlign: "center", color: T.green }}>No low stock alerts</div>
              )}
            </Card>
          </div>
        )}

        {sub === "search" && (
          <Card>
            <SectionHeader>Lens Blank Search</SectionHeader>
            <p style={{ color: T.textMuted, fontSize: 12, marginBottom: 16 }}>
              Search for lens blanks by coating type, index, or prescription range.
            </p>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
              <div>
                <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: "block", marginBottom: 4 }}>COATING TYPE</label>
                <select style={{ width: "100%", padding: "8px 10px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12 }}>
                  <option value="">Any</option>
                  {coatingTypes.filter(c => c !== "All").map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: "block", marginBottom: 4 }}>INDEX</label>
                <select style={{ width: "100%", padding: "8px 10px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12 }}>
                  <option value="">Any</option>
                  <option value="1.50">1.50</option>
                  <option value="1.56">1.56</option>
                  <option value="1.67">1.67</option>
                  <option value="1.74">1.74</option>
                </select>
              </div>
              <div>
                <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: "block", marginBottom: 4 }}>SPHERE</label>
                <input type="text" placeholder="-2.00" style={{ width: "100%", padding: "8px 10px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }} />
              </div>
              <div>
                <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: "block", marginBottom: 4 }}>CYLINDER</label>
                <input type="text" placeholder="-1.00" style={{ width: "100%", padding: "8px 10px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }} />
              </div>
            </div>
            <button style={{ background: T.blue, border: "none", borderRadius: 6, padding: "10px 24px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
              Search Inventory
            </button>
            <div style={{ marginTop: 24, padding: 20, background: T.bg, borderRadius: 8, textAlign: "center", color: T.textDim }}>
              Enter search criteria above and click Search to find matching lens blanks.
            </div>
          </Card>
        )}

        {/* Sync status footer */}
        <div style={{ marginTop: 20, display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", background: T.bg, borderRadius: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: inventory.status === "ok" || inventory.status === "mock" ? T.green : T.red }} />
            <span style={{ fontSize: 11, color: T.textDim, fontFamily: mono }}>
              {inventory.status === "mock" ? "Mock Mode" : "ItemPath"} - {inventory.lastSync ? new Date(inventory.lastSync).toLocaleTimeString() : "Not synced"}
            </span>
          </div>
          <span style={{ fontSize: 10, color: T.textDim }}>Auto-refresh every 30s</span>
        </div>

        {/* Item Detail Panel */}
        {selectedItem && <InventoryDetailPanel item={selectedItem} onClose={() => setSelectedItem(null)} title="Lens Blank Details" />}
      </div>
    </ProductionStageTab>
  );
}

export default InventoryTab;
