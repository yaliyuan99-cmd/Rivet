# Building Rivet

How this codebase is put together and the rules every page and route follows. The spec is the Figma file `Untitled` (fileKey `NiSg6a7Cm51Q7DriS7JNda`). Its frames are saved as exact text dumps in `docs/figma/frames/`, one per screen.

## Reading a frame dump

`docs/figma/frames/<nn>-<flow>-<screen>-desktop-light.txt`, for example `02-evaluation-results-desktop-light.txt`:

- `F name @x,y WxH fill=… stroke=…:w r=… Hgap/Vgap=… pad=t,r,b,l` is a frame.
- `T @x,y WxH "text"[Mono? Style size lhN% lsN colour]` is text. **The quoted text is the real copy. Use it verbatim.**
- Mobile layouts for every screen follow the same rules as `02-evaluation-results-mobile-light.txt`, `01-access-signup-mobile-light.txt` and `11-admin-checks-mobile-light.txt`. The kit already implements them.
- `ui-kit-light.txt` is the component sheet; `tokens.txt` and `styles.txt` hold tokens and type.

### What is a design annotation, not product copy

- Drop `/ DESKTOP` and `/ MOBILE` from eyebrows. `"02 EVALUATION / DESKTOP"` becomes `eyebrow="02 Evaluation"`.
- `/ LIGHT` in the app bar is the working theme toggle (the shell does this).
- `⌑ ACTION UNAVAILABLE` is `<RailUnavailable>`.
- `▾` after a value means the field is a select; `☑` means a real checkbox.
- `SHA-256 8a2f0c9e…` and similar samples are placeholders for real computed values.

### Where sample values become real data

The frames tell one fictional story (Maya Chen, Dr. Samira Patel, Alex Rivera, Helix Lab, BIO-042). Keep each sentence's wording, but fill names, codes, counts, times and hashes from the database, so the seeded story reads exactly like the frames and a brand-new user's data reads naturally. **Never hard-code a story value into a page.** "Aster 86/100" comes from a row, not from JSX.

Keep `SYNTHETIC DEMO` and `demo` score labels on anything synthetic. Do not invent customer claims, partnerships, earnings figures or traction.

## Layout of the code

```
server/
  index.ts            boot: migrate, seed, engine, serve API and dist/
  app.ts              composes routes; error handling, CSRF, session loading
  context.ts          AppContext { db, config, storage, now }, UserRow, iso helpers
  db/index.ts         async wrapper over node:sqlite (all, get, run, tx, exec)
  db/schema/*.sql     the data contract, applied in name order, all idempotent
  db/seed/            backbone.ts holds the whole BIO-042 story; each slice adds its own file
  lib/                auth, permissions, audit, crypto, errors, validate, ids, mail, storage, evidence, rateLimit, demoFixtures
  routes/<slice>.ts   export function registerX(app)
  engine/             run worker and other long-running logic
shared/types/         DTOs imported by both sides (`import type` only)
src/
  components/         the kit: import from '../../components/index.ts'
  lib/                api, query, session, format, browser, theme, routes
  pages/<slice>/      routes.tsx + pages for that slice
tests/api/            Vitest, using tests/helpers/app.ts
tests/e2e/            Playwright
```

Node runs the server's TypeScript directly (type stripping): `.ts` extensions on imports, `import type` for types, and no `enum`, parameter properties or namespaces.

## Server rules

- **Routes** live in `server/routes/<slice>.ts` as `registerX(app: Hono<AppEnv>)`. Get services with `const ctx = c.get('ctx')`. All paths start with `/api/`, except OAuth's `/oauth/token`.
- **Auth:** call `requireVerified(c)` (or `requireUser`, `requireAdmin`) first in every handler. "Tasks, datasets and reports require a verified account."
- **Permissions:** every check goes through `server/lib/permissions.ts`, which reads current state. It returns `{ allowed: true }` or `{ allowed: false, reason }`. Refuse with `throw forbidden(verdict.reason)`. Send the verdict to the page too, so it can render the action disabled with that exact reason. For a private item the caller may not see, use `notFound()`.
- **Validation:** `readJson(c, zodSchema)`. Zod messages are shown to users, so write full sentences ("Enter a task title to continue."). Failures return 422 with `fields`.
- **Errors:** `throw badRequest/forbidden/notFound/conflict/tooMany/unavailable/invalid`. Error bodies are `{ error: { code, message, fields? } }`.
- **Time:** always `ctx.now()`, never `new Date()`, so tests can move the clock. Store ISO strings.
- **Writes:** wrap multi-statement writes in `ctx.db.tx(async () => { … })`. Never await network calls inside `tx`.
- **Audit:** every consequential decision calls `audit(ctx, { actorId, action, subjectType, subjectId, subjectCode, workspaceId, detail })`.
- **Immutability:** `task_versions`, `evidence`, `reports`, `adjudications`, `trace_adjudications`, `traces`, `gate_runs`, `dataset_versions`, `model_revisions` and `audit_log` have triggers that refuse UPDATE and DELETE. Do not work around them. New states are new rows.
- **Hashes:** real SHA-256 from `server/lib/evidence.ts` and `server/lib/crypto.ts`. A page may only say "HASH VERIFIED" after the server recomputes the hash on that request (`verifyEvidenceRow`), and must render `<HashMismatch>` otherwise.
- **Codes:** `nextCounter(ctx.db, 'name', initial)` then format (`BIO-044`, `RUN-1043`, `EV-1043-A`, `CP-006`, `APP-030`, `REVIEW-043`, `ADJ-043`, `RPT-BIO-044`, `DS-BIO-10`, `TRACE-044`, `REG-BIO-044`, `GATE-020`, `OAUTH-042`, `CHECK-291`). Counter names already seeded: `task:BIO`, `run`, `dataset:BIO`, `application`, `review`, `adjudication`. Other slices seed their own counters.
- **Responses:** camelCase DTOs. Lists are `{ items: [...] }`. Parse JSON columns before returning them. Put shared DTO types in `shared/types/<slice>.ts`.
- **No fake success.** If a flow cannot complete because a service or credential is missing, say so and leave the action disabled with the reason. Never return success for something that did not happen.
- **Files:** `ctx.storage.put/read/stream`, plus an `uploads` row. Downloads set `Content-Disposition` and are permission-checked on each request.

## Client rules

- **Pages** are default exports, registered through `page(() => import('./X.tsx'))` in that slice's `routes.tsx` (`SliceRoutes`: `app` is inside the shell for verified accounts; `access` has no navigation; `guest` is signed-out only). Do not edit `src/App.tsx`.
- **Reference pages:** `src/pages/access/SignUpPage.tsx` (form) and `src/pages/access/VerifyPage.tsx` (query, mutations, modal, countdown).
- **Slices:** the code is grouped by area (`access`, `workspace`, `evaluation`, `expert`, `published`, `datasets`, `assurance`, `external`, `advisor`, `admin`), each with its own routes, pages and tests.
- **Structure,** in this order, matching the frames:
  ```tsx
  <Page title="…">
    <PageHeader eyebrow="02 Evaluation" title="…" subtitle="…" status="…" statusTone="warning" />
    <Alert tone="warning">…</Alert>
    <Workspace rail={<ContextRail>…</ContextRail>}>
      <Section title="…">…</Section>
    </Workspace>
    <Actions>…primary, then secondary…</Actions>
    <ActionsBelow><DisabledAction reason="…">…</DisabledAction></ActionsBelow>
  </Page>
  ```
- **Sections:** `kind="form"` for fields (heading + 16px), plain text and `<Pairs>` by default (heading + 31.5px). A frame's "Term\nDetail" lines are `<Pairs>`. Results rows are `<Row>` inside `kind="form"`; leaderboard rows are `<Row extra={<CiPlot/>}>` inside `kind="table"`.
- **Rail:** `ContextRail` adds the title and the synthetic note itself. Use `RailItem`, `RailNote`, `RailStat`, `RailSelect`, `RailTamper`, `RailUnavailable`. `RailItem term` is uppercased by CSS.
- **Fields:** `FieldInput`, `FieldTextarea`, `FieldSelect`, `FieldStatic`, `FieldFile`, `Checkbox`. Pass `error={mutation.fieldErrors.name}`, using the same key as the Zod field.
- **Data:** `useApiQuery<T>(path)` wrapped in `<QueryBoundary query={q}>{(data) => …}</QueryBoundary>`, which gives the loading skeleton, error state with retry, and 403/404 states. Keep the whole page inside the boundary. Poll with `refetchInterval` where state changes server-side.
- **Writes:** `useApiMutation(fn, { invalidate, onSuccess })`, with `busy={m.isPending}` on the button and `<Alert tone="danger">{m.formError}</Alert>` for errors. Show a toast only after the server confirms.
- **Disallowed actions** stay visible: `<DisabledAction reason={verdict.reason}>` with `<RailUnavailable action reason>`. The reason comes from the server wherever possible.
- **Styling:** use kit classes and the tokens in `src/styles/tokens.css` only. No new hex colours, no drop shadows, no pill containers. Section breaks are rules, not cards. If a page needs CSS the kit lacks, add `src/pages/<slice>/<slice>.css` and import it from the page. If several slices would need the same thing, it belongs in the kit.
- **Accessibility:** native elements (`button`, `a`, `select`, `input`, `dialog`). Links navigate, buttons act. Every control has a label. Status changes that matter use `<Alert live>` or the toast region. Icons are `aria-hidden` next to text. Do not rely on colour alone.
- **Responsive:** the kit handles 1100, 900 and 768 breakpoints and the mobile frames. Do not set fixed widths; long codes and hashes must wrap. Check 390px.
- **Links between slices:** use the route contract below, even if the target page is being built by someone else.
- **Dependencies:** none beyond those in `package.json` without a strong reason.

## Route contract

Client routes. Every slice can link to these.

| Path | Screen | Slice |
|---|---|---|
| `/signup`, `/signin`, `/verify`, `/auth/verify`, `/auth/github/failed`, `/forgot`, `/reset`, `/dev/outbox` | Access | access |
| `/` | Home: first-run and returning | workspace |
| `/workspace`, `/workspace/new`, `/invitations/:token`, `/w/:slug` | Members, create, accept invite, workspace URL | workspace |
| `/profile` | Profile | workspace |
| `/legal/terms`, `/legal/privacy` | Legal placeholders (access shell) | workspace |
| `/tasks` | Browse tasks (09 browse) | evaluation |
| `/tasks/new` (`?starter=1` prefills the authored starter task) | New draft | evaluation |
| `/tasks/:code` | Task (05 private): access policy, visibility, run | evaluation |
| `/tasks/:code/edit` | Editor (02 editor) | evaluation |
| `/tasks/:code/freeze` | Freeze preview (02 freeze) | evaluation |
| `/runs/:code` | Running, interrupted or results, by status | evaluation |
| `/evidence/:code` | Evidence (02 evidence) | evaluation |
| `/review` | Review queue, or apply/pending by state | expert |
| `/review/apply`, `/review/application` | Apply, your application (pending) | expert |
| `/review/:code` | Expert review, e.g. `/review/REVIEW-042` | expert |
| `/admin` | Administration index, locked state for non-admins | admin |
| `/admin/credentials`, `/admin/credentials/:code` | Credential queue, verification | expert |
| `/admin/adjudications`, `/admin/adjudications/:code` | Adjudication queue, decision (`:code` is the REVIEW code) | expert |
| `/admin/models`, `/admin/checks` | Model registry, system checks | admin |
| `/leaderboards`, `/leaderboards/methodology` | Leaderboard, methodology | published |
| `/reports`, `/reports/:code/:version` | Report index; report, e.g. `/reports/RPT-BIO-042/v1.0` | published |
| `/datasets`, `/datasets/upload`, `/datasets/:code`, `/datasets/:code/delete` | Datasets | datasets |
| `/assurance` | Agent assurance index | assurance |
| `/assurance/traces/:code`, `/assurance/regressions/:code`, `/assurance/gates/:code/:candidate` | Trace, regression, gate result | assurance |
| `/oauth/authorize`, `/oauth/consent/:code` | Consent and its outcomes (access shell) | external |
| `/atlas-demo`, `/atlas-demo/callback` | Demo OAuth client (access shell) | external |
| `/advisor` (`?task=BIO-042`) | Audit Advisor | advisor |

## Cross-slice reads

The schema in `server/db/schema/` is the contract. Read another slice's tables with SQL rather than importing its route code. There is no migration system yet: the schema files are re-applied on boot and every statement is idempotent, so a column added to an existing table needs `npm run db:reset` locally, and a migration step before real data exists. `server/db/seed/backbone.ts` shows exactly how the rows look.

## Testing

- API: `npx vitest run tests/api/<file>.test.ts`. Use `makeTestApp`, `Client`, `makeUser`, `makeWorkspace` and `lastMail` from `tests/helpers/app.ts`. `makeTestApp({ seed: true })` loads the demo story. Test permission refusals as carefully as the happy path.
- UI: run your own API and Vite on your assigned ports, then drive with Playwright:
  ```bash
  RIVET_DATA_DIR=<tmp> RIVET_PORT=<api> RIVET_PUBLIC_URL=http://localhost:<web> RIVET_STAGE_MS=300 node --disable-warning=ExperimentalWarning server/index.ts
  RIVET_PORT=<api> npx vite --port <web> --strictPort
  RIVET_E2E_BASE_URL=http://localhost:<web> npx playwright test tests/e2e/<slice>.spec.ts
  ```
  Demo sign-ins: `maya@helixlab.example` (member, workspace owner), `samira@northbridge.example` (verified Biology expert), `alex@rivet.example` (admin), `lena@northbridge.example` (pending applicant). Password `rivet-demo-2026`.
