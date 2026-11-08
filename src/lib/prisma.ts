import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
  prismaWal?: Promise<void>;
};

export const prisma = globalForPrisma.prisma ?? new PrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}

// A scan import writes a generation, thousands of quotes and the series in
// one transaction. In rollback-journal mode that write lock blocks every
// page read for the duration; WAL lets readers keep the previous snapshot.
// The setting is persistent in the database file, so doing it once per
// process (and once per new dev client) is enough. A failure is logged and
// does not stop the terminal: the database is still usable, just slower.
if (!globalForPrisma.prismaWal) {
  globalForPrisma.prismaWal = prisma
    .$queryRawUnsafe("PRAGMA journal_mode=WAL")
    .then(() => undefined)
    .catch((error) => {
      console.error("Failed to enable SQLite WAL:", error);
    });
}