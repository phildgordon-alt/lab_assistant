'use strict';

function normalizeWarehouse(raw) {
  const wh = raw || '';
  if (/kitchen/i.test(wh) || /wh3/i.test(wh)) return 'WH3';
  if (/wh2/i.test(wh)) return 'WH2';
  if (/wh1/i.test(wh)) return 'WH1';
  return wh;
}

module.exports = { normalizeWarehouse };
