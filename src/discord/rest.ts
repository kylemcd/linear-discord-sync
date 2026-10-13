import type {
  APIEmbed,
  APIMessage,
  APIThreadChannel,
  RESTGetAPIGatewayBotResult,
  RESTGetAPIGuildThreadsResult,
  RESTPatchAPIChannelJSONBody,
} from "discord-api-types/v10";

const API = "https://discord.com/api/v10";
const USER_AGENT = "DiscordBot (discord-linear-sync, 0.1.0)";

export class DiscordApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: number | undefined,
    message: string,
  ) {
    super(message);
    this.name = "DiscordApiError";
  }
  get notFound(): boolean {
    return this.status === 404;
  }
}

export interface ThreadPatch extends RESTPatchAPIChannelJSONBody {
  applied_tags?: string[];
  archived?: boolean;
  locked?: boolean;
  name?: string;
}

export class DiscordRest {
  constructor(private readonly token: string) {}

  getThread(threadId: string): Promise<APIThreadChannel> {
    return this.request("GET", `/channels/${threadId}`);
  }

  getMessage(channelId: string, messageId: string): Promise<APIMessage> {
    return this.request("GET", `/channels/${channelId}/messages/${messageId}`);
  }

  patchThread(threadId: string, patch: ThreadPatch, reason?: string): Promise<APIThreadChannel> {
    return this.request("PATCH", `/channels/${threadId}`, patch, reason);
  }

  /** Only users listed in `pingUserIds` are notified; nothing else in the content can ping. */
  sendMessage(
    channelId: string,
    message: { content?: string; embeds?: APIEmbed[] },
    pingUserIds: string[] = [],
  ): Promise<APIMessage> {
    return this.request("POST", `/channels/${channelId}/messages`, {
      ...message,
      allowed_mentions: { parse: [], users: pingUserIds },
    });
  }

  listActiveThreads(guildId: string): Promise<RESTGetAPIGuildThreadsResult> {
    return this.request("GET", `/guilds/${guildId}/threads/active`);
  }

  getGatewayBot(): Promise<RESTGetAPIGatewayBotResult> {
    return this.request("GET", "/gateway/bot");
  }

  private async request<T>(method: string, path: string, body?: unknown, reason?: string): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const headers: Record<string, string> = {
        Authorization: `Bot ${this.token}`,
        "User-Agent": USER_AGENT,
      };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (reason) headers["X-Audit-Log-Reason"] = encodeURIComponent(reason);

      const res = await fetch(`${API}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });

      if (res.status === 429 && attempt < 2) {
        const data = (await res.json().catch(() => ({}))) as { retry_after?: number };
        const waitMs = Math.ceil((data.retry_after ?? 1) * 1000);
        // Short waits are cheap to absorb here; long ones fall through to the caller's retry.
        if (waitMs <= 5000) {
          await new Promise((r) => setTimeout(r, waitMs));
          continue;
        }
      }

      if (!res.ok) {
        const text = await res.text();
        let code: number | undefined;
        try {
          code = (JSON.parse(text) as { code?: number }).code;
        } catch {
          // not JSON
        }
        throw new DiscordApiError(res.status, code, `Discord ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
      }
      if (res.status === 204) return undefined as T;
      return (await res.json()) as T;
    }
  }
}

export function threadUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

/** Milliseconds since epoch encoded in a Discord snowflake. */
export function snowflakeTime(id: string): number {
  return Number((BigInt(id) >> 22n) + 1420070400000n);
}
