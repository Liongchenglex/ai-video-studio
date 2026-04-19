/**
 * Database schema definitions for the application.
 * Includes BetterAuth tables (user, session, account, verification)
 * and the projects table for F-01 project management.
 */
import {
  pgTable,
  text,
  timestamp,
  boolean,
  uuid,
  index,
  pgEnum,
  jsonb,
  integer,
} from "drizzle-orm/pg-core";

// ─── BetterAuth tables ───────────────────────────────────────────────

export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").default(false).notNull(),
  image: text("image"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const session = pgTable("session", {
  id: text("id").primaryKey(),
  expiresAt: timestamp("expires_at").notNull(),
  token: text("token").notNull().unique(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
});

export const account = pgTable("account", {
  id: text("id").primaryKey(),
  accountId: text("account_id").notNull(),
  providerId: text("provider_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  accessToken: text("access_token"),
  refreshToken: text("refresh_token"),
  idToken: text("id_token"),
  accessTokenExpiresAt: timestamp("access_token_expires_at"),
  refreshTokenExpiresAt: timestamp("refresh_token_expires_at"),
  scope: text("scope"),
  password: text("password"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const verification = pgTable("verification", {
  id: text("id").primaryKey(),
  identifier: text("identifier").notNull(),
  value: text("value").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  createdAt: timestamp("created_at").defaultNow(),
  updatedAt: timestamp("updated_at").defaultNow(),
});

// ─── Application tables ──────────────────────────────────────────────

export const toneEnum = pgEnum("tone", [
  "educational",
  "entertaining",
  "documentary",
  "satirical",
]);

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
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    topic: text("topic"),
    status: projectStatusEnum("status").default("draft").notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
    deletedAt: timestamp("deleted_at"),

    // ── Style profile (F-02) ──
    styleString: text("style_string"),
    styleRefPaths: jsonb("style_ref_paths").$type<string[]>(),
    stylePreviewPath: text("style_preview_path"),

    // ── Video brief (F-03) ──
    brief: text("brief"),
    targetDuration: integer("target_duration").default(5),
    tone: toneEnum("tone").default("educational"),
  },
  (table) => [index("projects_user_id_deleted_at_idx").on(table.userId, table.deletedAt)],
);

export type Project = typeof projects.$inferSelect;
export type NewProject = typeof projects.$inferInsert;

// ─── Style templates (F-02) ─────────────────────────────────────────

export const styleTemplates = pgTable(
  "style_templates",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    styleString: text("style_string").notNull(),
    refPaths: jsonb("ref_paths").$type<string[]>().notNull(),
    previewPath: text("preview_path"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("style_templates_user_id_idx").on(table.userId)],
);

export type StyleTemplate = typeof styleTemplates.$inferSelect;
export type NewStyleTemplate = typeof styleTemplates.$inferInsert;

// ─── Scenes (F-03) ──────────────────────────────────────────────────

export const scenes = pgTable(
  "scenes",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),
    voiceover: text("voiceover").notNull(),
    sceneDescription: text("scene_description").notNull(),
    imagePrompt: text("image_prompt").notNull(),
    durationSeconds: integer("duration_seconds").notNull(),
    isHook: boolean("is_hook").default(false).notNull(),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("scenes_project_id_sort_order_idx").on(table.projectId, table.sortOrder),
  ],
);

export type Scene = typeof scenes.$inferSelect;
export type NewScene = typeof scenes.$inferInsert;
