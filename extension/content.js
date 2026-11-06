let isSelecting = false;
let selectedImage = null;
let selectedFaceId = null;
let isContinuousProcessing = false; // Track continuous processing mode
let isCurrentlyProcessing = 0; // Track if an image is currently being processed
let isScrolling = false; // Track if user is currently scrolling
let scrollTimeout = null; // For debouncing scroll events
let checkInterval = null; // For continuous checking
let settingsHash = null;
let isResultTab = false; // this tab shows a result opened via #img2img-result (no automatic processing)

const DB_NAME = 'imageSwapCache';
const STORE_NAME = 'images';
const DB_VERSION = 1;
const MAX_CACHE_ENTRIES = 50; // Maximum number of cached images

// Get face from IndexedDB
async function getFace(faceId) {
  try {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'getFace', faceId }, response => {
        if (response.success) {
          console.log('Retrieved face from DB:', faceId, response.face);
          resolve(response.face);
        } else {
          console.error('Error retrieving face:', response.error);
          reject(new Error(response.error));
        }
      });
    });
  } catch (error) {
    console.error('Error in getFace:', error);
    throw error;
  }
}

// Listen for messages from the popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startSelection') {
    selectedFaceId = request.selectedFaceId;
    startImageSelection();
  } else if (request.action === 'stopSelection') {
    stopImageSelection();
  } else if (request.action === 'selectAllVisible') {
    selectedFaceId = request.faceId;
    startContinuousProcessing();
  } else if (request.action === 'autoRemember') {
    selectedFaceId = request.faceId;
    replaceCachedImages();
  } else if (request.action === 'stopContinuousProcessing') {
    stopContinuousProcessing();
  } else if (request.action === 'checkProcessingStatus') {
    // Send back this tab's state: Automatic running, Manual Selection on (the popup shows its buttons from it)
    sendResponse({ isProcessing: isContinuousProcessing, isSelecting });
  }
});

// Swap Cache: swap in cached results by image URL, without downloading or hashing the page images. Once on, images
// the page adds later are looked up too (see restoreImage).
let swapCacheOn = false;

async function replaceCachedImages() {
  swapCacheOn = true;
  const images = allImages().filter(img =>
    img.src && !img.src.startsWith('data:') && !img.getAttribute('data-original-src')
  );
  await Promise.all(images.map(swapInCachedResult));
}

// After the extension is reloaded or updated, the content script already on an open tab keeps running but can't
// reach the background anymore (every chrome.runtime call throws "Extension context invalidated")
function extensionContextLost() {
  return !chrome.runtime?.id;
}

async function swapInCachedResult(imgElement) {
  if (isResultTab || imgElement.closest('.img2img-spinner') || extensionContextLost()) return;
  const src = imgElement.src;
  try {
    const cachedResult = await getFromCache(null, getSourceUrl(imgElement), true);
    // (unless the page pointed the image at another picture meanwhile)
    const name = cachedResult && await nameOfResult(cachedResult);
    if (cachedResult && imgElement.src === src) {
      showResult(imgElement, cachedResult, name);
      addDownloadButton(imgElement);
    }
  } catch (error) {
    if (extensionContextLost()) return;
    console.error('Swap Cache lookup failed:', error);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.autoRemember && !changes.autoRemember.newValue) {
    swapCacheOn = false;
  }
});

// Results shown on this page, by their original's URL. Sites like Instagram rebuild their images (carousel slides,
// re-rendered feeds) or point an <img> at another picture, which loses the result: an image that shows up with one
// of these URLs gets its result back.
const pageResults = new Map();

function restoreImage(imgElement) {
  if (!imgElement.src || imgElement.src.startsWith('data:')) {
    // One of our results: keep the page's responsive candidates from covering it again
    if (imgElement.hasAttribute('data-original-src') && imgElement.hasAttribute('srcset')) {
      imgElement.removeAttribute('srcset');
    }
    return;
  }
  if (imgElement.hasAttribute('data-original-src') && imgElement.src !== imgElement.getAttribute('data-original-src')) {
    // The page reused this <img> for another picture: to img2img it's a new image
    imgElement.removeAttribute('data-original-src');
    imgElement.removeAttribute('data-img2img-settings');
    revertedResults.delete(imgElement);
  }
  if (revertedResults.has(imgElement)) return; // toggled back to its original
  const result = pageResults.get(imgElement.src);
  if (result) {
    showResult(imgElement, result);
    addDownloadButton(imgElement);
  } else if (swapCacheOn && !imgElement.hasAttribute('data-original-src')) {
    swapInCachedResult(imgElement);
  }
}

const imageObserver = new MutationObserver(mutations => {
  if (extensionContextLost()) {
    // An orphaned content script: the reloaded extension injects a fresh one on the next page load
    imageObserver.disconnect();
    swapCacheOn = false;
    return;
  }
  if (pageResults.size === 0 && !swapCacheOn) return;
  const images = new Set();
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') {
      if (mutation.target.tagName === 'IMG') images.add(mutation.target);
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName === 'IMG') {
        images.add(node);
      } else if (node.firstElementChild) {
        node.querySelectorAll('img').forEach(img => images.add(img));
      }
    }
  }
  images.forEach(restoreImage);
});
imageObserver.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset'] });

async function startImageSelection() {
  isSelecting = true;
  document.body.style.cursor = 'crosshair';
  
  let settings = await getSettings();
  settingsHash = hashBase64("", settings); // used inside the click handler to prevent double processing
  // On window, so the capture listeners run before the page's own ones on document
  window.addEventListener('click', handleImageClick, true);
  window.addEventListener('mousemove', handleImageHover, true);
  document.documentElement.addEventListener('mouseleave', clearHoveredImage);
}

// Keep the manual-selection settings hash current: an image converted with older settings (or another
// source face) can then be clicked again without leaving and re-entering Manual Selection
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local' || !isSelecting) return;
  if (changes.selectedFaceId) {
    selectedFaceId = changes.selectedFaceId.newValue;
  }
  settingsHash = hashBase64("", await getSettings());
});

// Page images are <img> elements, or (for Manual Selection) elements that show a picture as their CSS background,
// like banners and product photos. A result shown in a background is kept here, so its CSS isn't read back.
const backgroundResults = new WeakMap();
const MIN_BACKGROUND_SIDE = 100; // smaller backgrounds are icons and sprites

function imageSrc(element) {
  if (element.tagName === 'IMG') return element.src;
  return backgroundResults.get(element) ?? cssBackgroundUrl(element);
}

function setImageSrc(element, url) {
  if (element.tagName === 'IMG') {
    element.src = url;
    return;
  }
  backgroundResults.set(element, url);
  element.style.setProperty('background-image', `url("${url.replace(/["\\]/g, '\\$&')}")`, 'important');
}

// The first url() of an element's CSS background ('' for none or a gradient)
function cssBackgroundUrl(element) {
  const value = getComputedStyle(element).backgroundImage;
  return value && value !== 'none' ? /url\(\s*(["']?)(.*?)\1\s*\)/.exec(value)?.[2] || '' : '';
}

function isBackgroundImage(element) {
  if (element === document.body || element === document.documentElement) return false;
  const rect = element.getBoundingClientRect();
  return rect.width >= MIN_BACKGROUND_SIDE && rect.height >= MIN_BACKGROUND_SIDE && Boolean(cssBackgroundUrl(element));
}

// An element's shadow root, also a closed one (which extensions may open)
function shadowRootOf(element) {
  return element.shadowRoot || globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element) || element.openOrClosedShadowRoot || null;
}

// The parent of a node, crossing out of a shadow root to its host
function parentOf(node) {
  return node.parentElement || node.parentNode?.host || null;
}

// The elements at a point of the window, topmost first, including those inside shadow roots (web components)
function elementsAt(x, y, root = document, seen = new Set([document])) {
  const elements = [];
  for (const element of root.elementsFromPoint(x, y)) {
    const shadow = shadowRootOf(element);
    if (shadow && !seen.has(shadow)) {
      seen.add(shadow);
      for (const inner of elementsAt(x, y, shadow, seen)) {
        if (!elements.includes(inner)) elements.push(inner);
      }
    }
    if (!elements.includes(element)) elements.push(element);
  }
  return elements;
}

// Every <img> of the page, including those inside shadow roots. The shadow roots are looked up at most once a second.
let shadowRootsCache = { time: 0, roots: [] };
function allImages() {
  if (Date.now() - shadowRootsCache.time > 1000) {
    const roots = [];
    const collect = root => root.querySelectorAll('*').forEach(element => {
      const shadow = shadowRootOf(element);
      if (shadow) {
        roots.push(shadow);
        collect(shadow);
      }
    });
    collect(document);
    shadowRootsCache = { time: Date.now(), roots };
  }
  return [document, ...shadowRootsCache.roots].flatMap(root => Array.from(root.querySelectorAll('img')));
}

// An image just inside an element that lets the pointer through (pointer-events: none), so elementsFromPoint never
// finds it, when it's at the point
function passThroughImageIn(element, x, y) {
  for (const img of element.querySelectorAll(':scope > img, :scope > * > img')) {
    if (getComputedStyle(img).pointerEvents !== 'none') continue;
    const rect = img.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return img;
  }
  return null;
}

// Elements that stop the search for an image under the pointer: the page's controls and img2img's own
const SELECTION_BLOCKERS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'CANVAS', 'IFRAME']);
const OWN_ELEMENTS = '.img2img-download, .img2img-revert, .img2img-compare, .img2img-spinner, #img2img-error-toast';

// The image seen at a point of the window. Sites like Instagram lay an empty element over their images to catch
// clicks, so it looks through the elements there (topmost first, skipping img2img's own) until it reaches an image,
// or something with its own text or a control, which is what's seen instead. Empty elements on top only count as
// the image's overlay when they're near it in the page: a modal's backdrop comes from elsewhere and hides the image.
// With backgrounds, an element showing a picture as its CSS background counts as an image too.
function imageAt(x, y, { backgrounds = false } = {}) {
  const above = [];
  const seen = element => above.every(overlay => isNearby(overlay, element)) ? element : null;
  for (const element of elementsAt(x, y)) {
    if (element.closest(OWN_ELEMENTS)) continue;
    if (SELECTION_BLOCKERS.has(element.tagName)) return null;
    if (element.tagName === 'IMG') return seen(element);
    const passThrough = passThroughImageIn(element, x, y);
    if (passThrough) return seen(passThrough);
    if (Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) return null;
    if (backgrounds && isBackgroundImage(element)) return seen(element);
    above.push(element);
  }
  return null;
}

// Whether an element is within a few levels of an image's ancestors, as a site's overlay on its own image is
function isNearby(element, img) {
  let ancestor = parentOf(img);
  for (let level = 0; ancestor && level < 4; level++, ancestor = parentOf(ancestor)) {
    for (let node = element; node; node = parentOf(node)) {
      if (node === ancestor) return true;
    }
  }
  return false;
}

// The image under the pointer that Manual Selection can process (not through img2img's own buttons)
function selectableImageAt(e) {
  if (e.target.closest?.(OWN_ELEMENTS)) return null;
  const img = imageAt(e.clientX, e.clientY, { backgrounds: true });
  return img && img.getAttribute('data-img2img-settings') !== settingsHash ? img : null;
}

let hoveredImage = null;

function setHoveredImage(img) {
  if (img === hoveredImage) return;
  clearHoveredImage();
  hoveredImage = img;
  if (img) {
    // Drawn inside the image, so containers that clip their overflow still show it
    img.style.outline = '2px solid #4CAF50';
    img.style.outlineOffset = '-2px';
  }
}

function clearHoveredImage() {
  if (hoveredImage) {
    hoveredImage.style.outline = '';
    hoveredImage.style.outlineOffset = '';
  }
  hoveredImage = null;
}

function handleImageHover(e) {
  if (!isSelecting) return;
  setHoveredImage(selectableImageAt(e));
}

async function handleImageClick(e) {
  if (!isSelecting) return;
  const img = selectableImageAt(e);
  if (!img) return; // links, buttons and the rest of the page work as usual

  e.preventDefault();
  e.stopPropagation();

  clearHoveredImage();
  img.setAttribute('data-img2img-settings', settingsHash);
  selectedImage = img;
  await swapImage(selectedImage);
}

function stopImageSelection() {
  isSelecting = false;
  document.body.style.cursor = '';
  clearHoveredImage();
  window.removeEventListener('click', handleImageClick, true);
  window.removeEventListener('mousemove', handleImageHover, true);
  document.documentElement.removeEventListener('mouseleave', clearHoveredImage);
}

// Helper to get ComfyUI server address from storage
async function getComfyServerAddress() {
  return new Promise(resolve => {
    chrome.storage.local.get(['comfyServerAddress'], result => {
      resolve(result.comfyServerAddress || 'http://127.0.0.1:8188');
    });
  });
}

function hashBase64(base64, settings) {
  // Combine all settings relevant to the selected workflow into a single string
  let settingsString;
  const workflow = effectiveWorkflow(settings);
  if (isCustomWorkflow(workflow)) {
    // The user's own workflow: its definition's version and the popup's values for it
    settingsString = JSON.stringify({ ...customWorkflowCacheKey(settings.customWorkflow, settings.customWorkflowValues, selectedFaceId), comfyServerAddress: settings.comfyServerAddress || 'http://127.0.0.1:8188' });
  } else if (workflow === 'controlnet') {
    // No source face: changing it shouldn't re-run the preprocessor
    const preprocessor = settings.controlnetPreprocessor || CONTROLNET_DEFAULT_PREPROCESSOR;
    settingsString = JSON.stringify({
      workflow, preprocessor, options: settings.controlnetOptions?.[preprocessor] || {},
      resolution: Number(settings.controlnetResolution) || CONTROLNET_DEFAULT_RESOLUTION,
      comfyServerAddress: settings.comfyServerAddress || 'http://127.0.0.1:8188',
    });
  } else if (workflow === 'upscale' || workflow === 'background' || workflow === 'restore') {
    // Only this workflow's own settings, so changing the source face or another workflow's settings keeps the cache
    const own = {
      upscale: { model: settings.upscaleModel || UPSCALE_DEFAULT_MODEL, scale: Number(settings.upscaleScale) || UPSCALE_DEFAULT_SCALE },
      background: {
        mode: settings.backgroundMode || BACKGROUND_DEFAULTS.mode,
        color: settings.backgroundMode === 'color' ? settings.backgroundColor || BACKGROUND_DEFAULTS.color : null,
        blur: settings.backgroundMode === 'blur' ? Number(settings.backgroundBlur ?? BACKGROUND_DEFAULTS.blur) : null,
      },
      restore: {
        model: settings.restoreModel || RESTORE_DEFAULTS.model,
        strength: Number(settings.restoreStrength ?? RESTORE_DEFAULTS.strength),
        fidelity: Number(settings.restoreFidelity ?? RESTORE_DEFAULTS.fidelity),
      },
    }[workflow];
    settingsString = JSON.stringify({ workflow, ...own, comfyServerAddress: settings.comfyServerAddress || 'http://127.0.0.1:8188' });
  } else {
    settingsString = JSON.stringify({ workflow, comfyServerAddress: settings.comfyServerAddress || 'http://127.0.0.1:8188' });
  }
  
  // Combine base64 and settings string
  const combinedString = base64 + settingsString;
  
  let hash = 5381;
  for (let i = 0; i < combinedString.length; i++) {
    hash = ((hash << 5) + hash) + combinedString.charCodeAt(i); // hash * 33 + c
    hash = hash & 0xFFFFFFFF; // Force 32bit integer
  }
  return hash.toString(16);
}

async function getFromCache(hash, imageUrl, allowLooseCacheLink = false) {
  try {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'getFromCache', hash, imageUrl, allowLooseCacheLink }, response => {
        if (response.success) {
          resolve(response.result);
        } else {
          console.error('Error getting from cache:', response.error);
          reject(new Error(response.error));
        }
      });
    });
  } catch (error) {
    console.error('Error in getFromCache:', error);
    throw error;
  }
}

// Local mode builds the ControlNet, upscale, background and restore workflows (shared/workflows.js).

// NSFW check for the graphs built here (see addSafetyCheck in shared/workflows.js). img2img is SFW-only; this stays on
// for release. (False positives are tuned with NSFW_SENSITIVITY, off if set to 0.)
const NSFW_SENSITIVITY = 0.5;
const NSFW_GATE_ENABLED = true;
const NSFW = { enabled: NSFW_GATE_ENABLED, sensitivity: NSFW_SENSITIVITY };

// A ComfyUI node class's object_info, or null when it isn't installed (cached per page)
const nodeInfoCache = new Map();
async function getNodeInfo(nodeClass) {
  if (!nodeInfoCache.has(nodeClass)) {
    const response = await chrome.runtime.sendMessage({ action: 'comfyRequest', url: `/object_info/${encodeURIComponent(nodeClass)}`, method: 'GET' });
    nodeInfoCache.set(nodeClass, (response.success && response.data[nodeClass]) || null);
  }
  return nodeInfoCache.get(nodeClass);
}

async function isNodeAvailable(nodeClass) {
  return Boolean(await getNodeInfo(nodeClass));
}

// Build the workflow selected in settings, for the user's own ComfyUI (local mode)
async function buildWorkflow(targetImage, settings, imageSize) {
  const workflow = effectiveWorkflow(settings);
  if (!SHARED_WORKFLOWS.includes(workflow) && !isCustomWorkflow(workflow)) {
    throw new Error(NOT_LOCAL_WORKFLOW_ERROR);
  }
  // Fail closed: without comfyui-tooling-nodes' filter to check for adult content, nothing is processed
  if (NSFW_GATE_ENABLED && !await isNodeAvailable(NSFW_CHECK_NODE)) {
    nodeInfoCache.delete(NSFW_CHECK_NODE); // re-check next time in case it gets installed
    throw new Error('img2img needs comfyui-tooling-nodes in ComfyUI to check images for adult content: install it and restart ComfyUI');
  }
  if (isCustomWorkflow(workflow)) {
    if (!settings.customWorkflow) {
      throw new Error(CUSTOM_WORKFLOW_MISSING_ERROR);
    }
    return buildCustomWorkflow(settings.customWorkflow, targetImage, settings.customWorkflowValues, NSFW, await customSourceImages(settings));
  }
  // The shared builders don't talk to ComfyUI: look up the one node they need to know about first
  const preprocessor = settings.controlnetPreprocessor || CONTROLNET_DEFAULT_PREPROCESSOR;
  const nodes = workflow === 'controlnet' ? { [preprocessor]: await getNodeInfo(preprocessor) } : {};
  if (workflow === 'controlnet' && !nodes[preprocessor]) {
    nodeInfoCache.delete(preprocessor); // re-check next time in case it gets installed
  }
  return buildSharedWorkflow(workflow, targetImage, settings, imageSize, { nodeInfo: nodeClass => nodes[nodeClass] || null, nsfw: NSFW });
}

// The images for a custom workflow's source inputs, { node: [base64, ...] }: each picker's source (picked in the
// popup, or the one selected in its grid), shared out to its Load Image nodes (sourceImagesByNode)
async function customSourceImages(settings) {
  const images = {};
  for (const group of sourceGroups(settings.customWorkflow)) {
    const sourceId = settings.customWorkflowValues?.[`source:${group.key}`] || selectedFaceId;
    const face = sourceId ? await getFace(sourceId).catch(() => null) : null;
    const dataUrls = face?.dataUrls || (face?.dataUrl ? [face.dataUrl] : []);
    images[group.key] = dataUrls.map(dataUrl => dataUrl.slice(dataUrl.indexOf(',') + 1));
  }
  return sourceImagesByNode(settings.customWorkflow, key => images[key]);
}

// A built-in workflow that doesn't run on the user's own ComfyUI
const NOT_LOCAL_WORKFLOW_ERROR = "This workflow isn't available on your ComfyUI: pick another one in the popup";
const TERMS_NOT_AGREED_ERROR = "Agree to img2img's terms in the popup first (My ComfyUI)";
const CUSTOM_WORKFLOW_ON_SERVER_ERROR = 'My workflows run on your own ComfyUI: set Processing to My ComfyUI in the popup';
const CUSTOM_WORKFLOW_MISSING_ERROR = 'This workflow was deleted: pick another one in the popup';

// Download buttons over swapped images, keyed by image, each with a toggle under it that shows the original
// image or the result, and a button that compares the two side by side in a new tab. One animation-frame loop
// keeps them all pinned to their image's top-right corner.
const downloadButtons = new Map();
const revertButtons = new Map();
const compareButtons = new Map();
// Images toggled back to their original, with the result to switch back to
const revertedResults = new Map();
const DOWNLOAD_BUTTON_SIZE = 32;
const REVERT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h11a5 5 0 0 1 0 10H9"/><path d="M8 5L4 9l4 4"/></svg>';
const COMPARE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/></svg>';
const RESULT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 9H9a5 5 0 0 0 0 10h6"/><path d="M16 5l4 4-4 4"/></svg>';

function addDownloadButton(imgElement) {
  if (downloadButtons.has(imgElement)) {
    // Re-processed: the image shows a new result, so its downloaded state has to be checked again
    revertedResults.delete(imgElement);
    updateRevertButton(imgElement);
    refreshDownloadButtonStates();
    return;
  }
  const button = createOverlayButton('img2img-download', 'Download processed image', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>', () => downloadSwappedImage(imgElement));
  downloadButtons.set(imgElement, button);
  revertButtons.set(imgElement, createOverlayButton('img2img-revert', '', '', () => toggleOriginal(imgElement)));
  updateRevertButton(imgElement);
  compareButtons.set(imgElement, createOverlayButton('img2img-compare', 'Compare with the original, side by side', COMPARE_ICON, () => compareWithOriginal(imgElement)));
  refreshDownloadButtonStates();
  if (downloadButtons.size === 1) {
    requestAnimationFrame(positionDownloadButtons);
  }
}

// Switch a processed image between its original and the result
function toggleOriginal(imgElement) {
  if (revertedResults.has(imgElement)) {
    setImageSrc(imgElement, revertedResults.get(imgElement));
    revertedResults.delete(imgElement);
  } else {
    revertedResults.set(imgElement, imageSrc(imgElement));
    setImageSrc(imgElement, imgElement.getAttribute('data-original-src'));
  }
  updateRevertButton(imgElement);
}

// Open the original and the result side by side in a new tab (compare.html). The background script holds the
// two images for it, since they're too large for a tab URL. The original is read the same way as for
// processing, so images from other sites and blob: URLs work too.
async function compareWithOriginal(imgElement) {
  const result = revertedResults.get(imgElement) || imageSrc(imgElement);
  try {
    const blob = await fetchImageBlob(imgElement.getAttribute('data-original-src'));
    const original = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const response = await chrome.runtime.sendMessage({ action: 'openCompareTab', original, result, name: await nameOfResult(result) });
    if (!response?.success) {
      throw new Error(response?.error || 'the comparison tab could not be opened');
    }
  } catch (error) {
    showPageError(`Couldn't compare: ${error.message}`);
  }
}

function updateRevertButton(imgElement) {
  const button = revertButtons.get(imgElement);
  const reverted = revertedResults.has(imgElement);
  button.title = reverted ? 'Show processed image' : 'Show original image';
  setIcon(button, reverted ? RESULT_ICON : REVERT_ICON);
}

// Puts one of the SVG icon strings above into a button, parsed as SVG rather than set as innerHTML
function setIcon(button, icon) {
  if (!icon) {
    button.replaceChildren();
    return;
  }
  const svg = new DOMParser().parseFromString(icon.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), 'image/svg+xml');
  button.replaceChildren(document.importNode(svg.documentElement, true));
}

// A round button over an image, kept out of the page's own click handling
function createOverlayButton(className, title, icon, onClick) {
  const button = document.createElement('button');
  button.className = className;
  button.title = title;
  setIcon(button, icon);
  Object.assign(button.style, {
    position: 'fixed',
    width: `${DOWNLOAD_BUTTON_SIZE}px`,
    height: `${DOWNLOAD_BUTTON_SIZE}px`,
    padding: '0',
    margin: '0',
    border: 'none',
    borderRadius: '50%',
    background: 'rgba(0, 0, 0, 0.6)',
    color: '#fff',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: '2147483647'
  });
  button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = 'rgba(52, 113, 219, 0.9)'; });
  button.addEventListener('mouseleave', () => { button.style.background = 'rgba(0, 0, 0, 0.6)'; });
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  document.documentElement.appendChild(button);
  return button;
}

// Fingerprint of a result image, used to remember which results were downloaded (same as background.js)
function resultKey(dataUrl) {
  let hash = 5381;
  for (let i = 0; i < dataUrl.length; i++) {
    hash = ((hash << 5) + hash + dataUrl.charCodeAt(i)) | 0;
  }
  return `${dataUrl.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

// Grey out (but keep showing) the download button of every result that has been downloaded before
function refreshDownloadButtonStates() {
  chrome.storage.local.get('downloadedResults', ({ downloadedResults = [] }) => {
    for (const [imgElement, button] of downloadButtons) {
      const src = imageSrc(imgElement);
      if (!src.startsWith('data:')) continue;
      if (button.dataset.src !== src) {
        button.dataset.src = src;
        button.dataset.resultKey = resultKey(src);
      }
      const downloaded = downloadedResults.includes(button.dataset.resultKey);
      button.disabled = downloaded;
      button.title = downloaded ? 'Already downloaded' : 'Download processed image';
      button.style.opacity = downloaded ? '0.45' : '1';
      button.style.cursor = downloaded ? 'default' : 'pointer';
    }
  });
}
chrome.storage.onChanged.addListener(changes => {
  if (changes.downloadedResults && downloadButtons.size > 0) {
    refreshDownloadButtonStates();
  }
});

// The part of an element that's on screen ({ top, right, width, height }): inside the window and every ancestor
// that clips its overflow, like a carousel that keeps its other slides beside the visible one, clipped away
function visibleRect(element) {
  const rect = element.getBoundingClientRect();
  let left = Math.max(rect.left, 0);
  let top = Math.max(rect.top, 0);
  let right = Math.min(rect.right, window.innerWidth);
  let bottom = Math.min(rect.bottom, window.innerHeight);
  // (up to <body>: its overflow, and <html>'s, applies to the window)
  for (let ancestor = parentOf(element); ancestor && ancestor !== document.body && right > left && bottom > top; ancestor = parentOf(ancestor)) {
    const style = getComputedStyle(ancestor);
    if (style.overflowX === 'visible' && style.overflowY === 'visible') continue;
    const clip = ancestor.getBoundingClientRect();
    if (style.overflowX !== 'visible') {
      left = Math.max(left, clip.left);
      right = Math.min(right, clip.right);
    }
    if (style.overflowY !== 'visible') {
      top = Math.max(top, clip.top);
      bottom = Math.min(bottom, clip.bottom);
    }
  }
  return { top, right, width: Math.max(0, right - left), height: Math.max(0, bottom - top) };
}

// Whether something else (a modal, a menu) covers an image's visible part, checked where its buttons go and at its
// centre: the buttons are on top of everything, so they'd show through
function isCovered(imgElement, rect) {
  const buttonPoint = [rect.right - 8 - DOWNLOAD_BUTTON_SIZE / 2, rect.top + 8 + DOWNLOAD_BUTTON_SIZE / 2];
  const centre = [rect.right - rect.width / 2, rect.top + rect.height / 2];
  const options = { backgrounds: imgElement.tagName !== 'IMG' };
  return imageAt(...buttonPoint, options) !== imgElement && imageAt(...centre, options) !== imgElement;
}

function positionDownloadButtons() {
  for (const [imgElement, button] of downloadButtons) {
    const revertButton = revertButtons.get(imgElement);
    const compareButton = compareButtons.get(imgElement);
    if (!imgElement.isConnected) {
      button.remove();
      revertButton.remove();
      compareButton.remove();
      downloadButtons.delete(imgElement);
      revertButtons.delete(imgElement);
      compareButtons.delete(imgElement);
      revertedResults.delete(imgElement);
      continue;
    }
    // Only while the image still shows our result or its toggled-back original (sites may swap src back),
    // and enough of it is on screen. The download button only shows with the result.
    const src = imageSrc(imgElement);
    const showsResult = src.startsWith('data:');
    const showsOriginal = revertedResults.has(imgElement) && src === imgElement.getAttribute('data-original-src');
    const rect = (showsResult || showsOriginal) ? visibleRect(imgElement) : null;
    const visible = Boolean(rect) && rect.width >= 64 && rect.height >= 64 && !isCovered(imgElement, rect);
    // (inline display would override the hidden attribute)
    button.style.display = visible && showsResult ? 'flex' : 'none';
    revertButton.style.display = visible ? 'flex' : 'none';
    compareButton.style.display = visible ? 'flex' : 'none';
    if (visible) {
      const left = `${rect.right - 8 - DOWNLOAD_BUTTON_SIZE}px`;
      button.style.top = `${rect.top + 8}px`;
      button.style.left = left;
      revertButton.style.top = `${rect.top + 8 + DOWNLOAD_BUTTON_SIZE + 6}px`;
      revertButton.style.left = left;
      compareButton.style.top = `${rect.top + 8 + 2 * (DOWNLOAD_BUTTON_SIZE + 6)}px`;
      compareButton.style.left = left;
    }
  }
  if (downloadButtons.size > 0) {
    requestAnimationFrame(positionDownloadButtons);
  }
}

// Open a cached result in a background tab (permanent "Open Results in New Tab" setting); processed results are opened
// by background.js when their job finishes. The result is read from the cache by hash, since data URLs are too long for
// tab URLs: in viewer.html, or in incognito on the original image URL with a #img2img-result marker (see
// showResultFromUrlMarker).
function openResultInNewTab(settings, imageHash, imageUrl, name) {
  // On a direct .jpg/.png URL the swapped image already is the whole page, so another tab adds nothing
  if (!settings.openResultsInNewTab || isImagePage()) {
    return;
  }
  chrome.runtime.sendMessage({ action: 'openResultTab', hash: imageHash, name, imageUrl });
}

function isImagePage() {
  return Boolean(document.contentType?.startsWith('image/'));
}

// Short names of the built-in workflows, for download names (the user's own workflows use their name)
const WORKFLOW_FILE_NAMES = {
  controlnet: 'ControlNet',
  upscale: 'Upscale',
  background: 'Background',
  restore: 'Face restore',
};

// Base name for downloads: "<start of the page title>-<workflow>-<face name>". Page titles can be long, so only
// the first few words are kept. Result tabs carry the name over from the page in an img2img-name marker.
// Processing passes the settings it used, so the name is the one the result was made with (see resultNames).
async function resultBaseName(processedWith = null) {
  const markerName = location.hash.match(/img2img-name=([^&]+)/)?.[1];
  if (markerName) {
    return decodeURIComponent(markerName);
  }
  const clean = text => (text || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
  let title = clean(document.title);
  if (title.length > 40) {
    title = title.slice(0, 40).replace(/\s+\S*$/, '') || title.slice(0, 40);
  }
  // The source's name, when the workflow uses one: the source selected in the grid, or for one of the user's own
  // workflows its first source picker's (the one picked for it, else the one selected in the grid)
  let workflowName = '';
  let faceName = '';
  try {
    const settings = processedWith || await getSettings();
    const workflow = effectiveWorkflow(settings);
    workflowName = clean(isCustomWorkflow(workflow) ? settings.customWorkflow?.name : WORKFLOW_FILE_NAMES[workflow]);
    const firstPicker = isCustomWorkflow(workflow) ? sourceGroups(settings.customWorkflow)[0] : null;
    const sourceId = FACE_WORKFLOWS.includes(workflow) ? selectedFaceId
      : firstPicker ? settings.customWorkflowValues?.[`source:${firstPicker.key}`] || selectedFaceId
      : null;
    faceName = sourceId ? clean((await getFace(sourceId))?.name) : '';
  } catch (error) {
    // The source was deleted: leave it out
  }
  return [title || location.hostname || 'image', workflowName, faceName].filter(Boolean).join('-').replace(/[. ]+$/, '');
}

// Result tabs opened in incognito point at the original image URL plus "#img2img-result=<hash>": show the
// cached result there, with the download button, and keep automatic processing off this tab
async function showResultFromUrlMarker() {
  const match = location.hash.match(/img2img-result=([^&]+)/);
  if (!match) {
    return;
  }
  isResultTab = true;
  // The marker's result, or else the latest one for this image: re-processing replaces older results, so
  // after a re-process in this tab, a reload shows the new result
  const result = await getFromCache(decodeURIComponent(match[1]), location.href, true);
  // On a direct image URL Chrome shows a single <img>; otherwise use the largest image on the page
  const img = Array.from(document.images).sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
  if (!result || !img) {
    showPageError('This result is no longer in the img2img cache.');
    return;
  }
  img.setAttribute('data-original-src', img.src);
  img.src = result;
  addDownloadButton(img);
}

// Save the swapped image as "<page title>-<workflow>-<face name>-img2img.<ext>"
// Downloads go through chrome.downloads in the background script: an <a download> click started from the
// content script's isolated world is unreliable (Chrome sometimes drops it, Edge always does).
async function downloadSwappedImage(imgElement) {
  const dataUrl = imageSrc(imgElement);
  const mimeType = dataUrl.match(/^data:([^;,]+)/)?.[1] || 'image/png';
  const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
  const filename = `${await nameOfResult(dataUrl)}-img2img.${extension}`;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl, filename });
    if (!response?.success) {
      throw new Error(response?.error || 'Download failed');
    }
  } catch (error) {
    // After the extension is reloaded, this page's content script can't reach the background anymore
    const contextLost = !chrome.runtime?.id || /context invalidated/i.test(error.message);
    showPageError(contextLost
      ? 'img2img was updated. Refresh this page to download images.'
      : `Download failed: ${error.message}`);
  }
}

// Show a loading spinner over the image's top-left corner. It's fixed-position and follows the image
// every frame, so it stays put through scrolling, resizing and centred layouts (e.g. Chrome's viewer
// for direct .jpg/.png URLs) without touching the page's own layout. Returns the spinner to remove later; its
// setProgress(percent) draws a ring around it (jobs on the user's ComfyUI report their progress).
function showSpinner(imgElement) {
  const spinner = document.createElement('div');
  spinner.className = 'img2img-spinner';
  const mark = document.createElement('img');
  mark.src = chrome.runtime.getURL('icons/spinner.svg'); // the animated logo mark
  mark.alt = '';
  Object.assign(mark.style, { display: 'block', width: '100%', height: '100%', margin: '0', padding: '0', border: 'none', maxWidth: 'none' });
  spinner.appendChild(mark);

  const svgNS = 'http://www.w3.org/2000/svg';
  const ring = document.createElementNS(svgNS, 'svg');
  ring.setAttribute('viewBox', '0 0 44 44');
  Object.assign(ring.style, { position: 'absolute', inset: '0', width: '100%', height: '100%', transform: 'rotate(-90deg)', display: 'none' });
  const RADIUS = 20.5;
  const circumference = 2 * Math.PI * RADIUS;
  const circle = (color) => {
    const element = document.createElementNS(svgNS, 'circle');
    Object.entries({ cx: 22, cy: 22, r: RADIUS, fill: 'none', stroke: color, 'stroke-width': 3 }).forEach(([name, value]) => element.setAttribute(name, value));
    ring.appendChild(element);
    return element;
  };
  circle('rgba(22, 101, 52, 0.15)');
  const arc = circle('#16a34a');
  arc.setAttribute('stroke-linecap', 'round');
  arc.setAttribute('stroke-dasharray', String(circumference));
  arc.setAttribute('stroke-dashoffset', String(circumference));
  arc.style.transition = 'stroke-dashoffset 0.3s ease-out';
  spinner.appendChild(ring);
  spinner.setProgress = percent => {
    ring.style.display = 'block';
    arc.setAttribute('stroke-dashoffset', String(circumference * (1 - percent / 100)));
  };

  Object.assign(spinner.style, {
    position: 'fixed',
    width: '44px',
    height: '44px',
    boxSizing: 'border-box',
    padding: '4px',
    margin: '0',
    border: 'none',
    maxWidth: 'none',
    background: 'rgba(255, 255, 255, 0.9)',
    borderRadius: '50%',
    boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
    pointerEvents: 'none',
    zIndex: '2147483647'
  });
  document.documentElement.appendChild(spinner);

  const followImage = () => {
    if (!spinner.isConnected) {
      return;
    }
    const rect = imgElement.getBoundingClientRect();
    spinner.hidden = !imgElement.isConnected || rect.width === 0;
    spinner.style.top = `${rect.top + 10}px`;
    spinner.style.left = `${rect.left + 10}px`;
    requestAnimationFrame(followImage);
  };
  followImage();
  return spinner;
}

// Download base names of the results shown on this page, by result: worked out when the image was processed (or
// swapped in from the cache), so changing the workflow or source afterwards doesn't rename them
const resultNames = new Map();

async function nameOfResult(result) {
  return resultNames.get(result) || resultBaseName();
}

// Show a result in a page image, keeping its original's URL. Responsive images (srcset, or <picture> sources)
// would keep showing the page's own candidates over src, so those are dropped (toggleOriginal shows src)
function showResult(imgElement, url, name) {
  if (name) {
    resultNames.set(url, name);
  }
  if (!imgElement.getAttribute('data-original-src')) {
    imgElement.setAttribute('data-original-src', lazySourceUrl(imgElement) || imageSrc(imgElement));
  }
  if (imgElement.tagName === 'IMG') {
    imgElement.removeAttribute('srcset');
    imgElement.removeAttribute('sizes');
    if (imgElement.parentElement?.tagName === 'PICTURE') {
      imgElement.parentElement.querySelectorAll('source').forEach(source => source.removeAttribute('srcset'));
    }
    pageResults.set(imgElement.getAttribute('data-original-src'), url);
  }
  setImageSrc(imgElement, url);
}

// Lazy-loaded images show a placeholder (an empty src, a data: URL or a 1-pixel image) until they scroll into
// view, with the real picture in one of these attributes
const LAZY_SOURCE_ATTRIBUTES = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];

function lazySourceUrl(imgElement) {
  if (imgElement.tagName !== 'IMG' || imgElement.hasAttribute('data-original-src')) return '';
  const placeholder = !imgElement.src || imgElement.src.startsWith('data:') || (imgElement.complete && imgElement.naturalWidth <= 2);
  const lazy = placeholder && LAZY_SOURCE_ATTRIBUTES.map(name => imgElement.getAttribute(name)).find(value => value?.trim());
  return lazy ? new URL(lazy.trim(), document.baseURI).href : '';
}

// The URL whose image gets processed, which is also the cache's image URL key
function getSourceUrl(imgElement) {
  let imageUrl = lazySourceUrl(imgElement) || imageSrc(imgElement);
  // If the image had been previously processed we need to grab the data-original-src
  if (imgElement.getAttribute('data-original-src')) {
    imageUrl = imgElement.getAttribute('data-original-src');
  }
  // Check if the image ancestor is a link, if so, get the link's href if it is a valid image url
  let link = imgElement.parentElement;
  while (link && link.tagName !== 'A') {
    link = link.parentElement;
  }
  if (link && (link.href.endsWith('.jpg') || link.href.endsWith('.png') || link.href.endsWith('.jpeg'))) {
    imageUrl = link.href;
  }
  return imageUrl;
}

// Download the page image. The content script's fetch runs under the page's CORS rules, so images from other
// sites (CDNs) without CORS headers fail there (and Chrome logs a CORS error); background.js can fetch any
// URL. Other-site images therefore go through the background first, while same-site, data: and blob: URLs
// (which only the page can read) use the page fetch. Each falls back to the other.
async function fetchImageBlob(imageUrl) {
  const fromPage = async () => {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.blob();
  };
  const fromBackground = async () => {
    const response = await chrome.runtime.sendMessage({ action: 'fetchImage', url: imageUrl });
    if (!response?.success) {
      throw new Error(response?.error || 'fetch failed');
    }
    // Decode directly: fetch() of a data: URL can be blocked by the page's CSP
    const [header, data] = response.dataUrl.split(',');
    const mimeType = header.match(/^data:([^;,]+)/)?.[1] || 'application/octet-stream';
    return new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: mimeType });
  };

  const url = new URL(imageUrl, location.href);
  const otherSite = /^https?:$/.test(url.protocol) && url.origin !== location.origin;
  const [first, second] = otherSite ? [fromBackground, fromPage] : [fromPage, fromBackground];
  let blob;
  try {
    blob = await first();
  } catch (firstError) {
    try {
      blob = await second();
    } catch (secondError) {
      throw new Error(`Couldn't load this image (${firstError.message})`);
    }
  }
  if (await isSvgBlob(blob)) return svgToPng(blob);
  return (await isProcessableBitmap(blob)) ? blob : bitmapToPng(blob);
}

// Bytes as text (for file signatures), read one by one: in Firefox the bytes belong to the page, and slice() or
// subarray() would read their constructor, which a content script isn't allowed to
function bytesText(bytes, start, end) {
  let text = '';
  for (let i = start; i < Math.min(end, bytes.length); i++) text += String.fromCharCode(bytes[i]);
  return text;
}

// Formats the API and ComfyUI read, by their first bytes (a server's Content-Type can be wrong)
async function isProcessableBitmap(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 16).arrayBuffer());
  const text = (start, end) => bytesText(bytes, start, end);
  return (bytes[0] === 0x89 && text(1, 4) === 'PNG') // also APNG
    || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) // JPEG
    || text(0, 4) === 'GIF8'
    || text(0, 2) === 'BM'
    || (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP')
    || (text(4, 8) === 'ftyp' && ['avif', 'avis'].includes(text(8, 12)));
}

// Other formats the browser can show (ICO, and TIFF, HEIC or JPEG XL where it supports them) are drawn into a PNG
async function bitmapToPng(blob) {
  const blobUrl = URL.createObjectURL(blob);
  try {
    const image = await loadImage(blobUrl).catch(() => {
      const format = blob.type.replace(/^image\//, '').toUpperCase();
      throw new Error(format ? `This browser can't read ${format} images` : "This isn't an image in a format this browser can read");
    });
    return await drawToPng(image, image.naturalWidth, image.naturalHeight);
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('blocked'));
    image.src = url;
  });
}

async function drawToPng(image, width, height) {
  if (!width || !height) {
    throw new Error("Couldn't read this image");
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!png) {
    throw new Error("Couldn't convert this image");
  }
  return png;
}

// Animated GIFs, WebPs and PNGs: only their first frame is processed
async function isAnimated(blob) {
  const bytes = new Uint8Array(await blob.slice(0, 1024 * 1024).arrayBuffer());
  const text = (start, end) => bytesText(bytes, start, end);
  if (text(0, 4) === 'GIF8') {
    // Each frame starts with a graphic control extension (21 F9 04)
    let frames = 0;
    for (let i = 0; i < bytes.length - 2 && frames < 2; i++) {
      if (bytes[i] === 0x21 && bytes[i + 1] === 0xf9 && bytes[i + 2] === 0x04) frames++;
    }
    return frames > 1;
  }
  if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
    return text(12, 16) === 'VP8X' && Boolean(bytes[20] & 0x02);
  }
  if (bytes[0] === 0x89 && text(1, 4) === 'PNG') {
    // An APNG has an acTL chunk before its image data
    const head = text(0, Math.min(bytes.length, 4096));
    const animation = head.indexOf('acTL');
    return animation !== -1 && (head.indexOf('IDAT') === -1 || animation < head.indexOf('IDAT'));
  }
  return false;
}

// SVG images are drawn into a PNG first: the API and ComfyUI only take bitmaps. Vector art has no fixed pixel size,
// so its longest side is drawn at its own size kept between SVG_MIN_SIDE and SVG_MAX_SIDE.
const SVG_MIN_SIDE = 1024;
const SVG_MAX_SIDE = 2048;

async function isSvgBlob(blob) {
  if (blob.type === 'image/svg+xml') return true;
  if (blob.type.startsWith('image/')) return false;
  // Some servers send SVG as text/xml, text/plain or with no type
  return /<svg[\s>]/i.test(await blob.slice(0, 1024).text());
}

async function svgToPng(blob) {
  const svg = new DOMParser().parseFromString(await blob.text(), 'image/svg+xml').documentElement;
  if (svg.localName !== 'svg') {
    throw new Error("Couldn't read this SVG image");
  }
  // Its size: width and height in pixels, else the viewBox's (also for the missing one of the two), else the
  // 300 × 150 that browsers give an SVG without one
  const pixels = name => Number(/^\s*([\d.]+)(px)?\s*$/.exec(svg.getAttribute(name) || '')?.[1]) || 0;
  const [, , boxWidth, boxHeight] = (svg.getAttribute('viewBox') || '').trim().split(/[\s,]+/).map(Number);
  let width = pixels('width');
  let height = pixels('height');
  if (boxWidth > 0 && boxHeight > 0) {
    if (!width && !height) [width, height] = [boxWidth, boxHeight];
    else if (!height) height = width * boxHeight / boxWidth;
    else if (!width) width = height * boxWidth / boxHeight;
  }
  if (!(width > 0 && height > 0)) [width, height] = [300, 150];
  const longest = Math.max(width, height);
  const scale = Math.min(SVG_MAX_SIDE, Math.max(SVG_MIN_SIDE, longest)) / longest;
  const [outWidth, outHeight] = [Math.round(width * scale), Math.round(height * scale)];
  // Without a viewBox, a larger width and height would crop the drawing instead of scaling it
  if (!svg.hasAttribute('viewBox')) svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('width', outWidth);
  svg.setAttribute('height', outHeight);

  const source = new XMLSerializer().serializeToString(svg);
  // A blob: URL first; the page's CSP may only allow data: images
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'image/svg+xml' }));
  let image;
  try {
    image = await loadImage(blobUrl).catch(() => loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(source)}`));
  } catch {
    throw new Error("Couldn't draw this SVG image: the site doesn't allow it");
  } finally {
    URL.revokeObjectURL(blobUrl);
  }
  return drawToPng(image, outWidth, outHeight);
}

async function getImageHash(imgElement) {
  // Get the image data
  const imageUrl = getSourceUrl(imgElement);
  const imageBlob = await fetchImageBlob(imageUrl);
  const base64Image = await blobToBase64(imageBlob);
  const imageSize = await getBlobSize(imageBlob, imgElement);

  // Get settings from storage
  const settings = await getSettings();

  // Generate hash including settings
  const imageHash = hashBase64(base64Image, settings);
  return [imageHash, base64Image, imageSize, settings, imageUrl, imageBlob];
}

async function swapImage(imgElement, cacheOnly = false, allowLooseCacheLink = false) {
  let imageUpdated = false;
  const spinner = cacheOnly ? null : showSpinner(imgElement);
  swapsInProgress += cacheOnly ? 0 : 1;
  try {
    let [imageHash, base64Image, imageSize, settings, imageUrl, imageBlob] = await getImageHash(imgElement);
    const name = await resultBaseName(settings);
      // make sure this image is not in a container with class 'img-blur'
    let container = imgElement.parentElement;
    while (container && !container.classList.contains('img-blur') && !container.classList.contains('img-back')) {
      container = container.parentElement;
    }
    if (container) {
      return;
    }
    
    // Check cache first
    const cachedResult = await getFromCache(imageHash, imageUrl, allowLooseCacheLink);
    if (cachedResult) {
      showResult(imgElement, cachedResult, name);
      imageUpdated = true;
      addDownloadButton(imgElement);
      if (!cacheOnly) {
        openResultInNewTab(settings, imageHash, imageUrl, name);
      }
      return;
    } else if (cacheOnly) {
      return;
    }

    const usesFace = FACE_WORKFLOWS.includes(effectiveWorkflow(settings));
    if (usesFace && !processesOnServer(settings)) {
      throw new Error(NOT_LOCAL_WORKFLOW_ERROR);
    }
    if (isCustomWorkflow(settings.workflow) && processesOnServer(settings)) {
      throw new Error(CUSTOM_WORKFLOW_ON_SERVER_ERROR);
    }
    // My ComfyUI users have no account: they agree to the terms in the popup (hosted users did at sign-up)
    if (!processesOnServer(settings) && settings.termsAgreedVersion !== TERMS_VERSION) {
      throw new Error(TERMS_NOT_AGREED_ERROR);
    }
    if (await isAnimated(imageBlob)) {
      showPageNotice('This image is animated: only its first frame is processed, so the result is a still image.');
    }
    // Get the selected source from IndexedDB (only the workflows with a source face use one)
    const face = usesFace ? await getFace(selectedFaceId) : { dataUrls: [] };
    if (!face) {
      throw new Error('Selected face not found');
    }

    const result = processesOnServer(settings)
      ? await processOnServer(face.dataUrls, base64Image, settings, imageHash, imageUrl, name)
      : await processOnComfyUI(base64Image, settings, imageSize, imageHash, imageUrl, name, spinner.setProgress);

    showResult(imgElement, result.data, name);
    imageUpdated = true;
    addDownloadButton(imgElement);
  } catch (error) {
    // The user sees the error on the page (NSFW refusals, credits, server errors), so it isn't logged as an
    // error too: that would fill the extension's error list on chrome://extensions
    console.debug('img2img: processing failed:', error);
    if (!imageUpdated) {
      showPageError(error.message === 'Failed to fetch' ? await unreachableServerMessage() : error.message);
    }
  } finally {
    spinner?.remove();
    swapsInProgress -= cacheOnly ? 0 : 1;
  }
}

// Local processing: build the workflow here; background.js runs it on the user's own ComfyUI
async function processOnComfyUI(base64Image, settings, imageSize, hash, imageUrl, name, onProgress) {
  const workflow = await buildWorkflow(base64Image, settings, imageSize);
  // The NSFW checks' probes, read before the result is shown
  const probes = safetyProbes(workflow).map(probe => ({ ...probe, refusal: nsfwRefusal(probe.label) }));
  return runJob({ kind: 'comfy', workflow, probes, output: resultNode(workflow), hash, imageUrl, name }, onProgress);
}

// Hosted processing: the img2img server builds the workflow from the settings, runs it on its GPU provider and keeps
// the result until background.js collects it. The server measures the image itself and ignores settings it doesn't know.

// Images go to the img2img server unless the user chose their own ComfyUI (Processing: My ComfyUI)
function processesOnServer(settings) {
  return settings.processingMode !== 'local';
}

async function processOnServer(sourceImages, base64Image, settings, hash, imageUrl, name) {
  return runJob({ kind: 'server', body: { workflow: settings.workflow, settings, image: base64Image, sourceImages }, hash, imageUrl, name });
}

// Hand a job to background.js, which runs it to the end (see its JOB_PORT) and answers { data }: the result (and, for
// jobs on the user's ComfyUI, { progress } as it goes: a percentage, passed to onProgress). The port
// closes with the page, which tells background.js to cancel the page's jobs (or to finish them and open the results in
// new tabs, when that setting is on).
let jobPort = null;
let nextJobId = 0;
const pendingJobs = new Map();

async function runJob(job, onProgress) {
  job.name ??= await resultBaseName();
  job.isImagePage = isImagePage();
  if (!jobPort) {
    jobPort = chrome.runtime.connect({ name: 'img2img-jobs' });
    jobPort.onMessage.addListener(({ id, data, error, progress }) => {
      const pending = pendingJobs.get(id);
      if (progress !== undefined) {
        pending?.onProgress?.(progress);
        return;
      }
      pendingJobs.delete(id);
      if (error === undefined) {
        pending?.resolve({ data });
      } else {
        pending?.reject(new Error(error));
      }
    });
    jobPort.onDisconnect.addListener(() => {
      void chrome.runtime.lastError; // (read so Chrome doesn't log it as unchecked, e.g. after the back/forward cache)
      jobPort = null;
      const message = chrome.runtime?.id ? 'img2img stopped before the image was done' : 'img2img was updated. Refresh this page to process images.';
      pendingJobs.forEach(pending => pending.reject(new Error(message)));
      pendingJobs.clear();
    });
  }
  const id = ++nextJobId;
  return new Promise((resolve, reject) => {
    pendingJobs.set(id, { resolve, reject, onProgress });
    jobPort.postMessage({ id, job });
  });
}

// Leaving the page cancels its images still processing, so the browser asks first. Not when results open in new tabs:
// those finish anyway and open there.
let swapsInProgress = 0;
let resultsOpenInNewTabs = false;
chrome.storage.local.get('openResultsInNewTab', result => { resultsOpenInNewTabs = result.openResultsInNewTab === true; });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.openResultsInNewTab) {
    resultsOpenInNewTabs = changes.openResultsInNewTab.newValue === true;
  }
});
window.addEventListener('beforeunload', event => {
  if (swapsInProgress > 0 && !resultsOpenInNewTabs) {
    event.preventDefault();
    event.returnValue = ''; // (older Chrome versions only ask when this is set)
  }
});

// The error shown when the server images go to can't be reached
async function unreachableServerMessage() {
  const settings = await chrome.storage.local.get('processingMode');
  if (processesOnServer(settings)) {
    return "Can't reach the img2img server";
  }
  return `Can't reach ComfyUI at ${await getComfyServerAddress()}`;
}

// Helper to get the dimensions of the fetched image (Blobs have no width/height)
async function getBlobSize(blob, imgElement) {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch (error) {
    // Fall back to the on-page image's natural size (or a background's size on the page)
    const rect = imgElement.getBoundingClientRect();
    return imgElement.tagName === 'IMG' ? { width: imgElement.naturalWidth, height: imgElement.naturalHeight } : { width: Math.round(rect.width), height: Math.round(rect.height) };
  }
}

// Show a short-lived error message on the page
function showPageError(message) {
  showToast(message, '#c62828');
}

// The same for information that isn't an error
function showPageNotice(message) {
  showToast(message, '#323232');
}

function showToast(message, background) {
  let toast = document.getElementById('img2img-error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'img2img-error-toast';
    Object.assign(toast.style, {
      position: 'fixed',
      bottom: '16px',
      right: '16px',
      maxWidth: '360px',
      padding: '10px 14px',
      color: '#fff',
      font: '13px Arial, sans-serif',
      borderRadius: '4px',
      boxShadow: '0 2px 8px rgba(0, 0, 0, 0.3)',
      zIndex: '2147483647'
    });
    (document.body || document.documentElement).appendChild(toast);
  }
  toast.style.background = background;
  // Web addresses in the message (e.g. the site's Credits page when credits run out) become links
  const parts = `img2img: ${message}`.split(/(https?:\/\/[^\s]+[^\s.,;:!?)])/);
  toast.replaceChildren(...parts.map((part, i) => {
    if (i % 2 === 0) return part;
    const link = Object.assign(document.createElement('a'), { href: part, textContent: part, target: '_blank', rel: 'noopener' });
    Object.assign(link.style, { color: '#fff', textDecoration: 'underline', fontWeight: 'bold' });
    return link;
  }));
  clearTimeout(toast.hideTimer);
  toast.hideTimer = setTimeout(() => toast.remove(), parts.length > 1 ? 20000 : 8000);
}

// Helper function to convert blob to base64
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// Function to check if an element is in viewport
function isInViewport(element) {
  const rect = element.getBoundingClientRect();
  const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
  // Make sure at least half of the image height is visible
  const topThreshold = rect.height * 0.5;
  const bottomThreshold = rect.height * 0.5;
  const topPortionVisible = rect.top <= viewportHeight && rect.top > -topThreshold;
  const bottomPortionVisible = rect.bottom <= viewportHeight && rect.bottom > -bottomThreshold;
  
  return (
    topPortionVisible &&
    bottomPortionVisible &&
    rect.left >= 0 &&
    rect.right <= (window.innerWidth || document.documentElement.clientWidth)
  );
}

// Function to check if image meets minimum size requirements
function meetsSizeRequirements(img) {
  return img.naturalWidth >= 300 && img.naturalHeight >= 300;
}

// Workflows that were removed map to their replacement, so a saved choice keeps working
const WORKFLOW_REPLACEMENTS = {};

// The settings the content script reads
const SETTING_KEYS = ['selectedFaceId', 'comfyServerAddress', 'workflow', 'controlnetPreprocessor', 'controlnetResolution', 'controlnetOptions', 'upscaleModel', 'upscaleScale', 'backgroundMode', 'backgroundColor', 'backgroundBlur', 'restoreModel', 'restoreStrength', 'restoreFidelity', 'processingMode', 'openResultsInNewTab', 'customWorkflows', 'customWorkflowValues', 'termsAgreedVersion'];

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(SETTING_KEYS, settings => {
      settings.workflow = WORKFLOW_REPLACEMENTS[settings.workflow] || settings.workflow || DEFAULT_WORKFLOW;
      // Of the user's own workflows, only the selected one and its values (the others never leave storage)
      const customId = customWorkflowId(settings.workflow);
      settings.customWorkflow = customId ? (settings.customWorkflows || []).find(definition => definition.id === customId) : undefined;
      settings.customWorkflowValues = customId ? settings.customWorkflowValues?.[customId] || {} : undefined;
      delete settings.customWorkflows;
      // A restore model that's no longer offered (CodeFormer, GPEN) falls back to the default
      if (settings.restoreModel && !RESTORE_MODELS.includes(settings.restoreModel)) {
        delete settings.restoreModel;
      }
      resolve(settings);
    });
  });
}

// Function to find next available image
async function findNextAvailableImage() {
  const images = allImages();
  // We need to add a hash to the image, but only with the settings that were used to generate the image
  // Here we will check for that hash in the image's class, so we know to skip it if it has been processed
  let settings = await getSettings();
  settingsHash = hashBase64("", settings);

  let nextImage = images.find(img => 
    isInViewport(img) && // Check viewport position each time
    img.getAttribute('data-img2img-settings') !== settingsHash &&
    img.src && 
    meetsSizeRequirements(img)
  );
  if (nextImage) {
    nextImage.setAttribute('data-img2img-settings', settingsHash);
  }
  return nextImage;
}

// Function to process next available image
async function processNextAvailableImage() {
  if (!isContinuousProcessing || isScrolling || isCurrentlyProcessing >= 3 || isResultTab) return; // (isCurrentlyProcessing) temporarily disabled
  
  const nextImage = await findNextAvailableImage();
  if (nextImage) {
    ++isCurrentlyProcessing;
    try {
      await swapImage(nextImage);
    } finally {
      --isCurrentlyProcessing;
    }
  }
}

// Function to start continuous processing
function startContinuousProcessing() {
  isContinuousProcessing = true;
  if (checkInterval) {
    clearInterval(checkInterval);
  }
  checkInterval = setInterval(processNextAvailableImage, 100);
}

// Function to stop continuous processing
function stopContinuousProcessing() {
  isContinuousProcessing = false;
  if (checkInterval) {
    clearInterval(checkInterval);
    checkInterval = null;
  }
}

showResultFromUrlMarker();

// Run Swap Cache as soon as the page is usable instead of waiting for every image to load
// (background.js runs it again on tab load complete to catch images added later)
chrome.storage.local.get(['autoRemember', 'selectedFaceId'], result => {
  if (result.autoRemember) {
    selectedFaceId = result.selectedFaceId;
    replaceCachedImages();
  }
});

// Add scroll event listener
window.addEventListener('scroll', function() {
  isScrolling = true;
  
  // Clear existing timeout
  if (scrollTimeout) {
    clearTimeout(scrollTimeout);
  }
  
  // Set new timeout with shorter delay
  scrollTimeout = setTimeout(function() {
    isScrolling = false;
    // Resume processing if it was active
    if (isContinuousProcessing) {
      processNextAvailableImage();
    }
  }, 50); // Reduced from 100ms to 50ms
}); 