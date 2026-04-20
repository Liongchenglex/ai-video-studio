/**
 * Inngest function registry. All functions are exported here
 * and served via the /api/inngest endpoint.
 */
export { inngest } from "./client";

// Functions will be added in Task 7
export const functions: ReturnType<typeof import("./client").inngest.createFunction>[] = [];
