import Image from "next/image";
import { appDownloadUrl, demoUrl } from "@/lib/site";
import { ButtonLink, CreditAlert } from "./ui";

export function Hero() {
  return (
    <section
      aria-labelledby="hero-title"
      className="relative isolate overflow-hidden bg-[linear-gradient(180deg,#1a1a1b_0%,#1b2432_22%,#1a3462_40%,#1a4294_51%,#174dbd_63%,#0c57ec_100%)] pt-20 md:pt-[130px]"
    >
      <div className="pointer-events-none absolute bottom-0 left-1/2 -z-10 w-[1860px] -translate-x-1/2">
        <Image
          src="/images/hero_pattern.png"
          alt=""
          width={1860}
          height={782}
          priority
          className="w-full max-w-none animate-drift opacity-45 [mask-image:linear-gradient(to_bottom,transparent_0%,black_45%)]"
        />
      </div>

      <div className="mx-auto flex max-w-[1440px] flex-col items-center px-5 pt-10 text-center md:pt-[50px]">
        <div className="flex animate-rise items-center gap-3">
          <Image src="/images/visa.png" alt="Visa and Mastercard" width={115} height={34} className="h-[30px] w-auto md:h-[34px]" />
          <span className="text-xs font-medium md:text-sm">Supports Visa and Mastercard</span>
        </div>

        <div className="mt-3 flex animate-rise items-center gap-2 [animation-delay:80ms]">
          <Image src="/images/avatars.png" alt="" width={62} height={25} className="h-[22px] w-auto md:h-[25px]" />
          <p className="text-sm text-white/60 md:text-base">Join 200 + People in using Tappi Smart pay</p>
        </div>

        <h1
          id="hero-title"
          className="mt-4 max-w-[760px] animate-rise text-[40px] leading-[1.05] font-bold tracking-tight [animation-delay:160ms] sm:text-5xl md:text-[64px]"
        >
          Turn Any Phone Into a <span className="text-violet">Card</span>{" "}
          <span className="animate-shimmer bg-[linear-gradient(90deg,#4f6ef7,#8b8ff9,#4f6ef7,#8b8ff9,#4f6ef7)] bg-[length:200%_auto] bg-clip-text text-transparent">
            Terminal
          </span>{" "}
          &amp; Dual Vault.
        </h1>

        <p className="mt-5 max-w-[560px] animate-rise text-base text-white/70 [animation-delay:240ms] md:text-lg">
          Accept card taps on your phone with zero extra hardware. Settle in instant NGN or store
          inflation-proof USDC.
        </p>

        <div className="relative z-10 mt-6 flex animate-rise flex-wrap justify-center gap-3 [animation-delay:320ms] md:gap-4">
          <ButtonLink href={appDownloadUrl} target="_blank" rel="noopener noreferrer">
            Download Mobile App
          </ButtonLink>
          <ButtonLink href={demoUrl} target="_blank" rel="noopener noreferrer">Get started Free</ButtonLink>
        </div>
      </div>

      {/* The hands slide in from each side and meet for a tap, then keep tapping. */}
      <div className="pointer-events-none relative mt-2 h-[260px] overflow-hidden sm:h-auto md:-mt-9">
        <div
          role="img"
          aria-label="One hand holding a phone while another taps a contactless card against its back"
          className="absolute top-0 left-1/2 aspect-[2880/804] w-[930px] -translate-x-1/2 sm:relative sm:left-0 sm:w-full sm:translate-x-0"
        >
          <div className="absolute inset-0 animate-hand-left">
            <Image
              src="/images/hero-left.png"
              alt=""
              fill
              priority
              sizes="(min-width: 640px) 100vw, 930px"
              className="animate-tap-back object-contain"
            />
          </div>

          <span aria-hidden="true" className="absolute top-[52%] left-[53.3%] aspect-square w-[11%] min-w-16">
            <span className="absolute top-1/2 left-1/2 size-full animate-ripple rounded-full opacity-0 border-2 border-white/70" />
            <span className="absolute top-1/2 left-1/2 size-full animate-ripple rounded-full opacity-0 border border-brand/80 [animation-delay:2.15s]" />
            <span className="absolute top-1/2 left-1/2 size-full animate-ripple rounded-full opacity-0 bg-white/10 [animation-delay:2.4s]" />
          </span>

          <div className="absolute inset-0 animate-hand-right">
            <Image
              src="/images/hero-right.png"
              alt=""
              fill
              priority
              sizes="(min-width: 640px) 100vw, 930px"
              className="animate-tap object-contain"
            />
          </div>
        </div>

        <div className="absolute bottom-[16%] left-1/2 -translate-x-1/2 scale-75 sm:scale-90 md:scale-100">
          <div className="animate-pop">
            <CreditAlert
              avatar="/images/avatar-whakiee.png"
              amount="₦4,500"
              from="Whakiee"
              className="w-max animate-float [animation-delay:2.8s]"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
