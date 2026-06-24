export function validateCatalog(catalog, { allowExample = false } = {}) {
  if (!Array.isArray(catalog)) {
    return ["Catalog must be a JSON array."];
  }

  const errors = [];
  const ids = new Set();
  const slugs = new Set();

  catalog.forEach((rawEntry, index) => {
    const { entry, errors: entryErrors } = validateCatalogEntry(rawEntry, {
      allowExample,
      label: `entry ${index}`,
    });
    errors.push(...entryErrors);

    if (!entry) {
      return;
    }
    if (ids.has(entry.id)) {
      errors.push(`entry ${index}: duplicate id "${entry.id}".`);
    }
    if (slugs.has(entry.slug)) {
      errors.push(`entry ${index}: duplicate slug "${entry.slug}".`);
    }
    ids.add(entry.id);
    slugs.add(entry.slug);
  });

  return errors;
}

export function validateCatalogEntry(rawEntry, { allowExample = false, label = "entry" } = {}) {
  const errors = [];
  if (!rawEntry || typeof rawEntry !== "object") {
    return {
      entry: null,
      errors: [`${label}: must be an object.`],
    };
  }

  const id = cleanString(rawEntry.id);
  const slug = cleanString(rawEntry.slug);
  const revisionId = cleanString(rawEntry.revisionId);
  const title = cleanString(rawEntry.title);
  const address = cleanString(rawEntry.address);
  const description = cleanString(rawEntry.description);
  const indexUrl = parseHttpUrl(rawEntry.indexUrl);
  const assetBaseUrl = parseHttpUrl(rawEntry.assetBaseUrl);
  const coverImage = cleanString(rawEntry.coverImage) ? parseHttpUrl(rawEntry.coverImage) : null;
  const publishedAt = cleanString(rawEntry.publishedAt);
  const sizeBytes = Number(rawEntry.sizeBytes);
  const fileCount = Number(rawEntry.fileCount);

  if (rawEntry.status !== "published") {
    errors.push(`${label}: status must be "published".`);
  }
  if (!id) errors.push(`${label}: id is required.`);
  if (!slug) errors.push(`${label}: slug is required.`);
  if (!revisionId) errors.push(`${label}: revisionId is required.`);
  if (!title) errors.push(`${label}: title is required.`);
  if (!indexUrl) errors.push(`${label}: indexUrl must be a valid http/https URL.`);
  if (!assetBaseUrl) errors.push(`${label}: assetBaseUrl must be a valid http/https URL.`);
  if (cleanString(rawEntry.coverImage) && !coverImage) {
    errors.push(`${label}: coverImage must be a valid http/https URL when provided.`);
  }
  if (!publishedAt || Number.isNaN(new Date(publishedAt).getTime())) {
    errors.push(`${label}: publishedAt must be an ISO-compatible date.`);
  }
  if (!Number.isFinite(sizeBytes) || sizeBytes < 0) {
    errors.push(`${label}: sizeBytes must be a non-negative number.`);
  }
  if (!Number.isFinite(fileCount) || fileCount < 0) {
    errors.push(`${label}: fileCount must be a non-negative number.`);
  }

  if (indexUrl && !indexUrl.pathname.endsWith("/index.html")) {
    errors.push(`${label}: indexUrl should point to an index.html file.`);
  }
  if (indexUrl && assetBaseUrl && !indexUrl.href.startsWith(assetBaseUrl.href)) {
    errors.push(`${label}: indexUrl must live under assetBaseUrl.`);
  }

  const checkedUrls = [indexUrl, assetBaseUrl, coverImage].filter(Boolean);
  for (const url of checkedUrls) {
    if (!allowExample && /(^|\.)example\.com$/i.test(url.hostname)) {
      errors.push(`${label}: replace placeholder domain ${url.hostname}.`);
    }
    if (/r2\.dev$/i.test(url.hostname)) {
      errors.push(`${label}: use an R2 custom domain instead of r2.dev.`);
    }
    if (/\.zip(?:$|[?#])/i.test(url.href)) {
      errors.push(`${label}: public catalog must not point at ZIP files.`);
    }
  }

  if (errors.length) {
    return { entry: null, errors };
  }

  return {
    entry: {
      id,
      slug,
      revisionId,
      title,
      address,
      description,
      coverImage: coverImage ? coverImage.href : "",
      indexUrl: indexUrl.href,
      assetBaseUrl: assetBaseUrl.href,
      publishedAt,
      status: "published",
      sizeBytes: Math.round(sizeBytes),
      fileCount: Math.round(fileCount),
    },
    errors,
  };
}

function cleanString(value) {
  return typeof value === "string" ? value.trim() : "";
}

function parseHttpUrl(value) {
  const rawValue = cleanString(value);
  if (!rawValue) {
    return null;
  }
  try {
    const url = new URL(rawValue);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}
