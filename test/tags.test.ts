import { describe, expect, it } from "vitest";
import { computeDesiredTags, sameTagSet } from "../src/discord/tags";

const LIFECYCLE = ["triage", "accepted", "in-progress", "fixed", "closed"];

describe("computeDesiredTags", () => {
  it("swaps the lifecycle tag and preserves unrelated tags (brief test 6)", () => {
    const { tags } = computeDesiredTags({
      current: ["bug", "dashboard", "triage"],
      lifecycleTagIds: LIFECYCLE,
      lifecycleTag: "in-progress",
    });
    expect(tags).toEqual(["bug", "dashboard", "in-progress"]);
  });

  it("adds a lifecycle tag when there is none", () => {
    const { tags } = computeDesiredTags({ current: ["bug"], lifecycleTagIds: LIFECYCLE, lifecycleTag: "triage" });
    expect(tags).toEqual(["bug", "triage"]);
  });

  it("removes stray lifecycle tags, including duplicates", () => {
    const { tags } = computeDesiredTags({
      current: ["triage", "bug", "fixed", "bug"],
      lifecycleTagIds: LIFECYCLE,
      lifecycleTag: "accepted",
    });
    expect(tags).toEqual(["bug", "accepted"]);
  });

  it("removes the lifecycle tag for an unmapped state", () => {
    const { tags } = computeDesiredTags({ current: ["bug", "triage"], lifecycleTagIds: LIFECYCLE, lifecycleTag: null });
    expect(tags).toEqual(["bug"]);
  });

  it("is a no-op when replayed", () => {
    const first = computeDesiredTags({ current: ["bug", "triage"], lifecycleTagIds: LIFECYCLE, lifecycleTag: "fixed" });
    const second = computeDesiredTags({ current: first.tags, lifecycleTagIds: LIFECYCLE, lifecycleTag: "fixed" });
    expect(sameTagSet(first.tags, second.tags)).toBe(true);
  });

  describe("label sync", () => {
    const labelTags = { bug: "L-bug", dashboard: "L-dash", api: "L-api" };

    it("adds a tag when its label is added in Linear", () => {
      const { tags } = computeDesiredTags({
        current: ["bug", "triage"],
        lifecycleTagIds: LIFECYCLE,
        lifecycleTag: "triage",
        labelTags,
        labelIds: ["L-bug", "L-api"],
        previousLabelIds: ["L-bug"],
      });
      expect(tags).toEqual(["bug", "api", "triage"]);
    });

    it("removes a tag when its label is removed in Linear", () => {
      const { tags } = computeDesiredTags({
        current: ["bug", "dashboard", "triage"],
        lifecycleTagIds: LIFECYCLE,
        lifecycleTag: "triage",
        labelTags,
        labelIds: ["L-bug"],
        previousLabelIds: ["L-bug", "L-dash"],
      });
      expect(tags).toEqual(["bug", "triage"]);
    });

    it("does not remove a mapped tag a user added in Discord when the label did not change", () => {
      const { tags } = computeDesiredTags({
        current: ["api", "triage"],
        lifecycleTagIds: LIFECYCLE,
        lifecycleTag: "accepted",
        labelTags,
        labelIds: [],
        previousLabelIds: [],
      });
      expect(tags).toEqual(["api", "accepted"]);
    });

    it("never touches unmapped tags", () => {
      const { tags } = computeDesiredTags({
        current: ["question", "triage"],
        lifecycleTagIds: LIFECYCLE,
        lifecycleTag: "triage",
        labelTags,
        labelIds: [],
        previousLabelIds: ["L-bug"],
      });
      expect(tags).toEqual(["question", "triage"]);
    });

    it("with no baseline, adds but never removes", () => {
      const { tags } = computeDesiredTags({
        current: ["dashboard"],
        lifecycleTagIds: LIFECYCLE,
        lifecycleTag: "triage",
        labelTags,
        labelIds: ["L-bug"],
        previousLabelIds: null,
      });
      expect(tags).toEqual(["dashboard", "bug", "triage"]);
    });
  });

  describe("5-tag limit", () => {
    it("keeps the lifecycle tag and drops newly added label tags first", () => {
      const { tags, dropped } = computeDesiredTags({
        current: ["a", "b", "c", "d", "triage"],
        lifecycleTagIds: LIFECYCLE,
        lifecycleTag: "fixed",
        labelTags: { api: "L-api" },
        labelIds: ["L-api"],
        previousLabelIds: [],
      });
      expect(tags).toEqual(["a", "b", "c", "d", "fixed"]);
      expect(dropped).toEqual(["api"]);
    });

    it("drops the most recent existing tag when a lifecycle tag must be added to a full thread", () => {
      const { tags, dropped } = computeDesiredTags({
        current: ["a", "b", "c", "d", "e"],
        lifecycleTagIds: LIFECYCLE,
        lifecycleTag: "triage",
      });
      expect(tags).toEqual(["a", "b", "c", "d", "triage"]);
      expect(dropped).toEqual(["e"]);
    });
  });
});
