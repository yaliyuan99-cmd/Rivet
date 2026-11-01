# Rivet

Evidence-first AI model evaluation, built from the Figma prototype (`Untitled`, 37 screens in light and dark, desktop and mobile). Real tasks, real evaluation, better AI.

Everything on screen works against a real server and database: accounts, email links, workspaces, invitations, task freezing, the run engine, sealed evidence, reviewer applications, expert review, adjudication, reports, the leaderboard bootstrap, dataset validation, agent release gates, OAuth for AI clients, the Audit Advisor and the system checks.

## Run it

Needs Node 24 or newer. There is nothing else to install or configure: the database is a local file, and uploads go to a local folder.

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173. The first start creates `data/` and loads the synthetic demo story.

For a production-style run on one port (http://localhost:8787):

```bash
npm run build
```

```bash
RIVET_ALLOW_DEV_OUTBOX=1 npm start
```

Without `RIVET_ALLOW_DEV_OUTBOX=1` or an email provider, a production-style server refuses new sign-ups rather than pretending to send email. The demo accounts still work.

To wipe the local data and reload the demo story:

```bash
npm run db:reset
```

## Demo accounts

Every account uses the password `rivet-demo-2026`. They exist only on an instance with the demo seed, and the sign-in page can fill them in for you.

| Account | Who | Try |
|---|---|---|
| `maya@helixlab.example` | Maya Chen: member, owner of Helix Lab | Finish draft BIO-043, freeze it, run it, stop and resume, request review. Run gate rc.19 and approve it. |
| `samira@northbridge.example` | Dr. Samira Patel: verified Biology expert | Claim a requested review. Adjudicate TRACE-044. |
| `alex@rivet.example` | Alex Rivera: administrator | Verify APP-029, finalize a submitted review, edit a model, run the system checks. |
| `lena@northbridge.example` | Dr. Lena Ortiz: applicant | See a pending application, then a verified one after Alex decides. |

Or create a new account. Email links appear at http://localhost:5173/dev/outbox until an email provider is configured.

Everything in the seed is fictional and labelled `SYNTHETIC DEMO`, including Aster, Meridian and Lumen, which are not real models. The demo adapter produces clearly labelled synthetic output, and its scores are always labelled `demo`.

## Configuration

Everything is optional; copy `.env.example` to `.env` to set any of it. With nothing set, each service below stays visibly disabled with its reason, and nothing pretends to work.

| Variable | Turns on |
|---|---|
| `ANTHROPIC_API_KEY` | Real runs on Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5, an LLM judge for scoring them, and a constrained LLM mode for the Audit Advisor |
| `RESEND_API_KEY`, `RIVET_MAIL_FROM` | Real email instead of the dev outbox |
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | Sign in with GitHub and connecting a GitHub profile |
| `LINKEDIN_CLIENT_ID`, `LINKEDIN_CLIENT_SECRET` | Connecting a LinkedIn profile |
| `HUGGINGFACE_CLIENT_ID`, `HUGGINGFACE_CLIENT_SECRET` | Connecting a Hugging Face profile |
| `RIVET_PUBLIC_URL` | The public address used in email links, citations and OAuth redirects |
| `RIVET_DATA_DIR`, `RIVET_PORT` | Where data lives, and the API port |
| `RIVET_DEMO=0` | Runs without the demo seed and labels |
| `RIVET_STAGE_MS` | Pause per run stage for the demo adapter (default 2500) |
| `RIVET_ALLOW_DEV_OUTBOX=1` | Keeps the dev outbox on with `NODE_ENV=production`, for local use only |

Set `NODE_ENV=production` when serving real users: the dev outbox then refuses to serve, so email needs a provider.

## How it is built

- **Client:** React, React Router, TanStack Query and Lucide icons, with plain CSS holding the Figma tokens 1:1. Every page is code-split. The kit in `src/components/` implements the Figma UI kit.
- **Server:** Hono on Node 24, running TypeScript directly with no build step. Routes are in `server/routes/`; the run worker, release gate, advisor and system checks are in `server/engine/`.
- **Data:** SQLite through `node:sqlite`, behind a small async interface in `server/db/index.ts`, using portable SQL so another database can replace it. Database triggers refuse changes to frozen versions, sealed evidence, reports, adjudications and the audit log.

This replaces Base44 from the earlier repository. Its backend functions return `402` on the current plan and its code cannot be exported or synced, so nothing could be made real on it. React, Vite, React Router, TanStack Query and Lucide are kept, and the useful rules in `base44/shared` were ported (contamination scan, statistics, review eligibility). Tailwind and shadcn were dropped, because the design's tokens map directly to CSS and the bundle is smaller without them.

More detail:
- `docs/ASSUMPTIONS.md`: decisions made where the design was silent, and what is blocked on you
- `docs/BUILDING.md`: code conventions and the route map
- `docs/figma/`: every frame as exact text, plus reference images

## Tests

```bash
npm run test:all
```

That runs the typecheck, the API tests (Vitest), the production build and the browser tests (Playwright, using the Chrome installed on this machine). The browser suite starts its own server on a throwaway database. It includes:

- `tests/e2e/journey.spec.ts`: one person's whole path from sign-up to a cited report, with a real expert and administrator
- `tests/e2e/a11y.spec.ts`: axe (WCAG A and AA) on every route in both themes, plus keyboard paths
- `tests/e2e/responsive.spec.ts`: no sideways scrolling or broken values at 1440, 1024, 820 and 390 px
- `tests/e2e/states.spec.ts`: loading, failure, recovery, session end and theme, forced at the network

`tests/api/authz-matrix.test.ts` walks every API route as a visitor, as an outsider and as a non-admin, so a route added without a permission check fails even if nobody wrote a test for it.

`scripts/qa/frame-diff.mjs` measures seeded pages against the Figma frames: copy, type styles and positions.

## Hosting

`npm start` serves everything from one Node process, so any host with Node 24 and a persistent disk works as is. Netlify would need a Postgres adapter behind `server/db/index.ts`, blob storage behind `server/lib/storage.ts`, and a separate home for the run worker, since functions there have no disk and do not stay running. Nothing has been deployed.
