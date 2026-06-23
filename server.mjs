import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import express from "express";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4177);
const PUBLIC_DIR = path.join(__dirname, "public");

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
});

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
