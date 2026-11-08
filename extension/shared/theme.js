// Dark mode for every extension page (the popup, My workflows, the cached images page, the result viewer and the
// comparison): one setting, darkMode in chrome.storage.local, that follows the system until it's switched. It's shown
// as data-theme="dark" or "light" on <html>, which each page's styles follow. Load this in <head>, before the page's
// own scripts: a copy of the last theme in localStorage applies at once, so pages don't flash the other one while
// chrome.storage answers.
(() => {
  const SETTING = 'darkMode';
  const COPY = 'img2img-dark-mode';
  const system = matchMedia('(prefers-color-scheme: dark)');
  let saved; // the setting: true, false, or undefined to follow the system

  const isDark = () => (typeof saved === 'boolean' ? saved : system.matches);
  const listeners = new Set();

  function apply() {
    const dark = isDark();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    try {
      localStorage.setItem(COPY, dark ? '1' : '0');
    } catch (error) {
      // No localStorage: the page still follows chrome.storage, a moment later
    }
    listeners.forEach(listener => listener(dark));
  }

  let copy = null;
  try {
    copy = localStorage.getItem(COPY);
  } catch (error) {
    // As above
  }
  document.documentElement.dataset.theme = (copy === null ? system.matches : copy === '1') ? 'dark' : 'light';

  chrome.storage.local.get(SETTING).then(stored => {
    saved = stored[SETTING];
    apply();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && SETTING in changes) {
      saved = changes[SETTING].newValue;
      apply();
    }
  });
  system.addEventListener('change', apply);

  const SUN = 'M12 4V2M12 22v-2M4 12H2M22 12h-2M5.6 5.6 4.2 4.2M19.8 19.8l-1.4-1.4M5.6 18.4l-1.4 1.4M19.8 4.2l-1.4 1.4M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8z';
  const MOON = 'M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z';

  globalThis.img2imgTheme = {
    isDark,
    setDark: dark => chrome.storage.local.set({ [SETTING]: Boolean(dark) }),
    toggle: () => chrome.storage.local.set({ [SETTING]: !isDark() }),
    // Called with the new state (true for dark) whenever the theme changes
    onChange: listener => listeners.add(listener),
    // A button that switches the theme, showing a sun in dark mode and a moon in light mode. Pages style it.
    button(className = '') {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = className;
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      for (const [name, value] of Object.entries({ width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })) {
        svg.setAttribute(name, value);
      }
      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      svg.append(path);
      button.append(svg);
      const update = () => {
        const dark = document.documentElement.dataset.theme === 'dark';
        path.setAttribute('d', dark ? SUN : MOON);
        button.title = dark ? 'Light mode' : 'Dark mode';
        button.setAttribute('aria-label', button.title);
      };
      update();
      listeners.add(update);
      button.addEventListener('click', () => globalThis.img2imgTheme.toggle());
      return button;
    },
  };
})();
