#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";

import {
  getDatabaseOptions,
  normalizeEmail,
  normalizeRole,
  parseArgs,
  readJsonRows,
  sqlLiteral,
  sqlNumber,
  wranglerD1Execute,
} from "./lib/dashboard-d1.mjs";
import { validateCatalogEntry } from "./lib/tour-catalog-validation.mjs";

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
  const { entry: tour, errors } = validateCatalogEntry(manifest, {
    allowExample: Boolean(options["allow-example"]),
    label: manifestPath,
  });
  if (errors.length || !tour) {
    throw new Error(`Manifest entry is not valid:\n${errors.map((error) => `- ${error}`).join("\n")}`);
  }

  const email = normalizeEmail(options.email);
  const role = normalizeRole(options.role);
  const userId = stableId("usr", email);
  const databaseOptions = getDatabaseOptions(options);
  const targetTourId = getTargetTourId(tour, databaseOptions);

  wranglerD1Execute(
    `INSERT INTO users (id, email, updated_at)
VALUES (${sqlLiteral(userId)}, ${sqlLiteral(email)}, ${nowSql()})
ON CONFLICT(email) DO UPDATE SET
  email = excluded.email,
  updated_at = ${nowSql()};

INSERT INTO tours (
  id, slug, revision_id, title, address, description, cover_image,
  index_url, asset_base_url, published_at, status, size_bytes, file_count, updated_at
)
VALUES (
  ${sqlLiteral(targetTourId)}, ${sqlLiteral(tour.slug)}, ${sqlLiteral(tour.revisionId)},
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
  ${sqlLiteral(targetTourId)},
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
  AND tours.id = ${sqlLiteral(targetTourId)};`,
      { ...databaseOptions, json: true },
    ),
  );

  console.log(`Imported ${targetTourId} (${tour.revisionId}) and assigned ${email} as ${role}.`);
  if (rows.length) {
    console.table(rows);
  }
}

function getTargetTourId(tour, databaseOptions) {
  const rows = readJsonRows(
    wranglerD1Execute(
      `SELECT id, slug, revision_id
FROM tours
WHERE id = ${sqlLiteral(tour.id)}
   OR (slug = ${sqlLiteral(tour.slug)} AND revision_id = ${sqlLiteral(tour.revisionId)});`,
      { ...databaseOptions, json: true },
    ),
  );
  const ids = new Set(rows.map((row) => row.id));
  if (ids.size > 1) {
    throw new Error(
      `D1 already has conflicting tour rows for id "${tour.id}" and revision "${tour.slug}/${tour.revisionId}".`,
    );
  }

  const existingId = rows[0]?.id;
  if (existingId && existingId !== tour.id) {
    console.warn(
      `Found existing D1 tour id "${existingId}" for ${tour.slug}/${tour.revisionId}; updating that row instead of changing its primary key to "${tour.id}".`,
    );
    return existingId;
  }

  return tour.id;
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function nowSql() {
  return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
}

function printUsage() {
  console.log(
    "Usage: node scripts/import-tour-to-d1.mjs <manifest-entry.json> --email client@example.com [--role viewer] [--database measured-space-dashboard] [--local|--remote] [--allow-example]",
  );
}
