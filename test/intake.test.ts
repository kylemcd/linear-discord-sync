import { describe, expect, it } from "vitest";
import { DiscordApiError } from "../src/discord/rest";
import { intakeThread, MAX_INTAKE_ATTEMPTS } from "../src/sync/intake";
import { sweepActiveThreads } from "../src/sync/cron";
import { FORUM, GUILD, LABEL, STATE, TAG, makeServices, newSnowflake } from "./helpers";

describe("intake (Discord post → Linear issue)", () => {
  it("creates one Triage issue with labels, description, link, tag and ack (brief test 1)", async () => {
    const { s, discord, linear } = makeServices();
    const threadId = discord.addPost({ tags: [TAG.bug, TAG.dashboard] });

    await intakeThread(s, threadId);

    expect(linear.issues.size).toBe(1);
    const issue = [...linear.issues.values()][0]!;
    expect(issue.title).toBe("Profile image fails to upload");
    expect(issue.state.id).toBe(STATE.triage.id);
    expect(issue.teamId).toBe("team-eng");
    expect(issue.labels.nodes.map((l) => l.id).sort()).toEqual([LABEL.bug, LABEL.dashboard].sort());
    expect(issue.description).toContain("Uploading a PNG from account settings produces an error.");
    expect(issue.description).toContain("### Discord report");
    expect(issue.description).toContain(`https://discord.com/channels/${GUILD}/${threadId}`);
    expect(issue.description).toContain("Forum: #bug-reports");
    expect(issue.description).toContain("Rae Porter (@reporter");

    expect(linear.links).toEqual([{ issueId: issue.id, url: `https://discord.com/channels/${GUILD}/${threadId}` }]);
    expect(discord.tags(threadId)).toEqual([TAG.bug, TAG.dashboard, TAG.triage]);

    expect(discord.sent).toHaveLength(1);
    expect(discord.sent[0]!.embeds?.[0]?.title).toBe(`Tracked as ${issue.identifier}`);
    expect(discord.sent[0]!.embeds?.[0]?.url).toBe(issue.url);

    const row = await s.db.getByThread(threadId);
    expect(row).toMatchObject({
      status: "created",
      discord_guild_id: GUILD,
      discord_forum_channel_id: FORUM,
      discord_initial_message_id: threadId,
      linear_issue_id: issue.id,
      linear_issue_identifier: issue.identifier,
    });
  });

  it("adds forum default labels", async () => {
    const { s, discord, linear } = makeServices({ forum: { defaultLabelIds: ["l-feature"] } });
    await intakeThread(s, discord.addPost({ tags: [] }));
    expect([...linear.issues.values()][0]!.labels.nodes.map((l) => l.id)).toEqual(["l-feature"]);
  });

  it("does not create a second issue when the event is replayed (brief test 5)", async () => {
    const { s, discord, linear } = makeServices();
    const threadId = discord.addPost();
    await intakeThread(s, threadId);
    await intakeThread(s, threadId);
    await intakeThread(s, threadId);
    expect(linear.createCalls).toBe(1);
    expect(linear.issues.size).toBe(1);
    expect(discord.sent).toHaveLength(1);
  });

  it("creates one issue when the gateway and the sweep race", async () => {
    const { s, discord, linear } = makeServices();
    const threadId = discord.addPost();
    await Promise.all([intakeThread(s, threadId), intakeThread(s, threadId), sweepActiveThreads(s)]);
    expect(linear.issues.size).toBe(1);
    expect(discord.sent.filter((m) => m.embeds)).toHaveLength(1);
  });

  it("recovers without duplicating when Linear created the issue but the response was lost", async () => {
    const { s, discord, linear } = makeServices();
    linear.createThenFail = 1;
    const threadId = discord.addPost();

    await intakeThread(s, threadId);
    expect(linear.issues.size).toBe(1);
    expect((await s.db.getByThread(threadId))!.status).toBe("created");
    expect(discord.sent).toHaveLength(1);
  });

  it("retries with backoff, posts one failure notice, and gives up after max attempts", async () => {
    let now = Date.now();
    const { s, discord, linear } = makeServices({ now: () => now });
    linear.failCreate = 100;
    const threadId = discord.addPost();

    await intakeThread(s, threadId);
    let row = (await s.db.getByThread(threadId))!;
    expect(row.status).toBe("pending");
    expect(row.intake_attempts).toBe(1);
    expect(row.next_attempt_at).toBeGreaterThan(now);
    expect(row.last_error).toContain("Linear is down");

    for (let i = 1; i < MAX_INTAKE_ATTEMPTS; i++) {
      now += 2 * 3_600_000;
      await intakeThread(s, threadId);
    }
    row = (await s.db.getByThread(threadId))!;
    expect(row.status).toBe("failed");
    expect(linear.issues.size).toBe(0);
    const notices = discord.sent.filter((m) => m.content?.includes("queued for retry"));
    expect(notices).toHaveLength(1);

    // A failed intake stays put until an admin retries it.
    linear.failCreate = 0;
    await intakeThread(s, threadId);
    expect(linear.issues.size).toBe(0);
    await s.db.update(threadId, { status: "pending", next_attempt_at: 0 }, now);
    await intakeThread(s, threadId, { force: true });
    expect(linear.issues.size).toBe(1);
  });

  it("finishes the ack on a later run when Discord was failing", async () => {
    const { s, discord, linear } = makeServices();
    const threadId = discord.addPost();
    discord.failSend = new DiscordApiError(500, undefined, "Discord down");

    await intakeThread(s, threadId);
    expect(linear.issues.size).toBe(1);
    const row = (await s.db.getByThread(threadId))!;
    expect(row.status).toBe("created");
    expect(row.ack_message_id).toBeNull();

    discord.failSend = null;
    await intakeThread(s, threadId);
    expect(linear.createCalls).toBe(1);
    expect(discord.sent).toHaveLength(1);
  });

  it("ignores threads in unconfigured forums and posts older than intakeSince", async () => {
    const { s, discord, linear } = makeServices();
    const other = discord.addPost();
    discord.threads.get(other)!.parent_id = "999";
    await intakeThread(s, other);

    const old = newSnowflake(Date.parse("2019-06-01T00:00:00Z"));
    discord.threads.set(old, { ...discord.threads.get(other)!, id: old, parent_id: FORUM });
    await intakeThread(s, old);

    expect(linear.issues.size).toBe(0);
    expect(await s.db.getByThread(other)).toBeNull();
  });

  it("backfills a post older than intakeSince when an admin forces it", async () => {
    const { s, discord, linear } = makeServices();
    const old = newSnowflake(Date.parse("2019-06-01T00:00:00Z"));
    const template = discord.threads.get(discord.addPost())!;
    discord.threads.clear();
    discord.threads.set(old, { ...template, id: old });
    discord.messages.set(old, { id: old, content: "old post", attachments: [] });

    await sweepActiveThreads(s);
    expect(linear.issues.size).toBe(0);

    await intakeThread(s, old, { force: true });
    expect(linear.issues.size).toBe(1);
    expect(discord.tags(old)).toContain(TAG.triage);
  });

  it("the sweep picks up posts the gateway missed", async () => {
    const { s, discord, linear } = makeServices();
    discord.addPost();
    discord.addPost();
    await sweepActiveThreads(s);
    expect(linear.issues.size).toBe(2);
    await sweepActiveThreads(s);
    expect(linear.createCalls).toBe(2);
  });

  it("waits for the first message when Discord announces the post before it exists", async () => {
    const { s, discord, linear } = makeServices();
    const threadId = discord.addPost({ body: "the real report" });
    discord.starterMissingFor = 2;
    await intakeThread(s, threadId);
    expect([...linear.issues.values()][0]!.description).toContain("the real report");
  });

  it("retries later instead of filing an empty issue when the first message is still missing", async () => {
    let now = Date.now();
    const { s, discord, linear } = makeServices({ now: () => now });
    const threadId = discord.addPost({ body: "the real report" });
    discord.starterMissingFor = 4;
    await intakeThread(s, threadId);
    expect(linear.issues.size).toBe(0);
    expect((await s.db.getByThread(threadId))!.status).toBe("pending");

    now += 10 * 60_000;
    await intakeThread(s, threadId);
    expect([...linear.issues.values()][0]!.description).toContain("the real report");
  });

  it("optionally prefixes the thread name", async () => {
    const { s, discord, linear } = makeServices({ forum: { prefixIssueIdentifier: true } });
    const threadId = discord.addPost({ title: "Settings page freezes" });
    await intakeThread(s, threadId);
    const identifier = [...linear.issues.values()][0]!.identifier;
    expect(discord.threads.get(threadId)!.name).toBe(`[${identifier}] Settings page freezes`);
  });
});
