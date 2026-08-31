import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { instanceId } from "../../common/instance-id";
import { config } from "../../config";

export type ClaimResult = "ok" | "owned_elsewhere" | "no_redis";

const ownerKey = (sessionId: string) => `voice:owner:${sessionId}`;

@Injectable()
export class SessionOwnershipService implements OnModuleDestroy {
  private readonly log = new Logger(SessionOwnershipService.name);
  private readonly owner = instanceId();
  private redis: Redis | null = null;
  private redisUp = false;

  constructor() {
    try {
      this.redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 2000,
        commandTimeout: 2000,
        enableOfflineQueue: false,
      });
      this.redis
        .connect()
        .then(() => {
          this.redisUp = true;
        })
        .catch((err) => {
          this.log.warn(`redis ownership unavailable: ${err}`);
          this.redis = null;
        });
    } catch {
      this.redis = null;
    }
  }

  get instance(): string {
    return this.owner;
  }

  isRedisUp(): boolean {
    return this.redisUp;
  }

  async ping(): Promise<boolean> {
    if (!this.redis) return false;
    try {
      const pong = await this.redis.ping();
      this.redisUp = pong === "PONG";
      return this.redisUp;
    } catch {
      this.redisUp = false;
      return false;
    }
  }

  /** Claim live WS ownership for this instance. */
  async claim(sessionId: string): Promise<ClaimResult> {
    if (!this.redis) return "no_redis";
    const k = ownerKey(sessionId);
    try {
      const current = await this.redis.get(k);
      if (current === this.owner) {
        await this.redis.expire(k, config.sessionTtlSec);
        return "ok";
      }
      if (current) return "owned_elsewhere";
      const ok = await this.redis.set(k, this.owner, "EX", config.sessionTtlSec, "NX");
      return ok === "OK" ? "ok" : "owned_elsewhere";
    } catch (err) {
      this.log.warn(`claim ${sessionId}: ${err}`);
      return "no_redis";
    }
  }

  async release(sessionId: string): Promise<void> {
    if (!this.redis) return;
    const k = ownerKey(sessionId);
    try {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        k,
        this.owner,
      );
    } catch (err) {
      this.log.debug(`release ${sessionId}: ${err}`);
    }
  }

  async getOwner(sessionId: string): Promise<string | null> {
    if (!this.redis) return null;
    try {
      return await this.redis.get(ownerKey(sessionId));
    } catch {
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }
}
