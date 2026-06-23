import { getAuthenticatedUser } from "../_shared/auth.js";
import { errorResponse, jsonResponse } from "../_shared/http.js";

export async function onRequestGet({ request, env }) {
  const user = getAuthenticatedUser(request, env);
  if (!user) {
    return errorResponse("Cloudflare Access identity is required.", 401);
  }
  if (!env.DB) {
    return errorResponse("D1 binding DB is not configured.", 500);
  }

  const { results } = await env.DB.prepare(
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
    WHERE lower(users.email) = lower(?1)
      AND tours.status = 'published'
    ORDER BY datetime(tours.published_at) DESC, tours.title COLLATE NOCASE ASC`,
  )
    .bind(user.email)
    .all();

  return jsonResponse({
    user: {
      email: user.email,
      name: user.name || "",
    },
    tours: (results || []).map(toApiTour).filter(Boolean),
  });
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
