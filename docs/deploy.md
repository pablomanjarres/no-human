# Deploying the console

One Vercel project serves both surfaces: the SICK landing page at `/` and the
equivalence console at `/console`. Every push to `main` redeploys production;
every push to any other branch gets a preview URL. That is Vercel's GitHub
integration — no workflow file, no secrets in CI.

## First-time setup

The only step that cannot be scripted is authorising Vercel against the GitHub
account. Do it once in a browser.

1. Open <https://vercel.com/new> and import `pablomanjarres/no-human`.
2. **Root Directory: `apps/console`.** This is the one setting that matters. Leave
   "Include files outside of the Root Directory" enabled — the build reads
   `apps/sick-clone-ui` to sync the landing page, and the pnpm workspace root is
   two levels up.
3. Framework preset: Next.js. Build and install commands come from
   `apps/console/vercel.json`, so leave them on the defaults.
4. Environment variables: none are required by the console, which renders from
   the offline corpus. `ANTHROPIC_API_KEY` is required only by `/api/consult` —
   without it the advisor still answers, ranking deterministically, and says so
   on every response. See `docs/consultancy-tool.md`.
5. Deploy.

Autodeploy is on from that moment. Nothing else to configure.

## Or from the CLI

```bash
npx vercel login                       # browser round-trip, once
cd apps/console
npx vercel link                        # creates the project
npx vercel git connect                 # turns on autodeploy from GitHub
npx vercel --prod                      # first production deploy
```

`vercel link` will ask for the root directory. Answer `apps/console`.

## What the build does

```
pnpm install --frozen-lockfile         # at the workspace root
node scripts/sync-landing.mjs          # apps/sick-clone-ui -> apps/console/public
next build
```

The sync step is why "include files outside the root directory" has to stay on.
The landing page has exactly one source of truth — `apps/sick-clone-ui` — and the
copies under `apps/console/public` are gitignored so they can never drift.

## Routes after deploy

| Path | Serves |
| --- | --- |
| `/` | Landing page, rewritten to the synced `public/index.html` |
| `/console` | The workspace |
| `/console/product/[sku]` | Product record, prerendered for all 799 SKUs — the three hand-authored parts plus every sensing SKU in the catalogue |
| `/console/corpus` | Extraction swarm output and the dispute ledger |
| `/console/doc/[docId]` | Citation viewer |
| `/consult.html` | Application advisor — problem description in, recommended SKU out |
| `/api/consult` | Advisor endpoint (`POST`). Needs `ANTHROPIC_API_KEY` for the full analysis; degrades to deterministic ranking without it |
| `/api/health` | Catalogue counts and whether a model credential is present |

## Demo links to have open on stage

Replace `<host>` with the deployment URL.

- `<host>/` — open cold here
- `<host>/console?q=QS18VN6LV` — the full solve, kill and promotion included
- `<host>/console?q=QS18VN6LV&t=900` — frozen one frame before the kill, if you
  want to talk over it rather than race it
- `<host>/console?q=ML100-8-1000-RT/95/103` — the refusal
- `<host>/console?q=WTB9-3P2211S14` — a live lookup into the 796-SKU catalogue:
  identifies the part, says plainly that it is ours rather than a competitor's,
  and ranks what else in the same category covers it
- `<host>/console?q=1052171` — the same part by order number, which is what is
  printed on a purchase order
- `<host>/console?q=WTB9-3P221` — a near miss. Offers candidate type codes and
  refuses to pick one, because a character of a type code is often a polarity
- `<host>/console?q=sensor%20de%20caja&mode=describe` — the Describe lane asking
  before it solves. "Caja" does not state a material, and a carton and a black
  crate are two derating tiers apart, so it asks instead of assuming
- `<host>/console?q=cajas%20de%20carton%20a%2040%20cm&mode=describe` — the same
  lane when the description does state both: ×2 derating, 800 mm required, solved
- `<host>/console/corpus` — the verifier dispute count

## Caveats

The landing page pulls Font Awesome from a CDN, so its icons do not render with
the network off. The console itself has no runtime network dependency: fonts are
self-hosted by `next/font` at build time and there are no remote images. If the
venue Wi-Fi dies, the console is fine and the landing page loses its glyphs.
