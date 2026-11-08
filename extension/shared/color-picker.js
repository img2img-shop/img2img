// A colour picker drawn in the page, for the popup: Firefox closes an extension popup when the browser's own colour
// dialog (<input type="color">) takes focus, so the colour picked there was lost. attach() turns a text input holding
// #rrggbb into a swatch that opens a saturation/brightness square, a hue slider and a few presets below it. The input
// keeps the value: it gets 'input' events while a colour is dragged and a 'change' event once it's picked, so pages
// save it like any other input. Pages style it (.color-field, .color-swatch, .color-panel and the parts inside).
(() => {
  const PRESETS = ['#ffffff', '#000000', '#f2f2f2', '#9fb4c7', '#2196f3', '#4caf50', '#ffeb3b', '#ff9800', '#f44336', '#e91e63', '#9c27b0', '#795548'];
  const HEX = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

  // '#abc', 'aabbcc' or '#AABBCC' as '#aabbcc', or null when it isn't a colour
  function normalize(value) {
    const match = HEX.exec(String(value || '').trim());
    if (!match) return null;
    const digits = match[1].length === 3 ? [...match[1]].map(digit => digit + digit).join('') : match[1];
    return '#' + digits.toLowerCase();
  }

  // Hue 0-360, saturation and value 0-1
  function hsvToHex(h, s, v) {
    const channel = n => {
      const k = (n + h / 60) % 6;
      return Math.round(255 * (v - v * s * Math.max(0, Math.min(k, 4 - k, 1))));
    };
    return '#' + [5, 3, 1].map(n => channel(n).toString(16).padStart(2, '0')).join('');
  }

  function hexToHsv(hex) {
    const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const range = max - Math.min(r, g, b);
    let h = 0;
    if (range) {
      if (max === r) h = 60 * (((g - b) / range + 6) % 6);
      else if (max === g) h = 60 * ((b - r) / range + 2);
      else h = 60 * ((r - g) / range + 4);
    }
    return { h, s: max ? range / max : 0, v: max };
  }

  function element(tag, className, attributes = {}) {
    const node = document.createElement(tag);
    node.className = className;
    Object.assign(node, attributes);
    return node;
  }

  // Returns sync(), to call after the input's value is set from code (a saved setting)
  function attach(input, fallback = '#ffffff') {
    const field = element('div', 'color-field');
    const swatch = element('button', 'color-swatch', { type: 'button', title: 'Pick a colour' });
    swatch.setAttribute('aria-label', 'Pick a colour');
    swatch.setAttribute('aria-expanded', 'false');
    input.before(field);
    field.append(swatch, input);

    const panel = element('div', 'color-panel', { hidden: true });
    const square = element('div', 'color-square');
    const thumb = element('div', 'color-thumb');
    square.append(thumb);
    const hue = element('input', 'color-hue', { type: 'range', min: 0, max: 359, step: 1 });
    hue.setAttribute('aria-label', 'Hue');
    const presets = element('div', 'color-presets');
    for (const preset of PRESETS) {
      const button = element('button', 'color-preset', { type: 'button', title: preset });
      button.style.background = preset;
      button.dataset.color = preset;
      presets.append(button);
    }
    panel.append(square, hue, presets);
    field.after(panel);

    let hsv = hexToHsv(normalize(input.value) || fallback);
    let saved = hsvToHex(hsv.h, hsv.s, hsv.v);

    function render() {
      const hex = hsvToHex(hsv.h, hsv.s, hsv.v);
      swatch.style.background = hex;
      square.style.backgroundColor = hsvToHex(hsv.h, 1, 1);
      thumb.style.left = `${hsv.s * 100}%`;
      thumb.style.top = `${(1 - hsv.v) * 100}%`;
      thumb.style.background = hex;
      hue.value = String(Math.round(hsv.h));
      return hex;
    }

    // While dragging: shown in the input; commit() saves it
    function preview() {
      input.value = render();
      input.dispatchEvent(new Event('input', { bubbles: true }));
    }
    function commit() {
      const hex = render();
      input.value = hex;
      if (hex !== saved) {
        saved = hex;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }

    function sync() {
      const hex = normalize(input.value) || fallback;
      // Grey has no hue: keep the slider where it was
      const next = hexToHsv(hex);
      hsv = next.s ? next : { ...next, h: hsv.h };
      saved = hex;
      input.value = hex;
      render();
    }

    function open(show) {
      panel.hidden = !show;
      swatch.setAttribute('aria-expanded', String(show));
    }
    swatch.addEventListener('click', () => open(panel.hidden));
    document.addEventListener('pointerdown', event => {
      if (!panel.hidden && !panel.contains(event.target) && !field.contains(event.target)) open(false);
    });
    panel.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        open(false);
        swatch.focus();
      }
    });

    function pick(event) {
      const box = square.getBoundingClientRect();
      hsv.s = Math.min(1, Math.max(0, (event.clientX - box.left) / box.width));
      hsv.v = 1 - Math.min(1, Math.max(0, (event.clientY - box.top) / box.height));
      preview();
    }
    square.addEventListener('pointerdown', event => {
      event.preventDefault();
      square.setPointerCapture(event.pointerId);
      pick(event);
    });
    square.addEventListener('pointermove', event => {
      if (square.hasPointerCapture(event.pointerId)) pick(event);
    });
    square.addEventListener('pointerup', commit);
    square.addEventListener('lostpointercapture', commit);

    hue.addEventListener('input', () => {
      hsv.h = Number(hue.value);
      preview();
    });
    hue.addEventListener('change', commit);

    presets.addEventListener('click', event => {
      const color = event.target.closest('.color-preset')?.dataset.color;
      if (!color) return;
      input.value = color;
      sync();
      saved = null;
      commit();
    });

    // Typed: shown once it's a colour; on leaving, an unfinished one goes back to the last colour. This listener comes
    // before the page's, so the page saves the tidied value.
    input.spellcheck = false;
    input.maxLength = 7;
    input.addEventListener('input', event => {
      if (event.isTrusted) {
        const hex = normalize(input.value);
        if (hex) {
          const next = hexToHsv(hex);
          hsv = next.s ? next : { ...next, h: hsv.h };
          render();
        }
      }
    });
    input.addEventListener('change', event => {
      if (event.isTrusted) {
        const hex = normalize(input.value) || saved;
        input.value = hex;
        sync();
      }
    });

    sync();
    return sync;
  }

  globalThis.img2imgColorPicker = { attach, normalize };
})();
