// FACE_WORKFLOWS, the ControlNet defaults and preprocessor list, and UPSCALE_DEFAULT_MODEL come from
// shared/workflows.js (loaded first).
// The workflows without a source face: their settings section, and the description shown under the workflow choice
const WORKFLOW_SECTIONS = { controlnet: 'controlnetSettings', upscale: 'upscaleSettings', background: 'backgroundSettings', restore: 'restoreSettings' };
const WORKFLOW_HINTS = {
  controlnet: "Replaces the image with a ControlNet preprocessor's map of it (edges, line art, depth, pose, segmentation...).",
  upscale: 'Makes the image larger and sharper with an upscale model.',
  background: 'Finds the subject with BiRefNet and removes, recolours or blurs the background.',
  restore: 'Sharpens and cleans up every face in the image (old or low-res photos), without swapping it.',
};
const SERVER_UNAVAILABLE_HINT = "This workflow isn't available on the img2img server yet: pick another one, or use My ComfyUI (Settings, Processing).";
const CUSTOM_WORKFLOW_HINT = 'One of your own workflows. It runs on your ComfyUI.';
const CUSTOM_ON_SERVER_HINT = 'My workflows run on your own ComfyUI: set Processing (under Settings) to My ComfyUI, or pick another workflow.';

document.addEventListener('DOMContentLoaded', function() {
  const startButton = document.getElementById('startSelection');
  const selectAllButton = document.getElementById('selectAllVisible');
  const statusDiv = document.getElementById('status');
  const faceGrid = document.getElementById('faceGrid');
  const autoProcessToggle = document.getElementById('autoProcessToggle');
  const autoRememberToggle = document.getElementById('autoRememberToggle');
  const addFaceButton = document.getElementById('addFace');
  const fileInput = document.getElementById('fileInput');
  const workflowAccordionHeader = document.getElementById('workflowAccordionHeader');
  const workflowAccordionContent = document.getElementById('workflowAccordionContent');
  const settingsAccordionHeader = document.getElementById('settingsAccordionHeader');
  const settingsAccordionContent = document.getElementById('settingsAccordionContent');
  const openInNewTabToggle = document.getElementById('openInNewTabToggle');
  const comfyServerAddress = document.getElementById('comfyServerAddress');
  const workflowSelect = document.getElementById('workflowSelect');
  // Range sliders stored as whole percentages; each shows its value in the span right after it
  const percentSliders = {
    backgroundBlur: document.getElementById('backgroundBlur'),
    restoreStrength: document.getElementById('restoreStrength'),
  };
  // Dropdowns and inputs of the simple workflows, saved under their id
  const upscaleModel = document.getElementById('upscaleModel');
  const backgroundMode = document.getElementById('backgroundMode');
  const restoreModel = document.getElementById('restoreModel');
  const simpleInputs = ['upscaleModel', 'upscaleScale', 'backgroundMode', 'backgroundColor', 'restoreModel'].map(id => document.getElementById(id));
  const controlnetPreprocessor = document.getElementById('controlnetPreprocessor');
  const controlnetResolution = document.getElementById('controlnetResolution');
  // Saved preprocessor options, by node class then input name (only the ones the user changed)
  let controlnetOptions = {};
  // The user's own workflows (My workflows page) and the values chosen for their settings, by workflow id
  let customWorkflows = [];
  let customWorkflowValues = {};

  // Modal elements
  const faceModal = document.getElementById('faceModal');
  const closeModal = document.querySelector('.close-modal');
  const faceNameInput = document.getElementById('faceNameInput');
  const facePreview = document.getElementById('facePreview');
  const previewImage = document.getElementById('previewImage');
  const sourceImagesGrid = document.getElementById('sourceImagesGrid');
  const addSourceImage = document.getElementById('addSourceImage');
  const cancelFace = document.getElementById('cancelFace');
  const saveFace = document.getElementById('saveFace');
  
  // Message a tab's content script. Tabs without one (chrome:// and extension pages, or pages loaded before
  // the extension was reloaded) fail with "Receiving end does not exist"; that's expected, so the error is
  // consumed and the callback gets undefined, the same as no reply.
  function sendToTab(tabId, message, callback) {
    chrome.tabs.sendMessage(tabId, message, response => {
      void chrome.runtime.lastError;
      if (callback) callback(response);
    });
  }

  let selectedFace = null;
  let currentSourceImages = [];
  let editingFaceId = null;
  const MAX_SOURCE_IMAGES = 5;
  let selectingImage = false;

  // Save face to IndexedDB
  async function saveFaceToDB(face) {
    try {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'saveFace', face }, response => {
          if (response.success) {
            console.log('Face saved successfully:', face.id);
            resolve();
          } else {
            console.error('Error saving face:', response.error);
            reject(new Error(response.error));
          }
        });
      });
    } catch (error) {
      console.error('Error in saveFaceToDB:', error);
      throw error;
    }
  }

  // Get all faces from IndexedDB, in the order they were dragged into (sourceOrder in storage, a list of ids);
  // faces not in it yet come last, oldest first
  // The sources, in the user's order. Rejects (never hangs) when background.js answers with an error, doesn't answer
  // (it couldn't be reached, or closed the message without a reply) or takes longer than FACES_TIMEOUT_MS.
  const FACES_TIMEOUT_MS = 4000;
  async function getAllFaces() {
    try {
      const { sourceOrder = [] } = await chrome.storage.local.get('sourceOrder');
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the extension took too long to answer')), FACES_TIMEOUT_MS);
        chrome.runtime.sendMessage({ action: 'getAllFaces' }, response => {
          clearTimeout(timer);
          if (chrome.runtime.lastError || !response) {
            reject(new Error(chrome.runtime.lastError?.message || 'no answer from the extension'));
          } else if (response.success && Array.isArray(response.faces)) {
            console.log('Retrieved all faces:', response.faces);
            const position = id => {
              const index = sourceOrder.indexOf(id);
              return index === -1 ? Infinity : index;
            };
            resolve(response.faces.map((face, index) => ({ face, index }))
              .sort((a, b) => position(a.face.id) - position(b.face.id) || a.index - b.index)
              .map(({ face }) => face));
          } else {
            console.error('Error retrieving faces:', response.error);
            reject(new Error(response.error || 'the sources could not be read'));
          }
        });
      });
    } catch (error) {
      console.error('Error in getAllFaces:', error);
      throw error;
    }
  }

  // Delete face from IndexedDB
  async function deleteFace(faceId) {
    try {
      return new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ action: 'deleteFace', faceId }, response => {
          if (response.success) {
            console.log('Face deleted successfully:', faceId);
            resolve();
          } else {
            console.error('Error deleting face:', response.error);
            reject(new Error(response.error));
          }
        });
      });
    } catch (error) {
      console.error('Error in deleteFace:', error);
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
  for (const [name, [header, content]] of Object.entries(accordions)) {
    header.addEventListener('click', () => {
      setSectionOpen(name, !content.classList.contains('active'));
      chrome.storage.local.get('openSections', ({ openSections = {} }) => {
        chrome.storage.local.set({ openSections: { ...openSections, [name]: content.classList.contains('active') } });
      });
    });
  }

  // Dev Auto-Reload: only offered for unpacked (development) installs
  const devAutoReloadRow = document.getElementById('devAutoReloadRow');
  const devAutoReloadToggle = document.getElementById('devAutoReloadToggle');
  chrome.management.getSelf(self => {
    devAutoReloadRow.hidden = self.installType !== 'development';
  });
  chrome.storage.local.get('devAutoReload', ({ devAutoReload }) => {
    devAutoReloadToggle.checked = devAutoReload === true;
  });
  devAutoReloadToggle.addEventListener('change', function() {
    chrome.storage.local.set({ devAutoReload: this.checked });
  });

  // Download-as-JPG toggle (on unless turned off), read by background.js when downloading
  const downloadAsJpgToggle = document.getElementById('downloadAsJpgToggle');
  chrome.storage.local.get('downloadAsJpg', ({ downloadAsJpg }) => {
    downloadAsJpgToggle.checked = downloadAsJpg !== false;
  });
  downloadAsJpgToggle.addEventListener('change', function() {
    chrome.storage.local.set({ downloadAsJpg: this.checked });
  });

  // Dark mode, shared with every extension page (shared/theme.js)
  const darkModeToggle = document.getElementById('darkModeToggle');
  darkModeToggle.checked = img2imgTheme.isDark();
  img2imgTheme.onChange(dark => { darkModeToggle.checked = dark; });
  darkModeToggle.addEventListener('change', () => img2imgTheme.setDark(darkModeToggle.checked));

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

  // Handle add face button click
  addFaceButton.addEventListener('click', function() {
    showFaceModal();
  });

  // Handle close modal
  closeModal.addEventListener('click', function() {
    hideFaceModal();
  });

  // Handle cancel button
  cancelFace.addEventListener('click', function() {
    hideFaceModal();
  });

  // Handle add source image button
  addSourceImage.addEventListener('click', function() {
    if (currentSourceImages.length >= MAX_SOURCE_IMAGES) {
      alert(`Maximum ${MAX_SOURCE_IMAGES} images allowed per face`);
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
        reader.onload = function(e) {
          const dataUrl = e.target.result;
          addSourceImageToGrid(dataUrl);
        };
        reader.readAsDataURL(file);
      });

      if (files.length > remainingSlots) {
        alert(`Only ${remainingSlots} more images can be added`);
      }
    }
  });

  // Handle save face button
  saveFace.addEventListener('click', async function() {
    if (currentSourceImages.length === 0) {
      alert('Please add at least one source image');
      return;
    }

    const faceName = faceNameInput.value.trim() || `Face ${Date.now()}`;
    const faceId = editingFaceId || 'face_' + Date.now();
    
    const face = {
      id: faceId,
      name: faceName,
      dataUrls: currentSourceImages,
      previewUrl: currentSourceImages[0]
    };

    try {
      console.log('Attempting to save face:', face);
      await saveFaceToDB(face);
      
      if (editingFaceId) {
        // Update existing face element
        const existingFace = document.querySelector(`.face-item[data-id="${faceId}"]`);
        if (existingFace) {
          existingFace.querySelector('img').src = face.previewUrl;
          existingFace.title = face.name;
          existingFace.querySelector('.image-count').textContent = face.dataUrls.length;
        }
      } else {
        // Create and add new face element to grid
        const faceElement = createFaceElement(faceId, faceName, currentSourceImages[0], currentSourceImages.length);
        faceGrid.insertBefore(faceElement, addFaceButton);
      }
      
      // Reset modal state
      resetFaceModal();
      hideFaceModal();
    } catch (error) {
      console.error('Error saving source:', error);
      alert('Failed to save source. Please try again.');
    }
  });

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

  // Function to show face modal
  function showFaceModal(faceId = null) {
    faceModal.style.display = 'block';
    editingFaceId = faceId;
    
    if (faceId) {
      // Edit mode
      document.getElementById('modalTitle').textContent = 'Edit Source';
      chrome.runtime.sendMessage({ action: 'getFace', faceId }, response => {
        if (response.success) {
          const faceData = getFaceData(response.face);
          faceNameInput.value = faceData.name;
          currentSourceImages = [...faceData.dataUrls];
          renderSourceImages();
        } else {
          console.error('Error loading face for editing:', response.error);
          alert('Failed to load face data. Please try again.');
          hideFaceModal();
        }
      });
    } else {
      // Create mode
      document.getElementById('modalTitle').textContent = 'Create New Source';
      resetFaceModal();
    }
  }

  // Function to hide face modal
  function hideFaceModal() {
    faceModal.style.display = 'none';
    editingFaceId = null;
    resetFaceModal();
  }

  // Function to reset face modal state
  function resetFaceModal() {
    faceNameInput.value = '';
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

  // Function to create face element
  function createFaceElement(faceId, faceName, previewUrl, imageCount) {
    const faceElement = document.createElement('div');
    faceElement.className = 'face-item';
    faceElement.dataset.id = faceId;
    faceElement.title = faceName;
    faceElement.draggable = true;

    const img = document.createElement('img');
    img.src = previewUrl;
    img.alt = faceName;
    img.draggable = false;

    // Drag onto another source to move it there; the new order is saved as sourceOrder
    faceElement.addEventListener('dragstart', function(e) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('application/x-img2img-source', faceId);
      faceElement.classList.add('dragging');
    });
    faceElement.addEventListener('dragend', () => faceElement.classList.remove('dragging'));
    faceElement.addEventListener('dragover', function(e) {
      if (!e.dataTransfer.types.includes('application/x-img2img-source')) return;
      e.preventDefault();
      faceElement.classList.add('drop-target');
    });
    faceElement.addEventListener('dragleave', () => faceElement.classList.remove('drop-target'));
    faceElement.addEventListener('drop', function(e) {
      e.preventDefault();
      faceElement.classList.remove('drop-target');
      const dragged = faceGrid.querySelector(`.face-item[data-id="${e.dataTransfer.getData('application/x-img2img-source')}"]`);
      if (!dragged || dragged === faceElement) return;
      const items = Array.from(faceGrid.querySelectorAll('.face-item'));
      // Moving forwards lands after the target, backwards before it
      faceGrid.insertBefore(dragged, items.indexOf(dragged) < items.indexOf(faceElement) ? faceElement.nextSibling : faceElement);
      chrome.storage.local.set({ sourceOrder: Array.from(faceGrid.querySelectorAll('.face-item'), item => item.dataset.id) });
      // A custom workflow's source pickers list the sources in this order too
      if (isCustomWorkflow(workflowSelect.value)) {
        renderCustomSettings();
      }
    });

    const editButton = document.createElement('button');
    editButton.textContent = 'E';  // Simple 'E' for Edit
    editButton.className = 'edit-face';
    editButton.addEventListener('click', function(e) {
      e.stopPropagation();
      showFaceModal(faceId);
    });
    
    const deleteButton = document.createElement('button');
    deleteButton.textContent = 'X';  // Simple 'X' for Delete
    deleteButton.className = 'delete-face';
    
    const countBadge = document.createElement('div');
    countBadge.className = 'image-count';
    countBadge.textContent = imageCount;
    
    faceElement.appendChild(img);
    faceElement.appendChild(editButton);
    faceElement.appendChild(deleteButton);
    faceElement.appendChild(countBadge);
    
    // Add click handler for face selection
    faceElement.addEventListener('click', function(e) {
      if (e.target !== deleteButton && e.target !== editButton) {
        selectFace(faceId);
      }
    });
    
    // Add click handler for delete button
    deleteButton.addEventListener('click', async function(e) {
      e.stopPropagation();
      if (confirm('Are you sure you want to delete this face?')) {
        try {
          await deleteFace(faceId);
          // Remove face element from grid
          faceElement.remove();
          // If deleted face was selected, clear selection
          if (faceId === selectedFace) {
            chrome.storage.local.remove('selectedFaceId');
          }
        } catch (error) {
          console.error('Error deleting face:', error);
          alert('Failed to delete face. Please try again.');
        }
      }
    });
    
    return faceElement;
  }

  // Helper function to get face data
  function getFaceData(face) {
    // Handle old face data structure
    if (face.dataUrl) {
      return {
        id: face.id,
        name: face.name || `Face ${face.id}`,
        dataUrls: [face.dataUrl],
        previewUrl: face.dataUrl
      };
    }
    // Handle new face data structure
    return {
      id: face.id,
      name: face.name || `Face ${face.id}`,
      dataUrls: face.dataUrls || [],
      previewUrl: face.previewUrl || (face.dataUrls && face.dataUrls[0]) || ''
    };
  }

  // Handle face selection
  function selectFace(faceId) {
    selectedFace = faceId;
    chrome.storage.local.set({ selectedFaceId: faceId });
    
    // Update UI to show selected face
    document.querySelectorAll('.face-item').forEach(item => {
      if (item.dataset.id === faceId) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }

  // Load saved faces and processing state
  // Restore the popup's settings, then show the sources. The settings come from storage and are applied at once; the
  // sources come from background.js, which can be slow to wake (or fail), so they're asked for at the same time and
  // filled in when they arrive. A failure shows in the status line: an alert would freeze the popup.
  let settingsApplied;
  const settingsRestored = new Promise(resolve => { settingsApplied = resolve; });
  async function loadFaces() {
    let facesError = null;
    // (one retry: the first message can fail while background.js is restarting)
    const facesRequest = getAllFaces()
      .catch(() => new Promise(resolve => setTimeout(resolve, 500)).then(getAllFaces))
      .catch(error => {
        facesError = error;
        return [];
      });
    try {
      const result = await new Promise(resolve => {
        chrome.storage.local.get(['selectedFaceId', 'isProcessing', 'autoProcess', 'autoRemember', 'comfyServerAddress', 'workflow', 'controlnetPreprocessor', 'controlnetResolution', 'controlnetOptions', 'upscaleModel', 'upscaleScale', 'backgroundMode', 'backgroundColor', 'backgroundBlur', 'restoreModel', 'restoreStrength', 'restoreFidelity', 'processingMode', 'openResultsInNewTab', 'customWorkflows', 'customWorkflowValues'], resolve);
      });
      
      const selectedFaceId = result.selectedFaceId;
      const storedIsProcessing = result.isProcessing || false;
      const autoProcess = result.autoProcess || false;
      const autoRemember = result.autoRemember || false;
      
      // Load saved settings
      if (comfyServerAddress) {
        if (result.comfyServerAddress) {
          comfyServerAddress.value = result.comfyServerAddress;
        } else {
          comfyServerAddress.value = 'http://127.0.0.1:8188';
        }
      }
      // Removed workflows map to their replacement (same table as content.js)
      const replacements = {};
      const workflow = replacements[result.workflow] || result.workflow;
      customWorkflows = result.customWorkflows || [];
      customWorkflowValues = result.customWorkflowValues || {};
      renderCustomWorkflowOptions();
      workflowSelect.value = [...FACE_WORKFLOWS, ...Object.keys(WORKFLOW_SECTIONS), ...customWorkflowNames()].includes(workflow) ? workflow : DEFAULT_WORKFLOW;
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
      // A restore model that's no longer offered (CodeFormer, GPEN) shows and saves as the default
      if (!RESTORE_MODELS.includes(restoreModel.value)) {
        restoreModel.value = RESTORE_DEFAULTS.model;
        chrome.storage.local.set({ restoreModel: restoreModel.value });
      }
      const legacyToggles = {};
      for (const [key, slider] of Object.entries(percentSliders)) {
        const value = result[key] ?? (legacyToggles[key] === false ? 0 : undefined);
        if (value !== undefined) {
          slider.value = value;
          slider.nextElementSibling.textContent = value + '%';
        }
      }
      showWorkflowSettings();
      openInNewTabToggle.checked = result.openResultsInNewTab === true;
      
      // Check actual processing status from content script
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        sendToTab(tabs[0].id, { action: 'checkProcessingStatus' }, function(response) {
          const isProcessing = response ? response.isProcessing : storedIsProcessing;
          // Manual Selection is on or off per tab: ask the tab (a tab without the content script isn't selecting)
          selectingImage = Boolean(response?.isSelecting);
          startButton.textContent = selectingImage ? 'Stop Selection' : 'Manual Selection';
          
          if (isProcessing) {
            selectAllButton.textContent = 'Stop Processing';
            selectAllButton.disabled = false;
            selectAllButton.classList.add('processing');
            startButton.disabled = true;
            showStatus('Continuous processing is active', 'processing');
          }
        });
      });
      
      // Update auto-process toggle state
      autoProcessToggle.checked = autoProcess;
      autoRememberToggle.checked = autoRemember;

      // Update UI based on processing state
      if (storedIsProcessing) {
        startButton.classList.add('active');
        selectAllButton.disabled = true;
        statusDiv.textContent = 'Processing';
      } else {
        startButton.classList.remove('active');
        selectAllButton.disabled = false;
        statusDiv.textContent = 'Not Processing';
      }
      settingsApplied();

      // Load saved faces
      const faces = await facesRequest;
      faces.forEach(face => {
        const faceData = getFaceData(face);
        const faceElement = createFaceElement(
          faceData.id,
          faceData.name,
          faceData.previewUrl,
          faceData.dataUrls.length
        );
        
        if (faceData.id === selectedFaceId) {
          faceElement.classList.add('selected');
        }
        
        faceGrid.insertBefore(faceElement, addFaceButton);
      });

      // If auto-process is enabled but no face is selected, select the first face
      if (autoProcess && !selectedFaceId && faces.length > 0) {
        selectFace(faces[0].id);
      }
      // A custom workflow's source pickers list the sources too
      if (isCustomWorkflow(workflowSelect.value)) {
        renderCustomSettings();
      }
      if (facesError) {
        throw facesError;
      }
    } catch (error) {
      console.error('Error loading faces:', error);
      showStatus(`Couldn't load your sources (${error.message}). Close and reopen the popup to try again.`, 'error');
    } finally {
      settingsApplied();
    }
  }

  // Initialize the popup
  const facesLoaded = loadFaces();

  // Export every source (name and images) to a .json file, and import such a file back. Sources live in the
  // extension's own IndexedDB, so this is how they move to another browser or survive a new extension ID.
  const SOURCES_EXPORT_FORMAT = 'img2img-sources';
  // Exports made before the rename from Swappix still import
  const SOURCES_IMPORT_FORMATS = [SOURCES_EXPORT_FORMAT, 'swappix-sources'];
  document.getElementById('exportSources').addEventListener('click', async () => {
    try {
      const sources = (await getAllFaces()).map(getFaceData);
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
        await saveFaceToDB({ id: source.id, name: String(source.name || source.id), dataUrls, previewUrl: dataUrls[0] });
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
    chrome.storage.local.get('selectedFaceId', function(result) {
      if (needsTermsAgreement()) {
        showStatus('Agree to the terms above first', 'error');
        return;
      }
      if (!result.selectedFaceId && workflowNeedsFace()) {
        showStatus('Please select a face first', 'error');
        return;
      }
      startButton.textContent = 'Stop Selection';
      chrome.tabs.query({active: true, currentWindow: true}, function(tabs) {
        sendToTab(tabs[0].id, { action: 'startSelection', selectedFaceId: result.selectedFaceId });
        window.close();
      });
    });
  });

  // Handle select all visible button
  selectAllButton.addEventListener('click', function() {
    chrome.storage.local.get('selectedFaceId', function(result) {
      if (needsTermsAgreement() && !selectAllButton.classList.contains('processing')) {
        showStatus('Agree to the terms above first', 'error');
        return;
      }
      if (!result.selectedFaceId && workflowNeedsFace()) {
        showStatus('Please select a face first', 'error');
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
          // Start processing
          sendToTab(tabs[0].id, { action: 'selectAllVisible', faceId: result.selectedFaceId });
          selectAllButton.textContent = 'Stop Processing';
          selectAllButton.classList.add('processing');
          showStatus('Continuous processing started', 'processing');
          startButton.disabled = true;
          chrome.storage.local.set({ isProcessing: true });
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
        chrome.storage.local.get(['selectedFaceId'], async function(result) {
          const faceId = result.selectedFaceId
          sendToTab(tabs[0].id, { action: 'autoRemember', faceId: faceId });
        });
        
      });
    }
  });

  // Function to show status messages
  function showStatus(message, type) {
    statusDiv.textContent = message;
    statusDiv.className = 'status ' + type;
  }

  // How many results the cache keeps; lowering it drops the oldest straight away
  const cacheSizeSelect = document.getElementById('cacheSize');
  chrome.storage.local.get('cacheSize', ({ cacheSize }) => {
    if (cacheSize) cacheSizeSelect.value = String(cacheSize);
  });
  cacheSizeSelect.addEventListener('change', async () => {
    try {
      await chrome.storage.local.set({ cacheSize: Number(cacheSizeSelect.value) });
      const response = await chrome.runtime.sendMessage({ action: 'trimCache' });
      if (!response?.success) throw new Error(response?.error || 'No response');
      showStatus(`The cache keeps ${cacheSizeSelect.value} images${response.count ? ` (${response.count} older removed)` : ''}`, 'success');
    } catch (error) {
      showStatus(`Couldn't change the cache size: ${error.message}`, 'error');
    }
  });

  // Purge the converted-image cache (Swap Cache and repeat conversions read from it)
  const purgeCacheButton = document.getElementById('purgeCache');
  purgeCacheButton.addEventListener('click', async function() {
    if (!confirm('Delete all cached converted images?')) return;
    purgeCacheButton.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({ action: 'clearCache' });
      if (!response?.success) throw new Error(response?.error || 'No response');
      showStatus(`Cache purged (${response.count} image${response.count === 1 ? '' : 's'})`, 'success');
    } catch (error) {
      showStatus(`Couldn't purge the cache: ${error.message}`, 'error');
    } finally {
      purgeCacheButton.disabled = false;
    }
  });

  // Save server address on change
  // Processing on the user's own ComfyUI (its address is a setting) or on the img2img server (fixed in background.js)
  const processingMode = document.getElementById('processingMode');
  const img2imgApiKey = document.getElementById('img2imgApiKey');
  // The workflows the img2img server offers, and with them the ControlNet preprocessors it offers and their options
  // (null if it can't be reached).
  let serverWorkflows = null;
  let serverPreprocessors = null;
  let serverUpscaleModels = null;
  const serverWorkflowsReady = refreshServerWorkflows();
  async function refreshServerWorkflows() {
    const response = await chrome.runtime.sendMessage({ action: 'apiRequest', url: '/v1/workflows', method: 'GET' }).catch(() => null);
    const answered = response?.success && response.status === 200 && Array.isArray(response.data?.workflows);
    serverWorkflows = answered ? response.data.workflows : [];
    serverPreprocessors = answered ? (response.data.preprocessors || {}) : null;
    serverUpscaleModels = answered ? (response.data.upscaleModels || []) : null;
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
    accountLoading = true;
    showCreditBadge();
    const response = await chrome.runtime.sendMessage({ action: 'apiRequest', url: '/v1/me', method: 'GET' }).catch(() => null);
    accountLoading = false;
    accountCredits = response?.success && response.status === 200 ? response.data.credits : null;
    creditsUrl = accountCredits !== null ? response.data.creditsUrl || null : null;
    if (!response?.success) {
      status.textContent = "Can't reach the img2img server";
    } else if (accountCredits !== null) {
      status.textContent = `${accountCredits} credit${accountCredits === 1 ? '' : 's'} left`;
      if (accountCredits <= 5 && creditsUrl) {
        const link = Object.assign(document.createElement('a'), { href: '#', textContent: 'Buy credits' });
        link.addEventListener('click', e => { e.preventDefault(); openCreditsPage(); });
        status.append(' · ', link);
      }
    } else {
      status.textContent = response.data?.error || `The img2img server returned HTTP ${response.status}`;
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
  const processingReady = new Promise(resolve => { processingRestored = resolve; });
  chrome.management.getSelf(self => {
    isDevelopmentInstall = self.installType === 'development';
    chrome.storage.local.get(['processingMode', 'img2imgApiKey', 'img2imgLocalApiKey', 'devServer'], result => {
      // The img2img server unless My ComfyUI was chosen (same rule as content.js)
      processingMode.value = result.processingMode === 'local' ? 'local' : 'server';
      devServer.value = result.devServer === 'local' ? 'local' : 'live';
      img2imgApiKey.value = result[apiKeyName()] || '';
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
        refreshAccount();
        refreshServerWorkflows();
      });
    });
  });
  // Saved for background.js, which adds it to each request to the server (content scripts never see it)
  img2imgApiKey.addEventListener('change', () => {
    chrome.storage.local.set({ [apiKeyName()]: img2imgApiKey.value.trim() }, refreshAccount);
  });

  if (comfyServerAddress) {
    comfyServerAddress.addEventListener('change', function() {
      chrome.storage.local.set({ comfyServerAddress: comfyServerAddress.value });
    });
  }


  // Show only the settings that apply to the selected workflow
  function showWorkflowSettings() {
    const workflow = workflowSelect.value;
    const local = document.getElementById('processingMode').value === 'local';
    const offeredFaceWorkflows = FACE_WORKFLOWS.filter(name => serverWorkflows?.includes(name));
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
      } else if (FACE_WORKFLOWS.includes(option.value)) {
        const offered = offeredFaceWorkflows.includes(option.value);
        option.hidden = !offered;
        option.disabled = !offered || local;
        option.dataset.label ??= option.textContent;
        option.textContent = offered && local ? `${option.dataset.label} (img2img server)` : option.dataset.label;
      } else {
        option.hidden = notOnServer(option.value);
      }
    }
    // A hidden workflow can't stay selected (a dropdown still shows its selected option): e.g. one chosen when a
    // server offered it. Once it's known what's offered, the default (or the first workflow left) takes over.
    if (workflowSelect.selectedOptions[0]?.hidden && (local || serverAnswered)) {
      const usable = [...workflowSelect.options].filter(option => !option.hidden && !option.disabled);
      const replacement = usable.find(option => option.value === DEFAULT_WORKFLOW) || usable[0];
      if (replacement) {
        workflowSelect.value = replacement.value;
        chrome.storage.local.set({ workflow: replacement.value });
        showWorkflowSettings();
        return;
      }
    }
    // The other workflows have none of the face settings, only their own section and a description
    const usesFace = FACE_WORKFLOWS.includes(workflow);
    const faceWorkflowOffered = offeredFaceWorkflows.includes(workflow);
    const custom = isCustomWorkflow(workflow);
    // One of the user's own workflows with source inputs uses the Source grid too
    const customSources = custom && local && customSourceNodes().length > 0;
    document.getElementById('sourceStage').hidden = !(usesFace && faceWorkflowOffered) && !customSources;
    for (const [name, sectionId] of Object.entries(WORKFLOW_SECTIONS)) {
      document.getElementById(sectionId).hidden = workflow !== name;
    }
    document.getElementById('customSettings').hidden = !custom || !local;
    const hintText = custom ? (local ? CUSTOM_WORKFLOW_HINT : CUSTOM_ON_SERVER_HINT)
      : notOnServer(workflow) ? SERVER_UNAVAILABLE_HINT
      : WORKFLOW_HINTS[workflow];
    const hint = document.getElementById('workflowHint');
    hint.textContent = hintText || '';
    hint.hidden = !hintText;
    if (custom) {
      renderCustomSettings();
    } else if (workflow === 'controlnet') {
      showControlnetSettings();
    } else if (workflow === 'upscale') {
      showUpscaleModels();
    }
    document.getElementById('backgroundColorGroup').hidden = backgroundMode.value !== 'color';
    document.getElementById('backgroundBlurGroup').hidden = backgroundMode.value !== 'blur';
  }

  // Whether processing needs the source selected in the grid: a workflow with a source face, or one of the user's
  // own workflows with a source input that follows the grid
  function workflowNeedsFace() {
    const id = customWorkflowId(workflowSelect.value);
    return FACE_WORKFLOWS.includes(workflowSelect.value)
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
        models = spec ? (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options || []) : [];
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
  // unknown), a dropdown for choices, a switch for on/off and a text box for text. onSave gets the new value.
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
      box.addEventListener('change', () => onSave(box.value));
      group.append(box);
      if (input.multiline && sizeKey) keepTextareaHeight(box, sizeKey);
    } else {
      const select = document.createElement('select');
      input.options.forEach((option, index) => select.append(new Option(prettyChoice(option), index)));
      select.value = Math.max(0, input.options.indexOf(value));
      select.addEventListener('change', () => onSave(input.options[select.value]));
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
  async function renderCustomSettings() {
    const render = ++customRender;
    const id = customWorkflowId(workflowSelect.value);
    const definition = customWorkflows.find(item => item.id === id);
    const sources = definition?.sourceNodes?.length ? await getAllFaces().catch(() => []) : [];
    if (render !== customRender) return; // changed while loading
    const container = document.getElementById('customOptions');
    const status = document.getElementById('customStatus');
    container.replaceChildren();
    const settings = definition?.settings || [];
    status.textContent = !definition ? 'This workflow was deleted: pick another one.'
      : !settings.length && !definition.sourceNodes?.length ? 'No settings chosen for this workflow. Choose some on the My workflows page.' : '';
    status.hidden = !status.textContent;
    const saved = customWorkflowValues[id] || {};
    const save = (key, newValue) => {
      customWorkflowValues = { ...customWorkflowValues, [id]: { ...customWorkflowValues[id], [key]: newValue } };
      chrome.storage.local.set({ customWorkflowValues });
    };
    for (const group of sourceGroups(definition)) {
      const key = `source:${group.key}`;
      const choices = ['', ...sources.map(face => face.id)];
      const names = { '': 'The source selected above', ...Object.fromEntries(sources.map(face => [face.id, face.name])) };
      const picker = createSettingControl(group.label, { kind: 'choice', options: choices }, choices.includes(saved[key]) ? saved[key] : '', value => save(key, value));
      picker.querySelectorAll('option').forEach(option => { option.textContent = names[choices[option.value]] ?? option.textContent; });
      const uses = group.nodes.length > 1 ? `Uses the source's first ${group.nodes.length} images (its last one again if it has fewer)`
        : group.batch ? "Uses all of the source's images" : "Uses the source's first image";
      picker.title = uses;
      picker.append(Object.assign(document.createElement('div'), { className: 'workflow-hint', textContent: uses }));
      container.append(picker);
    }
    for (const setting of settings) {
      const key = `${setting.node}.${setting.input}`;
      const value = settingValue(setting, saved[key], definition.graph[setting.node]?.inputs[setting.input]);
      const control = createSettingControl(setting.label, setting, value, newValue => save(key, newValue), `${id}.${key}`);
      container.append(control);
      if (setting.seed) {
        // A seed can be a new random number for each image instead (the number box is then unused)
        const randomKey = randomSeedKey(setting);
        const number = control.querySelector('input');
        number.disabled = saved[randomKey] === true;
        const random = createSettingControl('New seed each time', { kind: 'toggle' }, saved[randomKey] === true, checked => {
          number.disabled = checked;
          save(randomKey, checked);
        });
        random.classList.add('seed-random');
        container.append(random);
      }
    }
  }

  document.getElementById('manageWorkflows').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('workflows.html') });
  });

  document.getElementById('viewCache').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('cache.html') });
  });

  // Workflows added, changed or deleted on the My workflows page while the popup is open
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes.customWorkflows) return;
    const selected = workflowSelect.value;
    customWorkflows = changes.customWorkflows.newValue || [];
    renderCustomWorkflowOptions();
    workflowSelect.value = selected;
    if (!workflowSelect.value) {
      // The selected workflow was deleted: back to the default
      workflowSelect.value = DEFAULT_WORKFLOW;
      chrome.storage.local.set({ workflow: workflowSelect.value });
    }
    showWorkflowSettings();
  });

  controlnetPreprocessor.addEventListener('change', () => {
    chrome.storage.local.set({ controlnetPreprocessor: controlnetPreprocessor.value });
    renderControlnetOptions();
  });
  for (const input of simpleInputs) {
    input.addEventListener('change', () => {
      chrome.storage.local.set({ [input.id]: input.id === 'upscaleScale' ? Number(input.value) : input.value });
      showWorkflowSettings();
    });
  }
  controlnetResolution.addEventListener('change', () => {
    chrome.storage.local.set({ controlnetResolution: Number(controlnetResolution.value) });
  });

  // Handle workflow change
  workflowSelect.addEventListener('change', function() {
    chrome.storage.local.set({ workflow: this.value });
    showWorkflowSettings();
  });

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
    Promise.allSettled([earlierReads, settingsRestored, processingReady, siteAccessChecked, facesLoaded]),
    new Promise(resolve => setTimeout(resolve, REVEAL_LIMIT_MS)),
  ])
    // Two frames: the restored layout is drawn with transitions still off, then they come back
    .then(() => requestAnimationFrame(() => requestAnimationFrame(() => document.body.classList.remove('restoring'))));
}); 