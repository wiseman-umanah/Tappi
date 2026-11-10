import { signOut } from '@/server/auth';
import { route } from '@/server/http';

export const POST = route(async (request) => {
  await signOut(request);
});
