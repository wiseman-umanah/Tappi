// Cloudflare Pages Function: POST /api/waitlist from the "Join the List" form.
// Set WAITLIST_WEBHOOK_URL in the Pages project (Settings → Variables and Secrets) to wherever
// sign-ups should go; each one is POSTed there as JSON { email, intent, source }.

type Env = { WAITLIST_WEBHOOK_URL?: string };
type Context = { request: Request; env: Env };

const intents = new Set(["customer", "merchant", "both"]);

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

export async function onRequestPost({ request, env }: Context) {
  const input = (await request.json().catch(() => null)) as { email?: unknown; intent?: unknown } | null;
  const email = String(input?.email ?? "").trim().toLowerCase();
  const intent = String(input?.intent ?? "");

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
    return json({ error: "Enter a valid email address." }, 400);
  }
  if (!intents.has(intent)) {
    return json({ error: "Tell us how you will use Tappi." }, 400);
  }
  if (!env.WAITLIST_WEBHOOK_URL) {
    return json({ error: "Sign-ups are not open yet. Please try again soon." }, 503);
  }

  try {
    const response = await fetch(env.WAITLIST_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, intent, source: "landing-page" }),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
  } catch (error) {
    console.error("[waitlist]", error);
    return json({ error: "Something went wrong. Please try again." }, 502);
  }

  return json({ ok: true });
}
