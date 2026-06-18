# Session Analysis: Measured Space 3D Viewer Customization

## Project Context

Workspace: `/Users/mattnguyen/Documents/measured space`

Primary viewer export used during this session:

- `214vannorden_measuredspace/`
- `214vannorden_measuredspace.zip`

Main automation script:

- `scripts/rebrand-viewer.mjs`

The export is an offline 3D tour viewer with bundled JavaScript, local panorama/floorplan assets, local HTML, and generated viewer configuration in `index.html`.

## Viewer Architecture Notes

The viewer export is mostly a bundled application:

- Entry page: `214vannorden_measuredspace/index.html`
- Bundled viewer runtime: `214vannorden_measuredspace/html_assets/index.js` and chunk files
- Main legacy CSS: `214vannorden_measuredspace/html_assets/css/main.css`
- Pano cube faces and point-cloud data: `214vannorden_measuredspace/assets/`
- Gallery/profile assets: `214vannorden_measuredspace/gallery/` and `html_assets/a/`
- Floorplans are embedded as SVG script blocks in `index.html`

The app mounts into:

```html
<div id="lightbox" class="measured-space-viewer-bootstrap"></div>
```

The runtime then creates the visible viewer DOM, including:

- `.top-bar`
- `.banner-profile`
- `.top-bar-center`
- `.top-bar-title`
- `#side-panel`
- `#floorplanwindow`
- `#floorplanwindow__close`
- `#floorplanwindow__maximize`
- `#floorplanwindow__minimize`

## Rebrand Work

The company name was changed from the previous brand to `measured-space`.

Automation now handles:

- Visible text replacement to `measured-space`
- JavaScript identifier/data-key replacement to `measuredSpace`
- Title/favicon cleanup
- Legacy brand logo removal from DOM
- PDF cleanup when docs are kept
- Docs deletion by default

Important script behavior:

- The old brand token is constructed as `"i" + "guide"` in `scripts/rebrand-viewer.mjs` to avoid keeping the old literal token in the script.
- `--keep-docs` preserves `doc/` and runs PDF cleanup.
- Default behavior removes `doc/`.

Run command:

```bash
node scripts/rebrand-viewer.mjs "viewer-folder"
```

Dry-run command:

```bash
node scripts/rebrand-viewer.mjs "viewer-folder" --dry-run
```

## Logo And Branding Cleanup

Several logo sources were handled during the session.

### Browser Tab Logo

The favicon/head icon tags were removed and replaced with a transparent SVG favicon:

```html
<link rel="icon" href="data:image/svg+xml,%3Csvg ... %3E">
```

This is handled by:

- `stripHeadIconTags`
- `ensureTransparentFavicon`

### DOM Logos

The script injects a runtime cleanup hook after `window.initViewer(viewerParams)` to remove matching logo elements.

Handled by:

- `ensureLogoCleanupHook`

It removes elements matching logo-like classes, ids, src/href/alt/title attributes, and `.logo`.

### Tripod / Camera Overlay Logo

The visible black circular camera/tripod logo under the camera POV was identified as:

```text
214vannorden_measuredspace/html_assets/a/854d6a9347500641b40d.png
```

It is a `680 x 680` RGBA PNG.

Automation now replaces this asset with a transparent PNG while preserving the filename/path so the viewer does not request a missing asset.

Handled by:

- `TRIPOD_OVERLAY_IMAGE_NAMES`
- `neutralizeTripodOverlayImages`

### Nadir / Tripod Patch Images

The script also neutralizes named tripod/nadir image assets under:

```text
html_assets/image/
```

Handled by:

- `neutralizeTripodPatchImages`

### Baked Pano Bottom Cleanup

Before the exact overlay asset was identified, pano bottom cube faces were patched to remove baked tripod/nadir marks from:

```text
assets/p*-5.jpg
```

This uses a Python/Pillow/Numpy helper embedded in the script.

Handled by:

- `PYTHON_PANO_BOTTOM_SCRIPT`
- `neutralizePanoBottomFaces`

A marker prevents repeated destructive reprocessing:

```text
assets/.measured-space-pano-bottom-patches-cleaned
```

## Docs And Download Cleanup

The `doc/` folder was determined not to be required for the tour to run.

Automation now:

- Removes `doc/` by default
- Removes download/export/PDF/CSV/DXF controls from the UI
- Keeps PDF cleanup available with `--keep-docs`

Handled by:

- `removeDocFolder`
- `ensureDownloadCleanupHook`
- `processPdfs`

## Style Exploration

A standalone style exploration file was generated:

```text
style-options.html
```

It included four mock viewer style options. The user rejected that direction because the examples were too similar, so implementation shifted to direct targeted changes in the real viewer.

This file is not part of the production automation.

## Final Viewer Styling Changes

The real viewer received a custom CSS/JS layer.

Generated into each processed viewer:

```text
html_assets/css/measured-space-custom.css
html_assets/js/measured-space-custom.js
```

Source of truth for future automation:

```text
scripts/assets/measured-space-custom.css
scripts/assets/measured-space-custom.js
```

The automation copies these assets into every viewer export and injects:

```html
<link rel="stylesheet" href="./html_assets/css/measured-space-custom.css">
<script src="./html_assets/js/measured-space-custom.js"></script>
```

Handled by:

- `CUSTOM_VIEWER_STYLE_HREF`
- `CUSTOM_VIEWER_SCRIPT_SRC`
- `CUSTOM_VIEWER_ASSETS`
- `ensureCustomViewerAssets`
- `ensureCustomViewerStyleLink`
- `ensureCustomViewerScriptTag`

## Specific Style Requirements Implemented

### Address Bar

Changed from centered top position to top-left, next to the profile photo when present.

Key selectors:

- `.top-bar-center`
- `.top-bar-title`
- `.banner-profile`

Behavior:

- If a profile image exists, address starts beside it.
- If no profile image exists, address moves to the far left.

### Glass-Like UI

Added a transparent/glass treatment using:

- `rgba(...)` backgrounds
- `backdrop-filter: blur(...) saturate(...)`
- soft shadows
- subtle borders

Applied to:

- address bar
- profile/menu/action buttons
- map panel
- map header
- map controls

### Corners

Corners were reduced to:

```css
--ms-radius: 6px;
```

### Font

The viewer now uses:

```css
font-family: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
```

Inter is used when available locally. System fallbacks keep the export file-share friendly without relying on a web font download.

### Map Transparency

The map was made more transparent:

- side panel: `rgba(255, 255, 255, 0.2)`
- header: `rgba(255, 255, 255, 0.18)`
- floorplan window: `rgba(255, 255, 255, 0.08)`
- floorplan SVG opacity: `0.68`

### Map Flush Position

Removed the built-in left and bottom inset from the map.

Verified final position:

- expanded map: `left: 0`, `bottom: 0`
- compact map: `left: 0`, `bottom: 0`

Main selectors:

- `.bottom-bar`
- `.bottom-left-panel`
- `.floorplan-slot`
- `.floorplan-clipper`
- `#side-panel`

### Map Compact / Expand Controls

The original expanded map used an `X`-style close button to enter compact mode.

Changed behavior:

- expanded map button is now an accessible compact icon
- compact state has a clear `Expand map` button
- hide button remains labeled

The compact button is icon-only visually but remains accessible:

```html
aria-label="Compact map"
title="Compact map"
```

It uses a common inward-arrows collapse icon.

Handled by:

- `scripts/assets/measured-space-custom.js`
- `.ms-map-control-icon-only`
- `.ms-map-control-icon`
- `.ms-map-control-label`

## Verification Performed

Syntax checks:

```bash
node --check scripts/rebrand-viewer.mjs
node --check scripts/assets/measured-space-custom.js
node --check 214vannorden_measuredspace/html_assets/js/measured-space-custom.js
```

Automation dry-run:

```bash
node scripts/rebrand-viewer.mjs "214vannorden_measuredspace" --dry-run
```

Automation real run:

```bash
node scripts/rebrand-viewer.mjs "214vannorden_measuredspace"
```

The latest run was idempotent:

- `0` text files changed
- `0` custom viewer assets updated
- `0` docs removed
- `0` tripod overlays remaining
- `0` tripod patch images remaining
- `0` pano bottom faces remaining

Local browser verification used:

```bash
python3 -m http.server 4176
```

From:

```text
214vannorden_measuredspace/
```

Local URL:

```text
http://127.0.0.1:4176/
```

Verified in browser:

- address is top-left beside profile photo
- map is flush to left and bottom
- compact map button is square `38 x 38`
- compact button has icon, `aria-label`, and tooltip
- map transparency values are active
- custom CSS and JS are loaded

## Current Important Files

Automation:

```text
scripts/rebrand-viewer.mjs
```

Automation-owned custom viewer assets:

```text
scripts/assets/measured-space-custom.css
scripts/assets/measured-space-custom.js
```

Generated into current viewer:

```text
214vannorden_measuredspace/html_assets/css/measured-space-custom.css
214vannorden_measuredspace/html_assets/js/measured-space-custom.js
```

Current viewer:

```text
214vannorden_measuredspace/index.html
```

Style exploration artifact:

```text
style-options.html
```

## Recommended Future Workflow

For each newly uploaded/exported viewer folder:

```bash
node scripts/rebrand-viewer.mjs "new-viewer-folder"
```

Optional check before writing:

```bash
node scripts/rebrand-viewer.mjs "new-viewer-folder" --dry-run
```

Then serve locally:

```bash
cd "new-viewer-folder"
python3 -m http.server 4176
```

Open:

```text
http://127.0.0.1:4176/
```

## Notes / Caveats

- The custom styling layer is intentionally separate from the bundled viewer runtime. This avoids editing minified bundle internals.
- The custom layer depends on stable viewer DOM selectors. If future exports significantly change class/id names, selectors may need an update.
- Inter is not bundled as a font file; the CSS uses Inter when installed and falls back to system fonts for portability.
- The `style-options.html` file was exploratory only and is not used by the automation.
