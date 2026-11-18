import manifest from "./image-manifest.json";

const sizes: Record<string, number[]> = manifest;

/**
 * next/image loader for the static export: maps /images/<name>.png at a requested width to the
 * smallest pre-built WebP that is at least that wide (scripts/optimize-images.mjs).
 */
export default function imageLoader({ src, width }: { src: string; width: number; quality?: number }) {
  const match = /^\/images\/([^/]+)\.png$/.exec(src);
  const widths = match ? sizes[match[1]] : undefined;
  if (!match || !widths) return src;
  const best = widths.find((w) => w >= width) ?? widths[widths.length - 1];
  return `/images/opt/${match[1]}-${best}.webp`;
}
