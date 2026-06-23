#!/usr/bin/env node
import { parseArgs, readJsonRows, wranglerD1Execute } from "./lib/dashboard-d1.mjs";

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

function main() {
  const { options } = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    return;
  }

  const rows = readJsonRows(
    wranglerD1Execute(
      `SELECT
  tours.id,
  tours.slug,
  tours.revision_id,
  tours.title,
  tours.status,
  tours.published_at,
  COUNT(user_tours.user_id) AS assigned_users,
  COALESCE(group_concat(users.email, ', '), '') AS emails
FROM tours
LEFT JOIN user_tours ON user_tours.tour_id = tours.id
LEFT JOIN users ON users.id = user_tours.user_id
GROUP BY tours.id
ORDER BY datetime(tours.published_at) DESC, tours.title COLLATE NOCASE ASC;`,
      {
        database: options.database,
        remote: Boolean(options.remote),
        local: Boolean(options.local),
        json: true,
      },
    ),
  );

  if (!rows.length) {
    console.log("No dashboard tours found.");
    return;
  }
  console.table(rows);
}

function printUsage() {
  console.log("Usage: node scripts/list-dashboard-tours.mjs [--database measured-space-dashboard] [--remote]");
}
