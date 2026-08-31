import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import Redis from "ioredis";
import { config } from "../../config";
import { ChatTurn, SessionScope, TutorSnapshot, VoiceState } from "../tutor/interfaces";
import { defaultSnapshot } from "../tutor/tutor-state.service";

export type VoiceSession = {
  id: string;
  conversationId: string;
  studentId: string;
  accessToken: string;
  scope: SessionScope;
  state: VoiceState;
  tutor: TutorSnapshot;
  recentMessages: ChatTurn[];
  summary: string;
  currentTopic: string;
  startedAt: number;
};

const key = (id: string) => `voice:rtc:${id}`;
const WINDOW = 12;

@Injectable()
export class ConversationMemoryService implements OnModuleDestroy {
  private readonly log = new Logger(ConversationMemoryService.name);
  private redis: Redis | null = null;
  private readonly mem = new Map<string, VoiceSession>();

  constructor() {
    try {
      this.redis = new Redis(config.redisUrl, {
        maxRetriesPerRequest: 1,
        lazyConnect: true,
        connectTimeout: 2000,
        commandTimeout: 2000,
        enableOfflineQueue: false,
      });
      this.redis.connect().catch((err) => {
        this.log.warn(`redis unavailable, memory only: ${err}`);
        this.redis = null;
      });
    } catch {
      this.redis = null;
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.redis?.quit();
  }

  async save(session: VoiceSession): Promise<void> {
    session.recentMessages = session.recentMessages.slice(-WINDOW);
    this.mem.set(session.id, session);
    if (!this.redis) return;
    void this.redis
      .set(key(session.id), JSON.stringify(session), "EX", config.sessionTtlSec)
      .catch((err) => this.log.debug(`redis save skip: ${err}`));
  }

  async get(id: string): Promise<VoiceSession | null> {
    const hit = this.mem.get(id);
    if (hit) return hit;
    if (!this.redis) return null;
    try {
      const raw = await this.redis.get(key(id));
      if (!raw) return null;
      const session = JSON.parse(raw) as VoiceSession;
      this.mem.set(id, session);
      return session;
    } catch {
      return null;
    }
  }

  async drop(id: string): Promise<void> {
    this.mem.delete(id);
    try {
      await this.redis?.del(key(id));
    } catch {
      /* ignore */
    }
  }

  create(partial: Omit<VoiceSession, "tutor" | "recentMessages" | "summary" | "state" | "currentTopic" | "startedAt"> & Partial<VoiceSession>): VoiceSession {
    return {
      tutor: defaultSnapshot(),
      recentMessages: [],
      summary: "",
      state: "IDLE",
      currentTopic: "",
      startedAt: Date.now(),
      ...partial,
    };
  }
}
