#!/usr/bin/env node
import { BlobReader, BlobWriter, ZipReader, configure } from "@zip.js/zip.js";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import path from "node:path";

configure({ useWebWorkers: false });

const MAX_SINGLE_FILE_BYTES = 512 * 1024 * 1024;
const LARGE_TOUR_BYTES = 500 * 1024 * 1024;
const VERY_LARGE_TOUR_BYTES = 1024 * 1024 * 1024;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const zipPath = positional[0];
  if (!zipPath || options.help) {
    printUsage();
    process.exitCode = zipPath ? 0 : 1;
    return;
  }

  const slug = sanitizeSlug(requiredOption(options, "slug"));
  const title = requiredOption(options, "title");
  const address = options.address || "";
  const description = options.description || "Cloud-hosted measured-space tour.";
  const coverImage = options["cover-image"] || "";
  const baseUrl = requiredOption(options, "base-url");
  const allowLargeFile = Boolean(options["allow-large-file"]);

  const zipStats = await stat(zipPath);
  console.log(`ZIP size: ${formatBytes(zipStats.size)}`);

  const zipBuffer = await readFile(zipPath);
  const shortHash = createHash("sha256").update(zipBuffer).digest("hex").slice(0, 12);
  const publishedAt = new Date().toISOString();
  const revisionId = `${toRevisionTimestamp(new Date(publishedAt))}-${shortHash}`;
  const outputDir = path.resolve("dist", "tours", slug, revisionId);
  const manifestPath = path.resolve("dist", "tours", slug, `${revisionId}.manifest-entry.json`);

  await assertPathDoesNotExist(outputDir, `Refusing to overwrite existing revision folder: ${outputDir}`);
  await assertPathDoesNotExist(manifestPath, `Refusing to overwrite existing manifest entry: ${manifestPath}`);

  let zipReader;
  try {
    zipReader = new ZipReader(new BlobReader(new Blob([zipBuffer])));
    const entries = await zipReader.getEntries();
    const viewerRoot = findViewerRoot(entries);
    const viewerEntries = entries
      .filter((entry) => belongsToViewer(entry, viewerRoot))
      .filter((entry) => !entry.directory && !shouldSkipEntry(entry.filename));

    if (!viewerEntries.length) {
      throw new Error("No tour files were found under the viewer root.");
    }

    const oversizedEntry = viewerEntries.find((entry) => (entry.uncompressedSize || 0) > MAX_SINGLE_FILE_BYTES);
    if (oversizedEntry && !allowLargeFile) {
      throw new Error(
        `${shortName(oversizedEntry.filename)} is ${formatBytes(oversizedEntry.uncompressedSize)}. ` +
          "Rerun with --allow-large-file if this single file is expected.",
      );
    }

    const totalBytes = viewerEntries.reduce((sum, entry) => sum + (entry.uncompressedSize || 0), 0);
    const largestFiles = [...viewerEntries]
      .sort((a, b) => (b.uncompressedSize || 0) - (a.uncompressedSize || 0))
      .slice(0, 20);

    printLargeTourReport(totalBytes, viewerEntries.length, largestFiles);
    await mkdir(outputDir, { recursive: true });

    for (const entry of viewerEntries) {
      const relativePath = normalizeEntryPath(entry.filename).slice(viewerRoot.length);
      const destination = safeOutputPath(outputDir, relativePath);
      await mkdir(path.dirname(destination), { recursive: true });
      const blob = await entry.getData(new BlobWriter(getMimeType(relativePath)));
      await writeFile(destination, Buffer.from(await blob.arrayBuffer()));
    }

    const assetBaseUrl = buildPublicUrl(baseUrl, `tours/${slug}/${revisionId}/`);
    const manifestEntry = {
      id: slug,
      slug,
      revisionId,
      title,
      address,
      description,
      coverImage,
      indexUrl: buildPublicUrl(baseUrl, `tours/${slug}/${revisionId}/index.html`),
      assetBaseUrl,
      publishedAt,
      status: "published",
      sizeBytes: totalBytes,
      fileCount: viewerEntries.length,
    };

    await mkdir(path.dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifestEntry, null, 2)}\n`);

    console.log("");
    console.log(`Prepared immutable revision: ${outputDir}`);
    console.log(`Manifest entry: ${manifestPath}`);
    console.log("Cloud viewers do not download the ZIP; they download only assets requested by the tour runtime.");
  } finally {
    await zipReader?.close().catch(() => {});
  }
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const key = arg.slice(2);
    if (key === "allow-large-file" || key === "help") {
      options[key] = true;
      continue;
    }
    const value = args[index + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for --${key}`);
    }
    options[key] = value;
    index += 1;
  }
  return { positional, options };
}

function requiredOption(options, key) {
  if (!options[key]) {
    throw new Error(`Missing required option --${key}`);
  }
  return options[key];
}

function sanitizeSlug(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  if (!slug) {
    throw new Error("Slug must contain at least one letter or number.");
  }
  return slug;
}

function findViewerRoot(entries) {
  const filePaths = entries
    .filter((entry) => !entry.directory && !shouldSkipEntry(entry.filename))
    .map((entry) => normalizeEntryPath(entry.filename));

  const candidates = filePaths
    .filter((filePath) => filePath === "index.html" || filePath.endsWith("/index.html"))
    .map((indexPath) => indexPath.slice(0, -"index.html".length))
    .filter((root) => filePaths.some((filePath) => filePath.startsWith(`${root}html_assets/`)))
    .sort((a, b) => a.length - b.length);

  if (!candidates.length) {
    throw new Error("Could not find index.html beside an html_assets folder in this zip.");
  }
  return candidates[0];
}

function belongsToViewer(entry, root) {
  const filePath = normalizeEntryPath(entry.filename);
  return filePath.startsWith(root) && !shouldSkipEntry(filePath);
}

function normalizeEntryPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function shouldSkipEntry(filePath) {
  const normalized = normalizeEntryPath(filePath);
  const basename = normalized.split("/").pop();
  return (
    normalized === "__MACOSX" ||
    normalized.startsWith("__MACOSX/") ||
    basename === ".DS_Store" ||
    basename.startsWith("._")
  );
}

function safeOutputPath(outputDir, relativePath) {
  const normalized = normalizeEntryPath(relativePath);
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) {
    throw new Error(`Unsafe ZIP path: ${relativePath}`);
  }
  const destination = path.resolve(outputDir, ...normalized.split("/"));
  if (!destination.startsWith(`${outputDir}${path.sep}`)) {
    throw new Error(`Unsafe ZIP path: ${relativePath}`);
  }
  return destination;
}

async function assertPathDoesNotExist(filePath, message) {
  try {
    await access(filePath, fsConstants.F_OK);
    throw new Error(message);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

function printLargeTourReport(totalBytes, fileCount, largestFiles) {
  console.log(`Total unpacked size: ${formatBytes(totalBytes)}`);
  console.log(`File count: ${fileCount.toLocaleString()}`);
  console.log("");
  console.log("20 largest files:");
  for (const entry of largestFiles) {
    console.log(`- ${formatBytes(entry.uncompressedSize || 0)} ${normalizeEntryPath(entry.filename)}`);
  }
  console.log("");
  if (totalBytes > VERY_LARGE_TOUR_BYTES) {
    console.warn("STRONG WARNING: unpacked tour size exceeds 1 GB.");
  } else if (totalBytes > LARGE_TOUR_BYTES) {
    console.warn("Warning: unpacked tour size exceeds 500 MB.");
  }
  console.warn("Decoded image/texture/model/video memory can be much larger than file size.");
}

function buildPublicUrl(baseUrl, relativePath) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = new URL(relativePath, normalizedBase);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--base-url must be http or https.");
  }
  return url.href;
}

function toRevisionTimestamp(date) {
  return date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

function shortName(filePath) {
  const name = filePath.split("/").pop() || filePath;
  return name.length > 64 ? `${name.slice(0, 61)}...` : name;
}

function getMimeType(filePath) {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return (
    {
      css: "text/css",
      csv: "text/csv",
      gif: "image/gif",
      glb: "model/gltf-binary",
      html: "text/html",
      ico: "image/x-icon",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      js: "text/javascript",
      json: "application/json",
      mjs: "text/javascript",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      pdf: "application/pdf",
      png: "image/png",
      svg: "image/svg+xml",
      txt: "text/plain",
      wasm: "application/wasm",
      webm: "video/webm",
      webp: "image/webp",
      xml: "application/xml",
    }[extension] || "application/octet-stream"
  );
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function printUsage() {
  console.log(`Usage:
node scripts/prepare-tour.mjs ./path/to/tour.zip \\
  --slug 214-vannorden \\
  --title "214 Vannorden Tour" \\
  --address "214 Vannorden Street" \\
  --base-url "https://tours.example.com"

Options:
  --description "Text"       Catalog description.
  --cover-image "https://..." Optional catalog cover image URL.
  --allow-large-file         Allow a single extracted file larger than 512 MB.`);
}
