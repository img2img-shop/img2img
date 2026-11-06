// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('img2img installed');
  // After a dev auto-reload, refresh the tab that was active so it gets the new content script
  chrome.storage.local.get('devReloadTabId', ({ devReloadTabId }) => {
    if (devReloadTabId) {
      chrome.storage.local.remove('devReloadTabId');
      chrome.tabs.reload(devReloadTabId, () => void chrome.runtime.lastError);
    }
  });
});

// Development auto-reload: tools/dev-reload.js says "reload" when a file changes. Opt-in via the popup's
// Dev Auto-Reload setting (unpacked installs only): Chrome logs every failed WebSocket attempt as an error,
// so it must not keep trying when the watcher isn't being used. After 3 failed attempts in a row it stops,
// until the extension reloads or the setting is switched off and on again.
const DEV_RELOAD_MAX_FAILURES = 3;
let devReloadSocket = null;
let devReloadRetry = null;
let devReloadFailures = 0;

async function connectDevReload() {
  clearTimeout(devReloadRetry);
  let connected = false;
  // Check that tools/dev-reload.js is running before opening the WebSocket: Chrome logs every failed WebSocket
  // connection as an extension error, but not a failed fetch
  devReloadSocket = 'connecting';
  const running = await fetch('http://127.0.0.1:35729/', { signal: AbortSignal.timeout(2000) }).then(r => r.ok, () => false);
  if (!running) {
    devReloadSocket = null;
    devReloadFailures++;
    if (devReloadFailures < DEV_RELOAD_MAX_FAILURES) {
      devReloadRetry = setTimeout(updateDevReload, 30000);
    }
    return;
  }
  devReloadSocket = new WebSocket('ws://127.0.0.1:35729');
  devReloadSocket.onopen = () => {
    connected = true;
    devReloadFailures = 0;
  };
  devReloadSocket.onmessage = event => {
    if (event.data !== 'reload') return;
    chrome.tabs.query({ active: true, lastFocusedWindow: true }, tabs => {
      chrome.storage.local.set({ devReloadTabId: tabs[0]?.id || null }, () => chrome.runtime.reload());
    });
  };
  devReloadSocket.onclose = () => {
    devReloadSocket = null;
    devReloadFailures = connected ? 0 : devReloadFailures + 1;
    if (devReloadFailures < DEV_RELOAD_MAX_FAILURES) {
      devReloadRetry = setTimeout(updateDevReload, 30000); // retry only while still enabled
    }
  };
}

function updateDevReload() {
  chrome.management.getSelf(self => {
    chrome.storage.local.get('devAutoReload', ({ devAutoReload }) => {
      const enabled = self.installType === 'development' && devAutoReload === true;
      if (enabled && !devReloadSocket) {
        connectDevReload();
      } else if (!enabled) {
        clearTimeout(devReloadRetry);
        devReloadSocket?.close?.(); // (not while still checking: that sets it to "connecting")
      }
    });
  });
}
updateDevReload();
chrome.storage.onChanged.addListener(changes => {
  if (changes.devAutoReload) {
    devReloadFailures = 0;
    updateDevReload();
  }
});

// The user's own ComfyUI (Processing: My ComfyUI)
async function comfyAddress() {
  const { comfyServerAddress } = await chrome.storage.local.get('comfyServerAddress');
  return comfyServerAddress || 'http://127.0.0.1:8188';
}

// Requests to ComfyUI from pages and the popup (object_info lookups); images are processed by jobs (runJob)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Only handle ComfyUI requests here; returning true for other messages would promise a response that never
  // comes ("message channel closed before a response was received")
  if (request.action !== 'comfyRequest') {
    return false;
  }
  comfyAddress().then(address => handleComfyRequest({ ...request, url: address + request.url }, sendResponse));
  return true; // answered asynchronously
});

// Requests to the img2img server (hosted processing). apiRequest is any API call, answered { success, status, data },
// with success false only when the server couldn't be reached. The account's API key (popup Settings) is added here,
// so content scripts, which run in web pages, never handle it.
// The address is fixed (the API runs on the VPS). Unpacked (development) installs can switch to a local server
// (npm start in server/) in the popup's Settings: devServer 'local', with its own key, img2imgLocalApiKey.
const IMG2IMG_SERVER = 'https://api.img2img.live';
const LOCAL_IMG2IMG_SERVER = 'http://127.0.0.1:8787';
const isDevelopmentInstall = new Promise(resolve => chrome.management.getSelf(self => resolve(self.installType === 'development')));

async function img2imgServer() {
  const { devServer, img2imgApiKey, img2imgLocalApiKey } = await chrome.storage.local.get(['devServer', 'img2imgApiKey', 'img2imgLocalApiKey']);
  return devServer === 'local' && await isDevelopmentInstall
    ? { address: LOCAL_IMG2IMG_SERVER, apiKey: img2imgLocalApiKey }
    : { address: IMG2IMG_SERVER, apiKey: img2imgApiKey };
}

// Addresses older versions let users set, no longer used
chrome.storage.local.remove(['swappixServerAddress', 'img2imgServerAddress']);

async function apiFetch(path, { method = 'GET', headers, body } = {}) {
  const { address, apiKey } = await img2imgServer();
  const response = await fetch(address + path, { method, headers: { ...headers, ...(apiKey && { Authorization: `Bearer ${apiKey}` }) }, body });
  return { status: response.status, data: await response.json().catch(() => ({})) };
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'apiRequest') {
    return false;
  }
  apiFetch(request.url, request)
    .then(response => sendResponse({ success: true, ...response }), error => sendResponse({ success: false, error: error.message }));
  return true; // answered asynchronously
});

// Image jobs. A page builds the job (the ComfyUI graph, or the hosted job's request) and hands it over on a port; from
// then on it runs here: submitted, polled, NSFW-checked, cached, and the result sent back. The port closes when the
// page goes away (navigation, reload, closed tab). Its jobs on the user's ComfyUI are then cancelled, unless results
// open in new tabs: then they finish and open there. (Hosted jobs can't be cancelled, so they finish and are cached.)
const JOB_PORT = 'img2img-jobs';
const COMFY_POLL_INTERVAL_MS = 100; // a quick job takes ~1-2s, so a long interval adds noticeable wait; /history is cheap
const COMFY_TIMEOUT_MS = 5 * 60 * 1000;
const SERVER_POLL_INTERVAL_MS = 150;
const SERVER_TIMEOUT_MS = 6 * 60 * 1000;

// The extension icon's badge shows how many images are being processed, across all tabs
let jobsRunning = 0;
chrome.action.setBadgeBackgroundColor({ color: '#4CAF50' });
chrome.action.setBadgeTextColor?.({ color: '#ffffff' });
chrome.action.setBadgeText({ text: '' });

function countJob(change) {
  jobsRunning = Math.max(0, jobsRunning + change);
  chrome.action.setBadgeText({ text: jobsRunning ? String(jobsRunning) : '' });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== JOB_PORT) return;
  const jobs = new Set();
  port.onMessage.addListener(({ id, job }) => {
    job.sourceTab = port.sender?.tab;
    job.pageOpen = true;
    job.onProgress = progress => {
      if (job.pageOpen) {
        port.postMessage({ id, progress });
      }
    };
    jobs.add(job);
    countJob(1);
    runJob(job).then(data => ({ id, data }), error => ({ id, error: error.message })).then(reply => {
      jobs.delete(job);
      countJob(-1);
      if (job.pageOpen) {
        port.postMessage(reply);
      }
    });
  });
  port.onDisconnect.addListener(async () => {
    // Read so Chrome doesn't log it as unchecked: why the port closed (e.g. the page went into the back/forward
    // cache), which is handled like any other way of leaving the page
    void chrome.runtime.lastError;
    for (const job of jobs) {
      job.pageOpen = false;
    }
    const { openResultsInNewTab } = await chrome.storage.local.get('openResultsInNewTab');
    if (!openResultsInNewTab) {
      jobs.forEach(job => cancelComfyJob(job).catch(error => console.debug('Cancelling a ComfyUI job failed:', error)));
    }
  });
});

// Wait between polls. The extension API call resets the service worker's idle timer, so a job whose page is gone
// keeps the worker running (fetches don't)
async function pollWait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
  await chrome.runtime.getPlatformInfo();
}

async function runJob(job) {
  const data = job.kind === 'server' ? await runServerJob(job) : await runComfyJob(job);
  // On a direct .jpg/.png URL the result already is the whole page, so it opens in a tab only once that page is gone
  const { openResultsInNewTab } = await chrome.storage.local.get('openResultsInNewTab');
  if (openResultsInNewTab && !(job.pageOpen && job.isImagePage)) {
    openResultTab(job, job.sourceTab);
  }
  return data;
}

async function runServerJob(job) {
  const submitted = await apiFetch('/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.body) });
  if (submitted.status !== 202) {
    throw new Error(submitted.data.error || `The img2img server returned HTTP ${submitted.status}`);
  }
  const startTime = Date.now();
  while (Date.now() - startTime < SERVER_TIMEOUT_MS) {
    const { status, data } = await apiFetch(`/v1/jobs/${encodeURIComponent(submitted.data.jobId)}`);
    if (status !== 200) {
      throw new Error(data.error || `The img2img server returned HTTP ${status}`);
    }
    if (data.status === 'done') {
      await addToCache(job.hash, data.result, job.imageUrl, job.name).catch(error => console.error('Caching the result failed:', error));
      return data.result;
    }
    if (data.status === 'error') {
      throw new Error(data.error || 'The job failed');
    }
    await pollWait(SERVER_POLL_INTERVAL_MS);
  }
  throw new Error(`The img2img server did not finish within ${SERVER_TIMEOUT_MS / 60000} minutes`);
}

async function comfyJson(path, options) {
  const response = await fetch(await comfyAddress() + path, options);
  return response.json();
}

// Progress of the jobs on the user's ComfyUI, from its websocket. ComfyUI sends a prompt's progress messages to the
// client that submitted it (client_id), so the jobs are submitted with this worker's id. The socket is opened while
// ComfyUI jobs run; without it (an older ComfyUI, or it can't connect) jobs run as before, with no progress shown.
const comfyClientId = crypto.randomUUID();
const COMFY_SOCKET_OPEN_TIMEOUT_MS = 1500;
let comfySocket = null; // { socket, address, ready }
const progressJobs = new Map(); // prompt id → job
const earlyProgressMessages = new Map(); // prompt id → messages that came before the job had its prompt id

async function openComfySocket() {
  const address = await comfyAddress();
  if (comfySocket?.address !== address) {
    comfySocket?.socket.close();
    const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws?clientId=${comfyClientId}`);
    const ready = new Promise(resolve => {
      socket.addEventListener('open', resolve);
      socket.addEventListener('error', resolve);
      setTimeout(resolve, COMFY_SOCKET_OPEN_TIMEOUT_MS);
    });
    socket.addEventListener('message', event => {
      if (typeof event.data === 'string') { // (binary messages are previews of the image being made)
        handleComfyMessage(JSON.parse(event.data));
      }
    });
    socket.addEventListener('close', () => {
      if (comfySocket?.socket === socket) {
        comfySocket = null;
      }
    });
    comfySocket = { socket, address, ready };
  }
  await comfySocket.ready;
}

function closeComfySocketWhenIdle() {
  if (progressJobs.size === 0 && jobsRunning === 0) {
    comfySocket?.socket.close();
    comfySocket = null;
    earlyProgressMessages.clear();
  }
}

function trackComfyProgress(job) {
  // How much of the job each node is: a sampler counts its steps, every other node 1
  job.nodeWeights = new Map(Object.entries(job.workflow).map(([id, node]) => {
    const steps = Number(node.inputs?.steps);
    return [id, Number.isFinite(steps) && steps > 1 ? steps : 1];
  }));
  job.nodesDone = new Set();
  job.nodeFraction = new Map();
  job.progress = 0;
  progressJobs.set(job.promptId, job);
  earlyProgressMessages.get(job.promptId)?.forEach(message => handleComfyMessage(message));
  earlyProgressMessages.delete(job.promptId);
}

function handleComfyMessage({ type, data }) {
  const promptId = data?.prompt_id;
  if (!promptId) return;
  const job = progressJobs.get(promptId);
  if (!job) {
    if (earlyProgressMessages.size < 20 && (earlyProgressMessages.get(promptId)?.length || 0) < 500 && !['execution_success', 'execution_error', 'execution_interrupted'].includes(type)) {
      earlyProgressMessages.set(promptId, [...(earlyProgressMessages.get(promptId) || []), { type, data }]);
    }
    return;
  }
  if (type === 'execution_cached') {
    // Nodes ComfyUI still has from earlier runs don't run again: they're left out
    data.nodes?.forEach(id => job.nodeWeights.delete(String(id)));
  } else if (type === 'executing' && data.node != null) {
    // A node starts, so the one before it is done
    job.nodeFraction.forEach((_, id) => job.nodesDone.add(id));
    job.nodeFraction.clear();
    job.nodeFraction.set(String(data.node), 0);
  } else if (type === 'executed') {
    job.nodesDone.add(String(data.node));
  } else if (type === 'progress' && data.max > 0) {
    job.nodeFraction.set(String(data.node), Math.min(1, data.value / data.max));
  } else {
    return;
  }
  let total = 0;
  let done = 0;
  job.nodeWeights.forEach((weight, id) => {
    total += weight;
    done += job.nodesDone.has(id) ? weight : weight * (job.nodeFraction.get(id) || 0);
  });
  // A percentage that only goes up, and reaches 100 only when the result is in
  const progress = total ? Math.min(99, Math.floor(done / total * 100)) : 0;
  if (progress > job.progress) {
    job.progress = progress;
    job.onProgress?.(progress);
  }
}

async function runComfyJob(job) {
  await openComfySocket();
  try {
    return await runComfyPrompt(job);
  } finally {
    progressJobs.delete(job.promptId);
    earlyProgressMessages.delete(job.promptId);
    setTimeout(closeComfySocketWhenIdle, 1000);
  }
}

async function runComfyPrompt(job) {
  const submitted = await comfyJson('/prompt', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: job.workflow, client_id: comfyClientId }) });
  // ComfyUI accepts a prompt even when some outputs fail validation; those outputs are silently dropped
  const nodeErrors = Object.values(submitted.node_errors || {});
  if (nodeErrors.length > 0) {
    const firstError = nodeErrors[0].errors?.[0];
    const reason = [firstError?.message, firstError?.details].filter(Boolean).join(': ') || 'invalid input';
    throw new Error(`${nodeErrors[0].class_type} rejected the workflow (${reason})`);
  }
  if (submitted.error) {
    throw new Error(submitted.error.message || 'ComfyUI rejected the workflow');
  }
  job.promptId = submitted.prompt_id;
  trackComfyProgress(job);
  if (job.cancelled) {
    await removeFromComfy(job); // the page went away while it was being submitted
  }

  const startTime = Date.now();
  while (Date.now() - startTime < COMFY_TIMEOUT_MS) {
    if (job.cancelled) {
      throw new Error('Cancelled: the page was left');
    }
    const history = (await comfyJson(`/history/${job.promptId}`))[job.promptId];
    if (history?.status?.status_str === 'error') {
      throw new Error(formatComfyError(history));
    }
    if (history?.status?.completed) {
      // Every NSFW check probe first: a flagged image stops here, before the result is downloaded or cached
      for (const probe of job.probes) {
        const image = history.outputs?.[probe.node]?.images?.[0];
        const flagged = image ? await isProbeFlagged(`/api/view?${new URLSearchParams(image)}`).catch(error => error) : new Error('no check image');
        if (flagged instanceof Error) {
          throw new Error(`Couldn't check the ${probe.label} for adult content, so nothing is shown (${flagged.message})`);
        }
        if (flagged) {
          throw new Error(probe.refusal);
        }
      }
      // Only the result node's image (resultNode in shared/workflows.js): other nodes can save previews of their own
      const outputImage = job.output ? history.outputs?.[job.output]?.images?.[0] : null;
      if (!outputImage) {
        throw new Error('ComfyUI finished without producing an image');
      }
      const data = await fetchComfyResult(`/api/view?${new URLSearchParams(outputImage)}`);
      addToCache(job.hash, data, job.imageUrl, job.name).catch(error => console.error('Caching the result failed:', error));
      return data;
    }
    await pollWait(COMFY_POLL_INTERVAL_MS);
  }
  throw new Error(`ComfyUI did not finish within ${COMFY_TIMEOUT_MS / 60000} minutes`);
}

// Cancel a job on the user's ComfyUI. One still being submitted is removed as soon as runComfyJob has its prompt id.
async function cancelComfyJob(job) {
  if (job.kind === 'server' || job.cancelled) return;
  job.cancelled = true;
  if (job.promptId) {
    await removeFromComfy(job);
  }
}

// Take a prompt off ComfyUI: out of the queue if it's waiting, interrupted if it's the one running
async function removeFromComfy(job) {
  const post = (path, body) => fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const address = await comfyAddress();
  const queue = await comfyJson('/queue');
  // Queue items are [number, prompt_id, prompt, extra_data, outputs]. (ComfyUI versions that ignore /interrupt's
  // prompt_id interrupt whatever is running, so it's checked here that it's this one.)
  if (queue.queue_running?.some(item => item[1] === job.promptId)) {
    await post(`${address}/interrupt`, { prompt_id: job.promptId });
  } else {
    await post(`${address}/queue`, { delete: [job.promptId] });
  }
}

// Turn a ComfyUI execution_error message into readable text
function formatComfyError(history) {
  const errorMessage = (history.status?.messages || []).find(m => m[0] === 'execution_error');
  if (!errorMessage) {
    return 'ComfyUI reported an error while running the workflow';
  }
  const details = errorMessage[1];
  return `${details.node_type || 'Node'} ${details.node_id || ''} failed: ${details.exception_message || 'unknown error'}`.trim();
}

// Message a tab's content script. Tabs without one (chrome:// and extension pages, or pages loaded before
// the extension was reloaded) reject with "Receiving end does not exist", which is expected, so it's ignored.
function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {});
}

// Handle page navigation and auto-processing
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.status === 'loading') {
    // Clear processing state when page starts loading
    chrome.storage.local.set({ isProcessing: false }, function() {
      if (chrome.runtime.lastError) {
        console.error('Error clearing processing state:', chrome.runtime.lastError);
      }
    });
  } else if (changeInfo.status === 'complete') {
    // (No stopSelection here: a loaded page's new content script starts without Manual Selection, and sites like
    // Instagram also report 'complete' for in-page URL changes such as carousel slides, which should keep it on.)
    chrome.storage.local.get(['autoProcess', 'autoRemember', 'selectedFaceId'], async function(result) {
      const faceId = result.selectedFaceId
      if (result.autoRemember) {
        sendToTab(tabId, { action: 'autoRemember', faceId: faceId });
      }
      if (result.autoProcess) {
        sendToTab(tabId, { action: 'selectAllVisible', faceId: faceId });
      }
    });
  }
});

async function handleComfyRequest(request, sendResponse) {
  try {
    const response = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      body: request.body
    });
    
    const data = await response.json();
    sendResponse({ success: true, data: data });
  } catch (error) {
    console.debug('ComfyUI request failed:', error); // reported to the user by the page
    sendResponse({ success: false, error: error.message });
  }
}

// An NSFW check probe (addSafetyCheck in shared/workflows.js): flagged unless every pixel is black
async function isProbeFlagged(path) {
  const response = await fetch(await comfyAddress() + path);
  if (!response.ok) {
    throw new Error(`ComfyUI returned HTTP ${response.status} for the NSFW check`);
  }
  const bitmap = await createImageBitmap(await response.blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.drawImage(bitmap, 0, 0);
  const { data } = context.getImageData(0, 0, bitmap.width, bitmap.height);
  for (let i = 0; i < data.length; i += 4) {
    if (data[i] > 0 || data[i + 1] > 0 || data[i + 2] > 0) return true;
  }
  return false;
}

// ComfyUI writes the graph it ran into every PNG it saves (unless it was started with --disable-metadata). For My
// ComfyUI that graph holds the page image and every source image as base64, and all the settings, so a result
// shared or downloaded as PNG would carry them. Results keep only the chunks that draw the image.
const PNG_TEXT_CHUNKS = ['tEXt', 'iTXt', 'zTXt'];
function withoutPngText(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < 8 || view.getUint32(0) !== 0x89504e47) {
    return bytes; // not a PNG
  }
  const kept = [bytes.subarray(0, 8)];
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + 12 + view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (!PNG_TEXT_CHUNKS.includes(type)) {
      kept.push(bytes.subarray(offset, end));
    }
    offset = end;
    if (type === 'IEND') break;
  }
  const out = new Uint8Array(kept.reduce((total, part) => total + part.length, 0));
  kept.reduce((at, part) => (out.set(part, at), at + part.length), 0);
  return out;
}

// The result image as a data URL
async function fetchComfyResult(path) {
  const response = await fetch(await comfyAddress() + path);
  if (!response.ok) {
    throw new Error(`ComfyUI returned HTTP ${response.status} for the processed image`);
  }
  const type = response.headers.get('content-type') || 'image/png';
  const blob = new Blob([withoutPngText(new Uint8Array(await response.arrayBuffer()))], { type });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// IndexedDB setup
const dbName = 'FaceSwapDB';
const dbVersion = 1;
const storeName = 'faces';
let db;

// Initialize IndexedDB
const initDB = new Promise((resolve, reject) => {
  const request = indexedDB.open(dbName, dbVersion);
  
  request.onerror = () => {
    console.error('Error opening face database:', request.error);
    reject(request.error);
  };
  
  request.onsuccess = () => {
    console.log('Face database opened successfully');
    db = request.result;
    resolve();
  };
  
  request.onupgradeneeded = (event) => {
    console.log('Upgrading face database');
    const db = event.target.result;
    if (!db.objectStoreNames.contains(storeName)) {
      const store = db.createObjectStore(storeName, { keyPath: 'id' });
      console.log('Created faces store');
    }
  };
});

// Cache setup
const CACHE_DB_NAME = 'imageSwapCache';
const CACHE_STORE_NAME = 'images';
const CACHE_DB_VERSION = 4;
// How many results the cache keeps: the popup's Cache Size setting (cacheSize), one of these
const CACHE_SIZES = [25, 50, 100, 200, 500];
const DEFAULT_CACHE_SIZE = 50;
let cacheDB;

// Initialize Cache DB
const initCacheDB = new Promise((resolve, reject) => {
  const request = indexedDB.open(CACHE_DB_NAME, CACHE_DB_VERSION);
  
  request.onerror = () => {
    console.error('Error opening cache database:', request.error);
    reject(request.error);
  };
  
  request.onsuccess = () => {
    console.log('Cache database opened successfully');
    cacheDB = request.result;
    
    // Add error handling for database connection
    cacheDB.onerror = (event) => {
      console.error('Database error:', event.target.error);
    };
    
    // Handle database close
    cacheDB.onclose = () => {
      console.log('Cache database closed');
      cacheDB = null;
    };
    
    resolve();
  };
  
  request.onupgradeneeded = (event) => {
    console.log('Upgrading cache database');
    const db = event.target.result;
    const store = db.objectStoreNames.contains(CACHE_STORE_NAME)
      ? event.target.transaction.objectStore(CACHE_STORE_NAME)
      : db.createObjectStore(CACHE_STORE_NAME, { keyPath: 'hash' });
    if (!store.indexNames.contains('timestamp')) {
      store.createIndex('timestamp', 'timestamp', { unique: false });
      console.log('Added timestamp index to cache store');
    }
    // Lets Swap Cache look results up by page image URL without loading every cached image
    if (!store.indexNames.contains('imageUrl')) {
      store.createIndex('imageUrl', 'imageUrl', { unique: false });
      console.log('Added imageUrl index to cache store');
    }
    // Version 4 leaves signed URLs' changing parameters out of the image URL key (see cacheImageUrl)
    if (event.oldVersion > 0 && event.oldVersion < 4) {
      store.openCursor().onsuccess = cursorEvent => {
        const cursor = cursorEvent.target.result;
        if (!cursor) return;
        const key = cacheImageUrl(cursor.value.imageUrl);
        if (key !== cursor.value.imageUrl) {
          cursor.update({ ...cursor.value, imageUrl: key });
        }
        cursor.continue();
      };
    }
  };
});

// The cache's key for a page image: its URL without the #fragment. Result tabs for direct image URLs are the
// image URL plus "#img2img-result=...", and Chrome's image page uses that whole URL as the <img> src, so an
// image re-processed there would otherwise be stored apart from its earlier results and not replace them.
// Signed URLs get a new signature and expiry on every page load, so those parameters are left out too, and
// Instagram's and Facebook's CDNs (which also sign every parameter and vary the edge host) are keyed by the
// path alone, which names the file.
const META_IMAGE_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
// Signed-URL parameters of S3, CloudFront and Google Cloud Storage
const SIGNATURE_PARAMS = /^(x-amz-.+|x-goog-.+|expires|signature|key-pair-id|policy)$/i;

function cacheImageUrl(imageUrl) {
  if (!imageUrl) {
    return imageUrl;
  }
  let url;
  try {
    url = new URL(imageUrl);
  } catch (error) {
    return imageUrl.split('#')[0];
  }
  if (!/^https?:$/.test(url.protocol)) {
    return imageUrl.split('#')[0];
  }
  url.hash = '';
  if (META_IMAGE_HOSTS.test(url.hostname)) {
    return `meta-cdn:${url.pathname}`;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SIGNATURE_PARAMS.test(name)) {
      url.searchParams.delete(name);
    }
  }
  return url.href;
}

// Get from cache. With no hash, only the loose lookup by image URL runs (used by Swap Cache,
// which skips downloading and hashing the page image)
async function getFromCache(hash, imageUrl, allowLooseCacheLink = false) {
  imageUrl = cacheImageUrl(imageUrl);
  try {
    if (!cacheDB) {
      await initCacheDB;
    }
    return new Promise((resolve, reject) => {
      const transaction = cacheDB.transaction(CACHE_STORE_NAME, 'readonly');
      const store = transaction.objectStore(CACHE_STORE_NAME);

      const looseLookup = () => {
        if (!imageUrl || !allowLooseCacheLink) {
          resolve(null);
          return;
        }
        const urlRequest = store.index('imageUrl').getAll(imageUrl);
        urlRequest.onerror = () => reject(urlRequest.error);
        urlRequest.onsuccess = () => {
          // Each image keeps only its latest result (see addToCache); newest first in case of older data
          const entries = urlRequest.result.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          resolve(entries[0]?.processedImage || null);
        };
      };

      if (!hash) {
        looseLookup();
        return;
      }
      // First try exact hash match
      const request = store.get(hash);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        if (request.result?.processedImage) {
          resolve(request.result.processedImage);
        } else {
          looseLookup();
        }
      };
    });
  } catch (error) {
    console.error('Error in getFromCache:', error);
    throw error;
  }
}

// Add to cache. Each page image keeps only its latest result: re-processing an image deletes its older
// results, so neither Swap Cache nor an exact-hash lookup can bring an old one back after a refresh. name is the
// result's download base name (the cache page shows it; entries from before it was kept have none).
async function addToCache(hash, processedImage, imageUrl, name) {
  imageUrl = cacheImageUrl(imageUrl);
  try {
    if (!cacheDB) {
      await initCacheDB;
    }
    const limit = await cacheSize();
    return new Promise((resolve, reject) => {
      const transaction = cacheDB.transaction(CACHE_STORE_NAME, 'readwrite');
      const store = transaction.objectStore(CACHE_STORE_NAME);
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      // The new entry is the newest, so dropping the oldest beyond the limit never drops it
      const addEntry = () => {
        store.put({ hash, processedImage, imageUrl, name, timestamp: Date.now() });
        deleteOldest(store, limit);
      };

      // Remove the entry being replaced first so it doesn't count towards the limit
      store.delete(hash);
      if (!imageUrl) {
        addEntry();
        return;
      }
      const olderRequest = store.index('imageUrl').getAllKeys(imageUrl);
      olderRequest.onsuccess = () => {
        olderRequest.result.forEach(key => store.delete(key));
        addEntry();
      };
    });
  } catch (error) {
    console.error('Error in addToCache:', error);
    throw error;
  }
}

async function cacheSize() {
  const { cacheSize: size } = await chrome.storage.local.get('cacheSize');
  return CACHE_SIZES.includes(size) ? size : DEFAULT_CACHE_SIZE;
}

// Delete a cache store's oldest entries until `keep` are left (by key, without loading their images); calls done
// with how many it deleted
function deleteOldest(store, keep, done = () => {}) {
  const countRequest = store.count();
  countRequest.onsuccess = () => {
    const excess = countRequest.result - keep;
    if (excess <= 0) {
      done(0);
      return;
    }
    let deleted = 0;
    store.index('timestamp').openKeyCursor().onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor || deleted >= excess) {
        done(deleted);
        return;
      }
      store.delete(cursor.primaryKey);
      deleted++;
      cursor.continue();
    };
  };
}

// After Cache Size is lowered: drop the oldest results beyond it; resolves with how many were dropped
async function trimCache() {
  if (!cacheDB) {
    await initCacheDB;
  }
  const limit = await cacheSize();
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction(CACHE_STORE_NAME, 'readwrite');
    let deleted = 0;
    deleteOldest(transaction.objectStore(CACHE_STORE_NAME), limit, count => { deleted = count; });
    transaction.oncomplete = () => resolve(deleted);
    transaction.onerror = () => reject(transaction.error);
  });
}

// The cached results without their images (but with their thumbnails, once the cache page has made them), newest
// first, for the cache page (cache.html), which loads each image by its hash as it's shown
async function listCache() {
  if (!cacheDB) {
    await initCacheDB;
  }
  return new Promise((resolve, reject) => {
    const entries = [];
    const request = cacheDB.transaction(CACHE_STORE_NAME, 'readonly').objectStore(CACHE_STORE_NAME).index('timestamp').openCursor(null, 'prev');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(entries);
        return;
      }
      const { hash, imageUrl, name, timestamp, thumbnail } = cursor.value;
      entries.push({ hash, imageUrl, name, timestamp, thumbnail });
      cursor.continue();
    };
  });
}

// A small copy of a cached result for the cache page's thumbnail strip, made there the first time it's needed
async function setCacheThumbnail(hash, thumbnail) {
  if (!cacheDB) {
    await initCacheDB;
  }
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction(CACHE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(CACHE_STORE_NAME);
    const request = store.get(hash);
    request.onsuccess = () => {
      if (request.result) store.put({ ...request.result, thumbnail });
    };
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Delete one cached result (from the cache page)
async function deleteFromCache(hash) {
  if (!cacheDB) {
    await initCacheDB;
  }
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction(CACHE_STORE_NAME, 'readwrite');
    transaction.objectStore(CACHE_STORE_NAME).delete(hash);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
}

// Delete every cached result; resolves with how many there were
async function clearCache() {
  if (!cacheDB) {
    await initCacheDB;
  }
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction(CACHE_STORE_NAME, 'readwrite');
    const store = transaction.objectStore(CACHE_STORE_NAME);
    const countRequest = store.count();
    countRequest.onsuccess = () => store.clear();
    transaction.oncomplete = () => resolve(countRequest.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

// Handle messages from popup and content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveFace') {
    saveFace(request.face)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'getFace') {
    getFace(request.faceId)
      .then(face => sendResponse({ success: true, face }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'getAllFaces') {
    getAllFaces()
      .then(faces => sendResponse({ success: true, faces }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'deleteFace') {
    deleteFace(request.faceId)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'fetchImage') {
    // Page images the content script can't read (cross-origin without CORS): the extension has host
    // permission for all sites, so its fetch isn't subject to the page's CORS rules
    fetch(request.url, { credentials: 'include' })
      .then(response => {
        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }
        return response.blob();
      })
      .then(blob => new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(reader.result);
        reader.onerror = () => reject(reader.error);
        reader.readAsDataURL(blob);
      }))
      .then(dataUrl => sendResponse({ success: true, dataUrl }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'downloadImage') {
    downloadableImage(request).then(({ url, filename }) => {
      // A name Chrome still refuses gets a plain one, rather than no download at all
      const download = (name, retry) => {
        if (chrome.downloads.onDeterminingFilename) pendingDownloadNames.set(url, name);
        chrome.downloads.download({ url, filename: name }, downloadId => {
          if (chrome.runtime.lastError) pendingDownloadNames.delete(url);
          if (!chrome.runtime.lastError && url.startsWith('blob:')) blobDownloads.set(downloadId, url);
          // (Chrome says "Invalid filename", Firefox "filename must not contain illegal characters")
          if (/filename/i.test(chrome.runtime.lastError?.message) && retry) {
            download(`img2img.${name.split('.').pop()}`, false);
          } else if (chrome.runtime.lastError || downloadId === undefined) {
            sendResponse({ success: false, error: chrome.runtime.lastError?.message || 'Download was blocked' });
          } else {
            // Keyed by the result itself, not the JPG copy, so the page can match it
            markResultDownloaded(resultKey(request.dataUrl));
            sendResponse({ success: true, downloadId });
          }
        });
      };
      download(filename, true);
    }).catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'openCompareTab') {
    const id = crypto.randomUUID();
    compareImages.set(id, { original: request.original, result: request.result });
    // Only the latest few stay in memory (they're full images)
    while (compareImages.size > MAX_COMPARE_IMAGES) {
      compareImages.delete(compareImages.keys().next().value);
    }
    const url = chrome.runtime.getURL(`compare.html?${new URLSearchParams({ id, name: request.name || 'image' })}`);
    const nextTo = sender.tab && !sender.tab.incognito ? { index: sender.tab.index + 1, openerTabId: sender.tab.id, windowId: sender.tab.windowId } : {};
    chrome.tabs.create({ url, ...nextTo })
      .then(() => sendResponse({ success: true }), error => sendResponse({ success: false, error: error.message }));
    return true; // answered asynchronously
  }

  if (request.action === 'getCompareImages') {
    const images = compareImages.get(request.id);
    sendResponse(images ? { success: true, ...images } : { success: false });
    return false;
  }

  if (request.action === 'openResultTab') {
    openResultTab(request, sender.tab);
    sendResponse({ success: true });
    return false;
  }

  if (request.action === 'getFromCache') {
    getFromCache(request.hash, request.imageUrl, request.allowLooseCacheLink)
      .then(result => sendResponse({ success: true, result }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'listCache') {
    listCache()
      .then(entries => sendResponse({ success: true, entries }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'setCacheThumbnail') {
    setCacheThumbnail(request.hash, request.thumbnail)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'deleteFromCache') {
    deleteFromCache(request.hash)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'trimCache') {
    trimCache()
      .then(count => sendResponse({ success: true, count }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'clearCache') {
    clearCache()
      .then(count => sendResponse({ success: true, count }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
});

// Names for our own downloads, by URL, handed to Chrome again when it determines the filename. Another
// extension listening to onDeterminingFilename (e.g. FetchV) makes Chrome drop the filename given to
// chrome.downloads.download, saving "download.jpg"; a suggestion from our own listener still wins.
// (Firefox has no onDeterminingFilename and keeps the given filename.)
const pendingDownloadNames = new Map();

chrome.downloads.onDeterminingFilename?.addListener((item, suggest) => {
  const filename = item.byExtensionId === chrome.runtime.id && pendingDownloadNames.get(item.url);
  pendingDownloadNames.delete(item.url);
  if (filename) {
    suggest({ filename, conflictAction: 'uniquify' });
  } else {
    suggest();
  }
});

// Blob URLs handed to downloads (Firefox), by download id, released once the download has finished
const blobDownloads = new Map();

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (blobDownloads.has(id) && state && state.current !== 'in_progress') {
    URL.revokeObjectURL(blobDownloads.get(id));
    blobDownloads.delete(id);
  }
});

// The image pairs for compare.html tabs, by id. Kept in memory only: after the service worker restarts, a
// reloaded compare tab asks for the comparison to be opened again.
const compareImages = new Map();
const MAX_COMPARE_IMAGES = 5;

// Downloaded results are remembered (by a fingerprint of the image data) so their download buttons stay
// greyed out, on every page and in later sessions. Same function in content.js and viewer.js.
const MAX_DOWNLOADED_RESULTS = 1000;

function resultKey(dataUrl) {
  let hash = 5381;
  for (let i = 0; i < dataUrl.length; i++) {
    hash = ((hash << 5) + hash + dataUrl.charCodeAt(i)) | 0;
  }
  return `${dataUrl.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

// Whether a data URL is a PNG with an alpha channel (colour type 4 or 6 in its IHDR header), e.g. a
// background-removal result
function isPngWithAlpha(dataUrl) {
  if (!dataUrl.startsWith('data:image/png;base64,')) return false;
  const header = atob(dataUrl.slice(22, 22 + 44));
  return [4, 6].includes(header.charCodeAt(25));
}

// "Download as JPG" setting (on unless turned off): re-encode the result as a JPG to save space.
// PNGs with transparency stay PNG, since JPG would lose it.
// A download name Chrome accepts: no characters Windows or Chrome reject (slashes, colons, quotes, control
// and right-to-left marks), no leading dots or spaces
function safeFilename(filename) {
  const cleaned = String(filename || '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f‎‏‪-‮⁦-⁩]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return cleaned || 'img2img.png';
}

async function downloadableImage({ dataUrl, filename }) {
  filename = safeFilename(filename);
  const { downloadAsJpg } = await chrome.storage.local.get('downloadAsJpg');
  // (WebP results are transparent ones the server re-encoded to fit: keep them as they are)
  if (downloadAsJpg === false || /^data:image\/(jpeg|webp)/.test(dataUrl) || isPngWithAlpha(dataUrl)) {
    return { url: await downloadUrl(dataUrl), filename };
  }
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0);
  bitmap.close();
  const jpg = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
  return { url: await downloadUrl(jpg), filename: filename.replace(/\.[^.]*$/, '') + '.jpg' };
}

// A URL chrome.downloads accepts for an image (a data URL or a Blob). Chrome's service worker has no
// URL.createObjectURL, so it gets a data URL; Firefox's background page has it, and its downloads refuse data URLs.
async function downloadUrl(image) {
  if (typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(typeof image === 'string' ? await (await fetch(image)).blob() : image);
  }
  if (typeof image === 'string') return image;
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(image);
  });
}

function markResultDownloaded(key) {
  chrome.storage.local.get('downloadedResults', ({ downloadedResults = [] }) => {
    if (downloadedResults.includes(key)) return;
    chrome.storage.local.set({ downloadedResults: [...downloadedResults, key].slice(-MAX_DOWNLOADED_RESULTS) });
  });
}

// Open a converted image in a background tab next to the page it came from.
// Chrome rejects an opener tab that's in a different window from the new tab. That happens when the
// page is in a popup or app window (Chrome moves new tabs to a normal window), so only normal windows
// get the opener/position, and any remaining failure retries as a plain new tab.
// Incognito: extension pages can't open in incognito windows (spanning mode), so instead the original
// image URL opens with a #img2img-result marker and the content script shows the cached result there.
async function openResultTab(request, sourceTab) {
  const canOpenImageUrl = sourceTab?.incognito && /^https?:/i.test(request.imageUrl || '');
  const url = canOpenImageUrl
    ? `${request.imageUrl.split('#')[0]}#img2img-result=${encodeURIComponent(request.hash)}&img2img-name=${encodeURIComponent(request.name)}`
    : chrome.runtime.getURL(`viewer.html?${new URLSearchParams({ hash: request.hash, name: request.name })}`);
  let options = { url, active: false };
  try {
    const sourceWindow = sourceTab && await chrome.windows.get(sourceTab.windowId);
    if (sourceWindow?.type === 'normal') {
      // Go after any result tabs already opened from this page, so results line up left to right in order
      const tabs = await chrome.tabs.query({ windowId: sourceTab.windowId });
      const current = tabs.find(tab => tab.id === sourceTab.id) || sourceTab;
      let index = current.index + 1;
      while (tabs.some(tab => tab.index === index && tab.openerTabId === sourceTab.id)) index++;
      options = { ...options, windowId: sourceTab.windowId, index, openerTabId: sourceTab.id };
    }
    await chrome.tabs.create(options);
  } catch (error) {
    console.warn('Opening result tab next to the page failed, opening a plain tab:', error.message);
    try {
      await chrome.tabs.create({ url, active: false });
    } catch (retryError) {
      console.error('Could not open result tab:', retryError.message);
    }
  }
}

// Save face to IndexedDB
async function saveFace(face) {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      console.log('Saving face to DB:', face.id);
      const request = store.put(face);
      
      request.onsuccess = () => {
        console.log('Face saved successfully:', face.id);
        resolve();
      };
      request.onerror = () => {
        console.error('Error saving face:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error in saveFace:', error);
    throw error;
  }
}

// Get face from IndexedDB
async function getFace(faceId) {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(faceId);
      
      request.onsuccess = () => {
        console.log('Retrieved face from DB:', faceId, request.result);
        resolve(request.result);
      };
      request.onerror = () => {
        console.error('Error retrieving face from DB:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error in getFace:', error);
    throw error;
  }
}

// Get all faces from IndexedDB
async function getAllFaces() {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      
      request.onsuccess = () => {
        console.log('Retrieved all faces from DB:', request.result);
        resolve(request.result);
      };
      request.onerror = () => {
        console.error('Error retrieving all faces:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error in getAllFaces:', error);
    throw error;
  }
}

// Delete face from IndexedDB
async function deleteFace(faceId) {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(faceId);
      
      request.onsuccess = () => {
        console.log('Face deleted successfully:', faceId);
        resolve();
      };
      request.onerror = () => {
        console.error('Error deleting face:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Error in deleteFace:', error);
    throw error;
  }
}