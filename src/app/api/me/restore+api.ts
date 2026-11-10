import { restoreAccount } from '@/server/account';
import { requireUser, route } from '@/server/http';
import { me } from '@/server/wallet';

/** POST /api/me/restore — undoes a deletion within the restore window. */
export const POST = route(async (request) => me(await restoreAccount(await requireUser(request, { restoring: true }))));
