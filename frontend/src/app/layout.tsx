import type { Metadata, Viewport } from "next";
import localFont from "next/font/local";
import { LaunchProvider } from "@/components/launch";
import { faqs, site } from "@/lib/site";
import "./globals.css";

const creato = localFont({
  src: [
    { path: "./fonts/CreatoDisplay-Light.woff2", weight: "300", style: "normal" },
    { path: "./fonts/CreatoDisplay-Regular.woff2", weight: "400", style: "normal" },
    { path: "./fonts/CreatoDisplay-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/CreatoDisplay-Bold.woff2", weight: "700", style: "normal" },
    { path: "./fonts/CreatoDisplay-ExtraBold.woff2", weight: "800", style: "normal" },
  ],
  variable: "--font-creato",
  display: "swap",
  // Creato Display has no ₦ glyph; these system fonts do.
  fallback: ["system-ui", "Segoe UI", "Roboto", "Helvetica Neue", "Arial", "sans-serif"],
});

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: {
    default: site.title,
    template: `%s | ${site.name}`,
  },
  description: site.description,
  applicationName: site.name,
  keywords: site.keywords,
  authors: [{ name: "Macedon Labs" }],
  creator: "Macedon Labs",
  publisher: "Macedon Labs",
  category: "finance",
  alternates: { canonical: "/" },
  openGraph: {
    type: "website",
    url: "/",
    siteName: site.name,
    title: site.title,
    description: site.description,
    locale: site.locale,
  },
  twitter: {
    card: "summary_large_image",
    title: site.title,
    description: site.description,
  },
  robots: {
    index: true,
    follow: true,
    googleBot: {
      index: true,
      follow: true,
      "max-image-preview": "large",
      "max-snippet": -1,
      "max-video-preview": -1,
    },
  },
  formatDetection: { telephone: false, email: false, address: false },
};

export const viewport: Viewport = {
  themeColor: "#1a1a1a",
  colorScheme: "dark",
};

const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "Organization",
      "@id": `${site.url}/#organization`,
      name: site.name,
      url: site.url,
      logo: `${site.url}/icon.png`,
      parentOrganization: { "@type": "Organization", name: "Macedon Labs" },
    },
    {
      "@type": "WebSite",
      "@id": `${site.url}/#website`,
      url: site.url,
      name: site.name,
      description: site.description,
      publisher: { "@id": `${site.url}/#organization` },
      inLanguage: "en",
    },
    {
      "@type": "SoftwareApplication",
      name: site.name,
      description: site.description,
      applicationCategory: "FinanceApplication",
      operatingSystem: "Android, iOS",
      url: site.url,
      publisher: { "@id": `${site.url}/#organization` },
      offers: { "@type": "Offer", price: "0", priceCurrency: "NGN" },
    },
    {
      "@type": "FAQPage",
      mainEntity: faqs.map((faq) => ({
        "@type": "Question",
        name: faq.question,
        acceptedAnswer: { "@type": "Answer", text: faq.answer },
      })),
    },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" data-loading="" className={`${creato.variable} antialiased`}>
      <body className="min-h-dvh bg-ink font-sans text-white">
        <script
          type="application/ld+json"
          dangerouslySetInnerHTML={{
            __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c"),
          }}
        />
        <noscript>
          <style>{"#splash{display:none}"}</style>
        </noscript>
        <LaunchProvider>{children}</LaunchProvider>
      </body>
    </html>
  );
}
