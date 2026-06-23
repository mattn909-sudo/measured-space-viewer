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
- Cloudflare Pages Functions provide dashboard APIs under `/api/*`.
- Cloudflare D1 stores users, tours, and user-to-tour assignments.
- Cloudflare Access protects the dashboard and provides the authenticated email.
- Cloudflare R2 stores unpacked, versioned tour folders.
- `public/tours.json` remains as a local/static preview fallback.
- Assigned users open immutable tour revisions at URLs like `https://tours.example.com/tours/<slug>/<revisionId>/index.html`.

Cloud viewers do not download the original ZIP. They load the tour `index.html` and then the browser downloads only the assets requested by the measured-space runtime.

The initial privacy model is dashboard-filtered: authenticated users only see D1-assigned tours in the dashboard. Direct R2 revision URLs can still open if shared until `tours.measured-space.com` is separately protected.

## Authenticated Dashboard Setup

Create the D1 database:

```sh
npx wrangler d1 create measured-space-dashboard
```

Copy the returned `database_id` into `wrangler.toml` under the `DB` binding:

```toml
[[d1_databases]]
binding = "DB"
database_name = "measured-space-dashboard"
database_id = "..."
```

Apply migrations locally and remotely:

```sh
npm run d1:migrate:local
npm run d1:migrate:remote
```

For local Pages Functions development with D1, pass the binding explicitly if needed:

```sh
npx wrangler pages dev public --d1 DB=<database_id> \
  --binding NODE_ENV=development \
  --binding DASHBOARD_DEV_AUTH=true \
  --binding DASHBOARD_DEV_EMAIL=client@example.com
```

`npm start` serves the static viewer plus local-only `/api/me` and `/api/tours` shims backed by `public/tours.json`, so dashboard smoke tests can run without Cloudflare. In a pure static host where `/api/*` is unavailable, the browser falls back to a non-production `public/tours.json` preview while local ZIP viewing continues to work.

## Dashboard API

- `GET /api/me` returns the Cloudflare Access identity as `{ email, name, source }`.
- `GET /api/tours` returns `{ user, tours }` for tours assigned to the authenticated email.

Production API requests require Cloudflare Access identity from `Cf-Access-Authenticated-User-Email` or `Cf-Access-Jwt-Assertion`. The app does not accept a client-submitted email for authorization. Local fallback identity is only enabled when `NODE_ENV` is not `production` or `DASHBOARD_DEV_AUTH=true`.

## Dashboard Tour Operations

Import one prepared manifest entry, upsert its tour row, and assign it to a user:

```sh
npm run import-tour-to-d1 -- dist/tours/255-slade/<revisionId>.manifest-entry.json \
  --email client@example.com \
  --role viewer
```

Assign an already-imported tour to another user:

```sh
npm run assign-tour -- --tour-id 255-slade --email other@example.com --role viewer
```

List D1 dashboard tours and assignments:

```sh
npm run list-dashboard-tours
```

Add `-- --remote` to these scripts when you intend to modify the remote D1 database. The scripts use Wrangler and do not require R2 credentials. They update D1 metadata only; they do not upload files or overwrite immutable R2 revision folders.

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
2. Add the D1 `DB` binding to the Pages project or keep the `wrangler.toml` binding in sync.
3. Protect the dashboard hostname with Cloudflare Access.
4. Add the R2 bucket and bind a production custom domain such as `tours.example.com`.
5. Configure a Cloudflare Cache Rule for `tours.example.com/tours/*` to cache static tour HTML/assets.
6. Keep `public/tours.json` short-cache using `public/_headers`.
7. Publish new revisions instead of overwriting existing paths.

## Cloudflare Access Setup

Create a Cloudflare Access self-hosted application for the dashboard hostname, for example `dashboard.measured-space.com`.

Recommended policy shape:

- Include: the specific client emails, email domains, or identity-provider groups that should be allowed to sign in.
- Require: any organization requirements such as MFA or IdP group membership.
- Exclude: users or groups that should never access the dashboard.

Do not add a custom password login to this app. Cloudflare Access should handle sign-in, session cookies, and identity. After Access authenticates a request, Pages Functions read the user from `Cf-Access-Authenticated-User-Email` when present, or from the `Cf-Access-Jwt-Assertion` JWT payload. Browsers may also carry the `CF_Authorization` cookie as part of the Access session.

For a stricter origin-auth posture, add full JWT signature verification in the Pages Function using your Access team domain and the application AUD tag. The current implementation assumes the dashboard hostname is protected by Access and rejects production requests that do not include Access identity.

## Private Direct Tour URLs

Direct R2 URLs remain public in the initial dashboard-filtered privacy model. To make `https://tours.measured-space.com/tours/<slug>/<revisionId>/index.html` private too, use one of these approaches.

### Option 1: Put `tours.measured-space.com` Behind Cloudflare Access

This is the simplest operational model. Access protects the R2 custom domain, and authenticated users can load `index.html` plus the measured-space runtime assets under the same hostname.

Risks:

- Users allowed into Access for the tour hostname may be able to open any direct tour URL unless Access policies are split per client or paired with a more granular proxy.
- Measured-space loads many files dynamically, so Access must allow every relative asset request under the revision path, not only `index.html`.

Caching impact: Cloudflare can still cache static assets, but Access adds authorization checks and may reduce shared-cache effectiveness depending on policy/session behavior.

### Option 2: Serve R2 Through An Authorization Proxy

A Worker or Pages Function can check the Access email, look up the D1 assignment, and stream R2 objects only when the user is assigned to that tour.

Recommendation: this is the strongest fit when per-user or per-client tour privacy is required. It keeps D1 as the authorization source of truth and can preserve relative asset loading by proxying the full revision prefix, for example `/tours/<slug>/<revisionId>/<path>`.

Risks:

- Higher implementation complexity.
- The proxy must correctly map every static asset request, including images, point clouds, scripts, fonts, and media loaded after `index.html`.
- Large assets need streaming responses and careful cache headers.

Caching impact: public shared caching is harder because authorization varies by user. Cache immutable objects at the edge only when the cache key and authorization model cannot leak assets across users.

### Option 3: Signed URLs Or Signed Cookies

The dashboard can mint short-lived access to a revision path after checking D1 assignments.

Risks:

- The measured-space runtime requests many relative assets, so a signed `index.html` URL alone is not enough.
- Signed cookies are more practical than signing every dynamic asset URL, but they need tight expiry, path scoping, and revocation behavior.

Caching impact: immutable assets can cache well if signatures are cookie-based and edge rules are designed carefully; URL signatures can fragment cache keys.

Migration path:

1. Keep publishing immutable R2 revision folders exactly as today.
2. Add an authorized hostname or proxy path in parallel with the current public R2 URLs.
3. Update D1 `index_url` and `asset_base_url` for newly assigned dashboard entries to point at the protected path.
4. Test full tour loading, including dynamically requested assets.
5. Retire public direct links after clients have moved to the dashboard.

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
