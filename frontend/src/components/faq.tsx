import { faqs } from "@/lib/site";
import { Reveal } from "./reveal";
import { Eyebrow } from "./ui";

export function Faq() {
  return (
    <section id="faq" aria-labelledby="faq-title" className="bg-ink px-5 pt-20 md:pt-[46px]">
      <div className="mx-auto max-w-[880px]">
        <Reveal as="header" className="text-center">
          <Eyebrow className="normal-case md:text-sm">Questions</Eyebrow>
          <h2 id="faq-title" className="mt-2 text-3xl font-bold tracking-tight md:text-[40px]">
            Before you Tap
          </h2>
        </Reveal>

        <div className="mt-6 flex flex-col gap-2.5">
          {faqs.map((faq, index) => (
            <Reveal key={faq.question} delay={index * 90}>
            <details
              name="faq"
              className="group rounded-[24px] border border-navy-line transition-colors open:bg-navy/40 hover:border-brand/70"
            >
              <summary className="flex min-h-[46px] cursor-pointer list-none items-center justify-between gap-4 px-6 py-2.5 text-[15px] md:pl-10 [&::-webkit-details-marker]:hidden">
                {faq.question}
                <svg
                  className="size-4 shrink-0 text-brand transition-transform duration-300 group-open:rotate-45"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <path d="M8 1.5v13M1.5 8h13" />
                </svg>
              </summary>
              <p className="px-6 pb-5 text-sm leading-relaxed text-white/70 md:px-10">{faq.answer}</p>
            </details>
            </Reveal>
          ))}
        </div>
      </div>
    </section>
  );
}
