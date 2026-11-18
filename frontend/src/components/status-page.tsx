import Image from "next/image";
import type { ReactNode } from "react";
import { Logo } from "./ui";

/** Shared shell for the 404 and error pages: the two hands reach for a tap that never lands. */
export function StatusPage({
  code,
  title,
  body,
  toast,
  children,
}: {
  code: string;
  title: string;
  body: string;
  toast: { title: string; body: string };
  children: ReactNode;
}) {
  return (
    <div className="relative isolate flex min-h-dvh flex-col overflow-hidden bg-[linear-gradient(180deg,#1a1a1b_0%,#1b2432_30%,#1a3462_55%,#174dbd_85%,#0c57ec_100%)]">
      <Image
        src="/images/hero_pattern.png"
        alt=""
        width={1860}
        height={782}
        className="pointer-events-none absolute bottom-0 left-1/2 -z-10 w-[1860px] max-w-none -translate-x-1/2 animate-drift opacity-40 [mask-image:linear-gradient(to_bottom,transparent_0%,black_50%)]"
      />

      <header className="px-5 pt-6 md:px-[66px] md:pt-10">
        <Logo />
      </header>

      <main id="main" className="flex flex-1 flex-col items-center px-5 pt-10 text-center md:pt-12">
        <p className="bg-[linear-gradient(90deg,#4f6ef7,#8b5cf6,#4f6ef7)] bg-[length:200%_auto] bg-clip-text text-[96px] leading-none font-extrabold tracking-tight text-transparent [animation:rise_0.8s_var(--ease-out-expo)_both,shimmer_6s_linear_infinite] md:text-[140px]">
          {code}
        </p>
        <h1 className="mt-4 animate-rise text-3xl font-bold tracking-tight [animation-delay:100ms] md:text-5xl">{title}</h1>
        <p className="mt-4 max-w-[520px] animate-rise text-base text-white/70 [animation-delay:180ms] md:text-lg">{body}</p>
        <div className="mt-8 flex animate-rise flex-wrap justify-center gap-3 [animation-delay:260ms]">{children}</div>
      </main>

      <div
        aria-hidden="true"
        className="relative left-1/2 mt-10 aspect-[2880/804] w-[max(130vw,900px)] shrink-0 -translate-x-1/2 md:mt-4"
      >
        <div className="absolute inset-0 animate-reach-left">
          <Image src="/images/hero-left.png" alt="" fill sizes="130vw" className="object-contain" />
        </div>
        <div className="absolute inset-0 animate-reach-right">
          <Image src="/images/hero-right.png" alt="" fill sizes="130vw" className="object-contain" />
        </div>

        <div className="absolute bottom-[14%] left-1/2 -translate-x-1/2">
          <div className="animate-pop [animation-delay:0.6s]">
            <div className="flex w-max animate-float items-center gap-2.5 rounded-full bg-white py-2.5 pr-7 pl-2.5 text-left shadow-[0_12px_40px_rgba(0,0,0,0.3)]">
              <span className="flex size-9 items-center justify-center rounded-full bg-red-100 text-red-500">
                <svg className="size-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
                  <path d="M7 7l10 10M17 7L7 17" />
                </svg>
              </span>
              <span className="leading-tight">
                <span className="block text-sm font-medium text-black md:text-base">{toast.title}</span>
                <span className="block text-[11px] text-neutral-400 md:text-xs">{toast.body}</span>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
