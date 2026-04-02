#!/usr/bin/env python3
"""
Cross-reference DVI shipped XMLs vs Looker to find where the variance is.
Run on Mac Studio: python3 check_variance.py
"""
import json, urllib.request, urllib.parse, os, re

LOOKER_URL = "https://PairEyewear.cloud.looker.com"
CLIENT_ID = "R67SBc68xqrYpsBqpc2Y"
CLIENT_SECRET = "TbBbjfmx4y3jWK8VJQztt7BJ"
SHIPPED_DIR = os.path.join(os.path.dirname(__file__), "data", "dvi", "shipped")
import sys
if len(sys.argv) > 1:
    TARGET_ISO = sys.argv[1]  # e.g., 2026-03-31
    parts = TARGET_ISO.split("-")
    TARGET_DATE = f"{parts[1]}/{parts[2]}"  # e.g., 03/31
else:
    TARGET_DATE = "03/31"
    TARGET_ISO = "2026-03-31"

# 1. Get all References from shipped XMLs for target date
print(f"Scanning {SHIPPED_DIR} for ShipDate={TARGET_DATE}...")
dvi_refs = {}
count = 0
for fname in os.listdir(SHIPPED_DIR):
    if not fname.endswith(".xml"):
        continue
    fpath = os.path.join(SHIPPED_DIR, fname)
    with open(fpath, "r", errors="ignore") as f:
        content = f.read()
    if f'ShipDate="{TARGET_DATE}' not in content:
        continue
    count += 1
    m = re.search(r'Reference="([^"]*)"', content)
    ref = m.group(1) if m else ""
    dvi_refs[ref] = fname.replace(".xml", "")
print(f"Found {count} XMLs with ShipDate={TARGET_DATE}, {len(dvi_refs)} unique References")

# 2. Auth with Looker
print("Authenticating with Looker...")
data = urllib.parse.urlencode({"client_id": CLIENT_ID, "client_secret": CLIENT_SECRET}).encode()
req = urllib.request.Request(f"{LOOKER_URL}:19999/api/4.0/login", data=data)
token = json.loads(urllib.request.urlopen(req, timeout=15).read())["access_token"]

# 3. Query Looker for ALL order_numbers this year
print("Querying Looker for all shipped jobs (2026)...")
body = json.dumps({
    "model": "operations", "view": "poms_jobs",
    "fields": ["poms_jobs.order_number", "dvi_jobs.sent_from_lab_date"],
    "filters": {"dvi_jobs.dvi_destination": "PAIR", "dvi_jobs.sent_from_lab_date": "2026-01-01 to today"},
    "sorts": ["dvi_jobs.sent_from_lab_date desc"], "limit": 500000
}).encode()
req = urllib.request.Request(
    f"{LOOKER_URL}:19999/api/4.0/queries/run/json", body,
    {"Authorization": f"token {token}", "Content-Type": "application/json"}
)
rows = json.loads(urllib.request.urlopen(req, timeout=120).read())
looker = {}
for r in rows:
    on = r.get("poms_jobs.order_number", "")
    d = r.get("dvi_jobs.sent_from_lab_date", "")
    if on and d and on not in looker:
        looker[on] = d
print(f"Looker has {len(looker)} distinct order_numbers across all dates")

# 4. Cross-reference
mar31 = 0
other_date = 0
not_found = 0
date_buckets = {}
missing_refs = []

suffix_matched = 0
for ref, invoice in dvi_refs.items():
    # Try exact match first, then strip -1/-2/-3 suffix
    matched_ref = None
    if ref in looker:
        matched_ref = ref
    else:
        base = ref.split("-")[0]
        if base != ref and base in looker:
            matched_ref = base
            suffix_matched += 1

    if matched_ref:
        if looker[matched_ref] == TARGET_ISO:
            mar31 += 1
        else:
            other_date += 1
            d = looker[matched_ref]
            date_buckets[d] = date_buckets.get(d, 0) + 1
    else:
        not_found += 1
        missing_refs.append((ref, invoice))

print(f"\n{'='*50}")
print(f"RESULTS — DVI ShipDate {TARGET_DATE} vs Looker")
print(f"{'='*50}")
print(f"DVI XMLs with ShipDate {TARGET_DATE}:  {count}")
print(f"In Looker as {TARGET_ISO}:              {mar31}")
print(f"In Looker under DIFFERENT date:         {other_date}")
print(f"NOT in Looker at all:                   {not_found}")
print(f"  (of which matched via suffix strip:   {suffix_matched})")

if date_buckets:
    print(f"\nDate-shifted jobs:")
    for d in sorted(date_buckets.keys()):
        print(f"  {d}: {date_buckets[d]}")

if missing_refs:
    # Show invoice number distribution
    inv_nums = sorted([int(inv) for ref, inv in missing_refs if inv.isdigit()])
    if inv_nums:
        print(f"\nMissing job invoice range: {inv_nums[0]} - {inv_nums[-1]}")
        # Bucket by thousands
        buckets = {}
        for n in inv_nums:
            k = f"{n // 1000}xxx"
            buckets[k] = buckets.get(k, 0) + 1
        print(f"Distribution by invoice range:")
        for k in sorted(buckets.keys()):
            print(f"  {k}: {buckets[k]}")

    print(f"\nAll missing (Reference -> Invoice):")
    for ref, inv in sorted(missing_refs, key=lambda x: x[1]):
        print(f"  {ref} -> {inv}.xml")
