import { Assistant } from "@/components/assistant";
import { BackToTop } from "@/components/back-to-top";
import { DualWallet } from "@/components/dual-wallet";
import { EarlyAccess } from "@/components/early-access";
import { Faq } from "@/components/faq";
import { Footer } from "@/components/footer";
import { Hero } from "@/components/hero";
import { HowItWorks } from "@/components/how-it-works";
import { Navbar } from "@/components/navbar";
import { Settlement } from "@/components/settlement";

export default function Home() {
  return (
    <>
      <div aria-hidden="true" className="scroll-progress fixed inset-x-0 top-0 z-[60] hidden h-[3px] bg-linear-to-r from-brand via-violet to-brand" />
      <Navbar />
      <main id="main">
        <Hero />
        <HowItWorks />
        <DualWallet />
        <Assistant />
        <Settlement />
        <Faq />
        <EarlyAccess />
      </main>
      <Footer />
      <BackToTop />
    </>
  );
}
