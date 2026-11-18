"use client";

import { useActionState } from "react";
import { joinWaitlist, type WaitlistState } from "@/app/actions";
import { Reveal } from "./reveal";
import { Select } from "./select";
import { cn } from "./ui";

const initialState: WaitlistState = { status: "idle", message: "" };

const intentOptions = [
  { value: "customer", label: "use the wallet as a customer", hint: "Hold naira and USDC, tap to pay" },
  { value: "merchant", label: "accept payments as a merchant", hint: "Turn your phone into a card terminal" },
  { value: "both", label: "do both", hint: "Sell at the till and spend from the wallet" },
];

const fieldClass =
  "h-10 w-full rounded-full border border-white/40 bg-linear-to-r from-white to-[#e4ecfd] px-4 text-sm text-neutral-900 placeholder:text-neutral-500 outline-none focus:ring-2 focus:ring-brand";

export function EarlyAccess() {
  const [state, formAction, pending] = useActionState(joinWaitlist, initialState);

  return (
    <section id="early-access" aria-labelledby="early-access-title" className="bg-ink px-5 pt-20 pb-20 md:pt-[110px] md:pb-[86px]">
      <Reveal from="zoom" className="mx-auto grid max-w-[946px] items-center gap-10 rounded-3xl border border-navy-line/80 bg-[radial-gradient(120%_140%_at_0%_100%,#2f5189_0%,#16305b_45%,#12274a_65%,#1b3d79_100%)] px-6 py-12 md:grid-cols-2 md:gap-16 md:py-[52px] md:pr-[104px] md:pl-[105px]">
        <div>
          <p className="text-base font-medium tracking-wide uppercase">Early access</p>
          <h2 id="early-access-title" className="mt-3 text-3xl leading-[1.2] font-bold tracking-tight md:text-[40px]">
            Take your first tap with Tappi.
          </h2>
          <p className="mt-2 max-w-[310px] text-sm font-medium leading-relaxed text-white/90">
            Tell us how you will use it. We will write when your place is ready.
          </p>
        </div>

        {state.status === "success" ? (
          <p role="status" className="rounded-2xl border border-success/50 bg-success/10 px-5 py-6 text-base font-medium">
            {state.message}
          </p>
        ) : (
          <form action={formAction} className="flex flex-col">
            <label htmlFor="email" className="text-base font-medium">
              Email
            </label>
            <input
              id="email"
              name="email"
              type="email"
              required
              autoComplete="email"
              placeholder="you@business.com"
              className={cn(fieldClass, "mt-2")}
            />

            <label htmlFor="intent" className="mt-4 text-base font-medium">
              I want to
            </label>
            <Select id="intent" name="intent" defaultValue="customer" options={intentOptions} className="mt-2" />

            <button
              type="submit"
              disabled={pending}
              className="mt-3 h-12 rounded-full bg-brand text-base font-medium transition-colors hover:bg-brand-hover disabled:opacity-70"
            >
              {pending ? "Joining…" : "Join the List"}
            </button>

            <p role="alert" aria-live="polite" className="mt-2 min-h-5 text-sm text-red-300">
              {state.status === "error" ? state.message : ""}
            </p>
          </form>
        )}
      </Reveal>
    </section>
  );
}
