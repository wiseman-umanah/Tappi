"use client";

import Link from "next/link";
import { useEffect } from "react";
import { StatusPage } from "@/components/status-page";

export default function Error({ error, retry }: { error: unknown; retry: () => void }) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <StatusPage
      code="Oops"
      title="Something went wrong on our side."
      body="It's not you. Give it another try, and if it keeps happening, come back in a minute."
      toast={{ title: "Tap interrupted", body: "Let's try that again" }}
    >
      <button
        type="button"
        onClick={() => retry()}
        className="inline-flex h-12 items-center rounded-full bg-brand px-5 text-base font-medium transition-all duration-300 hover:-translate-y-0.5 hover:bg-brand-hover hover:shadow-[0_10px_30px_rgba(59,130,246,0.45)]"
      >
        Try again
      </button>
      <Link
        href="/"
        className="inline-flex h-12 items-center rounded-full border border-white/25 px-5 text-base font-medium transition-colors hover:border-white/60 hover:bg-white/5"
      >
        Back to home
      </Link>
    </StatusPage>
  );
}
