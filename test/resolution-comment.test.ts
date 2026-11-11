import { Effect, Option, Result } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LinearClient } from "../src/linear/client";
import { readIssueResolution } from "../src/linear/resolution-comment";

const pageResponse = (nodes: Array<{ body: string; createdAt: string }>, next: string | null = null) =>
  new Response(JSON.stringify({ data: { issue: { comments: {
    nodes, pageInfo: { hasNextPage: next !== null, endCursor: next },
  } } } }), { headers: { "Content-Type": "application/json" } });

describe("public resolution comment lookup", () => {
  afterEach(() => vi.restoreAllMocks());

  it("reads subsequent comment pages and chooses the newest marked comment by creation time", async () => {
    const requests: Array<{ query: string; variables: { id: string; after: string | null } }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      requests.push(JSON.parse(String(init?.body)));
      return requests.length === 1
        ? pageResponse([
          { body: "Internal information", createdAt: "2026-11-11T03:00:00Z" },
          { body: "## Public resolution\nCurrent fix and testing steps.", createdAt: "2026-11-11T02:00:00Z" },
        ], "page-two")
        : pageResponse([{ body: "## Public resolution\nOld fix.", createdAt: "2026-11-11T01:00:00Z" }]);
    });
    const result = await Effect.runPromise(readIssueResolution({ linear: new LinearClient("test-key"), issueId: "issue-1" }));
    expect(result).toEqual(Option.some("## Public resolution\nCurrent fix and testing steps."));
    expect(requests.map((request) => request.variables)).toEqual([
      { id: "issue-1", after: null }, { id: "issue-1", after: "page-two" },
    ]);
    expect(requests[0]?.query).toContain("comments(first: 50, after: $after, orderBy: createdAt)");
  });

  it("ignores internal comments, quoted markers, and empty public comments", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(pageResponse([
      { body: "Internal notes\n## Public resolution\nDo not share.", createdAt: "2026-11-11T03:00:00Z" },
      { body: "> ## Public resolution\nQuoted example.", createdAt: "2026-11-11T02:00:00Z" },
      { body: "## Public resolution\n  ", createdAt: "2026-11-11T01:00:00Z" },
    ]));
    const result = await Effect.runPromise(readIssueResolution({ linear: new LinearClient("test-key"), issueId: "issue-1" }));
    expect(result).toEqual(Option.none());
  });

  it("fails malformed API responses so the sync retries instead of losing the resolution", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ data: { issue: {} } })));
    const result = await Effect.runPromise(Effect.result(readIssueResolution({ linear: new LinearClient("test-key"), issueId: "issue-1" })));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure._tag).toBe("ResolutionCommentError");
  });

  it("bounds repeated pagination cursors instead of sending an incomplete lookup", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => pageResponse([], "same-cursor"));
    const result = await Effect.runPromise(Effect.result(readIssueResolution({ linear: new LinearClient("test-key"), issueId: "issue-1" })));
    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure.message).toContain("incomplete");
  });
});
