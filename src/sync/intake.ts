import type { APIMessage, APIThreadChannel } from "discord-api-types/v10";
import type { ForumConfig } from "../config";
import type { MappingRow } from "../db";
import { DiscordApiError, snowflakeTime, threadUrl } from "../discord/rest";
import type { LinearIssue } from "../linear/client";
import { copyAttachmentsToLinear, type UploadedAttachment } from "../linear/uploads";
import { errorMessage, log } from "../log";
import type { Services } from "../services";
import { syncIssueToDiscord } from "./issueToDiscord";

export const MAX_INTAKE_ATTEMPTS = 8;
const FAILURE_NOTICE_AFTER = 3;
const LINEAR_BLUE = 0x5e6ad2;
/**
 * Discord can announce a new post a moment before its first message exists
 * (common with attachments). Wait briefly, then retry via the cron. Only a post
 * older than this with no first message is treated as having none.
 */
const STARTER_MESSAGE_GRACE_MS = 60 * 60_000;
const STARTER_MESSAGE_WAITS_MS = [1000, 3000, 8000];

/**
 * Turn a Discord forum post into exactly one Linear issue, then tag and
 * acknowledge the thread. Safe to call any number of times for the same
 * thread, even from overlapping cron runs: each step is recorded
 * in D1 and skipped once done, and the issue ID is fixed before creation.
 */
export async function intakeThread(
  s: Services,
  threadId: string,
  /** force: an admin asked for this thread. Retries a failed intake and ignores intakeSince (backfill). */
  opts: { force?: boolean } = {},
): Promise<void> {
  let row = await s.db.getByThread(threadId);
  if (row && !opts.force && (row.status === "failed" || intakeComplete(row))) return;
  if (row?.discord_deleted_at) return;

  let thread: APIThreadChannel;
  try {
    thread = await s.discord.getThread(threadId);
  } catch (err) {
    if (err instanceof DiscordApiError && err.notFound) {
      if (row) await s.db.update(threadId, { discord_deleted_at: s.now() }, s.now());
      log.info({ operation: "discord_to_linear", result: "skipped", reason: "thread not found", discordThreadId: threadId });
      return;
    }
    if (row) await recordFailure(s, row, err);
    else log.warn({ operation: "discord_to_linear", result: "retry", discordThreadId: threadId, error: errorMessage(err) });
    return;
  }

  const forumId = thread.parent_id ?? "";
  const forum = s.config.forums[forumId];
  if (!forum) return;
  if (!row && !opts.force && snowflakeTime(threadId) < Date.parse(s.config.intakeSince)) return;

  row ??= await s.db.claimThread({
    threadId,
    guildId: thread.guild_id ?? s.config.guildId,
    forumChannelId: forumId,
    authorId: thread.owner_id ?? null,
    now: s.now(),
  });

  try {
    if (row.status !== "created") {
      row = await createIssue(s, row, thread, forum);
    }
    await finishIntake(s, row, thread, forum);
  } catch (err) {
    await recordFailure(s, row, err);
  }
}

function intakeComplete(row: MappingRow): boolean {
  return row.status === "created" && !!row.ack_message_id && !row.ack_message_id.startsWith("posting:");
}

async function createIssue(s: Services, row: MappingRow, thread: APIThreadChannel, forum: ForumConfig): Promise<MappingRow> {
  const threadId = row.discord_thread_id;

  // A previous attempt may have created the issue and then crashed.
  let issue: LinearIssue | null = row.intake_attempts > 0 ? await s.linear.getIssue(row.linear_issue_id) : null;

  if (!issue) {
    const starter = await getStarterMessage(s, threadId);
    const attachments = starter ? await copyAttachmentsToLinear(s.linear, starter.attachments, { discordThreadId: threadId }) : [];
    const labelIds = [
      ...new Set([
        ...(forum.defaultLabelIds ?? []),
        ...(thread.applied_tags ?? []).flatMap((tag) => (forum.labelTags?.[tag] ? [forum.labelTags[tag]] : [])),
      ]),
    ];
    try {
      issue = await s.linear.createIssue({
        id: row.linear_issue_id,
        teamId: forum.linearTeamId,
        stateId: forum.triageStateId,
        title: thread.name.slice(0, 255) || "Untitled Discord report",
        description: buildDescription({ thread, starter, forum, attachments, guildId: row.discord_guild_id }),
        labelIds,
      });
    } catch (err) {
      // Lost a race with another intake of the same thread, which used the same issue ID.
      issue = await s.linear.getIssue(row.linear_issue_id);
      if (!issue) throw err;
    }
  }

  const labelIds = issue.labels.nodes.map((l) => l.id);
  await s.db.update(
    threadId,
    {
      status: "created",
      linear_issue_identifier: issue.identifier,
      linear_issue_url: issue.url,
      synced_label_ids: JSON.stringify(labelIds),
      // The ack covers the initial state, so no notification for it.
      last_state_id: issue.state.id,
      last_error: null,
    },
    s.now(),
  );
  log.info({
    operation: "discord_to_linear",
    result: "success",
    discordThreadId: threadId,
    linearIssueId: issue.id,
    linearIssueIdentifier: issue.identifier,
  });
  const updated = await s.db.getByThread(threadId);
  if (!updated) throw new Error("mapping vanished");
  return updated;
}

async function finishIntake(s: Services, row: MappingRow, thread: APIThreadChannel, forum: ForumConfig): Promise<void> {
  const threadId = row.discord_thread_id;
  const identifier = row.linear_issue_identifier ?? "";
  const url = threadUrl(row.discord_guild_id, threadId);

  if (!row.link_attached) {
    await s.linear.linkUrl(row.linear_issue_id, url, `Discord: #${forum.name}`);
    await s.db.update(threadId, { link_attached: 1 }, s.now());
  }

  // Lifecycle tag for the issue's current state (normally Triage).
  await syncIssueToDiscord(s, { ...row, needs_sync: 1 }, { skipNotify: true });

  if (forum.prefixIssueIdentifier && !row.thread_renamed && identifier) {
    const prefix = `[${identifier}] `;
    if (!thread.name.startsWith(prefix)) {
      await s.discord.patchThread(threadId, { name: (prefix + thread.name).slice(0, 100) });
    }
    await s.db.update(threadId, { thread_renamed: 1 }, s.now());
  }

  if (await s.db.claimAck(threadId, s.now())) {
    try {
      const message = await s.discord.sendMessage(threadId, {
        embeds: [{ title: `Tracked as ${identifier}`, url: row.linear_issue_url ?? undefined, color: LINEAR_BLUE }],
      });
      await s.db.update(threadId, { ack_message_id: message.id, intake_attempts: 0, next_attempt_at: 0, last_error: null }, s.now());
    } catch (err) {
      await s.db.update(threadId, { ack_message_id: null }, s.now());
      throw err;
    }
  }
}

async function recordFailure(s: Services, row: MappingRow, err: unknown): Promise<void> {
  const attempts = row.intake_attempts + 1;
  const giveUp = attempts >= MAX_INTAKE_ATTEMPTS;
  const backoffMs = Math.min(2 ** attempts, 60) * 60_000;
  const fields: Parameters<Services["db"]["update"]>[1] = {
    intake_attempts: attempts,
    next_attempt_at: giveUp ? Number.MAX_SAFE_INTEGER : s.now() + backoffMs,
    last_error: errorMessage(err),
  };
  if (giveUp && row.status === "pending") fields.status = "failed";
  await s.db.update(row.discord_thread_id, fields, s.now());

  (giveUp ? log.error : log.warn)({
    operation: "discord_to_linear",
    result: giveUp ? "error" : "retry",
    discordThreadId: row.discord_thread_id,
    linearIssueId: row.linear_issue_id,
    linearIssueIdentifier: row.linear_issue_identifier,
    attempts,
    error: errorMessage(err),
    hint: permissionHint(err),
  });

  if (row.status === "pending" && attempts >= FAILURE_NOTICE_AFTER && !row.failure_notice_posted) {
    try {
      await s.discord.sendMessage(row.discord_thread_id, {
        content: "Could not create the Linear issue yet. The report has been queued for retry.",
      });
      await s.db.update(row.discord_thread_id, { failure_notice_posted: 1 }, s.now());
    } catch {
      // Best effort; the error is already logged.
    }
  }
}

async function getStarterMessage(s: Services, threadId: string): Promise<APIMessage | null> {
  for (let attempt = 0; ; attempt++) {
    try {
      // A forum post's starter message has the same ID as the thread.
      return await s.discord.getMessage(threadId, threadId);
    } catch (err) {
      if (!(err instanceof DiscordApiError && err.notFound)) throw err;
      if (s.now() - snowflakeTime(threadId) > STARTER_MESSAGE_GRACE_MS) return null; // deleted
      const wait = STARTER_MESSAGE_WAITS_MS[attempt];
      if (wait === undefined) throw new Error("The post's first message is not available yet");
      await s.sleep(wait);
    }
  }
}

export function buildDescription(input: {
  thread: APIThreadChannel;
  starter: APIMessage | null;
  forum: ForumConfig;
  attachments: UploadedAttachment[];
  guildId: string;
}): string {
  const { starter, forum, attachments } = input;
  const parts: string[] = [];
  const body = starter?.content?.trim();
  parts.push(body || "_(no text in the original post)_");

  if (attachments.length > 0) {
    parts.push(
      attachments
        .map((a) =>
          a.isImage ? `![${a.filename}](${a.url})` : `[${a.filename}](${a.url})${a.copied ? "" : " (Discord link, may expire)"}`,
        )
        .join("\n"),
    );
  }

  const author = starter?.author;
  const reporter = author
    ? `${author.global_name ?? author.username} (@${author.username}, Discord ID ${author.id})`
    : input.thread.owner_id
      ? `Discord user ${input.thread.owner_id}`
      : "unknown";
  parts.push(
    [
      "---",
      "",
      "### Discord report",
      "",
      `Reporter: ${reporter}`,
      `Discord thread: ${threadUrl(input.guildId, input.thread.id)}`,
      `Forum: #${forum.name}`,
    ].join("\n"),
  );
  return parts.join("\n\n");
}

function permissionHint(err: unknown): string | undefined {
  if (err instanceof DiscordApiError && err.code === 50013) {
    return "Bot is missing a Discord permission (Manage Threads / Send Messages in Threads / Embed Links) on this forum";
  }
  if (err instanceof DiscordApiError && err.code === 50001) {
    return "Bot cannot see this forum (View Channel / Read Message History)";
  }
  return undefined;
}
