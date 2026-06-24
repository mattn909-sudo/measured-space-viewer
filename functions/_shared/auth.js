const ACCESS_JWT_HEADER = "Cf-Access-Jwt-Assertion";
const ACCESS_EMAIL_HEADER = "Cf-Access-Authenticated-User-Email";
const ACCESS_NAME_HEADER = "Cf-Access-Authenticated-User-Name";
const CLOCK_SKEW_SECONDS = 60;
const JWKS_CACHE_MS = 10 * 60 * 1000;

const jwksCache = new Map();

export async function getAuthenticatedUser(request, env = {}) {
  const strictJwtConfig = getStrictJwtConfig(env);
  if (strictJwtConfig) {
    const jwtUser = await getVerifiedAccessJwtUser(request, strictJwtConfig);
    if (jwtUser.email) {
      return {
        email: jwtUser.email,
        name: jwtUser.name,
        source: "cloudflare-access-jwt-verified",
      };
    }

    return getDevAuthenticatedUser(request, env);
  }

  const accessEmail = cleanEmail(request.headers.get(ACCESS_EMAIL_HEADER));
  if (accessEmail) {
    return {
      email: accessEmail,
      name: cleanString(request.headers.get(ACCESS_NAME_HEADER)),
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

  return getDevAuthenticatedUser(request, env);
}

export function isDevAuthEnabled(env = {}) {
  if (String(env.DASHBOARD_DEV_AUTH || "").toLowerCase() === "true") {
    return true;
  }
  return String(env.NODE_ENV || "production").toLowerCase() !== "production";
}

async function getVerifiedAccessJwtUser(request, config) {
  try {
    const jwt = cleanString(request.headers.get(ACCESS_JWT_HEADER));
    if (!jwt) {
      return {};
    }

    const parts = jwt.split(".");
    if (parts.length !== 3) {
      return {};
    }

    const header = decodeJwtPart(parts[0]);
    const payload = decodeJwtPart(parts[1]);
    if (!header || !payload || header.alg !== "RS256" || !cleanString(header.kid)) {
      return {};
    }

    if (!isExpectedAccessPayload(payload, config)) {
      return {};
    }

    const key = await getVerificationKey(config.certsUrl, header.kid);
    if (!key) {
      return {};
    }

    const signature = base64UrlToBytes(parts[2]);
    const data = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
    const isValid = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, data);
    if (!isValid) {
      return {};
    }

    return {
      email: cleanEmail(payload.email),
      name:
        cleanString(payload.name) ||
        cleanString(payload.common_name) ||
        cleanString(request.headers.get(ACCESS_NAME_HEADER)),
    };
  } catch {
    return {};
  }
}

function getAccessJwtUser(request) {
  const jwt = cleanString(request.headers.get(ACCESS_JWT_HEADER));
  if (!jwt) {
    return {};
  }

  const payload = decodeJwtPart(jwt.split(".")[1]);
  if (!payload || typeof payload !== "object") {
    return {};
  }

  return {
    email: cleanEmail(payload.email),
    name: cleanString(payload.name) || cleanString(payload.common_name),
  };
}

function getDevAuthenticatedUser(request, env) {
  if (!isDevAuthEnabled(env)) {
    return null;
  }

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

function getStrictJwtConfig(env) {
  const teamDomain = normalizeTeamDomain(
    cleanString(env.CLOUDFLARE_ACCESS_TEAM_DOMAIN) ||
      cleanString(env.ACCESS_TEAM_DOMAIN) ||
      cleanString(env.TEAM_DOMAIN),
  );
  const audiences = splitAudiences(
    cleanString(env.CLOUDFLARE_ACCESS_AUD) || cleanString(env.ACCESS_AUD) || cleanString(env.POLICY_AUD),
  );

  if (!teamDomain || !audiences.length) {
    return null;
  }

  return {
    audiences,
    issuer: teamDomain,
    certsUrl: `${teamDomain}/cdn-cgi/access/certs`,
  };
}

function normalizeTeamDomain(value) {
  if (!value) {
    return "";
  }
  const withProtocol = /^https?:\/\//i.test(value) ? value : `https://${value}`;
  try {
    const url = new URL(withProtocol);
    if (url.protocol !== "https:" || !url.hostname.endsWith(".cloudflareaccess.com")) {
      return "";
    }
    return url.origin;
  } catch {
    return "";
  }
}

function splitAudiences(value) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function isExpectedAccessPayload(payload, config) {
  if (payload.iss !== config.issuer) {
    return false;
  }
  if (!hasExpectedAudience(payload.aud, config.audiences)) {
    return false;
  }

  const now = Math.floor(Date.now() / 1000);
  const expiresAt = Number(payload.exp);
  const notBefore = Number(payload.nbf || 0);
  if (!Number.isFinite(expiresAt) || expiresAt < now - CLOCK_SKEW_SECONDS) {
    return false;
  }
  if (Number.isFinite(notBefore) && notBefore > now + CLOCK_SKEW_SECONDS) {
    return false;
  }

  return Boolean(cleanEmail(payload.email));
}

function hasExpectedAudience(value, expectedAudiences) {
  const tokenAudiences = Array.isArray(value) ? value : [value];
  return tokenAudiences.some((audience) => expectedAudiences.includes(cleanString(audience)));
}

async function getVerificationKey(certsUrl, kid) {
  const jwks = await getAccessJwks(certsUrl);
  const jwk = jwks.find((item) => item && item.kid === kid);
  if (!jwk) {
    return null;
  }

  return crypto.subtle.importKey(
    "jwk",
    jwk,
    {
      name: "RSASSA-PKCS1-v1_5",
      hash: "SHA-256",
    },
    false,
    ["verify"],
  );
}

async function getAccessJwks(certsUrl) {
  const cached = jwksCache.get(certsUrl);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.keys;
  }

  const response = await fetch(certsUrl, {
    headers: {
      Accept: "application/json",
    },
  });
  if (!response.ok) {
    return [];
  }

  const body = await response.json();
  const keys = Array.isArray(body.keys) ? body.keys : [];
  jwksCache.set(certsUrl, {
    keys,
    expiresAt: Date.now() + JWKS_CACHE_MS,
  });
  return keys;
}

function decodeJwtPart(value) {
  if (!value) {
    return null;
  }

  try {
    const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const json = atob(padded);
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function base64UrlToBytes(value) {
  const normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function cleanEmail(value) {
  const email = cleanString(value).toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : "";
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}
