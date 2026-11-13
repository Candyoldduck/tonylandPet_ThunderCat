# Reference

Details behind the workflow in the [README](../README.md).

## Projects

Open the local URL printed by Vite. Choose **Open project** and select a project from the local
list, or use **Browse for a project folder…** to select its folder. A project contains
`rig.json`, `source.png` and `built/`. **Load rig.json only…** replaces the rig without loading images.
The header shows the project name with buttons to copy its full path and open its folder.
**Save rig** and Ctrl/Cmd+S save a listed project directly to `rig.json`, keeping the previous
file as `rig.json.bak`. The sample is read-only, and browser-picked folders use a JSON download.
Local project access is available only through the development server on 127.0.0.1; a static
build keeps the folder picker and download workflow. Images stay on this machine.
**Recent** keeps up to ten opened projects in this browser and can reopen the last project
on start. Remove individual entries, clear the history, or disable automatic reopening in
the project menu. Supported browsers retain a directory handle for picked folders and may
ask for permission again; other browsers show **Browse again**. Image data is never stored
in this history.

```text
project/
  rig.json
  source.png
  built/
    layers.json
    base.png
    hairmask.png
    eye0_ball.png
    ...other cut-out layers named in layers.json
    sprites/                 # optional drawn eye/mouth variants
      sprites.json
      ...sprite images
```

## Build a project by hand

The layer builder requires Python 3.10+ and [uv](https://docs.astral.sh/uv/).
It runs locally with NumPy, Pillow and OpenCV; these are build tools, not browser dependencies.
The other Python tools declare dependencies inline for bare `uv run`. The validator and
pose renderer use Node.js 22.17+; install Node dependencies with `npm ci` and Chromium with
`npx playwright install chromium` if needed. [Rig field descriptions](rig-fields.md)
explain coordinates and placement.

1. Create a project folder and put your illustration in `source.png`. A PNG with a transparent
   background works. Use a copy of your artwork when experimenting.
2. Prepare `rig.draft.json`. Use `samples/miko-qipao/rig.json` as a schema example, set `image.width`
   and `image.height` to your image dimensions, and place the geometry in source-image pixels.
   Trace each eye's `opening` inside the lashes and its enclosing `roi` around the lash and lid
   strokes. Place hair strand `nodes` from root to tip. Remove `hand`, `buns` and `accessories`
   if absent; keep the required head, body, face, mouth, cheeks, mesh and view settings.
   The eye fields `x0`, `x1`, `top` and `bot` can be omitted from the draft.
3. From the repository root, build the layers:

   ```sh
   uv run --with numpy --with pillow --with opencv-python-headless tools/build-layers.py /path/to/project --rig rig.draft.json
   ```

   This writes `rig.json` with 24 sampled points for each eye's top and bottom curves, plus
   `built/base.png`, `built/hairmask.png`, the four `eye{i}_ball/lash/low/crease.png` layers per
   eye, and `built/layers.json`. Hand and accessory layers are generated only when present
   in the rig. The input draft remains unchanged. Existing generated files are replaced;
   optional drawn sprites are preserved. Without `--rig`, the input is `rig.json`.
4. In the editor, choose **Open project** and select it from the list, or browse for the whole project
   folder, including `source.png`, `rig.json` and `built/`. Use **Pose test** to check blinking
   and face angles, and **Sweep angles** to check the full motion range.

The builder estimates eyelid skin and line colours near each eye's ROI, and hair colours near
the strand lines and buns. It follows connected colour regions within the head, buns and
strand areas, using nearby skin and body colours to exclude non-hair pixels. Bright hair
highlights or hair with several unrelated colours can leave gaps in the inferred mask.
It does not trace eyes or invent hidden artwork automatically. Incorrect
outlines can leave eye pixels behind during a blink or include skin in a moving layer. Inspect
the result and adjust the rig in the editor. For a writable project opened from the local
list, use **Save and rebuild layers** in the changed-outlines banner. It runs the local
builder and reloads the preview, keeping selection, zoom and undo history. A failed build
keeps the previous layers and offers a log. Browser-picked folders still require saving
the JSON, running the command without `--rig`, and reopening the folder. Keep the original draft separately
if you want to retain it. Drawn closed-eye and mouth variants are optional.

Accessory colour masks currently use the rig's red-dominance thresholds (`color.redness` and
`color.minRed`) inside each `box`. Hair and skin estimation assumes reasonably opaque pixels
around the traced regions; fully translucent artwork or unrelated colours inside an eye ROI
may need manual retouching. Inpainting approximates the artwork hidden behind hands and eyes.

## Editing

- Drag a handle or select an item to edit its numeric fields.
- Double-click a polygon/polyline edge to insert a vertex; Alt-click a vertex to remove it.
- Pinch to zoom at the cursor; two-finger scrolling pans. A mouse wheel zooms by default;
  **Mouse wheel** can switch it to panning. Ctrl/Cmd-scroll always zooms.
- Drag empty space, Space-drag or middle-drag to pan. Use **− / +** to zoom, the percentage
  to return to 100% (one image pixel per screen pixel), **Fit** for the whole image, or
  **Fit selected part** for the current part. Double-clicking a part in the list also fits it.
  Zoom ranges from 10% to 1600%, while dots keep the same screen size.
- Ctrl/Cmd+plus, minus, 0 and 1 zoom in, zoom out, fit and reset to 100%. These shortcuts
  leave browser behavior alone when an input is focused.
- **Undo** / **Redo** restore edits. Keyboard shortcuts: Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z and Ctrl/Cmd+S.
- **Save rig** saves a listed project, or downloads the JSON for a browser-picked folder.
  Dropping a JSON file also loads it.
- Pause **Idle motion** for a stable pose comparison, or use **Sweep angles** to sweep angles.
- Switch between the **Pose test** and **Lip sync** tabs under the preview. **Lip sync**
  holds あ・い・う・え・お・ん, or plays kana text at 4–12 morae per second.
  **Release** / **Stop** return control to the pose sliders. Drawn mouth images are used when
  available; otherwise the mesh mouth animates. This check does not play audio.

**Drawn variants** shows eye and mouth image counts. Check the drawings you want and
copy the prepared message for **Codex** or **Claude Code**. Codex's message requests its
built-in image generation, local import and pose review, and the card states that images
will be sent to Codex image generation. Claude Code's message asks it to prepare masks
and prompts and explain where to save the drawings, then stop. The recipient is remembered. Changes in the local project's `variants/` and `built/sprites/` directories
reload in place, keeping unsaved outlines, selection, zoom and undo history. The sample's
request asks the agent to work on a copy under `projects/`, leaving the original intact.

**If you prepare images yourself** is collapsed by default. Open it to export local masks
and prompts with `variant-requests.py`, or to drop or choose full-size PNGs with the listed
filenames. The editor validates dimensions and pixels outside the mask before building
sprites; rejected imports keep the previous drawings and sprites. Manual export and import
need a writable project from the development server. The app keeps images local; the
Codex card discloses the image-generation upload before you copy its request; other
external services are excluded from that request.

## Verify

```sh
npm run lint
npm test
npm run build
uv run --with numpy --with pillow --with opencv-python-headless tools/test_build_layers.py
npx playwright install chromium
npm run e2e
```

`docs/screenshots/` stores local visual verification evidence and is excluded from version control.
