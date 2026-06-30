/**
 * Reconcile DB file references against Replit Object Storage.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/reconcile-orphans.ts [--json] [--clear-missing]
 *
 * Reports two kinds of drift (non-destructive by default):
 *   1. MISSING  — a DB row references /api/files/... but the object is absent
 *                 from the bucket (broken media, e.g. files wiped in prod).
 *   2. ORPHAN   — a bucket object that no DB row references (candidate for the
 *                 orphan sweep; see scripts/sweep-orphans.ts).
 *
 * With --clear-missing the script *opt-in* nulls the dangling URL on the owning
 * row for scalar (text) columns, so the UI stops rendering broken media. JSON
 * columns (brandFonts, referenceScreenshots) are reported only — editing
 * embedded URLs inside JSON is risky and left to a manual/UI step. The DB rows
 * themselves are never deleted.
 */
import { db, assetsTable, brandsTable, creativeVariantsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { Client } from "@replit/object-storage";
import { gatherFileReferences, referencedKeySet, type FileReference } from "../src/services/file-references.js";

const PREFIXES = ["uploads/", "brand-assets/", "generated/", "assets/"];

async function listBucketKeys(client: Client): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const prefix of PREFIXES) {
    const res = await client.list({ prefix });
    if (!res.ok) {
      console.error(`list ${prefix} failed: ${res.error.message}`);
      continue;
    }
    for (const obj of res.value) {
      if (obj.name.startsWith("trash/")) continue;
      keys.add(obj.name);
    }
  }
  return keys;
}

async function clearReference(ref: FileReference): Promise<boolean> {
  switch (ref.table) {
    case "assets":
      await db
        .update(assetsTable)
        .set(ref.column === "thumbnailUrl" ? { thumbnailUrl: null } : { fileUrl: null })
        .where(eq(assetsTable.id, ref.rowId));
      return true;
    case "brands":
      await db.update(brandsTable).set({ logoFileUrl: null }).where(eq(brandsTable.id, ref.rowId));
      return true;
    case "creative_variants": {
      const col = ref.column as
        | "rawImageUrl"
        | "compositedImageUrl"
        | "videoUrl"
        | "audioUrl"
        | "mergedVideoUrl";
      await db
        .update(creativeVariantsTable)
        .set({ [col]: null })
        .where(eq(creativeVariantsTable.id, ref.rowId));
      return true;
    }
    default:
      return false;
  }
}

async function main(): Promise<void> {
  const asJson = process.argv.includes("--json");
  const clearMissing = process.argv.includes("--clear-missing");
  if (!process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID) {
    console.error("DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set — nothing to reconcile against.");
    process.exit(1);
  }

  const client = new Client();
  const [refs, inBucket] = await Promise.all([gatherFileReferences(), listBucketKeys(client)]);
  const referenced = referencedKeySet(refs);

  const missing = refs.filter((r) => !inBucket.has(r.key)).sort((a, b) => a.key.localeCompare(b.key));
  const orphans = [...inBucket].filter((k) => !referenced.has(k)).sort();

  let cleared = 0;
  let unclearable = 0;
  if (clearMissing) {
    for (const ref of missing) {
      if (ref.clearable && (await clearReference(ref))) cleared += 1;
      else unclearable += 1;
    }
  }

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          referenced: referenced.size,
          inBucket: inBucket.size,
          missing: missing.map((m) => ({ key: m.key, table: m.table, column: m.column, rowId: m.rowId })),
          orphans,
          cleared,
          unclearable,
        },
        null,
        2,
      ),
    );
  } else {
    console.log(`Referenced by DB: ${referenced.size} (across ${refs.length} columns)`);
    console.log(`Present in bucket: ${inBucket.size}`);
    console.log(`\nMISSING (referenced but absent from bucket): ${missing.length}`);
    for (const m of missing) console.log(`  - ${m.key}  <- ${m.table}.${m.column} (${m.rowId})`);
    console.log(`\nORPHAN (in bucket but unreferenced): ${orphans.length}`);
    for (const k of orphans) console.log(`  - ${k}`);
    if (clearMissing) {
      console.log(`\nCleared dangling URLs: ${cleared} (json/report-only skipped: ${unclearable})`);
    } else if (missing.length > 0) {
      console.log(`\n(run with --clear-missing to null the dangling scalar URLs)`);
    }
    if (orphans.length > 0) {
      console.log(`(run scripts/sweep-orphans.ts to move aged orphans to trash/)`);
    }
  }

  process.exit(0);
}

void main();
