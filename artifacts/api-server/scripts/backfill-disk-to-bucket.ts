/**
 * Backfill: copy every durable file from the local `uploads/` disk tree into
 * Replit Object Storage, preserving the namespace→prefix mapping the storage
 * service uses. Run once when switching an existing deployment from disk to the
 * bucket backend.
 *
 *   pnpm --filter @workspace/api-server exec tsx scripts/backfill-disk-to-bucket.ts \
 *       [uploads-dir] [--dry-run] [--overwrite]
 *
 * Default uploads-dir is "<cwd>/uploads". Idempotent and safe by default: an
 * object key that already exists in the bucket is SKIPPED unless its bytes
 * differ from the local file (size mismatch, then md5), so the backfill never
 * clobbers an unrelated object that happens to share a key, and re-runs are
 * cheap. Pass --overwrite to force re-upload regardless. Skips the soft-delete
 * trash/ tree and dotfiles.
 *
 * Disk layout → bucket key:
 *   uploads/<file>                  → uploads/<file>
 *   uploads/brand-assets/<file>     → brand-assets/<file>
 *   uploads/generated/<file>        → generated/<file>
 *   uploads/assets/<file>           → assets/<file>
 */
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { Client } from "@replit/object-storage";

const SUBDIR_TO_PREFIX: Record<string, string> = {
  "": "uploads/",
  "brand-assets": "brand-assets/",
  generated: "generated/",
  assets: "assets/",
};

interface PendingUpload {
  key: string;
  diskPath: string;
}

function collect(uploadsDir: string): PendingUpload[] {
  const pending: PendingUpload[] = [];
  for (const [subdir, prefix] of Object.entries(SUBDIR_TO_PREFIX)) {
    const dir = subdir ? path.join(uploadsDir, subdir) : uploadsDir;
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      if (entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      const stat = fs.statSync(full);
      if (!stat.isFile()) continue; // skip nested dirs (subdirs handled explicitly, trash/ ignored)
      pending.push({ key: `${prefix}${entry}`, diskPath: full });
    }
  }
  return pending;
}

/**
 * Decide whether a local file must be uploaded. Skips when an object already
 * exists in the bucket with identical bytes (size, then md5), so the backfill
 * never overwrites an unrelated object sharing a key and re-runs are cheap.
 */
async function needsUpload(client: Client, key: string, diskPath: string): Promise<boolean> {
  const exists = await client.exists(key);
  if (!exists.ok || !exists.value) return true;

  const local = fs.readFileSync(diskPath);
  const remote = await client.downloadAsBytes(key);
  if (!remote.ok) return true; // can't verify → re-upload to be safe
  const remoteBuf = remote.value[0];
  if (remoteBuf.length !== local.length) return true;
  const localMd5 = crypto.createHash("md5").update(local).digest("hex");
  const remoteMd5 = crypto.createHash("md5").update(remoteBuf).digest("hex");
  return localMd5 !== remoteMd5;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const overwrite = args.includes("--overwrite");
  const uploadsDir = path.resolve(args.find((a) => !a.startsWith("--")) || path.join(process.cwd(), "uploads"));

  if (!fs.existsSync(uploadsDir)) {
    console.error(`uploads dir not found: ${uploadsDir}`);
    process.exit(1);
  }
  if (!process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID) {
    console.error("DEFAULT_OBJECT_STORAGE_BUCKET_ID is not set — cannot backfill to a bucket.");
    process.exit(1);
  }

  const pending = collect(uploadsDir);
  console.log(`Backfilling ${pending.length} files from ${uploadsDir}${dryRun ? " (dry-run)" : ""} ...`);

  if (dryRun) {
    for (const p of pending) console.log(`  would upload ${p.diskPath} -> ${p.key}`);
    console.log(`Dry-run complete. ${pending.length} files would be uploaded.`);
    return;
  }

  const client = new Client();
  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  for (const p of pending) {
    if (!overwrite && !(await needsUpload(client, p.key, p.diskPath))) {
      skipped += 1;
    } else {
      const result = await client.uploadFromFilename(p.key, p.diskPath);
      if (result.ok) {
        uploaded += 1;
      } else {
        failed += 1;
        console.error(`FAILED ${p.key}: ${result.error.message}`);
      }
    }
    const processed = uploaded + skipped + failed;
    if (processed % 50 === 0 || processed === pending.length) {
      console.log(`  ${processed}/${pending.length} (uploaded: ${uploaded}, skipped: ${skipped}, failed: ${failed})`);
    }
  }

  console.log(`Done. uploaded=${uploaded} skipped=${skipped} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

void main();
