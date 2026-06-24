#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

import { validateCatalog } from "./lib/tour-catalog-validation.mjs";

if (isCliEntryPoint()) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

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

function printUsage() {
  console.log("Usage: node scripts/validate-tour-catalog.mjs public/tours.json [--allow-example]");
}

function isCliEntryPoint() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
