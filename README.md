# Measured Space Viewer

Static viewer shell for opening Measured Space virtual tours either from a local ZIP or from immutable cloud-hosted tour revisions.

## Local ZIP Viewing

Local ZIP mode runs entirely in the browser. Choose or drop a tour ZIP, and the app unpacks the files on the user's machine with `@zip.js/zip.js`. The unpacked files are stored in browser Cache Storage and served back through `public/service-worker.js` from `/__tours/...`.

The ZIP is not uploaded to this app or to a backend service. Local mode is useful for private review, field QA, and inspecting exports before publishing them.

```sh
npm install
npm run build
npm start
```

## Cloud-Hosted Tours Architecture

Production cloud mode separates the viewer shell from tour storage:

- Cloudflare Pages hosts this static app.
- Cloudflare R2 stores unpacked, versioned tour folders.
- `public/tours.json` is the short-cache public catalog shown by the viewer shell.
- Public users open immutable tour revisions at URLs like `https://tours.example.com/tours/<slug>/<revisionId>/index.html`.

Cloud viewers do not download the original ZIP. They load the tour `index.html` and then the browser downloads only the assets requested by the measured-space runtime.

## Where Large Tours Live

Large tours live unpacked in R2 under versioned paths such as:

```text
tours/214-vannorden/20260622T153000Z-a1b2c3d4e5f6/
```

Do not overwrite a published revision path. To update a tour, prepare and publish a new revision, then rebuild and deploy `public/tours.json` so the catalog points at the new immutable URL.

## Latency And Caching Strategy

`tours.json` should be short-cache/revalidate-friendly because it changes when a tour is promoted or rolled back. The viewer shell JS/CSS can use a moderate TTL until filenames are content-hashed.

Versioned R2 tour files should use:

```text
Cache-Control: public, max-age=31536000, immutable
```

Use a Cloudflare R2 custom domain, not `r2.dev`. Configure a Cloudflare Cache Rule for `tours.example.com/tours/*` to cache static HTML and assets, including static tour `index.html`. The first viewer in a region may hit R2 on cache miss; later viewers should be served from Cloudflare cache.

Browser cache is usually disk-backed. RAM and GPU memory are used by active decoded images, textures, models, and video buffers. A 1 GB cloud-hosted tour should not mean 1 GB is loaded into RAM on page open. Actual memory depends on the measured-space viewer runtime's preload and lazy-load behavior.

## Preparing A Tour

Prepare a ZIP by finding the viewer root (`index.html` beside `html_assets/`), unpacking it into `dist/tours/<slug>/<revisionId>/`, and writing a manifest entry beside the revision folder.

```sh
npm run prepare-tour -- ./path/to/tour.zip \
  --slug 214-vannorden \
  --title "214 Vannorden Tour" \
  --address "214 Vannorden Street" \
  --base-url "https://tours.example.com"
```

The script skips `__MACOSX`, `.DS_Store`, and `._*`, preserves relative paths, prints large-tour warnings, and requires `--allow-large-file` if any extracted file exceeds 512 MB.

## Building The Public Catalog

Build `public/tours.json` from prepared manifest entries:

```sh
npm run build-tour-catalog -- dist/tours --out public/tours.json
```

Invalid entries are skipped. Duplicate slugs keep the newest `publishedAt`, and the output is sorted newest first.

## Publishing To Cloudflare R2

Publish the immutable prepared folder to R2 with S3-compatible credentials stored only in environment variables:

```sh
R2_ACCOUNT_ID=... \
R2_ACCESS_KEY_ID=... \
R2_SECRET_ACCESS_KEY=... \
R2_BUCKET=... \
R2_PUBLIC_BASE_URL=https://tours.example.com \
npm run publish-tour-r2 -- dist/tours/214-vannorden/<revisionId> \
  --prefix tours/214-vannorden/<revisionId> \
  --dry-run
```

Remove `--dry-run` to upload. Never commit secrets. Versioned tour files are uploaded with long immutable cache headers.

## Cloudflare Production Setup

1. Deploy this repository to Cloudflare Pages.
2. Add the R2 bucket and bind a production custom domain such as `tours.example.com`.
3. Configure a Cloudflare Cache Rule for `tours.example.com/tours/*` to cache static tour HTML/assets.
4. Keep `public/tours.json` short-cache using `public/_headers`.
5. Publish new revisions instead of overwriting existing paths.

## Production Launch Checklist

- Replace every `tours.example.com` placeholder in `public/tours.json` with the real R2 custom domain.
- Add Cloudflare Pages secrets in GitHub Actions:
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_PAGES_PROJECT`
- Add R2 upload secrets locally or in a secure CI environment:
  - `R2_ACCOUNT_ID`
  - `R2_ACCESS_KEY_ID`
  - `R2_SECRET_ACCESS_KEY`
  - `R2_BUCKET`
  - `R2_PUBLIC_BASE_URL`
- Run `npm run production-check` before deploying. CI allows the sample `example.com` catalog, but production deploy does not.
- Confirm the R2 domain is a custom domain and not `r2.dev`.
- Confirm a Cloudflare Cache Rule caches `tours.example.com/tours/*`, including static tour `index.html`.

## One-Command Tour Release

For a full release candidate, use:

```sh
npm run release-tour -- ./path/to/tour.zip \
  --slug 214-vannorden \
  --title "214 Vannorden Tour" \
  --address "214 Vannorden Street" \
  --base-url "https://tours.example.com" \
  --dry-run
```

The release script prepares the immutable revision, optionally publishes it to R2, rebuilds `public/tours.json`, validates the catalog, and smoke-tests the hosted URL after a real upload. Remove `--dry-run` after reviewing the upload plan. Use `--skip-upload` when you only want to prepare a revision and rebuild the catalog.

## Cloudflare Pages Deployment

`wrangler.toml` points Cloudflare Pages at the `public` build output. The GitHub Actions workflow at `.github/workflows/deploy-cloudflare-pages.yml` runs checks and deploys with:

```sh
npx wrangler pages deploy public --project-name "$CLOUDFLARE_PAGES_PROJECT"
```

The workflow intentionally runs `npm run production-check` without `--allow-example`, so placeholder catalog URLs block production deployment.

## Hosted Tour Smoke Test

Check a hosted `index.html` after publishing:

```sh
npm run check-hosted-tour -- https://tours.example.com/tours/<slug>/<revisionId>/index.html
```

The script reports status, content type, cache-control, response size, warns if the HTML references a ZIP, and warns about unusually large referenced assets when `Content-Length` is available.

## Rollback Strategy

Rollback is a catalog change. Keep old immutable R2 revision folders in place, update `public/tours.json` to point the slug back to the previous revision, rebuild the app shell if needed, and redeploy Cloudflare Pages. Because revision folders are immutable and long-cacheable, rollback does not require deleting cached assets.

## Troubleshooting

- Cloud catalog is empty: confirm `public/tours.json` is valid JSON and entries have `status: "published"`, `id`, `slug`, `title`, and an `http` or `https` `indexUrl`.
- Cloud tour does not open: run `npm run check-hosted-tour -- <index-url>` and confirm the R2 custom domain is reachable.
- Updates do not appear: `tours.json` may still be inside its short cache window. Purge or wait for revalidation.
- Assets are stale: do not overwrite revision folders. Publish a new revision and update `tours.json`.
- Local ZIP fails: confirm the ZIP contains `index.html` beside `html_assets/`, and that browser storage has enough free disk space.
- Production deploy fails on catalog validation: replace placeholder domains and rerun `npm run production-check`.
