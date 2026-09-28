import 'server-only';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { db, transaction, audit } from './db';
import { adminSchema, saveAdmin, AdminInput } from './admin';
import { Actor, requireRole } from './permissions';
import { ensure, AppError } from './errors';
import { privateKey } from './crypto';
import { csv } from './reports';
export const importSchema = z
  .object({
    entity: z.enum(['employees', 'jobsites', 'tasks', 'codes']),
    csv: z.string().min(1).max(200000),
    previewToken: z.string().optional(),
    commit: z.boolean().default(false),
  })
  .strict();
export const templates = {
  employees: [
    ['firstName', 'lastName', 'email', 'roles', 'earliestStart'],
    ['Jane', 'Smith', 'jane@example.com', 'SHOP|SITE', '07:00'],
  ],
  jobsites: [
    ['name', 'number', 'address', 'overhead'],
    ['Example project', 'CW-001', 'Project address', 'false'],
  ],
  tasks: [['name'], ['Framing']],
  codes: [
    ['code', 'description'],
    ['5000', 'Labour'],
  ],
};
export function template(entity: keyof typeof templates) {
  return csv(templates[entity]);
}
export async function importCsv(actor: Actor, input: z.infer<typeof importSchema>) {
  requireRole(actor, 'OWNER', 'ADMIN');
  let rows: Record<string, string>[];
  try {
    rows = parse(input.csv, {
      columns: (headers: string[]) => {
        ensure(new Set(headers).size === headers.length, 'Duplicate CSV headers.');
        return headers;
      },
      skip_empty_lines: true,
      bom: true,
      trim: true,
      max_record_size: 10000,
    });
  } catch {
    throw new AppError(400, 'CSV could not be read. Check the template and quoting.');
  }
  ensure(rows.length > 0 && rows.length <= 250, 'Import between 1 and 250 rows at a time.');
  const errors: { row: number; message: string }[] = [],
    prepared: AdminInput[] = [],
    seen = new Set<string>();
  // First pass: extract and validate keys per row, keeping row numbers for errors.
  const keyed: { index: number; row: (typeof rows)[number]; key: string }[] = [];
  for (const [index, row] of rows.entries()) {
    try {
      const key = (
        input.entity === 'employees'
          ? row.email?.toLowerCase()
          : input.entity === 'jobsites'
            ? row.number
            : input.entity === 'codes'
              ? row.code
              : row.name
      )?.trim();
      ensure(key, 'Missing unique key.');
      ensure(!seen.has(key), 'Duplicate key within this file.');
      seen.add(key);
      keyed.push({ index, row, key });
    } catch (error) {
      errors.push({
        row: index + 2,
        message:
          error instanceof z.ZodError
            ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : error instanceof Error
              ? error.message
              : 'Invalid row.',
      });
    }
  }
  // Batch the duplicate-existence checks: one query per entity instead of one per row.
  const taken = new Set<string>();
  if (keyed.length > 0) {
    const keys = [...new Set(keyed.map((k) => k.key))];
    const found: string[] =
      input.entity === 'employees'
        ? (await db.user.findMany({ where: { email: { in: keys } }, select: { email: true } })).map(
            (u) => u.email,
          )
        : input.entity === 'jobsites'
          ? (
              await db.jobsite.findMany({ where: { number: { in: keys } }, select: { number: true } })
            ).map((j) => j.number)
          : input.entity === 'codes'
            ? (
                await db.accountingCode.findMany({
                  where: { code: { in: keys } },
                  select: { code: true },
                })
              ).map((c) => c.code)
            : (
                await db.task.findMany({ where: { name: { in: keys } }, select: { name: true } })
              ).map((t) => t.name);
    for (const k of found) taken.add(k);
  }
  for (const { index, row, key } of keyed) {
    try {
      const entity = input.entity;
      // Existing records are rejected explicitly: no accidental replacement of permission assignments.
      ensure(
        !taken.has(key),
        'Already exists. Edit the existing record in Admin; this import creates new records only.',
      );
      const data =
        entity === 'employees'
          ? {
              ...row,
              roles: (row.roles ?? '').split('|'),
              earliestStart: row.earliestStart || '07:00',
            }
          : entity === 'jobsites'
            ? { ...row, overhead: row.overhead === 'true' }
            : row;
      prepared.push(adminSchema.parse({ entity, data }));
    } catch (error) {
      errors.push({
        row: index + 2,
        message:
          error instanceof z.ZodError
            ? error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
            : error instanceof Error
              ? error.message
              : 'Invalid row.',
      });
    }
  }
  const previewToken = privateKey(`${actor.id}:${input.entity}:${input.csv}`);
  if (!input.commit)
    return {
      rows: prepared.map((p, i) => ({ row: i + 2, ...p.data })),
      errors,
      previewToken,
      count: rows.length,
    };
  ensure(!errors.length, 'Fix all row errors before importing.');
  ensure(input.previewToken === previewToken, 'Preview this exact file before confirming import.');
  return transaction(async (tx) => {
    for (const item of prepared) await saveAdmin(tx, actor, item);
    await audit(tx, actor.id, 'CSV_IMPORTED', 'Import', input.entity, null, {
      count: prepared.length,
    });
    return { ok: true, count: prepared.length };
  });
}
