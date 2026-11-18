import Image from "next/image";
import { Reveal } from "./reveal";
import { Eyebrow } from "./ui";

export function Assistant() {
  return (
    <section id="tappi-ai" aria-labelledby="ai-title" className="bg-ink px-5 py-16 md:py-[76px]">
      <div className="mx-auto grid max-w-[1240px] items-center gap-10 md:grid-cols-[minmax(0,590px)_1fr] md:gap-10">
        <Reveal from="zoom" className="order-2 flex justify-center overflow-hidden rounded-[32px] bg-ink-raised px-6 pt-11 md:order-1 md:px-0">
          <Reveal from="rise" delay={250} className="w-full max-w-[444px]">
          <Image
            src="/images/phone_left.png"
            alt="Tappi AI chat: “Send ₦5,000 to Wiseman” answered with “Action completed. Done. ₦5,000 sent to Wiseman.”"
            width={888}
            height={656}
            sizes="(min-width: 768px) 444px, 90vw"
            className="h-auto w-full"
          />
          </Reveal>
        </Reveal>

        <Reveal from="right" delay={100} className="order-1 text-center md:order-2 md:text-left">
          <Eyebrow className="text-lg md:text-xl">Tappi AI</Eyebrow>
          <h2 id="ai-title" className="mt-3 text-3xl font-bold tracking-tight md:text-[40px] md:leading-[1.2]">
            Say it in your language.
            <br />
            It gets done.
          </h2>
          <p className="mt-6 text-base leading-relaxed text-muted md:max-w-[550px] md:text-xl">
            Ask out loud or type, in English, Pidgin, Yorùbá, Igbo, Hausa, French or Spanish. Tappi AI sends
            the money, runs the swap or opens your terminal, then tells you what changed.
          </p>
        </Reveal>
      </div>
    </section>
  );
}
