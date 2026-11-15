// The result cache as a slideshow (cache.html, opened from the popup): newest first, stepped through by hand, with the
// thumbnails or, in Auto, every few seconds. The list comes without images; each image is loaded from the cache by its
// hash when it's shown, and the next one ahead of time. Thumbnails are made here the first time they're needed and
// saved with their result, so the strip never loads every full image.

const elements = Object.fromEntries(['stage', 'frame', 'image', 'download', 'delete', 'prev', 'next', 'message', 'strip', 'bar', 'caption', 'counter', 'manual', 'auto', 'interval', 'downloadAll', 'purge', 'fullscreen', 'fullscreenIcon']
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
  if (imageUrl?.startsWith('signed-path:')) {
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

function showEmpty(text = 'No cached images yet. Images you process are kept here (Cache Size on the settings page sets how many).') {
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
  const canvas = smallCanvas(image, image.naturalWidth, image.naturalHeight, { maxHeight: THUMBNAIL_HEIGHT });
  const webp = canvas.toDataURL(...THUMBNAIL_FORMAT);
  return webp.startsWith('data:image/webp') ? webp : canvas.toDataURL('image/jpeg', 0.8);
}

// Saved as "<name>-img2img.<ext>" like the on-page button, through background.js. Always available here, also for
// results downloaded before (the on-page button greys those out). With Double Download on (the downloadOriginal
// setting), the original goes along, fetched by background.js from the URL the entry was made from, the one thing
// this page has of it; a video's frame has no such URL, and says so.
// Resolves {} once saved, { error } when the result wasn't, { originalError } when only the original wasn't.
async function downloadEntry(entry, dataUrl, withOriginal) {
  const mimeType = dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png';
  const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
  const baseName = nameOf(entry).replace(/[\\/:*?"<>|]/g, '_') || 'image';
  const filename = `${baseName}-img2img.${extension}`;
  const response = await chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl, filename }).catch(error => ({ error: error.message }));
  if (!response?.success) return { error: response?.error || 'no answer' };
  if (!withOriginal) return {};
  const saved = await chrome.runtime.sendMessage({ action: 'downloadOriginal', url: entry.imageUrl || '', name: filename }).catch(error => ({ error: error.message }));
  return saved?.success ? {} : { originalError: saved?.error || 'no answer' };
}

async function doubleDownload() {
  const { downloadOriginal } = await chrome.storage.local.get('downloadOriginal');
  return downloadOriginal === true;
}

elements.download.addEventListener('click', async () => {
  const outcome = await downloadEntry(entries[index], elements.image.src, await doubleDownload());
  if (outcome.originalError) alert(`The original image couldn't be saved: ${outcome.originalError}`);
});

// Download all: every cached image, newest first, one at a time, each saved as its own download button saves it
// (with its original too while Double Download is on). The button counts them off and stops the rest when clicked
// again; closing the page stops them as well. Images deleted meanwhile are skipped. What couldn't be saved is
// told once at the end, with how many.
let downloadingAll = false;
let stopDownloadingAll = false;

function showDownloadAllProgress(done, total) {
  elements.downloadAll.textContent = downloadingAll ? `Stop (${done} / ${total})` : 'Download all';
  elements.downloadAll.title = downloadingAll ? 'Stop downloading the rest' : 'Download every image in the cache';
  elements.downloadAll.classList.toggle('busy', downloadingAll);
}

async function downloadAll() {
  if (downloadingAll) {
    stopDownloadingAll = true;
    return;
  }
  const queue = [...entries];
  if (!queue.length) return;
  downloadingAll = true;
  stopDownloadingAll = false;
  const withOriginal = await doubleDownload();
  let saved = 0;
  let gone = 0;
  const failed = [];
  const originalsFailed = [];
  for (const [i, entry] of queue.entries()) {
    if (stopDownloadingAll) break;
    showDownloadAllProgress(i, queue.length);
    if (!entries.includes(entry)) {
      gone++;
      continue;
    }
    const dataUrl = await (loaded.get(entry.hash) || chrome.runtime.sendMessage({ action: 'getFromCache', hash: entry.hash })
      .then(response => (response?.success && response.result) || null, () => null));
    if (!dataUrl) {
      gone++;
      continue;
    }
    const outcome = await downloadEntry(entry, dataUrl, withOriginal);
    if (outcome.error) {
      failed.push(`${nameOf(entry)}: ${outcome.error}`);
    } else {
      saved++;
      if (outcome.originalError) originalsFailed.push(`${nameOf(entry)}: ${outcome.originalError}`);
    }
  }
  downloadingAll = false;
  showDownloadAllProgress();
  const problems = [];
  if (failed.length) problems.push(`${failed.length} image${failed.length === 1 ? '' : 's'} couldn't be saved:\n${listed(failed)}`);
  if (originalsFailed.length) problems.push(`The original of ${originalsFailed.length} image${originalsFailed.length === 1 ? '' : 's'} couldn't be saved:\n${listed(originalsFailed)}`);
  if (problems.length) alert(`${saved} of ${queue.length - gone} downloaded.\n\n${problems.join('\n\n')}`);
}

// The first few of a list of problems, one to a line
function listed(lines, most = 8) {
  return lines.slice(0, most).join('\n') + (lines.length > most ? `\n… and ${lines.length - most} more` : '');
}
elements.downloadAll.addEventListener('click', downloadAll);

// Asks whether to delete, unless the user ticked "Don't ask again" before (cacheDeleteNoConfirm in chrome.storage.local).
// files are the files the result was downloaded as (downloadedFilesOf): with any, the question is asked whatever
// was ticked, with a box for deleting them too. Resolves { deleteFiles } to delete, null to keep. Auto mode waits
// while it's open.
const confirmDelete = document.getElementById('confirmDelete');
async function deleteConfirmed(files = []) {
  const { cacheDeleteNoConfirm } = await chrome.storage.local.get('cacheDeleteNoConfirm');
  if (cacheDeleteNoConfirm && files.length === 0) return { deleteFiles: false };
  clearTimeout(timer);
  await offerFileDeletion(files);
  document.getElementById('dontAskDelete').checked = false;
  confirmDelete.returnValue = '';
  confirmDelete.showModal();
  await new Promise(resolve => confirmDelete.addEventListener('close', resolve, { once: true }));
  const confirmed = confirmDelete.returnValue === 'delete';
  if (confirmed && files.length === 0 && document.getElementById('dontAskDelete').checked) {
    chrome.storage.local.set({ cacheDeleteNoConfirm: true });
  }
  if (!confirmed) schedule();
  return confirmed ? { deleteFiles: files.length > 0 && document.getElementById('deleteFile').checked } : null;
}

// The dialog's row for the files the result was downloaded as: there, with their names, when there are any, in
// place of "Don't ask again" (which doesn't cover a file: that is asked about every time). Same in viewer.js.
// The box is ticked or not as it was left the last time (deleteFileRemembered, from shared/images.js).
async function offerFileDeletion(files) {
  document.getElementById('deleteFileRow').hidden = files.length === 0;
  document.getElementById('dontAskRow').hidden = files.length > 0;
  document.getElementById('deleteFile').checked = files.length > 0 && await deleteFileRemembered();
  document.getElementById('deleteFileText').textContent = files.length > 0 ? fileDeletionText(files) : '';
}

// The box's text for the files a result was downloaded as, by name (same function in content.js)
document.getElementById('deleteFile')?.addEventListener('change', event => rememberDeleteFile(event.target.checked));

function fileDeletionText(files) {
  const names = files.map(file => file.path.split(/[\\/]/).pop()).join(', ');
  return `Also delete the ${files.length === 1 ? 'file' : 'files'} it was downloaded as: ${names}`;
}

// The files a cached result was downloaded as, still there to delete: [{ id, path }] (background.js keeps the
// browser's download ids with each downloaded result)
async function downloadedFilesOf(hash) {
  const response = await chrome.runtime.sendMessage({ action: 'downloadedFiles', hash });
  return (response?.success && response.files) || [];
}

// Delete the image shown from the cache (and the file it was downloaded as, if the box is ticked); the next one
// takes its place
let askingToDelete = false;
async function deleteCurrent() {
  const entry = entries[index];
  if (!entry || askingToDelete || confirmDelete.open) return;
  askingToDelete = true;
  clearTimeout(timer);
  let answer;
  try {
    answer = await deleteConfirmed(await downloadedFilesOf(entry.hash));
  } finally {
    askingToDelete = false;
  }
  if (!answer) return;
  const response = await chrome.runtime.sendMessage({ action: 'deleteFromCache', hash: entry.hash, deleteFiles: answer.deleteFiles });
  if (!response?.success) {
    alert(`Couldn't delete it: ${response?.error || 'no answer'}`);
    return;
  }
  if (response.fileError) {
    alert(`The downloaded file couldn't be deleted: ${response.fileError}`);
  }
  entries.splice(entries.indexOf(entry), 1);
  loaded.delete(entry.hash);
  thumbs.get(entry.hash)?.remove();
  thumbs.delete(entry.hash);
  elements.strip.hidden = entries.length < 2;
  show(Math.min(index, entries.length - 1));
}
elements.delete.addEventListener('click', deleteCurrent);

// Purge: every image out of the cache, as the settings page's button does. It always asks, with the count, and
// Auto waits while the question is open. Once done, the page shows what the empty cache shows.
const confirmPurge = document.getElementById('confirmPurge');
async function purgeCache() {
  if (!entries.length || confirmDelete.open || confirmPurge.open) return;
  clearTimeout(timer);
  document.getElementById('confirmPurgeText').textContent = entries.length === 1
    ? 'Delete the only image from the cache?'
    : `Delete all ${entries.length} images from the cache?`;
  confirmPurge.returnValue = '';
  confirmPurge.showModal();
  await new Promise(resolve => confirmPurge.addEventListener('close', resolve, { once: true }));
  if (confirmPurge.returnValue !== 'delete') {
    schedule();
    return;
  }
  elements.purge.disabled = true;
  const response = await chrome.runtime.sendMessage({ action: 'clearCache' }).catch(error => ({ error: error.message }));
  elements.purge.disabled = false;
  if (!response?.success) {
    alert(`Couldn't purge the cache: ${response?.error || 'no answer'}`);
    schedule();
    return;
  }
  entries = [];
  loaded.clear();
  thumbs.clear();
  elements.strip.replaceChildren();
  showEmpty(`Cache purged (${response.count} image${response.count === 1 ? '' : 's'}). Images you process from now on are kept here.`);
}
elements.purge.addEventListener('click', purgeCache);

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
  if (!entries.length || confirmDelete.open || confirmPurge.open || event.target.tagName === 'SELECT' || event.ctrlKey || event.metaKey || event.altKey) return;
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
