import Link from "next/link";
import { footerLinks } from "@/lib/site";
import { Logo } from "./ui";

export function Footer() {
  return (
    <footer className="border-t border-white/10 bg-ink px-5 py-10 md:py-[50px]">
      <div className="mx-auto flex max-w-[1202px] flex-col items-center gap-6 md:flex-row md:justify-between">
        <Logo />
        <nav aria-label="Footer">
          <ul className="flex gap-8">
            {footerLinks.map((link) => (
              <li key={link.href}>
                <Link href={link.href} className="text-[15px] font-medium text-white/90 hover:text-white">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <p className="text-[15px] font-medium text-white/50">© 2026 Tappi. Powered by Macedon Labs</p>
      </div>
    </footer>
  );
}
