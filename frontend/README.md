# Tappi — landing page

This is where the landing page lives. Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4.
The design it implements is `design/landing_page.png`.

## Run

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm build      # static export to out/
pnpm start      # serve out/ at http://localhost:3000 (run pnpm build first)
pnpm lint
pnpm images     # after adding or changing anything in public/images
pnpm loader     # after changing scripts/build-loader.mjs
```

## Deploy (Cloudflare Pages)

The site is a static export (`output: "export"`), so Cloudflare Pages serves `out/` directly.
Pages project settings (Settings → Build):

| Setting | Value |
| --- | --- |
| Root directory | `frontend` |
| Build command | `pnpm build` |
| Build output directory | `out` |

The root directory must be `frontend` so Pages also finds `frontend/functions/` (the waitlist API).
Variables (Settings → Variables and Secrets): `NEXT_PUBLIC_SITE_URL` (the real domain) and
`WAITLIST_WEBHOOK_URL` (see `.env.example`).

What static hosting changes:

- **Images**: no image server, so `pnpm images` pre-builds WebP sizes into `public/images/opt/` and
  `src/lib/image-loader.ts` picks the right one for `next/image`. Commit the generated files.
- **Headers** (security, caching): `public/_headers`, not `next.config.ts`.
- **Waitlist**: `functions/api/waitlist.ts` (Pages Function at `POST /api/waitlist`). `next dev` doesn't
  run it, so locally the form fakes success; `npx wrangler pages dev out` runs the real thing.
- **404**: `out/404.html`, which Pages serves for unknown paths.

## Layout

- `src/app/layout.tsx` — Creato Display font (`src/app/fonts`), site metadata, JSON-LD
  (Organization, WebSite, SoftwareApplication, FAQPage) and the launch loader.
- `src/app/page.tsx` — the page, one component per section in `src/components`.
- `src/app/not-found.tsx`, `error.tsx`, `global-error.tsx` — 404 and error pages.
- `src/app/robots.ts`, `sitemap.ts`, `manifest.ts`, icons, `opengraph-image.jpg`, `twitter-image.jpg` — SEO.
- `src/components/launch.tsx` — launch loader: plays `src/assets/tappi-loader.json` (Lottie, made by
  `scripts/build-loader.mjs`) while fonts and every image download.
- `src/lib/site.ts` — site URL, app download link, nav, FAQ copy.
- `public/images` — design assets; `design/` — the design and the original OG image (not deployed).

Creato Display has no ₦ glyph, so the naira sign renders in the system font.
