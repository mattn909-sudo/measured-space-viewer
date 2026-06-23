# Measured Space Dashboard Agent Prompts

Use these prompts to continue the product from the current production-ready static viewer into an authenticated dashboard where users only see tours assigned to them.

## Current State

- Static app is served from `public/`.
- `src/app.js` builds to `public/app.js`.
- Local ZIP viewing works in-browser with `@zip.js/zip.js`, Cache Storage, and `public/service-worker.js`.
- Cloud tour catalog reads `public/tours.json`.
- Tours are unpacked and published immutably to Cloudflare R2 under paths like:
  `https://tours.measured-space.com/tours/<slug>/<revisionId>/index.html`
- Cloudflare Pages should deploy the viewer shell from `public/`.
- R2 stores tour files; do not serve original ZIPs to viewers.

## Target Architecture

- Cloudflare Pages hosts the dashboard UI.
- Cloudflare Pages Functions provide APIs under `/api/*`.
- Cloudflare D1 stores users, tours, and user-to-tour assignments.
- Cloudflare Access protects the dashboard and provides user identity.
- R2 continues to host immutable tour revision files.

Initial privacy level: dashboard-filtered access. Users only see assigned tours in the dashboard, but direct R2 URLs may still open if shared. A later phase can protect direct R2 URLs with Cloudflare Access or a Worker proxy if required.

## Primary Agent Prompt

```text
You are working in the existing measured-space-viewer repository.

Goal: turn the existing Cloudflare Pages static tour viewer into an authenticated Cloudflare dashboard where a logged-in user sees only tours assigned to their email.

Keep existing behavior:
- Local ZIP mode must keep working.
- R2 immutable tour publishing scripts must keep working.
- Public cloud catalog support may remain as a fallback, but dashboard mode should use `/api/tours`.

Implement conservatively using Cloudflare-native primitives:
- Cloudflare Pages Functions for backend APIs.
- Cloudflare D1 for relational data.
- Cloudflare Access identity from request headers/JWT for authentication.
- No custom password system.

Deliver:
1. D1 SQL migrations for users, tours, user_tours, and useful indexes.
2. `wrangler.toml` updates for D1 binding named `DB`.
3. Pages Functions:
   - `/api/me`
   - `/api/tours`
   - `/api/admin/import-tour` or a CLI script for importing manifest entries and assigning users.
4. Frontend dashboard states:
   - signed-in user label
   - assigned tour cards
   - empty state
   - API loading/error states
   - preserve local ZIP section
5. Scripts:
   - create/apply D1 migrations
   - seed/import a tour manifest
   - assign a tour to a user email
6. README instructions for Cloudflare Access, D1 creation, migrations, and deployment.
7. Checks must pass.

Security:
- Do not trust client-provided email.
- Use identity from Cloudflare Access headers/JWT.
- Do not use `innerHTML` with API/catalog data.
- Validate all tour URLs as http/https.
- Do not commit secrets.

Acceptance criteria:
- `npm run check` passes.
- Local ZIP workflow still works.
- `/api/me` returns the authenticated user identity.
- `/api/tours` returns only tours assigned to the authenticated user.
- Dashboard renders assigned tours safely.
- Unassigned users see an empty state.
- Admin/import scripts do not overwrite immutable published R2 revision paths.
```

## Phase 1 Prompt: D1 Schema And Local APIs

```text
Implement Cloudflare D1 schema and read-only dashboard APIs.

Add migrations:
- users table keyed by id, unique email.
- tours table keyed by id, with slug, revision_id, title, address, description, cover_image, index_url, asset_base_url, published_at, status, size_bytes, file_count.
- user_tours join table with user_id, tour_id, role, created_at.
- indexes for email, tour status, and user_tours lookup.

Add Pages Functions:
- functions/api/me.js
- functions/api/tours.js

For now, support local development identity fallback only when `NODE_ENV !== "production"` or an explicit dev env flag is present. In production, require Cloudflare Access identity.

Update README with:
- `npx wrangler d1 create measured-space-dashboard`
- migration apply commands
- D1 binding setup

Run syntax/build checks.
```

## Phase 2 Prompt: Dashboard UI

```text
Update the frontend so the Cloud tours section becomes a signed-in dashboard.

Behavior:
- Load `/api/me` first and show the user email.
- Load `/api/tours` and render only assigned tours.
- Preserve current local ZIP workflow unchanged.
- If APIs are unavailable in local static mode, fall back to `./tours.json` with a clear non-production status message.

Design:
- Operational dashboard, not a marketing page.
- Dense, clear cards for tours.
- Buttons for Open tour and Copy link.
- Loading, error, and empty states.
- No `innerHTML` for API data.

Run checks and local smoke test.
```

## Phase 3 Prompt: Import And Assignment Tooling

```text
Add CLI scripts for D1-backed tour operations.

Scripts:
- `scripts/import-tour-to-d1.mjs <manifest-entry.json> --email client@example.com`
- `scripts/assign-tour.mjs --tour-id 255-slade --email client@example.com --role viewer`
- `scripts/list-dashboard-tours.mjs`

Use Wrangler D1 commands or Cloudflare D1 HTTP APIs without committing secrets.

Requirements:
- Import validates manifest entries like `validate-tour-catalog`.
- Upsert users by lowercase email.
- Upsert tours by id/slug/revision_id.
- Assignments are idempotent.
- Print exact commands and results.

Update package scripts and README.
```

## Phase 4 Prompt: Cloudflare Access Setup

```text
Document and wire Cloudflare Access for the dashboard.

Goal:
- Protect `dashboard.measured-space.com`.
- Allow specific client emails or groups.
- Pages Functions should derive identity from Cloudflare Access, not client input.

Deliver:
- README section for creating the Access application.
- Required Access policy examples.
- Notes on `Cf-Access-Jwt-Assertion` and `CF_Authorization`.
- Clear local development fallback instructions.

Do not add a custom password login.
```

## Phase 5 Prompt: Private Direct Tour URLs

```text
Design, but do not implement unless asked, a stronger privacy model where direct R2 tour URLs require authorization.

Compare:
1. Put `tours.measured-space.com` behind Cloudflare Access.
2. Serve R2 through a Worker/Pages Function proxy that checks D1 assignments.
3. Use signed URLs/cookies for temporary access.

Account for measured-space runtime behavior:
- It loads many static assets from index.html.
- It may request images, point clouds, scripts, fonts, and media dynamically.
- Authorization must not break relative asset loading.

Deliver:
- Recommendation
- Risks
- Migration path from public R2 revision URLs
- Caching impact
```

## Manual QA Prompt

```text
Run a complete QA pass:

1. Start the local server.
2. Confirm dashboard loads.
3. Confirm cloud tour cards render.
4. Confirm Open tour opens a new tab.
5. Confirm Copy link works.
6. Confirm local ZIP upload still opens via service worker.
7. Confirm invalid catalog/API data is ignored or shown as safe errors.
8. Confirm no console errors on initial load.
9. Run `npm run check`.
10. Summarize any remaining production blockers.
```
