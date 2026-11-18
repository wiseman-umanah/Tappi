// Pre-builds responsive WebP copies of public/images/*.png into public/images/opt/, plus
// src/lib/image-manifest.json listing the widths made for each image. The site is a static export
// (Cloudflare Pages), so there is no image server: src/lib/image-loader.ts picks from these files.
// Run after adding or changing an image: pnpm images
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const WIDTHS = [256, 384, 640, 828, 1080, 1440, 1920, 2880];
// Kept as source art only: the hero is drawn from hero-left/hero-right, the logo is inline SVG.
const SKIP = new Set(["hero.png", "logo.png"]);
const source = fileURLToPath(new URL("../public/images/", import.meta.url));
const output = `${source}opt/`;

rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });

const manifest = {};
for (const file of readdirSync(source).filter((name) => name.endsWith(".png") && !SKIP.has(name)).sort()) {
  const name = file.replace(/\.png$/, "");
  const { width } = await sharp(source + file).metadata();
  const widths = [...new Set([...WIDTHS.filter((w) => w < width), width])];
  for (const w of widths) {
    await sharp(source + file)
      .resize({ width: w })
      .webp({ quality: 82, alphaQuality: 90, effort: 6 })
      .toFile(`${output}${name}-${w}.webp`);
  }
  manifest[name] = widths;
  console.log(`${file}: ${widths.join(", ")}`);
}

writeFileSync(new URL("../src/lib/image-manifest.json", import.meta.url), `${JSON.stringify(manifest, null, 2)}\n`);
