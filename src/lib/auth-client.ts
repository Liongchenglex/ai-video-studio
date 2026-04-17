/**
 * BetterAuth client configuration for React.
 * Provides signIn, signUp, signOut, and useSession hooks
 * for use in client components.
 */
import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient();

export const { signIn, signUp, signOut, useSession } = authClient;
