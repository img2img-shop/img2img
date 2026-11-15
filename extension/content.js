let isSelecting = false;
let selectedImage = null;
let selectedSourceId = null;
let isContinuousProcessing = false; // Track continuous processing mode
let checkInterval = null; // For continuous checking
let settingsHash = null;
let isResultTab = false; // this tab shows a result opened via #img2img-result (no automatic processing)
// The Library page (library.html), which loads this script for what it shares with a web page: reading an image, the
// settings, the cache and the job queue. It runs jobs on its own files and keeps their results itself (library.js),
// so nothing here starts on it, by itself or from the popup (see allowedHere), and its jobs say where they are from
// (see runJob).
let isLibrary = false;
// viewer.html: the original of the result it shows, once viewer.js has it, as { image, url, imageUrl, blob }. A job
// on that result runs on the original, as a job on a processed page image does: image is the result's <img>, url
// the blob: URL the tab shows the original from (its data-original-src once a result of ours is on it), imageUrl
// the URL the image's results are cached under, so the new one joins them in the dropdown, and blob the picture.
let resultTabOriginal = null;
// The results this tab has already shown, by their cache hash (the picture with its settings): processing one of them
// again with the same settings finds the same result in the cache, which a result tab doesn't open in another tab
// (see swapImage), and which process again says rather than showing it again (reprocessImage). viewer.html adds the
// result it opened with.
const resultsShownHere = new Set();

const DB_NAME = 'imageSwapCache';
const STORE_NAME = 'images';
const DB_VERSION = 1;
const MAX_CACHE_ENTRIES = 50; // Maximum number of cached images

// Get a source from IndexedDB
// Used by: web pages, the result tab, the Library.
async function getSource(sourceId) {
  try {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'getSource', sourceId }, response => {
        if (response.success) {
          console.log('Retrieved source from DB:', sourceId, response.source);
          resolve(response.source);
        } else {
          console.error('Error retrieving source:', response.error);
          reject(new Error(response.error));
        }
      });
    });
  } catch (error) {
    console.error('Could not read the source:', error);
    throw error;
  }
}

// Listen for messages from the popup
// Site rules (shared/sites.js): "Never Run On" turns img2img off for a page altogether, and "Automatic Only On",
// when it has anything in it, keeps what starts by itself (auto-process, Swap Cache on page load) to those sites.
// Read once into here, and awaited by the rules below, so a message that arrives first still sees them.
const siteRules = { blockedSites: '', automaticSites: '' };
// "A Workflow for a Site" chooses this tab's workflow once, as the page loads: it runs here instead of the popup's
// choice, and the popup shows it as the choice and says a rule made it. The rule doesn't hold it: a workflow picked
// in the popup on this tab (followPopupWorkflow) runs here from then on, until the page is loaded again. Empty
// while the tab runs the popup's choice.
let tabWorkflow = '';
const siteRulesRead = new Promise(resolve => {
  chrome.storage.local.get([...Object.keys(siteRules), 'siteWorkflows'], stored => {
    Object.keys(siteRules).forEach(key => { siteRules[key] = stored[key] || ''; });
    tabWorkflow = img2imgSites.workflowFor(stored.siteWorkflows, location.href);
    resolve();
  });
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  Object.keys(siteRules).filter(key => changes[key]).forEach(key => { siteRules[key] = changes[key].newValue || ''; });
});

// Whether img2img may run here at all, and whether something starting by itself may
const runsHere = () => !img2imgSites.matches(siteRules.blockedSites, location.href);
const automaticRunsHere = () => runsHere()
  && (img2imgSites.patterns(siteRules.automaticSites).length === 0 || img2imgSites.matches(siteRules.automaticSites, location.href));

// Asked for on a site that's off: say so, since nothing visible would happen otherwise. What starts by itself
// (auto: true, from background.js's page-load hook) stays quiet instead: a toast on every page would be worse,
// and the popup says which rule is keeping it quiet on the page in front of it.
//
// Only Never Run On can stop something the user asked for. Automatic Only On is about what starts by itself, so
// a run the user pressed for is past the gate above before there is anything to explain.
async function allowedHere({ auto }) {
  await siteRulesRead;
  if (isLibrary) {
    return false;
  }
  if (auto ? automaticRunsHere() : runsHere()) {
    return true;
  }
  if (!auto) {
    showPageNotice('img2img is off on this site (Never Run On, in the img2img settings).');
  }
  return false;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'startSelection') {
    selectedSourceId = request.selectedSourceId;
    allowedHere(request).then(allowed => allowed && startImageSelection());
  } else if (request.action === 'stopSelection') {
    stopImageSelection();
  } else if (request.action === 'selectAllVisible') {
    selectedSourceId = request.sourceId;
    allowedHere(request).then(allowed => allowed && startContinuousProcessing());
  } else if (request.action === 'autoRemember') {
    selectedSourceId = request.sourceId;
    allowedHere(request).then(allowed => allowed && replaceCachedImages());
  } else if (request.action === 'stopContinuousProcessing') {
    stopContinuousProcessing();
  } else if (request.action === 'queueCleared') {
    // The popup cleared the queue (background.js has dropped this tab's waiting jobs): the images still being got
    // ready don't join it, and Automatic Selection stops, or it would pick them all again
    queueClears++;
    if (isContinuousProcessing) {
      stopContinuousProcessing();
      chrome.storage.local.set({ isProcessing: false }); // (so the popup's button isn't still "Stop Processing")
    }
  } else if (request.action === 'runWorkflowOnImage') {
    allowedHere(request).then(allowed => allowed && runWorkflowOnRightClickedImage(request));
  } else if (request.action === 'downloadRightClicked') {
    allowedHere(request).then(allowed => allowed && downloadRightClickedImage(request));
  } else if (request.action === 'countAutomaticImages') {
    countAutomaticImages().then(count => sendResponse({ count }));
    return true; // the answer comes after the settings have been read
  } else if (request.action === 'followPopupWorkflow') {
    // A workflow picked in the popup on this tab: it runs here over the one a site rule chose when the page loaded
    tabWorkflow = '';
  } else if (request.action === 'checkProcessingStatus') {
    // Send back this tab's state: Automatic running, Manual Selection on (the popup shows its buttons from it), and
    // the workflow a site rule chose for the tab, if one did (the popup shows it as the choice, and says so)
    siteRulesRead.then(() => sendResponse({ isProcessing: isContinuousProcessing, isSelecting, workflow: tabWorkflow }));
    return true;
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
  // Videos as well: the moments of them that have results come back over them (see restoreFromTheCache)
  allVideos().forEach(watchForRestore);
  await Promise.all([...images, ...backgroundsToLookUp()].map(swapInCachedResult));
}

// The page's CSS background pictures not looked up yet (see allBackgrounds). Each is looked up once: a background
// is part of the page's own design, which a page doesn't point at other pictures the way it does an <img>.
const backgroundsLookedUp = new WeakSet();
function backgroundsToLookUp() {
  return allBackgrounds(BACKGROUNDS_SETTLED_MS).filter(element => {
    if (backgroundsLookedUp.has(element) || element.hasAttribute('data-original-src')) return false;
    backgroundsLookedUp.add(element);
    const url = cssBackgroundUrl(element);
    return url && !url.startsWith('data:');
  });
}

// Backgrounds the page adds later (a gallery that fills in as it's scrolled) are looked up once the page has been
// still for a moment, rather than on every change: finding them means reading every element's style
let backgroundsLookup = 0;
function lookUpBackgroundsSoon() {
  if (!swapCacheOn || backgroundsLookup) return;
  backgroundsLookup = setTimeout(() => {
    backgroundsLookup = 0;
    if (swapCacheOn && !extensionContextLost()) backgroundsToLookUp().forEach(swapInCachedResult);
  }, BACKGROUNDS_SETTLED_MS);
}

// After the extension is reloaded or updated, the content script already on an open tab keeps running but can't
// reach the background anymore (every chrome.runtime call throws "Extension context invalidated")
// Used by: web pages, the result tab.
function extensionContextLost() {
  return !chrome.runtime?.id;
}

async function swapInCachedResult(imgElement) {
  if (isResultTab || imgElement.closest('.img2img-spinner') || extensionContextLost()) return;
  const src = imageSrc(imgElement); // (an <img>'s src, or the picture an element shows as its background)
  try {
    const cachedResult = await getFromCache(null, getSourceUrl(imgElement), true);
    // (unless the page pointed the image at another picture meanwhile)
    const name = cachedResult && await nameOfResult(cachedResult);
    if (cachedResult && imageSrc(imgElement) === src) {
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

// Results shown on this page, by their original's URL. Some sites rebuild their images (a carousel's slides,
// re-rendered feeds) or point an <img> at another picture, which loses the result: an image that shows up with one
// of these URLs gets its result back.
const pageResults = new Map();

function restoreImage(imgElement) {
  if (!imgElement.src || imgElement.src.startsWith('data:')) {
    // One of our results: keep the page's responsive candidates from covering it again
    if (imgElement.hasAttribute('data-original-src')) {
      keepAside(imgElement, 'srcset');
    }
    return;
  }
  if (imgElement.hasAttribute('data-original-src') && imgElement.src !== imgElement.getAttribute('data-original-src')) {
    // The page reused this <img> for another picture: to img2img it's a new image
    imgElement.removeAttribute('data-original-src');
    imgElement.removeAttribute('data-img2img-settings');
    imgElement.removeAttribute('data-img2img-srcset');
    imgElement.removeAttribute('data-img2img-sizes');
    generations.delete(imgElement);
    shownGeneration.delete(imgElement);
    refreshResultSelect(imgElement);
    if (imgElement.hasAttribute('data-img2img-width')) {
      imgElement.removeAttribute('width');
      imgElement.removeAttribute('data-img2img-width');
    }
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
  if (pageResults.size === 0 && !swapCacheOn && videoResults.length === 0) return;
  const images = new Set();
  const videos = new Set();
  for (const mutation of mutations) {
    if (mutation.type === 'attributes') {
      if (mutation.target.tagName === 'IMG') images.add(mutation.target);
      if (mutation.target.tagName === 'VIDEO') videos.add(mutation.target);
      continue;
    }
    for (const node of mutation.addedNodes) {
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (node.tagName === 'IMG') {
        images.add(node);
        continue;
      }
      if (node.tagName === 'VIDEO') {
        videos.add(node);
        continue;
      }
      if (node.firstElementChild) {
        node.querySelectorAll('img').forEach(img => images.add(img));
        if (videoResults.length > 0) node.querySelectorAll('video').forEach(video => videos.add(video));
      }
      // Something new on the page may show a picture as its background: Swap Cache looks those up as well
      lookUpBackgroundsSoon();
    }
  }
  images.forEach(restoreImage);
  videos.forEach(watchForRestore);
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
// source) can then be clicked again without leaving and re-entering Manual Selection
chrome.storage.onChanged.addListener(async (changes, areaName) => {
  if (areaName !== 'local' || !isSelecting) return;
  if (changes.selectedSourceId) {
    selectedSourceId = changes.selectedSourceId.newValue;
  }
  settingsHash = hashBase64("", await getSettings());
});

// Page images are <img> elements, or (for Manual Selection) elements that show a picture as their CSS background,
// like banners and product photos, or a <video>, whose picture is the frame it shows (see videoFrames below).
// A result shown in a background is kept here, so its CSS isn't read back.
const backgroundResults = new WeakMap();
const MIN_BACKGROUND_SIDE = 100; // smaller backgrounds are icons and sprites

// Used by: web pages, the result tab, the Library.
function imageSrc(element) {
  if (element.tagName === 'IMG') return element.src;
  if (element.tagName === 'VIDEO') return shownOverVideo.get(element) ?? videoFrames.get(element)?.url ?? '';
  return backgroundResults.get(element) ?? cssBackgroundUrl(element);
}

// Used by: web pages, the result tab.
function setImageSrc(element, url) {
  if (element.tagName === 'IMG') {
    element.src = url;
    return;
  }
  if (element.tagName === 'VIDEO') {
    showOverVideo(element, url);
    return;
  }
  backgroundResults.set(element, url);
  element.style.setProperty('background-image', `url("${url.replace(/["\\]/g, '\\$&')}")`, 'important');
}

// The first url() of an element's CSS background ('' for none or a gradient)
// Used by: web pages, the result tab, the Library.
function cssBackgroundUrl(element) {
  const value = getComputedStyle(element).backgroundImage;
  return value && value !== 'none' ? /url\(\s*(["']?)(.*?)\1\s*\)/.exec(value)?.[2] || '' : '';
}

// Used by: web pages, the result tab, the Library.
function isBackgroundImage(element) {
  if (element === document.body || element === document.documentElement) return false;
  const rect = element.getBoundingClientRect();
  return rect.width >= MIN_BACKGROUND_SIDE && rect.height >= MIN_BACKGROUND_SIDE && Boolean(cssBackgroundUrl(element));
}

// Some sites turn a still picture into a video once a song is added to it, and a video can't be
// processed as it is: Manual Selection takes the frame it shows instead. The frame is grabbed the moment the video
// is clicked (see handleImageClick: the player can replace the element before the click's hold-back time is over),
// processed like any other picture, and the result is shown over the video by an image of ours that follows it,
// since a <video> can't show a picture the way an <img> can. The video keeps its result while it plays the same
// media, so unpausing a story doesn't lose it, and a player that rebuilds its <video> for that media gets the
// result back (restoreVideo); other media (the next story) clears it, and the video can be processed again.
const MIN_VIDEO_SIDE = 100; // smaller videos are previews and avatars
const FRAME_LOAD_TIMEOUT_MS = 15000; // reading a frame from the media again (frameFromReloadedMedia)
const videoFrames = new WeakMap(); // video -> the frame of it being shown or processed (one of its frame list's)
const videoFrameLists = new WeakMap(); // video -> the frames of its media that have a result, earliest first
const framesInFlight = new WeakMap(); // video -> the times of its frames on their way to the server
const resultSelects = new Map(); // element -> the dropdown that picks which of its results to show
const shownOverVideo = new WeakMap(); // video -> what its overlay shows: a result, or the frame's url for the video itself
const frameOverlays = new WeakMap(); // video -> the image of ours over it
const grabbedFrames = new WeakMap(); // video -> the pixels grabbed when it was clicked, before they become a PNG
const videosWithoutAFrame = new WeakSet(); // videos already reported as having nothing to take yet

// Any number of a video's frames can be processed: it is paused wherever the user wants, that frame is done like
// a picture, and the dropdown over the video picks which of its results to look at (see resultSelects). A frame
// holds its own result: { time, url, mediaId, mediaSrc, dataUrl, blob, fingerprint, openingPrints, result, settings }.
//
// The frames with results, newest first, so a player that opens the same media again (a story gone back to, a
// feed re-rendered) gets them back. One is found by the media's URL where the player names it, and otherwise by
// the picture it shows: a player is handed a fresh blob: URL every time a story is opened, so there's no
// URL to recognise it by. The frames of one piece of media share a mediaId, so recognising any one of them
// brings back all of them, and with them the dropdown. The id goes into storage with a moment kept for later
// pages (keepFrameAcrossPages), so the moments of one piece of media belong together there too: the media's
// name alone can't tell them from another story's (see namedByItsPage). Only the last few are kept here: each
// holds a picture.
const videoResults = [];
const KEPT_VIDEO_RESULTS = 8;
const VIDEO_ITSELF = 'img2img-video'; // a video's "original": the video itself rather than a picture of ours
const SAME_FRAME_SECONDS = 0.05; // two moments closer than this are the same frame
let nextMediaId = 0;
// Used by: web pages, the result tab.
const newMediaId = () => `${Date.now().toString(36)}-${++nextMediaId}`; // (one no earlier page handed out)
const FINGERPRINT_SIDE = 16; // a frame as a 16x16 grey thumbnail, which is what media is recognised by
const FINGERPRINT_STEP = 64; // scaled down through this size first, so the thumbnail is an average of the frame
const FINGERPRINT_TOLERANCE = 18; // mean difference per pixel still counting as the same picture (64 = one spread)
const FINGERPRINT_FLATNESS = 4; // an even frame (black, still loading) says nothing about which media it is
const RESTORE_TRIES = 10; // frames looked at as new media starts, before giving up on recognising it
const LOOK_AGAIN_MS = 250; // between looks at a stopped video's frame, while it is still blank (see watchForRestore)

// The media a video is pointed at: its src where the player names one, and currentSrc where the media comes
// from the player itself (a stream) or a <source>. Deliberately not either of the two: while a player takes up
// other media, currentSrc still names the media before it for a moment, and going by that would tie a result to
// the wrong media (see videoShowsItsFrame, which does allow either while that moment lasts).
// A player may also hand its video the media as an object (srcObject) rather than a URL, and then src and currentSrc
// are both empty, for every story alike: each such object is given a name of its own here, as a fresh blob: URL
// would be, or every video played that way would be taken for one and the same media.
const mediaObjectNames = new WeakMap(); // the media object a video plays -> its name
// Used by: web pages, the result tab.
function videoMediaSrc(video) {
  const object = video.srcObject; // (it plays over src when both are set)
  if (!object) return video.src || video.currentSrc;
  if (!mediaObjectNames.has(object)) mediaObjectNames.set(object, `img2img-media-object:${newMediaId()}`);
  return mediaObjectNames.get(object);
}

// The same media, named in a way that holds from one page load to the next, which is how a result is found again
// after a refresh. A frame's own moment can be anywhere in a video, so nothing goes looking through it: the media
// is named from what the player already knows, and the moments that have results are kept under that name.
//  - media the player names with a URL: the URL, steadied as the cache steadies a page image's (a signed URL is
//    handed out with a new signature every load, and some CDNs vary the host they serve from as well)
//  - media the page made itself, a stream (which is what a story with a song added is): the page it plays on,
//    whose address names the story. No pixels and no seeking, whatever the video's length.
//
// How long the media is goes with it separately (see sameMedia), not into the name: a player hands out its own
// idea of the length, which can differ a little from one load to the next, and may pick another size for the
// same media altogether, so neither is safe to key by.
// Used by: web pages, the result tab.
function mediaKeyOf(video) {
  const mediaSrc = videoMediaSrc(video);
  if (!mediaSrc) {
    // A player builds its <video> and hands it the media a moment later: until then the element plays nothing,
    // and a result put on it now would be cleared as soon as its media arrived (see videoShowsItsFrame). The
    // watch tries again on loadedmetadata.
    return '';
  }
  if (/^https?:/i.test(mediaSrc)) {
    return `url:${steadyMediaUrl(mediaSrc)}`;
  }
  return `page:${location.origin}${location.pathname}`;
}

// How long a video says it is, where it says anything (a stream being appended to may not yet)
// Used by: web pages, the result tab.
function mediaLength(video) {
  return Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration.toFixed(2)) : 0;
}

// Whether a processed moment belongs to the media a video is playing: the same name, and a length that agrees
// within a second where both know one. The length is what tells two videos on one page apart.
const MEDIA_LENGTH_TOLERANCE = 1;

// Used by: web pages, the result tab.
function sameMedia(moment, video) {
  if (!moment.media || moment.media !== mediaKeyOf(video)) return false;
  const length = mediaLength(video);
  if (!moment.length || !length) return true;
  return Math.abs(moment.length - length) <= MEDIA_LENGTH_TOLERANCE;
}

// The same rules as cacheImageUrl in background.js, which does this for a page image's URL
const SIGNED_PATH_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const MEDIA_SIGNATURE_PARAMS = /^(x-amz-.+|x-goog-.+|expires|signature|key-pair-id|policy)$/i;

// Used by: web pages, the result tab.
function steadyMediaUrl(mediaSrc) {
  let url;
  try {
    url = new URL(mediaSrc);
  } catch (error) {
    return mediaSrc.split('#')[0];
  }
  url.hash = '';
  if (SIGNED_PATH_HOSTS.test(url.hostname)) {
    return `signed-path:${url.pathname}`; // these sign every parameter, and vary the host they serve from
  }
  for (const name of [...url.searchParams.keys()]) {
    if (MEDIA_SIGNATURE_PARAMS.test(name)) {
      url.searchParams.delete(name);
    }
  }
  return url.href;
}

// A video Manual Selection can take a frame of: big enough to be the page's picture, with a frame decoded
// Used by: web pages, the result tab, the Library.
function isSelectableVideo(element) {
  if (element.tagName !== 'VIDEO') return false;
  const rect = element.getBoundingClientRect();
  if (rect.width < MIN_VIDEO_SIDE || rect.height < MIN_VIDEO_SIDE) return false;
  if (element.readyState < 2 /* HAVE_CURRENT_DATA: a frame to take */) {
    // A player that hasn't decoded a frame yet (preload="none" and never started, or still loading) has
    // nothing to process. Said once per video in the console, since the page gives no sign of why it doesn't
    // highlight.
    if (!videosWithoutAFrame.has(element)) {
      videosWithoutAFrame.add(element);
      console.debug('img2img: this video has no frame to process yet (readyState', element.readyState, ')');
    }
    return false;
  }
  videosWithoutAFrame.delete(element);
  return true;
}

// Whether a video is still on the page, playing the media its frame was taken from. A player that points its
// <video> at other media leaves currentSrc behind for a moment (it catches up with src once the player starts
// loading), so either of the two naming the frame's media counts as still playing it.
// Used by: web pages, the result tab.
function videoShowsItsFrame(video) {
  const frame = videoFrames.get(video);
  if (!frame || !frame.mediaSrc || !video.isConnected) return false;
  return videoMediaSrc(video) === frame.mediaSrc || (!video.srcObject && video.currentSrc === frame.mediaSrc);
}

// The pixels of the frame a video shows, kept until the click that took them turns out to be a single one (see
// handleImageClick). Drawing a video of another site taints the canvas, which only shows when the pixels are read,
// in captureVideoFrame.
function grabVideoFrame(video, { pause = true } = {}) {
  const grab = { mediaSrc: videoMediaSrc(video), media: mediaKeyOf(video), length: mediaLength(video), time: video.currentTime, width: video.videoWidth, height: video.videoHeight, canvas: null };
  if (grab.width && grab.height) {
    grab.canvas = document.createElement('canvas');
    grab.canvas.width = grab.width;
    grab.canvas.height = grab.height;
    grab.canvas.getContext('2d').drawImage(video, 0, 0, grab.width, grab.height);
  }
  grabbedFrames.set(video, grab);
  // A story that plays on would be gone (the next one) before its result is there, and the player's progress
  // follows its video: it stays paused until the user starts it again, with the result over it. (Not when the
  // frame is taken as the right-click menu opens: the menu may be for something else.)
  if (pause) video.pause();
}

// The grabbed frame as a PNG, ready to be processed like a page image
async function captureVideoFrame(video) {
  const grab = grabbedFrames.get(video);
  const blob = await pngOfGrab(grab, 'process');
  const frame = {
    // Not a URL anything can be loaded from (the pixels are here): it names this moment of this media in the
    // cache, so the same frame processed again is a cache hit and another moment of it is its own picture
    url: `img2img-frame:${grab.mediaSrc}#t=${grab.time.toFixed(2)}`,
    mediaSrc: grab.mediaSrc,
    media: grab.media,
    length: grab.length,
    mediaId: mediaIdOf(video, grab.mediaSrc),
    time: grab.time,
    dataUrl: await blobToDataUrl(blob),
    blob,
    fingerprint: await fingerprintOfBlob(blob),
    openingPrints: openingOf(video), // (the array itself: it fills in as the video plays on)
    result: null, // set when it comes back from the server (showResult)
    settings: null,
  };
  videoFrames.set(video, frame);
  return frame;
}

// The pixels of a grabbed frame as a PNG (purpose: what the frame is for, said where there is none)
async function pngOfGrab(grab, purpose) {
  if (!grab?.canvas) {
    throw new Error(`This video hasn't got a frame to ${purpose} yet`);
  }
  try {
    return await canvasToPng(grab.canvas);
  } catch (error) {
    // The canvas is tainted: the video is another site's and the page may not read its pixels
    return frameFromReloadedMedia(grab);
  }
}

// Frames of the same media share an id, whatever URL it was playing under when each was taken, so that all of a
// video's frames are found together
function mediaIdOf(video, mediaSrc) {
  const sameMedia = frameListOf(video).find(frame => frame.mediaSrc === mediaSrc);
  return sameMedia ? sameMedia.mediaId : newMediaId();
}

// The frames of the media a video is playing that have a result, earliest first
// Used by: web pages, the result tab.
function frameListOf(video) {
  return videoFrameLists.get(video) || [];
}

// One moment of a video can be on its way to the server while another is already done
function framesInFlightFor(video) {
  return framesInFlight.get(video) || [];
}

function markFrameInFlight(video, time) {
  framesInFlight.set(video, [...framesInFlightFor(video), time]);
}

function unmarkFrameInFlight(video, time) {
  framesInFlight.set(video, framesInFlightFor(video).filter(pending => pending !== time));
}

// A frame joins its video's list once it has a result, in time order, replacing whatever was done at that moment
// before (the same moment processed again with other settings)
// Used by: web pages, the result tab.
function addFrameToList(video, frame) {
  const frames = frameListOf(video).filter(other =>
    other !== frame && Math.abs(other.time - frame.time) >= SAME_FRAME_SECONDS);
  frames.push(frame);
  frames.sort((one, other) => one.time - other.time);
  videoFrameLists.set(video, frames);
}

// Show one of a video's processed frames: its result goes over the video, and the dropdown follows. Picked by
// the user, the video is also moved to that moment, so putting the video back on show (the toggle button) leaves
// it where the result came from, ready to be processed again with other settings.
// Used by: web pages, the result tab.
async function showFrame(video, frame, { seek = false } = {}) {
  if (!frame.result && frame.hash) {
    // A moment that came back from an earlier page: its result waits in the cache until it's asked for
    frame.result = await getFromCache(frame.hash, null);
    if (!frame.result) {
      showPageError("That result isn't in the cache anymore");
      await forgetKeptFrame(frame.hash);
      return;
    }
  }
  videoFrames.set(video, frame);
  revertedResults.delete(video); // (looking at a frame is looking at its result)
  setImageSrc(video, frame.result);
  updateRevertButton(video);
  refreshDownloadButtonStates();
  refreshResultSelect(video);
  if (seek) {
    try {
      video.currentTime = frame.time;
    } catch (error) {
      // media that can't be moved about in (a live stream)
    }
  }
}

// A moment of a video, as the dropdown names it: 0:03.4
// Used by: web pages, the result tab.
function frameTimeLabel(seconds) {
  const minutes = Math.floor(seconds / 60);
  const rest = seconds - minutes * 60;
  return `${minutes}:${rest < 10 ? '0' : ''}${rest.toFixed(1)}`;
}

// The picture a frame shows, as a small grey thumbnail: what media is recognised by when its URL is no help.
// Taken from the frame that was processed (a PNG of ours), so it works for a video the page may not read too.
async function fingerprintOfBlob(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const thumbnail = thumbnailOf(bitmap);
    bitmap.close();
    return thumbnail;
  } catch (error) {
    return null;
  }
}

// The same for the frame a video shows now
// Used by: web pages, the result tab.
function frameFingerprint(video) {
  return video.readyState >= 2 ? thumbnailOf(video) : null;
}

// (null for a frame too even to name any media, and for another site's video, whose pixels the page may not read)
// Used by: web pages, the result tab.
function thumbnailOf(source) {
  const scaled = (element, side) => {
    const context = element.getContext('2d');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    element.width = side;
    element.height = side;
    return context;
  };
  const step = scaled(document.createElement('canvas'), FINGERPRINT_STEP);
  const canvas = document.createElement('canvas');
  const context = scaled(canvas, FINGERPRINT_SIDE);
  let pixels;
  try {
    // Through a middle size first: scaled straight down to 16x16 the browser samples the frame rather than
    // averaging it, and a video and a picture of the same frame then come out too differently to match
    step.drawImage(source, 0, 0, FINGERPRINT_STEP, FINGERPRINT_STEP);
    context.drawImage(step.canvas, 0, 0, FINGERPRINT_SIDE, FINGERPRINT_SIDE);
    pixels = context.getImageData(0, 0, FINGERPRINT_SIDE, FINGERPRINT_SIDE).data;
  } catch (error) {
    return null;
  }
  const grey = new Float32Array(FINGERPRINT_SIDE * FINGERPRINT_SIDE);
  let mean = 0;
  for (let i = 0; i < grey.length; i++) {
    grey[i] = (pixels[i * 4] * 299 + pixels[i * 4 + 1] * 587 + pixels[i * 4 + 2] * 114) / 1000;
    mean += grey[i];
  }
  mean /= grey.length;
  let spread = 0;
  for (const value of grey) spread += Math.abs(value - mean);
  spread /= grey.length;
  if (spread < FINGERPRINT_FLATNESS) return null;
  // Levelled: a video's pixels and a PNG's of the same frame differ in brightness and contrast (the colour
  // range each is decoded with), so both are put on the same footing before they are compared
  const thumbnail = new Uint8Array(grey.length);
  for (let i = 0; i < grey.length; i++) {
    thumbnail[i] = Math.max(0, Math.min(255, Math.round(128 + 64 * (grey[i] - mean) / spread)));
  }
  return thumbnail;
}

// Used by: web pages, the result tab.
function fingerprintsMatch(one, other) {
  if (!one || !other || one.length !== other.length) return false;
  let difference = 0;
  for (let i = 0; i < one.length; i++) difference += Math.abs(one[i] - other[i]);
  return difference / one.length <= FINGERPRINT_TOLERANCE;
}

// A frame of a video whose pixels the page may not read: the media is loaded again asking for CORS, and where the
// site doesn't allow that, downloaded by the extension (whose fetch isn't subject to the page's CORS rules) and
// read from the download. Media the page made itself (a blob: URL from a media stream) can't be loaded again, but
// its pixels can be read in the first place.
async function frameFromReloadedMedia(grab) {
  if (!/^https?:/i.test(grab.mediaSrc)) {
    throw new Error("This video's frames can't be read on this site");
  }
  try {
    return await pngFromMedia(grab.mediaSrc, grab, { cors: true });
  } catch (corsNotAllowed) {
    const blobUrl = URL.createObjectURL(await fetchBlobViaBackground(grab.mediaSrc));
    try {
      return await pngFromMedia(blobUrl, grab);
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  }
}

// One moment of a video file, drawn into a PNG through a video element of our own
async function pngFromMedia(url, { time, width, height }, { cors = false } = {}) {
  const video = document.createElement('video');
  if (cors) video.crossOrigin = 'anonymous';
  Object.assign(video, { muted: true, preload: 'auto', playsInline: true });
  try {
    await new Promise((resolve, reject) => {
      const fail = () => reject(new Error("Couldn't read a frame of this video"));
      const timer = setTimeout(fail, FRAME_LOAD_TIMEOUT_MS);
      const ready = () => {
        clearTimeout(timer);
        resolve();
      };
      video.addEventListener('error', fail, { once: true });
      video.addEventListener('loadeddata', () => {
        // (the frame at the start is already there, so there's nothing to seek to)
        if (!Number.isFinite(time) || Math.abs(video.currentTime - time) < 0.05) {
          ready();
          return;
        }
        video.addEventListener('seeked', ready, { once: true });
        video.currentTime = time;
      }, { once: true });
      video.src = url;
    });
    return await drawToPng(video, width || video.videoWidth, height || video.videoHeight);
  } finally {
    video.removeAttribute('src'); // stop its download
    video.load();
  }
}

// The result over a video: an image of ours, pinned over the video every frame (fixed-position, like the spinner
// and the download buttons, so the page's layout and its player are left alone) and clipped to the part of the
// video that's on screen. It lets clicks through, so the player still works under it, although the controls it
// draws over its video are hidden while the result shows (the toggle button puts the video back).
// Used by: web pages, the result tab.
function showOverVideo(video, url) {
  shownOverVideo.set(video, url);
  // A result is a still picture pinned over the video, so the player is stopped where it is: a story would
  // otherwise play on and move to the next one behind the result. (The toggle button puts the video back;
  // starting it again from there is the user's to do.)
  if (showsAResult(url)) {
    video.pause();
    startsUndone.set(video, 0);
  }
  if (frameOverlays.has(video)) return;
  // And kept stopped: a player still taking its media up when the result went on (Swap Cache puts one on as
  // the media's name is known, before the player is ready) starts it as soon as it can, and a story then plays
  // on behind the result after all. A start while a result is on show is undone - a few times; a player that
  // insists is let be rather than fought over every start.
  const stopAgain = () => {
    if (!showsAResult(shownOverVideo.get(video))) return;
    const undone = (startsUndone.get(video) || 0) + 1;
    startsUndone.set(video, undone);
    if (undone <= STARTS_UNDONE) video.pause();
  };
  video.addEventListener('playing', stopAgain);
  stopAgainListeners.set(video, stopAgain);
  const overlay = document.createElement('img');
  overlay.className = 'img2img-frame';
  overlay.alt = '';
  Object.assign(overlay.style, {
    position: 'fixed',
    top: '0',
    left: '0',
    margin: '0',
    padding: '0',
    border: 'none',
    minWidth: '0',
    minHeight: '0',
    maxWidth: 'none',
    maxHeight: 'none',
    pointerEvents: 'none',
    display: 'none',
    zIndex: '2147483646', // under img2img's own buttons
  });
  document.documentElement.appendChild(overlay);
  frameOverlays.set(video, overlay);
  followVideo(video, overlay);
}

// A result is a picture of ours (a data: URL); anything else over a video means the video itself is on show
// Used by: web pages, the result tab.
function showsAResult(url) {
  return Boolean(url) && url.startsWith('data:');
}

const stopAgainListeners = new WeakMap(); // video -> what undoes a start while its result is on show
const startsUndone = new WeakMap(); // video -> the starts undone since its result went on show
const STARTS_UNDONE = 3;

// Used by: web pages, the result tab.
function followVideo(video, overlay) {
  if (frameOverlays.get(video) !== overlay) return; // cleared, or the video has a newer overlay
  if (!videoShowsItsFrame(video)) {
    // The player moved on to other media, or the video left the page: the result has nothing to sit on anymore
    clearVideoResult(video);
    // The media it plays now may have results of its own (the next story, processed before). The watch the
    // change of media started stopped at once, since this result was still on show.
    if (video.isConnected) watchForRestore(video);
    return;
  }
  if (!overlay.isConnected) {
    document.documentElement.appendChild(overlay); // (a page that replaced <html>'s children)
  }
  const url = shownOverVideo.get(video);
  const rect = video.getBoundingClientRect();
  const visible = visibleRect(video);
  const showing = showsAResult(url) && visible.width > 0 && visible.height > 0;
  overlay.style.display = showing ? 'block' : 'none';
  if (showing) {
    if (overlay.src !== url) overlay.src = url;
    const style = getComputedStyle(video);
    const inset = [
      visible.top - rect.top,
      rect.right - visible.right,
      rect.bottom - (visible.top + visible.height),
      visible.right - visible.width - rect.left,
    ].map(side => `${Math.max(0, side)}px`).join(' ');
    Object.assign(overlay.style, {
      top: `${rect.top}px`,
      left: `${rect.left}px`,
      width: `${rect.width}px`,
      height: `${rect.height}px`,
      // Framed as the video frames itself (a story is usually cropped to the screen), and clipped like the
      // buttons are to the part of it that's on screen
      objectFit: style.objectFit,
      objectPosition: style.objectPosition,
      borderRadius: style.borderRadius,
      clipPath: `inset(${inset})`,
    });
  }
  requestAnimationFrame(() => followVideo(video, overlay));
}

// A video's result goes: its overlay and buttons are removed, and it can be processed again
// Used by: web pages, the result tab.
function clearVideoResult(video) {
  frameOverlays.get(video)?.remove();
  frameOverlays.delete(video);
  if (stopAgainListeners.has(video)) {
    video.removeEventListener('playing', stopAgainListeners.get(video));
    stopAgainListeners.delete(video);
  }
  startsUndone.delete(video);
  removeResultButtons(video);
  shownOverVideo.delete(video);
  videoFrames.delete(video);
  videoFrameLists.delete(video);
  grabbedFrames.delete(video);
  video.removeAttribute('data-img2img-settings');
  video.removeAttribute('data-original-src');
}

// A frame with a result is kept, so the media it came from gets it back later
// Used by: web pages, the result tab.
function rememberFrame(frame) {
  const already = videoResults.indexOf(frame);
  if (already >= 0) videoResults.splice(already, 1);
  videoResults.unshift(frame);
  videoResults.length = Math.min(videoResults.length, KEPT_VIDEO_RESULTS);
}

// Whether a video's media is named by the page it plays on rather than by a URL of its own (see mediaKeyOf).
// A name like that is shared: every story of one user plays at the same address, each under a blob: URL
// fresh every time it is opened, and a player appending its own stream need not say how long it is, so the
// name narrows the search down and no further - taken for the media itself, it put the last result over
// every story in turn. Media named by its page is only recognised by its pictures: the frame on screen has
// to agree with the one a moment was processed from, or with one of the frames the media showed as it
// started the time it was processed (its opening, see noteOpening) - which is what a video shows as it
// starts again, so a moving story is known in its first second. A moment kept without an opening (processed
// on a page the player never started, or by an earlier version) is known as the video reaches it, which the
// watch stays on for (see watchForRestore).
// Used by: web pages, the result tab.
function namedByItsPage(video) {
  return mediaKeyOf(video).startsWith('page:');
}

// The moment, of those given, one of whose pictures is the frame a video shows now - once the media it is
// pointed at is the media it plays: during the changeover the frame on screen is still the one before it,
// which would be recognised as the wrong story. printsOf gives a moment's thumbnails (see fingerprintOfBlob).
// Used by: web pages, the result tab.
function recognisedByPicture(video, moments, printsOf) {
  if (!videoSettled(video) || !moments.some(moment => printsOf(moment).some(Boolean))) return null;
  const fingerprint = frameFingerprint(video);
  if (!fingerprint) return null;
  return moments.find(moment => printsOf(moment).some(print => fingerprintsMatch(print, fingerprint))) || null;
}

// What a stream shows as it starts: a few thumbnails of its first seconds, taken as it plays (and of its first
// frame where a player holds it stopped), so the media is recognised again by them as it starts on a later
// page. Only media named by its page, which has nothing else to go by. One thumbnail says all there is about a
// still story, so a frame like one already taken isn't kept twice. Listened for on the document, so every
// video on the page is covered without bookkeeping (one inside a shadow root isn't: it is known by the
// processed moment alone).
const openings = new WeakMap(); // video -> { mediaSrc, prints, lastTime }
const OPENING_SECONDS = 6; // the opening is the first this many seconds
const OPENING_PRINTS = 6; // at most this many thumbnails of it
const OPENING_SPACING = 0.8; // seconds between two of them
const FIRST_FRAME_LOOKS = 3; // looks at a stopped video's first frame, which draws blank for a moment after loading

function openingOf(video) {
  return openings.get(video)?.prints || [];
}

function noteOpening(video) {
  if (!videoSettled(video) || !namedByItsPage(video)) return;
  const mediaSrc = videoMediaSrc(video);
  let opening = openings.get(video);
  if (!opening || opening.mediaSrc !== mediaSrc) {
    opening = { mediaSrc, prints: [], lastTime: -1 };
    openings.set(video, opening);
  }
  const time = video.currentTime;
  if (opening.prints.length >= OPENING_PRINTS || time > OPENING_SECONDS) return;
  if (opening.lastTime >= 0 && time - opening.lastTime < OPENING_SPACING) return;
  const print = frameFingerprint(video);
  if (!print) return;
  opening.lastTime = time;
  if (!opening.prints.some(known => fingerprintsMatch(known, print))) {
    opening.prints.push(print);
  }
}

document.addEventListener('timeupdate', event => {
  if (event.target.tagName === 'VIDEO') noteOpening(event.target);
}, true);
document.addEventListener('loadeddata', event => {
  const video = event.target;
  if (video.tagName !== 'VIDEO') return;
  for (let look = 1; look <= FIRST_FRAME_LOOKS; look++) {
    setTimeout(() => noteOpening(video), look * LOOK_AGAIN_MS);
  }
}, true);

// The result remembered for the media a video plays: by URL where the player names it (a file on a CDN), and
// otherwise by the picture its frame shows, which is how a story opened again under a fresh blob: URL is
// recognised (see namedByItsPage).
// Used by: web pages, the result tab.
function rememberedForVideo(video) {
  const byUrl = videoResults.find(frame => frame.mediaSrc === videoMediaSrc(video));
  if (byUrl) return byUrl;
  // The same media under another name, which costs nothing to ask
  const byName = videoResults.filter(frame => sameMedia(frame, video));
  if (!namedByItsPage(video)) return byName[0] || null;
  // (a story opened from elsewhere on the site plays at another address: with nothing under this one, anything
  // processed on this page is looked at)
  return recognisedByPicture(video, byName.length > 0 ? byName : videoResults,
    frame => [frame.fingerprint, ...(frame.openingPrints || [])]);
}

// Whether the frame a video shows belongs to the media it is pointed at, rather than to media it is leaving
// Used by: web pages, the result tab.
function videoSettled(video) {
  return video.readyState >= 2 && (!video.src || video.src === video.currentSrc);
}

// A player that opened media again that has a result (a story gone back to, a feed re-rendered) shows the result
// over it, from the frame it was made of, with every moment of the media in the dropdown: the ones this page
// remembers, gathered as the kept ones are (by id, and by their pictures), and the ones kept for later pages
// that it doesn't - a restore from the cache remembers only the frame it showed, and a moment processed on
// another visit was never here. The dropdown fetches those if they are picked.
const restoringVideo = new WeakSet();

// Used by: web pages, the result tab.
async function restoreVideo(video) {
  if (videoFrames.has(video) || restoringVideo.has(video)) return;
  const remembered = videoResults.length > 0 ? rememberedForVideo(video) : null;
  if (!remembered) {
    // Nothing on this page: what the cache has for this media, if the user asked for that (Swap Cache)
    if (swapCacheOn) restoreFromTheCache(video);
    return;
  }
  restoringVideo.add(video);
  try {
    const fingerprint = namedByItsPage(video) ? frameFingerprint(video) : null;
    const frames = gatherSameMedia([fingerprint, ...printsOfFrame(remembered)], remembered.mediaId, videoResults,
      printsOfFrame, frame => frame.mediaId);
    const mediaSrc = videoMediaSrc(video);
    frames.forEach(frame => { frame.mediaSrc = mediaSrc; frame.mediaId = remembered.mediaId; });
    if (swapCacheOn) {
      const kept = await keptFrames();
      if (videoFrames.has(video) || !video.isConnected) return;
      const candidates = kept.filter(moment => sameMedia(moment, video) && !frames.some(frame => frame.hash === moment.hash));
      const same = gatherSameMedia([fingerprint, ...frames.flatMap(printsOfFrame)], remembered.mediaId, candidates, printsOfKept, moment => moment.tag);
      retagKept(kept, same, remembered.mediaId);
      frames.push(...same.map(moment => frameFromKept(moment, video, remembered.mediaId)));
    }
    // (one frame per moment: the page's own over a kept one at the same time)
    const list = frames.filter((frame, index) =>
      frames.findIndex(other => Math.abs(other.time - frame.time) < SAME_FRAME_SECONDS) === index);
    videoFrameLists.set(video, list.sort((one, other) => one.time - other.time));
    videoFrames.set(video, remembered);
    if (remembered.settings) {
      video.setAttribute('data-img2img-settings', remembered.settings);
    }
    showResult(video, remembered.result, resultNames.get(remembered.result));
    addDownloadButton(video);
  } finally {
    restoringVideo.delete(video);
  }
}

// A frame's thumbnails: the frame itself, and the media's opening (see noteOpening)
// Used by: web pages, the result tab.
function printsOfFrame(frame) {
  return [frame.fingerprint, ...(frame.openingPrints || [])].filter(Boolean);
}

// Of the candidates, those of the same media as a seed: tagged like it, or with a picture agreeing with one of
// the seed's or with one of a candidate already gathered - the moments of one piece of media were tagged on
// their own if processed on different visits, or not at all by an earlier version, and their pictures are all
// that say which media each is of. A moment of a video that moves may only agree with the moment nearest it in
// time, which is why the gathering goes on until nothing more agrees.
// Used by: web pages, the result tab.
function gatherSameMedia(seedPrints, tag, candidates, printsOf, tagOf) {
  const same = [];
  let prints = seedPrints.filter(Boolean);
  for (let grew = true; grew;) {
    grew = false;
    for (const candidate of candidates) {
      if (same.includes(candidate)) continue;
      if ((tag && tagOf(candidate) === tag) || printsOf(candidate).some(print => prints.some(other => fingerprintsMatch(print, other)))) {
        same.push(candidate);
        prints = prints.concat(printsOf(candidate));
        grew = true;
      }
    }
  }
  return same;
}

// Kept moments found to be of one piece of media are tagged as one, so they are found together at once next time
// Used by: web pages, the result tab.
function retagKept(kept, moments, tag) {
  if (!moments.some(moment => moment.tag !== tag)) return;
  moments.forEach(moment => { moment.tag = tag; });
  keptFramesRead = Promise.resolve(kept);
  chrome.storage.local.set({ [FRAME_INDEX_KEY]: kept });
}

// A page reload leaves the page's own memory behind, so the moments of a video that have results are kept in
// storage: the media's name (mediaKeyOf) and the moment, with the source hash that finds the result itself in the
// cache. Only that much, so looking up what a page's videos have costs a read of a few kilobytes and no pictures;
// the result is fetched when it goes on show, and the others when the dropdown asks for them.
//
// Swap Cache puts these back as a page loads, as it does for images: it's the same "show me my results again"
// setting, and it stays off until the user turns it on.
const FRAME_INDEX_KEY = 'videoFrameIndex';
const KEPT_FRAME_MOMENTS = 60;

let keptFramesRead = null;

// Used by: web pages, the result tab.
function keptFrames() {
  keptFramesRead ??= new Promise(resolve => {
    chrome.storage.local.get(FRAME_INDEX_KEY, stored => {
      resolve(Array.isArray(stored?.[FRAME_INDEX_KEY]) ? stored[FRAME_INDEX_KEY] : []);
    });
  });
  return keptFramesRead;
}

// (another tab's results go in the same list)
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[FRAME_INDEX_KEY]) {
    const kept = changes[FRAME_INDEX_KEY].newValue;
    keptFramesRead = Promise.resolve(Array.isArray(kept) ? kept : []);
  }
});

// Used by: web pages, the result tab.
const printText = print => btoa(String.fromCharCode(...print));

// Used by: web pages, the result tab.
function printBytes(text) {
  try {
    return Uint8Array.from(atob(text), character => character.charCodeAt(0));
  } catch (error) {
    return null;
  }
}

// A processed moment, kept for later pages. Its thumbnail goes with it as a second way to recognise the media
// (see restoreFromTheCache), and so does the host, since the same picture on another site is another site's.
// Used by: web pages, the result tab.
async function keepFrameAcrossPages(frame, name) {
  if (!frame.hash || (!frame.media && !frame.fingerprint)) return;
  const moment = {
    media: frame.media || '',
    length: frame.length || 0,
    print: frame.fingerprint ? printText(frame.fingerprint) : '',
    opening: (frame.openingPrints || []).map(printText), // (see noteOpening)
    host: location.hostname,
    tag: frame.mediaId || '', // (the moments of one piece of media, together: see restoreFromTheCache)
    time: frame.time,
    hash: frame.hash,
    settings: frame.settings || '',
    name: name || resultNames.get(frame.result) || '',
  };
  const kept = [moment, ...(await keptFrames()).filter(other => other.hash !== moment.hash)]
    .slice(0, KEPT_FRAME_MOMENTS);
  keptFramesRead = Promise.resolve(kept);
  chrome.storage.local.set({ [FRAME_INDEX_KEY]: kept });
}

// A result that isn't in the cache anymore (cleared, or past the age it's kept for): the moment goes with it
// Used by: web pages, the result tab.
async function forgetKeptFrame(hash) {
  const kept = (await keptFrames()).filter(moment => moment.hash !== hash);
  keptFramesRead = Promise.resolve(kept);
  chrome.storage.local.set({ [FRAME_INDEX_KEY]: kept });
}

// A kept moment as one of a video's frames: the picture it was made from isn't kept (only its thumbnail), and the
// result itself waits in the cache until this frame goes on show
// Used by: web pages, the result tab.
function frameFromKept(moment, video, mediaId) {
  return {
    url: `img2img-frame:${moment.media || moment.hash}#t=${Number(moment.time || 0).toFixed(2)}`,
    mediaSrc: videoMediaSrc(video),
    media: moment.media,
    length: moment.length || mediaLength(video),
    mediaId,
    time: Number(moment.time) || 0,
    dataUrl: null, // (the moment's own picture: taken from the video again if it's needed, see originalOfFrame)
    blob: null,
    fingerprint: moment.print ? printBytes(moment.print) : null,
    openingPrints: (moment.opening || []).map(printBytes).filter(Boolean),
    result: null,
    settings: moment.settings,
    hash: moment.hash,
  };
}

// A kept moment's thumbnails: the frame it was processed from, and the media's opening (see noteOpening)
// Used by: web pages, the result tab.
function printsOfKept(moment) {
  return [printBytes(moment.print), ...(moment.opening || []).map(printBytes)].filter(Boolean);
}

// The kept moments of the media a recognised moment belongs to, for the dropdown (see gatherSameMedia), tagged
// as one from then on
// Used by: web pages, the result tab.
function momentsOfTheSameMedia(seen, candidates, fingerprint, kept) {
  const same = gatherSameMedia([fingerprint, ...printsOfKept(seen)], seen.tag, candidates, printsOfKept, moment => moment.tag);
  if (!same.includes(seen)) same.push(seen);
  retagKept(kept, same, seen.tag || newMediaId());
  return kept.filter(moment => same.includes(moment)); // (in the order they are kept in: newest first)
}

// Swap Cache on a video: the moments kept for the media it is playing come back. Media the player names with a
// URL is known by that name, which costs nothing, and the newest of its moments goes on show; media named by
// its page is known by its pictures (see namedByItsPage), and the moment that was processed from the frame on
// screen goes on show, with the moments of the same media (momentsOfTheSameMedia) in the dropdown.
const restoringFromCache = new WeakSet();
const unrecognisedMedia = new WeakSet(); // videos already said to have no processed moment

// Used by: web pages, the result tab.
async function restoreFromTheCache(video) {
  if (restoringFromCache.has(video) || videoFrames.has(video)) return;
  const kept = await keptFrames();
  if (kept.length === 0) return; // nothing has ever been processed: this costs a page with videos nothing
  const media = mediaKeyOf(video);
  const byName = kept.filter(moment => sameMedia(moment, video));
  let moments = byName;
  let seen = byName[0]; // kept newest first
  if (namedByItsPage(video)) {
    // (a story opened from elsewhere on the site plays at another address: with nothing under this one, what
    // was processed on this site is looked at)
    const onThisSite = kept.filter(moment => moment.host === location.hostname);
    const candidates = byName.length > 0 ? byName : onThisSite;
    seen = recognisedByPicture(video, candidates, printsOfKept);
    moments = seen ? momentsOfTheSameMedia(seen, candidates, frameFingerprint(video), kept) : [];
  }
  if (!seen) {
    // Said once per video, since there's nothing on the page to show why a result didn't come back (and for
    // media named by its page the watch goes on looking, see watchForRestore)
    if (!unrecognisedMedia.has(video) && videoSettled(video)) {
      unrecognisedMedia.add(video);
      console.debug('img2img: no processed moment for this video.', {
        media, length: mediaLength(video),
        kept: kept.map(moment => ({ media: moment.media, length: moment.length })),
        byPicture: namedByItsPage(video),
        readAFrame: Boolean(frameFingerprint(video)),
      });
    }
    return;
  }
  // One frame per moment, the one going on show first and then the newest (the same moment processed again
  // with other settings), as the page keeps them (see addFrameToList)
  moments = [seen, ...moments.filter(moment => moment !== seen)].filter((moment, index, all) =>
    all.findIndex(other => Math.abs(other.time - moment.time) < SAME_FRAME_SECONDS) === index);
  restoringFromCache.add(video);
  try {
    const result = await getFromCache(seen.hash, null);
    if (!result) {
      // The cache no longer holds it: cleared, or past the age results are kept for
      console.debug('img2img: the result for a processed moment is no longer in the cache', seen.hash);
      await forgetKeptFrame(seen.hash);
      return;
    }
    if (videoFrames.has(video) || !video.isConnected) {
      console.debug('img2img: the video was processed or left while its result was read');
      return;
    }
    const mediaId = seen.tag || newMediaId();
    const frames = moments.map(moment => frameFromKept(moment, video, mediaId));
    const shown = frames[moments.indexOf(seen)];
    shown.result = result;
    videoFrameLists.set(video, [...frames].sort((one, other) => one.time - other.time));
    videoFrames.set(video, shown);
    if (seen.settings) {
      video.setAttribute('data-img2img-settings', seen.settings);
    }
    showResult(video, result, seen.name || undefined);
    addDownloadButton(video);
  } catch (error) {
    if (!extensionContextLost()) {
      console.debug('img2img: putting a cached frame back over a video failed:', error);
    }
  } finally {
    restoringFromCache.delete(video);
  }
}

// Media just opened shows no frame yet, and the first one it shows can be black: the frames of its first moments
// are looked at until its picture is recognised, or there are no tries left. Media named by its page is only
// ever known by its pictures, its opening as a rule (see noteOpening), and failing that the one it was
// processed from, which a video that moves shows when it gets to that moment, so for that the watch stays on
// as long as the video plays: a thumbnail of the frame a few times a second, and only while something
// processed is there to compare it with.
const watchedForRestore = new WeakSet();

// Used by: web pages, the result tab.
function watchForRestore(video) {
  if ((videoResults.length === 0 && !swapCacheOn) || watchedForRestore.has(video)) return;
  watchedForRestore.add(video);
  let tries = RESTORE_TRIES;
  let looksLeft = RESTORE_TRIES;
  let lookAgain = null;
  const attempt = () => {
    clearTimeout(lookAgain);
    const outOfTries = --tries < 0 && !namedByItsPage(video);
    if (!video.isConnected || shownOverVideo.has(video) || (videoResults.length === 0 && !swapCacheOn) || outOfTries) {
      ['loadedmetadata', 'loadeddata', 'timeupdate'].forEach(name => video.removeEventListener(name, attempt));
      watchedForRestore.delete(video);
      return;
    }
    restoreVideo(video);
    // A frame just loaded draws blank for a moment yet, and a player holding its video stopped sends nothing
    // more to go on: media that goes by its picture is looked at again shortly, a few times over
    if (namedByItsPage(video) && video.paused && looksLeft-- > 0) {
      lookAgain = setTimeout(attempt, LOOK_AGAIN_MS);
    }
  };
  // Metadata is enough to name the media, which is all a lookup needs; the frames are only for the media that
  // has no name of its own (see restoreFromTheCache)
  ['loadedmetadata', 'loadeddata', 'timeupdate'].forEach(name => video.addEventListener(name, attempt));
  attempt();
}

// An element's shadow root, also a closed one (which extensions may open). Chrome's chrome.dom.openOrClosedShadowRoot
// throws for some elements (seen in Edge on a plain page's elements), which counts as no shadow root. It only takes an
// HTMLElement (SVG and MathML elements can't have a shadow root anyway), so those aren't asked.
// Used by: web pages, the result tab, the Library.
function shadowRootOf(element) {
  if (element.shadowRoot) return element.shadowRoot;
  if (!(element instanceof HTMLElement)) return null;
  try {
    return globalThis.chrome?.dom?.openOrClosedShadowRoot?.(element) || element.openOrClosedShadowRoot || null;
  } catch {
    return null;
  }
}

// The parent of a node, crossing out of a shadow root to its host
// Used by: web pages, the result tab, the Library.
function parentOf(node) {
  return node.parentElement || node.parentNode?.host || null;
}

// The elements at a point of the window, topmost first, including those inside shadow roots (web components)
// Used by: web pages, the result tab, the Library.
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
// Used by: web pages, the result tab.
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
  return allOfTag('img');
}

// The same for the page's videos (Swap Cache looks at those too)
function allVideos() {
  allImages(); // (the shadow roots are looked up there, at most once a second)
  return allOfTag('video');
}

// The elements that show a picture as their CSS background (banners, product photos, a gallery's tiles), for
// Automatic Selection and Swap Cache, which otherwise work from the page's <img>s. Finding them means reading
// every element's style, too slow to do on every look (Automatic Selection looks ten times a second), so the page
// is walked at most once in maxAge milliseconds: once a second for Automatic Selection, which is about the pace a
// page changes at under the user, and less often for Swap Cache, which runs on every page. Tags that never show a
// background are skipped without a look. Manual Selection and the right-click menu don't come through here: they
// look at the one element under the pointer (imageAt).
const BACKGROUNDS_FRESH_MS = 1000;
const BACKGROUNDS_SETTLED_MS = 5000;
const NOT_BACKGROUNDS = new Set(['HTML', 'BODY', 'HEAD', 'META', 'TITLE', 'LINK', 'STYLE', 'SCRIPT', 'NOSCRIPT', 'TEMPLATE', 'IMG', 'VIDEO', 'SOURCE', 'TRACK', 'BR', 'WBR', 'svg', 'path', 'g', 'use']);
let backgroundsCache = { time: 0, elements: [] };
function allBackgrounds(maxAge = BACKGROUNDS_FRESH_MS) {
  if (Date.now() - backgroundsCache.time > maxAge) {
    allImages(); // (the shadow roots are looked up there)
    const elements = [];
    for (const root of [document, ...shadowRootsCache.roots]) {
      for (const element of root.querySelectorAll('*')) {
        if (NOT_BACKGROUNDS.has(element.tagName) || element.closest(OWN_ELEMENTS)) continue;
        if (isBackgroundImage(element)) elements.push(element);
      }
    }
    backgroundsCache = { time: Date.now(), elements };
  }
  return backgroundsCache.elements;
}

// img2img's own are left out: the result over a video is an <img> of the page's own size (see showOverVideo), so
// Automatic Selection would pick it up and process a result, and the spinner's mark is an <img> too
// Used by: web pages, the result tab.
function allOfTag(tag) {
  return [document, ...shadowRootsCache.roots]
    .flatMap(root => Array.from(root.querySelectorAll(tag)))
    .filter(element => !element.closest(OWN_ELEMENTS));
}

// An image just inside an element that lets the pointer through (pointer-events: none), so elementsFromPoint never
// finds it, when it's at the point
// Used by: web pages, the result tab, the Library.
function passThroughImageIn(element, x, y, { videos = false } = {}) {
  const selector = videos ? ':scope > img, :scope > * > img, :scope > video, :scope > * > video' : ':scope > img, :scope > * > img';
  for (const img of element.querySelectorAll(selector)) {
    if (getComputedStyle(img).pointerEvents !== 'none') continue;
    if (img.tagName === 'VIDEO' && !isSelectableVideo(img)) continue;
    const rect = img.getBoundingClientRect();
    if (x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom) return img;
  }
  return null;
}

// Elements that stop the search for an image under the pointer: the page's controls and img2img's own
const SELECTION_BLOCKERS = new Set(['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'VIDEO', 'CANVAS', 'IFRAME']);

// A control a site builds out of a <div> or an <svg> instead of a <button>: a player's play, mute and next, a
// menu, a volume slider. These sit over the media they belong to, and an icon has no text of its own (an SVG's
// <title> is an element, not text), so without this a click on pause was a click on the story behind it.
//
// Only small ones: a layer with a role of its own that covers the media (a story's tap-to-advance) is the page's
// own overlay on its picture, which is exactly what the search looks through. An <a> is not one either: an image
// inside a link is the ordinary case, and a double click opens the link.
const CONTROL_ROLES = ['button', 'slider', 'checkbox', 'radio', 'switch', 'tab', 'menuitem', 'menuitemcheckbox',
  'menuitemradio', 'option', 'textbox', 'combobox', 'spinbutton', 'searchbox', 'progressbar']
  .map(role => `[role="${role}"]`).join(', ');
const CONTROL_MAX_SIDE = 200;

// Used by: web pages, the result tab, the Library.
function isPageControl(element) {
  const named = element.matches?.(CONTROL_ROLES)
    || (element.tagName === 'svg' && (element.hasAttribute('aria-label') || element.querySelector('title')));
  if (!named) return false;
  const rect = element.getBoundingClientRect();
  return rect.width <= CONTROL_MAX_SIDE && rect.height <= CONTROL_MAX_SIDE;
}
const OWN_ELEMENTS = '.img2img-download, .img2img-revert, .img2img-compare, .img2img-comparison, .img2img-reprocess, .img2img-delete, .img2img-results, .img2img-spinner, .img2img-frame, #img2img-error-toast, #img2img-confirm';

// The image seen at a point of the window. Some sites lay an empty element over their images to catch
// clicks, so it looks through the elements there (topmost first, skipping img2img's own) until it reaches an image,
// or something with its own text or a control, which is what's seen instead. Empty elements on top only count as
// the image's overlay when they're near it in the page: a modal's backdrop comes from elsewhere and hides the image.
// With backgrounds, an element showing a picture as its CSS background counts as an image too, and with videos,
// a video counts as the frame it shows (Manual Selection processes that).
// Used by: web pages, the result tab, the Library.
function imageAt(x, y, { backgrounds = false, videos = false } = {}) {
  const above = [];
  const seen = element => above.every(overlay => isNearby(overlay, element)) ? element : null;
  for (const element of elementsAt(x, y)) {
    if (element.closest(OWN_ELEMENTS)) continue;
    // A video is what's seen at the point however its player layers over it: the layer that catches the clicks
    // (a story player's own "Video player" layer) hangs several levels away from the <video> it belongs to, far
    // for the overlay test below to tell it from something covering the video from elsewhere. Text or a control
    // on top still wins, because the search stops at those before it ever reaches the video.
    if (videos && isSelectableVideo(element)) return element;
    if (SELECTION_BLOCKERS.has(element.tagName) || isPageControl(element)) return null;
    if (element.tagName === 'IMG') return seen(element);
    const passThrough = passThroughImageIn(element, x, y, { videos });
    if (passThrough) return seen(passThrough);
    if (Array.from(element.childNodes).some(node => node.nodeType === Node.TEXT_NODE && node.textContent.trim())) return null;
    if (backgrounds && isBackgroundImage(element)) return seen(element);
    above.push(element);
  }
  return null;
}

// Whether an element is within a few levels of an image's ancestors, as a site's overlay on its own image is
// Used by: web pages, the result tab, the Library.
function isNearby(element, img) {
  let ancestor = parentOf(img);
  for (let level = 0; ancestor && level < 4; level++, ancestor = parentOf(ancestor)) {
    for (let node = element; node; node = parentOf(node)) {
      if (node === ancestor) return true;
    }
  }
  return false;
}

// The image under the pointer that Manual Selection can process (not through img2img's own buttons). An image that
// already has its result is offered again, as its process again button would take it (reprocessImage); one on its way
// to the server isn't, so a click on it while it waits takes its job back (waitingJobAt).
function selectableImageAt(e) {
  if (e.target.closest?.(OWN_ELEMENTS)) return null;
  const img = imageAt(e.clientX, e.clientY, { backgrounds: true, videos: true });
  if (!img) return null;
  if (img.tagName !== 'VIDEO' && hasResult(img) && !imagesInFlight.has(img)) return img;
  return !isProcessedAlready(img) ? img : null;
}

// Whether an image (not a video) shows one of our results, or its original toggled back from one; in a result tab,
// the result it opened with too
// Used by: web pages, the result tab.
function hasResult(img) {
  return (img.hasAttribute('data-original-src') && downloadButtons.has(img)) || (isResultTab && resultTabOriginal?.image === img);
}

// Whether what's under the pointer has already been processed as it is. A video is taken a frame at a time, so
// it's offered again as soon as it shows another moment: one that hasn't been done with these settings, and
// isn't on its way to the server. (Pause it where you want it, or click it as it plays.)
function isProcessedAlready(element) {
  if (element.tagName !== 'VIDEO') {
    return element.getAttribute('data-img2img-settings') === settingsHash;
  }
  const time = element.currentTime;
  const sameMoment = moment => Math.abs(moment - time) < SAME_FRAME_SECONDS;
  if (framesInFlightFor(element).some(sameMoment)) return true;
  const done = frameListOf(element).find(frame => sameMoment(frame.time));
  return Boolean(done) && done.settings === settingsHash;
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

// Manual Selection takes the page's clicks, so an image that is also a link or a button can't be opened or pressed
// while it's on. A double click does that instead: the first click is held back for DOUBLE_CLICK_MS to see whether a
// second one follows, and that second click is left to the page, which opens the link or presses the button as it
// would without Manual Selection, with nothing processed.
const DOUBLE_CLICK_MS = 400;
const pendingClicks = new Map(); // image -> the first click's timer, while that click can still turn out to be a double one

function cancelPendingClicks() {
  pendingClicks.forEach((timer, element) => {
    clearTimeout(timer);
    // A video double-clicked to open its link: the frame grabbed for the first click isn't needed
    if (element.tagName === 'VIDEO' && !shownOverVideo.has(element)) {
      grabbedFrames.delete(element);
    }
  });
  pendingClicks.clear();
}

function handleImageClick(e) {
  if (!isSelecting) return;
  if (e.detail > 1) {
    // The second click of a double click: the page gets it, and the first click processes nothing. (Only the clicks
    // of this one double click can be waiting: the browser counts a click as the second of a double click when it
    // lands within a few pixels of the first, which another image on the page wouldn't.)
    cancelPendingClicks();
    return;
  }
  const img = selectableImageAt(e);
  if (!img) {
    // An image waiting its turn, clicked again, leaves the queue; otherwise links, buttons and the rest of the page
    // work as usual
    const waiting = waitingJobAt(e);
    if (waiting) {
      e.preventDefault();
      e.stopPropagation();
      waiting.drop();
    }
    return;
  }

  e.preventDefault();
  e.stopPropagation();

  // A video's frame is grabbed now, while it's the frame the user clicked: the player may play on, or replace the
  // element altogether (the next story), before the click's hold-back time is over
  if (img.tagName === 'VIDEO') {
    grabVideoFrame(img);
  }

  // Only a click that stays single processes the image (the green outline stays on it meanwhile). Images clicked one
  // after another each wait on their own, so they all go to the queue.
  clearTimeout(pendingClicks.get(img));
  pendingClicks.set(img, setTimeout(() => {
    pendingClicks.delete(img);
    processClickedImage(img);
  }, DOUBLE_CLICK_MS));
}

async function processClickedImage(img) {
  // (a video whose frame was grabbed is processed even if its player has replaced the element meanwhile: its result
  // then opens in a tab of its own, see swapImage)
  if (!isSelecting || (!img.isConnected && !grabbedFrames.has(img))) return;
  clearHoveredImage();
  if (img.tagName === 'VIDEO') {
    let frame;
    try {
      // Its grabbed frame becomes the picture to process (the mark below is set after, so a frame that can't be
      // read leaves the video to be clicked again)
      frame = await captureVideoFrame(img);
    } catch (error) {
      console.debug('img2img: reading the video frame failed:', error);
      showPageError(error.message);
      return;
    }
    // Held while it's on its way, so this moment of the video isn't started twice over, while every other moment
    // of it stays there to be processed
    markFrameInFlight(img, frame.time);
    img.setAttribute('data-img2img-settings', settingsHash);
    selectedImage = img;
    try {
      await swapImage(img);
    } finally {
      unmarkFrameInFlight(img, frame.time);
    }
    return;
  }
  if (hasResult(img)) {
    // Picked again: as its process again button does (a new seed each run brings a new result)
    await reprocessImage(img);
    return;
  }
  img.setAttribute('data-img2img-settings', settingsHash);
  selectedImage = img;
  await swapImage(img);
}

// The waiting job of the image under the pointer, when it has one (see waitingJobs)
function waitingJobAt(e) {
  if (waitingJobs.size === 0 || e.target.closest?.(OWN_ELEMENTS)) return null;
  const img = imageAt(e.clientX, e.clientY, { backgrounds: true, videos: true });
  for (const [spinner, entry] of waitingJobs) {
    if (spinner.image() === img) return entry;
  }
  return null;
}

function stopImageSelection() {
  isSelecting = false;
  document.body.style.cursor = '';
  clearHoveredImage();
  cancelPendingClicks();
  window.removeEventListener('click', handleImageClick, true);
  window.removeEventListener('mousemove', handleImageHover, true);
  document.documentElement.removeEventListener('mouseleave', clearHoveredImage);
}

// Leaving the page (a link followed, or an image's link opened by a double click) and coming back with Back or
// Forward restores it from the browser's back/forward cache: the same content script, with Manual Selection or
// Automatic Selection still on, so the page took clicks away from its links again although the popup was never
// used — and the jobs they had running are gone anyway, because the port to background.js was disconnected. A
// page that comes back starts like a page that loads.
window.addEventListener('pageshow', event => {
  if (!event.persisted) return;
  if (isSelecting) stopImageSelection();
  if (isContinuousProcessing) stopContinuousProcessing();
});

// The right-click menu's item named after the chosen workflow (background.js builds it): the image that was right-clicked
// is processed with the workflow chosen in the popup, without turning Manual Selection on. A video is taken as
// the frame it showed when the menu opened, as a click on it in Manual Selection takes the frame clicked.
//
// Where the pointer was is kept here, because the menu only passes the image's URL: the position names the right
// image when several on the page share a URL, finds lazy images and CSS backgrounds (which have no srcUrl of their
// own), and needs no matching at all. The URL is the fallback, for a page that moved under the open menu.
let lastRightClick = null;
const RIGHT_CLICK_KEPT_MS = 60 * 1000;

// The browser offers the items by itself only where the element right-clicked is an <img> or a <video>. A picture
// under a page's own empty layer, or one shown as a CSS background, is a click on the page as far as the browser
// can tell, so background.js keeps a second set of items for those and shows it only while told there is such a picture
// under the pointer. It has to know before the menu opens, which is too late to start at the right-click itself
// on systems that open the menu as the button goes down: so it's told as the pointer moves onto another element,
// and again at the button and the menu, and only when the answer has changed.
let coveredPictureTold = null;
function tellMenuWhatIsUnderPointer(event) {
  const target = event.target;
  const offeredAnyway = target?.tagName === 'IMG' || target?.tagName === 'VIDEO';
  const covered = !offeredAnyway && !target?.closest?.(OWN_ELEMENTS)
    && Boolean(imageAt(event.clientX, event.clientY, { backgrounds: true, videos: true }));
  if (covered === coveredPictureTold) return;
  coveredPictureTold = covered;
  try {
    // (no answer is waited for, and none comes when the extension was reloaded under this page)
    chrome.runtime.sendMessage({ action: 'pictureUnderPointer', covered })?.catch?.(() => {});
  } catch (error) { /* the extension was reloaded: this page's script is on its own */ }
}
window.addEventListener('mouseover', tellMenuWhatIsUnderPointer, true);
window.addEventListener('mousedown', event => {
  if (event.button === 2) tellMenuWhatIsUnderPointer(event);
}, true);
// The menu is one for the whole browser, so what another tab said last may stand when this one is come back to
const tellMenuAfresh = () => { coveredPictureTold = null; };
document.addEventListener('visibilitychange', tellMenuAfresh);
document.documentElement.addEventListener('mouseenter', tellMenuAfresh);

window.addEventListener('contextmenu', event => {
  tellMenuWhatIsUnderPointer(event);
  // A video's frame is taken as the menu opens, while it's the frame under the pointer: the player plays on under
  // the open menu, and is paused only once the workflow's item is chosen (runWorkflowOnRightClickedImage)
  const video = imageAt(event.clientX, event.clientY, { videos: true });
  if (video?.tagName === 'VIDEO') grabVideoFrame(video, { pause: false });
  const picture = imageAt(event.clientX, event.clientY, { backgrounds: true, videos: true });
  lastRightClick = { x: event.clientX, y: event.clientY, time: Date.now(), shown: picture && shownForDownload(picture) };
}, true);

// Every URL an element's image can be known by (what the menu's srcUrl is compared against)
function imageUrlsOf(element) {
  return [element.currentSrc, element.src, element.getAttribute('data-original-src'), lazySourceUrl(element)].filter(Boolean);
}

function rightClickedImage(srcUrl) {
  const fresh = lastRightClick && Date.now() - lastRightClick.time < RIGHT_CLICK_KEPT_MS;
  const atPointer = fresh ? imageAt(lastRightClick.x, lastRightClick.y, { backgrounds: true, videos: true }) : null;
  if (atPointer && (atPointer.tagName !== 'IMG' || !srcUrl || imageUrlsOf(atPointer).includes(srcUrl))) return atPointer;
  return (srcUrl && (allImages().find(img => imageUrlsOf(img).includes(srcUrl))
    || allVideos().find(video => videoMediaSrc(video) === srcUrl))) || atPointer;
}

async function runWorkflowOnRightClickedImage({ srcUrl, sourceId }) {
  if (sourceId !== undefined) selectedSourceId = sourceId;
  const img = rightClickedImage(srcUrl);
  if (!img) {
    // Images in a frame of the page are the usual case: the content script only runs in the page itself
    showPageError("Couldn't find that image on the page. Open the image in its own tab and try again.");
    return;
  }
  // Marked as Manual Selection marks it, so Automatic Selection and a later click don't do it over again
  settingsHash = hashBase64("", await getSettings());
  if (img.tagName === 'VIDEO') {
    // The frame taken as the menu opened, if the video still plays that media; otherwise the one it shows now
    const grab = grabbedFrames.get(img);
    if (grab && grab.mediaSrc === videoMediaSrc(img)) {
      img.pause(); // (as a click in Manual Selection does: the result goes over this frame)
    } else {
      grabVideoFrame(img);
    }
    let frame;
    try {
      frame = await captureVideoFrame(img);
    } catch (error) {
      console.debug('img2img: reading the video frame failed:', error);
      showPageError(error.message);
      return;
    }
    markFrameInFlight(img, frame.time);
    img.setAttribute('data-img2img-settings', settingsHash);
    selectedImage = img;
    try {
      await swapImage(img);
    } finally {
      unmarkFrameInFlight(img, frame.time);
    }
    return;
  }
  img.setAttribute('data-img2img-settings', settingsHash);
  selectedImage = img;
  await swapImage(img);
}

// The right-click menu's Download item (background.js builds it): what the right-clicked picture showed when the
// menu opened is saved, though the page may have moved on to another picture by the time Download is chosen (a
// story playing on under the open menu). A result on show is saved as its download button saves it (and its
// original too, with Double Download on); anything else as it is, in its own format and named after its file; a
// video as the frame it showed, as a PNG. The video plays on: saving a frame isn't processing it. Where there's no
// picture to be found (an image in a frame of the page), the menu's srcUrl is saved as it is.
async function downloadRightClickedImage({ srcUrl }) {
  try {
    const shown = shownAtRightClick(srcUrl);
    if (shown?.result) {
      await downloadSwappedImage(shown.picture, shown); // (says on the page itself when it fails)
    } else if (shown?.grab) {
      const { grab } = shown;
      await savePictureAsIs(await pngOfGrab(grab, 'save'), `${pictureFileBase(grab.mediaSrc)}-frame-${grab.time.toFixed(2)}s`);
    } else {
      const url = shown?.url || srcUrl;
      if (!url) throw new Error("couldn't find that image on the page");
      await savePictureAsIs(await fetchImageBlob(url, { asIs: true }), pictureFileBase(url));
    }
  } catch (error) {
    showDownloadError(error);
  }
}

// What Download saves of a picture, as it is on show now: { picture, urls, and result + original | grab | url }.
// urls are what the browser's menu may name it by (its srcUrl), for telling whether the menu was opened over it.
function shownForDownload(picture) {
  const urls = picture.tagName === 'IMG' ? imageUrlsOf(picture)
    : picture.tagName === 'VIDEO' ? [picture.currentSrc, picture.src].filter(Boolean) : [];
  if (showsItsResult(picture)) return { picture, urls, ...resultOnShow(picture) };
  // (the frame grabbed as the menu opened: see the contextmenu listener)
  if (picture.tagName === 'VIDEO') return { picture, urls, grab: grabbedFrames.get(picture) };
  const url = picture.tagName === 'IMG' ? lazySourceUrl(picture) || picture.currentSrc || picture.src : imageSrc(picture);
  return { picture, urls, url };
}

// What the picture the menu was opened over showed then. The menu's srcUrl, where the browser gives one, has to be
// that picture's, or the menu was opened somewhere this page didn't see (an image in a frame of the page): then the
// picture is looked for now, as the workflow's item looks for it.
function shownAtRightClick(srcUrl) {
  const fresh = lastRightClick && Date.now() - lastRightClick.time < RIGHT_CLICK_KEPT_MS;
  const kept = fresh ? lastRightClick.shown : null;
  if (kept && (!srcUrl || !kept.urls.length || kept.urls.includes(srcUrl))) return kept;
  const picture = rightClickedImage(srcUrl);
  if (!picture) return null;
  if (picture.tagName === 'VIDEO') grabVideoFrame(picture, { pause: false });
  return shownForDownload(picture);
}

// Whether an element has one of our results on show, rather than its original (toggled back to, or never processed)
function showsItsResult(element) {
  if (revertedResults.has(element)) return false;
  return element.tagName === 'VIDEO' ? showsAResult(shownOverVideo.get(element)) : hasResult(element);
}

// Save a picture as it is (background.js gives it its own format's extension)
async function savePictureAsIs(blob, name) {
  const response = await chrome.runtime.sendMessage({ action: 'downloadPicture', dataUrl: await blobToDataUrl(blob), name });
  if (!response?.success) throw new Error(response?.error || 'Download failed');
}

// What a picture saved as it is is called: its file's name where its address has one, else the page's title
function pictureFileBase(url) {
  let name = '';
  try {
    const parsed = new URL(url, location.href);
    if (/^https?:$/.test(parsed.protocol)) name = decodeURIComponent(parsed.pathname.split('/').pop());
  } catch (error) {
    // Not an address, or not valid percent-encoding: the page's title instead
  }
  return cleanForFileName(name.replace(/\.[^.]*$/, '')) || shortPageTitle() || cleanForFileName(location.hostname) || 'image';
}

// Helper to get ComfyUI server address from storage
// Used by: web pages, the result tab, the Library.
async function getComfyServerAddress() {
  return new Promise(resolve => {
    chrome.storage.local.get(['comfyServerAddress'], result => {
      resolve(result.comfyServerAddress || 'http://127.0.0.1:8188');
    });
  });
}

// Used by: web pages, the result tab, the Library.
function hashBase64(base64, settings) {
  // Combine all settings relevant to the selected workflow into a single string
  let settingsString;
  const workflow = effectiveWorkflow(settings);
  if (isCustomWorkflow(workflow)) {
    // The user's own workflow: its definition's version and the popup's values for it
    // (and whether it keeps its workflow: that result is another file, so it's cached apart)
    settingsString = JSON.stringify({
      ...customWorkflowCacheKey(settings.customWorkflow, settings.customWorkflowValues, selectedSourceId),
      comfyServerAddress: settings.comfyServerAddress || 'http://127.0.0.1:8188',
      ...(settings.keepWorkflowInResult === true ? { keepWorkflow: true } : {}),
    });
  } else if (workflow === 'controlnet') {
    // No source: changing it shouldn't re-run the preprocessor
    const preprocessor = settings.controlnetPreprocessor || CONTROLNET_DEFAULT_PREPROCESSOR;
    settingsString = JSON.stringify({
      workflow, preprocessor, options: settings.controlnetOptions?.[preprocessor] || {},
      resolution: Number(settings.controlnetResolution) || CONTROLNET_DEFAULT_RESOLUTION,
      comfyServerAddress: settings.comfyServerAddress || 'http://127.0.0.1:8188',
    });
  } else if (['upscale', 'background', 'restore', 'colorize', 'cleanup', 'sticker', 'idPhoto', 'faceBlur', 'filter', 'transform', 'segment'].includes(workflow)) {
    // Only this workflow's own settings, so changing the source or another workflow's settings keeps the cache
    const own = {
      upscale: { model: settings.upscaleModel || UPSCALE_DEFAULT_MODEL, scale: Number(settings.upscaleScale) || UPSCALE_DEFAULT_SCALE },
      background: {
        mode: settings.backgroundMode || BACKGROUND_DEFAULTS.mode,
        color: settings.backgroundMode === 'color' ? settings.backgroundColor || BACKGROUND_DEFAULTS.color : null,
        blur: settings.backgroundMode === 'blur' ? Number(settings.backgroundBlur ?? BACKGROUND_DEFAULTS.blur) : null,
        // (only for the newer modes, so the results cached for the others keep their keys)
        ...(settings.backgroundMode === 'gradient' && { colors: [settings.backgroundColor || BACKGROUND_DEFAULTS.color, settings.backgroundColor2 || BACKGROUND_DEFAULTS.color2] }),
        ...(usesSourceImage(settings) && { source: selectedSourceId }),
      },
      restore: {
        model: settings.restoreModel || RESTORE_DEFAULTS.model,
        strength: Number(settings.restoreStrength ?? RESTORE_DEFAULTS.strength),
        fidelity: Number(settings.restoreFidelity ?? RESTORE_DEFAULTS.fidelity),
      },
      colorize: { strength: Number(settings.colorizeStrength ?? COLORIZE_DEFAULTS.strength) },
      cleanup: { mode: settings.cleanupMode || CLEANUP_DEFAULTS.mode },
      sticker: {
        outline: Number(settings.stickerOutline ?? STICKER_DEFAULTS.outline),
        color: settings.stickerColor || STICKER_DEFAULTS.color,
        shadow: settings.stickerShadow ?? STICKER_DEFAULTS.shadow,
      },
      idPhoto: { size: settings.idPhotoSize || ID_PHOTO_DEFAULTS.size, background: settings.idPhotoBackground || ID_PHOTO_DEFAULTS.background },
      faceBlur: { style: settings.faceBlurStyle || FACE_BLUR_DEFAULTS.style, strength: Number(settings.faceBlurStrength ?? FACE_BLUR_DEFAULTS.strength) },
      filter: { style: settings.filterStyle || FILTER_DEFAULTS.style, strength: Number(settings.filterStrength ?? FILTER_DEFAULTS.strength) },
      transform: { preset: settings.transformPreset || TRANSFORM_DEFAULTS.preset, variation: Number(settings.transformVariation) || TRANSFORM_DEFAULTS.variation },
      segment: {
        prompt: segmentPrompt(settings.segmentPrompt),
        threshold: Number(settings.segmentThreshold ?? SEGMENT_DEFAULTS.threshold),
        output: settings.segmentOutput || SEGMENT_DEFAULTS.output,
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

// Used by: web pages, the result tab, the Library.
async function getFromCache(hash, imageUrl, allowLooseCacheLink = false) {
  try {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'getFromCache', hash, imageUrl, allowLooseCacheLink }, response => {
        if (response.success) {
          // (the key the cache holds it under: what its delete button removes it by)
          if (response.result && response.hash) resultKeys.set(response.result, response.hash);
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

// Local mode builds the shared workflows (shared/workflows.js: SHARED_WORKFLOWS).

// NSFW check for the graphs built here (see addSafetyCheck in shared/workflows.js). img2img is SFW-only; this stays on
// for release. (False positives are tuned with NSFW_SENSITIVITY, off if set to 0.)
const NSFW_SENSITIVITY = 0.5;
const NSFW_GATE_ENABLED = true;
const NSFW = { enabled: NSFW_GATE_ENABLED, sensitivity: NSFW_SENSITIVITY };

// A ComfyUI node class's object_info, or null when it isn't installed (cached per page)
const nodeInfoCache = new Map();
// Used by: web pages, the result tab, the Library.
async function getNodeInfo(nodeClass) {
  if (!nodeInfoCache.has(nodeClass)) {
    const response = await chrome.runtime.sendMessage({ action: 'comfyRequest', url: `/object_info/${encodeURIComponent(nodeClass)}`, method: 'GET' });
    nodeInfoCache.set(nodeClass, (response.success && response.data[nodeClass]) || null);
  }
  return nodeInfoCache.get(nodeClass);
}

// Used by: web pages, the result tab, the Library.
async function isNodeAvailable(nodeClass) {
  return Boolean(await getNodeInfo(nodeClass));
}

// Build the workflow selected in settings, for the user's own ComfyUI (local mode)
// Used by: web pages, the result tab, the Library.
async function buildWorkflow(targetImage, settings, imageSize) {
  const workflow = effectiveWorkflow(settings);
  if (!SHARED_WORKFLOWS.includes(workflow) && !isCustomWorkflow(workflow)) {
    throw new Error(NOT_LOCAL_WORKFLOW_ERROR);
  }
  // One of the user's own workflows, deleted since it was chosen (getSettings puts the popup's choice in its place
  // the next time round; this catches a run begun with it before that)
  if (isCustomWorkflow(workflow) && !settings.customWorkflow) {
    throw new Error(CUSTOM_WORKFLOW_MISSING_ERROR);
  }
  // Fail closed: without comfyui-tooling-nodes' filter to check for adult content, nothing is processed
  if (NSFW_GATE_ENABLED && !await isNodeAvailable(NSFW_CHECK_NODE)) {
    nodeInfoCache.delete(NSFW_CHECK_NODE); // re-check next time in case it gets installed
    throw new Error('img2img needs comfyui-tooling-nodes in ComfyUI to check images for adult content: install it and restart ComfyUI');
  }
  if (isCustomWorkflow(workflow)) {
    return buildCustomWorkflow(settings.customWorkflow, targetImage, settings.customWorkflowValues, NSFW, await customSourceImages(settings));
  }
  // The shared builders don't talk to ComfyUI: look up the nodes they need to know about first
  const nodes = {};
  for (const nodeClass of workflowNodeQueries(workflow, settings)) {
    nodes[nodeClass] = await getNodeInfo(nodeClass);
    // A node that's missing, or whose model list may grow (the face detection model), is looked up again next time
    if (!nodes[nodeClass] || workflow !== 'controlnet') {
      nodeInfoCache.delete(nodeClass);
    }
  }
  // A background replaced by an image: the image selected in the Source grid
  const source = usesSourceImage(settings) && selectedSourceId ? await getSource(selectedSourceId).catch(() => null) : null;
  const sourceImages = source?.dataUrls || (source?.dataUrl ? [source.dataUrl] : []);
  return buildSharedWorkflow(workflow, targetImage, settings, imageSize, { nodeInfo: nodeClass => nodes[nodeClass] || null, nsfw: NSFW, sourceImages });
}

// The images for a custom workflow's source inputs, { node: [base64, ...] }: each picker's source (picked in the
// popup, or the one selected in its grid), shared out to its Load Image nodes (sourceImagesByNode)
// Used by: web pages, the result tab, the Library.
async function customSourceImages(settings) {
  const images = {};
  for (const group of sourceGroups(settings.customWorkflow)) {
    const sourceId = settings.customWorkflowValues?.[`source:${group.key}`] || selectedSourceId;
    const source = sourceId ? await getSource(sourceId).catch(() => null) : null;
    const dataUrls = source?.dataUrls || (source?.dataUrl ? [source.dataUrl] : []);
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
// image or the result, a button that compares the two on the image itself, one that processes the image again
// (reprocessImage) and one that deletes the result from the cache. One animation-frame loop keeps them all pinned to
// their image's top-right corner.
const downloadButtons = new Map();
const revertButtons = new Map();
const compareButtons = new Map();
const reprocessButtons = new Map();
const deleteButtons = new Map();
// Images toggled back to their original, with the result to switch back to
const revertedResults = new Map();
const DOWNLOAD_BUTTON_SIZE = 32;
const BUTTON_HOVER = 'rgba(52, 113, 219, 0.9)';
const DELETE_HOVER = 'rgba(198, 40, 40, 0.9)'; // (red, as the viewer's delete button goes)
// Which image each icon belongs to, so the pointer being on one counts as being on its image (an icon can reach
// past the bottom of a short image)
const overlayOwners = new WeakMap();

// "Show Icons on Hover" (resultIconsOnHover, off by default): with it on, a processed image's icons wait for the
// pointer to be over the image or over one of them; with it off they're there for as long as the result is.
let iconsOnHover = false;
chrome.storage.local.get('resultIconsOnHover', ({ resultIconsOnHover }) => { iconsOnHover = resultIconsOnHover === true; });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.resultIconsOnHover) iconsOnHover = changes.resultIconsOnHover.newValue === true;
});

// Where the pointer is, read by positionDownloadButtons every frame. Listened for in the capture phase, so a
// page that stops the event on the way doesn't blind us, and passively, so this never holds up its scrolling.
let pointerAt = null; // { x, y } in viewport coordinates; null before the pointer moves and once it leaves
let pointerOnImage = null; // the image whose own icon the pointer is on, if any
function trackPointer(event) {
  pointerAt = { x: event.clientX, y: event.clientY };
  pointerOnImage = overlayOwners.get(event.target) || null;
}
for (const name of ['pointermove', 'pointerdown']) {
  document.addEventListener(name, trackPointer, { capture: true, passive: true });
}
// On <html> itself, where it means the pointer has left the window: pointerleave doesn't bubble, but a capturing
// listener at the document would still see every element the pointer leaves on the way across the page
document.documentElement.addEventListener('pointerleave', () => { pointerAt = null; pointerOnImage = null; }, { passive: true });

// With "Show Icons on Hover" on: whether the pointer is over this image, or over the column its icons are in,
// which reaches 8px below the image's top for six rows and can pass the bottom edge of a short image
const ICON_COLUMN_ROWS = 6; // download, revert, compare, process again, delete, and the result dropdown under them
// Used by: web pages, the result tab.
function pointerOverIcons(imgElement, rect) {
  if (pointerOnImage === imgElement) return true;
  if (!pointerAt) return false;
  const { x, y } = pointerAt;
  // (a visibleRect is { top, right, width, height }, as isCovered reads it too)
  if (x >= rect.right - rect.width && x <= rect.right && y >= rect.top && y <= rect.top + rect.height) return true;
  return x >= rect.right - 8 - DOWNLOAD_BUTTON_SIZE && x <= rect.right
    && y >= rect.top && y <= rect.top + 8 + ICON_COLUMN_ROWS * (DOWNLOAD_BUTTON_SIZE + 6);
}
const REVERT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9h11a5 5 0 0 1 0 10H9"/><path d="M8 5L4 9l4 4"/></svg>';
const COMPARE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="M12 5v14"/></svg>';
const RESULT_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 9H9a5 5 0 0 0 0 10h6"/><path d="M16 5l4 4-4 4"/></svg>';
const REPROCESS_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
const DELETE_ICON = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>';

// Used by: web pages, the result tab.
function addDownloadButton(imgElement) {
  if (downloadButtons.has(imgElement)) {
    // Re-processed: the image shows a new result, so its downloaded state has to be checked again, and a video
    // may have another frame to pick from
    revertedResults.delete(imgElement);
    updateRevertButton(imgElement);
    refreshDownloadButtonStates();
    refreshResultSelect(imgElement);
    loadGenerations(imgElement);
    return;
  }
  const button = createOverlayButton(imgElement, 'img2img-download', 'Download processed image', '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>', () => downloadSwappedImage(imgElement));
  downloadButtons.set(imgElement, button);
  revertButtons.set(imgElement, createOverlayButton(imgElement, 'img2img-revert', '', '', () => toggleOriginal(imgElement)));
  updateRevertButton(imgElement);
  compareButtons.set(imgElement, createOverlayButton(imgElement, 'img2img-compare', 'Compare with the original', COMPARE_ICON, () => compareWithOriginal(imgElement)));
  reprocessButtons.set(imgElement, createOverlayButton(imgElement, 'img2img-reprocess', 'Process again', REPROCESS_ICON, () => reprocessImage(imgElement)));
  deleteButtons.set(imgElement, createOverlayButton(imgElement, 'img2img-delete', 'Delete from the cache', DELETE_ICON, () => deleteResult(imgElement), DELETE_HOVER));
  refreshResultSelect(imgElement);
  loadGenerations(imgElement);
  refreshDownloadButtonStates();
  if (downloadButtons.size === 1) {
    requestAnimationFrame(positionDownloadButtons);
  }
}

// Switch a processed image between its original and the result
// Used by: web pages, the result tab.
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

// A processed image is compared with its original where it is: the compare button lays the pair over the image,
// one over the other with a divider dragged across them (the slider) or next to each other, and the same button
// takes the comparison off again. A small bar on the image's top-left corner switches between the two views
// (the one used last is kept in compareView), saves the pair as one picture, and closes. A result tab uses this
// too (viewer.js), where the side-by-side view has the whole window to itself rather than the image's own room.
const comparisons = new Map(); // element -> its comparison: { root, bar, shown, fillsWindow(), place(area) }
const comparisonsOpening = new WeakSet();
// Where side by side goes on a page of the extension's own, which gives it more room than the image's: a function
// answering { left, top, width, height }. The Library page sets it to its viewer pane (library.js); a result tab
// has the whole window without setting anything (roomForSideBySide). On a web page there is none: the two halves
// share the image's own room.
let sideBySideRoom = null;

// Used by: web pages, the result tab, the Library.
function roomForSideBySide() {
  if (sideBySideRoom) return sideBySideRoom();
  return isResultTab ? { left: 0, top: 0, width: document.documentElement.clientWidth, height: document.documentElement.clientHeight } : null;
}
const COMPARE_VIEW_SETTING = 'compareView';
// The captions need room: narrower than this they'd run into each other, shorter and the image's icons, which
// go down its right side, would sit on one
const COMPARISON_LABELS_FROM = { width: 300, height: 220 };
const SLIDER_VIEW_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v18"/><path d="M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg>';
const SIDE_VIEW_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5" width="7.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="7.5" height="14" rx="1.5"/></svg>';
const SAVE_PAIR_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>';
const CLOSE_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 6l12 12M18 6L6 18"/></svg>';
const GRIP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10 5 4 12l6 7M14 5l6 7-6 7"/></svg>';
// Behind the pair, and showing through a transparent result
const COMPARISON_BACKDROP = 'repeating-conic-gradient(#262626 0% 25%, #1c1c1c 0% 50%) 50% / 24px 24px';
// Side by side, around the two pictures: plain, so the checkerboard is only ever behind a picture
const SIDE_BY_SIDE_SURROUND = '#111';

// The compare button of an image on a page: the original is read the same way as for processing, so images from
// other sites and blob: URLs work too. Both go in as data: URLs, which nothing here takes for a page image.
// Used by: web pages, the result tab.
function compareWithOriginal(imgElement) {
  return toggleComparison(imgElement, async () => {
    const result = revertedResults.get(imgElement) || imageSrc(imgElement);
    // A video's original is the frame that was processed, which is here already
    const frame = videoFrames.get(imgElement);
    const original = frame
      ? frame.dataUrl
      : await blobToDataUrl(await fetchImageBlob(imgElement.getAttribute('data-original-src')));
    return { original, result, name: await nameOfResult(result) };
  });
}

// Puts the comparison on an element, or takes it off if it's there. loadPair gives { original, result, name }:
// the two pictures as URLs an <img> can show, and the start of the saved picture's name.
// Used by: web pages, the result tab.
async function toggleComparison(element, loadPair) {
  if (comparisons.has(element)) {
    closeComparison(element);
    return;
  }
  if (comparisonsOpening.has(element)) return;
  comparisonsOpening.add(element);
  try {
    const shown = imageSrc(element);
    const pair = await loadPair();
    // (the image moved on while its original was being read)
    if (!element.isConnected || imageSrc(element) !== shown) return;
    const stored = await chrome.storage.local.get(COMPARE_VIEW_SETTING);
    openComparison(element, pair, stored?.[COMPARE_VIEW_SETTING] === 'side' ? 'side' : 'slider');
  } catch (error) {
    showPageError(`Couldn't compare: ${error.message}`);
  } finally {
    comparisonsOpening.delete(element);
  }
}

// Used by: web pages, the result tab, the Library.
function closeComparison(element) {
  const comparison = comparisons.get(element);
  if (!comparison) return;
  comparison.root.remove();
  comparison.bar.remove();
  comparisons.delete(element);
  element.removeAttribute('data-img2img-comparing');
}

// How an element frames its picture, for the slider to frame the pair the same way: [object-fit, object-position]
// Used by: web pages, the result tab, the Library.
function framingOf(element) {
  const style = getComputedStyle(element);
  if (element.tagName === 'IMG' || element.tagName === 'VIDEO') {
    return [style.objectFit || 'fill', style.objectPosition || '50% 50%'];
  }
  return [style.backgroundSize === 'cover' ? 'cover' : 'contain', style.backgroundPosition || '50% 50%'];
}

// A box of the comparison, clear of whatever the page's own styles would give it
// Used by: web pages, the result tab, the Library.
function comparisonBox(style, tag = 'div') {
  const box = document.createElement(tag);
  Object.assign(box.style, { margin: '0', padding: '0', border: 'none', boxSizing: 'border-box', minWidth: '0', minHeight: '0', maxWidth: 'none', maxHeight: 'none' }, style);
  return box;
}

// Used by: web pages, the result tab, the Library.
function comparisonImage(src, alt, fit, position) {
  const img = comparisonBox({
    position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', display: 'block', borderRadius: '0',
    background: 'none', boxShadow: 'none', opacity: '1', transform: 'none', filter: 'none',
    objectFit: fit, objectPosition: position, pointerEvents: 'none', userSelect: 'none',
  }, 'img');
  img.alt = alt;
  img.draggable = false;
  img.src = src;
  return img;
}

// A caption on a picture of the pair: which one it is, and its size once it has loaded
// Used by: web pages, the result tab, the Library.
function comparisonLabel(img, text, style) {
  const label = comparisonBox({
    position: 'absolute', bottom: '8px', padding: '3px 8px', borderRadius: '10px', background: 'rgba(0, 0, 0, 0.6)',
    color: '#fff', font: '12px/1.3 Arial, sans-serif', whiteSpace: 'nowrap', pointerEvents: 'none', ...style,
  }, 'span');
  const write = () => {
    label.textContent = img.naturalWidth ? `${text} · ${img.naturalWidth} × ${img.naturalHeight}` : text;
  };
  img.addEventListener('load', write);
  write();
  return label;
}

// Used by: web pages, the result tab, the Library.
function openComparison(element, { original, result, name }, firstView) {
  const [fit, position] = framingOf(element);
  const radius = getComputedStyle(element).borderRadius;
  const root = comparisonBox({
    position: 'fixed', top: '0', left: '0', overflow: 'hidden', display: 'none', background: COMPARISON_BACKDROP,
    // Dragging moves the divider, rather than scrolling the page or selecting what's on it
    touchAction: 'none', userSelect: 'none', zIndex: '2147483646', // under img2img's own buttons
  });
  root.className = 'img2img-comparison';

  // The slider: both pictures framed as the image frames its own, the processed one clipped at the divider
  const slider = comparisonBox({ position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', cursor: 'ew-resize' });
  const sliderOriginal = comparisonImage(original, 'Original image', fit, position);
  const sliderResult = comparisonImage(result, 'Processed image', fit, position);
  const handle = comparisonBox({
    position: 'absolute', top: '0', bottom: '0', width: '2px', marginLeft: '-1px', background: 'rgba(255, 255, 255, 0.9)',
    boxShadow: '0 0 0 1px rgba(0, 0, 0, 0.35)', cursor: 'ew-resize', outline: 'none',
  });
  handle.setAttribute('role', 'slider');
  handle.setAttribute('aria-label', 'Divider between the original and the processed image');
  handle.setAttribute('aria-valuemin', '0');
  handle.setAttribute('aria-valuemax', '100');
  handle.tabIndex = 0;
  const grip = comparisonBox({
    position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', width: '30px', height: '30px',
    borderRadius: '50%', background: 'rgba(255, 255, 255, 0.92)', boxShadow: '0 1px 4px rgba(0, 0, 0, 0.4)', color: '#333',
    display: 'flex', alignItems: 'center', justifyContent: 'center',
  }, 'span');
  setIcon(grip, GRIP_ICON);
  handle.append(grip);
  const sliderLabels = [
    comparisonLabel(sliderOriginal, 'Original', { left: '8px' }),
    comparisonLabel(sliderResult, 'Processed', { right: '8px' }),
  ];
  slider.append(sliderOriginal, sliderResult, handle, ...sliderLabels);

  // Side by side: each picture whole and as large as fits its half, the two meeting in the middle, with the
  // checkerboard behind the pictures only (on the pictures themselves, sized to them: see layoutSide)
  const side = comparisonBox({ position: 'absolute', top: '0', left: '0', width: '100%', height: '100%', display: 'none', background: SIDE_BY_SIDE_SURROUND });
  const half = (src, alt, text, towards) => {
    const cell = comparisonBox({ position: 'relative', flex: '1 1 0', overflow: 'hidden' });
    const img = comparisonImage(src, alt, 'fill', '50% 50%');
    img.style.background = COMPARISON_BACKDROP;
    const label = comparisonLabel(img, text, { transform: 'translateX(-50%)' });
    cell.append(img, label);
    side.append(cell);
    img.addEventListener('load', () => layoutSide());
    return { cell, img, label, towards };
  };
  const sideOriginal = half(original, 'Original image', 'Original', 'right');
  const sideResult = half(result, 'Processed image', 'Processed', 'left');
  // Each picture scaled to fit its half, against the middle and centred top to bottom, its caption under it
  const layoutSide = () => {
    if (side.style.display === 'none') return;
    for (const { cell, img, label, towards } of [sideOriginal, sideResult]) {
      const room = { width: cell.clientWidth, height: cell.clientHeight };
      if (!img.naturalWidth || !room.width || !room.height) continue;
      const scale = Math.min(room.width / img.naturalWidth, room.height / img.naturalHeight);
      const width = img.naturalWidth * scale;
      const height = img.naturalHeight * scale;
      const left = towards === 'right' ? room.width - width : 0;
      const top = (room.height - height) / 2;
      Object.assign(img.style, { left: `${left}px`, top: `${top}px`, width: `${width}px`, height: `${height}px` });
      Object.assign(label.style, { left: `${left + width / 2}px`, bottom: `${top + 8}px` });
    }
  };
  const labels = [...sliderLabels, sideOriginal.label, sideResult.label];
  root.append(slider, side);

  // Where the divider is, as the share of the width showing the original
  let split = 50;
  const setSplit = value => {
    split = Math.min(100, Math.max(0, value));
    handle.style.left = `${split}%`;
    sliderResult.style.clipPath = `inset(0 0 0 ${split}%)`;
    const shown = Math.round(split);
    handle.setAttribute('aria-valuenow', String(shown));
    handle.setAttribute('aria-valuetext', `${shown}% original, ${100 - shown}% processed`);
  };
  const splitAt = clientX => {
    const { left, width } = root.getBoundingClientRect();
    if (width) setSplit(((clientX - left) / width) * 100);
  };
  setSplit(split);

  let view = firstView;
  // Pressing anywhere on the pictures takes the divider there and then it follows the pointer, which the capture
  // keeps up past the image's edges and outside the window. None of it reaches the page under the comparison.
  root.addEventListener('pointerdown', event => {
    event.stopPropagation();
    if (view !== 'slider' || event.button !== 0) return;
    event.preventDefault();
    root.setPointerCapture(event.pointerId);
    handle.focus({ preventScroll: true });
    splitAt(event.clientX);
  });
  root.addEventListener('pointermove', event => {
    if (root.hasPointerCapture(event.pointerId)) splitAt(event.clientX);
  });
  for (const type of ['click', 'dblclick', 'mousedown', 'mouseup', 'pointerup']) {
    root.addEventListener(type, event => {
      event.stopPropagation();
      if (type === 'click') event.preventDefault();
    });
  }
  // The divider is also a slider for the keyboard: the arrows step across it, Home and End go to either picture.
  // Escape closes the comparison, from the divider or from the bar.
  const onKey = event => {
    const step = event.shiftKey ? 10 : 2;
    if (event.key === 'Escape') closeComparison(element);
    else if (event.target !== handle) return;
    else if (event.key === 'ArrowLeft') setSplit(split - step);
    else if (event.key === 'ArrowRight') setSplit(split + step);
    else if (event.key === 'Home') setSplit(0);
    else if (event.key === 'End') setSplit(100);
    else return;
    event.preventDefault();
    event.stopPropagation();
  };
  root.addEventListener('keydown', onKey);

  // The bar: the two views, the pair as one picture, and close
  const bar = comparisonBox({
    position: 'fixed', top: '0', left: '0', display: 'none', gap: '2px', padding: '3px', borderRadius: '16px',
    background: 'rgba(0, 0, 0, 0.6)', zIndex: '2147483647',
  });
  bar.className = 'img2img-comparison';
  bar.setAttribute('role', 'group');
  bar.setAttribute('aria-label', 'Comparison');
  bar.addEventListener('keydown', onKey);
  const barButton = (title, icon, onClick) => {
    const button = comparisonBox({
      width: '26px', height: '26px', borderRadius: '50%', background: 'transparent', color: '#fff', cursor: 'pointer',
      display: 'flex', alignItems: 'center', justifyContent: 'center',
    }, 'button');
    button.type = 'button';
    button.title = title;
    setIcon(button, icon);
    const paint = hovered => {
      button.style.background = button.getAttribute('aria-pressed') === 'true' || (hovered && !button.disabled) ? BUTTON_HOVER : 'transparent';
    };
    button.addEventListener('mouseenter', () => paint(true));
    button.addEventListener('mouseleave', () => paint(false));
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      onClick(button);
      paint(false);
    });
    bar.append(button);
    return button;
  };
  const showView = name => {
    view = name;
    slider.style.display = name === 'slider' ? 'block' : 'none';
    side.style.display = name === 'side' ? 'flex' : 'none';
    layoutSide();
    for (const [button, its] of [[sliderButton, 'slider'], [sideButton, 'side']]) {
      button.setAttribute('aria-pressed', String(its === name));
      button.style.background = its === name ? BUTTON_HOVER : 'transparent';
    }
    // (read by the result tab's own buttons, which step aside while the comparison has the window)
    element.setAttribute('data-img2img-comparing', comparison.fillsWindow() ? 'window' : 'image');
  };
  const pickView = name => {
    showView(name);
    chrome.storage.local.set({ [COMPARE_VIEW_SETTING]: name });
  };
  const sliderButton = barButton('Slider: one over the other, with a divider to drag across them', SLIDER_VIEW_ICON, () => pickView('slider'));
  const sideButton = barButton('Side by side', SIDE_VIEW_ICON, () => pickView('side'));
  barButton('Download both as one picture', SAVE_PAIR_ICON, button => saveComparison(button, sideOriginal.img, sideResult.img, name));
  barButton('Close the comparison', CLOSE_ICON, () => closeComparison(element));

  const comparison = {
    root,
    bar,
    shown: imageSrc(element),
    // In a result tab the two halves get the window, on the Library page its viewer: the image's own room would
    // show each at half its size
    fillsWindow: () => view === 'side' && Boolean(roomForSideBySide()),
    // The view on show ('slider' or 'side'), and a way to change it for a page with controls of its own for that
    view: () => view,
    show: name => showView(name),
    // Laid over area ({ left, top, width, height }), showing the part of it that seen leaves ('none' for all)
    place(area, clip) {
      Object.assign(root.style, {
        display: 'block',
        left: `${area.left}px`,
        top: `${area.top}px`,
        width: `${area.width}px`,
        height: `${area.height}px`,
        clipPath: clip,
        borderRadius: comparison.fillsWindow() ? '0' : radius,
      });
      const room = area.width >= COMPARISON_LABELS_FROM.width && area.height >= COMPARISON_LABELS_FROM.height;
      for (const label of labels) label.style.display = room ? 'block' : 'none';
      layoutSide();
    },
  };
  comparisons.set(element, comparison);
  document.documentElement.append(root, bar);
  showView(firstView);
  if (comparisons.size === 1) requestAnimationFrame(positionComparisons);
}

// Keeps every comparison on its image, like the buttons: clipped to the part of the image that's on screen, away
// while the image is off screen or under something else, and gone with the picture it was opened on (another
// result picked, the original toggled back, the result deleted, the image off the page)
// Used by: web pages, the result tab, the Library.
function positionComparisons() {
  for (const [element, comparison] of comparisons) {
    if (!element.isConnected || imageSrc(element) !== comparison.shown) {
      closeComparison(element);
      continue;
    }
    const { root, bar } = comparison;
    if (!root.isConnected) document.documentElement.append(root, bar); // (a page that replaced <html>'s children)
    const seen = visibleRect(element);
    if (seen.width < 64 || seen.height < 64 || isCovered(element, seen)) {
      root.style.display = bar.style.display = 'none';
      continue;
    }
    let corner;
    if (comparison.fillsWindow()) {
      const room = roomForSideBySide();
      corner = { left: room.left, top: room.top };
      comparison.place(room, 'none');
    } else {
      const rect = element.getBoundingClientRect();
      corner = { left: seen.right - seen.width, top: seen.top };
      const inset = [
        seen.top - rect.top,
        rect.right - seen.right,
        rect.bottom - (seen.top + seen.height),
        corner.left - rect.left,
      ].map(edge => `${Math.max(0, edge)}px`).join(' ');
      comparison.place({ left: rect.left, top: rect.top, width: rect.width, height: rect.height }, `inset(${inset})`);
    }
    bar.style.display = 'flex';
    bar.style.left = `${corner.left + 8}px`;
    bar.style.top = `${corner.top + 8}px`;
  }
  if (comparisons.size > 0) requestAnimationFrame(positionComparisons);
}

// The composed picture's longest side, so a pair of large images still makes a picture the browser can save
const MAX_SIDE_BY_SIDE = 6000;

// The two images in one picture: side by side, each scaled to the taller one's height (so a small original is
// enlarged next to an upscale), with a caption under each. Returns a PNG data URL.
// Used by: web pages, the result tab, the Library.
function composeSideBySide(originalImg, resultImg) {
  // A picture saved from a result tab or the Library page takes that page's colours; on a web page it's dark on white
  const styles = isResultTab || isLibrary ? getComputedStyle(document.documentElement) : null;
  const colour = (name, fallback) => styles?.getPropertyValue(name).trim() || fallback;
  const halves = [[originalImg, 'Original'], [resultImg, 'Processed']];
  const height = Math.max(...halves.map(([img]) => img.naturalHeight));
  const widths = halves.map(([img]) => Math.max(1, Math.round((img.naturalWidth * height) / img.naturalHeight)));
  const padding = Math.min(48, Math.max(12, Math.round(height / 40)));
  const fontSize = Math.min(42, Math.max(13, Math.round(height / 36)));
  const caption = Math.round(fontSize * 1.8);
  const width = padding * 2 + widths[0] + padding + widths[1];
  const full = height + caption + padding * 2;

  // Everything is laid out at the images' own size, then drawn scaled down if that would be too large
  const zoom = Math.min(1, MAX_SIDE_BY_SIDE / Math.max(width, full));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * zoom));
  canvas.height = Math.max(1, Math.round(full * zoom));
  const context = canvas.getContext('2d');
  context.scale(zoom, zoom);
  context.fillStyle = colour('--bg', '#fff');
  context.fillRect(0, 0, width, full);
  context.textBaseline = 'middle';

  let x = padding;
  halves.forEach(([img, label], index) => {
    context.drawImage(img, x, padding, widths[index], height);
    // The caption, centred under its own image: the label in bold and the size beside it
    const size = `${img.naturalWidth} × ${img.naturalHeight}`;
    const bold = `bold ${fontSize}px Arial, sans-serif`;
    const plain = `${fontSize}px Arial, sans-serif`;
    context.font = bold;
    const labelWidth = context.measureText(label).width;
    context.font = plain;
    const sizeWidth = context.measureText(size).width;
    const gap = fontSize * 0.45;
    const middle = padding + height + caption / 2;
    let textX = x + (widths[index] - (labelWidth + gap + sizeWidth)) / 2;
    context.font = bold;
    context.fillStyle = colour('--strong', '#111');
    context.fillText(label, textX, middle);
    textX += labelWidth + gap;
    context.font = plain;
    context.fillStyle = colour('--muted', '#6b6b6b');
    context.fillText(size, textX, middle);
    x += widths[index] + padding;
  });
  return canvas.toDataURL('image/png');
}

// The comparison's own download: the pair as one picture, named like the result with -comparison after it
// Used by: web pages, the result tab, the Library.
async function saveComparison(button, originalImg, resultImg, name) {
  if (button.disabled || !originalImg.naturalWidth || !resultImg.naturalWidth) return;
  button.disabled = true;
  button.style.opacity = '0.45';
  try {
    const dataUrl = composeSideBySide(originalImg, resultImg);
    const filename = `${String(name || 'image').replace(/[\\/:*?"<>|]/g, '_')}-img2img-comparison.png`;
    const response = await chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl, filename });
    if (!response?.success) throw new Error(response?.error || 'Download failed');
  } catch (error) {
    showPageError(`The comparison picture couldn't be saved: ${error.message}`);
  } finally {
    button.disabled = false;
    button.style.opacity = '1';
  }
}

// Used by: web pages, the result tab.
function updateRevertButton(imgElement) {
  const button = revertButtons.get(imgElement);
  const reverted = revertedResults.has(imgElement);
  // A video's original is the video itself, which the overlay stops covering
  button.title = reverted ? 'Show processed image' : (imgElement.tagName === 'VIDEO' ? 'Show the video' : 'Show original image');
  setIcon(button, reverted ? RESULT_ICON : REVERT_ICON);
}

// The buttons and the dropdown of an element go: the element left the page, or its last result did
// Used by: web pages, the result tab.
function removeResultButtons(imgElement) {
  for (const buttons of [downloadButtons, revertButtons, compareButtons, reprocessButtons, deleteButtons, resultSelects]) {
    buttons.get(imgElement)?.remove();
    buttons.delete(imgElement);
  }
  revertedResults.delete(imgElement);
  closeComparison(imgElement);
}

// A result's delete button: the result goes from the cache, and with it, if the box is ticked, the file it was
// downloaded as (background.js deletes both). What is left takes its place on the page: the newest of the image's
// other results, with the dropdown following (gone once there is only one), or else the image as the page had it,
// ready to be processed again. On a video the frame's result goes, and the video shows its latest other frame, or
// itself. The result is known by the key the cache holds it under (resultKeys), noted as it came from the cache or
// back from a job.
const deleting = new WeakSet();

// Used by: web pages, the result tab.
async function deleteResult(imgElement) {
  if (deleting.has(imgElement)) return;
  const result = revertedResults.get(imgElement) || imageSrc(imgElement);
  const hash = resultKeys.get(result) || (imgElement.tagName !== 'VIDEO' ? shownGeneration.get(imgElement) : undefined);
  if (!hash) {
    showPageError("This result isn't in the cache");
    return;
  }
  deleting.add(imgElement);
  try {
    const answer = await confirmDeletion(await downloadedFilesOf(hash));
    if (!answer) return;
    const response = await chrome.runtime.sendMessage({ action: 'deleteFromCache', hash, deleteFiles: answer.deleteFiles });
    if (!response?.success) {
      throw new Error(response?.error || 'no answer');
    }
    resultKeys.delete(result);
    if (response.fileError) {
      showPageError(`The downloaded file couldn't be deleted: ${response.fileError}`);
    }
    await showWhatIsLeft(imgElement);
  } catch (error) {
    showPageError(`Couldn't delete it: ${error.message}`);
  } finally {
    deleting.delete(imgElement);
  }
}

// The files a cached result was downloaded as, still there to delete: [{ id, path }] (background.js keeps the
// browser's download ids with each downloaded result). The viewer uses this too.
// Used by: web pages, the result tab, the Library.
async function downloadedFilesOf(hash) {
  const response = await chrome.runtime.sendMessage({ action: 'downloadedFiles', hash });
  return (response?.success && response.files) || [];
}

// Asks before a result is deleted, in a dialog of ours over the page like the cache page's and the viewer's:
// resolves { deleteFiles } for a yes and null for a no. "Don't ask again" (cacheDeleteNoConfirm, shared with those
// pages) skips the question, but not where there is a downloaded file to decide about: deleting a file is asked
// about every time, and only done with its box ticked.
// Used by: web pages, the result tab, the Library.
async function confirmDeletion(files) {
  const { cacheDeleteNoConfirm } = await chrome.storage.local.get('cacheDeleteNoConfirm');
  if (cacheDeleteNoConfirm === true && files.length === 0) return { deleteFiles: false };
  const fileToo = files.length > 0 && await deleteFileRemembered();
  return new Promise(resolve => {
    document.getElementById('img2img-confirm')?.remove();
    const dialog = document.createElement('dialog');
    dialog.id = 'img2img-confirm';
    Object.assign(dialog.style, {
      padding: '20px 22px 16px',
      border: 'none',
      borderRadius: '10px',
      background: '#2a2a2a',
      color: '#fff',
      font: '14px/1.4 system-ui, sans-serif',
      maxWidth: '360px',
      boxShadow: '0 10px 30px rgba(0, 0, 0, 0.35)',
      textAlign: 'left',
    });
    const form = document.createElement('form');
    form.setAttribute('method', 'dialog');
    const question = document.createElement('p');
    question.textContent = 'Delete this result from the img2img cache?';
    Object.assign(question.style, { margin: '0 0 14px', font: 'inherit', color: '#fff' });
    const box = (name, text) => {
      const row = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.name = name;
      Object.assign(input.style, { margin: '0', width: '14px', height: '14px', flex: 'none', accentColor: '#3471db' });
      row.append(input, text);
      Object.assign(row.style, { display: 'flex', alignItems: 'center', gap: '8px', margin: '0 0 8px', font: '13px/1.3 system-ui, sans-serif', color: '#ccc', textTransform: 'none', cursor: 'pointer' });
      return row;
    };
    const fileRow = files.length > 0 ? box('deleteFiles', fileDeletionText(files)) : null;
    if (fileRow) {
      // (ticked or not as it was left the last time)
      const fileBox = fileRow.querySelector('input');
      fileBox.checked = fileToo;
      fileBox.addEventListener('change', () => rememberDeleteFile(fileBox.checked));
    }
    const askRow = files.length === 0 ? box('dontAsk', "Don't ask again") : null;
    const button = (value, text, colour) => {
      const element = document.createElement('button');
      element.type = 'submit';
      element.value = value;
      element.textContent = text;
      Object.assign(element.style, {
        padding: '7px 16px',
        margin: '0',
        border: `1px solid ${colour || '#777'}`,
        borderRadius: '6px',
        background: colour || 'transparent',
        color: '#fff',
        font: '14px/1.2 system-ui, sans-serif',
        textTransform: 'none',
        boxShadow: 'none',
        width: 'auto',
        height: 'auto',
        minWidth: '0',
        cursor: 'pointer',
      });
      return element;
    };
    const buttons = document.createElement('div');
    Object.assign(buttons.style, { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '18px' });
    const remove = button('delete', 'Delete', '#c62828');
    buttons.append(button('cancel', 'Cancel'), remove);
    form.append(question, ...[fileRow, askRow].filter(Boolean), buttons);
    dialog.append(form);
    // The page doesn't get the keys and clicks inside it (its own shortcuts, say)
    ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'keypress'].forEach(name =>
      dialog.addEventListener(name, event => event.stopPropagation()));
    dialog.addEventListener('close', () => {
      const confirmed = dialog.returnValue === 'delete';
      if (confirmed && askRow?.querySelector('input').checked) {
        chrome.storage.local.set({ cacheDeleteNoConfirm: true });
      }
      dialog.remove();
      resolve(confirmed ? { deleteFiles: Boolean(fileRow?.querySelector('input').checked) } : null);
    });
    document.documentElement.appendChild(dialog);
    dialog.showModal();
    remove.focus();
  });
}

// The box's text for the files a result was downloaded as, by name (same function in cache.js)
// Used by: web pages, the result tab, the Library.
function fileDeletionText(files) {
  const names = files.map(file => file.path.split(/[\\/]/).pop()).join(', ');
  return `Also delete the ${files.length === 1 ? 'file' : 'files'} it was downloaded as: ${names}`;
}

// After a result is deleted: the newest of the image's other results goes on show, or the image goes back to how
// the page had it (removeResult)
// Used by: web pages, the result tab.
async function showWhatIsLeft(imgElement) {
  if (imgElement.tagName === 'VIDEO') {
    await showWhatIsLeftOfVideo(imgElement);
    return;
  }
  const response = await chrome.runtime.sendMessage({ action: 'listResults', imageUrl: getSourceUrl(imgElement) });
  const results = labelGenerations((response?.success ? response.results : []).slice(0, LISTED_GENERATIONS));
  if (results.length === 0) {
    removeResult(imgElement);
    return;
  }
  generations.set(imgElement, results);
  await showGeneration(imgElement, results[0]);
}

// A video's frame whose result was deleted: the same moment may have another result (processed again with the
// same settings), which goes on show; else the moment goes from the video's list, from what the page remembers
// for a rebuilt player and from what is kept for later pages, and the latest other frame goes on show, or the
// video itself, ready to be processed again
// Used by: web pages, the result tab.
async function showWhatIsLeftOfVideo(video) {
  const frame = videoFrames.get(video);
  if (!frame) return;
  const another = frame.hash ? await getFromCache(frame.hash, null) : null;
  if (another) {
    frame.result = another;
    await showFrame(video, frame);
    return;
  }
  const frames = frameListOf(video).filter(other => other !== frame);
  videoFrameLists.set(video, frames);
  const remembered = videoResults.indexOf(frame);
  if (remembered >= 0) videoResults.splice(remembered, 1);
  if (frame.hash) await forgetKeptFrame(frame.hash);
  if (frames.length === 0) {
    clearVideoResult(video);
    return;
  }
  await showFrame(video, frames[frames.length - 1], { seek: true });
}

// An image's last result is gone: the image is put back as the page had it (its own picture, and the responsive
// candidates taken off it when the result went up), its buttons go, and it can be processed again
// Used by: web pages, the result tab.
function removeResult(imgElement) {
  const original = imgElement.getAttribute('data-original-src');
  removeResultButtons(imgElement);
  generations.delete(imgElement);
  shownGeneration.delete(imgElement);
  if (original) pageResults.delete(original);
  imgElement.removeAttribute('data-original-src');
  imgElement.removeAttribute('data-img2img-settings');
  if (imgElement.hasAttribute('data-img2img-width')) {
    imgElement.removeAttribute('width');
    imgElement.removeAttribute('data-img2img-width');
  }
  if (imgElement.tagName === 'IMG') {
    putBack(imgElement, 'srcset');
    putBack(imgElement, 'sizes');
    if (imgElement.parentElement?.tagName === 'PICTURE') {
      imgElement.parentElement.querySelectorAll('source').forEach(source => putBack(source, 'srcset'));
    }
    if (original) imgElement.src = original;
    return;
  }
  // A background: the page's own CSS shows again, unless it was the inline style the result went over
  backgroundResults.delete(imgElement);
  imgElement.style.removeProperty('background-image');
  if (original && !cssBackgroundUrl(imgElement)) {
    imgElement.style.backgroundImage = `url("${original.replace(/["\\]/g, '\\$&')}")`;
  }
}

// An attribute of the page's taken off an element while a result shows, kept as data-img2img-<name> so the
// element can be put back as it was (putBack, see removeResult)
// Used by: web pages, the result tab.
function keepAside(element, name) {
  if (!element.hasAttribute(name)) return;
  if (!element.hasAttribute(`data-img2img-${name}`)) {
    element.setAttribute(`data-img2img-${name}`, element.getAttribute(name));
  }
  element.removeAttribute(name);
}

// Used by: web pages, the result tab.
function putBack(element, name) {
  if (!element.hasAttribute(`data-img2img-${name}`)) return;
  element.setAttribute(name, element.getAttribute(`data-img2img-${name}`));
  element.removeAttribute(`data-img2img-${name}`);
}

// Puts one of the SVG icon strings above into a button, parsed as SVG rather than set as innerHTML
// Used by: web pages, the result tab, the Library.
function setIcon(button, icon) {
  if (!icon) {
    button.replaceChildren();
    return;
  }
  const svg = new DOMParser().parseFromString(icon.replace('<svg ', '<svg xmlns="http://www.w3.org/2000/svg" '), 'image/svg+xml');
  button.replaceChildren(document.importNode(svg.documentElement, true));
}

// A round button over an image, kept out of the page's own click handling; hover is its colour under the pointer
// Used by: web pages, the result tab.
function createOverlayButton(imgElement, className, title, icon, onClick, hover = BUTTON_HOVER) {
  const button = document.createElement('button');
  overlayOwners.set(button, imgElement);
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
  button.addEventListener('mouseenter', () => { if (!button.disabled) button.style.background = hover; });
  button.addEventListener('mouseleave', () => { button.style.background = 'rgba(0, 0, 0, 0.6)'; });
  button.addEventListener('click', e => {
    e.preventDefault();
    e.stopPropagation();
    onClick();
  });
  document.documentElement.appendChild(button);
  return button;
}

// The cache keeps every result an image has ever had (see addToCache in background.js) and shows the newest, so
// the dropdown offers the rest: a result the user picks is fetched by its own cache key. Listed per image when
// its result goes up, which is a lookup by URL in the background and no pictures over the wire.
const generations = new WeakMap(); // image -> its cached results, newest first: { hash, timestamp, name, label }
const shownGeneration = new WeakMap(); // image -> the cache key of the result it shows
const LISTED_GENERATIONS = 20;

// Used by: web pages, the result tab.
async function loadGenerations(imgElement) {
  if (imgElement.tagName === 'VIDEO') return; // a video's results are its frames (see resultChoicesOf)
  try {
    const response = await chrome.runtime.sendMessage({ action: 'listResults', imageUrl: getSourceUrl(imgElement) });
    if (!response?.success || !imgElement.isConnected) return;
    const results = labelGenerations(response.results.slice(0, LISTED_GENERATIONS));
    generations.set(imgElement, results);
    // The one on show, where its key is known (a result the cache sent, or one back from a job); else the newest,
    // which is what the cache shows, unless the user has picked another one already
    const shown = resultKeys.get(revertedResults.get(imgElement) || imageSrc(imgElement));
    if (results.some(entry => entry.hash === shown)) {
      shownGeneration.set(imgElement, shown);
    } else if (!results.some(entry => entry.hash === shownGeneration.get(imgElement))) {
      shownGeneration.set(imgElement, results[0]?.hash);
    }
    refreshResultSelect(imgElement);
  } catch (error) {
    if (!extensionContextLost()) {
      console.debug('img2img: listing the results cached for this image failed:', error);
    }
  }
}

// When each was made: the time of day, with the date for older ones, and with seconds where two of them would
// otherwise read the same
// Used by: web pages, the result tab.
function labelGenerations(results) {
  const clock = (stamp, seconds) => new Date(stamp).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
    ...(seconds ? { second: '2-digit' } : {}),
  });
  const today = new Date().toDateString();
  const label = (stamp, seconds) => (new Date(stamp).toDateString() === today
    ? clock(stamp, seconds)
    : `${new Date(stamp).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })} ${clock(stamp, seconds)}`);
  const labels = results.map(result => (result.timestamp ? label(result.timestamp) : 'Earlier'));
  const sameMinute = new Set(labels).size < labels.length;
  return results.map((result, index) => ({
    ...result,
    label: result.timestamp ? label(result.timestamp, sameMinute) : labels[index],
  }));
}

// One of an image's cached results, picked from the dropdown: fetched by its own key and put on the image, which
// is also what a page that rebuilds the image shows from then on (pageResults, see showResult)
// Used by: web pages, the result tab.
async function showGeneration(imgElement, entry) {
  try {
    const result = await getFromCache(entry.hash, null);
    if (!result) {
      throw new Error('it is no longer in the cache');
    }
    shownGeneration.set(imgElement, entry.hash);
    revertedResults.delete(imgElement);
    showResult(imgElement, result, entry.name);
    updateRevertButton(imgElement);
    refreshDownloadButtonStates();
    refreshResultSelect(imgElement);
  } catch (error) {
    showPageError(`Couldn't show that result: ${error.message}`);
  }
}

// What the dropdown over a result offers: a video's processed frames, by the moment each came from, and an
// image's cached results, by when each was made
// Used by: web pages, the result tab.
function resultChoicesOf(element) {
  if (element.tagName === 'VIDEO') {
    return frameListOf(element).map(frame => ({
      label: frameTimeLabel(frame.time),
      chosen: frame === videoFrames.get(element),
      show: () => showFrame(element, frame, { seek: true }),
    }));
  }
  return (generations.get(element) || []).map(entry => ({
    label: entry.label,
    chosen: entry.hash === shownGeneration.get(element),
    show: () => showGeneration(element, entry),
  }));
}

// The dropdown itself, there once something has two results to pick between; with one there's nothing to pick.
// Like the buttons it's fixed-position and follows its element (see positionDownloadButtons).
// Used by: web pages, the result tab.
function createResultSelect(element) {
  const select = document.createElement('select');
  overlayOwners.set(select, element);
  select.className = 'img2img-results';
  select.title = element.tagName === 'VIDEO' ? 'Which processed frame to show' : 'Which result to show';
  Object.assign(select.style, {
    position: 'fixed',
    display: 'none',
    boxSizing: 'content-box',
    height: 'auto',
    width: 'auto',
    minWidth: '0',
    maxWidth: 'none',
    padding: '3px 6px',
    margin: '0',
    border: 'none',
    borderRadius: '11px',
    background: 'rgba(0, 0, 0, 0.6)',
    color: '#fff',
    font: '600 11px/1.2 system-ui, sans-serif',
    textAlign: 'center',
    appearance: 'none',
    cursor: 'pointer',
    zIndex: '2147483647',
  });
  // The page doesn't get these: Manual Selection would take the click, and the page's own handlers would see a
  // click on its image or its video
  ['mousedown', 'click', 'keydown'].forEach(name =>
    select.addEventListener(name, event => event.stopPropagation()));
  select.addEventListener('change', () => {
    resultChoicesOf(element)[select.selectedIndex]?.show();
  });
  document.documentElement.appendChild(select);
  resultSelects.set(element, select);
  return select;
}

// Its choices, and which one is on show. The options are only rebuilt when they change, so a dropdown the user
// has open isn't pulled from under them.
// Used by: web pages, the result tab.
function refreshResultSelect(element) {
  const choices = resultChoicesOf(element);
  let select = resultSelects.get(element);
  if (choices.length < 2) {
    select?.remove();
    resultSelects.delete(element);
    return;
  }
  select = select || createResultSelect(element);
  const labels = choices.map(choice => choice.label).join('\u0000');
  if (select.dataset.labels !== labels) {
    select.dataset.labels = labels;
    select.replaceChildren(...choices.map(choice => {
      const option = document.createElement('option');
      option.textContent = choice.label;
      option.style.color = '#000'; // (the list the browser draws is on its own background)
      return option;
    }));
  }
  select.selectedIndex = choices.findIndex(choice => choice.chosen);
}

// Fingerprint of a result image, used to remember which results were downloaded (same as background.js)
// Used by: web pages, the result tab.
function resultKey(dataUrl) {
  let hash = 5381;
  for (let i = 0; i < dataUrl.length; i++) {
    hash = ((hash << 5) + hash + dataUrl.charCodeAt(i)) | 0;
  }
  return `${dataUrl.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

// Grey out (but keep showing) the download button of every result that has been downloaded before
// Used by: web pages, the result tab.
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
// Used by: web pages, the result tab, the Library.
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

// Whether something else (a modal, a menu) covers an image's visible part, checked where its buttons (or the
// spinner, at the top left) go and at its centre: they're on top of everything, so they'd show through
// Used by: web pages, the result tab, the Library.
function isCovered(imgElement, rect, { topLeft = false } = {}) {
  const left = rect.right - rect.width;
  const markPoint = topLeft
    ? [left + 10 + SPINNER_SIZE / 2, rect.top + 10 + SPINNER_SIZE / 2]
    : [rect.right - 8 - DOWNLOAD_BUTTON_SIZE / 2, rect.top + 8 + DOWNLOAD_BUTTON_SIZE / 2];
  const centre = [rect.right - rect.width / 2, rect.top + rect.height / 2];
  const options = { backgrounds: !['IMG', 'VIDEO'].includes(imgElement.tagName), videos: imgElement.tagName === 'VIDEO' };
  return imageAt(...markPoint, options) !== imgElement && imageAt(...centre, options) !== imgElement;
}

// Used by: web pages, the result tab.
function positionDownloadButtons() {
  for (const [imgElement, button] of downloadButtons) {
    const revertButton = revertButtons.get(imgElement);
    const compareButton = compareButtons.get(imgElement);
    const reprocessButton = reprocessButtons.get(imgElement);
    const deleteButton = deleteButtons.get(imgElement);
    if (!imgElement.isConnected) {
      removeResultButtons(imgElement);
      continue;
    }
    // Only while the image still shows our result or its toggled-back original (sites may swap src back),
    // and enough of it is on screen. The download button only shows with the result.
    const src = imageSrc(imgElement);
    const showsOriginal = revertedResults.has(imgElement) && src === imgElement.getAttribute('data-original-src');
    const showsResult = !showsOriginal && src.startsWith('data:');
    const rect = (showsResult || showsOriginal) ? visibleRect(imgElement) : null;
    // (and not under a comparison that has the whole window, in a result tab: its bar has what it needs)
    const visible = Boolean(rect) && rect.width >= 64 && rect.height >= 64 && !isCovered(imgElement, rect)
      && (!iconsOnHover || pointerOverIcons(imgElement, rect)) && !comparisons.get(imgElement)?.fillsWindow();
    // (inline display would override the hidden attribute)
    button.style.display = visible && showsResult ? 'flex' : 'none';
    revertButton.style.display = visible ? 'flex' : 'none';
    compareButton.style.display = visible ? 'flex' : 'none';
    reprocessButton.style.display = visible ? 'flex' : 'none';
    deleteButton.style.display = visible && showsResult ? 'flex' : 'none';
    // Something with more than one result (a video's frames, an image's generations): the dropdown goes under
    // the buttons, its right edge with theirs
    const select = resultSelects.get(imgElement);
    const picking = Boolean(select) && visible;
    if (select) {
      select.style.display = picking ? 'block' : 'none';
    }
    if (visible) {
      const left = `${rect.right - 8 - DOWNLOAD_BUTTON_SIZE}px`;
      button.style.top = `${rect.top + 8}px`;
      button.style.left = left;
      revertButton.style.top = `${rect.top + 8 + DOWNLOAD_BUTTON_SIZE + 6}px`;
      revertButton.style.left = left;
      compareButton.style.top = `${rect.top + 8 + 2 * (DOWNLOAD_BUTTON_SIZE + 6)}px`;
      compareButton.style.left = left;
      reprocessButton.style.top = `${rect.top + 8 + 3 * (DOWNLOAD_BUTTON_SIZE + 6)}px`;
      reprocessButton.style.left = left;
      deleteButton.style.top = `${rect.top + 8 + 4 * (DOWNLOAD_BUTTON_SIZE + 6)}px`;
      deleteButton.style.left = left;
      if (picking) {
        // Lined up with the buttons from the left, by its own width: a fixed element's right is measured from
        // the viewport's edge, which on a page with a scrollbar falls short of window.innerWidth, and the
        // dropdown then sat a scrollbar's width to the left of them
        select.style.top = `${rect.top + 8 + 5 * (DOWNLOAD_BUTTON_SIZE + 6)}px`;
        select.style.left = `${rect.right - 8 - select.offsetWidth}px`;
      }
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
// Used by: web pages, the result tab.
function openResultInNewTab(settings, imageHash, imageUrl, name, original) {
  // On a direct .jpg/.png URL the swapped image already is the whole page, so another tab adds nothing
  if (!settings.openResultsInNewTab || isImagePage()) {
    return;
  }
  chrome.runtime.sendMessage({ action: 'openResultTab', hash: imageHash, name, imageUrl, original });
}

// The page image as the page read it, for the tab a result opens in (viewer.html, with Open Results in New Tab):
// background.js keeps it for the tab, whose revert and compare buttons show the original from it. Reading it again
// from its URL, which the tab does otherwise, fails for a video's frame, a blob: image and an image a site won't
// serve twice. Only with the setting on, since it is the whole image once more on top of the job.
// Used by: web pages, the result tab.
function originalForResultTab(settings, base64Image, imageBlob) {
  if (!settings.openResultsInNewTab) return undefined;
  return `data:${imageBlob?.type || 'image/png'};base64,${base64Image}`;
}

// The page image to send along with a job: for the result's tab, and for Double Download when results download
// automatically. background.js saves those, as the page may be gone by then, so it needs the original from here:
// the image as it was read for processing (an SVG, or a format that can't be processed, is the PNG made of it).
// Used by: web pages, the result tab, the Library.
async function originalForJob(settings, base64Image, imageBlob) {
  const { autoDownload, downloadOriginal } = await chrome.storage.local.get(['autoDownload', 'downloadOriginal']);
  const wanted = settings.openResultsInNewTab || (autoDownload === true && downloadOriginal === true);
  return wanted ? `data:${imageBlob?.type || 'image/png'};base64,${base64Image}` : undefined;
}

// Used by: web pages, the result tab, the Library.
function isImagePage() {
  return Boolean(document.contentType?.startsWith('image/'));
}

// Short names of the built-in workflows, for download names (the user's own workflows use their name)
const WORKFLOW_FILE_NAMES = {
  controlnet: 'ControlNet',
  upscale: 'Upscale',
  background: 'Background',
  restore: 'Face restore',
  colorize: 'Colourised',
  cleanup: 'Cleaned up',
  sticker: 'Sticker',
  idPhoto: 'ID photo',
  faceBlur: 'Faces blurred',
  filter: 'Filter',
  transform: 'Transformed',
  segment: 'Cut out',
};

// The workflow's name as it goes in a file name: one of the user's own by its name
// Used by: web pages, the result tab, the Library.
function workflowFileName(settings) {
  const workflow = effectiveWorkflow(settings);
  return (isCustomWorkflow(workflow) ? settings.customWorkflow?.name : WORKFLOW_FILE_NAMES[workflow]) || '';
}

// The file extension a result downloads under, from its data URL (or a type such as image/png)
// Used by: web pages, the result tab, the Library.
function resultExtension(dataUrlOrType) {
  const type = String(dataUrlOrType).match(/^(?:data:)?image\/([^;,]+)/)?.[1] || 'png';
  return type === 'jpeg' ? 'jpg' : type;
}

// Base name for downloads: "<start of the page title>-<workflow>-<source name>". Page titles can be long, so only
// the first few words are kept. Result tabs carry the name over from the page in an img2img-name marker.
// Processing passes the settings it used, so the name is the one the result was made with (see resultNames).
// Used by: web pages, the result tab, the Library.
async function resultBaseName(processedWith = null) {
  const markerName = location.hash.match(/img2img-name=([^&]+)/)?.[1];
  if (markerName) {
    return decodeURIComponent(markerName);
  }
  const clean = cleanForFileName;
  const title = shortPageTitle();
  // The source's name, when the workflow uses one: the source selected in the grid, or for one of the user's own
  // workflows its first source picker's (the one picked for it, else the one selected in the grid)
  let workflowName = '';
  let sourceName = '';
  try {
    const settings = processedWith || await getSettings();
    const workflow = effectiveWorkflow(settings);
    workflowName = clean(workflowFileName(settings));
    const firstPicker = isCustomWorkflow(workflow) ? sourceGroups(settings.customWorkflow)[0] : null;
    const sourceId = SWAP_WORKFLOWS.includes(workflow) || usesSourceImage(settings) ? selectedSourceId
      : firstPicker ? settings.customWorkflowValues?.[`source:${firstPicker.key}`] || selectedSourceId
      : null;
    sourceName = sourceId ? clean((await getSource(sourceId))?.name) : '';
  } catch (error) {
    // The source was deleted: leave it out
  }
  const now = new Date();
  const pad = number => String(number).padStart(2, '0');
  // The page's address without the scheme or the #part, readable where it can be; kept short, as it can run long
  let address = `${location.hostname}${location.pathname}${location.search}`;
  try {
    address = decodeURI(address);
  } catch (error) {
    // Not valid percent-encoding: as it is
  }
  address = clean(address).slice(0, 80);
  // Eight letters and digits of its own for each result, so two results never share a name
  const id = Array.from(crypto.getRandomValues(new Uint8Array(8)), byte => (byte % 36).toString(36)).join('');
  const { filenamePattern } = await chrome.storage.local.get('filenamePattern');
  const name = fillFilenamePattern(filenamePattern, {
    '{title}': title,
    '{workflow}': workflowName,
    '{source}': sourceName,
    '{host}': clean(location.hostname),
    '{url}': address,
    '{id}': id,
    '{date}': `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    '{time}': `${pad(now.getHours())}-${pad(now.getMinutes())}`,
  });
  return name || title || location.hostname || 'image';
}

// Text made safe to go into a file name
// Used by: web pages, the result tab, the Library.
function cleanForFileName(text) {
  return (text || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim();
}

// The first few words of the page's title, for a file name
// Used by: web pages, the result tab, the Library.
function shortPageTitle() {
  const title = cleanForFileName(document.title);
  if (title.length <= 40) return title;
  return title.slice(0, 40).replace(/\s+\S*$/, '') || title.slice(0, 40);
}

// The "File Name" setting's tokens, filled in with what this page knows. A token with nothing behind it (no source
// for this workflow, say) leaves no gap or stray dash; one that isn't a token of ours is left as it was typed.
// -img2img and the extension are added by whoever downloads the result.
const DEFAULT_FILENAME_PATTERN = '{title}-{workflow}-{source}';

// Same function in settings.js, which shows an example of the name
// Used by: web pages, the result tab, the Library.
function fillFilenamePattern(pattern, values) {
  return (String(pattern || '').trim() || DEFAULT_FILENAME_PATTERN)
    .replace(/\{[a-z]+\}/gi, token => values[token.toLowerCase()] ?? token)
    .replace(/[-_\s]{2,}/g, '-')
    .replace(/^[-_\s.]+|[-_\s.]+$/g, '');
}

// Result tabs opened in incognito point at the original image URL plus "#img2img-result=<hash>": show the
// cached result there, with the download button, and keep automatic processing off this tab
async function showResultFromUrlMarker() {
  const match = location.hash.match(/img2img-result=([^&]+)/);
  if (!match) {
    return;
  }
  isResultTab = true;
  // The marker's result, or else the latest one for this image. A re-process in this tab moves the marker to its
  // result (see swapImage), so a reload shows the new result.
  const result = await getFromCache(decodeURIComponent(match[1]), location.href, true);
  // On a direct image URL Chrome shows a single <img>; otherwise use the largest image on the page
  const img = Array.from(document.images).sort((a, b) => b.naturalWidth * b.naturalHeight - a.naturalWidth * a.naturalHeight)[0];
  if (!result || !img) {
    showPageError('This result is no longer in the img2img cache.');
    return;
  }
  resultsShownHere.add(decodeURIComponent(match[1]));
  img.setAttribute('data-original-src', img.src);
  img.src = result;
  addDownloadButton(img);
}

// Save the swapped image as "<page title>-<workflow>-<source name>-img2img.<ext>"
// Downloads go through chrome.downloads in the background script: an <a download> click started from the
// content script's isolated world is unreliable (Chrome sometimes drops it, Edge always does).
// Used by: web pages, the result tab.
// shown: the result and its original as they were on show (the right-click menu's Download, taken as the menu opened)
// Used by: web pages, the result tab.
async function downloadSwappedImage(imgElement, shown = resultOnShow(imgElement)) {
  const { result: dataUrl, original } = shown;
  const filename = `${await nameOfResult(dataUrl)}-img2img.${resultExtension(dataUrl)}`;

  try {
    const response = await chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl, filename });
    if (!response?.success) {
      throw new Error(response?.error || 'Download failed');
    }
  } catch (error) {
    showDownloadError(error);
    return;
  }
  // An image's original is read from the page the way the compare button reads it, as it is (its own format, not
  // drawn into a PNG)
  await downloadOriginalToo(filename, () => /^data:/.test(original) ? original : fetchImageBlob(original, { asIs: true }));
}

// The result an element shows and its original: a video's original is the frame that was processed, which is here
// already; an image's is its URL
// Used by: web pages, the result tab.
function resultOnShow(imgElement) {
  const frame = videoFrames.get(imgElement);
  return { result: imageSrc(imgElement), original: frame ? frame.dataUrl : imgElement.getAttribute('data-original-src') };
}

// Used by: web pages, the result tab.
function showDownloadError(error) {
  // After the extension is reloaded, this page's content script can't reach the background anymore
  const contextLost = !chrome.runtime?.id || /context invalidated/i.test(error.message);
  showPageError(contextLost
    ? 'img2img was updated. Refresh this page to download images.'
    : `Download failed: ${error.message}`);
}

// "Double Download" (downloadOriginal, a setting on the settings page): a download button saves the original image
// too, right after the result, named like it with -original in place of -img2img (background.js names and saves
// it). load gives the original, as a data URL or a Blob, and is only called once the setting is found on, since
// an image's original has to be read for it. The result is saved either way: an original that can't be read
// says so on the page.
// Used by: web pages, the result tab.
async function downloadOriginalToo(filename, load) {
  const { downloadOriginal } = await chrome.storage.local.get('downloadOriginal');
  if (downloadOriginal !== true) return;
  try {
    let original = await load();
    if (original instanceof Blob) original = await blobToDataUrl(original);
    const response = await chrome.runtime.sendMessage({ action: 'downloadOriginal', dataUrl: original, name: filename });
    if (!response?.success) {
      throw new Error(response?.error || 'Download failed');
    }
  } catch (error) {
    showPageError(`The original image couldn't be saved: ${error.message}`);
  }
}

// Show a loading spinner over the image's top-left corner. It's fixed-position and follows the image
// every frame, so it stays put through scrolling, resizing and centred layouts (e.g. Chrome's viewer
// for direct .jpg/.png URLs) without touching the page's own layout. Returns the spinner to remove later; its
// setProgress(percent) draws a ring around it (jobs on the user's ComfyUI report their progress), setEstimate(ms)
// fills the ring over the time a hosted job should take, with the seconds left under it, and setWaiting(ahead) greys
// it out while the image waits its turn to go to the server (see waitingJobs). Like the image's buttons, it hides
// while a modal or menu covers the image. Some sites rebuild their images (a carousel's
// slide swiped away and back): the spinner then moves to the image that shows up with the same picture, and
// its image() is where the result goes. An image with several jobs (process again clicked more than once) has a
// spinner for each, in a row from its corner in the order they were started, closing up as each one finishes.
const SPINNER_SIZE = 44;
const SPINNER_GAP = 12; // (room between them for their labels: "~12 s", "3 ahead")
const spinnersShown = [];
// Used by: web pages, the result tab.
function showSpinner(imgElement) {
  const spinner = createSpinnerMark();
  spinnersShown.push(spinner);
  const src = imageSrc(imgElement);
  // The picture the image is a version of: switching between its original and its results (revert, the dropdown)
  // changes what it shows but not that, so the spinner stays on it whichever one is on show
  const originalOf = image => image.getAttribute('data-original-src')
    || (resultTabOriginal?.image === image ? resultTabOriginal.url : '');
  const picture = originalOf(imgElement) || src;
  let image = imgElement;
  let lastSearch = 0;
  const lost = () => {
    if (!image.isConnected) return true;
    const shown = imageSrc(image);
    return shown !== src && shown !== picture && originalOf(image) !== picture;
  };
  spinner.image = () => image;
  document.documentElement.appendChild(spinner);

  const followImage = () => {
    if (!spinner.isConnected) {
      spinnersShown.splice(spinnersShown.indexOf(spinner) >>> 0, 1);
      return;
    }
    // Its image left the page or shows another picture: look for one with its picture, a few times a second (the
    // one on screen first)
    if (lost() && src && performance.now() - lastSearch > 250) {
      lastSearch = performance.now();
      const candidates = allImages().filter(img => img.src === src);
      image = candidates.find(img => visibleRect(img).width > 0) || candidates[0] || image;
    }
    const rect = image.getBoundingClientRect();
    const visible = lost() ? null : visibleRect(image);
    spinner.hidden = !visible || visible.width === 0 || visible.height === 0 || isCovered(image, visible, { topLeft: true });
    const before = spinnersShown.slice(0, spinnersShown.indexOf(spinner))
      .filter(other => other.isConnected && other.image() === image).length;
    spinner.style.top = `${rect.top + 10}px`;
    spinner.style.left = `${rect.left + 10 + before * (SPINNER_SIZE + SPINNER_GAP)}px`;
    spinner.tick();
    requestAnimationFrame(followImage);
  };
  followImage();
  return spinner;
}

// The spinner itself, apart from where it is put: the animated logo mark in a white circle, with setWaiting(ahead)
// while the job waits its turn, setProgress(percent) or setEstimate(ms) once it runs, and tick(), which whoever
// shows the mark calls as it draws so the ring of a job with an estimate moves with time. showSpinner above keeps
// it on a page's image; the Library page (library.js) puts it on the picture in its viewer.
// Used by: web pages, the result tab, the Library.
function createSpinnerMark() {
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

  // Hosted jobs report no progress, only how long their workflow's jobs typically take: the ring fills to 90% over
  // that time, then creeps on towards 99% for a job that takes longer
  const label = document.createElement('div');
  Object.assign(label.style, {
    position: 'absolute', top: '100%', left: '50%', transform: 'translateX(-50%)', marginTop: '4px', padding: '2px 6px',
    border: 'none', borderRadius: '8px', background: 'rgba(255, 255, 255, 0.9)', boxShadow: '0 1px 4px rgba(0, 0, 0, 0.3)',
    color: '#166534', font: '600 11px/1.2 system-ui, sans-serif', whiteSpace: 'nowrap', display: 'none',
  });
  spinner.appendChild(label);
  let estimate = null; // { ms, start }
  spinner.setEstimate = (ms, start = performance.now()) => {
    estimate = { ms, start };
  };
  const showEstimate = () => {
    const elapsed = performance.now() - estimate.start;
    const share = elapsed / estimate.ms;
    spinner.setProgress(share < 1 ? 90 * share : 99 - 9 * Math.exp(-(share - 1) * 2));
    // Seconds left only for jobs long enough to wait for, and only until the estimate runs out
    const left = Math.ceil((estimate.ms - elapsed) / 1000);
    label.style.display = estimate.ms >= 3000 && left >= 1 ? 'block' : 'none';
    label.textContent = left > 90 ? `~${Math.ceil(left / 60)} min` : `~${left} s`;
  };

  // Waiting its turn to go to the server (see waitingJobs): the mark greys out, with how many images are ahead
  // under it; 0 is its turn. Given takeBack, a click on the mark takes the job back out of the queue meanwhile;
  // otherwise clicks go through it to the page.
  let takeBackNow = null;
  spinner.setWaiting = (ahead, takeBack = null) => {
    mark.style.filter = ahead ? 'grayscale(1)' : '';
    mark.style.opacity = ahead ? '0.6' : '';
    label.style.display = ahead ? 'block' : 'none';
    label.textContent = `${ahead} ahead`;
    takeBackNow = takeBack;
    spinner.style.pointerEvents = takeBack ? 'auto' : 'none';
    spinner.style.cursor = takeBack ? 'pointer' : '';
    spinner.title = takeBack ? 'Waiting its turn: click to take it back' : '';
  };
  // (the page doesn't hear the press either: it would take it for a click on whatever is under the mark)
  ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(type => spinner.addEventListener(type, e => {
    if (!takeBackNow) return;
    e.preventDefault();
    e.stopPropagation();
    if (type === 'click') takeBackNow();
  }));

  Object.assign(spinner.style, {
    position: 'fixed',
    width: `${SPINNER_SIZE}px`,
    height: `${SPINNER_SIZE}px`,
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
  spinner.tick = () => {
    if (estimate) {
      showEstimate();
    }
  };
  return spinner;
}

// Download base names of the results shown on this page, by result: worked out when the image was processed (or
// swapped in from the cache), so changing the workflow or source afterwards doesn't rename them
const resultNames = new Map();

// The keys the cache holds the results shown on this page under, by result: noted as each comes from the cache or
// back from a job, for the delete button (deleteResult), which removes a result by its key
const resultKeys = new Map();

// Used by: web pages, the result tab.
async function nameOfResult(result) {
  return resultNames.get(result) || resultBaseName();
}

// Show a result in a page image, keeping its original's URL. Responsive images (srcset, or <picture> sources)
// would keep showing the page's own candidates over src, so those are taken off (toggleOriginal shows src)
// Used by: web pages, the result tab.
function showResult(imgElement, url, name) {
  if (name) {
    resultNames.set(url, name);
  }
  if (!imgElement.getAttribute('data-original-src')) {
    // A video's original is the video itself, whichever of its frames is on show; the viewer's result's is the
    // image it was made from, not the result
    imgElement.setAttribute('data-original-src', imgElement.tagName === 'VIDEO'
      ? VIDEO_ITSELF
      : resultTabOriginal?.image === imgElement ? resultTabOriginal.url
      : lazySourceUrl(imgElement) || imageSrc(imgElement));
    keepLayoutSize(imgElement);
  }
  if (imgElement.tagName === 'IMG') {
    // (kept aside rather than dropped: the image is put back as it was once its last result is deleted)
    keepAside(imgElement, 'srcset');
    keepAside(imgElement, 'sizes');
    if (imgElement.parentElement?.tagName === 'PICTURE') {
      imgElement.parentElement.querySelectorAll('source').forEach(source => keepAside(source, 'srcset'));
    }
    pageResults.set(imgElement.getAttribute('data-original-src'), url);
  }
  const frame = videoFrames.get(imgElement);
  if (frame && showsAResult(url)) {
    frame.result = url;
    frame.settings = imgElement.getAttribute('data-img2img-settings');
    addFrameToList(imgElement, frame);
    rememberFrame(frame);
    // And for the pages after this one, if its result is in the cache under a hash
    keepFrameAcrossPages(frame).catch(error => {
      if (!extensionContextLost()) console.debug('img2img: keeping the frame for later failed:', error);
    });
  }
  setImageSrc(imgElement, url);
}

// An <img> the page doesn't size (no width or height, from its attributes or CSS) is laid out at its picture's
// own size, so a result of another size (an upscale, or a srcset image's result, which has no density) would
// resize it and push its container around. Once the first result has loaded, if the image's box changed, it gets
// the original's width (the height follows the result's shape); data-img2img-width marks the width as ours.
// Called before the first result is set, while the original still shows.
// Used by: web pages, the result tab.
function keepLayoutSize(imgElement) {
  if (imgElement.tagName !== 'IMG' || imgElement.hasAttribute('width') || imgElement.hasAttribute('height')) return;
  if (!imgElement.complete || imgElement.naturalWidth <= 2) return; // a lazy placeholder: no size to keep
  const before = imgElement.getBoundingClientRect();
  const width = imgElement.naturalWidth;
  imgElement.addEventListener('load', () => {
    const after = imgElement.getBoundingClientRect();
    if (Math.abs(after.width - before.width) > 1 || Math.abs(after.height - before.height) > 1) {
      imgElement.setAttribute('width', width);
      imgElement.setAttribute('data-img2img-width', '');
    }
  }, { once: true });
}

// Lazy-loaded images show a placeholder (an empty src, a data: URL or a 1-pixel image) until they scroll into
// view, with the real picture in one of these attributes
const LAZY_SOURCE_ATTRIBUTES = ['data-src', 'data-lazy-src', 'data-original', 'data-lazy', 'data-url'];

// Used by: web pages, the result tab.
function lazySourceUrl(imgElement) {
  if (imgElement.tagName !== 'IMG' || imgElement.hasAttribute('data-original-src')) return '';
  const placeholder = !imgElement.src || imgElement.src.startsWith('data:') || (imgElement.complete && imgElement.naturalWidth <= 2);
  const lazy = placeholder && LAZY_SOURCE_ATTRIBUTES.map(name => imgElement.getAttribute(name)).find(value => value?.trim());
  return lazy ? new URL(lazy.trim(), document.baseURI).href : '';
}

// The URL whose image gets processed, which is also the cache's image URL key
// Used by: web pages, the result tab.
function getSourceUrl(imgElement) {
  const frame = videoFrames.get(imgElement);
  if (frame) return frame.url; // a video: its frame, which was taken from the page rather than downloaded
  if (resultTabOriginal?.image === imgElement) return resultTabOriginal.imageUrl;
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
// asIs leaves the image in its own format: for processing, an SVG or a format the API and ComfyUI can't read is
// drawn into a PNG, but a download of the original is the file itself.
// Used by: web pages, the result tab, the Library.
async function fetchImageBlob(imageUrl, { asIs = false } = {}) {
  const fromPage = async () => {
    const response = await fetch(imageUrl);
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.blob();
  };
  const fromBackground = () => fetchBlobViaBackground(imageUrl);

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
  if (asIs) return blob;
  if (await isSvgBlob(blob)) return svgToPng(blob);
  return (await isProcessableBitmap(blob)) ? blob : bitmapToPng(blob);
}

// What the content script can't load itself, fetched by background.js (which isn't subject to the page's CORS
// rules) and sent back as a data URL
// Used by: web pages, the result tab, the Library.
async function fetchBlobViaBackground(url) {
  const response = await chrome.runtime.sendMessage({ action: 'fetchImage', url });
  if (!response?.success) {
    throw new Error(response?.error || 'fetch failed');
  }
  // Decode directly: fetch() of a data: URL can be blocked by the page's CSP
  const [header, data] = response.dataUrl.split(',');
  const mimeType = header.match(/^data:([^;,]+)/)?.[1] || 'application/octet-stream';
  return new Blob([Uint8Array.from(atob(data), c => c.charCodeAt(0))], { type: mimeType });
}

// Bytes as text (for file signatures), read one by one: in Firefox the bytes belong to the page, and slice() or
// subarray() would read their constructor, which a content script isn't allowed to
// Used by: web pages, the result tab, the Library.
function bytesText(bytes, start, end) {
  let text = '';
  for (let i = start; i < Math.min(end, bytes.length); i++) text += String.fromCharCode(bytes[i]);
  return text;
}

// Formats the API and ComfyUI read, by their first bytes (a server's Content-Type can be wrong)
// Used by: web pages, the result tab, the Library.
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
// Used by: web pages, the result tab, the Library.
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

// Used by: web pages, the result tab, the Library.
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('blocked'));
    image.src = url;
  });
}

// Used by: web pages, the result tab, the Library.
async function drawToPng(image, width, height) {
  if (!width || !height) {
    throw new Error("Couldn't read this image");
  }
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  canvas.getContext('2d').drawImage(image, 0, 0, width, height);
  return canvasToPng(canvas);
}

// A canvas as a PNG. Reading one that another site's video or image was drawn into throws a SecurityError (the
// canvas is "tainted"), which the video frames have a way around (see frameFromReloadedMedia).
// Used by: web pages, the result tab, the Library.
async function canvasToPng(canvas) {
  const png = await new Promise((resolve, reject) => {
    try {
      canvas.toBlob(resolve, 'image/png');
    } catch (error) {
      reject(error);
    }
  });
  if (!png) {
    throw new Error("Couldn't convert this image");
  }
  return png;
}

// Animated GIFs, WebPs and PNGs: only their first frame is processed
// Used by: web pages, the result tab, the Library.
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

// Used by: web pages, the result tab, the Library.
async function isSvgBlob(blob) {
  if (blob.type === 'image/svg+xml') return true;
  if (blob.type.startsWith('image/')) return false;
  // Some servers send SVG as text/xml, text/plain or with no type
  return /<svg[\s>]/i.test(await blob.slice(0, 1024).text());
}

// Used by: web pages, the result tab, the Library.
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

// Used by: web pages, the result tab.
async function getImageHash(imgElement) {
  // Get the image data (a video's frame is already here, taken from the page itself)
  const frame = videoFrames.get(imgElement);
  const imageUrl = frame ? frame.url : getSourceUrl(imgElement);
  // (the viewer's original is here already too, read from where the tab found it)
  const imageBlob = frame ? frame.blob
    : resultTabOriginal?.image === imgElement ? resultTabOriginal.blob
    : await fetchImageBlob(imageUrl);
  return hashedImage(imageBlob, imageUrl, imgElement);
}

// What a job needs of a picture already read, whoever read it (a page's image above, a file on the Library page):
// its base64, its size (sizedBy: the element to go by where the picture itself won't say), the settings, and the hash
// of the picture with those settings, which is what its result is cached under
// Used by: web pages, the result tab, the Library.
async function hashedImage(imageBlob, imageUrl, sizedBy) {
  const base64Image = await blobToBase64(imageBlob);
  const imageSize = await getBlobSize(imageBlob, sizedBy);

  // Get settings from storage
  const settings = await getSettings();

  // Generate hash including settings
  const imageHash = hashBase64(base64Image, settings);
  return [imageHash, base64Image, imageSize, settings, imageUrl, imageBlob];
}

// Jobs go to the server one at a time (background.js's queue, across every tab; see its jobsAtOnce, which only My
// ComfyUI can raise). Each image is
// handed over ready to go, downloaded, hashed and looked up in the cache, and waits its turn there while its spinner
// shows how many are ahead; the jobs outlive this page (see runJob). This page's jobs still waiting, by their spinner:
// a click on a waiting job's spinner takes it back, as does a waiting image clicked again in Manual Selection, and
// Stop Processing takes back Automatic Selection's.
const waitingJobs = new Map(); // spinner -> { drop(), auto }
// How many times the popup has cleared the queue: an image picked before the last time doesn't join it
let queueClears = 0;

// Whether these settings pick a new seed each run (usesRandomSeed): a pick then runs a new job rather than showing the
// result cached for the image and these settings
// Used by: web pages, the result tab.
function picksNewSeed(settings) {
  return isCustomWorkflow(effectiveWorkflow(settings)) && usesRandomSeed(settings.customWorkflow, settings.customWorkflowValues);
}

// The process again button of a processed image (and of the viewer's result): the image's original goes off again
// with the settings as they are now. With a new seed each run that is a new job and a new result; otherwise the same
// settings come back to the result the image already has, which a notice says instead of showing it again. Each click
// is a job of its own, also while the image's earlier ones are still waiting or running: each has its spinner, and
// each result goes on the image as it comes back.
// Used by: web pages, the result tab.
async function reprocessImage(imgElement) {
  if (extensionContextLost()) return;
  try {
    const settings = await getSettings();
    if (!picksNewSeed(settings)) {
      const [imageHash, , , , imageUrl] = await getImageHash(imgElement);
      const cached = await getFromCache(imageHash, imageUrl);
      const shown = revertedResults.get(imgElement) || imageSrc(imgElement);
      if (cached && (cached === shown || resultsShownHere.has(imageHash))) {
        // (the popup's "New seed each time" is there for a seed of the user's own workflow)
        const hasSeed = isCustomWorkflow(effectiveWorkflow(settings)) && (settings.customWorkflow?.settings || []).some(setting => setting.seed);
        showPageNotice(hasSeed
          ? 'Same settings, same result. For another one, change a setting or turn on New seed each time in the popup.'
          : 'Same settings, same result. Change a setting in the popup for another one.');
        return;
      }
    }
    settingsHash = hashBase64('', settings);
    imgElement.setAttribute('data-img2img-settings', settingsHash);
    selectedImage = imgElement;
    await swapImage(imgElement);
  } catch (error) {
    if (extensionContextLost()) return;
    showPageError(`Couldn't process it again: ${error.message}`);
  }
}

// Used by: web pages, the result tab.
// The images with jobs on their way (from the click to the result), by how many: Manual Selection doesn't offer
// such an image again meanwhile (a click on it takes a waiting job back), though its process again button adds more
const imagesInFlight = {
  counts: new WeakMap(),
  has(image) { return (this.counts.get(image) || 0) > 0; },
  add(image) { this.counts.set(image, (this.counts.get(image) || 0) + 1); },
  delete(image) {
    const left = (this.counts.get(image) || 0) - 1;
    if (left > 0) this.counts.set(image, left);
    else this.counts.delete(image);
  },
};

// Used by: web pages, the result tab.
async function swapImage(imgElement, { auto = false } = {}) {
  let imageUpdated = false;
  const spinner = showSpinner(imgElement);
  const clearsWhenPicked = queueClears;
  swapsInProgress++;
  imagesInFlight.add(imgElement);
  // In a result tab, the image already has a result, so a new one goes in its dropdown, whatever the settings, rather
  // than in yet another tab (background.js still opens one if the tab is gone by the time it's done). On a web page
  // Open Results in New Tab opens every new result.
  const addsToImage = isResultTab && imgElement.tagName !== 'VIDEO' && hasResult(imgElement);
  try {
    let [imageHash, base64Image, imageSize, settings, imageUrl, imageBlob] = await getImageHash(imgElement);
    // A video frame keeps the hash its result is cached under, so the moment can be found again on a later
    // page (keepFrameAcrossPages) without the picture itself being kept anywhere but the cache
    const capturedFrame = videoFrames.get(imgElement);
    if (capturedFrame) capturedFrame.hash = imageHash;
    const name = await resultBaseName(settings);
    if (capturedFrame) {
      // Kept now, before the job goes off, rather than when its result comes back: background.js caches the
      // result whether this page is still here or not (its jobs outlive the page), so a page left in the
      // meantime would otherwise never have kept the moment and nothing would come back on a later load. A
      // moment whose job never produced a result is dropped the first time it is looked up and nothing is
      // found in the cache for it (see restoreFromTheCache).
      capturedFrame.settings = imgElement.getAttribute('data-img2img-settings') || capturedFrame.settings;
      keepFrameAcrossPages(capturedFrame, name).catch(error => {
        if (!extensionContextLost()) console.debug('img2img: keeping the moment for later failed:', error);
      });
    }
      // make sure this image is not in a container with class 'img-blur'
    let container = imgElement.parentElement;
    while (container && !container.classList.contains('img-blur') && !container.classList.contains('img-back')) {
      container = container.parentElement;
    }
    if (container) {
      return;
    }
    
    const callbacks = {
      clearsWhenPicked,
      addsToImage,
      onProgress: spinner.setProgress,
      onEstimate: spinner.setEstimate,
      onWaiting: (ahead, drop) => {
        spinner.setWaiting(ahead, ahead ? drop : null);
        if (ahead) {
          waitingJobs.set(spinner, { drop, auto });
        } else {
          waitingJobs.delete(spinner);
        }
      },
    };
    // The cached result of this image and these settings, or a job for it (resultForImage). Stop Processing before
    // the job joins the queue: Automatic Selection's image goes back to the page as it was.
    // (a new seed each run: a picked image runs again rather than showing its cached result; Automatic Selection
    // still shows what is cached, or every visit to a page would run its images again)
    const result = await resultForImage({ imageHash, base64Image, imageSize, settings, imageUrl, imageBlob }, name, callbacks, () => {
      if (auto && !isContinuousProcessing) {
        throw Object.assign(new Error('Processing stopped'), { dropped: true });
      }
    }, { fresh: !auto && picksNewSeed(settings) });
    if (result.cached) {
      // The newest result of this image and these settings, whichever of them was on show before
      shownGeneration.delete(imgElement);
      showResult(imgElement, result.data, name);
      imageUpdated = true;
      addDownloadButton(imgElement);
      if (!addsToImage && !(isResultTab && resultsShownHere.has(imageHash))) {
        resultsShownHere.add(imageHash);
        openResultInNewTab(settings, imageHash, imageUrl, name, originalForResultTab(settings, base64Image, imageBlob));
      }
      return;
    }

    // (the image the spinner followed, in case the page rebuilt it meanwhile)
    const target = spinner.image();
    if (target.tagName === 'VIDEO' && !videoShowsItsFrame(target)) {
      // Its player moved on while the frame was processing (the next story): there's no video of that frame on the
      // page to show the result over, so it opens in a tab of its own instead
      if (!settings.openResultsInNewTab) {
        chrome.runtime.sendMessage({ action: 'openResultTab', hash: imageHash, name, imageUrl });
      }
      showPageNotice('That video moved on while its frame was processing: the result opened in a new tab.');
      imageUpdated = true;
      return;
    }
    // Which of the image's results this is, so the dropdown says the one that is showing rather than the one that
    // was: the others are still in the cache, so there is no telling from the list alone (see loadGenerations)
    if (result.key) {
      shownGeneration.set(target, result.key);
      resultKeys.set(result.data, result.key);
    }
    showResult(target, result.data, name);
    resultsShownHere.add(imageHash); // (background.js opened its tab, with the setting on)
    imageUpdated = true;
    addDownloadButton(target);
    if (isResultTab) {
      // The image's earlier results stay cached, so the marker (or viewer.html's hash) would bring the old one back
      // on a reload
      history.replaceState(null, '', location.href.replace(/img2img-result=[^&]*/, `img2img-result=${encodeURIComponent(imageHash)}`));
      const viewerUrl = new URL(location.href);
      if (viewerUrl.searchParams.has('hash')) {
        viewerUrl.searchParams.set('hash', result.key || imageHash);
        history.replaceState(null, '', viewerUrl.href);
      }
    }
  } catch (error) {
    if (error.dropped) {
      // Out of the queue before anything went to the server: the image can be picked again
      imgElement.removeAttribute('data-img2img-settings');
      return;
    }
    // The user sees the error on the page (NSFW refusals, credits, server errors), so it isn't logged as an
    // error too: that would fill the extension's error list on chrome://extensions
    console.debug('img2img: processing failed:', error);
    if (!imageUpdated) {
      // Nothing was put on the image, so Manual Selection lets it be clicked again (without leaving and re-entering
      // the mode) once the server is back. Automatic Selection keeps the mark: it would pick the same failing image
      // again and again.
      if (!auto) spinner.image().removeAttribute('data-img2img-settings');
      const message = error.message === 'Failed to fetch' ? await unreachableServerMessage() : error.message;
      // The server is down and img2img.shop says why (background.js's outageNotice)
      showPageError(error.notice ? `${message} — ${error.notice}` : message);
    }
  } finally {
    waitingJobs.delete(spinner);
    spinner.remove();
    swapsInProgress--;
    imagesInFlight.delete(imgElement);
  }
}

// From a picture read and hashed (hashedImage) to its result, whoever asks (swapImage for an image on a page,
// library.js for a file): the cache first, since the same picture with the same settings was done before; else the
// checks (sourceForJob) and a job in background.js's queue. Resolves { data, key }, with cached: true for a result
// that needed no job. beforeQueue runs just before the job is handed over and may throw to call it off.
// Used by: web pages, the result tab, the Library.
async function resultForImage({ imageHash, base64Image, imageSize, settings, imageUrl, imageBlob }, name, callbacks, beforeQueue = () => {}, { fresh = false } = {}) {
  // (fresh: a new result wanted, whatever the cache holds for these settings)
  const cached = fresh ? null : await getFromCache(imageHash, imageUrl);
  if (cached) {
    return { data: cached, key: resultKeys.get(cached), cached: true };
  }
  const source = await sourceForJob(settings, imageBlob);
  beforeQueue();
  // (the Library's jobs take no original along: it opens no result tabs, and its files are the user's already)
  const original = isLibrary ? undefined : await originalForJob(settings, base64Image, imageBlob);
  return processesOnServer(settings)
    ? processOnServer(source.dataUrls, base64Image, settings, imageHash, imageUrl, name, callbacks, original)
    : processOnComfyUI(base64Image, settings, imageSize, imageHash, imageUrl, name, callbacks, original);
}

// What a job is checked for before it joins the queue, whoever starts it (an image on a page, a file on the Library
// page): that the workflow runs where Processing sends it, and that the terms were agreed to. Resolves with the
// source the job takes along (no images for the workflows without one).
// Used by: web pages, the result tab, the Library.
async function sourceForJob(settings, imageBlob) {
  const usesSwap = SWAP_WORKFLOWS.includes(effectiveWorkflow(settings));
  if (usesSwap && !processesOnServer(settings)) {
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
  // Get the selected source from IndexedDB (only the workflows with a source, and a background replaced by an
  // image, use one)
  const source = usesSwap || usesSourceImage(settings) ? await getSource(selectedSourceId) : { dataUrls: [] };
  if (!source) {
    throw new Error(usesSwap ? 'Selected source not found' : 'Select the new background under Source in the popup first');
  }
  return source;
}

// Local processing: build the workflow here; background.js runs it on the user's own ComfyUI
// Used by: web pages, the result tab, the Library.
async function processOnComfyUI(base64Image, settings, imageSize, hash, imageUrl, name, callbacks, original) {
  const workflow = await buildWorkflow(base64Image, settings, imageSize);
  // The NSFW checks' probes, read before the result is shown
  const probes = safetyProbes(workflow).map(probe => ({ ...probe, refusal: nsfwRefusal(probe.label) }));
  // With Keep Workflow in Results on (settings page), a My workflows result keeps the graph ComfyUI writes into the
  // image, so dropping it into ComfyUI opens the workflow that made it; every other result has it taken out (see
  // fetchComfyResult in background.js)
  const keepWorkflow = settings.keepWorkflowInResult === true && isCustomWorkflow(effectiveWorkflow(settings));
  return runJob({ kind: 'comfy', workflow, probes, output: resultNode(workflow), hash, imageUrl, name, keepWorkflow, original }, callbacks);
}

// Hosted processing: the img2img server builds the workflow from the settings, runs it and keeps
// the result until background.js collects it. The server measures the image itself and ignores settings it doesn't know.

// Images go to the img2img server unless the user chose their own ComfyUI (Processing: My ComfyUI)
// Used by: web pages, the result tab, the Library.
function processesOnServer(settings) {
  return settings.processingMode !== 'local';
}

// Within the API's limits (shared/workflows.js HOSTED_MAX_*): a new background needs only its source's first image,
// and an image that's too large is shrunk to fit rather than refused (shared/images.js)
// Used by: web pages, the result tab, the Library.
async function processOnServer(sourceImages, base64Image, settings, hash, imageUrl, name, callbacks, original) {
  const sources = SWAP_WORKFLOWS.includes(effectiveWorkflow(settings)) ? sourceImages.slice(0, HOSTED_MAX_SOURCE_IMAGES) : sourceImages.slice(0, 1);
  const body = {
    workflow: settings.workflow,
    settings,
    image: await fitImage(base64Image, { maxBytes: HOSTED_MAX_TARGET_BYTES }),
    sourceImages: await Promise.all(sources.map(source => fitImage(source, { maxBytes: HOSTED_MAX_SOURCE_BYTES }))),
  };
  return runJob({ kind: 'server', body, hash, imageUrl, name, original }, callbacks);
}

// Hand a job to background.js, which queues it (one job goes to the server at a time, see its jobsAtOnce), runs it to
// the end (see its JOB_PORT) and answers { data }: the result, or { error }, with a { notice } explaining it when the
// server couldn't be reached and img2img.shop has a warning out. On the way it sends { ahead } while the job waits its
// turn (how many jobs are ahead, 0 once it starts), passed to onWaiting with a function that takes the job back out of
// the queue (the job then fails with a dropped error); for jobs on the user's ComfyUI, { progress } as it goes (a
// percentage, passed to onProgress); for hosted jobs, { estimate } once accepted (how many ms the server expects the
// job to take, passed to onEstimate). The port closes with the page, which tells background.js to drop the page's
// waiting jobs and cancel its running ones (or to finish them all and open the results in new tabs or download them,
// when those settings are on).
let jobPort = null;
let nextJobId = 0;
const pendingJobs = new Map();

// Used by: web pages, the result tab, the Library.
async function runJob(job, { onProgress, onEstimate, onWaiting, clearsWhenPicked, addsToImage } = {}) {
  if (clearsWhenPicked !== undefined && clearsWhenPicked !== queueClears) {
    // (picked before the popup cleared the queue, and only now ready to join it)
    throw Object.assign(new Error('Taken out of the queue'), { dropped: true });
  }
  job.name ??= await resultBaseName();
  job.isImagePage = isImagePage();
  if (addsToImage) job.addsToImage = true; // (a result tab's: its result goes in the image's dropdown, with no tab of its own)
  if (isLibrary) job.fromLibrary = true;
  if (!jobPort) {
    jobPort = chrome.runtime.connect({ name: 'img2img-jobs' });
    jobPort.onMessage.addListener(({ id, data, key, error, dropped, notice, progress, estimate, ahead }) => {
      const pending = pendingJobs.get(id);
      if (!pending) return;
      if (progress !== undefined) {
        pending.onProgress?.(progress);
        return;
      }
      if (estimate !== undefined) {
        pending.onEstimate?.(estimate);
        return;
      }
      if (ahead !== undefined) {
        pending.onWaiting?.(ahead, pending.drop);
        return;
      }
      pendingJobs.delete(id);
      if (error === undefined) {
        pending.resolve({ data, key });
      } else {
        pending.reject(Object.assign(new Error(error), dropped ? { dropped: true } : {}, notice ? { notice } : {}));
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
    const drop = () => jobPort?.postMessage({ id, drop: true });
    pendingJobs.set(id, { resolve, reject, onProgress, onEstimate, onWaiting, drop });
    jobPort.postMessage({ id, job });
  });
}

// Leaving the page cancels its images still processing, so the browser asks first. Not when results open in new tabs
// or download automatically: those finish anyway and open there or go to Downloads.
let swapsInProgress = 0;
const resultsOutliveThePage = { openResultsInNewTab: false, autoDownload: false };
chrome.storage.local.get(Object.keys(resultsOutliveThePage), result => {
  Object.keys(resultsOutliveThePage).forEach(key => { resultsOutliveThePage[key] = result[key] === true; });
});
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return;
  Object.keys(resultsOutliveThePage).filter(key => changes[key]).forEach(key => {
    resultsOutliveThePage[key] = changes[key].newValue === true;
  });
});
window.addEventListener('beforeunload', event => {
  if (swapsInProgress > 0 && !Object.values(resultsOutliveThePage).some(Boolean)) {
    event.preventDefault();
    event.returnValue = ''; // (older Chrome versions only ask when this is set)
  }
});

// The error shown when the server images go to can't be reached
// Used by: web pages, the result tab, the Library.
async function unreachableServerMessage() {
  const settings = await chrome.storage.local.get('processingMode');
  if (processesOnServer(settings)) {
    return "Can't reach the img2img server";
  }
  return `Can't reach ComfyUI at ${await getComfyServerAddress()}`;
}

// Helper to get the dimensions of the fetched image (Blobs have no width/height)
// Used by: web pages, the result tab, the Library.
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
// Used by: web pages, the result tab, the Library.
function showPageError(message) {
  showToast(message, '#c62828');
}

// The same for information that isn't an error
// Used by: web pages, the result tab, the Library.
function showPageNotice(message) {
  showToast(message, '#323232');
}

// Used by: web pages, the result tab, the Library.
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
// Used by: web pages, the result tab, the Library.
async function blobToBase64(blob) {
  return (await blobToDataUrl(blob)).split(',')[1];
}

// Used by: web pages, the result tab, the Library.
function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

// How far an element is from the window (0 when any of it is in view), so continuous processing does the images
// in view first and then works outwards
function distanceFromView(rect) {
  const dx = Math.max(0, rect.left - window.innerWidth, -rect.right);
  const dy = Math.max(0, rect.top - window.innerHeight, -rect.bottom);
  return Math.hypot(dx, dy);
}

// The sizes of images the page hasn't loaded yet (lazy ones out of view), looked up once each: null while loading
const probedSizes = new Map();
function probedSize(url) {
  if (!probedSizes.has(url)) {
    probedSizes.set(url, null);
    const probe = new Image();
    probe.onload = () => probedSizes.set(url, { width: probe.naturalWidth, height: probe.naturalHeight });
    probe.onerror = () => probedSizes.set(url, { width: 0, height: 0 });
    probe.src = url;
  }
  return probedSizes.get(url);
}

// Function to check if image meets minimum size requirements. An image that isn't loaded yet (lazy loading, out
// of view) is measured from its own file instead, so it doesn't have to be scrolled to first.
// "Smallest Image" (minImageSide): Automatic Selection and auto-process leave anything smaller alone, so thumbnails,
// avatars and sprites don't cost a job. Manual Selection and the right-click menu have no minimum: those are a
// deliberate choice of one image.
const DEFAULT_MIN_IMAGE_SIDE = 300;
let minImageSide = DEFAULT_MIN_IMAGE_SIDE;

const asImageSide = value => (Number(value) > 0 ? Number(value) : DEFAULT_MIN_IMAGE_SIDE);
chrome.storage.local.get('minImageSide', ({ minImageSide: saved }) => { minImageSide = asImageSide(saved); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.minImageSide) minImageSide = asImageSide(changes.minImageSide.newValue);
});

function meetsSizeRequirements(img) {
  if (img.tagName !== 'IMG') {
    // A background picture has no size of its own on the page: it's measured from its file, as a lazy image is
    const size = probedSize(automaticPictureUrl(img));
    return Boolean(size) && size.width >= minImageSide && size.height >= minImageSide;
  }
  const unloadedUrl = lazySourceUrl(img) || (img.complete ? '' : img.src);
  const size = unloadedUrl ? probedSize(unloadedUrl) : { width: img.naturalWidth, height: img.naturalHeight };
  return Boolean(size) && size.width >= minImageSide && size.height >= minImageSide;
}

// The settings the content script reads
const SETTING_KEYS = ['selectedSourceId', 'comfyServerAddress', 'workflow', 'controlnetPreprocessor', 'controlnetResolution', 'controlnetOptions', 'upscaleModel', 'upscaleScale', 'backgroundMode', 'backgroundColor', 'backgroundColor2', 'backgroundBlur', 'restoreModel', 'restoreStrength', 'restoreFidelity', 'colorizeStrength', 'cleanupMode', 'stickerOutline', 'stickerColor', 'stickerShadow', 'idPhotoSize', 'idPhotoBackground', 'faceBlurStyle', 'faceBlurStrength', 'filterStyle', 'filterStrength', 'transformPreset', 'transformVariation', 'segmentPrompt', 'segmentThreshold', 'segmentOutput', 'processingMode', 'openResultsInNewTab', 'keepWorkflowInResult', 'customWorkflows', 'customWorkflowValues', 'termsAgreedVersion'];

// Used by: web pages, the result tab, the Library.
async function getSettings() {
  await siteRulesRead; // (the workflow a site rule chose for this tab is read with the rules)
  return new Promise(resolve => {
    chrome.storage.local.get(SETTING_KEYS, settings => {
      const definitions = settings.customWorkflows || [];
      // A rule's workflow of the user's own, deleted since the page loaded: the popup's choice from here on (deleting
      // a workflow drops the rules that ran it, and puts the popup's choice back to the default)
      if (customWorkflowId(tabWorkflow) && !definitions.some(definition => definition.id === customWorkflowId(tabWorkflow))) {
        tabWorkflow = '';
      }
      // The workflow a site rule chose for this tab as the page loaded, else the popup's choice (see tabWorkflow).
      // It goes through the same replacements, so an old name still works.
      const chosen = tabWorkflow || settings.workflow;
      settings.workflow = WORKFLOW_REPLACEMENTS[chosen] || chosen || DEFAULT_WORKFLOW;
      // Of the user's own workflows, only the selected one and its values (the others never leave storage)
      const customId = customWorkflowId(settings.workflow);
      settings.customWorkflow = customId ? definitions.find(definition => definition.id === customId) : undefined;
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

// The picture Automatic Selection would process an element for: an <img>'s own or lazy-loading URL, or the one an
// element shows as its CSS background (its original, once a result is over it)
function automaticPictureUrl(element) {
  if (element.tagName === 'IMG') return element.src || lazySourceUrl(element);
  return element.getAttribute('data-original-src') || cssBackgroundUrl(element);
}

// Function to find next available image
async function findNextAvailableImage() {
  // The page's <img>s, and the elements showing a picture as their background (see allBackgrounds)
  const images = [...allImages(), ...allBackgrounds()];
  // We need to add a hash to the image, but only with the settings that were used to generate the image
  // Here we will check for that hash in the image's class, so we know to skip it if it has been processed
  let settings = await getSettings();
  settingsHash = hashBase64("", settings);

  // Every image of the page, not only those in view; hidden ones (no size on the page) are left alone
  let nextImage = null;
  let nearest = Infinity;
  for (const img of images) {
    if (img.getAttribute('data-img2img-settings') === settingsHash || !automaticPictureUrl(img)) continue;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const distance = distanceFromView(rect);
    if (distance < nearest && meetsSizeRequirements(img)) {
      nextImage = img;
      nearest = distance;
      if (distance === 0) break;
    }
  }
  if (nextImage) {
    nextImage.setAttribute('data-img2img-settings', settingsHash);
  }
  return nextImage;
}

// Automatic Selection keeps one image at the server and the next one ready: it's picked, downloaded and looked up in
// the cache while the one before runs (background.js sends one job at a time), so the page's images follow one
// another without a gap, and the rest of the page isn't downloaded ahead of time. A pick waits for the one before it
// (the settings are read first).
const AUTO_IMAGES_AT_ONCE = 2;
let activeSwaps = 0; // Automatic Selection's images, from being picked to done
let picking = false;

// "Stop After" (autoStopAfter): Automatic Selection and auto-process walk a whole page, which on the img2img server
// costs credits an image, so this caps one run of it. "Ask Before" is the popup's half of the same job: it knows the
// credits a workflow costs, and asks over that many images (see countAutomaticImages).
let autoStopAfter = 0; // 0: no cap
let automaticDone = 0; // images this run has started on, counted from the click or the page load that began it

const asCount = value => Math.max(Math.round(Number(value)) || 0, 0);
chrome.storage.local.get('autoStopAfter', ({ autoStopAfter: saved }) => { autoStopAfter = asCount(saved); });
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.autoStopAfter) autoStopAfter = asCount(changes.autoStopAfter.newValue);
});

async function processNextAvailableImage() {
  if (!isContinuousProcessing || isResultTab || picking || activeSwaps >= AUTO_IMAGES_AT_ONCE) return;
  if (autoStopAfter > 0 && automaticDone >= autoStopAfter) {
    stopContinuousProcessing();
    chrome.storage.local.set({ isProcessing: false }); // (so the popup's button isn't still "Stop Processing")
    showPageNotice(`Stopped after ${autoStopAfter} image${autoStopAfter === 1 ? '' : 's'} on this page (Stop After, in the img2img settings).`);
    return;
  }
  picking = true;
  try {
    const nextImage = await findNextAvailableImage();
    if (nextImage) {
      ++activeSwaps;
      ++automaticDone;
      swapImage(nextImage, { auto: true }).finally(() => --activeSwaps);
    }
  } finally {
    picking = false;
  }
}

// How many images Automatic Selection would convert here now, for the popup's question before it starts. The same
// rule as findNextAvailableImage, so it counts what would actually run; one not loaded yet, whose size is still
// unknown, isn't counted (the run itself downloads and measures it).
async function countAutomaticImages() {
  const hash = hashBase64('', await getSettings());
  return [...allImages(), ...allBackgrounds()].filter(img => {
    if (img.getAttribute('data-img2img-settings') === hash || !automaticPictureUrl(img)) return false;
    const rect = img.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && meetsSizeRequirements(img);
  }).length;
}

// Function to start continuous processing
function startContinuousProcessing() {
  isContinuousProcessing = true;
  automaticDone = 0; // Stop After counts each run: starting it again is asking for another run's worth
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
  // Automatic Selection's image waiting its turn goes back to the page as it was; the one at the server finishes
  waitingJobs.forEach(entry => entry.auto && entry.drop());
}

showResultFromUrlMarker();

// Run Swap Cache as soon as the page is usable instead of waiting for every image to load
// (background.js runs it again on tab load complete to catch images added later)
chrome.storage.local.get(['autoRemember', 'selectedSourceId'], async result => {
  if (result.autoRemember !== false && await allowedHere({ auto: true })) {
    selectedSourceId = result.selectedSourceId;
    replaceCachedImages();
  }
});
