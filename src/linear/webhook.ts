/** Maximum allowed difference between the signed webhookTimestamp and now. */
const MAX_SKEW_MS = 60_000;

export interface LinearIssueWebhook {
  action: "create" | "update" | "remove" | string;
  type: string;
  data: {
    id: string;
    identifier?: string;
    stateId?: string;
    labelIds?: string[];
    teamId?: string;
    updatedAt?: string;
  };
  updatedFrom?: Record<string, unknown> | null;
  webhookTimestamp: number;
  webhookId?: string;
  url?: string;
}

export type VerifyResult = { ok: true; payload: LinearIssueWebhook } | { ok: false; reason: string };

/**
 * Verify a Linear webhook the same way @linear/sdk's LinearWebhookClient does:
 * `Linear-Signature` is the hex HMAC-SHA256 of the raw body, and the signed
 * `webhookTimestamp` must be within one minute of now.
 */
export async function verifyLinearWebhook(
  rawBody: string,
  signature: string | null,
  secret: string,
  now: number = Date.now(),
): Promise<VerifyResult> {
  if (!signature) return { ok: false, reason: "missing signature" };

  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody));
  const expected = toHex(new Uint8Array(mac));
  if (!timingSafeEqual(expected, signature.trim().toLowerCase())) {
    return { ok: false, reason: "invalid signature" };
  }

  let payload: LinearIssueWebhook;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: "invalid json" };
  }
  const ts = payload.webhookTimestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts) || Math.abs(now - ts) > MAX_SKEW_MS) {
    return { ok: false, reason: "stale or missing webhookTimestamp" };
  }
  return { ok: true, payload };
}

/** True when an Issue webhook changed something this integration mirrors. */
export function isRelevantIssueChange(event: LinearIssueWebhook): boolean {
  if (event.type !== "Issue") return false;
  if (event.action === "remove") return true;
  if (event.action !== "update") return false;
  const from = event.updatedFrom ?? {};
  return "stateId" in from || "labelIds" in from || "trashed" in from;
}

function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
