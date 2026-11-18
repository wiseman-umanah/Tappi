import Image from "next/image";
import { Reveal } from "./reveal";
import { CreditAlert, Eyebrow, cn } from "./ui";

const steps = [
  {
    title: "Enter the amount",
    body: "Type it on the keypad or tap a preset. Charge in naira or USDC, and see the other currency alongside as you type.",
  },
  {
    title: "Customer taps",
    body: "A card, an Apple Pay phone or a Tappi wallet held to the back of your phone. A chime and a vibration confirm it.",
  },
  {
    title: "Money lands",
    body: "The payment joins your payout balance, with an itemized receipt to share. Settle to a local bank or a self-custody wallet whenever you like.",
  },
];

const modes = [
  {
    badge: "Merchant mode",
    badgeClass: "border-success/60 bg-success/15 text-success",
    title: "A terminal that fits in your hand",
    points: [
      "Keypad with naira and USDC charging, plus quick-add presets",
      "Searchable payment history, filtered by currency and status",
      "Daily volume, tap counts and a weekly revenue chart",
      "Instant settlement to a bank account or your own crypto wallet",
    ],
  },
  {
    badge: "Customer mode",
    badgeClass: "border-brand/70 bg-brand/20 text-white",
    title: "One wallet, two currencies",
    points: [
      "A naira vault and a USDC vault, each with its own yield",
      "Swap between them at the live rate, send to friends, top up in seconds",
      "A virtual contactless card, and tap-to-pay straight from your phone",
      "Choose which wallet pays, and set daily tap limits for each",
    ],
  },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" aria-labelledby="how-title" className="bg-ink px-5 pt-20 pb-24 md:pt-24 md:pb-36">
      <div className="mx-auto max-w-[1170px]">
        <Reveal as="header" className="text-center">
          <Eyebrow>How a sale works</Eyebrow>
          <h2 id="how-title" className="mt-3 text-3xl font-bold tracking-tight md:text-5xl">
            Three steps, no card reader.
          </h2>
          <p className="mx-auto mt-3 max-w-[760px] text-base text-muted md:text-xl">
            The phone you already carry is the terminal. Nothing to plug in, nothing to order.
          </p>
        </Reveal>

        <div className="mt-10 grid items-center gap-12 md:mt-9 lg:grid-cols-[600px_1fr] lg:gap-10 lg:px-[52px]">
          <ol className="flex flex-col gap-5">
            {steps.map((step, index) => (
              <Reveal
                as="li"
                key={step.title}
                from="left"
                delay={index * 140}
                className="group flex gap-3 rounded-2xl border border-navy-line/60 bg-navy px-5 py-6 transition-[border-color,background-color,box-shadow] duration-300 hover:border-brand/70 hover:bg-[#15305c] hover:shadow-[0_16px_40px_rgba(59,130,246,0.15)] md:px-5 md:py-7"
              >
                <span
                  aria-hidden="true"
                  className="relative flex size-10 shrink-0 items-center justify-center rounded-full bg-[#1e3a8a] text-base font-medium text-brand transition-colors duration-300 group-hover:bg-brand group-hover:text-white"
                >
                  <span className="absolute inset-0 animate-ping-soft rounded-full border border-brand/60" style={{ animationDelay: `${index * 0.8}s` }} />
                  {index + 1}
                </span>
                <div>
                  <h3 className="text-lg font-medium md:text-xl">{step.title}</h3>
                  <p className="mt-1 text-sm leading-relaxed text-white/70 md:text-[15px]">{step.body}</p>
                </div>
              </Reveal>
            ))}
          </ol>

          <Reveal from="right" delay={150} className="relative mx-auto w-full max-w-[400px]">
            <Image
              src="/images/phone.png"
              alt="Orange phone with a contactless card tapped against its back"
              width={778}
              height={832}
              sizes="(min-width: 1024px) 400px, 80vw"
              className="h-auto w-full animate-float [animation-duration:7s]"
            />
            <div className="absolute -bottom-2 left-1/2 w-max -translate-x-1/2 sm:left-[4%] sm:translate-x-0">
              <Reveal from="zoom" delay={700} className="relative">
                <div aria-hidden="true" className="absolute inset-x-4 -bottom-2 h-full rounded-full bg-neutral-300/90" />
                <CreditAlert
                  avatar="/images/avatar-wiseman.png"
                  amount="₦20,500"
                  from="Wiseman"
                  className="relative"
                />
              </Reveal>
            </div>
          </Reveal>
        </div>

        <Reveal className="mt-24 text-center md:mt-16">
          <Eyebrow>One app, two sides</Eyebrow>
          <h2 className="mt-3 text-3xl font-bold tracking-tight md:text-5xl">Built for the till and for the pocket.</h2>
        </Reveal>

        <div className="mt-10 grid gap-[30px] md:mt-11 md:grid-cols-2">
          {modes.map((mode, index) => (
            <Reveal
              as="article"
              key={mode.title}
              from="zoom"
              delay={index * 150}
              className="rounded-[28px] transition-shadow duration-500 hover:shadow-[0_24px_60px_rgba(59,130,246,0.22)] bg-[linear-gradient(120deg,#12274a_0%,#1a3463_55%,#2b4a7e_100%)] px-6 py-9 md:px-[66px] md:pt-11 md:pb-12"
            >
              <span className={cn("inline-flex rounded-full border px-3 py-1.5 text-sm font-medium", mode.badgeClass)}>
                {mode.badge}
              </span>
              <h3 className="mt-5 text-2xl font-bold tracking-tight md:text-[28px]">{mode.title}</h3>
              <ul className="mt-4 flex flex-col gap-3">
                {mode.points.map((point) => (
                  <li key={point} className="flex gap-3 text-[15px] text-white/90 transition-transform duration-300 hover:translate-x-1">
                    <svg className="mt-1 size-4 shrink-0 text-success" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                      <path d="M3 8.5l3 3 7-7" />
                    </svg>
                    {point}
                  </li>
                ))}
              </ul>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
