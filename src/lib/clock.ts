import 'server-only';
import { z } from 'zod';
import { Prisma, Role, TimeSegment } from '@prisma/client';
import { db, transaction, databaseNow, lockUsers, audit, json, Tx } from './db';
import { digest } from './crypto';
import { allowedSelection, Actor, has } from './permissions';
import { ensure } from './errors';
import {
  paidStart,
  dateKey,
  nextType,
  splitAtMidnights,
  DEFAULT_ZONE,
  normalizeZone,
  validZone,
} from './time';
export const punchSchema = z
  .object({
    key: z.string().uuid(),
    qrToken: z.string().min(32).max(100),
    action: z.enum(['CLOCK_IN', 'SWITCH', 'ARRIVED', 'CLOCK_OUT']),
    expectedSegmentId: z.string().nullish(),
    mode: z.enum(['SHOP', 'SITE', 'OFFICE']).optional(),
    jobsiteId: z.string().optional(),
    taskId: z.string().nullish(),
    notes: z.string().max(2000).default(''),
    // Set by the client only for punches queued while offline: the moment the
    // employee tapped, so hours reflect the real shift once replayed.
    clientAt: z.iso.datetime({ offset: true }).optional(),
  })
  .strict();
export type Punch = z.infer<typeof punchSchema>;
export const segmentInclude = {
  jobsite: true,
  task: true,
  truck: true,
  accountingCode: true,
  user: { select: { id: true, firstName: true, lastName: true } },
  workDay: true,
  approvals: {
    include: { approver: { select: { firstName: true, lastName: true } } },
    orderBy: { createdAt: 'desc' as const },
  },
} satisfies Prisma.TimeSegmentInclude;
export async function companySettings(tx: Tx = db) {
  const settings = (await tx.settings.findUnique({ where: { id: 'company' } })) ?? {
    id: 'company',
    timezone: process.env.APP_TIMEZONE ?? DEFAULT_ZONE,
    reportRecipient: '',
  };
  return { ...settings, timezone: normalizeZone(settings.timezone) };
}
export async function suggestCode(tx: Tx, jobsiteId: string, taskId?: string | null) {
  const mappings = await tx.accountingMapping.findMany({
    where: {
      accountingCode: { active: true },
      OR: [
        { jobsiteId, taskId: taskId ?? null },
        { jobsiteId, taskId: null },
        ...(taskId ? [{ jobsiteId: null, taskId }] : []),
      ],
    },
  });
  mappings.sort(
    (a, b) =>
      Number(!!b.jobsiteId) * 2 +
      Number(!!b.taskId) -
      (Number(!!a.jobsiteId) * 2 + Number(!!a.taskId)),
  );
  return mappings[0]?.accountingCodeId ?? null;
}
async function closeSegment(tx: Tx, current: TimeSegment, actualEnd: Date, zone: string) {
  const effectiveEnd = new Date(Math.max(+actualEnd, +current.effectiveStart));
  const parts = splitAtMidnights(current.effectiveStart, effectiveEnd, zone);
  await tx.timeSegment.update({
    where: { id: current.id },
    data: {
      end: parts[0].end,
      originalEnd: actualEnd,
      status: 'PENDING_PM_APPROVAL',
      version: { increment: 1 },
    },
  });
  // A long overnight shift is split at local midnight for precise daily/weekly approval.
  for (const part of parts.slice(1)) {
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
        originalEnd: actualEnd,
        effectiveStart: part.start,
        end: part.end,
        notes: current.notes,
        accountingCodeId: current.accountingCodeId,
        status: 'PENDING_PM_APPROVAL',
      },
    });
  }
  await audit(tx, current.userId, 'SEGMENT_CLOSED', 'TimeSegment', current.id, current, {
    actualEnd,
    effectiveEnd,
    parts,
  });
  return effectiveEnd;
}
export async function punch(user: Actor, input: Punch) {
  return transaction(async (tx) => {
    await lockUsers(tx, [user.id]);
    const requestHash = digest(JSON.stringify(input));
    const receipt = await tx.punchReceipt.findUnique({ where: { key: input.key } });
    if (receipt) {
      ensure(
        receipt.userId === user.id && receipt.requestHash === requestHash,
        'This request key has already been used.',
        409,
      );
      return receipt.response;
    }
    const actor = await tx.user.findUniqueOrThrow({ where: { id: user.id } });
    ensure(actor.active, 'Account is inactive.', 403);
    const qr = await tx.qrCode.findUnique({
      where: { token: input.qrToken },
      include: { truck: true },
    });
    ensure(
      qr?.active && (!qr.truck || qr.truck.active),
      'This QR code has been revoked or is unavailable.',
      404,
    );
    const serverNow = await databaseNow(tx);
    // Offline punches carry the client tap time. Trust it within a tight
    // window (small future skew, 24h backdate limit); anything older needs a
    // manager correction so payroll stays auditable.
    let now = serverNow;
    let offlinePunch: string | null = null;
    if (input.clientAt) {
      const clientAt = new Date(input.clientAt);
      ensure(Number.isFinite(+clientAt), 'Invalid punch time.');
      ensure(clientAt <= new Date(+serverNow + 5 * 60000), 'Punch time cannot be in the future.');
      ensure(
        clientAt >= new Date(+serverNow - 24 * 3600000),
        'Offline punches older than 24 hours need a manager correction.',
      );
      now = clientAt;
      offlinePunch = input.clientAt;
    }
    const settings = await companySettings(tx);
    const zone = normalizeZone(actor.timezone, settings.timezone);
    ensure(
      validZone(zone) && validZone(settings.timezone),
      'A timezone setting needs attention. Ask an administrator to correct it before recording time.',
    );
    const current = await tx.timeSegment.findFirst({
      where: { userId: actor.id, end: null },
      include: { workDay: true, jobsite: true },
    });
    ensure(
      (current?.id ?? null) === (input.expectedSegmentId ?? null),
      'Your clock status changed. Refresh before trying again.',
      409,
    );
    let message = "You're clocked in. Have a great day!";
    if (input.action === 'CLOCK_IN') {
      ensure(!current, 'You are already clocked in.', 409);
      ensure(qr.type === 'SHOP', 'Start your day using the shop QR.');
      ensure(
        input.mode && actor.roles.includes(input.mode as Role),
        'This work mode is not available.',
        403,
      );
      ensure(input.jobsiteId, 'Please select a project.');
      await allowedSelection(
        tx,
        actor.id,
        input.jobsiteId,
        input.mode === 'SHOP' ? input.taskId : null,
        input.mode === 'SHOP',
      );
      const start = paidStart(now, actor.earliestStart, zone);
      const day = await tx.workDay.create({
        data: {
          userId: actor.id,
          date: dateKey(now, zone),
          timezone: zone,
          originalStart: now,
          paidStart: start,
        },
      });
      const type = input.mode === 'SITE' ? 'TRAVEL' : input.mode;
      const taskId = type === 'SHOP' ? input.taskId : null;
      const segment = await tx.timeSegment.create({
        data: {
          userId: actor.id,
          workDayId: day.id,
          type,
          jobsiteId: input.jobsiteId,
          taskId,
          originalStart: now,
          effectiveStart: start,
          travelOrigin: type === 'TRAVEL' ? 'SHOP' : null,
          notes: input.notes,
          accountingCodeId:
            type === 'TRAVEL' ? null : await suggestCode(tx, input.jobsiteId, taskId),
        },
      });
      await audit(tx, actor.id, 'CLOCK_IN', 'TimeSegment', segment.id, null, {
        ...segment,
        qrId: qr.id,
        offlinePunch,
      });
      if (type === 'TRAVEL')
        message =
          "You're clocked in. Please remember to scan the QR code in the truck when you arrive at the jobsite. This helps us accurately track project expenses — not track you. Have a great day!";
    } else {
      ensure(current, 'You are not clocked in.', 409);
      ensure(
        qr.type === 'SHOP' || (has(actor, 'SITE') && ['SITE', 'TRAVEL'].includes(current.type)),
        'Use the shop QR for shop and office work.',
      );
      if (input.action === 'CLOCK_OUT') {
        // Midnight splits use the workday's stored timezone so hours land on the
        // same payroll day the shift started on, even for travelling employees.
        await closeSegment(tx, current, now, current.workDay.timezone);
        await tx.workDay.update({ where: { id: current.workDayId }, data: { endedAt: now } });
        await audit(tx, actor.id, 'CLOCK_OUT', 'WorkDay', current.workDayId, null, {
          at: now,
          qrId: qr.id,
          truckId: qr.truckId ?? current.truckId,
          jobsiteId: current.jobsiteId,
          offlinePunch,
        });
        message = "You're clocked out. Enjoy the rest of your day!";
      } else {
        ensure(input.jobsiteId, 'Please select a project.');
        if (
          current.type === 'TRAVEL' ||
          (current.type === 'SITE' &&
            !(input.action === 'SWITCH' && input.mode && input.mode !== 'SITE'))
        )
          ensure(qr.type === 'TRUCK', 'Scan a truck QR to switch site work or record arrival.');
        let type = nextType(current.type, current.jobsiteId === input.jobsiteId, input.action);
        const changingMode = input.action === 'SWITCH' && input.mode && input.mode !== current.type;
        if (changingMode) {
          ensure(qr.type === 'SHOP', 'Change work modes at the shop QR.');
          ensure(actor.roles.includes(input.mode!), 'This work mode is not available.', 403);
          type = input.mode === 'SITE' ? 'TRAVEL' : input.mode!;
        }
        const taskId = ['SHOP', 'SITE'].includes(type) ? input.taskId : null;
        await allowedSelection(
          tx,
          actor.id,
          input.jobsiteId,
          taskId,
          ['SHOP', 'SITE'].includes(type),
        );
        const boundary = await closeSegment(tx, current, now, current.workDay.timezone);
        const segment = await tx.timeSegment.create({
          data: {
            userId: actor.id,
            workDayId: current.workDayId,
            type,
            jobsiteId: input.jobsiteId,
            taskId,
            truckId: qr.truckId ?? current.truckId,
            travelOrigin:
              type === 'TRAVEL' ? (current.type === 'SITE' ? current.jobsite.name : 'SHOP') : null,
            originalStart: now,
            effectiveStart: boundary,
            notes: input.notes,
            accountingCodeId:
              type === 'TRAVEL' ? null : await suggestCode(tx, input.jobsiteId, taskId),
          },
        });
        await audit(tx, actor.id, input.action, 'TimeSegment', segment.id, null, {
          ...segment,
          qrId: qr.id,
          offlinePunch,
        });
        if (qr.truckId)
          await tx.truck.update({
            where: { id: qr.truckId },
            data: { lastScanAt: now, inferredJobsiteId: input.jobsiteId },
          });
        message =
          type === 'TRAVEL'
            ? 'Travel started. Scan the truck QR when you arrive.'
            : input.action === 'ARRIVED'
              ? 'Arrival recorded. Have a great day!'
              : 'Your work has been switched.';
      }
    }
    const response = { ok: true, message, confirmedAt: now.toISOString() };
    await tx.punchReceipt.create({
      data: { key: input.key, userId: actor.id, requestHash, response: json(response) },
    });
    return response;
  });
}
