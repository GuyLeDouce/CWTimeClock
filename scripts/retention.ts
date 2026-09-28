// Scheduled cleanup of ephemeral rows (expired sessions, used/expired action
// tokens, stale rate-limit buckets, old punch receipts).
// Run daily as a Railway Cron Job: `npm run retention`
import { runRetention } from '../src/lib/retention';
import { db } from '../src/lib/db';
async function main() {
  const counts = await runRetention();
  console.info('Retention cleanup complete.', counts);
}
main()
  .catch((error) => {
    console.error('Retention cleanup failed.', error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
