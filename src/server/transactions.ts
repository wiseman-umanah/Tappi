import type { User } from './auth';
import type { UserTxKind } from './db/schema';
import { payTx, refundTx, settleTx } from './merchant';
import { type Handler, submitUserTx } from './stellar/user-tx';
import { sendTx, swapTx, trustTx } from './wallet';

/** What each kind of user-signed transaction does around its submit (see stellar/user-tx.ts). */
const HANDLERS: Record<UserTxKind, Handler> = {
  pay: payTx,
  send: sendTx,
  swap: swapTx,
  refund: refundTx,
  settle: settleTx,
  trust: trustTx,
};

/** POST /api/tx/:id — the phone's signed copy of a prepared transaction. */
export const submitSigned = (user: User, id: string, signedXdr: string) => submitUserTx(user, id, signedXdr, HANDLERS);
