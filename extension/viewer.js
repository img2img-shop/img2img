// Shows a converted image from the result cache: viewer.html?hash=<cache hash>&name=<download base name>
document.body.append(img2imgTheme.button('theme-toggle'));

const params = new URLSearchParams(location.search);
const name = params.get('name') || 'image';
document.title = `${name} - img2img`;

chrome.runtime.sendMessage({ action: 'getFromCache', hash: params.get('hash') }, response => {
  if (response?.success && response.result) {
    const img = document.getElementById('result');
    img.src = response.result;
    img.hidden = false;

    // Download button, saved as "<page title>-<workflow>-<face name>-img2img.<ext>" like the on-page button, through
    // background.js. Always available here, also for results downloaded before.
    const download = document.getElementById('download');
    download.hidden = false;
    download.addEventListener('click', () => {
      const mimeType = response.result.match(/^data:([^;,]+)/)?.[1] || 'image/png';
      const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
      const baseName = name.replace(/[\\/:*?"<>|]/g, '_') || 'image';
      chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl: response.result, filename: `${baseName}-img2img.${extension}` });
    });
  } else {
    const message = document.getElementById('message');
    message.textContent = 'This image is no longer in the img2img cache.';
    message.hidden = false;
  }
});
