// The result cache as a slideshow (cache.html, opened from the popup): newest first, stepped through by hand, with the
// thumbnails or, in Auto, every few seconds. The list comes without images; each image is loaded from the cache by its
// hash when it's shown, and the next one ahead of time. Thumbnails are made here the first time they're needed and
// saved with their result, so the strip never loads every full image.

const elements = Object.fromEntries(['stage', 'frame', 'image', 'download', 'delete', 'prev', 'next', 'message', 'strip', 'bar', 'caption', 'counter', 'manual', 'auto', 'interval', 'fullscreen', 'fullscreenIcon']
  .map(id => [id, document.getElementById(id)]));

const THUMBNAIL_HEIGHT = 96; // twice the strip's, for sharp thumbnails on high-density screens
const ENTER_FULLSCREEN = 'M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5';
const EXIT_FULLSCREEN = 'M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5';

let entries = [];
let index = 0;
let auto = false;
let seconds = 5;
let timer = null;
// Loaded images by hash (null: no longer in the cache), only the few around the current one
const loaded = new Map();

function load(entry) {
  if (!loaded.has(entry.hash)) {
    loaded.set(entry.hash, chrome.runtime.sendMessage({ action: 'getFromCache', hash: entry.hash })
      .then(response => (response?.success && response.result) || null, () => null));
  }
  return loaded.get(entry.hash);
}

// Where the image came from, as text and, for a web address, a link
function sourceOf(imageUrl) {
  if (imageUrl?.startsWith('meta-cdn:')) {
    return { text: 'Instagram or Facebook' };
  }
  try {
    const url = new URL(imageUrl);
    if (/^https?:$/.test(url.protocol)) {
      return { text: url.hostname.replace(/^www\./, ''), href: url.href };
    }
  } catch (error) {
    // Not a URL: left out
  }
  return null;
}

// The download base name (entries cached before names were kept fall back to their site)
function nameOf(entry) {
  return entry.name || sourceOf(entry.imageUrl)?.text || 'image';
}

async function show(newIndex) {
  clearTimeout(timer);
  if (!entries.length) {
    showEmpty();
    return;
  }
  index = (newIndex + entries.length) % entries.length;
  const entry = entries[index];
  const shownIndex = index;

  const source = sourceOf(entry.imageUrl);
  const when = new Date(entry.timestamp).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  const title = entry.name || 'Processed image';
  const caption = [Object.assign(document.createElement('strong'), { textContent: title })];
  if (source) {
    caption.push(' · from ', source.href ? Object.assign(document.createElement('a'), { href: source.href, textContent: source.text, target: '_blank', rel: 'noopener' }) : source.text);
  }
  caption.push(` · ${when}`);
  elements.caption.replaceChildren(...caption);
  elements.counter.textContent = `${index + 1} / ${entries.length}`;
  elements.prev.hidden = elements.next.hidden = entries.length < 2;
  document.title = `${title} - img2img cache`;
  markCurrentThumb();

  const result = await load(entry);
  if (shownIndex !== index || entries[index] !== entry) return; // moved on while it loaded
  elements.frame.hidden = !result;
  elements.message.hidden = Boolean(result);
  if (result) {
    elements.image.src = result;
  } else {
    elements.message.textContent = 'This image is no longer in the cache.';
  }

  // Keep the next image ready, and only the ones around this one in memory
  const keep = new Set([-1, 0, 1].map(offset => entries[(index + offset + entries.length) % entries.length].hash));
  for (const hash of loaded.keys()) {
    if (!keep.has(hash)) loaded.delete(hash);
  }
  load(entries[(index + 1) % entries.length]);
  schedule();
}

function showEmpty(text = "No cached images yet. Images you process are kept here (Cache Size in the popup's settings sets how many).") {
  elements.frame.hidden = elements.prev.hidden = elements.next.hidden = elements.strip.hidden = elements.bar.hidden = true;
  elements.message.textContent = text;
  elements.message.hidden = false;
  document.title = 'Cached images - img2img';
}

function schedule() {
  clearTimeout(timer);
  if (auto && entries.length > 1) {
    timer = setTimeout(() => show(index + 1), seconds * 1000);
  }
}

function setMode(newAuto, save = true) {
  auto = newAuto;
  elements.manual.setAttribute('aria-pressed', String(!auto));
  elements.auto.setAttribute('aria-pressed', String(auto));
  elements.interval.hidden = !auto;
  if (save) chrome.storage.local.set({ cacheViewerMode: auto ? 'auto' : 'manual' });
  schedule();
}

// Thumbnails. Missing ones are made one at a time as they scroll into view: each needs its full image loaded.
const thumbs = new Map(); // hash -> button
const thumbQueue = [];
let makingThumbs = false;
const thumbObserver = new IntersectionObserver(observed => {
  for (const { target, isIntersecting } of observed) {
    if (isIntersecting) {
      thumbObserver.unobserve(target);
      thumbQueue.push(target.dataset.hash);
    }
  }
  makeThumbs();
}, { root: elements.strip, rootMargin: '0px 300px' });

function buildStrip() {
  thumbs.clear();
  elements.strip.replaceChildren(...entries.map((entry, i) => {
    const thumb = Object.assign(document.createElement('button'), { className: 'thumb', title: entry.name || 'Processed image' });
    thumb.setAttribute('role', 'option');
    thumb.dataset.hash = entry.hash;
    thumb.addEventListener('click', () => show(entries.indexOf(entry)));
    if (entry.thumbnail) {
      thumb.style.backgroundImage = `url("${entry.thumbnail}")`;
    } else {
      thumbObserver.observe(thumb);
    }
    thumbs.set(entry.hash, thumb);
    return thumb;
  }));
  elements.strip.hidden = entries.length < 2;
}

// The mouse wheel scrolls the strip sideways (a wheel only scrolls up and down by itself)
elements.strip.addEventListener('wheel', event => {
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX) || elements.strip.scrollWidth <= elements.strip.clientWidth) return;
  event.preventDefault();
  // (deltaMode 1 counts lines, as Firefox does for wheels)
  elements.strip.scrollLeft += event.deltaY * (event.deltaMode === 1 ? 40 : 1);
}, { passive: false });

function markCurrentThumb() {
  for (const [hash, thumb] of thumbs) {
    const current = hash === entries[index]?.hash;
    thumb.setAttribute('aria-current', String(current));
    thumb.setAttribute('aria-selected', String(current));
    if (current) thumb.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
}

async function makeThumbs() {
  if (makingThumbs) return;
  makingThumbs = true;
  while (thumbQueue.length) {
    const hash = thumbQueue.shift();
    const entry = entries.find(candidate => candidate.hash === hash);
    if (!entry || entry.thumbnail) continue;
    try {
      const full = await (loaded.get(hash) || chrome.runtime.sendMessage({ action: 'getFromCache', hash }).then(response => response?.result || null));
      if (!full) continue;
      entry.thumbnail = await thumbnailOf(full);
      const thumb = thumbs.get(hash);
      if (thumb) thumb.style.backgroundImage = `url("${entry.thumbnail}")`;
      chrome.runtime.sendMessage({ action: 'setCacheThumbnail', hash, thumbnail: entry.thumbnail });
    } catch (error) {
      console.debug('img2img: no thumbnail for', hash, error);
    }
  }
  makingThumbs = false;
}

// A small WebP (JPEG where WebP can't be written) of a result, kept transparent where it is
async function thumbnailOf(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  const scale = Math.min(1, THUMBNAIL_HEIGHT / image.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
  canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
  canvas.getContext('2d').drawImage(image, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL('image/webp', 0.8);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.8);
}

// Saved as "<name>-img2img.<ext>" like the on-page button, through background.js. Always available here, also for
// results downloaded before (the on-page button greys those out)
elements.download.addEventListener('click', () => {
  const dataUrl = elements.image.src;
  const mimeType = dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png';
  const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
  const baseName = nameOf(entries[index]).replace(/[\\/:*?"<>|]/g, '_') || 'image';
  chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl, filename: `${baseName}-img2img.${extension}` });
});

// Asks whether to delete, unless the user ticked "Don't ask again" before (cacheDeleteNoConfirm in chrome.storage.local).
// Resolves true to delete. Auto mode waits while it's open.
const confirmDelete = document.getElementById('confirmDelete');
async function deleteConfirmed() {
  const { cacheDeleteNoConfirm } = await chrome.storage.local.get('cacheDeleteNoConfirm');
  if (cacheDeleteNoConfirm) return true;
  clearTimeout(timer);
  document.getElementById('dontAskDelete').checked = false;
  confirmDelete.returnValue = '';
  confirmDelete.showModal();
  await new Promise(resolve => confirmDelete.addEventListener('close', resolve, { once: true }));
  const confirmed = confirmDelete.returnValue === 'delete';
  if (confirmed && document.getElementById('dontAskDelete').checked) {
    chrome.storage.local.set({ cacheDeleteNoConfirm: true });
  }
  if (!confirmed) schedule();
  return confirmed;
}

// Delete the image shown from the cache; the next one takes its place
async function deleteCurrent() {
  const entry = entries[index];
  if (!entry || confirmDelete.open || !(await deleteConfirmed())) return;
  const response = await chrome.runtime.sendMessage({ action: 'deleteFromCache', hash: entry.hash });
  if (!response?.success) {
    alert(`Couldn't delete it: ${response?.error || 'no answer'}`);
    return;
  }
  entries.splice(entries.indexOf(entry), 1);
  loaded.delete(entry.hash);
  thumbs.get(entry.hash)?.remove();
  thumbs.delete(entry.hash);
  elements.strip.hidden = entries.length < 2;
  show(Math.min(index, entries.length - 1));
}
elements.delete.addEventListener('click', deleteCurrent);

function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen().catch(() => {});
  }
}
elements.fullscreen.addEventListener('click', toggleFullscreen);

// Dark mode, shared with the popup and the other extension pages
document.getElementById('themeSlot').replaceWith(img2imgTheme.button('round theme-toggle'));
// In full screen, the bar and arrows fade out after the mouse rests for a moment
let idleTimer = null;
function wake() {
  document.documentElement.classList.remove('idle');
  clearTimeout(idleTimer);
  if (document.fullscreenElement) {
    idleTimer = setTimeout(() => document.documentElement.classList.add('idle'), 2500);
  }
}
document.addEventListener('mousemove', wake);
document.addEventListener('keydown', wake);

document.addEventListener('fullscreenchange', () => {
  const full = Boolean(document.fullscreenElement);
  wake();
  elements.fullscreenIcon.setAttribute('d', full ? EXIT_FULLSCREEN : ENTER_FULLSCREEN);
  elements.fullscreen.title = full ? 'Leave full screen (F)' : 'Full screen (F)';
});

elements.prev.addEventListener('click', () => show(index - 1));
elements.next.addEventListener('click', () => show(index + 1));
elements.manual.addEventListener('click', () => setMode(false));
elements.auto.addEventListener('click', () => setMode(true));
elements.interval.addEventListener('change', () => {
  seconds = Number(elements.interval.value);
  chrome.storage.local.set({ cacheViewerSeconds: seconds });
  schedule();
});
document.addEventListener('keydown', event => {
  if (!entries.length || confirmDelete.open || event.target.tagName === 'SELECT' || event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === 'ArrowLeft') show(index - 1);
  else if (event.key === 'ArrowRight') show(index + 1);
  else if (event.key === ' ') setMode(!auto);
  else if (event.key === 'Delete') deleteCurrent();
  else if (event.key === 'f' || event.key === 'F') toggleFullscreen();
  else return;
  event.preventDefault();
});

Promise.all([
  chrome.runtime.sendMessage({ action: 'listCache' }),
  chrome.storage.local.get(['cacheViewerMode', 'cacheViewerSeconds']),
]).then(([response, stored]) => {
  entries = response?.success ? response.entries : [];
  if (!entries.length) {
    showEmpty(response?.success ? undefined : `Couldn't read the cache: ${response?.error || 'no answer'}`);
    return;
  }
  seconds = [2, 3, 5, 10, 30].includes(stored.cacheViewerSeconds) ? stored.cacheViewerSeconds : 5;
  elements.interval.value = String(seconds);
  elements.bar.hidden = false;
  buildStrip();
  // Manual unless Auto was chosen last time
  setMode(stored.cacheViewerMode === 'auto', false);
  show(0);
});
