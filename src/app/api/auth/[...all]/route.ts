/**
 * BetterAuth catch-all API route handler.
 * Mounts all auth endpoints (sign-in, sign-up, sign-out, OAuth callbacks, session)
 * under /api/auth/*. Rate limiting applied to POST requests (sign-in, sign-up).
 */
import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";
import { applyRateLimit } from "@/lib/api-utils";
import { NextRequest } from "next/server";

const { GET: authGET, POST: authPOST } = toNextJsHandler(auth);

export { authGET as GET };

export async function POST(request: NextRequest) {
  const rateLimitError = applyRateLimit(request, "auth");
  if (rateLimitError) return rateLimitError;

  return authPOST(request);
}
