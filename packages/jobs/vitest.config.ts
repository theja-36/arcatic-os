import { defineConfig } from "vitest/config";

// Workflow tests bundle src/workflows on first use; under load that alone can exceed vitest's 5 s default.
export default defineConfig({ test: { testTimeout: 60_000, hookTimeout: 120_000 } });
