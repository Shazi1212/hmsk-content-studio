import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Unit tests only: pure logic, no network, no database (the Prisma client is constructed but never connects).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL(".", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    env: { DATABASE_URL: "postgresql://test:test@127.0.0.1:1/test", MOCK_LLM: "1" },
  },
});
