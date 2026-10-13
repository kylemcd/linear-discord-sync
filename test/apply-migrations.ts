import { applyD1Migrations, env } from "cloudflare:test";
import { beforeEach } from "vitest";

declare global {
  namespace Cloudflare {
    interface Env {
      TEST_MIGRATIONS?: import("cloudflare:test").D1Migration[];
    }
  }
}

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS ?? []);

// Tests in a file share one database; start each test with empty tables.
beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM issue_mappings"), env.DB.prepare("DELETE FROM processed_events")]);
});
