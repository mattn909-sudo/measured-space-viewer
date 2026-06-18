const TOUR_CACHE = "measured-space-tours-v1";
const VIRTUAL_DIRECTORY = "/__tours/";

self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  const requestUrl = new URL(event.request.url);
  if (!requestUrl.pathname.includes(VIRTUAL_DIRECTORY)) {
    return;
  }

  event.respondWith(serveTourFile(event.request));
});

async function serveTourFile(request) {
  const cache = await caches.open(TOUR_CACHE);
  const response = await cache.match(request, { ignoreSearch: true });
  if (response) {
    return response;
  }

  return new Response("Tour file not found.", {
    status: 404,
    headers: { "Content-Type": "text/plain" },
  });
}
