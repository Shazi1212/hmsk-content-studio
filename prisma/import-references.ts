/*
 * Imports reference posts (your researched or best-performing past posts) for one brand from a JSON file.
 *
 *   npm run db:import -- <brand-slug> <file.json>
 *
 * The file is an array of objects with the column names of a research export (see data/demo-references.json):
 * required "Platform", "Post URL", "Hook"; optional "Content Pillar", "Format", "Topic", "Main Message", "CTA", "Views", "Likes",
 * "Comments", "Shares", "Saves", "Performance Level" (High | Typical | Low), "Emotional Driver", "Content Mechanism", "Observations", ...
 * Rows are upserted on (Post URL, Platform, Hook), so running the import twice does not duplicate anything.
 */
import { PrismaClient } from "@prisma/client";
import { readFileSync } from "node:fs";
import { referenceRow } from "./reference-rows";

const prisma = new PrismaClient();

async function main() {
  const [slug, file] = process.argv.slice(2);
  if (!slug || !file) {
    console.error("Usage: npm run db:import -- <brand-slug> <file.json>");
    process.exit(2);
  }
  const brand = await prisma.brand.findUnique({ where: { slug } });
  if (!brand) throw new Error(`Unknown brand "${slug}". Create it in the Brands tab first.`);
  const rows = JSON.parse(readFileSync(file, "utf8")) as unknown;
  if (!Array.isArray(rows)) throw new Error("The file must contain a JSON array of objects.");
  let n = 0;
  for (const r of rows as Record<string, unknown>[]) {
    const data = referenceRow(r, brand.id, "import");
    if (!data.postUrl || !data.hook) {
      console.warn(`Skipped a row without "Post URL" or "Hook".`);
      continue;
    }
    await prisma.referencePost.upsert({
      where: { postUrl_platform_hook: { postUrl: data.postUrl, platform: data.platform, hook: data.hook ?? "" } },
      create: data,
      update: data,
    });
    n++;
  }
  console.log(`Imported ${n} reference posts for ${brand.name}.`);
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
