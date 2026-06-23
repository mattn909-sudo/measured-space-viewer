const GEOCODE_CACHE_KEY = "measured-space-geocode-v1";
const GEOCODE_REQUEST_DELAY_MS = 1100;
const DEFAULT_MAP_CENTER = [39.8283, -98.5795];
const DEFAULT_MAP_ZOOM = 4;

const appBaseUrl = new URL("./", window.location.href);
const dashboardUserLabel = document.querySelector("#dashboard-user-label");
const cloudTourStatus = document.querySelector("#cloud-tour-status");
const cloudTourList = document.querySelector("#cloud-tour-list");
const refreshCloudToursButton = document.querySelector("#refresh-cloud-tours");
const mapElement = document.querySelector("#tour-map");
const mapStatus = document.querySelector("#map-status");

let prefetchedCloudTourUrl = "";
let dashboardTours = [];
let map;
let markerLayer;
let geocodeQueue = Promise.resolve();
let geocodeCache = readGeocodeCache();

removeLegacyLocalViewer().catch(() => {});
loadCloudTours().catch((error) => renderDashboardError(error.message));

refreshCloudToursButton.addEventListener("click", () => {
  loadCloudTours().catch((error) => renderDashboardError(error.message));
});

async function loadCloudTours() {
  performance.mark("cloud-catalog:start");
  setLoadingState();

  try {
    await loadDashboardTours();
  } catch (error) {
    if (isApiUnavailableError(error)) {
      await loadFallbackCatalog();
    } else {
      renderDashboardError(error.message);
    }
  } finally {
    refreshCloudToursButton.disabled = false;
  }
}

function setLoadingState() {
  cloudTourStatus.textContent = "Loading assigned tours...";
  cloudTourStatus.classList.remove("is-error");
  dashboardUserLabel.textContent = "Checking sign-in...";
  dashboardUserLabel.classList.add("is-muted");
  cloudTourList.replaceChildren(renderSkeletonCard(), renderSkeletonCard(), renderSkeletonCard());
  mapStatus.textContent = "Preparing map...";
  refreshCloudToursButton.disabled = true;
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
  dashboardTours = rawTours.map(validateCloudTour).filter(Boolean);
  renderDashboardTours(dashboardTours, {
    emptyMessage: "No tours are assigned to this account yet.",
    statusLabel: "assigned",
  });
  await renderTourMap(dashboardTours);
  performance.mark("cloud-catalog:rendered");
  measureCloudCatalog("Dashboard tours loaded", rawTours.length, dashboardTours.length);
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
  dashboardTours = rawTours.map(validateCloudTour).filter(Boolean);
  renderDashboardTours(dashboardTours, {
    emptyMessage: "No published cloud tours are available in the local catalog.",
    statusLabel: "preview",
  });
  await renderTourMap(dashboardTours);
  performance.mark("cloud-catalog:rendered");
  measureCloudCatalog("Fallback cloud catalog loaded", rawTours.length, dashboardTours.length);
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
  const squareFeet = normalizePositiveInteger(
    rawTour.squareFeet ?? rawTour.sqft ?? rawTour.square_feet ?? rawTour.floorAreaSqft,
  );
  const locationParts = normalizeLocationParts(rawTour);

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
    squareFeet,
    locationParts,
    latitude: parseCoordinate(rawTour.latitude ?? rawTour.lat),
    longitude: parseCoordinate(rawTour.longitude ?? rawTour.lng ?? rawTour.lon),
  };
}

function renderDashboardTours(tours, options = {}) {
  cloudTourList.replaceChildren();

  if (!tours.length) {
    cloudTourStatus.textContent = options.emptyMessage || "No published cloud tours are available.";
    cloudTourList.append(renderEmptyState(options.emptyMessage));
    return;
  }

  const statusLabel = options.statusLabel || "published";
  cloudTourStatus.textContent = `${tours.length} ${statusLabel} ${tours.length === 1 ? "tour" : "tours"}.`;
  cloudTourList.append(...tours.map(renderTourRow));
}

function renderDashboardUser(user) {
  dashboardUserLabel.textContent = user.name ? `${user.name} (${user.email})` : user.email;
  dashboardUserLabel.classList.remove("is-muted");
}

function renderTourRow(tour) {
  const row = document.createElement("article");
  row.className = "tour-row";
  row.dataset.tourId = tour.id;

  const content = document.createElement("div");
  content.className = "tour-row-content";

  const title = document.createElement("h3");
  title.textContent = getStreetTitle(tour);
  content.append(title);

  const location = document.createElement("p");
  location.className = "tour-location";
  location.dataset.locationDetails = "";
  location.textContent = formatLocationDetails(tour.locationParts);
  content.append(location);

  const meta = document.createElement("div");
  meta.className = "tour-meta";
  appendMeta(meta, "Published date", formatDate(tour.publishedAt) || "Not set");
  appendMeta(meta, "Sq ft", tour.squareFeet ? tour.squareFeet.toLocaleString() : "Not set");
  appendMeta(meta, "Files", tour.fileCount > 0 ? tour.fileCount.toLocaleString() : "0");
  content.append(meta);

  const actions = document.createElement("div");
  actions.className = "tour-actions";

  const locateButton = document.createElement("button");
  locateButton.className = "icon-button";
  locateButton.type = "button";
  locateButton.title = "Focus on map";
  locateButton.setAttribute("aria-label", `Focus ${tour.title} on the map`);
  locateButton.textContent = "Map";
  locateButton.addEventListener("click", () => focusTourOnMap(tour.id));

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

  actions.append(openLink, locateButton, copyButton);
  row.append(content, actions);
  return row;
}

function appendMeta(container, label, value) {
  if (!value) {
    return;
  }

  const item = document.createElement("span");
  const labelElement = document.createElement("strong");
  labelElement.textContent = `${label}:`;
  const valueElement = document.createElement("span");
  valueElement.textContent = value;
  item.append(labelElement, " ", valueElement);
  container.append(item);
}

function renderSkeletonCard() {
  const skeleton = document.createElement("div");
  skeleton.className = "tour-row tour-row-skeleton";
  skeleton.setAttribute("aria-hidden", "true");

  const thumb = document.createElement("span");
  thumb.className = "skeleton skeleton-thumb";

  const lines = document.createElement("span");
  lines.className = "skeleton-lines";
  lines.append(
    createSkeletonLine("70%"),
    createSkeletonLine("48%"),
    createSkeletonLine("84%"),
  );

  skeleton.append(lines);
  return skeleton;
}

function createSkeletonLine(width) {
  const line = document.createElement("span");
  line.className = "skeleton skeleton-line";
  line.style.width = width;
  return line;
}

function renderEmptyState(message) {
  const empty = document.createElement("section");
  empty.className = "empty-state";
  const title = document.createElement("h3");
  title.textContent = "No assigned tours";
  const copy = document.createElement("p");
  copy.textContent = message || "When a tour is assigned to this account, it will appear here.";
  empty.append(title, copy);
  return empty;
}

function renderDashboardError(message) {
  dashboardTours = [];
  cloudTourList.replaceChildren();
  cloudTourStatus.textContent = message || "Cloud tours could not be loaded.";
  cloudTourStatus.classList.add("is-error");
  mapStatus.textContent = "Map unavailable until tours load.";
}

async function renderTourMap(tours) {
  if (!tours.length) {
    resetMap();
    mapStatus.textContent = "No assigned addresses to map.";
    return;
  }

  if (!window.L) {
    mapStatus.textContent = "Map library could not load. Tour list is still available.";
    return;
  }

  const leaflet = window.L;
  if (!map) {
    map = leaflet.map(mapElement, {
      scrollWheelZoom: false,
      zoomControl: true,
    }).setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    leaflet
      .tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        maxZoom: 19,
        attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
      })
      .addTo(map);
    markerLayer = leaflet.layerGroup().addTo(map);
  }

  markerLayer.clearLayers();
  mapStatus.textContent = "Geocoding tour addresses...";
  const locatedTours = [];

  for (const tour of tours) {
    const location = await getTourLocation(tour);
    if (!location) {
      continue;
    }
    tour.locationParts = {
      ...tour.locationParts,
      ...parseLocationFromGeocodeLabel(location.label),
    };
    updateTourLocationDetails(tour);
    locatedTours.push({ tour, location });
    const marker = leaflet
      .marker([location.latitude, location.longitude], {
        title: tour.title,
        alt: tour.address || tour.title,
      })
      .addTo(markerLayer);
    marker.bindPopup(createMapPopup(tour, location));
    marker.on("click", () => highlightTourRow(tour.id));
  }

  if (!locatedTours.length) {
    map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
    mapStatus.textContent = "No tour addresses could be mapped yet.";
    return;
  }

  const bounds = leaflet.latLngBounds(
    locatedTours.map(({ location }) => [location.latitude, location.longitude]),
  );
  map.fitBounds(bounds.pad(0.22), { maxZoom: locatedTours.length === 1 ? 15 : 13 });
  mapStatus.textContent = `${locatedTours.length} ${locatedTours.length === 1 ? "address" : "addresses"} mapped with OpenStreetMap.`;
}

async function getTourLocation(tour) {
  if (Number.isFinite(tour.latitude) && Number.isFinite(tour.longitude)) {
    return {
      latitude: tour.latitude,
      longitude: tour.longitude,
      label: tour.address,
      source: "catalog",
    };
  }

  if (!tour.address) {
    return null;
  }

  return enqueueGeocode(tour.address);
}

function enqueueGeocode(address) {
  geocodeQueue = geocodeQueue
    .catch(() => {})
    .then(() => geocodeAddress(address));
  return geocodeQueue;
}

async function geocodeAddress(address) {
  const cacheKey = normalizeAddress(address);
  if (geocodeCache[cacheKey]) {
    return geocodeCache[cacheKey];
  }

  await delay(GEOCODE_REQUEST_DELAY_MS);
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.searchParams.set("format", "jsonv2");
  url.searchParams.set("limit", "1");
  url.searchParams.set("q", address);

  try {
    const response = await fetch(url, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const results = await response.json();
    const first = Array.isArray(results) ? results[0] : null;
    const latitude = Number(first?.lat);
    const longitude = Number(first?.lon);
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) {
      return null;
    }
    const location = {
      latitude,
      longitude,
      label: cleanOptionalString(first.display_name) || address,
      source: "nominatim",
    };
    geocodeCache[cacheKey] = location;
    writeGeocodeCache(geocodeCache);
    return location;
  } catch {
    return null;
  }
}

function createMapPopup(tour, location) {
  const popup = document.createElement("div");
  popup.className = "map-popup";

  const title = document.createElement("strong");
  title.textContent = getStreetTitle(tour);

  const address = document.createElement("span");
  address.textContent = location.label || tour.address || "Mapped tour";

  const openLink = document.createElement("a");
  openLink.href = tour.indexUrl;
  openLink.target = "_blank";
  openLink.rel = "noopener noreferrer";
  openLink.textContent = "Open tour";

  popup.append(title, address, openLink);
  return popup;
}

function focusTourOnMap(tourId) {
  const tour = dashboardTours.find((item) => item.id === tourId);
  if (!tour || !map || !markerLayer) {
    return;
  }

  const marker = markerLayer
    .getLayers()
    .find((layer) => layer.options?.title === tour.title);
  if (!marker) {
    mapStatus.textContent = "This tour does not have a mapped address yet.";
    return;
  }

  map.setView(marker.getLatLng(), 16);
  marker.openPopup();
  highlightTourRow(tour.id);
}

function highlightTourRow(tourId) {
  for (const row of cloudTourList.querySelectorAll(".tour-row")) {
    row.classList.toggle("is-selected", row.dataset.tourId === tourId);
  }
}

function resetMap() {
  if (markerLayer) {
    markerLayer.clearLayers();
  }
  if (map) {
    map.setView(DEFAULT_MAP_CENTER, DEFAULT_MAP_ZOOM);
  }
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

async function removeLegacyLocalViewer() {
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((registration) => registration.unregister()));
  }
  if ("caches" in window) {
    await caches.delete("measured-space-tours-v1");
  }
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

function readGeocodeCache() {
  try {
    const parsed = JSON.parse(localStorage.getItem(GEOCODE_CACHE_KEY) || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writeGeocodeCache(cache) {
  try {
    localStorage.setItem(GEOCODE_CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

function parseCoordinate(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePositiveInteger(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : 0;
}

function normalizeLocationParts(rawTour) {
  const parts = {
    street: cleanOptionalString(
      rawTour.street || rawTour.streetName || rawTour.street_name || rawTour.addressLine1,
    ),
    town: cleanOptionalString(rawTour.town || rawTour.neighborhood || rawTour.suburb),
    city: cleanOptionalString(rawTour.city || rawTour.municipality),
    state: cleanOptionalString(rawTour.state || rawTour.region),
    zipcode: cleanOptionalString(rawTour.zipcode || rawTour.zipCode || rawTour.postalCode),
  };

  if (!parts.street) {
    parts.street = extractStreetFromAddress(cleanOptionalString(rawTour.address));
  }
  return parts;
}

function parseLocationFromGeocodeLabel(label) {
  const segments = cleanOptionalString(label)
    .split(",")
    .map((segment) => segment.trim())
    .filter(Boolean);
  if (segments.length < 4) {
    return {};
  }

  const country = segments.at(-1);
  const zipcodeIndex = findZipcodeIndex(segments);
  const zipcode = zipcodeIndex >= 0 ? segments[zipcodeIndex] : "";
  const state = zipcodeIndex > 0 ? segments[zipcodeIndex - 1] : "";
  const city = zipcodeIndex > 2 ? segments[zipcodeIndex - 3] : segments.at(-3) || "";
  const town = zipcodeIndex > 3 ? segments[zipcodeIndex - 4] : "";

  return {
    street: buildStreetFromGeocodeSegments(segments),
    town: town && town !== country ? town : "",
    city: city && city !== country ? city : "",
    state,
    zipcode,
  };
}

function findZipcodeIndex(segments) {
  return segments.findIndex((segment) => /\b\d{5}(?:-\d{4})?\b/.test(segment));
}

function buildStreetFromGeocodeSegments(segments) {
  if (segments.length >= 2 && /^\d+[A-Za-z]?$/.test(segments[0])) {
    return `${segments[0]} ${segments[1]}`;
  }
  return segments[0] || "";
}

function extractStreetFromAddress(address) {
  return address.split(",")[0]?.trim() || "";
}

function getStreetTitle(tour) {
  return tour.locationParts.street || extractStreetFromAddress(tour.address) || tour.title;
}

function formatLocationDetails(parts) {
  const items = [parts.town, parts.city, parts.state, parts.zipcode].filter(Boolean);
  return items.length ? items.join(", ") : "Location details pending";
}

function updateTourLocationDetails(tour) {
  const row = cloudTourList.querySelector(`[data-tour-id="${CSS.escape(tour.id)}"]`);
  const title = row?.querySelector("h3");
  const location = row?.querySelector("[data-location-details]");
  if (title) {
    title.textContent = getStreetTitle(tour);
  }
  if (location) {
    location.textContent = formatLocationDetails(tour.locationParts);
  }
}

function normalizeAddress(address) {
  return address.toLowerCase().replace(/\s+/g, " ").trim();
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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
