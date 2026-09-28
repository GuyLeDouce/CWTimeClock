import 'server-only';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { TimeSegment } from '@prisma/client';
import { transaction, lockUsers, audit, databaseNow, Tx } from './db';
import { Actor, canApprove, allowedSelection } from './permissions';
import { AppError, ensure } from './errors';
import { companySettings } from './clock';
import { dateKey, previousWeek } from './time';
export const editSchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    userId: z.string(),
    jobsiteId: z.string(),
    taskId: z.string().nullable(),
    effectiveStart: z.iso.datetime({ offset: true }),
    end: z.iso.datetime({ offset: true }),
    accountingCodeId: z.string().nullable(),
    notes: z.string().max(2000),
    reason: z.string().min(5).max(1000),
  })
  .strict();
export async function validateClosed(
  tx: Tx,
  segment: Pick<
    TimeSegment,
    'id' | 'userId' | 'effectiveStart' | 'end' | 'type' | 'accountingCodeId'
  >,
  requireCode = true,
) {
  ensure(segment.end && segment.end >= segment.effectiveStart, 'Record has an invalid time range.');
  const now = await databaseNow(tx);
  ensure(segment.end <= now, 'Future time cannot be approved or exported.');
  if (requireCode && segment.type !== 'TRAVEL')
    ensure(segment.accountingCodeId, 'Choose an accounting code before approval.');
  if (segment.end > segment.effectiveStart) {
    const conflict = await tx.timeSegment.findFirst({
      where: {
        id: { not: segment.id },
        userId: segment.userId,
        effectiveStart: { lt: segment.end },
        OR: [
          { end: null },
          {
            AND: [
              { end: { gt: segment.effectiveStart } },
              { end: { gt: tx.timeSegment.fields.effectiveStart } },
            ],
          },
        ],
      },
    });
    ensure(!conflict, 'This record overlaps another time record.');
  }
}
export async function editRecord(actor: Actor, input: z.infer<typeof editSchema>) {
  return transaction(async (tx) => {
    const existing = await tx.timeSegment.findUnique({
      where: { id: input.id },
      include: { workDay: true },
    });
    ensure(existing, 'Record not found.', 404);
    await lockUsers(tx, [existing.userId, input.userId]);
    await canApprove(tx, actor, existing.userId, existing.jobsiteId);
    await canApprove(tx, actor, input.userId, input.jobsiteId);
    ensure(
      existing.version === input.version,
      'This record changed. Refresh and review it again.',
      409,
    );
    ensure(
      existing.end && existing.workDay.endedAt,
      'Clock out the working day before correcting its records.',
    );
    ensure(
      existing.status !== 'EXPORTED',
      'Exported records are locked. Record an adjustment in accounting instead.',
    );
    const employee = await tx.user.findUnique({ where: { id: input.userId } });
    ensure(employee, 'Employee not found.');
    // Unchanged historic assignments may be inactive; changed assignments must be currently authorized.
    if (
      input.userId !== existing.userId ||
      input.jobsiteId !== existing.jobsiteId ||
      input.taskId !== existing.taskId
    )
      await allowedSelection(
        tx,
        input.userId,
        input.jobsiteId,
        input.taskId,
        ['SHOP', 'SITE'].includes(existing.type),
      );
    if (['SHOP', 'SITE'].includes(existing.type))
      ensure(input.taskId, 'Shop and site labour require a task.');
    if (['OFFICE', 'TRAVEL'].includes(existing.type))
      ensure(!input.taskId, 'Office and travel do not use task selections.');
    if (input.accountingCodeId)
      ensure(
        await tx.accountingCode.findFirst({ where: { id: input.accountingCodeId, active: true } }),
        'Accounting code is inactive.',
      );
    const start = new Date(input.effectiveStart),
      end = new Date(input.end);
    // Corrections stay within the workday's own calendar day, matching the
    // timezone the shift was recorded in rather than the company timezone.
    const dayZone = existing.workDay.timezone;
    const nextMidnight = DateTime.fromJSDate(start, { zone: dayZone })
      .startOf('day')
      .plus({ days: 1 })
      .toJSDate();
    ensure(
      end <= nextMidnight,
      'Keep a corrected line within its local calendar day; use adjacent lines for overnight work.',
    );
    const changes = {
      userId: input.userId,
      jobsiteId: input.jobsiteId,
      taskId: input.taskId,
      effectiveStart: start,
      end,
      accountingCodeId: input.accountingCodeId,
      notes: input.notes,
    };
    await validateClosed(tx, { ...existing, ...changes }, false);
    let workDayId = existing.workDayId;
    if (input.userId !== existing.userId) {
      const day = await tx.workDay.create({
        data: {
          userId: input.userId,
          date: dateKey(start, dayZone),
          timezone: dayZone,
          originalStart: existing.originalStart,
          paidStart: start,
          endedAt: end,
        },
      });
      workDayId = day.id;
    }
    const updated = await tx.timeSegment.update({
      where: { id: input.id },
      data: { ...changes, workDayId, status: 'PENDING_PM_APPROVAL', version: { increment: 1 } },
    });
    if (workDayId !== existing.workDayId) {
      // Reassignment moved the last segment off the old workday: remove the
      // now-empty day so it does not linger as an orphan.
      const remaining = await tx.timeSegment.count({ where: { workDayId: existing.workDayId } });
      if (remaining === 0) await tx.workDay.delete({ where: { id: existing.workDayId } });
    }
    await audit(
      tx,
      actor.id,
      'RECORD_CORRECTED',
      'TimeSegment',
      existing.id,
      existing,
      updated,
      input.reason,
    );
    return { ok: true };
  });
}
export const approvalSchema = z
  .object({
    records: z
      .array(z.object({ id: z.string(), version: z.number().int().positive() }))
      .min(1)
      .max(1000),
  })
  .strict();
// Approving hundreds of records in one serializable transaction exceeds the 20s
// statement timeout (each record costs several round trips). Process in small
// chunks; the per-record version checks make chunking safe under concurrency.
const APPROVAL_CHUNK = 25;
export async function approveRecords(actor: Actor, input: z.infer<typeof approvalSchema>) {
  ensure(
    new Set(input.records.map((r) => r.id)).size === input.records.length,
    'Duplicate records.',
  );
  let count = 0;
  for (let i = 0; i < input.records.length; i += APPROVAL_CHUNK) {
    try {
      count += await approveChunk(actor, input.records.slice(i, i + APPROVAL_CHUNK));
    } catch (error) {
      // Earlier chunks are already committed; report progress so the user can
      // refresh and retry the remainder instead of re-approving blindly.
      const detail = error instanceof Error ? error.message : 'Approval failed.';
      throw new AppError(409, `${detail} ${count} of ${input.records.length} records were approved.`);
    }
  }
  return { ok: true, count };
}
async function approveChunk(
  actor: Actor,
  chunk: { id: string; version: number }[],
): Promise<number> {
  return transaction(async (tx) => {
    const records = await tx.timeSegment.findMany({
      where: { id: { in: chunk.map((r) => r.id) } },
      include: { workDay: true },
    });
    ensure(records.length === chunk.length, 'Some records no longer exist.');
    await lockUsers(
      tx,
      records.map((r) => r.userId),
    );
    const settings = await companySettings(tx),
      now = await databaseNow(tx);
    const currentWeek = previousWeek(now, settings.timezone).end;
    for (const record of records) {
      await canApprove(tx, actor, record.userId, record.jobsiteId);
      ensure(
        record.version === chunk.find((r) => r.id === record.id)?.version,
        'A record changed. Refresh before approving.',
        409,
      );
      ensure(
        record.status === 'PENDING_PM_APPROVAL' || record.status === 'RECORDED',
        'Only unapproved records can be approved.',
      );
      ensure(
        record.end && record.end <= currentWeek && record.workDay.endedAt,
        'Approve completed working days from completed weeks.',
      );
      await validateClosed(tx, record);
      const approved = await tx.timeSegment.update({
        where: { id: record.id },
        data: { status: 'PM_APPROVED', version: { increment: 1 } },
      });
      await tx.approval.create({
        data: { segmentId: record.id, approverId: actor.id, segmentVersion: approved.version },
      });
      await audit(tx, actor.id, 'PM_APPROVED', 'TimeSegment', record.id, record, approved);
    }
    return records.length;
  });
}

export const closeDaySchema = z
  .object({
    id: z.string(),
    version: z.number().int().positive(),
    end: z.iso.datetime({ offset: true }),
    reason: z.string().min(10).max(1000),
  })
  .strict();
export async function closeForgottenDay(actor: Actor, input: z.infer<typeof closeDaySchema>) {
  return transaction(async (tx) => {
    const current = await tx.timeSegment.findUnique({
      where: { id: input.id },
      include: { workDay: true },
    });
    ensure(current, 'Record not found.', 404);
    await lockUsers(tx, [current.userId]);
    await canApprove(tx, actor, current.userId, current.jobsiteId);
    ensure(!current.end && !current.workDay.endedAt, 'This shift has already been closed.', 409);
    ensure(
      current.version === input.version,
      'This record changed. Refresh and review again.',
      409,
    );
    const now = await databaseNow(tx),
      end = new Date(input.end),
      dayZone = current.workDay.timezone;
    ensure(
      end >= current.originalStart && end <= now,
      'Choose an end after the scan and no later than the current time.',
    );
    const effectiveEnd = new Date(Math.max(+end, +current.effectiveStart));
    const { splitAtMidnights } = await import('./time');
    const parts = splitAtMidnights(current.effectiveStart, effectiveEnd, dayZone);
    const updated = await tx.timeSegment.update({
      where: { id: current.id },
      data: { end: parts[0].end, status: 'PENDING_PM_APPROVAL', version: { increment: 1 } },
    });
    for (const part of parts.slice(1))
      await tx.timeSegment.create({
        data: {
          userId: current.userId,
          workDayId: current.workDayId,
          type: current.type,
          jobsiteId: current.jobsiteId,
          taskId: current.taskId,
          truckId: current.truckId,
          travelOrigin: current.travelOrigin,
          originalStart: part.start,
          effectiveStart: part.start,
          end: part.end,
          notes: current.notes,
          accountingCodeId: current.accountingCodeId,
          status: 'PENDING_PM_APPROVAL',
        },
      });
    await tx.workDay.update({ where: { id: current.workDayId }, data: { endedAt: end } });
    // No original end scan is invented: originalEnd deliberately remains null.
    await audit(
      tx,
      actor.id,
      'FORGOTTEN_SHIFT_CLOSED',
      'TimeSegment',
      current.id,
      current,
      { ...updated, correctedEnd: end, parts },
      input.reason,
    );
    return { ok: true };
  });
}
