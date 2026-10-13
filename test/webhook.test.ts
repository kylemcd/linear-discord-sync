import { describe, expect, it } from "vitest";
import { isRelevantIssueChange, verifyLinearWebhook } from "../src/linear/webhook";

export async function sign(body: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

const SECRET = "shh";

describe("verifyLinearWebhook", () => {
  const now = 1_800_000_000_000;
  const body = JSON.stringify({ action: "update", type: "Issue", data: { id: "i1" }, webhookTimestamp: now });

  it("accepts a correctly signed, fresh payload", async () => {
    const result = await verifyLinearWebhook(body, await sign(body, SECRET), SECRET, now + 5_000);
    expect(result.ok).toBe(true);
  });

  it("rejects a bad signature", async () => {
    const result = await verifyLinearWebhook(body, await sign(body, "other"), SECRET, now);
    expect(result).toEqual({ ok: false, reason: "invalid signature" });
  });

  it("rejects a missing signature", async () => {
    expect((await verifyLinearWebhook(body, null, SECRET, now)).ok).toBe(false);
  });

  it("rejects a tampered body", async () => {
    const sig = await sign(body, SECRET);
    expect((await verifyLinearWebhook(body.replace("i1", "i2"), sig, SECRET, now)).ok).toBe(false);
  });

  it("rejects a stale timestamp", async () => {
    const result = await verifyLinearWebhook(body, await sign(body, SECRET), SECRET, now + 61_000);
    expect(result).toEqual({ ok: false, reason: "stale or missing webhookTimestamp" });
  });
});

describe("isRelevantIssueChange", () => {
  const base = { type: "Issue", data: { id: "i" }, webhookTimestamp: 0 };
  it("matches state and label changes and removals", () => {
    expect(isRelevantIssueChange({ ...base, action: "update", updatedFrom: { stateId: "x" } })).toBe(true);
    expect(isRelevantIssueChange({ ...base, action: "update", updatedFrom: { labelIds: [] } })).toBe(true);
    expect(isRelevantIssueChange({ ...base, action: "remove" })).toBe(true);
  });
  it("ignores other changes", () => {
    expect(isRelevantIssueChange({ ...base, action: "update", updatedFrom: { title: "x" } })).toBe(false);
    expect(isRelevantIssueChange({ ...base, action: "create" })).toBe(false);
    expect(isRelevantIssueChange({ ...base, type: "Comment", action: "remove" })).toBe(false);
  });
});
