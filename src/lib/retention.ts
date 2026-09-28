import 'server-only';
import { db } from './db';
// Retention windows for ephemeral rows. Time records, export batches and the
// audit log are payroll evidence and are never deleted by this job.
const RECEIPT_TTL_DAYS = 30;
export async function runRetention(now = new Date()) {
  const receiptCutoff = new Date(now.getTime() - RECEIPT_TTL_DAYS * 86400000);
  const [sessions, tokens, rateLimits, receipts] = await Promise.all([
    db.session.deleteMany({ where: { expiresAt: { lt: now } } }),
    db.actionToken.deleteMany({
      where: { OR: [{ usedAt: { not: null } }, { expiresAt: { lt: now } }] },
    }),
    db.rateLimit.deleteMany({ where: { resetsAt: { lt: now } } }),
    db.punchReceipt.deleteMany({ where: { createdAt: { lt: receiptCutoff } } }),
  ]);
  return {
    sessions: sessions.count,
    actionTokens: tokens.count,
    rateLimits: rateLimits.count,
    punchReceipts: receipts.count,
  };
}
