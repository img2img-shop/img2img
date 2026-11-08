let isSelecting = false;
let selectedImage = null;
let selectedSourceId = null;
let isContinuousProcessing = false; // Track continuous processing mode
let checkInterval = null; // For continuous checking
let settingsHash = null;
let isResultTab = false; // this tab shows a result opened via #img2img-result (no automatic processing)

const DB_NAME = 'imageSwapCache';
const STORE_NAME = 'images';
const DB_VERSION = 1;
const MAX_CACHE_ENTRIES = 50; // Maximum number of cached images

// Get a source from IndexedDB
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
const siteRulesRead = new Promise(resolve => {
  chrome.storage.local.get(Object.keys(siteRules), stored => {
    Object.keys(siteRules).forEach(key => { siteRules[key] = stored[key] || ''; });
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
  } else if (request.action === 'runWorkflowOnImage') {
    allowedHere(request).then(allowed => allowed && runWorkflowOnRightClickedImage(request));
  } else if (request.action === 'countAutomaticImages') {
    countAutomaticImages().then(count => sendResponse({ count }));
    return true; // the answer comes after the settings have been read
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
  // Videos as well: the moments of them that have results come back over them (see restoreFromTheCache)
  allVideos().forEach(watchForRestore);
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

// Results shown on this page, by their original's URL. Some sites rebuild their images (a carousel's slides,
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
      } else if (node.tagName === 'VIDEO') {
        videos.add(node);
      } else if (node.firstElementChild) {
        node.querySelectorAll('img').forEach(img => images.add(img));
        if (videoResults.length > 0) node.querySelectorAll('video').forEach(video => videos.add(video));
      }
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

function imageSrc(element) {
  if (element.tagName === 'IMG') return element.src;
  if (element.tagName === 'VIDEO') return shownOverVideo.get(element) ?? videoFrames.get(element)?.url ?? '';
  return backgroundResults.get(element) ?? cssBackgroundUrl(element);
}

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
function cssBackgroundUrl(element) {
  const value = getComputedStyle(element).backgroundImage;
  return value && value !== 'none' ? /url\(\s*(["']?)(.*?)\1\s*\)/.exec(value)?.[2] || '' : '';
}

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
// holds its own result: { time, url, mediaId, mediaSrc, dataUrl, blob, fingerprint, result, settings }.
//
// The frames with results, newest first, so a player that opens the same media again (a story gone back to, a
// feed re-rendered) gets them back. One is found by the media's URL where the player names it, and otherwise by
// the picture it shows: a player is handed a fresh blob: URL every time a story is opened, so there's no
// URL to recognise it by. The frames of one piece of media share a mediaId, so recognising any one of them
// brings back all of them, and with them the dropdown. Only the last few are kept: each holds a picture.
const videoResults = [];
const KEPT_VIDEO_RESULTS = 8;
const VIDEO_ITSELF = 'img2img-video'; // a video's "original": the video itself rather than a picture of ours
const SAME_FRAME_SECONDS = 0.05; // two moments closer than this are the same frame
let nextMediaId = 0;
const FINGERPRINT_SIDE = 16; // a frame as a 16x16 grey thumbnail, which is what media is recognised by
const FINGERPRINT_STEP = 64; // scaled down through this size first, so the thumbnail is an average of the frame
const FINGERPRINT_TOLERANCE = 18; // mean difference per pixel still counting as the same picture (64 = one spread)
const FINGERPRINT_FLATNESS = 4; // an even frame (black, still loading) says nothing about which media it is
const RESTORE_TRIES = 10; // frames looked at as new media starts, before giving up on recognising it

// The media a video is pointed at: its src where the player names one, and currentSrc where the media comes
// from the player itself (a stream) or a <source>. Deliberately not either of the two: while a player takes up
// other media, currentSrc still names the media before it for a moment, and going by that would tie a result to
// the wrong media (see videoShowsItsFrame, which does allow either while that moment lasts).
function videoMediaSrc(video) {
  return video.src || video.currentSrc;
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
function mediaLength(video) {
  return Number.isFinite(video.duration) && video.duration > 0 ? Number(video.duration.toFixed(2)) : 0;
}

// Whether a processed moment belongs to the media a video is playing: the same name, and a length that agrees
// within a second where both know one. The length is what tells two videos on one page apart.
const MEDIA_LENGTH_TOLERANCE = 1;

function sameMedia(moment, video) {
  if (!moment.media || moment.media !== mediaKeyOf(video)) return false;
  const length = mediaLength(video);
  if (!moment.length || !length) return true;
  return Math.abs(moment.length - length) <= MEDIA_LENGTH_TOLERANCE;
}

// The same rules as cacheImageUrl in background.js, which does this for a page image's URL
const SIGNED_PATH_HOSTS = /(^|\.)(cdninstagram\.com|fbcdn\.net)$/i;
const MEDIA_SIGNATURE_PARAMS = /^(x-amz-.+|x-goog-.+|expires|signature|key-pair-id|policy)$/i;

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
function videoShowsItsFrame(video) {
  const frame = videoFrames.get(video);
  if (!frame || !video.isConnected) return false;
  return video.currentSrc === frame.mediaSrc || video.src === frame.mediaSrc;
}

// The pixels of the frame a video shows, kept until the click that took them turns out to be a single one (see
// handleImageClick). Drawing a video of another site taints the canvas, which only shows when the pixels are read,
// in captureVideoFrame.
function grabVideoFrame(video) {
  const grab = { mediaSrc: videoMediaSrc(video), media: mediaKeyOf(video), length: mediaLength(video), time: video.currentTime, width: video.videoWidth, height: video.videoHeight, canvas: null };
  if (grab.width && grab.height) {
    grab.canvas = document.createElement('canvas');
    grab.canvas.width = grab.width;
    grab.canvas.height = grab.height;
    grab.canvas.getContext('2d').drawImage(video, 0, 0, grab.width, grab.height);
  }
  grabbedFrames.set(video, grab);
  // A story that plays on would be gone (the next one) before its result is there, and the player's progress
  // follows its video: it stays paused until the user starts it again, with the result over it
  video.pause();
}

// The grabbed frame as a PNG, ready to be processed like a page image
async function captureVideoFrame(video) {
  const grab = grabbedFrames.get(video);
  if (!grab?.canvas) {
    throw new Error("This video hasn't got a frame to process yet");
  }
  let blob;
  try {
    blob = await canvasToPng(grab.canvas);
  } catch (error) {
    // The canvas is tainted: the video is another site's and the page may not read its pixels
    blob = await frameFromReloadedMedia(grab);
  }
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
    result: null, // set when it comes back from the server (showResult)
    settings: null,
  };
  videoFrames.set(video, frame);
  return frame;
}

// Frames of the same media share an id, whatever URL it was playing under when each was taken, so that all of a
// video's frames are found together
function mediaIdOf(video, mediaSrc) {
  const sameMedia = frameListOf(video).find(frame => frame.mediaSrc === mediaSrc);
  return sameMedia ? sameMedia.mediaId : ++nextMediaId;
}

// The frames of the media a video is playing that have a result, earliest first
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
function frameFingerprint(video) {
  return video.readyState >= 2 ? thumbnailOf(video) : null;
}

// (null for a frame too even to name any media, and for another site's video, whose pixels the page may not read)
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
function showOverVideo(video, url) {
  shownOverVideo.set(video, url);
  // A result is a still picture pinned over the video, so the player is stopped where it is: a story would
  // otherwise play on and move to the next one behind the result. (The toggle button puts the video back;
  // starting it again from there is the user's to do.)
  if (showsAResult(url)) {
    video.pause();
  }
  if (frameOverlays.has(video)) return;
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
function showsAResult(url) {
  return Boolean(url) && url.startsWith('data:');
}

function followVideo(video, overlay) {
  if (frameOverlays.get(video) !== overlay) return; // cleared, or the video has a newer overlay
  if (!videoShowsItsFrame(video)) {
    // The player moved on to other media, or the video left the page: the result has nothing to sit on anymore
    clearVideoResult(video);
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
function clearVideoResult(video) {
  frameOverlays.get(video)?.remove();
  frameOverlays.delete(video);
  resultSelects.get(video)?.remove();
  resultSelects.delete(video);
  shownOverVideo.delete(video);
  videoFrames.delete(video);
  videoFrameLists.delete(video);
  grabbedFrames.delete(video);
  revertedResults.delete(video);
  video.removeAttribute('data-img2img-settings');
  video.removeAttribute('data-original-src');
  for (const buttons of [downloadButtons, revertButtons, compareButtons]) {
    buttons.get(video)?.remove();
    buttons.delete(video);
  }
}

// A frame with a result is kept, so the media it came from gets it back later
function rememberFrame(frame) {
  const already = videoResults.indexOf(frame);
  if (already >= 0) videoResults.splice(already, 1);
  videoResults.unshift(frame);
  videoResults.length = Math.min(videoResults.length, KEPT_VIDEO_RESULTS);
}

// The result remembered for the media a video plays: by URL where the player names it (a file on a CDN), and
// otherwise by the picture its frame shows, which is how a story opened again under a fresh blob: URL is
// recognised. The frames of a moving video are all different, so only a still one is recognised that way -
// which is what this is for: a still story with a song added to it.
function rememberedForVideo(video) {
  const byUrl = videoResults.find(frame => frame.mediaSrc === videoMediaSrc(video));
  if (byUrl) return byUrl;
  // The same media under another URL (a story opened again gets a fresh blob: one), which costs nothing to ask
  const byMedia = videoResults.find(frame => sameMedia(frame, video));
  if (byMedia) return byMedia;
  // The frame it shows, once the media it is pointed at is the media it plays: during the changeover the frame
  // on screen is still the one before it, which would be recognised as the wrong story
  if (!videoSettled(video) || !videoResults.some(frame => frame.fingerprint)) return null;
  const fingerprint = frameFingerprint(video);
  return fingerprint
    ? videoResults.find(frame => fingerprintsMatch(frame.fingerprint, fingerprint))
    : null;
}

// Whether the frame a video shows belongs to the media it is pointed at, rather than to media it is leaving
function videoSettled(video) {
  return video.readyState >= 2 && (!video.src || video.src === video.currentSrc);
}

// A player that opened media again that has a result (a story gone back to, a feed re-rendered) shows the result
// over it, from the frame it was made of
function restoreVideo(video) {
  if (videoFrames.has(video)) return;
  const remembered = videoResults.length > 0 ? rememberedForVideo(video) : null;
  if (!remembered) {
    // Nothing on this page: what the cache has for this media, if the user asked for that (Swap Cache)
    if (swapCacheOn) restoreFromTheCache(video);
    return;
  }
  // Every frame of that media, so all of them are in the dropdown again, under the URL it is playing under now
  const frames = videoResults.filter(frame => frame.mediaId === remembered.mediaId);
  const mediaSrc = videoMediaSrc(video);
  frames.forEach(frame => { frame.mediaSrc = mediaSrc; });
  videoFrameLists.set(video, [...frames].sort((one, other) => one.time - other.time));
  videoFrames.set(video, remembered);
  if (remembered.settings) {
    video.setAttribute('data-img2img-settings', remembered.settings);
  }
  showResult(video, remembered.result, resultNames.get(remembered.result));
  addDownloadButton(video);
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

const printText = print => btoa(String.fromCharCode(...print));

function printBytes(text) {
  try {
    return Uint8Array.from(atob(text), character => character.charCodeAt(0));
  } catch (error) {
    return null;
  }
}

// A processed moment, kept for later pages. Its thumbnail goes with it as a second way to recognise the media
// (see restoreFromTheCache), and so does the host, since the same picture on another site is another site's.
async function keepFrameAcrossPages(frame, name) {
  if (!frame.hash || (!frame.media && !frame.fingerprint)) return;
  const moment = {
    media: frame.media || '',
    length: frame.length || 0,
    print: frame.fingerprint ? printText(frame.fingerprint) : '',
    host: location.hostname,
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
async function forgetKeptFrame(hash) {
  const kept = (await keptFrames()).filter(moment => moment.hash !== hash);
  keptFramesRead = Promise.resolve(kept);
  chrome.storage.local.set({ [FRAME_INDEX_KEY]: kept });
}

// A kept moment as one of a video's frames: the picture it was made from isn't kept (only its thumbnail), and the
// result itself waits in the cache until this frame goes on show
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
    result: null,
    settings: moment.settings,
    hash: moment.hash,
  };
}

// Swap Cache on a video: the moments kept for the media it is playing come back, the newest of them on show.
// The media is recognised by its name, which costs nothing; only where that can't be had (no URL, and a page
// whose address the player doesn't keep) does it come down to the frame on screen, which answers for media that
// stays on one picture - a story with a song - and not for a video that moves.
const restoringFromCache = new WeakSet();
const unrecognisedMedia = new WeakSet(); // videos already said to have no processed moment

async function restoreFromTheCache(video) {
  if (restoringFromCache.has(video) || videoFrames.has(video)) return;
  const kept = await keptFrames();
  if (kept.length === 0) return; // nothing has ever been processed: this costs a page with videos nothing
  const media = mediaKeyOf(video);
  let moments = kept.filter(moment => sameMedia(moment, video));
  if (moments.length === 0) {
    if (!videoSettled(video)) return;
    const fingerprint = frameFingerprint(video);
    const seen = fingerprint && kept.find(moment =>
      moment.host === location.hostname && fingerprintsMatch(printBytes(moment.print), fingerprint));
    if (!seen) {
      // Said once per video, since there's nothing on the page to show why a result didn't come back
      if (!unrecognisedMedia.has(video)) {
        unrecognisedMedia.add(video);
        console.debug('img2img: no processed moment for this video.', {
          media, length: mediaLength(video),
          kept: kept.map(moment => ({ media: moment.media, length: moment.length })),
          readAFrame: Boolean(fingerprint),
        });
      }
      return;
    }
    moments = kept.filter(moment => moment.media === seen.media && moment.media);
    if (moments.length === 0) moments = [seen];
  }
  restoringFromCache.add(video);
  try {
    const newest = moments[0]; // kept newest first
    const result = await getFromCache(newest.hash, null);
    if (!result) {
      // The cache no longer holds it: cleared, or past the age results are kept for
      console.debug('img2img: the result for a processed moment is no longer in the cache', newest.hash);
      await forgetKeptFrame(newest.hash);
      return;
    }
    if (videoFrames.has(video) || !video.isConnected) {
      console.debug('img2img: the video was processed or left while its result was read');
      return;
    }
    const mediaId = ++nextMediaId;
    const frames = moments.map(moment => frameFromKept(moment, video, mediaId));
    const shown = frames[0];
    shown.result = result;
    videoFrameLists.set(video, [...frames].sort((one, other) => one.time - other.time));
    videoFrames.set(video, shown);
    if (newest.settings) {
      video.setAttribute('data-img2img-settings', newest.settings);
    }
    showResult(video, result, newest.name || undefined);
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
// are looked at until its picture is recognised, or there are no tries left.
const watchedForRestore = new WeakSet();

function watchForRestore(video) {
  if ((videoResults.length === 0 && !swapCacheOn) || watchedForRestore.has(video)) return;
  watchedForRestore.add(video);
  let tries = RESTORE_TRIES;
  const attempt = () => {
    if (!video.isConnected || shownOverVideo.has(video) || (videoResults.length === 0 && !swapCacheOn) || tries-- <= 0) {
      ['loadedmetadata', 'loadeddata', 'timeupdate'].forEach(name => video.removeEventListener(name, attempt));
      watchedForRestore.delete(video);
      return;
    }
    restoreVideo(video);
  };
  // Metadata is enough to name the media, which is all a lookup needs; the frames are only for the media that
  // has no name of its own (see restoreFromTheCache)
  ['loadedmetadata', 'loadeddata', 'timeupdate'].forEach(name => video.addEventListener(name, attempt));
  attempt();
}

// An element's shadow root, also a closed one (which extensions may open). Chrome's chrome.dom.openOrClosedShadowRoot
// throws for some elements (seen in Edge on a plain page's elements), which counts as no shadow root. It only takes an
// HTMLElement (SVG and MathML elements can't have a shadow root anyway), so those aren't asked.
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
  return allOfTag('img');
}

// The same for the page's videos (Swap Cache looks at those too)
function allVideos() {
  allImages(); // (the shadow roots are looked up there, at most once a second)
  return allOfTag('video');
}

// img2img's own are left out: the result over a video is an <img> of the page's own size (see showOverVideo), so
// Automatic Selection would pick it up and process a result, and the spinner's mark is an <img> too
function allOfTag(tag) {
  return [document, ...shadowRootsCache.roots]
    .flatMap(root => Array.from(root.querySelectorAll(tag)))
    .filter(element => !element.closest(OWN_ELEMENTS));
}

// An image just inside an element that lets the pointer through (pointer-events: none), so elementsFromPoint never
// finds it, when it's at the point
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

function isPageControl(element) {
  const named = element.matches?.(CONTROL_ROLES)
    || (element.tagName === 'svg' && (element.hasAttribute('aria-label') || element.querySelector('title')));
  if (!named) return false;
  const rect = element.getBoundingClientRect();
  return rect.width <= CONTROL_MAX_SIDE && rect.height <= CONTROL_MAX_SIDE;
}
const OWN_ELEMENTS = '.img2img-download, .img2img-revert, .img2img-compare, .img2img-results, .img2img-spinner, .img2img-frame, #img2img-error-toast';

// The image seen at a point of the window. Some sites lay an empty element over their images to catch
// clicks, so it looks through the elements there (topmost first, skipping img2img's own) until it reaches an image,
// or something with its own text or a control, which is what's seen instead. Empty elements on top only count as
// the image's overlay when they're near it in the page: a modal's backdrop comes from elsewhere and hides the image.
// With backgrounds, an element showing a picture as its CSS background counts as an image too, and with videos,
// a video counts as the frame it shows (Manual Selection processes that).
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
  const img = imageAt(e.clientX, e.clientY, { backgrounds: true, videos: true });
  return img && !isProcessedAlready(img) ? img : null;
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

// The right-click menu's "img2img: <workflow>" item (background.js builds it): the image that was right-clicked
// is processed with the workflow chosen in the popup, without turning Manual Selection on.
//
// Where the pointer was is kept here, because the menu only passes the image's URL: the position names the right
// image when several on the page share a URL, finds lazy images and CSS backgrounds (which have no srcUrl of their
// own), and needs no matching at all. The URL is the fallback, for a page that moved under the open menu.
let lastRightClick = null;
const RIGHT_CLICK_KEPT_MS = 60 * 1000;
window.addEventListener('contextmenu', event => {
  lastRightClick = { x: event.clientX, y: event.clientY, time: Date.now() };
}, true);

// Every URL an element's image can be known by (what the menu's srcUrl is compared against)
function imageUrlsOf(element) {
  return [element.currentSrc, element.src, element.getAttribute('data-original-src'), lazySourceUrl(element)].filter(Boolean);
}

function rightClickedImage(srcUrl) {
  const fresh = lastRightClick && Date.now() - lastRightClick.time < RIGHT_CLICK_KEPT_MS;
  const atPointer = fresh ? imageAt(lastRightClick.x, lastRightClick.y, { backgrounds: true }) : null;
  if (atPointer && (atPointer.tagName !== 'IMG' || !srcUrl || imageUrlsOf(atPointer).includes(srcUrl))) return atPointer;
  return (srcUrl && allImages().find(img => imageUrlsOf(img).includes(srcUrl))) || atPointer;
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
  img.setAttribute('data-img2img-settings', settingsHash);
  selectedImage = img;
  await swapImage(img);
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
    settingsString = JSON.stringify({ ...customWorkflowCacheKey(settings.customWorkflow, settings.customWorkflowValues, selectedSourceId), comfyServerAddress: settings.comfyServerAddress || 'http://127.0.0.1:8188' });
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

// Local mode builds the shared workflows (shared/workflows.js: SHARED_WORKFLOWS).

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
// image or the result, and a button that compares the two side by side in a new tab. One animation-frame loop
// keeps them all pinned to their image's top-right corner.
const downloadButtons = new Map();
const revertButtons = new Map();
const compareButtons = new Map();
// Images toggled back to their original, with the result to switch back to
const revertedResults = new Map();
const DOWNLOAD_BUTTON_SIZE = 32;
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
// which reaches 8px below the image's top for four rows and can pass the bottom edge of a short image
const ICON_COLUMN_ROWS = 4; // download, revert, compare, and the result dropdown under them
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
  compareButtons.set(imgElement, createOverlayButton(imgElement, 'img2img-compare', 'Compare with the original, side by side', COMPARE_ICON, () => compareWithOriginal(imgElement)));
  refreshResultSelect(imgElement);
  loadGenerations(imgElement);
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
    // A video's original is the frame that was processed, which is here already
    const frame = videoFrames.get(imgElement);
    const original = frame
      ? frame.dataUrl
      : await blobToDataUrl(await fetchImageBlob(imgElement.getAttribute('data-original-src')));
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
  // A video's original is the video itself, which the overlay stops covering
  button.title = reverted ? 'Show processed image' : (imgElement.tagName === 'VIDEO' ? 'Show the video' : 'Show original image');
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
function createOverlayButton(imgElement, className, title, icon, onClick) {
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

// The cache keeps every result an image has ever had (see addToCache in background.js) and shows the newest, so
// the dropdown offers the rest: a result the user picks is fetched by its own cache key. Listed per image when
// its result goes up, which is a lookup by URL in the background and no pictures over the wire.
const generations = new WeakMap(); // image -> its cached results, newest first: { hash, timestamp, name, label }
const shownGeneration = new WeakMap(); // image -> the cache key of the result it shows
const LISTED_GENERATIONS = 20;

async function loadGenerations(imgElement) {
  if (imgElement.tagName === 'VIDEO') return; // a video's results are its frames (see resultChoicesOf)
  try {
    const response = await chrome.runtime.sendMessage({ action: 'listResults', imageUrl: getSourceUrl(imgElement) });
    if (!response?.success || !imgElement.isConnected) return;
    const results = labelGenerations(response.results.slice(0, LISTED_GENERATIONS));
    generations.set(imgElement, results);
    // The newest is the one the cache shows, unless the user has picked another one already
    if (!results.some(entry => entry.hash === shownGeneration.get(imgElement))) {
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

// Whether something else (a modal, a menu) covers an image's visible part, checked where its buttons (or the
// spinner, at the top left) go and at its centre: they're on top of everything, so they'd show through
function isCovered(imgElement, rect, { topLeft = false } = {}) {
  const left = rect.right - rect.width;
  const markPoint = topLeft
    ? [left + 10 + SPINNER_SIZE / 2, rect.top + 10 + SPINNER_SIZE / 2]
    : [rect.right - 8 - DOWNLOAD_BUTTON_SIZE / 2, rect.top + 8 + DOWNLOAD_BUTTON_SIZE / 2];
  const centre = [rect.right - rect.width / 2, rect.top + rect.height / 2];
  const options = { backgrounds: !['IMG', 'VIDEO'].includes(imgElement.tagName), videos: imgElement.tagName === 'VIDEO' };
  return imageAt(...markPoint, options) !== imgElement && imageAt(...centre, options) !== imgElement;
}

function positionDownloadButtons() {
  for (const [imgElement, button] of downloadButtons) {
    const revertButton = revertButtons.get(imgElement);
    const compareButton = compareButtons.get(imgElement);
    if (!imgElement.isConnected) {
      button.remove();
      revertButton.remove();
      compareButton.remove();
      resultSelects.get(imgElement)?.remove();
      downloadButtons.delete(imgElement);
      revertButtons.delete(imgElement);
      compareButtons.delete(imgElement);
      resultSelects.delete(imgElement);
      revertedResults.delete(imgElement);
      continue;
    }
    // Only while the image still shows our result or its toggled-back original (sites may swap src back),
    // and enough of it is on screen. The download button only shows with the result.
    const src = imageSrc(imgElement);
    const showsOriginal = revertedResults.has(imgElement) && src === imgElement.getAttribute('data-original-src');
    const showsResult = !showsOriginal && src.startsWith('data:');
    const rect = (showsResult || showsOriginal) ? visibleRect(imgElement) : null;
    const visible = Boolean(rect) && rect.width >= 64 && rect.height >= 64 && !isCovered(imgElement, rect)
      && (!iconsOnHover || pointerOverIcons(imgElement, rect));
    // (inline display would override the hidden attribute)
    button.style.display = visible && showsResult ? 'flex' : 'none';
    revertButton.style.display = visible ? 'flex' : 'none';
    compareButton.style.display = visible ? 'flex' : 'none';
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
      if (picking) {
        // Lined up with the buttons from the left, by its own width: a fixed element's right is measured from
        // the viewport's edge, which on a page with a scrollbar falls short of window.innerWidth, and the
        // dropdown then sat a scrollbar's width to the left of them
        select.style.top = `${rect.top + 8 + 3 * (DOWNLOAD_BUTTON_SIZE + 6)}px`;
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
  colorize: 'Colourised',
  cleanup: 'Cleaned up',
  sticker: 'Sticker',
  idPhoto: 'ID photo',
  faceBlur: 'Faces blurred',
  filter: 'Filter',
  transform: 'Transformed',
  segment: 'Cut out',
};

// Base name for downloads: "<start of the page title>-<workflow>-<source name>". Page titles can be long, so only
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
  let sourceName = '';
  try {
    const settings = processedWith || await getSettings();
    const workflow = effectiveWorkflow(settings);
    workflowName = clean(isCustomWorkflow(workflow) ? settings.customWorkflow?.name : WORKFLOW_FILE_NAMES[workflow]);
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
  const { filenamePattern } = await chrome.storage.local.get('filenamePattern');
  const name = fillFilenamePattern(filenamePattern, {
    '{title}': title,
    '{workflow}': workflowName,
    '{source}': sourceName,
    '{host}': clean(location.hostname),
    '{date}': `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    '{time}': `${pad(now.getHours())}-${pad(now.getMinutes())}`,
  });
  return name || title || location.hostname || 'image';
}

// The "File Name" setting's tokens, filled in with what this page knows. A token with nothing behind it (no source
// for this workflow, say) leaves no gap or stray dash; one that isn't a token of ours is left as it was typed.
// -img2img and the extension are added by whoever downloads the result.
const DEFAULT_FILENAME_PATTERN = '{title}-{workflow}-{source}';

// Same function in settings.js, which shows an example of the name
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
  img.setAttribute('data-original-src', img.src);
  img.src = result;
  addDownloadButton(img);
}

// Save the swapped image as "<page title>-<workflow>-<source name>-img2img.<ext>"
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
// setProgress(percent) draws a ring around it (jobs on the user's ComfyUI report their progress), setEstimate(ms)
// fills the ring over the time a hosted job should take, with the seconds left under it, and setWaiting(ahead) greys
// it out while the image waits its turn to go to the server (see waitingJobs). Like the image's buttons, it hides
// while a modal or menu covers the image. Some sites rebuild their images (a carousel's
// slide swiped away and back): the spinner then moves to the image that shows up with the same picture, and
// its image() is where the result goes.
const SPINNER_SIZE = 44;
function showSpinner(imgElement) {
  const spinner = document.createElement('div');
  spinner.className = 'img2img-spinner';
  const src = imageSrc(imgElement);
  let image = imgElement;
  let lastSearch = 0;
  const lost = () => !image.isConnected || imageSrc(image) !== src;
  spinner.image = () => image;
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
  spinner.setEstimate = ms => {
    estimate = { ms, start: performance.now() };
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
  // under it; 0 is its turn
  spinner.setWaiting = ahead => {
    mark.style.filter = ahead ? 'grayscale(1)' : '';
    mark.style.opacity = ahead ? '0.6' : '';
    label.style.display = ahead ? 'block' : 'none';
    label.textContent = `${ahead} ahead`;
  };

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
  document.documentElement.appendChild(spinner);

  const followImage = () => {
    if (!spinner.isConnected) {
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
    spinner.style.top = `${rect.top + 10}px`;
    spinner.style.left = `${rect.left + 10}px`;
    if (estimate) {
      showEstimate();
    }
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
    // A video's original is the video itself, whichever of its frames is on show
    imgElement.setAttribute('data-original-src', imgElement.tagName === 'VIDEO'
      ? VIDEO_ITSELF
      : lazySourceUrl(imgElement) || imageSrc(imgElement));
    keepLayoutSize(imgElement);
  }
  if (imgElement.tagName === 'IMG') {
    imgElement.removeAttribute('srcset');
    imgElement.removeAttribute('sizes');
    if (imgElement.parentElement?.tagName === 'PICTURE') {
      imgElement.parentElement.querySelectorAll('source').forEach(source => source.removeAttribute('srcset'));
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

function lazySourceUrl(imgElement) {
  if (imgElement.tagName !== 'IMG' || imgElement.hasAttribute('data-original-src')) return '';
  const placeholder = !imgElement.src || imgElement.src.startsWith('data:') || (imgElement.complete && imgElement.naturalWidth <= 2);
  const lazy = placeholder && LAZY_SOURCE_ATTRIBUTES.map(name => imgElement.getAttribute(name)).find(value => value?.trim());
  return lazy ? new URL(lazy.trim(), document.baseURI).href : '';
}

// The URL whose image gets processed, which is also the cache's image URL key
function getSourceUrl(imgElement) {
  const frame = videoFrames.get(imgElement);
  if (frame) return frame.url; // a video: its frame, which was taken from the page rather than downloaded
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
  if (await isSvgBlob(blob)) return svgToPng(blob);
  return (await isProcessableBitmap(blob)) ? blob : bitmapToPng(blob);
}

// What the content script can't load itself, fetched by background.js (which isn't subject to the page's CORS
// rules) and sent back as a data URL
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
  return canvasToPng(canvas);
}

// A canvas as a PNG. Reading one that another site's video or image was drawn into throws a SecurityError (the
// canvas is "tainted"), which the video frames have a way around (see frameFromReloadedMedia).
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
  // Get the image data (a video's frame is already here, taken from the page itself)
  const frame = videoFrames.get(imgElement);
  const imageUrl = frame ? frame.url : getSourceUrl(imgElement);
  const imageBlob = frame ? frame.blob : await fetchImageBlob(imageUrl);
  const base64Image = await blobToBase64(imageBlob);
  const imageSize = await getBlobSize(imageBlob, imgElement);

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
// a waiting image clicked again in Manual Selection takes its job back, and Stop Processing takes back Automatic
// Selection's.
const waitingJobs = new Map(); // spinner -> { drop(), auto }

async function swapImage(imgElement, { auto = false } = {}) {
  let imageUpdated = false;
  const spinner = showSpinner(imgElement);
  swapsInProgress++;
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
    
    // Check cache first
    const cachedResult = await getFromCache(imageHash, imageUrl);
    if (cachedResult) {
      // The newest result of this image and these settings, whichever of them was on show before
      shownGeneration.delete(imgElement);
      showResult(imgElement, cachedResult, name);
      imageUpdated = true;
      addDownloadButton(imgElement);
      openResultInNewTab(settings, imageHash, imageUrl, name);
      return;
    }

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

    // Off to background.js's queue. (Stop Processing meanwhile: Automatic Selection's image goes back to the page as
    // it was.)
    if (auto && !isContinuousProcessing) {
      throw Object.assign(new Error('Processing stopped'), { dropped: true });
    }
    const callbacks = {
      onProgress: spinner.setProgress,
      onEstimate: spinner.setEstimate,
      onWaiting: (ahead, drop) => {
        spinner.setWaiting(ahead);
        if (ahead) {
          waitingJobs.set(spinner, { drop, auto });
        } else {
          waitingJobs.delete(spinner);
        }
      },
    };
    const result = processesOnServer(settings)
      ? await processOnServer(source.dataUrls, base64Image, settings, imageHash, imageUrl, name, callbacks)
      : await processOnComfyUI(base64Image, settings, imageSize, imageHash, imageUrl, name, callbacks);

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
    }
    showResult(target, result.data, name);
    imageUpdated = true;
    addDownloadButton(target);
    if (isResultTab) {
      // The image's earlier results stay cached, so the marker would bring the old one back on a reload
      history.replaceState(null, '', location.href.replace(/img2img-result=[^&]*/, `img2img-result=${encodeURIComponent(imageHash)}`));
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
      showPageError(error.message === 'Failed to fetch' ? await unreachableServerMessage() : error.message);
    }
  } finally {
    waitingJobs.delete(spinner);
    spinner.remove();
    swapsInProgress--;
  }
}

// Local processing: build the workflow here; background.js runs it on the user's own ComfyUI
async function processOnComfyUI(base64Image, settings, imageSize, hash, imageUrl, name, callbacks) {
  const workflow = await buildWorkflow(base64Image, settings, imageSize);
  // The NSFW checks' probes, read before the result is shown
  const probes = safetyProbes(workflow).map(probe => ({ ...probe, refusal: nsfwRefusal(probe.label) }));
  return runJob({ kind: 'comfy', workflow, probes, output: resultNode(workflow), hash, imageUrl, name }, callbacks);
}

// Hosted processing: the img2img server builds the workflow from the settings, runs it and keeps
// the result until background.js collects it. The server measures the image itself and ignores settings it doesn't know.

// Images go to the img2img server unless the user chose their own ComfyUI (Processing: My ComfyUI)
function processesOnServer(settings) {
  return settings.processingMode !== 'local';
}

// Within the API's limits (shared/workflows.js HOSTED_MAX_*): a new background needs only its source's first image,
// and an image that's too large is shrunk to fit rather than refused (shared/images.js)
async function processOnServer(sourceImages, base64Image, settings, hash, imageUrl, name, callbacks) {
  const sources = SWAP_WORKFLOWS.includes(effectiveWorkflow(settings)) ? sourceImages.slice(0, HOSTED_MAX_SOURCE_IMAGES) : sourceImages.slice(0, 1);
  const body = {
    workflow: settings.workflow,
    settings,
    image: await fitImage(base64Image, { maxBytes: HOSTED_MAX_TARGET_BYTES }),
    sourceImages: await Promise.all(sources.map(source => fitImage(source, { maxBytes: HOSTED_MAX_SOURCE_BYTES }))),
  };
  return runJob({ kind: 'server', body, hash, imageUrl, name }, callbacks);
}

// Hand a job to background.js, which queues it (one job goes to the server at a time, see its jobsAtOnce), runs it to
// the end (see its JOB_PORT) and answers { data }: the result. On the way it sends { ahead } while the job waits its
// turn (how many jobs are ahead, 0 once it starts), passed to onWaiting with a function that takes the job back out of
// the queue (the job then fails with a dropped error); for jobs on the user's ComfyUI, { progress } as it goes (a
// percentage, passed to onProgress); for hosted jobs, { estimate } once accepted (how many ms the server expects the
// job to take, passed to onEstimate). The port closes with the page, which tells background.js to drop the page's
// waiting jobs and cancel its running ones (or to finish them all and open the results in new tabs or download them,
// when those settings are on).
let jobPort = null;
let nextJobId = 0;
const pendingJobs = new Map();

async function runJob(job, { onProgress, onEstimate, onWaiting } = {}) {
  job.name ??= await resultBaseName();
  job.isImagePage = isImagePage();
  if (!jobPort) {
    jobPort = chrome.runtime.connect({ name: 'img2img-jobs' });
    jobPort.onMessage.addListener(({ id, data, key, error, dropped, progress, estimate, ahead }) => {
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
        pending.reject(Object.assign(new Error(error), dropped ? { dropped: true } : {}));
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
async function blobToBase64(blob) {
  return (await blobToDataUrl(blob)).split(',')[1];
}

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
  const unloadedUrl = lazySourceUrl(img) || (img.complete ? '' : img.src);
  const size = unloadedUrl ? probedSize(unloadedUrl) : { width: img.naturalWidth, height: img.naturalHeight };
  return Boolean(size) && size.width >= minImageSide && size.height >= minImageSide;
}

// The settings the content script reads
const SETTING_KEYS = ['selectedSourceId', 'comfyServerAddress', 'workflow', 'siteWorkflows', 'controlnetPreprocessor', 'controlnetResolution', 'controlnetOptions', 'upscaleModel', 'upscaleScale', 'backgroundMode', 'backgroundColor', 'backgroundColor2', 'backgroundBlur', 'restoreModel', 'restoreStrength', 'restoreFidelity', 'colorizeStrength', 'cleanupMode', 'stickerOutline', 'stickerColor', 'stickerShadow', 'idPhotoSize', 'idPhotoBackground', 'faceBlurStyle', 'faceBlurStrength', 'filterStyle', 'filterStrength', 'transformPreset', 'transformVariation', 'segmentPrompt', 'segmentThreshold', 'segmentOutput', 'processingMode', 'openResultsInNewTab', 'customWorkflows', 'customWorkflowValues', 'termsAgreedVersion'];

async function getSettings() {
  return new Promise(resolve => {
    chrome.storage.local.get(SETTING_KEYS, settings => {
      // A site with a workflow rule of its own uses that instead of the popup's choice (the popup says so, and the
      // rules are on the settings page). It goes through the same replacements, so an old name still works.
      const chosen = img2imgSites.workflowFor(settings.siteWorkflows, location.href) || settings.workflow;
      delete settings.siteWorkflows; // (the rules themselves are nobody else's business: only the workflow matters)
      settings.workflow = WORKFLOW_REPLACEMENTS[chosen] || chosen || DEFAULT_WORKFLOW;
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

  // Every image of the page, not only those in view; hidden ones (no size on the page) are left alone
  let nextImage = null;
  let nearest = Infinity;
  for (const img of images) {
    if (img.getAttribute('data-img2img-settings') === settingsHash || !(img.src || lazySourceUrl(img))) continue;
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
  return allImages().filter(img => {
    if (img.getAttribute('data-img2img-settings') === hash || !(img.src || lazySourceUrl(img))) return false;
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
