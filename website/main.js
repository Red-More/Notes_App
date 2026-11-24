/* Small progressive enhancements; all content works without JS. */
(() => {
  const header = document.querySelector('[data-header]');
  const syncHeader = () => {
    header?.classList.toggle('is-scrolled', window.scrollY > 8);
  };
  syncHeader();
  window.addEventListener('scroll', syncHeader, { passive: true });

  const year = document.querySelector('[data-year]');
  if (year) year.textContent = String(new Date().getFullYear());
})();
