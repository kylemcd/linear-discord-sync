export interface MappingRow {
  discord_thread_id: string;
  discord_guild_id: string;
  discord_forum_channel_id: string;
  discord_initial_message_id: string;
  discord_author_id: string | null;
  linear_issue_id: string;
  linear_issue_identifier: string | null;
  linear_issue_url: string | null;
  status: "pending" | "created" | "failed";
  intake_attempts: number;
  next_attempt_at: number;
  last_error: string | null;
  failure_notice_posted: number;
  link_attached: number;
  thread_renamed: number;
  ack_message_id: string | null;
  needs_sync: number;
  sync_attempts: number;
  synced_label_ids: string | null;
  last_state_id: string | null;
  completed_at: number | null;
  archived_at: number | null;
  discord_deleted_at: number | null;
  linear_deleted_at: number | null;
  discord_inactive: number;
  created_at: number;
  updated_at: number;
}

type Updatable = Omit<MappingRow, "discord_thread_id" | "linear_issue_id" | "created_at" | "updated_at">;

/** An ack claim older than this is assumed to have crashed and may be retried. */
const ACK_CLAIM_TTL_MS = 10 * 60_000;
/** D1 allows at most 100 bound parameters per statement. */
const MAX_PARAMS = 90;

export class Db {
  constructor(private readonly d1: D1Database) {}

  /**
   * Insert a pending row for this thread unless one already exists, then return
   * the row. The Linear issue ID is generated here, so every later attempt
   * creates the same issue.
   */
  async claimThread(input: {
    threadId: string;
    guildId: string;
    forumChannelId: string;
    authorId: string | null;
    now: number;
  }): Promise<MappingRow> {
    await this.d1
      .prepare(
        `INSERT INTO issue_mappings (discord_thread_id, discord_guild_id, discord_forum_channel_id,
           discord_initial_message_id, discord_author_id, linear_issue_id, status, created_at, updated_at)
         VALUES (?1, ?2, ?3, ?1, ?4, ?5, 'pending', ?6, ?6)
         ON CONFLICT (discord_thread_id) DO NOTHING`,
      )
      .bind(input.threadId, input.guildId, input.forumChannelId, input.authorId, crypto.randomUUID(), input.now)
      .run();
    const row = await this.getByThread(input.threadId);
    if (!row) throw new Error(`mapping for thread ${input.threadId} missing after insert`);
    return row;
  }

  getByThread(threadId: string): Promise<MappingRow | null> {
    return this.d1.prepare("SELECT * FROM issue_mappings WHERE discord_thread_id = ?").bind(threadId).first<MappingRow>();
  }

  getByLinearIssue(issueId: string): Promise<MappingRow | null> {
    return this.d1.prepare("SELECT * FROM issue_mappings WHERE linear_issue_id = ?").bind(issueId).first<MappingRow>();
  }

  async update(threadId: string, fields: Partial<Updatable>, now: number): Promise<void> {
    const keys = Object.keys(fields) as Array<keyof Updatable>;
    if (keys.length === 0) return;
    const sets = keys.map((k, i) => `${k} = ?${i + 1}`).join(", ");
    const values = keys.map((k) => fields[k] ?? null);
    await this.d1
      .prepare(`UPDATE issue_mappings SET ${sets}, updated_at = ?${keys.length + 1} WHERE discord_thread_id = ?${keys.length + 2}`)
      .bind(...values, now, threadId)
      .run();
  }

  /** Atomically claim the right to post the acknowledgement. */
  async claimAck(threadId: string, now: number): Promise<boolean> {
    const res = await this.d1
      .prepare(
        `UPDATE issue_mappings SET ack_message_id = ?2
         WHERE discord_thread_id = ?1
           AND (ack_message_id IS NULL
                OR (ack_message_id LIKE 'posting:%' AND CAST(substr(ack_message_id, 9) AS INTEGER) < ?3))`,
      )
      .bind(threadId, `posting:${now}`, now - ACK_CLAIM_TTL_MS)
      .run();
    return res.meta.changes === 1;
  }

  dueIntake(now: number, limit = 25): Promise<MappingRow[]> {
    return this.all(
      "SELECT * FROM issue_mappings WHERE status IN ('pending', 'created') AND next_attempt_at <= ? AND (ack_message_id IS NULL OR ack_message_id LIKE 'posting:%') AND discord_deleted_at IS NULL ORDER BY next_attempt_at LIMIT ?",
      now,
      limit,
    );
  }

  needingSync(limit = 25): Promise<MappingRow[]> {
    return this.all("SELECT * FROM issue_mappings WHERE needs_sync = 1 ORDER BY updated_at LIMIT ?", limit);
  }

  /** Tracked threads not yet known to be deleted in Discord. */
  liveThreads(limit = 5000): Promise<Pick<MappingRow, "discord_thread_id" | "discord_inactive">[]> {
    return this.all(
      "SELECT discord_thread_id, discord_inactive FROM issue_mappings WHERE status = 'created' AND discord_deleted_at IS NULL LIMIT ?",
      limit,
    );
  }

  /** Tracked threads whose Linear state can still change what Discord shows. */
  openMappings(limit = 500): Promise<MappingRow[]> {
    return this.all(
      "SELECT * FROM issue_mappings WHERE status = 'created' AND archived_at IS NULL AND discord_deleted_at IS NULL AND linear_deleted_at IS NULL ORDER BY updated_at DESC LIMIT ?",
      limit,
    );
  }

  completedNotArchived(limit = 50): Promise<MappingRow[]> {
    return this.all(
      "SELECT * FROM issue_mappings WHERE completed_at IS NOT NULL AND archived_at IS NULL AND discord_deleted_at IS NULL ORDER BY completed_at LIMIT ?",
      limit,
    );
  }

  /** Which of these thread IDs already have a mapping. */
  async existingThreadIds(threadIds: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (let i = 0; i < threadIds.length; i += MAX_PARAMS) {
      const chunk = threadIds.slice(i, i + MAX_PARAMS);
      const rows = await this.all<{ discord_thread_id: string }>(
        `SELECT discord_thread_id FROM issue_mappings WHERE discord_thread_id IN (${chunk.map(() => "?").join(",")})`,
        ...chunk,
      );
      for (const r of rows) found.add(r.discord_thread_id);
    }
    return found;
  }

  /** Record a webhook delivery. Returns false if it was already processed. */
  async markEventProcessed(eventId: string, source: string, now: number): Promise<boolean> {
    const res = await this.d1
      .prepare("INSERT INTO processed_events (event_id, source, processed_at) VALUES (?, ?, ?) ON CONFLICT DO NOTHING")
      .bind(eventId, source, now)
      .run();
    return res.meta.changes === 1;
  }

  async pruneEvents(before: number): Promise<void> {
    await this.d1.prepare("DELETE FROM processed_events WHERE processed_at < ?").bind(before).run();
  }

  private async all<T = MappingRow>(sql: string, ...params: unknown[]): Promise<T[]> {
    const res = await this.d1.prepare(sql).bind(...params).all<T>();
    return res.results;
  }
}

export function parseLabelIds(json: string | null): string[] | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : null;
  } catch {
    return null;
  }
}
