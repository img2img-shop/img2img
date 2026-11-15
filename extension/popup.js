// SWAP_WORKFLOWS, the ControlNet defaults and preprocessor list, and UPSCALE_DEFAULT_MODEL come from
// shared/workflows.js (loaded first).
// The workflows without a source: their settings section, and the description shown under the workflow choice
const WORKFLOW_SECTIONS = {
  controlnet: 'controlnetSettings', upscale: 'upscaleSettings', background: 'backgroundSettings', restore: 'restoreSettings',
  colorize: 'colorizeSettings', cleanup: 'cleanupSettings',
  sticker: 'stickerSettings', idPhoto: 'idPhotoSettings', faceBlur: 'faceBlurSettings', filter: 'filterSettings',
  transform: 'transformSettings', segment: 'segmentSettings',
};
const WORKFLOW_HINTS = {
  controlnet: "Replaces the image with a ControlNet preprocessor's map of it (edges, line art, depth, pose, segmentation...).",
  upscale: 'Makes the image larger and sharper with an upscale model.',
  background: 'Finds the subject with BiRefNet and removes the background, or replaces it with a colour, a gradient or an image, or blurs it.',
  restore: 'Sharpens and cleans up every face in the image (old or low-res photos), without swapping it.',
  colorize: 'Colourises a black-and-white photo with DDColor.',
  cleanup: 'Removes JPEG artefacts or noise from a photo, keeping its size.',
  sticker: 'Cuts out the subject with an outline and a drop shadow, as a transparent PNG.',
  idPhoto: 'Crops a portrait to a passport or ID photo size around the face, on a plain background.',
  faceBlur: 'Finds every face in the image and pixelates or blurs it.',
  filter: 'Pixel art, posterize, sepia, black & white or a vignette.',
  transform: 'Redraws the photo with Qwen-Image-Edit: everyone in it in a new outfit, or the whole photo in an art style. Takes longer than the other workflows.',
  segment: 'Finds what you describe ("dog", "red car", "glasses") with SAM 3 and cuts it out as a transparent PNG, removes it, or makes a mask of it.',
};
const SERVER_UNAVAILABLE_HINT = "This workflow isn't available on the img2img server yet: pick another one, or use My ComfyUI (Settings, Processing).";
const CUSTOM_WORKFLOW_HINT = 'One of your own workflows. It runs on your ComfyUI.';
const CUSTOM_ON_SERVER_HINT = 'My workflows run on your own ComfyUI: set Processing (under Settings) to My ComfyUI, or pick another workflow.';

// How long a workflow's jobs typically take on the img2img server, as the end of its hint
function typicalWaitHint(ms) {
  const seconds = ms / 1000;
  const wait = seconds < 1 ? 'under a second' : seconds < 90 ? `about ${Math.round(seconds)} s` : `about ${Math.round(seconds / 60)} min`;
  return ` On the img2img server it usually takes ${wait}.`;
}

// As the Library page's workflow panel (popup.html?embedded): see :root.embedded in popup.html
if (new URLSearchParams(location.search).has('embedded')) {
  document.documentElement.classList.add('embedded');
}

document.addEventListener('DOMContentLoaded', function() {
  const startButton = document.getElementById('startSelection');
  const selectAllButton = document.getElementById('selectAllVisible');
  const statusDiv = document.getElementById('status');
  const sourceGrid = document.getElementById('sourceGrid');
  const autoProcessToggle = document.getElementById('autoProcessToggle');
  const autoRememberToggle = document.getElementById('autoRememberToggle');
  const addSourceButton = document.getElementById('addSource');
  const fileInput = document.getElementById('fileInput');
  const workflowAccordionHeader = document.getElementById('workflowAccordionHeader');
  const workflowAccordionContent = document.getElementById('workflowAccordionContent');
  const settingsAccordionHeader = document.getElementById('settingsAccordionHeader');
  const settingsAccordionContent = document.getElementById('settingsAccordionContent');
  const openInNewTabToggle = document.getElementById('openInNewTabToggle');
  const workflowSelect = document.getElementById('workflowSelect');
  // The workflow dropdown shown in its place (see renderWorkflowPicker)
  const pickerButton = document.getElementById('workflowPickerButton');
  const pickerList = document.getElementById('workflowPickerList');
  // Range sliders stored as whole percentages; each shows its value in the span right after it
  const percentSliders = {
    backgroundBlur: document.getElementById('backgroundBlur'),
    restoreStrength: document.getElementById('restoreStrength'),
    colorizeStrength: document.getElementById('colorizeStrength'),
    stickerOutline: document.getElementById('stickerOutline'),
    faceBlurStrength: document.getElementById('faceBlurStrength'),
    filterStrength: document.getElementById('filterStrength'),
    segmentThreshold: document.getElementById('segmentThreshold'),
  };
  // Dropdowns and inputs of the simple workflows, saved under their id
  const upscaleModel = document.getElementById('upscaleModel');
  const backgroundMode = document.getElementById('backgroundMode');
  const restoreModel = document.getElementById('restoreModel');
  // The outfit and style presets, grouped, before the saved one is restored
  const transformPreset = document.getElementById('transformPreset');
  for (const [group, label] of [['outfit', 'Outfits'], ['style', 'Styles']]) {
    const optgroup = Object.assign(document.createElement('optgroup'), { label });
    for (const [value, preset] of Object.entries(TRANSFORM_PRESETS).filter(([, preset]) => preset.group === group)) {
      optgroup.append(new Option(preset.label, value));
    }
    transformPreset.append(optgroup);
  }
  transformPreset.value = TRANSFORM_DEFAULTS.preset;
  const simpleInputs = ['upscaleModel', 'upscaleScale', 'backgroundMode', 'backgroundColor', 'backgroundColor2', 'restoreModel', 'cleanupMode', 'stickerColor', 'idPhotoSize', 'idPhotoBackground', 'faceBlurStyle', 'filterStyle', 'transformPreset', 'transformVariation', 'segmentPrompt', 'segmentOutput'].map(id => document.getElementById(id));
  // Colours are picked in the popup itself: Firefox closes the popup when its own colour dialog opens
  const colorDefaults = { backgroundColor: BACKGROUND_DEFAULTS.color, backgroundColor2: BACKGROUND_DEFAULTS.color2, stickerColor: STICKER_DEFAULTS.color, idPhotoBackground: ID_PHOTO_DEFAULTS.background };
  const colorPickers = Object.entries(colorDefaults).map(([id, fallback]) => img2imgColorPicker.attach(document.getElementById(id), fallback));
  const stickerShadowToggle = document.getElementById('stickerShadowToggle');
  const controlnetPreprocessor = document.getElementById('controlnetPreprocessor');
  const controlnetResolution = document.getElementById('controlnetResolution');
  // Saved preprocessor options, by node class then input name (only the ones the user changed)
  let controlnetOptions = {};
  // The user's own workflows (My workflows page) and the values chosen for their settings, by workflow id
  let customWorkflows = [];
  let customWorkflowValues = {};

  // Modal elements
  const sourceModal = document.getElementById('sourceModal');
  const closeModal = document.querySelector('.close-modal');
  const sourceNameInput = document.getElementById('sourceNameInput');
  const sourcePreview = document.getElementById('sourcePreview');
  const previewImage = document.getElementById('previewImage');
  const sourceImagesGrid = document.getElementById('sourceImagesGrid');
  const addSourceImage = document.getElementById('addSourceImage');
  const cancelSource = document.getElementById('cancelSource');
  const saveSource = document.getElementById('saveSource');
  
  // Message a tab's content script. Tabs without one (chrome:// and extension pages, or pages loaded before
  // the extension was reloaded) fail with "Receiving end does not exist"; that's expected, so the error is
  // consumed and the callback gets undefined, the same as no reply.
  function sendToTab(tabId, message, callback) {
    chrome.tabs.sendMessage(tabId, message, response => {
      void chrome.runtime.lastError;
      if (callback) callback(response);
    });
  }

  // The workflow a site rule ("A Workflow for a Site") chose for the tab in front of the popup as its page loaded,
  // which content.js reports with the tab's status ('' while the tab runs the popup's choice), is shown as the
  // choice, since it's what runs there, without a word about the rule; a workflow picked here then runs on the
  // page instead (popupWorkflowChosen), until the page is loaded again.
  let tabFollowsPopup = false; // (a choice made here before the tab had answered counts over its answer)
  // Tells the tab the popup's choice runs there from now on
  function popupWorkflowChosen() {
    tabFollowsPopup = true;
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (tabs[0]) sendToTab(tabs[0].id, { action: 'followPopupWorkflow' });
    });
  }

  let selectedSource = null;
  let currentSourceImages = [];
  let editingSourceId = null;
  const MAX_SOURCE_IMAGES = 5;
  let selectingImage = false;

  // Save a source to IndexedDB
  async function saveSourceToDB(source) {
    try {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'saveSource', source }, response => {
          if (response.success) {
            console.log('Source saved successfully:', source.id);
            resolve();
          } else {
            console.error('Error saving source:', response.error);
            reject(new Error(response.error));
          }
        });
      });
    } catch (error) {
      console.error('Could not save the source:', error);
      throw error;
    }
  }

  // Get all the sources from IndexedDB, in the order they were dragged into (sourceOrder in storage, a list of ids);
  // sources not in it yet come last, oldest first
  // The sources, in the user's order. Rejects (never hangs) when background.js answers with an error, doesn't answer
  // (it couldn't be reached, or closed the message without a reply) or takes longer than SOURCES_TIMEOUT_MS.
  const SOURCES_TIMEOUT_MS = 4000;
  async function getAllSources() {
    try {
      const { sourceOrder = [] } = await chrome.storage.local.get('sourceOrder');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the extension took too long to answer')), SOURCES_TIMEOUT_MS);
        chrome.runtime.sendMessage({ action: 'getAllSources' }, response => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !response) {
            reject(new Error(chrome.runtime.lastError?.message || 'no answer from the extension'));
          } else if (response.success && Array.isArray(response.sources)) {
            console.log('Retrieved all sources:', response.sources);
            const position = id => {
              const index = sourceOrder.indexOf(id);
              return index === -1 ? Infinity : index;
            };
            resolve(response.sources.map((source, index) => ({ source, index }))
              .sort((a, b) => position(a.source.id) - position(b.source.id) || a.index - b.index)
              .map(({ source }) => source));
          } else {
            console.error('Error retrieving sources:', response.error);
            reject(new Error(response.error || 'the sources could not be read'));
          }
        });
      });
    } catch (error) {
      console.error('Could not read the sources:', error);
      throw error;
    }
  }

  // Delete a source from IndexedDB
  async function deleteSource(sourceId) {
    try {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'deleteSource', sourceId }, response => {
          if (response.success) {
            console.log('Source deleted successfully:', sourceId);
            resolve();
          } else {
            console.error('Error deleting source:', response.error);
            reject(new Error(response.error));
          }
        });
      });
    } catch (error) {
      console.error('Could not delete the source:', error);
      throw error;
    }
  }

  // The Workflow and Settings sections stay open or closed as they were left (openSections in storage); until
  // one is toggled, it's as popup.html has it (Workflow open, Settings closed)
  const accordions = {
    workflow: [workflowAccordionHeader, workflowAccordionContent],
    settings: [settingsAccordionHeader, settingsAccordionContent],
  };
  const setSectionOpen = (name, open) => accordions[name].forEach(element => element.classList.toggle('active', open));
  chrome.storage.local.get('openSections', ({ openSections = {} }) => {
    for (const [name, open] of Object.entries(openSections)) {
      if (accordions[name]) setSectionOpen(name, open);
    }
  });
  // A section opened at the bottom of the popup opens under the button bar, where it looks as if nothing happened:
  // scroll what it holds into view above the bar, but never so far that its own header leaves the top
  const actionsBar = document.querySelector('.actions-bar');
  function revealSection(header, content) {
    const hidden = content.getBoundingClientRect().bottom + 12 - actionsBar.getBoundingClientRect().top;
    const room = header.getBoundingClientRect().top;
    if (hidden > 0 && room > 0) window.scrollBy({ top: Math.min(hidden, room), behavior: 'smooth' });
  }
  for (const [name, [header, content]] of Object.entries(accordions)) {
    header.addEventListener('click', () => {
      setSectionOpen(name, !content.classList.contains('active'));
      if (content.classList.contains('active')) revealSection(header, content);
      chrome.storage.local.get('openSections', ({ openSections = {} }) => {
        chrome.storage.local.set({ openSections: { ...openSections, [name]: content.classList.contains('active') } });
      });
    });
  }

  // Announcements from img2img.shop, fetched by background.js once a day and as the popup opens: everything that
  // applies to this version, hasn't been dismissed and hasn't ended, newest first. Everything is drawn as text, never
  // as markup, so nothing in it can run here.
  const announcementsBox = document.getElementById('announcements');
  const ANNOUNCEMENTS_DISMISSED_KEPT = 50;
  let announcementEndTimer = null;

  function showAnnouncements({ announcements, announcementsDismissed }) {
    const dismissed = Array.isArray(announcementsDismissed) ? announcementsDismissed : [];
    const now = Date.now();
    const showing = (Array.isArray(announcements) ? announcements : [])
      .filter(item => !dismissed.includes(item.id) && !(item.endsAt && Date.parse(item.endsAt) <= now));
    // One that ends while the popup is open goes then
    clearTimeout(announcementEndTimer);
    const nextEnd = Math.min(...showing.map(item => (item.endsAt ? Date.parse(item.endsAt) : Infinity)));
    if (Number.isFinite(nextEnd)) {
      announcementEndTimer = setTimeout(() => {
        chrome.storage.local.get(['announcements', 'announcementsDismissed'], showAnnouncements);
      }, Math.min(nextEnd - now + 500, 2 ** 31 - 1));
    }
    announcementsBox.textContent = '';
    announcementsBox.hidden = showing.length === 0;
    for (const item of showing) {
      const card = document.createElement('div');
      card.className = 'announcement announcement-' + (item.level || 'info');
      const title = document.createElement('div');
      title.className = 'announcement-title';
      title.textContent = item.title;
      card.appendChild(title);
      if (item.body) {
        const body = document.createElement('div');
        body.textContent = item.body;
        card.appendChild(body);
      }
      if (item.url) {
        const link = document.createElement('a');
        link.href = item.url;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = item.link || 'Read more';
        card.appendChild(link);
      }
      const dismiss = document.createElement('button');
      dismiss.className = 'announcement-dismiss';
      dismiss.title = 'Dismiss';
      dismiss.setAttribute('aria-label', 'Dismiss this announcement');
      dismiss.textContent = '×';
      dismiss.addEventListener('click', () => dismissAnnouncement(item.id));
      card.appendChild(dismiss);
      announcementsBox.appendChild(card);
    }
  }

  function dismissAnnouncement(id) {
    chrome.storage.local.get(['announcements', 'announcementsDismissed'], result => {
      const dismissed = Array.isArray(result.announcementsDismissed) ? result.announcementsDismissed : [];
      // The ids of announcements long gone from the site are no use: keep the newest few
      const announcementsDismissed = [...dismissed.filter(seen => seen !== id), id].slice(-ANNOUNCEMENTS_DISMISSED_KEPT);
      chrome.storage.local.set({ announcementsDismissed });
      showAnnouncements({ ...result, announcementsDismissed });
    });
  }

  chrome.storage.local.get(['announcements', 'announcementsDismissed'], showAnnouncements);
  // What's stored is shown at once; a check that's due runs now (background.js keeps to its Announcements setting) and
  // its answer is drawn when it comes in
  chrome.runtime.sendMessage({ action: 'refreshAnnouncements' }).catch(() => {});
  chrome.storage.onChanged.addListener(changes => {
    if (changes.announcements) {
      chrome.storage.local.get(['announcements', 'announcementsDismissed'], showAnnouncements);
    }
  });

  // Download-results-automatically toggle (off unless turned on), read by content.js when a result comes in
  const autoDownloadToggle = document.getElementById('autoDownloadToggle');
  chrome.storage.local.get('autoDownload', ({ autoDownload }) => {
    autoDownloadToggle.checked = autoDownload === true;
  });
  autoDownloadToggle.addEventListener('change', function() {
    chrome.storage.local.set({ autoDownload: this.checked });
  });

  // Download-as-JPG toggle (on unless turned off), read by background.js when downloading
  const downloadAsJpgToggle = document.getElementById('downloadAsJpgToggle');
  chrome.storage.local.get('downloadAsJpg', ({ downloadAsJpg }) => {
    downloadAsJpgToggle.checked = downloadAsJpg !== false;
  });
  downloadAsJpgToggle.addEventListener('change', function() {
    const set = () => chrome.storage.local.set({ downloadAsJpg: this.checked });
    if (!this.checked) return set();
    // With Keep Workflow in Results on (settings page), results of the user's own workflows download as PNG whatever
    // this says, since a JPG can't carry the workflow: say so first, as the settings page does. A no leaves it off.
    chrome.storage.local.get('keepWorkflowInResult', ({ keepWorkflowInResult }) => {
      if (keepWorkflowInResult === true && !confirm('Keep Workflow in Results is on. Results of your own workflows will keep downloading as PNG, since a JPG can\'t carry the workflow; everything else will download as JPG.\n\nTurn Download as JPG on?')) {
        this.checked = false;
        return;
      }
      set();
    });
  });

  // The settings page has these three as well: follow it while both are open
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (changes.openResultsInNewTab) openInNewTabToggle.checked = changes.openResultsInNewTab.newValue === true;
    if (changes.autoDownload) autoDownloadToggle.checked = changes.autoDownload.newValue === true;
    if (changes.downloadAsJpg) downloadAsJpgToggle.checked = changes.downloadAsJpg.newValue !== false;
  });

  // Everything else is on the settings page (settings.html), which the browser also offers as this extension's options
  document.getElementById('openSettings').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  stickerShadowToggle.addEventListener('change', () => chrome.storage.local.set({ stickerShadow: stickerShadowToggle.checked }));

  // Handle open-results-in-new-tab toggle
  openInNewTabToggle.addEventListener('change', function() {
    chrome.storage.local.set({ openResultsInNewTab: this.checked });
  });


  // Workflow sections (Source, Swap, Blend...) fold away by clicking their heading; which ones are folded is
  // remembered. Both refine sections share the "refine" key.
  chrome.storage.local.get('collapsedStages', ({ collapsedStages = [] }) => {
    const stages = Array.from(document.querySelectorAll('.stage'));
    for (const stage of stages) {
      stage.classList.toggle('collapsed', collapsedStages.includes(stage.dataset.stage));
      stage.querySelector('.settings-stage').addEventListener('click', () => {
        const collapse = !stage.classList.contains('collapsed');
        stages.filter(other => other.dataset.stage === stage.dataset.stage).forEach(other => other.classList.toggle('collapsed', collapse));
        const collapsed = new Set(stages.filter(other => other.classList.contains('collapsed')).map(other => other.dataset.stage));
        chrome.storage.local.set({ collapsedStages: [...collapsed] });
      });
    }
  });

  // Handle add source button click
  addSourceButton.addEventListener('click', function() {
    showSourceModal();
  });

  // Handle close modal
  closeModal.addEventListener('click', function() {
    hideSourceModal();
  });

  // Handle cancel button
  cancelSource.addEventListener('click', function() {
    hideSourceModal();
  });

  // Handle add source image button
  addSourceImage.addEventListener('click', function() {
    if (currentSourceImages.length >= MAX_SOURCE_IMAGES) {
      alert(`Maximum ${MAX_SOURCE_IMAGES} images allowed per source`);
      return;
    }
    fileInput.click();
  });

  // Handle file input change
  fileInput.addEventListener('change', function(e) {
    const files = Array.from(e.target.files);
    if (files.length > 0) {
      const remainingSlots = MAX_SOURCE_IMAGES - currentSourceImages.length;
      const filesToAdd = files.slice(0, remainingSlots);
      
      filesToAdd.forEach(file => {
        const reader = new FileReader();
        // Kept at most SOURCE_MAX_SIDE and the hosted size limit (shared/images.js): plenty for a portrait or a background
        reader.onload = async function(e) {
          addSourceImageToGrid(await fitImage(e.target.result, { maxBytes: HOSTED_MAX_SOURCE_BYTES, maxSide: SOURCE_MAX_SIDE }));
        };
        reader.readAsDataURL(file);
      });

      if (files.length > remainingSlots) {
        alert(`Only ${remainingSlots} more images can be added`);
      }
    }
  });

  // Handle save source button
  saveSource.addEventListener('click', async function() {
    if (currentSourceImages.length === 0) {
      alert('Please add at least one source image');
      return;
    }

    const sourceName = sourceNameInput.value.trim() || `Source ${Date.now()}`;
    const sourceId = editingSourceId || 'source_' + Date.now();
    
    const source = {
      id: sourceId,
      name: sourceName,
      dataUrls: currentSourceImages,
      previewUrl: currentSourceImages[0]
    };

    try {
      console.log('Attempting to save source:', source);
      await saveSourceToDB(source);
      
      if (editingSourceId) {
        // Update the existing source element
        const existingSource = document.querySelector(`.source-item[data-id="${sourceId}"]`);
        if (existingSource) {
          existingSource.querySelector('img').src = source.previewUrl;
          existingSource.title = source.name;
          existingSource.querySelector('.image-count').textContent = source.dataUrls.length;
        }
      } else {
        // Create and add a new source element to the grid
        const sourceElement = createSourceElement(sourceId, sourceName, currentSourceImages[0], currentSourceImages.length);
        sourceGrid.insertBefore(sourceElement, addSourceButton);
      }
      
      // Reset modal state
      resetSourceModal();
      hideSourceModal();
    } catch (error) {
      console.error('Error saving source:', error);
      alert('Failed to save source. Please try again.');
    }
  });

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

  // Function to show the source modal
  function showSourceModal(sourceId = null) {
    sourceModal.style.display = 'block';
    editingSourceId = sourceId;
    
    if (sourceId) {
      // Edit mode
      document.getElementById('modalTitle').textContent = 'Edit Source';
      chrome.runtime.sendMessage({ action: 'getSource', sourceId }, response => {
        if (response.success) {
          const sourceData = getSourceData(response.source);
          sourceNameInput.value = sourceData.name;
          currentSourceImages = [...sourceData.dataUrls];
          renderSourceImages();
        } else {
          console.error('Error loading source for editing:', response.error);
          alert('Failed to load the source. Please try again.');
          hideSourceModal();
        }
      });
    } else {
      // Create mode
      document.getElementById('modalTitle').textContent = 'Create New Source';
      resetSourceModal();
    }
  }

  // Function to hide the source modal
  function hideSourceModal() {
    sourceModal.style.display = 'none';
    editingSourceId = null;
    resetSourceModal();
  }

  // Function to reset the source modal state
  function resetSourceModal() {
    sourceNameInput.value = '';
    currentSourceImages = [];
    imageViewer.hidden = true;
    renderSourceImages();
  }

  // Function to add source image to grid
  function addSourceImageToGrid(dataUrl) {
    currentSourceImages.push(dataUrl);
    renderSourceImages();
  }

  // Rebuild the source image grid from currentSourceImages. Thumbnails can be dragged to reorder (image 1
  // is the source's preview) and clicked to view full size.
  function renderSourceImages() {
    sourceImagesGrid.innerHTML = '';
    currentSourceImages.forEach((dataUrl, index) => {
      const imageItem = document.createElement('div');
      imageItem.className = 'source-image-item';
      imageItem.draggable = true;
      imageItem.title = 'Drag to reorder, click to expand';

      const img = document.createElement('img');
      img.src = dataUrl;
      img.alt = `Source Image ${index + 1}`;
      img.draggable = false;

      const orderBadge = document.createElement('span');
      orderBadge.className = 'image-order';
      orderBadge.textContent = index + 1;

      const removeButton = document.createElement('button');
      removeButton.textContent = 'X';
      removeButton.className = 'remove-image';
      removeButton.addEventListener('click', function(e) {
        e.stopPropagation();
        currentSourceImages.splice(index, 1);
        renderSourceImages();
      });

      imageItem.append(img, orderBadge, removeButton);
      imageItem.addEventListener('click', () => openImageViewer(index));

      // Drag and drop reordering
      imageItem.addEventListener('dragstart', function(e) {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(index));
        imageItem.classList.add('dragging');
      });
      imageItem.addEventListener('dragend', () => imageItem.classList.remove('dragging'));
      imageItem.addEventListener('dragover', function(e) {
        e.preventDefault();
        imageItem.classList.add('drop-target');
      });
      imageItem.addEventListener('dragleave', () => imageItem.classList.remove('drop-target'));
      imageItem.addEventListener('drop', function(e) {
        e.preventDefault();
        const fromIndex = Number(e.dataTransfer.getData('text/plain'));
        if (Number.isInteger(fromIndex) && fromIndex !== index) {
          const [moved] = currentSourceImages.splice(fromIndex, 1);
          currentSourceImages.splice(index, 0, moved);
        }
        renderSourceImages();
      });

      sourceImagesGrid.appendChild(imageItem);
    });

    if (currentSourceImages.length < MAX_SOURCE_IMAGES) {
      const addButton = document.createElement('div');
      addButton.className = 'add-source-image';
      addButton.id = 'addSourceImage';
      addButton.innerHTML = '<span>+ Add Image</span>';
      addButton.addEventListener('click', () => fileInput.click());
      sourceImagesGrid.appendChild(addButton);
    }

    // The preview always shows image 1
    if (currentSourceImages.length > 0) {
      previewImage.src = currentSourceImages[0];
      previewImage.style.display = 'block';
    } else {
      previewImage.style.display = 'none';
    }
  }

  // Full-size viewer for a source's images, with previous/next navigation
  let viewerIndex = 0;
  function openImageViewer(index) {
    viewerIndex = index;
    showViewerImage();
    imageViewer.hidden = false;
  }

  function showViewerImage() {
    viewerImage.src = currentSourceImages[viewerIndex];
    viewerCounter.textContent = `${viewerIndex + 1} / ${currentSourceImages.length}`;
    viewerPrev.hidden = viewerNext.hidden = currentSourceImages.length < 2;
  }

  function stepImageViewer(step) {
    viewerIndex = (viewerIndex + step + currentSourceImages.length) % currentSourceImages.length;
    showViewerImage();
  }

  const imageViewer = document.getElementById('imageViewer');
  const viewerImage = document.getElementById('viewerImage');
  const viewerCounter = document.getElementById('viewerCounter');
  const viewerPrev = document.getElementById('viewerPrev');
  const viewerNext = document.getElementById('viewerNext');
  imageViewer.addEventListener('click', () => { imageViewer.hidden = true; });
  viewerPrev.addEventListener('click', e => { e.stopPropagation(); stepImageViewer(-1); });
  viewerNext.addEventListener('click', e => { e.stopPropagation(); stepImageViewer(1); });
  document.addEventListener('keydown', function(e) {
    if (imageViewer.hidden) return;
    if (e.key === 'Escape') imageViewer.hidden = true;
    if (e.key === 'ArrowLeft') stepImageViewer(-1);
    if (e.key === 'ArrowRight') stepImageViewer(1);
  });

  // Function to create a source element
  function createSourceElement(sourceId, sourceName, previewUrl, imageCount) {
    const sourceElement = document.createElement('div');
    sourceElement.className = 'source-item';
    sourceElement.dataset.id = sourceId;
    sourceElement.title = sourceName;
    sourceElement.draggable = true;

    const img = document.createElement('img');
    img.src = previewUrl;
    img.alt = sourceName;
    img.draggable = false;

    // Drag onto another source to move it there; the new order is saved as sourceOrder
    sourceElement.addEventListener('dragstart', function(e) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-img2img-source', sourceId);
      sourceElement.classList.add('dragging');
    });
    sourceElement.addEventListener('dragend', () => sourceElement.classList.remove('dragging'));
    sourceElement.addEventListener('dragover', function(e) {
      if (!e.dataTransfer.types.includes('application/x-img2img-source')) return;
      e.preventDefault();
      sourceElement.classList.add('drop-target');
    });
    sourceElement.addEventListener('dragleave', () => sourceElement.classList.remove('drop-target'));
    sourceElement.addEventListener('drop', function(e) {
      e.preventDefault();
      sourceElement.classList.remove('drop-target');
      const dragged = sourceGrid.querySelector(`.source-item[data-id="${e.dataTransfer.getData('application/x-img2img-source')}"]`);
      if (!dragged || dragged === sourceElement) return;
      const items = Array.from(sourceGrid.querySelectorAll('.source-item'));
      // Moving forwards lands after the target, backwards before it
      sourceGrid.insertBefore(dragged, items.indexOf(dragged) < items.indexOf(sourceElement) ? sourceElement.nextSibling : sourceElement);
      chrome.storage.local.set({ sourceOrder: Array.from(sourceGrid.querySelectorAll('.source-item'), item => item.dataset.id) });
      // A custom workflow's source pickers list the sources in this order too
      if (isCustomWorkflow(workflowSelect.value)) {
        renderCustomSettings();
      }
    });

    const editButton = document.createElement('button');
    editButton.textContent = 'E';  // Simple 'E' for Edit
    editButton.className = 'edit-source';
    editButton.addEventListener('click', function(e) {
      e.stopPropagation();
      showSourceModal(sourceId);
    });
    
    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'X';  // Simple 'X' for Delete
    deleteButton.className = 'delete-source';
    
    const countBadge = document.createElement('div');
    countBadge.className = 'image-count';
    countBadge.textContent = imageCount;
    
    sourceElement.appendChild(img);
    sourceElement.appendChild(editButton);
    sourceElement.appendChild(deleteButton);
    sourceElement.appendChild(countBadge);
    
    // Add click handler for source selection
    sourceElement.addEventListener('click', function(e) {
      if (e.target !== deleteButton && e.target !== editButton) {
        selectSource(sourceId);
      }
    });
    
    // Add click handler for delete button
    deleteButton.addEventListener('click', async function(e) {
      e.stopPropagation();
      if (confirm('Are you sure you want to delete this source?')) {
        try {
          await deleteSource(sourceId);
          // Remove the source element from the grid
          sourceElement.remove();
          // If the deleted source was selected, clear the selection
          if (sourceId === selectedSource) {
            chrome.storage.local.remove('selectedSourceId');
          }
        } catch (error) {
          console.error('Error deleting source:', error);
          alert('Failed to delete the source. Please try again.');
        }
      }
    });
    
    return sourceElement;
  }

  // Helper function to get a source's data
  function getSourceData(source) {
    // Handle the old source data structure
    if (source.dataUrl) {
      return {
        id: source.id,
        name: source.name || `Source ${source.id}`,
        dataUrls: [source.dataUrl],
        previewUrl: source.dataUrl
      };
    }
    // Handle the new source data structure
    return {
      id: source.id,
      name: source.name || `Source ${source.id}`,
      dataUrls: source.dataUrls || [],
      previewUrl: source.previewUrl || (source.dataUrls && source.dataUrls[0]) || ''
    };
  }

  // Handle source selection
  function selectSource(sourceId) {
    selectedSource = sourceId;
    chrome.storage.local.set({ selectedSourceId: sourceId });
    
    // Update UI to show the selected source
    document.querySelectorAll('.source-item').forEach(item => {
      if (item.dataset.id === sourceId) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }

  // Load saved sources and processing state
  // Restore the popup's settings, then show the sources. The settings come from storage and are applied at once; the
  // sources come from background.js, which can be slow to wake (or fail), so they're asked for at the same time and
  // filled in when they arrive. A failure shows in the status line: an alert would freeze the popup.
  let settingsApplied;
  const settingsRestored = new Promise(resolve => { settingsApplied = resolve; });
  async function loadSources() {
    let sourcesError = null;
    // (one retry: the first message can fail while background.js is restarting)
    const sourcesRequest = getAllSources()
      .catch(() => new Promise(resolve => setTimeout(resolve, 500)).then(getAllSources))
      .catch(error => {
        sourcesError = error;
        return [];
      });
    // The tab's state (Automatic running, Manual Selection on, a workflow a site rule chose for it), asked for at
    // the same time as the settings; a tab without the content script answers nothing
    const tabStatus = new Promise(resolve => {
      chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
        if (!tabs[0]) return resolve(undefined);
        sendToTab(tabs[0].id, { action: 'checkProcessingStatus' }, resolve);
      });
    });
    try {
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['selectedSourceId', 'isProcessing', 'autoProcess', 'autoRemember', 'workflow', 'controlnetPreprocessor', 'controlnetResolution', 'controlnetOptions', 'upscaleModel', 'upscaleScale', 'backgroundMode', 'backgroundColor', 'backgroundColor2', 'backgroundBlur', 'restoreModel', 'restoreStrength', 'restoreFidelity', 'colorizeStrength', 'cleanupMode', 'stickerOutline', 'stickerColor', 'stickerShadow', 'idPhotoSize', 'idPhotoBackground', 'faceBlurStyle', 'faceBlurStrength', 'filterStyle', 'filterStrength', 'transformPreset', 'transformVariation', 'segmentPrompt', 'segmentThreshold', 'segmentOutput', 'processingMode', 'openResultsInNewTab', 'customWorkflows', 'customWorkflowValues'], resolve);
      });
      
      const selectedSourceId = result.selectedSourceId;
      const storedIsProcessing = result.isProcessing || false;
      const autoProcess = result.autoProcess || false;
      const autoRemember = result.autoRemember !== false; // Swap Cache is on unless it has been turned off
      
      // Load saved settings
      // Removed workflows map to their replacement (same table as content.js)
      const replacements = {};
      const workflow = replacements[result.workflow] || result.workflow;
      customWorkflows = result.customWorkflows || [];
      customWorkflowValues = result.customWorkflowValues || {};
      renderCustomWorkflowOptions();
      workflowSelect.value = [...SWAP_WORKFLOWS, ...Object.keys(WORKFLOW_SECTIONS), ...customWorkflowNames()].includes(workflow) ? workflow : DEFAULT_WORKFLOW;
      controlnetPreprocessor.dataset.saved = result.controlnetPreprocessor || CONTROLNET_DEFAULT_PREPROCESSOR;
      controlnetResolution.value = String(result.controlnetResolution || CONTROLNET_DEFAULT_RESOLUTION);
      controlnetOptions = result.controlnetOptions || {};
      // The upscale model list arrives from ComfyUI later, so its saved value waits in a data attribute
      upscaleModel.dataset.saved = result.upscaleModel || UPSCALE_DEFAULT_MODEL;
      for (const input of simpleInputs) {
        if (result[input.id] !== undefined && input !== upscaleModel) {
          input.value = String(result[input.id]);
        }
      }
      colorPickers.forEach(sync => sync());
      stickerShadowToggle.checked = result.stickerShadow ?? STICKER_DEFAULTS.shadow;
      // A restore model that's no longer offered (CodeFormer, GPEN) shows and saves as the default
      if (!RESTORE_MODELS.includes(restoreModel.value)) {
        restoreModel.value = RESTORE_DEFAULTS.model;
        chrome.storage.local.set({ restoreModel: restoreModel.value });
      }
      // Likewise a preset that was taken out
      if (!TRANSFORM_PRESETS[transformPreset.value]) {
        transformPreset.value = TRANSFORM_DEFAULTS.preset;
      }
      const legacyToggles = {};
      for (const [key, slider] of Object.entries(percentSliders)) {
        const value = result[key] ?? (legacyToggles[key] === false ? 0 : undefined);
        if (value !== undefined) {
          slider.value = value;
          slider.nextElementSibling.textContent = value + '%';
        }
      }
      // What a site rule chose for the tab (see tabFollowsPopup): shown as the choice, since it's what runs there,
      // unless something picked here already told the tab otherwise, and only while it's a workflow listed here
      const response = await tabStatus;
      const ruled = String(response?.workflow || '');
      if (ruled && !tabFollowsPopup && [...workflowSelect.options].some(option => option.value === ruled)) {
        workflowSelect.value = ruled;
      }
      showWorkflowSettings();
      showSiteNotice();
      openInNewTabToggle.checked = result.openResultsInNewTab === true;
      
      // Update auto-process toggle state
      autoProcessToggle.checked = autoProcess;
      autoRememberToggle.checked = autoRemember;

      // Update UI based on processing state
      if (storedIsProcessing) {
        startButton.classList.add('active');
        selectAllButton.disabled = true;
      } else {
        startButton.classList.remove('active');
        selectAllButton.disabled = false;
      }
      // The tab's own state (a tab without the content script isn't selecting, and runs nothing)
      const isProcessing = response ? response.isProcessing : storedIsProcessing;
      // Manual Selection is on or off per tab
      selectingImage = Boolean(response?.isSelecting);
      startButton.textContent = selectingImage ? 'Stop Selection' : 'Manual Selection';
      if (isProcessing) {
        selectAllButton.textContent = 'Stop Processing';
        selectAllButton.disabled = false;
        selectAllButton.classList.add('processing');
        startButton.disabled = true;
        showStatus('Continuous processing is active', 'processing');
      }
      settingsApplied();

      // Load saved sources
      const sources = await sourcesRequest;
      sources.forEach(source => {
        const sourceData = getSourceData(source);
        const sourceElement = createSourceElement(
          sourceData.id,
          sourceData.name,
          sourceData.previewUrl,
          sourceData.dataUrls.length
        );
        
        if (sourceData.id === selectedSourceId) {
          sourceElement.classList.add('selected');
        }
        
        sourceGrid.insertBefore(sourceElement, addSourceButton);
      });

      // If auto-process is enabled but no source is selected, select the first source
      if (autoProcess && !selectedSourceId && sources.length > 0) {
        selectSource(sources[0].id);
      }
      // A custom workflow's source pickers list the sources too
      if (isCustomWorkflow(workflowSelect.value)) {
        renderCustomSettings();
      }
      if (sourcesError) {
        throw sourcesError;
      }
    } catch (error) {
      console.error('Error loading sources:', error);
      showStatus(`Couldn't load your sources (${error.message}). Close and reopen the popup to try again.`, 'error');
    } finally {
      settingsApplied();
    }
  }

  // Initialize the popup
  const sourcesLoaded = loadSources();

  // Export every source (name and images) to a .json file, and import such a file back. Sources live in the
  // extension's own IndexedDB, so this is how they move to another browser or survive a new extension ID.
  const SOURCES_EXPORT_FORMAT = 'img2img-sources';
  // Exports made before the rename from Swappix still import
  const SOURCES_IMPORT_FORMATS = [SOURCES_EXPORT_FORMAT, 'swappix-sources'];
  document.getElementById('exportSources').addEventListener('click', async () => {
    try {
      const sources = (await getAllSources()).map(getSourceData);
      if (sources.length === 0) {
        showStatus('No sources to export', 'error');
        return;
      }
      const file = new Blob([JSON.stringify({ format: SOURCES_EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), sources })], { type: 'application/json' });
      // Straight to the Downloads folder: a Save As dialog can close the popup, which revokes the blob URL
      const url = URL.createObjectURL(file);
      const filename = `img2img-sources-${new Date().toISOString().slice(0, 10)}.json`;
      await chrome.downloads.download({ url, filename, saveAs: false });
      showStatus(`Exported ${sources.length} source${sources.length === 1 ? '' : 's'} to Downloads/${filename}`, 'success');
    } catch (error) {
      showStatus(`Export failed: ${error.message}`, 'error');
    }
  });

  const importSourcesInput = document.getElementById('importSourcesInput');
  document.getElementById('importSources').addEventListener('click', () => importSourcesInput.click());
  importSourcesInput.addEventListener('change', async () => {
    const file = importSourcesInput.files[0];
    importSourcesInput.value = '';
    if (!file) return;
    try {
      const data = JSON.parse(await file.text());
      if (!SOURCES_IMPORT_FORMATS.includes(data?.format) || !Array.isArray(data.sources)) {
        throw new Error('not an img2img sources export');
      }
      let imported = 0;
      for (const source of data.sources) {
        const dataUrls = (source.dataUrls || []).filter(url => typeof url === 'string' && url.startsWith('data:image/'));
        if (typeof source.id !== 'string' || dataUrls.length === 0) continue;
        await saveSourceToDB({ id: source.id, name: String(source.name || source.id), dataUrls, previewUrl: dataUrls[0] });
        imported++;
      }
      showStatus(`Imported ${imported} source${imported === 1 ? '' : 's'}`, 'success');
      // Reload so the source grid shows them
      setTimeout(() => location.reload(), 600);
    } catch (error) {
      showStatus(`Import failed: ${error.message}`, 'error');
    }
  });

  // Handle start selection button
  startButton.addEventListener('click', function() {
    // Start or stop Manual Selection in this tab (selectingImage is what the tab said when the popup opened)
    if (selectingImage) {
      selectingImage = false;
      startButton.textContent = 'Manual Selection';
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        sendToTab(tabs[0].id, { action: 'stopSelection' });
      });
      return;
    }
    chrome.storage.local.get('selectedSourceId', function(result) {
      if (needsTermsAgreement()) {
        showStatus('Agree to the terms above first', 'error');
        return;
      }
      if (!result.selectedSourceId && workflowNeedsSource()) {
        showStatus('Select a source first', 'error');
        return;
      }
      startButton.textContent = 'Stop Selection';
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        sendToTab(tabs[0].id, { action: 'startSelection', selectedSourceId: result.selectedSourceId });
        window.close();
      });
    });
  });

  // What the site rules (shared/sites.js) mean for the page in front of us: off altogether, left out of what starts
  // by itself, or opened with a workflow of its own, shown as the choice here. The rules are on the settings page.
  function showSiteNotice() {
    const notice = document.getElementById('siteNotice');
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      const url = tabs[0]?.url || '';
      const site = img2imgSites.host(url);
      if (!site) {
        notice.hidden = true; // an extension page, a file, a new tab: no site to have a rule
        return;
      }
      chrome.storage.local.get(['blockedSites', 'automaticSites', 'siteWorkflows', 'customWorkflows'], stored => {
        const said = [];
        if (img2imgSites.matches(stored.blockedSites, url)) {
          said.push(`img2img is off on ${site} (Never Run On).`);
        } else {
          if (img2imgSites.patterns(stored.automaticSites).length > 0 && !img2imgSites.matches(stored.automaticSites, url)) {
            said.push(`Auto-process and Swap Cache don't start by themselves on ${site} (Automatic Only On).`);
          }
          const workflowName = workflow => {
            const customId = customWorkflowId(workflow);
            return customId ? (stored.customWorkflows || []).find(definition => definition.id === customId)?.name : WORKFLOW_LABELS[workflow];
          };
          // A rule for one of the user's own workflows, deleted since: the popup's choice runs here, and the rule
          // has to be changed in the settings
          const siteWorkflow = img2imgSites.workflowFor(stored.siteWorkflows, url);
          if (customWorkflowId(siteWorkflow) && !workflowName(siteWorkflow)) {
            said.push(`A rule for ${site} names a workflow that was deleted, so the one chosen here runs: change the rule in the settings.`);
          }
        }
        notice.textContent = said.join(' ');
        notice.hidden = said.length === 0;
      });
    });
  }

  // "Ask Before" (autoAskOver): Automatic Selection converts every image on the page that qualifies, which on the
  // img2img server costs credits an image, so over that many it says how many and what they cost first. Resolves
  // true to go ahead. A page without a content script answers nothing, and the message below reports that as usual.
  async function automaticSelectionAgreed(tabId) {
    const { autoAskOver } = await chrome.storage.local.get('autoAskOver');
    // Unset means the default (the settings page shows the same one); 0 is "never ask", chosen there
    const askOver = askOverLimit(autoAskOver);
    if (askOver <= 0) {
      return true;
    }
    const count = await new Promise(resolve => {
      sendToTab(tabId, { action: 'countAutomaticImages' }, response => resolve(Number(response?.count) || 0));
    });
    if (count <= askOver) {
      return true;
    }
    const cost = runCostText(count, serverCredits[workflowSelect.value], processingMode.value === 'server');
    return confirm(`About ${count} images on this page will be converted.${cost}\n\nGo ahead?`);
  }

  // Handle select all visible button
  selectAllButton.addEventListener('click', function() {
    chrome.storage.local.get('selectedSourceId', function(result) {
      if (needsTermsAgreement() && !selectAllButton.classList.contains('processing')) {
        showStatus('Agree to the terms above first', 'error');
        return;
      }
      if (!result.selectedSourceId && workflowNeedsSource()) {
        showStatus('Select a source first', 'error');
        return;
      }

      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        if (selectAllButton.classList.contains('processing')) {
          // Stop processing
          sendToTab(tabs[0].id, { action: 'stopContinuousProcessing' });
          selectAllButton.textContent = 'Automatic Selection';
          selectAllButton.classList.remove('processing');
          showStatus('Processing stopped', 'success');
          startButton.disabled = false;
          chrome.storage.local.set({ isProcessing: false });
        } else {
          // Start processing, once a page with more images than Ask Before has been agreed to
          automaticSelectionAgreed(tabs[0].id).then(agreed => {
            if (!agreed) {
              showStatus('Nothing processed', 'success');
              // Auto-process turned this on; saying no turns it back off, or it would start again on the next page
              if (autoProcessToggle.checked) {
                autoProcessToggle.checked = false;
                chrome.storage.local.set({ autoProcess: false });
              }
              return;
            }
            sendToTab(tabs[0].id, { action: 'selectAllVisible', sourceId: result.selectedSourceId });
            selectAllButton.textContent = 'Stop Processing';
            selectAllButton.classList.add('processing');
            showStatus('Continuous processing started', 'processing');
            startButton.disabled = true;
            chrome.storage.local.set({ isProcessing: true });
          });
        }
      });
    });
  });

  // Handle auto-process toggle
  autoProcessToggle.addEventListener('change', function() {
    const isEnabled = this.checked;
    chrome.storage.local.set({ autoProcess: isEnabled });
    
    if (isEnabled && !selectAllButton.classList.contains('processing')) {
      selectAllButton.click();
    }
  });

  // Handle auto-remember toggle
  autoRememberToggle.addEventListener('change', function() {
    const isEnabled = this.checked;
    chrome.storage.local.set({ autoRemember: isEnabled });
    if (isEnabled) {
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        chrome.storage.local.get(['selectedSourceId'], async function(result) {
          const sourceId = result.selectedSourceId
          sendToTab(tabs[0].id, { action: 'autoRemember', sourceId: sourceId });
        });
        
      });
    }
  });

  // Function to show status messages
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
  }

  // Processing on the user's own ComfyUI (its address is a setting on the settings page) or on the img2img server
  // (fixed in background.js)
  const processingMode = document.getElementById('processingMode');
  const img2imgApiKey = document.getElementById('img2imgApiKey');
  // The workflows the img2img server offers, and with them the ControlNet preprocessors it offers and their options
  // (null if it can't be reached).
  let serverWorkflows = null;
  let serverPreprocessors = null;
  let serverUpscaleModels = null;
  let serverTypicalWaits = {}; // workflow → ms, for those that ran on the server lately
  let serverCredits = {}; // workflow → credits per image, shown in the workflow dropdown
  const serverWorkflowsReady = refreshServerWorkflows();
  async function refreshServerWorkflows() {
    const server = await fetchServerWorkflows(); // (shared/workflows.js)
    serverWorkflows = server.workflows;
    serverCredits = server.credits;
    serverPreprocessors = server.preprocessors;
    serverUpscaleModels = server.upscaleModels;
    serverTypicalWaits = server.typicalWaits;
    controlnetListReady = null;
    upscaleModelsReady = null;
    showWorkflowSettings();
  }

  // The credits of the account the API key belongs to, or the server's reason it can't say (no key, a revoked one).
  // The balance is also shown at the top of the popup while images go to the img2img server.
  let accountCredits = null;
  let accountLoading = false;
  // The site's Credits page (from the server, so it's the local site with a local server)
  let creditsUrl = null;
  async function refreshAccount() {
    const status = document.getElementById('img2imgAccountStatus');
    if (!img2imgApiKey.value.trim()) {
      accountCredits = null;
      status.textContent = 'Add a key to use the img2img server';
      showCreditBadge();
      return;
    }
    accountLoading = true;
    showCreditBadge();
    const account = await fetchAccount(); // (shared/workflows.js)
    accountLoading = false;
    accountCredits = account.credits;
    creditsUrl = account.creditsUrl;
    if (!account.reached) {
      status.textContent = "Can't reach the img2img server";
    } else if (accountCredits !== null) {
      status.textContent = `${accountCredits} credit${accountCredits === 1 ? '' : 's'} left`;
      if (accountCredits <= 5 && creditsUrl) {
        const link = Object.assign(document.createElement('a'), { href: '#', textContent: 'Buy credits' });
        link.addEventListener('click', e => { e.preventDefault(); openCreditsPage(); });
        status.append(' · ', link);
      }
    } else {
      status.textContent = account.error;
    }
    showCreditBadge();
  }

  // A spinner while the balance loads, then the balance: red at 5 or fewer, orange up to 20, green above. Only
  // while images go to the img2img server, and hidden when the balance can't be read.
  function showCreditBadge() {
    const badge = document.getElementById('creditBadge');
    badge.hidden = processingMode.value !== 'server' || (!accountLoading && !Number.isFinite(accountCredits));
    if (badge.hidden) return;
    badge.className = 'credit-badge';
    if (accountLoading) {
      badge.classList.add('credit-loading');
      badge.replaceChildren(Object.assign(document.createElement('img'), { className: 'credit-spinner', src: 'icons/spinner.svg', alt: '' }));
      badge.title = 'Checking your credits';
      return;
    }
    badge.textContent = `${accountCredits} credit${accountCredits === 1 ? '' : 's'}`;
    badge.title = creditsUrl ? 'Credits left on your img2img account: click to buy more' : 'Credits left on your img2img account';
    badge.classList.toggle('credit-link', Boolean(creditsUrl));
    badge.classList.toggle('credit-low', accountCredits <= 5);
    badge.classList.toggle('credit-medium', accountCredits > 5 && accountCredits <= 20);
  }

  function openCreditsPage() {
    if (creditsUrl) {
      chrome.tabs.create({ url: creditsUrl });
    }
  }
  document.getElementById('creditBadge').addEventListener('click', openCreditsPage);

  // My ComfyUI users agree to the terms once, here (TERMS_VERSION in shared/workflows.js); hosted users agreed at
  // sign-up on the site. Until they do, the selection buttons refuse and the content script won't process.
  let termsAgreedVersion = null;
  const termsCard = document.getElementById('termsCard');
  const termsCheckbox = document.getElementById('termsCheckbox');
  const termsAgree = document.getElementById('termsAgree');
  document.getElementById('termsLink').href = TERMS_URL;
  document.getElementById('acceptableUseLink').href = ACCEPTABLE_USE_URL;
  const needsTermsAgreement = () => processingMode.value === 'local' && termsAgreedVersion !== TERMS_VERSION;
  function showTermsCard() {
    termsCard.hidden = !needsTermsAgreement();
  }
  chrome.storage.local.get('termsAgreedVersion', result => {
    termsAgreedVersion = result.termsAgreedVersion || null;
    showTermsCard();
  });
  termsCheckbox.addEventListener('change', () => { termsAgree.disabled = !termsCheckbox.checked; });
  termsAgree.addEventListener('click', () => {
    termsAgreedVersion = TERMS_VERSION;
    chrome.storage.local.set({ termsAgreedVersion, termsAgreedAt: new Date().toISOString() });
    showTermsCard();
    showStatus('Thanks: you can start now', 'success');
  });

  // Site access: Chrome grants host_permissions at install, but Firefox users can withhold or revoke them, and
  // without them the content script doesn't run and ComfyUI can't be reached
  const siteAccessCard = document.getElementById('siteAccessCard');
  const siteAccess = { origins: chrome.runtime.getManifest().host_permissions };
  const siteAccessChecked = chrome.permissions.contains(siteAccess).then(granted => { siteAccessCard.hidden = granted; });
  document.getElementById('siteAccessAllow').addEventListener('click', () => {
    // (Firefox only allows the request straight from the click, before any await)
    chrome.permissions.request(siteAccess).then(granted => {
      siteAccessCard.hidden = granted;
      if (granted) showStatus('Thanks: reload a page to use img2img on it', 'success');
    });
  });

  // The address is set on the settings page; the popup only says which one My ComfyUI will use
  function showComfyServer() {
    chrome.storage.local.get('comfyServerAddress', ({ comfyServerAddress }) => {
      document.getElementById('comfyServerHint').textContent =
        `${comfyServerAddress || 'http://127.0.0.1:8188'} (change it in All settings)`;
    });
  }
  showComfyServer();
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.comfyServerAddress) showComfyServer();
  });

  function showProcessingSettings() {
    // The preprocessors and upscale models come from the img2img server or from ComfyUI
    controlnetListReady = null;
    upscaleModelsReady = null;
    document.getElementById('img2imgApiKeyGroup').hidden = processingMode.value !== 'server';
    document.getElementById('devServerGroup').hidden = processingMode.value !== 'server' || !isDevelopmentInstall;
    document.getElementById('comfyServerGroup').hidden = processingMode.value === 'server';
    // My workflows run on the user's own ComfyUI only
    document.getElementById('manageWorkflows').hidden = processingMode.value === 'server';
    showTermsCard();
    showCreditBadge();
    showWorkflowSettings();
  }
  // Development installs can use a local server instead of the live API (see img2imgServer in background.js),
  // each with its own key: the key field shows and saves the one for the server in use
  const devServer = document.getElementById('devServer');
  let isDevelopmentInstall = false;
  const apiKeyName = () => (isDevelopmentInstall && devServer.value === 'local' ? 'img2imgLocalApiKey' : 'img2imgApiKey');
  let processingRestored;
  let processingModeKnown = false;
  const processingReady = new Promise(resolve => { processingRestored = resolve; });
  chrome.management.getSelf(self => {
    isDevelopmentInstall = self.installType === 'development';
    chrome.storage.local.get(['processingMode', 'img2imgApiKey', 'img2imgLocalApiKey', 'devServer'], result => {
      // The img2img server unless My ComfyUI was chosen (same rule as content.js)
      processingMode.value = result.processingMode === 'local' ? 'local' : 'server';
      processingModeKnown = true;
      devServer.value = result.devServer === 'local' ? 'local' : 'live';
      img2imgApiKey.value = result[apiKeyName()] || '';
      maskApiKey();
      showProcessingSettings();
      refreshAccount();
      processingRestored();
    });
  });
  processingMode.addEventListener('change', () => {
    chrome.storage.local.set({ processingMode: processingMode.value });
    showProcessingSettings();
  });
  devServer.addEventListener('change', () => {
    chrome.storage.local.set({ devServer: devServer.value }, () => {
      chrome.storage.local.get(apiKeyName(), result => {
        img2imgApiKey.value = result[apiKeyName()] || '';
        maskApiKey();
        refreshAccount();
        refreshServerWorkflows();
      });
    });
  });
  // A key is hidden as soon as there is one, but an empty field stays a text field: Chrome draws a password
  // field's placeholder in the font it uses for the dots, which spaces the letters out and reads as gibberish
  function maskApiKey() {
    img2imgApiKey.type = img2imgApiKey.value ? 'password' : 'text';
  }
  img2imgApiKey.addEventListener('input', maskApiKey);
  // Saved for background.js, which adds it to each request to the server (content scripts never see it)
  img2imgApiKey.addEventListener('change', () => {
    chrome.storage.local.set({ [apiKeyName()]: img2imgApiKey.value.trim() }, refreshAccount);
  });



  // Show only the settings that apply to the selected workflow
  function showWorkflowSettings() {
    const workflow = workflowSelect.value;
    const local = document.getElementById('processingMode').value === 'local';
    const offeredSwapWorkflows = SWAP_WORKFLOWS.filter(name => serverWorkflows?.includes(name));
    // The other workflows are hidden too while images go to an img2img server that doesn't offer them (it
    // answered, so serverPreprocessors isn't null); if it can't be reached, they all stay listed
    const serverAnswered = serverPreprocessors !== null;
    const notOnServer = name => !local && serverAnswered && !serverWorkflows.includes(name);
    for (const option of workflowSelect.options) {
      if (isCustomWorkflow(option.value)) {
        // The user's own workflows run only on their ComfyUI
        option.disabled = !local;
        option.dataset.label ??= option.textContent;
        option.textContent = local ? option.dataset.label : `${option.dataset.label} (My ComfyUI)`;
      } else if (SWAP_WORKFLOWS.includes(option.value)) {
        const offered = offeredSwapWorkflows.includes(option.value);
        option.hidden = !offered;
        option.disabled = !offered || local;
        option.dataset.label ??= option.textContent;
        option.textContent = offered && local ? `${option.dataset.label} (img2img server)` : option.dataset.label;
      } else {
        // One the img2img server doesn't offer (yet) stays listed for My ComfyUI, like the user's own workflows, so a
        // choice saved for My ComfyUI (or before the server offered it) isn't replaced
        const unavailable = notOnServer(option.value);
        option.disabled = unavailable;
        option.dataset.label ??= option.textContent;
        option.textContent = unavailable ? `${option.dataset.label} (My ComfyUI)` : option.dataset.label;
      }
    }
    // A hidden workflow can't stay selected (a dropdown still shows its selected option): e.g. one chosen when a
    // server offered it. Once it's known what's offered, the default (or the first workflow left) takes over. Not
    // before the Processing setting is restored: until then the dropdown shows img2img server, even for My ComfyUI.
    if (workflowSelect.selectedOptions[0]?.hidden && processingModeKnown && (local || serverAnswered)) {
      const usable = [...workflowSelect.options].filter(option => !option.hidden && !option.disabled);
      const replacement = usable.find(option => option.value === DEFAULT_WORKFLOW) || usable[0];
      if (replacement) {
        workflowSelect.value = replacement.value;
        chrome.storage.local.set({ workflow: replacement.value });
        popupWorkflowChosen();
        showWorkflowSettings();
        return;
      }
    }
    renderWorkflowPicker();
    // The other workflows have none of the face settings, only their own section and a description
    const usesSwap = SWAP_WORKFLOWS.includes(workflow);
    const swapWorkflowOffered = offeredSwapWorkflows.includes(workflow);
    const custom = isCustomWorkflow(workflow);
    // One of the user's own workflows with source inputs uses the Source grid too
    const customSources = custom && local && customSourceNodes().length > 0;
    // A background replaced by an image uses the image selected in the Source grid
    const sourceBackground = usesSourceImage({ workflow, backgroundMode: backgroundMode.value });
    document.getElementById('sourceStage').hidden = !(usesSwap && swapWorkflowOffered) && !customSources && !sourceBackground;
    for (const [name, sectionId] of Object.entries(WORKFLOW_SECTIONS)) {
      document.getElementById(sectionId).hidden = workflow !== name;
    }
    document.getElementById('customSettings').hidden = !custom || !local;
    const hintText = custom ? (local ? CUSTOM_WORKFLOW_HINT : CUSTOM_ON_SERVER_HINT)
      : notOnServer(workflow) ? SERVER_UNAVAILABLE_HINT
      : WORKFLOW_HINTS[workflow];
    const typicalWait = !local && hintText === WORKFLOW_HINTS[workflow] && Number.isFinite(serverTypicalWaits[workflow])
      ? typicalWaitHint(serverTypicalWaits[workflow]) : '';
    const hint = document.getElementById('workflowHint');
    hint.textContent = hintText ? hintText + typicalWait : '';
    hint.hidden = !hintText;
    if (custom) {
      renderCustomSettings();
    } else if (workflow === 'controlnet') {
      showControlnetSettings();
    } else if (workflow === 'upscale') {
      showUpscaleModels();
    }
    document.getElementById('backgroundColorGroup').hidden = !['color', 'gradient'].includes(backgroundMode.value);
    document.getElementById('backgroundColorLabel').textContent = backgroundMode.value === 'gradient' ? 'Top Colour' : 'Colour';
    document.getElementById('backgroundColor2Group').hidden = backgroundMode.value !== 'gradient';
    document.getElementById('backgroundBlurGroup').hidden = backgroundMode.value !== 'blur';
  }

  // Whether processing needs the source selected in the grid: a workflow with a source, a background replaced by
  // an image, or one of the user's own workflows with a source input that follows the grid
  function workflowNeedsSource() {
    const id = customWorkflowId(workflowSelect.value);
    return SWAP_WORKFLOWS.includes(workflowSelect.value)
      || usesSourceImage({ workflow: workflowSelect.value, backgroundMode: backgroundMode.value })
      || customSourceNodes().some(group => !customWorkflowValues[id]?.[`source:${group.key}`]);
  }

  // The selected custom workflow's source pickers (sourceGroups: one per group of Load Image nodes)
  function customSourceNodes() {
    const id = customWorkflowId(workflowSelect.value);
    return sourceGroups(customWorkflows.find(item => item.id === id));
  }

  // The upscale model list (filled in once per source): the models the img2img server offers, or the ones in
  // ComfyUI's models/upscale_models. A saved model that isn't on the list is replaced (and saved) by the default.
  let upscaleModelsReady = null;
  function showUpscaleModels() {
    upscaleModelsReady ??= (async () => {
      let models;
      if (document.getElementById('processingMode').value === 'local') {
        const spec = (await getComfyNodeInfo('UpscaleModelLoader'))?.input?.required?.model_name;
        // (not the restoration models, which are in models/upscale_models too)
        models = (spec ? (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options || []) : []).filter(model => !RESTORATION_MODELS.includes(model));
      } else {
        await serverWorkflowsReady;
        models = serverUpscaleModels || [];
      }
      const wanted = upscaleModel.dataset.saved || UPSCALE_DEFAULT_MODEL;
      upscaleModel.replaceChildren(...(models.length ? models : [wanted]).map(name => new Option(name.replace(/\.(pth|safetensors|pt|bin|ckpt)$/, ''), name)));
      upscaleModel.value = models.includes(wanted) ? wanted : (models.includes(UPSCALE_DEFAULT_MODEL) ? UPSCALE_DEFAULT_MODEL : upscaleModel.options[0]?.value);
      if (models.length && upscaleModel.value !== wanted) {
        upscaleModel.dataset.saved = upscaleModel.value;
        chrome.storage.local.set({ upscaleModel: upscaleModel.value });
      }
    })();
  }

  // ComfyUI's description of a node (its inputs), or null when it isn't installed or ComfyUI can't be reached
  const comfyNodeInfo = new Map();
  async function getComfyNodeInfo(nodeClass) {
    if (!comfyNodeInfo.has(nodeClass)) {
      comfyNodeInfo.set(nodeClass, chrome.runtime.sendMessage({ action: 'comfyRequest', url: `/object_info/${encodeURIComponent(nodeClass)}`, method: 'GET' })
        .then(response => (response?.success && response.data[nodeClass]) || null)
        .catch(() => null));
    }
    return comfyNodeInfo.get(nodeClass);
  }

  function showControlnetStatus(message) {
    const status = document.getElementById('controlnetStatus');
    status.textContent = message || '';
    status.hidden = !message;
  }

  // A preprocessor's description (inputs) from where images are processed: the ones the img2img server offers,
  // or the ones installed in ComfyUI. Null when it isn't offered or can't be read.
  async function getPreprocessorInfo(nodeClass) {
    if (document.getElementById('processingMode').value === 'local') {
      return getComfyNodeInfo(nodeClass);
    }
    await serverWorkflowsReady;
    return serverPreprocessors?.[nodeClass] ?? null;
  }

  // Fill the preprocessor list (once per source) with the offered or installed ones, then show the selected
  // one's options
  let controlnetListReady = null;
  function showControlnetSettings() {
    controlnetListReady ??= (async () => {
      const available = await Promise.all(CONTROLNET_PREPROCESSORS.map(([nodeClass]) => getPreprocessorInfo(nodeClass)));
      const local = document.getElementById('processingMode').value === 'local';
      // If ComfyUI or the img2img server can't be reached, list them all rather than none
      const reachable = local ? available.some(Boolean) : serverPreprocessors !== null;
      const groups = new Map();
      CONTROLNET_PREPROCESSORS.forEach(([nodeClass, label, group], index) => {
        if (reachable && !available[index]) return;
        if (!groups.has(group)) {
          groups.set(group, document.createElement('optgroup'));
          groups.get(group).label = group;
        }
        groups.get(group).append(new Option(label, nodeClass));
      });
      controlnetPreprocessor.replaceChildren(...groups.values());
      controlnetPreprocessor.value = controlnetPreprocessor.dataset.saved;
      if (!controlnetPreprocessor.value) {
        controlnetPreprocessor.value = CONTROLNET_DEFAULT_PREPROCESSOR;
      }
      showControlnetStatus(reachable ? '' : `Couldn't reach ${local ? 'ComfyUI' : 'the img2img server'} to read the preprocessors' options.`);
    })();
    controlnetListReady.then(renderControlnetOptions);
  }

  // A ComfyUI input spec as a control description, or null for inputs this popup doesn't offer
  function describeInput(spec) {
    const [type, config = {}] = spec;
    if (Array.isArray(type)) {
      return { kind: 'choice', options: type, default: config.default ?? type[0] };
    }
    if (type === 'COMBO') {
      return { kind: 'choice', options: config.options || [], default: config.default ?? config.options?.[0] };
    }
    if (type === 'INT' || type === 'FLOAT') {
      const step = config.step ?? (type === 'INT' ? 1 : 0.01);
      return { kind: 'number', min: config.min ?? 0, max: config.max ?? 100, step, default: config.default ?? config.min ?? 0 };
    }
    if (type === 'BOOLEAN') {
      return { kind: 'choice', options: [true, false], default: config.default ?? false };
    }
    return null;
  }

  // "low_threshold" -> "Low threshold"; enable/disable and true/false read as On/Off
  const prettyName = name => name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
  const prettyChoice = value => ({ enable: 'On', disable: 'Off', true: 'On', false: 'Off' })[String(value)] ?? String(value);

  // What the popup calls one of a text setting's own choices
  const pickName = option => option === PICK_NONE ? 'None' : option;

  function formatNumber(value, step) {
    const decimals = (String(step).split('.')[1] || '').length;
    return Number(value).toFixed(decimals);
  }

  function saveControlnetOption(nodeClass, name, value) {
    controlnetOptions = { ...controlnetOptions, [nodeClass]: { ...controlnetOptions[nodeClass], [name]: value } };
    chrome.storage.local.set({ controlnetOptions });
  }

  // Heights the text boxes were resized to, in textareaHeights[sizeKey] (px). Kept apart from the settings
  // values, so resizing a box doesn't count as a settings change for the cache.
  function keepTextareaHeight(box, sizeKey) {
    let savedHeight = null;
    chrome.storage.local.get('textareaHeights', ({ textareaHeights = {} }) => {
      savedHeight = textareaHeights[sizeKey] ?? null;
      if (savedHeight) box.style.height = `${savedHeight}px`;
      let timer = null;
      new ResizeObserver(() => {
        const height = box.offsetHeight;
        // (0 while the box is hidden, e.g. another workflow's settings are showing)
        if (!height || height === savedHeight) return;
        // The first size seen is the box's own, not a resize
        if (savedHeight === null) {
          savedHeight = height;
          return;
        }
        clearTimeout(timer);
        timer = setTimeout(() => {
          savedHeight = height;
          chrome.storage.local.get('textareaHeights', ({ textareaHeights = {} }) => {
            chrome.storage.local.set({ textareaHeights: { ...textareaHeights, [sizeKey]: height } });
          });
        }, 300);
      }).observe(box);
    });
  }

  // A labelled control for one setting: a slider for numbers (a number box when the range is huge or
  // unknown), a dropdown for choices, a switch for on/off and a text box for text; a text setting with words of
  // its own gets a dropdown of them, or a slider that steps through them. onSave gets the new value.
  // A multiline text box with a sizeKey keeps the height it's resized to (see keepTextareaHeight).
  function createSettingControl(labelText, input, value, onSave, sizeKey = null) {
    const group = document.createElement('div');
    group.className = 'settings-group';
    const label = document.createElement('label');
    label.className = 'settings-label';
    label.textContent = labelText;
    group.append(label);
    const bounded = Number.isFinite(input.min) && Number.isFinite(input.max);

    if (input.kind === 'number' && (!bounded || (input.max - input.min) / input.step > 2000)) {
      const box = document.createElement('input');
      Object.assign(box, { type: 'number', step: input.step, value });
      if (Number.isFinite(input.min)) box.min = input.min;
      if (Number.isFinite(input.max)) box.max = input.max;
      box.className = 'controlnet-number';
      box.addEventListener('change', () => {
        let number = Number(box.value);
        if (!Number.isFinite(number)) number = value;
        number = Math.min(input.max ?? Infinity, Math.max(input.min ?? -Infinity, number));
        box.value = number;
        onSave(number);
      });
      group.append(box);
    } else if (input.kind === 'number') {
      const slider = document.createElement('input');
      Object.assign(slider, { type: 'range', min: input.min, max: input.max, step: input.step, value });
      const shown = document.createElement('span');
      shown.className = 'range-value';
      shown.textContent = formatNumber(value, input.step);
      slider.addEventListener('input', () => { shown.textContent = formatNumber(slider.value, input.step); });
      slider.addEventListener('change', () => onSave(Number(slider.value)));
      group.append(slider, shown);
    } else if (input.kind === 'pick' && input.slider) {
      // A slider over the setting's own choices, from None through them in the order they were written (its own
      // None, where it has one, stays where it was written)
      const picks = pickList(input);
      const slider = document.createElement('input');
      Object.assign(slider, { type: 'range', min: 0, max: picks.length - 1, step: 1, value: Math.max(0, picks.indexOf(value)) });
      const shown = document.createElement('span');
      shown.className = 'range-value';
      shown.textContent = pickName(picks[slider.value]);
      slider.addEventListener('input', () => { shown.textContent = pickName(picks[slider.value]); });
      slider.addEventListener('change', () => onSave(picks[slider.value]));
      group.append(slider, shown);
    } else if (input.kind === 'toggle') {
      const row = document.createElement('label');
      row.className = 'switch';
      const checkbox = document.createElement('input');
      checkbox.type = 'checkbox';
      checkbox.checked = Boolean(value);
      const knob = document.createElement('span');
      knob.className = 'slider round';
      checkbox.addEventListener('change', () => onSave(checkbox.checked));
      row.append(checkbox, knob);
      group.append(row);
    } else if (input.kind === 'text') {
      const box = document.createElement(input.multiline ? 'textarea' : 'input');
      box.className = 'setting-text';
      if (input.multiline) box.rows = 4;
      box.value = value ?? '';
      // Saved as it's typed: the popup can close before the box loses focus (a click on the page, or the browser's
      // download bubble taking the focus), and a change event never comes then
      box.addEventListener('input', () => onSave(box.value));
      box.addEventListener('change', () => onSave(box.value));
      group.append(box);
      if (input.multiline && sizeKey) keepTextareaHeight(box, sizeKey);
    } else {
      const select = document.createElement('select');
      // (a setting's own choices come after None, and are shown as they were written)
      const options = input.kind === 'pick' ? pickList(input) : input.options;
      options.forEach((option, index) => select.append(new Option(input.kind === 'pick' ? pickName(option) : prettyChoice(option), index)));
      select.value = Math.max(0, options.indexOf(value));
      select.addEventListener('change', () => onSave(options[select.value]));
      group.append(select);
    }
    return group;
  }

  // One control per preprocessor option. The image and resolution are set by the workflow, so they aren't shown.
  async function renderControlnetOptions() {
    const nodeClass = controlnetPreprocessor.value;
    const container = document.getElementById('controlnetOptions');
    const info = await getPreprocessorInfo(nodeClass);
    if (controlnetPreprocessor.value !== nodeClass) return; // changed while loading
    container.replaceChildren();
    if (!info) return;
    const saved = controlnetOptions[nodeClass] || {};
    for (const [name, spec] of Object.entries({ ...info.input.required, ...info.input.optional })) {
      const input = name === 'resolution' ? null : describeInput(spec);
      if (!input) continue;
      container.append(createSettingControl(prettyName(name), input, saved[name] ?? input.default, value => saveControlnetOption(nodeClass, name, value)));
    }
  }

  // The user's own workflows, listed under "My workflows" in the workflow choice
  const customWorkflowNames = () => customWorkflows.map(definition => `${CUSTOM_WORKFLOW_PREFIX}${definition.id}`);
  function renderCustomWorkflowOptions() {
    workflowSelect.querySelector('#customWorkflowGroup')?.remove();
    if (!customWorkflows.length) return;
    const group = document.createElement('optgroup');
    group.id = 'customWorkflowGroup';
    group.label = 'My workflows';
    for (const definition of customWorkflows) {
      group.append(new Option(definition.name, `${CUSTOM_WORKFLOW_PREFIX}${definition.id}`));
    }
    workflowSelect.append(group);
  }

  // The selected workflow's settings, as chosen on the My workflows page, with the values saved here. Its
  // source inputs come first: each takes the source selected in the grid, or one picked for it here.
  let customRender = 0;
  // (the presets: see showPresets)
  const presetsButton = document.getElementById('customPresetsOpen');
  // The workflow whose presets are listed, or null while its Options show; and the preset form's state while its
  // modal is open, { definition, preset (null for a new one), draft: { key: value }, ticked: Set of keys }
  let presetsOf = null;
  let presetForm = null;
  async function renderCustomSettings() {
    const render = ++customRender;
    const id = customWorkflowId(workflowSelect.value);
    const definition = customWorkflows.find(item => item.id === id);
    const sources = definition?.sourceNodes?.length ? await getAllSources().catch(() => []) : [];
    if (render !== customRender) return; // changed while loading
    const container = document.getElementById('customOptions');
    const status = document.getElementById('customStatus');
    const settings = definition?.settings || [];
    status.textContent = !definition ? 'This workflow was deleted: pick another one.'
      : !settings.length && !definition.sourceNodes?.length ? 'No settings chosen for this workflow. Choose some on the My workflows page.' : '';
    status.hidden = !status.textContent;
    presetsButton.hidden = !definition || !workflowValueKeys(definition).length;
    // Another workflow's presets were open: this one's Options show
    if (presetsOf !== null && (presetsOf !== id || presetsButton.hidden)) showCustomView('options');
    if (!definition) {
      container.replaceChildren();
      return;
    }
    const save = (key, newValue) => {
      customWorkflowValues = { ...customWorkflowValues, [id]: { ...customWorkflowValues[id], [key]: newValue } };
      chrome.storage.local.set({ customWorkflowValues });
    };
    container.replaceChildren(...customControls(definition, customWorkflowValues[id] || {}, sources, save).map(entry => entry.control));
  }

  // The keys of every value the popup saves for a custom workflow, in the order of its controls (see customControls)
  function workflowValueKeys(definition) {
    const keys = sourceGroups(definition).map(group => `source:${group.key}`);
    for (const setting of definition?.settings || []) {
      keys.push(settingKey(setting));
      if (setting.seed && setting.kind !== 'bypass') keys.push(randomSeedKey(setting));
    }
    return keys;
  }

  // A custom workflow's controls, showing the values given, with save(key, value) called on each change: a picker
  // for each source, then its settings in their order, a seed's "New seed each time" under it. Each comes as
  // { key, control, value }, value being what the control shows, as it's saved. The Options and the preset form
  // both build theirs here.
  function customControls(definition, saved, sources, save) {
    const entries = [];
    for (const group of sourceGroups(definition)) {
      const key = `source:${group.key}`;
      const choices = ['', ...sources.map(source => source.id)];
      const names = { '': 'The source selected above', ...Object.fromEntries(sources.map(source => [source.id, source.name])) };
      const value = choices.includes(saved[key]) ? saved[key] : '';
      const picker = createSettingControl(group.label, { kind: 'choice', options: choices }, value, newValue => save(key, newValue));
      picker.querySelectorAll('option').forEach(option => { option.textContent = names[choices[option.value]] ?? option.textContent; });
      const uses = group.nodes.length > 1 ? `Uses the source's first ${group.nodes.length} images (its last one again if it has fewer)`
        : group.batch ? "Uses all of the source's images" : "Uses the source's first image";
      picker.title = uses;
      picker.append(Object.assign(document.createElement('div'), { className: 'workflow-hint', textContent: uses }));
      entries.push({ key, control: picker, value });
    }
    // The settings of a node that's switched off are put away with it: they'd change nothing
    const settings = definition.settings || [];
    const off = new Set(settings.filter(setting => setting.kind === 'bypass' && nodeSwitchedOff(definition, setting, saved)).map(setting => String(setting.node)));
    const ofNode = (control, node) => {
      control.dataset.node = node;
      control.hidden = off.has(String(node));
    };
    for (const setting of settings) {
      const key = settingKey(setting);
      if (setting.kind === 'bypass') {
        // A node's switch: on unless it was turned off here, or is off in the workflow file and wasn't turned on here
        // (what's saved is whether the node is left out)
        const value = nodeSwitchedOff(definition, setting, saved);
        const control = createSettingControl(setting.label, { kind: 'toggle' }, !value, checked => {
          save(key, !checked);
          for (const other of entries) {
            if (other.control.dataset.node === String(setting.node)) other.control.hidden = !checked;
          }
        });
        control.classList.add('node-switch');
        entries.push({ key, control, value });
        continue;
      }
      const value = settingValue(setting, saved[key], definition.graph[setting.node]?.inputs[setting.input]);
      const control = createSettingControl(setting.label, setting, value, newValue => save(key, newValue), `${definition.id}.${key}`);
      ofNode(control, setting.node);
      entries.push({ key, control, value });
      if (setting.seed) {
        // A seed can be a new random number for each image instead (the number box is then unused)
        const randomKey = randomSeedKey(setting);
        const number = control.querySelector('input');
        const random = saved[randomKey] === true;
        number.disabled = random;
        const toggle = createSettingControl('New seed each time', { kind: 'toggle' }, random, checked => {
          number.disabled = checked;
          save(randomKey, checked);
        });
        toggle.classList.add('seed-random');
        ofNode(toggle, setting.node);
        entries.push({ key: randomKey, control: toggle, value: random });
      }
    }
    return entries;
  }

  // Presets: values for some of a custom workflow's settings, kept in customWorkflowPresets[id] as
  // [{ id, name, values }], values under the keys customWorkflowValues uses. Applying one puts its values in with the
  // popup's own; which one was applied isn't shown, as the settings can be changed after it, or by another preset.
  // The My workflows page carries them over with the values when a workflow's file is replaced.

  // 'options' or 'list' (the presets; adding or editing one opens the preset modal over them)
  function showCustomView(view) {
    document.getElementById('customOptionsView').hidden = view !== 'options';
    document.getElementById('customPresets').hidden = view !== 'list';
    presetsOf = view === 'options' ? null : customWorkflowId(workflowSelect.value);
    if (view === 'options') hidePresetModal();
  }

  function hidePresetModal() {
    document.getElementById('presetModal').style.display = 'none';
    presetForm = null;
    document.getElementById('presetControls').replaceChildren();
  }

  const shownCustomWorkflow = () => customWorkflows.find(item => item.id === customWorkflowId(workflowSelect.value));

  async function loadPresets(id) {
    const { customWorkflowPresets = {} } = await chrome.storage.local.get('customWorkflowPresets');
    return Array.isArray(customWorkflowPresets[id]) ? customWorkflowPresets[id] : [];
  }

  async function savePresets(id, presets) {
    const { customWorkflowPresets = {} } = await chrome.storage.local.get('customWorkflowPresets');
    const all = { ...customWorkflowPresets };
    if (presets.length) all[id] = presets;
    else delete all[id];
    await chrome.storage.local.set({ customWorkflowPresets: all });
  }

  // A preset's values for the settings the workflow has now (one taken off the workflow keeps its value in the
  // preset, for when it's put back)
  function presetValues(definition, preset) {
    const keys = new Set(workflowValueKeys(definition));
    return Object.fromEntries(Object.entries(preset?.values || {}).filter(([key]) => keys.has(key)));
  }

  async function showPresets() {
    const definition = shownCustomWorkflow();
    if (!definition) {
      showCustomView('options');
      return;
    }
    const presets = await loadPresets(definition.id);
    if (shownCustomWorkflow() !== definition) return; // changed while loading
    document.getElementById('presetList').replaceChildren(...presets.map(preset => {
      const row = document.createElement('div');
      row.className = 'preset-row';
      const info = document.createElement('div');
      info.className = 'preset-info';
      const count = Object.keys(presetValues(definition, preset)).length;
      info.append(
        Object.assign(document.createElement('div'), { className: 'preset-name', textContent: preset.name, title: preset.name }),
        Object.assign(document.createElement('div'), {
          className: 'workflow-hint',
          textContent: count ? `Changes ${count} option${count === 1 ? '' : 's'}` : 'Changes nothing this workflow has now',
        }),
      );
      const action = (text, onClick, title = '') => {
        const button = Object.assign(document.createElement('button'), { className: 'link-button', textContent: text, title });
        button.addEventListener('click', onClick);
        return button;
      };
      row.append(
        info,
        action('Apply', () => applyPreset(definition, preset), 'Put these values in the Options'),
        action('Edit', () => openPresetForm(definition, preset)),
        action('Delete', async () => {
          if (!confirm(`Delete the preset "${preset.name}"?`)) return;
          await savePresets(definition.id, (await loadPresets(definition.id)).filter(item => item.id !== preset.id));
          showPresets();
        }),
      );
      return row;
    }));
    document.getElementById('presetsEmpty').hidden = presets.length > 0;
    showCustomView('list');
  }

  async function applyPreset(definition, preset) {
    const values = presetValues(definition, preset);
    customWorkflowValues = { ...customWorkflowValues, [definition.id]: { ...customWorkflowValues[definition.id], ...values } };
    await chrome.storage.local.set({ customWorkflowValues });
    showCustomView('options');
    renderCustomSettings();
  }

  // The form for a new preset (starting from the values in the Options, nothing ticked) or one to edit (its own
  // values over those, its settings ticked). Each setting has a tick that puts it in the preset; changing it ticks it.
  async function openPresetForm(definition, preset = null) {
    const sources = definition.sourceNodes?.length ? await getAllSources().catch(() => []) : [];
    const own = presetValues(definition, preset);
    const draft = {};
    const ticked = new Set(Object.keys(own));
    const rows = new Map();
    const tick = (key, on) => {
      const row = rows.get(key);
      row.box.checked = on;
      row.control.classList.toggle('preset-off', !on);
      if (on) ticked.add(key);
      else ticked.delete(key);
    };
    const entries = customControls(definition, { ...customWorkflowValues[definition.id], ...own }, sources, (key, value) => {
      draft[key] = value;
      tick(key, true);
    });
    for (const { key, control, value } of entries) {
      draft[key] = value;
      const box = Object.assign(document.createElement('input'), { type: 'checkbox', className: 'preset-tick', title: 'Part of this preset' });
      box.addEventListener('change', () => tick(key, box.checked));
      // (inside the label: a click on the setting's name ticks it too)
      control.querySelector('.settings-label').prepend(box);
      rows.set(key, { box, control });
      tick(key, ticked.has(key));
    }
    document.getElementById('presetControls').replaceChildren(...entries.map(entry => entry.control));
    document.getElementById('presetTitle').textContent = preset ? 'Edit Preset' : 'New Preset';
    document.getElementById('presetName').value = preset?.name || '';
    document.getElementById('presetError').hidden = true;
    document.getElementById('presetModal').style.display = 'block';
    document.getElementById('presetModal').scrollTop = 0;
    presetForm = { definition, preset, draft, ticked };
    document.getElementById('presetName').focus();
  }

  async function savePresetForm() {
    if (!presetForm) return;
    const { definition, preset, draft, ticked } = presetForm;
    const name = document.getElementById('presetName').value.trim();
    const error = document.getElementById('presetError');
    error.textContent = !name ? 'Give the preset a name.' : !ticked.size ? 'Tick at least one option for the preset to change.' : '';
    error.hidden = !error.textContent;
    if (error.textContent) return;
    // (in the order the settings show; values kept for settings the workflow doesn't have now stay)
    const keys = workflowValueKeys(definition);
    const kept = Object.fromEntries(Object.entries(preset?.values || {}).filter(([key]) => !keys.includes(key)));
    const values = { ...kept, ...Object.fromEntries(keys.filter(key => ticked.has(key)).map(key => [key, draft[key]])) };
    const presets = await loadPresets(definition.id);
    const edited = preset && presets.some(item => item.id === preset.id);
    await savePresets(definition.id, edited
      ? presets.map(item => item.id === preset.id ? { ...item, name, values } : item)
      : [...presets, { id: `p_${Date.now().toString(36)}`, name, values }]);
    hidePresetModal();
    showPresets();
  }

  presetsButton.addEventListener('click', event => {
    // (the heading's own click folds the section away: this opens it instead, where it was folded)
    event.stopPropagation();
    const stage = document.getElementById('customSettings');
    if (stage.classList.contains('collapsed')) stage.querySelector('.settings-stage').click();
    showPresets();
  });
  document.getElementById('presetsBack').addEventListener('click', () => showCustomView('options'));
  document.getElementById('presetAdd').addEventListener('click', () => {
    const definition = shownCustomWorkflow();
    if (definition) openPresetForm(definition);
  });
  document.getElementById('presetCancel').addEventListener('click', hidePresetModal);
  document.getElementById('presetClose').addEventListener('click', hidePresetModal);
  document.getElementById('presetSave').addEventListener('click', () => savePresetForm());
  document.getElementById('presetName').addEventListener('keydown', event => {
    if (event.key === 'Enter') savePresetForm();
  });
  // Presets carried over by the My workflows page (a replaced file) while they're listed here
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.customWorkflowPresets && !document.getElementById('customPresets').hidden) showPresets();
  });

  document.getElementById('manageWorkflows').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('workflows.html') });
  });

  document.getElementById('viewCache').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('cache.html') });
  });

  // The Library: the tab it is already open in, if there is one, so the folder open there isn't lost to a second tab
  document.getElementById('openLibrary').addEventListener('click', async () => {
    const url = chrome.runtime.getURL('library.html');
    const tabs = await chrome.tabs.query({}).catch(() => []);
    const open = tabs.find(tab => tab.url?.startsWith(url));
    if (!open) {
      chrome.tabs.create({ url });
      return;
    }
    await chrome.tabs.update(open.id, { active: true });
    await chrome.windows.update(open.windowId, { focused: true }).catch(() => {});
  });

  // The images waiting their turn, across every tab (background.js keeps the queue and says when it changes). Clear
  // Queue takes them all out; the ones already being processed finish.
  const queueRow = document.getElementById('queueRow');
  const queueCount = document.getElementById('queueCount');
  function showQueue(waiting) {
    queueRow.hidden = !waiting;
    queueCount.textContent = `${waiting} image${waiting === 1 ? '' : 's'} waiting`;
  }
  chrome.runtime.sendMessage({ action: 'queueStatus' }).then(response => showQueue(response?.waiting || 0), () => {});
  chrome.runtime.onMessage.addListener(request => {
    if (request.action === 'queueChanged') showQueue(request.waiting);
  });
  document.getElementById('clearQueue').addEventListener('click', async () => {
    const { cleared } = await chrome.runtime.sendMessage({ action: 'clearQueue' });
    showQueue(0);
    // Automatic Selection stops with it (the page would pick the same images again)
    if (selectAllButton.classList.contains('processing')) {
      selectAllButton.textContent = 'Automatic Selection';
      selectAllButton.classList.remove('processing');
      startButton.disabled = false;
      chrome.storage.local.set({ isProcessing: false });
    }
    showStatus(`${cleared} image${cleared === 1 ? '' : 's'} taken out of the queue`, 'success');
  });

  // Workflows added, changed or deleted on the My workflows page while the popup is open
  chrome.storage.onChanged.addListener(async (changes, areaName) => {
    if (areaName !== 'local' || !changes.customWorkflows) return;
    const selected = workflowSelect.value;
    customWorkflows = changes.customWorkflows.newValue || [];
    // The My workflows page moves a workflow's saved values along when its file is replaced
    customWorkflowValues = (await chrome.storage.local.get('customWorkflowValues')).customWorkflowValues || {};
    renderCustomWorkflowOptions();
    workflowSelect.value = selected;
    if (!workflowSelect.value) {
      // The selected workflow was deleted: back to the default
      workflowSelect.value = DEFAULT_WORKFLOW;
      chrome.storage.local.set({ workflow: workflowSelect.value });
    }
    showWorkflowSettings();
    // (a preset's count of settings is the workflow's)
    if (!document.getElementById('customPresets').hidden) showPresets();
  });

  controlnetPreprocessor.addEventListener('change', () => {
    chrome.storage.local.set({ controlnetPreprocessor: controlnetPreprocessor.value });
    renderControlnetOptions();
  });
  // The prompt is saved as it's typed too (as it's sent; the box is tidied once it's left): the popup can close before
  // the box loses focus, and a change event never comes then
  const segmentPromptInput = document.getElementById('segmentPrompt');
  segmentPromptInput.addEventListener('input', () => {
    chrome.storage.local.set({ segmentPrompt: segmentPrompt(segmentPromptInput.value) || SEGMENT_DEFAULTS.prompt });
  });
  for (const input of simpleInputs) {
    input.addEventListener('change', () => {
      if (input.id === 'transformVariation') {
        // A whole number from 1 (an emptied or odd entry goes back to a valid one)
        input.value = String(Math.min(999, Math.max(1, Math.round(Number(input.value)) || TRANSFORM_DEFAULTS.variation)));
      }
      if (input.id === 'segmentPrompt') {
        // Saved as it's sent; an emptied box goes back to the default
        input.value = segmentPrompt(input.value) || SEGMENT_DEFAULTS.prompt;
      }
      chrome.storage.local.set({ [input.id]: ['upscaleScale', 'transformVariation'].includes(input.id) ? Number(input.value) : input.value });
      showWorkflowSettings();
    });
  }
  controlnetResolution.addEventListener('change', () => {
    chrome.storage.local.set({ controlnetResolution: Number(controlnetResolution.value) });
  });

  // Handle workflow change
  workflowSelect.addEventListener('change', function() {
    chrome.storage.local.set({ workflow: this.value });
    popupWorkflowChosen();
    showCustomView('options');
    showWorkflowSettings();
  });

  // The workflow dropdown, drawn from workflowSelect (which keeps the choice, and whose options showWorkflowSettings
  // hides, disables and relabels): a native dropdown can't show images, and each workflow shows its credit cost with a
  // coin while images go to the img2img server
  const workflowCost = value => {
    const credits = serverCredits[value];
    if (processingMode.value !== 'server' || !Number.isFinite(credits)) return null;
    const cost = document.createElement('span');
    cost.className = 'workflow-cost';
    cost.title = `${credits} credit${credits === 1 ? '' : 's'} per image`;
    cost.append(Object.assign(document.createElement('img'), { src: 'icons/coin.svg', alt: '' }), String(credits));
    return cost;
  };
  const pickerContent = option => {
    const label = Object.assign(document.createElement('span'), { className: 'picker-label', textContent: option.textContent });
    const cost = option.disabled ? null : workflowCost(option.value);
    return cost ? [label, cost] : [label];
  };
  const pickerItems = () => [...pickerList.querySelectorAll('.picker-option:not([aria-disabled="true"])')];
  function renderWorkflowPicker() {
    const selected = workflowSelect.selectedOptions[0];
    pickerButton.replaceChildren(...(selected ? pickerContent(selected) : []));
    const credits = selected && !selected.disabled && pickerButton.querySelector('.workflow-cost')?.title;
    pickerButton.setAttribute('aria-label', `Workflow: ${selected?.textContent || ''}${credits ? `, ${credits}` : ''}`);
    if (!pickerList.hidden) fillPickerList();
  }
  function fillPickerList() {
    const items = [];
    const addOption = option => {
      if (option.hidden) return;
      const item = document.createElement('li');
      item.className = 'picker-option';
      item.id = `workflowOption-${option.value}`;
      item.dataset.value = option.value;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(option.selected));
      if (option.disabled) item.setAttribute('aria-disabled', 'true');
      item.append(...pickerContent(option));
      items.push(item);
    };
    for (const child of workflowSelect.children) {
      if (child.tagName === 'OPTGROUP') {
        items.push(Object.assign(document.createElement('li'), { className: 'picker-group', role: 'presentation', textContent: child.label }));
        [...child.children].forEach(addOption);
      } else {
        addOption(child);
      }
    }
    pickerList.replaceChildren(...items);
  }
  function setActivePickerItem(item) {
    for (const other of pickerList.querySelectorAll('.picker-option.active')) other.classList.remove('active');
    if (!item) return pickerList.removeAttribute('aria-activedescendant');
    item.classList.add('active');
    pickerList.setAttribute('aria-activedescendant', item.id);
    item.scrollIntoView({ block: 'nearest' });
  }
  function openWorkflowPicker() {
    fillPickerList();
    pickerList.hidden = false;
    pickerButton.setAttribute('aria-expanded', 'true');
    setActivePickerItem(pickerList.querySelector('.picker-option[aria-selected="true"]:not([aria-disabled="true"])') || pickerItems()[0]);
    pickerList.focus();
  }
  function closeWorkflowPicker(focusButton = true) {
    if (pickerList.hidden) return;
    pickerList.hidden = true;
    pickerButton.setAttribute('aria-expanded', 'false');
    if (focusButton) pickerButton.focus();
  }
  function chooseWorkflow(item) {
    closeWorkflowPicker();
    if (!item || item.getAttribute('aria-disabled') === 'true' || item.dataset.value === workflowSelect.value) return;
    workflowSelect.value = item.dataset.value;
    workflowSelect.dispatchEvent(new Event('change'));
  }
  pickerButton.addEventListener('click', () => (pickerList.hidden ? openWorkflowPicker() : closeWorkflowPicker()));
  pickerButton.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openWorkflowPicker();
    }
  });
  pickerList.addEventListener('keydown', event => {
    const items = pickerItems();
    const index = items.indexOf(pickerList.querySelector('.picker-option.active'));
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1, PageDown: index + 5, PageUp: index - 5 };
    if (event.key in moves) {
      event.preventDefault();
      setActivePickerItem(items[Math.min(items.length - 1, Math.max(0, moves[event.key]))]);
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      chooseWorkflow(items[index]);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeWorkflowPicker();
    } else if (event.key === 'Tab') {
      closeWorkflowPicker(false);
    } else if (event.key.length === 1 && /\S/.test(event.key)) {
      // Typing a letter goes to the next workflow starting with it
      const letter = event.key.toLowerCase();
      const next = [...items.slice(index + 1), ...items.slice(0, index + 1)].find(item => item.textContent.trim().toLowerCase().startsWith(letter));
      if (next) setActivePickerItem(next);
    }
  });
  pickerList.addEventListener('mousemove', event => {
    const item = event.target.closest('.picker-option:not([aria-disabled="true"])');
    if (item && !item.classList.contains('active')) setActivePickerItem(item);
  });
  pickerList.addEventListener('click', event => {
    const item = event.target.closest('.picker-option');
    if (item && item.getAttribute('aria-disabled') !== 'true') chooseWorkflow(item);
  });
  document.addEventListener('pointerdown', event => {
    if (!event.target.closest('#workflowPicker')) closeWorkflowPicker(false);
  });
  renderWorkflowPicker();

  // Handle percentage slider changes
  for (const [key, slider] of Object.entries(percentSliders)) {
    slider.addEventListener('input', () => { slider.nextElementSibling.textContent = slider.value + '%'; });
    slider.addEventListener('change', () => chrome.storage.local.set({ [key]: Number(slider.value) }));
  }

  // Show the popup once its saved state is applied (body.restoring in popup.html). Storage answers in the order
  // it's asked, so this last read comes back after the ones above; the settings, Processing, the site access card
  // and the sources come later, so they're waited for too. Never longer than REVEAL_LIMIT_MS: the sources come from
  // background.js, which can be slow to wake, and the settings don't wait for them. Never for the img2img server
  // (network).
  const REVEAL_LIMIT_MS = 800;
  const earlierReads = new Promise(resolve => chrome.storage.local.get('openSections', resolve));
  Promise.race([
    Promise.allSettled([earlierReads, settingsRestored, processingReady, siteAccessChecked, sourcesLoaded]),
    new Promise(resolve => setTimeout(resolve, REVEAL_LIMIT_MS)),
  ])
    // Two frames: the restored layout is drawn with transitions still off, then they come back
    .then(() => requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('restoring'))));
}); 