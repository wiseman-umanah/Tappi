import Image from "next/image";
import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { TappiMark } from "./tappi-mark";

export function cn(...classes: Array<string | false | null | undefined>) {
  return classes.filter(Boolean).join(" ");
}

export function Logo({ className }: { className?: string }) {
  return (
    <Link
      href="/"
      aria-label="Tappi home"
      className={cn("group inline-flex items-center gap-1.5", className)}
    >
      <TappiMark className="h-auto w-[30px] transition-transform duration-500 group-hover:-rotate-12 md:w-[34px]" />
      <span className="text-xl font-medium tracking-tight">Tappi</span>
    </Link>
  );
}

export function ButtonLink({ className, ...props }: ComponentProps<typeof Link>) {
  return (
    <Link
      className={cn(
        "inline-flex h-12 items-center justify-center rounded-full bg-brand px-4 text-base font-medium whitespace-nowrap text-white transition-all duration-300 hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-[0_10px_30px_rgba(59,130,246,0.45)] active:translate-y-0",
        className,
      )}
      {...props}
    />
  );
}

export function Eyebrow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <p className={cn("text-sm font-medium tracking-wide text-brand uppercase md:text-base", className)}>
      {children}
    </p>
  );
}

export function CreditAlert({
  avatar,
  amount,
  from,
  className,
}: {
  avatar: string;
  amount: string;
  from: string;
  className?: string;
}) {
  return (
    <div
      role="img"
      aria-label={`Credit alert: you have received ${amount} from ${from}`}
      className={cn(
        "flex items-center gap-2 rounded-full bg-white py-2 pr-6 pl-2 text-left shadow-[0_12px_40px_rgba(0,0,0,0.25)] md:gap-2.5 md:py-3 md:pl-3 md:pr-8",
        className,
      )}
    >
      <Image src={avatar} alt="" width={48} height={48} className="size-8 rounded-full md:size-[38px]" />
      <div className="leading-tight">
        <p className="text-sm font-medium text-black md:text-base">Credit Alert</p>
        <p className="text-[11px] text-neutral-400 md:text-xs">
          You have received {amount} from {from}
        </p>
      </div>
    </div>
  );
}
