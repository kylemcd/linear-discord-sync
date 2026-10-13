import { DiscordApiError, snowflakeTime } from "../discord/rest";
import { errorMessage, log } from "../log";
import type { Services } from "../services";
import { parseLabelIds } from "../db";
import { intakeThread } from "./intake";
import { handleThreadDeleted, syncIssueToDiscord } from "./issueToDiscord";

const DAY_MS = 86_400_000;
const PROCESSED_EVENT_TTL_MS = 7 * DAY_MS;

type Job = readonly [name: string, run: (s: Services) => Promise<void>];

/** Every minute: take in new posts, and retry posts whose intake failed. */
const INTAKE_JOBS: Job[] = [
  ["intake_sweep", sweepActiveThreads],
  ["intake_retry", retryPendingIntake],
];

/** Every 30 minutes: retry failed syncs, catch missed Linear changes, archive, clean up. */
const MAINTENANCE_JOBS: Job[] = [
  ["sync_retry", retryDirtySyncs],
  ["drift_check", resyncDrifted],
  ["deletion_check", findDeletedThreads],
  ["auto_archive", archiveCompletedThreads],
  ["prune_events", pruneEvents],
];

export const runIntake = (s: Services) => runJobs(s, INTAKE_JOBS);
export const runMaintenance = (s: Services) => runJobs(s, MAINTENANCE_JOBS);

/** Runs each job independently, so one failing does not block the others. Returns "ok" or the error per job. */
async function runJobs(s: Services, jobs: Job[]): Promise<Record<string, string>> {
  const results: Record<string, string> = {};
  for (const [name, job] of jobs) {
    try {
      await job(s);
      results[name] = "ok";
    } catch (err) {
      results[name] = errorMessage(err);
      log.error({ operation: `cron_${name}`, result: "error", error: errorMessage(err) });
    }
  }
  return results;
}

/** Any active thread in a configured forum without a mapping is new: take it in. */
export async function sweepActiveThreads(s: Services): Promise<void> {
  const since = Date.parse(s.config.intakeSince);
  const { threads } = await s.discord.listActiveThreads(s.config.guildId);
  const candidates = threads
    .filter((t) => "parent_id" in t && t.parent_id && s.config.forums[t.parent_id] && snowflakeTime(t.id) >= since)
    .map((t) => t.id);
  if (candidates.length === 0) return;

  const known = await s.db.existingThreadIds(candidates);
  const missing = candidates.filter((id) => !known.has(id));
  for (const id of missing) {
    log.info({ operation: "intake_sweep", result: "info", reason: "new post", discordThreadId: id });
    await intakeThread(s, id);
  }
}

async function retryPendingIntake(s: Services): Promise<void> {
  for (const row of await s.db.dueIntake(s.now())) {
    await intakeThread(s, row.discord_thread_id);
  }
}

async function retryDirtySyncs(s: Services): Promise<void> {
  for (const row of await s.db.needingSync()) {
    await syncIssueToDiscord(s, row);
  }
}

/**
 * Safety net for missed or stale webhooks: compare each open thread's last
 * synced Linear state and labels with Linear now, and resync any that moved.
 * One Linear request per 50 threads.
 */
export async function resyncDrifted(s: Services): Promise<void> {
  const rows = await s.db.openMappings();
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const issues = new Map((await s.linear.getIssues(batch.map((r) => r.linear_issue_id))).map((x) => [x.id, x]));
    for (const row of batch) {
      const issue = issues.get(row.linear_issue_id);
      if (!issue) continue; // deleted or trashed: the webhook path handles that
      const labels = issue.labels.nodes.map((l) => l.id).sort().join();
      const synced = (parseLabelIds(row.synced_label_ids) ?? []).sort().join();
      if (issue.state.id === row.last_state_id && labels === synced) continue;
      log.info({
        operation: "drift_check",
        result: "info",
        discordThreadId: row.discord_thread_id,
        linearIssueId: row.linear_issue_id,
        linearIssueIdentifier: issue.identifier,
        to: issue.state.name,
      });
      await syncIssueToDiscord(s, row);
    }
  }
}

/**
 * Discord sends no webhook when a post is deleted. A tracked thread that drops
 * off the active-thread list was either archived or deleted: ask Discord once
 * to tell which. Archived threads are remembered and only asked about again if
 * they become active again, so this costs one request per thread that drops off.
 */
export async function findDeletedThreads(s: Services): Promise<void> {
  const { threads } = await s.discord.listActiveThreads(s.config.guildId);
  const active = new Set(threads.map((t) => t.id));
  for (const row of await s.db.liveThreads()) {
    const id = row.discord_thread_id;
    if (active.has(id)) {
      if (row.discord_inactive) await s.db.update(id, { discord_inactive: 0 }, s.now());
      continue;
    }
    if (row.discord_inactive) continue;
    try {
      await s.discord.getThread(id);
      await s.db.update(id, { discord_inactive: 1 }, s.now()); // archived, still there
    } catch (err) {
      if (err instanceof DiscordApiError && err.notFound) await handleThreadDeleted(s, id);
      else throw err;
    }
  }
}

async function archiveCompletedThreads(s: Services): Promise<void> {
  const now = s.now();
  for (const row of await s.db.completedNotArchived()) {
    const forum = s.config.forums[row.discord_forum_channel_id];
    const days = forum?.archiveCompletedAfterDays;
    if (days === null || days === undefined || row.completed_at === null) continue;
    if (now - row.completed_at < days * DAY_MS) continue;

    const ctx = {
      discordThreadId: row.discord_thread_id,
      linearIssueId: row.linear_issue_id,
      linearIssueIdentifier: row.linear_issue_identifier,
    };
    try {
      await s.discord.patchThread(
        row.discord_thread_id,
        forum?.lockOnArchive ? { archived: true, locked: true } : { archived: true },
        "Linear issue completed",
      );
      await s.db.update(row.discord_thread_id, { archived_at: now }, now);
      log.info({ operation: "auto_archive", result: "success", ...ctx });
    } catch (err) {
      if (err instanceof DiscordApiError && err.notFound) {
        await s.db.update(row.discord_thread_id, { discord_deleted_at: now }, now);
        continue;
      }
      log.warn({ operation: "auto_archive", result: "retry", error: errorMessage(err), ...ctx });
    }
  }
}

async function pruneEvents(s: Services): Promise<void> {
  await s.db.pruneEvents(s.now() - PROCESSED_EVENT_TTL_MS);
}
