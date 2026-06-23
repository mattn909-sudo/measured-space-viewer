#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

import {
  cleanString,
  normalizeEmail,
  normalizeRole,
  parseArgs,
  readJsonRows,
  sqlLiteral,
  sqlNumber,
  wranglerD1Execute,
} from "./lib/dashboard-d1.mjs";

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  if (options.help || !positional[0] || !options.email) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const manifestPath = positional[0];
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const tour = validateManifestEntry(manifest);
  const email = normalizeEmail(options.email);
  const role = normalizeRole(options.role);
  const userId = stableId("usr", email);
  const databaseOptions = {
    database: options.database,
    remote: Boolean(options.remote),
    local: Boolean(options.local),
  };

  wranglerD1Execute(
    `INSERT INTO users (id, email, updated_at)
VALUES (${sqlLiteral(userId)}, ${sqlLiteral(email)}, ${nowSql()})
ON CONFLICT(email) DO UPDATE SET updated_at = ${nowSql()};

INSERT INTO tours (
  id, slug, revision_id, title, address, description, cover_image,
  index_url, asset_base_url, published_at, status, size_bytes, file_count, updated_at
)
VALUES (
  ${sqlLiteral(tour.id)}, ${sqlLiteral(tour.slug)}, ${sqlLiteral(tour.revisionId)},
  ${sqlLiteral(tour.title)}, ${sqlLiteral(tour.address)}, ${sqlLiteral(tour.description)},
  ${sqlLiteral(tour.coverImage)}, ${sqlLiteral(tour.indexUrl)}, ${sqlLiteral(tour.assetBaseUrl)},
  ${sqlLiteral(tour.publishedAt)}, ${sqlLiteral(tour.status)}, ${sqlNumber(tour.sizeBytes)},
  ${sqlNumber(tour.fileCount)}, ${nowSql()}
)
ON CONFLICT(id) DO UPDATE SET
  slug = excluded.slug,
  revision_id = excluded.revision_id,
  title = excluded.title,
  address = excluded.address,
  description = excluded.description,
  cover_image = excluded.cover_image,
  index_url = excluded.index_url,
  asset_base_url = excluded.asset_base_url,
  published_at = excluded.published_at,
  status = excluded.status,
  size_bytes = excluded.size_bytes,
  file_count = excluded.file_count,
  updated_at = ${nowSql()};

INSERT INTO user_tours (user_id, tour_id, role)
VALUES (
  (SELECT id FROM users WHERE lower(email) = lower(${sqlLiteral(email)})),
  ${sqlLiteral(tour.id)},
  ${sqlLiteral(role)}
)
ON CONFLICT(user_id, tour_id) DO UPDATE SET role = excluded.role;`,
    databaseOptions,
  );

  const rows = readJsonRows(
    wranglerD1Execute(
      `SELECT users.email, tours.id AS tour_id, tours.slug, tours.revision_id, user_tours.role
FROM user_tours
INNER JOIN users ON users.id = user_tours.user_id
INNER JOIN tours ON tours.id = user_tours.tour_id
WHERE lower(users.email) = lower(${sqlLiteral(email)})
  AND tours.id = ${sqlLiteral(tour.id)};`,
      { ...databaseOptions, json: true },
    ),
  );

  console.log(`Imported ${tour.id} (${tour.revisionId}) and assigned ${email} as ${role}.`);
  if (rows.length) {
    console.table(rows);
  }
}

function validateManifestEntry(raw) {
  if (!raw || typeof raw !== "object" || raw.status !== "published") {
    throw new Error("Manifest entry must be an object with status \"published\".");
  }

  const entry = {
    id: requiredString(raw.id, "id"),
    slug: requiredString(raw.slug, "slug"),
    revisionId: requiredString(raw.revisionId, "revisionId"),
    title: requiredString(raw.title, "title"),
    address: cleanString(raw.address),
    description: cleanString(raw.description),
    coverImage: cleanHttpUrl(raw.coverImage, "coverImage", false),
    indexUrl: cleanHttpUrl(raw.indexUrl, "indexUrl", true),
    assetBaseUrl: cleanHttpUrl(raw.assetBaseUrl, "assetBaseUrl", true),
    publishedAt: requiredString(raw.publishedAt, "publishedAt"),
    status: "published",
    sizeBytes: normalizeNonNegativeNumber(raw.sizeBytes, "sizeBytes"),
    fileCount: normalizeNonNegativeNumber(raw.fileCount, "fileCount"),
  };

  if (Number.isNaN(new Date(entry.publishedAt).getTime())) {
    throw new Error("publishedAt must be an ISO-compatible date.");
  }
  if (!entry.indexUrl.startsWith(entry.assetBaseUrl)) {
    throw new Error("indexUrl must live under assetBaseUrl.");
  }
  if (!new URL(entry.indexUrl).pathname.endsWith("/index.html")) {
    throw new Error("indexUrl should point to an index.html file.");
  }
  return entry;
}

function requiredString(value, field) {
  const text = cleanString(value);
  if (!text) {
    throw new Error(`${field} is required.`);
  }
  return text;
}

function cleanHttpUrl(value, field, required) {
  const text = cleanString(value);
  if (!text) {
    if (required) {
      throw new Error(`${field} is required.`);
    }
    return "";
  }
  let url;
  try {
    url = new URL(text);
  } catch {
    throw new Error(`${field} must be a valid URL.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${field} must be an http/https URL.`);
  }
  if (/\.zip(?:$|[?#])/i.test(url.href)) {
    throw new Error(`${field} must not point at a ZIP file.`);
  }
  return url.href;
}

function normalizeNonNegativeNumber(value, field) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new Error(`${field} must be a non-negative number.`);
  }
  return Math.round(number);
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function nowSql() {
  return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
}

function printUsage() {
  console.log(
    "Usage: node scripts/import-tour-to-d1.mjs <manifest-entry.json> --email client@example.com [--role viewer] [--database measured-space-dashboard] [--remote]",
  );
}
