#!/usr/bin/env node
import crypto from "node:crypto";

import {
  getDatabaseOptions,
  normalizeEmail,
  normalizeRequiredString,
  normalizeRole,
  parseArgs,
  readJsonRows,
  sqlLiteral,
  wranglerD1Execute,
} from "./lib/dashboard-d1.mjs";

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.help || !options["tour-id"] || !options.email) {
    printUsage();
    process.exitCode = options.help ? 0 : 1;
    return;
  }

  const tourId = normalizeRequiredString(options["tour-id"], "--tour-id");
  const email = normalizeEmail(options.email);
  const role = normalizeRole(options.role);
  const userId = stableId("usr", email);
  const databaseOptions = getDatabaseOptions(options);

  const existingTour = readJsonRows(
    wranglerD1Execute(`SELECT id, title, revision_id FROM tours WHERE id = ${sqlLiteral(tourId)};`, {
      ...databaseOptions,
      json: true,
    }),
  );
  if (!existingTour.length) {
    throw new Error(`Tour ${tourId} does not exist in D1. Import it first.`);
  }

  wranglerD1Execute(
    `INSERT INTO users (id, email, updated_at)
VALUES (${sqlLiteral(userId)}, ${sqlLiteral(email)}, ${nowSql()})
ON CONFLICT(email) DO UPDATE SET
  email = excluded.email,
  updated_at = ${nowSql()};

INSERT INTO user_tours (user_id, tour_id, role)
VALUES (
  (SELECT id FROM users WHERE lower(email) = lower(${sqlLiteral(email)})),
  ${sqlLiteral(tourId)},
  ${sqlLiteral(role)}
)
ON CONFLICT(user_id, tour_id) DO UPDATE SET role = excluded.role;`,
    databaseOptions,
  );

  const rows = readJsonRows(
    wranglerD1Execute(
      `SELECT users.email, tours.id AS tour_id, tours.title, tours.revision_id, user_tours.role
FROM user_tours
INNER JOIN users ON users.id = user_tours.user_id
INNER JOIN tours ON tours.id = user_tours.tour_id
WHERE lower(users.email) = lower(${sqlLiteral(email)})
  AND tours.id = ${sqlLiteral(tourId)};`,
      { ...databaseOptions, json: true },
    ),
  );

  console.log(`Assigned ${tourId} to ${email} as ${role}.`);
  console.table(rows);
}

function stableId(prefix, value) {
  return `${prefix}_${crypto.createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

function nowSql() {
  return "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
}

function printUsage() {
  console.log(
    "Usage: node scripts/assign-tour.mjs --tour-id 255-slade --email client@example.com [--role viewer] [--database measured-space-dashboard] [--local|--remote]",
  );
}
