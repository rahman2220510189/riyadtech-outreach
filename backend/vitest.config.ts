import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    projects: [
      {
        // npm test: pure unit tests, no network, no real database.
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/integration/**"],
          env: { NODE_ENV: "test" },
        },
      },
      {
        // npm run test:int: real PostgreSQL (Neon dev branch), needs TEST_DATABASE_URL in .env.
        test: {
          name: "integration",
          include: ["test/integration/**/*.int.test.ts"],
          env: { NODE_ENV: "test" },
          testTimeout: 30_000,
          hookTimeout: 30_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
