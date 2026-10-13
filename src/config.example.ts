/**
 * `pnpm run setup` writes src/config.local.ts (gitignored) for you. To do it by
 * hand instead, copy this file there and fill in your IDs:
 *
 *   cp src/config.example.ts src/config.local.ts
 *   pnpm run discover     # prints every ID below and how tags match
 *
 * Types and field docs are in src/config.ts.
 */
import type { Config, ForumConfig } from "./config";

const TEAM = "LINEAR_TEAM_ID";
const STATE = {
  triage: "LINEAR_TRIAGE_STATE_ID",
  todo: "LINEAR_TODO_STATE_ID",
  done: "LINEAR_DONE_STATE_ID",
};
const LABEL = {
  bug: "LINEAR_BUG_LABEL_ID",
  feature: "LINEAR_FEATURE_LABEL_ID",
};

/** Settings shared by every forum. */
const shared = {
  linearTeamId: TEAM,
  triageStateId: STATE.triage,
  notify: {
    [STATE.done]: "This has been marked done. Thanks for the report!",
  },
  archiveCompletedAfterDays: 7,
  lockOnArchive: false,
  prefixIssueIdentifier: false,
  commentOnThreadDeleted: true,
} satisfies Partial<ForumConfig>;

export const config: Config = {
  guildId: "DISCORD_SERVER_ID",
  // Posts created before this are never imported by the sweep.
  intakeSince: "2026-01-01T00:00:00Z",
  forums: {
    // #bug-reports
    DISCORD_BUGS_FORUM_ID: {
      ...shared,
      name: "bug-reports",
      defaultLabelIds: [LABEL.bug],
      statusTags: {
        [STATE.triage]: "DISCORD_TRIAGE_TAG_ID",
        [STATE.todo]: "DISCORD_ACCEPTED_TAG_ID",
        "type:backlog": "DISCORD_ACCEPTED_TAG_ID",
        "type:started": "DISCORD_IN_PROGRESS_TAG_ID",
        "type:completed": "DISCORD_FIXED_TAG_ID",
        "type:canceled": "DISCORD_CLOSED_TAG_ID",
        "type:duplicate": "DISCORD_DUPLICATE_TAG_ID",
      },
      labelTags: {
        // "DISCORD_DASHBOARD_TAG_ID": "LINEAR_DASHBOARD_LABEL_ID",
      },
      onLinearIssueDeletedTagId: "DISCORD_CLOSED_TAG_ID",
    },
    // #ideas: same shape, with its own tag IDs (tags belong to one forum).
    DISCORD_IDEAS_FORUM_ID: {
      ...shared,
      name: "ideas",
      defaultLabelIds: [LABEL.feature],
      statusTags: {
        [STATE.triage]: "DISCORD_IDEAS_TRIAGE_TAG_ID",
        "type:completed": "DISCORD_IDEAS_SHIPPED_TAG_ID",
        "type:canceled": "DISCORD_IDEAS_CLOSED_TAG_ID",
      },
    },
  },
};
