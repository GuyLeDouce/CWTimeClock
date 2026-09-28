import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { Prisma } from '@prisma/client';
import QRCode from 'qrcode';
import { db, transaction, audit, databaseNow } from '@/lib/db';
import {
  login,
  logout,
  sendReset,
  resetPassword,
  requireUser,
  issueToken,
  rateLimit,
} from '@/lib/auth';
import { AppError, ensure } from '@/lib/errors';
import { appUrl, sendEmail, checkEmailConfiguration } from '@/lib/email';
import { punch, punchSchema } from '@/lib/clock';
import { state, myHours, locate, info, managementOptions } from '@/lib/queries';
import { has, requireRole, requireManagement } from '@/lib/permissions';
import {
  editRecord,
  editSchema,
  approveRecords,
  approvalSchema,
  closeForgottenDay,
  closeDaySchema,
} from '@/lib/records';
import { getRecords, filterSchema, finalizeExport, exportSchema, emailExport } from '@/lib/reports';
import { adminData, adminSchema, saveAdmin, manageQr, qrSchema } from '@/lib/admin';
import { importCsv, importSchema, template, templates } from '@/lib/imports';
import { visit, visitSchema, visits } from '@/lib/visits';
import { digest } from '@/lib/crypto';
import { emailSchema } from '@/lib/validation';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
// Best-effort client IP for rate limiting. Railway's edge proxy sets
// x-forwarded-for to the real client address; the first entry is standard.
function clientIp(request: NextRequest) {
  const forwarded = request.headers.get('x-forwarded-for');
  const raw =
    forwarded?.split(',')[0]?.trim() || request.headers.get('x-real-ip')?.trim() || 'unknown';
  return raw.slice(0, 64).replace(/[^0-9a-fA-F.:]/g, '') || 'unknown';
}
// Authenticated GETs that can return thousands of rows or generate files.
const HEAVY_GETS = new Set([
  'records',
  'info',
  'admin',
  'exports',
  'export/download',
  'admin/qr-image',
]);
const credentials = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(256),
  })
  .strict();
// Compare origins structurally so a trailing slash, default port or host casing
// from a trusted proxy does not turn a legitimate same-origin request into a 403.
function normalizeOrigin(value: string | null) {
  try {
    return new URL((value ?? '').trim()).origin.toLowerCase();
  } catch {
    return '';
  }
}
async function dispatch(request: NextRequest, path: string, body: unknown) {
  const get = request.method === 'GET';
  const params = Object.fromEntries(request.nextUrl.searchParams);
  if (get && path === 'health') {
    await db.$queryRaw`SELECT 1`;
    return { ok: true };
  }
  if (!get && path === 'auth/login') {
    const input = credentials.parse(body);
    // Email-keyed limiting (inside login) stops targeted guessing; IP-keyed
    // limiting stops credential stuffing across many accounts.
    await rateLimit(`login-ip:${clientIp(request)}`, 30, 900);
    return login(input.email, input.password);
  }
  if (!get && path === 'auth/forgot') {
    await rateLimit(`forgot-ip:${clientIp(request)}`, 10, 3600);
    return sendReset(
      z.object({ email: emailSchema }).parse(body).email,
    );
  }
  if (!get && path === 'auth/reset') {
    const input = z
      .object({ token: z.string().min(32).max(100), password: z.string().min(12).max(128) })
      .parse(body);
    await rateLimit(`token:${digest(input.token)}`, 10);
    return resetPassword(input.token, input.password);
  }
  const actor = await requireUser();
  if (!get) await rateLimit(`action:${actor.id}`, 150, 60);
  if (get && HEAVY_GETS.has(path)) await rateLimit(`heavy:${actor.id}`, 60, 60);
  if (get && path === 'state') return state(actor, params.qr);
  if (get && path === 'hours') return myHours(actor);
  if (get && path === 'locate') return locate(actor);
  if (get && path === 'options') return managementOptions(actor);
  if (get && path === 'records') {
    const records = await getRecords(actor, filterSchema.parse(params));
    ensure(records.length <= 5000, 'Narrow the date range to fewer than 5,000 records.');
    return { records };
  }
  if (get && path === 'info')
    return info(
      actor,
      z.object({ from: z.string(), to: z.string(), employee: z.string().optional() }).parse(params),
    );
  if (get && path === 'admin') return adminData(actor);
  if (get && path === 'visits') return visits(actor);
  if (get && path === 'exports') {
    await requireManagement(actor, 'send');
    return {
      batches: await db.exportBatch.findMany({
        select: { id: true, createdAt: true, reason: true, _count: { select: { items: true } } },
        orderBy: { createdAt: 'desc' },
        take: 100,
      }),
    };
  }
  if (get && path === 'export/download') {
    await requireManagement(actor, 'send');
    const batch = await db.exportBatch.findUnique({
      where: { id: z.string().min(1).parse(params.id) },
    });
    ensure(batch, 'Export not found.', 404);
    return new NextResponse(batch.csv, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="cedar-winds-${batch.id}.csv"`,
      },
    });
  }
  if (get && path === 'admin/template') {
    requireRole(actor, 'OWNER', 'ADMIN');
    ensure(params.entity in templates, 'Unknown template.');
    return new NextResponse(template(params.entity as keyof typeof templates), {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="${params.entity}-template.csv"`,
      },
    });
  }
  if (get && path === 'admin/qr-image') {
    requireRole(actor, 'OWNER', 'ADMIN');
    const qr = await db.qrCode.findFirst({ where: { id: params.id, active: true } });
    ensure(qr, 'QR code not available.', 404);
    return new NextResponse(
      await QRCode.toString(`${appUrl()}/scan/${qr.token}`, { type: 'svg', margin: 3, width: 320 }),
      { headers: { 'Content-Type': 'image/svg+xml' } },
    );
  }
  if (!get && path === 'auth/logout') return logout();
  if (!get && path === 'punch') return punch(actor, punchSchema.parse(body));
  if (!get && path === 'records/close-day')
    return closeForgottenDay(actor, closeDaySchema.parse(body));
  if (!get && path === 'records/edit') return editRecord(actor, editSchema.parse(body));
  if (!get && path === 'records/approve') return approveRecords(actor, approvalSchema.parse(body));
  if (!get && path === 'exports/create') return finalizeExport(actor, exportSchema.parse(body));
  if (!get && path === 'exports/email')
    return emailExport(actor, z.object({ id: z.string() }).parse(body).id);
  if (!get && path === 'admin/save')
    return transaction((tx) => saveAdmin(tx, actor, adminSchema.parse(body)));
  if (!get && path === 'admin/qr') return manageQr(actor, qrSchema.parse(body));
  if (!get && path === 'admin/import') return importCsv(actor, importSchema.parse(body));
  if (!get && path === 'visits') return visit(actor, visitSchema.parse(body));
  if (!get && path === 'admin/password-reset') {
    requireRole(actor, 'OWNER', 'ADMIN');
    const { id } = z.object({ id: z.string() }).parse(body);
    const target = await db.user.findUnique({ where: { id } });
    ensure(target?.active, 'Active employee not found.', 404);
    ensure(
      has(actor, 'OWNER') || !has(target, 'OWNER', 'ADMIN'),
      'Only an Owner can reset this account.',
      403,
    );
    checkEmailConfiguration();
    const token = await issueToken(id, 'RESET_PASSWORD');
    // Send first: if delivery fails, the employee keeps their sessions and no
    // undeliverable token is left active. Only then revoke sessions and retire
    // any older unused reset tokens for this account.
    await sendEmail({
      to: target.email,
      subject: 'Set your Cedar Winds password',
      text: `Your administrator has requested a password reset. Set your password within 30 minutes:\n${appUrl()}/reset-password?token=${token}`,
    });
    await transaction(async (tx) => {
      const now = await databaseNow(tx);
      await tx.actionToken.updateMany({
        where: {
          userId: id,
          purpose: 'RESET_PASSWORD',
          usedAt: null,
          tokenHash: { not: digest(token) },
        },
        data: { usedAt: now },
      });
      await tx.session.deleteMany({ where: { userId: id } });
      await audit(tx, actor.id, 'ADMIN_PASSWORD_RESET', 'User', id, null, {
        sessionsRevoked: true,
      });
    });
    return { ok: true, message: 'Password email sent; existing sessions revoked.' };
  }
  if (!get && path === 'desktop/email') {
    requireRole(actor, 'OWNER', 'PM', 'CONTROLLER');
    checkEmailConfiguration();
    await rateLimit(`desktop:${actor.id}`, 4);
    const token = await issueToken(actor.id, 'DESKTOP');
    await sendEmail({
      to: actor.email,
      subject: 'Open Cedar Winds on desktop',
      text: `Open this link on your desktop within 15 minutes. Sign in with your normal account:\n${appUrl()}/desktop?token=${token}`,
    });
    return { ok: true, message: 'A desktop link has been emailed to you.' };
  }
  if (!get && path === 'desktop/open') {
    requireRole(actor, 'OWNER', 'PM', 'CONTROLLER');
    const { token } = z.object({ token: z.string().min(32).max(100) }).parse(body);
    await transaction(async (tx) => {
      const item = await tx.actionToken.findUnique({ where: { tokenHash: digest(token) } });
      const now = await databaseNow(tx);
      ensure(
        item &&
          item.userId === actor.id &&
          item.purpose === 'DESKTOP' &&
          !item.usedAt &&
          item.expiresAt > now,
        'This link is expired, used, or belongs to another account.',
      );
      await tx.actionToken.update({ where: { id: item.id }, data: { usedAt: now } });
    });
    return { ok: true };
  }
  throw new AppError(404, 'This action is not available.');
}
async function handler(request: NextRequest, context: { params: Promise<{ route: string[] }> }) {
  const requestId = crypto.randomUUID();
  let stage = 'request';
  try {
    let body: unknown;
    if (request.method !== 'GET') {
      stage = 'origin-check';
      ensure(
        normalizeOrigin(request.headers.get('origin')) === normalizeOrigin(appUrl()),
        'Request origin is not allowed.',
        403,
      );
      stage = 'request-body';
      ensure(
        request.headers.get('content-type')?.includes('application/json'),
        'JSON request required.',
        415,
      );
      ensure(
        Number(request.headers.get('content-length') ?? 0) <= 260000,
        'Request is too large.',
        413,
      );
      const text = await request.text();
      ensure(text.length <= 260000, 'Request is too large.', 413);
      try {
        body = JSON.parse(text);
      } catch {
        throw new AppError(400, 'Invalid JSON request.');
      }
    }
    stage = 'dispatch';
    const result = await dispatch(request, (await context.params).route.join('/'), body);
    const response = result instanceof NextResponse ? result : NextResponse.json(result);
    response.headers.set('Cache-Control', 'private, no-store');
    response.headers.set('X-Request-ID', requestId);
    return response;
  } catch (error) {
    let status = 500,
      message = 'Something went wrong. Please try again or contact your administrator.';
    if (error instanceof AppError) {
      status = error.status;
      message = error.message;
    } else if (error instanceof z.ZodError) {
      status = 400;
      message = error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    } else if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      ['P2002', 'P2003', 'P2004', 'P2010', 'P2034'].includes(error.code)
    ) {
      status = 409;
      message =
        'This change conflicts with an existing record. Refresh and check for duplicates or overlapping time.';
    } else if (
      // PostgreSQL exclusion-constraint violations (overlapping time segments)
      // surface as unknown engine errors, not P2002. Map them to 409 as well.
      error instanceof Prisma.PrismaClientUnknownRequestError &&
      /exclusion|23P01/i.test(error.message)
    ) {
      status = 409;
      message =
        'This change conflicts with an existing record. Refresh and check for duplicates or overlapping time.';
    } else
      console.error('Request failed', {
        requestId,
        stage,
        errorType: error instanceof Error ? error.name : 'Unknown',
        // Codes distinguish URL/configuration errors from runtime failures without
        // logging error messages that may contain credentials or request data.
        errorCode:
          error instanceof Error &&
          'code' in error &&
          typeof error.code === 'string' &&
          /^(ERR_[A-Z_]+|P\d{4})$/.test(error.code)
            ? error.code
            : undefined,
      });
    return NextResponse.json(
      { error: message, requestId },
      { status, headers: { 'Cache-Control': 'private, no-store' } },
    );
  }
}
export { handler as GET, handler as POST };
