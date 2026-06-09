/**
 * Bulk-upload curated asset-library media into Replit Object Storage.
 *
 * Run from the Replit workspace (the sidecar provides credentials there):
 *   pnpm --filter @workspace/api-server exec tsx scripts/upload-assets-to-bucket.ts <source-dir>
 *
 * Uploads every regular file in <source-dir> (non-recursive) to the default
 * bucket as "assets/<filename>", which is exactly what
 * GET /api/files/assets/:filename serves. Idempotent: re-running overwrites
 * the same object names. Skips dotfiles (.gitkeep, .DS_Store).
 */
import fs from "fs";
import path from "path";
import { Client } from "@replit/object-storage";

async function main(): Promise<void> {
  const srcDir = process.argv[2];
  if (!srcDir || !fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
    console.error("Usage: tsx scripts/upload-assets-to-bucket.ts <source-dir>");
    process.exit(1);
  }

  const files = fs
    .readdirSync(srcDir)
    .filter((f) => !f.startsWith(".") && fs.statSync(path.join(srcDir, f)).isFile());

  console.log(`Uploading ${files.length} files from ${srcDir} to bucket prefix assets/ ...`);
  const client = new Client();

  let uploaded = 0;
  let failed = 0;
  for (const f of files) {
    const result = await client.uploadFromFilename(`assets/${f}`, path.join(srcDir, f));
    if (result.ok) {
      uploaded += 1;
    } else {
      failed += 1;
      console.error(`FAILED ${f}: ${result.error.message}`);
    }
    const processed = uploaded + failed;
    if (processed % 50 === 0 || processed === files.length) {
      console.log(`  ${processed}/${files.length} (failed: ${failed})`);
    }
  }

  const listed = await client.list({ prefix: "assets/" });
  const inBucket = listed.ok ? listed.value.length : -1;
  console.log(`Done. uploaded=${uploaded} failed=${failed} bucket "assets/" object count=${inBucket}`);
  if (failed > 0) {
    process.exit(1);
  }
}

void main();
