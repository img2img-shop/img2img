// Shows a converted image from the result cache: viewer.html?hash=<cache hash>&name=<download base name>
// &src=<the URL of the image it was made from>. viewer.html also runs content.js, so the popup's Manual
// Selection can process the result again (chaining workflows), and the buttons below share its icons, its
// image loading and its comparison tabs. Like the incognito result tabs, nothing is processed here
// automatically.
isResultTab = true;
document.body.append(img2imgTheme.button('theme-toggle'));

// "Show Icons on Hover" (All settings): with it on, this tab's buttons wait for the pointer to be over the image,
// as a processed image's icons do on a page. Followed while the tab is open, like every other setting.
const frame = document.getElementById('frame');
const showIconsOnHover = on => frame.classList.toggle('on-hover', on === true);
chrome.storage.local.get('resultIconsOnHover', ({ resultIconsOnHover }) => showIconsOnHover(resultIconsOnHover));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.resultIconsOnHover) showIconsOnHover(changes.resultIconsOnHover.newValue);
});

const params = new URLSearchParams(location.search);
const name = params.get('name') || 'image';
// (the start of further results' download names, see resultBaseName in content.js)
document.title = name;

// The image the result was made from, for the revert and compare buttons: fetched from its URL, through the
// background script when the site doesn't allow a direct fetch (fetchImageBlob, from content.js). Without it
// — no URL to load it from, or the site won't serve it again — the two buttons are left out and the result
// shows with its download button alone.
async function loadOriginal() {
  const src = params.get('src');
  if (!src || !/^https?:/i.test(src)) {
    return null;
  }
  try {
    const blob = await fetchImageBlob(src);
    return { blob, url: URL.createObjectURL(blob) };
  } catch (error) {
    console.debug("The original image couldn't be loaded, so this result has no revert and compare buttons:", error.message);
    return null;
  }
}

// Open the original and the result side by side in a new tab (compare.html), like the compare button on the
// page: the background script holds the two images for that tab, as data URLs.
async function openComparison(original, processedImage) {
  try {
    const originalDataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(original.blob);
    });
    const response = await chrome.runtime.sendMessage({ action: 'openCompareTab', original: originalDataUrl, result: processedImage, name });
    if (!response?.success) {
      throw new Error(response?.error || 'the comparison tab could not be opened');
    }
  } catch (error) {
    showPageError(`Couldn't compare: ${error.message}`);
  }
}

// Asks whether to delete, unless "Don't ask again" was ticked here or on the cache page (cacheDeleteNoConfirm in
// chrome.storage.local). Resolves true to delete.
const confirmDelete = document.getElementById('confirmDelete');
async function deleteConfirmed() {
  const { cacheDeleteNoConfirm } = await chrome.storage.local.get('cacheDeleteNoConfirm');
  if (cacheDeleteNoConfirm) return true;
  document.getElementById('dontAskDelete').checked = false;
  confirmDelete.returnValue = '';
  confirmDelete.showModal();
  await new Promise(resolve => confirmDelete.addEventListener('close', resolve, { once: true }));
  const confirmed = confirmDelete.returnValue === 'delete';
  if (confirmed && document.getElementById('dontAskDelete').checked) {
    chrome.storage.local.set({ cacheDeleteNoConfirm: true });
  }
  return confirmed;
}

chrome.runtime.sendMessage({ action: 'getFromCache', hash: params.get('hash') }, async response => {
  if (!response?.success || !response.result) {
    const message = document.getElementById('message');
    message.textContent = 'This image is no longer in the img2img cache.';
    message.hidden = false;
    return;
  }
  const processedImage = response.result;
  const img = document.getElementById('result');
  // As a blob: URL, so a result made from it doesn't carry the whole image as its image URL (the cache key)
  const resultUrl = URL.createObjectURL(await (await fetch(processedImage)).blob());
  img.src = resultUrl;
  img.hidden = false;

  // Download button, saved as "<page title>-<workflow>-<source name>-img2img.<ext>" like the on-page button, through
  // background.js. Always available here, also for results downloaded before.
  const download = document.getElementById('download');
  download.hidden = false; // (shown at once, rather than waiting for the original image below)
  download.addEventListener('click', () => {
    const mimeType = processedImage.match(/^data:([^;,]+)/)?.[1] || 'image/png';
    const extension = mimeType.split('/')[1] === 'jpeg' ? 'jpg' : mimeType.split('/')[1];
    const baseName = name.replace(/[\\/:*?"<>|]/g, '_') || 'image';
    chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl: processedImage, filename: `${baseName}-img2img.${extension}` });
  });

  // Delete this result from the cache, as on the cache page (also on the Delete key): the last of the buttons,
  // under the rest. What's left is the message the viewer shows for a result that isn't in the cache any more;
  // the tab can be closed, or the original image processed again from the page it came from.
  const remove = document.getElementById('delete');
  remove.hidden = false; // (shown at once too)
  let deleted = false;
  async function deleteResult() {
    if (deleted || confirmDelete.open || !(await deleteConfirmed())) return;
    const response = await chrome.runtime.sendMessage({ action: 'deleteFromCache', hash: params.get('hash') });
    if (!response?.success) {
      showPageError(`Couldn't delete it: ${response?.error || 'no answer'}`);
      return;
    }
    deleted = true;
    img.hidden = true;
    img.removeAttribute('src');
    URL.revokeObjectURL(resultUrl);
    for (const id of ['download', 'delete', 'revert', 'compare']) document.getElementById(id).hidden = true;
    const message = document.getElementById('message');
    message.textContent = 'Deleted from the img2img cache.';
    message.hidden = false;
  }
  remove.addEventListener('click', deleteResult);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Delete' || remove.hidden || confirmDelete.open || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    event.preventDefault();
    deleteResult();
  });

  // The toggle between the original image and the result, and the comparison, as on the page
  const revert = document.getElementById('revert');
  const compare = document.getElementById('compare');
  const original = await loadOriginal();
  frame.classList.toggle('no-original', !original);
  if (original) {
    revert.addEventListener('click', () => {
      img.src = img.src === original.url ? resultUrl : original.url;
    });
    setIcon(compare, COMPARE_ICON);
    compare.addEventListener('click', () => openComparison(original, processedImage));
  }

  // While a result made here is shown, content.js's own buttons are on the image (download, revert, compare),
  // so these three step aside; the download button is for the result, not the original.
  const updateButtons = () => {
    if (deleted) return;
    const showsResult = img.src === resultUrl;
    const showsOriginal = Boolean(original) && img.src === original.url;
    download.hidden = remove.hidden = !showsResult;
    revert.hidden = compare.hidden = !original || !(showsResult || showsOriginal);
    revert.title = showsOriginal ? 'Show processed image' : 'Show original image';
    setIcon(revert, showsOriginal ? RESULT_ICON : REVERT_ICON);
  };
  updateButtons();
  new MutationObserver(updateButtons).observe(img, { attributes: true, attributeFilter: ['src'] });
});
