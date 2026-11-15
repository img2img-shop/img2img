// Shrinking images to fit: source images as they're added in the popup, and anything over the hosted limits
// (shared/workflows.js HOSTED_MAX_*) before a hosted job sends it. For pages with a DOM: the popup, the content
// scripts and the extension's own pages.

// The longest side a source image is kept at: plenty for a portrait, and a new background is resized to the image it
// goes behind
const SOURCE_MAX_SIDE = 2048;

// The delete question's box for the files a result was downloaded as: ticked or not as it was last left, on whichever
// page asks (a web page, a result tab, the Library, the cache page). Unticked to begin with.
const DELETE_FILE_SETTING = 'deleteFileToo';

// Used by: web pages, the result tab, the Library, the cache page.
async function deleteFileRemembered() {
  try {
    const stored = await chrome.storage.local.get(DELETE_FILE_SETTING);
    return stored?.[DELETE_FILE_SETTING] === true;
  } catch {
    return false;
  }
}

// Used by: web pages, the result tab, the Library, the cache page.
function rememberDeleteFile(checked) {
  Promise.resolve(chrome.storage.local.set({ [DELETE_FILE_SETTING]: checked === true })).catch(() => {});
}

// How many bytes a data URL (or plain base64) decodes to, without decoding it
// Used by: web pages, the result tab, the Library, the popup.
function base64Bytes(image) {
  const base64 = image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
  return Math.floor(base64.length * 3 / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0);
}

// A picture drawn small, for a thumbnail: on a canvas no longer than maxSide on its longer side and no taller than
// maxHeight, never larger than the picture itself. source is anything a canvas draws (an image, a bitmap, a video);
// width and height are its own. The caller keeps the canvas in the form it needs (see THUMBNAIL_FORMAT).
// Used by: the Library, the cache page.
function smallCanvas(source, width, height, { maxSide = Infinity, maxHeight = Infinity } = {}) {
  const scale = Math.min(1, maxSide / Math.max(width, height, 1), maxHeight / Math.max(height, 1));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return canvas;
}

// What a thumbnail is kept as: WebP (small, and it keeps transparency), at this quality
const THUMBNAIL_FORMAT = ['image/webp', 0.8];

// The image (a data URL, or plain base64) at most maxBytes, with its longest side at most maxSide, in the same form
// it came in. Returned as it is when it already fits. Otherwise it's re-encoded, as JPEG if it was one and as WebP
// (which keeps transparency) if not, and scaled down step by step until it fits. One that can't be decoded here
// (an SVG, say) is returned as it is, for the API to judge.
// Used by: web pages, the result tab, the Library, the popup.
async function fitImage(image, { maxBytes = Infinity, maxSide = Infinity } = {}) {
  const isDataUrl = image.startsWith('data:');
  const mimeType = isDataUrl ? image.slice(5, image.search(/[;,]/)) : '';
  const bytes = base64Bytes(image);
  if (bytes <= maxBytes && maxSide === Infinity) {
    return image;
  }
  let bitmap;
  try {
    const base64 = isDataUrl ? image.slice(image.indexOf(',') + 1) : image;
    bitmap = await createImageBitmap(new Blob([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], { type: mimeType }));
  } catch {
    return image;
  }
  try {
    const longest = Math.max(bitmap.width, bitmap.height);
    if (bytes <= maxBytes && longest <= maxSide) {
      return image;
    }
    const type = mimeType === 'image/jpeg' ? 'image/jpeg' : 'image/webp';
    let scale = Math.min(1, maxSide / longest);
    for (let attempt = 0; attempt < 8; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.92));
      if (!blob) {
        return image;
      }
      if (blob.size <= maxBytes) {
        const dataUrl = await new Promise((resolve, reject) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
        return isDataUrl ? dataUrl : dataUrl.slice(dataUrl.indexOf(',') + 1);
      }
      // The size goes with the area: aim a little under the limit
      scale *= Math.sqrt(maxBytes / blob.size) * 0.9;
    }
    return image;
  } finally {
    bitmap.close();
  }
}
