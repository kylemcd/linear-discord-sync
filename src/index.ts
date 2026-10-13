import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { HTTPException } from "hono/http-exception";
import { timingSafeEqual } from "hono/utils/buffer";
import { validateConfig } from "./config";
import { config } from "./config.local";
import { isRelevantIssueChange, verifyLinearWebhook } from "./linear/webhook";
import { errorMessage, log } from "./log";
import { createServices } from "./services";
import { runIntake, runMaintenance } from "./sync/cron";
import { intakeThread } from "./sync/intake";
import { syncIssueToDiscord } from "./sync/issueToDiscord";

const configProblems = validateConfig(config);

const app = new Hono<{ Bindings: Env }>();

app.get("/", (c) => c.json({ ok: configProblems.length === 0, configProblems }));

app.post("/webhooks/linear", async (c) => {
  const raw = await c.req.text();
  const verified = await verifyLinearWebhook(raw, c.req.header("linear-signature") ?? null, c.env.LINEAR_WEBHOOK_SECRET);
  if (!verified.ok) {
    log.warn({ operation: "linear_webhook", result: "error", reason: verified.reason });
    return c.text("invalid webhook", 401);
  }
  const event = verified.payload;
  if (!isRelevantIssueChange(event)) return c.text("ignored");

  const s = createServices(c.env);
  const row = await s.db.getByLinearIssue(event.data.id);
  if (!row) return c.text("not tracked");

  const deliveryId = c.req.header("linear-delivery");
  if (deliveryId && !(await s.db.markEventProcessed(deliveryId, "linear", s.now()))) {
    return c.text("duplicate");
  }

  // Mark dirty first so the cron retries if this run fails or is cut short.
  await s.db.update(row.discord_thread_id, { needs_sync: 1 }, s.now());
  c.executionCtx.waitUntil(syncIssueToDiscord(s, { ...row, needs_sync: 1 }, { minUpdatedAt: event.data.updatedAt }));
  return c.text("ok");
});

const admin = new Hono<{ Bindings: Env }>();
admin.use(
  "*",
  bearerAuth({
    verifyToken: async (token, c) => {
      const expected = (c.env as Env).ADMIN_TOKEN;
      return !!expected && (await timingSafeEqual(token, expected));
    },
  }),
);


/** Run every scheduled job now and report each one's result. */
admin.post("/sweep", async (c) => {
  const s = createServices(c.env);
  const results = { ...(await runIntake(s)), ...(await runMaintenance(s)) };
  return c.json({ ok: Object.values(results).every((r) => r === "ok"), results });
});

admin.get("/mappings/:threadId", async (c) => {
  const row = await createServices(c.env).db.getByThread(c.req.param("threadId"));
  return row ? c.json(row) : c.json({ error: "not found" }, 404);
});

/** Take in one thread now: retries a failed intake, or backfills a post older than intakeSince. */
admin.post("/retry/:threadId", async (c) => {
  const s = createServices(c.env);
  const threadId = c.req.param("threadId");
  const row = await s.db.getByThread(threadId);
  if (row) {
    await s.db.update(
      threadId,
      { status: row.status === "failed" ? "pending" : row.status, next_attempt_at: 0, failure_notice_posted: 0 },
      s.now(),
    );
  }
  await intakeThread(s, threadId, { force: true });
  return c.json(await s.db.getByThread(threadId));
});

/** Force a Linear → Discord resync of one thread. */
admin.post("/resync/:threadId", async (c) => {
  const s = createServices(c.env);
  const row = await s.db.getByThread(c.req.param("threadId"));
  if (!row) return c.json({ error: "not found" }, 404);
  await syncIssueToDiscord(s, { ...row, needs_sync: 1 });
  return c.json(await s.db.getByThread(row.discord_thread_id));
});

app.route("/admin", admin);

app.onError((err, c) => {
  if (err instanceof HTTPException) return err.getResponse();
  log.error({ operation: "http", result: "error", path: c.req.path, error: errorMessage(err) });
  return c.text("internal error", 500);
});

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    if (configProblems.length > 0) {
      log.error({ operation: "config", result: "fatal", problems: configProblems });
      return;
    }
    // Every minute: new posts. Discord has no webhook for them, so the bot polls.
    // Linear changes arrive by webhook and don't wait for this.
    const s = createServices(env);
    await runIntake(s);
    if (new Date(controller.scheduledTime).getUTCMinutes() % 30 === 0) {
      ctx.waitUntil(runMaintenance(s));
    }
  },
} satisfies ExportedHandler<Env>;
