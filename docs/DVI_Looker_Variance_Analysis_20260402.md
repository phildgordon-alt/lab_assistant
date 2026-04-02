# DVI vs Looker Shipped Jobs Variance Analysis

**Date:** April 2, 2026
**Prepared by:** Phil Gordon, VP R&D — Pair Eyewear
**Subject:** 159 shipped jobs missing from Looker/NetSuite for March 31, 2026

---

## Summary

On March 31, 2026, DVI processed and shipped **1,004 jobs**. Looker (which ingests DVI data via the megafile) only shows **844 distinct jobs** for that date. After investigation, the breakdown is:

| Category | Count | Explanation |
|----------|-------|-------------|
| Matched in Looker as Mar 31 | 838 | Correct — DVI and Looker agree |
| Remakes (suffix jobs) | 70 | DVI creates separate XMLs for -1/-2/-3 remakes; Looker counts under base order — expected |
| Date-shifted to Apr 1 | 6 | Minor — 6 jobs show as Apr 1 in Looker |
| Date-shifted to Mar 19 | 1 | Minor — 1 job shows as Mar 19 in Looker |
| **Not in Looker at all** | **159** | **These jobs are missing from Looker/NetSuite entirely** |
| **Total** | **1,004** | |

The 70 remake suffix jobs are expected behavior (not a discrepancy). The real gap is **159 jobs** that DVI shipped but that never appeared in Looker under any date.

---

## Data Sources Used in This Analysis

### Source 1: DVI Shipped XML Files (Ground Truth for Shipping)

- **Location:** Mac Studio at `/Users/Shared/lab_assistant/data/dvi/shipped/`
- **Origin:** Synced every 60 seconds from the DVI server (`192.168.0.27`) via SMB share `visdir\VISION\SHIPLOG`
- **Format:** One XML file per shipped job, named `{invoice_number}.xml` (MegaTransfer format)
- **What's inside each file:** Full job details including:
  - `OrderData Invoice="428007"` — DVI invoice number (the filename)
  - `OrderData Reference="3171471"` — Shopify order ID
  - `OrderData RxNumber="D4247540700"` — DVI prescription tracking ID
  - `OrderData ShipDate="03/31/26"` — Date the job shipped
  - Lens details (OPC, material, Rx), frame info, coating, operator
- **Count for Mar 31:** 1,004 XML files with `ShipDate="03/31"`
- **Verified:** 1,004 unique References (Shopify order IDs) — no duplicates
- **Why this is authoritative:** DVI generates one XML per shipped job at ship time. File count = ship count. These files are the lab's source of truth for what physically shipped.

### Source 2: Looker API (Ingests the DVI Megafile via POMS/NetSuite)

- **Endpoint:** `https://PairEyewear.cloud.looker.com:19999/api/4.0/queries/run/json`
- **Model:** `operations` / View: `poms_jobs`
- **Fields queried:** `poms_jobs.order_number`, `poms_jobs.job_id`, `poms_jobs.dvi_id`, `dvi_jobs.sent_from_lab_date`
- **Filter:** `dvi_jobs.dvi_destination = 'PAIR'`, date range `2026-01-01 to today`
- **Count for Mar 31:** 844 distinct `job_id` values with `sent_from_lab_date = 2026-03-31`
- **Why this is authoritative for what NetSuite sees:** Looker reads from the same data that DVI sends in its nightly megafile to POMS/NetSuite. If a job isn't in Looker, it wasn't in the megafile or failed during ingestion.

### How the Two Sources Connect

The DVI shipped XML `Reference` field = Looker's `poms_jobs.order_number` (the Shopify order ID). This is the join key used for cross-referencing.

**Verified mapping (job 418178, shipped Mar 27):**

| XML Field | Value | Looker Field | Value | Match |
|-----------|-------|-------------|-------|-------|
| Reference | 3001290 | order_number | 3001290 | Yes |
| RxNumber | D029900389 | dvi_id | D029900389 | Yes |
| ShipDate | 03/27/26 | sent_from_lab_date | 2026-03-27 | Yes |

**Note on DVI ID format:** XML `RxNumber` may have a trailing zero that Looker drops (e.g., XML: `D4247540700`, Looker: `D424754070`). The `Reference`/`order_number` match is more reliable.

---

## Methodology

### Step 1: Count DVI shipped XMLs for Mar 31
Scanned all `.xml` files in the shipped directory. Found 1,004 files with `ShipDate="03/31"`. Extracted the `Reference` (Shopify order ID) from each. Confirmed all 1,004 are unique — one file per job, no duplicates.

### Step 2: Query Looker for ALL shipped jobs in 2026
Queried the Looker API for every `order_number` and `sent_from_lab_date` for the entire year (500K row limit, well within bounds — total was ~30,318 distinct order numbers).

### Step 3: Cross-reference DVI References against Looker order_numbers
For each of the 1,004 DVI References:
1. **Exact match** — check if the Reference exists in Looker as an `order_number`
2. **Suffix strip** — if no exact match, strip the `-1`/`-2`/`-3` remake suffix and try again (DVI adds suffixes for remakes; Looker stores the base order number)
3. **Check ALL dates** — if found in Looker, check whether `sent_from_lab_date` is Mar 31 or a different date

This approach determines whether missing jobs are:
- **Date-shifted** — in Looker but under a different date (Looker ingestion issue)
- **Truly missing** — not in Looker under any date (megafile didn't include them)

---

## Findings

### The 70 Remake Suffix Jobs — Expected, Not a Discrepancy
DVI creates a new job (with a new invoice number and a suffixed Reference like `3173879-1`) for each remake. Looker counts these under the original order number `3173879`. This is correct — the remake is fulfilling the same customer order. DVI's XML count is higher because it counts each attempt separately.

### The 7 Date-Shifted Jobs — Minor
- 6 jobs have `sent_from_lab_date = 2026-04-01` in Looker despite having `ShipDate="03/31"` in the DVI XML
- 1 job has `sent_from_lab_date = 2026-03-19`

Likely cause: the megafile that DVI sends at midnight may attribute these to the date it was processed rather than the actual ship date, or there's a timezone/cutoff issue.

### The 159 Truly Missing Jobs — Action Required
These 159 jobs have DVI shipped XMLs with `ShipDate="03/31"`, but their Shopify order number (`Reference`) does not appear in Looker under ANY date in 2026. The megafile that DVI sends to POMS/NetSuite did not include these jobs.

**Sample missing jobs:**

| Shopify Order (Reference) | DVI Invoice | XML File |
|--------------------------|-------------|----------|
| 3150142 | 423568 | 423568.xml |
| 3142961 | 422312 | 422312.xml |
| 3132846 | 423030 | 423030.xml |
| 3142487 | 421974 | 421974.xml |
| 3126060 | 422299 | 422299.xml |
| 3144751 | 422070 | 422070.xml |
| 3148968 | 423347 | 423347.xml |
| 2944098 | 421544 | 421544.xml |
| 3135121 | 419795 | 419795.xml |
| 3145020 | 422307 | 422307.xml |

**Observation:** The DVI invoice numbers (419xxx–423xxx) are notably lower than expected for Mar 31 shipped jobs (which should be in the 428xxx–430xxx range). These appear to be older jobs that were in the lab for an extended period before shipping. It's possible DVI's megafile export has a cutoff or filter that excludes jobs below a certain invoice number or entry date.

---

## Historical Context

The variance between DVI shipped and Looker has always existed at a baseline of ~3-5%:

| Date | DVI XMLs | Looker | Gap | % |
|------|----------|--------|-----|---|
| Mar 10 | 1,231 | 1,187 | 44 | 3.6% |
| Mar 27 | 859 | 853 | 6 | 0.7% |
| Mar 28 | 409 | 406 | 3 | 0.7% |
| Mar 30 | 813 | 787 | 26 | 3.2% |
| **Mar 31** | **1,004** | **844** | **160** | **16%** |
| Apr 1 | 612 | 665 | -53 | -8.6% |

Mar 31 is a clear outlier. The gap jumped from a normal 3-5% to 16%. Apr 1 shows a negative variance (Looker has MORE than DVI XMLs), which could indicate jobs from Mar 31 posting as Apr 1 in NetSuite, but only 6 date-shifted jobs were found — not enough to explain the full Apr 1 surplus.

---

## Questions for DVI

1. **Is there a filter or cutoff in the nightly megafile export?** The 159 missing jobs have lower invoice numbers (419xxx–423xxx), suggesting they entered the lab weeks before shipping. Does the megafile exclude jobs older than a certain date or below a certain invoice number?

2. **Did the Mar 31 midnight batch run successfully?** The spike from ~3% to 16% variance is sudden. Was there an error or timeout in the batch process that night?

3. **Can you provide the megafile sent on Mar 31 night?** Comparing the megafile contents against the 159 missing References would confirm whether the jobs were omitted from the megafile or dropped during Looker/POMS ingestion.

4. **Is the `sent_from_lab_date` in the megafile always the same as `ShipDate` in the XML?** Or can it be set to the batch processing date? This would explain the 6 date-shifted jobs.

---

## Script Used

The cross-reference was performed by `check_variance.py` in the Lab Assistant repository. It:
1. Scans all shipped XML files for a target ShipDate
2. Authenticates with the Looker API using OAuth2 credentials
3. Queries all shipped jobs for the year
4. Cross-references by Shopify order ID (XML `Reference` = Looker `order_number`)
5. Reports exact matches, date shifts, suffix/remake matches, and truly missing jobs
