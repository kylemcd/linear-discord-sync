import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Db } from "../src/db";
import { FORUM, GUILD, newSnowflake } from "./helpers";
import { sign } from "./webhook.test";

async function trackedRow() {
  const db = new Db(env.DB);
  const threadId = newSnowflake();
  const row = await db.claimThread({ threadId, guildId: GUILD, forumChannelId: FORUM, authorId: "1", now: Date.now() });
  await db.update(threadId, { status: "created", linear_issue_identifier: "ENG-1" }, Date.now());
  return { issueId: row.linear_issue_id };
}

async function post(payload: object, opts: { delivery?: string; secret?: string } = {}) {
  const body = JSON.stringify(payload);
  return SELF.fetch("https://bot.test/webhooks/linear", {
    method: "POST",
    body,
    headers: {
      "Content-Type": "application/json",
      "Linear-Signature": await sign(body, opts.secret ?? env.LINEAR_WEBHOOK_SECRET),
      ...(opts.delivery ? { "Linear-Delivery": opts.delivery } : {}),
    },
  });
}

describe("POST /webhooks/linear", () => {
  afterEach(() => vi.restoreAllMocks());

  it("rejects an invalid signature", async () => {
    const res = await post({ type: "Issue", action: "update", data: { id: "x" }, webhookTimestamp: Date.now() }, { secret: "nope" });
    expect(res.status).toBe(401);
  });

  it("ignores untracked issues and irrelevant changes", async () => {
    const res = await post({ type: "Issue", action: "update", data: { id: "unknown" }, updatedFrom: { stateId: "a" }, webhookTimestamp: Date.now() });
    expect(await res.text()).toBe("not tracked");
    const res2 = await post({ type: "Issue", action: "update", data: { id: "unknown" }, updatedFrom: { title: "a" }, webhookTimestamp: Date.now() });
    expect(await res2.text()).toBe("ignored");
  });

  it("accepts a tracked issue change and dedupes deliveries", async () => {
    // The sync itself is covered in sync.test.ts; this worker runs with the placeholder config.
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("upstream down", { status: 503 }));
    const { issueId } = await trackedRow();
    const payload = { type: "Issue", action: "update", data: { id: issueId }, updatedFrom: { stateId: "s1" }, webhookTimestamp: Date.now() };
    const delivery = crypto.randomUUID();

    const res = await post(payload, { delivery });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");

    const replay = await post(payload, { delivery });
    expect(await replay.text()).toBe("duplicate");
  });
});

describe("admin routes", () => {
  it("require the admin token", async () => {
    expect((await SELF.fetch("https://bot.test/admin/mappings/1")).status).toBe(401);
    const ok = await SELF.fetch("https://bot.test/admin/mappings/1", { headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } });
    expect(ok.status).toBe(404);
  });
});
