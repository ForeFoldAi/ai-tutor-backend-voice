import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
import { createRedisClient } from "../../common/redis-client";
import { config } from "../../config";
import { ChatTurn, FastApiTutorState, SessionScope, TutorSnapshot, VoiceState } from "../tutor/interfaces";
import { defaultSnapshot } from "../tutor/tutor-state.service";

/** Ask AI Tutor modes — when set, Nest routes turns to student_assistant (not chapter RAG). */
export type AssistantAgentMode = "free" | "ask" | "practice" | "explain";

export type VoiceSession = {
  id: string;
  conversationId: string;
  studentId: string;
  accessToken: string;
  scope: SessionScope;
  /** When set, voice is transport-only for Ask AI Tutor. */
  agentMode?: AssistantAgentMode;
  state: VoiceState;
  tutor: TutorSnapshot;
  recentMessages: ChatTurn[];
  summary: string;
  currentTopic: string;
  startedAt: number;
  /** FastAPI voice tutor state machine */
  tutorState: FastApiTutorState;
  explainedPoints: string[];
  affectTrajectory: string[];
  quizAttempts: number;
  lastQuizQuestion: string;
  lastFillerPhrase: string;
};

const key = (id: string) => `voice:rtc:${id}`;
const WINDOW = 14;
const MAX_REDIS_FAILURES = 3;

@Injectable()
export class ConversationMemoryService implements OnModuleDestroy {
  private readonly log = new Logger(ConversationMemoryService.name);
  private redis = createRedisClient("ConversationMemory");
  private redisFailures = 0;
  private readonly mem = new Map<string, VoiceSession>();

  async onModuleDestroy(): Promise<void> {
    await this.redis?.client.quit();
  }

  private disableRedis(reason: string): void {
    this.redis?.disable(reason);
    this.redis = null;
  }

  async save(session: VoiceSession): Promise<void> {
    session.recentMessages = session.recentMessages.slice(-WINDOW);
    this.mem.set(session.id, session);
    const r = this.redis;
    if (!r) return;
    void r.client
      .set(key(session.id), JSON.stringify(session), "EX", config.sessionTtlSec)
      .then(() => {
        this.redisFailures = 0;
      })
      .catch((err) => {
        this.redisFailures += 1;
        if (this.redisFailures >= MAX_REDIS_FAILURES) {
          this.disableRedis(String(err));
          return;
        }
        this.log.debug(`redis save skip (${this.redisFailures}/${MAX_REDIS_FAILURES}): ${err}`);
      });
  }

  async get(id: string): Promise<VoiceSession | null> {
    const hit = this.mem.get(id);
    if (hit) return hit;
    const r = this.redis;
    if (!r) return null;
    try {
      const raw = await r.client.get(key(id));
      if (!raw) return null;
      const session = JSON.parse(raw) as VoiceSession;
      session.tutorState = session.tutorState ?? "TEACHING";
      session.explainedPoints = session.explainedPoints ?? [];
      session.affectTrajectory = session.affectTrajectory ?? [];
      session.quizAttempts = session.quizAttempts ?? 0;
      session.lastQuizQuestion = session.lastQuizQuestion ?? "";
      session.lastFillerPhrase = session.lastFillerPhrase ?? "";
      // agentMode may be absent on older Redis snapshots — leave undefined
      this.mem.set(id, session);
      this.redisFailures = 0;
      return session;
    } catch (err) {
      this.redisFailures += 1;
      if (this.redisFailures >= MAX_REDIS_FAILURES) this.disableRedis(String(err));
      return null;
    }
  }

  async drop(id: string): Promise<void> {
    this.mem.delete(id);
    try {
      await this.redis?.client.del(key(id));
    } catch {
      /* ignore */
    }
  }

  create(partial: Omit<VoiceSession, "tutor" | "recentMessages" | "summary" | "state" | "currentTopic" | "startedAt" | "tutorState" | "explainedPoints" | "affectTrajectory" | "quizAttempts" | "lastQuizQuestion" | "lastFillerPhrase"> & Partial<VoiceSession>): VoiceSession {
    return {
      tutor: defaultSnapshot(),
      recentMessages: [],
      summary: "",
      state: "IDLE",
      currentTopic: "",
      startedAt: Date.now(),
      tutorState: "TEACHING",
      explainedPoints: [],
      affectTrajectory: [],
      quizAttempts: 0,
      lastQuizQuestion: "",
      lastFillerPhrase: "",
      ...partial,
    };
  }
}
