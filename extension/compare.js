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

function show(id, src) {
  const img = document.getElementById(id);
  img.addEventListener('load', () => {
    document.getElementById(`${id}Size`).textContent = `${img.naturalWidth} × ${img.naturalHeight}`;
    fit(img);
  });
  new ResizeObserver(() => fit(img)).observe(img.parentElement);
  img.src = src;
}

chrome.runtime.sendMessage({ action: 'getCompareImages', id: params.get('id') }, response => {
  if (response?.success) {
    show('original', response.original);
    show('result', response.result);
    offerDownload(response.result);
    document.getElementById('compare').hidden = false;
  } else {
    const message = document.getElementById('message');
    message.textContent = 'This comparison is no longer available. Click the compare button on the image again.';
    message.hidden = false;
  }
});
