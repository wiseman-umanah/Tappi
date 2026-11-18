"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import animationData from "@/assets/tappi-loader.json";
import { TappiMark } from "./tappi-mark";
import { cn } from "./ui";

/** Frame of tappi-loader.json where the mark is drawn, filled and has settled after its bounce. */
const SETTLED_FRAME = 130;
/** First visit: let the pen draw and fill the whole mark once. */
const FIRST_VISIT_MS = (SETTLED_FRAME / 60) * 1000 + 150;
/** Later visits in the same tab: assets are cached, so only a short beat. */
const RETURN_VISIT_MS = 600;
/** Never hold the page back longer than this, even on a slow connection. */
const MAX_MS = 8000;
const EXIT_MS = 650;
const SEEN_KEY = "tappi:launched";

function readSeen() {
  try {
    return sessionStorage.getItem(SEEN_KEY) === "1";
  } catch {
    return false;
  }
}

function markSeen() {
  try {
    sessionStorage.setItem(SEEN_KEY, "1");
  } catch {
    // Private mode or storage blocked: every visit just shows the full loader.
  }
}

/** Resolves once the image is downloaded and decoded (or has failed), so it paints instantly. */
function settle(img: HTMLImageElement) {
  const decode = () => img.decode().catch(() => undefined);
  if (img.complete) return img.naturalWidth ? decode() : Promise.resolve();
  return new Promise<void>((resolve) => {
    img.addEventListener("load", () => decode().then(() => resolve()), { once: true });
    img.addEventListener("error", () => resolve(), { once: true });
  });
}

/**
 * Downloads every image on the page now, including the lazy ones further down, at the exact size
 * the browser picked from each srcset. The responses land in the browser's HTTP cache.
 */
async function preloadImages(onProgress: (done: number, total: number) => void) {
  const images = Array.from(document.images);
  let done = 0;
  onProgress(0, images.length);
  for (const img of images) {
    if (img.loading === "lazy") img.loading = "eager";
  }
  await Promise.all(images.map((img) => settle(img).then(() => onProgress(++done, images.length))));
}

function whenPageLoaded() {
  if (document.readyState === "complete") return Promise.resolve();
  return new Promise<void>((resolve) => window.addEventListener("load", () => resolve(), { once: true }));
}

/** The pen-drawn Tappi mark from tappi-loader.json. */
function LoaderMark({ startFrame }: { startFrame: number }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let destroy = () => {};
    import("lottie-web/build/player/lottie_light").then(({ default: lottie }) => {
      if (disposed || !ref.current) return;
      const anim = lottie.loadAnimation({
        container: ref.current,
        renderer: "svg",
        loop: true,
        autoplay: startFrame === 0,
        animationData,
      });
      if (startFrame > 0) anim.goToAndPlay(startFrame, true);
      destroy = () => anim.destroy();
    });
    return () => {
      disposed = true;
      destroy();
    };
  }, [startFrame]);

  return <div ref={ref} className="absolute inset-0" />;
}

type Phase = "loading" | "leaving" | "done";

function Splash({ phase, progress, animate, startFrame }: { phase: Phase; progress: number; animate: boolean; startFrame: number }) {
  const percent = Math.round(progress * 100);
  return (
    <div
      id="splash"
      role="progressbar"
      aria-label="Loading Tappi"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      className={cn(
        "fixed inset-0 z-[100] flex flex-col items-center justify-center bg-ink bg-[radial-gradient(60%_45%_at_50%_110%,rgba(12,87,236,0.45),transparent)] transition-opacity ease-out",
        phase === "leaving" ? "pointer-events-none opacity-0" : "opacity-100",
      )}
      style={{ transitionDuration: `${EXIT_MS}ms` }}
    >
      <div
        className={cn(
          "flex flex-col items-center transition-transform ease-out",
          phase === "leaving" && "-translate-y-2 scale-95",
        )}
        style={{ transitionDuration: `${EXIT_MS}ms` }}
      >
        {/* 512-unit Lottie canvas; the mark sits in its middle 340×350, where the faint track is drawn. */}
        <div className="relative size-40 md:size-48">
          <TappiMark className="absolute top-[16.02%] left-[16.8%] h-[68.36%] w-[66.4%] text-white/10" />
          {animate ? (
            <LoaderMark startFrame={startFrame} />
          ) : (
            <TappiMark className="absolute top-[16.02%] left-[16.8%] h-[68.36%] w-[66.4%] text-white" />
          )}
        </div>
        <p className="-mt-3 text-2xl font-medium tracking-tight md:-mt-4">Tappi</p>
        <div className="mt-5 h-[3px] w-32 overflow-hidden rounded-full bg-white/10">
          <div
            className="h-full rounded-full bg-linear-to-r from-brand to-violet transition-[width] duration-300 ease-out"
            style={{ width: `${Math.max(6, percent)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * Covers the page with the Tappi loader while fonts and every image on the page download, then
 * fades away so the page's entrance animations play on a fully loaded page.
 */
export function LaunchProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [progress, setProgress] = useState(0);
  const [animate, setAnimate] = useState(true);
  const [startFrame, setStartFrame] = useState(0);

  useEffect(() => {
    const seen = readSeen();
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Settling state from the visitor's device and history, which only exist in the browser.
    /* eslint-disable react-hooks/set-state-in-effect */
    setAnimate(!reduceMotion);
    if (seen) setStartFrame(SETTLED_FRAME);
    /* eslint-enable react-hooks/set-state-in-effect */

    let finished = false;
    let exitTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = () => {
      if (finished) return;
      finished = true;
      markSeen();
      setProgress(1);
      document.documentElement.removeAttribute("data-loading");
      setPhase("leaving");
      exitTimer = setTimeout(() => setPhase("done"), EXIT_MS);
    };

    const minWait = new Promise((resolve) => setTimeout(resolve, seen || reduceMotion ? RETURN_VISIT_MS : FIRST_VISIT_MS));
    const assets = Promise.all([
      whenPageLoaded(),
      document.fonts.ready,
      preloadImages((done, total) => setProgress(total ? done / total : 1)),
    ]);
    Promise.all([assets, minWait]).then(finish);
    const cap = setTimeout(finish, MAX_MS);

    return () => {
      clearTimeout(cap);
      clearTimeout(exitTimer);
    };
  }, []);

  return (
    <>
      {phase === "done" ? null : <Splash phase={phase} progress={progress} animate={animate} startFrame={startFrame} />}
      {children}
    </>
  );
}
