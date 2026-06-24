# Measured Space Dashboard

Authenticated dashboard for opening assigned Measured Space virtual tours from immutable cloud-hosted tour revisions.

## Dashboard App

The dashboard loads the signed-in user from `/api/me`, fetches assigned tours from `/api/tours`, and renders a dense operational workspace with tour actions and a property map. The local ZIP viewer has been removed from the browser app; ZIP exports are still handled by the publishing scripts before immutable R2 upload.

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

`npm start` serves the static dashboard plus local-only `/api/me` and `/api/tours` shims backed by `public/tours.json`, so dashboard smoke tests can run without Cloudflare. The shim only creates a development identity when `NODE_ENV` is not `production` or `DASHBOARD_DEV_AUTH=true`; set `DASHBOARD_DEV_EMAIL` and `DASHBOARD_DEV_NAME` to preview a specific user. In a pure static host where `/api/*` is unavailable, the browser falls back to a non-production `public/tours.json` preview.

## Dashboard Map

The map uses Leaflet with OpenStreetMap tiles and geocodes tour addresses with the public Nominatim API when a tour does not already include coordinates. Geocoded results are cached in `localStorage` and requests are queued at roughly one request per second for light, policy-friendly local/dashboard use.

For production scale, prefer storing latitude/longitude in D1 during import so the dashboard does not need to geocode on every new browser profile.

## Dashboard API

- `GET /api/me` returns the Cloudflare Access identity as `{ email, name, source }`.
- `GET /api/tours` returns `{ user, tours }` for tours assigned to the authenticated email.

Production API requests require Cloudflare Access identity from `Cf-Access-Authenticated-User-Email` or `Cf-Access-Jwt-Assertion`. The app does not accept a client-submitted email for authorization. If `CLOUDFLARE_ACCESS_TEAM_DOMAIN` and `CLOUDFLARE_ACCESS_AUD` are configured, Pages Functions verify the signed Access JWT before using its email claim. Local fallback identity is only enabled when `NODE_ENV` is not `production` or `DASHBOARD_DEV_AUTH=true`.

## Dashboard Tour Operations

The D1 operation scripts default to local D1 (`--local`). Pass `--remote` only when you intend to modify the Cloudflare-hosted database. Each script prints the exact `npx wrangler d1 execute ...` command it runs plus Wrangler output/result tables. These scripts update D1 metadata only; they do not require R2 credentials, upload files, or overwrite immutable R2 revision folders.

Import one prepared manifest entry, upsert its tour row, and assign it to a lowercase user email:

```sh
npm run import-tour-to-d1 -- dist/tours/255-slade/<revisionId>.manifest-entry.json \
  --email client@example.com \
  --role viewer
```

The import uses the same production-safety checks as `npm run validate-catalog`: `published` status, required IDs/title/revision, valid `http`/`https` URLs, `index.html` URLs under `assetBaseUrl`, no ZIP URLs, no `r2.dev`, and no placeholder `example.com` domains unless you explicitly pass `--allow-example` for local sample data. Tours are matched by `id` or by the existing `slug` + `revisionId` row before upsert.

Assign an already-imported tour to another user:

```sh
npm run assign-tour -- --tour-id 255-slade --email other@example.com --role viewer
```

List D1 dashboard tours and assignments:

```sh
npm run list-dashboard-tours
```

Remote examples:

```sh
npm run import-tour-to-d1 -- dist/tours/255-slade/<revisionId>.manifest-entry.json \
  --email client@example.com \
  --role viewer \
  --remote

npm run assign-tour -- --tour-id 255-slade --email other@example.com --role viewer --remote
npm run list-dashboard-tours -- --remote
```

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

Create a Cloudflare Access self-hosted application for the dashboard hostname before exposing production data.

1. In Cloudflare Zero Trust, open **Access > Applications** and add a **Self-hosted** application.
2. Name it `Measured Space Dashboard`.
3. Set the application domain to `dashboard.measured-space.com` and protect all paths, including `/api/*`.
4. Choose the identity provider clients should use.
5. Add at least one Allow policy for the client emails or identity-provider groups that should see the dashboard.
6. Copy the application's AUD tag from the Access application details.
7. In the Cloudflare Pages project, add these production variables to enable JWT verification in the Functions:

```text
CLOUDFLARE_ACCESS_TEAM_DOMAIN=https://<team-name>.cloudflareaccess.com
CLOUDFLARE_ACCESS_AUD=<Access application AUD tag>
```

These values are not application passwords, but keep them in Cloudflare Pages environment variables so deployment config stays environment-specific. Do not commit service tokens, API tokens, IdP secrets, or client-specific private notes.

Required policy examples:

- Client email allowlist: Action `Allow`; Include `Emails` with `client@example.com` and `owner@example.com`; Require your organization MFA or approved IdP; Exclude former users who should never access the dashboard.
- Client company group: Action `Allow`; Include an IdP group such as `Measured Space - Client A`; Require email domain `client-a.example`; Exclude suspended or offboarded groups.
- Internal operator access: Action `Allow`; Include a small internal admin group; Require stronger posture such as MFA, managed device, or your IdP's high-assurance group.

Keep Access policy membership and D1 tour assignment separate. Access decides who can reach `dashboard.measured-space.com`; D1 decides which authenticated email can see each tour inside the dashboard.

Do not add a custom password login to this app. Cloudflare Access handles sign-in, session cookies, and identity. After Access authenticates a request, Pages Functions read the user from the signed `Cf-Access-Jwt-Assertion` JWT when verification variables are configured, then fall back to `Cf-Access-Authenticated-User-Email` for simpler Access-protected deployments. Browsers may also carry the `CF_Authorization` cookie as part of the Access session, but the Functions do not use that cookie as client input for authorization. Cloudflare recommends validating the `Cf-Access-Jwt-Assertion` header because the cookie is browser/session transport and is not guaranteed on every request.

Local development fallback:

- `npm start` uses the local Express shim. With the default non-production `NODE_ENV`, `/api/me` returns `DASHBOARD_DEV_EMAIL` or `dev@example.com`, and `/api/tours` returns local preview data unless `DASHBOARD_REMOTE_D1=true` is set.
- `npx wrangler pages dev` should be run with `--binding NODE_ENV=development` and, when needed, `--binding DASHBOARD_DEV_AUTH=true --binding DASHBOARD_DEV_EMAIL=client@example.com`.
- `X-Dev-User-Email` is only honored when development auth is enabled. A production request with only that header is rejected.
- Do not set `DASHBOARD_DEV_AUTH=true` in the production Pages environment. Missing or invalid Access identity returns `401` from `/api/me` and `/api/tours`.

References: Cloudflare documents the [Access application token](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/) and the [JWT validation flow](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/) for the `Cf-Access-Jwt-Assertion` header and `CF_Authorization` cookie.

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
- Map is empty: confirm tours have full addresses, or add latitude/longitude during D1 import.
- Production deploy fails on catalog validation: replace placeholder domains and rerun `npm run production-check`.
