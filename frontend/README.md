# Tappi — landing page

This is where the landing page lives. Next.js 16 (App Router), React 19, TypeScript, Tailwind CSS v4.
The design it implements is `design/landing_page.png`.

## Run

```sh
pnpm install
pnpm dev        # http://localhost:3000
pnpm build && pnpm start
pnpm lint
```

Copy `.env.example` to `.env.local` and set `NEXT_PUBLIC_SITE_URL` to the real domain before deploying.

## Layout

- `src/app/layout.tsx` — Creato Display font (`src/app/fonts`), site metadata and JSON-LD
  (Organization, WebSite, SoftwareApplication, FAQPage).
- `src/app/page.tsx` — the page, one component per section in `src/components`.
- `src/app/robots.ts`, `sitemap.ts`, `manifest.ts`, `icon.png`, `apple-icon.png`,
  `opengraph-image.jpg`, `twitter-image.jpg` — SEO and share files.
- `src/app/actions.ts` — "Join the List" server action; forwards to `WAITLIST_WEBHOOK_URL`.
- `src/lib/site.ts` — site URL, copy shared by several sections (nav, footer, FAQ).
- `public/images` — design assets.

Creato Display has no ₦ glyph, so the naira sign renders in the system font.
