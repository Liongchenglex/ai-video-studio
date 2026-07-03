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
  doublePrecision,
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

export const generationStatusEnum = pgEnum("generation_status", [
  "pending",
  "generating",
  "done",
  "failed",
]);

export const projectStatusEnum = pgEnum("project_status", [
  "draft",
  "generating",
  "ready",
  "published",
]);

export const entityTypeEnum = pgEnum("entity_type", [
  "character",
  "location",
  "object",
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

    // ── Script (F-03) ──
    // Plain text with paragraph breaks (\n\n). No scene/shot structure —
    // shots are user-defined on the editor timeline instead.
    script: text("script"),

    // ── Music (F-06) ──
    musicPath: text("music_path"),
    musicStatus: generationStatusEnum("music_status").default("pending"),
    musicMood: text("music_mood").default("ambient"),
    voiceId: text("voice_id").default("21m00Tcm4TlvDq8ikWAM"),
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

// ─── Shots (F-04 + F-07 + F-08) ─────────────────────────────────────
// A shot is a user-defined time range on the project timeline with an
// image + animated clip over that range of the continuous voiceover.
// Users create and position shots in the Timeline Editor (F-08); there
// is no scene-level grouping.

export const shots = pgTable(
  "shots",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),

    imagePrompt: text("image_prompt").notNull(),
    motionPrompt: text("motion_prompt").notNull(),

    // ── Image (F-04) ──
    imagePath: text("image_path"),
    imageStatus: generationStatusEnum("image_status").default("pending"),

    // ── Clip (F-07) ──
    clipPath: text("clip_path"),
    clipStatus: generationStatusEnum("clip_status").default("pending"),
    clipDurationSeconds: integer("clip_duration_seconds"),

    // ── v4.0: beat membership + sub-beat offsets ──
    // beatId is nullable during the additive migration; backfilled later.
    beatId: uuid("beat_id").references(() => beats.id, { onDelete: "cascade" }),
    startInBeat: doublePrecision("start_in_beat"),
    endInBeat: doublePrecision("end_in_beat"),

    // ── v4.0: Reference Bible tagging (F-16) ──
    referencedEntityIds: jsonb("referenced_entity_ids")
      .$type<string[]>()
      .default([]),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("shots_project_id_sort_order_idx").on(table.projectId, table.sortOrder),
  ],
);

export type Shot = typeof shots.$inferSelect;
export type NewShot = typeof shots.$inferInsert;

// ─── Beats (v4.0) ────────────────────────────────────────────────────
// A beat is one sentence/clause of narration. It owns its own text and
// its own voiceover audio clip. Beats stack sequentially: a beat's
// absolute start = sum of prior beats' voDurationSeconds. Shots are the
// visuals under a beat (see shots.beatId).

export const beats = pgTable(
  "beats",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    sortOrder: integer("sort_order").notNull(),

    // Narration text — source of truth for this beat's words.
    text: text("text").notNull(),

    // Per-beat voiceover audio.
    voPath: text("vo_path"),
    voStatus: generationStatusEnum("vo_status").default("pending"),
    voDurationSeconds: doublePrecision("vo_duration_seconds"),
    voTimestamps: jsonb("vo_timestamps").$type<{
      characters: string[];
      character_start_times_seconds: number[];
      character_end_times_seconds: number[];
    }>(),

    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [
    index("beats_project_id_sort_order_idx").on(table.projectId, table.sortOrder),
  ],
);

export type Beat = typeof beats.$inferSelect;
export type NewBeat = typeof beats.$inferInsert;

// ─── Entities / Reference Bible (F-16, v4.0) ─────────────────────────
// Recurring characters / locations / objects. Each has one multi-view
// reference-sheet image used to condition FLUX so the entity looks
// consistent across shots. Tagging lives on shots.referencedEntityIds.

export const entities = pgTable(
  "entities",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    type: entityTypeEnum("type").notNull(),
    description: text("description"),
    referenceSheetPath: text("reference_sheet_path"),
    referenceStatus: generationStatusEnum("reference_status").default("pending"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
    updatedAt: timestamp("updated_at")
      .defaultNow()
      .$onUpdate(() => new Date())
      .notNull(),
  },
  (table) => [index("entities_project_id_idx").on(table.projectId)],
);

export type Entity = typeof entities.$inferSelect;
export type NewEntity = typeof entities.$inferInsert;
