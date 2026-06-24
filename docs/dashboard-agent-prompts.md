# Measured Space Dashboard Agent Prompts

Use these prompts to continue the product from the current production-ready static viewer into a fully deployed authenticated dashboard where users only see tours assigned to them. When the user asks for production, do the Cloudflare setup end to end instead of stopping at design notes.

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

Production privacy level: dashboard and direct tour access should both be protected for client launches. Users only see assigned tours in the dashboard, and production direct tour URLs should not be left publicly reachable if the user asks for end-to-end production.

## Primary Agent Prompt

```text
You are working in the existing measured-space-viewer repository.

Goal: turn the existing Cloudflare Pages static tour viewer into a production-deployed authenticated Cloudflare dashboard where a logged-in user sees only tours assigned to their email.

Keep existing behavior:
- Local ZIP mode must keep working.
- R2 immutable tour publishing scripts must keep working.
- Public cloud catalog support may remain as a fallback, but dashboard mode should use `/api/tours`.

Implement conservatively using Cloudflare-native primitives:
- Cloudflare Pages Functions for backend APIs.
- Cloudflare D1 for relational data.
- Cloudflare Access identity from request headers/JWT for authentication.
- Cloudflare R2 for immutable tour files.
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
6. Cloudflare production setup:
   - Pages project deployed from `public/`.
   - `dashboard.measured-space.com` attached to Pages and protected by Cloudflare Access.
   - D1 database created, remotely migrated, and bound as `DB`.
   - Access application created with explicit allowed client emails/groups and no custom password login.
   - Pages production variables configured for Access JWT verification.
   - R2 bucket/custom domain configured for immutable tour revisions.
   - Remote D1 tour imports and assignments completed for the production clients.
7. README instructions for Cloudflare Access, D1 creation, migrations, deployment, and production verification.
8. Checks must pass.

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
- `dashboard.measured-space.com` is protected by Cloudflare Access in production.
- Production Pages Functions reject requests without Access identity.
- Production D1 contains the expected tour rows and user assignments.
- Published R2 tour revision URLs load for authorized users.
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

## Phase 5 Prompt: End-To-End Production Launch

```text
Complete the end-to-end Cloudflare production launch now. Do not stop at documentation unless account access, DNS ownership, or required secrets are missing. If a blocker requires the user, ask for the exact missing item and continue everything else that can be completed safely.

Production goals:
- `dashboard.measured-space.com` serves the dashboard from Cloudflare Pages.
- `dashboard.measured-space.com` is protected by Cloudflare Access.
- Access allows only specific client emails, email domains, or identity-provider groups.
- `/api/me` and `/api/tours` derive identity from Cloudflare Access, never client input.
- Remote D1 stores production users, tours, and user_tours assignments.
- Assigned users see only their assigned tours.
- R2 continues to publish immutable tour revisions.
- Direct production tour URLs are protected for client launch.

Preflight:
1. Inspect the current auth implementation, Pages Functions, README, wrangler.toml, local fallback behavior, D1 scripts, R2 publishing scripts, and current git status.
2. Confirm `npm run check` passes before production changes when possible.
3. Run `npx wrangler whoami` and identify the Cloudflare account available in this environment.
4. Do not commit secrets. Use environment variables, Wrangler secrets, Cloudflare Pages variables, or the Cloudflare dashboard/API.
5. Preserve the existing dashboard UI, D1 import/assignment scripts, local/non-production fallback behavior, and immutable R2 publishing workflow.

Deliver:
1. Cloudflare Pages:
   - Create or link the Pages project.
   - Deploy `public/`.
   - Attach `dashboard.measured-space.com`.
   - Confirm `/api/me` and `/api/tours` are served by Pages Functions.
2. D1:
   - Create `measured-space-dashboard` if it does not exist.
   - Update `wrangler.toml` with the real `database_id` if needed.
   - Apply remote migrations.
   - Verify `users`, `tours`, and `user_tours` exist remotely.
3. Cloudflare Access:
   - Create a self-hosted Access application for `dashboard.measured-space.com/*`.
   - Add Allow policies for the requested client emails/groups.
   - Add organization requirements such as MFA when available.
   - Do not add a custom password login.
   - Capture the Access application AUD tag and team domain.
   - Configure Pages production variables:
     - `CLOUDFLARE_ACCESS_TEAM_DOMAIN`
     - `CLOUDFLARE_ACCESS_AUD`
   - Verify unauthenticated production requests to `/api/me` and `/api/tours` return `401` or are intercepted by Access.
4. Tours and assignments:
   - Publish prepared tour revisions to R2 only under new immutable revision paths.
   - Do not overwrite existing R2 revision paths.
   - Import production manifest entries into remote D1.
   - Assign tours to lowercase client emails.
   - Verify `npm run list-dashboard-tours -- --remote`.
5. Direct tour URL protection:
   - Protect `tours.measured-space.com` for launch using the lowest-risk approach that preserves measured-space asset loading.
   - Prefer Cloudflare Access on the R2 custom domain if all authorized dashboard users may load the protected tour domain.
   - If per-user/per-tour authorization is required immediately, implement or wire a Worker/Pages proxy that checks Access identity and D1 assignment before streaming R2 objects.
   - Test a real tour `index.html` plus dynamic assets such as images, point clouds, scripts, fonts, and media.
6. Verification:
   - `npm run check`.
   - Production `/api/me` rejects unauthenticated requests.
   - Production `/api/tours` rejects unauthenticated requests.
   - Authenticated allowed user sees only assigned tours.
   - Unassigned allowed user sees an empty dashboard.
   - Direct production tour URLs are not public.
   - Local development fallback still works only outside production or with explicit dev auth enabled.
   - No secrets are present in git diff.

Final report:
- List every Cloudflare resource created or updated.
- List domains, Pages project, D1 database, R2 bucket/custom domain, Access apps/policies, and Pages variables configured.
- Include exact verification commands and outcomes.
- Clearly state any blocker that prevented full production completion.
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
