import { describe, expect, it } from "vitest";
import { DiscordApiError } from "../src/discord/rest";
import { runMaintenance } from "../src/sync/cron";
import { intakeThread } from "../src/sync/intake";
import { handleThreadDeleted, syncIssueToDiscord } from "../src/sync/issueToDiscord";
import { LABEL, STATE, TAG, makeServices } from "./helpers";

async function tracked(opts: Parameters<typeof makeServices>[0] = {}) {
  const ctx = makeServices(opts);
  const threadId = ctx.discord.addPost({ tags: [TAG.bug, TAG.dashboard] });
  await intakeThread(ctx.s, threadId);
  const row = (await ctx.s.db.getByThread(threadId))!;
  ctx.discord.patches = [];
  ctx.discord.sent = [];
  const sync = async () => syncIssueToDiscord(ctx.s, (await ctx.s.db.getByThread(threadId))!);
  return { ...ctx, threadId, issueId: row.linear_issue_id, sync };
}

describe("Linear status → Discord tags", () => {
  it("follows Triage → Todo → In Progress → Done, preserving other tags (brief tests 2-4, 6)", async () => {
    const { discord, linear, threadId, issueId, sync } = await tracked({ forum: { notify: {} } });
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.triage]);

    linear.setState(issueId, STATE.todo);
    await sync();
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.accepted]);

    linear.setState(issueId, STATE.inProgress);
    await sync();
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.inProgress]);

    linear.setState(issueId, STATE.done);
    await sync();
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.fixed]);

    expect(discord.sent).toHaveLength(0); // no state-change chatter
  });

  it("does not call Discord when a webhook is replayed (brief test 5)", async () => {
    const { discord, linear, issueId, sync } = await tracked();
    linear.setState(issueId, STATE.inProgress);
    await sync();
    expect(discord.patches).toHaveLength(1);
    await sync();
    await sync();
    expect(discord.patches).toHaveLength(1);
  });

  it("syncs mapped label changes both ways from Linear only", async () => {
    const { discord, linear, threadId, issueId, sync } = await tracked();
    linear.setLabels(issueId, [LABEL.bug, LABEL.api]); // dashboard removed, api added
    await sync();
    expect(discord.tags(threadId).sort()).toEqual([TAG.bug, TAG.api, TAG.triage].sort());

    // A mapped tag added by a user in Discord survives unrelated syncs.
    discord.threads.get(threadId)!.applied_tags!.push(TAG.dashboard);
    linear.setState(issueId, STATE.todo);
    await sync();
    expect(discord.tags(threadId)).toContain(TAG.dashboard);
  });

  it("notifies the reporter once per state entry", async () => {
    const { discord, linear, issueId, sync } = await tracked();
    linear.setState(issueId, STATE.needsInfo);
    await sync();
    await sync();
    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0]!.content).toBe("<@300> The team needs more information.");
    expect(discord.sent[0]!.ping).toEqual(["300"]);

    linear.setState(issueId, STATE.todo);
    await sync();
    linear.setState(issueId, STATE.done);
    await sync();
    expect(discord.sent.map((m) => m.content)).toEqual([
      "<@300> The team needs more information.",
      "<@300> This issue has been marked fixed.",
    ]);
  });

  it("unarchives to retag an archived thread, and re-archives it if the issue is still done", async () => {
    const { s, discord, linear, threadId, issueId, sync } = await tracked();
    discord.threads.get(threadId)!.thread_metadata.archived = true;
    linear.setState(issueId, STATE.canceled);
    await sync();
    expect(discord.tags(threadId)).toContain(TAG.closed);
    expect(discord.threads.get(threadId)!.thread_metadata.archived).toBe(true);

    linear.setState(issueId, STATE.inProgress);
    await sync();
    expect(discord.threads.get(threadId)!.thread_metadata.archived).toBe(false);
    expect((await s.db.getByThread(threadId))!.completed_at).toBeNull();
  });

  it("re-reads when Linear returns an issue older than the webhook", async () => {
    const { s, discord, linear, threadId, issueId } = await tracked();
    linear.setState(issueId, STATE.inProgress);
    linear.staleReads = 2;
    const webhookUpdatedAt = linear.issues.get(issueId)!.updatedAt;
    await syncIssueToDiscord(s, (await s.db.getByThread(threadId))!, { minUpdatedAt: webhookUpdatedAt });
    expect(discord.tags(threadId)).toContain(TAG.inProgress);
  });

  it("leaves the sync flagged when Linear stays stale, and the cron finishes it", async () => {
    const { s, discord, linear, threadId, issueId } = await tracked();
    linear.setState(issueId, STATE.inProgress);
    linear.staleReads = 10;
    const webhookUpdatedAt = linear.issues.get(issueId)!.updatedAt;
    await s.db.update(threadId, { needs_sync: 1 }, Date.now());
    await syncIssueToDiscord(s, (await s.db.getByThread(threadId))!, { minUpdatedAt: webhookUpdatedAt });
    expect(discord.tags(threadId)).toContain(TAG.triage);
    expect((await s.db.getByThread(threadId))!.needs_sync).toBe(1);

    linear.staleReads = 0;
    await runMaintenance(s);
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.inProgress]);
  });

  it("the drift check catches a status change whose webhook never arrived", async () => {
    const { s, discord, linear, threadId, issueId } = await tracked({ forum: { notify: {} } });
    linear.setState(issueId, STATE.inProgress); // no webhook, no sync call
    await runMaintenance(s);
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.inProgress]);

    discord.patches = [];
    await runMaintenance(s);
    expect(discord.patches).toHaveLength(0);
  });

  it("keeps needs_sync set and retries from the cron after a Discord failure", async () => {
    const { s, discord, linear, threadId, issueId, sync } = await tracked();
    await s.db.update(threadId, { needs_sync: 1 }, Date.now());
    discord.failPatch = new DiscordApiError(500, undefined, "boom");
    linear.setState(issueId, STATE.todo);
    await sync();
    let row = (await s.db.getByThread(threadId))!;
    expect(row.needs_sync).toBe(1);
    expect(row.sync_attempts).toBe(1);
    expect(linear.issues.get(issueId)!.state.id).toBe(STATE.todo.id); // Linear untouched

    discord.failPatch = null;
    await runMaintenance(s);
    row = (await s.db.getByThread(threadId))!;
    expect(row.needs_sync).toBe(0);
    expect(discord.tags(threadId)).toContain(TAG.accepted);
  });
});

describe("auto-archive", () => {
  it("treats Linear's duplicate state type as finished", async () => {
    const { s, linear, threadId, issueId, sync } = await tracked();
    linear.setState(issueId, STATE.duplicate);
    await sync();
    expect((await s.db.getByThread(threadId))!.completed_at).not.toBeNull();
  });

  it("archives a completed thread after the configured delay", async () => {
    let now = Date.now();
    const { s, discord, linear, threadId, issueId } = await tracked({ now: () => now, forum: { lockOnArchive: true } });
    linear.setState(issueId, STATE.done);
    await syncIssueToDiscord(s, (await s.db.getByThread(threadId))!);

    await runMaintenance(s);
    expect(discord.threads.get(threadId)!.thread_metadata.archived).toBe(false);

    now += 7 * 86_400_000 + 1;
    await runMaintenance(s);
    expect(discord.threads.get(threadId)!.thread_metadata).toEqual({ archived: true, locked: true });
    expect((await s.db.getByThread(threadId))!.archived_at).toBe(now);
  });
});

describe("deletion never cascades", () => {
  it("tags the thread Closed when the Linear issue is deleted", async () => {
    const { s, discord, linear, threadId, issueId, sync } = await tracked();
    linear.issues.delete(issueId);
    await sync();
    expect(discord.threads.has(threadId)).toBe(true);
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.closed]);
    expect((await s.db.getByThread(threadId))!.linear_deleted_at).not.toBeNull();
  });

  it("treats a trashed issue as deleted, and resumes syncing if it is restored", async () => {
    const { s, discord, linear, threadId, issueId, sync } = await tracked({ forum: { onLinearIssueDeletedTagId: "t-deleted" } });
    linear.issues.get(issueId)!.trashed = true;
    await sync();
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, "t-deleted"]);

    linear.issues.get(issueId)!.trashed = false;
    linear.setState(issueId, STATE.todo);
    await sync();
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.accepted]);
    expect((await s.db.getByThread(threadId))!.linear_deleted_at).toBeNull();
  });

  it("notices a deleted thread on the next sync and comments once", async () => {
    const { s, discord, linear, threadId, issueId, sync } = await tracked();
    discord.threads.delete(threadId);
    linear.setState(issueId, STATE.todo);
    await sync();
    await sync();
    expect(linear.issues.has(issueId)).toBe(true);
    expect(linear.comments).toHaveLength(1);
    expect((await s.db.getByThread(threadId))!.discord_deleted_at).not.toBeNull();
  });

  it("the 30-minute check finds a deleted post without any Linear change", async () => {
    const { s, discord, linear, threadId, issueId } = await tracked();
    await runMaintenance(s);
    expect(linear.comments).toHaveLength(0);

    discord.threads.delete(threadId);
    await runMaintenance(s);
    await runMaintenance(s);
    expect(linear.comments).toEqual([{ issueId, body: "The original Discord thread for this report was deleted." }]);
  });

  it("the 30-minute check asks about an archived post once, and again only after it reopens", async () => {
    const { s, discord, linear, threadId } = await tracked();
    let lookups = 0;
    const getThread = discord.getThread.bind(discord);
    discord.getThread = async (id: string) => {
      if (id === threadId) lookups++;
      return getThread(id);
    };

    discord.threads.get(threadId)!.thread_metadata.archived = true;
    await runMaintenance(s);
    await runMaintenance(s);
    expect(lookups).toBe(1);
    expect(linear.comments).toHaveLength(0);

    discord.threads.get(threadId)!.thread_metadata.archived = false;
    await runMaintenance(s); // active again: flag cleared
    discord.threads.get(threadId)!.thread_metadata.archived = true;
    await runMaintenance(s);
    expect(lookups).toBe(2);
  });

  it("comments on the Linear issue when the thread is deleted", async () => {
    const { s, discord, linear, threadId, issueId } = await tracked();
    discord.threads.delete(threadId);
    await handleThreadDeleted(s, threadId);
    await handleThreadDeleted(s, threadId);
    expect(linear.issues.has(issueId)).toBe(true);
    expect(linear.comments).toEqual([{ issueId, body: "The original Discord thread for this report was deleted." }]);
  });
});
