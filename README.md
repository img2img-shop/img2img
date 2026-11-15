# img2img

A browser extension (Chrome, Firefox, Edge, Brave, Opera, Vivaldi) that sends any image on a web page through ComfyUI: upscale it, remove, replace or blur its background,
restore or colourise an old photo, clean up a compressed one, make a sticker or a passport photo of it, blur its
faces, give it a filter or an art style, change what someone is wearing, cut out whatever you name, turn it into a ControlNet map,
or run **your own ComfyUI workflows** on it, with their settings in the extension's popup.

Pick an image on the page (or let the extension process every image in view), and the result replaces it in
place, with buttons to download it, flip back to the original, compare the two side by side, or pick between
every result that image has had. They sit in its corner for as long as the result does, or wait for the pointer
to be over the image if you'd rather (**Show Icons on Hover** in the settings). A video works the same way: click it and the frame it's showing goes through
the workflow, and its processed moments come back when the page is loaded again. The process again button runs
an image through again once you've changed a setting, and the right-click menu downloads the result, the picture as
it is, or the frame a video is showing.

Pictures on your own computer work too: the popup's **Library…** opens a folder (or single files) of images and
videos, where you process one, a selection or all of them, compare each result with its original, and save the
results one by one, all at once, or as a ZIP laid out like the folder. Opening a folder sends nothing anywhere.

Jobs queue up and are sent one at a time, and they go on running when you leave the page. The extension's
settings page has the download folder and file names, whether those buttons wait for a hover, the caps for
automatic selection, how long results stay in the cache, and rules per site (never run here, automatic selection
only here, this workflow here).

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
   order. A seed can be a new random number for each image. A number's slider covers what the node allows, which
   is often far more than makes sense: narrow its range, and the slider covers only the useful part (-3 to 3 for a
   LoRA strength the node takes from -10 to 10). A text input can be a dropdown or a slider over choices you
   write, each a label and the text it puts in.
5. Give any node an on/off switch in the popup, set to bypass or mute it as ComfyUI does, so an optional step
   costs a click instead of a second workflow.
6. In the popup, **Presets** saves the values of some settings under a name, to put them all in with one click.

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
  - **Background removal / blur** and **Sticker**: [ComfyUI-RMBG](https://github.com/1038lab/ComfyUI-RMBG) with
    BiRefNet-general. A background replaced by an image uses the image selected under Source.
  - **Cut out by prompt**: ComfyUI-RMBG's SAM3 Segmentation node (Meta's SAM 3, SAM License). It downloads
    [`sam3.pt`](https://huggingface.co/1038lab/sam3) (about 3.5 GB) into `models/sam3` the first time it runs. Type a
    short name ("dog", "bridge"); everything that matches is cut out, removed, or given as a black-and-white mask.
  - **ID / passport photo** and **Blur faces**: ComfyUI's own face detection, with
    [`mediapipe_face_fp32.safetensors`](https://huggingface.co/Comfy-Org/mediapipe) in `models/detection` (ID photos
    also use ComfyUI-RMBG for the plain background). Needs a recent ComfyUI.
  - **Photo filter**: nothing more, only ComfyUI's own nodes.
  - **Colourise**: [ComfyUI-DDColor](https://github.com/kijai/ComfyUI-DDColor). It downloads `ddcolor_modelscope.pth`
    (about 900 MB) the first time it runs.
  - **Photo cleanup**: [1xDeJPG_realplksr_otf](https://github.com/Phhofm/models/releases/tag/1xDeJPG_realplksr_otf) and
    [1xDeNoise_realplksr_otf](https://github.com/Phhofm/models/releases/tag/1xDeNoise_realplksr_otf) in
    `models/upscale_models`.
  - **Upscale**: any upscale model in `models/upscale_models`.
  - **Outfits & styles**: ComfyUI's own Qwen-Image-Edit nodes (a recent ComfyUI) and a GPU with at least 16 GB of
    memory, with the four files of ComfyUI's Qwen-Image-Edit 2511 template (about 31 GB):
    [`qwen_image_edit_2511_fp8mixed.safetensors`](https://huggingface.co/Comfy-Org/Qwen-Image-Edit_ComfyUI/tree/main/split_files/diffusion_models)
    in `models/diffusion_models`,
    [`qwen_2.5_vl_7b_fp8_scaled.safetensors`](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/tree/main/split_files/text_encoders)
    in `models/text_encoders`,
    [`qwen_image_vae.safetensors`](https://huggingface.co/Comfy-Org/Qwen-Image_ComfyUI/tree/main/split_files/vae)
    in `models/vae` and
    [`Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors`](https://huggingface.co/lightx2v/Qwen-Image-Edit-2511-Lightning)
    in `models/loras`. All Apache-2.0.
  - **Face restore**: GFPGAN models and a face restore node pack (ComfyUI Manager's *Install Missing Custom
    Nodes* finds it once the workflow has run).

## Safe for work only

img2img is for SFW images. Every workflow, including your own, checks the page image, every source image and
the result with the CompVis safety checker from comfyui-tooling-nodes. If any of them is flagged, nothing is
shown or saved by the extension. Without the safety checker in ComfyUI, the extension refuses to run anything.

## What the extension sends

Running on your own ComfyUI, your images go to your ComfyUI and nowhere else. The one request the extension
makes to img2img.shop either way is a check for announcements, so it can tell you about a new feature or a
problem with the service. It asks once a day, and in between only if it hasn't asked in the last 15 minutes: when
you open the popup, and when an image can't be edited because the img2img service can't be reached (the error on
the page then says what's wrong, if there's an announcement about it):

```
GET https://img2img.shop/announcements.json
```

It has no parameters, no account, no identifiers and no version number, which is why each announcement carries
the versions and browsers it's for and the extension picks the ones that apply (`checkAnnouncements` in
`extension/background.js`). Cookies aren't sent, and nothing that comes back is ever executed: the popup and the
page's error message show it as text, with https links only. An announcement can carry an end time, after which
the extension stops showing it without asking again. The site counts these requests to see how many people use
the extension — one anonymous hash per day, however often a browser asks, that no IP address can be recovered
from, the same as its page views — because people running their own ComfyUI don't show up anywhere else. Turn it
off with the **Announcements** setting on the settings page, and nothing is sent at all.

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
purpose (personal projects, research, education, hobby use). Source available rather than open source, since that
licence isn't an OSI one.

**Paid work is covered if you buy credits.** While your [img2img](https://img2img.shop) account has had credits
bought for it, you may use img2img commercially, including for client work, on the service or on your own ComfyUI
— the [additional grant](LICENSE) at the top of the licence says so. It covers using and changing img2img, not
redistributing it.

Anything else commercial, and any redistribution, needs a separate licence: write to img2imgshop@gmail.com.
