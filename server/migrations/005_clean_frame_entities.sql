-- 005_clean_frame_entities.sql
--
-- One-time cleanup. The 2026-05-06 frame-fields backfill landed
-- frame_upc / frame_style / frame_color values that contain the
-- literal string `&#x20;&#x20;` (DVI pads SKUs with HTML space
-- entities and the parser's _trim helper only stripped actual
-- whitespace, not the literal entity text). Result: rows store
-- e.g. `196016720664&#x20;&#x20;` and equality matches against the
-- bare SKU return zero hits — which broke the holds feature's
-- "find active jobs picking this SKU" lookup.
--
-- The parser is fixed forward (oven-timer-server.js parseDviXml
-- and scripts/backfill-frame-fields-from-inbound-xml.js now decode
-- entities before trimming). This migration cleans the historical
-- pollution so the next equality check works without tricks.
--
-- Idempotent — REPLACE on already-clean values is a no-op.

UPDATE jobs SET frame_upc   = TRIM(REPLACE(REPLACE(frame_upc,   '&#x20;', ' '), '  ', ' ')) WHERE frame_upc   LIKE '%&#x20;%';
UPDATE jobs SET frame_name  = TRIM(REPLACE(REPLACE(frame_name,  '&#x20;', ' '), '  ', ' ')) WHERE frame_name  LIKE '%&#x20;%';
UPDATE jobs SET frame_style = TRIM(REPLACE(REPLACE(frame_style, '&#x20;', ' '), '  ', ' ')) WHERE frame_style LIKE '%&#x20;%';
UPDATE jobs SET frame_color = TRIM(REPLACE(REPLACE(frame_color, '&#x20;', ' '), '  ', ' ')) WHERE frame_color LIKE '%&#x20;%';
UPDATE jobs SET frame_sku   = TRIM(REPLACE(REPLACE(frame_sku,   '&#x20;', ' '), '  ', ' ')) WHERE frame_sku   LIKE '%&#x20;%';
UPDATE jobs SET frame_mfr   = TRIM(REPLACE(REPLACE(frame_mfr,   '&#x20;', ' '), '  ', ' ')) WHERE frame_mfr   LIKE '%&#x20;%';
