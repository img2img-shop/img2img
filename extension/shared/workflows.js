// Workflow builders shared by the extension (local mode, run on the user's own ComfyUI) and the img2img
// server (hosted jobs): the image workflows and the NSFW gate.
//
// Loaded as a plain script: by the extension as a content script before content.js and in the popup before
// popup.js (its top-level names are shared with those scripts), and by the server through require(), which
// gets the exports at the end. Nothing here talks to ComfyUI: callers pass in what the builders need to know
// about the installed nodes.

// The version of img2img's terms of service and acceptable use policy that My ComfyUI users agree to in the popup
// (they have no account, so the agreement is kept by the extension: chrome.storage.local termsAgreedVersion).
// Same as the site's config img2img.terms_version: change both when the terms change, and everyone is asked again.
const TERMS_VERSION = '2026-11-12';
const TERMS_URL = 'https://img2img.shop/terms';
const ACCEPTABLE_USE_URL = 'https://img2img.shop/acceptable-use';

// The largest images a hosted job takes (the API refuses larger ones; the extension shrinks them to fit first, see
// shared/images.js), each as decoded bytes. The largest job, the target and HOSTED_MAX_SOURCE_IMAGES sources
// base64-encoded, is about 92.3 MB: under the server's request limit with room for the rest of the request.
const HOSTED_MAX_TARGET_BYTES = 16 * 1024 * 1024;
const HOSTED_MAX_SOURCE_BYTES = 10 * 1024 * 1024;
const HOSTED_MAX_SOURCE_IMAGES = 5;

// ImageBlur inputs within the node's limits (radius 1-31, sigma 0.1-10). Blurs scale with the image, and
// ComfyUI rejects the whole workflow when one is out of range, so large photos would fail otherwise.
// Used by: web pages, the result tab, the Library, the img2img server.
function imageBlurInputs(image, radius, sigma) {
  return {
    "image": image,
    "blur_radius": Math.min(31, Math.max(1, Math.round(radius))),
    "sigma": Number(Math.min(10, Math.max(0.1, sigma)).toFixed(2))
  };
}

// ControlNet map workflow: the image is replaced by a comfyui_controlnet_aux preprocessor's map of it (edges,
// line art, depth, pose, segmentation...). The popup lists the preprocessors and offers their options, read
// from ComfyUI; the saved ones are checked against the node's inputs here and the rest use its defaults.
const CONTROLNET_DEFAULT_PREPROCESSOR = 'CannyEdgePreprocessor';
const CONTROLNET_DEFAULT_RESOLUTION = 1024;

// ControlNet map workflow: the comfyui_controlnet_aux preprocessors it offers, as [node class, label, group].
// Each takes one image and returns its map as the first output. The popup lists the installed ones; the
// server only accepts these.
const CONTROLNET_PREPROCESSORS = [
  ['CannyEdgePreprocessor', 'Canny', 'Edges & lines'],
  ['PyraCannyPreprocessor', 'Pyra Canny', 'Edges & lines'],
  ['LineArtPreprocessor', 'Line Art (realistic)', 'Edges & lines'],
  ['LineartStandardPreprocessor', 'Line Art (standard)', 'Edges & lines'],
  ['AnimeLineArtPreprocessor', 'Line Art (anime)', 'Edges & lines'],
  ['Manga2Anime_LineArt_Preprocessor', 'Line Art (manga)', 'Edges & lines'],
  ['AnyLineArtPreprocessor_aux', 'AnyLine', 'Edges & lines'],
  ['HEDPreprocessor', 'Soft Edge (HED)', 'Edges & lines'],
  ['PiDiNetPreprocessor', 'Soft Edge (PiDiNet)', 'Edges & lines'],
  ['TEEDPreprocessor', 'Soft Edge (TEED)', 'Edges & lines'],
  ['DiffusionEdge_Preprocessor', 'Diffusion Edge', 'Edges & lines'],
  ['M-LSDPreprocessor', 'Straight Lines (M-LSD)', 'Edges & lines'],
  ['BinaryPreprocessor', 'Binary', 'Edges & lines'],
  ['ScribblePreprocessor', 'Scribble', 'Scribble'],
  ['Scribble_XDoG_Preprocessor', 'Scribble (XDoG)', 'Scribble'],
  ['Scribble_PiDiNet_Preprocessor', 'Scribble (PiDiNet)', 'Scribble'],
  ['FakeScribblePreprocessor', 'Fake Scribble (HED)', 'Scribble'],
  ['DepthAnythingV2Preprocessor', 'Depth Anything V2', 'Depth'],
  ['DepthAnythingPreprocessor', 'Depth Anything', 'Depth'],
  ['Zoe_DepthAnythingPreprocessor', 'Zoe Depth Anything', 'Depth'],
  ['MiDaS-DepthMapPreprocessor', 'MiDaS Depth', 'Depth'],
  ['Zoe-DepthMapPreprocessor', 'Zoe Depth', 'Depth'],
  ['LeReS-DepthMapPreprocessor', 'LeReS Depth', 'Depth'],
  ['Metric3D-DepthMapPreprocessor', 'Metric3D Depth', 'Depth'],
  ['BAE-NormalMapPreprocessor', 'BAE Normals', 'Normals'],
  ['DSINE-NormalMapPreprocessor', 'DSINE Normals', 'Normals'],
  ['MiDaS-NormalMapPreprocessor', 'MiDaS Normals', 'Normals'],
  ['Metric3D-NormalMapPreprocessor', 'Metric3D Normals', 'Normals'],
  ['DWPreprocessor', 'DWPose', 'Pose & face'],
  ['OpenposePreprocessor', 'OpenPose', 'Pose & face'],
  ['AnimalPosePreprocessor', 'Animal Pose', 'Pose & face'],
  ['DensePosePreprocessor', 'DensePose', 'Pose & face'],
  // (MediaPipe Face Mesh left out: it uses mediapipe's old solutions API, which mediapipe 0.10.30+ no longer
  // has, and returns a black map instead of an error)
  ['OneFormer-ADE20K-SemSegPreprocessor', 'OneFormer ADE20K', 'Segmentation'],
  ['OneFormer-COCO-SemSegPreprocessor', 'OneFormer COCO', 'Segmentation'],
  ['UniFormer-SemSegPreprocessor', 'UniFormer', 'Segmentation'],
  ['AnimeFace_SemSegPreprocessor', 'Anime Face', 'Segmentation'],
  ['ColorPreprocessor', 'Colour Palette', 'Colour & tile'],
  ['ShufflePreprocessor', 'Content Shuffle', 'Colour & tile'],
  ['TilePreprocessor', 'Tile (blur)', 'Colour & tile'],
  ['TTPlanet_TileGF_Preprocessor', 'Tile (guided filter)', 'Colour & tile'],
  ['TTPlanet_TileSimple_Preprocessor', 'Tile (simple)', 'Colour & tile'],
];

// The value for one preprocessor input: the saved option if the node still accepts it, else its default.
// Undefined for inputs that aren't plain numbers or choices.
// Used by: web pages, the result tab, the Library, the img2img server.
function controlnetInputValue(spec, saved) {
  const [type, config = {}] = spec;
  const options = Array.isArray(type) ? type : type === 'COMBO' ? (config.options || []) : type === 'BOOLEAN' ? [true, false] : null;
  if (options) {
    return options.includes(saved) ? saved : (config.default ?? options[0]);
  }
  if (type === 'INT' || type === 'FLOAT') {
    const fallback = config.default ?? config.min ?? 0;
    return Number.isFinite(saved) ? Math.min(config.max ?? Infinity, Math.max(config.min ?? -Infinity, saved)) : fallback;
  }
  return undefined;
}

// nodeInfo(nodeClass) returns a node's ComfyUI object_info entry, or null when it isn't installed
// Used by: web pages, the result tab, the Library.
function buildControlnetWorkflow(targetImage, settings, imageSize, nodeInfo) {
  const preprocessor = settings.controlnetPreprocessor || CONTROLNET_DEFAULT_PREPROCESSOR;
  const info = nodeInfo(preprocessor);
  if (!info) {
    throw new Error(`ComfyUI doesn't have the ${preprocessor} preprocessor (comfyui_controlnet_aux)`);
  }
  const saved = settings.controlnetOptions?.[preprocessor] || {};
  const inputs = {};
  for (const [name, spec] of Object.entries({ ...info.input.required, ...info.input.optional })) {
    if (spec[0] === 'IMAGE') {
      inputs[name] = ["102", 0];
    } else if (name === 'resolution') {
      inputs[name] = Number(settings.controlnetResolution) || CONTROLNET_DEFAULT_RESOLUTION;
    } else {
      const value = controlnetInputValue(spec, saved[name]);
      if (value !== undefined) {
        inputs[name] = value;
      }
    }
  }
  return {
    "102": { "inputs": { "image": targetImage }, "class_type": "ETN_LoadImageBase64", "_meta": { "title": "Input Image" } },
    "104": { "inputs": inputs, "class_type": preprocessor, "_meta": { "title": "Preprocessor" } },
    // The map comes out at the detect resolution; back to the image's size so it fits the page the same way
    "105": {
      "inputs": { "image": ["104", 0], "upscale_method": "bilinear", "width": imageSize.width, "height": imageSize.height, "crop": "disabled" },
      "class_type": "ImageScale",
      "_meta": { "title": "Scale To Image Size" }
    },
    // PreviewImage: result goes to ComfyUI's temp folder, not output/
    "109": { "inputs": { "images": ["105", 0] }, "class_type": "PreviewImage", "_meta": { "title": "Final Result", "img2img_result": true } },
  };
}

// Simple image workflows without a source: upscale, background removal/blur and face restore.
const SWAP_WORKFLOWS = [];
const SHARED_WORKFLOWS = ['controlnet', 'upscale', 'background', 'restore', 'colorize', 'cleanup', 'sticker', 'idPhoto', 'faceBlur', 'filter', 'transform', 'segment'];
// The workflow until one is chosen (a new install has none saved)
const DEFAULT_WORKFLOW = 'background';

// Workflows that were removed map to their replacement, so a saved choice keeps working
const WORKFLOW_REPLACEMENTS = {};

// What each workflow is called, for naming the chosen one outside the popup (the right-click menu's
// "img2img: <workflow>" item). The popup's own dropdown shows these names from popup.html's workflowSelect
// options, so a name changed here belongs there too. A workflow of the user's own is named by its definition.
const WORKFLOW_LABELS = {
  controlnet: 'ControlNet map',
  upscale: 'Upscale',
  background: 'Background removal / blur',
  restore: 'Face restore',
  colorize: 'Colourise',
  cleanup: 'Photo cleanup',
  segment: 'Cut out by prompt',
  sticker: 'Sticker',
  idPhoto: 'ID / passport photo',
  faceBlur: 'Blur faces',
  filter: 'Photo filter',
  transform: 'Outfits & styles',
};

// The workflow that actually runs
function effectiveWorkflow(settings) { return settings.workflow; }
// 4xNomos8k_atd_jpg (Philip Hofmann, CC BY 4.0): licensed for commercial use, with credit. 4x-UltraSharp, Remacri
// and most other popular upscalers are CC BY-NC-SA, so they're not offered as a default.
const UPSCALE_DEFAULT_MODEL = '4xNomos8k_atd_jpg.safetensors';
const UPSCALE_DEFAULT_SCALE = 2;
const UPSCALE_MAX_SIDE = 4096; // longest side of an upscaled result, so results stay a sensible size
const BACKGROUND_MODEL = 'BiRefNet-general'; // the BiRefNet model installed with comfyui-rmbg
const BACKGROUND_DEFAULTS = { mode: 'transparent', color: '#ffffff', color2: '#9fb4c7', blur: 50 };
const RESTORE_DEFAULTS = { model: 'GFPGANv1.4.pth', strength: 100, fidelity: 50 };
// The face restore models offered: GFPGAN (Apache-2.0). CodeFormer (S-Lab) and GPEN (Alibaba) are
// non-commercial, so they were removed; a saved one falls back to the default.
const RESTORE_MODELS = ['GFPGANv1.4.pth', 'GFPGANv1.3.pth'];

// Used by: web pages, the result tab, the Library.
function inputImageNode(targetImage) {
  return { "inputs": { "image": targetImage }, "class_type": "ETN_LoadImageBase64", "_meta": { "title": "Input Image" } };
}

// Used by: web pages, the result tab, the Library.
function previewNode(image) {
  // PreviewImage: result goes to ComfyUI's temp folder, not output/
  return { "inputs": { "images": image }, "class_type": "PreviewImage", "_meta": { "title": "Final Result", "img2img_result": true } };
}

// Upscale with an ESRGAN-style model (it upscales by its own factor), then scale to the chosen factor,
// capped so the longest side stays within UPSCALE_MAX_SIDE. A larger image is shrunk first so a 4x model's
// output stays within UPSCALE_MAX_SIDE too: at 2048px the 8192px intermediate took minutes on the GPU.
// Used by: web pages, the result tab, the Library.
function buildUpscaleWorkflow(targetImage, settings, imageSize) {
  const scale = Number(settings.upscaleScale) || UPSCALE_DEFAULT_SCALE;
  const longest = Math.max(imageSize.width, imageSize.height);
  const factor = Math.max(1, Math.min(scale, UPSCALE_MAX_SIDE / longest));
  const shrink = Math.min(1, UPSCALE_MAX_SIDE / 4 / longest);
  const workflow = {
    "102": inputImageNode(targetImage),
    "103": { "inputs": { "model_name": settings.upscaleModel || UPSCALE_DEFAULT_MODEL }, "class_type": "UpscaleModelLoader", "_meta": { "title": "Upscale Model" } },
    "104": { "inputs": { "upscale_model": ["103", 0], "image": ["102", 0] }, "class_type": "ImageUpscaleWithModel", "_meta": { "title": "Upscale" } },
    "105": {
      "inputs": { "image": ["104", 0], "upscale_method": "lanczos", "width": Math.round(imageSize.width * factor), "height": Math.round(imageSize.height * factor), "crop": "disabled" },
      "class_type": "ImageScale",
      "_meta": { "title": "Scale To Target Size" }
    },
    "109": previewNode(["105", 0]),
  };
  if (shrink < 1) {
    workflow["101"] = {
      "inputs": { "image": ["102", 0], "upscale_method": "area", "width": Math.round(imageSize.width * shrink), "height": Math.round(imageSize.height * shrink), "crop": "disabled" },
      "class_type": "ImageScale",
      "_meta": { "title": "Shrink Before Upscale" }
    };
    workflow["104"].inputs.image = ["101", 0];
  }
  return workflow;
}

// A strong blur of `image` (sigma in pixels of an image of `imageSize`). ImageBlur's limits (radius 31, sigma 10)
// are too small for large images, so a smaller copy is blurred and scaled back up. ids: the three nodes' ids;
// titles: their titles. Returns the blurred image's link.
// Used by: web pages, the result tab, the Library.
function addStrongBlur(workflow, ids, image, sigma, imageSize, titles = ['Shrink For Blur', 'Blur', 'Back To Full Size']) {
  const [shrinkId, blurId, growId] = ids;
  const shrink = Math.max(1, sigma / 6);
  const small = { width: Math.max(8, Math.round(imageSize.width / shrink)), height: Math.max(8, Math.round(imageSize.height / shrink)) };
  workflow[shrinkId] = { "inputs": { "image": image, "upscale_method": "area", ...small, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": titles[0] } };
  workflow[blurId] = { "inputs": imageBlurInputs([shrinkId, 0], Math.ceil(3 * sigma / shrink), sigma / shrink), "class_type": "ImageBlur", "_meta": { "title": titles[1] } };
  workflow[growId] = { "inputs": { "image": [blurId, 0], "upscale_method": "bilinear", "width": imageSize.width, "height": imageSize.height, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": titles[2] } };
  return [growId, 0];
}

// A #rrggbb setting, or the fallback when it isn't one
// Used by: web pages, the result tab, the Library.
function colorSetting(value, fallback) {
  return /^#[0-9a-fA-F]{6}$/.test(value || '') ? value : fallback;
}

// A #rrggbb colour as the number EmptyImage takes
// Used by: web pages, the result tab, the Library.
function colorNumber(hex) {
  return parseInt(hex.slice(1), 16);
}

// A whole-percent setting (0-100), or the fallback when it's unset
// Used by: web pages, the result tab, the Library.
function percentSetting(value, fallback) {
  const number = Number(value);
  return value === undefined || value === null || value === '' || !Number.isFinite(number) ? fallback : Math.min(100, Math.max(0, number));
}

// Raw base64 of a source image (the server passes data URLs, the extension raw base64)
// Used by: web pages, the result tab, the Library.
function rawBase64(image) {
  return image.startsWith('data:') ? image.slice(image.indexOf(',') + 1) : image;
}

// Whether the workflow uses the image selected in the popup's Source grid: a background replaced by an image
// Used by: web pages, the result tab, the Library, the popup, the img2img server.
function usesSourceImage(settings) {
  return settings.workflow === 'background' && settings.backgroundMode === 'image';
}

// Background removal with BiRefNet: a transparent PNG, a solid colour, the background blurred like a
// portrait-mode photo, or replaced by a gradient or by an image from the Source grid (the foreground pasted
// over it through BiRefNet's mask). sources: the source images (base64), for the image mode.
// Used by: web pages, the result tab, the Library.
function buildBackgroundWorkflow(targetImage, settings, imageSize, sources = [], nsfw = { enabled: false }) {
  const mode = settings.backgroundMode || BACKGROUND_DEFAULTS.mode;
  const workflow = {
    "102": inputImageNode(targetImage),
    "103": {
      "inputs": {
        "image": ["102", 0], "model": BACKGROUND_MODEL, "sensitivity": 1.0, "mask_blur": 0, "mask_offset": 0, "invert_output": false,
        "refine_foreground": mode === 'transparent', "background": mode === 'color' ? "Color" : "Alpha",
        "background_color": settings.backgroundColor || BACKGROUND_DEFAULTS.color
      },
      "class_type": "BiRefNetRMBG",
      "_meta": { "title": "Remove Background" }
    },
  };
  if (mode === 'transparent' || mode === 'color') {
    workflow["109"] = previewNode(["103", 0]);
    return workflow;
  }
  let backdrop;
  if (mode === 'blur') {
    // Strength 100% is a blur of 3% of the image's short side
    const strength = Number(settings.backgroundBlur ?? BACKGROUND_DEFAULTS.blur) / 100;
    const sigma = Math.max(0.5, strength * 0.03 * Math.min(imageSize.width, imageSize.height));
    backdrop = addStrongBlur(workflow, ["104", "105", "106"], ["102", 0], sigma, imageSize, ['Shrink For Blur', 'Blur Background', 'Back To Full Size']);
  } else if (mode === 'gradient') {
    // Top colour to bottom colour: a 1x2 image of the two, stretched to twice the image's height (bilinear scaling
    // fades between the two pixels' centres, a quarter and three quarters of the way down), and its middle half
    workflow["120"] = { "inputs": { "width": 1, "height": 2, "batch_size": 1, "color": colorNumber(colorSetting(settings.backgroundColor, BACKGROUND_DEFAULTS.color)) }, "class_type": "EmptyImage", "_meta": { "title": "Top Colour" } };
    workflow["121"] = { "inputs": { "width": 1, "height": 1, "batch_size": 1, "color": colorNumber(colorSetting(settings.backgroundColor2, BACKGROUND_DEFAULTS.color2)) }, "class_type": "EmptyImage", "_meta": { "title": "Bottom Colour" } };
    workflow["122"] = { "inputs": { "destination": ["120", 0], "source": ["121", 0], "x": 0, "y": 1, "resize_source": false }, "class_type": "ImageCompositeMasked", "_meta": { "title": "Two Colours" } };
    workflow["123"] = { "inputs": { "image": ["122", 0], "upscale_method": "bilinear", "width": imageSize.width, "height": 2 * imageSize.height, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Stretched" } };
    workflow["125"] = { "inputs": { "image": ["123", 0], "width": imageSize.width, "height": imageSize.height, "x": 0, "y": Math.round(imageSize.height / 2) }, "class_type": "ImageCrop", "_meta": { "title": "Gradient" } };
    backdrop = ["125", 0];
  } else if (mode === 'image') {
    if (!sources.length) {
      throw new Error('Pick the new background in the Source grid first');
    }
    // The source image fills the background, scaled and cropped to cover it; it's checked like the page image
    workflow["112"] = { "inputs": { "image": rawBase64(sources[0]) }, "class_type": "ETN_LoadImageBase64", "_meta": { "title": "New Background" } };
    const source = nsfw.enabled ? addSafetyCheck(workflow, ["112", 0], "161", nsfw, 'source image') : ["112", 0];
    workflow["124"] = { "inputs": { "image": source, "upscale_method": "lanczos", "width": imageSize.width, "height": imageSize.height, "crop": "center" }, "class_type": "ImageScale", "_meta": { "title": "Cover The Image" } };
    backdrop = ["124", 0];
  } else {
    throw new Error(`Unknown background mode: ${mode}`);
  }
  workflow["107"] = {
    "inputs": { "destination": backdrop, "source": ["102", 0], "x": 0, "y": 0, "resize_source": false, "mask": ["103", 1] },
    "class_type": "ImageCompositeMasked",
    "_meta": { "title": mode === 'blur' ? "Sharp Foreground Over Blur" : "Foreground Over New Background" }
  };
  workflow["109"] = previewNode(["107", 0]);
  return workflow;
}

// Sticker: the subject cut out with BiRefNet, with an outline in a colour (the subject's mask grown) and a soft drop
// shadow, as a transparent PNG. The image gets a margin so the outline and shadow fit, and large images are made
// smaller first (stickers don't need more, and growing the mask is slow on very large ones).
const STICKER_DEFAULTS = { outline: 50, color: '#ffffff', shadow: true };
const STICKER_MAX_SIDE = 2048;
// Used by: web pages, the result tab, the Library.
function buildStickerWorkflow(targetImage, settings, imageSize) {
  const outlinePercent = percentSetting(settings.stickerOutline, STICKER_DEFAULTS.outline);
  const shadow = settings.stickerShadow ?? STICKER_DEFAULTS.shadow;
  const shrink = Math.min(1, STICKER_MAX_SIDE / Math.max(imageSize.width, imageSize.height));
  const size = { width: Math.round(imageSize.width * shrink), height: Math.round(imageSize.height * shrink) };
  const short = Math.min(size.width, size.height);
  // 100% is an outline of 4% of the short side
  const outline = Math.round(outlinePercent / 100 * 0.04 * short);
  const offset = shadow ? Math.max(1, Math.round(0.012 * short)) : 0;
  const sigma = shadow ? Math.max(1, 0.01 * short) : 0;
  const margin = Math.ceil((outline + offset + 3 * sigma + 2) / 8) * 8;
  const canvas = { width: size.width + 2 * margin, height: size.height + 2 * margin };
  const workflow = { "102": inputImageNode(targetImage) };
  let image = ["102", 0];
  if (shrink < 1) {
    workflow["101"] = { "inputs": { "image": image, "upscale_method": "area", ...size, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Shrink" } };
    image = ["101", 0];
  }
  workflow["120"] = { "inputs": { "image": image, "left": margin, "top": margin, "right": margin, "bottom": margin, "feathering": 0 }, "class_type": "ImagePadForOutpaint", "_meta": { "title": "Margin" } };
  workflow["121"] = {
    "inputs": { "image": ["120", 0], "model": BACKGROUND_MODEL, "sensitivity": 1.0, "mask_blur": 0, "mask_offset": 0, "invert_output": false, "refine_foreground": false, "background": "Alpha", "background_color": "#ffffff" },
    "class_type": "BiRefNetRMBG",
    "_meta": { "title": "Find The Subject" }
  };
  const subject = ["121", 1];
  let outlineMask = subject;
  if (outline > 0) {
    workflow["122"] = { "inputs": { "mask": subject, "value": 0.5 }, "class_type": "ThresholdMask", "_meta": { "title": "Solid Subject" } };
    workflow["123"] = { "inputs": { "mask": ["122", 0], "expand": outline, "tapered_corners": true }, "class_type": "GrowMask", "_meta": { "title": "Outline" } };
    outlineMask = ["123", 0];
  }
  // Colours: the shadow's black, the outline colour inside the outline, the subject inside its own mask
  workflow["130"] = { "inputs": { ...canvas, "batch_size": 1, "color": 0 }, "class_type": "EmptyImage", "_meta": { "title": "Shadow Colour" } };
  workflow["131"] = { "inputs": { ...canvas, "batch_size": 1, "color": colorNumber(colorSetting(settings.stickerColor, STICKER_DEFAULTS.color)) }, "class_type": "EmptyImage", "_meta": { "title": "Outline Colour" } };
  workflow["132"] = { "inputs": { "destination": ["130", 0], "source": ["131", 0], "x": 0, "y": 0, "resize_source": false, "mask": outlineMask }, "class_type": "ImageCompositeMasked", "_meta": { "title": "Outline Over Shadow" } };
  workflow["133"] = { "inputs": { "destination": ["132", 0], "source": ["120", 0], "x": 0, "y": 0, "resize_source": false, "mask": subject }, "class_type": "ImageCompositeMasked", "_meta": { "title": "Subject Over Outline" } };
  // Opacity: the outline, and the shadow (the outline moved down and right, blurred, at 45%) around it
  let opacity = outlineMask;
  if (shadow) {
    workflow["124"] = { "inputs": { "value": 0, ...canvas }, "class_type": "SolidMask", "_meta": { "title": "Empty" } };
    workflow["125"] = { "inputs": { "destination": ["124", 0], "source": outlineMask, "x": offset, "y": offset, "operation": "add" }, "class_type": "MaskComposite", "_meta": { "title": "Shadow Offset" } };
    workflow["126"] = { "inputs": { "mask": ["125", 0] }, "class_type": "MaskToImage", "_meta": { "title": "Shadow As Image" } };
    const blurred = addStrongBlur(workflow, ["127", "128", "129"], ["126", 0], sigma, canvas, ['Shrink Shadow', 'Blur Shadow', 'Shadow Full Size']);
    workflow["140"] = { "inputs": { "image": blurred, "channel": "red" }, "class_type": "ImageToMask", "_meta": { "title": "Soft Shadow" } };
    workflow["141"] = { "inputs": { "value": 0.45, ...canvas }, "class_type": "SolidMask", "_meta": { "title": "Shadow Strength" } };
    workflow["142"] = { "inputs": { "destination": ["140", 0], "source": ["141", 0], "x": 0, "y": 0, "operation": "multiply" }, "class_type": "MaskComposite", "_meta": { "title": "Faint Shadow" } };
    workflow["143"] = { "inputs": { "destination": outlineMask, "source": ["142", 0], "x": 0, "y": 0, "operation": "add" }, "class_type": "MaskComposite", "_meta": { "title": "Sticker Opacity" } };
    opacity = ["143", 0];
  }
  // JoinImageWithAlpha takes a mask of what's transparent
  workflow["144"] = { "inputs": { "mask": opacity }, "class_type": "InvertMask", "_meta": { "title": "Transparency" } };
  workflow["145"] = { "inputs": { "image": ["133", 0], "alpha": ["144", 0] }, "class_type": "JoinImageWithAlpha", "_meta": { "title": "Sticker" } };
  workflow["109"] = previewNode(["145", 0]);
  return workflow;
}

// Cut out by prompt: Meta's SAM 3 (SAM License: open weights, commercial use allowed) through comfyui-rmbg's
// SAM3Segment finds everything matching a short text prompt ("dog", "red car", "glasses") with a score above the
// threshold, as one merged mask. The result is the matches cut out (transparent PNG), everything but the matches (the
// matches made transparent), or the black-and-white mask. Nothing found: an empty (transparent or black) image.
// SAM3Segment's own inverted output ignores the inversion when nothing is found, so the transparency is made here.
const SEGMENT_NODE = 'SAM3Segment';
const SEGMENT_OUTPUTS = ['cutout', 'remove', 'mask'];
const SEGMENT_DEFAULTS = { prompt: 'person', threshold: 50, output: 'cutout' };
const SEGMENT_PROMPT_MAX = 200;
const SEGMENT_THRESHOLD_RANGE = [5, 95]; // percent: the node's confidence_threshold is 0.05-0.95

// The prompt as it's sent (and cached): one line, at most SEGMENT_PROMPT_MAX characters; '' when there's none
// Used by: web pages, the result tab, the Library, the popup, the img2img server.
function segmentPrompt(value) {
  return String(value ?? SEGMENT_DEFAULTS.prompt).replace(/\s+/g, ' ').trim().slice(0, SEGMENT_PROMPT_MAX);
}

// Used by: web pages, the result tab, the Library.
function buildSegmentWorkflow(targetImage, settings, nodeInfo) {
  if (!nodeInfo(SEGMENT_NODE)) {
    throw new Error("ComfyUI doesn't have the SAM3 Segmentation node (comfyui-rmbg by 1038lab, in ComfyUI Manager)");
  }
  const prompt = segmentPrompt(settings.segmentPrompt);
  if (!prompt) {
    throw new Error('Type what to cut out (for example "dog" or "red car")');
  }
  const output = SEGMENT_OUTPUTS.includes(settings.segmentOutput) ? settings.segmentOutput : SEGMENT_DEFAULTS.output;
  const [low, high] = SEGMENT_THRESHOLD_RANGE;
  const threshold = Math.min(high, Math.max(low, percentSetting(settings.segmentThreshold, SEGMENT_DEFAULTS.threshold))) / 100;
  const workflow = {
    "102": inputImageNode(targetImage),
    "103": {
      "inputs": {
        "image": ["102", 0], "prompt": prompt, "output_mode": "Merged", "confidence_threshold": threshold,
        "max_segments": 0, "segment_pick": 0, "mask_blur": 0, "mask_offset": 0, "device": "Auto", "invert_output": false,
        "unload_model": false, "background": "Alpha", "background_color": "#222222"
      },
      "class_type": SEGMENT_NODE,
      "_meta": { "title": "Find By Prompt" }
    },
  };
  const matches = ["103", 1];
  if (output === 'mask') {
    workflow["104"] = { "inputs": { "mask": matches }, "class_type": "MaskToImage", "_meta": { "title": "Mask" } };
    workflow["109"] = previewNode(["104", 0]);
    return workflow;
  }
  // JoinImageWithAlpha takes a mask of what's transparent: the matches to remove them, everything else to cut them out
  let transparent = matches;
  if (output === 'cutout') {
    workflow["104"] = { "inputs": { "mask": matches }, "class_type": "InvertMask", "_meta": { "title": "Everything Else" } };
    transparent = ["104", 0];
  }
  workflow["105"] = { "inputs": { "image": ["102", 0], "alpha": transparent }, "class_type": "JoinImageWithAlpha", "_meta": { "title": output === 'cutout' ? "Cut Out" : "Removed" } };
  workflow["109"] = previewNode(["105", 0]);
  return workflow;
}

// Faces are found with ComfyUI's own MediaPipe face detector (comfy_extras/nodes_mediapipe.py; Comfy-Org's
// repackaged MediaPipe Face Landmarker, Apache-2.0), in models/detection
const FACE_DETECTION_MODEL = 'mediapipe_face_fp32.safetensors';

// Used by: web pages, the result tab, the Library.
function faceDetectionModel(nodeInfo) {
  const spec = nodeInfo('LoadMediaPipeFaceLandmarker')?.input?.required?.model_name;
  const options = spec ? (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options || []) : [];
  if (!options.includes(FACE_DETECTION_MODEL)) {
    throw new Error(`ComfyUI needs the face detection model ${FACE_DETECTION_MODEL} in models/detection (from huggingface.co/Comfy-Org/mediapipe)`);
  }
  return FACE_DETECTION_MODEL;
}

// The face oval mask of every face found in `image` (ids 150-152). minConfidence: lower finds smaller and turned
// faces, and more false ones.
// Used by: web pages, the result tab, the Library.
function addFaceMask(workflow, image, nodeInfo, { allFaces, minConfidence, variant }) {
  workflow["150"] = { "inputs": { "model_name": faceDetectionModel(nodeInfo) }, "class_type": "LoadMediaPipeFaceLandmarker", "_meta": { "title": "Face Detection Model" } };
  workflow["151"] = {
    "inputs": { "face_detection_model": ["150", 0], "image": image, "detector_variant": variant, "num_faces": allFaces ? 0 : 1, "min_confidence": minConfidence, "missing_frame_fallback": "empty" },
    "class_type": "MediaPipeFaceLandmarker",
    "_meta": { "title": "Find Faces" }
  };
  workflow["152"] = { "inputs": { "face_landmarks": ["151", 0], "regions": "all" }, "class_type": "MediaPipeFaceMask", "_meta": { "title": "Face Mask" } };
  return ["152", 0];
}

// Face blur: every face pixelated or blurred, for privacy. The face ovals are grown to take in the hair line and
// ears, and their edge softened. The detector runs both its close-up and its far range at a low threshold: a face
// that's missed stays recognisable, while a false find only blurs a patch.
const FACE_BLUR_DEFAULTS = { style: 'pixelate', strength: 60 };
// Used by: web pages, the result tab, the Library.
function buildFaceBlurWorkflow(targetImage, settings, imageSize, nodeInfo) {
  const strength = Math.max(10, percentSetting(settings.faceBlurStrength, FACE_BLUR_DEFAULTS.strength)) / 100;
  const style = settings.faceBlurStyle === 'blur' ? 'blur' : 'pixelate';
  const short = Math.min(imageSize.width, imageSize.height);
  const workflow = { "102": inputImageNode(targetImage) };
  const faces = addFaceMask(workflow, ["102", 0], nodeInfo, { allFaces: true, minConfidence: 0.15, variant: "both" });
  workflow["120"] = { "inputs": { "mask": faces, "expand": Math.max(2, Math.round(0.02 * short)), "tapered_corners": true }, "class_type": "GrowMask", "_meta": { "title": "Whole Head" } };
  workflow["121"] = { "inputs": { "mask": ["120", 0] }, "class_type": "MaskToImage", "_meta": { "title": "Mask As Image" } };
  workflow["122"] = { "inputs": imageBlurInputs(["121", 0], Math.ceil(0.012 * short), 0.004 * short), "class_type": "ImageBlur", "_meta": { "title": "Soft Edge" } };
  workflow["123"] = { "inputs": { "image": ["122", 0], "channel": "red" }, "class_type": "ImageToMask", "_meta": { "title": "Blur Mask" } };
  let hidden;
  if (style === 'pixelate') {
    // 100% is blocks of 6% of the short side
    const block = Math.max(4, Math.round(strength * 0.06 * short));
    workflow["130"] = { "inputs": { "image": ["102", 0], "upscale_method": "area", "width": Math.max(1, Math.ceil(imageSize.width / block)), "height": Math.max(1, Math.ceil(imageSize.height / block)), "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Blocks" } };
    workflow["131"] = { "inputs": { "image": ["130", 0], "upscale_method": "nearest-exact", "width": imageSize.width, "height": imageSize.height, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Pixelated" } };
    hidden = ["131", 0];
  } else {
    // 100% is a blur of 4% of the short side
    hidden = addStrongBlur(workflow, ["130", "131", "132"], ["102", 0], Math.max(1, strength * 0.04 * short), imageSize, ['Shrink For Blur', 'Blur Faces', 'Back To Full Size']);
  }
  workflow["140"] = { "inputs": { "destination": ["102", 0], "source": hidden, "x": 0, "y": 0, "resize_source": false, "mask": ["123", 0] }, "class_type": "ImageCompositeMasked", "_meta": { "title": "Hide Faces" } };
  workflow["109"] = previewNode(["140", 0]);
  return workflow;
}

// ID photo: cropped around the face at a passport size, on a plain background. Only ComfyUI's own nodes do the
// cropping, in two steps:
// 1. ImageCropToMask crops a square around the face oval at twice its height (so the oval always lands at the
//    same place: rows 256-768 of 1024, centred). That node finds its box from the mask's pixels above 0.8 and
//    blends the image with the mask too, so the mask is 0.8 everywhere and 0.805 on the face: the box is the
//    face's, and everything is kept at 80% over white. Inverting, brightening by 1/0.8 and inverting again undoes
//    that blend (the face comes out 0.6% darker at most), and keeps the white where the crop reached past the photo.
// 2. With the face at a known place, the photo's frame is a fixed crop of that square (padded with white for the
//    larger sizes), scaled to the photo's size; then BiRefNet puts the person on the chosen background.
// Where the top of the head is, is estimated (hair goes up to ~45% of the oval's height above it), so the sizes
// aim for the middle of each country's range.
const ID_PHOTO_SIZES = {
  // 35 x 45 mm at 300 dpi (UK, EU, Schengen visas, Australia, India and others): head (chin to crown) 32-36 mm
  eu: { width: 413, height: 531, head: 0.76, top: 0.09 },
  // 2 x 2 in at 300 dpi (US passports and visas): head 1-1 3/8 in, eyes 1 1/8-1 3/8 in from the bottom
  us: { width: 600, height: 600, head: 0.6, top: 0.08 },
};
const ID_PHOTO_DEFAULTS = { size: 'eu', background: '#ffffff' };
const ID_PHOTO_SQUARE = 1024; // step 1's square; the face oval is half its height
const ID_PHOTO_PAD = 512; // white added around it for step 2
const ID_PHOTO_HAIR = 0.45; // the hair above the oval, as a fraction of the oval's height
// Used by: web pages, the result tab, the Library.
function buildIdPhotoWorkflow(targetImage, settings, imageSize, nodeInfo) {
  const size = ID_PHOTO_SIZES[settings.idPhotoSize] || ID_PHOTO_SIZES[ID_PHOTO_DEFAULTS.size];
  const workflow = { "102": inputImageNode(targetImage) };
  const face = addFaceMask(workflow, ["102", 0], nodeInfo, { allFaces: false, minConfidence: 0.5, variant: "short" });
  workflow["120"] = { "inputs": { "value": 0.8, "width": imageSize.width, "height": imageSize.height }, "class_type": "SolidMask", "_meta": { "title": "Keep Everything" } };
  workflow["121"] = { "inputs": { "value": 0.005, "width": imageSize.width, "height": imageSize.height }, "class_type": "SolidMask", "_meta": { "title": "Face Mark" } };
  workflow["122"] = { "inputs": { "destination": face, "source": ["121", 0], "x": 0, "y": 0, "operation": "multiply" }, "class_type": "MaskComposite", "_meta": { "title": "Faint Face" } };
  workflow["123"] = { "inputs": { "destination": ["120", 0], "source": ["122", 0], "x": 0, "y": 0, "operation": "add" }, "class_type": "MaskComposite", "_meta": { "title": "Crop Mask" } };
  workflow["124"] = {
    "inputs": { "images": ["102", 0], "masks": ["123", 0], "width": ID_PHOTO_SQUARE, "height": ID_PHOTO_SQUARE, "pad_factor": 2.0, "grow_mask": 0, "background": "#ffffff" },
    "class_type": "ImageCropToMask",
    "_meta": { "title": "Square Around The Face" }
  };
  workflow["125"] = { "inputs": { "image": ["124", 0] }, "class_type": "ImageInvert", "_meta": { "title": "Undo The Blend (invert)" } };
  workflow["126"] = { "inputs": { "images": ["125", 0], "factor": 1.25 }, "class_type": "AdjustBrightness", "_meta": { "title": "Undo The Blend (scale)" } };
  workflow["127"] = { "inputs": { "image": ["126", 0] }, "class_type": "ImageInvert", "_meta": { "title": "Undo The Blend" } };
  workflow["128"] = { "inputs": { "image": ["127", 0], "left": ID_PHOTO_PAD, "top": ID_PHOTO_PAD, "right": ID_PHOTO_PAD, "bottom": ID_PHOTO_PAD, "feathering": 0 }, "class_type": "ImagePadForOutpaint", "_meta": { "title": "Room Around" } };
  const padded = ID_PHOTO_SQUARE + 2 * ID_PHOTO_PAD;
  workflow["129"] = { "inputs": { "width": padded, "height": padded, "batch_size": 1, "color": 0xffffff }, "class_type": "EmptyImage", "_meta": { "title": "White" } };
  workflow["130"] = { "inputs": { "destination": ["128", 0], "source": ["129", 0], "x": 0, "y": 0, "resize_source": false, "mask": ["128", 1] }, "class_type": "ImageCompositeMasked", "_meta": { "title": "White Room" } };
  // The photo's frame in the square: the oval runs from 1/4 to 3/4 of its height
  const ovalTop = ID_PHOTO_SQUARE / 4;
  const ovalHeight = ID_PHOTO_SQUARE / 2;
  const crown = ovalTop - ID_PHOTO_HAIR * ovalHeight;
  const photoHeight = (ovalTop + ovalHeight - crown) / size.head;
  const photoWidth = photoHeight * size.width / size.height;
  workflow["131"] = {
    "inputs": {
      "image": ["130", 0], "width": Math.round(photoWidth), "height": Math.round(photoHeight),
      "x": Math.round(ID_PHOTO_PAD + ID_PHOTO_SQUARE / 2 - photoWidth / 2), "y": Math.round(ID_PHOTO_PAD + crown - size.top * photoHeight)
    },
    "class_type": "ImageCrop",
    "_meta": { "title": "Photo Frame" }
  };
  workflow["132"] = { "inputs": { "image": ["131", 0], "upscale_method": "lanczos", "width": size.width, "height": size.height, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Photo Size" } };
  workflow["133"] = {
    "inputs": {
      "image": ["132", 0], "model": BACKGROUND_MODEL, "sensitivity": 1.0, "mask_blur": 0, "mask_offset": 0, "invert_output": false, "refine_foreground": false,
      "background": "Color", "background_color": colorSetting(settings.idPhotoBackground, ID_PHOTO_DEFAULTS.background)
    },
    "class_type": "BiRefNetRMBG",
    "_meta": { "title": "Plain Background" }
  };
  workflow["109"] = previewNode(["133", 0]);
  return workflow;
}

// Photo filters, with ComfyUI's own nodes only (no model): pixel art, posterize, sepia, black & white and
// vignette. Strength (0-100) sets each one's amount.
const FILTER_STYLES = ['pixel', 'posterize', 'sepia', 'bw', 'vignette'];
const FILTER_DEFAULTS = { style: 'pixel', strength: 50 };
// Used by: web pages, the result tab, the Library.
function buildFilterWorkflow(targetImage, settings, imageSize) {
  const style = FILTER_STYLES.includes(settings.filterStyle) ? settings.filterStyle : FILTER_DEFAULTS.style;
  const strength = percentSetting(settings.filterStrength, FILTER_DEFAULTS.strength) / 100;
  const { width, height } = imageSize;
  const short = Math.min(width, height);
  const workflow = { "102": inputImageNode(targetImage) };
  const scale = (id, image, method, size, title) => {
    workflow[id] = { "inputs": { "image": image, "upscale_method": method, "width": size.width, "height": size.height, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": title } };
    return [id, 0];
  };
  const smaller = factor => ({ width: Math.max(1, Math.round(width / factor)), height: Math.max(1, Math.round(height / factor)) });
  const luma = () => {
    workflow["120"] = { "inputs": { "image": ["102", 0] }, "class_type": "ImageRGBToYUV", "_meta": { "title": "Brightness" } };
    return ["120", 0];
  };
  let result;
  if (style === 'pixel') {
    // Blocks of 0.5-3% of the short side, in 32 colours
    const block = Math.max(2, Math.round(short * (0.005 + strength * 0.025)));
    const small = scale("121", ["102", 0], "area", smaller(block), "Pixels");
    workflow["122"] = { "inputs": { "image": small, "colors": 32, "dither": "none" }, "class_type": "ImageQuantize", "_meta": { "title": "Palette" } };
    result = scale("123", ["122", 0], "nearest-exact", imageSize, "Pixel Art");
  } else if (style === 'posterize') {
    // 16 colours at 0%, down to 2 at 100%
    workflow["121"] = { "inputs": { "image": ["102", 0], "colors": Math.max(2, Math.round(16 - strength * 14)), "dither": "none" }, "class_type": "ImageQuantize", "_meta": { "title": "Posterize" } };
    result = ["121", 0];
  } else if (style === 'sepia' || style === 'bw') {
    let tone = luma();
    if (style === 'sepia') {
      workflow["121"] = { "inputs": { "width": width, "height": height, "batch_size": 1, "color": 0xffe2b4 }, "class_type": "EmptyImage", "_meta": { "title": "Sepia Tone" } };
      workflow["122"] = { "inputs": { "image1": tone, "image2": ["121", 0], "blend_factor": 1, "blend_mode": "multiply" }, "class_type": "ImageBlend", "_meta": { "title": "Sepia" } };
      tone = ["122", 0];
    }
    workflow["123"] = { "inputs": { "image1": ["102", 0], "image2": tone, "blend_factor": strength, "blend_mode": "normal" }, "class_type": "ImageBlend", "_meta": { "title": "Amount" } };
    result = ["123", 0];
  } else {
    // A 5x5 light map stretched over the image: the middle 3x3 lit, the edges' middles half lit, the corners dark.
    // Bilinear scaling keeps the middle 40% (each way) untouched and fades out from there. Strength is how dark
    // the corners get.
    workflow["121"] = { "inputs": { "value": 0, "width": 5, "height": 5 }, "class_type": "SolidMask", "_meta": { "title": "Dark" } };
    workflow["122"] = { "inputs": { "value": 0.5, "width": 3, "height": 5 }, "class_type": "SolidMask", "_meta": { "title": "Column" } };
    workflow["123"] = { "inputs": { "value": 0.5, "width": 5, "height": 3 }, "class_type": "SolidMask", "_meta": { "title": "Row" } };
    workflow["124"] = { "inputs": { "destination": ["121", 0], "source": ["122", 0], "x": 1, "y": 0, "operation": "add" }, "class_type": "MaskComposite", "_meta": { "title": "Lit Column" } };
    workflow["125"] = { "inputs": { "destination": ["124", 0], "source": ["123", 0], "x": 0, "y": 1, "operation": "add" }, "class_type": "MaskComposite", "_meta": { "title": "Light Map" } };
    workflow["126"] = { "inputs": { "mask": ["125", 0] }, "class_type": "MaskToImage", "_meta": { "title": "As Image" } };
    const light = scale("127", ["126", 0], "bilinear", imageSize, "Over The Image");
    workflow["120"] = { "inputs": { "image": light, "channel": "red" }, "class_type": "ImageToMask", "_meta": { "title": "Light" } };
    workflow["128"] = { "inputs": { "mask": ["120", 0] }, "class_type": "InvertMask", "_meta": { "title": "Shade" } };
    workflow["129"] = { "inputs": { "value": strength, "width": width, "height": height }, "class_type": "SolidMask", "_meta": { "title": "Amount" } };
    workflow["130"] = { "inputs": { "destination": ["128", 0], "source": ["129", 0], "x": 0, "y": 0, "operation": "multiply" }, "class_type": "MaskComposite", "_meta": { "title": "Shade Amount" } };
    workflow["131"] = { "inputs": { "width": width, "height": height, "batch_size": 1, "color": 0 }, "class_type": "EmptyImage", "_meta": { "title": "Black" } };
    workflow["132"] = { "inputs": { "destination": ["102", 0], "source": ["131", 0], "x": 0, "y": 0, "resize_source": false, "mask": ["130", 0] }, "class_type": "ImageCompositeMasked", "_meta": { "title": "Vignette" } };
    result = ["132", 0];
  }
  workflow["109"] = previewNode(result);
  return workflow;
}

// Photo cleanup models, run by ComfyUI's own upscale model nodes at 1x (1xDeJPG / 1xDeNoise realplksr otf, Philip
// Hofmann, CC BY 4.0): they're in models/upscale_models, but they aren't upscalers, so the Upscale workflow doesn't
// offer them
const CLEANUP_MODELS = { jpeg: '1xDeJPG_realplksr_otf.safetensors', noise: '1xDeNoise_realplksr_otf.safetensors' };
const RESTORATION_MODELS = Object.values(CLEANUP_MODELS);
const CLEANUP_DEFAULTS = { mode: 'jpeg' };
// Colourise: DDColor (Kang et al., Apache-2.0) through kijai's ComfyUI-DDColor pack (Apache-2.0), which keeps the
// checkpoint in its own checkpoints folder. ComfyUI's own upscale node can't run DDColor: it splits images into 512px
// tiles, and spandrel's DDColor takes a one-channel image ComfyUI has no node for.
const COLORIZE_NODE = 'DDColor_Colorize';
const COLORIZE_MODEL = 'ddcolor_modelscope.pth';
const COLORIZE_DEFAULTS = { strength: 100 };

// The upscale model file a restoration workflow needs, or an error saying where it goes
// Used by: web pages, the result tab, the Library.
function restorationModel(nodeInfo, file, url) {
  const spec = nodeInfo('UpscaleModelLoader')?.input?.required?.model_name;
  const options = spec ? (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options || []) : [];
  if (!options.includes(file)) {
    throw new Error(`ComfyUI needs the model ${file} in models/upscale_models (${url})`);
  }
  return file;
}

// Colourise: DDColor predicts the colours at 512x512 and puts them under the photo's own brightness at full size.
// Strength blends the colours with the original.
// Used by: web pages, the result tab, the Library.
function buildColorizeWorkflow(targetImage, settings, nodeInfo) {
  if (!nodeInfo(COLORIZE_NODE)) {
    throw new Error("ComfyUI doesn't have the DDColor node (ComfyUI-DDColor by kijai, in ComfyUI Manager)");
  }
  const strength = percentSetting(settings.colorizeStrength, COLORIZE_DEFAULTS.strength) / 100;
  const workflow = {
    "102": inputImageNode(targetImage),
    "104": { "inputs": { "image": ["102", 0], "model_input_size": 512, "checkpoint": COLORIZE_MODEL }, "class_type": COLORIZE_NODE, "_meta": { "title": "Colourise" } },
  };
  let result = ["104", 0];
  if (strength < 1) {
    workflow["121"] = { "inputs": { "image1": ["102", 0], "image2": ["104", 0], "blend_factor": strength, "blend_mode": "normal" }, "class_type": "ImageBlend", "_meta": { "title": "Strength" } };
    result = ["121", 0];
  }
  workflow["109"] = previewNode(result);
  return workflow;
}

// Photo cleanup: a 1x restoration model over the whole image (ComfyUI tiles it), against JPEG artefacts or noise
// Used by: web pages, the result tab, the Library.
function buildCleanupWorkflow(targetImage, settings, nodeInfo) {
  const mode = CLEANUP_MODELS[settings.cleanupMode] ? settings.cleanupMode : CLEANUP_DEFAULTS.mode;
  const model = restorationModel(nodeInfo, CLEANUP_MODELS[mode], `github.com/Phhofm/models/releases/tag/${CLEANUP_MODELS[mode].replace('.safetensors', '')}`);
  return {
    "102": inputImageNode(targetImage),
    "103": { "inputs": { "model_name": model }, "class_type": "UpscaleModelLoader", "_meta": { "title": "Cleanup Model" } },
    "104": { "inputs": { "upscale_model": ["103", 0], "image": ["102", 0] }, "class_type": "ImageUpscaleWithModel", "_meta": { "title": "Clean Up" } },
    "109": previewNode(["104", 0]),
  };
}

// Outfits & styles: Qwen-Image-Edit-2511 (Apache-2.0) with its 4-step Lightning LoRA (lightx2v, Apache-2.0), as in
// ComfyUI's own "Image Edit (Qwen-Image 2511)" template, on ComfyUI's own nodes. It redraws the photo from a preset
// prompt: a new outfit for everyone in it (the face, pose and background kept), or the whole photo in an art style.
// Presets only, no free text: the prompts are written to stay SFW, and the result gets its own NSFW check. The style
// prompts were tuned on test photos: told to keep the likeness or the composition too firmly, the model hardly changes
// the style (and an old black-and-white photo only gets colourised).
const TRANSFORM_MODELS = {
  unet: { file: 'qwen_image_edit_2511_fp8mixed.safetensors', folder: 'diffusion_models', url: 'huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI' },
  clip: { file: 'qwen_2.5_vl_7b_fp8_scaled.safetensors', folder: 'text_encoders', url: 'huggingface.co/Comfy-Org/Qwen-Image_ComfyUI' },
  vae: { file: 'qwen_image_vae.safetensors', folder: 'vae', url: 'huggingface.co/Comfy-Org/Qwen-Image_ComfyUI' },
  lora: { file: 'Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors', folder: 'loras', url: 'huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning' },
};
const TRANSFORM_OUTFIT_KEEP = "Keep each person's face, identity, skin tone, hairstyle, expression and pose, and the background, exactly the same.";
const TRANSFORM_PRESETS = {
  police: { group: 'outfit', label: 'Police officer', outfit: "a police officer's uniform: a dark navy shirt with a badge and shoulder patches, and a peaked police cap" },
  firefighter: { group: 'outfit', label: 'Firefighter', outfit: "a firefighter's turnout gear: a tan fire-resistant coat with reflective stripes, and a firefighter's helmet" },
  nurse: { group: 'outfit', label: 'Nurse', outfit: "a nurse's outfit: loose light blue medical scrubs, with a stethoscope around the neck" },
  doctor: { group: 'outfit', label: 'Doctor', outfit: "a doctor's long white lab coat over smart clothes, with a stethoscope around the neck" },
  soldier: { group: 'outfit', label: 'Soldier', outfit: "a soldier's camouflage combat uniform and a combat helmet, without any weapons" },
  astronaut: { group: 'outfit', label: 'Astronaut', outfit: 'a white astronaut spacesuit with mission patches, without the helmet' },
  pilot: { group: 'outfit', label: 'Airline pilot', outfit: "an airline pilot's uniform: a white shirt with epaulettes, a dark tie, a dark jacket and a pilot's cap" },
  chef: { group: 'outfit', label: 'Chef', outfit: "a white double-breasted chef's jacket and a tall white chef's hat" },
  royalty: { group: 'outfit', label: 'Royalty', outfit: 'royal regalia: a jewelled gold crown, and a long red velvet robe with an ermine fur collar over fine clothes' },
  knight: { group: 'outfit', label: 'Knight', outfit: "a knight's polished steel plate armour, without the helmet" },
  superhero: { group: 'outfit', label: 'Superhero', outfit: 'an original superhero costume with a flowing cape and a simple star emblem on the chest' },
  pirate: { group: 'outfit', label: 'Pirate', outfit: 'a pirate costume: a black tricorn hat, a long red coat and a white ruffled shirt' },
  cowboy: { group: 'outfit', label: 'Cowboy', outfit: 'a cowboy outfit: a brown cowboy hat, a denim shirt, a leather vest and a bandana' },
  wizard: { group: 'outfit', label: 'Wizard', outfit: "a long blue wizard's robe and a tall pointed wizard's hat decorated with stars" },
  graduate: { group: 'outfit', label: 'Graduate', outfit: 'a black graduation gown and a mortarboard cap with a tassel' },
  business: { group: 'outfit', label: 'Business suit', outfit: 'a smart, well-tailored dark business suit' },
  victorian: { group: 'outfit', label: 'Victorian', outfit: 'elegant Victorian-era clothing from the 1880s' },
  cartoon: { group: 'style', label: '3D cartoon', prompt: 'Convert this photo into a 3D cartoon render, like a still from a modern animated movie. Everyone becomes a cute, stylised 3D cartoon character with big eyes and a big head, in the same pose and clothes. Keep the colours of the photo.' },
  anime: { group: 'style', label: 'Anime', prompt: 'Redraw the whole image as an anime illustration: clean line art, flat cel shading, large anime eyes and a painted background. Keep the same people, clothes, poses and composition. Keep the colours of the photo.' },
  comic: { group: 'style', label: 'Comic book', prompt: 'Redraw the whole image as a comic book illustration with bold ink outlines and halftone shading. Keep the same people, clothes, poses and composition.' },
  oilPainting: { group: 'style', label: 'Oil painting', prompt: 'Convert this photo into an impressionist oil painting with heavy impasto brushstrokes, in the style of Van Gogh.' },
  watercolor: { group: 'style', label: 'Watercolour', prompt: 'Repaint the whole image as a loose watercolour painting on textured paper, with soft bleeding washes of colour, visible paper grain and pencil underdrawing. Keep the same people, clothes, poses and composition.' },
  sketch: { group: 'style', label: 'Pencil sketch', prompt: 'Redraw the whole image as a detailed graphite pencil sketch on white paper. Keep the same people, clothes, poses and composition.' },
  popArt: { group: 'style', label: 'Pop art', prompt: 'Redraw the whole image as a pop art screen print: bold flat colours, thick black outlines and Ben-Day halftone dots. Keep the same people, clothes, poses and composition.' },
  clay: { group: 'style', label: 'Claymation', prompt: 'Convert this photo into a claymation stop-motion scene. Each person in the photo becomes a plasticine clay figure with a rounded clay face, and the background is sculpted from plasticine. Do not add any people. Keep the colours of the photo.' },
  renaissance: { group: 'style', label: 'Renaissance painting', prompt: 'Transform this photo into a Renaissance oil painting in the style of Leonardo da Vinci, with sfumato, a dark background and old cracked varnish.' },
  statue: { group: 'style', label: 'Marble statue', prompt: 'Turn the people into carved white marble statues, with smooth polished stone skin, hair and clothes and blank stone eyes, standing in the same room. Keep the same poses and composition.' },
};
const TRANSFORM_DEFAULTS = { preset: 'police', variation: 1 };
const TRANSFORM_PIXELS = 1024 * 1024; // the model works at about one megapixel
const TRANSFORM_STEPS = 4; // the Lightning LoRA's steps, at CFG 1

// The preset's edit instruction
// Used by: web pages, the result tab, the Library, the img2img server.
function transformPrompt(preset) {
  const { outfit, prompt } = TRANSFORM_PRESETS[preset] || TRANSFORM_PRESETS[TRANSFORM_DEFAULTS.preset];
  // (Naming "adults and children" made it worse: it skipped children, and added a child to a photo of one adult)
  return outfit ? `Change the clothes of every person in the photo to ${outfit}. ${TRANSFORM_OUTFIT_KEEP}` : prompt;
}

// The installed name of a model file the workflow needs: the file itself, or one in a subfolder of its folder
// Used by: web pages, the result tab, the Library.
function transformModel(nodeInfo, nodeClass, input, { file, folder, url }) {
  const spec = nodeInfo(nodeClass)?.input?.required?.[input];
  const options = spec ? (Array.isArray(spec[0]) ? spec[0] : spec[1]?.options || []) : [];
  const found = options.find(option => option === file || option.endsWith(`/${file}`) || option.endsWith(`\\${file}`));
  if (!found) {
    throw new Error(`ComfyUI needs ${file} in models/${folder} (${url})`);
  }
  return found;
}

// The working size: the photo's shape at about TRANSFORM_PIXELS, both sides a multiple of 16
function transformSize(imageSize) {
  const scale = Math.sqrt(TRANSFORM_PIXELS / (imageSize.width * imageSize.height));
  const side = length => Math.max(256, Math.round(length * scale / 16) * 16);
  return { width: side(imageSize.width), height: side(imageSize.height) };
}

// Used by: web pages, the result tab, the Library.
function buildTransformWorkflow(targetImage, settings, imageSize, nodeInfo, nsfw) {
  const preset = TRANSFORM_PRESETS[settings.transformPreset] ? settings.transformPreset : TRANSFORM_DEFAULTS.preset;
  const variation = Math.max(1, Math.round(Number(settings.transformVariation) || TRANSFORM_DEFAULTS.variation));
  const models = {
    unet: transformModel(nodeInfo, 'UNETLoader', 'unet_name', TRANSFORM_MODELS.unet),
    clip: transformModel(nodeInfo, 'CLIPLoader', 'clip_name', TRANSFORM_MODELS.clip),
    vae: transformModel(nodeInfo, 'VAELoader', 'vae_name', TRANSFORM_MODELS.vae),
    lora: transformModel(nodeInfo, 'LoraLoaderModelOnly', 'lora_name', TRANSFORM_MODELS.lora),
  };
  const edit = (prompt, title) => ({ "inputs": { "clip": ["111", 0], "prompt": prompt, "vae": ["112", 0], "image1": ["103", 0] }, "class_type": "TextEncodeQwenImageEditPlus", "_meta": { "title": title } });
  const reference = (conditioning, title) => ({ "inputs": { "conditioning": conditioning, "reference_latents_method": "index_timestep_zero" }, "class_type": "FluxKontextMultiReferenceLatentMethod", "_meta": { "title": title } });
  const workflow = {
    "102": inputImageNode(targetImage),
    "103": { "inputs": { "image": ["102", 0], "upscale_method": "lanczos", ...transformSize(imageSize), "crop": "center" }, "class_type": "ImageScale", "_meta": { "title": "Working Size" } },
    "110": { "inputs": { "unet_name": models.unet, "weight_dtype": "default" }, "class_type": "UNETLoader", "_meta": { "title": "Qwen-Image-Edit 2511" } },
    "111": { "inputs": { "clip_name": models.clip, "type": "qwen_image", "device": "default" }, "class_type": "CLIPLoader", "_meta": { "title": "Qwen2.5-VL Text Encoder" } },
    "112": { "inputs": { "vae_name": models.vae }, "class_type": "VAELoader", "_meta": { "title": "Qwen-Image VAE" } },
    "113": { "inputs": { "model": ["110", 0], "shift": 3.1 }, "class_type": "ModelSamplingAuraFlow", "_meta": { "title": "Shift" } },
    "114": { "inputs": { "model": ["113", 0], "strength": 1 }, "class_type": "CFGNorm", "_meta": { "title": "CFG Norm" } },
    "115": { "inputs": { "model": ["114", 0], "lora_name": models.lora, "strength_model": 1 }, "class_type": "LoraLoaderModelOnly", "_meta": { "title": "Lightning (4 steps)" } },
    "120": edit(transformPrompt(preset), 'Edit Instruction'),
    "121": edit('', 'Negative'),
    "122": reference(["120", 0], 'Positive Reference'),
    "123": reference(["121", 0], 'Negative Reference'),
    "124": { "inputs": { "pixels": ["103", 0], "vae": ["112", 0] }, "class_type": "VAEEncode", "_meta": { "title": "Encode" } },
    "125": {
      "inputs": { "model": ["115", 0], "seed": variation, "steps": TRANSFORM_STEPS, "cfg": 1, "sampler_name": "euler", "scheduler": "simple", "positive": ["122", 0], "negative": ["123", 0], "latent_image": ["124", 0], "denoise": 1 },
      "class_type": "KSampler",
      "_meta": { "title": "Redraw" }
    },
    "126": { "inputs": { "samples": ["125", 0], "vae": ["112", 0] }, "class_type": "VAEDecode", "_meta": { "title": "Decode" } },
    // Back to the photo's own size, like every other workflow's result, so it fits the page image's place
    "127": { "inputs": { "image": ["126", 0], "upscale_method": "lanczos", "width": imageSize.width, "height": imageSize.height, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Photo Size" } },
  };
  // The redrawn photo is new content, so it's checked too, not only the photo it came from
  const result = nsfw.enabled ? addSafetyCheck(workflow, ["127", 0], "162", nsfw, 'result') : ["127", 0];
  workflow["109"] = previewNode(result);
  return workflow;
}

// The ComfyUI nodes a shared workflow's builder asks about (nodeInfo), so local mode can look them up first
// Used by: web pages, the result tab, the Library, the img2img server.
function workflowNodeQueries(workflow, settings) {
  return {
    controlnet: [settings.controlnetPreprocessor || CONTROLNET_DEFAULT_PREPROCESSOR],
    faceBlur: ['LoadMediaPipeFaceLandmarker'],
    colorize: [COLORIZE_NODE],
    segment: [SEGMENT_NODE],
    cleanup: ['UpscaleModelLoader'],
    idPhoto: ['LoadMediaPipeFaceLandmarker'],
    transform: ['UNETLoader', 'CLIPLoader', 'VAELoader', 'LoraLoaderModelOnly'],
  }[workflow] || [];
}

// Restore every face in the photo with a face restore model, without swapping it (old or low-res photos)
// Used by: web pages, the result tab, the Library.
function buildRestoreWorkflow(targetImage, settings) {
  const strength = Number(settings.restoreStrength ?? RESTORE_DEFAULTS.strength) / 100;
  const fidelity = Number(settings.restoreFidelity ?? RESTORE_DEFAULTS.fidelity) / 100;
  return {
    "102": inputImageNode(targetImage),
    "104": {
      "inputs": { "image": ["102", 0], "facedetection": "retinaface_resnet50", "model": RESTORE_MODELS.includes(settings.restoreModel) ? settings.restoreModel : RESTORE_DEFAULTS.model, "visibility": strength, "codeformer_weight": fidelity },
      "class_type": "ReActorRestoreFace",
      "_meta": { "title": "Restore Faces" }
    },
    "109": previewNode(["104", 0]),
  };
}

// img2img is for SFW images only. Every image a workflow touches -- the page image, any source images and the
// result -- is checked with comfyui-tooling-nodes' ETN_NSFWFilter, which every img2img ComfyUI needs (it also
// loads the images). Each check adds a small output of its own, which whatever collects the result reads first
// (safetyProbes): a job whose check failed is refused there, before the result is read. nsfw is
// { enabled, sensitivity }: the server's config for hosted jobs, the extension's for local mode.
const NSFW_CHECK_NODE = 'ETN_NSFWFilter';
const NSFW_PROBE_SIZE = 64;

// Checks `image` (a link) as checkId; returns the link to use instead (the filter's output). label names the
// image in the refusal ("target image", "result"...).
// Used by: web pages, the result tab, the Library, the img2img server.
function addSafetyCheck(workflow, image, checkId, nsfw, label) {
  workflow[checkId] = { "inputs": { "image": image, "sensitivity": nsfw.sensitivity }, "class_type": NSFW_CHECK_NODE, "_meta": { "title": `NSFW Check (${label})` } };
  const difference = (name, first, second) => {
    workflow[`${checkId}:${name}`] = { "inputs": { "image1": first, "image2": second, "blend_factor": 1, "blend_mode": "difference" }, "class_type": "ImageBlend", "_meta": { "title": "NSFW Check difference" } };
    return [`${checkId}:${name}`, 0];
  };
  workflow[`${checkId}:difference`] = {
    "inputs": { "image1": difference('above', image, [checkId, 0]), "image2": difference('below', [checkId, 0], image), "blend_factor": 1, "blend_mode": "screen" },
    "class_type": "ImageBlend",
    "_meta": { "title": "NSFW Check difference" }
  };
  workflow[`${checkId}:small`] = { "inputs": { "image": [`${checkId}:difference`, 0], "upscale_method": "area", "width": NSFW_PROBE_SIZE, "height": NSFW_PROBE_SIZE, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "NSFW Check probe size" } };
  // img2img_probe marks it for safetyProbes; ComfyUI ignores _meta
  workflow[`${checkId}:probe`] = { "inputs": { "images": [`${checkId}:small`, 0] }, "class_type": "PreviewImage", "_meta": { "title": "NSFW Check probe", "img2img_probe": label } };
  return [checkId, 0];
}

// The target image is checked before anything else uses it: every node that read the loader reads the check
// Used by: web pages, the result tab, the Library, the img2img server.
function addSafetyGate(workflow, loaderNodeId, gateNodeId, nsfw) {
  if (!nsfw.enabled) {
    return workflow;
  }
  for (const node of Object.values(workflow)) {
    for (const [name, value] of Object.entries(node.inputs)) {
      if (Array.isArray(value) && value[0] === loaderNodeId && value[1] === 0) {
        node.inputs[name] = [gateNodeId, 0];
      }
    }
  }
  addSafetyCheck(workflow, [loaderNodeId, 0], gateNodeId, nsfw, 'target image');
  return workflow;
}

// A graph's NSFW probes: [{ node, label }]
// Used by: web pages, the result tab, the Library, the img2img server.
function safetyProbes(workflow) {
  return Object.entries(workflow)
    .filter(([, node]) => node.class_type === 'PreviewImage' && node._meta?.img2img_probe)
    .map(([node, { _meta }]) => ({ node, label: _meta.img2img_probe }));
}

// A graph's result: the node marked img2img_result ("Final Result"), the only output whose image is shown. Other
// outputs can have images too (a probe, or a sampler that previews its own image), so it's never "the first".
// Used by: web pages, the result tab, the Library, My workflows, the img2img server.
function resultNode(workflow) {
  return Object.keys(workflow).find(node => workflow[node]._meta?.img2img_result) ?? null;
}

// The refusal for a flagged probe, worded the same everywhere
// Used by: web pages, the result tab, the Library, the img2img server.
function nsfwRefusal(label) {
  return `The ${label} looks NSFW, so it wasn't processed. img2img is for SFW images only.`;
}

// Build one of SHARED_WORKFLOWS with the NSFW gate on its input image (and on a source image it uses). options:
// { nodeInfo, nsfw, sourceImages } (see buildControlnetWorkflow and addSafetyGate; sourceImages: the Source grid's
// images, as base64 or data URLs, for the workflows that use one: usesSourceImage).
// Used by: web pages, the result tab, the Library, the img2img server.
function buildSharedWorkflow(workflow, targetImage, settings, imageSize, { nodeInfo, nsfw, sourceImages = [] }) {
  const graph = {
    controlnet: () => buildControlnetWorkflow(targetImage, settings, imageSize, nodeInfo),
    upscale: () => buildUpscaleWorkflow(targetImage, settings, imageSize),
    background: () => buildBackgroundWorkflow(targetImage, settings, imageSize, sourceImages, nsfw),
    restore: () => buildRestoreWorkflow(targetImage, settings),
    sticker: () => buildStickerWorkflow(targetImage, settings, imageSize),
    idPhoto: () => buildIdPhotoWorkflow(targetImage, settings, imageSize, nodeInfo),
    faceBlur: () => buildFaceBlurWorkflow(targetImage, settings, imageSize, nodeInfo),
    filter: () => buildFilterWorkflow(targetImage, settings, imageSize),
    colorize: () => buildColorizeWorkflow(targetImage, settings, nodeInfo),
    cleanup: () => buildCleanupWorkflow(targetImage, settings, nodeInfo),
    transform: () => buildTransformWorkflow(targetImage, settings, imageSize, nodeInfo, nsfw),
    segment: () => buildSegmentWorkflow(targetImage, settings, nodeInfo),
  }[workflow];
  if (!graph) {
    throw new Error(`Unknown workflow: ${workflow}`);
  }
  return addSafetyGate(graph(), "102", "160", nsfw);
}

// The account the API key belongs to, as the img2img server says: its credits and where more are bought.
// { reached: false } when the server can't be reached; with error set when it answers that it can't say (no key, a
// revoked one), and credits null in both cases.
// Used by: the Library, the popup.
async function fetchAccount() {
  const response = await chrome.runtime.sendMessage({ action: 'apiRequest', url: '/v1/me', method: 'GET' }).catch(() => null);
  const reached = Boolean(response?.success);
  const known = reached && response.status === 200;
  return {
    reached,
    credits: known ? response.data.credits ?? null : null,
    creditsUrl: known ? response.data.creditsUrl || null : null,
    error: reached && !known ? response.data?.error || `The img2img server returned HTTP ${response.status}` : '',
  };
}

// What the img2img server offers: its workflows, what each costs in credits, how long each usually takes, and the
// ControlNet preprocessors and upscale models it has. answered is false when it can't be reached or says nothing
// usable; the lists are then empty (preprocessors and upscaleModels null, which is "unknown" to the popup).
// Used by: the Library, the popup.
async function fetchServerWorkflows() {
  const response = await chrome.runtime.sendMessage({ action: 'apiRequest', url: '/v1/workflows', method: 'GET' }).catch(() => null);
  const answered = Boolean(response?.success) && response.status === 200 && Array.isArray(response.data?.workflows);
  return {
    answered,
    workflows: answered ? response.data.workflows : [],
    credits: answered ? response.data.credits || {} : {},
    preprocessors: answered ? response.data.preprocessors || {} : null,
    upscaleModels: answered ? response.data.upscaleModels || [] : null,
    typicalWaits: answered ? response.data.typicalWaitMs || {} : {},
  };
}

// "Ask Before" (autoAskOver, in the settings): a run of more images than this says how many and what they cost
// first. Unset means the default, which the settings page shows too; 0 is "never ask". The popup asks for Automatic
// Selection, the Library page for its Process selected.
const DEFAULT_ASK_OVER = 20;

// Used by: the Library, the popup.
function askOverLimit(autoAskOver) {
  return autoAskOver === undefined ? DEFAULT_ASK_OVER : Math.round(Number(autoAskOver)) || 0;
}

// What a run of count images costs, as the end of that question: said only for the img2img server, and only when
// the workflow's credits are known
// Used by: the Library, the popup.
function runCostText(count, creditsEach, onServer) {
  const total = Number.isFinite(creditsEach) ? count * creditsEach : null;
  return onServer && total !== null ? ` That costs about ${total} credit${total === 1 ? '' : 's'}.` : '';
}

// "Jobs at Once": how many jobs run at a time. One on the img2img server; My ComfyUI is the user's own GPU, so the
// setting lets it have up to JOBS_AT_ONCE_MOST.
const JOBS_AT_ONCE_MOST = 4;

// Used by: the Library, the background script.
function jobsAtOnceFor(setting, processingMode) {
  const wanted = processingMode === 'local' ? Math.round(Number(setting)) || 1 : 1;
  return Math.min(Math.max(wanted, 1), JOBS_AT_ONCE_MOST);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TERMS_VERSION, TERMS_URL, ACCEPTABLE_USE_URL, HOSTED_MAX_TARGET_BYTES, HOSTED_MAX_SOURCE_BYTES, HOSTED_MAX_SOURCE_IMAGES, SWAP_WORKFLOWS, SHARED_WORKFLOWS, DEFAULT_WORKFLOW, WORKFLOW_REPLACEMENTS, WORKFLOW_LABELS, CONTROLNET_DEFAULT_PREPROCESSOR, CONTROLNET_DEFAULT_RESOLUTION, CONTROLNET_PREPROCESSORS,
    UPSCALE_DEFAULT_MODEL, UPSCALE_DEFAULT_SCALE, BACKGROUND_DEFAULTS, RESTORE_DEFAULTS, RESTORE_MODELS, effectiveWorkflow,
    STICKER_DEFAULTS, FACE_BLUR_DEFAULTS, ID_PHOTO_SIZES, ID_PHOTO_DEFAULTS, FILTER_STYLES, FILTER_DEFAULTS,
    FACE_DETECTION_MODEL, usesSourceImage, workflowNodeQueries, COLORIZE_NODE, COLORIZE_MODEL, CLEANUP_MODELS, RESTORATION_MODELS, COLORIZE_DEFAULTS, CLEANUP_DEFAULTS,
    TRANSFORM_MODELS, TRANSFORM_PRESETS, TRANSFORM_DEFAULTS, transformPrompt,
    SEGMENT_NODE, SEGMENT_OUTPUTS, SEGMENT_DEFAULTS, SEGMENT_PROMPT_MAX, SEGMENT_THRESHOLD_RANGE, segmentPrompt,
    imageBlurInputs, controlnetInputValue, NSFW_CHECK_NODE, addSafetyCheck, addSafetyGate, safetyProbes, resultNode, nsfwRefusal, buildSharedWorkflow,
  };
}
