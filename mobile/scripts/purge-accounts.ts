/**
 * Closes deleted accounts whose 30-day restore window has ended and erases closed accounts past the
 * record-retention period. The server also runs this on sign-in requests; schedule this script
 * (cron) once the backend is hosted.
 *
 *   pnpm accounts:purge
 */
import { purgeAccounts } from '../src/server/account';

async function main() {
  const result = await purgeAccounts({ force: true });
  console.log(`closed ${result?.closed ?? 0} account(s), erased ${result?.erased ?? 0} past retention`);
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
