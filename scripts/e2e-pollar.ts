/**
 * End-to-end check of Tappi on Pollar, without a phone: two test users sign in through Pollar's
 * real (Test mode) API with the SDK build the phone uses, against a running Tappi server, and move
 * real testnet money — wallet setup, send, pay a charge (also across currencies), swap, refund,
 * settle, a Tappi card tap. It runs the app's own Pollar code (src/lib/pollar-flow.ts).
 *
 *   PGLITE_DIR=/tmp/tappi-e2e pnpm start --port 8090      # a server on an empty database
 *   pnpm e2e one@example.com two@example.com              # asks for the two emailed codes
 *
 * Without inboxes to hand (`pnpm e2e:standin`), a stand-in plays Pollar: it answers the server's
 * sign-in check and signs with test keys made here. Everything on Tappi's side and on Stellar is
 * still real; only Pollar's sign-in and signing are replaced. The server must then be started with
 * POLLAR_SERVER_URL=http://localhost:8099.
 *
 * The two sessions are kept in .data/e2e (like the phone keeps its own in SecureStore), so a second
 * run starts without new codes — which also checks that a restarted app can still sign.
 *
 * E2E_API        the server (default http://localhost:8090/api)
 * E2E_CODE_DIR   read the codes from <dir>/a.txt and <dir>/b.txt instead of asking on the terminal
 * E2E_STATE_DIR  where the test sessions are kept (default .data/e2e)
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { createInterface } from 'node:readline/promises';

// The SDK decides how to behave from this, as React Native sets it.
Object.defineProperty(globalThis, 'navigator', { value: { product: 'ReactNative' }, configurable: true });

type Flow = ReturnType<(typeof import('../src/lib/pollar-flow'))['createPollarFlow']>;
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

const API = process.env.E2E_API ?? 'http://localhost:8090/api';
const KEY = process.env.EXPO_PUBLIC_POLLAR_KEY ?? '';
const PIN = '4321';
const STANDIN = process.env.E2E_STANDIN === '1';
const STANDIN_PORT = 8099;
const STATE_DIR = process.env.E2E_STATE_DIR ?? path.join(process.cwd(), '.data', STANDIN ? 'e2e-standin' : 'e2e');
const [emailA, emailB] = STANDIN ? ['ada@standin.test', 'bola@standin.test'] : process.argv.slice(2);

let step = 0;
const ok = (what: string, detail = '') => console.log(`  ✓ ${String(++step).padStart(2)} ${what}${detail ? ` — ${detail}` : ''}`);
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`FAILED: ${message}`);
}
const near = (a: number, b: number, slack = 0.01) => Math.abs(a - b) <= slack;

async function readCode(name: 'a' | 'b', email: string) {
  const dir = process.env.E2E_CODE_DIR;
  if (!dir) {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    const code = (await rl.question(`Code emailed to ${email}: `)).trim();
    rl.close();
    return code;
  }
  const file = path.join(dir, `${name}.txt`);
  console.log(`  … waiting for the code for user ${name.toUpperCase()} in ${file}`);
  for (let i = 0; i < 600; i++) {
    if (existsSync(file)) return readFileSync(file, 'utf8').trim();
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('No code arrived');
}

/** Stand-in for Pollar's Server API: tells Tappi's server who a stand-in token belongs to. */
function startStandinPollar() {
  const server = createServer((request, response) => {
    let raw = '';
    request.on('data', (chunk) => (raw += chunk));
    request.on('end', () => {
      const reply = (status: number, body: Json) => {
        response.writeHead(status, { 'content-type': 'application/json' });
        response.end(JSON.stringify(body));
      };
      try {
        const { token } = JSON.parse(raw) as { token: string };
        const who = JSON.parse(Buffer.from(token.replace(/^standin\./, ''), 'base64url').toString());
        reply(200, {
          code: 'SERVER_TOKEN_VERIFIED',
          success: true,
          content: { userId: who.userId, applicationId: 'standin', network: 'testnet', wallet: { type: 'internal', address: who.address }, profile: { email: who.email } },
        });
      } catch {
        reply(401, { code: 'SDK_AUTH_INVALID_TOKEN', success: false });
      }
    });
  });
  return new Promise<void>((resolve) => server.listen(STANDIN_PORT, resolve)).then(() => server.unref());
}

/** Stand-in for the Pollar SDK on the phone: already signed in, signs with a test key kept here. */
async function standinClient(email: string, secret: string) {
  const { Keypair, Networks, TransactionBuilder } = await import('@stellar/stellar-sdk');
  const keypair = Keypair.fromSecret(secret);
  const accessToken = `standin.${Buffer.from(JSON.stringify({ userId: `standin-${keypair.publicKey().slice(0, 12)}`, address: keypair.publicKey(), email })).toString('base64url')}`;
  return {
    onConfirmationRequest: () => () => {},
    getAuthState: () => ({ step: 'authenticated', verified: true, session: { token: { accessToken } } }),
    refreshWalletState: async () => 'READY',
    signTx: async (xdr: string) => {
      const tx = TransactionBuilder.fromXDR(xdr, Networks.TESTNET);
      tx.sign(keypair);
      return { status: 'signed', signedXdr: tx.toXDR() };
    },
    logout: async () => {},
  } as unknown as import('@pollar/core').PollarClient;
}

class TestUser {
  token: string | null = null;
  flow!: Flow;
  me!: Json;
  /** What the phone would keep in SecureStore: Pollar's session and device key, and Tappi's token. */
  private saved: { email?: string; api?: string; token?: string | null; secret?: string; pollar: Record<string, string> } = { pollar: {} };
  private pollar!: import('@pollar/core').PollarClient;
  constructor(
    readonly id: 'a' | 'b',
    readonly name: string,
    readonly email: string,
  ) {}

  private get file() {
    return path.join(STATE_DIR, `${this.id}.json`);
  }
  private save() {
    mkdirSync(STATE_DIR, { recursive: true });
    writeFileSync(this.file, JSON.stringify({ ...this.saved, email: this.email, api: API, token: this.token }), { mode: 0o600 });
  }

  api = async <T>(route: string, init: { method?: string; body?: unknown } = {}): Promise<T> => {
    const response = await fetch(API + route, {
      method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    const json = (await response.json().catch(() => ({}))) as Json;
    if (!response.ok) throw Object.assign(new Error(`${route} → ${response.status} ${json.error ?? ''}`), { status: response.status });
    return json as T;
  };

  async start() {
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, 'utf8'));
      // A session for another email or server is no use here.
      if (saved.email === this.email && saved.api === API) this.saved = saved;
    }
    const { createPollarFlow } = await import('../src/lib/pollar-flow');
    if (STANDIN) {
      const { Keypair } = await import('@stellar/stellar-sdk');
      this.saved.secret ??= Keypair.random().secret();
      this.save();
      this.pollar = await standinClient(this.email, this.saved.secret);
    } else {
      const { PollarClient } = await import('@pollar/core');
      // Each test user is its own "phone" with its own storage, so the two sessions don't mix.
      const storage = {
        get: async (key: string) => this.saved.pollar[key] ?? null,
        set: async (key: string, value: string) => {
          this.saved.pollar[key] = value;
          this.save();
        },
        remove: async (key: string) => {
          delete this.saved.pollar[key];
          this.save();
        },
      };
      this.pollar = new PollarClient({ apiKey: KEY, stellarNetwork: 'testnet', storage });
      await this.pollar.ready();
    }
    this.flow = createPollarFlow(async () => this.pollar, this.api);
  }

  /** Like reopening the app: both sessions come back from storage, no code needed. */
  async resume() {
    if (this.pollar.getAuthState().step !== 'authenticated' || !this.saved.token) return false;
    this.token = this.saved.token;
    try {
      this.me = await this.api<Json>('/me');
      return true;
    } catch {
      this.token = null;
      return false;
    }
  }

  signedIn(session: Json) {
    this.token = session.token;
    this.save();
  }

  /** Pollar holds the money; prepared by Tappi with the PIN, signed through Pollar, submitted by Tappi. */
  pay = async <T = Json>(route: string, body: Json) => this.flow.signAndSubmit<T>(await this.api(route, { body: { ...body, pin: PIN } }));

  async balances() {
    this.me = await this.api<Json>('/me');
    return this.me.wallet.balances as { NGN: number; USDC: number };
  }
}

async function main() {
  assert(STANDIN || KEY, 'EXPO_PUBLIC_POLLAR_KEY is not set (run with --env-file=.env.local)');
  assert(emailA && emailB && emailA !== emailB, 'usage: pnpm e2e <email-one> <email-two>');
  if (STANDIN) await startStandinPollar();
  const health = await fetch(`${API}/health`).then((r) => r.json() as Promise<Json>);
  assert(health.ok, `the Tappi server at ${API} isn't healthy: ${JSON.stringify(health).slice(0, 200)}`);
  console.log(`${STANDIN ? 'STAND-IN Pollar (no emails). ' : ''}Tappi server ${API} (${health.database}); treasury ${JSON.stringify(health.treasury.balances)}`);

  const tag = Date.now().toString(36).slice(-5);
  const a = new TestUser('a', 'A (customer)', emailA);
  const b = new TestUser('b', 'B (merchant)', emailB);
  await Promise.all([a.start(), b.start()]);

  // ── Sign-in: straight back in if this "phone" still has its sessions, else Pollar emails a code ──
  const fresh: TestUser[] = [];
  for (const user of [a, b]) {
    if (await user.resume()) ok(`${user.name} is still signed in after a restart`, 'no code needed');
    else fresh.push(user);
  }
  if (STANDIN) {
    for (const user of fresh.splice(0)) {
      user.signedIn(await user.flow.signInToTappi());
      ok(`${user.name} signed in`, 'stand-in for Pollar: no email');
    }
  }
  for (const user of fresh) await user.flow.sendSignInCode(user.email);
  if (fresh.length) {
    ok(`Pollar sent ${fresh.length} sign-in code(s)`);
    const wrong = await fresh[0].flow.verifySignInCode('000000').then(
      () => null,
      (error: Error) => error.message,
    );
    assert(wrong, 'a wrong code was accepted');
    ok('a wrong code is refused', wrong);
  }
  for (const user of fresh) {
    const session = await user.flow.verifySignInCode(await readCode(user.id, user.email));
    assert(session.token, 'no Tappi session');
    user.signedIn(session);
    ok(`${user.name} signed in`, `wallet at sign-in: ${session.wallet ? 'linked' : 'not yet'}`);
  }

  for (const user of [a, b]) {
    let me = await user.api<Json>('/me');
    if (me.needsProfile) {
      const profile = { name: user.id === 'a' ? 'Ada Test' : 'Bola Stores', handle: `${user.id === 'a' ? 'ada' : 'bola'}_${tag}`, gender: 'female' };
      me = await user.api<Json>('/me', { method: 'PATCH', body: profile });
    }
    if (!me.hasPin) await user.api('/me/pin', { body: { pin: PIN } });
    if (!me.wallet) me = await user.flow.linkWallet();
    assert(me.wallet, 'Pollar gave this user no wallet');
    const firstTime = !me.wallet.setup.welcomed;
    for (let i = 0; i < 12 && !me.wallet.setup.welcomed; i++) {
      me = await user.flow.setupWallet();
      if (!me.wallet.setup.welcomed) await new Promise((r) => setTimeout(r, 2500));
    }
    assert(me.wallet.setup.onChain && !me.wallet.setup.missing.length && me.wallet.setup.welcomed, `wallet not ready: ${JSON.stringify(me.wallet.setup)}`);
    if (firstTime) {
      assert(near(me.wallet.balances.NGN, 50_000) && near(me.wallet.balances.USDC, 25), `welcome money missing: ${JSON.stringify(me.wallet.balances)}`);
    }
    user.me = me;
    ok(`${user.name} wallet ready`, `@${me.user.handle} ${me.wallet.publicKey.slice(0, 6)}… NGN ${me.wallet.balances.NGN}, USDC ${me.wallet.balances.USDC}`);
  }
  const handleB = b.me.user.handle as string;
  const start = { a: await a.balances(), b: await b.balances() };
  /** How far each balance has moved since the start of this run. */
  const moved = async () => {
    const [na, nb] = [await a.balances(), await b.balances()];
    return { aNGN: na.NGN - start.a.NGN, aUSDC: na.USDC - start.a.USDC, bNGN: nb.NGN - start.b.NGN, bUSDC: nb.USDC - start.b.USDC };
  };

  // ── Send ──
  const sent = await a.pay('/send', { to: handleB, asset: 'NGN', amount: 1000 });
  assert(sent.tx, 'no transaction for the send');
  let m = await moved();
  assert(near(m.aNGN, -1000) && near(m.bNGN, 1000), `send balances are off: ${JSON.stringify(m)}`);
  ok('A sent ₦1,000 to B', sent.tx);

  // ── A charge in naira, paid in naira ──
  const charge1 = await b.api<Json>('/requests', { body: { amount: 500, asset: 'NGN', tag: 'Test' } });
  const paid1 = await a.pay(`/requests/${charge1.code}/pay`, { asset: 'NGN', channel: 'code' });
  assert((await b.api<Json>(`/requests/${charge1.id}`)).state === 'paid', 'charge 1 not paid');
  m = await moved();
  assert(near(m.aNGN, -1500) && near(m.bNGN, 1500), `charge 1 balances are off: ${JSON.stringify(m)}`);
  ok('A paid B’s ₦500 charge', paid1.tx);

  const again = await a.api(`/requests/${charge1.code}/pay`, { body: { pin: PIN, asset: 'NGN', channel: 'code' } }).then(
    () => null,
    (error: Error) => error.message,
  );
  assert(again, 'a paid charge could be paid again');
  ok('a paid charge can’t be paid twice', again);

  // ── A charge in USDC, paid from naira (converted on the way) ──
  const charge2 = await b.api<Json>('/requests', { body: { amount: 2, asset: 'USDC', tag: 'Test' } });
  const paid2 = await a.pay(`/requests/${charge2.code}/pay`, { asset: 'NGN', channel: 'qr' });
  m = await moved();
  assert(near(m.bUSDC, 2), `merchant didn’t get exactly 2 USDC: ${JSON.stringify(m)}`);
  assert(m.aNGN < -1500 && near(m.aUSDC, 0), `customer wasn’t charged in naira: ${JSON.stringify(m)}`);
  const cost = -m.aNGN - 1500;
  ok('A paid B’s 2 USDC charge from naira', `cost ₦${cost.toFixed(2)} · ${paid2.tx}`);

  // ── Swap ──
  const swapped = await a.pay('/swap', { from: 'USDC', amount: 5 });
  m = await moved();
  assert(swapped.received > 0 && near(m.aUSDC, -5) && near(m.aNGN, -1500 - cost + swapped.received, 0.05), `swap balances are off: ${JSON.stringify(m)}`);
  ok('A swapped 5 USDC', `got ₦${swapped.received}`);

  // ── Refund (merchant signs) ──
  const refunded = await b.pay(`/requests/${charge2.id}/refund`, {});
  assert((await b.api<Json>(`/requests/${charge2.id}`)).state === 'refunded', 'charge 2 not refunded');
  m = await moved();
  assert(near(m.bUSDC, 0) && near(m.aUSDC, -3), `refund balances are off: ${JSON.stringify(m)}`);
  ok('B refunded the 2 USDC charge', refunded.tx);

  // ── Settlement (merchant signs) ──
  const settled = await b.pay('/merchant/settle', {});
  assert(settled.amount > 0, 'nothing settled');
  ok('B settled to the bank stand-in', `₦${settled.amount}`);

  // ── Tappi card: B reads A's card, A's phone signs by itself ──
  await a.api('/card');
  const armed = await a.api<Json>('/card/arm', { body: { pin: PIN } });
  const charge3 = await b.api<Json>('/requests', { body: { amount: 250, asset: 'NGN', tag: 'Test' } });
  const read = await b.api<Json>(`/requests/${charge3.id}/tappi-card`, { body: { token: armed.link.replace('tappi://card/', '') } });
  assert(read.waiting, 'card read didn’t start a payment');
  const card = await a.api<Json>('/card');
  assert(card.pendingPayment, 'the card holder’s phone has nothing to sign');
  await a.flow.signAndSubmit(card.pendingPayment);
  assert((await b.api<Json>(`/requests/${charge3.id}`)).state === 'paid', 'card charge not paid');
  ok('Tappi card tap paid B’s ₦250 charge', `channel ${(await b.api<Json>(`/requests/${charge3.id}`)).channel}`);

  // ── A signed transaction is used once ──
  const prepared = await a.api<import('../src/lib/api-types').Prepared>('/send', { body: { to: handleB, asset: 'NGN', amount: 10, pin: PIN } });
  await a.flow.signAndSubmit(prepared);
  const replay = await a.api(`/tx/${prepared.id}`, { body: { signedXdr: prepared.xdr } }).then(
    () => null,
    (error: Error) => error.message,
  );
  assert(replay, 'a prepared transaction could be submitted twice');
  ok('a prepared transaction can’t be submitted twice', replay);

  const activity = await a.api<Json>('/activity');
  ok('activity recorded', `${activity.entries.length} entries for A`);

  console.log(`\nAll ${step} checks passed.`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(`\n${error instanceof Error ? error.message : error}`);
    process.exit(1);
  },
);
