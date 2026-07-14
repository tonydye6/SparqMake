import { db, assetsTable } from "@workspace/db";
import { inArray, sql } from "drizzle-orm";
import type { GenerationPacket } from "./packet-assembly.js";

// Called after a generation flow succeeds. Increments each involved asset's
// usage count and stamps lastUsedAt. Never throws — usage tracking must not
// fail an otherwise-successful generation.
export async function recordAssetUsage(assetIds: string[]): Promise<void> {
  const unique = [...new Set(assetIds)].filter(Boolean);
  if (unique.length === 0) return;
  try {
    await db.update(assetsTable)
      .set({
        usageCount: sql`COALESCE(${assetsTable.usageCount}, 0) + 1`,
        lastUsedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(inArray(assetsTable.id, unique));
  } catch (err) {
    console.error("Failed to record asset usage:", err instanceof Error ? err.message : err);
  }
}

export function packetAssetIds(packet: GenerationPacket | null | undefined): string[] {
  if (!packet) return [];
  return [
    ...packet.generationAssets.map(a => a.asset.id),
    ...packet.compositingAssets.map(a => a.asset.id),
    ...packet.contextAssets.map(a => a.asset.id),
  ];
}
