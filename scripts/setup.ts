/**
 * One-command setup and deploy: `pnpm run setup`.
 *
 * Prerequisites (manual, once): a Discord bot token with the Message Content
 * intent on, and a Linear personal API key. Everything else happens here:
 * config.local.ts, the D1 database and schema, deploy with secrets, the Linear
 * webhook, and a first check that the Worker can reach Discord and Linear.
 *
 * Safe to re-run: each step reuses what already exists.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { stdin, stdout } from "node:process";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import {
  discordClient,
  guessDefaultLabel,
  hasMessageContent,
  inviteUrl,
  linearClient,
  matchTags,
  readVars,
  renderConfig,
  writeVar,
  type ForumPlan,
} from "./lib";

const CONFIG_FILE = "src/config.local.ts";
const LOCAL_WRANGLER = "wrangler.local.jsonc";

// Queue input lines so piped answers aren't lost; at end of input, prompts take their default.
const rl = createInterface({ input: stdin });
const lines: string[] = [];
const waiting: Array<(line: string | null) => void> = [];
let inputClosed = false;
rl.on("line", (line) => (waiting.shift() ?? ((l: string | null) => lines.push(l ?? "")))(line));
rl.on("close", () => {
  inputClosed = true;
  for (const w of waiting.splice(0)) w(null);
});
const nextLine = (): Promise<string | null> =>
  lines.length ? Promise.resolve(lines.shift()!) : inputClosed ? Promise.resolve(null) : new Promise((r) => waiting.push(r));
const ask = async (q: string, def = "") => {
  stdout.write(def ? `${q} [${def}] ` : `${q} `);
  const line = await nextLine();
  if (line === null) stdout.write("\n");
  return (line ?? "").trim() || def;
};
const confirm = async (q: string, def = true) => {
  const a = (await ask(`${q} (${def ? "Y/n" : "y/N"})`)).toLowerCase();
  return a === "" ? def : a.startsWith("y");
};
const step = (n: number, title: string) => console.log(`\n\x1b[1m${n}. ${title}\x1b[0m`);
const ok = (msg: string) => console.log(`   \x1b[32m✓\x1b[0m ${msg}`);
const warn = (msg: string) => console.log(`   \x1b[33m!\x1b[0m ${msg}`);
const fail = (msg: string): never => {
  console.error(`\n\x1b[31m✗ ${msg}\x1b[0m`);
  process.exit(1);
};

async function pick<T>(items: T[], label: (t: T) => string, prompt: string): Promise<T> {
  if (items.length === 1) return items[0]!;
  items.forEach((t, i) => console.log(`   ${i + 1}. ${label(t)}`));
  for (;;) {
    const n = Number(await ask(prompt, "1"));
    if (items[n - 1]) return items[n - 1]!;
    if (inputClosed) fail("No valid choice given.");
  }
}

async function pickMany<T>(items: T[], label: (t: T) => string, prompt: string): Promise<T[]> {
  items.forEach((t, i) => console.log(`   ${i + 1}. ${label(t)}`));
  for (;;) {
    const raw = await ask(`${prompt} (comma-separated numbers)`, "all");
    if (raw === "all") return items;
    const chosen = raw.split(",").map((s) => items[Number(s.trim()) - 1]);
    if (chosen.length && chosen.every(Boolean)) return chosen as T[];
    if (inputClosed) fail("No valid choice given.");
  }
}

function wrangler(args: string[], opts: { capture?: boolean; input?: string } = {}, retried = false): { status: number; out: string } {
  const res = spawnSync("node_modules/.bin/wrangler", args, {
    encoding: "utf8",
    stdio: opts.capture || opts.input !== undefined ? ["pipe", "pipe", "pipe"] : "inherit",
    input: opts.input,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false" },
  });
  const out = `${res.stdout ?? ""}${res.stderr ?? ""}`;
  // Wrangler sometimes fails the first API call while refreshing its login token.
  if (res.status !== 0 && !retried && /Authentication error/.test(out)) return wrangler(args, opts, true);
  return { status: res.status ?? 1, out };
}

async function main() {
  console.log("\nDiscord forum ↔ Linear sync: setup\n");

  // ---------------------------------------------------------------- 1
  step(1, "Credentials (.dev.vars)");
  let vars = readVars();
  if (!vars.DISCORD_BOT_TOKEN) {
    console.log("   Discord bot token: discord.com/developers/applications → your app → Bot → Reset Token");
    const token = await ask("   Paste the bot token:");
    if (!token) fail("A Discord bot token is required.");
    writeVar("DISCORD_BOT_TOKEN", token);
  }
  if (!vars.LINEAR_API_KEY) {
    console.log("   Linear API key: Linear → Settings → Security & access → Personal API keys");
    const key = await ask("   Paste the API key:");
    if (!key) fail("A Linear API key is required.");
    writeVar("LINEAR_API_KEY", key);
  }
  if (!vars.ADMIN_TOKEN) writeVar("ADMIN_TOKEN", randomBytes(24).toString("base64url"));
  if (!vars.LINEAR_WEBHOOK_SECRET) writeVar("LINEAR_WEBHOOK_SECRET", `lin_wh_${randomBytes(24).toString("base64url")}`);
  vars = readVars();
  ok("Saved in .dev.vars (gitignored)");

  // ---------------------------------------------------------------- 2
  step(2, "Discord bot");
  const discord = discordClient(vars.DISCORD_BOT_TOKEN!);
  let app = await discord.app().catch((e) => fail(`The Discord bot token was rejected. ${e.message}`));
  ok(`Bot: ${app.name}`);
  while (!hasMessageContent(app)) {
    warn("Message Content intent is off. Turn it on: Developer Portal → your app → Bot → Privileged Gateway Intents.");
    await ask("   Press Enter once it's on.");
    if (inputClosed) fail("Message Content intent is off.");
    app = await discord.app();
  }
  ok("Message Content intent is on");
  let guilds = await discord.guilds();
  while (guilds.length === 0) {
    console.log(`   Invite the bot to your server:\n   ${inviteUrl(app.id)}`);
    await ask("   Press Enter once it's added.");
    if (inputClosed) fail("The bot isn't in a server yet.");
    guilds = await discord.guilds();
  }
  ok(`In ${guilds.length} server${guilds.length === 1 ? "" : "s"}. Invite link, if you need it again: ${inviteUrl(app.id)}`);

  // ---------------------------------------------------------------- 3
  step(3, `Forum mappings (${CONFIG_FILE})`);
  const linear = linearClient(vars.LINEAR_API_KEY!);
  const workspace = await linear.workspace().catch((e) => fail(`The Linear API key was rejected. ${e.message}`));
  ok(`Linear workspace: ${workspace.organization.name} (as ${workspace.viewer.name})`);

  const existing = existsSync(CONFIG_FILE) ? readFileSync(CONFIG_FILE, "utf8") : "";
  const isPlaceholder = !existing || existing.includes("DISCORD_SERVER_ID");
  const loadConfig = async () =>
    ((await import(`${pathToFileURL(resolve(CONFIG_FILE)).href}?v=${Date.now()}`)) as typeof import("../src/config.local")).config;
  if (isPlaceholder || !(await confirm(`   ${CONFIG_FILE} already exists. Keep it?`))) {
    // Existing mappings win over name matching, so renamed tags keep working.
    const previous = isPlaceholder ? undefined : await loadConfig().catch(() => undefined);
    const guild = await pick(guilds, (g) => g.name, "   Server:");
    const forums = await discord.forums(guild.id);
    if (forums.length === 0) fail(`No forum channels in ${guild.name} that the bot can see.`);
    const chosen = await pickMany(forums, (f) => `#${f.name} (${f.available_tags.length} tags)`, "   Forums to sync:");
    const team = await pick(workspace.teams.nodes, (t) => `${t.name} (${t.key})`, "   Linear team for new issues:");
    if (!team.triageEnabled) warn(`Triage is off for ${team.name}. Turn it on in Linear: Team settings → Triage.`);
    const labels = [...team.labels.nodes, ...workspace.issueLabels.nodes.filter((l) => !l.team)];

    const plans: ForumPlan[] = [];
    for (const forum of chosen) {
      const match = matchTags(forum, team, labels, previous?.forums[forum.id]);
      const guess = guessDefaultLabel(forum.name, labels);
      console.log(`\n   #${forum.name}`);
      for (const m of match.statusTags) console.log(`     status  ${m.tag.name.padEnd(16)} ← ${m.state}`);
      for (const m of match.labelTags) console.log(`     label   ${m.tag.name.padEnd(16)} ↔ ${m.label}`);
      if (match.unmatched.length) console.log(`     ignored ${match.unmatched.map((t) => t.name).join(", ")}`);
      if (match.statusTags.length === 0) warn("No tags match a Linear state, so status changes won't show. Add tags like Triage / In Progress / Done.");
      const answer = await ask(`     Label every issue from #${forum.name} with (blank for none):`, guess?.name ?? "");
      const defaultLabel = answer ? labels.find((l) => l.name.toLowerCase() === answer.toLowerCase()) : undefined;
      if (answer && !defaultLabel) warn(`No Linear label named "${answer}"; skipping.`);
      plans.push({ forum, team, match, defaultLabel });
    }
    writeFileSync(CONFIG_FILE, renderConfig({ guild, plans, intakeSince: new Date().toISOString().replace(/\.\d+Z$/, "Z") }));
    ok(`Wrote ${CONFIG_FILE}. Edit it any time, then run pnpm run deploy.`);
  } else {
    ok(`Keeping ${CONFIG_FILE}`);
  }
  const config = await loadConfig();
  const { validateConfig } = await import("../src/config");
  const problems = validateConfig(config);
  if (problems.length) fail(`Config problems:\n  ${problems.join("\n  ")}`);

  // ---------------------------------------------------------------- 4
  step(4, "Cloudflare");
  if (!/You are logged in/.test(wrangler(["whoami"], { capture: true }).out)) {
    console.log("   Opening the Cloudflare login in your browser…");
    if (wrangler(["login"]).status !== 0) fail("Cloudflare login failed.");
  }
  ok("Logged in to Cloudflare");

  const dbName = readFileSync("wrangler.jsonc", "utf8").match(/"database_name":\s*"([^"]+)"/)?.[1] ?? "discord_linear_sync";
  const dbId = readVars().D1_DATABASE_ID ?? "";
  const list = wrangler(["d1", "list", "--json"], { capture: true });
  let databases: Array<{ uuid: string; name: string }> = [];
  try {
    databases = JSON.parse(list.out.slice(list.out.indexOf("[")));
  } catch {
    fail(`Could not list D1 databases:\n${list.out}`);
  }
  let db = databases.find((d) => d.uuid === dbId) ?? databases.find((d) => d.name === dbName);
  if (!db) {
    const created = wrangler(["d1", "create", dbName], { capture: true });
    const uuid = created.out.match(/"database_id":\s*"([0-9a-f-]{36})"/)?.[1];
    if (!uuid) fail(`Could not create the D1 database:\n${created.out}`);
    db = { uuid: uuid!, name: dbName };
    ok(`Created D1 database ${dbName}`);
  } else {
    ok(`Using D1 database ${db.name}`);
  }
  if (db.uuid !== dbId) {
    writeVar("D1_DATABASE_ID", db.uuid);
    ok("Saved the database ID in .dev.vars");
  }
  // wrangler.jsonc has a placeholder ID; this writes wrangler.local.jsonc with the real one.
  if (spawnSync("node", ["scripts/ensure-config.mjs", "--deploy"], { stdio: "inherit" }).status !== 0) fail("Could not prepare the deploy config.");
  const migrate = wrangler(["d1", "migrations", "apply", "DB", "--remote", "-c", LOCAL_WRANGLER], { capture: true });
  if (migrate.status !== 0) fail(`Applying the schema failed:\n${migrate.out}`);
  ok("Database schema is up to date");

  // ---------------------------------------------------------------- 5
  step(5, "Deploy");
  const secretsFile = join(tmpdir(), `dls-secrets-${process.pid}.env`);
  const secretKeys = ["DISCORD_BOT_TOKEN", "LINEAR_API_KEY", "LINEAR_WEBHOOK_SECRET", "ADMIN_TOKEN"] as const;
  writeFileSync(secretsFile, secretKeys.map((k) => `${k}=${vars[k]}`).join("\n"), { mode: 0o600 });
  let deploy;
  try {
    deploy = wrangler(["deploy", "-c", LOCAL_WRANGLER, "--secrets-file", secretsFile], { capture: true });
  } finally {
    rmSync(secretsFile, { force: true });
  }
  if (deploy.status !== 0) fail(`Deploy failed:\n${deploy.out}`);
  let workerUrl = deploy.out.match(/https:\/\/[^\s]+\.workers\.dev/)?.[0] ?? vars.WORKER_URL ?? "";
  if (!workerUrl) workerUrl = await ask("   Deployed. What's the Worker's URL (https://…)?");
  writeVar("WORKER_URL", workerUrl);
  ok(`Deployed to ${workerUrl}`);

  // ---------------------------------------------------------------- 6
  step(6, "Linear webhook");
  const hookUrl = `${workerUrl.replace(/\/$/, "")}/webhooks/linear`;
  const teamIds = [...new Set(Object.values(config.forums).map((f) => f.linearTeamId))];
  try {
    const hooks = await linear.webhooks();
    let secret = vars.LINEAR_WEBHOOK_SECRET!;
    for (const teamId of teamIds) {
      const same = (u: string | null) => (u ?? "").replace(/\/+$/, "") === hookUrl;
      const hook = hooks.find((h) => same(h.url) && (h.allPublicTeams || h.team?.id === teamId));
      if (!hook) {
        await linear.createWebhook({ url: hookUrl, teamId, secret });
        ok(`Created the webhook for team ${workspace.teams.nodes.find((t) => t.id === teamId)?.name ?? teamId}`);
        continue;
      }
      if (!hook.enabled) await linear.enableWebhook(hook.id);
      if (hook.secret && hook.secret !== secret) {
        // A webhook made by hand: use its secret rather than replacing it.
        secret = hook.secret;
        writeVar("LINEAR_WEBHOOK_SECRET", secret);
        if (wrangler(["secret", "put", "LINEAR_WEBHOOK_SECRET", "-c", LOCAL_WRANGLER], { input: secret }).status !== 0)
          fail("Could not update LINEAR_WEBHOOK_SECRET.");
        ok("Using the existing webhook's signing secret");
      }
      ok("Webhook already registered");
    }
  } catch (err) {
    warn(`Could not set up the webhook automatically (${(err as Error).message}). This needs a Linear admin's API key.`);
    console.log(`   Create it by hand: Linear → Settings → API → Webhooks → New webhook
     URL: ${hookUrl}
     Events: Issues
   then run: pnpm wrangler secret put LINEAR_WEBHOOK_SECRET   (paste the webhook's signing secret)`);
  }

  // ---------------------------------------------------------------- 7
  step(7, "Check the Worker");
  let results: Record<string, string> | null = null;
  for (let i = 0; i < 5 && !results; i++) {
    await new Promise((r) => setTimeout(r, 2000)); // let the new version roll out
    const res = await fetch(`${workerUrl}/admin/sweep`, {
      method: "POST",
      headers: { Authorization: `Bearer ${readVars().ADMIN_TOKEN}` },
    }).catch(() => null);
    if (res?.ok) results = ((await res.json()) as { results: Record<string, string> }).results;
  }
  if (!results) warn("Couldn't reach the Worker yet. Check it with pnpm wrangler tail.");
  else {
    const failed = Object.entries(results).filter(([, r]) => r !== "ok");
    if (failed.length) for (const [job, err] of failed) warn(`${job}: ${err}`);
    else ok("The Worker reached Discord and Linear. New posts are picked up within a minute.");
  }

  console.log(`
\x1b[1mDone.\x1b[0m Create a post in ${Object.values(config.forums)
    .map((f) => `#${f.name}`)
    .join(" or ")} to test it.
   Watch live logs:   pnpm wrangler tail
   Change mappings:   edit ${CONFIG_FILE}, then pnpm run deploy
   Re-run setup:      pnpm run setup (safe to repeat)
`);
}

main()
  .catch((err) => fail(err instanceof Error ? err.message : String(err)))
  .finally(() => rl.close());
