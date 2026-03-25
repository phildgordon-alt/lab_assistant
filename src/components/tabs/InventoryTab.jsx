import { useState, useEffect, useMemo, useRef } from 'react';
import { T, mono } from '../../constants';
import { Card, SectionHeader } from '../shared';

// CSV export helper
function downloadCSV(filename, headers, rows) {
  const csv = [headers.join(','), ...rows.map(r => headers.map(h => {
    const v = r[h] ?? '';
    return String(v).includes(',') ? `"${v}"` : v;
  }).join(','))].join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

const ExportBtn = ({ onClick, label = "Export CSV" }) => (
  <button onClick={onClick} style={{
    background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6,
    padding: '6px 14px', color: T.textMuted, fontSize: 11, fontWeight: 600,
    fontFamily: "'JetBrains Mono',monospace", cursor: 'pointer'
  }}>{label}</button>
);

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
  const [sub, setSub] = useState("warehouses");
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
  const [poData, setPoData] = useState(null);
  const [poFilter, setPoFilter] = useState("all");
  const [poSearch, setPoSearch] = useState("");
  const [poExpanded, setPoExpanded] = useState(null);
  const [inboundData, setInboundData] = useState(null);
  const [inboundSearch, setInboundSearch] = useState("");
  const [lensIntelData, setLensIntelData] = useState(null);
  const [lensIntelFilter, setLensIntelFilter] = useState("all");
  const [lensIntelSearch, setLensIntelSearch] = useState("");
  const [lensIntelDetail, setLensIntelDetail] = useState(null);
  const [lensSettings, setLensSettings] = useState(false);
  const [lensDefaults, setLensDefaults] = useState({ manufacturing_weeks: 13, transit_weeks: 4, fda_hold_weeks: 2, safety_stock_weeks: 4 });
  const [lensSaving, setLensSaving] = useState(false);
  const [npiData, setNpiData] = useState(null);
  const [npiOpen, setNpiOpen] = useState(false);
  const [pipelineData, setPipelineData] = useState(null);
  const [pipelineDays, setPipelineDays] = useState(30);
  const [pipelineDetail, setPipelineDetail] = useState(null);
  const [pipelineDetailDate, setPipelineDetailDate] = useState(null);
  const [pipelineDetailSearch, setPipelineDetailSearch] = useState("");
  const [compareData, setCompareData] = useState(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareFilter, setCompareFilter] = useState("all");
  const [compareSearch, setCompareSearch] = useState("");

  // Lazy-load: only fetch data needed for the active sub-tab
  const fetchedRef = useRef({});
  useEffect(() => {
    if (!ovenServerUrl) return;
    const fetchFor = async (tab) => {
      try {
        if (tab === 'warehouses' || tab === 'picks') {
          // Activity + Picks: need picks data
          if (!fetchedRef.current.picks) {
            const [picksResp, alertsResp] = await Promise.all([
              fetch(`${ovenServerUrl}/api/inventory/picks`).then(r => r.json()),
              fetch(`${ovenServerUrl}/api/inventory/alerts`).then(r => r.json()),
            ]);
            setPicks(picksResp);
            setAlerts(alertsResp);
            fetchedRef.current.picks = true;
          }
        }
        if (tab === 'warehouse-stock') {
          if (!fetchedRef.current.whStock) {
            const [whResp, catResp] = await Promise.all([
              fetch(`${ovenServerUrl}/api/inventory/warehouse-stock`).then(r => r.json()).catch(() => null),
              fetch(`${ovenServerUrl}/api/netsuite/categories`).then(r => r.json()).catch(() => ({})),
            ]);
            if (whResp) setWhStock(whResp);
            setSkuCategories(catResp);
            fetchedRef.current.whStock = true;
          }
        }
        if (tab === 'inventory') {
          if (!fetchedRef.current.inventory) {
            const [invResp, vlmsResp, alertsResp, topsResp, catResp] = await Promise.all([
              fetch(`${ovenServerUrl}/api/inventory`).then(r => r.json()),
              fetch(`${ovenServerUrl}/api/inventory/vlms`).then(r => r.json()),
              fetch(`${ovenServerUrl}/api/inventory/alerts`).then(r => r.json()),
              fetch(`${ovenServerUrl}/api/inventory/tops`).then(r => r.json()).catch(() => null),
              fetch(`${ovenServerUrl}/api/netsuite/categories`).then(r => r.json()).catch(() => ({})),
            ]);
            setInventory(invResp);
            setVlms(vlmsResp);
            setAlerts(alertsResp);
            if (topsResp) setTopsData(topsResp);
            setSkuCategories(catResp);
            fetchedRef.current.inventory = true;
          }
        }
        if (tab === 'reconciliation') {
          if (!fetchedRef.current.recon) {
            const reconResp = await fetch(`${ovenServerUrl}/api/netsuite/reconcile`).then(r => r.json()).catch(() => null);
            if (reconResp) setReconData(reconResp);
            fetchedRef.current.recon = true;
          }
        }
        if (tab === 'binning') {
          if (!fetchedRef.current.binning) {
            const binResp = await fetch(`${ovenServerUrl}/api/inventory/binning/summary`).then(r => r.json()).catch(() => null);
            if (binResp) setBinningData(binResp);
            fetchedRef.current.binning = true;
          }
        }
        if (tab === 'tops') {
          if (!fetchedRef.current.tops) {
            fetch(`${ovenServerUrl}/api/inventory/tops`).then(r => r.json()).then(setTopsData).catch(() => {});
            fetchedRef.current.tops = true;
          }
        }
        if (tab === 'alerts') {
          if (!fetchedRef.current.alerts) {
            const alertsResp = await fetch(`${ovenServerUrl}/api/inventory/alerts`).then(r => r.json());
            setAlerts(alertsResp);
            fetchedRef.current.alerts = true;
          }
        }
        setLoading(false);
      } catch (e) {
        console.error('[Inventory] Fetch error:', e);
        setLoading(false);
      }
    };
    fetchFor(sub);
  }, [ovenServerUrl, sub]);

  // Filter and sort materials
  const [filterCategory, setFilterCategory] = useState("All");

  // Merge ItemPath materials + TOPS into one list
  const allInventory = useMemo(() => {
    const items = (inventory.materials || []).map(m => ({ ...m, category: skuCategories[m.sku] || 'Other' }));
    // Add TOPS items (not already in ItemPath)
    const ipSkus = new Set(items.map(m => m.sku));
    for (const t of (topsData?.items || [])) {
      if (!ipSkus.has(t.upc || t.sku)) {
        items.push({ sku: t.upc || t.sku, name: t.model_name ? `${t.model_name} ${t.top_code || ''}`.trim() : t.sku, qty: t.qty, category: 'Tops', coatingType: null, location: t.location || 'TOPS' });
      }
    }
    return items;
  }, [inventory.materials, topsData, skuCategories]);

  const filteredMaterials = useMemo(() => {
    let items = [...allInventory];
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      items = items.filter(m =>
        m.sku?.toLowerCase().includes(q) ||
        m.name?.toLowerCase().includes(q) ||
        m.coatingType?.toLowerCase().includes(q) ||
        m.category?.toLowerCase().includes(q) ||
        m.location?.toLowerCase().includes(q)
      );
    }
    if (filterCoating !== "All") {
      items = items.filter(m => m.coatingType === filterCoating);
    }
    if (filterCategory !== "All") {
      items = items.filter(m => m.category === filterCategory);
    }
    items.sort((a, b) => {
      const av = a[sortCol], bv = b[sortCol];
      if (typeof av === "number" && typeof bv === "number") return sortDir === "asc" ? av - bv : bv - av;
      return sortDir === "asc" ? String(av || "").localeCompare(String(bv || "")) : String(bv || "").localeCompare(String(av || ""));
    });
    return items;
  }, [allInventory, searchQuery, filterCoating, filterCategory, sortCol, sortDir]);

  // Get unique coating types for filter
  const coatingTypes = useMemo(() => {
    const types = new Set((inventory.materials || []).map(m => m.coatingType).filter(Boolean));
    return ["All", ...Array.from(types).sort()];
  }, [inventory.materials]);

  // Stats
  const totalSKUs = allInventory.length;
  const totalQty = allInventory.reduce((s, m) => s + (m.qty || 0), 0);
  const outOfStock = allInventory.filter(m => m.qty === 0).length;
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
      {[{ id: "warehouses", label: "Activity" }, { id: "picks", label: "Picks" }, { id: "warehouse-stock", label: "Warehouse Stock" }, { id: "lens-intel", label: "Lens Intelligence" }, { id: "inventory", label: "Inventory" }, { id: "reconciliation", label: "Reconciliation" }, { id: "consumption", label: "Consumption" }, { id: "pipeline", label: "Jobs Pipeline" }, { id: "lens-usage", label: "Transactions" }, { id: "inbound", label: "Inbound" }, { id: "pos", label: "Purchase Orders" }, { id: "tops", label: "TOPS Count" }, { id: "binning", label: "Binning Intelligence" }, { id: "alerts", label: "Alerts" }, { id: "search", label: "Lens Search" }].map(t => (
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
            <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
              <input type="text" placeholder="Search SKU, name, category..." value={searchQuery} onChange={e => setSearchQuery(e.target.value)}
                style={{ flex: 1, maxWidth: 300, padding: "8px 12px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }} />
              {['All', 'Lenses', 'Frames', 'Tops', 'Other'].map(c => (
                <button key={c} onClick={() => setFilterCategory(c)} style={{
                  padding: "7px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                  background: filterCategory === c ? T.blue : 'transparent', color: filterCategory === c ? '#fff' : T.textMuted,
                  border: `1px solid ${filterCategory === c ? T.blue : T.border}`
                }}>{c}</button>
              ))}
              <select value={filterCoating} onChange={e => setFilterCoating(e.target.value)}
                style={{ padding: "7px 12px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 11, fontFamily: mono }}>
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
                    <SHdr col="category">Category</SHdr>
                    <SHdr col="name">Description</SHdr>
                    <SHdr col="coatingType">Coating</SHdr>
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
                        <td style={{ padding: "10px 12px" }}>
                          <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700, fontFamily: mono,
                            background: m.category === 'Lenses' ? `${T.cyan}20` : m.category === 'Frames' ? `${T.purple || '#9b6ee0'}20` : m.category === 'Tops' ? `${T.amber}20` : `${T.textDim}20`,
                            color: m.category === 'Lenses' ? T.cyan : m.category === 'Frames' ? (T.purple || '#9b6ee0') : m.category === 'Tops' ? T.amber : T.textDim
                          }}>{m.category || 'Other'}</span>
                        </td>
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
                  <ExportBtn onClick={() => {
                    const rows = reconData.discrepancies || [];
                    downloadCSV('reconciliation.csv', ['sku','name','category','wh1','wh2','wh3','itempath','netsuite','diff','severity'], rows);
                  }} />
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
          const maxDaily = Math.max(1, ...daily.map(d => Math.max(d.kardex || 0, d.netsuite || 0)));

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
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Consumption — Kardex / ItemPath vs DVI / NetSuite</h3>
                <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
                  {[{id:'ytd',label:'YTD'},{id:'month',label:'This Month'},{id:'30',label:'30d'},{id:'7',label:'7d'},{id:'custom',label:'Custom'}].map(p => (
                    <button key={p.id} onClick={() => p.id !== 'custom' ? applyFilter(p.id) : setConsumeFilter('custom')} style={{
                      padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                      background: consumeFilter === p.id ? T.blue : 'transparent', color: consumeFilter === p.id ? '#fff' : T.textMuted,
                      border: `1px solid ${consumeFilter === p.id ? T.blue : T.border}`
                    }}>{p.label}</button>
                  ))}
                  <ExportBtn onClick={() => {
                    const skuRows = consumeData?.skus || [];
                    downloadCSV('consumption.csv', ['sku','type','kardex_qty','netsuite_qty','breakages','variance'], skuRows);
                  }} />
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
              <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 10, marginBottom: 10 }}>
                <Card style={{ padding: 14, borderLeft: `4px solid ${T.green}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1, marginBottom: 6 }}>KARDEX / ITEMPATH</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(2,1fr)", gap: 8 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: T.green, fontFamily: mono }}>{(sm.kardex?.jobs || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>JOBS</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: T.green, fontFamily: mono }}>{(sm.kardex?.total || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>TOTAL UNITS</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, marginTop: 6, display: "flex", gap: 12 }}>
                    <span>Lenses: {(sm.kardex?.lenses || 0).toLocaleString()}</span>
                    <span>Frames: {(sm.kardex?.frames || 0).toLocaleString()}</span>
                    <span>{sm.kardex?.skus || 0} SKUs · {sm.kardex?.days || 0} days</span>
                  </div>
                </Card>
                <Card style={{ padding: 14, borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1, marginBottom: 6 }}>DVI / NETSUITE</div>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 8 }}>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: T.blue, fontFamily: mono }}>{(sm.netsuite?.jobs || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>JOBS</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: T.blue, fontFamily: mono }}>{(sm.netsuite?.total || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>TOTAL UNITS</div>
                    </div>
                    <div style={{ textAlign: "center" }}>
                      <div style={{ fontSize: 22, fontWeight: 800, color: T.red, fontFamily: mono }}>{(sm.netsuite?.breakages || 0).toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>BREAKAGES (DVI)</div>
                    </div>
                  </div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, marginTop: 6, display: "flex", gap: 12 }}>
                    <span>Lenses: {(sm.netsuite?.lenses || 0).toLocaleString()}</span>
                    <span>Frames: {(sm.netsuite?.frames || 0).toLocaleString()}</span>
                    <span>{sm.netsuite?.skus || 0} SKUs · {sm.netsuite?.days || 0} days</span>
                  </div>
                </Card>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 20 }}>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>UNIT VARIANCE</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: Math.abs(sm.variance || 0) < 500 ? T.green : T.amber, fontFamily: mono }}>
                    {(sm.variance || 0) > 0 ? '+' : ''}{(sm.variance || 0).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>Kardex — NetSuite</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>JOB VARIANCE</div>
                  <div style={{ fontSize: 22, fontWeight: 800, color: Math.abs((sm.kardex?.jobs || 0) - (sm.netsuite?.jobs || 0)) < 100 ? T.green : T.amber, fontFamily: mono }}>
                    {((sm.kardex?.jobs || 0) - (sm.netsuite?.jobs || 0)) > 0 ? '+' : ''}{((sm.kardex?.jobs || 0) - (sm.netsuite?.jobs || 0)).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>Kardex jobs — DVI jobs</div>
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
                              <div style={{ width: `${Math.round(((d.kardex || 0) / maxDaily) * 100)}%`, height: '100%', background: T.green, borderRadius: 2, opacity: 0.7 }} />
                            </div>
                            <div style={{ height: 4, background: T.surface, borderRadius: 2, overflow: 'hidden' }}>
                              <div style={{ width: `${Math.round(((d.netsuite || 0) / maxDaily) * 100)}%`, height: '100%', background: T.blue, borderRadius: 2, opacity: 0.7 }} />
                            </div>
                          </div>
                          <div style={{ minWidth: 50, textAlign: 'right', fontSize: 11, fontWeight: 600, color: T.green, fontFamily: mono }}>{(d.kardex || 0) > 0 ? d.kardex.toLocaleString() : '—'}</div>
                          <div style={{ minWidth: 50, textAlign: 'right', fontSize: 11, fontWeight: 600, color: T.blue, fontFamily: mono }}>{(d.netsuite || 0) > 0 ? d.netsuite.toLocaleString() : '—'}</div>
                        </div>
                      );
                    })}
                  </div>
                  <div style={{ display: "flex", gap: 16, padding: "6px 12px", borderTop: `1px solid ${T.border}`, marginTop: 4, fontSize: 10, fontFamily: mono, color: T.textDim }}>
                    <span><span style={{ display: "inline-block", width: 10, height: 4, background: T.green, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />Kardex / ItemPath</span>
                    <span><span style={{ display: "inline-block", width: 10, height: 4, background: T.blue, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />DVI / NetSuite</span>
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
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.green, borderBottom: `1px solid ${T.border}` }}>KARDEX / IP</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.blue, borderBottom: `1px solid ${T.border}` }}>DVI / NS</th>
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
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: s.kardex_qty > 0 ? T.green : T.textDim }}>{s.kardex_qty > 0 ? s.kardex_qty.toLocaleString() : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: s.netsuite_qty > 0 ? T.blue : T.textDim }}>{s.netsuite_qty > 0 ? s.netsuite_qty.toLocaleString() : '—'}</td>
                          <td style={{ padding: '6px 12px', textAlign: 'right', color: s.breakages > 0 ? T.red : T.textDim }}>{s.breakages > 0 ? s.breakages.toLocaleString() : '—'}</td>
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

        {sub === "pipeline" && (() => {
          if (!pipelineData || pipelineData._days !== pipelineDays) {
            fetch(`${ovenServerUrl}/api/usage/pipeline?days=${pipelineDays}`).then(r => r.json()).then(d => { d._days = pipelineDays; setPipelineData(d); }).catch(() => {});
          }
          const daily = pipelineData?.daily || [];
          const totals = pipelineData?.totals || {};
          const maxJobs = Math.max(1, ...daily.map(d => Math.max(d.dvi, d.looker)));

          return (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Jobs Pipeline — DVI Shipped vs Looker → NetSuite</h3>
                <div style={{ display: "flex", gap: 4 }}>
                  {[7, 14, 30, 60].map(d => (
                    <button key={d} onClick={() => { setPipelineData(null); setPipelineDays(d); }} style={{
                      padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                      background: pipelineDays === d ? T.blue : 'transparent', color: pipelineDays === d ? '#fff' : T.textMuted,
                      border: `1px solid ${pipelineDays === d ? T.blue : T.border}`
                    }}>{d}d</button>
                  ))}
                  <ExportBtn onClick={() => {
                    downloadCSV('pipeline.csv', ['date','dvi','looker','breakage','variance'], (pipelineData?.daily || []).map(d => ({...d, variance: d.dvi - d.looker})));
                  }} label="Export Summary" />
                  <ExportBtn onClick={async () => {
                    try {
                      const resp = await fetch(`${ovenServerUrl}/api/shipping/detail?days=${pipelineDays}`);
                      const data = await resp.json();
                      downloadCSV(`shipped_jobs_${pipelineDays}d.csv`, ['date','invoice','tray','coating','lensType','lensMat','frameStyle','frameSku','department','daysInLab','entryDate','rush'], data.jobs || []);
                    } catch (e) { console.error(e); }
                  }} label="Export All Jobs" />
                </div>
              </div>

              {/* KPI cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 10, marginBottom: 20 }}>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>BREAKAGES</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.red, fontFamily: mono }}>{(totals.breakage || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>lens breakages (DVI)</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>DVI (SHIPPED)</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.amber, fontFamily: mono }}>{(totals.dvi || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>jobs shipped from lab</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>LOOKER → NETSUITE</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{(totals.looker || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>jobs reported to NetSuite</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${Math.abs((totals.dvi || 0) - (totals.looker || 0)) < 50 ? T.green : T.red}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>VARIANCE (DVI — LOOKER)</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: Math.abs((totals.dvi || 0) - (totals.looker || 0)) < 50 ? T.green : T.red, fontFamily: mono }}>
                    {((totals.dvi || 0) - (totals.looker || 0)) > 0 ? '+' : ''}{((totals.dvi || 0) - (totals.looker || 0)).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>mega file ingestion gap</div>
                </Card>
              </div>

              {/* Daily table */}
              <Card>
                <SectionHeader right={`${daily.length} days`}>Daily Shipped Jobs</SectionHeader>
                <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: mono }}>
                    <thead>
                      <tr style={{ background: T.bg, position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>DATE</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.red, borderBottom: `1px solid ${T.border}` }}>BREAKAGE</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.amber, borderBottom: `1px solid ${T.border}` }}>DVI SHIPPED</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.blue, borderBottom: `1px solid ${T.border}` }}>LOOKER → NS</th>
                        <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>VARIANCE</th>
                        <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>BAR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {daily.map(d => {
                        const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
                        const variance = d.dvi - d.looker;
                        const isToday = d.date === new Date().toISOString().slice(0, 10);
                        const dviPct = Math.round((d.dvi / maxJobs) * 100);
                        const lkPct = Math.round((d.looker / maxJobs) * 100);
                        const isExpanded = pipelineDetailDate === d.date;
                        return [
                          <tr key={d.date} onClick={() => {
                            if (isExpanded) { setPipelineDetailDate(null); setPipelineDetail(null); }
                            else {
                              setPipelineDetailDate(d.date);
                              setPipelineDetail(null);
                              setPipelineDetailSearch("");
                              fetch(`${ovenServerUrl}/api/shipping/detail?date=${d.date}`).then(r => r.json()).then(setPipelineDetail).catch(() => {});
                            }
                          }} style={{ borderBottom: `1px solid ${T.border}22`, background: isExpanded ? `${T.amber}10` : isToday ? `${T.blue}10` : 'transparent', cursor: 'pointer' }}>
                            <td style={{ padding: '6px 12px', color: isToday ? T.blue : T.textMuted, fontWeight: isToday ? 700 : 400 }}>{isToday ? 'TODAY' : dayName} {isExpanded ? '▲' : '▼'}</td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', color: d.breakage > 0 ? T.red : T.textDim }}>{d.breakage > 0 ? d.breakage.toLocaleString() : '—'}</td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', color: d.dvi > 0 ? T.amber : T.textDim }}>{d.dvi > 0 ? d.dvi.toLocaleString() : '—'}</td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', color: d.looker > 0 ? T.blue : T.textDim }}>{d.looker > 0 ? d.looker.toLocaleString() : '—'}</td>
                            <td style={{ padding: '6px 12px', textAlign: 'right', fontWeight: 600, color: variance === 0 ? T.textDim : Math.abs(variance) > 20 ? T.red : T.amber }}>
                              {d.dvi > 0 || d.looker > 0 ? (variance > 0 ? '+' : '') + variance : '—'}
                            </td>
                            <td style={{ padding: '6px 12px', width: '25%' }}>
                              <div style={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
                                <div style={{ height: 4, background: T.surface, borderRadius: 2, overflow: 'hidden' }}>
                                  <div style={{ width: `${dviPct}%`, height: '100%', background: T.amber, borderRadius: 2, opacity: 0.7 }} />
                                </div>
                                <div style={{ height: 4, background: T.surface, borderRadius: 2, overflow: 'hidden' }}>
                                  <div style={{ width: `${lkPct}%`, height: '100%', background: T.blue, borderRadius: 2, opacity: 0.7 }} />
                                </div>
                              </div>
                            </td>
                          </tr>,
                          isExpanded && (
                            <tr key={d.date + '-detail'}>
                              <td colSpan={6} style={{ padding: 0, background: `${T.amber}05` }}>
                                {!pipelineDetail ? (
                                  <div style={{ padding: 16, textAlign: 'center', color: T.textDim, fontSize: 12 }}>Loading jobs...</div>
                                ) : (
                                  <div style={{ padding: '12px 16px' }}>
                                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                                      <span style={{ fontSize: 12, fontWeight: 700, color: T.text, fontFamily: mono }}>{pipelineDetail.count} DVI shipped jobs — {d.date}</span>
                                      <div style={{ display: 'flex', gap: 8 }}>
                                        <input type="text" placeholder="Search invoice, coating, frame..." value={pipelineDetailSearch} onChange={e => setPipelineDetailSearch(e.target.value)}
                                          style={{ padding: '5px 10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 11, fontFamily: mono, width: 200 }} />
                                        <ExportBtn label="Export Jobs" onClick={() => {
                                          downloadCSV(`shipped_${d.date}.csv`, ['invoice','tray','coating','lensType','lensMat','frameStyle','frameSku','department','daysInLab','entryDate','shipDate','rush'], pipelineDetail.jobs);
                                        }} />
                                      </div>
                                    </div>
                                    <div style={{ maxHeight: 400, overflowY: 'auto' }}>
                                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: mono }}>
                                        <thead>
                                          <tr style={{ background: T.bg }}>
                                            <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>INVOICE</th>
                                            <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>COATING</th>
                                            <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>LENS</th>
                                            <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>FRAME</th>
                                            <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>DEPT</th>
                                            <th style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>DAYS</th>
                                            <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>ENTRY</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {(pipelineDetailSearch ? pipelineDetail.jobs.filter(j => {
                                            const q = pipelineDetailSearch.toLowerCase();
                                            return (j.invoice||'').toLowerCase().includes(q) || (j.coating||'').toLowerCase().includes(q) || (j.frameStyle||'').toLowerCase().includes(q) || (j.frameSku||'').toLowerCase().includes(q) || (j.department||'').toLowerCase().includes(q);
                                          }) : pipelineDetail.jobs).slice(0, 200).map((j, i) => (
                                            <tr key={i} style={{ borderBottom: `1px solid ${T.border}15` }}>
                                              <td style={{ padding: '4px 8px', color: T.text, fontWeight: 600 }}>{j.invoice}</td>
                                              <td style={{ padding: '4px 8px', color: T.textMuted }}>{j.coating || '—'}</td>
                                              <td style={{ padding: '4px 8px', color: T.textMuted }}>{j.lensType || '—'}</td>
                                              <td style={{ padding: '4px 8px', color: T.textMuted }}>{j.frameStyle || j.frameSku || '—'}</td>
                                              <td style={{ padding: '4px 8px', color: T.textMuted }}>{j.department || '—'}</td>
                                              <td style={{ padding: '4px 8px', textAlign: 'right', color: T.textMuted }}>{j.daysInLab || '—'}</td>
                                              <td style={{ padding: '4px 8px', color: T.textDim }}>{j.entryDate || '—'}</td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                    </div>
                                  </div>
                                )}
                              </td>
                            </tr>
                          )
                        ];
                      })}
                    </tbody>
                  </table>
                </div>
                <div style={{ display: "flex", gap: 16, padding: "8px 12px", borderTop: `1px solid ${T.border}`, fontSize: 10, fontFamily: mono, color: T.textDim }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 4, background: T.amber, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />DVI shipped jobs</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 4, background: T.blue, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />Looker → NetSuite</span>
                  <span>Click a day to see job detail + export</span>
                </div>
              </Card>

              {/* Job Comparison: DVI vs Looker */}
              <Card style={{ marginTop: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px', borderBottom: `1px solid ${T.border}` }}>
                  <SectionHeader style={{ margin: 0 }}>Job Comparison — DVI vs Looker</SectionHeader>
                  <div style={{ display: 'flex', gap: 8 }}>
                    {!compareData && !compareLoading && (
                      <button onClick={async () => {
                        setCompareLoading(true);
                        try {
                          const resp = await fetch(`${ovenServerUrl}/api/shipping/compare?days=${pipelineDays}`);
                          setCompareData(await resp.json());
                        } catch (e) { console.error(e); }
                        setCompareLoading(false);
                      }} style={{ background: T.blue, border: 'none', borderRadius: 6, padding: '8px 16px', color: '#fff', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: mono }}>
                        Load Comparison
                      </button>
                    )}
                    {compareData && (
                      <ExportBtn label="Export Comparison" onClick={() => {
                        downloadCSV(`job_comparison_${pipelineDays}d.csv`, ['date','order_number','source','invoice','job_id','dvi_id','dvi_coating','dvi_frame','dvi_department','dvi_days_in_lab','dvi_entry_date','dvi_rush','lk_frame_upc','lk_opcs','lk_lenses','lk_breakages'], compareData.jobs || []);
                      }} />
                    )}
                  </div>
                </div>
                {compareLoading && <div style={{ padding: 20, textAlign: 'center', color: T.textDim }}>Loading job comparison from DVI + Looker...</div>}
                {compareData && (() => {
                  const sm = compareData.summary || {};
                  const jobs = compareData.jobs || [];
                  let filtered = jobs;
                  if (compareFilter !== 'all') filtered = filtered.filter(j => j.source === compareFilter);
                  if (compareSearch) {
                    const q = compareSearch.toLowerCase();
                    filtered = filtered.filter(j => (j.order_number||'').includes(q) || (j.invoice||'').includes(q) || (j.job_id||'').includes(q) || (j.dvi_coating||'').toLowerCase().includes(q) || (j.dvi_frame||'').toLowerCase().includes(q) || (j.lk_frame_upc||'').includes(q) || (j.lk_opcs||'').includes(q));
                  }
                  return (
                    <div>
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, padding: '12px 16px' }}>
                        <div style={{ textAlign: 'center', padding: 8, background: T.bg, borderRadius: 6 }}>
                          <div style={{ fontSize: 20, fontWeight: 800, color: T.green, fontFamily: mono }}>{sm.both || 0}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>BOTH</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: 8, background: T.bg, borderRadius: 6 }}>
                          <div style={{ fontSize: 20, fontWeight: 800, color: T.amber, fontFamily: mono }}>{sm.dviOnly || 0}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>DVI ONLY</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: 8, background: T.bg, borderRadius: 6 }}>
                          <div style={{ fontSize: 20, fontWeight: 800, color: T.blue, fontFamily: mono }}>{sm.lookerOnly || 0}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>LOOKER ONLY</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: 8, background: T.bg, borderRadius: 6 }}>
                          <div style={{ fontSize: 20, fontWeight: 800, color: T.amber, fontFamily: mono }}>{sm.dviTotal || 0}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>DVI TOTAL</div>
                        </div>
                        <div style={{ textAlign: 'center', padding: 8, background: T.bg, borderRadius: 6 }}>
                          <div style={{ fontSize: 20, fontWeight: 800, color: T.blue, fontFamily: mono }}>{sm.lookerTotal || 0}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>LOOKER TOTAL</div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: 8, padding: '8px 16px', alignItems: 'center' }}>
                        <input type="text" placeholder="Search reference, invoice, coating..." value={compareSearch} onChange={e => setCompareSearch(e.target.value)}
                          style={{ flex: 1, padding: '6px 10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 11, fontFamily: mono }} />
                        {['all', 'Both', 'DVI Only', 'Looker Only'].map(f => (
                          <button key={f} onClick={() => setCompareFilter(f)} style={{
                            padding: '6px 12px', borderRadius: 6, fontSize: 10, fontWeight: 600, fontFamily: mono, cursor: 'pointer',
                            background: compareFilter === f ? T.blue : 'transparent', color: compareFilter === f ? '#fff' : T.textMuted,
                            border: `1px solid ${compareFilter === f ? T.blue : T.border}`
                          }}>{f === 'all' ? 'All' : f}</button>
                        ))}
                      </div>
                      <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: mono }}>
                          <thead>
                            <tr style={{ background: T.bg, position: 'sticky', top: 0, zIndex: 1 }}>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>DATE</th>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>ORDER #</th>
                              <th style={{ padding: '5px 8px', textAlign: 'center', fontSize: 8, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SOURCE</th>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.amber, borderBottom: `1px solid ${T.border}` }}>DVI INV</th>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.amber, borderBottom: `1px solid ${T.border}` }}>DVI COAT</th>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.amber, borderBottom: `1px solid ${T.border}` }}>DVI FRAME</th>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.blue, borderBottom: `1px solid ${T.border}` }}>LK JOB ID</th>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.blue, borderBottom: `1px solid ${T.border}` }}>LK FRAME</th>
                              <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 8, color: T.blue, borderBottom: `1px solid ${T.border}` }}>LK OPCs</th>
                              <th style={{ padding: '5px 8px', textAlign: 'right', fontSize: 8, color: T.blue, borderBottom: `1px solid ${T.border}` }}>LENSES</th>
                            </tr>
                          </thead>
                          <tbody>
                            {filtered.slice(0, 300).map((j, i) => (
                              <tr key={i} style={{ borderBottom: `1px solid ${T.border}15`, background: j.source === 'DVI Only' ? `${T.amber}08` : j.source === 'Looker Only' ? `${T.blue}08` : 'transparent' }}>
                                <td style={{ padding: '3px 8px', color: T.textMuted, fontSize: 10 }}>{j.date}</td>
                                <td style={{ padding: '3px 8px', color: T.text, fontWeight: 600 }}>{j.order_number}</td>
                                <td style={{ padding: '3px 8px', textAlign: 'center' }}>
                                  <span style={{ fontSize: 8, padding: '2px 5px', borderRadius: 3, fontWeight: 700,
                                    background: j.source === 'Both' ? `${T.green}20` : j.source === 'DVI Only' ? `${T.amber}20` : `${T.blue}20`,
                                    color: j.source === 'Both' ? T.green : j.source === 'DVI Only' ? T.amber : T.blue
                                  }}>{j.source}</span>
                                </td>
                                <td style={{ padding: '3px 8px', color: T.amber }}>{j.invoice || '—'}</td>
                                <td style={{ padding: '3px 8px', color: T.textMuted }}>{j.dvi_coating || '—'}</td>
                                <td style={{ padding: '3px 8px', color: T.textMuted }}>{j.dvi_frame || '—'}</td>
                                <td style={{ padding: '3px 8px', color: T.blue }}>{j.job_id || '—'}</td>
                                <td style={{ padding: '3px 8px', color: T.textMuted }}>{j.lk_frame_upc || '—'}</td>
                                <td style={{ padding: '3px 8px', color: T.textMuted, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{j.lk_opcs || '—'}</td>
                                <td style={{ padding: '3px 8px', textAlign: 'right', color: T.textMuted }}>{j.lk_lenses || '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                        {filtered.length > 300 && <div style={{ padding: 8, textAlign: 'center', fontSize: 10, color: T.textDim }}>Showing 300 of {filtered.length}</div>}
                      </div>
                    </div>
                  );
                })()}
                {!compareData && !compareLoading && <div style={{ padding: 16, textAlign: 'center', color: T.textDim, fontSize: 11 }}>Click "Load Comparison" to cross-reference DVI shipped jobs against Looker</div>}
              </Card>
            </div>
          );
        })()}

        {sub === "lens-usage" && (() => {
          if (!usageData || usageData._days !== usageDays) {
            fetch(`${ovenServerUrl}/api/usage/daily?days=${usageDays}`).then(r => r.json()).then(d => { d._days = usageDays; setUsageData(d); }).catch(() => {});
          }
          const daily = usageData?.dailyTotals || [];
          const skus = usageData?.skuComparison || [];
          const sm = usageData?.summary || {};
          const lk = sm.looker || {};
          const ip = sm.itempath || {};
          const maxDay = Math.max(1, ...daily.map(d => Math.max(d.looker_qty || 0, d.itempath_qty || 0)));

          return (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Daily Transactions — Looker vs ItemPath</h3>
                <div style={{ display: "flex", gap: 4 }}>
                  {[7, 14, 30, 60].map(d => (
                    <button key={d} onClick={() => { setUsageData(null); setUsageDays(d); }} style={{
                      padding: "6px 12px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                      background: usageDays === d ? T.blue : 'transparent', color: usageDays === d ? '#fff' : T.textMuted,
                      border: `1px solid ${usageDays === d ? T.blue : T.border}`
                    }}>{d}d</button>
                  ))}
                  <ExportBtn onClick={() => {
                    const skuRows = usageData?.skuComparison || [];
                    downloadCSV('transactions.csv', ['sku','looker_qty','looker_breakages','itempath_qty','variance'], skuRows);
                  }} />
                </div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 20 }}>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>LOOKER TRANSACTIONS</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: T.blue, fontFamily: mono }}>{(lk.total || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{lk.skus || 0} SKUs · {lk.days || 0} days</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.green}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>ITEMPATH TRANSACTIONS</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: T.green, fontFamily: mono }}>{(ip.total || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{ip.skus || 0} SKUs · {ip.days || 0} days</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>BREAKAGES</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: T.red, fontFamily: mono }}>{(lk.breakages || 0).toLocaleString()}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{lk.total > 0 ? ((lk.breakages || 0) / lk.total * 100).toFixed(1) : 0}% rate</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>VARIANCE</div>
                  <div style={{ fontSize: 26, fontWeight: 800, color: Math.abs(sm.variance || 0) < 100 ? T.green : T.amber, fontFamily: mono }}>
                    {(sm.variance || 0) > 0 ? '+' : ''}{(sm.variance || 0).toLocaleString()}
                  </div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>ItemPath — Looker</div>
                </Card>
              </div>

              <Card style={{ marginBottom: 20 }}>
                <SectionHeader right={`${daily.length} days`}>Daily Transactions</SectionHeader>
                <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
                  {daily.map(d => {
                    const dayName = new Date(d.date + 'T12:00:00').toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
                    const lkPct = Math.round(((d.looker_qty || 0) / maxDay) * 100);
                    const ipPct = Math.round(((d.itempath_qty || 0) / maxDay) * 100);
                    const isToday = d.date === new Date().toISOString().slice(0, 10);
                    return (
                      <div key={d.date} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '4px 12px', background: isToday ? `${T.blue}12` : T.bg, borderRadius: 5, border: `1px solid ${isToday ? T.blue : T.border}` }}>
                        <div style={{ width: 100, fontSize: 11, fontWeight: isToday ? 700 : 500, color: isToday ? T.blue : T.textMuted, fontFamily: mono }}>{isToday ? 'TODAY' : dayName}</div>
                        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 1 }}>
                          <div style={{ height: 5, background: T.surface, borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${lkPct}%`, height: '100%', background: T.blue, borderRadius: 3, opacity: 0.7 }} />
                          </div>
                          <div style={{ height: 5, background: T.surface, borderRadius: 3, overflow: 'hidden' }}>
                            <div style={{ width: `${ipPct}%`, height: '100%', background: T.green, borderRadius: 3, opacity: 0.7 }} />
                          </div>
                        </div>
                        <div style={{ minWidth: 55, textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.blue, fontFamily: mono }}>{(d.looker_qty || 0).toLocaleString()}</div>
                        <div style={{ minWidth: 40, textAlign: 'right', fontSize: 10, color: (d.looker_breakages || 0) > 0 ? T.red : T.textDim, fontFamily: mono }}>{(d.looker_breakages || 0) > 0 ? `-${d.looker_breakages}` : ''}</div>
                        <div style={{ width: 1, height: 14, background: T.border }} />
                        <div style={{ minWidth: 55, textAlign: 'right', fontSize: 12, fontWeight: 700, color: T.green, fontFamily: mono }}>{(d.itempath_qty || 0) > 0 ? d.itempath_qty.toLocaleString() : '—'}</div>
                      </div>
                    );
                  })}
                </div>
                {daily.length === 0 && <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>Loading...</div>}
                <div style={{ display: "flex", gap: 16, padding: "8px 12px", borderTop: `1px solid ${T.border}`, marginTop: 6, fontSize: 10, fontFamily: mono, color: T.textDim }}>
                  <span><span style={{ display: "inline-block", width: 10, height: 5, background: T.blue, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />Looker (lenses + frames)</span>
                  <span><span style={{ display: "inline-block", width: 10, height: 5, background: T.green, borderRadius: 2, marginRight: 4, opacity: 0.7 }} />ItemPath (picks)</span>
                </div>
              </Card>

              {skus.length > 0 && (
                <Card>
                  <SectionHeader right={`${skus.length} SKUs`}>Transactions by SKU</SectionHeader>
                  <div style={{ maxHeight: 500, overflowY: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: mono }}>
                      <thead>
                        <tr style={{ background: T.bg, position: 'sticky', top: 0, zIndex: 1 }}>
                          <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SKU</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.blue, borderBottom: `1px solid ${T.border}` }}>LOOKER</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.red, borderBottom: `1px solid ${T.border}` }}>BREAKAGE</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.green, borderBottom: `1px solid ${T.border}` }}>ITEMPATH</th>
                          <th style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, color: T.amber, borderBottom: `1px solid ${T.border}` }}>VARIANCE</th>
                        </tr>
                      </thead>
                      <tbody>
                        {skus.slice(0, 100).map(s => (
                          <tr key={s.sku} style={{ borderBottom: `1px solid ${T.border}22` }}>
                            <td style={{ padding: '7px 12px', fontWeight: 600, color: T.text }}>{s.sku}</td>
                            <td style={{ padding: '7px 12px', textAlign: 'right', color: s.looker_qty > 0 ? T.blue : T.textDim }}>{s.looker_qty > 0 ? s.looker_qty.toLocaleString() : '—'}</td>
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

        {sub === "lens-intel" && (() => {
          if (!lensIntelData) {
            fetch(`${ovenServerUrl}/api/lens-intel/status`).then(r => r.json()).then(setLensIntelData).catch(() => {});
          }
          const items = lensIntelData?.items || [];
          const sm = lensIntelData?.summary || {};
          let filtered = items;
          if (lensIntelFilter !== 'all') filtered = filtered.filter(i => i.status === lensIntelFilter);
          if (lensIntelSearch) {
            const q = lensIntelSearch.toLowerCase();
            filtered = filtered.filter(i => i.sku?.toLowerCase().includes(q) || i.description?.toLowerCase().includes(q));
          }

          return (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Lens Intelligence</h3>
                <div style={{ display: "flex", gap: 8 }}>
                  <ExportBtn label="Export CSV" onClick={() => window.open(`${ovenServerUrl}/api/lens-intel/export`, '_blank')} />
                  <ExportBtn label="Order Report" onClick={async () => {
                    const resp = await fetch(`${ovenServerUrl}/api/lens-intel/orders`);
                    const data = await resp.json();
                    downloadCSV('lens_order_recommendations.csv', ['sku','description','on_hand','avg_weekly_consumption','projected_weekly','consumption_method','weeks_of_supply','status','order_qty_recommended','dynamic_reorder_point','lead_time_weeks','manufacturing_weeks','transit_weeks','fda_hold_weeks','runout_date','days_at_risk','abc_class','regression_slope','regression_r2'], data.recommendations || []);
                  }} />
                  <button onClick={() => setLensSettings(!lensSettings)} style={{ background: lensSettings ? T.amber : 'transparent', border: `1px solid ${lensSettings ? T.amber : T.border}`, borderRadius: 6, padding: "6px 14px", color: lensSettings ? '#fff' : T.textMuted, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                    Settings
                  </button>
                  <button onClick={async () => {
                    await fetch(`${ovenServerUrl}/api/lens-intel/refresh`, { method: 'POST' });
                    const resp = await fetch(`${ovenServerUrl}/api/lens-intel/status`);
                    setLensIntelData(await resp.json());
                  }} style={{ background: T.blue, border: "none", borderRadius: 6, padding: "6px 14px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                    Refresh
                  </button>
                </div>
              </div>

              {/* Settings panel */}
              {lensSettings && (
                <Card style={{ padding: 16, marginBottom: 16, border: `1px solid ${T.amber}30`, background: `${T.amber}05` }}>
                  <div style={{ fontSize: 14, fontWeight: 700, color: T.text, marginBottom: 12 }}>Lead Time & Planning Settings</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 12, marginBottom: 16 }}>
                    <div>
                      <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 4 }}>MANUFACTURING (weeks)</label>
                      <input type="number" step="0.5" value={lensDefaults.manufacturing_weeks} onChange={e => setLensDefaults(p => ({...p, manufacturing_weeks: parseFloat(e.target.value) || 0}))}
                        style={{ width: '100%', padding: '8px 10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: mono }} />
                      <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>Time to manufacture (default: 13 = 90 days)</div>
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 4 }}>OCEAN TRANSIT (weeks)</label>
                      <input type="number" step="0.5" value={lensDefaults.transit_weeks} onChange={e => setLensDefaults(p => ({...p, transit_weeks: parseFloat(e.target.value) || 0}))}
                        style={{ width: '100%', padding: '8px 10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: mono }} />
                      <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>Shipping from supplier (default: 4)</div>
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 4 }}>FDA HOLD (weeks)</label>
                      <input type="number" step="0.5" value={lensDefaults.fda_hold_weeks} onChange={e => setLensDefaults(p => ({...p, fda_hold_weeks: parseFloat(e.target.value) || 0}))}
                        style={{ width: '100%', padding: '8px 10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: mono }} />
                      <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>Customs/FDA clearance (default: 2)</div>
                    </div>
                    <div>
                      <label style={{ fontSize: 10, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 4 }}>SAFETY STOCK (weeks)</label>
                      <input type="number" step="0.5" value={lensDefaults.safety_stock_weeks} onChange={e => setLensDefaults(p => ({...p, safety_stock_weeks: parseFloat(e.target.value) || 0}))}
                        style={{ width: '100%', padding: '8px 10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 13, fontFamily: mono }} />
                      <div style={{ fontSize: 9, color: T.textDim, marginTop: 2 }}>Buffer stock (A=6, B=4, C=3)</div>
                    </div>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                    <div style={{ fontSize: 11, color: T.textMuted, fontFamily: mono }}>
                      Total lead time: <strong style={{ color: T.text }}>{(lensDefaults.manufacturing_weeks + lensDefaults.transit_weeks + lensDefaults.fda_hold_weeks).toFixed(1)} weeks</strong> ({Math.round((lensDefaults.manufacturing_weeks + lensDefaults.transit_weeks + lensDefaults.fda_hold_weeks) * 7)} days)
                    </div>
                    <button onClick={async () => {
                      setLensSaving(true);
                      await fetch(`${ovenServerUrl}/api/lens-intel/defaults`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(lensDefaults) });
                      await fetch(`${ovenServerUrl}/api/lens-intel/refresh`, { method: 'POST' });
                      const resp = await fetch(`${ovenServerUrl}/api/lens-intel/status`);
                      setLensIntelData(await resp.json());
                      setLensSaving(false);
                    }} disabled={lensSaving}
                      style={{ background: T.green, border: "none", borderRadius: 6, padding: "8px 20px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono, opacity: lensSaving ? 0.6 : 1 }}>
                      {lensSaving ? "Saving..." : "Apply to All & Recompute"}
                    </button>
                  </div>
                  <div style={{ fontSize: 10, color: T.textDim, marginTop: 8 }}>
                    Defaults for SKUs without custom params. Click a row to set per-SKU overrides. Mark discontinued = ABC class "X".
                  </div>

                  {/* Bulk edit by prefix */}
                  <div style={{ marginTop: 16, paddingTop: 16, borderTop: `1px solid ${T.border}` }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: T.text, marginBottom: 8 }}>Bulk Edit by SKU Prefix / Vendor</div>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>PREFIX</label>
                        <select id="bulk-prefix" style={{ padding: '6px 10px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono }}>
                          <option value="4800">4800 — Essilor</option>
                          <option value="062">062x — Somo</option>
                          <option value="026">026x</option>
                          <option value="001">001x — Younger</option>
                          <option value="5">5xxx — Conant</option>
                          <option value="custom">Custom prefix...</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>CUSTOM PREFIX</label>
                        <input type="text" id="bulk-custom-prefix" placeholder="e.g. 4800" style={{ padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono, width: 80 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>MFG (wk)</label>
                        <input type="number" step="0.5" id="bulk-mfg" defaultValue="13" style={{ padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono, width: 60 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>TRANSIT (wk)</label>
                        <input type="number" step="0.5" id="bulk-transit" defaultValue="4" style={{ padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono, width: 60 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>FDA (wk)</label>
                        <input type="number" step="0.5" id="bulk-fda" defaultValue="2" style={{ padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono, width: 60 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>SAFETY (wk)</label>
                        <input type="number" step="0.5" id="bulk-safety" defaultValue="4" style={{ padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono, width: 60 }} />
                      </div>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>ABC</label>
                        <select id="bulk-abc" style={{ padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono }}>
                          <option value="">No change</option>
                          <option value="A">A</option>
                          <option value="B">B</option>
                          <option value="C">C</option>
                          <option value="X">X — Discontinued</option>
                        </select>
                      </div>
                      <div>
                        <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>SUPPLIER</label>
                        <input type="text" id="bulk-supplier" placeholder="e.g. Essilor" style={{ padding: '6px 8px', background: T.bg, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono, width: 90 }} />
                      </div>
                      <button onClick={async () => {
                        const prefixEl = document.getElementById('bulk-prefix');
                        let prefix = prefixEl.value === 'custom' ? (document.getElementById('bulk-custom-prefix')?.value || '') : prefixEl.value;
                        if (!prefix) { alert('Enter a prefix'); return; }
                        const matching = (lensIntelData?.items || []).filter(i => i.sku.startsWith(prefix));
                        if (matching.length === 0) { alert('No SKUs match prefix: ' + prefix); return; }
                        if (!confirm(`Apply settings to ${matching.length} SKUs starting with "${prefix}"?`)) return;
                        const params = {
                          manufacturing_weeks: parseFloat(document.getElementById('bulk-mfg')?.value) || 13,
                          transit_weeks: parseFloat(document.getElementById('bulk-transit')?.value) || 4,
                          fda_hold_weeks: parseFloat(document.getElementById('bulk-fda')?.value) || 2,
                          safety_stock_weeks: parseFloat(document.getElementById('bulk-safety')?.value) || 4,
                          supplier: document.getElementById('bulk-supplier')?.value || null,
                        };
                        const abc = document.getElementById('bulk-abc')?.value;
                        if (abc) params.abc_class = abc;
                        const updates = matching.map(i => ({ sku: i.sku, ...params }));
                        setLensSaving(true);
                        await fetch(`${ovenServerUrl}/api/lens-intel/params/bulk`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ updates }) });
                        await fetch(`${ovenServerUrl}/api/lens-intel/refresh`, { method: 'POST' });
                        const resp = await fetch(`${ovenServerUrl}/api/lens-intel/status`);
                        setLensIntelData(await resp.json());
                        setLensSaving(false);
                        alert(`Updated ${updates.length} SKUs`);
                      }} disabled={lensSaving}
                        style={{ background: T.green, border: "none", borderRadius: 4, padding: "6px 16px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono, opacity: lensSaving ? 0.6 : 1, whiteSpace: 'nowrap' }}>
                        {lensSaving ? "Saving..." : "Apply to Prefix"}
                      </button>
                    </div>
                  </div>
                </Card>
              )}

              {/* KPI cards */}
              <div style={{ display: "grid", gridTemplateColumns: "repeat(6,1fr)", gap: 8, marginBottom: 16 }}>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.red, fontFamily: mono }}>{sm.critical || 0}</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>CRITICAL</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.amber, fontFamily: mono }}>{sm.warning || 0}</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>WARNING</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.green}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.green, fontFamily: mono }}>{sm.ok || 0}</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>OK</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.blue, fontFamily: mono }}>{sm.overstock || 0}</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>OVERSTOCK</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.red}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.red, fontFamily: mono }}>{sm.stockoutRisk || 0}</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>STOCKOUT RISK</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.amber, fontFamily: mono }}>{sm.orderRecommended || 0}</div>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>ORDER NOW</div>
                </Card>
              </div>

              {/* Filters */}
              <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center" }}>
                <input type="text" placeholder="Search SKU or description..." value={lensIntelSearch} onChange={e => setLensIntelSearch(e.target.value)}
                  style={{ flex: 1, maxWidth: 300, padding: "8px 12px", background: T.bg, border: `1px solid ${T.border}`, borderRadius: 6, color: T.text, fontSize: 12, fontFamily: mono }} />
                {['all', 'CRITICAL', 'WARNING', 'OK', 'OVERSTOCK'].map(f => (
                  <button key={f} onClick={() => setLensIntelFilter(f)} style={{
                    padding: "7px 12px", borderRadius: 6, fontSize: 10, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                    background: lensIntelFilter === f ? (f === 'CRITICAL' ? T.red : f === 'WARNING' ? T.amber : f === 'OK' ? T.green : f === 'OVERSTOCK' ? T.blue : T.blue) : 'transparent',
                    color: lensIntelFilter === f ? '#fff' : T.textMuted,
                    border: `1px solid ${lensIntelFilter === f ? 'transparent' : T.border}`
                  }}>{f === 'all' ? `All (${sm.total || 0})` : `${f} (${sm[f.toLowerCase()] || 0})`}</button>
                ))}
              </div>

              {/* Main table */}
              <Card>
                <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: mono }}>
                    <thead>
                      <tr style={{ background: T.bg, position: 'sticky', top: 0, zIndex: 1 }}>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SKU</th>
                        <th style={{ padding: '6px 8px', textAlign: 'center', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>STATUS</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>ON HAND</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>AVG/WK</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>TREND</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>WOS</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>WOS+PO</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>ROP</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>OPEN PO</th>
                        <th style={{ padding: '6px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>RUNOUT</th>
                        <th style={{ padding: '6px 8px', textAlign: 'center', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>RISK</th>
                        <th style={{ padding: '6px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>ORDER QTY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.slice(0, 200).map(i => {
                        const statusColor = i.status === 'CRITICAL' ? T.red : i.status === 'WARNING' ? T.amber : i.status === 'OK' ? T.green : T.blue;
                        return (
                          <tr key={i.sku} style={{ borderBottom: `1px solid ${T.border}15`, background: i.status === 'CRITICAL' ? `${T.red}08` : i.will_stockout ? `${T.amber}06` : 'transparent', cursor: 'pointer' }}
                            onClick={async () => {
                              try {
                                const resp = await fetch(`${ovenServerUrl}/api/lens-intel/sku/${encodeURIComponent(i.sku)}`);
                                const data = await resp.json();
                                setLensIntelDetail(data?.status ? data : { status: i, weekly: [] });
                              } catch (e) {
                                setLensIntelDetail({ status: i, weekly: [] });
                              }
                            }}>
                            <td style={{ padding: '5px 8px', fontWeight: 600, color: T.text, maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={i.description}>{i.sku}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                              <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, fontWeight: 700, background: `${statusColor}20`, color: statusColor }}>{i.status}</span>
                            </td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: T.text }}>{i.on_hand?.toLocaleString()}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: T.textMuted }}>{i.avg_weekly_consumption}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: i.consumption_trend_pct > 10 ? T.red : i.consumption_trend_pct < -10 ? T.green : T.textDim }}>
                              {i.consumption_trend_pct > 0 ? '+' : ''}{i.consumption_trend_pct}%
                            </td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: 700, color: i.weeks_of_supply < 6 ? T.red : i.weeks_of_supply < 10 ? T.amber : T.green }}>{i.weeks_of_supply}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: T.textMuted }}>{i.weeks_of_supply_with_po}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: i.on_hand <= i.dynamic_reorder_point ? T.red : T.textDim }}>{i.dynamic_reorder_point}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', color: i.open_po_qty > 0 ? T.blue : T.textDim }}>{i.open_po_qty || '—'}</td>
                            <td style={{ padding: '5px 8px', color: T.textMuted, fontSize: 10 }}>{i.runout_date || '—'}</td>
                            <td style={{ padding: '5px 8px', textAlign: 'center' }}>
                              {i.will_stockout ? <span style={{ fontSize: 8, padding: '2px 6px', borderRadius: 3, fontWeight: 700, background: `${T.red}20`, color: T.red }}>{i.days_at_risk}d</span> : '—'}
                            </td>
                            <td style={{ padding: '5px 8px', textAlign: 'right', fontWeight: i.order_recommended ? 700 : 400, color: i.order_recommended ? T.amber : T.textDim }}>
                              {i.order_recommended ? i.order_qty_recommended?.toLocaleString() : '—'}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  {filtered.length === 0 && <div style={{ padding: 20, textAlign: 'center', color: T.textDim }}>Loading lens intelligence...</div>}
                </div>
              </Card>

              {/* Detail panel */}
              {lensIntelDetail?.status && (
                <Card style={{ marginTop: 16, padding: 16 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                    <div>
                      <div style={{ fontSize: 16, fontWeight: 800, color: T.text, fontFamily: mono }}>{lensIntelDetail.status.sku}</div>
                      <div style={{ fontSize: 12, color: T.textMuted }}>{lensIntelDetail.status.description}</div>
                    </div>
                    <button onClick={() => setLensIntelDetail(null)} style={{ background: 'transparent', border: `1px solid ${T.border}`, borderRadius: 6, padding: '6px 12px', color: T.textMuted, fontSize: 11, cursor: 'pointer' }}>Close</button>
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 10, marginBottom: 16 }}>
                    <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: T.text, fontFamily: mono }}>{lensIntelDetail.status.on_hand?.toLocaleString()}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>ON HAND</div>
                    </div>
                    <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: T.amber, fontFamily: mono }}>{lensIntelDetail.status.weeks_of_supply}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>WEEKS SUPPLY</div>
                    </div>
                    <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: T.blue, fontFamily: mono }}>{lensIntelDetail.status.open_po_qty || 0}</div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>OPEN PO QTY</div>
                    </div>
                    <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                      <div style={{ fontSize: 20, fontWeight: 800, color: lensIntelDetail.status.will_stockout ? T.red : T.green, fontFamily: mono }}>
                        {lensIntelDetail.status.will_stockout ? `${lensIntelDetail.status.days_at_risk}d risk` : 'Safe'}
                      </div>
                      <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>STOCKOUT</div>
                    </div>
                  </div>
                  {/* Weekly consumption chart */}
                  {lensIntelDetail.weekly?.length > 0 && (
                    <div>
                      <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, fontFamily: mono, marginBottom: 8 }}>WEEKLY CONSUMPTION</div>
                      <div style={{ display: 'flex', gap: 4, alignItems: 'flex-end', height: 80 }}>
                        {[...lensIntelDetail.weekly].reverse().map((w, i) => {
                          const maxW = Math.max(1, ...lensIntelDetail.weekly.map(x => x.units_consumed));
                          const pct = Math.round((w.units_consumed / maxW) * 100);
                          return (
                            <div key={w.week_start} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                              <div style={{ fontSize: 9, color: T.textMuted, fontFamily: mono }}>{w.units_consumed}</div>
                              <div style={{ width: '100%', background: T.blue, borderRadius: 2, opacity: 0.7, height: `${pct}%`, minHeight: 2 }} />
                              <div style={{ fontSize: 8, color: T.textDim }}>{w.week_start.slice(5)}</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                  {/* Order recommendation */}
                  {lensIntelDetail.status.order_recommended === 1 && (
                    <div style={{ marginTop: 16, padding: 12, background: `${T.amber}10`, borderRadius: 8, border: `1px solid ${T.amber}30` }}>
                      <div style={{ fontSize: 12, fontWeight: 700, color: T.amber, marginBottom: 4 }}>Order Recommended</div>
                      <div style={{ fontSize: 11, color: T.textMuted }}>
                        Recommend ordering <strong style={{ color: T.text }}>{lensIntelDetail.status.order_qty_recommended?.toLocaleString()}</strong> units.
                        Current on-hand ({lensIntelDetail.status.on_hand}) is below reorder point ({lensIntelDetail.status.dynamic_reorder_point}).
                        {lensIntelDetail.status.runout_date && <> Projected runout: <strong style={{ color: T.red }}>{lensIntelDetail.status.runout_date}</strong></>}
                      </div>
                    </div>
                  )}
                  {/* Regression info */}
                  <div style={{ marginTop: 12, display: 'flex', gap: 16, padding: '10px 12px', background: T.bg, borderRadius: 6 }}>
                    <div style={{ fontSize: 10, fontFamily: mono, color: T.textMuted }}>
                      Method: <strong style={{ color: T.text }}>{lensIntelDetail.status.consumption_method || 'average'}</strong>
                    </div>
                    <div style={{ fontSize: 10, fontFamily: mono, color: T.textMuted }}>
                      Avg/wk: <strong style={{ color: T.text }}>{lensIntelDetail.status.avg_weekly_consumption}</strong>
                    </div>
                    <div style={{ fontSize: 10, fontFamily: mono, color: T.textMuted }}>
                      Projected/wk: <strong style={{ color: T.blue }}>{lensIntelDetail.status.projected_weekly}</strong>
                    </div>
                    {lensIntelDetail.status.regression_slope != null && (
                      <>
                        <div style={{ fontSize: 10, fontFamily: mono, color: T.textMuted }}>
                          Slope: <strong style={{ color: lensIntelDetail.status.regression_slope > 0 ? T.red : T.green }}>{lensIntelDetail.status.regression_slope > 0 ? '+' : ''}{lensIntelDetail.status.regression_slope}</strong>
                        </div>
                        <div style={{ fontSize: 10, fontFamily: mono, color: T.textMuted }}>
                          R²: <strong style={{ color: lensIntelDetail.status.regression_r2 >= 0.5 ? T.green : T.amber }}>{lensIntelDetail.status.regression_r2}</strong>
                          {lensIntelDetail.status.regression_r2 >= 0.5 ? ' (strong)' : lensIntelDetail.status.regression_r2 >= 0.3 ? ' (moderate)' : ' (weak)'}
                        </div>
                      </>
                    )}
                    <div style={{ fontSize: 10, fontFamily: mono, color: T.textDim }}>
                      Lead: {lensIntelDetail.status.lead_time_weeks}wk ({lensIntelDetail.status.manufacturing_weeks}+{lensIntelDetail.status.transit_weeks}+{lensIntelDetail.status.fda_hold_weeks})
                    </div>
                  </div>

                  {/* Per-SKU settings */}
                  <div style={{ marginTop: 16, padding: 12, background: T.bg, borderRadius: 8 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, marginBottom: 8, fontFamily: mono }}>SKU SETTINGS</div>
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, marginBottom: 10 }}>
                      {[
                        { key: 'manufacturing_weeks', label: 'MFG (wk)', val: lensIntelDetail.params?.manufacturing_weeks ?? lensIntelDetail.status.manufacturing_weeks ?? 13 },
                        { key: 'transit_weeks', label: 'Transit (wk)', val: lensIntelDetail.params?.transit_weeks ?? lensIntelDetail.status.transit_weeks ?? 4 },
                        { key: 'fda_hold_weeks', label: 'FDA (wk)', val: lensIntelDetail.params?.fda_hold_weeks ?? lensIntelDetail.status.fda_hold_weeks ?? 2 },
                        { key: 'safety_stock_weeks', label: 'Safety (wk)', val: lensIntelDetail.params?.safety_stock_weeks ?? lensIntelDetail.status.safety_stock_weeks ?? 4 },
                        { key: 'min_order_qty', label: 'Min Order', val: lensIntelDetail.params?.min_order_qty ?? 0 },
                      ].map(f => (
                        <div key={f.key}>
                          <label style={{ fontSize: 9, color: T.textDim, fontFamily: mono, display: 'block', marginBottom: 2 }}>{f.label}</label>
                          <input type="number" step="0.5" defaultValue={f.val} id={`sku-param-${f.key}`}
                            style={{ width: '100%', padding: '6px 8px', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 12, fontFamily: mono }} />
                        </div>
                      ))}
                    </div>
                    <div style={{ display: 'flex', gap: 8 }}>
                      <select defaultValue={lensIntelDetail.params?.abc_class || lensIntelDetail.status.abc_class || 'B'} id="sku-param-abc"
                        style={{ padding: '6px 10px', background: T.surface, border: `1px solid ${T.border}`, borderRadius: 4, color: T.text, fontSize: 11, fontFamily: mono }}>
                        <option value="A">A — High Volume (6wk safety)</option>
                        <option value="B">B — Medium (4wk safety)</option>
                        <option value="C">C — Low Volume (3wk safety)</option>
                        <option value="X">X — DISCONTINUED</option>
                      </select>
                      <button onClick={async () => {
                        const params = {
                          sku: lensIntelDetail.status.sku,
                          manufacturing_weeks: parseFloat(document.getElementById('sku-param-manufacturing_weeks')?.value) || 13,
                          transit_weeks: parseFloat(document.getElementById('sku-param-transit_weeks')?.value) || 4,
                          fda_hold_weeks: parseFloat(document.getElementById('sku-param-fda_hold_weeks')?.value) || 2,
                          safety_stock_weeks: parseFloat(document.getElementById('sku-param-safety_stock_weeks')?.value) || 4,
                          min_order_qty: parseInt(document.getElementById('sku-param-min_order_qty')?.value) || 0,
                          abc_class: document.getElementById('sku-param-abc')?.value || 'B',
                        };
                        await fetch(`${ovenServerUrl}/api/lens-intel/params`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(params) });
                        await fetch(`${ovenServerUrl}/api/lens-intel/refresh`, { method: 'POST' });
                        const resp = await fetch(`${ovenServerUrl}/api/lens-intel/status`);
                        setLensIntelData(await resp.json());
                        setLensIntelDetail(null);
                      }} style={{ background: T.blue, border: "none", borderRadius: 4, padding: "6px 16px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                        Save & Recompute
                      </button>
                      <button onClick={async () => {
                        await fetch(`${ovenServerUrl}/api/lens-intel/params`, { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ sku: lensIntelDetail.status.sku, abc_class: 'X' }) });
                        await fetch(`${ovenServerUrl}/api/lens-intel/refresh`, { method: 'POST' });
                        const resp = await fetch(`${ovenServerUrl}/api/lens-intel/status`);
                        setLensIntelData(await resp.json());
                        setLensIntelDetail(null);
                      }} style={{ background: T.red, border: "none", borderRadius: 4, padding: "6px 16px", color: "#fff", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: mono }}>
                        Mark Discontinued
                      </button>
                    </div>
                  </div>
                </Card>
              )}
              {/* NPI / New Product Introduction */}
              <Card style={{ marginTop: 20 }}>
                <div onClick={() => {
                  setNpiOpen(!npiOpen);
                  if (!npiData && !npiOpen) fetch(`${ovenServerUrl}/api/lens-intel/npi`).then(r => r.json()).then(setNpiData).catch(() => {});
                }} style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 700, color: T.text }}>New Product Introduction — CR 39 Cannibalization</div>
                    <div style={{ fontSize: 11, color: T.textMuted }}>Null lens type orders = CR 39 baseline demand (currently upgraded to poly)</div>
                  </div>
                  <span style={{ fontSize: 14, color: T.textDim }}>{npiOpen ? '▲' : '▼'}</span>
                </div>
                {npiOpen && npiData && (() => {
                  const sm = npiData.summary || {};
                  return (
                    <div style={{ padding: '0 16px 16px' }}>
                      {/* KPIs */}
                      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(5,1fr)', gap: 8, marginBottom: 16 }}>
                        <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                          <div style={{ fontSize: 22, fontWeight: 800, color: T.blue, fontFamily: mono }}>{sm.adoptionPct || 0}%</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>CR39 ADOPTION</div>
                        </div>
                        <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                          <div style={{ fontSize: 22, fontWeight: 800, color: T.amber, fontFamily: mono }}>{(sm.avgWeeklyCR39 || 0).toLocaleString()}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>CR39 JOBS/WK</div>
                        </div>
                        <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                          <div style={{ fontSize: 22, fontWeight: 800, color: T.green, fontFamily: mono }}>{(sm.cr39WeeklyLenses || 0).toLocaleString()}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>CR39 LENSES/WK</div>
                        </div>
                        <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                          <div style={{ fontSize: 22, fontWeight: 800, color: T.red, fontFamily: mono }}>{(npiData.totalPolyWeeklyReduction || 0).toLocaleString()}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>POLY REDUCTION/WK</div>
                        </div>
                        <div style={{ background: T.bg, padding: 10, borderRadius: 6, textAlign: 'center' }}>
                          <div style={{ fontSize: 22, fontWeight: 800, color: T.text, fontFamily: mono }}>{(sm.cr39InitialOrder || 0).toLocaleString()}</div>
                          <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono }}>INITIAL ORDER QTY</div>
                          <div style={{ fontSize: 8, color: T.textDim }}>({sm.leadTimeWeeks}wk lead + {sm.safetyWeeks}wk safety)</div>
                        </div>
                      </div>

                      {/* Weekly trend */}
                      {(npiData.weekly || []).length > 0 && (
                        <div style={{ marginBottom: 16 }}>
                          <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, fontFamily: mono, marginBottom: 6 }}>WEEKLY CR39 DEMAND TREND</div>
                          <div style={{ display: 'flex', gap: 3, alignItems: 'flex-end', height: 60 }}>
                            {[...(npiData.weekly || [])].reverse().slice(-12).map(w => {
                              const maxW = Math.max(1, ...(npiData.weekly || []).map(x => x.cr39));
                              const pct = Math.round((w.cr39 / maxW) * 100);
                              return (
                                <div key={w.week} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1 }}>
                                  <div style={{ fontSize: 8, color: T.textMuted, fontFamily: mono }}>{w.cr39}</div>
                                  <div style={{ width: '100%', background: T.blue, borderRadius: 2, opacity: 0.7, height: `${pct}%`, minHeight: 2 }} />
                                  <div style={{ fontSize: 7, color: T.textDim }}>{w.week.slice(5)}</div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      )}

                      {/* Cannibalized SKUs */}
                      {(npiData.cannibalizedSkus || []).length > 0 && (
                        <div>
                          <div style={{ fontSize: 11, fontWeight: 700, color: T.textDim, fontFamily: mono, marginBottom: 6 }}>POLY SKUs IMPACTED BY CR39 ({sm.adoptionPct}% reduction)</div>
                          <div style={{ maxHeight: 300, overflowY: 'auto' }}>
                            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: mono }}>
                              <thead>
                                <tr style={{ background: T.bg }}>
                                  <th style={{ padding: '5px 8px', textAlign: 'left', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SKU</th>
                                  <th style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>CURRENT/WK</th>
                                  <th style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9, color: T.red, borderBottom: `1px solid ${T.border}` }}>LOST/WK</th>
                                  <th style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9, color: T.green, borderBottom: `1px solid ${T.border}` }}>NEW/WK</th>
                                  <th style={{ padding: '5px 8px', textAlign: 'right', fontSize: 9, color: T.textDim, borderBottom: `1px solid ${T.border}` }}>SHARE %</th>
                                </tr>
                              </thead>
                              <tbody>
                                {(npiData.cannibalizedSkus || []).map(s => (
                                  <tr key={s.sku} style={{ borderBottom: `1px solid ${T.border}15` }}>
                                    <td style={{ padding: '4px 8px', color: T.text, fontWeight: 600 }}>{s.sku}</td>
                                    <td style={{ padding: '4px 8px', textAlign: 'right', color: T.textMuted }}>{s.currentWeekly}</td>
                                    <td style={{ padding: '4px 8px', textAlign: 'right', color: T.red }}>-{s.lostWeekly}</td>
                                    <td style={{ padding: '4px 8px', textAlign: 'right', color: T.green }}>{s.newWeekly}</td>
                                    <td style={{ padding: '4px 8px', textAlign: 'right', color: T.textDim }}>{s.share}%</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <ExportBtn label="Export Cannibalization" onClick={() => {
                            downloadCSV('cr39_cannibalization.csv', ['sku','currentWeekly','lostWeekly','newWeekly','share'], npiData.cannibalizedSkus || []);
                          }} />
                        </div>
                      )}
                    </div>
                  );
                })()}
                {npiOpen && !npiData && <div style={{ padding: 16, textAlign: 'center', color: T.textDim }}>Loading NPI analysis...</div>}
              </Card>
            </div>
          );
        })()}

        {sub === "inbound" && (() => {
          if (!inboundData) {
            fetch(`${ovenServerUrl}/api/inventory/inbound`).then(r => r.json()).then(setInboundData).catch(() => {});
          }
          const bp = inboundData?.byPhase || {};
          const phaseColors = { 'On the Water': T.blue, 'Pending': T.amber, 'Received': T.green };

          const renderPOList = (orders, phase) => {
            const list = inboundSearch ? orders.filter(o => {
              const q = inboundSearch.toLowerCase();
              return o.poNumber?.toLowerCase().includes(q) || o.vendor?.toLowerCase().includes(q) || o.memo?.toLowerCase().includes(q) || o.lines?.some(l => l.sku?.toLowerCase().includes(q));
            }) : orders;
            if (list.length === 0) return null;
            return list.map(o => (
              <div key={o.id} style={{ borderBottom: `1px solid ${T.border}`, padding: '10px 16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                  <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                    <span style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: T.text }}>{o.poNumber}</span>
                    <span style={{ fontSize: 11, color: T.textMuted }}>{o.vendor}</span>
                    <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 3, fontWeight: 700, fontFamily: mono, background: `${phaseColors[phase]}20`, color: phaseColors[phase] }}>{phase.toUpperCase()}</span>
                    {o.shipDate && <span style={{ fontSize: 10, color: T.textDim, fontFamily: mono }}>Shipped: {o.shipDate}</span>}
                  </div>
                  <div style={{ display: 'flex', gap: 14, fontFamily: mono, fontSize: 11, color: T.textMuted }}>
                    <span>PO: {o.date}</span>
                    <span style={{ color: T.amber }}>{o.totalQty} units</span>
                    <span>${Math.round(o.totalAmount).toLocaleString()}</span>
                  </div>
                </div>
                {o.memo && <div style={{ fontSize: 10, color: T.textDim, marginBottom: 4 }}>{o.memo}</div>}
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {(o.lines || []).slice(0, 6).map((l, i) => (
                    <span key={i} style={{ fontSize: 9, padding: '2px 6px', background: T.bg, borderRadius: 3, fontFamily: mono, color: T.textMuted }}>{l.sku} x{l.qty}</span>
                  ))}
                  {(o.lines || []).length > 6 && <span style={{ fontSize: 9, color: T.textDim }}>+{o.lines.length - 6} more</span>}
                </div>
              </div>
            ));
          };

          return (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Inbound / In-Transit</h3>
                <ExportBtn onClick={() => {
                  const allOrders = [...(inboundData?.onTheWater || []), ...(inboundData?.pending || []), ...(inboundData?.received || [])];
                  const rows = [];
                  for (const o of allOrders) {
                    for (const l of (o.lines || [])) {
                      rows.push({ po: o.poNumber, phase: o.phase, date: o.date, shipDate: o.shipDate || '', vendor: o.vendor, memo: o.memo, status: o.status, sku: l.sku, name: l.name, category: l.category, qty: l.qty, rate: l.rate, amount: l.amount });
                    }
                  }
                  downloadCSV('inbound.csv', ['po','phase','date','shipDate','vendor','memo','status','sku','name','category','qty','rate','amount'], rows);
                }} />
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>ON THE WATER</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.blue, fontFamily: mono }}>{bp.onTheWater?.count || 0}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{(bp.onTheWater?.qty || 0).toLocaleString()} units · ${Math.round(bp.onTheWater?.amount || 0).toLocaleString()}</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>PENDING / WIP</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.amber, fontFamily: mono }}>{bp.pending?.count || 0}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{(bp.pending?.qty || 0).toLocaleString()} units · ${Math.round(bp.pending?.amount || 0).toLocaleString()}</div>
                </Card>
                <Card style={{ padding: 14, textAlign: "center", borderLeft: `4px solid ${T.green}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>RECEIVED</div>
                  <div style={{ fontSize: 28, fontWeight: 800, color: T.green, fontFamily: mono }}>{bp.received?.count || 0}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono }}>{(bp.received?.qty || 0).toLocaleString()} units · ${Math.round(bp.received?.amount || 0).toLocaleString()}</div>
                </Card>
              </div>

              <div style={{ marginBottom: 12 }}>
                <input type="text" placeholder="Search PO#, vendor, SKU, memo..." value={inboundSearch} onChange={e => setInboundSearch(e.target.value)}
                  style={{ width: '100%', maxWidth: 400, padding: "10px 14px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }} />
              </div>

              {/* On the Water */}
              {(inboundData?.onTheWater || []).length > 0 && (
                <Card style={{ marginBottom: 16 }}>
                  <SectionHeader right={`${(inboundData?.onTheWater || []).length} POs`}>On the Water</SectionHeader>
                  <div style={{ maxHeight: 400, overflowY: 'auto' }}>{renderPOList(inboundData?.onTheWater || [], 'On the Water')}</div>
                </Card>
              )}

              {/* Pending / WIP */}
              {(inboundData?.pending || []).length > 0 && (
                <Card style={{ marginBottom: 16 }}>
                  <SectionHeader right={`${(inboundData?.pending || []).length} POs`}>Pending / WIP</SectionHeader>
                  <div style={{ maxHeight: 400, overflowY: 'auto' }}>{renderPOList(inboundData?.pending || [], 'Pending')}</div>
                </Card>
              )}

              {/* Received */}
              {(inboundData?.received || []).length > 0 && (
                <Card style={{ marginBottom: 16 }}>
                  <SectionHeader right={`${(inboundData?.received || []).length} POs`}>Received</SectionHeader>
                  <div style={{ maxHeight: 300, overflowY: 'auto' }}>{renderPOList(inboundData?.received || [], 'Received')}</div>
                </Card>
              )}
            </div>
          );
        })()}

        {sub === "pos" && (() => {
          if (!poData) {
            fetch(`${ovenServerUrl}/api/netsuite/pos`).then(r => r.json()).then(setPoData).catch(() => {});
          }
          const orders = poData?.orders || [];
          let filtered = orders;
          if (poFilter !== 'all') filtered = filtered.filter(o => o.status === poFilter);
          if (poSearch) {
            const q = poSearch.toLowerCase();
            filtered = filtered.filter(o => o.poNumber?.toLowerCase().includes(q) || o.vendor?.toLowerCase().includes(q) || o.lines?.some(l => l.sku?.toLowerCase().includes(q)));
          }

          const statuses = {};
          for (const o of orders) statuses[o.status] = (statuses[o.status] || 0) + 1;
          const totalQty = filtered.reduce((s, o) => s + o.totalQty, 0);
          const totalAmount = filtered.reduce((s, o) => s + o.totalAmount, 0);

          return (
            <div>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
                <h3 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: T.text }}>Purchase Orders</h3>
                <div style={{ fontSize: 11, color: T.textDim, fontFamily: mono }}>Last sync: {poData?.lastSync ? new Date(poData.lastSync).toLocaleString() : '—'}</div>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 10, marginBottom: 16 }}>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.blue}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>OPEN POs</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.blue, fontFamily: mono }}>{filtered.length}</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.amber}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>TOTAL QTY ORDERED</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.amber, fontFamily: mono }}>{totalQty.toLocaleString()}</div>
                </Card>
                <Card style={{ padding: 12, textAlign: "center", borderLeft: `4px solid ${T.textDim}` }}>
                  <div style={{ fontSize: 9, color: T.textDim, fontFamily: mono, letterSpacing: 1 }}>TOTAL AMOUNT</div>
                  <div style={{ fontSize: 24, fontWeight: 800, color: T.text, fontFamily: mono }}>${Math.round(totalAmount).toLocaleString()}</div>
                </Card>
              </div>

              <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
                <input type="text" placeholder="Search PO#, vendor, SKU..." value={poSearch} onChange={e => setPoSearch(e.target.value)}
                  style={{ flex: 1, padding: "10px 14px", background: T.surface, border: `1px solid ${T.border}`, borderRadius: 8, color: T.text, fontSize: 13, fontFamily: mono }} />
                {['all', ...Object.keys(statuses)].map(s => (
                  <button key={s} onClick={() => setPoFilter(s)} style={{
                    padding: "8px 14px", borderRadius: 6, fontSize: 11, fontWeight: 600, fontFamily: mono, cursor: "pointer",
                    background: poFilter === s ? T.blue : 'transparent', color: poFilter === s ? '#fff' : T.textMuted,
                    border: `1px solid ${poFilter === s ? T.blue : T.border}`
                  }}>{s === 'all' ? `All (${orders.length})` : `${s} (${statuses[s]})`}</button>
                ))}
              </div>

              <Card>
                <div style={{ maxHeight: 600, overflowY: 'auto' }}>
                  {filtered.map(o => (
                    <div key={o.id} style={{ borderBottom: `1px solid ${T.border}` }}>
                      <div onClick={() => setPoExpanded(poExpanded === o.id ? null : o.id)} style={{
                        display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 16px', cursor: 'pointer',
                        background: poExpanded === o.id ? `${T.blue}08` : 'transparent'
                      }}>
                        <div style={{ display: 'flex', gap: 16, alignItems: 'center' }}>
                          <div style={{ fontFamily: mono, fontSize: 13, fontWeight: 700, color: T.text }}>{o.poNumber}</div>
                          <div style={{ fontSize: 11, color: T.textMuted }}>{o.vendor}</div>
                          <span style={{ fontSize: 10, padding: '2px 8px', borderRadius: 4, fontWeight: 600, fontFamily: mono,
                            background: o.statusCode === 'B' ? `${T.amber}20` : o.statusCode === 'C' ? `${T.green}20` : `${T.blue}20`,
                            color: o.statusCode === 'B' ? T.amber : o.statusCode === 'C' ? T.green : T.blue
                          }}>{o.status}</span>
                          {(o.statusCode === 'B' || o.statusCode === 'C') && <span style={{ fontSize: 9, padding: '2px 6px', borderRadius: 3, fontWeight: 700, fontFamily: mono, background: `${T.blue}20`, color: T.blue }}>ON THE WATER</span>}
                        </div>
                        <div style={{ display: 'flex', gap: 20, alignItems: 'center', fontFamily: mono, fontSize: 11 }}>
                          <span style={{ color: T.textMuted }}>{o.date}</span>
                          <span style={{ color: T.text }}>{o.lineCount} items</span>
                          <span style={{ color: T.amber }}>Qty: {o.totalQty}</span>
                          <span style={{ color: T.textDim }}>${Math.round(o.totalAmount).toLocaleString()}</span>
                          <span style={{ fontSize: 12, color: T.textDim }}>{poExpanded === o.id ? '▲' : '▼'}</span>
                        </div>
                      </div>
                      {poExpanded === o.id && o.lines?.length > 0 && (
                        <div style={{ padding: '0 16px 12px 32px', background: `${T.blue}05` }}>
                          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11, fontFamily: mono }}>
                            <thead>
                              <tr>
                                <th style={{ padding: '6px 8px', textAlign: 'left', color: T.textDim, fontSize: 9, borderBottom: `1px solid ${T.border}` }}>SKU</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', color: T.textDim, fontSize: 9, borderBottom: `1px solid ${T.border}` }}>NAME</th>
                                <th style={{ padding: '6px 8px', textAlign: 'left', color: T.textDim, fontSize: 9, borderBottom: `1px solid ${T.border}` }}>CAT</th>
                                <th style={{ padding: '6px 8px', textAlign: 'right', color: T.textDim, fontSize: 9, borderBottom: `1px solid ${T.border}` }}>QTY</th>
                                <th style={{ padding: '6px 8px', textAlign: 'right', color: T.textDim, fontSize: 9, borderBottom: `1px solid ${T.border}` }}>RATE</th>
                                <th style={{ padding: '6px 8px', textAlign: 'right', color: T.textDim, fontSize: 9, borderBottom: `1px solid ${T.border}` }}>AMOUNT</th>
                              </tr>
                            </thead>
                            <tbody>
                              {o.lines.map((l, i) => (
                                <tr key={i} style={{ borderBottom: `1px solid ${T.border}22` }}>
                                  <td style={{ padding: '5px 8px', color: T.text, fontWeight: 600 }}>{l.sku}</td>
                                  <td style={{ padding: '5px 8px', color: T.textMuted, maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{l.name}</td>
                                  <td style={{ padding: '5px 8px', color: T.cyan, fontSize: 9 }}>{l.category}</td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right', color: T.amber }}>{l.qty}</td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right', color: T.textMuted }}>${l.rate?.toFixed(2) || '—'}</td>
                                  <td style={{ padding: '5px 8px', textAlign: 'right', color: T.textDim }}>${Math.round(l.amount).toLocaleString()}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>
                      )}
                    </div>
                  ))}
                  {filtered.length === 0 && <div style={{ padding: 20, textAlign: "center", color: T.textDim }}>No purchase orders found</div>}
                </div>
              </Card>
            </div>
          );
        })()}

        {sub === "tops" && (() => {
          const uploadTopsFile = async (file) => {
            setTopsUploading(true);
            setTopsError(null);
            setTopsResult(null);
            try {
              const body = file.name.endsWith('.xlsx') ? await file.arrayBuffer() : await file.text();
              const contentType = file.name.endsWith('.xlsx') ? 'application/octet-stream' : 'text/csv';
              const resp = await fetch(`${ovenServerUrl}/api/inventory/tops/upload`, {
                method: 'POST',
                headers: { 'Content-Type': contentType, 'X-Filename': file.name },
                body
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
                <input ref={topsFileRef} type="file" accept=".csv,.xlsx" onChange={handleTopsSelect} style={{ display: 'none' }} />
                {topsUploading ? (
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Uploading...</div>
                ) : (
                  <>
                    <div style={{ fontSize: 28, marginBottom: 8 }}>+</div>
                    <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>Drop TOPS file here</div>
                    <div style={{ fontSize: 12, color: T.textMuted, marginTop: 4 }}>or click to browse — XLSX (Tops Inventory) or CSV (SKU + QTY)</div>
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
                  <div style={{ fontSize: 14, fontWeight: 600, color: T.text }}>{topsData?.items?.[0]?.count_date || (topsData?.lastUpload ? new Date(topsData.lastUpload.uploaded_at).toLocaleDateString() : 'Never')}</div>
                  <div style={{ fontSize: 10, color: T.textMuted, fontFamily: mono, marginTop: 4 }}>COUNT DATE</div>
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
                          <th style={{ fontFamily: mono, fontSize: 9, color: T.textDim, letterSpacing: 1.5, textAlign: 'left', padding: '9px 12px', borderBottom: `2px solid ${T.border}`, textTransform: 'uppercase' }}>MODEL</th>
                          <th style={{ fontFamily: mono, fontSize: 9, color: T.textDim, letterSpacing: 1.5, textAlign: 'left', padding: '9px 12px', borderBottom: `2px solid ${T.border}`, textTransform: 'uppercase' }}>TOP CODE</th>
                          <th style={{ fontFamily: mono, fontSize: 9, color: T.textDim, letterSpacing: 1.5, textAlign: 'left', padding: '9px 12px', borderBottom: `2px solid ${T.border}`, textTransform: 'uppercase' }}>UPC</th>
                          <th style={{ fontFamily: mono, fontSize: 9, color: T.textDim, letterSpacing: 1.5, textAlign: 'right', padding: '9px 12px', borderBottom: `2px solid ${T.border}`, textTransform: 'uppercase' }}>QTY</th>
                          <th style={{ fontFamily: mono, fontSize: 9, color: T.textDim, letterSpacing: 1.5, textAlign: 'left', padding: '9px 12px', borderBottom: `2px solid ${T.border}`, textTransform: 'uppercase' }}>LOCATION</th>
                        </tr>
                      </thead>
                      <tbody>
                        {filtered.map((item, i) => (
                          <tr key={i} style={{ borderBottom: `1px solid ${T.border}` }}>
                            <td style={{ padding: '8px 12px', fontFamily: mono, fontSize: 12, color: T.text }}>{item.model_name || '—'}</td>
                            <td style={{ padding: '8px 12px', fontFamily: mono, fontSize: 12, color: T.textMuted }}>{item.top_code || '—'}</td>
                            <td style={{ padding: '8px 12px', fontFamily: mono, fontSize: 12, color: T.text }}>{item.upc || item.sku}</td>
                            <td style={{ padding: '8px 12px', fontFamily: mono, fontSize: 12, color: T.text, textAlign: 'right' }}>{item.qty.toLocaleString()}</td>
                            <td style={{ padding: '8px 12px', fontFamily: mono, fontSize: 11, color: T.textMuted }}>{item.location || '—'}</td>
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
