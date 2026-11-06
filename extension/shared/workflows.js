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
const TERMS_VERSION = '2026-11-04';
const TERMS_URL = 'https://img2img.shop/terms';
const ACCEPTABLE_USE_URL = 'https://img2img.shop/acceptable-use';

// ImageBlur inputs within the node's limits (radius 1-31, sigma 0.1-10). Blurs scale with the image, and
// ComfyUI rejects the whole workflow when one is out of range, so large photos would fail otherwise.
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

// Simple image workflows without a source face: upscale, background removal/blur and face restore.
const FACE_WORKFLOWS = [];
const SHARED_WORKFLOWS = ['controlnet', 'upscale', 'background', 'restore'];
// The workflow until one is chosen (a new install has none saved)
const DEFAULT_WORKFLOW = 'background';

// The workflow that actually runs
function effectiveWorkflow(settings) { return settings.workflow; }
// 4xNomos8k_atd_jpg (Philip Hofmann, CC BY 4.0): licensed for commercial use, with credit. 4x-UltraSharp, Remacri
// and most other popular upscalers are CC BY-NC-SA, so they're never the default (worker/cleared.json).
const UPSCALE_DEFAULT_MODEL = '4xNomos8k_atd_jpg.safetensors';
const UPSCALE_DEFAULT_SCALE = 2;
const UPSCALE_MAX_SIDE = 4096; // longest side of an upscaled result, so results stay a sensible size
const BACKGROUND_MODEL = 'BiRefNet-general'; // the BiRefNet model installed with comfyui-rmbg
const BACKGROUND_DEFAULTS = { mode: 'transparent', color: '#ffffff', blur: 50 };
const RESTORE_DEFAULTS = { model: 'GFPGANv1.4.pth', strength: 100, fidelity: 50 };
// The face restore models offered: GFPGAN (Apache-2.0). CodeFormer (S-Lab) and GPEN (Alibaba) are
// non-commercial, so they were removed; a saved one falls back to the default.
const RESTORE_MODELS = ['GFPGANv1.4.pth', 'GFPGANv1.3.pth'];

function inputImageNode(targetImage) {
  return { "inputs": { "image": targetImage }, "class_type": "ETN_LoadImageBase64", "_meta": { "title": "Input Image" } };
}

function previewNode(image) {
  // PreviewImage: result goes to ComfyUI's temp folder, not output/
  return { "inputs": { "images": image }, "class_type": "PreviewImage", "_meta": { "title": "Final Result", "img2img_result": true } };
}

// Upscale with an ESRGAN-style model (it upscales by its own factor), then scale to the chosen factor,
// capped so the longest side stays within UPSCALE_MAX_SIDE. A larger image is shrunk first so a 4x model's
// output stays within UPSCALE_MAX_SIDE too: at 2048px the 8192px intermediate took minutes on the GPU.
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

// Background removal with BiRefNet: a transparent PNG, a solid colour, or the background blurred like a
// portrait-mode photo (the foreground pasted sharp over a blurred copy through BiRefNet's mask)
function buildBackgroundWorkflow(targetImage, settings, imageSize) {
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
  if (mode !== 'blur') {
    workflow["109"] = previewNode(["103", 0]);
    return workflow;
  }
  // A strong blur on a large image needs more than ImageBlur's limits (radius 31, sigma 10), so blur a
  // smaller copy and scale it back up. Strength 100% is a blur of 3% of the image's short side.
  const strength = Number(settings.backgroundBlur ?? BACKGROUND_DEFAULTS.blur) / 100;
  const sigma = Math.max(0.5, strength * 0.03 * Math.min(imageSize.width, imageSize.height));
  const shrink = Math.max(1, sigma / 6);
  const small = { width: Math.max(8, Math.round(imageSize.width / shrink)), height: Math.max(8, Math.round(imageSize.height / shrink)) };
  workflow["104"] = { "inputs": { "image": ["102", 0], "upscale_method": "area", ...small, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Shrink For Blur" } };
  workflow["105"] = { "inputs": imageBlurInputs(["104", 0], Math.ceil(3 * sigma / shrink), sigma / shrink), "class_type": "ImageBlur", "_meta": { "title": "Blur Background" } };
  workflow["106"] = { "inputs": { "image": ["105", 0], "upscale_method": "bilinear", "width": imageSize.width, "height": imageSize.height, "crop": "disabled" }, "class_type": "ImageScale", "_meta": { "title": "Back To Full Size" } };
  workflow["107"] = {
    "inputs": { "destination": ["106", 0], "source": ["102", 0], "x": 0, "y": 0, "resize_source": false, "mask": ["103", 1] },
    "class_type": "ImageCompositeMasked",
    "_meta": { "title": "Sharp Foreground Over Blur" }
  };
  workflow["109"] = previewNode(["107", 0]);
  return workflow;
}

// Restore every face in the photo with a face restore model, without swapping it (old or low-res photos)
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

// img2img is for SFW images only. Images are checked with comfyui-tooling-nodes' ETN_NSFWFilter (the CompVis
// safety checker), which every img2img ComfyUI has (it also loads the images). The filter doesn't stop a
// workflow: it returns an unflagged image untouched and a blurred copy of a flagged one. So each check also gets
// a probe: the difference between the image before and after the filter (both ways), shrunk to 64x64 and saved
// as a preview. An unflagged image's probe is exactly black. Whatever collects the result (the extension, the
// RunPod worker, the server's ComfyUI provider) reads every probe first (safetyProbes) and refuses the job, before
// the result is read, if any probe pixel isn't black. nsfw is { enabled, sensitivity }: the server's config for
// hosted jobs, the extension's for local mode.
const NSFW_CHECK_NODE = 'ETN_NSFWFilter';
const NSFW_PROBE_SIZE = 64;

// Checks `image` (a link) as checkId; returns the link to use instead (the filter's output). label names the
// image in the refusal ("target image", "result"...).
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
function safetyProbes(workflow) {
  return Object.entries(workflow)
    .filter(([, node]) => node.class_type === 'PreviewImage' && node._meta?.img2img_probe)
    .map(([node, { _meta }]) => ({ node, label: _meta.img2img_probe }));
}

// A graph's result: the node marked img2img_result ("Final Result"), the only output whose image is shown. Other
// outputs can have images too (a probe, or a sampler that previews its own image), so it's never "the first".
function resultNode(workflow) {
  return Object.keys(workflow).find(node => workflow[node]._meta?.img2img_result) ?? null;
}

// The refusal for a flagged probe, worded the same everywhere
function nsfwRefusal(label) {
  return `The ${label} looks NSFW, so it wasn't processed. img2img is for SFW images only.`;
}

// Build one of SHARED_WORKFLOWS with the NSFW gate on its input image. options: { nodeInfo, nsfw } (see
// buildControlnetWorkflow and addSafetyGate).
function buildSharedWorkflow(workflow, targetImage, settings, imageSize, { nodeInfo, nsfw }) {
  const graph = {
    controlnet: () => buildControlnetWorkflow(targetImage, settings, imageSize, nodeInfo),
    upscale: () => buildUpscaleWorkflow(targetImage, settings, imageSize),
    background: () => buildBackgroundWorkflow(targetImage, settings, imageSize),
    restore: () => buildRestoreWorkflow(targetImage, settings),
  }[workflow];
  if (!graph) {
    throw new Error(`Unknown workflow: ${workflow}`);
  }
  return addSafetyGate(graph(), "102", "160", nsfw);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    TERMS_VERSION, TERMS_URL, ACCEPTABLE_USE_URL, FACE_WORKFLOWS, SHARED_WORKFLOWS, DEFAULT_WORKFLOW, CONTROLNET_DEFAULT_PREPROCESSOR, CONTROLNET_DEFAULT_RESOLUTION, CONTROLNET_PREPROCESSORS,
    UPSCALE_DEFAULT_MODEL, UPSCALE_DEFAULT_SCALE, BACKGROUND_DEFAULTS, RESTORE_DEFAULTS, RESTORE_MODELS, effectiveWorkflow,
    imageBlurInputs, controlnetInputValue, NSFW_CHECK_NODE, addSafetyCheck, addSafetyGate, safetyProbes, resultNode, nsfwRefusal, buildSharedWorkflow,
  };
}
