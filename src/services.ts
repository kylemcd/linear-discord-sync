import type { Config } from "./config";
import { config as defaultConfig } from "./config.local";
import { Db } from "./db";
import { DiscordRest } from "./discord/rest";
import { LinearClient } from "./linear/client";

/** Everything the sync flows need, built once per request / event. */
export interface Services {
  config: Config;
  db: Db;
  discord: DiscordRest;
  linear: LinearClient;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export function createServices(env: Env, config: Config = defaultConfig): Services {
  return {
    config,
    db: new Db(env.DB),
    discord: new DiscordRest(env.DISCORD_BOT_TOKEN),
    linear: new LinearClient(env.LINEAR_API_KEY),
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  };
}
