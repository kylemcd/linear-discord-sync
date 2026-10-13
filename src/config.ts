/**
 * Config types, validation and lookup helpers. The values themselves live in
 * src/config.local.ts, which is gitignored and bundled into the Worker by
 * `wrangler deploy`. Start from src/config.example.ts.
 *
 * Every value is an ID, never a display name. Run `pnpm run discover` to print
 * the forum tag IDs and Linear team / workflow state / label IDs you need.
 *
 * Discord forum tag IDs belong to a single forum channel, so every mapping
 * lives under the forum it applies to.
 */

export interface ForumConfig {
  /** Label used in logs and in the Linear description ("Forum: #bug-reports"). */
  name: string;
  linearTeamId: string;
  /** New issues are created in this state. Use the team's Triage state. */
  triageStateId: string;
  /** Linear labels always added to issues from this forum (e.g. "Bug" or "Feature request"). */
  defaultLabelIds?: string[];

  /**
   * Linear workflow state → Discord lifecycle tag. Keys are Linear state IDs,
   * or `type:<stateType>` (triage, backlog, unstarted, started, completed,
   * canceled, duplicate) as a fallback for any state of that type. An exact
   * state ID match wins over a type match. A state with no mapping removes the
   * lifecycle tag.
   */
  statusTags: Record<string, string>;

  /**
   * Discord tag ID → Linear label ID. Applied tags become labels when the issue
   * is created. After that, adding or removing a mapped label in Linear adds or
   * removes the tag in Discord. Unmapped tags are never touched.
   */
  labelTags?: Record<string, string>;

  /**
   * Optional one-time message posted to the thread when the issue enters a
   * state. Keys use the same format as `statusTags`.
   */
  notify?: Record<string, string>;

  /** Archive the thread this many days after the issue reaches a completed/canceled state. null = never. */
  archiveCompletedAfterDays?: number | null;
  /** Also lock threads when archiving them. */
  lockOnArchive?: boolean;
  /** Rename threads to "[ENG-123] Title" once tracked. */
  prefixIssueIdentifier?: boolean;
  /** When the Linear issue is deleted, apply this tag (e.g. "Closed"). null = do nothing. */
  onLinearIssueDeletedTagId?: string | null;
  /** When the Discord thread is deleted, add a comment to the Linear issue. */
  commentOnThreadDeleted?: boolean;
}

export interface Config {
  guildId: string;
  /** Posts created before this time are never imported by the sweep. */
  intakeSince: string;
  forums: Record<string, ForumConfig>;
}

/** Returns a list of problems; empty means the config is usable. */
export function validateConfig(cfg: Config): string[] {
  const problems: string[] = [];
  if (!/^\d+$/.test(cfg.guildId)) problems.push("guildId must be a Discord snowflake");
  if (Number.isNaN(Date.parse(cfg.intakeSince))) problems.push("intakeSince must be an ISO date");
  if (Object.keys(cfg.forums).length === 0) problems.push("no forums configured");

  for (const [forumId, forum] of Object.entries(cfg.forums)) {
    const where = `forums[${forumId}] (${forum.name})`;
    if (!forum.linearTeamId) problems.push(`${where}: linearTeamId is required`);
    if (!forum.triageStateId) problems.push(`${where}: triageStateId is required`);
    const lifecycle = new Set(lifecycleTagIds(forum));
    for (const tagId of Object.keys(forum.labelTags ?? {})) {
      if (lifecycle.has(tagId)) problems.push(`${where}: tag ${tagId} is both a status tag and a label tag`);
    }
  }
  return problems;
}

/** Tags the bot owns on this forum: status tags plus the "issue deleted" tag. */
export function lifecycleTagIds(forum: ForumConfig): string[] {
  const ids = Object.values(forum.statusTags);
  if (forum.onLinearIssueDeletedTagId) ids.push(forum.onLinearIssueDeletedTagId);
  return ids;
}

/** Look up a state-keyed map ("<stateId>" first, then "type:<stateType>"). */
export function lookupByState<T>(
  map: Record<string, T> | undefined,
  state: { id: string; type: string },
): T | undefined {
  if (!map) return undefined;
  return map[state.id] ?? map[`type:${state.type}`];
}
