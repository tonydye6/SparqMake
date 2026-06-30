/**
 * Sweep soft-deleted ("trash/") objects.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/cleanup-soft-deleted.ts [--purge] [--older-than-days N]
 *
 * deleteObject() soft-deletes by copying to a trash/ prefix (bucket) and an
 * uploads/trash/ tree (disk) before removing the live copy. This script hard-
 * deletes those tombstones.
 *
 *   Disk:   files under uploads/trash/ older than N days (mtime) are removed.
 *   Bucket: the @replit/object-storage SDK exposes no per-object timestamp, so
 *           bucket trash can only be purged wholesale. It is listed by default
 *           and only deleted when --purge is passed.
 *
 * Default --older-than-days is 30 (disk only). Without --purge the bucket side
 * is a dry-run listing.
 */
import fs from "fs";
import path from "path";
import { Client } from "@replit/object-storage";

const TRASH_PREFIX = "trash/";

function parseArgs() {
  const args = process.argv.slice(2);
  const purge = args.includes("--purge");
  let olderThanDays = 30;
  const idx = args.indexOf("--older-than-days");
  if (idx >= 0 && args[idx + 1]) {
    const n = parseInt(args[idx + 1], 10);
    if (!Number.isNaN(n) && n >= 0) olderThanDays = n;
  }
  return { purge, olderThanDays };
}

function sweepDisk(uploadsDir: string, olderThanMs: number): { removed: number; kept: number } {
  const trashRoot = path.join(uploadsDir, "trash");
  let removed = 0;
  let kept = 0;
  if (!fs.existsSync(trashRoot)) return { removed, kept };

  const cutoff = Date.now() - olderThanMs;
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir)) {
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        walk(full);
      } else if (stat.isFile()) {
        if (stat.mtimeMs < cutoff) {
          fs.unlinkSync(full);
          removed += 1;
        } else {
          kept += 1;
        }
      }
    }
  };
  walk(trashRoot);
  return { removed, kept };
}

async function sweepBucket(client: Client, purge: boolean): Promise<{ found: number; removed: number }> {
  const res = await client.list({ prefix: TRASH_PREFIX });
  if (!res.ok) {
    console.error(`list ${TRASH_PREFIX} failed: ${res.error.message}`);
    return { found: 0, removed: 0 };
  }
  const names = res.value.map((o) => o.name);
  let removed = 0;
  if (purge) {
    for (const name of names) {
      const del = await client.delete(name, { ignoreNotFound: true });
      if (del.ok) removed += 1;
      else console.error(`FAILED delete ${name}: ${del.error.message}`);
    }
  } else {
    for (const name of names) console.log(`  would purge ${name}`);
  }
  return { found: names.length, removed };
}

async function main(): Promise<void> {
  const { purge, olderThanDays } = parseArgs();
  const uploadsDir = path.join(process.cwd(), "uploads");

  const disk = sweepDisk(uploadsDir, olderThanDays * 24 * 60 * 60 * 1000);
  console.log(`Disk trash: removed=${disk.removed} kept=${disk.kept} (older-than ${olderThanDays}d)`);

  if (process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID) {
    const client = new Client();
    const bucket = await sweepBucket(client, purge);
    if (purge) {
      console.log(`Bucket trash: found=${bucket.found} removed=${bucket.removed}`);
    } else {
      console.log(`Bucket trash: found=${bucket.found} (dry-run — pass --purge to delete)`);
    }
  } else {
    console.log("Bucket trash: skipped (DEFAULT_OBJECT_STORAGE_BUCKET_ID not set)");
  }
}

void main();
