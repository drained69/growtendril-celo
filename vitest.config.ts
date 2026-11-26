import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src"), "@growth-tools": path.resolve(import.meta.dirname, "packages/growth-tools/dist") } },
  // Cold route imports run PGlite migrations; under a full parallel run that can exceed the 5s/10s defaults.
  test: { include: ["tests/**/*.test.ts"], environment: "node", testTimeout: 30_000, hookTimeout: 60_000 },
});
