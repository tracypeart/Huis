import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Extraction tests start real isolated processes and run OCR.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
