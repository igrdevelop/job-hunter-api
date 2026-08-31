# Profile Page Tabs — api repo work order

Companion of the bot repo's `docs/PROFILE_PAGE_TABS_WORKORDER.md` (the decisions
and the UI/UX spec, owner-approved 2026-08-31) and an increment on top of this
repo's `docs/RESUME_PROFILE_STORE.md` (P1–P4 shipped: profiles storage, PUT →
render job, uploads → parse job, erasure). A third companion will live in
`job-hunter-site`. **The "Shared contract additions" section is duplicated from
the bot work order and must stay in sync — do not change contract details
unilaterally; flag mismatches to the user.**

## Goal

The site's `/profile` page becomes four tabs: **Uploads → Editor (default) →
Rendered files → Test resume**. Most of the REST surface already exists
(RESUME_PROFILE_STORE.md P1–P3). This work order adds what the tabs still
lack from the API:

1. the **preview** job flow (tab 4 — "what will the system actually produce
   from my profile": a generic no-vacancy CV PDF, per track, kept as a dated
   history);
2. **read endpoints** the tabs poll/list: uploads listing, rendered-files
   listing + content, preview history + PDF download, render staleness;
3. an **`isOwner` flag** on the authenticated user, so the site can gate the
   owner-only UI (tab 4 + the variant chip row) and later hide tab 3.

The bot side (`profile_jobs` kind=`preview`, the deterministic no-LLM content
build, `generate_docs --no-tracker`) is a separate bot-repo PR, in flight —
same deploy-ordering note as P2: preview jobs inserted before the bot drain
ships just sit `pending`, harmless.

## Shared contract additions (verbatim from the bot work order)

- **New `profile_jobs.kind = 'preview'`.** Payload: JSON
  `{"profile": <full profile document>, "track": "<variant key or 'core'>"}` —
  self-contained like `render` (the bot never reads app.sqlite). Result on
  `done`: JSON list of written file paths (the PDF first), under a dated
  subfolder `users/{uid}/candidate/preview/<track>/<UTC timestamp>/` — each
  preview run gets its own folder so the history list is just a directory
  listing. Terminal `error` + message otherwise. Same statuses, claim
  semantics, stale-reset and polling as the existing kinds.
- **Previews are a dated history, not an overwrite** (owner decision
  2026-08-31). No auto-prune in v1. No watermark — production layout as-is.
- The bot validates the `track` string before using it as a path component
  (slug-only); the API SHOULD reject a non-slug track at the endpoint too
  (`^[a-z][a-z0-9_]*$` or the literal `core`) so garbage never reaches the
  queue.

## REST surface additions (all JWT, user-scoped)

```
POST /api/profile/preview          body { track: "angular" | ... | "core" }
                                   → 201 { jobId }        (throttle: 10/hour)
                                     409 when the user has no stored profile
GET  /api/profile/previews         → [ { track, timestamp, files: [names] } ]
                                     newest-first; from listing
                                     users/{uid}/candidate/preview/**
GET  /api/profile/previews/:track/:ts/:file
                                   → the file (PDF etc.); 404 outside the
                                     user's own preview tree
GET  /api/profile/uploads          → [ { id, filename, sha256, uploadedAt,
                                       jobId, jobStatus } ]   (tab 1 list;
                                     POST already exists from P3)
GET  /api/profile/files            → [ { name, size, modifiedAt } ] — the
                                     rendered files in users/{uid}/candidate/
                                     (whitelist below)
GET  /api/profile/files/:name      → file content, read-only (tab 3)
```

- **`POST /api/profile/preview`** inserts a `profile_jobs` row
  (kind=`preview`, payload = `{profile: <the user's CURRENT stored profile
  json>, track}`) — the server builds the payload from the `profiles` table,
  the client sends only the track. Poll via the existing
  `GET /api/profile/jobs/:id`.
- **Rendered-files whitelist** (never a free path): `candidate.yaml`,
  `candidate_profile.md`, `base_cv_<slug>.md`, `generation_rules.local.md`,
  `profile.json`. Anything else 404s. Read-only by construction — there is no
  PUT/DELETE for these, per the one-way DB → files rule (bot plan decision #6).
- **Staleness for tab 3:** extend `GET /api/profile`'s response with
  `lastRenderJob: { id, status, updatedAt } | null` (the most recent
  kind=`render` row for the user). The site derives "profile changed since
  last render" from `updatedAt` vs the profile's own `updatedAt` — no new
  server-side computed flag.
- **`isOwner`:** expose a boolean on the authenticated-user payload the site
  already consumes (`/api/auth/me` or its equivalent). Mechanism is this
  repo's choice — recommended: compare the caller's user id against the
  configured owner id (the same identity `DEFAULT_USER_ID` names on the bot
  side) rather than inventing a roles table for one flag.

## Phases (one PR each)

### T1 — Preview flow

- `POST /api/profile/preview` (validation: slug track, stored profile exists,
  throttle 10/hour/user like uploads) + job insert.
- `GET /api/profile/previews` + the per-file download endpoint, both derived
  strictly from `UserPathsService` paths; traversal-proof (`:track`/`:ts`/
  `:file` validated as path-safe components, resolved path must stay inside
  `users/{uid}/candidate/preview/`).
- e2e: POST creates a pending row whose payload embeds the caller's own
  profile; non-slug track 400; no profile 409; cross-user job/preview access
  404 (SAAS risk #1 — tests, not discipline); a planted file outside the
  preview tree is unreachable.

### T2 — Tab read endpoints

- `GET /api/profile/uploads` (join the stored upload metadata with each
  upload's parse-job status).
- `GET /api/profile/files` + `GET /api/profile/files/:name` with the
  whitelist; `lastRenderJob` added to `GET /api/profile`.
- e2e: whitelist enforced (a `..`/absolute/off-list name 404s), cross-user
  isolation, files listing empty (not an error) for a never-rendered user.

### T3 — `isOwner` exposure

- Add the boolean to the auth payload; config knob for the owner user id if
  one does not already exist.
- e2e: owner token → `isOwner: true`; any other user → `false`.

## Risks / decisions

- **Path traversal is the whole game here** — three new endpoints serve files
  by client-supplied names. Every path is derived from `UserPathsService`,
  every component is validated before joining, and every phase lands with the
  planted-file e2e. Same discipline the bot applies on its side of the bus
  (`_resolve_user_relative_path`).
- **The preview payload is built server-side** from the stored profile, not
  accepted from the client — the client names a track, nothing more. This
  keeps the queue payload trustworthy-ish and the endpoint tiny.
- **No preview pruning in v1** (owner decision). If disk ever matters, a
  retention cap is a later bot-side or ops concern, not an API feature now.
- **Tab-visibility flags are site-side** — the API only supplies `isOwner`.
  Which tabs a flag hides (tab 4 + chips owner-only; tab 3 default ON) lives
  in the site work order.
- **Deploy ordering:** T1 may ship before the bot's `preview` drain — jobs
  sit `pending` by design. The site copy should not promise a preview "within
  a minute" until the bot side is live.

## Coordination

- Bot repo: `preview` job kind PR (in flight — adds `hunter/profile_preview.py`,
  the drain dispatch, `tools/preview_profile.py`). The DDL does not change
  (`kind` is free-text); no tracker migration needed here.
- Site repo: the site work order (tabs, chips, flags, polling UX) consumes
  this REST surface; to be written next.
- Update `CLAUDE.md` (endpoints table, work log) in the same PR as each phase.
