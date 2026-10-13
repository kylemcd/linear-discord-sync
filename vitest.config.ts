import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig(async () => {
  const migrations = await readD1Migrations("./migrations");
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            DISCORD_BOT_TOKEN: "test-discord-token",
            LINEAR_API_KEY: "test-linear-key",
            LINEAR_WEBHOOK_SECRET: "test-webhook-secret",
            ADMIN_TOKEN: "test-admin-token",
          },
        },
      }),
    ],
    test: { setupFiles: ["./test/apply-migrations.ts"] },
  };
});
