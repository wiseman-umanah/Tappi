import type { User } from './auth';
import { HttpError } from './errors';

/** How long a deleted account can be restored by signing in again (see account.ts). */
export const RESTORE_DAYS = 30;
/** CBN AML/CFT Regulations 2022: keep records at least 5 years after the relationship ends. */
export const RETENTION_YEARS = 5;

/** Throws unless money can be sent to `user` (a disabled or deleted account takes nothing in). */
export function assertCanReceive(user: Pick<User, 'status'>, who: string) {
  if (user.status === 'active') return;
  throw new HttpError(
    403,
    user.status === 'disabled' ? `${who} isn't accepting payments right now.` : `${who} is no longer on Tappi.`,
  );
}

/** For the user's own incoming money: Terminal charges and test deposits. */
export function assertOwnReceiving(user: Pick<User, 'status'>) {
  if (user.status === 'disabled') {
    throw new HttpError(403, 'Your account is disabled. Turn it back on in Profile to receive money.');
  }
}
