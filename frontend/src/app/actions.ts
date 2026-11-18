"use server";

export type WaitlistState = { status: "idle" | "success" | "error"; message: string };

const intents = new Set(["customer", "merchant", "both"]);

export async function joinWaitlist(_previous: WaitlistState, formData: FormData): Promise<WaitlistState> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  const intent = String(formData.get("intent") ?? "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return { status: "error", message: "Enter a valid email address." };
  }
  if (!intents.has(intent)) {
    return { status: "error", message: "Tell us how you will use Tappi." };
  }

  // Sign-ups are forwarded to whatever collects them (form service, CRM, the Tappi API)
  // once WAITLIST_WEBHOOK_URL is set.
  const webhook = process.env.WAITLIST_WEBHOOK_URL;
  if (!webhook) {
    if (process.env.NODE_ENV === "production") {
      return { status: "error", message: "Sign-ups are not open yet. Please try again soon." };
    }
    console.info("[waitlist] WAITLIST_WEBHOOK_URL is not set; sign-up not stored:", { email, intent });
    return { status: "success", message: "You're on the list. We'll write when your place is ready." };
  }

  try {
    const response = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, intent, source: "landing-page" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
  } catch (error) {
    console.error("[waitlist]", error);
    return { status: "error", message: "Something went wrong. Please try again." };
  }

  return { status: "success", message: "You're on the list. We'll write when your place is ready." };
}
