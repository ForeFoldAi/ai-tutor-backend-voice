import Redis from "ioredis";
import { Logger } from "@nestjs/common";
import { config } from "../config";

const log = new Logger("Redis");

export type RedisHandle = {
  client: Redis;
  /** Call after repeated command failures — drops Redis, keeps in-memory fallback. */
  disable: (reason: string) => void;
};

/** Lazy-connect ioredis with shared timeouts. Returns null when REDIS_URL is empty. */
export function createRedisClient(label: string): RedisHandle | null {
  if (!config.redisUrl) return null;
  try {
    const client = new Redis(config.redisUrl, {
      maxRetriesPerRequest: 1,
      lazyConnect: true,
      connectTimeout: config.redisConnectTimeoutMs,
      commandTimeout: config.redisCommandTimeoutMs,
      enableOfflineQueue: false,
    });
    // ponytail: ioredis emits 'error' on DNS/refused; unhandled events can crash Node during deploy.
    client.on("error", (err) => log.debug(`${label}: ${err.message}`));
    client.connect().catch((err) => {
      log.warn(`${label}: connect failed, memory only: ${err}`);
      client.disconnect();
    });
    return {
      client,
      disable(reason: string) {
        log.warn(`${label}: disabled (${reason}) — memory only until restart`);
        client.disconnect();
      },
    };
  } catch (err) {
    log.warn(`${label}: init failed: ${err}`);
    return null;
  }
}
