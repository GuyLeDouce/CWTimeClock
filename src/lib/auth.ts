import 'server-only';
import { cookies } from 'next/headers';
import { db, transaction, databaseNow, audit } from './db';
import { digest, privateKey, randomToken, hashPassword, verifyPassword } from './crypto';
import { AppError, ensure } from './errors';
import { sendEmail, appUrl } from './email';
import { TokenPurpose } from '@prisma/client';
export const SESSION_COOKIE =
  process.env.NODE_ENV === 'production' ? '__Host-cw-session' : 'cw-session';
export async function currentUser() {
  const raw = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!raw) return null;
  const session = await db.session.findUnique({
    where: { tokenHash: digest(raw) },
    include: { user: true },
  });
  return session && session.expiresAt > new Date() && session.user.active ? session.user : null;
}
export async function requireUser() {
  const user = await currentUser();
  if (!user) throw new AppError(401, 'Please sign in again.');
  return user;
}
export async function rateLimit(key: string, max = 8, windowSeconds = 900) {
  const safeKey = privateKey(key);
  const rows = await db.$queryRaw<{ count: number }[]>`
    INSERT INTO "RateLimit" ("key","count","resetsAt") VALUES (${safeKey},1,clock_timestamp() + ${windowSeconds} * interval '1 second')
    ON CONFLICT ("key") DO UPDATE SET "count" = CASE WHEN "RateLimit"."resetsAt" <= clock_timestamp() THEN 1 ELSE "RateLimit"."count" + 1 END,
    "resetsAt" = CASE WHEN "RateLimit"."resetsAt" <= clock_timestamp() THEN clock_timestamp() + ${windowSeconds} * interval '1 second' ELSE "RateLimit"."resetsAt" END RETURNING "count"`;
  ensure(rows[0].count <= max, 'Too many attempts. Please wait and try again.', 429);
}
export async function login(email: string, password: string) {
  await rateLimit(`login:${email}`);
  const user = await db.user.findUnique({ where: { email } });
  const valid = await verifyPassword(password, user?.passwordHash ?? null);
  ensure(valid && user?.active, 'Email or password is incorrect.', 401);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + 30 * 86400000);
  await db.session.create({ data: { userId: user.id, tokenHash: digest(token), expiresAt } });
  (await cookies()).set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    expires: expiresAt,
  });
  return { ok: true };
}
export async function logout() {
  const jar = await cookies();
  const token = jar.get(SESSION_COOKIE)?.value;
  if (token) await db.session.deleteMany({ where: { tokenHash: digest(token) } });
  jar.delete(SESSION_COOKIE);
  return { ok: true };
}
export async function issueToken(userId: string, purpose: TokenPurpose) {
  const token = randomToken();
  await db.actionToken.create({
    data: {
      userId,
      purpose,
      tokenHash: digest(token),
      expiresAt: new Date(Date.now() + (purpose === 'DESKTOP' ? 15 : 30) * 60000),
    },
  });
  return token;
}
export async function sendReset(email: string) {
  await rateLimit(`reset:${email}`, 4);
  const user = await db.user.findUnique({ where: { email } });
  if (user?.active) {
    const token = await issueToken(user.id, 'RESET_PASSWORD');
    try {
      await sendEmail({
        to: user.email,
        subject: 'Set your Cedar Winds password',
        text: `Set your password within 30 minutes:\n${appUrl()}/reset-password?token=${token}\n\nIf you did not request this, ignore this email.`,
      });
    } catch {
      console.error('Password reset email delivery failed.');
    }
  } else {
    // Do comparable work for unknown addresses so response timing does not
    // reveal whether an account exists. Not a perfect mask for SMTP latency,
    // but it removes the trivial fast-vs-slow signal.
    await hashPassword(randomToken());
  }
  return { message: 'If this email has an active account, a password link has been sent.' };
}
export async function resetPassword(token: string, password: string) {
  const encoded = await hashPassword(password);
  await transaction(async (tx) => {
    const item = await tx.actionToken.findUnique({
      where: { tokenHash: digest(token) },
      include: { user: true },
    });
    const now = await databaseNow(tx);
    ensure(
      item &&
        item.purpose === 'RESET_PASSWORD' &&
        !item.usedAt &&
        item.expiresAt > now &&
        item.user.active,
      'This password link has expired or has already been used.',
    );
    const changed = await tx.actionToken.updateMany({
      where: { id: item.id, usedAt: null },
      data: { usedAt: now },
    });
    ensure(changed.count === 1, 'This link has already been used.');
    await tx.user.update({ where: { id: item.userId }, data: { passwordHash: encoded } });
    await tx.session.deleteMany({ where: { userId: item.userId } });
    await tx.actionToken.updateMany({
      where: { userId: item.userId, purpose: 'RESET_PASSWORD', usedAt: null },
      data: { usedAt: now },
    });
    await audit(tx, item.userId, 'PASSWORD_RESET', 'User', item.userId, null, {
      sessionsRevoked: true,
    });
  });
  return { message: 'Password saved. Please sign in.' };
}
