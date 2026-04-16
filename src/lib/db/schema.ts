/**
 * Database schema definitions for the application.
 * BetterAuth tables (user, session, account, verification) are generated
 * via `npx @better-auth/cli generate`. This file defines the projects table
 * which is the core entity for F-01 project management.
 */
import {
  pgTable,
  text,
  timestamp,
  uuid,
  index,
  pgEnum,
} from "drizzle-orm/pg-core";

export const projectStatusEnum = pgEnum("project_status", [
  "draft",
  "generating",
  "ready",
  "published",
]);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    topic: text("topic"),
    status: projectStatusEnum("status").default("draft").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at"),
  },
  (table) => [index("projects_user_id_deleted_at_idx").on(table.userId, table.deletedAt)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;
