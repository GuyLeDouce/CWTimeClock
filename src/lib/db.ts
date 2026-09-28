import 'server-only';
import { PrismaClient, Prisma } from '@prisma/client';
const globalDb = globalThis as unknown as { prisma?: PrismaClient };
export const db = globalDb.prisma ?? new PrismaClient();
if (process.env.NODE_ENV !== 'production') globalDb.prisma = db;
export type Tx = Prisma.TransactionClient;
export async function transaction<T>(work: (tx: Tx) => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await db.$transaction(work, { isolationLevel: 'Serializable', timeout: 20000 });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        ['P2034', 'P2002'].includes(error.code) &&
        attempt < 3
      )
        continue;
      throw error;
    }
  }
}
export async function lockUsers(tx: Tx, ids: string[]) {
  for (const id of [...new Set(ids)].sort())
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${id}, 0))`;
}
export async function databaseNow(tx: Tx): Promise<Date> {
  const [row] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
  return row.now;
}
export function json(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value));
}
export async function audit(
  tx: Tx,
  actorId: string | null,
  action: string,
  entity: string,
  entityId: string,
  before: unknown,
  after: unknown,
  reason?: string,
) {
  await tx.auditLog.create({
    data: {
      actorId,
      action,
      entity,
      entityId,
      before: before == null ? Prisma.JsonNull : json(before),
      after: after == null ? Prisma.JsonNull : json(after),
      reason,
    },
  });
}
