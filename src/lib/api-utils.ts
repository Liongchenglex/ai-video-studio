/**
 * Shared API utilities for route handlers.
 * Provides session retrieval and standard error responses.
 */
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";
import { checkRateLimit, getClientIp } from "@/lib/rate-limit";

/**
 * Retrieves the current authenticated session from the request headers.
 * Returns null if no valid session exists.
 */
export async function getSession() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });
  return session;
}

/**
 * Returns a 401 JSON response for unauthenticated requests.
 */
export function unauthorizedResponse() {
  return NextResponse.json(
    { error: "Authentication required" },
    { status: 401 },
  );
}

/**
 * Returns a 403 JSON response for unauthorized access.
 */
export function forbiddenResponse() {
  return NextResponse.json(
    { error: "Access denied" },
    { status: 403 },
  );
}

/**
 * Returns a 404 JSON response.
 */
export function notFoundResponse() {
  return NextResponse.json(
    { error: "Not found" },
    { status: 404 },
  );
}

/**
 * Returns a 400 JSON response for bad requests.
 */
export function badRequestResponse(message = "Bad request") {
  return NextResponse.json(
    { error: message },
    { status: 400 },
  );
}

/** Rate limit presets */
const RATE_LIMITS = {
  auth: { maxRequests: 10, windowSeconds: 60 },
  mutation: { maxRequests: 30, windowSeconds: 60 },
} as const;

/**
 * Applies rate limiting to a request. Returns a 429 response if exceeded.
 */
export function applyRateLimit(
  request: Request,
  type: keyof typeof RATE_LIMITS,
): NextResponse | null {
  const ip = getClientIp(request);
  const config = RATE_LIMITS[type];
  const result = checkRateLimit(`${type}:${ip}`, config);

  if (!result.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      {
        status: 429,
        headers: {
          "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
        },
      },
    );
  }

  return null;
}

/**
 * Validates the Origin header on mutation requests to prevent CSRF.
 * Returns a 403 response if the origin doesn't match the expected host.
 */
export async function verifyCsrf(request: Request): Promise<NextResponse | null> {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");

  if (!origin || !host) {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403 },
    );
  }

  const originHost = new URL(origin).host;
  if (originHost !== host) {
    return NextResponse.json(
      { error: "Forbidden" },
      { status: 403 },
    );
  }

  return null;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Validates that a string is a valid UUID v4 format.
 */
export function isValidUUID(id: string): boolean {
  return UUID_REGEX.test(id);
}
