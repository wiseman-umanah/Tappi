import type { Metadata } from "next";
import Link from "next/link";
import { StatusPage } from "@/components/status-page";
import { ButtonLink } from "@/components/ui";

export const metadata: Metadata = {
  title: "Page not found",
  description: "This page doesn't exist. Head back to Tappi to turn any phone into a card terminal.",
};

export default function NotFound() {
  return (
    <StatusPage
      code="404"
      title="That tap didn't connect."
      body="The page you're looking for has moved, or never existed. Your money is safe; only this link is lost."
      toast={{ title: "Tap failed", body: "We couldn't find this page" }}
    >
      <ButtonLink href="/">Back to home</ButtonLink>
      <Link
        href="/#how-it-works"
        className="inline-flex h-12 items-center rounded-full border border-white/25 px-5 text-base font-medium transition-colors hover:border-white/60 hover:bg-white/5"
      >
        See how Tappi works
      </Link>
      <Link
        href="/#faq"
        className="inline-flex h-12 items-center rounded-full px-4 text-base font-medium text-white/80 underline-offset-4 hover:text-white hover:underline"
      >
        Read the FAQ
      </Link>
    </StatusPage>
  );
}
