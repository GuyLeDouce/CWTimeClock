import 'server-only';
import { DateTime } from 'luxon';
import { db, databaseNow } from './db';
import { Actor, has, modes, requireManagement, segmentScope } from './permissions';
import { companySettings, segmentInclude } from './clock';
import {
  clippedMs,
  hours,
  previousWeek,
  dateRange,
  hasCurrentApproval,
  normalizeZone,
  validZone,
} from './time';
import { ensure } from './errors';
export async function state(actor: Actor, token?: string) {
  const [settings, current, jobs, tasks, qr] = await Promise.all([
    companySettings(),
    db.timeSegment.findFirst({ where: { userId: actor.id, end: null }, include: segmentInclude }),
    db.jobsite.findMany({
      where: { active: true, employees: { some: { userId: actor.id } } },
      orderBy: { name: 'asc' },
    }),
    db.task.findMany({
      where: { active: true, employees: { some: { userId: actor.id } } },
      include: { jobs: true },
      orderBy: { name: 'asc' },
    }),
    token
      ? db.qrCode.findFirst({
          where: { token, active: true, OR: [{ truckId: null }, { truck: { active: true } }] },
          select: { id: true, label: true, type: true, truckId: true },
        })
      : null,
  ]);
  if (token) ensure(qr, 'This QR code has been revoked or is not available.', 404);
  return {
    user: {
      id: actor.id,
      firstName: actor.firstName,
      lastName: actor.lastName,
      roles: actor.roles,
      email: actor.email,
      earliestStart: actor.earliestStart,
    },
    modes: modes(actor),
    current,
    jobs,
    tasks,
    qr,
    timezone: normalizeZone(actor.timezone, settings.timezone),
    companyTimezone: settings.timezone,
    serverNow: (await databaseNow(db)).toISOString(),
  };
}
export async function myHours(actor: Actor) {
  const settings = await companySettings();
  // Live totals clip open segments at "now": use the database clock, the same
  // source as punch timestamps, so app-server clock drift cannot inflate them.
  const now = await databaseNow(db);
  const zone = normalizeZone(actor.timezone, settings.timezone);
  ensure(
    validZone(zone) && validZone(settings.timezone),
    'A timezone setting needs attention. Ask an administrator to correct it before viewing hours.',
  );
  const today = DateTime.fromJSDate(now, { zone }).startOf('day').toJSDate(),
    tomorrow = DateTime.fromJSDate(today, { zone }).plus({ days: 1 }).toJSDate();
  // The personal week view follows the employee's own timezone, matching "today" above.
  const week = previousWeek(now, zone);
  const records = await db.timeSegment.findMany({
    where: {
      userId: actor.id,
      effectiveStart: { lt: tomorrow },
      OR: [{ end: { gt: week.start } }, { end: null }],
    },
    include: segmentInclude,
    orderBy: { effectiveStart: 'asc' },
  });
  const dayMs = records.reduce(
    (sum, r) => sum + clippedMs(r.effectiveStart, r.end ?? now, today, tomorrow),
    0,
  );
  const lastWeek = records.filter(
    (r) => clippedMs(r.effectiveStart, r.end ?? now, week.start, week.end) > 0,
  );
  const approved = lastWeek.filter(hasCurrentApproval);
  const groups = new Map<string, number>();
  for (const r of lastWeek) {
    const key = `${r.type} · ${r.jobsite.name}`;
    groups.set(
      key,
      (groups.get(key) ?? 0) + clippedMs(r.effectiveStart, r.end ?? now, week.start, week.end),
    );
  }
  const dayRecords = records.filter(
    (r) =>
      r.originalStart >= today || clippedMs(r.effectiveStart, r.end ?? now, today, tomorrow) > 0,
  );
  const current = records.find((r) => !r.end) ?? null;
  return {
    todayHours: hours(dayMs),
    actualStart: dayRecords[0]?.workDay.originalStart ?? null,
    paidStart: dayRecords[0]?.workDay.paidStart ?? null,
    current,
    currentHours: current ? hours(Math.max(0, +now - +current.effectiveStart)) : '0.0000',
    week,
    approvedHours: hours(
      approved.reduce(
        (s, r) => s + clippedMs(r.effectiveStart, r.end ?? now, week.start, week.end),
        0,
      ),
    ),
    pending: lastWeek.some((r) => !hasCurrentApproval(r)),
    groups: [...groups].map(([label, ms]) => ({ label, hours: hours(ms) })),
    timezone: zone,
  };
}
export async function locate(actor: Actor) {
  await requireManagement(actor, 'locate');
  const full = has(actor, 'OWNER', 'CONTROLLER');
  const employees = await db.user.findMany({
    where: {
      active: true,
      roles: { hasSome: full ? ['SHOP', 'SITE', 'OFFICE'] : ['SHOP', 'SITE'] },
      ...(full ? {} : { managers: { some: { pmId: actor.id } } }),
    },
    select: {
      id: true,
      firstName: true,
      lastName: true,
      segments: { where: { end: null }, include: segmentInclude, take: 1 },
    },
    orderBy: { lastName: 'asc' },
  });
  const allowedJobs = full ? null : await db.pmJobsite.findMany({ where: { pmId: actor.id } });
  const visible = employees.map(({ segments, ...u }) => {
    const current = segments[0];
    if (
      current &&
      !full &&
      (current.type === 'OFFICE' || !allowedJobs?.some((j) => j.jobsiteId === current.jobsiteId))
    )
      return { ...u, current: null, state: 'OUTSIDE ASSIGNMENTS' };
    return { ...u, current: current ?? null, state: current?.type ?? 'CLOCKED OUT' };
  });
  const trucks = await db.truck.findMany({
    where: {
      active: true,
      ...(!full
        ? {
            OR: [
              { inferredJobsiteId: null },
              { inferredJobsite: { managers: { some: { pmId: actor.id } } } },
            ],
          }
        : {}),
    },
    include: {
      inferredJobsite: true,
      segments: {
        where: {
          AND: [segmentScope(actor), { originalStart: { gte: new Date(Date.now() - 86400000) } }],
        },
        orderBy: { originalStart: 'desc' },
        take: 20,
        include: { user: { select: { firstName: true, lastName: true } } },
      },
    },
  });
  return {
    employees: visible,
    trucks,
    notice: 'Locations are based on employee selections and QR scans. GPS is not used.',
  };
}
export async function managementOptions(actor: Actor) {
  if (has(actor, 'OWNER', 'PM')) await requireManagement(actor, 'verify');
  else await requireManagement(actor, 'send');
  const full = has(actor, 'OWNER', 'CONTROLLER');
  const [employees, jobs, tasks, codes, pms, settings] = await Promise.all([
    db.user.findMany({
      where: full ? {} : { managers: { some: { pmId: actor.id } } },
      select: { id: true, firstName: true, lastName: true },
      orderBy: { lastName: 'asc' },
    }),
    db.jobsite.findMany({
      where: full ? {} : { managers: { some: { pmId: actor.id } } },
      orderBy: { name: 'asc' },
    }),
    db.task.findMany({ orderBy: { name: 'asc' } }),
    db.accountingCode.findMany({ where: { active: true }, orderBy: { code: 'asc' } }),
    db.user.findMany({
      where: { roles: { hasSome: ['PM', 'OWNER'] }, ...(full ? {} : { id: actor.id }) },
      select: { id: true, firstName: true, lastName: true },
    }),
    companySettings(),
  ]);
  return {
    employees,
    jobs,
    tasks,
    codes,
    pms,
    timezone: settings.timezone,
    previousWeek: previousWeek(new Date(), settings.timezone),
  };
}
export async function info(actor: Actor, params: { from: string; to: string; employee?: string }) {
  await requireManagement(actor, 'info');
  const settings = await companySettings(),
    range = dateRange(params.from, params.to, settings.timezone),
    now = new Date();
  const records = await db.timeSegment.findMany({
    where: {
      userId: params.employee || undefined,
      effectiveStart: { lt: range.end },
      OR: [{ end: null }, { end: { gt: range.start } }],
    },
    include: segmentInclude,
    orderBy: { effectiveStart: 'asc' },
    take: 20001,
  });
  ensure(records.length <= 20000, 'Narrow the date range to view this report.');
  const users = new Map<
    string,
    { id: string; name: string; ms: number; approvedMs: number; records: typeof records }
  >();
  for (const r of records) {
    const item = users.get(r.userId) ?? {
      id: r.userId,
      name: `${r.user.firstName} ${r.user.lastName}`,
      ms: 0,
      approvedMs: 0,
      records: [],
    };
    const ms = clippedMs(r.effectiveStart, r.end ?? now, range.start, range.end);
    item.ms += ms;
    if (hasCurrentApproval(r)) item.approvedMs += ms;
    item.records.push(r);
    users.set(r.userId, item);
  }
  return {
    employees: [...users.values()].map((u) => ({
      ...u,
      hours: hours(u.ms),
      approvedHours: hours(u.approvedMs),
    })),
    timezone: settings.timezone,
  };
}
