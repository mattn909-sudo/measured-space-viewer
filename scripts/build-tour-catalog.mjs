#!/usr/bin/env node
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const inputDir = positional[0];
  const outFile = options.out;
  if (!inputDir || !outFile || options.help) {
    printUsage();
    process.exitCode = inputDir && outFile ? 0 : 1;
    return;
  }

  const manifestPaths = await findManifestEntries(path.resolve(inputDir));
  const entriesBySlug = new Map();

  for (const manifestPath of manifestPaths) {
    const raw = JSON.parse(await readFile(manifestPath, "utf8"));
    const entry = validateCatalogEntry(raw);
    if (!entry) {
      console.warn(`Skipping invalid manifest entry: ${manifestPath}`);
      continue;
    }

    const existing = entriesBySlug.get(entry.slug);
    if (!existing || publishedTime(entry.publishedAt) > publishedTime(existing.publishedAt)) {
      entriesBySlug.set(entry.slug, entry);
    }
  }

  const catalog = [...entriesBySlug.values()].sort(
    (a, b) => publishedTime(b.publishedAt) - publishedTime(a.publishedAt) || a.slug.localeCompare(b.slug),
  );

  await mkdir(path.dirname(path.resolve(outFile)), { recursive: true });
  await writeFile(outFile, `${JSON.stringify(catalog, null, 2)}\n`);
  console.log(`Wrote ${catalog.length} published tours to ${outFile}`);
}

async function findManifestEntries(rootDir) {
  const results = [];

  async function walk(currentDir) {
    const dirents = await readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const filePath = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(filePath);
      } else if (dirent.isFile() && dirent.name.endsWith(".manifest-entry.json")) {
        results.push(filePath);
      }
    }
  }

  await walk(rootDir);
  return results.sort();
}

function validateCatalogEntry(raw) {
  if (!raw || typeof raw !== "object" || raw.status !== "published") {
    return null;
  }

  const id = cleanRequiredString(raw.id);
  const slug = cleanRequiredString(raw.slug);
  const revisionId = cleanRequiredString(raw.revisionId);
  const title = cleanRequiredString(raw.title);
  const indexUrl = cleanUrl(raw.indexUrl);
  const assetBaseUrl = cleanUrl(raw.assetBaseUrl);
  const publishedAt = cleanRequiredString(raw.publishedAt);
  if (!id || !slug || !revisionId || !title || !indexUrl || !assetBaseUrl || !publishedAt) {
    return null;
  }
  if (Number.isNaN(new Date(publishedAt).getTime())) {
    return null;
  }

  const sizeBytes = Number(raw.sizeBytes);
  const fileCount = Number(raw.fileCount);

  return {
    id,
    slug,
    revisionId,
    title,
    address: cleanOptionalString(raw.address),
    description: cleanOptionalString(raw.description),
    coverImage: cleanUrl(raw.coverImage) || "",
    indexUrl,
    assetBaseUrl,
    publishedAt,
    status: "published",
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? Math.round(sizeBytes) : 0,
    fileCount: Number.isFinite(fileCount) && fileCount > 0 ? Math.round(fileCount) : 0,
  };
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
    if (key === "help") {
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

function cleanRequiredString(value) {
  const cleaned = cleanOptionalString(value);
  return cleaned || "";
}

function cleanOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanUrl(value) {
  const rawValue = cleanOptionalString(value);
  if (!rawValue) {
    return "";
  }
  try {
    const url = new URL(rawValue);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function publishedTime(value) {
  return new Date(value).getTime() || 0;
}

function printUsage() {
  console.log("Usage: node scripts/build-tour-catalog.mjs dist/tours --out public/tours.json");
}
