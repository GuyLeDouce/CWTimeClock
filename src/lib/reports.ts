import 'server-only';
import { Prisma } from '@prisma/client';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { db, transaction, audit, lockUsers, databaseNow } from './db';
import { Actor, has, requireManagement, segmentScope } from './permissions';
import { companySettings, segmentInclude } from './clock';
import { dateRange, hours, durationMs, previousWeek } from './time';
import { ensure } from './errors';
import { validateClosed } from './records';
import { sendEmail } from './email';
export const filterSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  employee: z.string().optional(),
  jobsite: z.string().optional(),
  task: z.string().optional(),
  code: z.string().optional(),
  status: z.enum(['RECORDED', 'PENDING_PM_APPROVAL', 'PM_APPROVED', 'EXPORTED']).optional(),
  pm: z.string().optional(),
  type: z.enum(['SHOP', 'SITE', 'OFFICE', 'TRAVEL']).optional(),
});
export type Filters = z.infer<typeof filterSchema>;
export async function recordFilter(
  actor: Actor,
  filters: Filters,
): Promise<Prisma.TimeSegmentWhereInput> {
  const settings = await companySettings();
  const defaults = previousWeek(await databaseNow(db), settings.timezone);
  ensure(!!filters.from === !!filters.to, 'Select both a start and an end date.');
  const range =
    filters.from && filters.to ? dateRange(filters.from, filters.to, settings.timezone) : defaults;
  return {
    AND: [
      segmentScope(actor),
      {
        effectiveStart: { gte: range.start, lt: range.end },
        userId: filters.employee || undefined,
        jobsiteId: filters.jobsite || undefined,
        taskId: filters.task || undefined,
        accountingCodeId: filters.code || undefined,
        status: filters.status,
        type: filters.type,
        ...(filters.pm ? { approvals: { some: { approverId: filters.pm } } } : {}),
      },
    ],
  };
}
export async function getRecords(actor: Actor, filters: Filters) {
  await requireManagement(actor, has(actor, 'OWNER', 'PM') ? 'verify' : 'send');
  return db.timeSegment.findMany({
    where: await recordFilter(actor, filters),
    include: segmentInclude,
    orderBy: [{ user: { lastName: 'asc' } }, { effectiveStart: 'asc' }],
    take: 5001,
  });
}
export function csvCell(value: unknown) {
  let text = String(value ?? '');
  if (/^[\s]*[=+\-@\t\r\n]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
export function csv(rows: unknown[][]) {
  return '\uFEFF' + rows.map((row) => row.map(csvCell).join(',')).join('\r\n') + '\r\n';
}
export const exportSchema = z
  .object({
    records: z
      .array(z.object({ id: z.string(), version: z.number().int().positive() }))
      .min(1)
      .max(1000),
    overrideReason: z.string().max(1000).optional(),
  })
  .strict();
type ExportRecord = Prisma.TimeSegmentGetPayload<{ include: typeof segmentInclude }>;
// Exporting hundreds of records in one serializable transaction exceeds the 20s
// statement timeout. Validate in small chunks, then create the batch in a final
// lightweight transaction that re-verifies nothing changed in between.
const EXPORT_CHUNK = 25;
async function validateExportChunk(
  actor: Actor,
  chunk: { id: string; version: number }[],
  overrideReason: string | undefined,
  weekStart: Date,
): Promise<ExportRecord[]> {
  return transaction(async (tx) => {
    const records = await tx.timeSegment.findMany({
      where: { id: { in: chunk.map((r) => r.id) } },
      include: segmentInclude,
      orderBy: [{ user: { lastName: 'asc' } }, { effectiveStart: 'asc' }],
    });
    ensure(records.length === chunk.length, 'Some records no longer exist.');
    await lockUsers(
      tx,
      records.map((r) => r.userId),
    );
    for (const record of records) {
      ensure(
        record.version === chunk.find((r) => r.id === record.id)?.version,
        'A record changed. Refresh before exporting.',
        409,
      );
      ensure(
        record.status !== 'EXPORTED',
        'A record has already been exported. Download its existing batch.',
        409,
      );
      ensure(
        record.status === 'PM_APPROVED' ||
          (has(actor, 'OWNER') && (overrideReason?.trim().length ?? 0) >= 10),
        'Only PM-approved records can be exported.',
      );
      ensure(
        record.end && record.end <= weekStart && record.workDay.endedAt,
        'Export completed working days from completed weeks.',
      );
      await validateClosed(tx, record);
    }
    return records;
  });
}
export async function finalizeExport(actor: Actor, input: z.infer<typeof exportSchema>) {
  await requireManagement(actor, 'send');
  ensure(
    new Set(input.records.map((r) => r.id)).size === input.records.length,
    'Duplicate export records.',
  );
  const settings = await companySettings();
  const weekStart = previousWeek(await databaseNow(db), settings.timezone).end;
  const validated: ExportRecord[] = [];
  for (let i = 0; i < input.records.length; i += EXPORT_CHUNK)
    validated.push(
      ...(await validateExportChunk(
        actor,
        input.records.slice(i, i + EXPORT_CHUNK),
        input.overrideReason,
        weekStart,
      )),
    );
  validated.sort(
    (a, b) =>
      a.user.lastName.localeCompare(b.user.lastName) || +a.effectiveStart - +b.effectiveStart,
  );
  return transaction(async (tx) => {
    const fresh = await tx.timeSegment.findMany({
      where: { id: { in: validated.map((r) => r.id) } },
      select: { id: true, version: true, status: true },
    });
    ensure(fresh.length === validated.length, 'Some records no longer exist.');
    for (const f of fresh) {
      const original = validated.find((r) => r.id === f.id)!;
      ensure(
        f.version === original.version && f.status === original.status,
        'A record changed. Refresh before exporting.',
        409,
      );
    }
    const rows: unknown[][] = [
      [
        'Employee',
        'Employee ID',
        'Date',
        'Jobsite',
        'Project number',
        'Task',
        'Work type',
        'Start',
        'End',
        'Labour hours',
        'Travel hours',
        'Total hours',
        'Duration milliseconds',
        'Accounting code',
        'Notes',
        'PM approver',
        'Approval timestamp',
        'Record ID',
        'Owner override reason',
      ],
    ];
    for (const r of validated) {
      const duration = durationMs(r.effectiveStart, r.end!);
      const approval = r.approvals.find((a) => a.segmentVersion === r.version);
      // Render dates in the workday's stored timezone so each row shows the
      // payroll day the hours were recorded against.
      const rowZone = r.workDay.timezone;
      rows.push([
        `${r.user.firstName} ${r.user.lastName}`,
        r.userId,
        DateTime.fromJSDate(r.effectiveStart, { zone: rowZone }).toISODate(),
        r.jobsite.name,
        r.jobsite.number,
        r.task?.name,
        r.type,
        DateTime.fromJSDate(r.effectiveStart, { zone: rowZone }).toISO(),
        DateTime.fromJSDate(r.end!, { zone: rowZone }).toISO(),
        r.type === 'TRAVEL' ? '0.0000' : hours(duration),
        r.type === 'TRAVEL' ? hours(duration) : '0.0000',
        hours(duration),
        duration,
        r.accountingCode?.code,
        r.notes,
        approval ? `${approval.approver.firstName} ${approval.approver.lastName}` : '',
        approval?.createdAt.toISOString(),
        r.id,
        r.status !== 'PM_APPROVED' ? input.overrideReason : '',
      ]);
    }
    const batch = await tx.exportBatch.create({
      data: {
        actorId: actor.id,
        csv: csv(rows),
        reason: input.overrideReason,
        items: { create: validated.map((r) => ({ segmentId: r.id })) },
      },
    });
    await tx.timeSegment.updateMany({
      where: { id: { in: validated.map((r) => r.id) } },
      data: { status: 'EXPORTED' },
    });
    await audit(
      tx,
      actor.id,
      'ACCOUNTING_EXPORT',
      'ExportBatch',
      batch.id,
      validated.map((r) => ({ id: r.id, status: r.status, version: r.version })),
      { recordIds: validated.map((r) => r.id) },
      input.overrideReason,
    );
    return { id: batch.id, count: validated.length };
  });
}
export async function emailExport(actor: Actor, batchId: string) {
  await requireManagement(actor, 'send');
  const settings = await companySettings();
  ensure(settings.reportRecipient, 'Set the accounting report email address in Admin first.');
  const batch = await db.exportBatch.findUnique({ where: { id: batchId } });
  ensure(batch, 'Export not found.', 404);
  await sendEmail({
    to: settings.reportRecipient,
    subject: 'Cedar Winds approved time report',
    text: `Attached is accounting export ${batch.id}, created ${batch.createdAt.toISOString()}.`,
    attachments: [{ filename: `cedar-winds-${batch.id}.csv`, content: batch.csv }],
  });
  await audit(db, actor.id, 'REPORT_EMAILED', 'ExportBatch', batch.id, null, {
    to: settings.reportRecipient,
  });
  return { ok: true, message: `Report emailed to ${settings.reportRecipient}.` };
}
