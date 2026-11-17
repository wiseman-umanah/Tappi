/**
 * One-time (and re-runnable) TESTNET setup, adapted from Mint:
 *   - creates the treasury, NGN issuer and market-maker accounts with Friendbot, saves the secrets
 *     to .env.local
 *   - adds NGN + USDC trustlines and issues Tappi's test naira
 *   - buys Circle testnet USDC with XLM for the faucet and the market maker
 *   - (re)places the market maker's NGN/USDC offers at NGN_PER_USDC so swaps have liquidity
 *
 *   pnpm stellar:bootstrap
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { Asset, Keypair, Operation, type Horizon } from '@stellar/stellar-sdk';

import { env } from '../src/server/env';
import { loadAccountOrNull, readBalances } from '../src/server/stellar/accounts';
import { accountUrl, amount7, horizon, ngn, usdc, XLM } from '../src/server/stellar/config';
import { build, submitSigned } from '../src/server/stellar/submit';

const ENV_FILE = '.env.local';
const ACCOUNTS = ['TREASURY_SECRET', 'NGN_ISSUER_SECRET', 'MARKET_MAKER_SECRET'] as const;
const TARGET_NGN = { treasury: 50_000_000, maker: 200_000_000 };
const TARGET_USDC = { treasury: 1000, maker: 1000 };
const XLM_FLOOR = 2500;
const SPREAD = 0.005; // the maker quotes 0.5% either side of NGN_PER_USDC

function saveEnv(name: string, value: string) {
  let text = readFileSync(ENV_FILE, 'utf8');
  const line = new RegExp(`^${name}=.*$`, 'm');
  text = line.test(text) ? text.replace(line, `${name}=${value}`) : `${text.trimEnd()}\n${name}=${value}\n`;
  writeFileSync(ENV_FILE, text);
  process.env[name] = value;
}

async function friendbot(publicKey: string) {
  await horizon().friendbot(publicKey).call();
}

async function ensureAccount(name: (typeof ACCOUNTS)[number]) {
  let secret = process.env[name];
  if (!secret) {
    secret = Keypair.random().secret();
    saveEnv(name, secret);
    console.log(`• generated ${name} and saved it to ${ENV_FILE}`);
  }
  const keypair = Keypair.fromSecret(secret);
  if (!(await loadAccountOrNull(keypair.publicKey()))) {
    await friendbot(keypair.publicKey());
    console.log(`• funded ${name} (${keypair.publicKey()}) with Friendbot`);
  }
  return keypair;
}

const holds = (account: Horizon.AccountResponse, asset: Asset) =>
  account.balances.some(
    (b) => 'asset_code' in b && b.asset_code === asset.getCode() && b.asset_issuer === asset.getIssuer(),
  );

async function ensureTrustlines(keypair: Keypair) {
  const account = await horizon().loadAccount(keypair.publicKey());
  const missing = [ngn(), usdc()].filter((asset) => !holds(account, asset));
  if (missing.length === 0) return;
  await submitSigned(
    await build(keypair.publicKey(), missing.map((asset) => Operation.changeTrust({ asset }))),
    [keypair],
  );
  console.log(`• added ${missing.map((a) => a.getCode()).join(' + ')} trustline(s) for ${keypair.publicKey().slice(0, 6)}…`);
}

// Friendbot gives 10k XLM per new account; merging donors in tops the target up.
async function topUpXlm(keypair: Keypair, donors: number) {
  for (let i = 0; i < donors; i++) {
    const donor = Keypair.random();
    await friendbot(donor.publicKey());
    const tx = await build(donor.publicKey(), [Operation.accountMerge({ destination: keypair.publicKey() })]);
    await submitSigned(tx, [donor]);
  }
  if (donors) console.log(`• merged ${donors} Friendbot account(s) into ${keypair.publicKey().slice(0, 6)}…`);
}

async function issueNgn(issuer: Keypair, to: Keypair, target: number) {
  const { NGN } = readBalances(await horizon().loadAccount(to.publicKey()));
  const missing = target - NGN;
  if (missing <= 1) return;
  await submitSigned(
    await build(issuer.publicKey(), [
      Operation.payment({ destination: to.publicKey(), asset: ngn(), amount: amount7(missing) }),
    ]),
    [issuer],
  );
  console.log(`• issued ₦${missing.toLocaleString()} test naira to ${to.publicKey().slice(0, 6)}…`);
}

async function buyUsdc(keypair: Keypair, wantUsdc: number) {
  const balances = readBalances(await horizon().loadAccount(keypair.publicKey()));
  const missing = wantUsdc - balances.USDC;
  if (missing <= 1) return;

  // Ask the network how much XLM it costs to receive the missing USDC.
  const { records } = await horizon().strictReceivePaths([XLM], usdc(), amount7(missing)).call();
  const best = records.sort((a, b) => Number(a.source_amount) - Number(b.source_amount))[0];
  if (!best) return console.warn('! no XLM→USDC liquidity on testnet right now — use https://faucet.circle.com instead');
  const cost = Number(best.source_amount);
  if (cost > balances.XLM - XLM_FLOOR) {
    return console.warn(`! buying ${missing.toFixed(0)} USDC would cost ${cost.toFixed(0)} XLM — not enough XLM; re-run later or use faucet.circle.com`);
  }
  const tx = await build(keypair.publicKey(), [
    Operation.pathPaymentStrictReceive({
      sendAsset: XLM,
      sendMax: amount7(cost * 1.02),
      destination: keypair.publicKey(),
      destAsset: usdc(),
      destAmount: amount7(missing),
      path: [],
    }),
  ]);
  await submitSigned(tx, [keypair]);
  console.log(`• bought ${missing.toFixed(2)} USDC for ~${cost.toFixed(0)} XLM`);
}

/** Cancels the maker's old offers and posts fresh two-sided NGN/USDC quotes in one transaction. */
async function placeQuotes(maker: Keypair) {
  const rate = env.ngnPerUsdc;
  const account = await horizon().loadAccount(maker.publicKey());
  const { NGN, USDC } = readBalances(account);
  const { records } = await horizon().offers().forAccount(maker.publicKey()).limit(100).call();
  const asset = (side: Horizon.ServerApi.OfferRecord['selling']) =>
    side.asset_type === 'native' ? Asset.native() : new Asset(side.asset_code!, side.asset_issuer!);

  const ops = records.map((offer) =>
    Operation.manageSellOffer({
      selling: asset(offer.selling),
      buying: asset(offer.buying),
      amount: '0',
      price: offer.price_r,
      offerId: offer.id,
    }),
  );
  // Sells USDC for NGN: buyers pay rate × (1 + spread) naira per USDC.
  if (USDC > 1)
    ops.push(
      Operation.manageSellOffer({
        selling: usdc(),
        buying: ngn(),
        amount: amount7(USDC * 0.95),
        price: { n: Math.round(rate * (1 + SPREAD) * 1000), d: 1000 },
      }),
    );
  // Sells NGN for USDC: sellers get rate × (1 − spread) naira per USDC.
  if (NGN > 1)
    ops.push(
      Operation.manageSellOffer({
        selling: ngn(),
        buying: usdc(),
        amount: amount7(NGN * 0.95),
        price: { n: 1000, d: Math.round(rate * (1 - SPREAD) * 1000) },
      }),
    );
  if (ops.length === 0) return;
  await submitSigned(await build(maker.publicKey(), ops), [maker]);
  console.log(`• market maker quoting NGN/USDC around ₦${rate.toLocaleString()} (±${SPREAD * 100}%)`);
}

async function main() {
  const [treasury, issuer, maker] = await Promise.all(ACCOUNTS.map(ensureAccount));
  await ensureTrustlines(treasury);
  await ensureTrustlines(maker);

  const makerXlm = readBalances(await horizon().loadAccount(maker.publicKey())).XLM;
  await topUpXlm(maker, makerXlm < 15_000 ? 1 : 0);

  await issueNgn(issuer, treasury, TARGET_NGN.treasury);
  await issueNgn(issuer, maker, TARGET_NGN.maker);
  await buyUsdc(treasury, TARGET_USDC.treasury);
  await buyUsdc(maker, TARGET_USDC.maker);
  await placeQuotes(maker);

  console.log('');
  for (const [label, kp] of [['Treasury', treasury], ['NGN issuer', issuer], ['Market maker', maker]] as const) {
    const b = readBalances(await horizon().loadAccount(kp.publicKey()));
    console.log(
      `${label.padEnd(13)} ${b.XLM.toFixed(0).padStart(6)} XLM  ₦${b.NGN.toLocaleString().padEnd(12)} ${b.USDC.toFixed(2)} USDC  ${accountUrl(kp.publicKey())}`,
    );
  }
}

main().catch((error) => {
  console.error(error?.response?.data?.extras?.result_codes ?? error?.codes ?? error);
  process.exit(1);
});
