export function getAuthenticatedUser(request, env = {}) {
  const accessEmail = cleanEmail(request.headers.get("Cf-Access-Authenticated-User-Email"));
  if (accessEmail) {
    return {
      email: accessEmail,
      name: cleanString(request.headers.get("Cf-Access-Authenticated-User-Name")),
      source: "cloudflare-access-header",
    };
  }

  const jwtUser = getAccessJwtUser(request);
  if (jwtUser.email) {
    return {
      email: jwtUser.email,
      name: jwtUser.name,
      source: "cloudflare-access-jwt",
    };
  }

  if (isDevAuthEnabled(env)) {
    const devEmail =
      cleanEmail(env.DASHBOARD_DEV_EMAIL) ||
      cleanEmail(request.headers.get("X-Dev-User-Email")) ||
      "dev@example.com";
    return {
      email: devEmail,
      name: cleanString(env.DASHBOARD_DEV_NAME) || "Local Developer",
      source: "local-dev-fallback",
    };
  }

  return null;
}

export function isDevAuthEnabled(env = {}) {
  if (String(env.DASHBOARD_DEV_AUTH || "").toLowerCase() === "true") {
    return true;
  }
  return String(env.NODE_ENV || "production").toLowerCase() !== "production";
}

function getAccessJwtUser(request) {
  const jwt = cleanString(request.headers.get("Cf-Access-Jwt-Assertion"));
  if (!jwt) {
    return {};
  }

  const payload = decodeJwtPayload(jwt);
  if (!payload || typeof payload !== "object") {
    return {};
  }

  return {
    email: cleanEmail(payload.email),
    name: cleanString(payload.name) || cleanString(payload.common_name),
  };
}

function decodeJwtPayload(jwt) {
  const parts = jwt.split(".");
  if (parts.length < 2) {
    return null;
  }

  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function cleanEmail(value) {
  const email = cleanString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}
