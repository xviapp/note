// Apply the saved palette before the stylesheet and application can paint.
(() => {
  let preference = 'system';
  try {
    const saved = localStorage.getItem('note:theme');
    if (['light', 'dark', 'starry'].includes(saved)) preference = saved;
  } catch {
    // Private browsing may disable storage; the system palette still works.
  }
  const theme =
    preference === 'system'
      ? matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : preference;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme === 'light' ? 'light' : 'dark';
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content',
    { light: '#F9EFE2', dark: '#191817', starry: '#20263b' }[theme]);
  // Keep browser/install icons in sync with the chosen app palette, including
  // explicit night/starry choices when the operating system is in light mode.
  const icons = () => {
    const dark = document.documentElement.dataset.theme !== 'light';
    for (const element of document.querySelectorAll('[data-brand-light][data-brand-dark]')) {
      const attribute = element.tagName === 'LINK' ? 'href' : 'src';
      const value = element.dataset[dark ? 'brandDark' : 'brandLight'];
      if (element.getAttribute(attribute) !== value) element.setAttribute(attribute, value);
    }
  };
  icons();
  new MutationObserver(icons).observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['data-theme'],
  });
  document.addEventListener('DOMContentLoaded', icons, { once: true });
})();
