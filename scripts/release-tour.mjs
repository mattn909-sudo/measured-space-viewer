#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

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
  const dryRun = Boolean(options["dry-run"]);
  const skipUpload = Boolean(options["skip-upload"]);
  const skipSmoke = Boolean(options["skip-smoke"]) || dryRun || skipUpload;

  run("Prepare immutable tour revision", [
    "scripts/prepare-tour.mjs",
    zipPath,
    "--slug",
    slug,
    "--title",
    requiredOption(options, "title"),
    "--base-url",
    requiredOption(options, "base-url"),
    ...optionalArg(options, "address"),
    ...optionalArg(options, "description"),
    ...optionalArg(options, "cover-image"),
    ...(options["allow-large-file"] ? ["--allow-large-file"] : []),
  ]);

  const manifest = await newestManifestForSlug(slug);
  const revisionFolder = path.resolve("dist", "tours", slug, manifest.revisionId);
  const prefix = `tours/${slug}/${manifest.revisionId}`;

  if (!skipUpload) {
    run(dryRun ? "Dry-run R2 upload" : "Upload immutable revision to R2", [
      "scripts/publish-tour-r2.mjs",
      revisionFolder,
      "--prefix",
      prefix,
      ...(dryRun ? ["--dry-run"] : []),
    ]);
  }

  run("Build public tour catalog", ["scripts/build-tour-catalog.mjs", "dist/tours", "--out", "public/tours.json"]);
  run("Validate public tour catalog", [
    "scripts/validate-tour-catalog.mjs",
    "public/tours.json",
    ...(options["allow-example"] ? ["--allow-example"] : []),
  ]);

  if (!skipSmoke) {
    run("Smoke-test hosted tour", ["scripts/check-hosted-tour.mjs", manifest.indexUrl]);
  }

  console.log("");
  console.log("Release candidate ready.");
  console.log(`Revision: ${manifest.slug}/${manifest.revisionId}`);
  console.log(`Tour URL: ${manifest.indexUrl}`);
  console.log("Deploy the updated public/ folder to Cloudflare Pages after reviewing public/tours.json.");
}

function run(label, args) {
  console.log("");
  console.log(`==> ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: "inherit" });
  if (result.status !== 0) {
    throw new Error(`${label} failed.`);
  }
}

async function newestManifestForSlug(slug) {
  const manifestDir = path.resolve("dist", "tours", slug);
  const names = await readdir(manifestDir);
  const manifests = [];

  for (const name of names) {
    if (!name.endsWith(".manifest-entry.json")) {
      continue;
    }
    const manifest = JSON.parse(await readFile(path.join(manifestDir, name), "utf8"));
    manifests.push(manifest);
  }

  manifests.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  if (!manifests[0]) {
    throw new Error(`No manifest entries found for slug ${slug}.`);
  }
  return manifests[0];
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
    if (["allow-example", "allow-large-file", "dry-run", "help", "skip-smoke", "skip-upload"].includes(key)) {
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

function optionalArg(options, key) {
  return options[key] ? [`--${key}`, options[key]] : [];
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

function printUsage() {
  console.log(`Usage:
node scripts/release-tour.mjs ./path/to/tour.zip \\
  --slug 214-vannorden \\
  --title "214 Vannorden Tour" \\
  --address "214 Vannorden Street" \\
  --base-url "https://tours.example.com" \\
  --dry-run

Options:
  --skip-upload          Prepare and build catalog without R2 upload.
  --skip-smoke           Skip hosted URL check after upload.
  --allow-large-file     Allow extracted files larger than 512 MB.
  --allow-example        Permit example.com in catalog validation.`);
}
