export const site = {
  name: "Tappi",
  title: "Tappi — Turn any phone into a card terminal & dual vault",
  description:
    "Accept contactless card taps on your phone with zero extra hardware. Settle in instant NGN to a Nigerian bank or store inflation-proof USDC. Tappi is a SoftPOS terminal and naira + USDC wallet in one app.",
  url: (process.env.NEXT_PUBLIC_SITE_URL ?? "https://tappi.app").replace(/\/$/, ""),
  locale: "en_NG",
  keywords: [
    "Tappi",
    "SoftPOS",
    "tap to pay Nigeria",
    "phone card terminal",
    "accept card payments on phone",
    "contactless payments Nigeria",
    "NFC POS",
    "USDC wallet",
    "naira wallet",
    "NGN to USDC",
    "merchant payments",
    "Tappi AI",
  ],
};

// Android APK builds live here until the app is on the Play Store and App Store.
export const appDownloadUrl =
  "https://drive.google.com/drive/folders/13C3mNMcuhRlt3qjzbrSp6CUwQLDDGDBr?usp=drive_link";

export const navLinks = [
  { label: "Features", href: "#how-it-works" },
  { label: "Dual Wallet", href: "#dual-wallet" },
  { label: "AI Assistant", href: "#tappi-ai" },
  { label: "Settlement", href: "#settlement" },
];

export const footerLinks = [
  { label: "How it works", href: "#how-it-works" },
  { label: "Wallet", href: "#dual-wallet" },
  { label: "Tappi Ai", href: "#tappi-ai" },
];

export const faqs = [
  {
    question: "Do I need a card reader?",
    answer:
      "No. Tappi uses the NFC chip already inside your Android phone, so the phone is the terminal. There is nothing to plug in and nothing to order. On phones without NFC, customers pay by scanning a QR code or typing a 6-character code.",
  },
  {
    question: "Which payments can I accept?",
    answer:
      "Contactless Visa and Mastercard cards, phones with Apple Pay or Google Pay, and Tappi wallets held to the back of your phone. Customers can also pay by QR code or by entering your charge code.",
  },
  {
    question: "Can I charge in dollars and get paid in naira?",
    answer:
      "You can charge in naira or USDC and see the other currency alongside as you type. Payments land in your payout balance, and you can swap between NGN and USDC at the live rate with one clear fee before you settle.",
  },
  {
    question: "What can the customer wallet do?",
    answer:
      "It holds a naira vault and a USDC vault, swaps between them, sends money to friends by username, and comes with a virtual contactless card so you can tap to pay straight from your phone, with daily limits you set.",
  },
  {
    question: "Is Tappi available yet?",
    answer:
      "Tappi is in early access. Join the list below, tell us whether you want to accept payments or use the wallet, and we will write when your place is ready.",
  },
];
