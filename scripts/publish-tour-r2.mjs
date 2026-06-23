#!/usr/bin/env node
import { createHash, createHmac } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

const DEFAULT_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 750;
const REQUIRED_ENV = [
  "R2_ACCOUNT_ID",
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_BUCKET",
  "R2_PUBLIC_BASE_URL",
];

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

async function main() {
  const { positional, options } = parseArgs(process.argv.slice(2));
  const folder = positional[0];
  const prefix = normalizePrefix(options.prefix || "");
  const dryRun = Boolean(options["dry-run"]);
  const retries = parseNonNegativeInteger(options.retries ?? DEFAULT_RETRIES, "--retries");
  const startAt = normalizeRelativeFilter(options["start-at"] || "");
  const startAfter = normalizeRelativeFilter(options["start-after"] || "");
  if (startAt && startAfter) {
    throw new Error("Use only one of --start-at or --start-after.");
  }

  if (!folder || !prefix || options.help) {
    printUsage();
    process.exitCode = folder && prefix ? 0 : 1;
    return;
  }

  const env = readEnv();
  if (/r2\.dev/i.test(env.R2_PUBLIC_BASE_URL)) {
    console.warn("Warning: use a production R2 custom domain for public tours, not r2.dev.");
  }

  const rootDir = path.resolve(folder);
  const files = await listFiles(rootDir);
  if (!files.length) {
    throw new Error(`No files found in ${rootDir}`);
  }

  const selectedFiles = filterFilesForResume(files, rootDir, { startAt, startAfter });
  if (!selectedFiles.length) {
    throw new Error("No files matched the requested resume filter.");
  }

  console.log(`${dryRun ? "Dry run:" : "Publishing"} ${selectedFiles.length} files to R2 bucket ${env.R2_BUCKET}`);
  if (selectedFiles.length !== files.length) {
    console.log(`Resume filter selected ${selectedFiles.length} of ${files.length} total files.`);
  }

  for (const filePath of selectedFiles) {
    const relativePath = path.relative(rootDir, filePath).split(path.sep).join("/");
    const key = `${prefix}/${relativePath}`;
    const contentType = getMimeType(relativePath);
    const cacheControl = cacheControlForKey(key);
    const publicUrl = buildPublicUrl(env.R2_PUBLIC_BASE_URL, key);

    if (dryRun) {
      const fileStats = await stat(filePath);
      console.log(`- ${key} ${formatBytes(fileStats.size)} ${contentType} ${cacheControl}`);
      continue;
    }

    await putObjectWithRetry({ env, key, filePath, contentType, cacheControl, retries });
    console.log(`Uploaded ${publicUrl}`);
  }
}

async function putObjectWithRetry({ env, key, filePath, contentType, cacheControl, retries }) {
  let lastError;
  for (let attempt = 1; attempt <= retries + 1; attempt += 1) {
    try {
      await putObject({ env, key, filePath, contentType, cacheControl });
      return;
    } catch (error) {
      lastError = error;
      if (attempt > retries || !isRetryableUploadError(error)) {
        break;
      }
      const delayMs = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(`Upload retry ${attempt}/${retries} for ${key}: ${readableError(error)}`);
      await sleep(delayMs);
    }
  }

  throw new Error(`R2 upload failed for ${key}: ${readableError(lastError)}`);
}

async function putObject({ env, key, filePath, contentType, cacheControl }) {
  const body = await readFile(filePath);
  const payloadHash = sha256Hex(body);
  const now = new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const host = `${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`;
  const canonicalUri = `/${encodeS3Path(env.R2_BUCKET)}/${encodeS3Path(key)}`;
  const url = `https://${host}${canonicalUri}`;
  const signedHeaders = "cache-control;content-type;host;x-amz-content-sha256;x-amz-date";
  const headers = {
    "Cache-Control": cacheControl,
    "Content-Type": contentType,
    "x-amz-content-sha256": payloadHash,
    "x-amz-date": amzDate,
  };

  const canonicalHeaders = [
    `cache-control:${cacheControl}`,
    `content-type:${contentType}`,
    `host:${host}`,
    `x-amz-content-sha256:${payloadHash}`,
    `x-amz-date:${amzDate}`,
    "",
  ].join("\n");

  const canonicalRequest = ["PUT", canonicalUri, "", canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const credentialScope = `${dateStamp}/auto/s3/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join("\n");
  const signature = hmacHex(signingKey(env.R2_SECRET_ACCESS_KEY, dateStamp), stringToSign);

  headers.Authorization =
    `AWS4-HMAC-SHA256 Credential=${env.R2_ACCESS_KEY_ID}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, { method: "PUT", headers, body });
  if (!response.ok) {
    const responseText = await response.text().catch(() => "");
    const error = new Error(`${response.status} ${response.statusText} ${responseText}`.trim());
    error.status = response.status;
    throw error;
  }
}

async function listFiles(rootDir) {
  const results = [];

  async function walk(currentDir) {
    const dirents = await readdir(currentDir, { withFileTypes: true });
    for (const dirent of dirents) {
      const filePath = path.join(currentDir, dirent.name);
      if (dirent.isDirectory()) {
        await walk(filePath);
      } else if (dirent.isFile()) {
        results.push(filePath);
      }
    }
  }

  await walk(rootDir);
  return results.sort();
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
    if (key === "dry-run" || key === "help") {
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

function readEnv() {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(", ")}`);
  }
  return Object.fromEntries(REQUIRED_ENV.map((key) => [key, process.env[key]]));
}

function normalizePrefix(value) {
  return String(value).replace(/^\/+|\/+$/g, "");
}

function normalizeRelativeFilter(value) {
  return String(value).replace(/^\/+/, "");
}

function filterFilesForResume(files, rootDir, { startAt, startAfter }) {
  if (!startAt && !startAfter) {
    return files;
  }

  const relativePaths = files.map((filePath) => path.relative(rootDir, filePath).split(path.sep).join("/"));
  const needle = startAt || startAfter;
  const matchIndex = relativePaths.indexOf(needle);
  if (matchIndex === -1) {
    throw new Error(`Resume file not found in prepared folder: ${needle}`);
  }

  const startIndex = startAt ? matchIndex : matchIndex + 1;
  return files.slice(startIndex);
}

function parseNonNegativeInteger(value, label) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return number;
}

function isRetryableUploadError(error) {
  if (!error) {
    return false;
  }
  if (error.status) {
    return error.status === 408 || error.status === 429 || error.status >= 500;
  }
  return true;
}

function readableError(error) {
  if (!error) {
    return "unknown error";
  }
  if (error.cause?.code) {
    return `${error.message} (${error.cause.code})`;
  }
  return error.message || String(error);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cacheControlForKey(key) {
  if (key.endsWith("tours.json") || key.includes("/latest/")) {
    return "public, max-age=60, stale-while-revalidate=300";
  }
  return "public, max-age=31536000, immutable";
}

function buildPublicUrl(baseUrl, key) {
  const normalizedBase = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  return new URL(key, normalizedBase).href;
}

function encodeS3Path(value) {
  return String(value)
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function signingKey(secretAccessKey, dateStamp) {
  const dateKey = hmacBuffer(`AWS4${secretAccessKey}`, dateStamp);
  const dateRegionKey = hmacBuffer(dateKey, "auto");
  const dateRegionServiceKey = hmacBuffer(dateRegionKey, "s3");
  return hmacBuffer(dateRegionServiceKey, "aws4_request");
}

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmacBuffer(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function hmacHex(key, value) {
  return createHmac("sha256", key).update(value).digest("hex");
}

function getMimeType(filePath) {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return (
    {
      css: "text/css",
      gif: "image/gif",
      glb: "model/gltf-binary",
      html: "text/html; charset=utf-8",
      ico: "image/x-icon",
      jpeg: "image/jpeg",
      jpg: "image/jpeg",
      js: "text/javascript; charset=utf-8",
      json: "application/json; charset=utf-8",
      mjs: "text/javascript; charset=utf-8",
      mp3: "audio/mpeg",
      mp4: "video/mp4",
      pcd: "application/octet-stream",
      png: "image/png",
      svg: "image/svg+xml",
      txt: "text/plain; charset=utf-8",
      wasm: "application/wasm",
      webm: "video/webm",
      webp: "image/webp",
      xml: "application/xml",
    }[extension] || "application/octet-stream"
  );
}

function formatBytes(bytes) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function printUsage() {
  console.log(`Usage:
R2_ACCOUNT_ID=... R2_ACCESS_KEY_ID=... R2_SECRET_ACCESS_KEY=... \\
R2_BUCKET=... R2_PUBLIC_BASE_URL=https://tours.example.com \\
node scripts/publish-tour-r2.mjs dist/tours/<slug>/<revisionId> \\
  --prefix tours/<slug>/<revisionId> \\
  --dry-run

Options:
  --retries 3              Retry transient upload failures per file.
  --start-at path          Resume beginning with this relative file path.
  --start-after path       Resume after this relative file path.`);
}
