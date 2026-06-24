import path from "node:path";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4177);
const PUBLIC_DIR = path.join(__dirname, "public");
const DASHBOARD_D1_DATABASE = process.env.DASHBOARD_D1_DATABASE || "measured-space-dashboard";

const app = express();

app.get("/api/me", (request, response) => {
  const user = getLocalDevUser(request);
  if (!user) {
    response.status(401).json({ error: "Local dashboard identity is disabled." });
    return;
  }

  response.set("Cache-Control", "no-store");
  response.json(user);
});

app.get("/api/tours", async (request, response, next) => {
  try {
    const user = getLocalDevUser(request);
    if (!user) {
      response.status(401).json({ error: "Local dashboard identity is disabled." });
      return;
    }

    if (isRemoteD1Enabled()) {
      const rows = readRemoteD1Rows(
        `SELECT
  tours.id,
  tours.slug,
  tours.revision_id,
  tours.title,
  tours.address,
  tours.description,
  tours.cover_image,
  tours.index_url,
  tours.asset_base_url,
  tours.published_at,
  tours.status,
  tours.size_bytes,
  tours.file_count,
  user_tours.role
FROM users
INNER JOIN user_tours ON user_tours.user_id = users.id
INNER JOIN tours ON tours.id = user_tours.tour_id
WHERE lower(users.email) = lower(${sqlLiteral(user.email)})
  AND tours.status = 'published'
ORDER BY datetime(tours.published_at) DESC, tours.title COLLATE NOCASE ASC;`,
      );
      response.set("Cache-Control", "no-store");
      response.json({
        user: {
          email: user.email,
          name: user.name,
        },
        tours: rows.map(toApiTour).filter(Boolean),
      });
      return;
    }

    const catalog = JSON.parse(await readFile(path.join(PUBLIC_DIR, "tours.json"), "utf8"));
    response.set("Cache-Control", "no-store");
    response.json({
      user: {
        email: user.email,
        name: user.name,
      },
      tours: Array.isArray(catalog) ? catalog : [],
    });
  } catch (error) {
    next(error);
  }
});

app.use(express.static(PUBLIC_DIR));

app.listen(PORT, () => {
  console.log(`Measured Space viewer app: http://127.0.0.1:${PORT}`);
  if (isRemoteD1Enabled()) {
    console.log(`Dashboard API source: remote Cloudflare D1 (${DASHBOARD_D1_DATABASE})`);
  }
});

function isRemoteD1Enabled() {
  return String(process.env.DASHBOARD_REMOTE_D1 || "").toLowerCase() === "true";
}

function readRemoteD1Rows(sql) {
  const args = ["wrangler", "d1", "execute", DASHBOARD_D1_DATABASE, "--remote", "--json", "--command", sql];
  const result = spawnSync("npx", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  if (result.status !== 0) {
    throw new Error(
      `Remote D1 query failed with exit code ${result.status}.\n${result.stderr || result.stdout}`.trim(),
    );
  }

  const output = result.stdout.trim();
  if (!output) {
    return [];
  }
  const parsed = JSON.parse(output.slice(output.search(/[\[{]/)));
  return Array.isArray(parsed) ? parsed.flatMap((item) => item.results || []) : parsed.results || [];
}

function toApiTour(row) {
  const indexUrl = cleanHttpUrl(row.index_url);
  const assetBaseUrl = cleanHttpUrl(row.asset_base_url);
  if (!indexUrl || !assetBaseUrl) {
    return null;
  }

  return {
    id: cleanString(row.id),
    slug: cleanString(row.slug),
    revisionId: cleanString(row.revision_id),
    title: cleanString(row.title),
    address: cleanString(row.address),
    description: cleanString(row.description),
    coverImage: cleanHttpUrl(row.cover_image),
    indexUrl,
    assetBaseUrl,
    publishedAt: cleanString(row.published_at),
    status: "published",
    sizeBytes: normalizeInteger(row.size_bytes),
    fileCount: normalizeInteger(row.file_count),
    role: cleanString(row.role) || "viewer",
  };
}

function sqlLiteral(value) {
  if (value == null || value === "") {
    return "NULL";
  }
  return `'${String(value).replace(/'/g, "''")}'`;
}

function getLocalDevUser(request) {
  const isDevEnabled =
    process.env.NODE_ENV !== "production" ||
    String(process.env.DASHBOARD_DEV_AUTH || "").toLowerCase() === "true";
  if (!isDevEnabled) {
    return null;
  }

  return {
    email:
      cleanEmail(process.env.DASHBOARD_DEV_EMAIL) ||
      cleanEmail(request.get("X-Dev-User-Email")) ||
      "dev@example.com",
    name: cleanString(process.env.DASHBOARD_DEV_NAME) || "Local Developer",
    source: "local-dev-server",
  };
}

function cleanEmail(value) {
  const email = cleanString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanHttpUrl(value) {
  const rawValue = cleanString(value);
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

function normalizeInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}
