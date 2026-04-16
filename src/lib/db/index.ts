/**
 * Drizzle ORM database client.
 * Connects to PostgreSQL using the postgres driver and exposes
 * a typed db instance used throughout the application.
 */
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const connectionString = process.env.DATABASE_URL!;
const client = postgres(connectionString);

export const db = drizzle(client, { schema });
