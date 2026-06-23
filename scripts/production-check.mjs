#!/usr/bin/env node
import { access, readFile } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { spawnSync } from "node:child_process";

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const allowExample = process.argv.includes("--allow-example");
  const errors = [];

  await requireFile("public/index.html", errors);
  await requireFile("public/app.js", errors);
  await requireFile("public/styles.css", errors);
  await requireFile("public/tours.json", errors);
  await requireFile("public/_headers", errors);
  await requireFile("wrangler.toml", errors);

  await checkHeaders(errors);
  await checkWrangler(errors);
  runCatalogValidation(errors, allowExample);

  if (errors.length) {
    for (const error of errors) {
      console.error(`- ${error}`);
    }
    throw new Error("Production preflight failed.");
  }

  console.log("Production preflight OK.");
}

async function requireFile(filePath, errors) {
  try {
    await access(filePath, fsConstants.R_OK);
  } catch {
    errors.push(`Missing required file: ${filePath}`);
  }
}

async function checkHeaders(errors) {
  let headers = "";
  try {
    headers = await readFile("public/_headers", "utf8");
  } catch {
    return;
  }

  const requiredSnippets = [
    "/tours.json",
    "max-age=60",
    "/app.js",
    "/styles.css",
    "X-Content-Type-Options: nosniff",
    "Referrer-Policy:",
    "Permissions-Policy:",
  ];

  for (const snippet of requiredSnippets) {
    if (!headers.includes(snippet)) {
      errors.push(`public/_headers is missing ${snippet}`);
    }
  }
}

async function checkWrangler(errors) {
  let wrangler = "";
  try {
    wrangler = await readFile("wrangler.toml", "utf8");
  } catch {
    return;
  }

  if (!/pages_build_output_dir\s*=\s*"public"/.test(wrangler)) {
    errors.push('wrangler.toml must set pages_build_output_dir = "public"');
  }
}

function runCatalogValidation(errors, allowExample) {
  const args = ["scripts/validate-tour-catalog.mjs", "public/tours.json"];
  if (allowExample) {
    args.push("--allow-example");
  }

  const result = spawnSync(process.execPath, args, { encoding: "utf8" });
  if (result.status !== 0) {
    errors.push(result.stderr.trim() || result.stdout.trim() || "Catalog validation failed.");
  }
}
