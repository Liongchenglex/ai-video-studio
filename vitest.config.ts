/**
 * Vitest configuration. Unit tests live in tests/unit and exercise pure
 * logic only (no network, no DB) — routes and UI are covered by the
 * manual test cases in docs/feature18/test-case.md.
 */
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  test: {
    include: ["tests/unit/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
