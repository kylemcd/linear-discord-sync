import { createExecutionContext, env, SELF } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { SimKitSupportLinear } from "../src/simkit-support-linear";

beforeEach(() => {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    if (request.url === "https://api.linear.app/graphql" && request.method === "POST"
      && request.headers.get("Authorization") === "test-linear-key")
      return Response.json({ data: { viewer: { id: "test-viewer" } } });
    if (request.url === "https://uploads.linear.app/report" && request.headers.get("Authorization") === "test-linear-key")
      return new Response(null, { status: 302, headers: { Location: "https://test-bucket.s3.amazonaws.com/report?signed=test" } });
    if (request.url === "https://test-bucket.s3.amazonaws.com/report?signed=test" && !request.headers.has("Authorization"))
      return new Response("private diagnostic content");
    throw new Error("Unexpected outbound request or credential.");
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

it("keeps the private asset handler off the public Discord worker", async () => {
  const response = await SELF.fetch("https://bot.test/asset", { method: "POST", body: "https://uploads.linear.app/report" });
  expect(response.status).toBe(404);
});

it("uses the existing credential for Linear, but not the signed storage redirect", async () => {
  const gateway = new SimKitSupportLinear(createExecutionContext(), env);
  const response = await gateway.fetch(new Request("https://private/", { method: "POST", body: '{"query":"{ viewer { id } }"}' }));
  expect(await response.json()).toEqual({ data: { viewer: { id: "test-viewer" } } });
  const asset = await gateway.fetch(new Request("https://private/asset", { method: "POST", body: "https://uploads.linear.app/report" }));
  expect(await asset.text()).toBe("private diagnostic content");
});

it("rejects an arbitrary asset host without making an outbound request", async () => {
  const gateway = new SimKitSupportLinear(createExecutionContext(), env);
  const response = await gateway.fetch(new Request("https://private/asset", { method: "POST", body: "https://attacker.test/report" }));
  expect(response.status).toBe(400);
});
