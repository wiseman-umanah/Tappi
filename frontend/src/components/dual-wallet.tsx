import Image from "next/image";
import { Reveal } from "./reveal";
import { Eyebrow } from "./ui";

export function DualWallet() {
  return (
    <section id="dual-wallet" aria-labelledby="wallet-title" className="bg-ink-raised px-5 pt-16 [clip-path:inset(-80px_0_0_0)] md:pt-0">
      <div className="mx-auto grid max-w-[1240px] items-end gap-10 md:grid-cols-2 md:gap-12">
        <Reveal from="left" className="text-center md:self-center md:py-24 md:text-right">
          <Eyebrow className="text-lg md:text-xl">Dual wallet</Eyebrow>
          <h2 id="wallet-title" className="mt-3 text-3xl font-bold tracking-tight md:text-[40px] md:leading-[1.2]">
            Hold both.
            <br />
            Switch in one tap.
          </h2>
          <p className="mt-6 text-base leading-relaxed text-muted md:ml-auto md:max-w-[550px] md:text-xl">
            Keep spending money in naira and savings in USDC. Swap between them whenever the rate suits
            you, at the live rate with one clear fee.
          </p>
        </Reveal>

        <Reveal from="rise" delay={120} className="mx-auto w-full max-w-[444px] md:mx-0 md:-mt-11">
          <Image
            src="/images/phone_right.png"
            alt="Tappi swap screen converting 100 USDC to ₦157,526.00 at an indicative rate of ₦1,580 with a 0.3% fee"
            width={888}
            height={950}
            sizes="(min-width: 768px) 444px, 90vw"
            className="h-auto w-full"
          />
        </Reveal>
      </div>
    </section>
  );
}
