export type WaitlistState = { status: "idle" | "success" | "error"; message: string };

const JOINED = "You're on the list. We'll write when your place is ready.";

/** Form action for "Join the List": posts to the Cloudflare Pages Function in functions/api/waitlist.ts. */
export async function joinWaitlist(_previous: WaitlistState, formData: FormData): Promise<WaitlistState> {
  const body = JSON.stringify({ email: formData.get("email"), intent: formData.get("intent") });
  try {
    const response = await fetch("/api/waitlist", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    // `next dev` doesn't run Pages Functions; pretend it worked so the form can be tried locally.
    if (response.status === 404 && process.env.NODE_ENV === "development") {
      console.info("[waitlist] /api/waitlist only runs on Cloudflare (or `wrangler pages dev out`):", body);
      return { status: "success", message: JOINED };
    }
    const result = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) return { status: "error", message: result.error ?? "Something went wrong. Please try again." };
    return { status: "success", message: JOINED };
  } catch {
    return { status: "error", message: "Couldn't reach Tappi. Check your connection and try again." };
  }
}
