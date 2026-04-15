/* tv-shell.js — Universal viewport behaviors for unattended TV dashboards.
   Loaded by every standalone dashboard. */
(function() {
  // ── Overflow sentinel: toggle .dense class if content overflows viewport.
  //    Tightens spacing and hides secondary labels in tv-shell.css.
  let resizeTimer;
  function checkOverflow() {
    // Check documentElement AND the .main scroll container — main has
    // overflow-y:auto, which hides its internal overflow from documentElement.
    // Without this, content clipped inside main never triggers dense mode.
    const docOverflow = document.documentElement.scrollHeight > window.innerHeight + 4
                     || document.documentElement.scrollWidth  > window.innerWidth + 4;
    const main = document.querySelector('body > .main');
    const mainOverflow = !!main && (main.scrollHeight > main.clientHeight + 4);
    document.body.classList.toggle('dense', docOverflow || mainOverflow);
  }
  // Debounced check on resize and content change
  const ro = new ResizeObserver(() => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(checkOverflow, 100);
  });
  ro.observe(document.documentElement);
  window.addEventListener('resize', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(checkOverflow, 100);
  });
  // Initial check after first render
  setTimeout(checkOverflow, 200);
  // Recheck periodically in case data refresh adds content
  setInterval(checkOverflow, 30000);
})();
