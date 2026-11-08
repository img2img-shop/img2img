// Shows a processed image next to its original: compare.html?id=<comparison id>&name=<page name>. The two
// images come from background.js, which holds them for the tab (opened by the compare button on the page).
document.body.append(img2imgTheme.button('theme-toggle'));

const params = new URLSearchParams(location.search);
const name = params.get('name') || 'image';
document.title = `${name} - img2img comparison`;

// Fingerprint of a result image, used to remember which results were downloaded (same as background.js)
function resultKey(dataUrl) {
  let hash = 5381;
  for (let i = 0; i < dataUrl.length; i++) {
    hash = ((hash << 5) + hash + dataUrl.charCodeAt(i)) | 0;
  }
  return `${dataUrl.length.toString(36)}-${(hash >>> 0).toString(36)}`;
}

// The processed image's download, named "<page title>-<workflow>-<source>-img2img.<ext>" like the other download buttons;
// greyed out once it's been downloaded
function offerDownload(result) {
  const download = document.getElementById('download');
  const key = resultKey(result);
  const refreshState = downloadedResults => {
    download.disabled = downloadedResults.includes(key);
    download.title = download.disabled ? 'Already downloaded' : 'Download processed image';
  };
  chrome.storage.local.get('downloadedResults', ({ downloadedResults = [] }) => refreshState(downloadedResults));
  chrome.storage.onChanged.addListener(changes => {
    if (changes.downloadedResults) refreshState(changes.downloadedResults.newValue || []);
  });
  download.addEventListener('click', () => {
    const mimeType = result.match(/^data:([^;,]+)/)?.[1] || 'image/png';
    const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
    chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl: result, filename: `${name}-img2img.${extension}` });
  });
}

// The composed picture's longest side, so a pair of large images still makes a picture the browser can save
const MAX_SIDE_BY_SIDE = 6000;

// The two images in one picture: side by side, each scaled to the taller one's height (so a small original is
// enlarged next to an upscale, as it is on screen), with the same captions underneath on the page's own
// background. Returns a PNG data URL.
function composeSideBySide(originalImg, resultImg) {
  const styles = getComputedStyle(document.documentElement);
  const colour = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
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
    // The caption, centred under its own image: the label in bold and the size beside it, as in the page
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

// The comparison's own download, next to the theme toggle: available once both images have loaded, since the
// picture is drawn from them
function offerSideBySide(originalImg, resultImg) {
  const button = document.getElementById('downloadBoth');
  const reveal = () => {
    if (originalImg.naturalWidth && resultImg.naturalWidth) button.hidden = false;
  };
  originalImg.addEventListener('load', reveal);
  resultImg.addEventListener('load', reveal);
  reveal();
  button.addEventListener('click', () => {
    button.disabled = true;
    let dataUrl;
    try {
      dataUrl = composeSideBySide(originalImg, resultImg);
    } catch (error) {
      button.disabled = false;
      showMessage(`The comparison picture couldn't be drawn: ${error.message}`);
      return;
    }
    chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl, filename: `${name}-img2img-comparison.png` }, response => {
      button.disabled = false;
      const error = chrome.runtime.lastError?.message || (response?.success ? null : response?.error);
      if (error) showMessage(`The comparison picture couldn't be saved: ${error}`);
    });
  });
}

// Each image as large as fits its half, keeping its shape (enlarged if it's small), with its caption as wide as it
function fit(img) {
  if (!img.naturalWidth || !img.naturalHeight) return;
  const frame = img.parentElement;
  const scale = Math.min(frame.clientWidth / img.naturalWidth, frame.clientHeight / img.naturalHeight);
  const width = Math.max(1, Math.floor(img.naturalWidth * scale));
  img.style.width = `${width}px`;
  img.style.height = `${Math.max(1, Math.floor(img.naturalHeight * scale))}px`;
  frame.nextElementSibling.style.width = `${width}px`;
}

// A message under the comparison, for a download that didn't happen (the page's own text when there are no images)
function showMessage(text) {
  const message = document.getElementById('message');
  message.textContent = text;
  message.hidden = false;
}

function show(id, src) {
  const img = document.getElementById(id);
  img.addEventListener('load', () => {
    document.getElementById(`${id}Size`).textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    fit(img);
  });
  new ResizeObserver(() => fit(img)).observe(img.parentElement);
  img.src = src;
  return img;
}

chrome.runtime.sendMessage({ action: 'getCompareImages', id: params.get('id') }, response => {
  if (response?.success) {
    const original = show('original', response.original);
    const result = show('result', response.result);
    offerDownload(response.result);
    offerSideBySide(original, result);
    document.getElementById('compare').hidden = false;
  } else {
    showMessage('This comparison is no longer available. Click the compare button on the image again.');
  }
});
