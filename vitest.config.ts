import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globalSetup: ["./test/global-setup.ts"],
    // Extraction tests start real isolated processes and run OCR.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
