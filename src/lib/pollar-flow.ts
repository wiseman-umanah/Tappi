import type { AuthState, PollarClient } from '@pollar/core';

import type { Me, Prepared, Session, WalletSetup } from '@/lib/api-types';

/**
 * Everything Tappi does with Pollar (https://docs.pollar.xyz), with no React Native in it so the
 * same code runs on the phone (src/lib/pollar.ts wires it up) and in the end-to-end check
 * (scripts/e2e-pollar.ts).
 *
 * Pollar signs users in (email code) and holds their Stellar wallet. Tappi never holds the key: the
 * server builds each transaction, this side signs it through Pollar, and the server checks it, pays
 * the fee and submits it (src/server/stellar/user-tx.ts).
 */
type Api = <T>(path: string, init?: { method?: string; body?: unknown }) => Promise<T>;

/** The Pollar session is gone (expired, signed out elsewhere): the user has to sign in again. */
export class PollarSessionError extends Error {
  constructor() {
    super('Your wallet session ended. Sign in again.');
  }
}

const TIMEOUT = 'That took too long. Check your connection and try again.';

export function createPollarFlow(getClient: () => Promise<PollarClient>, api: Api) {
  /** Transactions Tappi asked Pollar to sign: only these are confirmed without asking again. */
  const expected = new Set<string>();
  const attached = new WeakSet<PollarClient>();

  async function client() {
    const pollar = await getClient();
    if (!attached.has(pollar)) {
      attached.add(pollar);
      // Tappi already asked for the PIN (or the phone unlock, for the card) before it built the
      // transaction, so if the Pollar app is set to confirm signatures, that step is answered here
      // — but only for the exact transaction Tappi is signing. Anything else is refused.
      pollar.onConfirmationRequest((pending) => {
        for (const request of pending) {
          if (request.unsignedXdr && expected.has(request.unsignedXdr)) request.confirm();
          else request.reject();
        }
      });
    }
    return pollar;
  }

  /** Resolves when the sign-in reaches one of `steps`; rejects if it fails from here on. */
  function waitFor(pollar: PollarClient, steps: AuthState['step'][], timeoutMs = 45_000): Promise<AuthState> {
    return new Promise((resolve, reject) => {
      let unsubscribe: () => void = () => {};
      // The listener is first called with the state as it stands: an error left over from an
      // earlier try (a wrong code, say) isn't this attempt failing.
      let replay = true;
      const finish = (settle: () => void) => {
        clearTimeout(timer);
        queueMicrotask(() => unsubscribe());
        settle();
      };
      const timer = setTimeout(() => finish(() => reject(new Error(TIMEOUT))), timeoutMs);
      unsubscribe = pollar.onAuthStateChange((state) => {
        if (state.step === 'error') {
          if (!replay) finish(() => reject(new Error(state.message || 'Sign-in failed. Try again.')));
        } else if (steps.includes(state.step)) finish(() => resolve(state));
      });
      replay = false;
    });
  }

  async function session(pollar: PollarClient) {
    const state = pollar.getAuthState();
    if (state.step !== 'authenticated') throw new PollarSessionError();
    return state.session;
  }

  /** Pollar emails a 6-digit code to `email`. */
  async function sendSignInCode(email: string) {
    const pollar = await client();
    // A Pollar session left from an earlier sign-in (Tappi's own session ended) starts over.
    if (pollar.getAuthState().step === 'authenticated') await pollar.logout();
    pollar.cancelLogin();
    pollar.beginEmailLogin();
    await waitFor(pollar, ['entering_email']);
    const sent = waitFor(pollar, ['entering_code']);
    pollar.sendEmailCode(email);
    await sent;
  }

  /** Hands the current Pollar session to Tappi: a Tappi session, with the Pollar wallet linked. */
  async function signInToTappi(): Promise<Session> {
    const pollar = await client();
    const { token } = await session(pollar);
    return api<Session>('/auth/pollar', { body: { token: token.accessToken } });
  }

  /** Checks the code with Pollar, then signs in to Tappi with that Pollar session. */
  async function verifySignInCode(code: string): Promise<Session> {
    const pollar = await client();
    const done = waitFor(pollar, ['authenticated']);
    try {
      pollar.verifyEmailCode(code);
    } catch {
      // The sign-in attempt is gone (it failed on the network, or was cancelled): start again.
      done.catch(() => {});
      throw new Error('That sign-in attempt ended. Tap “Send a new code” and try again.');
    }
    await done;
    return signInToTappi();
  }

  /** Links the Pollar wallet to the signed-in Tappi account (when it wasn't there at sign-in). */
  async function linkWallet(): Promise<Me> {
    const pollar = await client();
    await pollar.refreshWalletState();
    const { token } = await session(pollar);
    return api<Me>('/me/wallet', { body: { token: token.accessToken } });
  }

  /**
   * Signs a transaction Tappi prepared (through Pollar, without Pollar's fee sponsorship: Tappi's
   * treasury pays) and hands it back to Tappi to submit. Returns what the server answered.
   */
  async function signAndSubmit<T>(prepared: Prepared): Promise<T> {
    const pollar = await client();
    await session(pollar);
    expected.add(prepared.xdr);
    try {
      const outcome = await pollar.signTx(prepared.xdr, { skipSponsorship: true });
      if (outcome.status === 'cosign_pending') {
        throw new Error('This wallet needs an approval Tappi doesn’t support yet. Nothing was sent.');
      }
      if (outcome.status !== 'signed') {
        // Pollar dropped the session while we were signing.
        if (pollar.getAuthState().step !== 'authenticated') throw new PollarSessionError();
        throw new Error(outcome.details || 'Your wallet didn’t sign this. Nothing was sent. Try again.');
      }
      return await api<T>(`/tx/${prepared.id}`, { body: { signedXdr: outcome.signedXdr } });
    } finally {
      expected.delete(prepared.xdr);
    }
  }

  /**
   * One step of getting the wallet ready (the server opens the account, then asks this phone to
   * sign its NGN and USDC trustlines, then pays the welcome money). Call it until
   * `me.wallet.setup.welcomed`.
   */
  async function setupWallet(): Promise<Me> {
    const step = await api<WalletSetup>('/wallet/setup', { method: 'POST' });
    if (!step.sign) return step.me;
    return (await signAndSubmit<WalletSetup>(step.sign)).me;
  }

  async function signOut() {
    await (await client()).logout();
  }

  return { sendSignInCode, verifySignInCode, signInToTappi, linkWallet, signAndSubmit, setupWallet, signOut };
}
