/** Shared helpers for the local setup scripts (discover, setup). Node only. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";

export const DEV_VARS = ".dev.vars";

export const PERMISSIONS = {
  VIEW_CHANNEL: 1n << 10n,
  EMBED_LINKS: 1n << 14n,
  READ_MESSAGE_HISTORY: 1n << 16n,
  MANAGE_THREADS: 1n << 34n,
  SEND_MESSAGES_IN_THREADS: 1n << 38n,
};
export const PERMISSION_BITS = Object.values(PERMISSIONS).reduce((a, b) => a | b, 0n);
const GATEWAY_MESSAGE_CONTENT = 1 << 18;
const GATEWAY_MESSAGE_CONTENT_LIMITED = 1 << 19;
const GUILD_FORUM = 15;

// ---------- .dev.vars ----------

export function readVars(): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(DEV_VARS)) return vars;
  for (const line of readFileSync(DEV_VARS, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*"?(.*?)"?\s*$/);
    if (m && m[2]) vars[m[1]!] = m[2];
  }
  return vars;
}

/** Set one key in .dev.vars, keeping every other line as it is. */
export function writeVar(key: string, value: string): void {
  const lines = existsSync(DEV_VARS) ? readFileSync(DEV_VARS, "utf8").split("\n") : [];
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i === -1) {
    if (lines.length && lines[lines.length - 1] === "") lines.pop();
    lines.push(`${key}=${value}`, "");
  } else {
    lines[i] = `${key}=${value}`;
  }
  writeFileSync(DEV_VARS, lines.join("\n"), { mode: 0o600 });
}

// ---------- Discord ----------

export type Tag = { id: string; name: string; moderated: boolean };
export type Forum = { id: string; name: string; guild_id: string; type: number; available_tags: Tag[] };
export type Guild = { id: string; name: string };
export type DiscordApp = { id: string; name: string; flags?: number };

export function discordClient(token: string) {
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`https://discord.com/api/v10${path}`, { headers: { Authorization: `Bot ${token}` } });
    if (!res.ok) throw new Error(`Discord ${path}: ${res.status} ${await res.text()}`);
    return res.json() as Promise<T>;
  };
  return {
    app: () => get<DiscordApp>("/oauth2/applications/@me"),
    guilds: () => get<Guild[]>("/users/@me/guilds"),
    forums: async (guildId: string) => (await get<Forum[]>(`/guilds/${guildId}/channels`)).filter((c) => c.type === GUILD_FORUM),
  };
}

export function inviteUrl(appId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${appId}&scope=bot&permissions=${PERMISSION_BITS}`;
}

export function hasMessageContent(app: DiscordApp): boolean {
  const flags = app.flags ?? 0;
  return !!(flags & GATEWAY_MESSAGE_CONTENT) || !!(flags & GATEWAY_MESSAGE_CONTENT_LIMITED);
}

// ---------- Linear ----------

export type State = { id: string; name: string; type: string; position: number };
export type Label = { id: string; name: string; team: { key: string } | null };
export type Team = {
  id: string;
  key: string;
  name: string;
  triageEnabled: boolean;
  states: { nodes: State[] };
  labels: { nodes: Array<{ id: string; name: string }> };
};
export type Webhook = { id: string; url: string | null; secret: string | null; enabled: boolean; team: { id: string } | null; allPublicTeams: boolean };

export function linearClient(apiKey: string) {
  const gql = async <T>(query: string, variables: Record<string, unknown> = {}): Promise<T> => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: apiKey },
      body: JSON.stringify({ query, variables }),
    });
    const body = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
    if (body.errors?.length || !body.data) throw new Error(`Linear: ${body.errors?.map((e) => e.message).join("; ") ?? res.status}`);
    return body.data;
  };
  return {
    workspace: () =>
      gql<{ viewer: { name: string; admin: boolean }; organization: { name: string }; teams: { nodes: Team[] }; issueLabels: { nodes: Label[] } }>(`{
        viewer { name admin }
        organization { name }
        teams { nodes { id key name triageEnabled
          states { nodes { id name type position } }
          labels { nodes { id name } } } }
        issueLabels(first: 250) { nodes { id name team { key } } }
      }`),
    webhooks: async () =>
      (await gql<{ webhooks: { nodes: Webhook[] } }>(`{ webhooks(first: 100) { nodes { id url secret enabled allPublicTeams team { id } } } }`)).webhooks
        .nodes,
    createWebhook: (input: { url: string; teamId: string; secret: string }) =>
      gql(
        `mutation($input: WebhookCreateInput!) { webhookCreate(input: $input) { success } }`,
        { input: { ...input, resourceTypes: ["Issue"], label: "Discord forum sync" } },
      ),
    enableWebhook: (id: string) =>
      gql(`mutation($id: String!) { webhookUpdate(id: $id, input: { enabled: true }) { success } }`, { id }),
  };
}

// ---------- Tag → state / label matching ----------

export const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Common lifecycle tag names that don't share a name with a Linear state. */
const LIFECYCLE_HINTS: Record<string, (states: State[]) => string | undefined> = {
  triage: (s) => s.find((x) => x.type === "triage")?.id,
  new: (s) => s.find((x) => x.type === "triage")?.id,
  accepted: (s) => s.find((x) => norm(x.name) === "todo")?.id ?? "type:unstarted",
  planned: (s) => s.find((x) => norm(x.name) === "todo")?.id ?? "type:unstarted",
  inprogress: () => "type:started",
  started: () => "type:started",
  fixed: () => "type:completed",
  done: () => "type:completed",
  completed: () => "type:completed",
  shipped: () => "type:completed",
  resolved: () => "type:completed",
  closed: () => "type:canceled",
  canceled: () => "type:canceled",
  cancelled: () => "type:canceled",
  wontfix: () => "type:canceled",
  duplicate: (s) => s.find((x) => x.type === "duplicate")?.id ?? "type:duplicate",
};

export interface TagMatch {
  statusTags: Array<{ key: string; tag: Tag; state: string }>;
  labelTags: Array<{ tag: Tag; labelId: string; label: string }>;
  unmatched: Tag[];
}

/**
 * Match each forum tag to a Linear state (by name, then common synonyms) or a
 * label (by name). `previous` is this forum's existing mapping: a tag it
 * already maps keeps that mapping, so renamed tags aren't lost on re-run.
 */
export function matchTags(
  forum: Forum,
  team: Team,
  labels: Array<{ id: string; name: string }>,
  previous?: { statusTags?: Record<string, string>; labelTags?: Record<string, string> },
): TagMatch {
  const result: TagMatch = { statusTags: [], labelTags: [], unmatched: [] };
  const stateName = (key: string) => team.states.nodes.find((s) => s.id === key)?.name ?? key;
  for (const tag of forum.available_tags) {
    const prevStates = Object.entries(previous?.statusTags ?? {}).filter(([, tagId]) => tagId === tag.id);
    if (prevStates.length) {
      for (const [key] of prevStates) result.statusTags.push({ key, tag, state: stateName(key) });
      continue;
    }
    const prevLabel = previous?.labelTags?.[tag.id];
    const prevLabelName = prevLabel && labels.find((l) => l.id === prevLabel)?.name;
    if (prevLabel && prevLabelName) {
      result.labelTags.push({ tag, labelId: prevLabel, label: prevLabelName });
      continue;
    }
    const key = norm(tag.name);
    const byName = team.states.nodes.find((s) => norm(s.name) === key);
    const stateKey = byName?.id ?? LIFECYCLE_HINTS[key]?.(team.states.nodes);
    if (stateKey) {
      const stateName = byName?.name ?? team.states.nodes.find((s) => s.id === stateKey)?.name ?? stateKey;
      result.statusTags.push({ key: stateKey, tag, state: stateName });
      continue;
    }
    const label = labels.find((l) => norm(l.name) === key || norm(l.name) === key.replace(/s$/, ""));
    if (label) result.labelTags.push({ tag, labelId: label.id, label: label.name });
    else result.unmatched.push(tag);
  }
  return result;
}

/** Guess a default label for a forum from its name (#bugs → Bug, #ideas → Idea or Feature). */
export function guessDefaultLabel(forumName: string, labels: Array<{ id: string; name: string }>) {
  const n = norm(forumName).replace(/s$/, "");
  const candidates = n.includes("bug")
    ? ["bug"]
    : n.includes("idea") || n.includes("feature") || n.includes("suggestion") || n.includes("request")
      ? ["idea", "feature", "featurerequest", "improvement"]
      : [n];
  for (const c of candidates) {
    const hit = labels.find((l) => norm(l.name) === c);
    if (hit) return hit;
  }
  return undefined;
}

// ---------- config.local.ts ----------

export interface ForumPlan {
  forum: Forum;
  team: Team;
  match: TagMatch;
  defaultLabel?: { id: string; name: string };
}

/** Render src/config.local.ts for the chosen forums. */
export function renderConfig(input: { guild: Guild; plans: ForumPlan[]; intakeSince: string }): string {
  const q = JSON.stringify;
  const forums = input.plans.map(({ forum, team, match, defaultLabel }) => {
    const triage = team.states.nodes.find((s) => s.type === "triage");
    const done = match.statusTags.some((m) => m.key === "type:completed" || team.states.nodes.find((s) => s.id === m.key)?.type === "completed");
    const closed = match.statusTags.find((m) => m.key === "type:canceled");
    const lines = [
      `    // #${forum.name} → ${team.name} (${team.key})`,
      `    ${q(forum.id)}: {`,
      `      name: ${q(forum.name)},`,
      `      linearTeamId: ${q(team.id)},`,
      `      triageStateId: ${q(triage?.id ?? "ENABLE_TRIAGE_FOR_THIS_TEAM")},`,
      `      defaultLabelIds: [${defaultLabel ? `${q(defaultLabel.id)} /* ${defaultLabel.name} */` : ""}],`,
      `      statusTags: {`,
      ...match.statusTags.map((m) => `        ${q(m.key)}: ${q(m.tag.id)}, // ${m.tag.name} ← ${m.state}`),
      `      },`,
      `      labelTags: {`,
      ...match.labelTags.map((m) => `        ${q(m.tag.id)}: ${q(m.labelId)}, // ${m.tag.name} → ${m.label}`),
      `      },`,
      done ? `      notify: { "type:completed": "This has been marked done. Thanks for the report!" },` : `      notify: {},`,
      `      archiveCompletedAfterDays: 7,`,
      `      lockOnArchive: false,`,
      `      prefixIssueIdentifier: false,`,
      `      onLinearIssueDeletedTagId: ${closed ? `${q(closed.tag.id)}, // ${closed.tag.name}` : "null,"}`,
      `      commentOnThreadDeleted: true,`,
      `    },`,
    ];
    if (match.unmatched.length) {
      lines.splice(1, 0, `    // Unmatched tags (left alone by the bot): ${match.unmatched.map((t) => t.name).join(", ")}`);
    }
    return lines.join("\n");
  });

  return `/**
 * This deployment's sync config, written by \`pnpm run setup\`. Gitignored.
 * \`wrangler deploy\` bundles it into the Worker. Field docs are in src/config.ts.
 * Edit freely, then \`pnpm run deploy\`.
 */
import type { Config } from "./config";

export const config: Config = {
  guildId: ${q(input.guild.id)}, // ${input.guild.name}
  // Posts created before this are never imported by the sweep.
  intakeSince: ${q(input.intakeSince)},
  forums: {
${forums.join("\n")}
  },
};
`;
}
