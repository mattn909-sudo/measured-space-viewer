export function jsonResponse(body, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("Content-Type", "application/json; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  return new Response(JSON.stringify(body), {
    ...init,
    headers,
  });
}

export function errorResponse(message, status = 500) {
  return jsonResponse({ error: message }, { status });
}
