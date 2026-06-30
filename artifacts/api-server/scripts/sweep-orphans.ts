/**
 * Orphan sweep: move aged, unreferenced live objects to the recoverable trash/
 * prefix so bucket storage does not grow unbounded the way the ephemeral disk
 * used to self-clear. Covers the upload→create-record gap (raw uploads that were
 * never attached) and objects left behind by abandoned/failed generations.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/sweep-orphans.ts \
 *       [--apply] [--older-than-days N] [--include-bucket]
 *
 * Safety:
 *   - DRY-RUN by default: lists what *would* be swept. Pass --apply to act.
 *   - SOFT-DELETE only: objects are moved to trash/ (bucket) / uploads/trash/
 *     (disk) via the storage service, recoverable until scripts/cleanup-soft-
 *     deleted.ts purges them after the recovery window.
 *   - AGE GUARD: disk objects are swept only when their mtime is older than
 *     --older-than-days (default 7), protecting freshly-uploaded files still in
 *     the upload→create gap.
 *   - The @replit/object-storage SDK exposes no per-object timestamp, so
 *     bucket-only objects cannot be aged. They are swept only with the explicit
 *     --include-bucket opt-in (run when no uploads are in flight).
 */
import fs from "fs";
import path from "path";
import { Client } from "@replit/object-storage";
import { deleteObject, internal, type StorageNamespace } from "../src/services/storage.js";
import {
  gatherFileReferences,
  referencedKeySet,
  keyToLocation,
  selectSweepable,
  type SweepCandidate,
} from "../src/services/file-references.js";

const NAMESPACES = internal.NAMESPACES;

function parseArgs() {
  const args = process.argv.slice(2);
  const apply = args.includes("--apply");
  const includeBucket = args.includes("--include-bucket");
  let olderThanDays = 7;
  const idx = args.indexOf("--older-than-days");
  if (idx >= 0 && args[idx + 1]) {
    const n = parseInt(args[idx + 1], 10);
    if (!Number.isNaN(n) && n >= 0) olderThanDays = n;
  }
  return { apply, includeBucket, olderThanDays };
}

function collectDiskCandidates(): Map<string, SweepCandidate> {
  const out = new Map<string, SweepCandidate>();
  for (const ns of Object.keys(NAMESPACES) as StorageNamespace[]) {
    const sub = NAMESPACES[ns].diskSubdir;
    const dir = sub ? path.join(internal.UPLOAD_ROOT, sub) : internal.UPLOAD_ROOT;
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      const key = NAMESPACES[ns].bucketPrefix + entry;
      out.set(key, { key, namespace: ns, filename: entry, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

async function collectBucketCandidates(client: Client): Promise<Map<string, SweepCandidate>> {
  const out = new Map<string, SweepCandidate>();
  for (const ns of Object.keys(NAMESPACES) as StorageNamespace[]) {
    const prefix = NAMESPACES[ns].bucketPrefix;
    const res = await client.list({ prefix });
    if (!res.ok) {
      console.error(`list ${prefix} failed: ${res.error.message}`);
      continue;
    }
    for (const obj of res.value) {
      if (obj.name.startsWith(internal.TRASH_PREFIX)) continue;
      const loc = keyToLocation(obj.name);
      if (!loc) continue;
      out.set(obj.name, { key: obj.name, namespace: loc.namespace, filename: loc.filename });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const { apply, includeBucket, olderThanDays } = parseArgs();
  const hasBucket = Boolean(process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID);

  const candidates = collectDiskCandidates();
  if (hasBucket) {
    const client = new Client();
    const bucket = await collectBucketCandidates(client);
    // Merge: a disk entry (with mtime) wins so the object can be aged.
    for (const [key, cand] of bucket) {
      if (!candidates.has(key)) candidates.set(key, cand);
    }
  }

  const refs = await gatherFileReferences();
  const referenced = referencedKeySet(refs);
  const cutoffMs = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

  const sweepable = selectSweepable([...candidates.values()], referenced, cutoffMs, includeBucket).sort((a, b) =>
    a.key.localeCompare(b.key),
  );

  const undated = sweepable.filter((c) => c.mtimeMs === undefined).length;
  console.log(
    `Live objects: ${candidates.size} | referenced: ${referenced.size} | sweepable: ${sweepable.length} ` +
      `(older-than ${olderThanDays}d; bucket-only undated included: ${includeBucket ? `yes (${undated})` : "no"})`,
  );

  if (!apply) {
    for (const c of sweepable) console.log(`  would trash ${c.key}${c.mtimeMs === undefined ? " [bucket-only]" : ""}`);
    console.log(`\nDRY-RUN. Pass --apply to soft-delete the ${sweepable.length} object(s) above to trash/.`);
    return;
  }

  let moved = 0;
  for (const c of sweepable) {
    await deleteObject({ namespace: c.namespace, filename: c.filename }, { soft: true });
    moved += 1;
  }
  console.log(`Swept ${moved} object(s) to trash/. Recoverable until cleanup-soft-deleted.ts purges them.`);
}

void main();
