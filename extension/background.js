// Messages answered here, and who sends them (kept by the used-by check, which fails when this is out of date):
//   apiRequest: the Library, the popup
//   clearCache: the cache page, the settings page
//   clearQueue: the popup
//   comfyRequest: web pages, the result tab, the Library, the popup, My workflows
//   deleteFromCache: web pages, the result tab, the Library, the cache page
//   deleteSource: the popup
//   downloadImage: web pages, the result tab, the Library, the cache page
//   downloadOriginal: web pages, the result tab, the cache page
//   downloadPicture: web pages
//   downloadableImage: the Library
//   downloadedFiles: web pages, the result tab, the Library, the cache page
//   fetchImage: web pages, the result tab, the Library
//   getAllSources: the popup
//   getFromCache: web pages, the result tab, the Library, the cache page
//   getOriginalImage: the result tab
//   getSource: web pages, the result tab, the Library, the popup
//   listCache: the Library, the cache page
//   listResults: web pages, the result tab
//   openResultTab: web pages, the result tab
//   pictureUnderPointer: web pages
//   purgeExpired: the settings page
//   queueStatus: the popup
//   refreshAnnouncements: the popup
//   saveSource: the popup
//   setCacheThumbnail: the cache page
//   trimCache: the settings page

// The shared workflow code (names the right-click menu's item after the chosen workflow). Chrome runs this file as
// a service worker, Firefox as an event page, which loads the same scripts from the manifest instead (see
// tools/build-release.mjs) and has no importScripts.
if (typeof importScripts === 'function') {
  importScripts('shared/workflows.js', 'shared/custom-workflows.js');
}

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  console.log('img2img installed');
  scheduleAnnouncements();
  createRunMenu();
  // After a dev auto-reload, refresh the tab that was active so it gets the new content script
  chrome.storage.local.get('devReloadTabId', ({ devReloadTabId }) => {
    if (devReloadTabId) {
      chrome.storage.local.remove('devReloadTabId');
      chrome.tabs.reload(devReloadTabId, () => void chrome.runtime.lastError);
    }
  });
});
chrome.runtime.onStartup.addListener(scheduleAnnouncements);
chrome.runtime.onStartup.addListener(updateRunMenu);

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

// Announcements shown at the top of the popup: a new feature, or something wrong with the service. img2img.shop is
// asked with one GET that carries nothing at all — no account, no settings, not even which version this is — so each
// announcement says which versions and browsers it's meant for (announcementApplies) and the choice is made here.
// It's asked once a day in the background, and again when the popup opens if the last answer is more than a few
// minutes old, so that a notice about today (the service down this evening) is seen while it still matters. When a
// hosted job fails because the server can't be reached, the page's error carries the current warning too
// (outageNotice). The site counts those requests the same cookie-free way it counts page views, once a day per
// visitor however often they come, which is the only way to tell how many people use the extension: everyone
// processing on their own ComfyUI never reaches it otherwise.
// The Announcements setting (on the settings page) turns all of it off, and Firefox's own data-collection consent is respected
// where the browser offers it. Nothing fetched is ever run: the popup draws the text as text (showAnnouncements in
// popup.js), and only ordinary web links are kept.
const ANNOUNCEMENTS_URL = 'https://img2img.shop/announcements.json';
const ANNOUNCEMENTS_ALARM = 'img2img-announcements';
const ANNOUNCEMENTS_EVERY_MINUTES = 24 * 60;
const ANNOUNCEMENTS_AGAIN_AFTER_MS = 20 * 60 * 60 * 1000; // a browser restart shouldn't mean another check
const ANNOUNCEMENTS_FRESH_MS = 15 * 60 * 1000; // what the popup and a failed job settle for
const ANNOUNCEMENTS_AT_MOST = 5;
const ANNOUNCEMENT_LEVELS = ['info', 'warning', 'critical'];

function scheduleAnnouncements() {
  // The first check waits a few minutes, so starting the browser isn't slowed down by it
  chrome.alarms.create(ANNOUNCEMENTS_ALARM, { delayInMinutes: 5, periodInMinutes: ANNOUNCEMENTS_EVERY_MINUTES });
}

chrome.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === ANNOUNCEMENTS_ALARM) checkAnnouncements();
});

chrome.storage.onChanged.addListener(changes => {
  if (!changes.announcementsEnabled) return;
  if (changes.announcementsEnabled.newValue === false) {
    chrome.storage.local.remove(['announcements', 'announcementsCheckedAt']); // nothing of it is left behind
  } else {
    checkAnnouncements();
  }
});

async function announcementsAllowed() {
  const { announcementsEnabled } = await chrome.storage.local.get('announcementsEnabled');
  if (announcementsEnabled === false) {
    return false;
  }
  try {
    // Firefox 140+ asks about technical and interaction data itself: honour that answer where the API exists
    if (await chrome.permissions.contains({ data_collection: ['technicalAndInteraction'] }) === false) {
      return false;
    }
  } catch {
    // Chromium browsers and older Firefox have no data collection permissions: the setting is the only switch
  }
  return true;
}

// The popup asks as it opens: the answer comes into storage, which the popup is watching
chrome.runtime.onMessage.addListener(request => {
  if (request.action === 'refreshAnnouncements') {
    checkAnnouncements(ANNOUNCEMENTS_FRESH_MS);
  }
  return false;
});

// One check at a time: the popup opening as the alarm goes off needs only one answer
let checkingAnnouncements = null;

function checkAnnouncements(againAfterMs = ANNOUNCEMENTS_AGAIN_AFTER_MS) {
  checkingAnnouncements ??= fetchAnnouncements(againAfterMs).finally(() => {
    checkingAnnouncements = null;
  });
  return checkingAnnouncements;
}

async function fetchAnnouncements(againAfterMs) {
  if (!await announcementsAllowed()) {
    return;
  }
  const { announcementsCheckedAt } = await chrome.storage.local.get('announcementsCheckedAt');
  if (announcementsCheckedAt && Date.now() - Date.parse(announcementsCheckedAt) < againAfterMs) {
    return;
  }
  let items;
  try {
    const response = await fetch(ANNOUNCEMENTS_URL, {
      credentials: 'omit', // the extension isn't the site: never send the account's cookies with this
      cache: 'no-store',
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) return;
    items = (await response.json())?.announcements;
  } catch {
    return; // offline, or the site is unreachable: asked again when the popup opens, or tomorrow
  }
  if (!Array.isArray(items)) {
    return;
  }
  const version = chrome.runtime.getManifest().version;
  const browser = browserName();
  const announcements = items
    .filter(item => item && typeof item === 'object' && announcementApplies(item, version, browser))
    .map(readAnnouncement)
    .filter(item => item && !announcementEnded(item))
    .slice(0, ANNOUNCEMENTS_AT_MOST);
  await chrome.storage.local.set({ announcements, announcementsCheckedAt: new Date().toISOString() });
}

// An announcement with an end time ("down from 20:00 to 21:00") goes at that time, without waiting for a check
function announcementEnded(item, now = Date.now()) {
  return Boolean(item.endsAt) && Date.parse(item.endsAt) <= now;
}

// For a hosted job that failed because the server can't be reached: the warning that explains it, if there is one,
// as a line for the page's error. Dismissing it in the popup doesn't keep it out of here: it says why this job failed.
async function outageNotice() {
  // (the error isn't held up long for it: with no answer soon, what's stored will do)
  await Promise.race([checkAnnouncements(ANNOUNCEMENTS_FRESH_MS).catch(() => {}), new Promise(resolve => setTimeout(resolve, 4000))]);
  const { announcements } = await chrome.storage.local.get('announcements');
  const item = (Array.isArray(announcements) ? announcements : [])
    .find(candidate => ['warning', 'critical'].includes(candidate.level) && !announcementEnded(candidate));
  if (!item) {
    return '';
  }

  return [item.title, item.body, item.url].filter(Boolean).join(' ');
}

// Only the fields the popup draws, as plain text within sensible lengths. One without an id or a title is dropped:
// the id is how an announcement the user has dismissed stays dismissed.
function readAnnouncement(item) {
  const text = (value, limit) => (typeof value === 'string' ? value.trim().slice(0, limit) : '');
  const id = text(item.id, 100);
  const title = text(item.title, 120);
  if (!id || !title) {
    return null;
  }
  const url = text(item.url, 500);
  const endsAt = text(item.endsAt, 40);

  return {
    id,
    title,
    level: ANNOUNCEMENT_LEVELS.includes(item.level) ? item.level : 'info',
    body: text(item.body, 300),
    url: /^https:\/\//i.test(url) ? url : '', // an ordinary web link or none: never javascript: or data:
    link: text(item.link, 60),
    endsAt: Number.isNaN(Date.parse(endsAt)) ? '' : new Date(endsAt).toISOString()
  };
}

function announcementApplies(item, version, browser) {
  if (typeof item.minVersion === 'string' && compareVersions(version, item.minVersion) < 0) {
    return false;
  }
  if (typeof item.maxVersion === 'string' && compareVersions(version, item.maxVersion) > 0) {
    return false;
  }

  return !Array.isArray(item.browsers) || item.browsers.length === 0 || item.browsers.includes(browser);
}

// Versions as the stores write them, so that 1.0.10 is newer than 1.0.9 (-1 when a is older, 1 when newer, 0 equal)
function compareVersions(a, b) {
  const numbers = value => String(value).split('.').map(part => Number(part) || 0);
  const [left, right] = [numbers(a), numbers(b)];
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const [one, other] = [left[i] || 0, right[i] || 0];
    if (one !== other) return one < other ? -1 : 1;
  }

  return 0;
}

// Which browser this is, for announcements meant for one of them. Chrome's name is in the user agent of the browsers
// built on it, so those are checked first.
function browserName() {
  const agent = navigator.userAgent;
  if (agent.includes('Firefox/')) return 'firefox';
  if (agent.includes('Edg/')) return 'edge';
  if (agent.includes('OPR/')) return 'opera';

  return 'chrome';
}

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
// The address is fixed. Unpacked (development) installs can switch to a local server
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
// then on it runs here: queued, submitted, polled, NSFW-checked, cached, and the result sent back. The port closes when
// the page goes away (navigation, reload, closed tab). Its jobs still waiting their turn are then dropped and those on
// the user's ComfyUI cancelled, unless results open in new tabs or download automatically: then they all finish and
// open there or go to Downloads. (Hosted jobs already submitted can't be cancelled, so they finish and are cached.)
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
  showJobCount();
}

// The Library page hands its files over a couple at a time and keeps the rest waiting in the page (each is read
// whole to be sent, see library.js), so it says how many those are, on a port of its own: they count on the badge
// and among the images the popup says are waiting, like the ones handed over. The port closing takes them off.
const LIBRARY_PORT = 'img2img-library';
const waitingInLibraries = new Map(); // port -> the files waiting in its page
const waitingInPages = () => [...waitingInLibraries.values()].reduce((sum, count) => sum + count, 0);

function showJobCount() {
  const count = jobsRunning + waitingInPages();
  chrome.action.setBadgeText({ text: count ? String(count) : '' });
}

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== LIBRARY_PORT) return;
  port.onMessage.addListener(({ waiting }) => {
    waitingInLibraries.set(port, Math.max(0, Math.round(Number(waiting)) || 0));
    showJobCount();
    tellQueuePositions();
  });
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    waitingInLibraries.delete(port);
    showJobCount();
    tellQueuePositions();
  });
});

// Jobs go to the img2img server one at a time, across every tab: sending them in a burst finishes no sooner and
// costs more. The others wait here, first come first served: their pages hear how many are ahead ({ ahead }, 0 when
// it's their turn) for their spinners, and can take a waiting job back ({ id, drop: true }), which answers it with a
// dropped error. Pages hand jobs over ready to go (downloaded, hashed, cache checked), so the next one follows
// without a gap. My ComfyUI is the user's own GPU, so the "Jobs at Once" setting lets it have up to
// JOBS_AT_ONCE_MOST at a time (jobsAtOnceFor, in shared/workflows.js).
let jobsAtOnce = 1;
const jobQueue = { running: 0, waiting: [] }; // waiting: { job, start(), drop() }, first in line first

async function readJobsAtOnce() {
  const { jobsAtOnce: setting, processingMode } = await chrome.storage.local.get(['jobsAtOnce', 'processingMode']);
  jobsAtOnce = jobsAtOnceFor(setting, processingMode);
  startWaitingJobs(); // raising it lets the jobs already waiting go
}
readJobsAtOnce();
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes.jobsAtOnce || changes.processingMode)) readJobsAtOnce();
});

function startWaitingJobs() {
  while (jobQueue.running < jobsAtOnce && jobQueue.waiting.length > 0) {
    jobQueue.waiting.shift().start();
  }
  tellQueuePositions();
}

function waitForJobSlot(job) {
  return new Promise((resolve, reject) => {
    const start = () => {
      jobQueue.running++;
      job.onWaiting?.(0);
      resolve();
    };
    if (jobQueue.running < jobsAtOnce && jobQueue.waiting.length === 0) {
      start();
      return;
    }
    jobQueue.waiting.push({ job, start, drop: () => reject(Object.assign(new Error('Taken out of the queue'), { dropped: true })) });
    tellQueuePositions();
  });
}

function releaseJobSlot() {
  jobQueue.running--;
  startWaitingJobs();
}

// Take the waiting jobs that match out of the queue: their runJob fails with a dropped error
function dropWaitingJobs(matches) {
  const dropped = jobQueue.waiting.filter(entry => matches(entry.job));
  jobQueue.waiting = jobQueue.waiting.filter(entry => !dropped.includes(entry));
  dropped.forEach(entry => entry.drop());
  tellQueuePositions();
}

function tellQueuePositions() {
  jobQueue.waiting.forEach((entry, i) => entry.job.onWaiting?.(jobQueue.running + i));
  // The popup, while it's open, shows how many are waiting (with its Clear button)
  chrome.runtime.sendMessage({ action: 'queueChanged', waiting: jobQueue.waiting.length + waitingInPages() })?.catch?.(() => {});
}

// The popup asks how many jobs are waiting their turn, and can clear them all, in every tab. The jobs already at the
// server or on ComfyUI go on. Each tab hears queueCleared: its jobs still being got ready never join the queue, and
// Automatic Selection stops there, or it would pick the same images straight back.
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'queueStatus') {
    sendResponse({ waiting: jobQueue.waiting.length + waitingInPages() });
    return false;
  }
  if (request.action !== 'clearQueue') {
    return false;
  }
  const cleared = jobQueue.waiting.length + waitingInPages();
  dropWaitingJobs(() => true);
  chrome.tabs.query({}).then(tabs => tabs.forEach(tab => chrome.tabs.sendMessage(tab.id, { action: 'queueCleared' }).catch(() => {})));
  sendResponse({ cleared });
  return false;
});

chrome.runtime.onConnect.addListener(port => {
  if (port.name !== JOB_PORT) return;
  const jobs = new Map(); // by the page's job id
  port.onMessage.addListener(({ id, job, drop }) => {
    if (drop) {
      // The page takes a waiting job back (its image clicked again, or Stop Processing); one already running goes on
      const waiting = jobs.get(id);
      if (waiting) {
        dropWaitingJobs(candidate => candidate === waiting);
      }
      return;
    }
    job.sourceTab = port.sender?.tab;
    job.pageOpen = true;
    const tell = message => {
      if (job.pageOpen) {
        port.postMessage({ id, ...message });
      }
    };
    job.onProgress = progress => tell({ progress });
    job.onEstimate = estimate => tell({ estimate });
    job.onWaiting = ahead => tell({ ahead });
    jobs.set(id, job);
    countJob(1);
    runJob(job).then(data => ({ id, data, key: job.cacheKey }), async error => ({
      id,
      error: error.message,
      ...(error.dropped && { dropped: true }),
      ...(error.outage && { notice: await outageNotice() })
    })).then(reply => {
      jobs.delete(id);
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
    const pageJobs = [...jobs.values()];
    for (const job of pageJobs) {
      job.pageOpen = false;
    }
    const { openResultsInNewTab, autoDownload } = await chrome.storage.local.get(['openResultsInNewTab', 'autoDownload']);
    // (the Library page's jobs never outlive it: it is the one place their results go, see runJob)
    const endsWithThePage = job => job.fromLibrary || (!openResultsInNewTab && !autoDownload);
    dropWaitingJobs(job => pageJobs.includes(job) && endsWithThePage(job));
    pageJobs.filter(endsWithThePage).forEach(job => cancelComfyJob(job).catch(error => console.debug('Cancelling a ComfyUI job failed:', error)));
  });
});

// Wait between polls. The extension API call resets the service worker's idle timer, so a job whose page is gone
// keeps the worker running (fetches don't)
async function pollWait(ms) {
  await new Promise(resolve => setTimeout(resolve, ms));
  await chrome.runtime.getPlatformInfo();
}

async function runJob(job) {
  await waitForJobSlot(job); // (fails with a dropped error when the page takes the job back, or leaves, before its turn)
  let data;
  try {
    data = job.kind === 'server' ? await runServerJob(job) : await runComfyJob(job);
  } finally {
    releaseJobSlot();
  }
  // The Library page shows its results in its own viewer and saves each one itself, into a folder named after the one
  // the file came from: no tab for it, and no second copy in Downloads
  if (job.fromLibrary) {
    return data;
  }
  // On a direct .jpg/.png URL the result already is the whole page, so it opens in a tab only once that page is gone
  const { openResultsInNewTab, autoDownload } = await chrome.storage.local.get(['openResultsInNewTab', 'autoDownload']);
  // A result tab's image processed again gets its new result in its dropdown there (addsToImage), with no tab either
  if (openResultsInNewTab && !(job.pageOpen && (job.isImagePage || job.addsToImage))) {
    if (job.original) rememberOriginal(job.hash, job.original);
    openResultTab(job, job.sourceTab);
  }
  // Download Results Automatically: saved here rather than by the page, so a page that's gone still gets its results
  // saved. Named like its download button's (content.js's downloadSwappedImage). With Double Download on, the
  // original follows the result as it does from the button: the page sent it with the job (its originalForJob)
  if (autoDownload) {
    const type = data.match(/^data:image\/([^;,]+)/)?.[1] || 'png';
    const filename = `${job.name || 'img2img'}-img2img.${type === 'jpeg' ? 'jpg' : type}`;
    downloadResult(data, filename)
      .catch(error => console.warn('Downloading the result automatically failed:', error.message))
      .then(async () => {
        const { downloadOriginal: double } = await chrome.storage.local.get('downloadOriginal');
        if (double === true && job.original) await downloadOriginal(job.original, filename);
      })
      .catch(error => console.warn('Downloading the original automatically failed:', error.message));
  }
  return data;
}

// The server didn't answer, or answered that it can't do anything right now (5xx): an outage, which the page's
// error explains with the current warning announcement if there is one (outageNotice)
async function jobApiFetch(path, options) {
  try {
    return await apiFetch(path, options);
  } catch (error) {
    throw Object.assign(error, { outage: true });
  }
}

function serverJobError(status, data) {
  return Object.assign(new Error(data.error || `The img2img server returned HTTP ${status}`), { outage: status >= 500 });
}

async function runServerJob(job) {
  const submitted = await jobApiFetch('/v1/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(job.body) });
  if (submitted.status !== 202) {
    throw serverJobError(submitted.status, submitted.data);
  }
  // How long the job's workflow typically takes, for the page's spinner (servers that don't know leave it out)
  if (Number.isFinite(submitted.data.estimatedWaitMs) && submitted.data.estimatedWaitMs > 0) {
    job.onEstimate?.(submitted.data.estimatedWaitMs);
  }
  let startTime = Date.now();
  while (Date.now() - startTime < SERVER_TIMEOUT_MS) {
    const { status, data } = await jobApiFetch(`/v1/jobs/${encodeURIComponent(submitted.data.jobId)}`);
    if (status !== 200) {
      throw serverJobError(status, data);
    }
    // The clock starts when the job is picked up, not when it was sent: before that it is waiting its turn
    if (data.status === 'queued') {
      startTime = Date.now();
    }
    if (data.status === 'done') {
      job.cacheKey = await addToCache(job.hash, data.result, job.imageUrl, job.name)
        .catch(error => void console.error('Caching the result failed:', error));
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

  let startTime = Date.now();
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
      const data = await fetchComfyResult(`/api/view?${new URLSearchParams(outputImage)}`, job.keepWorkflow);
      job.cacheKey = await addToCache(job.hash, data, job.imageUrl, job.name)
        .catch(error => void console.error('Caching the result failed:', error));
      return data;
    }
    // The clock starts once ComfyUI does: behind a long batch, a job waits its turn
    if (Date.now() - startTime >= COMFY_TIMEOUT_MS && await isWaitingInComfyQueue(job)) {
      startTime = Date.now();
    }
    await pollWait(COMFY_POLL_INTERVAL_MS);
  }
  throw new Error(`ComfyUI did not finish within ${COMFY_TIMEOUT_MS / 60000} minutes`);
}

// Whether a prompt is still waiting its turn in ComfyUI's queue. Asked only when its timeout runs out: /queue holds
// every waiting prompt's graph, images included, so it's too big to poll.
async function isWaitingInComfyQueue(job) {
  const queue = await comfyJson('/queue').catch(() => ({}));
  return Boolean(queue.queue_pending?.some(item => item[1] === job.promptId));
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
    // (No stopSelection here: a loaded page's new content script starts without Manual Selection, and some
    // sites report 'complete' for in-page URL changes such as a carousel's slides, which should keep it on.)
    chrome.storage.local.get(['autoProcess', 'autoRemember', 'selectedSourceId'], async function(result) {
      const sourceId = result.selectedSourceId
      // auto: these start by themselves, so content.js checks them against the Automatic Only On rule and, where a
      // site is off, says nothing rather than putting a message on every page
      if (result.autoRemember !== false) { // Swap Cache is on unless it has been turned off
        sendToTab(tabId, { action: 'autoRemember', sourceId: sourceId, auto: true });
      }
      if (result.autoProcess) {
        sendToTab(tabId, { action: 'selectAllVisible', sourceId: sourceId, auto: true });
      }
    });
  }
});

// Right-click menu: an image's or a video's context menu offers the workflow chosen in the popup ("img2img:
// Upscale"), so a single image can be processed without turning Manual Selection on. content.js finds the image
// that was right-clicked and runs it through the same path as a click there; a video is taken as the frame it
// showed when the menu opened.
//
// The browser only counts a right-click as one on an image or a video when that element itself is what was
// clicked. Many pages lay an empty layer over their pictures, or show them as a CSS background, and there the
// click is one on the page or on a link. A second item serves those: it's for a click on the page or a link, and
// stays hidden unless content.js has found a picture under the pointer (the 'pictureUnderPointer' message).
//
// Next to it, Download saves what the picture shows: its result where one is on show (as its download button
// does), otherwise the picture as it is, or a video's frame as a PNG. The browser's own items save a video as the
// whole video and know nothing of results, backgrounds or pictures under a layer.
//
// With more than one item the browser lists them under "img2img", so the items themselves don't say it again.
const RUN_MENU_ID = 'img2img-run-workflow';
const COVERED_MENU_ID = 'img2img-run-workflow-covered';
const RUN_MENU_IDS = [RUN_MENU_ID, COVERED_MENU_ID];
const DOWNLOAD_MENU_IDS = ['img2img-download-image', 'img2img-download-frame', 'img2img-download-covered'];

// The items in the order the menu lists them. A title of null is the chosen workflow's name (runMenuTitle); covered
// items are the ones shown only while content.js says there's a picture under the pointer.
const MENU_ITEMS = [
  { id: RUN_MENU_ID, title: null, contexts: ['image', 'video'] },
  { id: COVERED_MENU_ID, title: null, contexts: ['page', 'link'], covered: true },
  { id: DOWNLOAD_MENU_IDS[0], title: 'Download image', contexts: ['image'] },
  { id: DOWNLOAD_MENU_IDS[1], title: 'Download frame', contexts: ['video'] },
  { id: DOWNLOAD_MENU_IDS[2], title: 'Download image', contexts: ['page', 'link'], covered: true },
];

// The chosen workflow's name
async function runMenuTitle() {
  const { workflow, customWorkflows } = await chrome.storage.local.get(['workflow', 'customWorkflows']);
  const chosen = WORKFLOW_REPLACEMENTS[workflow] || workflow || DEFAULT_WORKFLOW;
  const customId = customWorkflowId(chosen);
  const name = customId
    ? (customWorkflows || []).find(definition => definition.id === customId)?.name
    : WORKFLOW_LABELS[chosen];
  // A workflow that's no longer there (one of the user's own, deleted) falls back to the default, as the popup does
  return name || WORKFLOW_LABELS[DEFAULT_WORKFLOW];
}

function createRunMenu() {
  // The browser keeps the items of an earlier run, which would make creating these a duplicate-id error
  chrome.contextMenus.removeAll(async () => {
    const runTitle = await runMenuTitle();
    for (const { id, title, contexts, covered } of MENU_ITEMS) {
      chrome.contextMenus.create(
        { id, title: title ?? runTitle, contexts, ...(covered ? { visible: false } : {}) },
        () => void chrome.runtime.lastError,
      );
    }
  });
}

// The run items are named after the chosen workflow, so they follow the popup's choice (and a renamed workflow of
// the user's own). Where an item isn't there to update (a browser session that didn't keep the menus, or a version
// that had fewer items) they're all created.
async function updateRunMenu() {
  const runTitle = await runMenuTitle();
  let missing = false;
  const updated = MENU_ITEMS.map(({ id, title }) => new Promise(resolve => {
    chrome.contextMenus.update(id, { title: title ?? runTitle }, () => {
      if (chrome.runtime.lastError) missing = true;
      resolve();
    });
  }));
  await Promise.all(updated);
  if (missing) createRunMenu();
}

// content.js says whether the pointer is over a picture the browser's own menu wouldn't offer the items for. Only
// the tab being looked at counts: the menu is one for the whole browser.
chrome.runtime.onMessage.addListener((request, sender) => {
  if (request.action === 'pictureUnderPointer' && sender.tab?.active) {
    let missing = false;
    const updated = MENU_ITEMS.filter(item => item.covered).map(({ id }) => new Promise(resolve => {
      chrome.contextMenus.update(id, { visible: Boolean(request.covered) }, () => {
        if (chrome.runtime.lastError) missing = true;
        resolve();
      });
    }));
    // (an install that came from a version with fewer items gets the others here)
    Promise.all(updated).then(() => missing && updateRunMenu());
  }
  return false;
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && (changes.workflow || changes.customWorkflows)) {
    updateRunMenu();
  }
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (DOWNLOAD_MENU_IDS.includes(info.menuItemId)) {
    sendToTab(tab.id, { action: 'downloadRightClicked', srcUrl: info.srcUrl });
    return;
  }
  if (!RUN_MENU_IDS.includes(info.menuItemId)) return;
  const { selectedSourceId } = await chrome.storage.local.get('selectedSourceId');
  sendToTab(tab.id, { action: 'runWorkflowOnImage', srcUrl: info.srcUrl, sourceId: selectedSourceId });
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

// Reads an NSFW check's own output (addSafetyCheck in shared/workflows.js) and says whether it failed
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
// shared or downloaded as PNG would carry them. Results keep only the chunks that draw the image, except a My
// workflows result made with Keep Workflow in Results on (job.keepWorkflow, from content.js): that graph is the
// user's own, run on their own ComfyUI, and keeping it means dropping the result into ComfyUI opens the workflow
// that made it.
const PNG_TEXT_CHUNKS = ['tEXt', 'iTXt', 'zTXt'];
function withoutPngText(bytes) {
  if (!isPng(bytes)) return bytes;
  const kept = [bytes.subarray(0, 8)];
  for (const { type, start, end } of pngChunks(bytes)) {
    if (!PNG_TEXT_CHUNKS.includes(type)) {
      kept.push(bytes.subarray(start, end));
    }
  }
  const out = new Uint8Array(kept.reduce((total, part) => total + part.length, 0));
  kept.reduce((at, part) => (out.set(part, at), at + part.length), 0);
  return out;
}

function isPng(bytes) {
  return bytes.length >= 8 && new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0) === 0x89504e47;
}

// A PNG's chunks after its signature, as { type, start, end } (byte offsets of the whole chunk)
function* pngChunks(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const end = offset + 12 + view.getUint32(offset);
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    yield { type, start: offset, end };
    offset = end;
    if (type === 'IEND') break;
  }
}

// The result image as a data URL, without the graph ComfyUI wrote into it unless the job keeps it
async function fetchComfyResult(path, keepText = false) {
  const response = await fetch(await comfyAddress() + path);
  if (!response.ok) {
    throw new Error(`ComfyUI returned HTTP ${response.status} for the processed image`);
  }
  const type = response.headers.get('content-type') || 'image/png';
  const bytes = new Uint8Array(await response.arrayBuffer());
  return dataUrlOf(new Blob([keepText ? bytes : withoutPngText(bytes)], { type }));
}

// A Blob as a data URL (the service worker has no URL.createObjectURL)
function dataUrlOf(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// IndexedDB setup
const dbName = 'SourcesDB';
const dbVersion = 1;
const storeName = 'sources';
let db;

// Initialize IndexedDB
const initDB = new Promise((resolve, reject) => {
  const request = indexedDB.open(dbName, dbVersion);
  
  request.onerror = () => {
    console.error('Error opening the source database:', request.error);
    reject(request.error);
  };
  
  request.onsuccess = () => {
    console.log('Source database opened successfully');
    db = request.result;
    resolve();
  };
  
  request.onupgradeneeded = (event) => {
    console.log('Upgrading the source database');
    const db = event.target.result;
    if (!db.objectStoreNames.contains(storeName)) {
      const store = db.createObjectStore(storeName, { keyPath: 'id' });
      console.log('Created the sources store');
    }
  };
});

// Cache setup
const CACHE_DB_NAME = 'imageSwapCache';
// A cached result is kept in two parts under the same key: what's known about it (its page image, name, time and
// thumbnail) in the first store, and its picture in the second. Listing the cache and finding a page image's results
// then read only the small part; a picture is read when it's wanted, by its key.
const CACHE_STORE_NAME = 'images';
const PICTURE_STORE_NAME = 'pictures';
const CACHE_DB_VERSION = 6;
// How many results the cache keeps: the Cache Size setting (cacheSize) on the settings page, one of these
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
    // Lets an image processed with the same settings find its results (see addToCache)
    if (!store.indexNames.contains('sourceHash')) {
      store.createIndex('sourceHash', 'sourceHash', { unique: false });
      console.log('Added sourceHash index to cache store');
    }
    const pictures = db.objectStoreNames.contains(PICTURE_STORE_NAME)
      ? event.target.transaction.objectStore(PICTURE_STORE_NAME)
      : db.createObjectStore(PICTURE_STORE_NAME, { keyPath: 'hash' });
    // Version 4 leaves signed URLs' changing parameters out of the image URL key (see cacheImageUrl). Version 5 keys
    // each result on its own, so the results from before it get a key of their own and keep their hash as sourceHash.
    // Version 6 moves each picture into the pictures store. One pass does both: a re-keyed entry comes up again
    // further on, already re-keyed, and has its picture moved then.
    if (event.oldVersion > 0 && event.oldVersion < 6) {
      store.openCursor().onsuccess = cursorEvent => {
        const cursor = cursorEvent.target.result;
        if (!cursor) return;
        const entry = cursor.value;
        if (!entry.sourceHash) {
          cursor.delete();
          store.put({ ...entry, imageUrl: cacheImageUrl(entry.imageUrl), sourceHash: entry.hash, hash: newCacheKey(entry.hash) });
        } else if ('processedImage' in entry) {
          const { processedImage, ...details } = entry;
          pictures.put({ hash: entry.hash, processedImage });
          cursor.update(details);
        }
        cursor.continue();
      };
    }
  };
});

// The cache's key for a page image: its URL without the #fragment. Result tabs for direct image URLs are the
// image URL plus "#img2img-result=...", and Chrome's image page uses that whole URL as the <img> src, so an
// image re-processed there would otherwise be stored apart from its earlier results and not replace them.
// Signed URLs get a new signature and expiry on every page load, so those parameters are left out too, and the
// CDNs below sign every parameter and vary the edge host, so those are keyed by the path alone, which names the
// file. (Renaming this key orphans results cached under the old one, which was accepted when it changed.)
const SIGNED_PATH_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
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
  if (SIGNED_PATH_HOSTS.test(url.hostname)) {
    return `signed-path:${url.pathname}`;
  }
  for (const name of [...url.searchParams.keys()]) {
    if (SIGNATURE_PARAMS.test(name)) {
      url.searchParams.delete(name);
    }
  }
  return url.href;
}

// A cached result's own key: its source hash (page image and settings) plus a random part, so every result is kept
function newCacheKey(sourceHash) {
  return `${sourceHash}.${crypto.randomUUID()}`;
}

// The newest of some cache entries' results
function newestEntry(entries) {
  return entries.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0] || null;
}

// Get from cache. hash is a source hash (the newest result of that image and settings) or a result's own key (the
// cache page, viewer.html). With no hash, only the loose lookup by image URL runs (used by Swap Cache, which skips
// downloading and hashing the page image).
async function getFromCache(hash, imageUrl, allowLooseCacheLink = false) {
  return (await findInCache(hash, imageUrl, allowLooseCacheLink))?.processedImage || null;
}

// The same lookup, resolving with the whole entry ({ hash, processedImage, ... }) rather than the picture alone:
// a page is told the key of the result it is sent, which is what the result's delete button removes it by
async function findInCache(hash, imageUrl, allowLooseCacheLink = false) {
  imageUrl = cacheImageUrl(imageUrl);
  try {
    if (!cacheDB) {
      await initCacheDB;
    }
    return new Promise((resolve, reject) => {
      const transaction = cacheDB.transaction([CACHE_STORE_NAME, PICTURE_STORE_NAME], 'readonly');
      const store = transaction.objectStore(CACHE_STORE_NAME);

      // The entry found, with its picture; null when there's no entry or its picture is gone
      const withPicture = (entry, then) => {
        if (!entry) {
          then(null);
          return;
        }
        const pictureRequest = transaction.objectStore(PICTURE_STORE_NAME).get(entry.hash);
        pictureRequest.onerror = () => reject(pictureRequest.error);
        pictureRequest.onsuccess = () => {
          const processedImage = pictureRequest.result?.processedImage;
          then(processedImage ? { ...entry, processedImage } : null);
        };
      };

      const looseLookup = () => {
        if (!imageUrl || !allowLooseCacheLink) {
          resolve(null);
          return;
        }
        const urlRequest = store.index('imageUrl').getAll(imageUrl);
        urlRequest.onerror = () => reject(urlRequest.error);
        // An image keeps all its results (see addToCache): the newest is the one shown
        urlRequest.onsuccess = () => withPicture(newestEntry(urlRequest.result), resolve);
      };

      if (!hash) {
        looseLookup();
        return;
      }
      // First the exact match: the newest result made with this source hash, or the result with this key
      const sourceRequest = store.index('sourceHash').getAll(hash);
      sourceRequest.onerror = () => reject(sourceRequest.error);
      sourceRequest.onsuccess = () => {
        const newest = newestEntry(sourceRequest.result);
        if (newest) {
          withPicture(newest, resolve);
          return;
        }
        const request = store.get(hash);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => withPicture(request.result, found => (found ? resolve(found) : looseLookup()));
      };
    });
  } catch (error) {
    console.error('Error in findInCache:', error);
    throw error;
  }
}

// Add to cache. A page image keeps all its results, also those made with the same settings (outfits and styles can
// give more than one worth keeping, and the cache page shows them all); lookups show the newest (see getFromCache).
// hash is the source hash; the result gets a key of its own, which is what this resolves with: the page is told
// which of an image's results it is showing, so its dropdown can say so. name is the result's download base name
// (the cache page shows it; entries from before it was kept have none).
async function addToCache(hash, processedImage, imageUrl, name) {
  imageUrl = cacheImageUrl(imageUrl);
  try {
    if (!cacheDB) {
      await initCacheDB;
    }
    const limit = await cacheSize();
    const key = newCacheKey(hash);
    return new Promise((resolve, reject) => {
      const transaction = cacheDB.transaction([CACHE_STORE_NAME, PICTURE_STORE_NAME], 'readwrite');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);

      // The new entry is the newest, so dropping the oldest beyond the limit never drops it
      transaction.objectStore(CACHE_STORE_NAME).put({ hash: key, sourceHash: hash, imageUrl, name, timestamp: Date.now() });
      transaction.objectStore(PICTURE_STORE_NAME).put({ hash: key, processedImage });
      deleteOldest(transaction, limit);
    }).then(() => {
      purgeExpired().catch(() => {}); // (its own transaction, once this one is in: an age that has passed isn't urgent)
      return key;
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

// Delete one cached result, both parts, in a transaction over both stores
function deleteResult(transaction, key) {
  transaction.objectStore(CACHE_STORE_NAME).delete(key);
  transaction.objectStore(PICTURE_STORE_NAME).delete(key);
}

// Delete the cache's oldest results until `keep` are left (by key, without loading them), in a transaction over both
// stores; calls done with how many it deleted
function deleteOldest(transaction, keep, done = () => {}) {
  const store = transaction.objectStore(CACHE_STORE_NAME);
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
      deleteResult(transaction, cursor.primaryKey);
      deleted++;
      cursor.continue();
    };
  };
}

// The results cached for one page image, newest first and without their pictures: an image keeps every
// generation of itself (see addToCache), and the dropdown over a processed image offers them, fetching the one
// picked by its own key (getFromCache). Only what the dropdown needs is sent, since a picture each would be
// megabytes of message for nothing.
const LISTED_RESULTS = 20;

async function listResults(imageUrl) {
  imageUrl = cacheImageUrl(imageUrl);
  if (!imageUrl) {
    return [];
  }
  if (!cacheDB) {
    await initCacheDB;
  }
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction(CACHE_STORE_NAME, 'readonly');
    const request = transaction.objectStore(CACHE_STORE_NAME).index('imageUrl').getAll(imageUrl);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result
      .sort((one, other) => (other.timestamp || 0) - (one.timestamp || 0))
      .slice(0, LISTED_RESULTS)
      .map(({ hash, timestamp, name }) => ({ hash, timestamp, name })));
  });
}

// "Delete results older than": the ages offered, in days (anything else means they're kept until the cache is full)
const CACHE_KEEP_DAYS = [1, 7, 30];

// Results older than that setting; resolves with how many were deleted. Runs when a result is added, when the
// browser starts and when the setting changes, so an age is never only applied to new results.
async function purgeExpired() {
  const { cacheKeepDays } = await chrome.storage.local.get('cacheKeepDays');
  if (!CACHE_KEEP_DAYS.includes(cacheKeepDays)) {
    return 0;
  }
  if (!cacheDB) {
    await initCacheDB;
  }
  const oldest = Date.now() - cacheKeepDays * 24 * 60 * 60 * 1000;
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction([CACHE_STORE_NAME, PICTURE_STORE_NAME], 'readwrite');
    let deleted = 0;
    transaction.objectStore(CACHE_STORE_NAME).index('timestamp').openKeyCursor(IDBKeyRange.upperBound(oldest)).onsuccess = event => {
      const cursor = event.target.result;
      if (!cursor) {
        return;
      }
      deleteResult(transaction, cursor.primaryKey);
      deleted++;
      cursor.continue();
    };
    transaction.oncomplete = () => resolve(deleted);
    transaction.onerror = () => reject(transaction.error);
  });
}

// "Clear the cache when the browser starts" (for a shared computer), then whatever is past its age
chrome.runtime.onStartup.addListener(async () => {
  const { cacheClearOnStartup } = await chrome.storage.local.get('cacheClearOnStartup');
  if (cacheClearOnStartup) {
    await clearCache();
  }
  await purgeExpired();
});

// After Cache Size is lowered: drop the oldest results beyond it; resolves with how many were dropped
async function trimCache() {
  if (!cacheDB) {
    await initCacheDB;
  }
  const limit = await cacheSize();
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction([CACHE_STORE_NAME, PICTURE_STORE_NAME], 'readwrite');
    let deleted = 0;
    deleteOldest(transaction, limit, count => { deleted = count; });
    transaction.oncomplete = () => resolve(deleted);
    transaction.onerror = () => reject(transaction.error);
  });
}

// The cached results without their images (but with their thumbnails, once the cache page has made them), newest
// first, for the cache page (cache.html), which loads each image by its hash as it's shown. Only the small part of
// each result is read (see PICTURE_STORE_NAME).
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

// Delete one cached result by its key (the cache page, the viewer, and a result's delete button on the page), and
// with deleteFiles the files it was downloaded as (see deleteDownloadedFiles). Resolves with how many files went,
// and the error if one couldn't; the result goes either way.
async function deleteFromCache(hash, { deleteFiles = false } = {}) {
  if (!cacheDB) {
    await initCacheDB;
  }
  const files = deleteFiles ? await deleteDownloadedFiles(hash) : { filesDeleted: 0 };
  await new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction([CACHE_STORE_NAME, PICTURE_STORE_NAME], 'readwrite');
    deleteResult(transaction, hash);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error);
  });
  return files;
}

// One cached result by its key, with its picture, or null
async function cacheEntry(hash) {
  if (!cacheDB) {
    await initCacheDB;
  }
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction([CACHE_STORE_NAME, PICTURE_STORE_NAME], 'readonly');
    const request = transaction.objectStore(CACHE_STORE_NAME).get(hash);
    const pictureRequest = transaction.objectStore(PICTURE_STORE_NAME).get(hash);
    transaction.oncomplete = () => resolve(request.result ? { ...request.result, processedImage: pictureRequest.result?.processedImage } : null);
    transaction.onerror = () => reject(transaction.error);
  });
}

// The downloads of a cached result that are still there to delete: the browser's records of them (chrome.downloads
// keeps where each file went), found by the ids kept with the result's fingerprint (markResultDownloaded). A
// download taken out of the browser's history is left out, as is one whose file the browser has seen go (it only
// looks now and then: a file deleted by hand may still be offered, and removing it again does no harm). Resolves
// with { key, files: [{ id, path }] }.
async function downloadsOf(hash) {
  const entry = await cacheEntry(hash);
  if (!entry?.processedImage || !chrome.downloads?.search) {
    return { key: null, files: [] };
  }
  const key = resultKey(entry.processedImage);
  const { downloadedFiles = {} } = await chrome.storage.local.get('downloadedFiles');
  const found = await Promise.all((downloadedFiles[key] || []).map(id => chrome.downloads.search({ id }).catch(() => [])));
  const files = found.flat()
    .filter(item => item.state === 'complete' && item.exists !== false && item.filename)
    .map(item => ({ id: item.id, path: item.filename }));
  return { key, files };
}

async function downloadedFilesOf(hash) {
  return (await downloadsOf(hash)).files;
}

// Delete the files a cached result was downloaded as (chrome.downloads.removeFile: the browser's record of the
// download stays, saying the file is gone, as when a file is deleted by hand), and forget that the result was
// downloaded, so its download button is live again. Resolves with how many went, and the first error met; a file
// that couldn't go is still remembered.
async function deleteDownloadedFiles(hash) {
  const { key, files } = await downloadsOf(hash);
  let filesDeleted = 0;
  let fileError;
  for (const file of files) {
    try {
      await chrome.downloads.removeFile(file.id);
      filesDeleted++;
    } catch (error) {
      fileError = fileError || error?.message || String(error);
    }
  }
  if (key && !fileError) {
    await forgetResultDownloaded(key);
  }
  return fileError ? { filesDeleted, fileError } : { filesDeleted };
}

// Delete every cached result; resolves with how many there were
async function clearCache() {
  if (!cacheDB) {
    await initCacheDB;
  }
  return new Promise((resolve, reject) => {
    const transaction = cacheDB.transaction([CACHE_STORE_NAME, PICTURE_STORE_NAME], 'readwrite');
    const store = transaction.objectStore(CACHE_STORE_NAME);
    const countRequest = store.count();
    countRequest.onsuccess = () => {
      store.clear();
      transaction.objectStore(PICTURE_STORE_NAME).clear();
    };
    transaction.oncomplete = () => resolve(countRequest.result);
    transaction.onerror = () => reject(transaction.error);
  });
}

// Handle messages from popup and content script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'saveSource') {
    saveSource(request.source)
      .then(() => sendResponse({ success: true }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'getSource') {
    getSource(request.sourceId)
      .then(source => sendResponse({ success: true, source }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'getAllSources') {
    getAllSources()
      .then(sources => sendResponse({ success: true, sources }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }
  
  if (request.action === 'deleteSource') {
    deleteSource(request.sourceId)
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
    // (folder: the Library page's, a folder of its own for the results of each folder opened there)
    downloadResult(request.dataUrl, request.filename, request.folder)
      .then(downloadId => sendResponse({ success: true, downloadId }), error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  // A result as it would be downloaded, without downloading it: a JPG or the picture as it is, by the Download as
  // JPG and Keep Workflow in Results settings (see downloadableImage). The Library page puts these in its ZIP, so a
  // result is the same file there as when it is saved by itself.
  if (request.action === 'downloadableImage') {
    downloadableImage({ dataUrl: request.dataUrl, filename: request.filename })
      .then(image => sendResponse({ success: true, ...image }), error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // Double Download: the original of a result just downloaded, sent after it by the same button. It comes as a
  // data URL (the page read it, or has it, as for a video's frame), or as a URL for this script to fetch (the
  // cache page knows only where its image came from); name is the result's download name
  if (request.action === 'downloadOriginal') {
    downloadOriginal(request.dataUrl || request.url, request.name)
      .then(downloadId => sendResponse({ success: true, downloadId }), error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  // The right-click menu's Download, for a picture with no result on show: saved as it is (see downloadAsIs), name
  // being its file name without the extension
  if (request.action === 'downloadPicture') {
    downloadAsIs(request.dataUrl, request.name)
      .then(downloadId => sendResponse({ success: true, downloadId }), error => sendResponse({ success: false, error: error.message }));
    return true;
  }

  if (request.action === 'openResultTab') {
    if (request.original) rememberOriginal(request.hash, request.original);
    openResultTab(request, sender.tab);
    sendResponse({ success: true });
    return false;
  }

  // The original of a result, for the tab it opened in (see rememberOriginal)
  if (request.action === 'getOriginalImage') {
    sendResponse({ success: true, original: originalImages.get(request.hash) || null });
    return false;
  }

  if (request.action === 'getFromCache') {
    findInCache(request.hash, request.imageUrl, request.allowLooseCacheLink)
      .then(entry => sendResponse({ success: true, result: entry?.processedImage || null, hash: entry?.hash, imageUrl: entry?.imageUrl }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'listResults') {
    listResults(request.imageUrl)
      .then(results => sendResponse({ success: true, results }))
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
    deleteFromCache(request.hash, { deleteFiles: request.deleteFiles === true })
      .then(files => sendResponse({ success: true, ...files }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  // The files a cached result was downloaded as, for the question its delete button asks (see downloadedFilesOf)
  if (request.action === 'downloadedFiles') {
    downloadedFilesOf(request.hash)
      .then(files => sendResponse({ success: true, files }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'trimCache') {
    trimCache()
      .then(count => sendResponse({ success: true, count }))
      .catch(error => sendResponse({ success: false, error: error.message }));
    return true; // Keep the message channel open for async response
  }

  if (request.action === 'purgeExpired') {
    purgeExpired()
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
// extension listening to onDeterminingFilename makes Chrome drop the filename given to
// chrome.downloads.download, saving "download.jpg"; a suggestion from our own listener still wins.
// (Firefox has no onDeterminingFilename and keeps the given filename.)
//
// We only listen while a download of ours is waiting for its name. Every extension listening takes part in
// naming every download the browser makes, and whoever listened last has the say: the others are told their
// name lost to ours, and lose it, even where we asked for no name at all. For a download that isn't ours
// there is nothing to ask for, so the listener isn't there to be asked.
const pendingDownloadNames = new Map();
let namingDownloads = false;

// The event, where the browser has it (the Firefox package has only the line that says it doesn't)
const downloadNaming = chrome.downloads.onDeterminingFilename; // chromium-only
// firefox: const downloadNaming = undefined;

// How long a download has to ask for its name before we stop listening: it may be blocked and never ask
const DOWNLOAD_NAME_TIMEOUT = 60000;

function suggestDownloadName(item, suggest) {
  const filename = item.byExtensionId === chrome.runtime.id && pendingDownloadNames.get(item.url);
  if (filename) {
    suggest({ filename, conflictAction: 'uniquify' });
    forgetDownloadName(item.url);
  } else {
    suggest();
  }
}

function rememberDownloadName(url, name) {
  if (!downloadNaming) return;
  pendingDownloadNames.set(url, name);
  if (!namingDownloads) {
    downloadNaming.addListener(suggestDownloadName);
    namingDownloads = true;
  }
  // A retry under the same URL replaces the name, and its own timer takes over from this one
  setTimeout(() => {
    if (pendingDownloadNames.get(url) === name) forgetDownloadName(url);
  }, DOWNLOAD_NAME_TIMEOUT);
}

function forgetDownloadName(url) {
  pendingDownloadNames.delete(url);
  if (namingDownloads && pendingDownloadNames.size === 0) {
    downloadNaming.removeListener(suggestDownloadName);
    namingDownloads = false;
  }
}

// Blob URLs handed to downloads (Firefox), by download id, released once the download has finished
const blobDownloads = new Map();

chrome.downloads.onChanged.addListener(({ id, state }) => {
  if (blobDownloads.has(id) && state && state.current !== 'in_progress') {
    URL.revokeObjectURL(blobDownloads.get(id));
    blobDownloads.delete(id);
  }
});

// The originals of results that opened in tabs of their own, by the hash the tab was opened with (the page sends
// it with the job, or with its request to open a cached result; see originalForResultTab in content.js). The viewer
// asks for it as it loads, and reads the original from its URL instead once this is gone. In memory only, and the
// latest few: they're whole page images.
const originalImages = new Map();
const MAX_ORIGINAL_IMAGES = 5;

function rememberOriginal(hash, original) {
  originalImages.delete(hash);
  originalImages.set(hash, original);
  while (originalImages.size > MAX_ORIGINAL_IMAGES) {
    originalImages.delete(originalImages.keys().next().value);
  }
}

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

// The bytes of a PNG data URL, or null for anything else
async function pngBytes(dataUrl) {
  if (!dataUrl.startsWith('data:image/png;base64,')) return null;
  const bytes = new Uint8Array(await (await fetch(dataUrl)).arrayBuffer());
  return isPng(bytes) ? bytes : null;
}

// Whether a PNG has text chunks. Only a My workflows result made with Keep Workflow in Results on has them (see
// fetchComfyResult); every other result has them taken out.
function hasPngText(bytes) {
  for (const { type } of pngChunks(bytes)) {
    if (PNG_TEXT_CHUNKS.includes(type)) return true;
  }
  return false;
}

// "Download as JPG" setting (on unless turned off): re-encode the result as a JPG to save space.
// PNGs with transparency stay PNG, since JPG would lose it, and so does a PNG that carries its workflow while Keep
// Workflow in Results is on: dropping the file into ComfyUI opens the workflow only while the graph is in it, and
// a JPG can't hold it.
// A download name Chrome accepts: no characters Windows or Chrome reject (slashes, colons, quotes, control
// and right-to-left marks), no leading dots or spaces
function safeFilename(filename) {
  const cleaned = String(filename || '')
    .replace(/[\\/:*?"<>|\x00-\x1f\x7f‎‏‪-‮⁦-⁩]/g, '_')
    .replace(/^[.\s]+/, '')
    .trim();
  return cleaned || 'img2img.png';
}

// "Download Folder" setting: a subfolder of the browser's Downloads folder for results. chrome.downloads only
// takes a relative path, so an absolute one ("D:\Photos") or a back-reference ("..") is cleaned into a
// relative path rather than refused; missing folders the browser creates. Empty means Downloads itself.
// {date} and {month} in the folder, so results can be filed by the day or the month they were made.
// Same function in settings.js, which shows the folder they land in.
function expandFolderTokens(folder) {
  const now = new Date();
  const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return String(folder || '').replace(/\{date\}/gi, date).replace(/\{month\}/gi, date.slice(0, 7));
}

function safeFolder(folder) {
  const parts = String(folder || '').trim().replace(/\\/g, '/').split('/');
  // A drive or home folder typed at the front ("D:\Photos", "~/Photos") is dropped: what follows it is kept
  if (/^[a-z]:$/i.test(parts[0]) || parts[0] === '~') parts.shift();
  return parts
    .map(part => part
      .replace(/[:*?"<>|\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '_')
      .replace(/^[.\s]+|[.\s]+$/g, ''))
    .filter(part => part && part !== '..')
    .join('/');
}

// The "JPG Quality" setting, as a percentage: smaller files, the balanced default, or the best quality
const JPG_QUALITIES = [80, 92, 98];
const DEFAULT_JPG_QUALITY = 92;

async function downloadableImage({ dataUrl, filename }) {
  filename = safeFilename(filename);
  const { downloadAsJpg, jpgQuality, keepWorkflowInResult } = await chrome.storage.local.get(['downloadAsJpg', 'jpgQuality', 'keepWorkflowInResult']);
  // A PNG with text chunks is a My workflows result that kept its workflow. While Keep Workflow in Results is on it
  // stays a PNG, since a JPG can't carry the workflow; with the setting off since (a result from before), the text
  // comes out on the way, as it does from every other result
  const bytes = await pngBytes(dataUrl);
  if (bytes && hasPngText(bytes)) {
    if (keepWorkflowInResult === true) return { url: await downloadUrl(dataUrl), filename };
    dataUrl = await dataUrlOf(new Blob([withoutPngText(bytes)], { type: 'image/png' }));
  }
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
  const quality = JPG_QUALITIES.includes(jpgQuality) ? jpgQuality : DEFAULT_JPG_QUALITY;
  const jpg = await canvas.convertToBlob({ type: 'image/jpeg', quality: quality / 100 });
  return { url: await downloadUrl(jpg), filename: filename.replace(/\.[^.]*$/, '') + '.jpg' };
}

// A URL chrome.downloads accepts for an image (a data URL or a Blob). Chrome's service worker has no
// URL.createObjectURL, so it gets a data URL; Firefox's background page has it, and its downloads refuse data URLs.
async function downloadUrl(image) {
  if (typeof URL.createObjectURL === 'function') {
    return URL.createObjectURL(typeof image === 'string' ? await (await fetch(image)).blob() : image);
  }
  if (typeof image === 'string') return image;
  return dataUrlOf(image);
}

// Save a result to Downloads (its download button, or Download Results Automatically); resolves to the download's id.
async function downloadResult(dataUrl, filename, subfolder) {
  const downloadId = await saveToDownloads(await downloadableImage({ dataUrl, filename }), subfolder);
  // Keyed by the result itself, not the JPG copy, so the page can match it. Recorded before the page hears the
  // download went through: what it does next (delete the result, with its file) goes by the record.
  await markResultDownloaded(resultKey(dataUrl), downloadId);
  return downloadId;
}

// "Double Download" setting (downloadOriginal, off to begin with): a download button saves the original image as
// well, right after the result. It's saved as it is, in its own format rather than as a JPG: it is the original,
// and what the page showed. Named like the result, with -original where the result has -img2img, so the two sit
// together in the folder; the extension is the original's own. A URL in place of the data is fetched here.
const IMAGE_EXTENSIONS = { jpeg: 'jpg', 'svg+xml': 'svg', 'x-icon': 'ico', 'vnd.microsoft.icon': 'ico', tiff: 'tif' };

async function downloadOriginal(image, name) {
  const base = safeFilename(name).replace(/\.[^.]*$/, '').replace(/-img2img$/, '');
  return downloadAsIs(image, `${base}-original`);
}

// A picture saved as it is, in its own format, as "<base>.<its own extension>". A URL in place of the data is
// fetched here.
async function downloadAsIs(image, base) {
  let dataUrl = image;
  if (!/^data:/i.test(dataUrl)) {
    // (a video's frame, say, which names a moment of the video rather than a file)
    if (!/^https?:/i.test(dataUrl)) throw new Error('there is no URL to load it from');
    const response = await fetch(dataUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    dataUrl = await dataUrlOf(await response.blob());
  }
  const subtype = dataUrl.match(/^data:image\/([^;,]+)/)?.[1]?.toLowerCase() || 'png';
  const extension = IMAGE_EXTENSIONS[subtype] || subtype;
  return saveToDownloads({ url: await downloadUrl(dataUrl), filename: safeFilename(`${base || 'image'}.${extension}`) });
}

// Put an image ({ url, filename }) in Downloads; resolves to the download's id.
// The Download Folder setting puts it in a subfolder of Downloads.
// A name or folder Chrome still refuses gets a plain name in Downloads itself, rather than no download at all.
// subfolder: a folder of its own inside that one (the Library page's results, by the folder their files came from),
// or inside "img2img" when no Download Folder is set, so they don't land loose among everything else in Downloads.
const LIBRARY_FOLDER = 'img2img';

async function saveToDownloads(image, subfolder = '') {
  const { downloadFolder } = await chrome.storage.local.get('downloadFolder');
  const chosen = safeFolder(expandFolderTokens(downloadFolder));
  const inside = safeFolder(subfolder);
  const folder = inside ? `${chosen || LIBRARY_FOLDER}/${inside}` : chosen;
  const download = (name, retry) => new Promise((resolve, reject) => {
    rememberDownloadName(image.url, name);
    chrome.downloads.download({ url: image.url, filename: name }, downloadId => {
      const error = chrome.runtime.lastError;
      if (error) forgetDownloadName(image.url);
      if (!error && image.url.startsWith('blob:')) blobDownloads.set(downloadId, image.url);
      // (Chrome says "Invalid filename", Firefox "filename must not contain illegal characters")
      if (/filename/i.test(error?.message) && retry) {
        resolve(download(`img2img.${image.filename.split('.').pop()}`, false));
      } else if (error || downloadId === undefined) {
        reject(new Error(error?.message || 'Download was blocked'));
      } else {
        resolve(downloadId);
      }
    });
  });
  return download(folder ? `${folder}/${image.filename}` : image.filename, true);
}

// The download's id goes with it (downloadedFiles: fingerprint -> the ids of its last few downloads), so the file
// can be deleted along with the result (deleteDownloadedFiles). The ids of results no longer listed go with them.
const MAX_DOWNLOADS_OF_A_RESULT = 5;

// One at a time, so downloads close together (Download all on the cache page) don't write over each other's
let markingDownloads = Promise.resolve();

function markResultDownloaded(key, downloadId) {
  markingDownloads = markingDownloads.then(async () => {
    const { downloadedResults = [], downloadedFiles = {} } = await chrome.storage.local.get(['downloadedResults', 'downloadedFiles']);
    const results = downloadedResults.includes(key) ? downloadedResults : [...downloadedResults, key].slice(-MAX_DOWNLOADED_RESULTS);
    const files = Object.fromEntries(Object.entries(downloadedFiles).filter(([other]) => results.includes(other)));
    if (downloadId !== undefined) {
      files[key] = [...(files[key] || []), downloadId].slice(-MAX_DOWNLOADS_OF_A_RESULT);
    }
    await chrome.storage.local.set({ downloadedResults: results, downloadedFiles: files });
  }).catch(error => console.warn('img2img: download not recorded', error));
  return markingDownloads;
}

// The result went along with its files: it counts as not downloaded again
async function forgetResultDownloaded(key) {
  const { downloadedResults = [], downloadedFiles = {} } = await chrome.storage.local.get(['downloadedResults', 'downloadedFiles']);
  const files = { ...downloadedFiles };
  delete files[key];
  await chrome.storage.local.set({ downloadedResults: downloadedResults.filter(other => other !== key), downloadedFiles: files });
}

// Open a converted image in a background tab next to the page it came from.
// Chrome rejects an opener tab that's in a different window from the new tab. That happens when the
// page is in a popup or app window (Chrome moves new tabs to a normal window), so only normal windows
// get the opener/position, and any remaining failure retries as a plain new tab.
// Incognito: extension pages can't open in incognito windows (spanning mode), so instead the original
// image URL opens with a #img2img-result marker and the content script shows the cached result there.
async function openResultTab(request, sourceTab) {
  // The viewer's revert and compare buttons load the original image from its own URL, so it goes along. Only
  // a page URL can be fetched again there: a result made from a blob: URL in the page, or from a data: URL,
  // opens with its download button alone.
  const imageUrl = /^https?:/i.test(request.imageUrl || '') ? request.imageUrl : '';
  const canOpenImageUrl = sourceTab?.incognito && imageUrl;
  const url = canOpenImageUrl
    ? `${imageUrl.split('#')[0]}#img2img-result=${encodeURIComponent(request.hash)}&img2img-name=${encodeURIComponent(request.name)}`
    : chrome.runtime.getURL(`viewer.html?${new URLSearchParams({ hash: request.hash, name: request.name, ...(imageUrl ? { src: imageUrl } : {}) })}`);
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

// Save a source to IndexedDB
async function saveSource(source) {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      console.log('Saving source to DB:', source.id);
      const request = store.put(source);
      
      request.onsuccess = () => {
        console.log('Source saved successfully:', source.id);
        resolve();
      };
      request.onerror = () => {
        console.error('Error saving source:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Could not save the source:', error);
    throw error;
  }
}

// Get a source from IndexedDB
async function getSource(sourceId) {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(sourceId);
      
      request.onsuccess = () => {
        console.log('Retrieved source from DB:', sourceId, request.result);
        resolve(request.result);
      };
      request.onerror = () => {
        console.error('Error retrieving source from DB:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Could not read the source:', error);
    throw error;
  }
}

// Get all the sources from IndexedDB
async function getAllSources() {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAll();
      
      request.onsuccess = () => {
        console.log('Retrieved all sources from DB:', request.result);
        resolve(request.result);
      };
      request.onerror = () => {
        console.error('Error retrieving all sources:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Could not read the sources:', error);
    throw error;
  }
}

// Delete a source from IndexedDB
async function deleteSource(sourceId) {
  try {
    await initDB;
    return new Promise((resolve, reject) => {
      const transaction = db.transaction([storeName], 'readwrite');
      const store = transaction.objectStore(storeName);
      const request = store.delete(sourceId);
      
      request.onsuccess = () => {
        console.log('Source deleted successfully:', sourceId);
        resolve();
      };
      request.onerror = () => {
        console.error('Error deleting source:', request.error);
        reject(request.error);
      };
    });
  } catch (error) {
    console.error('Could not delete the source:', error);
    throw error;
  }
}