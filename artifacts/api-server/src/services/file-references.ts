import { db, assetsTable, brandsTable, creativesTable, creativeVariantsTable } from "@workspace/db";
import { resolveUrl, internal, type StorageNamespace } from "./storage.js";

/**
 * Bulk inventory of every file URL the database references, used by the
 * reconcile and orphan-sweep scripts. (Per-request ownership lives in
 * file-ownership.ts; this is the whole-DB scan.)
 */

export interface FileReference {
  /** Object-storage key, e.g. "generated/foo.png". */
  key: string;
  url: string;
  table: string;
  column: string;
  rowId: string;
  /** Scalar text columns can be auto-cleared; json columns are report-only. */
  clearable: boolean;
}

function keyFor(url: string | null | undefined): string | null {
  const loc = resolveUrl(url);
  return loc ? internal.bucketKey(loc) : null;
}

function urlsInText(text: string): string[] {
  const out: string[] = [];
  const re = /\/api\/files\/[A-Za-z0-9._\-/]+/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.push(m[0]);
  return out;
}

/** Walk every file-bearing column and return one entry per referenced URL. */
export async function gatherFileReferences(): Promise<FileReference[]> {
  const refs: FileReference[] = [];
  const addScalar = (url: string | null | undefined, table: string, column: string, rowId: string) => {
    if (!url) return;
    const key = keyFor(url);
    if (key) refs.push({ key, url, table, column, rowId, clearable: true });
  };
  const addJson = (value: unknown, table: string, column: string, rowId: string) => {
    if (!value) return;
    for (const url of urlsInText(JSON.stringify(value))) {
      const key = keyFor(url);
      if (key) refs.push({ key, url, table, column, rowId, clearable: false });
    }
  };

  const assets = await db
    .select({ id: assetsTable.id, fileUrl: assetsTable.fileUrl, thumbnailUrl: assetsTable.thumbnailUrl })
    .from(assetsTable);
  for (const a of assets) {
    addScalar(a.fileUrl, "assets", "fileUrl", a.id);
    addScalar(a.thumbnailUrl, "assets", "thumbnailUrl", a.id);
  }

  const brands = await db
    .select({ id: brandsTable.id, logoFileUrl: brandsTable.logoFileUrl, brandFonts: brandsTable.brandFonts })
    .from(brandsTable);
  for (const b of brands) {
    addScalar(b.logoFileUrl, "brands", "logoFileUrl", b.id);
    addJson(b.brandFonts, "brands", "brandFonts", b.id);
  }

  const variants = await db
    .select({
      id: creativeVariantsTable.id,
      rawImageUrl: creativeVariantsTable.rawImageUrl,
      compositedImageUrl: creativeVariantsTable.compositedImageUrl,
      videoUrl: creativeVariantsTable.videoUrl,
      audioUrl: creativeVariantsTable.audioUrl,
      mergedVideoUrl: creativeVariantsTable.mergedVideoUrl,
    })
    .from(creativeVariantsTable);
  for (const v of variants) {
    addScalar(v.rawImageUrl, "creative_variants", "rawImageUrl", v.id);
    addScalar(v.compositedImageUrl, "creative_variants", "compositedImageUrl", v.id);
    addScalar(v.videoUrl, "creative_variants", "videoUrl", v.id);
    addScalar(v.audioUrl, "creative_variants", "audioUrl", v.id);
    addScalar(v.mergedVideoUrl, "creative_variants", "mergedVideoUrl", v.id);
  }

  const creatives = await db
    .select({ id: creativesTable.id, referenceScreenshots: creativesTable.referenceScreenshots })
    .from(creativesTable);
  for (const c of creatives) {
    addJson(c.referenceScreenshots, "creatives", "referenceScreenshots", c.id);
  }

  return refs;
}

export function referencedKeySet(refs: FileReference[]): Set<string> {
  return new Set(refs.map((r) => r.key));
}

/** Map a bucket key back to its {namespace, filename}, or null if it isn't ours. */
export function keyToLocation(key: string): { namespace: StorageNamespace; filename: string } | null {
  if (key.startsWith(internal.TRASH_PREFIX)) return null;
  const namespaces = internal.NAMESPACES;
  for (const ns of Object.keys(namespaces) as StorageNamespace[]) {
    const prefix = namespaces[ns].bucketPrefix;
    if (key.startsWith(prefix)) {
      const filename = key.slice(prefix.length);
      if (filename && !filename.includes("/")) return { namespace: ns, filename };
    }
  }
  return null;
}

export interface SweepCandidate {
  key: string;
  namespace: StorageNamespace;
  filename: string;
  /** Disk mtime in ms if the object exists on disk; undefined for bucket-only. */
  mtimeMs?: number;
}

/**
 * Pure decision: of the live objects, which unreferenced ones are old enough to
 * move to trash. Disk-resident objects are aged by mtime against `cutoffMs`.
 * Bucket-only objects (no mtime available — the SDK exposes no timestamp) are
 * included only when `includeUndated` is true (explicit opt-in).
 */
export function selectSweepable(
  candidates: SweepCandidate[],
  referenced: Set<string>,
  cutoffMs: number,
  includeUndated: boolean,
): SweepCandidate[] {
  return candidates.filter((c) => {
    if (referenced.has(c.key)) return false;
    if (c.mtimeMs === undefined) return includeUndated;
    return c.mtimeMs < cutoffMs;
  });
}
