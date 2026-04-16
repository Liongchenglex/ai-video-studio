/**
 * BetterAuth client configuration for React.
 * Provides signIn, signUp, signOut, and useSession hooks
 * for use in client components.
 */
"use client";

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: process.env.NEXT_PUBLIC_APP_URL || "http://localhost:3000",
});

export const { signIn, signUp, signOut, useSession } = authClient;
