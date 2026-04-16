/**
 * BetterAuth catch-all API route handler.
 * Mounts all auth endpoints (sign-in, sign-up, sign-out, OAuth callbacks, session)
 * under /api/auth/*.
 */
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth);
