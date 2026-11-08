// The settings page (settings.html, the extension's options page): every setting except the few the popup keeps
// (Processing, the API key and the development server, which the popup needs for its own workflow list and credits).
// Nothing is saved or applied here: each setting is written to chrome.storage.local as it changes, which is where the
// popup, the content scripts and background.js read it from.

// The switches, each bound to a chrome.storage.local key. onByDefault is what an unset key means. Their boxes are
// ticked from one read below, so none of them flicks over while the page is already up.
const switches = [];

function toggle(id, key, { onByDefault = false } = {}) {
  const input = document.getElementById(id);
  const state = value => (typeof value === 'boolean' ? value : onByDefault);
  input.addEventListener('change', () => chrome.storage.local.set({ [key]: input.checked }));
  switches.push({ input, key, state });
}

// The three the popup repeats
toggle('openInNewTabToggle', 'openResultsInNewTab');
toggle('autoDownloadToggle', 'autoDownload');
toggle('downloadAsJpgToggle', 'downloadAsJpg', { onByDefault: true });
// The icons over a converted image (content.js) and in a result tab (viewer.js): always there, or on hover
toggle('iconsOnHoverToggle', 'resultIconsOnHover');
toggle('cacheClearOnStartupToggle', 'cacheClearOnStartup');
// Announcements: background.js asks the site once a day, and removes anything stored when this is turned off
toggle('announcementsToggle', 'announcementsEnabled', { onByDefault: true });
toggle('devAutoReloadToggle', 'devAutoReload');

// The popup has some of the same switches: follow it while both are open
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  for (const { input, key, state } of switches) {
    if (key in changes) input.checked = state(changes[key].newValue);
  }
});

// A dropdown of numbers bound to a key. afterChange, where it's given, reports what the change did.
const numberSelects = [];

function numberSelect(id, key, { afterChange } = {}) {
  const select = document.getElementById(id);
  select.addEventListener('change', async () => {
    await chrome.storage.local.set({ [key]: Number(select.value) });
    await afterChange?.(Number(select.value));
  });
  numberSelects.push({ select, key });
}

numberSelect('jpgQuality', 'jpgQuality');
numberSelect('jobsAtOnce', 'jobsAtOnce');
// Automatic Selection: the smallest image worth a job, and the two that keep a long page from running up a bill
numberSelect('minImageSide', 'minImageSide');
numberSelect('autoAskOver', 'autoAskOver');
numberSelect('autoStopAfter', 'autoStopAfter');

// Dark mode is one setting for every extension page, kept by shared/theme.js
const darkModeToggle = document.getElementById('darkModeToggle');
darkModeToggle.checked = img2imgTheme.isDark();
img2imgTheme.onChange(dark => { darkModeToggle.checked = dark; });
darkModeToggle.addEventListener('change', () => img2imgTheme.setDark(darkModeToggle.checked));

// Dev Auto-Reload: only offered for unpacked (development) installs
chrome.management.getSelf(self => {
  document.getElementById('devAutoReloadRow').hidden = self.installType !== 'development';
});

// "Download Folder": a subfolder of the browser's Downloads folder for results. Saved as typed (background.js cleans
// it when it downloads); the hint under the field shows where results actually land.
// Same functions as expandFolderTokens and safeFolder in background.js.
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

const downloadFolder = document.getElementById('downloadFolder');
const downloadFolderHint = document.getElementById('downloadFolderHint');

function showDownloadFolder() {
  const folder = safeFolder(expandFolderTokens(downloadFolder.value));
  const typed = safeFolder(downloadFolder.value);
  if (!folder) {
    downloadFolderHint.textContent = 'Results go straight to your Downloads folder. Name a folder to keep them '
      + 'together and the browser creates it: img2img, or img2img/{date} for one folder a day.';
    return;
  }
  downloadFolderHint.textContent = `Results go to Downloads/${folder}/`
    + (typed === downloadFolder.value.trim().replace(/\\/g, '/').replace(/\/+$/, '')
      ? ''
      : ' \u2014 only folders inside Downloads are possible, so the path was adjusted.');
}

// Saved while typing, so an edit isn't lost by closing the tab; tidied up once the field is left
let savingFolder;
downloadFolder.addEventListener('input', () => {
  showDownloadFolder();
  clearTimeout(savingFolder);
  savingFolder = setTimeout(() => chrome.storage.local.set({ downloadFolder: downloadFolder.value.trim() }), 400);
});
downloadFolder.addEventListener('blur', () => {
  clearTimeout(savingFolder);
  downloadFolder.value = downloadFolder.value.trim();
  showDownloadFolder();
  chrome.storage.local.set({ downloadFolder: downloadFolder.value });
});

// "File Name": the pattern content.js fills in for each result (resultBaseName). The tokens are the pieces it knows;
// -img2img and the extension are always added, so a result is recognisable as one.
const FILENAME_TOKENS = ['{title}', '{workflow}', '{source}', '{host}', '{date}', '{time}'];
const DEFAULT_FILENAME_PATTERN = '{title}-{workflow}-{source}';
const FILENAME_EXAMPLE = {
  '{title}': 'Mountain hares in winter',
  '{workflow}': 'Upscale',
  '{source}': 'Bella',
  '{host}': 'example.com',
  '{date}': '2026-11-08',
  '{time}': '14-05',
};

const filenamePattern = document.getElementById('filenamePattern');
const filenamePatternHint = document.getElementById('filenamePatternHint');
const filenameTokens = document.getElementById('filenameTokens');

// Same function as fillFilenamePattern in content.js, which names the results
function fillPattern(pattern, values) {
  return (String(pattern || '').trim() || DEFAULT_FILENAME_PATTERN)
    .replace(/\{[a-z]+\}/gi, token => values[token.toLowerCase()] ?? token)
    .replace(/[-_\s]{2,}/g, '-')
    .replace(/^[-_\s.]+|[-_\s.]+$/g, '');
}

// One dash where a token was taken out, and none left hanging at either end
function tidyPattern(pattern) {
  return pattern.replace(/[-_\s]{2,}/g, '-').replace(/^[-_\s.]+|[-_\s.]+$/g, '');
}

function tokenRegex(token) {
  return new RegExp(token.replace(/[^a-z]/gi, character => `[${character}]`), 'i');
}

function showFilenamePattern() {
  const unknown = (filenamePattern.value.match(/\{[a-z]+\}/gi) || [])
    .filter(token => !FILENAME_TOKENS.includes(token.toLowerCase()));
  filenamePatternHint.textContent = `Saves as "${fillPattern(filenamePattern.value, FILENAME_EXAMPLE)}-img2img.jpg". `
    + 'Click a token to add it where the cursor is, or click it again to take it out.'
    + (unknown.length ? ` ${unknown.join(', ')} ${unknown.length === 1 ? 'is' : 'are'} not a token of ours, so it stays as typed.` : '');
  for (const { token, button } of tokenButtons) {
    // An empty field means the default pattern, which is the name the hint shows, so the tokens follow it
    const inUse = tokenRegex(token).test(filenamePattern.value.trim() || DEFAULT_FILENAME_PATTERN);
    button.classList.toggle('in-use', inUse);
    button.title = `${token} is "${FILENAME_EXAMPLE[token]}" here. Click to ${inUse ? 'take it out' : 'add it'}.`;
  }
}

let savingPattern;
function savePattern() {
  clearTimeout(savingPattern);
  chrome.storage.local.set({ filenamePattern: filenamePattern.value.trim() });
}

// Where a clicked token goes: where the cursor was last left in the field
let patternCaret = null;
for (const event of ['focus', 'click', 'keyup', 'input']) {
  filenamePattern.addEventListener(event, () => { patternCaret = filenamePattern.selectionStart; });
}

// Clicking a token puts it in the pattern with a dash between it and what's already there, so a name can be put
// together without typing the braces; clicking one that's in there takes it out again
function toggleFilenameToken(token) {
  const typed = filenamePattern.value.trim();
  const pattern = typed || DEFAULT_FILENAME_PATTERN;
  const used = tokenRegex(token);
  let caret;
  if (used.test(pattern)) {
    filenamePattern.value = tidyPattern(pattern.replace(used, ''));
    caret = filenamePattern.value.length;
  } else {
    // At the cursor, or at the end when nothing has been typed yet (the default pattern is what's being added to)
    const at = typed ? Math.min(patternCaret ?? pattern.length, pattern.length) : pattern.length;
    const before = pattern.slice(0, at);
    const after = pattern.slice(at);
    const head = before + (!before || /[-_\s]$/.test(before) ? '' : '-') + token;
    filenamePattern.value = head + (!after || /^[-_\s]/.test(after) ? '' : '-') + after;
    caret = head.length;
  }
  patternCaret = caret;
  filenamePattern.focus();
  filenamePattern.setSelectionRange(caret, caret);
  savePattern();
  showFilenamePattern();
}

const tokenButtons = FILENAME_TOKENS.map(token => {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = token;
  // Keep the cursor where it is, so the token lands there instead of at the end
  button.addEventListener('mousedown', event => event.preventDefault());
  button.addEventListener('click', () => toggleFilenameToken(token));
  filenameTokens.appendChild(button);
  return { token, button };
});

filenamePattern.addEventListener('input', () => {
  showFilenamePattern();
  clearTimeout(savingPattern);
  savingPattern = setTimeout(() => chrome.storage.local.set({ filenamePattern: filenamePattern.value.trim() }), 400);
});
filenamePattern.addEventListener('blur', () => {
  clearTimeout(savingPattern);
  filenamePattern.value = filenamePattern.value.trim();
  chrome.storage.local.set({ filenamePattern: filenamePattern.value });
});

// The user's own ComfyUI (used when Processing is My ComfyUI; content.js falls back to 127.0.0.1:8188)
const comfyServerAddress = document.getElementById('comfyServerAddress');
comfyServerAddress.addEventListener('change', () => {
  chrome.storage.local.set({ comfyServerAddress: comfyServerAddress.value.trim() });
});

// "Never Run On" and "Automatic Only On" (shared/sites.js reads them): saved as typed, while typing, so a list
// half entered isn't lost by closing the tab
function siteList(id, key) {
  const field = document.getElementById(id);
  let saving;
  field.addEventListener('input', () => {
    clearTimeout(saving);
    saving = setTimeout(() => chrome.storage.local.set({ [key]: field.value }), 400);
  });
  field.addEventListener('blur', () => {
    clearTimeout(saving);
    // What the rules actually match, one a line, so a pasted address or a list shows as what it became
    field.value = img2imgSites.patterns(field.value).join('\n');
    chrome.storage.local.set({ [key]: field.value });
  });
  return field;
}

const blockedSites = siteList('blockedSites', 'blockedSites');
const automaticSites = siteList('automaticSites', 'automaticSites');

// "A Workflow for a Site": [{ site, workflow }], the first rule covering a page's site winning (content.js).
// The workflows are the built-in ones and the user's own, as the popup lists them.
const siteWorkflowRules = document.getElementById('siteWorkflowRules');
let siteWorkflows = [];
let customWorkflowNames = [];

function saveSiteWorkflows() {
  chrome.storage.local.set({ siteWorkflows: siteWorkflows.filter(rule => rule.site.trim() && rule.workflow) });
}

function workflowOptions(selected) {
  const select = document.createElement('select');
  const options = [
    ...Object.entries(WORKFLOW_LABELS),
    ...customWorkflowNames.map(({ id, name }) => [`${CUSTOM_WORKFLOW_PREFIX}${id}`, `${name} (your own)`]),
  ];
  // A workflow that's gone (one of the user's own, deleted) still shows, so the rule isn't silently changed
  if (selected && !options.some(([value]) => value === selected)) {
    options.push([selected, `${selected} (not here any more)`]);
  }
  for (const [value, label] of options) {
    select.append(Object.assign(document.createElement('option'), { value, textContent: label, selected: value === selected }));
  }
  return select;
}

function renderSiteWorkflows() {
  siteWorkflowRules.replaceChildren(...siteWorkflows.map((rule, index) => {
    const row = Object.assign(document.createElement('div'), { className: 'rule-row' });
    const site = Object.assign(document.createElement('input'), {
      type: 'text', value: rule.site, placeholder: 'example.com', spellcheck: false, autocomplete: 'off',
    });
    site.addEventListener('input', () => { siteWorkflows[index].site = site.value; saveSiteWorkflows(); });
    const workflow = workflowOptions(rule.workflow);
    workflow.addEventListener('change', () => { siteWorkflows[index].workflow = workflow.value; saveSiteWorkflows(); });
    const remove = Object.assign(document.createElement('button'), { className: 'danger', textContent: 'Remove', title: 'Drop this rule' });
    remove.addEventListener('click', () => {
      siteWorkflows.splice(index, 1);
      saveSiteWorkflows();
      renderSiteWorkflows();
    });
    row.append(site, workflow, remove);
    return row;
  }));
}

document.getElementById('addSiteWorkflow').addEventListener('click', () => {
  siteWorkflows.push({ site: '', workflow: Object.keys(WORKFLOW_LABELS)[0] });
  renderSiteWorkflows();
  siteWorkflowRules.querySelector('.rule-row:last-child input')?.focus();
});

const cacheStatus = document.getElementById('cacheStatus');

function showCacheStatus(message, type = 'success') {
  cacheStatus.textContent = message;
  cacheStatus.className = type === 'error' ? 'status error' : 'status';
  cacheStatus.hidden = false;
}

// A cache job in background.js (trimming to a new size, deleting what's past its age, purging the lot)
async function cacheAction(action, said) {
  try {
    const response = await chrome.runtime.sendMessage({ action });
    if (!response?.success) throw new Error(response?.error || 'No response');
    showCacheStatus(said(response.count));
  } catch (error) {
    showCacheStatus(`Couldn't ${action === 'clearCache' ? 'purge the cache' : 'change the cache'}: ${error.message}`, 'error');
  }
}

// How many results the cache keeps; lowering it drops the oldest straight away
numberSelect('cacheSize', 'cacheSize', {
  afterChange: size => cacheAction('trimCache', count => `The cache keeps ${size} images${count ? ` (${count} older removed)` : ''}`),
});
// How long a result is kept, whatever the size allows
numberSelect('cacheKeepDays', 'cacheKeepDays', {
  afterChange: days => cacheAction('purgeExpired', count => (days
    ? `Results are deleted after ${days === 1 ? 'a day' : days === 7 ? 'a week' : 'a month'}${count ? ` (${count} already past that, removed)` : ''}`
    : 'Results are kept until the cache is full')),
});

// Purge the converted-image cache (Swap Cache and repeat conversions read from it)
const purgeCacheButton = document.getElementById('purgeCache');
purgeCacheButton.addEventListener('click', async () => {
  if (!confirm('Delete all cached converted images?')) return;
  purgeCacheButton.disabled = true;
  await cacheAction('clearCache', count => `Cache purged (${count} image${count === 1 ? '' : 's'})`);
  purgeCacheButton.disabled = false;
});

document.getElementById('viewCache').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('cache.html') });
});
document.getElementById('manageWorkflows').addEventListener('click', () => {
  chrome.tabs.create({ url: chrome.runtime.getURL('workflows.html') });
});

// Settings backup: everything in chrome.storage.local except what belongs to this browser or this person alone.
// The sources themselves live in IndexedDB and are exported from the popup instead.
const SETTINGS_EXPORT_FORMAT = 'img2img-settings';
const NOT_IN_BACKUP = [
  'img2imgApiKey', 'img2imgLocalApiKey', // a key belongs to one account, and a backup file is easily shared
  'termsAgreedVersion', // agreeing to the terms is each person's own
  'announcements', 'announcementsCheckedAt', 'announcementsDismissed', // fetched again, and dismissals are local
  'downloadedResults', 'isProcessing', 'devReloadTabId', // what this browser is doing, not a setting
];

const backupStatus = document.getElementById('backupStatus');

function showBackupStatus(message, type = 'success') {
  backupStatus.textContent = message;
  backupStatus.className = type === 'error' ? 'status error' : 'status';
  backupStatus.hidden = false;
}

document.getElementById('exportSettings').addEventListener('click', async () => {
  try {
    const stored = await chrome.storage.local.get(null);
    const settings = Object.fromEntries(Object.entries(stored).filter(([key]) => !NOT_IN_BACKUP.includes(key)));
    const file = new Blob([JSON.stringify({ format: SETTINGS_EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), settings }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(file);
    const filename = `img2img-settings-${new Date().toISOString().slice(0, 10)}.json`;
    await chrome.downloads.download({ url, filename, saveAs: false });
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    showBackupStatus(`Exported ${Object.keys(settings).length} settings to Downloads/${filename}`);
  } catch (error) {
    showBackupStatus(`Export failed: ${error.message}`, 'error');
  }
});

const importSettingsInput = document.getElementById('importSettingsInput');
document.getElementById('importSettings').addEventListener('click', () => importSettingsInput.click());
importSettingsInput.addEventListener('change', async () => {
  const file = importSettingsInput.files[0];
  importSettingsInput.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    if (data?.format !== SETTINGS_EXPORT_FORMAT || !data.settings || typeof data.settings !== 'object') {
      throw new Error('not an img2img settings export');
    }
    // Filtered again on the way in: an older file, or a hand-edited one, can't bring a key or an agreement with it
    const settings = Object.fromEntries(Object.entries(data.settings).filter(([key]) => !NOT_IN_BACKUP.includes(key)));
    await chrome.storage.local.set(settings);
    showBackupStatus(`Imported ${Object.keys(settings).length} settings. Reloading the page to show them\u2026`);
    setTimeout(() => location.reload(), 800);
  } catch (error) {
    showBackupStatus(`Import failed: ${error.message}`, 'error');
  }
});

// Every saved value in one read: the page shows nothing until they're all in place
const readKeys = [...switches.map(({ key }) => key), ...numberSelects.map(({ key }) => key),
  'downloadFolder', 'filenamePattern', 'comfyServerAddress', 'blockedSites', 'automaticSites', 'siteWorkflows', 'customWorkflows'];
chrome.storage.local.get(readKeys, stored => {
  for (const { input, key, state } of switches) {
    input.checked = state(stored[key]);
  }
  for (const { select, key } of numberSelects) {
    // (a value this version doesn't offer, or none at all, leaves the dropdown's own default selected)
    if (stored[key] !== undefined && [...select.options].some(option => Number(option.value) === Number(stored[key]))) {
      select.value = String(Number(stored[key]));
    }
  }
  downloadFolder.value = stored.downloadFolder || '';
  showDownloadFolder();
  filenamePattern.value = stored.filenamePattern || '';
  showFilenamePattern();
  comfyServerAddress.value = stored.comfyServerAddress || '';
  blockedSites.value = stored.blockedSites || '';
  automaticSites.value = stored.automaticSites || '';
  customWorkflowNames = (stored.customWorkflows || []).map(({ id, name }) => ({ id, name: name || id }));
  siteWorkflows = (Array.isArray(stored.siteWorkflows) ? stored.siteWorkflows : [])
    .map(({ site, workflow }) => ({ site: String(site || ''), workflow: String(workflow || '') }));
  renderSiteWorkflows();
  document.body.classList.remove('loading');
});
