// Apply the saved palette before the stylesheet and application can paint.
(() => {
  let preference = 'system';
  let ink = false;
  try {
    const saved = localStorage.getItem('note:theme');
    ink = localStorage.getItem('note:ink') === 'true';
    if (['light', 'dark', 'starry'].includes(saved)) preference = saved;
  } catch {
    // Private browsing may disable storage; the system palette still works.
  }
  const theme = ink
    ? 'light'
    : preference === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.ink = String(ink);
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute(
      'content',
      ink ? '#ffffff' : { light: '#F9EFE2', dark: '#191817', starry: '#20263b' }[theme],
    );
})();
