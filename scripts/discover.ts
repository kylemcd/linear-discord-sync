/**
 * Read-only: prints the bot invite URL, whether Message Content is on, every
 * forum and tag the bot can see, every Linear team / state / label, and how
 * each forum's tags would be matched. `pnpm run setup` uses the same matching
 * and writes src/config.local.ts for you.
 *
 * Usage: pnpm run discover   (reads .dev.vars)
 */
import { discordClient, hasMessageContent, inviteUrl, linearClient, matchTags, readVars, type Forum } from "./lib";

async function main() {
  const vars = readVars();
  if (!vars.DISCORD_BOT_TOKEN || !vars.LINEAR_API_KEY) {
    console.error("Set DISCORD_BOT_TOKEN and LINEAR_API_KEY in .dev.vars first (or run pnpm run setup).");
    process.exit(1);
  }
  const discord = discordClient(vars.DISCORD_BOT_TOKEN);
  const linear = linearClient(vars.LINEAR_API_KEY);

  const app = await discord.app();
  console.log(`\n== Discord application: ${app.name} (${app.id})`);
  console.log(`Invite URL:\n  ${inviteUrl(app.id)}`);
  console.log(hasMessageContent(app) ? "  ✓ Message Content intent is enabled" : "  ⚠ Message Content intent is OFF (post bodies will be empty)");

  const guilds = await discord.guilds();
  if (guilds.length === 0) console.log("\nThe bot is not in any server yet. Use the invite URL above.");
  const forums: Forum[] = [];
  for (const g of guilds) {
    console.log(`\n== Server: ${g.name}  guildId: ${g.id}`);
    const gForums = await discord.forums(g.id);
    if (gForums.length === 0) console.log("  (no forum channels)");
    for (const f of gForums) {
      forums.push(f);
      console.log(`  #${f.name}  forumChannelId: ${f.id}`);
      for (const t of f.available_tags) console.log(`    tag ${t.id}  ${t.name}${t.moderated ? "  (moderators only)" : ""}`);
    }
  }

  const ws = await linear.workspace();
  for (const team of ws.teams.nodes) {
    console.log(`\n== Linear team: ${team.name} (${team.key})  linearTeamId: ${team.id}`);
    if (!team.triageEnabled) console.log("  ⚠ Triage is not enabled for this team (Team settings → Triage).");
    for (const s of [...team.states.nodes].sort((a, b) => a.position - b.position)) console.log(`    state ${s.id}  ${s.name}  [type:${s.type}]`);
  }
  console.log("\n== Linear labels");
  for (const l of ws.issueLabels.nodes) console.log(`    label ${l.id}  ${l.name}  (${l.team ? l.team.key : "workspace"})`);

  const team = ws.teams.nodes[0];
  if (!team) return;
  const labels = [...team.labels.nodes, ...ws.issueLabels.nodes.filter((l) => !l.team)];
  console.log(`\n== Tag matching against team ${team.key}`);
  for (const f of forums) {
    const m = matchTags(f, team, labels);
    console.log(`  #${f.name}`);
    for (const s of m.statusTags) console.log(`    status  ${s.tag.name.padEnd(16)} ← ${s.state}  ("${s.key}": "${s.tag.id}")`);
    for (const l of m.labelTags) console.log(`    label   ${l.tag.name.padEnd(16)} ↔ ${l.label}  ("${l.tag.id}": "${l.labelId}")`);
    if (m.unmatched.length) console.log(`    ignored ${m.unmatched.map((t) => t.name).join(", ")}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
