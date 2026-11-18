import { Reveal } from "./reveal";
import { Eyebrow } from "./ui";

const rows = [
  { label: "Destination", bank: "Your Nigerian bank account", crypto: "Your self-custodial wallet" },
  { label: "Arrives", bank: "Within about 30 seconds", crypto: "About a minute" },
  { label: "Fee", bank: "0.5%, minimum ₦50", crypto: "$0.25 flat" },
  { label: "Accepting fee", bank: "1.4% per tap", crypto: "0.5% per tap" },
];

function Chip({ children, tone }: { children: string; tone: "green" | "blue" }) {
  const toneClass =
    tone === "green" ? "border-success/60 bg-success/15 text-success" : "border-brand/80 bg-brand/25 text-brand";
  return (
    <span className={`inline-flex h-6 items-center rounded-full border px-2.5 text-[9px] font-medium ${toneClass}`}>
      {children}
    </span>
  );
}

export function Settlement() {
  return (
    <section id="settlement" aria-labelledby="settlement-title" className="bg-navy px-5 py-20 md:pt-[98px] md:pb-[118px]">
      <div className="mx-auto max-w-[1240px]">
        <Reveal>
        <Eyebrow className="text-sm md:text-sm">Instant settlement</Eyebrow>
        <h2 id="settlement-title" className="mt-2 text-3xl font-bold tracking-tight md:text-[40px]">
          Your money, where you want it.
        </h2>
        <p className="mt-3 max-w-[590px] text-[15px] leading-relaxed text-white/90">
          Move your payout balance to a Nigerian bank account or to a wallet you control. You pick the
          destination each time.
        </p>
        </Reveal>

        <div className="mt-10 grid gap-4 md:hidden">
          {(
            [
              { key: "bank", chip: "NGN", tone: "green", heading: "LOCAL BANK" },
              { key: "crypto", chip: "USDC", tone: "blue", heading: "CRYPTO WALLET" },
            ] as const
          ).map((option, index) => (
            <Reveal key={option.key} delay={index * 120} className="rounded-3xl border border-navy-line p-5">
              <p className="flex items-center gap-2 text-sm font-medium">
                <Chip tone={option.tone}>{option.chip}</Chip> {option.heading}
              </p>
              <dl className="mt-4 grid gap-3 text-[15px]">
                {rows.map((row) => (
                  <div key={row.label} className="flex justify-between gap-4 border-t border-navy-line pt-3">
                    <dt className="text-white/70">{row.label}</dt>
                    <dd className="text-right">{row[option.key]}</dd>
                  </div>
                ))}
              </dl>
            </Reveal>
          ))}
        </div>

        <Reveal from="zoom" className="mt-[50px] hidden rounded-3xl border border-navy-line md:block">
          <table className="w-full border-collapse text-left text-[15px]">
            <caption className="sr-only">Settlement options compared</caption>
            <thead>
              <tr className="h-16">
                <td className="w-[29%]" />
                <th scope="col" className="w-[26%] font-medium">
                  <span className="flex items-center gap-2 text-sm">
                    <Chip tone="green">NGN</Chip> LOCAL BANK
                  </span>
                </th>
                <th scope="col" className="font-medium">
                  <span className="flex items-center gap-2 text-sm">
                    <Chip tone="blue">USDC</Chip> CRYPTO WALLET
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <Reveal as="tr" key={row.label} delay={200 + index * 110} className="h-16 border-t border-navy-line transition-colors hover:bg-white/[0.03]">
                  <th scope="row" className="pl-5 font-normal">
                    {row.label}
                  </th>
                  <td>{row.bank}</td>
                  <td className="pr-5">{row.crypto}</td>
                </Reveal>
              ))}
            </tbody>
          </table>
        </Reveal>
      </div>
    </section>
  );
}
