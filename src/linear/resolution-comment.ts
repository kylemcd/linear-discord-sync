import { Data, Effect, Option, Schema } from "effect";
import type { LinearClient } from "./client";

const commentPage = Schema.Struct({
  issue: Schema.NullOr(Schema.Struct({
    comments: Schema.Struct({
      nodes: Schema.Array(Schema.Struct({ body: Schema.String, createdAt: Schema.String })),
      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean, endCursor: Schema.NullOr(Schema.String) }),
    }),
  })),
});
const decodeCommentPage = Schema.decodeUnknownEffect(commentPage);

/** Keeps comment lookup failures in the existing sync retry path. */
export class ResolutionCommentError extends Data.TaggedError("ResolutionCommentError")<{
  readonly issueId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

/** Reads only explicitly public resolution comments. Internal comments never become a fallback. */
export const readIssueResolution = Effect.fn("readIssueResolution")(function* ({ linear, issueId }: {
  linear: Pick<LinearClient, "gql">;
  issueId: string;
}): Effect.fn.Return<Option.Option<string>, ResolutionCommentError> {
  let after: string | null = null;
  const comments: Array<{ body: string; createdAt: string }> = [];
  // Bound API work. An incomplete lookup must retry rather than send an incorrect fallback.
  for (let page = 0; page < 10; page++) {
    const raw = yield* Effect.tryPromise({
      try: () => linear.gql<unknown>(
        `query ResolutionComments($id: String!, $after: String) {
          issue(id: $id) {
            comments(first: 50, after: $after, orderBy: createdAt) {
              nodes { body createdAt }
              pageInfo { hasNextPage endCursor }
            }
          }
        }`,
        { id: issueId, after },
      ),
      catch: (cause) => new ResolutionCommentError({
        issueId, message: "Resolution comment lookup failed. Retry the issue sync.", cause,
      }),
    });
    const data = yield* decodeCommentPage(raw).pipe(Effect.mapError((cause) => new ResolutionCommentError({
      issueId, message: "Resolution comment response was invalid. Retry the issue sync.", cause,
    })));
    if (!data.issue) return yield* new ResolutionCommentError({
      issueId, message: "Resolution comment issue was not found. Resync the issue to check its status.",
    });
    comments.push(...data.issue.comments.nodes);
    const { hasNextPage, endCursor } = data.issue.comments.pageInfo;
    if (!hasNextPage) {
      const latest = comments
        .filter((comment) => /^## Public resolution\r?\n\s*\S/.test(comment.body.trim()))
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
      return latest ? Option.some(latest.body.trim()) : Option.none();
    }
    if (!endCursor || endCursor === after) break;
    after = endCursor;
  }
  return yield* new ResolutionCommentError({
    issueId, message: "Resolution comment lookup was incomplete. Review the issue comments before retrying the sync.",
  });
});
