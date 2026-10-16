/*
 * Seeds the demo brand (data/brands.ts) and its demo reference posts (data/demo-references.json) into an EMPTY database.
 * Runs on every container start; once any brand exists it does nothing, so brands edited or deleted in the app stay that way.
 * Reference-post files use the column names of a research spreadsheet export ("Platform", "Post URL", "Hook", ...).
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BRANDS } from "../data/brands";
import { referenceRow } from "./reference-rows";

const prisma = new PrismaClient();

/** Reference-post dataset per seeded brand slug (files in data/). */
const FILES: Record<string, string> = {
  "northwind-coffee": "demo-references.json",
};

async function main() {
  if ((await prisma.brand.count()) > 0) {
    console.log("Brands already exist; seed skipped.");
    return;
  }
  for (const brand of BRANDS) {
    // referenceImages stay in data/brands.ts; the Brand table has no column for them (lib/references.ts imports them into BrandAsset on first use).
    const { referenceImages: _referenceImages, ...b } = brand;
    void _referenceImages;
    await prisma.brand.create({ data: { ...b } });
  }
  const brands = await prisma.brand.findMany();
  const bySlug = Object.fromEntries(brands.map((b) => [b.slug, b.id]));

  let total = 0;
  for (const [slug, file] of Object.entries(FILES)) {
    if (!bySlug[slug]) continue;
    const rows = JSON.parse(readFileSync(join(__dirname, "..", "data", file), "utf8")) as Record<string, unknown>[];
    for (const r of rows) {
      const data = referenceRow(r, bySlug[slug], "seed");
      const { postUrl, platform, hook } = data;
      await prisma.referencePost.upsert({
        where: { postUrl_platform_hook: { postUrl, platform, hook: hook ?? "" } },
        create: data,
        update: data,
      });
      total++;
    }
  }
  console.log(`Seeded ${brands.length} brands and ${total} reference posts.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
