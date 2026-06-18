#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { deflateSync } from "node:zlib";

const DEFAULT_TARGET = "3d viewer";
const DEFAULT_OLD_BRAND = "i" + "guide";
const DEFAULT_PUBLIC_BRAND = "measured-space";
const DEFAULT_CODE_BRAND = "measuredSpace";
const TRANSPARENT_FAVICON =
  "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 viewBox=%220 0 16 16%22/%3E";
const TRIPOD_OVERLAY_IMAGE_NAMES = new Set(["854d6a9347500641b40d.png"]);
const CUSTOM_VIEWER_STYLE_HREF = "./html_assets/css/measured-space-custom.css";
const CUSTOM_VIEWER_SCRIPT_SRC = "./html_assets/js/measured-space-custom.js";
const CUSTOM_VIEWER_ASSETS = [
  {
    label: "custom viewer CSS",
    source: new URL("./assets/measured-space-custom.css", import.meta.url),
    target: path.join("html_assets", "css", "measured-space-custom.css"),
  },
  {
    label: "custom viewer JS",
    source: new URL("./assets/measured-space-custom.js", import.meta.url),
    target: path.join("html_assets", "js", "measured-space-custom.js"),
  },
];

const TEXT_EXTENSIONS = new Set([
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
  ".webmanifest",
  ".xml",
]);

const SKIP_DIRS = new Set([
  ".git",
  ".next",
  "coverage",
  "dist",
  "node_modules",
  "tmp",
]);

const PYTHON_PDF_SCRIPT = String.raw`
import json
import os
import re
import sys
import tempfile
from pathlib import Path

target = Path(sys.argv[1])
old_text = sys.argv[2]
public_text = sys.argv[3]
dry_run = sys.argv[4] == "1"

try:
    from pypdf import PdfReader, PdfWriter
    from pypdf.generic import DecodedStreamObject, NameObject
except Exception as exc:
    print(json.dumps({
        "type": "pdf-skip",
        "reason": "pypdf is unavailable",
        "detail": str(exc),
    }))
    sys.exit(0)

old_bytes = old_text.encode("utf-8")
public_bytes = public_text.encode("utf-8")
brand_bytes_re = re.compile(re.escape(old_bytes), re.IGNORECASE)
brand_text_re = re.compile(re.escape(old_text), re.IGNORECASE)
logo_marker = b"\n0.0117647 0.533333 0.8 rg 711."

def strip_footer_logo(data):
    blocks = 0
    while True:
        idx = data.find(logo_marker)
        if idx < 0:
            return data, blocks
        data = data[:idx]
        blocks += 1

def replacement_stream(data):
    new_data, text_hits = brand_bytes_re.subn(public_bytes, data)
    new_data, logo_blocks = strip_footer_logo(new_data)
    return new_data, text_hits, logo_blocks

def update_metadata(reader, writer):
    changed = False
    meta = reader.metadata or {}
    new_meta = {}
    for key, value in meta.items():
        if value is None:
            continue
        value_text = str(value)
        new_value, hits = brand_text_re.subn(public_text, value_text)
        if hits:
            changed = True
        new_meta[key] = new_value
    if new_meta:
        writer.add_metadata(new_meta)
    return changed

def update_xmp(reader, writer):
    try:
        metadata = reader.trailer["/Root"].get("/Metadata")
    except Exception:
        return False, 0
    if not metadata:
        return False, 0

    try:
        data = metadata.get_data()
    except Exception:
        return False, 0

    new_data, hits = brand_bytes_re.subn(public_bytes, data)
    if not hits:
        return False, 0

    stream = DecodedStreamObject()
    stream.set_data(new_data)
    stream.update({
        NameObject("/Type"): NameObject("/Metadata"),
        NameObject("/Subtype"): NameObject("/XML"),
    })
    writer._root_object.update({NameObject("/Metadata"): stream})
    return True, hits

pdfs = sorted(target.rglob("*.pdf"))
for pdf in pdfs:
    reader = PdfReader(str(pdf))
    writer = PdfWriter()
    changed = False
    total_text_hits = 0
    total_logo_blocks = 0

    for page in reader.pages:
        contents = page.get_contents()
        if contents is not None:
            data = contents.get_data()
            new_data, text_hits, logo_blocks = replacement_stream(data)
            total_text_hits += text_hits
            total_logo_blocks += logo_blocks
            if new_data != data:
                changed = True
                stream = DecodedStreamObject()
                stream.set_data(new_data)
                page[NameObject("/Contents")] = stream
        writer.add_page(page)

    if update_metadata(reader, writer):
        changed = True

    xmp_changed, xmp_hits = update_xmp(reader, writer)
    if xmp_changed:
        changed = True
        total_text_hits += xmp_hits

    if changed and not dry_run:
        fd, tmp_name = tempfile.mkstemp(prefix=pdf.name + ".", suffix=".tmp", dir=str(pdf.parent))
        os.close(fd)
        tmp_path = Path(tmp_name)
        try:
            with tmp_path.open("wb") as handle:
                writer.write(handle)
            tmp_path.replace(pdf)
        finally:
            if tmp_path.exists():
                tmp_path.unlink()

    print(json.dumps({
        "type": "pdf",
        "file": str(pdf),
        "changed": changed,
        "dryRun": dry_run,
        "textHits": total_text_hits,
        "logoBlocks": total_logo_blocks,
    }))
`;

const PYTHON_PANO_BOTTOM_SCRIPT = String.raw`
import json
import sys
from pathlib import Path

target = Path(sys.argv[1])
dry_run = sys.argv[2] == "1"
marker = target / "assets" / ".measured-space-pano-bottom-patches-cleaned"

try:
    import numpy as np
    from PIL import Image, ImageDraw, ImageFilter, ImageStat
except Exception as exc:
    print(json.dumps({
        "type": "pano-bottom-skip",
        "reason": "Pillow/numpy are unavailable",
        "detail": str(exc),
    }))
    sys.exit(0)

assets = target / "assets"
if not assets.exists():
    print(json.dumps({"type": "pano-bottom-summary", "changed": 0, "skipped": 0, "reason": "missing assets"}))
    sys.exit(0)

if marker.exists():
    print(json.dumps({"type": "pano-bottom-summary", "changed": 0, "skipped": 0, "reason": "already cleaned"}))
    sys.exit(0)

faces = sorted(assets.glob("p*-5.jpg"))

def ellipse_mask(size, rx, ry):
    mask = Image.new("L", size, 0)
    draw = ImageDraw.Draw(mask)
    cx, cy = size[0] // 2, size[1] // 2
    draw.ellipse((cx - rx, cy - ry, cx + rx, cy + ry), fill=255)
    return mask

def safe_crop_box(cx, cy, rx, ry, w, h):
    box = (cx - rx, cy - ry, cx + rx, cy + ry)
    if box[0] < 0 or box[1] < 0 or box[2] > w or box[3] > h:
        return None
    return box

def median_color(image, mask):
    return np.array(ImageStat.Stat(image, mask).median, dtype=np.int16)

def patch_face(path):
    image = Image.open(path).convert("RGB")
    w, h = image.size
    cx, cy = w // 2, h // 2
    rx = max(90, int(w * 0.103))
    ry = max(180, int(h * 0.19))
    target_box = safe_crop_box(cx, cy, rx, ry, w, h)
    if target_box is None:
        return False

    mask = ellipse_mask((rx * 2, ry * 2), rx - 1, ry - 1)
    ring_rx = int(rx * 1.45)
    ring_ry = int(ry * 1.25)
    ring_box = safe_crop_box(cx, cy, ring_rx, ring_ry, w, h)
    if ring_box is None:
        ring_box = target_box

    ring_crop = image.crop(ring_box)
    ring_mask = Image.new("L", ring_crop.size, 0)
    ring_draw = ImageDraw.Draw(ring_mask)
    rcx, rcy = ring_crop.size[0] // 2, ring_crop.size[1] // 2
    ring_draw.ellipse((rcx - min(ring_rx, rcx), rcy - min(ring_ry, rcy), rcx + min(ring_rx, rcx), rcy + min(ring_ry, rcy)), fill=255)
    ring_draw.ellipse((rcx - rx, rcy - ry, rcx + rx, rcy + ry), fill=0)
    dest_med = median_color(ring_crop, ring_mask)

    offsets = [
        (-0.225, 0), (0.225, 0), (0, -0.255), (0, 0.255),
        (-0.225, -0.145), (0.225, -0.145), (-0.225, 0.145), (0.225, 0.145),
        (-0.34, 0), (0.34, 0), (0, -0.37), (0, 0.37),
    ]

    best = None
    for x_factor, y_factor in offsets:
        sx = cx + int(w * x_factor)
        sy = cy + int(h * y_factor)
        source_box = safe_crop_box(sx, sy, rx, ry, w, h)
        if source_box is None:
            continue
        crop = image.crop(source_box)
        source_med = median_color(crop, mask)
        arr = np.asarray(crop)
        dark_ratio = np.mean((arr[:, :, 0] < 45) & (arr[:, :, 1] < 45) & (arr[:, :, 2] < 45))
        score = float(np.linalg.norm(source_med - dest_med) + dark_ratio * 500)
        if best is None or score < best[0]:
            best = (score, crop, source_med)

    if best is None:
        return False

    _, source, source_med = best
    source_arr = np.asarray(source).astype(np.int16)
    source_arr = np.clip(source_arr + (dest_med - source_med), 0, 255).astype(np.uint8)
    source = Image.fromarray(source_arr, "RGB").filter(ImageFilter.GaussianBlur(radius=max(1, int(w * 0.001))))

    feather = mask.filter(ImageFilter.GaussianBlur(radius=max(12, int(min(w, h) * 0.016))))
    target_crop = image.crop(target_box)
    patched = Image.composite(source, target_crop, feather)
    image.paste(patched, target_box)

    if not dry_run:
        image.save(path, "JPEG", quality=92, optimize=True)
    return True

changed = 0
for face in faces:
    if patch_face(face):
        changed += 1
        print(json.dumps({
            "type": "pano-bottom",
            "file": str(face),
            "changed": True,
            "dryRun": dry_run,
        }))

if changed and not dry_run:
    marker.write_text("cleaned\n", encoding="utf-8")

print(json.dumps({
    "type": "pano-bottom-summary",
    "changed": changed,
    "skipped": len(faces) - changed,
    "reason": "",
}))
`;

function main() {
  const options = parseArgs(process.argv.slice(2));
  const targetDir = path.resolve(options.target);

  if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
    throw new Error(`Viewer folder does not exist: ${targetDir}`);
  }

  const context = makeContext(options);
  const customViewerAssetFiles = ensureCustomViewerAssets(targetDir, options.dryRun);
  const files = collectFiles(targetDir);
  const stats = {
    changedTextFiles: 0,
    checkedTextFiles: files.text.length,
    customViewerAssetFiles,
    changedPdfFiles: 0,
    checkedPdfFiles: files.pdf.length,
    removedDocFiles: 0,
    neutralizedTripodOverlayFiles: 0,
    neutralizedTripodPatchFiles: 0,
    neutralizedPanoBottomFaces: 0,
  };

  const jsFiles = [];
  for (const file of files.text) {
    const ext = path.extname(file).toLowerCase();
    if (ext === ".js") {
      jsFiles.push(file);
    }

    const before = fs.readFileSync(file, "utf8");
    const after = transformTextFile(before, file, context);

    if (after !== before) {
      stats.changedTextFiles += 1;
      if (!options.dryRun) {
        fs.writeFileSync(file, after);
      }
      console.log(`${options.dryRun ? "Would update" : "Updated"} ${relative(targetDir, file)}`);
    }
  }

  if (options.pdf && !options.pruneDocs) {
    const pdfResult = processPdfs(targetDir, context, options.dryRun);
    stats.changedPdfFiles = pdfResult.changed;
    for (const line of pdfResult.lines) {
      console.log(line);
    }
  }

  if (options.pruneDocs) {
    stats.removedDocFiles = removeDocFolder(targetDir, options.dryRun);
  }

  stats.neutralizedTripodOverlayFiles = neutralizeTripodOverlayImages(targetDir, options.dryRun);
  stats.neutralizedTripodPatchFiles = neutralizeTripodPatchImages(targetDir, options.dryRun);
  const panoBottomResult = neutralizePanoBottomFaces(targetDir, options.dryRun);
  stats.neutralizedPanoBottomFaces = panoBottomResult.changed;
  for (const line of panoBottomResult.lines) {
    console.log(line);
  }

  if (!options.dryRun) {
    validateJavaScript(jsFiles);
  }

  console.log("");
  console.log(
    `${options.dryRun ? "Dry run checked" : "Checked"} ${stats.checkedTextFiles} text files, ` +
      `${stats.changedTextFiles} ${options.dryRun ? "would change" : "changed"}.`,
  );
  console.log(
    `${options.dryRun ? "Would update" : "Updated"} ${stats.customViewerAssetFiles} custom viewer asset(s).`,
  );
  console.log(
    options.pruneDocs
      ? `Skipped PDF cleanup because doc folder pruning is enabled.`
      : `${options.dryRun ? "Dry run checked" : "Checked"} ${stats.checkedPdfFiles} PDFs, ` +
          `${stats.changedPdfFiles} ${options.dryRun ? "would change" : "changed"}.`,
  );
  console.log(
    `${options.dryRun ? "Would remove" : "Removed"} ${stats.removedDocFiles} file(s) from doc/.`,
  );
  console.log(
    `${options.dryRun ? "Would neutralize" : "Neutralized"} ` +
      `${stats.neutralizedTripodOverlayFiles} tripod overlay image(s).`,
  );
  console.log(
    `${options.dryRun ? "Would neutralize" : "Neutralized"} ` +
      `${stats.neutralizedTripodPatchFiles} tripod patch image(s).`,
  );
  console.log(
    `${options.dryRun ? "Would neutralize" : "Neutralized"} ` +
      `${stats.neutralizedPanoBottomFaces} pano bottom face(s).`,
  );
}

function parseArgs(argv) {
  const options = {
    codeBrand: DEFAULT_CODE_BRAND,
    dryRun: false,
    oldBrand: DEFAULT_OLD_BRAND,
    pdf: true,
    pruneDocs: true,
    publicBrand: DEFAULT_PUBLIC_BRAND,
    target: DEFAULT_TARGET,
  };

  for (const arg of argv) {
    if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--keep-docs") {
      options.pruneDocs = false;
    } else if (arg === "--no-pdf") {
      options.pdf = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg.startsWith("--old=")) {
      options.oldBrand = arg.slice("--old=".length);
    } else if (arg.startsWith("--public=")) {
      options.publicBrand = arg.slice("--public=".length);
    } else if (arg.startsWith("--code=")) {
      options.codeBrand = arg.slice("--code=".length);
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      options.target = arg;
    }
  }

  return options;
}

function printHelp() {
  console.log(`Usage: node scripts/rebrand-viewer.mjs [viewer-folder] [options]

Options:
  --dry-run          Report changes without writing files.
  --keep-docs        Preserve doc/ and clean PDF branding instead of deleting docs.
  --no-pdf           Skip PDF cleanup.
  --old=<name>       Legacy brand token to replace.
  --public=<name>    Replacement for visible text, classes, URLs, and PDF text.
  --code=<name>      Replacement for JavaScript identifiers and data keys.
`);
}

function makeContext(options) {
  return {
    brandTextRe: new RegExp(escapeRegExp(options.oldBrand), "gi"),
    codeBrand: options.codeBrand,
    constantBrand: toConstantName(options.codeBrand),
    identifierBrandRe: new RegExp(escapeRegExp(options.oldBrand), "gi"),
    oldBrand: options.oldBrand,
    pascalBrand: toPascalName(options.codeBrand),
    publicBrand: options.publicBrand,
  };
}

function collectFiles(root) {
  const text = [];
  const pdf = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory() && SKIP_DIRS.has(entry.name)) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      if (ext === ".pdf") {
        pdf.push(fullPath);
      } else if (TEXT_EXTENSIONS.has(ext)) {
        text.push(fullPath);
      }
    }
  }

  walk(root);
  return { pdf, text };
}

function transformTextFile(source, file, context) {
  const ext = path.extname(file).toLowerCase();
  if (ext === ".js") {
    return transformJavaScript(source, context);
  }
  if (ext === ".html") {
    return transformHtml(source, file, context);
  }
  return replaceVisible(source, context);
}

function transformHtml(source, file, context) {
  let result = "";
  let lastIndex = 0;
  const scriptRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

  for (const match of source.matchAll(scriptRe)) {
    const [fullMatch, attrs, body] = match;
    const openTagEnd = fullMatch.indexOf(">") + 1;
    const openTag = fullMatch.slice(0, openTagEnd);
    const closeTag = fullMatch.slice(openTagEnd + body.length);

    result += replaceVisible(source.slice(lastIndex, match.index), context);
    result += replaceVisible(openTag, context);
    result += isJavaScriptScript(attrs)
      ? transformJavaScript(body, context)
      : replaceVisible(body, context);
    result += replaceVisible(closeTag, context);
    lastIndex = match.index + fullMatch.length;
  }

  result += replaceVisible(source.slice(lastIndex), context);

  if (path.basename(file).toLowerCase() === "index.html") {
    result = stripHeadIconTags(result);
    result = neutralizeTripodConfig(result);
    result = ensureTransparentFavicon(result);
    result = ensureCustomViewerStyleLink(result);
    result = ensureCustomViewerScriptTag(result);
    result = ensureLogoCleanupHook(result);
    result = ensureDownloadCleanupHook(result);
  }

  return result;
}

function isJavaScriptScript(attrs) {
  const typeMatch = attrs.match(/\btype\s*=\s*(["'])(.*?)\1/i);
  if (!typeMatch) {
    return true;
  }

  const type = typeMatch[2].trim().toLowerCase();
  return (
    type === "module" ||
    type === "text/javascript" ||
    type === "application/javascript" ||
    type === "application/ecmascript" ||
    type === "text/ecmascript"
  );
}

function stripHeadIconTags(html) {
  let result = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const rel = getAttribute(tag, "rel").toLowerCase();
    const href = getAttribute(tag, "href").toLowerCase();
    const relTokens = rel.split(/\s+/).filter(Boolean);

    if (relTokens.includes("apple-touch-icon")) {
      return "";
    }
    if (relTokens.includes("mask-icon")) {
      return "";
    }
    if (relTokens.includes("manifest")) {
      return "";
    }
    if (relTokens.includes("icon") && !href.startsWith("data:image/svg+xml")) {
      return "";
    }

    return tag;
  });

  result = result.replace(/<meta\b[^>]*>/gi, (tag) => {
    const name = getAttribute(tag, "name").toLowerCase();
    if (name === "theme-color" || name.startsWith("msapplication-")) {
      return "";
    }
    return tag;
  });

  return result.replace(/\n{3,}/g, "\n\n");
}

function ensureTransparentFavicon(html) {
  if (html.includes(TRANSPARENT_FAVICON)) {
    return html;
  }

  const tag = `  <link rel="icon" href="${TRANSPARENT_FAVICON}">\n`;
  const stylesheetMatch = html.match(/^[ \t]*<link\b[^>]*\brel\s*=\s*(["'])stylesheet\1[^>]*>\s*$/im);
  if (stylesheetMatch?.index != null) {
    return html.slice(0, stylesheetMatch.index) + tag + html.slice(stylesheetMatch.index);
  }

  const headClose = html.search(/<\/head>/i);
  if (headClose >= 0) {
    return html.slice(0, headClose) + tag + html.slice(headClose);
  }

  return tag + html;
}

function ensureCustomViewerStyleLink(html) {
  if (html.includes(CUSTOM_VIEWER_STYLE_HREF)) {
    return html;
  }

  const tag = ` <link rel="stylesheet" href="${CUSTOM_VIEWER_STYLE_HREF}">`;
  const headClose = html.search(/<\/head>/i);
  if (headClose >= 0) {
    return html.slice(0, headClose) + tag + html.slice(headClose);
  }

  return tag + html;
}

function ensureCustomViewerScriptTag(html) {
  if (html.includes(CUSTOM_VIEWER_SCRIPT_SRC)) {
    return html;
  }

  const tag = ` <script src="${CUSTOM_VIEWER_SCRIPT_SRC}"></script>`;
  const bodyClose = html.search(/<\/body>/i);
  if (bodyClose >= 0) {
    return html.slice(0, bodyClose) + tag + html.slice(bodyClose);
  }

  return html + tag;
}

function neutralizeTripodConfig(html) {
  return html
    .replace(/\btripodImageUrl\s*:\s*(["'])(?:\\.|(?!\1)[\s\S])*?\1/g, "tripodImageUrl: ''")
    .replace(/\btripodImageOpacity\s*:\s*(?:\d+(?:\.\d+)?|null|undefined)/g, "tripodImageOpacity: 0");
}

function ensureLogoCleanupHook(html) {
  if (html.includes("__measuredSpaceLogoCleanup")) {
    return html;
  }

  const initCall = "window.initViewer(viewerParams)";
  const index = html.indexOf(initCall);
  if (index < 0) {
    return html;
  }

  const insertAt = index + initCall.length;
  const hook = `
      ;(() => {
        if (window.__measuredSpaceLogoCleanup) return;
        window.__measuredSpaceLogoCleanup = true;

        const selector = [
          '[class*="measured-space-logo"]',
          '[id*="measured-space-logo"]',
          '[src*="measured-space-logo"]',
          '[href*="measured-space-logo"]',
          '[alt*="measured-space-logo"]',
          '[title*="measured-space-logo"]',
          '.logo',
        ].join(',');

        const removeLogos = (root = document) => {
          root.querySelectorAll(selector).forEach((node) => {
            const logo =
              node.closest?.('.floorplanwindow__measured-space-logo,.pano-views__measured-space-logo,.logo') ||
              node;
            logo.remove();
          });
        };

        removeLogos();
        new MutationObserver(() => removeLogos()).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      })()`;

  return html.slice(0, insertAt) + hook + html.slice(insertAt);
}

function ensureDownloadCleanupHook(html) {
  if (html.includes("__measuredSpaceDownloadCleanup")) {
    return html;
  }

  const initCall = "window.initViewer(viewerParams)";
  const index = html.indexOf(initCall);
  if (index < 0) {
    return html;
  }

  const insertAt = index + initCall.length;
  const hook = `
      ;(() => {
        if (window.__measuredSpaceDownloadCleanup) return;
        window.__measuredSpaceDownloadCleanup = true;

        const downloadWords = /download|export|pdf|csv|dxf|all floors|property overview|tag data/i;
        const candidates = [
          'a[href*="/doc/"]',
          'a[href*="./doc/"]',
          'a[href^="doc/"]',
          'a[download]',
          'button',
          '[role="button"]',
        ].join(',');

        const removeDownloads = (root = document) => {
          root.querySelectorAll(candidates).forEach((node) => {
            const href = node.getAttribute?.('href') || '';
            const label = node.textContent || node.getAttribute?.('aria-label') || node.getAttribute?.('title') || '';
            if (!href.includes('/doc/') && !href.includes('./doc/') && !href.startsWith('doc/') && !downloadWords.test(label)) {
              return;
            }

            const item =
              node.closest?.('.dropdown-menu li,.menu-item,.details-link,.download-link,.btn-group,.modal-footer a,.modal-footer button') ||
              node;
            item.remove();
          });
        };

        removeDownloads();
        new MutationObserver(() => removeDownloads()).observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      })()`;

  return html.slice(0, insertAt) + hook + html.slice(insertAt);
}

function transformJavaScript(source, context) {
  let out = "";
  let i = 0;
  let previous = { type: "start", value: "" };

  while (i < source.length) {
    const char = source[i];

    if (isWhitespace(char)) {
      out += char;
      i += 1;
      continue;
    }

    if (char === "'" || char === '"') {
      const read = readQuotedString(source, i, context);
      out += read.text;
      i = read.end;
      previous = { type: "literal", value: "" };
      continue;
    }

    if (char === "`") {
      const read = readTemplateString(source, i, context);
      out += read.text;
      i = read.end;
      previous = { type: "literal", value: "" };
      continue;
    }

    if (char === "/" && source[i + 1] === "/") {
      const end = findLineEnd(source, i + 2);
      out += replaceVisible(source.slice(i, end), context);
      i = end;
      continue;
    }

    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      const finalEnd = end < 0 ? source.length : end + 2;
      out += replaceVisible(source.slice(i, finalEnd), context);
      i = finalEnd;
      continue;
    }

    if (char === "/" && isRegexStart(previous)) {
      const read = readRegexLiteral(source, i, context);
      out += read.text;
      i = read.end;
      previous = { type: "literal", value: "" };
      continue;
    }

    if (isIdentifierStart(char)) {
      const end = readIdentifierEnd(source, i + 1);
      const token = source.slice(i, end);
      const transformed = replaceIdentifierBrand(token, context);
      out += transformed;
      i = end;
      previous = keywordCanPrecedeRegex(token)
        ? { type: "keyword", value: token }
        : { type: "identifier", value: transformed };
      continue;
    }

    out += char;
    if (!isWhitespace(char)) {
      previous = { type: punctuationCanPrecedeRegex(char) ? "operator" : "punctuation", value: char };
    }
    i += 1;
  }

  return out;
}

function readQuotedString(source, start, context) {
  const quote = source[start];
  let body = "";
  let i = start + 1;

  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      body += source.slice(i, Math.min(i + 2, source.length));
      i += 2;
      continue;
    }
    if (char === quote) {
      const keyLike = isObjectKeyString(source, start, i) || isBracketKeyString(source, start, i);
      const transformed = keyLike
        ? replaceIdentifierBrand(body, context)
        : replaceVisible(body, context);
      return { end: i + 1, text: quote + transformed + quote };
    }
    body += char;
    i += 1;
  }

  return { end: source.length, text: source.slice(start) };
}

function readTemplateString(source, start, context) {
  let out = "`";
  let chunk = "";
  let i = start + 1;

  while (i < source.length) {
    const char = source[i];
    if (char === "\\") {
      chunk += source.slice(i, Math.min(i + 2, source.length));
      i += 2;
      continue;
    }
    if (char === "`") {
      out += replaceVisible(chunk, context) + "`";
      return { end: i + 1, text: out };
    }
    if (char === "$" && source[i + 1] === "{") {
      const expressionEnd = findTemplateExpressionEnd(source, i + 2);
      if (expressionEnd < 0) {
        chunk += source.slice(i);
        return { end: source.length, text: out + replaceVisible(chunk, context) };
      }

      out += replaceVisible(chunk, context);
      out += "${" + transformJavaScript(source.slice(i + 2, expressionEnd), context) + "}";
      chunk = "";
      i = expressionEnd + 1;
      continue;
    }
    chunk += char;
    i += 1;
  }

  return { end: source.length, text: out + replaceVisible(chunk, context) };
}

function findTemplateExpressionEnd(source, start) {
  let depth = 1;
  let i = start;

  while (i < source.length) {
    const char = source[i];
    if (char === "'" || char === '"') {
      i = skipQuotedRaw(source, i);
      continue;
    }
    if (char === "`") {
      i = skipTemplateRaw(source, i);
      continue;
    }
    if (char === "/" && source[i + 1] === "/") {
      i = findLineEnd(source, i + 2);
      continue;
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2);
      i = end < 0 ? source.length : end + 2;
      continue;
    }
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
    i += 1;
  }

  return -1;
}

function readRegexLiteral(source, start, context) {
  let i = start + 1;
  let inClass = false;
  let escaped = false;

  while (i < source.length) {
    const char = source[i];
    if (escaped) {
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === "[") {
      inClass = true;
    } else if (char === "]") {
      inClass = false;
    } else if (char === "/" && !inClass) {
      i += 1;
      while (/[a-z]/i.test(source[i] || "")) {
        i += 1;
      }
      return { end: i, text: replaceVisible(source.slice(start, i), context) };
    }
    i += 1;
  }

  return { end: source.length, text: replaceVisible(source.slice(start), context) };
}

function replaceVisible(text, context) {
  return text.replace(context.brandTextRe, context.publicBrand);
}

function replaceIdentifierBrand(token, context) {
  return token.replace(context.identifierBrandRe, (match) => {
    if (/^[A-Z0-9_]+$/.test(match)) {
      return context.constantBrand;
    }
    if (/^[A-Z]/.test(match)) {
      return context.pascalBrand;
    }
    return context.codeBrand;
  });
}

function ensureCustomViewerAssets(targetDir, dryRun) {
  let changed = 0;

  for (const asset of CUSTOM_VIEWER_ASSETS) {
    const contents = fs.readFileSync(asset.source, "utf8");
    const target = path.join(targetDir, asset.target);
    const current = fs.existsSync(target) ? fs.readFileSync(target, "utf8") : null;

    if (current === contents) {
      continue;
    }

    changed += 1;
    if (dryRun) {
      console.log(`Would update ${asset.label} ${relative(targetDir, target)}`);
      continue;
    }

    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, contents);
    console.log(`Updated ${asset.label} ${relative(targetDir, target)}`);
  }

  return changed;
}

function processPdfs(targetDir, context, dryRun) {
  const python = choosePython();
  if (!python) {
    return {
      changed: 0,
      lines: ["PDF cleanup skipped: no Python executable was found."],
    };
  }

  const result = spawnSync(
    python,
    ["-c", PYTHON_PDF_SCRIPT, targetDir, context.oldBrand, context.publicBrand, dryRun ? "1" : "0"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 },
  );

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.status !== 0) {
    throw new Error(`PDF cleanup failed:\n${stderr || stdout}`);
  }

  const lines = [];
  let changed = 0;
  for (const rawLine of stdout ? stdout.split(/\r?\n/) : []) {
    try {
      const event = JSON.parse(rawLine);
      if (event.type === "pdf-skip") {
        lines.push(`PDF cleanup skipped: ${event.reason}${event.detail ? ` (${event.detail})` : ""}`);
      } else if (event.type === "pdf") {
        if (event.changed) {
          changed += 1;
        }
        const verb = dryRun ? (event.changed ? "Would update" : "Would leave") : event.changed ? "Updated" : "Left";
        lines.push(
          `${verb} ${path.relative(targetDir, event.file)} ` +
            `(text hits: ${event.textHits}, logo blocks: ${event.logoBlocks})`,
        );
      } else {
        lines.push(rawLine);
      }
    } catch {
      lines.push(rawLine);
    }
  }

  if (stderr) {
    lines.push(stderr);
  }

  return { changed, lines };
}

function removeDocFolder(targetDir, dryRun) {
  const docDir = path.join(targetDir, "doc");
  if (!fs.existsSync(docDir)) {
    return 0;
  }

  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  walk(docDir);
  if (dryRun) {
    console.log(`Would remove doc/ (${files.length} file(s))`);
  } else {
    fs.rmSync(docDir, { force: true, recursive: true });
    console.log(`Removed doc/ (${files.length} file(s))`);
  }

  return files.length;
}

function neutralizeTripodPatchImages(targetDir, dryRun) {
  const candidates = [];
  const imageRoot = path.join(targetDir, "html_assets", "image");
  if (!fs.existsSync(imageRoot)) {
    return 0;
  }

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
        continue;
      }
      if (!entry.isFile()) {
        continue;
      }

      const basename = entry.name.toLowerCase();
      const ext = path.extname(basename);
      if (!/(?:nadir|tripod)/.test(basename)) {
        continue;
      }
      if (![".png", ".jpg", ".jpeg", ".webp"].includes(ext)) {
        continue;
      }
      candidates.push(fullPath);
    }
  }

  walk(imageRoot);
  const transparentPng = createTransparentPng(680, 680);
  let changed = 0;

  for (const file of candidates) {
    const ext = path.extname(file).toLowerCase();
    const alreadyTransparent = ext === ".png" && fs.readFileSync(file).equals(transparentPng);
    if (alreadyTransparent) {
      continue;
    }

    changed += 1;
    if (dryRun) {
      console.log(`Would neutralize tripod patch ${relative(targetDir, file)}`);
      continue;
    }

    if (ext === ".png") {
      fs.writeFileSync(file, transparentPng);
      console.log(`Neutralized tripod patch ${relative(targetDir, file)}`);
    } else {
      fs.rmSync(file, { force: true });
      console.log(`Removed tripod patch ${relative(targetDir, file)}`);
    }
  }

  return changed;
}

function neutralizeTripodOverlayImages(targetDir, dryRun) {
  const candidates = [];
  const assetRoots = [
    path.join(targetDir, "html_assets", "a"),
    path.join(targetDir, "html_assets", "image"),
  ];

  for (const assetRoot of assetRoots) {
    if (!fs.existsSync(assetRoot)) {
      continue;
    }

    for (const entry of fs.readdirSync(assetRoot, { withFileTypes: true })) {
      if (!entry.isFile()) {
        continue;
      }

      if (TRIPOD_OVERLAY_IMAGE_NAMES.has(entry.name.toLowerCase())) {
        candidates.push(path.join(assetRoot, entry.name));
      }
    }
  }

  const transparentPng = createTransparentPng(680, 680);
  let changed = 0;

  for (const file of candidates) {
    if (fs.readFileSync(file).equals(transparentPng)) {
      continue;
    }

    changed += 1;
    if (dryRun) {
      console.log(`Would neutralize tripod overlay ${relative(targetDir, file)}`);
      continue;
    }

    fs.writeFileSync(file, transparentPng);
    console.log(`Neutralized tripod overlay ${relative(targetDir, file)}`);
  }

  return changed;
}

function neutralizePanoBottomFaces(targetDir, dryRun) {
  const python = choosePython();
  if (!python) {
    return {
      changed: 0,
      lines: ["Pano bottom cleanup skipped: no Python executable was found."],
    };
  }

  const result = spawnSync(
    python,
    ["-c", PYTHON_PANO_BOTTOM_SCRIPT, targetDir, dryRun ? "1" : "0"],
    { encoding: "utf8", maxBuffer: 1024 * 1024 * 20 },
  );

  const stdout = result.stdout.trim();
  const stderr = result.stderr.trim();
  if (result.status !== 0) {
    throw new Error(`Pano bottom cleanup failed:\n${stderr || stdout}`);
  }

  const lines = [];
  let changed = 0;
  let shown = 0;
  for (const rawLine of stdout ? stdout.split(/\r?\n/) : []) {
    try {
      const event = JSON.parse(rawLine);
      if (event.type === "pano-bottom-skip") {
        lines.push(`Pano bottom cleanup skipped: ${event.reason}${event.detail ? ` (${event.detail})` : ""}`);
      } else if (event.type === "pano-bottom") {
        changed += 1;
        if (shown < 8) {
          lines.push(
            `${dryRun ? "Would neutralize" : "Neutralized"} pano bottom ${path.relative(targetDir, event.file)}`,
          );
          shown += 1;
        }
      } else if (event.type === "pano-bottom-summary") {
        if (changed > shown) {
          lines.push(`${dryRun ? "Would neutralize" : "Neutralized"} ${changed - shown} more pano bottom face(s).`);
        }
        if (event.reason) {
          lines.push(`Pano bottom cleanup: ${event.reason}.`);
        }
      } else {
        lines.push(rawLine);
      }
    } catch {
      lines.push(rawLine);
    }
  }

  if (stderr) {
    lines.push(stderr);
  }

  return { changed, lines };
}

function createTransparentPng(width, height) {
  const bytesPerPixel = 4;
  const rowLength = 1 + width * bytesPerPixel;
  const raw = Buffer.alloc(rowLength * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * rowLength] = 0;
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", Buffer.concat([uint32(width), uint32(height), Buffer.from([8, 6, 0, 0, 0])])),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const typeBuffer = Buffer.from(type, "ascii");
  return Buffer.concat([
    uint32(data.length),
    typeBuffer,
    data,
    uint32(crc32(Buffer.concat([typeBuffer, data]))),
  ]);
}

function uint32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32BE(value >>> 0, 0);
  return buffer;
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function choosePython() {
  const home = process.env.HOME || "";
  const candidates = [
    process.env.PYTHON,
    path.join(home, ".cache/codex-runtimes/codex-primary-runtime/dependencies/python/bin/python3"),
    "python3",
    "python",
  ].filter(Boolean);

  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["-c", "import sys; print(sys.executable)"], {
      encoding: "utf8",
    });
    if (result.status === 0) {
      return candidate;
    }
  }

  return null;
}

function validateJavaScript(files) {
  const failures = [];
  for (const file of files) {
    const result = spawnSync(process.execPath, ["--check", file], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024 * 10,
    });
    if (result.status !== 0) {
      failures.push(`${file}\n${result.stderr || result.stdout}`);
    }
  }

  if (failures.length) {
    throw new Error(`JavaScript validation failed:\n\n${failures.join("\n\n")}`);
  }
}

function getAttribute(tag, name) {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*(["'])(.*?)\\1`, "i");
  const match = tag.match(re);
  return match ? match[2] : "";
}

function isObjectKeyString(source, start, end) {
  const next = nextNonWhitespace(source, end + 1);
  if (next.char !== ":") {
    return false;
  }

  const prev = previousNonWhitespace(source, start - 1);
  return prev.char === "{" || prev.char === "," || prev.char === "";
}

function isBracketKeyString(source, start, end) {
  const prev = previousNonWhitespace(source, start - 1);
  const next = nextNonWhitespace(source, end + 1);
  return prev.char === "[" && next.char === "]";
}

function previousNonWhitespace(source, index) {
  for (let i = index; i >= 0; i -= 1) {
    if (!isWhitespace(source[i])) {
      return { char: source[i], index: i };
    }
  }
  return { char: "", index: -1 };
}

function nextNonWhitespace(source, index) {
  for (let i = index; i < source.length; i += 1) {
    if (!isWhitespace(source[i])) {
      return { char: source[i], index: i };
    }
  }
  return { char: "", index: source.length };
}

function isRegexStart(previous) {
  return (
    previous.type === "start" ||
    previous.type === "operator" ||
    previous.type === "keyword" ||
    (previous.type === "punctuation" && previous.value === ";")
  );
}

function keywordCanPrecedeRegex(token) {
  return new Set([
    "case",
    "delete",
    "do",
    "else",
    "in",
    "instanceof",
    "new",
    "return",
    "throw",
    "typeof",
    "void",
    "yield",
  ]).has(token);
}

function punctuationCanPrecedeRegex(char) {
  return "([{=,:;!&|?+-*~%^<>".includes(char);
}

function skipQuotedRaw(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
    } else if (source[i] === quote) {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return source.length;
}

function skipTemplateRaw(source, start) {
  let i = start + 1;
  while (i < source.length) {
    if (source[i] === "\\") {
      i += 2;
    } else if (source[i] === "`") {
      return i + 1;
    } else {
      i += 1;
    }
  }
  return source.length;
}

function findLineEnd(source, start) {
  const end = source.indexOf("\n", start);
  return end < 0 ? source.length : end;
}

function readIdentifierEnd(source, start) {
  let i = start;
  while (i < source.length && isIdentifierPart(source[i])) {
    i += 1;
  }
  return i;
}

function isIdentifierStart(char) {
  return /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return /[A-Za-z0-9_$]/.test(char);
}

function isWhitespace(char) {
  return /\s/.test(char);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function toPascalName(value) {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function toConstantName(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toUpperCase();
}

function relative(root, file) {
  return path.relative(root, file) || ".";
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
}
