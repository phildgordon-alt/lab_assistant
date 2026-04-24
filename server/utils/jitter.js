'use strict';
// jitterInterval(ms) — returns ms with ±20% random offset to prevent
// multiple pollers aligning on the same second. Use as the FIRST poll
// delay AND as the setInterval value if you want each interval jittered.
function jitterInterval(ms) {
  return Math.round(ms * (0.8 + Math.random() * 0.4));
}
module.exports = { jitterInterval };
