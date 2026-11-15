// Shows a converted image from the result cache: viewer.html?hash=<cache hash>&name=<download base name>
// &src=<the URL of the image it was made from>. viewer.html also runs content.js, so the popup's Manual
// Selection can process the image again, and the buttons below share its icons, its image loading and its
// comparison, laid over the image. As on a page, processing a result again runs on its original (resultTabOriginal in
// content.js), and the new result joins the image's others in content.js's dropdown. Like the incognito result
// tabs, nothing is processed here automatically.
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

// The browser's zoom (Ctrl + wheel, Ctrl + plus and minus) zooms the image: it's fitted to the window at the
// browser's usual zoom, and --zoom tells the page how far it is from that (see img in viewer.html).
async function followZoom() {
  try {
    const tab = await chrome.tabs.getCurrent();
    const [zoom, settings] = await Promise.all([chrome.tabs.getZoom(tab.id), chrome.tabs.getZoomSettings(tab.id)]);
    document.documentElement.style.setProperty('--zoom', zoom / (settings.defaultZoomFactor || 1));
  } catch (error) {
    console.debug("The tab's zoom couldn't be read, so the image stays fitted to the window:", error.message);
  }
}
followZoom();
chrome.tabs.onZoomChange.addListener(followZoom);

const params = new URLSearchParams(location.search);
const name = params.get('name') || 'image';
// (the start of further results' download names, see resultBaseName in content.js)
document.title = name;

// The image the result was made from, for the revert and compare buttons: fetched from its URL, through the
// background script when the site doesn't allow a direct fetch (fetchImageBlob, from content.js). Without it
// — no URL to load it from, or the site won't serve it again — the two buttons are left out and the result
// shows with its download button alone.
async function loadOriginal() {
  // The original as the page read it, kept by background.js for this tab when the job was sent off: a video's
  // frame, a blob: image and an image a site won't serve twice have it here and nowhere else
  const kept = await chrome.runtime.sendMessage({ action: 'getOriginalImage', hash: params.get('hash') }).catch(() => null);
  if (kept?.original) {
    const blob = await (await fetch(kept.original)).blob();
    return { blob, url: URL.createObjectURL(blob) };
  }
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

// Asks whether to delete, unless "Don't ask again" was ticked here or on the cache page (cacheDeleteNoConfirm in
// chrome.storage.local). files are the files the result was downloaded as (downloadedFilesOf, from content.js):
// with any, the question is asked whatever was ticked, with a box for deleting them too. Resolves { deleteFiles }
// to delete, null to keep.
const confirmDelete = document.getElementById('confirmDelete');
async function deleteConfirmed(files = []) {
  const { cacheDeleteNoConfirm } = await chrome.storage.local.get('cacheDeleteNoConfirm');
  if (cacheDeleteNoConfirm && files.length === 0) return { deleteFiles: false };
  await offerFileDeletion(files);
  document.getElementById('dontAskDelete').checked = false;
  confirmDelete.returnValue = '';
  confirmDelete.showModal();
  await new Promise(resolve => confirmDelete.addEventListener('close', resolve, { once: true }));
  const confirmed = confirmDelete.returnValue === 'delete';
  if (confirmed && files.length === 0 && document.getElementById('dontAskDelete').checked) {
    chrome.storage.local.set({ cacheDeleteNoConfirm: true });
  }
  return confirmed ? { deleteFiles: files.length > 0 && document.getElementById('deleteFile').checked } : null;
}

// The dialog's row for the files the result was downloaded as: there, with their names, when there are any, in
// place of "Don't ask again" (which doesn't cover a file: that is asked about every time). Same in cache.js.
// The box is ticked or not as it was left the last time (deleteFileRemembered, from shared/images.js).
async function offerFileDeletion(files) {
  document.getElementById('deleteFileRow').hidden = files.length === 0;
  document.getElementById('dontAskRow').hidden = files.length > 0;
  document.getElementById('deleteFile').checked = files.length > 0 && await deleteFileRemembered();
  document.getElementById('deleteFileText').textContent = files.length > 0 ? fileDeletionText(files) : '';
}
document.getElementById('deleteFile').addEventListener('change', event => rememberDeleteFile(event.target.checked));

// The message takes the image's place: the empty frame goes, or the two would share the window and the text
// would sit to the right of the middle
function showMessage(text) {
  frame.hidden = true;
  const message = document.getElementById('message');
  message.textContent = text;
  message.hidden = false;
}

chrome.runtime.sendMessage({ action: 'getFromCache', hash: params.get('hash') }, async response => {
  if (!response?.success || !response.result) {
    showMessage('This image is no longer in the img2img cache.');
    return;
  }
  const processedImage = response.result;
  // The key the cache holds it under: a tab opened for a finished job carries the image's source hash, which names
  // its newest result, so the result is deleted by the key the cache answered with, and its downloads found by it
  const key = response.hash || params.get('hash');
  // (processing the original again with the same settings comes back to this result: no second tab for it)
  resultsShownHere.add(params.get('hash')).add(key);
  const img = document.getElementById('result');
  // As a blob: URL, so a result made from it doesn't carry the whole image as its image URL (the cache key)
  const resultUrl = URL.createObjectURL(await (await fetch(processedImage)).blob());
  img.src = resultUrl;
  img.hidden = false;

  // Download button, saved as "<page title>-<workflow>-<source name>-img2img.<ext>" like the on-page button, through
  // background.js. Always available here, also for results downloaded before. With Double Download on, the original
  // goes along (downloadOriginalToo, from content.js), read again from its URL as it is, in its own format.
  const download = document.getElementById('download');
  download.hidden = false; // (shown at once, rather than waiting for the original image below)
  download.addEventListener('click', async () => {
    const baseName = name.replace(/[\\/:*?"<>|]/g, '_') || 'image';
    const filename = `${baseName}-img2img.${resultExtension(processedImage)}`;
    const response = await chrome.runtime.sendMessage({ action: 'downloadImage', dataUrl: processedImage, filename });
    if (!response?.success) return;
    await downloadOriginalToo(filename, () => {
      const src = params.get('src');
      if (!src) throw new Error('this result has no image URL to load it from');
      return fetchImageBlob(src, { asIs: true });
    });
  });

  // Delete this result from the cache, as on the cache page (also on the Delete key), and the file it was downloaded
  // as with it if the box is ticked: the last of the buttons, under the rest. What's left is the original image, which
  // Manual Selection can process again here; without one, the message the viewer shows for a result that isn't in
  // the cache any more.
  const originalLoad = loadOriginal(); // (started here, so a delete straight away still finds it)
  const remove = document.getElementById('delete');
  remove.hidden = false; // (shown at once too)
  let deleted = false;
  let asking = false;
  async function deleteResult() {
    if (deleted || asking || confirmDelete.open) return;
    asking = true;
    let answer;
    try {
      answer = await deleteConfirmed(await downloadedFilesOf(key));
    } finally {
      asking = false;
    }
    if (!answer) return;
    const response = await chrome.runtime.sendMessage({ action: 'deleteFromCache', hash: key, deleteFiles: answer.deleteFiles });
    if (!response?.success) {
      showPageError(`Couldn't delete it: ${response?.error || 'no answer'}`);
      return;
    }
    if (response.fileError) {
      showPageError(`The downloaded file couldn't be deleted: ${response.fileError}`);
    }
    deleted = true;
    for (const id of ['download', 'delete', 'revert', 'compare', 'reprocess']) document.getElementById(id).hidden = true;
    const original = await originalLoad;
    if (original) {
      img.src = original.url;
    } else {
      img.hidden = true;
      img.removeAttribute('src');
    }
    URL.revokeObjectURL(resultUrl);
    if (!original) showMessage(response.filesDeleted ? 'Deleted from the img2img cache, with the file it was downloaded as.' : 'Deleted from the img2img cache.');
  }
  remove.addEventListener('click', deleteResult);
  document.addEventListener('keydown', event => {
    if (event.key !== 'Delete' || remove.hidden || confirmDelete.open || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    event.preventDefault();
    deleteResult();
  });
  // Up and Down step through the image's cached results, as the dropdown lists them (resultChoicesOf, from
  // content.js), stopping at the first and the last as the dropdown does. With the dropdown focused, its own keys
  // apply (it keeps its keys from the page); with one result there's nothing to step to.
  document.addEventListener('keydown', event => {
    if ((event.key !== 'ArrowUp' && event.key !== 'ArrowDown') || confirmDelete.open || event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target.tagName)) return;
    const choices = resultChoicesOf(img);
    if (choices.length < 2) return;
    event.preventDefault();
    const at = choices.findIndex(choice => choice.chosen);
    const next = event.key === 'ArrowDown'
      ? (at < 0 ? 0 : Math.min(at + 1, choices.length - 1))
      : (at < 0 ? choices.length - 1 : Math.max(at - 1, 0));
    if (next !== at) choices[next].show();
  });

  // The toggle between the original image and the result, and the comparison, as on the page
  const revert = document.getElementById('revert');
  const compare = document.getElementById('compare');
  const reprocess = document.getElementById('reprocess');
  const original = await originalLoad;
  frame.classList.toggle('no-original', !original);
  if (original) {
    // For a job on this result (see resultTabOriginal in content.js): cached under the URL this result is (the
    // image's results are listed together by it), else the original's; without either it can only go under the tab's own
    const src = params.get('src');
    resultTabOriginal = { image: img, url: original.url, imageUrl: response.imageUrl || (src && /^https?:/i.test(src) ? src : original.url), blob: original.blob };
    revert.addEventListener('click', () => {
      img.src = img.src === original.url ? resultUrl : original.url;
    });
    setIcon(compare, COMPARE_ICON);
    // Over the image, as on a page (toggleComparison, from content.js): the pair as this tab already holds it
    compare.addEventListener('click', () => toggleComparison(img, () => ({ original: original.url, result: resultUrl, name })));
    // Processing the original again, as an image's own button on a page does: a new seed each run brings a new
    // result, the same settings otherwise say so
    setIcon(reprocess, REPROCESS_ICON);
    reprocess.addEventListener('click', () => reprocessImage(img));
  }

  // Once a result made here goes on the image, content.js's own buttons are on it (download, revert, compare,
  // delete, and the dropdown between the image's results), so these step aside for good: content.js's revert shows
  // the original, its dropdown this result, and a second set over them would only repeat them. Before that, the
  // download button is for the result, not the original.
  let handedOver = false;
  const updateButtons = () => {
    if (deleted) return;
    handedOver = handedOver || downloadButtons.has(img) || img.hasAttribute('data-original-src');
    if (handedOver) {
      for (const button of [download, remove, revert, compare, reprocess]) button.hidden = true;
      return;
    }
    const showsResult = img.src === resultUrl;
    const showsOriginal = Boolean(original) && img.src === original.url;
    download.hidden = remove.hidden = !showsResult;
    revert.hidden = compare.hidden = reprocess.hidden = !original || !(showsResult || showsOriginal);
    revert.title = showsOriginal ? 'Show processed image' : 'Show original image';
    setIcon(revert, showsOriginal ? RESULT_ICON : REVERT_ICON);
  };
  updateButtons();
  new MutationObserver(updateButtons).observe(img, { attributes: true, attributeFilter: ['src'] });

  // An image with more than one result (processed again here, before a reload, or on its page) shows them all, as it
  // does once a result is made here: content.js's buttons take over, with the dropdown between the results
  if (original) {
    const listed = await chrome.runtime.sendMessage({ action: 'listResults', imageUrl: resultTabOriginal.imageUrl }).catch(() => null);
    if (!deleted && !handedOver && listed?.results?.length > 1) {
      resultKeys.set(processedImage, key);
      showResult(img, processedImage, name);
      addDownloadButton(img);
    }
  }
});
