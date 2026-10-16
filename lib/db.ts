import { PrismaClient } from "@prisma/client";
import { scrubDeep } from "@/lib/text";

/** Operations whose arguments carry data to store. */
const WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "upsert"]);

/**
 * The app's Prisma client. Every write passes through `scrubDeep` first: Prisma's engine rejects a string with an unpaired UTF-16
 * surrogate ("unexpected end of hex escape"), and one appears whenever text containing an emoji is cut in the middle by a `slice`
 * or arrives that way from a platform API or a model. The first victim was a TikTok sync of emoji captions (lib/text.ts).
 */
function build() {
  const client = new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["warn", "error"] : ["error"],
  });
  return client.$extends({
    name: "well-formed-strings",
    query: {
      $allModels: {
        $allOperations({ operation, args, query }) {
          return query(WRITES.has(operation) ? scrubDeep(args) : args);
        },
      },
    },
  });
}

const globalForPrisma = globalThis as unknown as { prisma?: ReturnType<typeof build> };

export const prisma = globalForPrisma.prisma ?? build();

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = prisma;
