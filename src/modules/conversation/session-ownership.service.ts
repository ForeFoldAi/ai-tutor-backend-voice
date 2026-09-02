import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createRedisClient } from "../../common/redis-client";
import { instanceId } from "../../common/instance-id";
import { config } from "../../config";

export type ClaimResult = "ok" | "owned_elsewhere" | "no_redis";

const ownerKey = (sessionId: string) => `voice:owner:${sessionId}`;

@Injectable()
export class SessionOwnershipService implements OnModuleDestroy {
  private readonly log = new Logger(SessionOwnershipService.name);
  private readonly owner = instanceId();
  private redis = createRedisClient("SessionOwnership");
  private redisUp = false;

  get instance(): string {
    return this.owner;
  }

  isRedisUp(): boolean {
    return this.redisUp;
  }

  async ping(): Promise<boolean> {
    const r = this.redis;
    if (!r) return false;
    try {
      const pong = await r.client.ping();
      this.redisUp = pong === "PONG";
      return this.redisUp;
    } catch {
      this.redisUp = false;
      return false;
    }
  }

  /** Claim live WS ownership for this instance. */
  async claim(sessionId: string): Promise<ClaimResult> {
    const r = this.redis;
    if (!r) return "no_redis";
    const k = ownerKey(sessionId);
    try {
      const current = await r.client.get(k);
      if (current === this.owner) {
        await r.client.expire(k, config.sessionTtlSec);
        return "ok";
      }
      if (current) return "owned_elsewhere";
      const ok = await r.client.set(k, this.owner, "EX", config.sessionTtlSec, "NX");
      return ok === "OK" ? "ok" : "owned_elsewhere";
    } catch (err) {
      this.log.warn(`claim ${sessionId}: ${err}`);
      return "no_redis";
    }
  }

  async release(sessionId: string): Promise<void> {
    const r = this.redis;
    if (!r) return;
    const k = ownerKey(sessionId);
    try {
      await r.client.eval(
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
    const r = this.redis;
    if (!r) return null;
    try {
      return await r.client.get(ownerKey(sessionId));
    } catch {
      return null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.client.quit();
  }
}
