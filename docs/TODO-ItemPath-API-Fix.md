# TODO: Stop Killing the ItemPath API

**Problem:** Lab_Assistant polls ItemPath every 60 seconds with 6 parallel calls
totaling 4–6 MB per poll = ~300 MB/hour. This overloads the API.

**Single source of all ItemPath calls:** `server/itempath-adapter.js` (lines 517–527)

---

## Current State (after recent fixes)

| Call | Params | Est. Size | Frequency |
|------|--------|-----------|-----------|
| `/api/materials` | `limit=10000` | 3–5 MB | Every 60s |
| `/api/orders` | `limit=200, status=In Process` | ~50 KB | Every 60s |
| `/api/transactions` (all) | `after=today, limit=200` | ~100 KB | Every 60s |
| `/api/transactions` (picks) | `type=4, after=today, limit=500` | ~200 KB | Every 60s |
| `/api/transactions` (puts) | `type=3, after=today, limit=500` | ~200 KB | Every 60s |
| `/api/warehouses` | (none) | ~5 KB | Every 60s |
| `/api/locations` | `limit=20000` | 7 MB | Every 60 min (cached) |
| **TOTAL per poll** | | **~4–6 MB** | **Every 60s** |
| **TOTAL per hour** | | **~240–360 MB** | |

---

## Fix List (priority order)

### 1. DONE — Locations cached (60-min TTL)
- [x] `getLocationsData()` caches locations, refreshes once per hour
- Savings: 7 MB × 59 polls = **~413 MB/hr saved**

### 2. DONE — Gateway proxies through Lab Server cache
- [x] Gateway `/api/inventory/*` endpoints proxy to Lab Server, not direct to ItemPath
- Savings: Eliminated 6 duplicate direct ItemPath calls per browser request

### 3. DONE — Transactions limited to today only
- [x] All transaction calls use `after=todayStart`
- [x] Limits reduced from 5000/2000/500 to 500/500/200

### 4. TODO — Cache materials like locations (biggest remaining win)
Materials is 3–5 MB and rarely changes mid-shift. Cache it.
- **File:** `server/itempath-adapter.js`
- **Change:** Cache materials with 5-min TTL (like locations has 60-min TTL)
- **Why 5 min not 60:** Lens blanks get picked throughout the day, qty changes matter
- **Savings:** ~3–5 MB × 48 skipped polls per 5 min window = **~80% reduction**
- **Risk:** Stock levels lag by up to 5 minutes (acceptable for dashboard display)

### 5. TODO — Slow down the poll interval
60 seconds is aggressive. The dashboard doesn't need sub-minute updates.
- **File:** `server/itempath-adapter.js` line 40 / `.env`
- **Change:** Set `ITEMPATH_POLL_MS=120000` (2 minutes) or `180000` (3 minutes)
- **Savings:** 50–67% reduction in all call volume
- **Risk:** Dashboard data lags by 2–3 min instead of 1 min

### 6. TODO — Deduplicate the 3 transaction calls into 1
Currently 3 separate transaction calls per poll. Could be 1 call.
- **File:** `server/itempath-adapter.js` lines 520–522
- **Current:** 3 calls: all types + type 4 + type 3 (overlapping data)
- **Change:** Single call: `/api/transactions?after=todayStart&limit=500`
  Then split results client-side by `type` field
- **Savings:** Eliminates 2 API calls per poll (~300 KB saved)
- **Risk:** If ItemPath API doesn't return `type` field, filter won't work.
  Test with one call first and check the response shape.

### 7. TODO — Warehouses: cache like locations
Warehouse list never changes during a shift.
- **File:** `server/itempath-adapter.js`
- **Change:** Cache with 60-min TTL (same pattern as locations)
- **Savings:** Tiny per-call but eliminates 59 unnecessary calls/hour

### 8. TODO — Add If-Modified-Since / ETag support
If ItemPath supports conditional requests, skip re-downloading unchanged data.
- **File:** `server/itempath-adapter.js` `ipFetch()` function
- **Change:** Store `ETag` / `Last-Modified` header from response, send
  `If-None-Match` / `If-Modified-Since` on next request. If 304, use cache.
- **Savings:** Could eliminate 90%+ of bandwidth if ItemPath supports it
- **Risk:** ItemPath may not support conditional requests. Test manually first:
  ```bash
  curl -I -H "Authorization: Bearer $TOKEN" https://paireyewear.itempath.com/api/materials?limit=1
  ```
  Look for `ETag` or `Last-Modified` in response headers.

### 9. TODO — Add backoff on errors
If ItemPath returns 429 or 5xx, back off instead of retrying at 60s.
- **File:** `server/itempath-adapter.js` `poll()` function
- **Change:** On error, double the poll interval (120s, 240s, 480s).
  Reset to normal on success.
- **Risk:** None. Prevents hammering a struggling API.

### 10. TODO — Frontend: slow down putwall polling
`src/App.jsx` polls `/api/inventory/putwall` every **10 seconds**.
This doesn't hit ItemPath directly (reads from Lab Server cache),
but it's unnecessary load on the Lab Server.
- **File:** `src/App.jsx` line ~1986
- **Change:** Poll every 30s instead of 10s
- **Risk:** Put wall position updates lag by 30s instead of 10s

---

## Target State After All Fixes

| Call | Frequency | Est. Size |
|------|-----------|-----------|
| `/api/materials` | Every 5 min | 3–5 MB |
| `/api/transactions` (single) | Every 2 min | ~300 KB |
| `/api/orders` | Every 2 min | ~50 KB |
| `/api/locations` | Every 60 min | 7 MB |
| `/api/warehouses` | Every 60 min | ~5 KB |
| **TOTAL per hour** | | **~50 MB** (down from ~300 MB) |

---

## Files to Update on Server

After implementing fixes, copy these to the live server:
1. `server/itempath-adapter.js` — all polling changes
2. `gateway/index.ts` — proxy changes (already done)

Then restart: `bash stop.sh && bash start.sh`

---

## How to Verify

After restart, watch the logs:
```
[ItemPath] /api/materials?limit=10000 → 4200.3 KB
[ItemPath] /api/transactions?after=2026-03-10&limit=200 → 89.1 KB
[ItemPath] /api/transactions?type=4&after=2026-03-10&limit=500 → 112.4 KB
[ItemPath] /api/transactions?type=3&after=2026-03-10&limit=500 → 98.7 KB
[ItemPath] /api/orders?limit=200&status=In+Process → 45.2 KB
[ItemPath] All fetches completed in 1200ms
[ItemPath] ✓ Sync: 3200 SKUs, 12 active orders, 3 alerts, 18400 locations | cache=892 KB | 1450ms total
```

Every call now logs its payload size. If any single call is over 1 MB
(other than materials), investigate.
