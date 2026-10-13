// Deployment-specific values stay out of git:
//   - src/config.local.ts holds the server, forum, tag and Linear IDs.
//   - D1_DATABASE_ID in .dev.vars holds the Cloudflare database ID.
// Both are gitignored and written by `pnpm run setup`.
//
//   (no flag)   require src/config.local.ts                 (predev)
//   --create    copy the example if it's missing             (tests, typecheck)
//   --deploy    require both, then write wrangler.local.jsonc (deploy, migrations)
import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";

const local = "src/config.local.ts";
const flags = process.argv.slice(2);

if (!existsSync(local)) {
  if (flags.includes("--create")) {
    copyFileSync("src/config.example.ts", local);
    console.log(`Created ${local} from the example. Run pnpm run setup before deploying.`);
  } else {
    console.error(`Missing ${local}. Run pnpm run setup to create it (or copy src/config.example.ts and fill it in).`);
    process.exit(1);
  }
}

if (flags.includes("--deploy")) {
  const vars = existsSync(".dev.vars") ? readFileSync(".dev.vars", "utf8") : "";
  const dbId = vars.match(/^D1_DATABASE_ID=(\S+)/m)?.[1];
  if (!dbId) {
    console.error("Missing D1_DATABASE_ID in .dev.vars. Run pnpm run setup to create or find the database.");
    process.exit(1);
  }
  const source = readFileSync("wrangler.jsonc", "utf8");
  const filled = source.replace(/("database_id":\s*")[^"]*(")/, `$1${dbId}$2`);
  writeFileSync(
    "wrangler.local.jsonc",
    `// GENERATED from wrangler.jsonc with your D1_DATABASE_ID. Gitignored; edit wrangler.jsonc instead.\n${filled}`,
  );
}
