import { pgTable, text, integer, jsonb, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/**
 * Durable audit trail for privileged and destructive mutations.
 *
 * Records who did what to which entity, and when — enough to reconstruct a
 * destructive action (e.g. how many rows a bulk-delete removed) after the fact.
 *
 * Design notes:
 *  - `brandId` is a nullable, un-referenced tenancy seam reserved for the
 *    deferred per-org/per-brand scoping work. It is intentionally NOT a foreign
 *    key: an audit record must outlive the entity it describes (deleting a brand
 *    must not cascade-delete the record of that deletion), so no FK/cascade is
 *    attached here.
 *  - `entityIds` holds the affected id(s) as JSON so a single bulk action can be
 *    recorded in one row alongside `affectedCount`.
 *  - Indexed by actor, action, entity type, and time so records are queryable by
 *    the common access patterns (who, what, and time range) for later surfacing.
 */
export const auditLogsTable = pgTable("audit_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  actorId: text("actor_id").notNull(),
  actorRole: text("actor_role").notNull(),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityIds: jsonb("entity_ids").$type<string[]>(),
  affectedCount: integer("affected_count"),
  brandId: text("brand_id"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, (table) => [
  index("audit_logs_actor_idx").on(table.actorId),
  index("audit_logs_action_idx").on(table.action),
  index("audit_logs_entity_idx").on(table.entityType),
  index("audit_logs_created_at_idx").on(table.createdAt),
]);

export const insertAuditLogSchema = createInsertSchema(auditLogsTable).omit({
  id: true,
  createdAt: true,
});

export type InsertAuditLog = z.infer<typeof insertAuditLogSchema>;
export type AuditLog = typeof auditLogsTable.$inferSelect;
