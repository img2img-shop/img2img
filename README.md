# img2img

A browser extension (Chrome, Firefox, Edge, Brave, Opera, Vivaldi) that sends any image on a web page through ComfyUI: upscale it, remove or blur its background,
restore old photos, turn it into a ControlNet map, or run **your own ComfyUI workflows** on it, with their settings
in the extension's popup.

Pick an image on the page (or let the extension process every image in view), and the result replaces it in
place, with buttons to download it, flip back to the original, or compare the two side by side.

It runs two ways:

- **On your own ComfyUI** (free): the extension builds the workflow and sends it to your ComfyUI. Your images go
  only to your machine.
- **On the img2img service** ([img2img.shop](https://img2img.shop)): no GPU needed. Images are processed on hosted
  GPUs, paid for with credits.

## My workflows

Bring any ComfyUI workflow that takes an image:

1. In the popup, under the workflow choice, open **My workflows: add or edit…**.
2. Upload a workflow saved from ComfyUI (a normal save, subgraphs included, or an Export (API) file).
3. The workflow is drawn the way ComfyUI shows it. Click its nodes to choose:
   - the **Load Image** node that gets the image from the page,
   - any Load Image nodes that get a **source** picked in the popup (a face, an object to add, a style
     reference: one image or several as a batch). Load Image nodes that feed the same node, like the inputs of a
     batch, share one picker and get the source's images in order,
   - the **Save** or **Preview Image** node that gives the result.
4. Tick the inputs you want in the popup (prompts, strengths, steps, models, seeds...), name them and put them in
   order. A seed can be a new random number for each image.

Your workflows appear under **My workflows** in the popup. When one runs, only the chosen output is kept and it's
saved as a preview, so nothing piles up in ComfyUI's `output` folder.

## Install

1. Install the extension, one of these ways:
   - **From the browser's store:** see [img2img.shop/install](https://img2img.shop/install) for every browser.
   - **From a release:** download the ZIP for your browser from this repo's Releases.
     - Chrome and the other Chromium browsers: unzip `img2img-chromium-<version>.zip`, open the browser's
       extensions page (`chrome://extensions`), turn on Developer mode, choose **Load unpacked** and pick the
       unzipped folder.
     - Firefox: open `about:debugging#/runtime/this-firefox`, choose **Load Temporary Add-on** and pick
       `img2img-firefox-<version>.zip`. Firefox removes it when it restarts; for a permanent install, use the store.
   - **For development:** load the `extension` folder unpacked in a Chromium browser. Its ID is fixed there
     (`fbkmcmaknjlmdgocomnkhhjoipbopdmn`); store installs get the store's own ID.
2. To use your own ComfyUI, open the popup's **Settings**, set **Processing** to **My ComfyUI** and check the
   ComfyUI address (default `http://127.0.0.1:8188`).

### ComfyUI setup

- Start ComfyUI so it accepts requests from the extension:

  ```
  python main.py --enable-cors-header fbkmcmaknjlmdgocomnkhhjoipbopdmn
  ```

- The one custom node pack every workflow needs:
  [comfyui-tooling-nodes](https://github.com/Acly/comfyui-tooling-nodes). It loads the page image and provides
  the safety checker.
- For the built-in workflows:
  - **ControlNet map**: [comfyui_controlnet_aux](https://github.com/Fannovel16/comfyui_controlnet_aux). The popup
    lists the preprocessors you have installed, with their options.
  - **Background removal / blur**: [ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG) with BiRefNet-general.
  - **Upscale**: any upscale model in `models/upscale_models`.
  - **Face restore**: GFPGAN models and a face restore node pack (ComfyUI Manager's *Install Missing Custom
    Nodes* finds it once the workflow has run).

## Safe for work only

img2img is for SFW images. Every workflow, including your own, checks the page image, every source image and
the result with the CompVis safety checker from comfyui-tooling-nodes. If any of them is flagged, nothing is
shown or saved by the extension. Without the safety checker in ComfyUI, the extension refuses to run anything.

## Repository layout

- `extension/`: the browser extension (Manifest V3, no build step for Chromium browsers).
  - `popup.*`: workflow choice and settings. `content.js`: picking images on the page and showing results.
    `background.js`: requests to ComfyUI and the img2img service, the source and result storage.
  - `workflows.*`: the My workflows page. `shared/custom-workflows.js`: reading ComfyUI workflow files and
    building what runs. `shared/workflows.js`: the built-in workflows and the NSFW check.
- `tools/dev-reload.js`: reloads the unpacked extension when files change (`node tools/dev-reload.js`, then turn
  on Dev Auto-Reload in the popup's Settings).
- `tools/build-release.mjs`: builds the release ZIPs from the last commit (`node tools/build-release.mjs`, into
  `dist/extension/<version>/`). The Firefox package gets its own manifest (an event page instead of a service
  worker, and Firefox's add-on settings) and is checked with Mozilla's linter (`--no-lint` skips it).

## Licence

Everything here is under the [PolyForm Noncommercial License 1.0.0](LICENSE): free to use, study, change and share for any noncommercial
purpose (personal projects, research, education, hobby use). Commercial use needs a separate licence: write to
img2imgshop@gmail.com.
