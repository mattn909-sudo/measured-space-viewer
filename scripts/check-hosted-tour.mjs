#!/usr/bin/env node
const LARGE_REFERENCED_ASSET_BYTES = 100 * 1024 * 1024;

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const indexUrl = process.argv[2];
  if (!indexUrl || process.argv.includes("--help")) {
    printUsage();
    process.exitCode = indexUrl ? 0 : 1;
    return;
  }

  const url = validateHttpUrl(indexUrl);
  const response = await fetch(url.href, { headers: { Accept: "text/html,*/*" } });
  const body = await response.text();
  const responseSize = Buffer.byteLength(body);

  console.log(`URL: ${url.href}`);
  console.log(`Status: ${response.status} ${response.statusText}`);
  console.log(`Content-Type: ${response.headers.get("content-type") || "(missing)"}`);
  console.log(`Cache-Control: ${response.headers.get("cache-control") || "(missing)"}`);
  console.log(`Response size: ${formatBytes(responseSize)}`);

  if (!response.ok) {
    process.exitCode = 1;
    return;
  }

  if (/\.zip(?:[?#"')\s>]|$)/i.test(body)) {
    console.warn("Warning: index.html appears to reference a .zip file.");
  }

  const references = extractAssetReferences(body, url);
  console.log(`Static references found: ${references.length}`);
  for (const assetUrl of references.slice(0, 60)) {
    await checkReferencedAsset(assetUrl);
  }
}

async function checkReferencedAsset(assetUrl) {
  try {
    const response = await fetch(assetUrl.href, { method: "HEAD" });
    const contentLength = Number(response.headers.get("content-length"));
    const cacheControl = response.headers.get("cache-control") || "(missing)";
    if (Number.isFinite(contentLength) && contentLength > LARGE_REFERENCED_ASSET_BYTES) {
      console.warn(
        `Warning: large referenced asset ${assetUrl.href} reports ${formatBytes(contentLength)} (${cacheControl}).`,
      );
    }
  } catch (error) {
    console.warn(`Warning: could not inspect referenced asset ${assetUrl.href}: ${error.message}`);
  }
}

function extractAssetReferences(html, baseUrl) {
  const urls = new Map();
  const attributePattern = /\b(?:href|src)\s*=\s*(["'])(.*?)\1/gi;
  let match;
  while ((match = attributePattern.exec(html))) {
    const rawValue = match[2].trim();
    if (!rawValue || rawValue.startsWith("#") || rawValue.startsWith("data:") || rawValue.startsWith("mailto:")) {
      continue;
    }
    try {
      const assetUrl = new URL(rawValue, baseUrl);
      if (assetUrl.protocol === "http:" || assetUrl.protocol === "https:") {
        urls.set(assetUrl.href, assetUrl);
      }
    } catch {
      // Ignore invalid static references.
    }
  }
  return [...urls.values()];
}

function validateHttpUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL must use http or https.");
  }
  return url;
}

function formatBytes(bytes) {
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
  console.log("Usage: node scripts/check-hosted-tour.mjs https://tours.example.com/tours/<slug>/<revisionId>/index.html");
}
