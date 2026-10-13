import { env } from "cloudflare:test";
import type { APIEmbed, APIMessage, APIThreadChannel } from "discord-api-types/v10";
import type { Config, ForumConfig } from "../src/config";
import { Db } from "../src/db";
import { DiscordApiError, type DiscordRest, type ThreadPatch } from "../src/discord/rest";
import { LinearApiError, type CreateIssueInput, type LinearClient, type LinearIssue } from "../src/linear/client";
import type { Services } from "../src/services";

export const GUILD = "100000000000000000";
export const FORUM = "200000000000000000";

export const TAG = {
  triage: "t-triage",
  accepted: "t-accepted",
  inProgress: "t-in-progress",
  fixed: "t-fixed",
  closed: "t-closed",
  needsInfo: "t-needs-info",
  bug: "t-bug",
  dashboard: "t-dashboard",
  api: "t-api",
};

export const STATE = {
  triage: { id: "s-triage", name: "Triage", type: "triage" },
  todo: { id: "s-todo", name: "Todo", type: "unstarted" },
  inProgress: { id: "s-in-progress", name: "In Progress", type: "started" },
  needsInfo: { id: "s-needs-info", name: "Needs Info", type: "unstarted" },
  done: { id: "s-done", name: "Done", type: "completed" },
  canceled: { id: "s-canceled", name: "Canceled", type: "canceled" },
  duplicate: { id: "s-duplicate", name: "Duplicate", type: "duplicate" },
};

export const LABEL = { bug: "l-bug", dashboard: "l-dashboard", api: "l-api" };

export function forumConfig(overrides: Partial<ForumConfig> = {}): ForumConfig {
  return {
    name: "bug-reports",
    linearTeamId: "team-eng",
    triageStateId: STATE.triage.id,
    statusTags: {
      [STATE.triage.id]: TAG.triage,
      [STATE.todo.id]: TAG.accepted,
      [STATE.needsInfo.id]: TAG.needsInfo,
      "type:started": TAG.inProgress,
      "type:completed": TAG.fixed,
      "type:canceled": TAG.closed,
    },
    labelTags: { [TAG.bug]: LABEL.bug, [TAG.dashboard]: LABEL.dashboard, [TAG.api]: LABEL.api },
    notify: { [STATE.needsInfo.id]: "The team needs more information.", "type:completed": "This issue has been marked fixed." },
    archiveCompletedAfterDays: 7,
    onLinearIssueDeletedTagId: TAG.closed,
    commentOnThreadDeleted: true,
    ...overrides,
  };
}

export function testConfig(forum: Partial<ForumConfig> = {}): Config {
  return { guildId: GUILD, intakeSince: "2020-01-01T00:00:00Z", forums: { [FORUM]: forumConfig(forum) } };
}

/** A snowflake for "now", so it passes the intakeSince filter. */
let seq = 0;
export function newSnowflake(time = Date.now()): string {
  return ((BigInt(time - 1420070400000) << 22n) + BigInt(seq++)).toString();
}

type FakeThread = Pick<APIThreadChannel, "id" | "parent_id" | "guild_id" | "name" | "owner_id" | "applied_tags"> & {
  thread_metadata: { archived: boolean; locked: boolean };
};

export class FakeDiscord {
  threads = new Map<string, FakeThread>();
  messages = new Map<string, Partial<APIMessage>>();
  sent: Array<{ channelId: string; content?: string; embeds?: APIEmbed[]; ping: string[] }> = [];
  patches: Array<{ threadId: string; patch: ThreadPatch }> = [];
  failPatch: Error | null = null;
  failSend: Error | null = null;
  /** getMessage for a starter message returns 404 this many times first. */
  starterMissingFor = 0;
  private nextId = 1;

  addPost(opts: { tags?: string[]; title?: string; body?: string; author?: string } = {}): string {
    const id = newSnowflake();
    this.threads.set(id, {
      id,
      parent_id: FORUM,
      guild_id: GUILD,
      name: opts.title ?? "Profile image fails to upload",
      owner_id: opts.author ?? "300",
      applied_tags: opts.tags ?? [TAG.bug, TAG.dashboard],
      thread_metadata: { archived: false, locked: false },
    });
    this.messages.set(id, {
      id,
      content: opts.body ?? "Uploading a PNG from account settings produces an error.",
      attachments: [],
      author: { id: opts.author ?? "300", username: "reporter", global_name: "Rae Porter" } as APIMessage["author"],
    });
    return id;
  }

  tags(threadId: string): string[] {
    return this.threads.get(threadId)?.applied_tags ?? [];
  }

  async getThread(id: string) {
    const t = this.threads.get(id);
    if (!t) throw new DiscordApiError(404, 10003, "Unknown Channel");
    return structuredClone(t) as unknown as APIThreadChannel;
  }

  async getMessage(_channelId: string, id: string) {
    if (this.starterMissingFor > 0) {
      this.starterMissingFor--;
      throw new DiscordApiError(404, 10008, "Unknown Message");
    }
    const m = this.messages.get(id);
    if (!m) throw new DiscordApiError(404, 10008, "Unknown Message");
    return m as APIMessage;
  }

  async patchThread(threadId: string, patch: ThreadPatch) {
    if (this.failPatch) throw this.failPatch;
    const t = this.threads.get(threadId);
    if (!t) throw new DiscordApiError(404, 10003, "Unknown Channel");
    if (t.thread_metadata.archived && patch.archived !== false && (patch.applied_tags || patch.name)) {
      throw new DiscordApiError(400, 50083, "Thread is archived");
    }
    this.patches.push({ threadId, patch });
    if (patch.applied_tags) t.applied_tags = [...patch.applied_tags];
    if (patch.name) t.name = patch.name;
    if (patch.archived !== undefined) t.thread_metadata.archived = patch.archived;
    if (patch.locked !== undefined) t.thread_metadata.locked = patch.locked;
    return structuredClone(t) as unknown as APIThreadChannel;
  }

  async sendMessage(channelId: string, message: { content?: string; embeds?: APIEmbed[] }, ping: string[] = []) {
    if (this.failSend) throw this.failSend;
    this.sent.push({ channelId, ...message, ping });
    return { id: `m-${this.nextId++}` } as APIMessage;
  }

  async listActiveThreads(_guildId: string) {
    return { threads: [...this.threads.values()].filter((t) => !t.thread_metadata.archived), members: [] };
  }
}

type StoredIssue = LinearIssue & { title: string; description: string; teamId: string };

export class FakeLinear {
  issues = new Map<string, StoredIssue>();
  createCalls = 0;
  failCreate = 0;
  /** Simulate a crash after Linear accepted the issue but before we saw the response. */
  createThenFail = 0;
  links: Array<{ issueId: string; url: string }> = [];
  comments: Array<{ issueId: string; body: string }> = [];
  /** getIssue returns the snapshot from before the latest change this many times. */
  staleReads = 0;
  private previous = new Map<string, StoredIssue>();
  private n = 100;
  private clock = Date.parse("2026-01-01T00:00:00Z");

  async getIssue(id: string) {
    if (this.staleReads > 0 && this.previous.has(id)) {
      this.staleReads--;
      return structuredClone(this.previous.get(id)!);
    }
    const i = this.issues.get(id);
    return i ? structuredClone(i) : null;
  }

  async getIssues(ids: string[]) {
    return ids.flatMap((id) => (this.issues.has(id) && !this.issues.get(id)!.trashed ? [structuredClone(this.issues.get(id)!)] : []));
  }

  async createIssue(input: CreateIssueInput) {
    this.createCalls++;
    if (this.failCreate > 0) {
      this.failCreate--;
      throw new LinearApiError("Linear is down");
    }
    if (this.issues.has(input.id)) throw new LinearApiError("Entity already exists");
    const state = Object.values(STATE).find((s) => s.id === input.stateId)!;
    const identifier = `ENG-${this.n++}`;
    const issue: StoredIssue = {
      id: input.id,
      identifier,
      url: `https://linear.app/test/issue/${identifier}`,
      updatedAt: this.tick(),
      state,
      labels: { nodes: input.labelIds.map((id) => ({ id })) },
      title: input.title,
      description: input.description,
      teamId: input.teamId,
    };
    this.issues.set(input.id, issue);
    if (this.createThenFail > 0) {
      this.createThenFail--;
      throw new LinearApiError("socket hang up");
    }
    return structuredClone(issue);
  }

  async linkUrl(issueId: string, url: string) {
    this.links.push({ issueId, url });
  }

  async createComment(issueId: string, body: string) {
    this.comments.push({ issueId, body });
  }

  async prepareUpload(): Promise<never> {
    throw new Error("not used in tests");
  }

  setState(issueId: string, state: (typeof STATE)[keyof typeof STATE]) {
    this.change(issueId, (i) => (i.state = state));
  }

  setLabels(issueId: string, labelIds: string[]) {
    this.change(issueId, (i) => (i.labels = { nodes: labelIds.map((id) => ({ id })) }));
  }

  private change(issueId: string, fn: (i: StoredIssue) => void) {
    const issue = this.issues.get(issueId)!;
    this.previous.set(issueId, structuredClone(issue));
    fn(issue);
    issue.updatedAt = this.tick();
  }

  private tick(): string {
    this.clock += 1000;
    return new Date(this.clock).toISOString();
  }
}

export function makeServices(opts: { forum?: Partial<ForumConfig>; now?: () => number } = {}) {
  const discord = new FakeDiscord();
  const linear = new FakeLinear();
  const s: Services = {
    config: testConfig(opts.forum),
    db: new Db(env.DB),
    discord: discord as unknown as DiscordRest,
    linear: linear as unknown as LinearClient,
    now: opts.now ?? (() => Date.now()),
    sleep: async () => {},
  };
  return { s, discord, linear };
}
