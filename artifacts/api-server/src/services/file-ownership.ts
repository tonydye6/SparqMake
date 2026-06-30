import { db, assetsTable, brandsTable, creativesTable, creativeVariantsTable } from "@workspace/db";
import { eq, or, sql } from "drizzle-orm";
import { publicUrlFor, type StorageLocation } from "./storage.js";

/**
 * Ownership / reference check for protected file namespaces.
 *
 * This project has no per-user tenant model (users carry a role only — see
 * middleware/auth.ts), so true cross-tenant isolation is not possible here.
 * What we CAN enforce is that a requested file is actually referenced by a
 * durable DB record. Unknown / orphaned objects are rejected (404), which
 * stops an authenticated client from probing arbitrary bucket keys.
 *
 * Public generated media (the `generated` namespace) is intentionally NOT
 * gated here — it is served by the unauthenticated public files router.
 */
export async function isFileReferenced(loc: StorageLocation): Promise<boolean> {
  const url = publicUrlFor(loc);

  const [asset] = await db
    .select({ id: assetsTable.id })
    .from(assetsTable)
    .where(or(eq(assetsTable.fileUrl, url), eq(assetsTable.thumbnailUrl, url)))
    .limit(1);
  if (asset) return true;

  const [brandLogo] = await db
    .select({ id: brandsTable.id })
    .from(brandsTable)
    .where(eq(brandsTable.logoFileUrl, url))
    .limit(1);
  if (brandLogo) return true;

  // brand fonts are stored as a json array of { fileUrl, ... }
  const [brandFont] = await db
    .select({ id: brandsTable.id })
    .from(brandsTable)
    .where(sql`${brandsTable.brandFonts}::text LIKE ${"%" + url + "%"}`)
    .limit(1);
  if (brandFont) return true;

  const [variant] = await db
    .select({ id: creativeVariantsTable.id })
    .from(creativeVariantsTable)
    .where(
      or(
        eq(creativeVariantsTable.rawImageUrl, url),
        eq(creativeVariantsTable.compositedImageUrl, url),
        eq(creativeVariantsTable.videoUrl, url),
        eq(creativeVariantsTable.audioUrl, url),
        eq(creativeVariantsTable.mergedVideoUrl, url),
      ),
    )
    .limit(1);
  if (variant) return true;

  // reference screenshots are stored as a json array of { url, viewport }
  const [creative] = await db
    .select({ id: creativesTable.id })
    .from(creativesTable)
    .where(sql`${creativesTable.referenceScreenshots}::text LIKE ${"%" + url + "%"}`)
    .limit(1);
  if (creative) return true;

  return false;
}
