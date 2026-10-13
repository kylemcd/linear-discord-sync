/** Discord allows at most 5 applied tags on a forum thread. */
export const MAX_APPLIED_TAGS = 5;

export interface DesiredTagsInput {
  /** Tags currently applied to the thread. */
  current: string[];
  /** Every tag this forum uses as a lifecycle/status tag. */
  lifecycleTagIds: Iterable<string>;
  /** Lifecycle tag for the issue's current state; null removes any lifecycle tag. */
  lifecycleTag: string | null;
  /** Discord tag ID → Linear label ID. */
  labelTags?: Record<string, string>;
  /** Labels on the Linear issue now. */
  labelIds?: string[];
  /**
   * Labels as of the previous sync. Label → tag sync is a diff against this,
   * so only labels that actually changed in Linear touch Discord. null means no
   * baseline: present mapped labels add their tag, nothing is removed.
   */
  previousLabelIds?: string[] | null;
}

export interface DesiredTagsResult {
  tags: string[];
  /** Tags that had to be left off because of the 5-tag limit. */
  dropped: string[];
}

/**
 * Compute the thread's new applied tags. Unrelated tags are always preserved;
 * only lifecycle tags and mapped-label tags whose label changed are touched.
 */
export function computeDesiredTags(input: DesiredTagsInput): DesiredTagsResult {
  const lifecycle = new Set(input.lifecycleTagIds);
  const tags = dedupe(input.current.filter((t) => !lifecycle.has(t)));
  const added: string[] = [];

  if (input.labelTags && input.labelIds) {
    const now = new Set(input.labelIds);
    const before = input.previousLabelIds ? new Set(input.previousLabelIds) : null;
    for (const [tagId, labelId] of Object.entries(input.labelTags)) {
      const has = now.has(labelId);
      const had = before ? before.has(labelId) : false;
      if (has && !had && !tags.includes(tagId)) {
        tags.push(tagId);
        added.push(tagId);
      } else if (!has && had && before) {
        const i = tags.indexOf(tagId);
        if (i !== -1) tags.splice(i, 1);
      }
    }
  }

  const dropped: string[] = [];
  const room = MAX_APPLIED_TAGS - (input.lifecycleTag ? 1 : 0);
  // Over the limit: first give up tags this sync would have added, newest first,
  // then the most recently applied existing tags. The lifecycle tag always wins.
  while (tags.length > room) {
    const victim = added.length > 0 ? added.pop()! : tags[tags.length - 1]!;
    tags.splice(tags.lastIndexOf(victim), 1);
    dropped.push(victim);
  }

  if (input.lifecycleTag) tags.push(input.lifecycleTag);
  return { tags, dropped };
}

export function sameTagSet(a: string[], b: string[]): boolean {
  const sa = new Set(a);
  const sb = new Set(b);
  if (sa.size !== sb.size) return false;
  for (const t of sa) if (!sb.has(t)) return false;
  return true;
}

function dedupe(tags: string[]): string[] {
  return [...new Set(tags)];
}
