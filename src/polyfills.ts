import * as ExpoCrypto from 'expo-crypto';

// Pollar's SDK (src/lib/pollar.ts) signs every request with a key it makes on the phone, which
// needs secure random numbers. Hermes has no `crypto`, so expo-crypto provides it. Loaded first,
// from index.js, before anything imports @pollar/core.
type CryptoLike = { getRandomValues?: unknown; randomUUID?: unknown };
const scope = globalThis as unknown as { crypto?: CryptoLike };
const crypto: CryptoLike = scope.crypto ?? {};
if (typeof crypto.getRandomValues !== 'function') crypto.getRandomValues = ExpoCrypto.getRandomValues;
if (typeof crypto.randomUUID !== 'function') crypto.randomUUID = ExpoCrypto.randomUUID;
if (!scope.crypto) scope.crypto = crypto;
