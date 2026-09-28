import 'server-only';
import { z } from 'zod';
import { Role } from '@prisma/client';
import { db, transaction, audit, Tx, lockUsers } from './db';
import { Actor, has, requireRole } from './permissions';
import { ensure } from './errors';
import { randomToken } from './crypto';
import { validZone } from './time';
import { emailSchema } from './validation';
const id = z.string().min(1);
const ids = z.array(id).max(1000).default([]);
export const roles = z
  .array(z.enum(Role))
  .min(1)
  .refine(
    (v) => !v.includes('CONTROLLER') || v.some((r) => ['SHOP', 'SITE', 'OFFICE'].includes(r)),
    'Controllers need at least one clock-in mode.',
  );
export const userFields = z.object({
  firstName: z.string().trim().min(1).max(80),
  lastName: z.string().trim().min(1).max(80),
  email: emailSchema,
  active: z.boolean().default(true),
  earliestStart: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default('07:00'),
  timezone: z
    .string()
    .trim()
    .refine((v) => !v || validZone(v))
    .nullable()
    .optional(),
  roles,
  jobsiteIds: ids,
  taskIds: ids,
  employeeIds: ids,
  managedJobsiteIds: ids,
});
export const adminSchema = z.discriminatedUnion('entity', [
  z.object({ entity: z.literal('employees'), id: id.optional(), data: userFields }),
  z.object({
    entity: z.literal('jobsites'),
    id: id.optional(),
    data: z.object({
      name: z.string().trim().min(1).max(160),
      number: z.string().trim().min(1).max(80),
      address: z.string().max(300).optional(),
      overhead: z.boolean().default(false),
      active: z.boolean().default(true),
      taskIds: ids,
    }),
  }),
  z.object({
    entity: z.literal('tasks'),
    id: id.optional(),
    data: z.object({ name: z.string().trim().min(1).max(100), active: z.boolean().default(true) }),
  }),
  z.object({
    entity: z.literal('codes'),
    id: id.optional(),
    data: z.object({
      code: z.string().trim().min(1).max(50),
      description: z.string().trim().min(1).max(200),
      active: z.boolean().default(true),
    }),
  }),
  z.object({
    entity: z.literal('trucks'),
    id: id.optional(),
    data: z.object({ name: z.string().trim().min(1).max(100), active: z.boolean().default(true) }),
  }),
  z.object({
    entity: z.literal('mappings'),
    id: id.optional(),
    data: z
      .object({ jobsiteId: id.nullable(), taskId: id.nullable(), accountingCodeId: id })
      .refine((v) => v.jobsiteId || v.taskId, 'Select a jobsite or task.'),
  }),
  z.object({
    entity: z.literal('settings'),
    data: z.object({
      timezone: z.string().trim().refine(validZone),
      reportRecipient: z.union([emailSchema, z.literal('')]),
    }),
  }),
]);
export type AdminInput = z.infer<typeof adminSchema>;
export const safeUserSelect = {
  id: true,
  firstName: true,
  lastName: true,
  email: true,
  active: true,
  roles: true,
  earliestStart: true,
  timezone: true,
  jobs: true,
  tasks: true,
  managedEmployees: true,
  managedJobs: true,
} as const;
function sanitizeUser<T extends { passwordHash?: string | null }>(user: T) {
  const { passwordHash: _, ...safe } = user;
  void _;
  return safe;
}
export async function saveAdmin(tx: Tx, actor: Actor, input: AdminInput) {
  requireRole(actor, 'OWNER', 'ADMIN');
  if (input.entity === 'employees') {
    const before = input.id
      ? await tx.user.findUnique({
          where: { id: input.id },
          include: { jobs: true, tasks: true, managedEmployees: true, managedJobs: true },
        })
      : null;
    if (input.id) ensure(before, 'Employee not found.', 404);
    if (!has(actor, 'OWNER')) {
      ensure(
        !input.data.roles.some((r) => ['OWNER', 'ADMIN'].includes(r)) &&
          !before?.roles.some((r) => ['OWNER', 'ADMIN'].includes(r)),
        'Only an Owner can manage Owner or Admin accounts.',
        403,
      );
    }
    if (before) await lockUsers(tx, [before.id]);
    if (before && !input.data.active)
      ensure(
        !(await tx.workDay.findFirst({ where: { userId: before.id, endedAt: null } })),
        'Close this employee’s active working day before deactivating their account.',
      );
    if (
      before?.roles.includes('OWNER') &&
      (!input.data.roles.includes('OWNER') || !input.data.active)
    )
      ensure(
        await tx.user.count({
          where: { id: { not: before.id }, active: true, roles: { has: 'OWNER' } },
        }),
        'At least one active Owner is required.',
      );
    const { jobsiteIds, taskIds, employeeIds, managedJobsiteIds, ...fields } = input.data;
    const relations = {
      jobs: { create: jobsiteIds.map((jobsiteId) => ({ jobsiteId })) },
      tasks: { create: taskIds.map((taskId) => ({ taskId })) },
      managedEmployees: { create: employeeIds.map((employeeId) => ({ employeeId })) },
      managedJobs: { create: managedJobsiteIds.map((jobsiteId) => ({ jobsiteId })) },
    };
    if (input.id) {
      await tx.employeeJobsite.deleteMany({ where: { userId: input.id } });
      await tx.employeeTask.deleteMany({ where: { userId: input.id } });
      await tx.pmEmployee.deleteMany({ where: { pmId: input.id } });
      await tx.pmJobsite.deleteMany({ where: { pmId: input.id } });
    }
    const data = { ...fields, timezone: fields.timezone || null, ...relations };
    const saved = input.id
      ? await tx.user.update({ where: { id: input.id }, data, select: safeUserSelect })
      : await tx.user.create({ data, select: safeUserSelect });
    if (!saved.active) await tx.session.deleteMany({ where: { userId: saved.id } });
    await audit(
      tx,
      actor.id,
      before ? 'UPDATED' : 'CREATED',
      'User',
      saved.id,
      before ? sanitizeUser(before) : null,
      saved,
    );
    return saved;
  }
  if (input.entity === 'jobsites') {
    const before = input.id
      ? await tx.jobsite.findUnique({ where: { id: input.id }, include: { tasks: true } })
      : null;
    const { taskIds, ...fields } = input.data;
    if (input.id) await tx.jobsiteTask.deleteMany({ where: { jobsiteId: input.id } });
    const data = { ...fields, tasks: { create: taskIds.map((taskId) => ({ taskId })) } };
    const saved = input.id
      ? await tx.jobsite.update({ where: { id: input.id }, data })
      : await tx.jobsite.create({ data });
    await audit(tx, actor.id, before ? 'UPDATED' : 'CREATED', 'Jobsite', saved.id, before, {
      ...saved,
      taskIds,
    });
    return saved;
  }
  if (input.entity === 'settings') {
    const before = await tx.settings.findUnique({ where: { id: 'company' } });
    const saved = await tx.settings.upsert({
      where: { id: 'company' },
      create: { id: 'company', ...input.data },
      update: input.data,
    });
    await audit(tx, actor.id, 'UPDATED', 'Settings', 'company', before, saved);
    return saved;
  }
  // Explicit model dispatch keeps the accepted fields and permissions bounded.
  if (input.entity === 'tasks') {
    const before = input.id ? await tx.task.findUnique({ where: { id: input.id } }) : null;
    const saved = input.id
      ? await tx.task.update({ where: { id: input.id }, data: input.data })
      : await tx.task.create({ data: input.data });
    await audit(tx, actor.id, before ? 'UPDATED' : 'CREATED', 'Task', saved.id, before, saved);
    return saved;
  }
  if (input.entity === 'codes') {
    const before = input.id
      ? await tx.accountingCode.findUnique({ where: { id: input.id } })
      : null;
    const saved = input.id
      ? await tx.accountingCode.update({ where: { id: input.id }, data: input.data })
      : await tx.accountingCode.create({ data: input.data });
    await audit(
      tx,
      actor.id,
      before ? 'UPDATED' : 'CREATED',
      'AccountingCode',
      saved.id,
      before,
      saved,
    );
    return saved;
  }
  if (input.entity === 'trucks') {
    const before = input.id ? await tx.truck.findUnique({ where: { id: input.id } }) : null;
    const saved = input.id
      ? await tx.truck.update({ where: { id: input.id }, data: input.data })
      : await tx.truck.create({ data: input.data });
    await audit(tx, actor.id, before ? 'UPDATED' : 'CREATED', 'Truck', saved.id, before, saved);
    return saved;
  }
  const before = input.id
    ? await tx.accountingMapping.findUnique({ where: { id: input.id } })
    : null;
  const saved = input.id
    ? await tx.accountingMapping.update({ where: { id: input.id }, data: input.data })
    : await tx.accountingMapping.create({ data: input.data });
  await audit(
    tx,
    actor.id,
    before ? 'UPDATED' : 'CREATED',
    'AccountingMapping',
    saved.id,
    before,
    saved,
  );
  return saved;
}
export async function adminData(actor: Actor) {
  requireRole(actor, 'OWNER', 'ADMIN');
  const [employees, jobsites, tasks, codes, trucks, mappings, qrs, settings, logs] =
    await Promise.all([
      db.user.findMany({ select: safeUserSelect, orderBy: { lastName: 'asc' } }),
      db.jobsite.findMany({ include: { tasks: true }, orderBy: { name: 'asc' } }),
      db.task.findMany({ orderBy: { name: 'asc' } }),
      db.accountingCode.findMany({ orderBy: { code: 'asc' } }),
      db.truck.findMany({ orderBy: { name: 'asc' } }),
      db.accountingMapping.findMany({
        include: { jobsite: true, task: true, accountingCode: true },
      }),
      db.qrCode.findMany({ orderBy: { createdAt: 'desc' } }),
      db.settings.findUnique({ where: { id: 'company' } }),
      db.auditLog.findMany({
        orderBy: { createdAt: 'desc' },
        take: 200,
        include: { actor: { select: { firstName: true, lastName: true } } },
      }),
    ]);
  return { employees, jobsites, tasks, codes, trucks, mappings, qrs, settings, logs };
}
export const qrSchema = z
  .object({
    action: z.enum(['CREATE', 'REGENERATE', 'REVOKE']),
    id: z.string().optional(),
    label: z.string().min(1).max(100).optional(),
    type: z.enum(['SHOP', 'TRUCK']).optional(),
    truckId: z.string().optional(),
  })
  .strict();
export async function manageQr(actor: Actor, input: z.infer<typeof qrSchema>) {
  requireRole(actor, 'OWNER', 'ADMIN');
  return transaction(async (tx) => {
    let old = null;
    if (input.action !== 'CREATE') {
      ensure(input.id, 'Choose a QR code.');
      old = await tx.qrCode.findUnique({ where: { id: input.id } });
      ensure(old, 'QR code not found.', 404);
      await tx.qrCode.update({
        where: { id: old.id },
        data: { active: false, revokedAt: new Date() },
      });
      await audit(
        tx,
        actor.id,
        'QR_REVOKED',
        'QrCode',
        old.id,
        { label: old.label, active: old.active },
        { active: false },
      );
      if (input.action === 'REVOKE') return { ok: true };
    }
    const type = old?.type ?? input.type,
      truckId = old?.truckId ?? input.truckId ?? null,
      label = old?.label ?? input.label;
    ensure(type && label, 'Choose a QR type and label.');
    ensure(
      type === 'SHOP' ? !truckId : truckId,
      'Truck QR codes require a truck; shop codes do not.',
    );
    if (truckId)
      ensure(
        await tx.truck.findFirst({ where: { id: truckId, active: true } }),
        'Truck not available.',
      );
    const created = await tx.qrCode.create({
      data: { type, label, truckId, token: randomToken() },
    });
    await audit(tx, actor.id, 'QR_CREATED', 'QrCode', created.id, null, { label, type, truckId });
    return { ok: true, id: created.id };
  });
}
