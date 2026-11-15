// The Library: a folder of the user's own images and videos, opened in this page and processed here. Nothing is
// uploaded by opening a folder; a file goes to wherever Processing sends images only when it is processed.
//
// library.html also runs content.js, for everything a job shares with one started on a web page: reading the image
// into a format that can be processed, the settings, the result cache, the checks before a job, and the queue in
// background.js. What is this page's own is below: the folder and its views, the viewer, which files wait their
// turn, and where each result goes (shown here, and saved in Downloads under the folder its file came from).
// isLibrary tells content.js to start nothing here itself.
isLibrary = true;

(() => {
  const $ = selector => document.querySelector(selector);
  const $$ = selector => [...document.querySelectorAll(selector)];
  // An element with its attributes and what goes in it, built without markup, so a file's name is only ever text.
  // An attribute that is false, null or undefined is left off, and true gives it with no value; children are
  // elements or text, in arrays or not, and null, false or '' among them are skipped.
  // el('button', { class: 'del', 'data-id': 3, disabled: !ready }, 'Delete')
  function el(tag, attributes = {}, ...children) {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === false || value == null) continue;
      element.setAttribute(name, value === true ? '' : String(value));
    }
    element.append(...children.flat(Infinity).filter(child => child != null && child !== false && child !== ''));
    return element;
  }
  const FOLDER_ICON = '\u{1F4C1}';
  const CROSS = '✕';

  $('#themeSlot').append(img2imgTheme.button('theme-toggle'));

  const IMAGE_NAMES = /\.(jpe?g|png|webp|gif|bmp|avif|svg|ico|tiff?|heic|heif|jxl)$/i;
  const VIDEO_NAMES = /\.(mp4|m4v|webm|mov|mkv|ogv)$/i;
  // (a file's type is empty where the system has none for its extension)
  const isVideoFile = file => file.type.startsWith('video/') || (!file.type && VIDEO_NAMES.test(file.name));
  const isImageFile = file => file.type.startsWith('image/') || (!file.type && IMAGE_NAMES.test(file.name));

  const MAX_WALK = 20000; // files looked at in a folder and its subfolders, of any kind
  const THUMB_SIDE = 320; // a thumbnail's longer side, in pixels
  const THUMBS_AT_ONCE = 3;
  const FRAME = 1 / 30; // a step back or forward in a video
  const SAME_ERROR_STOPS = 3; // the same error this many times running stops the run: the rest would fail the same way

  const STATUS = { none: 'Not processed', queued: 'Queued', processing: 'Processing', done: 'Processed', failed: 'Failed', blocked: 'Stopped by the safety check' };
  const STATUS_ORDER = ['processing', 'queued', 'done', 'failed', 'blocked', 'none'];

  // Every file open, and the frames taken from its videos (a frame is a picture of its own with a parent: it is
  // processed and shown like an image, and listed under its video rather than among the files)
  let entries = [];
  let nextId = 1;
  const byId = id => entries.find(entry => entry.id === id);
  const isVideo = entry => Boolean(entry && entry.kind === 'video');
  const framesOf = video => entries.filter(entry => entry.parent === video.id).sort((a, b) => a.t - b.t);

  const S = {
    folders: [], folder: '', history: [], at: -1,
    includeSub: false, view: 'thumbs', tile: 84, gridTile: 150, sort: 'name', dir: 1, search: '', status: 'all', type: 'all',
    selected: new Set(), anchor: null, current: null, currentName: '', frame: null, centre: 'viewer',
    compare: 'result', peek: false, strip: true,
    scale: 1, tx: 0, ty: 0, fitMode: 'fit',
    server: true, credits: null, costs: {}, autoSave: false,
  };
  const current = () => byId(S.current);
  // What the viewer shows: the file open, or the frame of that video picked from its list
  const shown = () => (S.frame && byId(S.frame)) || current();

  // ---------- What is remembered: how the page was left ----------
  //
  // Every choice of view, order and filter, which pane is open, and where in the folder the page was (the subfolder,
  // and the file open by its name), so the Library opens as it was left. Kept in chrome.storage.local.

  const LAYOUT_KEY = 'libraryLayout';
  const LAYOUT = ['view', 'tile', 'gridTile', 'sort', 'dir', 'strip', 'compare', 'status', 'type', 'search', 'includeSub', 'centre', 'folder', 'currentName'];

  function saveLayout() {
    const layout = Object.fromEntries(LAYOUT.map(key => [key, S[key]]));
    layout.leftWidth = document.documentElement.style.getPropertyValue('--left-w');
    layout.noLeft = document.body.classList.contains('no-left');
    layout.noRight = document.body.classList.contains('no-right');
    chrome.storage.local.set({ [LAYOUT_KEY]: layout });
  }

  async function loadLayout() {
    const { [LAYOUT_KEY]: layout = {} } = await chrome.storage.local.get(LAYOUT_KEY);
    LAYOUT.forEach(key => { if (key in layout) S[key] = layout[key]; });
    if (layout.leftWidth) document.documentElement.style.setProperty('--left-w', layout.leftWidth);
    document.body.classList.toggle('no-left', layout.noLeft === true);
    document.body.classList.toggle('no-right', layout.noRight === true);
    // (the controls that say them; the file types offered depend on the folder, see openFiles)
    $('#statusFilter').value = S.status;
    if ($('#statusFilter').value !== S.status) S.status = $('#statusFilter').value = 'all';
    $('#search').value = S.search;
    $('#includeSub').checked = S.includeSub === true;
    if (S.centre !== 'grid') S.centre = 'viewer';
  }

  // ---------- Opening ----------

  // What a file's results are cached under, in place of the address a page image has: its name, size and date, which
  // stay the same wherever its folder is opened from, so the results still in the cache come back with it
  const cacheKeyOf = file => `img2img-library:${encodeURIComponent(file.name)}?size=${file.size}&modified=${file.lastModified}`;

  function addEntry(fields) {
    const entry = { id: nextId++, status: 'none', error: '', results: [], shown: -1, w: 0, h: 0, thumb: '', thumbState: '', ahead: null, progress: null, estimate: null, drop: null, taken: false, ...fields };
    entries.push(entry);
    return entry;
  }

  // "Open folder": the browser's folder picker where there is one, which asks to let the page view the files. The
  // older folder input is what's left elsewhere, and the browser's own dialogs for it speak of uploading although
  // nothing is.
  async function pickFolder() {
    if (!window.showDirectoryPicker) {
      $('#pickFolder').click();
      return;
    }
    let root;
    try {
      root = await window.showDirectoryPicker();
    } catch (error) {
      if (error.name !== 'AbortError') $('#pickFolder').click(); // (closing the picker is AbortError)
      return;
    }
    await openFolderHandle(root);
  }

  // A folder by the handle the browser gave for it: read through, opened, and remembered for the next time the
  // Library is opened (see "Folders opened before" below). Resolves false if it can't be read any more.
  async function openFolderHandle(root) {
    const files = [];
    const walk = async (directory, path) => {
      for await (const handle of directory.values()) {
        if (files.length >= MAX_WALK) return;
        if (handle.kind === 'directory') {
          await walk(handle, `${path}/${handle.name}`);
        } else if (IMAGE_NAMES.test(handle.name) || VIDEO_NAMES.test(handle.name)) {
          files.push({ file: await handle.getFile(), path });
        }
      }
    };
    $('#crumbs').replaceChildren(el('span', { class: 'sep' }, 'Reading the folder…'));
    try {
      await walk(root, root.name);
    } catch (error) {
      showPageError(`The folder couldn't be read: ${error.message}`);
      render();
      return false;
    }
    await rememberFolder(root).catch(error => console.debug('img2img: the folder is not remembered:', error));
    await openFiles(files);
    return true;
  }

  // ---------- Folders opened before ----------
  //
  // The browser's handle for a folder can be kept (in this page's own IndexedDB) and used again: the Library opens
  // on the folder it was last on. The browser decides whether that needs asking again: where it was told to allow
  // the folder on every visit the folder just opens, otherwise it is listed to be opened with one click, which is
  // when the browser asks. Only where there are such handles (the folder picker, a dropped folder): a folder from
  // the older folder input has to be picked again.
  const FOLDERS_DB = 'img2imgLibrary';
  const FOLDERS_STORE = 'folders';
  const FOLDERS_KEPT = 6;

  async function foldersRequest(mode, make) {
    const db = await new Promise((resolve, reject) => {
      const open = indexedDB.open(FOLDERS_DB, 1);
      open.onupgradeneeded = () => open.result.createObjectStore(FOLDERS_STORE, { keyPath: 'id', autoIncrement: true });
      open.onsuccess = () => resolve(open.result);
      open.onerror = () => reject(open.error);
    });
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(FOLDERS_STORE, mode);
        const request = make(transaction.objectStore(FOLDERS_STORE));
        transaction.oncomplete = () => resolve(request.result);
        transaction.onerror = transaction.onabort = () => reject(transaction.error);
      });
    } finally {
      db.close();
    }
  }

  // The folders remembered, the last one opened first: { id, name, handle, opened }
  async function recentFolders() {
    const kept = await foldersRequest('readonly', store => store.getAll()).catch(() => []);
    return kept.sort((a, b) => b.opened - a.opened);
  }

  async function rememberFolder(handle) {
    for (const other of await recentFolders()) {
      if (await other.handle.isSameEntry(handle).catch(() => false)) await forgetFolder(other.id);
    }
    await foldersRequest('readwrite', store => store.add({ name: handle.name, handle, opened: Date.now() }));
    for (const old of (await recentFolders()).slice(FOLDERS_KEPT)) await forgetFolder(old.id);
  }

  const forgetFolder = id => foldersRequest('readwrite', store => store.delete(id));

  // ask: from a click, so the browser may be asked to allow the folder again
  async function openRemembered(folder, { ask }) {
    let allowed = await folder.handle.queryPermission({ mode: 'read' }).catch(() => 'denied');
    if (allowed !== 'granted' && ask) allowed = await folder.handle.requestPermission({ mode: 'read' }).catch(() => 'denied');
    if (allowed !== 'granted') return false;
    return openFolderHandle(folder.handle);
  }

  async function showRecentFolders() {
    const folders = await recentFolders();
    $('#recent').hidden = folders.length === 0;
    $('#recentList').replaceChildren(...folders.map(folder => el('div', {},
      el('button', { class: 'btn', 'data-recent': folder.id, title: 'Open this folder again' }, `${FOLDER_ICON} ${folder.name}`),
      el('button', { class: 'btn forget', 'data-forget': folder.id, title: 'Take it off this list' }, CROSS))));
    return folders;
  }

  // The same list under the arrow beside "Open folder", where it is in reach while a folder is open
  async function openRecentMenu() {
    const menu = $('#recentMenu');
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    closeMenus();
    await fillRecentMenu();
    menu.hidden = false;
    const button = $('#openFolderGroup').getBoundingClientRect();
    menu.style.transform = `translate(${button.left}px, ${button.bottom + 4}px)`;
  }

  async function fillRecentMenu() {
    const folders = await recentFolders();
    const rows = folders.map(folder => el('div', { class: 'recent-row' },
      el('button', { 'data-recent': folder.id, title: 'Open this folder again' }, `${FOLDER_ICON} ${folder.name}`),
      el('button', { class: 'forget', 'data-forget': folder.id, title: 'Take it off this list', 'aria-label': `Take ${folder.name} off this list` }, CROSS)));
    $('#recentMenu').replaceChildren(...(rows.length ? rows
      : [el('div', { class: 'note' }, 'No folders opened yet. A folder you open is listed here, to be opened again with one click.')]));
  }

  // A click in either list: open the folder again, or take it off the list
  async function onRecentClick(event) {
    const forget = event.target.closest('[data-forget]');
    if (forget) {
      await forgetFolder(Number(forget.dataset.forget));
      showRecentFolders();
      if (!$('#recentMenu').hidden) fillRecentMenu();
      return;
    }
    const again = event.target.closest('[data-recent]');
    if (!again) return;
    $('#recentMenu').hidden = true;
    const folder = (await recentFolders()).find(other => other.id === Number(again.dataset.recent));
    if (folder && !await openRemembered(folder, { ask: true })) showRecentFolders();
  }

  // As the page opens: the folder it was last on, if the browser allows it without being asked
  async function reopenLastFolder() {
    const [last] = await showRecentFolders();
    if (last && !entries.length) await openRemembered(last, { ask: false });
  }

  // A dropped folder is read through, subfolders and all, with no question from the browser; dropped files are taken
  // as they are. The entries have to be asked for before the drop event is over.
  async function openDropped(dataTransfer) {
    const loose = [...dataTransfer.files].map(file => ({ file, path: 'Dropped files' }));
    // One folder, where the browser hands out a handle for it: opened as a picked folder is, so it is remembered
    const handles = [...dataTransfer.items].map(item => item.getAsFileSystemHandle?.());
    if (handles.length === 1 && handles[0]) {
      const handle = await handles[0].catch(() => null);
      if (handle?.kind === 'directory') {
        await openFolderHandle(handle);
        return;
      }
    }
    const dropped = [...dataTransfer.items].map(item => item.webkitGetAsEntry?.()).filter(Boolean);
    const files = [];
    const children = async directory => {
      const reader = directory.createReader();
      const all = [];
      for (;;) {
        const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
        if (!batch.length) return all;
        all.push(...batch);
      }
    };
    const walk = async entry => {
      if (files.length >= MAX_WALK) return;
      if (entry.isDirectory) {
        for (const child of await children(entry)) await walk(child);
        return;
      }
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
      files.push({ file, path: entry.fullPath.slice(1).split('/').slice(0, -1).join('/') || 'Dropped files' });
    };
    try {
      for (const entry of dropped) await walk(entry);
    } catch (error) {
      files.length = 0; // the folders couldn't be read: whatever files were dropped directly
    }
    openFiles(files.length ? files : loose);
  }

  // From the folder input and the file input: a folder's files say where in it they are
  function openPicked(fileList, fallbackPath) {
    openFiles([...fileList].map(file => {
      const relative = file.webkitRelativePath || '';
      return { file, path: relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : fallbackPath };
    }));
  }

  async function openFiles(found) {
    const usable = found.filter(({ file }) => isImageFile(file) || isVideoFile(file));
    if (!usable.length) {
      showPageNotice('There are no images or videos in there.');
      render();
      return;
    }
    if (waitingCount() > 0 && !confirm('Files are still waiting to be processed. Opening something else takes them out of the queue.\n\nOpen it anyway?')) {
      render();
      return;
    }
    // (where the page was left, if this is that folder again)
    const leftIn = S.folder;
    const leftOn = S.currentName;
    closeFolder();
    for (const { file, path } of usable) {
      addEntry({
        kind: isVideoFile(file) ? 'video' : 'image', file, path, name: file.name, size: file.size, modified: file.lastModified,
        type: (file.name.includes('.') ? file.name.split('.').pop() : '').toUpperCase(), key: cacheKeyOf(file), duration: 0,
      });
    }
    const folders = new Set();
    for (const entry of entries) {
      const parts = entry.path.split('/');
      parts.forEach((_, i) => folders.add(parts.slice(0, i + 1).join('/')));
    }
    S.folders = [...folders].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    const types = [...new Set(entries.map(entry => entry.type))].sort();
    $('#typeFilter').replaceChildren(el('option', { value: 'all' }, 'All types'), ...types.map(type => el('option', {}, type)));
    if (!types.includes(S.type)) S.type = 'all';
    $('#typeFilter').value = S.type;
    await resultsFromTheCache();
    // The top folder, or the first one down that has files in it when the top one has none of its own
    const top = S.folders[0];
    const first = entries.some(entry => entry.path === top) ? top : S.folders.find(folder => entries.some(entry => entry.path === folder)) || top;
    S.currentName = leftOn;
    go(S.folders.includes(leftIn) ? leftIn : first);
  }

  // The results the cache still holds for these files (it keeps as many as its Cache Size setting, the newest):
  // they come back as each file's results, their pictures read only when one is looked at
  async function resultsFromTheCache() {
    const response = await chrome.runtime.sendMessage({ action: 'listCache' }).catch(() => null);
    if (!response?.success) return;
    const files = new Map(entries.map(entry => [entry.key, entry]));
    // (listed newest first; a file's results are kept oldest first)
    for (const cached of [...response.entries].reverse()) {
      const entry = files.get(cached.imageUrl);
      if (!entry) continue;
      const base = baseName(entry);
      const label = cached.name?.startsWith(`${base}-`) ? cached.name.slice(base.length + 1) : cached.name || 'Result';
      entry.results.push({ key: cached.hash, url: '', label, name: cached.name || `${base}-${label}`, time: cached.timestamp || 0, w: 0, h: 0, thumb: cached.thumbnail || '', saved: null });
      entry.shown = entry.results.length - 1;
      entry.status = 'done';
    }
  }

  function closeFolder() {
    stopAll();
    leaveVideo();
    for (const entry of entries) {
      if (entry.thumb.startsWith('blob:')) URL.revokeObjectURL(entry.thumb);
      entry.results.forEach(forgetResult);
    }
    showPicture(null);
    entries = [];
    thumbsWanted.length = 0;
    Object.assign(S, { folders: [], folder: '', history: [], at: -1, selected: new Set(), anchor: null, current: null, frame: null });
  }

  function go(folder, fromHistory = false) {
    S.folder = folder;
    if (!fromHistory) {
      S.history = S.history.slice(0, S.at + 1);
      S.history.push(folder);
      S.at = S.history.length - 1;
    }
    S.selected.clear();
    leaveVideo();
    const list = visible();
    // (the file the page was left on, when this is where it was left)
    S.current = (list.find(entry => entry.name === S.currentName) || list[0])?.id ?? null;
    S.currentName = current()?.name || '';
    saveLayout();
    render();
  }

  const inFolder = (entry, folder) => entry.path === folder || entry.path.startsWith(`${folder}/`);

  function visible() {
    const query = S.search.toLowerCase();
    const list = entries.filter(entry => !entry.parent
      && (S.includeSub ? inFolder(entry, S.folder) : entry.path === S.folder)
      && (!query || entry.name.toLowerCase().includes(query))
      && (S.type === 'all' || entry.type === S.type)
      && (S.status === 'all' || entry.status === S.status || (S.status === 'queued' && entry.status === 'processing')));
    const key = {
      name: entry => entry.name.toLowerCase(), date: entry => entry.modified, size: entry => entry.size,
      dims: entry => entry.w * entry.h, type: entry => entry.type, status: entry => STATUS_ORDER.indexOf(entry.status),
    }[S.sort];
    // (names as a file manager orders them: IMG_9 before IMG_10; and by name where the rest is equal)
    const byName = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true });
    return list.sort((a, b) => {
      const x = key(a);
      const y = key(b);
      return (S.sort === 'name' || x === y ? byName(a, b) : x < y ? -1 : 1) * S.dir;
    });
  }

  // ---------- Thumbnails: made as a file comes near the view, a few at a time, and kept while the folder is open ----------

  const thumbsWanted = [];
  let thumbsBeingMade = 0;
  const nearView = new IntersectionObserver(seen => {
    for (const { isIntersecting, target } of seen) {
      if (!isIntersecting) continue;
      nearView.unobserve(target);
      const entry = byId(Number(target.dataset.id));
      if (entry && !entry.thumbState) {
        entry.thumbState = 'wanted';
        thumbsWanted.push(entry);
      }
    }
    makeThumbs();
  }, { rootMargin: '400px' });

  function makeThumbs() {
    while (thumbsBeingMade < THUMBS_AT_ONCE && thumbsWanted.length) {
      const entry = thumbsWanted.shift();
      thumbsBeingMade++;
      (isVideo(entry) ? videoPoster(entry) : imageThumb(entry))
        .then(() => { entry.thumbState = 'made'; }, () => { entry.thumbState = 'none'; })
        .finally(() => {
          thumbsBeingMade--;
          if (entries.includes(entry)) updateEntry(entry);
          makeThumbs();
        });
    }
  }

  // A picture drawn small, as a blob: URL; resolves with the picture's own size too
  async function smallCopy(source, width, height) {
    const canvas = smallCanvas(source, width, height, { maxSide: THUMB_SIDE }); // (shared/images.js)
    const blob = await new Promise(resolve => canvas.toBlob(resolve, ...THUMBNAIL_FORMAT)) || await new Promise(resolve => canvas.toBlob(resolve));
    return URL.createObjectURL(blob);
  }

  // A blob's picture and its size: decoded directly, or through an <img> for what that can't read (an SVG)
  async function pictureOf(blob) {
    try {
      const bitmap = await createImageBitmap(blob);
      return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
    } catch (error) {
      const url = URL.createObjectURL(blob);
      try {
        const image = await loadImage(url);
        return { source: image, width: image.naturalWidth || THUMB_SIDE, height: image.naturalHeight || THUMB_SIDE, done: () => {} };
      } finally {
        URL.revokeObjectURL(url);
      }
    }
  }

  async function imageThumb(entry) {
    const picture = await pictureOf(entry.file);
    entry.w = picture.width;
    entry.h = picture.height;
    entry.thumb = await smallCopy(picture.source, picture.width, picture.height);
    picture.done();
  }

  // A video's thumbnail is a frame from its start, which also says how large and how long it is
  function videoPoster(entry) {
    return new Promise((resolve, reject) => {
      const video = document.createElement('video');
      const url = URL.createObjectURL(entry.file);
      const end = () => {
        video.removeAttribute('src');
        video.load();
        URL.revokeObjectURL(url);
      };
      video.muted = true;
      video.preload = 'auto';
      video.addEventListener('loadeddata', () => {
        entry.w = video.videoWidth;
        entry.h = video.videoHeight;
        entry.duration = Number.isFinite(video.duration) ? video.duration : 0;
        video.currentTime = Math.min(0.1, entry.duration / 2);
      }, { once: true });
      video.addEventListener('seeked', async () => {
        try {
          entry.thumb = await smallCopy(video, entry.w, entry.h);
          resolve();
        } catch (error) {
          reject(error);
        } finally {
          end();
        }
      }, { once: true });
      video.addEventListener('error', () => { end(); reject(new Error("this browser can't play it")); }, { once: true });
      video.src = url;
    });
  }

  // ---------- The lists ----------

  const fmtSize = bytes => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
  const fmtDate = time => new Date(time).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
  const fmtDims = entry => (entry.w ? `${entry.w} × ${entry.h}` : '…');
  const fmtTime = (seconds, exact = false) => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}${exact ? `.${String(Math.floor(seconds % 1 * 100)).padStart(2, '0')}` : ''}`;
  // The white tick of a processed file
  function tick() {
    const SVG = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(SVG, 'svg');
    const attributes = { viewBox: '0 0 24 24', fill: 'none', stroke: '#fff', 'stroke-width': '3.5', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
    for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', 'M5 12.5l4.5 4.5L19 7.5');
    svg.append(path);
    return svg;
  }

  // The picture a file shows in the lists: its result's, once it has one that has been looked at or made here
  const thumbOf = entry => entry.results[entry.shown]?.thumb || entry.thumb;

  // A file's mark in the lists, as what goes in its slot (elements and text). words: for the list and the details
  // view, which say "Processed" where a thumbnail carries the tick
  function badge(entry, words = false) {
    if (isVideo(entry)) {
      const processed = framesOf(entry).filter(frame => frame.results.length).length;
      const length = entry.duration ? fmtTime(entry.duration) : '';
      return [el('span', { class: 'badge vid', title: 'Video' }, `▶ ${length}${processed ? ` · ${processed} processed` : ''}`)];
    }
    if (entry.status === 'queued') {
      const ahead = aheadOf(entry);
      return [el('span', { class: 'badge queued', title: 'Waiting its turn: click to take it back' }, ahead ? `${ahead} ahead` : 'next')];
    }
    if (entry.status === 'processing') {
      return [el('span', { class: 'spinmark', title: 'Being processed' }, el('img', { src: 'icons/spinner.svg', alt: '' })), words ? 'Processing' : ''];
    }
    if (entry.status === 'done') {
      return [words ? el('span', { class: 'badge done' }, 'Processed') : el('span', { class: 'mark', title: 'Processed' }, tick())];
    }
    if (entry.status === 'failed' || entry.status === 'blocked') {
      return [el('span', { class: `badge ${entry.status}`, title: entry.error || STATUS[entry.status] },
        `${entry.status === 'failed' ? '!' : '⊘'}${words ? ` ${STATUS[entry.status]}` : ''}`)];
    }
    return [words ? STATUS.none : ''];
  }

  const pic = entry => el('div', { class: 'pic' }, el('img', { alt: '', src: thumbOf(entry) || null }), el('span', { class: 'bslot' }));

  function render() {
    const list = visible();
    const files = $('#files');
    files.className = S.view;
    if (!entries.length) {
      files.replaceChildren();
    } else if (!list.length) {
      files.replaceChildren(el('div', { class: 'empty' }, 'No files here match.'));
    } else if (S.view === 'thumbs') {
      files.replaceChildren(...list.map(entry => el('div', { class: 'item tile', 'data-id': entry.id, title: entry.name },
        pic(entry), el('div', { class: 'nm' }, entry.name))));
    } else if (S.view === 'list') {
      files.replaceChildren(...list.map(entry => el('div', { class: 'item row', 'data-id': entry.id, title: entry.name },
        pic(entry), el('div', { class: 'nm' }, entry.name), el('span', { class: 'words' }))));
    } else {
      const arrow = key => (S.sort === key ? (S.dir > 0 ? ' ↑' : ' ↓') : '');
      const heading = (key, text) => el('th', { 'data-sort': key }, `${text}${arrow(key)}`);
      files.replaceChildren(el('table', {},
        el('thead', {}, el('tr', {}, heading('name', 'Name'), heading('dims', 'Dimensions'), heading('size', 'Size'),
          heading('date', 'Date modified'), heading('type', 'Type'), heading('status', 'Status'))),
        el('tbody', {}, list.map(entry => el('tr', { class: 'item', 'data-id': entry.id },
          el('td', {}, pic(entry), entry.name), el('td', { class: 'dims' }), el('td', {}, fmtSize(entry.size)),
          el('td', {}, fmtDate(entry.modified)), el('td', {}, entry.type), el('td', { class: 'words' }))))));
    }
    listed = list.map(entry => entry.id).join(',');
    files.style.setProperty('--tile', `${S.centre === 'grid' ? S.gridTile : S.tile}px`);
    $('#strip').replaceChildren(...(S.centre === 'viewer' && S.strip
      ? list.map(entry => el('div', { class: 'item', 'data-id': entry.id, title: entry.name }, pic(entry)))
      : []));
    $('#strip').hidden = !S.strip || !list.length;
    nearView.disconnect();
    for (const element of $$('.item')) {
      const entry = byId(Number(element.dataset.id));
      paintItem(element, entry);
      if (!entry.thumbState) nearView.observe(element);
    }

    // The folders, as a tree
    $('#tree').replaceChildren(...S.folders.map(folder => {
      const depth = folder.split('/').length - 1;
      const count = entries.filter(entry => entry.path === folder && !entry.parent).length;
      return el('button', { 'data-folder': folder, class: folder === S.folder ? 'on' : '', style: `padding-left:${6 + depth * 14}px` },
        `${FOLDER_ICON} ${folder.split('/').pop()} `, el('span', { class: 'count' }, String(count)));
    }));
    const parts = S.folder ? S.folder.split('/') : [];
    const crumbs = parts.flatMap((part, i) => [
      i ? el('span', { class: 'sep' }, '›') : null,
      el('button', { 'data-folder': parts.slice(0, i + 1).join('/') }, part),
    ]).filter(Boolean);
    $('#crumbs').replaceChildren(...(crumbs.length ? crumbs : [el('span', { class: 'sep' }, 'Nothing open')]));
    $('#back').disabled = S.at <= 0;
    $('#fwd').disabled = S.at >= S.history.length - 1;

    $$('#views .btn').forEach(button => button.setAttribute('aria-pressed', button.dataset.view === S.view));
    $('#size').value = S.centre === 'grid' ? S.gridTile : S.tile;
    $('#size').hidden = S.view !== 'thumbs';
    $('#sort').value = S.sort;
    $('#dir').textContent = S.dir > 0 ? '↑' : '↓';
    $('#stripBtn').setAttribute('aria-pressed', S.strip);
    $('#gridBtn').setAttribute('aria-pressed', S.centre === 'grid');
    showCurrent();
    renderStatus();
  }

  // (only when it changes: putting the same mark in again would start its animation over)
  const slotHtml = new WeakMap();
  function setSlot(slot, parts) {
    const box = el('span', {}, parts);
    const html = box.innerHTML;
    if (slotHtml.get(slot) === html) return;
    slotHtml.set(slot, html);
    slot.replaceChildren(...box.childNodes);
  }

  // The files the lists were last drawn with, in order. A file's status decides whether it is in a list filtered by
  // status, and where it is in one sorted by it: when a job changes that, the lists are drawn again, so a file
  // appears under "Processed" as its job ends (and leaves "Not processed").
  let listed = '';
  function redrawIfTheListChanged() {
    if (S.status === 'all' && S.sort !== 'status') return false;
    if (visible().map(entry => entry.id).join(',') === listed) return false;
    render();
    return true;
  }

  // One file's elements in the lists, brought up to date
  function paintItem(element, entry) {
    element.classList.toggle('sel', S.selected.has(entry.id));
    element.classList.toggle('cur', entry.id === S.current);
    element.classList.toggle('blocked', entry.status === 'blocked');
    const picture = element.querySelector('.pic img');
    const thumb = thumbOf(entry);
    if (thumb && picture.getAttribute('src') !== thumb) picture.src = thumb;
    setSlot(element.querySelector('.bslot'), badge(entry));
    const words = element.querySelector('.words');
    if (words) setSlot(words, badge(entry, true));
    const dims = element.querySelector('.dims');
    if (dims) dims.textContent = fmtDims(entry);
  }

  // An entry changed: its elements in the lists (a frame's video stands for it there), and what else shows it
  function updateEntry(entry) {
    if (redrawIfTheListChanged()) return;
    const inList = entry.parent ? byId(entry.parent) : entry;
    if (inList) $$(`.item[data-id="${inList.id}"]`).forEach(element => paintItem(element, inList));
    if (entry === shown() || entry === current() || inList === current()) {
      renderInfo();
      showResult();
      updateSpinner();
    }
    renderStatus();
  }

  // The selection or the file open changed
  function updateMarks() {
    for (const element of $$('.item')) {
      const id = Number(element.dataset.id);
      element.classList.toggle('sel', S.selected.has(id));
      element.classList.toggle('cur', id === S.current);
    }
    renderStatus();
  }

  // Positions change for every waiting file at once
  function updateWaiting() {
    if (redrawIfTheListChanged()) return;
    entries.filter(entry => entry.status === 'queued').forEach(entry => {
      const inList = entry.parent ? byId(entry.parent) : entry;
      if (inList) $$(`.item[data-id="${inList.id}"]`).forEach(element => paintItem(element, inList));
    });
    renderStatus();
  }

  function renderStatus() {
    const listed = entries.filter(entry => !entry.parent);
    const list = visible();
    const processed = entries.filter(entry => entry.status === 'done').length;
    const failed = entries.filter(entry => entry.status === 'failed').length;
    const unsaved = unsavedHere();
    const bold = number => el('b', {}, String(number));
    $('#sCounts').replaceChildren(...(listed.length
      ? [bold(list.length), ` file${list.length === 1 ? '' : 's'} · `, bold(S.selected.size), ' selected · ', bold(processed), ' processed',
        ...(failed ? [' · ', bold(failed), ' failed'] : []), ...(unsaved ? [' · ', bold(unsaved), ' not saved'] : [])]
      : ['Nothing open']));
    const waiting = waitingCount();
    $('#queueBtn').textContent = `${waiting} in queue ▴`;
    $('#queueBtn').hidden = !listed.length;
    const credits = Number.isFinite(S.credits) ? [el('b', {}, S.credits.toLocaleString()), ` credit${S.credits === 1 ? '' : 's'} · `] : [];
    $('#sWhere').replaceChildren(...(S.server ? [...credits, 'img2img server'] : ['My ComfyUI']));
    $('#whereLine').textContent = S.server ? 'Processing is set to the img2img server.' : 'Processing is set to your own ComfyUI.';

    // One button for whatever is selected: a video that is open stands for the frame it is stopped on
    const onlyVideo = S.selected.size === 1 && isVideo(byId([...S.selected][0]));
    $('#runSel').textContent = onlyVideo ? 'Process this frame' : `Process selected (${S.selected.size})`;
    $('#runSel').disabled = !S.selected.size;
    $('#stopBtn').hidden = waiting === 0;
    $('#stopBtn').textContent = waiting > 1 ? `Stop (${waiting} waiting)` : 'Stop';
    $('#qRetry').disabled = !failed;
    const queued = [...handedOver, ...waitingHere];
    const rows = queued.map(entry => el('div', {},
      el('span', {}, entry.name),
      el('small', {}, entry.status === 'processing' ? 'processing' : 'waiting'),
      entry.status === 'processing' ? null : el('button', { 'data-take': entry.id, title: 'Take it back' }, CROSS)));
    $('#queueList').replaceChildren(...(rows.length ? rows : [el('div', {}, el('span', {}, 'Nothing waiting.'))]));
  }

  function renderInfo() {
    const file = current();
    const entry = shown();
    const info = $('#info');
    if (!file) {
      info.replaceChildren(el('span', { class: 'hint' }, 'No file open.'));
      return;
    }
    const row = (key, value) => el('div', {}, el('span', { class: 'k' }, key), value);
    const heading = text => el('div', { class: 'pane-h', style: 'padding:10px 0 2px' }, text);
    const parts = [row('Name', file.name), row('Dimensions', fmtDims(file))];
    if (isVideo(file)) parts.push(row('Length', file.duration ? fmtTime(file.duration) : '…'));
    parts.push(row('Size', fmtSize(file.size)), row('Modified', fmtDate(file.modified)));
    if (isVideo(file)) {
      const frames = framesOf(file);
      parts.push(heading('Frames'));
      parts.push(...(frames.length
        ? frames.map(frame => el('div', { class: `ver ${frame.id === S.frame ? 'on' : ''}`, 'data-frame': frame.id },
          el('div', { class: 'grow' }, fmtTime(frame.t, true), el('small', {}, frame.error || STATUS[frame.status])),
          el('button', { class: 'del', 'data-delframe': frame.id, title: 'Take this frame off the list, with its results' }, CROSS)))
        : [el('p', { class: 'hint' }, 'Stop the video where you want and press “Process this frame”. Any number of its frames can be processed.')]));
    }
    if (isVideo(entry)) {
      info.replaceChildren(...parts);
      return;
    }
    parts.push(row('Status', STATUS[entry.status]));
    if (entry.error) parts.push(el('div', { class: 'error' }, entry.error));
    parts.push(heading(`Results${entry.parent ? ' of this frame' : ''}`));
    parts.push(el('div', { class: `ver ${entry.shown < 0 ? 'on' : ''}`, 'data-result': -1 }, el('div', { class: 'grow' }, 'Original')));
    parts.push(...entry.results.map((result, i) => {
      const time = result.time ? new Date(result.time).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' }) : '';
      const where = result.savedAs ? `Saved as ${result.savedAs}` : result.saveError ? `Not saved: ${result.saveError}` : result.madeHere ? 'Not saved' : '';
      return el('div', { class: `ver ${entry.shown === i ? 'on' : ''}`, 'data-result': i },
        el('div', { class: 'grow' }, result.label, el('small', { title: where }, [time, where].filter(Boolean).join(' · '))),
        result.saved ? el('button', { 'data-show': i, title: 'Show the saved file in its folder' }, FOLDER_ICON) : null,
        el('button', { class: 'del', 'data-delresult': i, title: 'Delete this result (it asks first, and offers the file it was saved as)' }, CROSS));
    }));
    info.replaceChildren(...parts);
  }

  // ---------- The viewer ----------

  const viewer = $('#viewer');
  const canvas = $('#canvas');
  const vOrig = $('#vOrig');
  const vRes = $('#vRes');
  const vVid = $('#vVid');
  const picture = { entry: null, url: '', result: null }; // what the viewer holds: its original's URL, and the result on it

  // Point the viewer at an entry's original (null: at nothing). The URL of the one before is let go.
  function showPicture(entry) {
    if (picture.entry === entry) return;
    if (picture.url) URL.revokeObjectURL(picture.url);
    picture.entry = entry;
    picture.result = null;
    picture.url = entry ? URL.createObjectURL(entry.file || entry.blob) : '';
    closeComparison(vRes);
    vRes.removeAttribute('src');
    if (!entry) {
      vOrig.removeAttribute('src');
      vVid.removeAttribute('src');
      vVid.load();
    } else if (isVideo(entry)) {
      vVid.src = picture.url;
    } else {
      vVid.removeAttribute('src');
      vVid.load();
      vOrig.src = picture.url;
    }
  }

  function showCurrent() {
    const entry = shown();
    const file = current();
    const list = visible();
    $('#vMsg').hidden = entries.length > 0;
    $('#vName').textContent = file ? file.name : '';
    $('#vCount').textContent = file ? `${list.findIndex(other => other.id === file.id) + 1} / ${list.length}` : '';
    $('#vidBar').hidden = !isVideo(file) || S.centre !== 'viewer';
    if (entry?.parent) {
      // A frame's own picture goes on the <img>; its video stays loaded underneath, so going back to it is where it
      // was left
      showPicture(file);
      if (frameShown.entry !== entry) {
        if (frameShown.url) URL.revokeObjectURL(frameShown.url);
        frameShown.entry = entry;
        frameShown.url = URL.createObjectURL(entry.blob);
        vOrig.src = frameShown.url;
      }
    } else {
      forgetFrameShown();
      showPicture(entry || null);
    }
    renderInfo();
    showResult();
    updateVideoBar();
    updateSpinner();
  }

  // The frame of the open video that is on show, with the URL of its picture
  const frameShown = { entry: null, url: '' };
  function forgetFrameShown() {
    if (frameShown.url) URL.revokeObjectURL(frameShown.url);
    frameShown.entry = null;
    frameShown.url = '';
  }

  // A result's picture, read from the cache the first time it is looked at (one made here is already held).
  // Resolves false when the cache no longer has it.
  async function loadResult(result) {
    if (result.url) return true;
    if (!result.key) return false;
    result.loading ??= (async () => {
      const dataUrl = await getFromCache(result.key).catch(() => null);
      if (!dataUrl) return false;
      resultKeys.delete(dataUrl); // (content.js notes each result it is handed by its picture, which a page of many can't hold)
      await holdResult(result, dataUrl);
      return true;
    })();
    const loaded = await result.loading;
    result.loading = null;
    return loaded;
  }

  // Keep a result's picture as a blob: URL (the data URL it arrives as is let go), with its size and a small copy
  async function holdResult(result, dataUrl) {
    const blob = await (await fetch(dataUrl)).blob();
    result.url = URL.createObjectURL(blob);
    try {
      const drawn = await pictureOf(blob);
      result.w = drawn.width;
      result.h = drawn.height;
      if (result.thumb.startsWith('blob:')) URL.revokeObjectURL(result.thumb);
      result.thumb = await smallCopy(drawn.source, drawn.width, drawn.height);
      drawn.done();
    } catch (error) {
      // (shown at whatever size the <img> finds, and listed with the original's thumbnail)
    }
  }

  function forgetResult(result) {
    if (result.url) URL.revokeObjectURL(result.url);
    if (result.thumb.startsWith('blob:')) URL.revokeObjectURL(result.thumb);
    result.url = '';
  }

  // The result in place of the original, and the two compared when Slider or Side by side is chosen (syncComparison)
  let resultWanted = 0;
  async function showResult() {
    const entry = shown();
    const result = entry && !isVideo(entry) ? entry.results[entry.shown] || null : null;
    const asked = ++resultWanted;
    if (result && !result.url) {
      // (the original shows while its result is read)
      vVid.hidden = true;
      vRes.hidden = true;
      vOrig.hidden = false;
      canvas.hidden = false;
      syncComparison(null);
      layout();
      const loaded = await loadResult(result);
      if (asked !== resultWanted) return; // (something else is on show by now)
      if (!loaded) {
        // No longer in the cache (it keeps the newest, up to its size): off the list, the file itself is untouched
        entry.results.splice(entry.results.indexOf(result), 1);
        entry.shown = entry.results.length - 1;
        if (entry.status === 'done' && !entry.results.length) entry.status = 'none';
        showPageNotice('That result is no longer in the cache.');
        updateEntry(entry);
        return;
      }
      updateEntry(entry); // (its thumbnail)
      return;
    }
    const has = Boolean(result);
    canvas.hidden = !entry;
    if (!entry) {
      syncComparison(null);
      return;
    }
    const video = isVideo(entry);
    vVid.hidden = !video;
    vOrig.hidden = video || (has && !S.peek);
    vRes.hidden = !has || S.peek;
    if (has && picture.result !== result) {
      picture.result = result;
      vRes.src = result.url;
    } else if (!has) {
      picture.result = null;
    }
    layout();
    syncComparison(has && !S.peek ? { entry, result } : null);
  }

  // Slider and Side by side are content.js's comparison (openComparison), the one a processed image has on a web
  // page and in its result tab, laid over the result's picture here: the divider to drag, the captions with each
  // picture's size, the pair saved as one picture. It follows the picture as it is zoomed, and Side by side takes
  // the viewer (sideBySideRoom). The three buttons above the viewer choose; the comparison's own bar works too, and
  // the buttons follow it (see the observer below).
  sideBySideRoom = () => {
    const area = viewer.getBoundingClientRect();
    return { left: area.left, top: area.top, width: area.width, height: area.height };
  };

  // showing: { entry, result } while a result is on show to be compared, null otherwise
  function syncComparison(showing) {
    const view = S.compare === 'split' ? 'slider' : S.compare === 'side' ? 'side' : null;
    const open = comparisons.get(vRes);
    if (open && (!showing || !view || open.shown !== imageSrc(vRes))) closeComparison(vRes);
    if (showing && view && vRes.getAttribute('src')) {
      const now = comparisons.get(vRes);
      if (!now) {
        const original = showing.entry.parent ? frameShown.url : picture.url;
        openComparison(vRes, { original, result: showing.result.url, name: showing.result.name }, view);
      } else if (now.view() !== view) {
        now.show(view);
      }
    }
    const pressed = showing || (picture.result && S.peek) ? S.compare : 'result';
    $$('#compare .btn').forEach(button => {
      button.setAttribute('aria-pressed', button.dataset.cmp === pressed);
      button.disabled = !picture.result && button.dataset.cmp !== 'result';
    });
  }

  // The comparison's own bar switches the view and closes it too: the buttons above the viewer go by what it did
  new MutationObserver(() => {
    if (!picture.result || S.peek || picture.result.url !== vRes.getAttribute('src')) return; // (not a choice: nothing to compare)
    const open = comparisons.get(vRes);
    const chosen = open ? (open.view() === 'side' ? 'side' : 'split') : 'result';
    if (chosen === S.compare) return;
    S.compare = chosen;
    saveLayout();
    syncComparison({ entry: shown(), result: picture.result });
  }).observe(vRes, { attributes: true, attributeFilter: ['data-img2img-comparing'] });

  // The size of what the picture area holds: the result's own while it shows alone (an upscaled or cropped result
  // has another size than its original), the original's otherwise
  function boxSize() {
    const entry = shown();
    if (!entry) return null;
    const result = isVideo(entry) ? null : entry.results[entry.shown];
    const alone = result?.url && !S.peek;
    const width = alone ? result.w || vRes.naturalWidth : entry.w || (isVideo(entry) ? vVid.videoWidth : vOrig.naturalWidth);
    const height = alone ? result.h || vRes.naturalHeight : entry.h || (isVideo(entry) ? vVid.videoHeight : vOrig.naturalHeight);
    return width && height ? { width, height } : null;
  }

  function layout() {
    const box = boxSize();
    if (!box) return;
    canvas.style.width = `${box.width}px`;
    canvas.style.height = `${box.height}px`;
    if (S.fitMode !== 'free') {
      const area = viewer.getBoundingClientRect();
      const fit = Math.min(area.width / box.width, area.height / box.height) * 0.96;
      const fill = Math.max(area.width / box.width, area.height / box.height);
      S.scale = S.fitMode === 'fill' ? fill : fit;
      S.tx = (area.width - box.width * S.scale) / 2;
      S.ty = (area.height - box.height * S.scale) / 2;
    }
    applyTransform();
  }

  function applyTransform() {
    canvas.style.transform = `translate(${S.tx}px, ${S.ty}px) scale(${S.scale})`;
    $('#zoom').value = Math.round(S.scale * 100);
    $('#zoomPct').textContent = `${Math.round(S.scale * 100)}%`;
    $('#zFit').setAttribute('aria-pressed', S.fitMode === 'fit');
    $('#zFill').setAttribute('aria-pressed', S.fitMode === 'fill');
    updateSpinner();
  }

  // The mark on the picture while its file waits or is processed: content.js's own spinner (createSpinnerMark), which
  // follows an image on a page and here is kept on the picture's top-left corner. One mark for the file on show,
  // told what that file's job has said so far.
  let spinnerMark = null; // { entry, mark, estimate }
  function updateSpinner() {
    const entry = shown();
    const busy = Boolean(entry) && (entry.status === 'queued' || entry.status === 'processing') && S.centre === 'viewer';
    if (spinnerMark && (!busy || spinnerMark.entry !== entry)) {
      spinnerMark.mark.remove();
      spinnerMark = null;
    }
    if (!busy) return;
    if (!spinnerMark) {
      const mark = createSpinnerMark();
      mark.id = 'spinner';
      Object.assign(mark.style, { position: 'absolute', zIndex: '4' });
      viewer.append(mark);
      spinnerMark = { entry, mark, estimate: null };
    }
    const { mark } = spinnerMark;
    const waiting = entry.status === 'queued';
    mark.setWaiting(waiting ? aheadOf(entry) : 0, waiting ? () => takeBack(entry) : null);
    if (!waiting && entry.estimate && spinnerMark.estimate !== entry.estimate) {
      spinnerMark.estimate = entry.estimate;
      mark.setEstimate(entry.estimate.ms, entry.estimate.start);
    } else if (!waiting && !entry.estimate && entry.progress !== null) {
      mark.setProgress(entry.progress);
    }
    mark.tick();
    mark.style.left = `${Math.max(10, S.tx + 10)}px`;
    mark.style.top = `${Math.max(10, S.ty + 10)}px`;
  }

  function zoomTo(scale, x, y) {
    const area = viewer.getBoundingClientRect();
    x ??= area.width / 2;
    y ??= area.height / 2;
    scale = Math.min(8, Math.max(0.05, scale));
    const change = scale / S.scale;
    S.tx = x - (x - S.tx) * change;
    S.ty = y - (y - S.ty) * change;
    S.scale = scale;
    S.fitMode = 'free';
    applyTransform();
  }

  // Sizes that only the loaded picture knows
  vOrig.addEventListener('load', () => {
    const entry = shown();
    if (entry && !isVideo(entry) && !entry.w) {
      entry.w = vOrig.naturalWidth;
      entry.h = vOrig.naturalHeight;
      updateEntry(entry);
    }
    layout();
  });
  vRes.addEventListener('load', layout);
  new ResizeObserver(layout).observe(viewer);

  function setCurrent(id) {
    if (id !== S.current) {
      leaveVideo();
      S.fitMode = 'fit';
    }
    S.current = id;
    S.currentName = current()?.name || '';
    saveLayout();
    showCurrent();
    updateMarks();
    $$(`.item[data-id="${id}"]`).forEach(element => element.scrollIntoView({ block: 'nearest', inline: 'nearest' }));
  }

  function step(by, to) {
    const list = visible();
    if (!list.length) return;
    const at = list.findIndex(entry => entry.id === S.current);
    const next = list[to ?? Math.min(list.length - 1, Math.max(0, at + by))];
    S.selected = new Set([next.id]);
    S.anchor = next.id;
    setCurrent(next.id);
  }

  function setCentre(mode) {
    S.centre = mode;
    $('#gridHost').hidden = mode !== 'grid';
    $('#viewerWrap').hidden = mode === 'grid';
    (mode === 'grid' ? $('#gridHost') : $('#filesHost')).append($('#filesPanel'));
    if (mode === 'grid') vVid.pause();
    saveLayout();
    render();
    if (mode === 'viewer') layout();
  }

  // ---------- A video: stop it anywhere, and that frame is processed like a picture ----------

  function updateVideoBar() {
    const video = current();
    if (!isVideo(video)) return;
    const length = video.duration || vVid.duration || 0;
    const time = S.frame ? byId(S.frame).t : vVid.currentTime || 0;
    $('#scrub').max = length || 1;
    $('#scrub').value = time;
    $('#vTime').textContent = `${fmtTime(time, true)} / ${fmtTime(length)}`;
    $('#vPlay').textContent = vVid.paused ? '▶' : '❚❚';
    $('#marks').replaceChildren(...(length ? framesOf(video).map(frame => el('button', {
      'data-frame': frame.id,
      class: `${frame.results.length ? '' : 'wait'} ${frame.id === S.frame ? 'on' : ''}`,
      style: `left:${frame.t / length * 100}%`,
      title: `${fmtTime(frame.t, true)}: ${STATUS[frame.status]}`,
    })) : []));
  }

  // Away from the frame picked, back to the video itself
  function backToVideo() {
    if (!S.frame) return;
    S.frame = null;
    showCurrent();
  }

  function leaveVideo() {
    vVid.pause();
    S.frame = null;
  }

  function seek(time) {
    const video = current();
    if (!isVideo(video)) return;
    backToVideo();
    vVid.currentTime = Math.min(vVid.duration || video.duration || 0, Math.max(0, time));
    updateVideoBar();
  }

  function play(on) {
    if (!isVideo(current())) return;
    if (!on) {
      vVid.pause();
      return;
    }
    backToVideo();
    vVid.play().catch(() => {});
  }

  function showFrame(id) {
    const frame = byId(id);
    if (!frame) return;
    vVid.pause();
    vVid.currentTime = frame.t;
    S.frame = id;
    showCurrent();
  }

  // The frame the video is stopped on becomes a picture of its own, kept with the video, and joins the queue
  async function processFrame() {
    const video = current();
    if (!isVideo(video)) return;
    if (S.frame) {
      enqueue([byId(S.frame)]);
      return;
    }
    if (vVid.readyState < 2 || !vVid.videoWidth) {
      showPageNotice('This video has no frame to process yet.');
      return;
    }
    vVid.pause();
    const time = Number(vVid.currentTime.toFixed(2));
    let frame = framesOf(video).find(other => other.t === time);
    if (!frame) {
      const drawn = document.createElement('canvas');
      drawn.width = vVid.videoWidth;
      drawn.height = vVid.videoHeight;
      drawn.getContext('2d').drawImage(vVid, 0, 0);
      const blob = await canvasToPng(drawn);
      frame = addEntry({
        kind: 'frame', parent: video.id, t: time, blob, path: video.path, name: `${video.name} at ${fmtTime(time, true)}`,
        size: blob.size, modified: video.modified, type: 'PNG', key: `${video.key}&t=${time.toFixed(2)}`, w: drawn.width, h: drawn.height,
      });
    }
    S.frame = frame.id;
    showCurrent();
    enqueue([frame]);
  }

  function deleteFrame(id) {
    const frame = byId(id);
    if (!frame) return;
    if (frame.status === 'processing') {
      showPageNotice("This frame is being processed: it can be taken off the list once it's done.");
      return;
    }
    takeBack(frame);
    frame.results.forEach(result => {
      if (result.key) chrome.runtime.sendMessage({ action: 'deleteFromCache', hash: result.key }).catch(() => {});
      forgetResult(result);
    });
    entries = entries.filter(entry => entry !== frame);
    if (S.frame === id) S.frame = null;
    showCurrent();
    updateEntry(byId(frame.parent));
  }

  vVid.addEventListener('loadedmetadata', () => {
    const video = current();
    if (!isVideo(video)) return;
    video.w = vVid.videoWidth;
    video.h = vVid.videoHeight;
    video.duration = Number.isFinite(vVid.duration) ? vVid.duration : 0;
    updateEntry(video);
    updateVideoBar();
    layout();
  });
  for (const event of ['timeupdate', 'seeked', 'play', 'pause', 'ended']) {
    vVid.addEventListener(event, () => { if (!S.frame) updateVideoBar(); });
  }
  // (timeupdate comes a few times a second: while it plays, the timeline follows every frame drawn)
  const followPlayback = () => {
    if (!vVid.paused && !S.frame) updateVideoBar();
    spinnerMark?.mark.tick(); // (the ring of a job with an estimate moves with time)
    requestAnimationFrame(followPlayback);
  };
  requestAnimationFrame(followPlayback);

  // ---------- Jobs ----------
  //
  // The files to process wait here, in the order they were picked, and are handed to content.js's job code one or two
  // at a time: each is read whole to be sent off, and a folder's worth of them read at once would not fit in memory.
  // background.js runs them one after another (see its queue), across every tab.

  const waitingHere = []; // entries not handed over yet
  const handedOver = new Set(); // entries being read, waiting in background.js's queue, or being processed
  let handOverAtOnce = 2;
  let sameErrors = { message: '', count: 0 };

  const waitingCount = () => waitingHere.length + handedOver.size;
  const restingStatus = entry => (entry.results.length ? 'done' : 'none');

  // How many are ahead of a waiting file: background.js says for the ones it has, the rest follow those
  function aheadOf(entry) {
    if (handedOver.has(entry)) return entry.ahead ?? [...handedOver].indexOf(entry);
    return handedOver.size + waitingHere.indexOf(entry);
  }

  async function readJobsAtOnce() {
    const { jobsAtOnce, processingMode } = await chrome.storage.local.get(['jobsAtOnce', 'processingMode']);
    handOverAtOnce = jobsAtOnceFor(jobsAtOnce, processingMode) + 1; // (the next one ready as a job ends, as Automatic Selection keeps one)
  }

  function enqueue(list) {
    const fresh = list.filter(entry => entry && !isVideo(entry) && !waitingHere.includes(entry) && !handedOver.has(entry));
    for (const entry of fresh) {
      entry.status = 'queued';
      entry.error = '';
      entry.ahead = null;
      entry.taken = false;
      waitingHere.push(entry);
    }
    handOver();
    fresh.forEach(updateEntry);
    updateWaiting();
  }

  function handOver() {
    while (handedOver.size < handOverAtOnce && waitingHere.length) {
      const entry = waitingHere.shift();
      handedOver.add(entry);
      runEntry(entry);
    }
    tellWaitingHere();
  }

  // background.js counts the jobs it was handed; the files still waiting here are said to it, so the extension's
  // badge and the popup's "waiting" line count the whole run (see LIBRARY_PORT there). The port closes with the page.
  let waitingPort = null;
  let waitingTold = 0;
  function tellWaitingHere() {
    if (waitingHere.length === waitingTold) return;
    try {
      if (!waitingPort) {
        waitingPort = chrome.runtime.connect({ name: 'img2img-library' });
        waitingPort.onDisconnect.addListener(() => {
          void chrome.runtime.lastError;
          waitingPort = null;
          waitingTold = 0;
        });
      }
      waitingPort.postMessage({ waiting: waitingHere.length });
      waitingTold = waitingHere.length;
    } catch (error) {
      waitingPort = null; // (the extension was reloaded under the page)
    }
  }

  async function runEntry(entry) {
    try {
      await processEntry(entry);
      sameErrors = { message: '', count: 0 };
    } catch (error) {
      if (error.dropped) {
        entry.status = restingStatus(entry);
      } else {
        console.debug('img2img: processing failed:', error);
        const message = error.message === 'Failed to fetch' ? await unreachableServerMessage() : error.message;
        entry.error = error.notice ? `${message} — ${error.notice}` : message;
        // (the refusal's own words, see nsfwRefusal in shared/workflows.js)
        entry.status = /looks NSFW/.test(message) ? 'blocked' : 'failed';
        if (entry.status === 'failed') noteFailure(entry.error);
      }
    } finally {
      handedOver.delete(entry);
      entry.drop = null;
      entry.ahead = null;
      entry.progress = null;
      entry.estimate = null;
      if (entries.includes(entry)) updateEntry(entry);
      handOver();
      updateWaiting();
    }
  }

  // An error is said once on the page; the file keeps it, in its Info. The same one several times running is not
  // about the files (no credits left, the server out of reach, terms not agreed to), so the run stops there.
  function noteFailure(message) {
    sameErrors = sameErrors.message === message ? { message, count: sameErrors.count + 1 } : { message, count: 1 };
    if (sameErrors.count === 1) {
      showPageError(message);
    } else if (sameErrors.count >= SAME_ERROR_STOPS && waitingCount() > 1) {
      stopAll();
      showPageError(`Stopped, after the same error ${SAME_ERROR_STOPS} times: ${message}`);
    }
  }

  const taken = () => Object.assign(new Error('Taken out of the queue'), { dropped: true });

  // One file or frame, from its bytes to its result, along the path an image on a page takes in content.js
  // (hashedImage, then resultForImage: the cache first, then the checks, then the queue)
  async function processEntry(entry) {
    const clearsWhenPicked = queueClears;
    const url = URL.createObjectURL(entry.file || entry.blob);
    let blob;
    try {
      blob = await fetchImageBlob(url); // (as a page image is read: an SVG or a format that can't be processed becomes a PNG)
    } finally {
      URL.revokeObjectURL(url);
    }
    const [imageHash, base64Image, imageSize, settings, imageUrl, imageBlob] = await hashedImage(blob, entry.key, { tagName: 'IMG', naturalWidth: entry.w, naturalHeight: entry.h });
    selectedSourceId = settings.selectedSourceId; // (the source a workflow takes along is read through this)
    const workflow = effectiveWorkflow(settings);
    const label = (isCustomWorkflow(workflow) ? settings.customWorkflow?.name : WORKFLOW_LABELS[workflow]) || 'Result';
    const name = `${baseName(entry)}-${(workflowFileName(settings) || 'img2img').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()}`;
    const callbacks = {
      clearsWhenPicked,
      onProgress: progress => {
        entry.progress = progress;
        updateEntry(entry);
      },
      onEstimate: ms => {
        entry.estimate = { ms, start: performance.now() };
      },
      onWaiting: (ahead, drop) => {
        entry.ahead = ahead;
        entry.drop = ahead ? drop : null;
        entry.status = ahead ? 'queued' : 'processing';
        updateEntry(entry);
        updateWaiting();
      },
    };
    const result = await resultForImage({ imageHash, base64Image, imageSize, settings, imageUrl, imageBlob }, name, callbacks, () => {
      if (entry.taken) throw taken();
    });
    // (content.js notes each cached result it is handed by its picture, which a page of many can't hold)
    if (result.cached) resultKeys.delete(result.data);
    await addResult(entry, result.data, result.key, label, name);
    if (!result.cached && processesOnServer(settings)) readAccountSoon();
  }

  // A file's name without its extension; a frame's is its video's with the moment it is from
  function baseName(entry) {
    if (entry.parent) {
      const video = byId(entry.parent);
      return `${baseName(video)}-${fmtTime(entry.t, true).replace(':', 'm').replace('.', 's')}`;
    }
    return entry.name.replace(/\.[^.]+$/, '') || entry.name;
  }

  // A result joins its file's list and goes on show. With Download Results Automatically on it is saved straight away,
  // as a page's result is; otherwise it is saved from the Save menu. One the list already has (the cache answered
  // with it again) is only shown.
  async function addResult(entry, dataUrl, key, label, name) {
    let result = key ? entry.results.find(other => other.key === key) : null;
    const isNew = !result;
    if (isNew) {
      result = { key: key || '', url: '', label, name, time: Date.now(), w: 0, h: 0, thumb: '', saved: null, madeHere: true };
      entry.results.push(result);
    }
    if (!result.url) await holdResult(result, dataUrl);
    entry.shown = entry.results.indexOf(result);
    entry.status = 'done';
    entry.error = '';
    if (isNew && S.autoSave) saveResult(entry, result, dataUrl, name);
  }

  // Into Downloads, in a folder named after the one the file is in (background.js adds it under the Download Folder
  // setting, or under "img2img"). A name already taken there gets a number, so nothing is written over. Only ever the
  // result: Double Download's copy of the original would be a copy of a file the user already has, in that folder.
  async function saveResult(entry, result, dataUrl, name) {
    const filename = `${name}.${resultExtension(dataUrl)}`;
    const response = await chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl, filename, folder: entry.path }).catch(error => ({ success: false, error: error.message }));
    if (response?.success) {
      result.saved = response.downloadId;
      result.savedAs = (await savedPath(response.downloadId) || filename).split(/[\\/]/).slice(-2).join('/');
    } else {
      result.saveError = response?.error || 'no answer';
      showPageError(`The result of ${entry.name} couldn't be saved: ${result.saveError}`);
    }
    if (entries.includes(entry) && entry === shown()) renderInfo();
  }

  // Where a download ended up, once the browser has settled its name (a result may be saved as a JPG, and a name
  // already taken gets a number); empty if it doesn't say in a few seconds
  async function savedPath(downloadId) {
    for (let tries = 0; tries < 30; tries++) {
      const [download] = await chrome.downloads.search({ id: downloadId }).catch(() => []);
      if (!download || download.state === 'interrupted') return '';
      if (download.state === 'complete' && download.filename) return download.filename;
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    return '';
  }

  // ---------- Saving from the Save menu ----------

  // The result a file would be saved as: the one it shows, or its newest while it shows its original
  const resultOf = entry => entry.results[entry.shown] || entry.results.at(-1) || null;
  const withUnsavedResult = list => list.filter(entry => { const result = resultOf(entry); return result && !result.saved; });
  // Results made since the folder was opened and saved nowhere yet: what closing the page could lose
  const unsavedHere = () => entries.reduce((count, entry) => count + entry.results.filter(result => result.madeHere && !result.saved).length, 0);
  // (a video stands for its frames)
  const withFrames = list => list.flatMap(entry => (isVideo(entry) ? framesOf(entry) : [entry]));

  // Save one file's result unless it has been already (here, or in an earlier session: background.js knows the files
  // a cached result was downloaded as). Resolves 'saved', 'already' or 'failed'.
  async function saveNow(entry) {
    const result = resultOf(entry);
    if (!result || !await loadResult(result)) return 'failed';
    if (!result.saved && result.key) {
      const response = await chrome.runtime.sendMessage({ action: 'downloadedFiles', hash: result.key }).catch(() => null);
      const file = response?.files?.[0];
      if (file) {
        result.saved = file.id;
        result.savedAs = file.path.split(/[\\/]/).slice(-2).join('/');
      }
    }
    if (result.saved) return 'already';
    const dataUrl = await blobToDataUrl(await (await fetch(result.url)).blob());
    await saveResult(entry, result, dataUrl, result.name);
    return result.saved ? 'saved' : 'failed';
  }

  async function saveMany(list) {
    const counts = { saved: 0, already: 0, failed: 0 };
    for (const entry of list) counts[await saveNow(entry)]++;
    const said = [];
    if (counts.saved) said.push(`${counts.saved} result${counts.saved === 1 ? '' : 's'} saved in Downloads`);
    if (counts.already) said.push(`${counts.already} already saved`);
    if (counts.failed) said.push(`${counts.failed} couldn't be saved`);
    if (said.length) showPageNotice(`${said.join(', ')}.`);
    renderInfo();
    renderStatus();
  }

  // Every file's result in one ZIP, laid out in the folders the files are in. Each goes in as the file it would be
  // saved as by itself (a JPG or as it is, by the Download as JPG setting: background.js makes it), and is stored
  // rather than compressed, since a picture compressed again is no smaller.
  const ZIP_MOST_FILES = 65535;
  const ZIP_MOST_BYTES = 0xffffffff;
  const CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[n] = c >>> 0;
    }
    return table;
  })();
  function crc32(bytes) {
    let c = 0xffffffff;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  }

  // files: [{ path, blob }]. Stored, not compressed; resolves with the ZIP as a Blob.
  async function zipOf(files) {
    const now = new Date();
    const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
    const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
    const parts = [];
    const directory = [];
    let offset = 0;
    for (const { path, blob } of files) {
      const name = new TextEncoder().encode(path);
      const bytes = new Uint8Array(await blob.arrayBuffer());
      const crc = crc32(bytes);
      if (offset + bytes.length + name.length + 30 > ZIP_MOST_BYTES) throw new Error('the results are too large for one ZIP');
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true);
      local.setUint16(4, 20, true);
      local.setUint16(6, 0x0800, true); // (names are UTF-8)
      local.setUint16(10, time, true);
      local.setUint16(12, date, true);
      local.setUint32(14, crc, true);
      local.setUint32(18, bytes.length, true);
      local.setUint32(22, bytes.length, true);
      local.setUint16(26, name.length, true);
      parts.push(local, name, bytes);
      const listed = new DataView(new ArrayBuffer(46));
      listed.setUint32(0, 0x02014b50, true);
      listed.setUint16(4, 20, true);
      listed.setUint16(6, 20, true);
      listed.setUint16(8, 0x0800, true);
      listed.setUint16(12, time, true);
      listed.setUint16(14, date, true);
      listed.setUint32(16, crc, true);
      listed.setUint32(20, bytes.length, true);
      listed.setUint32(24, bytes.length, true);
      listed.setUint16(28, name.length, true);
      listed.setUint32(42, offset, true);
      directory.push(listed, name);
      offset += 30 + name.length + bytes.length;
    }
    const directorySize = directory.reduce((size, part) => size + part.byteLength, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, directorySize, true);
    end.setUint32(16, offset, true);
    return new Blob([...parts, ...directory, end], { type: 'application/zip' });
  }

  // A result's picture as the file a download of it would be: { blob, extension }. As it is, if background.js
  // can't say.
  async function asDownloaded(result) {
    const original = await (await fetch(result.url)).blob();
    const ownExtension = resultExtension(original.type);
    const response = await chrome.runtime.sendMessage({ action: 'downloadableImage', dataUrl: await blobToDataUrl(original), filename: `${result.name}.${ownExtension}` }).catch(() => null);
    if (!response?.success || !response.url) return { blob: original, extension: ownExtension };
    try {
      const blob = await (await fetch(response.url)).blob();
      return { blob, extension: response.filename?.split('.').pop() || ownExtension };
    } catch (error) {
      return { blob: original, extension: ownExtension };
    } finally {
      if (response.url.startsWith('blob:')) URL.revokeObjectURL(response.url);
    }
  }

  async function saveZip(list) {
    if (list.length > ZIP_MOST_FILES) {
      showPageError('That is more results than one ZIP holds.');
      return;
    }
    showPageNotice(`Putting ${list.length} result${list.length === 1 ? '' : 's'} in a ZIP…`);
    const files = [];
    const taken = new Set();
    for (const entry of list) {
      const result = resultOf(entry);
      if (!await loadResult(result)) continue;
      const { blob, extension } = await asDownloaded(result);
      const base = `${entry.path}/${result.name}`.replace(/[\\:*?"<>|\x00-\x1f]/g, '_');
      let path = `${base}.${extension}`;
      for (let n = 1; taken.has(path.toLowerCase()); n++) path = `${base} (${n}).${extension}`;
      taken.add(path.toLowerCase());
      files.push({ path, blob });
    }
    if (!files.length) {
      showPageNotice('There are no results to put in a ZIP.');
      return;
    }
    try {
      const url = URL.createObjectURL(await zipOf(files));
      const top = (S.folders[0] || 'results').split('/')[0].replace(/[\\/:*?"<>|\x00-\x1f]/g, '_');
      await chrome.downloads.download({ url, filename: `${top}-img2img.zip` });
      setTimeout(() => URL.revokeObjectURL(url), 60000); // (once the browser has had time to read it)
      showPageNotice(`${files.length} result${files.length === 1 ? '' : 's'} saved in Downloads as ${top}-img2img.zip.`);
    } catch (error) {
      showPageError(`The ZIP couldn't be saved: ${error.message}`);
    }
  }

  function openSaveMenu() {
    const menu = $('#saveMenu');
    if (!menu.hidden) {
      menu.hidden = true;
      return;
    }
    closeMenus();
    const onShow = shown();
    const thisOne = onShow && !isVideo(onShow) && onShow.results[onShow.shown] ? onShow : null;
    const selected = withUnsavedResult(withFrames([...S.selected].map(byId).filter(Boolean)));
    const all = withUnsavedResult(entries);
    const zipped = entries.filter(resultOf);
    const count = list => (list.length ? ` (${list.length})` : '');
    const thisSaved = Boolean(thisOne && resultOf(thisOne).saved);
    menu.replaceChildren(
      el('button', { 'data-save': 'this', disabled: !thisOne || thisSaved }, thisSaved ? 'This result is saved' : 'Save this result'),
      el('button', { 'data-save': 'selected', disabled: !selected.length }, `Save selected results${count(selected)}`),
      el('button', { 'data-save': 'all', disabled: !all.length }, `Save all results${count(all)}`),
      el('hr'),
      el('button', { 'data-save': 'zip', disabled: !zipped.length }, `Save all results as a ZIP${count(zipped)}`),
      el('div', { class: 'note' }, S.autoSave
        ? 'Results are also saved as they finish (Download Results Automatically is on).'
        : 'Results are saved from here only. To save each one as it finishes, turn on Download Results Automatically in the settings.'));
    menu.hidden = false;
    const button = $('#saveBtn').getBoundingClientRect();
    menu.style.transform = `translate(${Math.min(button.left, innerWidth - menu.offsetWidth - 8)}px, ${button.bottom + 4}px)`;
    menu.onclick = click => {
      const action = click.target.closest('[data-save]:not(:disabled)')?.dataset.save;
      if (!action) return;
      menu.hidden = true;
      ({
        this: () => saveMany([thisOne]),
        selected: () => saveMany(selected),
        all: () => saveMany(all),
        zip: () => saveZip(zipped),
      })[action]();
    };
  }

  function takeBack(entry) {
    const at = waitingHere.indexOf(entry);
    if (at >= 0) {
      waitingHere.splice(at, 1);
      tellWaitingHere();
      entry.status = restingStatus(entry);
      updateEntry(entry);
      updateWaiting();
      return;
    }
    if (!handedOver.has(entry) || entry.status === 'processing') return; // (one being processed finishes)
    entry.taken = true;
    entry.drop?.();
  }

  function stopAll() {
    const waiting = waitingHere.splice(0);
    tellWaitingHere();
    waiting.forEach(entry => { entry.status = restingStatus(entry); });
    [...handedOver].forEach(takeBack);
    waiting.forEach(entry => { if (entries.includes(entry)) updateEntry(entry); });
    updateWaiting();
  }

  // "Process selected": the images selected, and of the video that is open (if it is selected) the frame showing.
  // Other videos selected with them are left alone, since nobody has chosen a frame of theirs. A run of many asks
  // first, by the popup's own rule ("Ask Before" in the settings), with what it costs on the img2img server.
  async function runSelected() {
    const video = current();
    const picked = [...S.selected].map(byId).filter(Boolean);
    const images = picked.filter(entry => !isVideo(entry));
    const frame = isVideo(video) && S.selected.has(video.id);
    if (!images.length && !frame) {
      if (picked.some(isVideo)) showPageNotice('A video is processed a frame at a time: open it and stop where you want first.');
      return;
    }
    if (images.length && !await agreedToRun(images.length)) return;
    if (frame) processFrame();
    enqueue(images);
  }

  async function agreedToRun(count) {
    const { autoAskOver } = await chrome.storage.local.get('autoAskOver');
    const askOver = askOverLimit(autoAskOver);
    if (askOver <= 0 || count <= askOver) return true;
    const settings = await getSettings();
    const cost = runCostText(count, S.costs[settings.workflow], processesOnServer(settings));
    const ask = $('#ask');
    $('#askText').textContent = `About ${count} images will be converted.${cost} Go ahead?`;
    ask.returnValue = '';
    ask.showModal();
    await new Promise(resolve => ask.addEventListener('close', resolve, { once: true }));
    return ask.returnValue === 'ok';
  }

  // Deleting a result, as its delete button does on a page: content.js's question first (unless "Don't ask again" was
  // ticked), which offers the file the result was downloaded as, by name, when there is one; ticked, the file goes
  // with the result.
  const deletingResults = new Set();
  async function deleteResult(entry, index) {
    const result = entry.results[index];
    if (!result || deletingResults.has(result)) return;
    if (result.key) {
      deletingResults.add(result);
      try {
        const answer = await confirmDeletion(await downloadedFilesOf(result.key));
        if (!answer) return;
        const response = await chrome.runtime.sendMessage({ action: 'deleteFromCache', hash: result.key, deleteFiles: answer.deleteFiles }).catch(() => null);
        if (!response?.success) {
          showPageError(`Couldn't delete it: ${response?.error || 'no answer'}`);
          return;
        }
        if (response.fileError) showPageError(`The downloaded file couldn't be deleted: ${response.fileError}`);
      } finally {
        deletingResults.delete(result);
      }
      index = entry.results.indexOf(result); // (the list may have changed while the question was up)
      if (index < 0) return;
    }
    if (picture.result === result) picture.result = null;
    forgetResult(result);
    entry.results.splice(index, 1);
    entry.shown = Math.min(entry.shown >= index ? entry.shown - 1 : entry.shown, entry.results.length - 1);
    if (entry.status === 'done') entry.status = restingStatus(entry);
    updateEntry(entry);
    if (entry === shown()) {
      renderInfo();
      showResult();
    }
  }

  // The popup cleared the queue, in every tab: background.js has dropped what it held, and what waits here goes too
  chrome.runtime.onMessage.addListener(request => {
    if (request.action === 'queueCleared') stopAll();
  });

  // Leaving takes the waiting files out of the queue, and results not saved yet may not be in the cache for long
  // (it keeps the newest, up to its size), so the browser asks first
  window.addEventListener('beforeunload', event => {
    if (waitingCount() > 0 || unsavedHere() > 0) {
      event.preventDefault();
      event.returnValue = '';
    }
  });

  // ---------- Where images go, and the credits there ----------

  async function readAccount() {
    const settings = await chrome.storage.local.get(['processingMode', 'autoDownload']);
    S.server = processesOnServer(settings);
    S.autoSave = settings.autoDownload === true;
    readJobsAtOnce();
    if (S.server) {
      const [account, workflows] = await Promise.all([fetchAccount(), fetchServerWorkflows()]); // (shared/workflows.js)
      S.credits = account.credits;
      S.costs = workflows.credits;
    }
    renderStatus();
  }
  let accountTimer = 0;
  function readAccountSoon() {
    clearTimeout(accountTimer);
    accountTimer = setTimeout(readAccount, 1500);
  }
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.processingMode || changes.jobsAtOnce || changes.autoDownload || Object.keys(changes).some(key => /apikey|devserver/i.test(key))) readAccount();
  });

  // ---------- Events ----------

  $('#openFolder').addEventListener('click', pickFolder);
  $('#openFolderHere').addEventListener('click', pickFolder);
  $('#recentList').addEventListener('click', onRecentClick);
  $('#recentMenu').addEventListener('click', onRecentClick);
  $('#recentBtn').addEventListener('click', openRecentMenu);
  // (folders are only remembered where the browser has the folder picker)
  $('#recentBtn').hidden = !window.showDirectoryPicker;
  $('#openFiles').addEventListener('click', () => $('#pickFiles').click());
  $('#pickFolder').addEventListener('change', event => { openPicked(event.target.files, 'Files'); event.target.value = ''; });
  $('#pickFiles').addEventListener('change', event => { openPicked(event.target.files, 'Files'); event.target.value = ''; });

  window.addEventListener('dragover', event => { event.preventDefault(); document.body.classList.add('dragover'); });
  window.addEventListener('dragleave', () => document.body.classList.remove('dragover'));
  window.addEventListener('drop', event => {
    event.preventDefault();
    document.body.classList.remove('dragover');
    if (event.dataTransfer.items.length) openDropped(event.dataTransfer);
  });

  function closeMenus() {
    $('#ctx').hidden = true;
    $('#saveMenu').hidden = true;
    $('#recentMenu').hidden = true;
  }
  document.addEventListener('click', event => {
    const folder = event.target.closest('[data-folder]');
    if (folder) {
      go(folder.dataset.folder);
      return;
    }
    if (!event.target.closest('#saveBtn, #saveMenu, #recentBtn, #recentMenu')) closeMenus();
    if (!event.target.closest('#queue, #queueBtn')) $('#queue').hidden = true;
  });

  // The files: select, open, take a waiting one back
  function onItemClick(event) {
    const heading = event.target.closest('th');
    if (heading) {
      if (S.sort === heading.dataset.sort) S.dir = -S.dir;
      else Object.assign(S, { sort: heading.dataset.sort, dir: 1 });
      saveLayout();
      render();
      return;
    }
    const element = event.target.closest('.item');
    if (!element) {
      if (!event.ctrlKey && !event.shiftKey) {
        S.selected.clear();
        updateMarks();
      }
      return;
    }
    const id = Number(element.dataset.id);
    if (event.target.closest('.badge.queued')) {
      takeBack(byId(id));
      return;
    }
    const list = visible().map(entry => entry.id);
    if (event.shiftKey && S.anchor !== null && list.includes(S.anchor)) {
      const from = list.indexOf(S.anchor);
      const to = list.indexOf(id);
      if (!event.ctrlKey) S.selected.clear();
      for (let i = Math.min(from, to); i <= Math.max(from, to); i++) S.selected.add(list[i]);
    } else if (event.ctrlKey || event.metaKey) {
      if (S.selected.has(id)) S.selected.delete(id);
      else S.selected.add(id);
      S.anchor = id;
    } else {
      S.selected = new Set([id]);
      S.anchor = id;
    }
    setCurrent(id);
  }
  $('#files').addEventListener('click', onItemClick);
  $('#strip').addEventListener('click', onItemClick);
  $('#files').addEventListener('dblclick', event => {
    const element = event.target.closest('.item');
    if (!element) return;
    S.current = Number(element.dataset.id);
    setCentre(S.centre === 'grid' ? 'viewer' : 'grid');
  });
  viewer.addEventListener('dblclick', () => { if (current()) setCentre('grid'); });

  // Right-click on a file
  function onContextMenu(event) {
    const element = event.target.closest('.item');
    const id = element ? Number(element.dataset.id) : event.currentTarget === viewer ? S.current : null;
    if (!id) return;
    event.preventDefault();
    if (!S.selected.has(id)) {
      S.selected = new Set([id]);
      S.anchor = id;
    }
    setCurrent(id);
    const entry = byId(id);
    const many = S.selected.size > 1;
    const result = entry.results[entry.shown];
    const menu = $('#ctx');
    menu.replaceChildren(
      el('button', { 'data-do': 'process' }, `Process ${many ? `${S.selected.size} files` : isVideo(entry) ? 'this frame' : 'this image'}`),
      ...(entry.status === 'queued' ? [el('button', { 'data-do': 'take' }, 'Take it back from the queue')] : []),
      el('button', { 'data-do': 'open' }, 'Open'),
      el('button', { 'data-do': 'compare', disabled: !result }, 'Compare with the original'),
      el('hr'),
      el('button', { 'data-do': 'folder', disabled: !result?.saved }, 'Show the saved result in its folder'),
      el('button', { 'data-do': 'delete', disabled: !result }, 'Delete this result'));
    menu.hidden = false;
    menu.style.transform = `translate(${Math.min(event.clientX, innerWidth - menu.offsetWidth - 8)}px, ${Math.min(event.clientY, innerHeight - menu.offsetHeight - 8)}px)`;
    menu.onclick = click => {
      const action = click.target.closest('[data-do]')?.dataset.do;
      if (!action) return;
      click.stopPropagation();
      menu.hidden = true;
      ({
        process: runSelected,
        take: () => takeBack(entry),
        open: () => setCentre('viewer'),
        compare: () => { S.compare = 'split'; setCentre('viewer'); },
        folder: () => chrome.downloads.show(result.saved),
        delete: () => deleteResult(entry, entry.shown),
      })[action]();
    };
  }
  $('#files').addEventListener('contextmenu', onContextMenu);
  $('#strip').addEventListener('contextmenu', onContextMenu);
  viewer.addEventListener('contextmenu', onContextMenu);

  // The files' controls
  $('#views').addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (!button) return;
    S.view = button.dataset.view;
    saveLayout();
    render();
  });
  $('#size').addEventListener('input', event => {
    S[S.centre === 'grid' ? 'gridTile' : 'tile'] = Number(event.target.value);
    $('#files').style.setProperty('--tile', `${event.target.value}px`);
  });
  $('#size').addEventListener('change', saveLayout);
  $('#sort').addEventListener('change', event => { S.sort = event.target.value; saveLayout(); render(); });
  $('#dir').addEventListener('click', () => { S.dir = -S.dir; saveLayout(); render(); });
  $('#statusFilter').addEventListener('change', event => { S.status = event.target.value; saveLayout(); render(); });
  $('#typeFilter').addEventListener('change', event => { S.type = event.target.value; saveLayout(); render(); });
  $('#search').addEventListener('input', event => { S.search = event.target.value; saveLayout(); render(); });
  $('#includeSub').addEventListener('change', event => { S.includeSub = event.target.checked; saveLayout(); render(); });
  $('#back').addEventListener('click', () => { if (S.at > 0) go(S.history[--S.at], true); });
  $('#fwd').addEventListener('click', () => { if (S.at < S.history.length - 1) go(S.history[++S.at], true); });

  // The top bar
  $('#saveBtn').addEventListener('click', openSaveMenu);
  $('#toggleLeft').addEventListener('click', () => { document.body.classList.toggle('no-left'); saveLayout(); layout(); });
  $('#toggleRight').addEventListener('click', () => { document.body.classList.toggle('no-right'); saveLayout(); layout(); });
  $('#help').addEventListener('click', () => $('#keys').showModal());

  // The viewer's bar
  $('#prev').addEventListener('click', () => step(-1));
  $('#next').addEventListener('click', () => step(1));
  $('#zFit').addEventListener('click', () => { S.fitMode = 'fit'; layout(); });
  $('#zFill').addEventListener('click', () => { S.fitMode = 'fill'; layout(); });
  $('#z100').addEventListener('click', () => zoomTo(1));
  $('#zoom').addEventListener('input', event => zoomTo(event.target.value / 100));
  $('#compare').addEventListener('click', event => {
    const button = event.target.closest('[data-cmp]');
    if (!button || button.disabled) return;
    S.compare = button.dataset.cmp;
    saveLayout();
    showResult();
  });
  $('#stripBtn').addEventListener('click', () => { S.strip = !S.strip; saveLayout(); render(); layout(); });
  $('#gridBtn').addEventListener('click', () => setCentre('grid'));
  $('#full').addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : viewer.requestFullscreen()));

  const overViewer = event => event.target === viewer || viewer.contains(event.target) || Boolean(event.target.closest?.('.img2img-comparison'));
  window.addEventListener('wheel', event => {
    if (!event.ctrlKey || !shown() || !overViewer(event) || S.centre !== 'viewer') return;
    event.preventDefault();
    const area = viewer.getBoundingClientRect();
    zoomTo(S.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15), event.clientX - area.left, event.clientY - area.top);
  }, { passive: false });

  // Dragging the picture moves it
  viewer.addEventListener('pointerdown', event => {
    if (!boxSize() || event.button !== 0 || event.target.closest('button')) return;
    const from = { x: event.clientX, y: event.clientY, tx: S.tx, ty: S.ty };
    viewer.setPointerCapture(event.pointerId);
    viewer.classList.add('panning');
    const move = moved => {
      S.tx = from.tx + moved.clientX - from.x;
      S.ty = from.ty + moved.clientY - from.y;
      if (Math.abs(moved.clientX - from.x) + Math.abs(moved.clientY - from.y) > 3) S.fitMode = 'free';
      applyTransform();
    };
    const up = () => {
      viewer.classList.remove('panning');
      viewer.removeEventListener('pointermove', move);
      viewer.removeEventListener('pointerup', up);
      viewer.removeEventListener('pointercancel', up);
    };
    viewer.addEventListener('pointermove', move);
    viewer.addEventListener('pointerup', up);
    viewer.addEventListener('pointercancel', up);
  });

  // The left pane's width
  $('#splitL').addEventListener('pointerdown', event => {
    const bar = event.currentTarget;
    bar.setPointerCapture(event.pointerId);
    bar.classList.add('drag');
    const move = moved => document.documentElement.style.setProperty('--left-w', `${Math.max(180, moved.clientX)}px`);
    const up = () => {
      bar.classList.remove('drag');
      bar.removeEventListener('pointermove', move);
      bar.removeEventListener('pointerup', up);
      saveLayout();
    };
    bar.addEventListener('pointermove', move);
    bar.addEventListener('pointerup', up);
  });

  // The video's bar
  $('#vPlay').addEventListener('click', () => play(vVid.paused));
  $('#vBack').addEventListener('click', () => { vVid.pause(); seek((S.frame ? byId(S.frame).t : vVid.currentTime) - FRAME); });
  $('#vFwd').addEventListener('click', () => { vVid.pause(); seek((S.frame ? byId(S.frame).t : vVid.currentTime) + FRAME); });
  $('#scrub').addEventListener('input', event => { vVid.pause(); seek(Number(event.target.value)); });
  $('#marks').addEventListener('click', event => {
    const mark = event.target.closest('[data-frame]');
    if (mark) showFrame(Number(mark.dataset.frame));
  });

  // The right pane
  $('#runSel').addEventListener('click', runSelected);
  $('#stopBtn').addEventListener('click', stopAll);
  $('#info').addEventListener('click', event => {
    const entry = shown();
    const frameToDelete = event.target.closest('[data-delframe]');
    if (frameToDelete) {
      deleteFrame(Number(frameToDelete.dataset.delframe));
      return;
    }
    const frame = event.target.closest('[data-frame]');
    if (frame) {
      showFrame(Number(frame.dataset.frame));
      return;
    }
    const show = event.target.closest('[data-show]');
    if (show) {
      chrome.downloads.show(entry.results[Number(show.dataset.show)].saved);
      return;
    }
    const toDelete = event.target.closest('[data-delresult]');
    if (toDelete) {
      deleteResult(entry, Number(toDelete.dataset.delresult));
      return;
    }
    const result = event.target.closest('[data-result]');
    if (result) {
      entry.shown = Number(result.dataset.result);
      updateEntry(entry);
    }
  });

  // The queue
  $('#queueBtn').addEventListener('click', () => { $('#queue').hidden = !$('#queue').hidden; });
  $('#qStop').addEventListener('click', stopAll);
  $('#qRetry').addEventListener('click', () => enqueue(entries.filter(entry => entry.status === 'failed')));
  $('#queueList').addEventListener('click', event => {
    const button = event.target.closest('[data-take]');
    if (button) takeBack(byId(Number(button.dataset.take)));
  });

  window.addEventListener('keydown', event => {
    if (event.target.matches('input[type="search"], select') || document.querySelector('dialog[open]')) return;
    const key = event.key;
    if (key === ' ') {
      event.preventDefault();
      if (isVideo(shown())) {
        if (!event.repeat) play(vVid.paused);
      } else if (!S.peek) {
        S.peek = true;
        showResult();
      }
      return;
    }
    if (key === 'Escape') {
      closeMenus();
      $('#queue').hidden = true;
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'a') {
      event.preventDefault();
      S.selected = new Set(visible().map(entry => entry.id));
      updateMarks();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && key.toLowerCase() === 'i') {
      event.preventDefault();
      S.selected = new Set(visible().map(entry => entry.id).filter(id => !S.selected.has(id)));
      updateMarks();
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const actions = {
      ArrowLeft: () => step(-1), ArrowRight: () => step(1), ArrowUp: () => step(-1), ArrowDown: () => step(1),
      Home: () => step(0, 0), End: () => step(0, visible().length - 1),
      Enter: () => current() && setCentre(S.centre === 'grid' ? 'viewer' : 'grid'),
      0: () => { S.fitMode = 'fit'; layout(); }, 1: () => zoomTo(1),
      f: () => $('#full').click(), p: () => S.selected.size && runSelected(), '?': () => $('#keys').showModal(),
      Delete: () => { const entry = shown(); if (entry && !isVideo(entry) && entry.shown >= 0) deleteResult(entry, entry.shown); },
      ',': () => $('#vBack').click(), '.': () => $('#vFwd').click(),
    };
    const run = actions[key] || actions[key.toLowerCase()];
    if (run) {
      event.preventDefault();
      run();
    }
  });
  window.addEventListener('keyup', event => {
    if (event.key === ' ' && S.peek) {
      S.peek = false;
      showResult();
    }
  });

  loadLayout().then(() => setCentre(S.centre)).then(reopenLastFolder);
  readAccount();
})();
