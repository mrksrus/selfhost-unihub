// Colours the page before the first paint from the mode and look stored on this
// device (P-02). A classic script in <head>, before the stylesheet, so there is
// no flash; a separate file because the production CSP allows only 'self'.
(() => {
  let theme = 'dark';
  try { theme = localStorage.getItem('theme') || 'dark'; } catch {}
  const dark = theme === 'dark' || (theme === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  document.documentElement.classList.toggle('light', !dark);
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
  document.documentElement.style.backgroundColor = dark ? '#000000' : '#f5f7fa';
  // The look chosen on this device for that theme (src/lib/theme.ts); the stylesheet colours the page from it.
  try { const look = localStorage.getItem(dark ? 'unihub:theme:dark' : 'unihub:theme:light'); if (look) document.documentElement.dataset.theme = look; } catch {}
})();
