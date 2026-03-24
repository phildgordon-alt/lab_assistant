import { useState, useEffect, useMemo, useRef } from 'react';
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
        <button onClick={onClose} style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 8, width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center', color: T.text, cursor: 'pointer', fontSize: 20, fontWeight: 700, lineHeight: 1 }}>X</button>
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
    const q = query;
    setQuery('');
    setLoading(true);
    setResponse('');

    try {
      const gatewayUrl = settings?.gatewayUrl || 'http://localhost:3001';
      const res = await fetch(`${gatewayUrl}/web/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          question: q,
          agent: domain === 'inventory' ? 'InventoryAgent' : domain,
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
      } else {
        const err = await res.json().catch(() => ({}));
        setResponse(`Error: ${err.message || `HTTP ${res.status}`}`);
      }
    } catch (e) {
      setResponse('Error connecting to AI service.');
    } finally {
      setLoading(false);
    }
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

// ── Binning Detail View ─────────────────────────────────────────
function BinningDetailView({ view, serverUrl }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [binTypeFilter, setBinTypeFilter] = useState("all"); // all, full, half, quarter
  const [sortCol, setSortCol] = useState("days_left");
  const [sortAsc, setSortAsc] = useState(true);

  useEffect(() => {
    if (!serverUrl) return;
    setLoading(true);
    const ep = view === 'swap' ? '/api/inventory/binning/swap'
             : view === 'consolidate' ? '/api/inventory/binning/consolidate'
             : '/api/inventory/binning/adjacency';
    fetch(`${serverUrl}${ep}`).then(r => r.json()).then(d => { setData(d); setLoading(false); }).catch(() => setLoading(false));
  }, [view, serverUrl]);

  if (loading) return <Card style={{ padding: 32, textAlign: "center", color: T.textMuted }}>Loading...</Card>;
  if (!data) return null;

  if (view === 'swap') {
    const prebuild = data.prebuild_list || [];

    // Filter by bin type
    const filtered = binTypeFilter === 'all' ? prebuild : prebuild.filter(b => b.bin_type === binTypeFilter);

    // Sort
    const sorted = [...filtered].sort((a, b) => {
      const av = a[sortCol] ?? 0, bv = b[sortCol] ?? 0;
      if (typeof av === 'string') return sortAsc ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortAsc ? av - bv : bv - av;
    });

    const toggleSort = (col) => { if (sortCol === col) setSortAsc(!sortAsc); else { setSortCol(col); setSortAsc(true); } };
    const sortIcon = (col) => sortCol === col ? (sortAsc ? ' ▲' : ' ▼') : '';

    // Count by type
    const fullCount = prebuild.filter(b => b.bin_type === 'full').length;
    const halfCount = prebuild.filter(b => b.bin_type === 'half').length;
    const qtrCount = prebuild.filter(b => b.bin_type === 'quarter').length;

    return (
      <div>
        {/* Bin type filter buttons */}
        <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
          {[
            { id: 'all', label: `All (${prebuild.length})`, color: T.text },
            { id: 'full', label: `Full (${fullCount})`, color: T.green },
            { id: 'half', label: `Half (${halfCount})`, color: T.blue },
            { id: 'quarter', label: `Quarter (${qtrCount})`, color: T.amber },
          ].map(f => (
            <button key={f.id} onClick={() => setBinTypeFilter(f.id)} style={{
              padding: "8px 16px", borderRadius: 6, fontSize: 12, fontWeight: 600, fontFamily: mono, cursor: "pointer",
              background: binTypeFilter === f.id ? `${f.color}25` : 'transparent',
              color: binTypeFilter === f.id ? f.color : T.textMuted,
              border: `1px solid ${binTypeFilter === f.id ? f.color : T.border}`
            }}>{f.label}</button>
          ))}
        </div>

        {sorted.length > 0 ? (
          <Card style={{ marginBottom: 20, borderLeft: `4px solid ${T.red}` }}>
            <SectionHeader right={`${sorted.length} SKUs`}>Pre-Build List (Kitchen)</SectionHeader>
            <div style={{ maxHeight: 600, overflowY: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: mono }}>
              <thead><tr style={{ background: T.bg, position: "sticky", top: 0, zIndex: 1 }}>
                <th onClick={() => toggleSort('sku')} style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10, cursor: "pointer" }}>SKU{sortIcon('sku')}</th>
                <th onClick={() => toggleSort('bin_type')} style={{ padding: "8px 12px", textAlign: "center", color: T.textDim, fontSize: 10, cursor: "pointer" }}>BUILD TYPE{sortIcon('bin_type')}</th>
                <th onClick={() => toggleSort('current_qty')} style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10, cursor: "pointer" }}>CURRENT{sortIcon('current_qty')}</th>
                <th onClick={() => toggleSort('daily_rate')} style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10, cursor: "pointer" }}>DAILY RATE{sortIcon('daily_rate')}</th>
                <th onClick={() => toggleSort('days_left')} style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10, cursor: "pointer" }}>DAYS LEFT{sortIcon('days_left')}</th>
                <th onClick={() => toggleSort('qty_needed')} style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10, cursor: "pointer" }}>QTY NEEDED{sortIcon('qty_needed')}</th>
                <th onClick={() => toggleSort('carousel')} style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10, cursor: "pointer" }}>CAROUSEL{sortIcon('carousel')}</th>
              </tr></thead>
              <tbody>{sorted.map((b, i) => {
                const typeColor = b.bin_type === 'full' ? T.green : b.bin_type === 'half' ? T.blue : b.bin_type === 'quarter' ? T.amber : T.textMuted;
                const typeLabel = b.bin_type === 'full' ? 'FULL' : b.bin_type === 'half' ? 'HALF' : b.bin_type === 'quarter' ? 'QTR' : b.bin_type?.toUpperCase() || '—';
                return (
                <tr key={i} style={{ borderBottom: `1px solid ${T.border}22` }}>
                  <td style={{ padding: "8px 12px", color: T.text }}>{b.sku}</td>
                  <td style={{ padding: "8px 12px", textAlign: "center" }}><span style={{ padding: "3px 10px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: `${typeColor}20`, color: typeColor, fontFamily: mono }}>{typeLabel}</span></td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: T.textMuted }}>{b.current_qty}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: T.blue }}>{b.daily_rate || '—'}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: b.days_left <= 1 ? T.red : b.days_left <= 3 ? T.amber : T.textMuted, fontWeight: 700 }}>{b.days_left}</td>
                  <td style={{ padding: "8px 12px", textAlign: "right", color: T.green, fontWeight: 700 }}>{b.qty_needed}</td>
                  <td style={{ padding: "8px 12px", color: T.textDim }}>{b.carousel}</td>
                </tr>
                );
              })}</tbody>
            </table>
            </div>
          </Card>
        ) : (
          <Card style={{ padding: 32, textAlign: "center", color: T.textMuted }}>No bins matching filter.</Card>
        )}
      </div>
    );
  }

  if (view === 'consolidate') {
    const ops = data.opportunities || [];
    return (
      <Card>
        <SectionHeader right={`${data.summary?.total_shelves_freed || 0} shelves freed`}>Consolidation Opportunities</SectionHeader>
        {ops.length > 0 ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: mono }}>
            <thead><tr style={{ background: T.bg }}>
              <th style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>SKU</th>
              <th style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10 }}>BINS</th>
              <th style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10 }}>TARGET</th>
              <th style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10 }}>FREED</th>
              <th style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10 }}>TOTAL QTY</th>
              <th style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>CAROUSELS</th>
            </tr></thead>
            <tbody>{ops.map((o, i) => (
              <tr key={i} style={{ borderBottom: `1px solid ${T.border}22` }}>
                <td style={{ padding: "8px 12px", color: T.text }}>{o.sku}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", color: T.amber }}>{o.current_bins}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", color: T.green }}>{o.target_bins}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", color: T.green, fontWeight: 700 }}>{o.shelves_freed}</td>
                <td style={{ padding: "8px 12px", textAlign: "right", color: T.textMuted }}>{o.total_qty}</td>
                <td style={{ padding: "8px 12px", color: T.textDim }}>{o.carousels}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : (
          <div style={{ padding: 32, textAlign: "center", color: T.textMuted }}>No consolidation opportunities found.</div>
        )}
      </Card>
    );
  }

  if (view === 'adjacency') {
    const recs = data.move_recommendations || [];
    const pairs = data.pairs || [];
    return (
      <div>
        <Card style={{ marginBottom: 20 }}>
          <SectionHeader right={`${data.summary?.days_analyzed || 14}d analyzed`}>Co-Pick Pairs</SectionHeader>
          {pairs.length > 0 ? (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: mono }}>
              <thead><tr style={{ background: T.bg }}>
                <th style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>SKU A</th>
                <th style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>SKU B</th>
                <th style={{ padding: "8px 12px", textAlign: "right", color: T.textDim, fontSize: 10 }}>CO-PICKS</th>
                <th style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>LOC A</th>
                <th style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>LOC B</th>
                <th style={{ padding: "8px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>ACTION</th>
              </tr></thead>
              <tbody>{pairs.slice(0, 30).map((p, i) => {
                const actionColor = p.action === 'optimal' ? T.green : p.action === 'move_adjacent_shelf' ? T.amber : T.red;
                const actionLabel = p.action === 'optimal' ? 'Optimal' : p.action === 'move_adjacent_shelf' ? 'Move Shelf' : p.action === 'move_same_carousel' ? 'Move Carousel' : '—';
                return (
                  <tr key={i} style={{ borderBottom: `1px solid ${T.border}22` }}>
                    <td style={{ padding: "8px 12px", color: T.text }}>{p.sku_a}</td>
                    <td style={{ padding: "8px 12px", color: T.text }}>{p.sku_b}</td>
                    <td style={{ padding: "8px 12px", textAlign: "right", color: T.blue, fontWeight: 700 }}>{p.co_picks}</td>
                    <td style={{ padding: "8px 12px", color: T.textDim }}>{p.loc_a}</td>
                    <td style={{ padding: "8px 12px", color: T.textDim }}>{p.loc_b}</td>
                    <td style={{ padding: "8px 12px" }}><span style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: `${actionColor}20`, color: actionColor }}>{actionLabel}</span></td>
                  </tr>
                );
              })}</tbody>
            </table>
          ) : (
            <div style={{ padding: 32, textAlign: "center", color: T.textMuted }}>Not enough pick history for adjacency analysis.</div>
          )}
        </Card>
      </div>
    );
  }

  return null;
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
  const [whStock, setWhStock] = useState(null);
  const [whSearch, setWhSearch] = useState("");
  const [whFilter, setWhFilter] = useState("all"); // all, WH1, WH2, WH3
  const [binningData, setBinningData] = useState(null);
  const [skuCategories, setSkuCategories] = useState({});
  const [binningView, setBinningView] = useState("swap"); // swap, consolidate, adjacency
  const [reconData, setReconData] = useState(null);
  const [reconFilter, setReconFilter] = useState("all"); // all, discrepancies, matches, ns_only, ip_only
  const [reconCategory, setReconCategory] = useState("all"); // all, Lenses, Tops, Frames, Other
  const [reconSearch, setReconSearch] = useState("");
  const [reconRefreshing, setReconRefreshing] = useState(false);
  const [topsData, setTopsData] = useState(null);
  const [topsUploading, setTopsUploading] = useState(false);
  const [topsResult, setTopsResult] = useState(null);
  const [topsError, setTopsError] = useState(null);
  const [topsDragOver, setTopsDragOver] = useState(false);
  const [topsSearch, setTopsSearch] = useState("");
  const topsFileRef = useRef(null);
  const [usageData, setUsageData] = useState(null);
  const [usageDays, setUsageDays] = useState(30);
  const [usageTopOPCs, setUsageTopOPCs] = useState([]);
  const [consumeData, setConsumeData] = useState(null);
  const [consumeFilter, setConsumeFilter] = useState("ytd"); // ytd, 30, 7, custom
  const [consumeFrom, setConsumeFrom] = useState("");
  const [consumeTo, setConsumeTo] = useState("");
  const [consumeSearch, setConsumeSearch] = useState("");
  const [consumeSort, setConsumeSort] = useState("looker"); // looker, itempath, variance
  const [consumeLoading, setConsumeLoading] = useState(false);

  // Fetch all inventory data
  useEffect(() => {
    if (!ovenServerUrl) return;
    const go = async () => {
      try {
        const [invResp, picksResp, alertsResp, vlmsResp, whResp, binResp, reconResp] = await Promise.all([
          fetch(`${ovenServerUrl}/api/inventory`).then(r => r.json()),
          fetch(`${ovenServerUrl}/api/inventory/picks`).then(r => r.json()),
          fetch(`${ovenServerUrl}/api/inventory/alerts`).then(r => r.json()),
          fetch(`${ovenServerUrl}/api/inventory/vlms`).then(r => r.json()),
          fetch(`${ovenServerUrl}/api/inventory/warehouse-stock`).then(r => r.json()).catch(() => null),
          fetch(`${ovenServerUrl}/api/inventory/binning/summary`).then(r => r.json()).catch(() => null),
          fetch(`${ovenServerUrl}/api/netsuite/reconcile`).then(r => r.json()).catch(() => null),
        ]);
        setInventory(invResp);
        setPicks(picksResp);
        setAlerts(alertsResp);
        setVlms(vlmsResp);
        if (whResp) setWhStock(whResp);
        if (binResp) setBinningData(binResp);
        if (reconResp) setReconData(reconResp);
        fetch(`${ovenServerUrl}/api/inventory/tops`).then(r => r.json()).then(setTopsData).catch(() => {});
        // Fetch NetSuite category mapping for warehouse stock breakdown
        try { const catResp = await fetch(`${ovenServerUrl}/api/netsuite/categories`).then(r => r.json()); setSkuCategories(catResp); } catch {}
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
      {[{ id: "inventory", label: "Inventory" }, { id: "warehouse-stock", label: "Warehouse Stock" }, { id: "consumption", label: "Consumption" }, { id: "lens-usage", label: "Daily Usage" }, { id: "tops", label: "TOPS Count" }, { id: "binning", label: "Binning Intelligence" }, { id: "reconciliation", label: "Reconciliation" }, { id: "warehouses", label: "Activity" }, { id: "picks", label: "Picks" }, { id: "alerts", label: "Alerts" }, { id: "search", label: "Lens Search" }].map(t => (
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
    picksByWarehouse: picks.byWarehouse,
    warehouseStock: whStock ? { wh1_units: whStock.wh1_total_units, wh2_units: whStock.wh2_total_units, wh3_units: whStock.wh3_total_units } : null
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

        {sub === "binning" && (
          <div>
            {/* Sub-navigation */}
            <div style={{ display: "flex", gap: 4, marginBottom: 20 }}>
              {[{ id: "swap", label: "Blue Bin Swap" }, { id: "consolidate", label: "Consolidation" }, { id: "adjacency", label: "Adjacency" }].map(t => (
                <button key={t.id} onClick={() => setBinningView(t.id)}
                  style={{ background: binningView === t.id ? T.purple + '30' : "transparent", border: `1px solid ${binningView === t.id ? T.purple : T.border}`, borderRadius: 6, padding: "8px 16px", color: binningView === t.id ? T.purple : T.textMuted, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: mono }}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Summary cards */}
            {binningData && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 16, marginBottom: 24 }}>
                <Card style={{ padding: 16, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>BINS NEAR SWAP</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.red, fontFamily: mono }}>{binningData.swap?.bins_near_swap || 0}</div>
                </Card>
                <Card style={{ padding: 16, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>CONSOLIDATION OPS</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.amber, fontFamily: mono }}>{binningData.consolidation?.total_opportunities || 0}</div>
                  <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono }}>{binningData.consolidation?.total_shelves_freed || 0} shelves freed</div>
                </Card>
                <Card style={{ padding: 16, textAlign: "center", borderLeft: `4px solid ${T.purple}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>MOVE RECOMMENDATIONS</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.purple, fontFamily: mono }}>{binningData.adjacency?.move_recommendations || 0}</div>
                </Card>
              </div>
            )}

            {/* Bin Type Summary */}
            {binningData?.binTypes && (
              <Card style={{ marginBottom: 20 }}>
                <SectionHeader right={`${binningData.binTypes.total_bins} total bins`}>Bin Type Distribution</SectionHeader>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
                  {[
                    { label: 'FULL', count: binningData.binTypes.full, color: T.green, desc: '1 SKU' },
                    { label: 'HALF', count: binningData.binTypes.half, color: T.blue, desc: '2 SKUs' },
                    { label: 'QUARTER', count: binningData.binTypes.quarter, color: T.amber, desc: '4 SKUs' },
                    { label: 'MIXED', count: binningData.binTypes.mixed, color: T.red, desc: '5+ SKUs' },
                  ].map(t => (
                    <div key={t.label} style={{ padding: 12, background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, textAlign: "center" }}>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>{t.label}</div>
                      <div style={{ fontSize: 28, fontWeight: 800, color: t.color, fontFamily: mono }}>{t.count}</div>
                      <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>{t.desc}</div>
                    </div>
                  ))}
                </div>

                {/* Per-carousel breakdown */}
                {binningData.byCarousel && (
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(160px,1fr))", gap: 12 }}>
                    {Object.entries(binningData.byCarousel).map(([car, counts]) => (
                      <div key={car} style={{ padding: 12, background: T.bg, borderRadius: 8, border: `1px solid ${T.border}` }}>
                        <div style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 8 }}>{car}</div>
                        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                          {counts.full > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.green }}>F:{counts.full}</span>}
                          {counts.half > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.blue }}>H:{counts.half}</span>}
                          {counts.quarter > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.amber }}>Q:{counts.quarter}</span>}
                          {counts.mixed > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.red }}>M:{counts.mixed}</span>}
                        </div>
                        {/* Fill bar showing type proportions */}
                        <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", marginTop: 8 }}>
                          {counts.full > 0 && <div style={{ flex: counts.full, background: T.green }} />}
                          {counts.half > 0 && <div style={{ flex: counts.half, background: T.blue }} />}
                          {counts.quarter > 0 && <div style={{ flex: counts.quarter, background: T.amber }} />}
                          {counts.mixed > 0 && <div style={{ flex: counts.mixed, background: T.red }} />}
                        </div>
                        <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono, marginTop: 4 }}>{counts.total} bins</div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Carousel utilization */}
            {binningData?.utilization && (
              <Card style={{ marginBottom: 20 }}>
                <SectionHeader>Carousel Utilization</SectionHeader>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
                  {binningData.utilization.map((u, i) => (
                    <div key={i} style={{ padding: 12, background: T.bg, borderRadius: 8, border: `1px solid ${T.border}`, textAlign: "center" }}>
                      <div style={{ fontFamily: mono, fontSize: 14, fontWeight: 700, color: T.text }}>{u.carousel}</div>
                      <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>{u.warehouse}</div>
                      <div style={{ fontSize: 22, fontWeight: 800, color: T.blue, fontFamily: mono, marginTop: 4 }}>{(u.total_units || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>{u.unique_skus} SKUs · {u.total_bins} bins</div>
                    </div>
                  ))}
                </div>
              </Card>
            )}

            {/* Detail view based on selected sub-view */}
            <BinningDetailView view={binningView} serverUrl={ovenServerUrl} />
          </div>
        )}

        {sub === "reconciliation" && (
          <div>
            {/* Summary KPIs */}
            {reconData?.summary ? (
              <>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
                  <Card style={{ padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>SKUS COMPARED</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: T.text, fontFamily: mono }}>{reconData.summary.totalSkus?.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>NS: {reconData.summary.netsuiteSkus} · IP: {reconData.summary.itempathSkus}</div>
                  </Card>
                  <Card style={{ padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>MATCHED</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{reconData.summary.matched?.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: T.green, fontFamily: mono }}>{reconData.summary.matchRate}% match rate</div>
                  </Card>
                  <Card style={{ padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>DISCREPANCIES</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: reconData.summary.discrepancies > 0 ? T.red : T.green, fontFamily: mono }}>{reconData.summary.discrepancies?.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>
                      <span style={{ color: T.red }}>{reconData.summary.critical} critical</span> · <span style={{ color: T.amber }}>{reconData.summary.high} high</span> · {reconData.summary.low} low
                    </div>
                  </Card>
                  <Card style={{ padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>NET VARIANCE</div>
                    <div style={{ fontSize: 28, fontWeight: 800, color: reconData.summary.totalDiff === 0 ? T.green : T.amber, fontFamily: mono }}>{reconData.summary.totalDiff > 0 ? '+' : ''}{reconData.summary.totalDiff?.toLocaleString()}</div>
                    <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>IP: {reconData.summary.totalItemPath?.toLocaleString()} · NS: {reconData.summary.totalNetSuite?.toLocaleString()}</div>
                  </Card>
                </div>

                {/* Sync status + refresh */}
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                  <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono }}>
                    Last sync: {reconData.lastSync ? new Date(reconData.lastSync).toLocaleString() : 'Never'}
                  </div>
                  <button onClick={async () => {
                    setReconRefreshing(true);
                    try {
                      await fetch(`${ovenServerUrl}/api/netsuite/refresh`, { method: 'POST' });
                      const resp = await fetch(`${ovenServerUrl}/api/netsuite/reconcile`);
                      setReconData(await resp.json());
                    } catch (e) { console.error(e); }
                    setReconRefreshing(false);
                  }} disabled={reconRefreshing}
                    style={{ background: T.blue, border: "none", borderRadius: 8, padding: "8px 16px", color: "#fff", fontSize: 12, fontWeight: 700, cursor: "pointer", opacity: reconRefreshing ? 0.6 : 1, fontFamily: mono }}>
                    {reconRefreshing ? "Syncing..." : "↻ Refresh NetSuite"}
                  </button>
                </div>

                {/* Filters */}
                <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
                  <input value={reconSearch} onChange={e => setReconSearch(e.target.value)} placeholder="Search SKU..."
                    style={{ flex: 1, padding: "10px 14px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }} />
                  {[
                    { id: 'all', label: 'All' },
                    { id: 'discrepancies', label: 'Discrepancies', color: T.red },
                    { id: 'matches', label: 'Matches', color: T.green },
                    { id: 'ns_only', label: 'NS Only', color: T.purple },
                    { id: 'ip_only', label: 'IP Only', color: T.blue },
                  ].map(f => (
                    <button key={f.id} onClick={() => setReconFilter(f.id)} style={{
                      padding: "8px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                      background: reconFilter === f.id ? `${f.color || T.text}25` : 'transparent',
                      color: reconFilter === f.id ? (f.color || T.text) : T.textMuted,
                      border: `1px solid ${reconFilter === f.id ? (f.color || T.text) : T.border}`
                    }}>{f.label}</button>
                  ))}
                </div>

                {/* Category filter — re-fetches from server so KPIs recalculate */}
                <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                  <span style={{ fontSize: 11, color: T.textDim, fontFamily: mono, alignSelf: "center" }}>Category:</span>
                  {['all', 'Lenses', 'Tops', 'Frames', 'Other'].map(c => (
                    <button key={c} onClick={async () => {
                      setReconCategory(c);
                      try {
                        const catParam = c === 'all' ? '' : `?category=${c}`;
                        const resp = await fetch(`${ovenServerUrl}/api/netsuite/reconcile${catParam}`);
                        setReconData(await resp.json());
                      } catch (e) { console.error(e); }
                    }} style={{
                      padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                      background: reconCategory === c ? `${T.cyan}25` : 'transparent',
                      color: reconCategory === c ? T.cyan : T.textMuted,
                      border: `1px solid ${reconCategory === c ? T.cyan : T.border}`
                    }}>{c === 'all' ? 'All' : c}</button>
                  ))}
                </div>

                {/* Discrepancy table */}
                {(() => {
                  let rows = reconData.discrepancies || [];
                  if (reconFilter === 'matches') rows = [];
                  if (reconFilter === 'ns_only') rows = rows.filter(d => d.netsuite > 0 && d.itempath === 0);
                  if (reconFilter === 'ip_only') rows = rows.filter(d => d.itempath > 0 && d.netsuite === 0);
                  if (reconCategory !== 'all') rows = rows.filter(d => d.category === reconCategory);
                  if (reconSearch) {
                    const q = reconSearch.toLowerCase();
                    rows = rows.filter(d => d.sku?.toLowerCase().includes(q) || d.name?.toLowerCase().includes(q));
                  }
                  return (
                    <Card style={{ padding: 0 }}>
                      <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                        <span style={{ fontSize: 12, fontWeight: 700, color: T.text, fontFamily: mono }}>{rows.length} {reconFilter === 'all' ? 'discrepancies' : reconFilter}</span>
                      </div>
                      <div style={{ maxHeight: 500, overflowY: "auto" }}>
                        <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: mono }}>
                          <thead>
                            <tr style={{ background: T.bg, position: "sticky", top: 0, zIndex: 1 }}>
                              <th style={{ padding: "10px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>SKU</th>
                              <th style={{ padding: "10px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>NAME</th>
                              <th style={{ padding: "10px 12px", textAlign: "left", color: T.textDim, fontSize: 10 }}>CAT</th>
                              <th style={{ padding: "10px 12px", textAlign: "right", color: T.blue, fontSize: 10 }}>WH1</th>
                              <th style={{ padding: "10px 12px", textAlign: "right", color: T.green, fontSize: 10 }}>WH2</th>
                              <th style={{ padding: "10px 12px", textAlign: "right", color: T.amber, fontSize: 10 }}>WH3</th>
                              <th style={{ padding: "10px 12px", textAlign: "right", color: T.blue, fontSize: 10 }}>IP TOTAL</th>
                              <th style={{ padding: "10px 12px", textAlign: "right", color: T.purple || '#9b6ee0', fontSize: 10 }}>NETSUITE</th>
                              <th style={{ padding: "10px 12px", textAlign: "right", color: T.textDim, fontSize: 10 }}>VARIANCE</th>
                              <th style={{ padding: "10px 12px", textAlign: "center", color: T.textDim, fontSize: 10 }}>STATUS</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.slice(0, 200).map((d, i) => {
                              const statusColor = d.diff === 0 ? T.green : d.netsuite === 0 ? T.blue : d.itempath === 0 ? (T.purple || '#9b6ee0') : d.diff > 0 ? T.amber : T.red;
                              const statusLabel = d.diff === 0 ? 'MATCH' : d.netsuite === 0 ? 'IP ONLY' : d.itempath === 0 ? 'NS ONLY' : d.diff > 0 ? 'OVER' : 'SHORT';
                              const sevColor = d.severity === 'critical' ? T.red : d.severity === 'high' ? T.amber : T.textDim;
                              return (
                                <tr key={i} style={{ borderBottom: `1px solid ${T.border}22`, background: d.severity === 'critical' ? `${T.red}08` : 'transparent' }}>
                                  <td style={{ padding: "8px 12px", color: T.text }}>{d.sku}</td>
                                  <td style={{ padding: "8px 12px", color: T.textMuted, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.name}</td>
                                  <td style={{ padding: "8px 12px", color: T.cyan, fontSize: 10 }}>{d.category || '—'}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", color: d.wh1 > 0 ? T.blue : T.textDim }}>{d.wh1 || '—'}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", color: d.wh2 > 0 ? T.green : T.textDim }}>{d.wh2 || '—'}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", color: d.wh3 > 0 ? T.amber : T.textDim }}>{d.wh3 || '—'}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", color: T.blue, fontWeight: 600 }}>{d.itempath?.toLocaleString()}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", color: T.purple || '#9b6ee0', fontWeight: 600 }}>{d.netsuite?.toLocaleString()}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "right", color: sevColor, fontWeight: 700 }}>{d.diff > 0 ? '+' : ''}{d.diff}</td>
                                  <td style={{ padding: "8px 12px", textAlign: "center" }}>
                                    <span style={{ padding: "3px 8px", borderRadius: 4, fontSize: 10, fontWeight: 700, background: `${statusColor}20`, color: statusColor }}>{statusLabel}</span>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {rows.length === 0 && reconFilter === 'matches' && (
                          <div style={{ padding: 32, textAlign: "center", color: T.green }}>All {reconData.summary.matched} SKUs match between ItemPath and NetSuite.</div>
                        )}
                        {rows.length === 0 && reconFilter !== 'matches' && (
                          <div style={{ padding: 32, textAlign: "center", color: T.textMuted }}>No discrepancies found.</div>
                        )}
                      </div>
                    </Card>
                  );
                })()}
              </>
            ) : (
              <Card style={{ padding: 40, textAlign: "center" }}>
                <div style={{ fontSize: 32, marginBottom: 10 }}>📊</div>
                <div style={{ color: T.textMuted }}>NetSuite reconciliation loading... If this persists, check Settings → Connections for NetSuite status.</div>
              </Card>
            )}
          </div>
        )}

        {sub === "warehouse-stock" && (
          <div>
            {/* Warehouse totals */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 16, marginBottom: 24 }}>
              {[
                { id: 'WH1', label: 'Warehouse 1', sub: 'CAR 1-3', color: T.blue },
                { id: 'WH2', label: 'Warehouse 2', sub: 'CAR 4-6', color: T.green },
                { id: 'WH3', label: 'Warehouse 3', sub: 'Kitchen + IRV02', color: T.amber },
                { id: 'TOPS', label: 'TOPS', sub: 'Manual Count', color: T.purple },
              ].map(wh => {
                const whData = whStock ? (whStock[wh.id] || {}) : {};
                const skus = Object.keys(whData).length;
                const units = Object.values(whData).reduce((s, q) => s + q, 0);
                const isActive = whFilter === wh.id;

                // Category breakdown using NetSuite category mapping
                const catCounts = { Lenses: 0, Frames: 0, Tops: 0, Other: 0 };
                for (const [sku, qty] of Object.entries(whData)) {
                  const cat = skuCategories[sku] || 'Other';
                  catCounts[cat] = (catCounts[cat] || 0) + qty;
                }

                return (
                  <Card key={wh.id} onClick={() => setWhFilter(whFilter === wh.id ? 'all' : wh.id)}
                    style={{ padding: 20, cursor: 'pointer', borderLeft: `4px solid ${wh.color}`, background: isActive ? `${wh.color}15` : T.card, border: isActive ? `1px solid ${wh.color}` : `1px solid ${T.border}`, borderLeftWidth: 4 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <div>
                        <div style={{ fontSize: 16, fontWeight: 800, color: T.text, fontFamily: mono }}>{wh.label}</div>
                        <div style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>{wh.sub}</div>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
                      <div>
                        <div style={{ fontSize: 28, fontWeight: 900, color: wh.color, fontFamily: mono }}>{units.toLocaleString()}</div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>TOTAL UNITS</div>
                      </div>
                      <div>
                        <div style={{ fontSize: 28, fontWeight: 900, color: T.text, fontFamily: mono }}>{skus.toLocaleString()}</div>
                        <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>UNIQUE SKUS</div>
                      </div>
                    </div>
                    {/* Category breakdown */}
                    <div style={{ borderTop: `1px solid ${T.border}`, paddingTop: 8, display: "flex", gap: 12, flexWrap: "wrap" }}>
                      {catCounts.Lenses > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.cyan }}>Lenses: {catCounts.Lenses.toLocaleString()}</span>}
                      {catCounts.Frames > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.green }}>Frames: {catCounts.Frames.toLocaleString()}</span>}
                      {catCounts.Tops > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.amber }}>Tops: {catCounts.Tops.toLocaleString()}</span>}
                      {catCounts.Other > 0 && <span style={{ fontSize: 10, fontFamily: mono, color: T.textDim }}>Other: {catCounts.Other.toLocaleString()}</span>}
                    </div>
                  </Card>
                );
              })}
            </div>

            {/* Search */}
            <div style={{ marginBottom: 16, display: "flex", gap: 12, alignItems: "center" }}>
              <input
                value={whSearch} onChange={e => setWhSearch(e.target.value)}
                placeholder="Search by SKU..."
                style={{ flex: 1, padding: "10px 14px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }}
              />
              <div style={{ display: "flex", gap: 4 }}>
                {['all', 'WH1', 'WH2', 'WH3', 'TOPS'].map(f => (
                  <button key={f} onClick={() => setWhFilter(f)} style={{
                    padding: "8px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                    background: whFilter === f ? (f === 'WH1' ? T.blue : f === 'WH2' ? T.green : f === 'WH3' ? T.amber : f === 'TOPS' ? T.purple : T.blueDark) : 'transparent',
                    color: whFilter === f ? '#fff' : T.textMuted,
                    border: `1px solid ${whFilter === f ? 'transparent' : T.border}`
                  }}>{f === 'all' ? 'All' : f}</button>
                ))}
              </div>
            </div>

            {/* SKU table */}
            {whStock ? (() => {
              // Build unified SKU list
              const skuMap = {};
              for (const wh of ['WH1', 'WH2', 'WH3', 'TOPS']) {
                for (const [sku, qty] of Object.entries(whStock[wh] || {})) {
                  if (!skuMap[sku]) skuMap[sku] = { sku, WH1: 0, WH2: 0, WH3: 0, TOPS: 0, total: 0 };
                  skuMap[sku][wh] = qty;
                  skuMap[sku].total += qty;
                }
              }
              let rows = Object.values(skuMap);
              // Filter by warehouse
              if (whFilter !== 'all') rows = rows.filter(r => r[whFilter] > 0);
              // Filter by search
              if (whSearch) {
                const q = whSearch.toLowerCase();
                rows = rows.filter(r => r.sku.toLowerCase().includes(q));
              }
              // Sort by total desc
              rows.sort((a, b) => b.total - a.total);
              const grandTotal = rows.reduce((s, r) => s + r.total, 0);

              return (
                <Card style={{ padding: 0 }}>
                  <div style={{ padding: "12px 16px", borderBottom: `1px solid ${T.border}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.text, fontFamily: mono }}>{rows.length} SKUs</span>
                    <span style={{ fontSize: 12, fontFamily: mono, color: T.textDim }}>Total: <strong style={{ color: T.orange }}>{grandTotal.toLocaleString()}</strong> units</span>
                  </div>
                  <div style={{ maxHeight: 500, overflowY: "auto" }}>
                    <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, fontFamily: mono }}>
                      <thead>
                        <tr style={{ background: T.bg, position: "sticky", top: 0, zIndex: 1 }}>
                          <th style={{ padding: "10px 16px", textAlign: "left", color: T.textDim, fontSize: 10, letterSpacing: 1, borderBottom: `1px solid ${T.border}` }}>SKU</th>
                          <th style={{ padding: "10px 12px", textAlign: "right", color: T.blue, fontSize: 10, letterSpacing: 1, borderBottom: `1px solid ${T.border}` }}>WH1</th>
                          <th style={{ padding: "10px 12px", textAlign: "right", color: T.green, fontSize: 10, letterSpacing: 1, borderBottom: `1px solid ${T.border}` }}>WH2</th>
                          <th style={{ padding: "10px 12px", textAlign: "right", color: T.amber, fontSize: 10, letterSpacing: 1, borderBottom: `1px solid ${T.border}` }}>WH3</th>
                          <th style={{ padding: "10px 12px", textAlign: "right", color: T.purple, fontSize: 10, letterSpacing: 1, borderBottom: `1px solid ${T.border}` }}>TOPS</th>
                          <th style={{ padding: "10px 16px", textAlign: "right", color: T.text, fontSize: 10, letterSpacing: 1, borderBottom: `1px solid ${T.border}` }}>TOTAL</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.slice(0, 200).map(r => (
                          <tr key={r.sku} style={{ borderBottom: `1px solid ${T.border}22` }}
                            onClick={() => { const m = (inventory.materials || []).find(x => x.sku === r.sku); if (m) setSelectedItem(m); }}>
                            <td style={{ padding: "8px 16px", color: T.text, cursor: "pointer" }}>{r.sku}</td>
                            <td style={{ padding: "8px 12px", textAlign: "right", color: r.WH1 > 0 ? T.blue : T.textDim }}>{r.WH1 || '—'}</td>
                            <td style={{ padding: "8px 12px", textAlign: "right", color: r.WH2 > 0 ? T.green : T.textDim }}>{r.WH2 || '—'}</td>
                            <td style={{ padding: "8px 12px", textAlign: "right", color: r.WH3 > 0 ? T.amber : T.textDim }}>{r.WH3 || '—'}</td>
                            <td style={{ padding: "8px 12px", textAlign: "right", color: r.TOPS > 0 ? T.purple : T.textDim }}>{r.TOPS || '—'}</td>
                            <td style={{ padding: "8px 16px", textAlign: "right", fontWeight: 700, color: T.text }}>{r.total.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {rows.length > 200 && <div style={{ padding: 12, textAlign: "center", color: T.textDim, fontSize: 11 }}>Showing first 200 of {rows.length} SKUs</div>}
                  </div>
                </Card>
              );
            })() : (
              <Card style={{ padding: 40, textAlign: "center" }}>
                <div style={{ color: T.textMuted }}>Loading warehouse stock data...</div>
              </Card>
            )}
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

        {sub === "consumption" && (() => {
          const fetchConsumption = (f, t) => {
            setConsumeLoading(true);
            const params = new URLSearchParams();
            if (f) params.set('from', f);
            if (t) params.set('to', t);
            fetch(`${ovenServerUrl}/api/usage/consumption?${params}`).then(r => r.json()).then(d => { setConsumeData(d); setConsumeLoading(false); }).catch(() => setConsumeLoading(false));
          };
          if (!consumeData && !consumeLoading) fetchConsumption();

          const skus = consumeData?.skus || [];
          const daily = consumeData?.daily || [];
          const sm = consumeData?.summary || {};
          const maxDaily = Math.max(1, ...daily.map(d => Math.max(d.looker, d.itempath)));

          // Filter + sort
          let filtered = skus;
          if (consumeSearch) {
            const q = consumeSearch.toLowerCase();
            filtered = filtered.filter(s => s.sku.toLowerCase().includes(q));
          }
          filtered = [...filtered].sort((a, b) => {
            if (consumeSort === 'looker') return b.looker_lenses - a.looker_lenses;
            if (consumeSort === 'itempath') return b.itempath_qty - a.itempath_qty;
            if (consumeSort === 'variance') return Math.abs(b.variance) - Math.abs(a.variance);
            return 0;
          });

          const applyFilter = (preset) => {
            setConsumeFilter(preset);
            setConsumeData(null);
            const today = new Date().toISOString().slice(0, 10);
            const year = new Date().getFullYear();
            if (preset === 'ytd') fetchConsumption(`${year}-01-01`, today);
            else if (preset === '30') { const d = new Date(); d.setDate(d.getDate() - 30); fetchConsumption(d.toISOString().slice(0, 10), today); }
            else if (preset === '7') { const d = new Date(); d.setDate(d.getDate() - 7); fetchConsumption(d.toISOString().slice(0, 10), today); }
            else if (preset === 'month') { const d = new Date(); fetchConsumption(`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`, today); }
          };

          return (
            <div>
              {/* Header */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Consumption — Kardex vs NetSuite</h3>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {[{id:'ytd',label:'YTD'},{id:'month',label:'This Month'},{id:'30',label:'30d'},{id:'7',label:'7d'},{id:'custom',label:'Custom'}].map(p => (
                    <button key={p.id} onClick={() => p.id !== 'custom' ? applyFilter(p.id) : setConsumeFilter('custom')} style={{
                      padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                      background: consumeFilter === p.id ? T.blue : 'transparent', color: consumeFilter === p.id ? '#fff' : T.textMuted,
                      border: `1px solid ${consumeFilter === p.id ? T.blue : T.border}`
                    }}>{p.label}</button>
                  ))}
                </div>
              </div>

              {/* Custom date range */}
              {consumeFilter === 'custom' && (
                <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
                  <input type="date" value={consumeFrom} onChange={e => setConsumeFrom(e.target.value)}
                    style={{ padding: "8px 10px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }} />
                  <span style={{ color: T.textDim }}>to</span>
                  <input type="date" value={consumeTo} onChange={e => setConsumeTo(e.target.value)}
                    style={{ padding: "8px 10px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }} />
                  <button onClick={() => { setConsumeData(null); fetchConsumption(consumeFrom, consumeTo); }}
                    style={{ background: T.blue, border: "none", borderRadius: 6, padding: "8px 16px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                    Apply
                  </button>
                </div>
              )}

              {/* KPIs */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(5,1fr)", gap: 10, marginBottom: 20 }}>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.green}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>KARDEX (ITEMPATH)</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.green, fontFamily: mono }}>{(sm.itempath?.total || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{sm.itempath?.skus || 0} SKUs · {sm.itempath?.days || 0} days</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>
                    Lenses: {(sm.itempath?.lenses || 0).toLocaleString()} · Frames: {(sm.itempath?.frames || 0).toLocaleString()}
                  </div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>NETSUITE (LOOKER)</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.blue, fontFamily: mono }}>{(sm.kardex?.total || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{sm.kardex?.skus || 0} SKUs · {sm.kardex?.days || 0} days</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>
                    Lenses: {(sm.kardex?.lenses || 0).toLocaleString()} · Frames: {(sm.kardex?.frames || 0).toLocaleString()}
                  </div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>BREAKAGES</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.red, fontFamily: mono }}>{(sm.kardex?.breakages || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{sm.kardex?.total > 0 ? (sm.kardex.breakages / sm.kardex.total * 100).toFixed(1) : 0}% rate</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>VARIANCE</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: Math.abs(sm.variance || 0) < 500 ? T.green : T.amber, fontFamily: mono }}>
                    {(sm.variance || 0) > 0 ? '+' : ''}{(sm.variance || 0).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>Kardex — NetSuite</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.textDim}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>PERIOD</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: mono }}>{sm.from}</div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, fontFamily: mono }}>{sm.to}</div>
                </Card>
              </div>

              {/* Daily chart */}
              {daily.length > 0 && (
                <Card style={{ marginBottom: 20 }}>
                  <SectionHeader right={`${daily.length} days`}>Daily Consumption</SectionHeader>
                  <div style={{ display: "flex", flexDirection: "column", gap: 2, maxHeight: 400, overflowY: "auto" }}>
                    {daily.map(d => {
                      const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
                      const lkPct = Math.round((d.looker / maxDaily) * 100);
                      const ipPct = Math.round((d.itempath / maxDaily) * 100);
                      const isToday = d.date === new Date().toISOString().slice(0, 10);
                      return (
                        <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '3px 12px', background: isToday ? `${T.blue}12` : T.bg, borderRadius: 4, border: `1px solid ${isToday ? T.blue : T.border}` }}>
                          <div style={{ width: 95, fontSize: 10, fontWeight: isToday ? 700 : 500, color: isToday ? T.blue : T.textMuted, fontFamily: mono }}>{isToday ? 'TODAY' : dayName}</div>
                          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                            <div style={{ height: 4, background: T.surface, borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${ipPct}%`, height: '100%', background: T.green, borderRadius: 2, opacity: 0.7 }} />
                            </div>
                            <div style={{ height: 4, background: T.surface, borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${lkPct}%`, height: '100%', background: T.blue, borderRadius: 2, opacity: 0.7 }} />
                            </div>
                          </div>
                          <div style={{ minWidth: 50, textAlign: 'right', fontSize: 11, fontWeight: 600, color: T.green, fontFamily: mono }}>{d.itempath > 0 ? d.itempath.toLocaleString() : '—'}</div>
                          <div style={{ minWidth: 50, textAlign: 'right', fontSize: 11, fontWeight: 600, color: T.blue, fontFamily: mono }}>{d.looker.toLocaleString()}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 16, padding: "6px 12px", borderTop: `1px solid ${T.border}`, marginTop: 4, fontSize: 10, fontFamily: mono, color: T.textDim }}>
                    <span><span style={{ display: "inline-block", width: 10, height: 4, background: T.green, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />Kardex (ItemPath picks)</span>
                    <span><span style={{ display: "inline-block", width: 10, height: 4, background: T.blue, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />NetSuite (Looker — sent from lab)</span>
                  </div>
                </Card>
              )}

              {/* SKU comparison table */}
              <Card>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "12px 16px", borderBottom: `1px solid ${T.border}` }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{ fontSize: 12, fontWeight: 700, color: T.text, fontFamily: mono }}>{filtered.length} SKUs</span>
                    <input type="text" placeholder="Search SKU..." value={consumeSearch} onChange={e => setConsumeSearch(e.target.value)}
                      style={{ padding: "6px 10px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 11, fontFamily: mono, width: 180 }} />
                  </div>
                  <div style={{ display: "flex", gap: 4 }}>
                    {[{id:'looker',label:'By Looker'},{id:'itempath',label:'By ItemPath'},{id:'variance',label:'By Variance'}].map(s => (
                      <button key={s.id} onClick={() => setConsumeSort(s.id)} style={{
                        padding: "5px 10px", borderRadius: 5, fontSize: 10, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                        background: consumeSort === s.id ? T.blue : 'transparent', color: consumeSort === s.id ? '#fff' : T.textMuted,
                        border: `1px solid ${consumeSort === s.id ? T.blue : T.border}`
                      }}>{s.label}</button>
                    ))}
                  </div>
                </div>
                <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: mono }}>
                    <thead>
                      <tr style={{ background: T.bg, position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SKU</th>
                        <th style={{ padding: '8px 12px', textAlign: 'center', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>TYPE</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.green, borderBottom: `1px solid ${T.border}` }}>KARDEX (IP)</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.blue, borderBottom: `1px solid ${T.border}` }}>NETSUITE (LK)</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.red, borderBottom: `1px solid ${T.border}` }}>BREAKAGE</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.amber, borderBottom: `1px solid ${T.border}` }}>VARIANCE</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 200).map(s => (
                        <tr key={s.sku} style={{ borderBottom: `1px solid ${T.border}22` }}>
                          <td style={{ padding: '6px 12px', fontWeight: 600, color: T.text }}>{s.sku}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'center' }}>
                            <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700, fontFamily: mono,
                              background: s.type === 'frame' ? `${T.purple || '#9b6ee0'}20` : `${T.cyan}20`,
                              color: s.type === 'frame' ? (T.purple || '#9b6ee0') : T.cyan
                            }}>{s.type === 'frame' ? 'FRAME' : 'LENS'}</span>
                          </td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: s.itempath_qty > 0 ? T.green : T.textDim }}>{s.itempath_qty > 0 ? s.itempath_qty.toLocaleString() : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: s.kardex_total > 0 ? T.blue : T.textDim }}>{s.kardex_total > 0 ? s.kardex_total.toLocaleString() : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: s.looker_breakages > 0 ? T.red : T.textDim }}>{s.looker_breakages > 0 ? s.looker_breakages.toLocaleString() : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 700, color: s.variance === 0 ? T.textDim : Math.abs(s.variance) > 100 ? T.red : T.amber }}>
                            {s.variance !== 0 ? (s.variance > 0 ? '+' : '') + s.variance.toLocaleString() : '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {filtered.length === 0 && !consumeLoading && <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No consumption data for this period</div>}
                  {consumeLoading && <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>Loading...</div>}
                </div>
                {filtered.length > 200 && <div style={{ padding: 8, textAlign: "center", fontSize: 10, color: T.textDim }}>Showing 200 of {filtered.length}</div>}
              </Card>
            </div>
          );
        })()}

        {sub === "lens-usage" && (() => {
          // Fetch on mount / days change
          if (!usageData || usageData._days !== usageDays) {
            fetch(`${ovenServerUrl}/api/usage/daily?days=${usageDays}`).then(r => r.json()).then(d => { d._days = usageDays; setUsageData(d); }).catch(() => {});
          }
          const daily = usageData?.dailyTotals || [];
          const skus = usageData?.skuComparison || [];
          const lk = usageData?.summary?.looker || {};
          const ip = usageData?.summary?.itempath || {};
          const maxDay = Math.max(1, ...daily.map(d => Math.max(d.looker_lenses, d.itempath_qty)));

          return (
            <div>
              {/* Header + period selector */}
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Daily Usage — Looker vs ItemPath</h3>
                <div style={{ display: "flex", gap: 4 }}>
                  {[14, 30, 60].map(d => (
                    <button key={d} onClick={() => { setUsageData(null); setUsageDays(d); }} style={{
                      padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                      background: usageDays === d ? T.blue : 'transparent', color: usageDays === d ? '#fff' : T.textMuted,
                      border: `1px solid ${usageDays === d ? T.blue : T.border}`
                    }}>{d}d</button>
                  ))}
                </div>
              </div>

              {/* KPIs */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>LOOKER — SENT FROM LAB</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: T.blue, fontFamily: mono }}>{(lk.totalLenses || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{lk.avgDaily || 0}/day · {lk.days || 0} days · {lk.skus || 0} OPCs</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>BREAKAGES (LOOKER)</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: T.red, fontFamily: mono }}>{(lk.totalBreakages || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{lk.breakageRate || 0}% rate</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.green}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>ITEMPATH — PICKED</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: T.green, fontFamily: mono }}>{(ip.totalQty || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{ip.totalPicks || 0} picks · {ip.days || 0} days · {ip.skus || 0} SKUs</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>VARIANCE</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: Math.abs((ip.totalQty || 0) - (lk.totalLenses || 0)) < 100 ? T.green : T.amber, fontFamily: mono }}>
                    {((ip.totalQty || 0) - (lk.totalLenses || 0)) > 0 ? '+' : ''}{((ip.totalQty || 0) - (lk.totalLenses || 0)).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>IP picked - Looker sent</div>
                </Card>
              </div>

              {/* Daily chart — side by side bars */}
              <Card style={{ marginBottom: 20 }}>
                <SectionHeader right={`${daily.length} days`}>Daily Consumption</SectionHeader>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {daily.map(d => {
                    const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
                    const lkPct = Math.round((d.looker_lenses / maxDay) * 100);
                    const ipPct = Math.round((d.itempath_qty / maxDay) * 100);
                    const isToday = d.date === new Date().toISOString().slice(0, 10);
                    const isWeekend = [0, 6].includes(new Date(d.date + 'T12:00:00').getDay());
                    return (
                      <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: isToday ? `${T.blue}12` : T.bg, borderRadius: 5, border: `1px solid ${isToday ? T.blue : T.border}` }}>
                        <div style={{ width: 100, fontSize: 11, fontWeight: isToday ? 700 : 500, color: isToday ? T.blue : isWeekend ? T.textDim : T.textMuted, fontFamily: mono }}>{isToday ? 'TODAY' : dayName}</div>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <div style={{ height: 5, background: T.surface, borderRadius: 3, overflow: 'hidden', position: 'relative' }}>
                            <div style={{ width: `${lkPct}%`, height: '100%', background: T.blue, borderRadius: 3, opacity: 0.7 }} />
                            {d.looker_breakages > 0 && <div style={{ position: 'absolute', right: 0, top: 0, width: `${Math.max(2, Math.round((d.looker_breakages / maxDay) * 100))}%`, height: '100%', background: T.red, borderRadius: 3, opacity: 0.9 }} />}
                          </div>
                          <div style={{ height: 5, background: T.surface, borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${ipPct}%`, height: '100%', background: T.green, borderRadius: 3, opacity: 0.7 }} />
                          </div>
                        </div>
                        <div style={{ minWidth: 55, textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.blue, fontFamily: mono }}>{d.looker_lenses.toLocaleString()}</div>
                        <div style={{ minWidth: 40, textAlign: 'right', fontSize: 10, color: d.looker_breakages > 0 ? T.red : T.textDim, fontFamily: mono }}>{d.looker_breakages > 0 ? `-${d.looker_breakages}` : ''}</div>
                        <div style={{ width: 1, height: 14, background: T.border }} />
                        <div style={{ minWidth: 55, textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.green, fontFamily: mono }}>{d.itempath_qty > 0 ? d.itempath_qty.toLocaleString() : '—'}</div>
                      </div>
                    );
                  })}
                </div>
                {daily.length === 0 && <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>Loading usage data...</div>}
                <div style={{ display: "flex", gap: 16, padding: "8px 12px", borderTop: `1px solid ${T.border}`, marginTop: 6, fontSize: 10, fontFamily: mono, color: T.textDim }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 5, background: T.blue, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />Looker (sent from lab)</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 5, background: T.green, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />ItemPath (picked)</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 5, background: T.red, borderRadius: 2, marginRight: 4, opacity: 0.9 }} />Breakages</span>
                </div>
              </Card>

              {/* SKU comparison table */}
              {skus.length > 0 && (
                <Card>
                  <SectionHeader right={`${skus.length} SKUs`}>Usage by SKU — Looker vs ItemPath</SectionHeader>
                  <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: mono }}>
                      <thead>
                        <tr style={{ background: T.bg, position: 'sticky', top: 0, zIndex: 1 }}>
                          <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SKU / OPC</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.blue, borderBottom: `1px solid ${T.border}` }}>LOOKER SENT</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.red, borderBottom: `1px solid ${T.border}` }}>BREAKAGE</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.green, borderBottom: `1px solid ${T.border}` }}>IP PICKED</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.amber, borderBottom: `1px solid ${T.border}` }}>VARIANCE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skus.slice(0, 100).map((s, i) => (
                          <tr key={s.sku} style={{ borderBottom: `1px solid ${T.border}22` }}>
                            <td style={{ padding: '7px 12px', fontWeight: 600, color: T.text }}>{s.sku}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: s.looker_lenses > 0 ? T.blue : T.textDim }}>{s.looker_lenses > 0 ? s.looker_lenses.toLocaleString() : '—'}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: s.looker_breakages > 0 ? T.red : T.textDim }}>{s.looker_breakages > 0 ? s.looker_breakages.toLocaleString() : '—'}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: s.itempath_qty > 0 ? T.green : T.textDim }}>{s.itempath_qty > 0 ? s.itempath_qty.toLocaleString() : '—'}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', fontWeight: 700, color: s.variance === 0 ? T.textDim : Math.abs(s.variance) > 50 ? T.red : T.amber }}>
                              {s.variance !== 0 ? (s.variance > 0 ? '+' : '') + s.variance.toLocaleString() : '—'}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              )}
            </div>
          );
        })()}

        {sub === "tops" && (() => {
          const uploadTopsFile = async (file) => {
            setTopsUploading(true);
            setTopsError(null);
            setTopsResult(null);
            try {
              const content = await file.text();
              const resp = await fetch(`${ovenServerUrl}/api/inventory/tops/upload`, {
                method: 'POST',
                headers: { 'Content-Type': 'text/csv', 'X-Filename': file.name },
                body: content
              });
              const data = await resp.json();
              if (resp.ok) {
                setTopsResult(data);
                const updated = await fetch(`${ovenServerUrl}/api/inventory/tops`).then(r => r.json());
                setTopsData(updated);
              } else {
                setTopsError(data.error || 'Upload failed');
              }
            } catch (e) { setTopsError(e.message); }
            setTopsUploading(false);
          };
          const handleTopsDrop = (e) => { e.preventDefault(); setTopsDragOver(false); const f = e.dataTransfer?.files?.[0]; if (f) uploadTopsFile(f); };
          const handleTopsSelect = (e) => { const f = e.target.files?.[0]; if (f) uploadTopsFile(f); };
          const items = topsData?.items || [];
          const filtered = topsSearch ? items.filter(i => i.sku.toLowerCase().includes(topsSearch.toLowerCase())) : items;

          return (
            <div>
              {/* Upload Area */}
              <Card
                onDragOver={e => { e.preventDefault(); setTopsDragOver(true); }}
                onDragLeave={() => setTopsDragOver(false)}
                onDrop={handleTopsDrop}
                onClick={() => topsFileRef.current?.click()}
                style={{ padding: 32, textAlign: 'center', cursor: 'pointer', border: `2px dashed ${topsDragOver ? T.blue : T.border}`, background: topsDragOver ? `${T.blue}10` : T.card, transition: 'all 0.2s', marginBottom: 16 }}
              >
                <input ref={topsFileRef} type="file" accept=".csv" onChange={handleTopsSelect} style={{ display: 'none' }} />
                {topsUploading ? (
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Uploading...</div>
                ) : (
                  <>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>+</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Drop TOPS CSV here</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>or click to browse — CSV with SKU and QTY columns</div>
                  </>
                )}
              </Card>

              {topsError && (
                <Card style={{ background: `${T.red}10`, border: `1px solid ${T.red}40`, marginBottom: 16, padding: 16 }}>
                  <span style={{ color: T.red, fontSize: 13, fontWeight: 600 }}>{topsError}</span>
                </Card>
              )}

              {topsResult && (
                <Card style={{ background: `${T.green}10`, border: `1px solid ${T.green}40`, marginBottom: 16, padding: 16 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{ fontSize: 18, color: T.green }}>OK</span>
                    <div>
                      <div style={{ fontSize: 13, fontWeight: 700, color: T.green }}>{topsResult.rowCount} SKUs uploaded — {topsResult.totalQty?.toLocaleString()} total units</div>
                      <div style={{ fontSize: 11, color: T.textMuted }}>{topsResult.filename}</div>
                    </div>
                  </div>
                </Card>
              )}

              {/* KPI Cards */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, marginBottom: 16 }}>
                <Card style={{ padding: 16, textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: T.text, fontFamily: mono }}>{topsData?.count || 0}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono, marginTop: 4 }}>UNIQUE SKUS</div>
                </Card>
                <Card style={{ padding: 16, textAlign: 'center' }}>
                  <div style={{ fontSize: 28, fontWeight: 700, color: T.blue, fontFamily: mono }}>{(topsData?.totalQty || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono, marginTop: 4 }}>TOTAL UNITS</div>
                </Card>
                <Card style={{ padding: 16, textAlign: 'center' }}>
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{topsData?.lastUpload ? new Date(topsData.lastUpload.uploaded_at).toLocaleString() : 'Never'}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono, marginTop: 4 }}>LAST UPLOAD</div>
                </Card>
              </div>

              {/* Data Table */}
              {items.length > 0 && (
                <Card>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <SectionHeader style={{ margin: 0 }}>TOPS Inventory</SectionHeader>
                    <input
                      type="text" placeholder="Search SKU..."
                      value={topsSearch} onChange={e => setTopsSearch(e.target.value)}
                      style={{ padding: '6px 12px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono, width: 200 }}
                    />
                  </div>
                  <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead>
                        <tr>
                          <th style={{ fontFamily: mono, fontSize: 9, color: T.textDim, letterSpacing: 1.5, textAlign: 'left', padding: '9px 12px', borderBottom: `2px solid ${T.border}`, textTransform: 'uppercase' }}>SKU</th>
                          <th style={{ fontFamily: mono, fontSize: 9, color: T.textDim, letterSpacing: 1.5, textAlign: 'right', padding: '9px 12px', borderBottom: `2px solid ${T.border}`, textTransform: 'uppercase' }}>QTY</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((item, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                            <td style={{ padding: '8px 12px', fontFamily: mono, fontSize: 12, color: T.text }}>{item.sku}</td>
                            <td style={{ padding: '8px 12px', fontFamily: mono, fontSize: 12, color: T.text, textAlign: 'right' }}>{item.qty.toLocaleString()}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ padding: '8px 12px', fontSize: 10, color: T.textDim, borderTop: `1px solid ${T.border}` }}>
                    Showing {filtered.length} of {items.length} SKUs
                  </div>
                </Card>
              )}
            </div>
          );
        })()}

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
