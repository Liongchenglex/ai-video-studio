/**
 * Shared API utilities for route handlers.
 * Provides session retrieval and standard error responses.
 */
import { auth } from "@/lib/auth";
import { headers } from "next/headers";
import { NextResponse } from "next/server";

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
