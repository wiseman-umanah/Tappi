import { activity } from '@/server/activity';
import { requireUser, route } from '@/server/http';

export const GET = route(async (request) => activity(await requireUser(request)));
