import { BlobReader, BlobWriter, ZipReader, configure } from "@zip.js/zip.js";

configure({ useWebWorkers: false });

const TOUR_CACHE = "measured-space-tours-v1";
const VIRTUAL_DIRECTORY = "__tours";
const STORAGE_OVERHEAD_RATIO = 1.15;
const STORAGE_RESERVE_BYTES = 128 * 1024 * 1024;
const MAX_SINGLE_FILE_BYTES = 512 * 1024 * 1024;
const form = document.querySelector("#upload-form");
const fileInput = document.querySelector("#tour-file");
const dropZone = document.querySelector("#drop-zone");
const fileName = document.querySelector("#file-name");
const processButton = document.querySelector("#process-button");
const progressFill = document.querySelector("#progress-fill");
const statusText = document.querySelector("#status-text");
const cloudTourList = document.querySelector("#cloud-tour-list");
const cloudTourStatus = document.querySelector("#cloud-tour-status");
const dashboardUserLabel = document.querySelector("#dashboard-user-label");
const refreshCloudToursButton = document.querySelector("#refresh-cloud-tours");
const appBaseUrl = new URL("./", window.location.href);
let selectedFile = null;
let activeTourTab = null;
let prefetchedCloudTourUrl = "";

prepareServiceWorker().catch((error) => setStatus(error.message, "error"));
loadCloudTours().catch((error) => renderCloudTourError(error.message));

refreshCloudToursButton.addEventListener("click", () => {
  loadCloudTours().catch((error) => renderCloudTourError(error.message));
});

fileInput.addEventListener("change", () => {
  selectFile(fileInput.files[0]);
});

dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("is-dragging");
});

dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("is-dragging");
});

document.addEventListener("dragover", (event) => {
  event.preventDefault();
  document.body.classList.add("is-dragging");
});

document.addEventListener("dragleave", (event) => {
  if (!event.relatedTarget) {
    document.body.classList.remove("is-dragging");
  }
});

document.addEventListener("drop", (event) => {
  event.preventDefault();
  document.body.classList.remove("is-dragging");
  dropZone.classList.remove("is-dragging");
  if (event.dataTransfer.files.length) {
    selectFile(event.dataTransfer.files[0]);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const file = selectedFile;
  if (!file) {
    setStatus("Choose a zip file first.", "error");
    return;
  }

  const tourTab = openLoadingTab();
  activeTourTab = tourTab;
  await openTour(file, tourTab);
});

async function loadCloudTours() {
  performance.mark("cloud-catalog:start");
  cloudTourStatus.textContent = "Loading assigned tours...";
  cloudTourStatus.classList.remove("is-error");
  dashboardUserLabel.textContent = "Checking sign-in...";
  dashboardUserLabel.classList.add("is-muted");
  cloudTourList.replaceChildren();
  refreshCloudToursButton.disabled = true;

  try {
    await loadDashboardTours();
  } catch (error) {
    if (isApiUnavailableError(error)) {
      await loadFallbackCatalog();
    } else {
      renderCloudTourError(error.message);
    }
  } finally {
    refreshCloudToursButton.disabled = false;
  }
}

async function loadDashboardTours() {
  const me = await fetchJson(new URL("api/me", appBaseUrl), "Identity request failed");
  const user = validateUser(me);
  if (!user) {
    throw new Error("The sign-in response did not include a valid user email.");
  }
  renderDashboardUser(user);

  const dashboard = await fetchJson(new URL("api/tours", appBaseUrl), "Assigned tours request failed");
  const rawTours = Array.isArray(dashboard) ? dashboard : dashboard.tours;
  if (!Array.isArray(rawTours)) {
    throw new Error("Assigned tours response must include a tours array.");
  }

  performance.mark("cloud-catalog:fetched");
  const tours = rawTours.map(validateCloudTour).filter(Boolean);
  renderCloudTours(tours, {
    emptyMessage: "No tours are assigned to this account yet.",
    statusLabel: "assigned",
  });
  performance.mark("cloud-catalog:rendered");
  measureCloudCatalog("Dashboard tours loaded", rawTours.length, tours.length);
}

async function loadFallbackCatalog() {
  dashboardUserLabel.textContent = "Local catalog preview";
  dashboardUserLabel.classList.add("is-muted");
  cloudTourStatus.textContent = "Dashboard APIs are unavailable here. Showing non-production catalog preview.";

  const rawTours = await fetchJson(new URL("tours.json", appBaseUrl), "Catalog request failed");
  if (!Array.isArray(rawTours)) {
    throw new Error("Catalog must be a JSON array.");
  }

  performance.mark("cloud-catalog:fetched");
  const tours = rawTours.map(validateCloudTour).filter(Boolean);
  renderCloudTours(tours, {
    emptyMessage: "No published cloud tours are available in the local catalog.",
    statusLabel: "preview",
  });
  performance.mark("cloud-catalog:rendered");
  measureCloudCatalog("Fallback cloud catalog loaded", rawTours.length, tours.length);
}

async function fetchJson(url, label) {
  let response;
  try {
    response = await fetch(url, {
      cache: "no-cache",
      headers: { Accept: "application/json" },
    });
  } catch (error) {
    throw new ApiRequestError(`${label}.`, 0, error);
  }

  if (!response.ok) {
    throw new ApiRequestError(`${label} (${response.status}).`, response.status);
  }

  try {
    return await response.json();
  } catch (error) {
    throw new ApiRequestError(`${label}: response was not valid JSON.`, response.status, error);
  }
}

function validateUser(rawUser) {
  if (!rawUser || typeof rawUser !== "object") {
    return null;
  }
  const email = cleanRequiredString(rawUser.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return null;
  }
  return {
    email: email.toLowerCase(),
    name: cleanOptionalString(rawUser.name),
  };
}

function validateCloudTour(rawTour) {
  if (!rawTour || typeof rawTour !== "object" || rawTour.status !== "published") {
    return null;
  }

  const id = cleanRequiredString(rawTour.id);
  const slug = cleanRequiredString(rawTour.slug);
  const title = cleanRequiredString(rawTour.title);
  const indexUrl = cleanUrl(rawTour.indexUrl);
  if (!id || !slug || !title || !indexUrl) {
    return null;
  }

  const assetBaseUrl = cleanUrl(rawTour.assetBaseUrl);
  const coverImage = cleanUrl(rawTour.coverImage);
  const sizeBytes = Number(rawTour.sizeBytes);
  const fileCount = Number(rawTour.fileCount);

  return {
    id,
    slug,
    revisionId: cleanOptionalString(rawTour.revisionId),
    title,
    address: cleanOptionalString(rawTour.address),
    description: cleanOptionalString(rawTour.description),
    coverImage: coverImage || "",
    indexUrl,
    assetBaseUrl: assetBaseUrl || "",
    publishedAt: cleanOptionalString(rawTour.publishedAt),
    status: "published",
    sizeBytes: Number.isFinite(sizeBytes) && sizeBytes > 0 ? sizeBytes : 0,
    fileCount: Number.isFinite(fileCount) && fileCount > 0 ? fileCount : 0,
  };
}

function renderCloudTours(tours, options = {}) {
  cloudTourList.replaceChildren();
  if (!tours.length) {
    cloudTourStatus.textContent = options.emptyMessage || "No published cloud tours are available.";
    return;
  }

  const statusLabel = options.statusLabel || "published";
  cloudTourStatus.textContent = `${tours.length} ${statusLabel} ${tours.length === 1 ? "tour" : "tours"}.`;
  cloudTourList.append(...tours.map(renderCloudTourCard));
}

function renderDashboardUser(user) {
  dashboardUserLabel.textContent = user.name ? `${user.name} (${user.email})` : user.email;
  dashboardUserLabel.classList.remove("is-muted");
}

function renderCloudTourCard(tour) {
  const card = document.createElement("article");
  card.className = "tour-card";

  if (tour.coverImage) {
    const image = document.createElement("img");
    image.className = "tour-cover";
    image.src = tour.coverImage;
    image.alt = "";
    image.loading = "lazy";
    image.decoding = "async";
    card.append(image);
  }

  const content = document.createElement("div");
  const title = document.createElement("h3");
  title.textContent = tour.title;
  content.append(title);

  if (tour.address) {
    const address = document.createElement("p");
    address.className = "tour-address";
    address.textContent = tour.address;
    content.append(address);
  }

  if (tour.description) {
    const description = document.createElement("p");
    description.textContent = tour.description;
    content.append(description);
  }

  const meta = document.createElement("div");
  meta.className = "tour-meta";
  const published = formatDate(tour.publishedAt);
  if (published) {
    const publishedText = document.createElement("span");
    publishedText.textContent = published;
    meta.append(publishedText);
  }
  if (tour.sizeBytes > 0) {
    const sizeText = document.createElement("span");
    sizeText.textContent = formatBytes(tour.sizeBytes);
    meta.append(sizeText);
  }
  if (tour.fileCount > 0) {
    const countText = document.createElement("span");
    countText.textContent = `${tour.fileCount.toLocaleString()} files`;
    meta.append(countText);
  }
  if (meta.childElementCount) {
    content.append(meta);
  }

  const actions = document.createElement("div");
  actions.className = "tour-actions";

  const openLink = document.createElement("a");
  openLink.className = "primary-link";
  openLink.href = tour.indexUrl;
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  openLink.textContent = "Open tour";
  openLink.addEventListener("click", (event) => {
    event.preventDefault();
    openCloudTour(tour);
  });
  openLink.addEventListener("pointerenter", () => prefetchCloudTourIndex(tour));
  openLink.addEventListener("focus", () => prefetchCloudTourIndex(tour));

  const copyButton = document.createElement("button");
  copyButton.className = "copy-button";
  copyButton.type = "button";
  copyButton.textContent = "Copy link";
  copyButton.addEventListener("click", () => copyCloudTourLink(tour, copyButton));

  actions.append(openLink, copyButton);
  card.append(content, actions);
  return card;
}

function renderCloudTourError(message) {
  cloudTourList.replaceChildren();
  cloudTourStatus.textContent = message || "Cloud tours could not be loaded.";
  cloudTourStatus.classList.add("is-error");
}

function measureCloudCatalog(label, totalEntries, renderedEntries) {
  performance.measure("cloud-catalog:fetch", "cloud-catalog:start", "cloud-catalog:fetched");
  performance.measure("cloud-catalog:render", "cloud-catalog:fetched", "cloud-catalog:rendered");
  console.info(label, {
    totalEntries,
    renderedEntries,
    measures: performance
      .getEntriesByType("measure")
      .filter((entry) => entry.name.startsWith("cloud-catalog:"))
      .slice(-2)
      .map((entry) => ({ name: entry.name, durationMs: Math.round(entry.duration) })),
  });
}

function isApiUnavailableError(error) {
  return (
    isLocalStaticMode() &&
    error instanceof ApiRequestError &&
    (error.status === 0 || error.status === 404 || error.status === 405)
  );
}

function isLocalStaticMode() {
  return (
    window.location.protocol === "file:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.hostname === "[::1]"
  );
}

class ApiRequestError extends Error {
  constructor(message, status, cause) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.cause = cause;
  }
}

function openCloudTour(tour) {
  window.open(tour.indexUrl, "_blank", "noopener,noreferrer");
}

async function copyCloudTourLink(tour, button) {
  const originalText = button.textContent;
  try {
    await navigator.clipboard.writeText(tour.indexUrl);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  window.setTimeout(() => {
    button.textContent = originalText;
  }, 1800);
}

function prefetchCloudTourIndex(tour) {
  if (tour.indexUrl === prefetchedCloudTourUrl) {
    return;
  }
  prefetchedCloudTourUrl = tour.indexUrl;
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = tour.indexUrl;
  link.as = "document";
  document.head.append(link);
}

async function openTour(file, tourTab) {
  setBusy(true);
  setProgress(1);
  setStatus("Reading tour archive...");

  let zipReader;
  let tourPrefix;

  try {
    await prepareServiceWorker();
    await navigator.storage?.persist?.();

    zipReader = new ZipReader(new BlobReader(file));
    const entries = await zipReader.getEntries();
    const viewerRoot = findViewerRoot(entries);
    const viewerEntries = entries.filter((entry) => belongsToViewer(entry, viewerRoot));
    const totalBytes = viewerEntries.reduce((sum, entry) => sum + (entry.uncompressedSize || 0), 0);
    validateViewerEntries(viewerEntries, totalBytes);
    const tourId = createTourId(file.name);
    tourPrefix = new URL(`${VIRTUAL_DIRECTORY}/${tourId}/`, appBaseUrl);

    await clearStoredTours();
    await ensureStorageCapacity(totalBytes);

    const cache = await caches.open(TOUR_CACHE);
    let completedBytes = 0;

    for (const entry of viewerEntries) {
      if (entry.directory || shouldSkipEntry(entry.filename)) {
        continue;
      }

      const relativePath = normalizeEntryPath(entry.filename).slice(viewerRoot.length);
      const entrySize = entry.uncompressedSize || 0;
      setStatus(`Unzipping ${shortName(relativePath)}...`);

      const blob = await entry.getData(new BlobWriter(getMimeType(relativePath)), {
        onprogress(loaded) {
          updateExtractionProgress(completedBytes + loaded, totalBytes);
        },
      });

      const fileUrl = new URL(encodePath(relativePath), tourPrefix);
      await cache.put(
        fileUrl,
        new Response(blob, {
          headers: {
            "Cache-Control": "no-store",
            "Content-Type": getMimeType(relativePath),
          },
        }),
      );

      completedBytes += entrySize;
      updateExtractionProgress(completedBytes, totalBytes);
    }

    const tourUrl = new URL("index.html", tourPrefix);
    const cachedIndex = await cache.match(tourUrl);
    if (!cachedIndex) {
      throw new Error("The tour index could not be stored.");
    }

    setProgress(100);
    setStatus("Opening tour...");
    if (tourTab && !tourTab.closed) {
      tourTab.location.replace(tourUrl);
    } else {
      window.location.assign(tourUrl);
    }
    activeTourTab = null;
  } catch (error) {
    if (tourPrefix) {
      await deleteTour(tourPrefix).catch(() => {});
    }
    console.error(error);
    const message = readableError(error);
    setProgress(0);
    setStatus(message, "error");
    showTourTabError(tourTab, message);
    setBusy(false);
    activeTourTab = null;
  } finally {
    await zipReader?.close().catch(() => {});
  }
}

function openLoadingTab() {
  const tourTab = window.open("", "_blank");
  if (!tourTab) {
    return null;
  }

  tourTab.document.title = "Opening tour";
  tourTab.document.body.style.cssText = "margin:0;min-height:100vh;background:#f5f7f8";

  const main = tourTab.document.createElement("main");
  main.style.cssText =
    "display:grid;align-content:center;gap:18px;width:min(520px,calc(100% - 40px));min-height:100vh;margin:auto;font:16px system-ui,sans-serif;color:#172026";

  const title = tourTab.document.createElement("h1");
  title.textContent = "Opening tour";
  title.style.cssText = "margin:0;font-size:24px;letter-spacing:0";

  const track = tourTab.document.createElement("div");
  track.style.cssText = "height:12px;overflow:hidden;border-radius:999px;background:#dfe7e9";
  track.setAttribute("role", "progressbar");
  track.setAttribute("aria-valuemin", "0");
  track.setAttribute("aria-valuemax", "100");
  track.setAttribute("aria-valuenow", "0");

  const fill = tourTab.document.createElement("span");
  fill.dataset.progressFill = "";
  fill.style.cssText =
    "display:block;width:0;height:100%;border-radius:inherit;background:#0f766e;transition:width 160ms ease";
  track.append(fill);

  const status = tourTab.document.createElement("p");
  status.dataset.progressStatus = "";
  status.textContent = "Preparing tour...";
  status.style.cssText = "margin:0;color:#5f6f7a;overflow-wrap:anywhere";

  main.append(title, track, status);
  tourTab.document.body.append(main);
  return tourTab;
}

function showTourTabError(tourTab, message) {
  if (!tourTab || tourTab.closed) {
    return;
  }

  tourTab.document.title = "Tour could not open";
  const heading = tourTab.document.querySelector("h1");
  const track = tourTab.document.querySelector('[role="progressbar"]');
  const status = tourTab.document.querySelector("[data-progress-status]");
  const main = tourTab.document.querySelector("main");

  if (heading) {
    heading.textContent = "Tour could not open";
  }
  if (track) {
    track.hidden = true;
  }
  if (status) {
    status.textContent = message;
    status.style.color = "#b42318";
  }
  if (main && !main.querySelector("button")) {
    const recovery = tourTab.document.createElement("p");
    recovery.textContent = "Free some disk space, close other tabs, or try a smaller or freshly exported ZIP.";
    recovery.style.cssText = "margin:0;color:#5f6f7a;line-height:1.5";

    const closeButton = tourTab.document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = "Close this tab";
    closeButton.style.cssText =
      "min-height:48px;padding:0 20px;border:0;border-radius:6px;color:white;background:#0f766e;font:700 16px system-ui,sans-serif;cursor:pointer";
    closeButton.addEventListener("click", () => tourTab.close());
    main.append(recovery, closeButton);
  }
}

async function prepareServiceWorker() {
  if (!("serviceWorker" in navigator) || !("caches" in window)) {
    throw new Error("This browser does not support local tour storage.");
  }

  const workerUrl = new URL("service-worker.js", appBaseUrl);
  await navigator.serviceWorker.register(workerUrl, { scope: appBaseUrl.pathname });
  await navigator.serviceWorker.ready;
}

function findViewerRoot(entries) {
  const filePaths = entries
    .filter((entry) => !entry.directory && !shouldSkipEntry(entry.filename))
    .map((entry) => normalizeEntryPath(entry.filename));

  const candidates = filePaths
    .filter((filePath) => filePath === "index.html" || filePath.endsWith("/index.html"))
    .map((indexPath) => indexPath.slice(0, -"index.html".length))
    .filter((root) => filePaths.some((filePath) => filePath.startsWith(`${root}html_assets/`)))
    .sort((a, b) => a.length - b.length);

  if (!candidates.length) {
    throw new Error("Could not find index.html beside an html_assets folder in this zip.");
  }
  return candidates[0];
}

function belongsToViewer(entry, root) {
  const filePath = normalizeEntryPath(entry.filename);
  return filePath.startsWith(root) && !shouldSkipEntry(filePath);
}

function validateViewerEntries(entries, totalBytes) {
  const files = entries.filter((entry) => !entry.directory && !shouldSkipEntry(entry.filename));
  if (!files.length || totalBytes <= 0) {
    throw new Error("This ZIP does not contain any readable tour files.");
  }

  const oversizedEntry = files.find((entry) => (entry.uncompressedSize || 0) > MAX_SINGLE_FILE_BYTES);
  if (oversizedEntry) {
    throw new Error(
      `${shortName(oversizedEntry.filename)} is too large for reliable in-browser extraction.`,
    );
  }
}

function normalizeEntryPath(filePath) {
  return filePath.replace(/\\/g, "/").replace(/^\.\//, "");
}

function shouldSkipEntry(filePath) {
  const normalized = normalizeEntryPath(filePath);
  const basename = normalized.split("/").pop();
  return normalized === "__MACOSX" ||
    normalized.startsWith("__MACOSX/") ||
    basename === ".DS_Store" ||
    basename.startsWith("._");
}

async function clearStoredTours() {
  const cache = await caches.open(TOUR_CACHE);
  const requests = await cache.keys();
  await Promise.all(requests.map((request) => cache.delete(request)));
}

async function deleteTour(tourPrefix) {
  const cache = await caches.open(TOUR_CACHE);
  const requests = await cache.keys();
  await Promise.all(
    requests
      .filter((request) => request.url.startsWith(tourPrefix.href))
      .map((request) => cache.delete(request)),
  );
}

async function ensureStorageCapacity(requiredBytes) {
  const estimate = await navigator.storage?.estimate?.();
  if (!estimate?.quota || estimate.usage == null) {
    return;
  }

  const available = Math.max(0, estimate.quota - estimate.usage);
  const safeRequiredBytes = Math.ceil(requiredBytes * STORAGE_OVERHEAD_RATIO) + STORAGE_RESERVE_BYTES;
  if (safeRequiredBytes > available) {
    throw new Error(
      `This tour needs about ${formatBytes(safeRequiredBytes)} of safe working space, but only ${formatBytes(available)} is available.`,
    );
  }
}

function updateExtractionProgress(completed, total) {
  const percent = total ? Math.round((completed / total) * 96) : 50;
  setProgress(Math.max(2, Math.min(98, percent)));
}

function selectFile(file) {
  if (file && !file.name.toLowerCase().endsWith(".zip")) {
    selectedFile = null;
    processButton.disabled = true;
    fileName.textContent = file.name;
    setStatus("Choose a .zip tour export.", "error");
    setProgress(0);
    return;
  }

  selectedFile = file || null;
  processButton.disabled = !file;
  fileName.textContent = file ? `${file.name} (${formatBytes(file.size)})` : "or drag the zip file here";
  setStatus(file ? "Ready to open." : "Waiting for a zip file.");
  setProgress(0);
}

function setBusy(isBusy) {
  processButton.disabled = isBusy || !selectedFile;
  processButton.textContent = isBusy ? "Unzipping..." : "Open tour";
}

function setStatus(message, type = "info") {
  statusText.textContent = message;
  statusText.classList.toggle("is-error", type === "error");
  if (activeTourTab && !activeTourTab.closed) {
    const tabStatus = activeTourTab.document.querySelector("[data-progress-status]");
    if (tabStatus) {
      tabStatus.textContent = message;
      tabStatus.style.color = type === "error" ? "#b42318" : "#5f6f7a";
    }
  }
}

function setProgress(value) {
  progressFill.style.width = `${value}%`;
  if (activeTourTab && !activeTourTab.closed) {
    const tabFill = activeTourTab.document.querySelector("[data-progress-fill]");
    const tabTrack = tabFill?.parentElement;
    if (tabFill && tabTrack) {
      tabFill.style.width = `${value}%`;
      tabTrack.setAttribute("aria-valuenow", String(Math.round(value)));
    }
  }
}

function createTourId(fileName) {
  const slug = fileName
    .replace(/\.zip$/i, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48) || "tour";
  return `${Date.now()}-${slug}`;
}

function encodePath(filePath) {
  return filePath.split("/").map(encodeURIComponent).join("/");
}

function shortName(filePath) {
  const name = filePath.split("/").pop() || filePath;
  return name.length > 48 ? `${name.slice(0, 45)}...` : name;
}

function readableError(error) {
  if (error?.name === "QuotaExceededError") {
    return "The browser ran out of storage. Partial tour files were removed.";
  }
  if (error?.name === "RangeError" || /memory|allocation|array buffer/i.test(error?.message || "")) {
    return "This device ran out of working memory while unzipping the tour. Partial tour files were removed.";
  }
  if (/central directory|invalid zip|corrupt|unexpected end|bad signature/i.test(error?.message || "")) {
    return "This ZIP appears incomplete or damaged. Export or download the tour again and retry.";
  }
  if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
    return "The browser blocked local tour storage. Allow site storage or use a supported browser.";
  }
  return error?.message || "The tour could not be opened.";
}

function getMimeType(filePath) {
  const extension = filePath.split(".").pop()?.toLowerCase();
  return ({
    css: "text/css",
    csv: "text/csv",
    gif: "image/gif",
    glb: "model/gltf-binary",
    html: "text/html",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    mjs: "text/javascript",
    mp3: "audio/mpeg",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    wasm: "application/wasm",
    webm: "video/webm",
    webp: "image/webp",
    xml: "application/xml",
  })[extension] || "application/octet-stream";
}

function cleanRequiredString(value) {
  const cleaned = cleanOptionalString(value);
  return cleaned || "";
}

function cleanOptionalString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function cleanUrl(value) {
  const rawValue = cleanOptionalString(value);
  if (!rawValue) {
    return "";
  }

  try {
    const url = new URL(rawValue, window.location.href);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function formatDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}
