import { lifecycleTagIds, lookupByState, type ForumConfig } from "../config";
import { parseLabelIds, type MappingRow } from "../db";
import { DiscordApiError } from "../discord/rest";
import { computeDesiredTags, sameTagSet } from "../discord/tags";
import type { LinearIssue } from "../linear/client";
import { errorMessage, log } from "../log";
import type { Services } from "../services";

export const MAX_SYNC_ATTEMPTS = 8;
/** Linear state types that mean the work is finished (auto-archive and "done" handling). */
const DONE_TYPES = new Set(["completed", "canceled", "duplicate"]);
/** Re-reads when Linear's API returns an issue older than the webhook that announced a change. */
const STALE_READ_RETRIES = 3;
const STALE_READ_DELAY_MS = 1500;

/**
 * Make the Discord thread reflect the Linear issue's current state and labels.
 *
 * State-based and idempotent: it reads the issue and the thread as they are
 * now, so replayed or out-of-order webhooks are harmless, and Discord is only
 * called when something actually differs. Linear is never modified.
 */
export async function syncIssueToDiscord(
  s: Services,
  row: MappingRow,
  opts: {
    skipNotify?: boolean;
    /** updatedAt from the webhook. A read older than this is stale and gets retried. */
    minUpdatedAt?: string;
  } = {},
): Promise<void> {
  const ctx = {
    discordThreadId: row.discord_thread_id,
    linearIssueId: row.linear_issue_id,
    linearIssueIdentifier: row.linear_issue_identifier,
  };
  const forum = s.config.forums[row.discord_forum_channel_id];
  if (!forum || row.status !== "created" || row.discord_deleted_at) {
    if (row.needs_sync) await s.db.update(row.discord_thread_id, { needs_sync: 0 }, s.now());
    return;
  }

  try {
    let issue = await s.linear.getIssue(row.linear_issue_id);
    const isStale = () => !!(issue && opts.minUpdatedAt && issue.updatedAt < opts.minUpdatedAt);
    for (let i = 0; i < STALE_READ_RETRIES && isStale(); i++) {
      await s.sleep(STALE_READ_DELAY_MS);
      issue = await s.linear.getIssue(row.linear_issue_id);
    }
    if (isStale()) {
      // Leave needs_sync set; the cron reads again in a few minutes.
      throw new Error(`Linear returned ${issue!.updatedAt}, older than the webhook's ${opts.minUpdatedAt}`);
    }
    if (!issue || issue.trashed) {
      await handleLinearIssueDeleted(s, row, forum);
      return;
    }

    let thread;
    try {
      thread = await s.discord.getThread(row.discord_thread_id);
    } catch (err) {
      if (err instanceof DiscordApiError && err.notFound) {
        // The bot polls instead of listening, so this is where it learns a thread was deleted.
        await handleThreadDeleted(s, row.discord_thread_id);
        return;
      }
      throw err;
    }

    const current = thread.applied_tags ?? [];
    const lifecycleTag = lookupByState(forum.statusTags, issue.state) ?? null;
    const labelIds = issue.labels.nodes.map((l) => l.id);
    const { tags, dropped } = computeDesiredTags({
      current,
      lifecycleTagIds: lifecycleTagIds(forum),
      lifecycleTag,
      labelTags: forum.labelTags,
      labelIds,
      previousLabelIds: parseLabelIds(row.synced_label_ids),
    });
    if (dropped.length > 0) {
      log.warn({ operation: "linear_to_discord", result: "info", reason: "5-tag limit", dropped, ...ctx });
    }

    const isDone = DONE_TYPES.has(issue.state.type);
    const wasArchived = thread.thread_metadata?.archived ?? false;
    let archivedAt = row.archived_at;

    if (!sameTagSet(current, tags)) {
      // Archived threads can only be edited while unarchiving them in the same request.
      await s.discord.patchThread(
        row.discord_thread_id,
        wasArchived ? { applied_tags: tags, archived: false } : { applied_tags: tags },
        `Linear ${issue.identifier} → ${issue.state.name}`,
      );
      if (wasArchived && isDone) {
        await s.discord.patchThread(row.discord_thread_id, { archived: true });
      } else if (wasArchived) {
        archivedAt = null; // reopened: leave it open
      }
      log.info({
        operation: "linear_to_discord",
        result: "success",
        ...ctx,
        linearIssueIdentifier: issue.identifier,
        to: issue.state.name,
        from: current,
        tags,
      });
    } else {
      log.info({ operation: "linear_to_discord", result: "skipped", reason: "tags already match", ...ctx });
    }

    const lastStateId = await maybeNotify(s, row, forum, issue, opts.skipNotify ?? false);

    await s.db.update(
      row.discord_thread_id,
      {
        synced_label_ids: JSON.stringify(labelIds),
        last_state_id: lastStateId,
        completed_at: isDone ? (row.completed_at ?? s.now()) : null,
        archived_at: isDone ? archivedAt : null,
        linear_issue_identifier: issue.identifier,
        linear_deleted_at: null, // restored from the trash, if it had been deleted
        needs_sync: 0,
        sync_attempts: 0,
      },
      s.now(),
    );
  } catch (err) {
    const attempts = row.sync_attempts + 1;
    const giveUp = attempts >= MAX_SYNC_ATTEMPTS;
    await s.db.update(
      row.discord_thread_id,
      { needs_sync: giveUp ? 0 : 1, sync_attempts: giveUp ? 0 : attempts, last_error: errorMessage(err) },
      s.now(),
    );
    (giveUp ? log.error : log.warn)({
      operation: "linear_to_discord",
      result: giveUp ? "error" : "retry",
      attempts,
      error: errorMessage(err),
      ...ctx,
    });
  }
}

/** Post the configured one-time message when the issue enters a new state. */
async function maybeNotify(
  s: Services,
  row: MappingRow,
  forum: ForumConfig,
  issue: LinearIssue,
  skip: boolean,
): Promise<string> {
  if (skip || row.last_state_id === issue.state.id) return issue.state.id;
  const message = lookupByState(forum.notify, issue.state);
  if (!message) return issue.state.id;

  const ping = row.discord_author_id ? [row.discord_author_id] : [];
  const content = row.discord_author_id ? `<@${row.discord_author_id}> ${message}` : message;
  await s.discord.sendMessage(row.discord_thread_id, { content }, ping);
  log.info({
    operation: "reporter_notification",
    result: "success",
    discordThreadId: row.discord_thread_id,
    linearIssueId: row.linear_issue_id,
    linearIssueIdentifier: issue.identifier,
    state: issue.state.name,
  });
  return issue.state.id;
}

/** The Linear issue is gone. Never delete the thread; optionally tag it. */
async function handleLinearIssueDeleted(s: Services, row: MappingRow, forum: ForumConfig): Promise<void> {
  const ctx = {
    discordThreadId: row.discord_thread_id,
    linearIssueId: row.linear_issue_id,
    linearIssueIdentifier: row.linear_issue_identifier,
  };
  if (forum.onLinearIssueDeletedTagId && !row.linear_deleted_at) {
    try {
      const thread = await s.discord.getThread(row.discord_thread_id);
      const current = thread.applied_tags ?? [];
      const { tags } = computeDesiredTags({
        current,
        lifecycleTagIds: lifecycleTagIds(forum),
        lifecycleTag: forum.onLinearIssueDeletedTagId,
      });
      if (!sameTagSet(current, tags)) {
        const archived = thread.thread_metadata?.archived ?? false;
        await s.discord.patchThread(row.discord_thread_id, archived ? { applied_tags: tags, archived: false } : { applied_tags: tags });
        if (archived) await s.discord.patchThread(row.discord_thread_id, { archived: true });
      }
    } catch (err) {
      if (!(err instanceof DiscordApiError && err.notFound)) throw err;
    }
  }
  await s.db.update(row.discord_thread_id, { linear_deleted_at: row.linear_deleted_at ?? s.now(), needs_sync: 0 }, s.now());
  log.info({ operation: "linear_issue_deleted", result: "success", ...ctx });
}

/** A Discord thread was deleted. Never delete the issue; optionally leave a comment. */
export async function handleThreadDeleted(s: Services, threadId: string): Promise<void> {
  const row = await s.db.getByThread(threadId);
  if (!row || row.discord_deleted_at) return;
  await s.db.update(threadId, { discord_deleted_at: s.now(), needs_sync: 0 }, s.now());

  const forum = s.config.forums[row.discord_forum_channel_id];
  const ctx = {
    discordThreadId: threadId,
    linearIssueId: row.linear_issue_id,
    linearIssueIdentifier: row.linear_issue_identifier,
  };
  if (forum?.commentOnThreadDeleted && row.status === "created" && !row.linear_deleted_at) {
    try {
      await s.linear.createComment(row.linear_issue_id, "The original Discord thread for this report was deleted.");
    } catch (err) {
      log.warn({ operation: "discord_thread_deleted", result: "error", error: errorMessage(err), ...ctx });
      return;
    }
  }
  log.info({ operation: "discord_thread_deleted", result: "success", ...ctx });
}
