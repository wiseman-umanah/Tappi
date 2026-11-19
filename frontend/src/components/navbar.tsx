"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { demoUrl, navLinks } from "@/lib/site";
import { ButtonLink, Logo, cn } from "./ui";

export function Navbar() {
  const [open, setOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const [current, setCurrent] = useState("");

  useEffect(() => {
    if (!open) return;
    const close = (event: KeyboardEvent) => event.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", close);
    return () => window.removeEventListener("keydown", close);
  }, [open]);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // Highlight the link of the section being read.
  useEffect(() => {
    const sections = navLinks
      .map((link) => document.querySelector<HTMLElement>(link.href))
      .filter((section): section is HTMLElement => section !== null);
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setCurrent(`#${entry.target.id}`);
        }
      },
      { rootMargin: "-45% 0px -50% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  return (
    <header className="fixed inset-x-0 top-0 z-50 animate-[rise_0.8s_var(--ease-out-expo)_both] px-4 pt-4 md:px-8 md:pt-[54px] xl:px-[66px]">
      <a
        href="#main"
        className="sr-only rounded-full bg-brand px-4 py-2 focus:not-sr-only focus:absolute focus:top-3 focus:left-4"
      >
        Skip to content
      </a>

      <nav
        aria-label="Main"
        className={cn(
          "mx-auto flex h-16 max-w-[1308px] items-center justify-between rounded-full border pr-2 pl-5 backdrop-blur-md transition-all duration-500 md:h-[76px] md:pr-3.5 md:pl-4",
          scrolled
            ? "border-white/15 bg-ink/80 shadow-[0_12px_40px_rgba(0,0,0,0.35)] md:-translate-y-[38px]"
            : "border-white/20 bg-white/[0.03]",
        )}
      >
        <Logo />

        <ul className="hidden items-center gap-2 lg:flex">
          {navLinks.map((link) => (
            <li key={link.href}>
              <Link
                href={link.href}
                aria-current={current === link.href ? "location" : undefined}
                className={cn(
                  "relative rounded-full px-4 py-2 text-base transition-colors hover:text-white",
                  current === link.href ? "bg-white/10 text-white" : "text-white/85",
                )}
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>

        <div className="flex items-center gap-2">
          <div className="hidden sm:block">
            <ButtonLink href={demoUrl} target="_blank" rel="noopener noreferrer">Get started Free</ButtonLink>
          </div>
          <button
            type="button"
            className="inline-flex size-12 items-center justify-center rounded-full text-white hover:bg-white/10 lg:hidden"
            aria-expanded={open}
            aria-controls="mobile-menu"
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((value) => !value)}
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              {open ? <path d="M6 6l12 12M18 6L6 18" /> : <path d="M4 7h16M4 12h16M4 17h16" />}
            </svg>
          </button>
        </div>
      </nav>

      <div
        id="mobile-menu"
        className={cn(
          "absolute inset-x-4 top-[calc(100%+0.5rem)] rounded-3xl border border-white/15 bg-ink/95 p-3 backdrop-blur-md transition-all duration-300 md:inset-x-8 lg:hidden",
          open ? "visible translate-y-0 opacity-100" : "invisible -translate-y-2 opacity-0",
          scrolled && "md:-translate-y-[38px]",
        )}
      >
        <ul className="flex flex-col">
          {navLinks.map((link, index) => (
            <li
              key={link.href}
              className={cn("transition-all duration-300", open ? "translate-x-0 opacity-100" : "-translate-x-2 opacity-0")}
              style={{ transitionDelay: open ? `${index * 50}ms` : "0ms" }}
            >
              <Link
                href={link.href}
                onClick={() => setOpen(false)}
                className="block rounded-2xl px-4 py-3 text-base text-white/90 hover:bg-white/5"
              >
                {link.label}
              </Link>
            </li>
          ))}
        </ul>
        <ButtonLink href={demoUrl} target="_blank" rel="noopener noreferrer" onClick={() => setOpen(false)} className="mt-2 w-full sm:hidden">
          Get started Free
        </ButtonLink>
      </div>
    </header>
  );
}
