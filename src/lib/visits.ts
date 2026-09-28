import 'server-only';
import { z } from 'zod';
import { db, transaction, lockUsers, databaseNow, audit } from './db';
import { Actor, requireRole } from './permissions';
import { ensure } from './errors';
export async function visits(actor: Actor) {
  requireRole(actor, 'OWNER');
  return {
    visits: await db.siteVisit.findMany({
      include: { jobsite: true, user: { select: { firstName: true, lastName: true } } },
      orderBy: { start: 'desc' },
      take: 500,
    }),
    jobs: await db.jobsite.findMany({
      where: { active: true, overhead: false },
      orderBy: { name: 'asc' },
    }),
  };
}
export const visitSchema = z
  .object({
    action: z.enum(['START', 'END']),
    jobsiteId: z.string().optional(),
    notes: z.string().max(2000).default(''),
  })
  .strict();
export async function visit(actor: Actor, input: z.infer<typeof visitSchema>) {
  requireRole(actor, 'OWNER');
  return transaction(async (tx) => {
    await lockUsers(tx, [actor.id]);
    const now = await databaseNow(tx);
    const current = await tx.siteVisit.findFirst({ where: { userId: actor.id, end: null } });
    if (input.action === 'START') {
      ensure(!current, 'End your current visit first.');
      ensure(input.jobsiteId, 'Select a project.');
      ensure(
        await tx.jobsite.findFirst({
          where: { id: input.jobsiteId, active: true, overhead: false },
        }),
        'Project is not available.',
      );
      const result = await tx.siteVisit.create({
        data: { userId: actor.id, jobsiteId: input.jobsiteId, start: now, notes: input.notes },
      });
      await audit(tx, actor.id, 'VISIT_STARTED', 'SiteVisit', result.id, null, result);
      return result;
    }
    ensure(current, 'No active site visit.');
    const result = await tx.siteVisit.update({ where: { id: current.id }, data: { end: now } });
    await audit(tx, actor.id, 'VISIT_ENDED', 'SiteVisit', result.id, current, result);
    return result;
  });
}
