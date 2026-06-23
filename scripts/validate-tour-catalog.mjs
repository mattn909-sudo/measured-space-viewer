#!/usr/bin/env node
import { readFile } from "node:fs/promises";

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const catalogPath = positional[0] || "public/tours.json";
  if (options.help) {
    printUsage();
    return;
  }

  const allowExample = Boolean(options["allow-example"]);
  const catalog = JSON.parse(await readFile(catalogPath, "utf8"));
  const errors = validateCatalog(catalog, { allowExample });

  if (errors.length) {
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    throw new Error(`${catalogPath} is not production-ready.`);
  }

  console.log(`Catalog OK: ${catalogPath} (${catalog.length} entries)`);
}

function validateCatalog(catalog, { allowExample }) {
  const errors = [];
  if (!Array.isArray(catalog)) {
    return ["Catalog must be a JSON array."];
  }

  const ids = new Set();
  const slugs = new Set();

  catalog.forEach((entry, index) => {
    const label = `entry ${index}`;
    if (!entry || typeof entry !== "object") {
      errors.push(`${label}: must be an object.`);
      return;
    }

    const id = cleanString(entry.id);
    const slug = cleanString(entry.slug);
    const revisionId = cleanString(entry.revisionId);
    const title = cleanString(entry.title);
    const indexUrl = parseHttpUrl(entry.indexUrl);
    const assetBaseUrl = parseHttpUrl(entry.assetBaseUrl);
    const coverImage = cleanString(entry.coverImage) ? parseHttpUrl(entry.coverImage) : null;
    const publishedAt = cleanString(entry.publishedAt);
    const sizeBytes = Number(entry.sizeBytes);
    const fileCount = Number(entry.fileCount);

    if (entry.status !== "published") {
      errors.push(`${label}: status must be "published".`);
    }
    if (!id) errors.push(`${label}: id is required.`);
    if (!slug) errors.push(`${label}: slug is required.`);
    if (!revisionId) errors.push(`${label}: revisionId is required.`);
    if (!title) errors.push(`${label}: title is required.`);
    if (!indexUrl) errors.push(`${label}: indexUrl must be a valid http/https URL.`);
    if (!assetBaseUrl) errors.push(`${label}: assetBaseUrl must be a valid http/https URL.`);
    if (cleanString(entry.coverImage) && !coverImage) {
      errors.push(`${label}: coverImage must be a valid http/https URL when provided.`);
    }
    if (!publishedAt || Number.isNaN(new Date(publishedAt).getTime())) {
      errors.push(`${label}: publishedAt must be an ISO-compatible date.`);
    }
    if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
      errors.push(`${label}: sizeBytes must be a non-negative number.`);
    }
    if (!Number.isFinite(fileCount) || fileCount < 0) {
      errors.push(`${label}: fileCount must be a non-negative number.`);
    }
    if (ids.has(id)) {
      errors.push(`${label}: duplicate id "${id}".`);
    }
    if (slugs.has(slug)) {
      errors.push(`${label}: duplicate slug "${slug}".`);
    }
    ids.add(id);
    slugs.add(slug);

    if (indexUrl && !indexUrl.pathname.endsWith("/index.html")) {
      errors.push(`${label}: indexUrl should point to an index.html file.`);
    }
    if (indexUrl && assetBaseUrl && !indexUrl.href.startsWith(assetBaseUrl.href)) {
      errors.push(`${label}: indexUrl must live under assetBaseUrl.`);
    }

    const checkedUrls = [indexUrl, assetBaseUrl, coverImage].filter(Boolean);
    for (const url of checkedUrls) {
      if (!allowExample && /(^|\.)example\.com$/i.test(url.hostname)) {
        errors.push(`${label}: replace placeholder domain ${url.hostname}.`);
      }
      if (/r2\.dev$/i.test(url.hostname)) {
        errors.push(`${label}: use an R2 custom domain instead of r2.dev.`);
      }
      if (/\.zip(?:$|[?#])/i.test(url.href)) {
        errors.push(`${label}: public catalog must not point at ZIP files.`);
      }
    }
  });

  return errors;
}

function parseArgs(args) {
  const positional = [];
  const options = {};
  for (const arg of args) {
    if (arg === "--allow-example" || arg === "--help") {
      options[arg.slice(2)] = true;
    } else {
      positional.push(arg);
    }
  }
  return { positional, options };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseHttpUrl(value) {
  const rawValue = cleanString(value);
  if (!rawValue) {
    return null;
  }
  try {
    const url = new URL(rawValue);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function printUsage() {
  console.log("Usage: node scripts/validate-tour-catalog.mjs public/tours.json [--allow-example]");
}
