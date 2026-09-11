import { Injectable, Logger, OnModuleInit } from "@nestjs/common";
import { config } from "../../config";
import { MSG } from "../../common/messages";
import { voiceLog } from "../../common/logger";
import { floatToInt16, int16ToFloat, packPcm, PCM_SAMPLE_RATE, resample, unpackPcm } from "../../audio/pcm";
import { SileroVad, loadSilero } from "../../audio/vad";
import { speakable } from "../../audio/sentences";
import {
  AssistantAgentMode,
  ConversationMemoryService,
  VoiceSession,
} from "../conversation/conversation-memory.service";
import { SessionOwnershipService } from "../conversation/session-ownership.service";
import { ConversationSummaryService } from "../conversation/conversation-summary.service";
import { ProgressService } from "../progress/progress.service";
import { RagClient, RagAuthError, RagResult } from "../rag/rag.client";
import { AnswerEvaluatorService } from "../tutor/answer-evaluator.service";
import { nextDifficulty } from "../tutor/difficulty-manager.service";
import { QueryRewriterService } from "../tutor/query-rewriter.service";
import { QuestionGeneratorService } from "../tutor/question-generator.service";
import { afterEvaluate, afterExplainShouldCheck, decideAction } from "../tutor/tutor-orchestrator.service";
import { classifyReplyIntent, isBareAcknowledgement, dialogueActForUtterance } from "../tutor/reply-intent";
import type { DialogueAct } from "../tutor/reply-intent";
import { followupIntent, isRecallQuestion, topicFromQuestion } from "../tutor/query-rewriter";
import { NestFollowupIntent } from "../tutor/interfaces";
import { RecallService } from "../tutor/recall.service";
import { AnswerGrade, ChatTurn, SessionScope } from "../tutor/interfaces";
import { turnStillActive } from "../tutor/turn-commit";
import {
  assistantTranscript,
  turnCancelledPayload,
  userTranscriptCommitted,
  userTranscriptPending,
} from "./transcript-events";
import { isLikelyEcho, isMeaningfulTranscript, pcmSpeechRms, postprocessTranscript } from "./stt-quality";
import { WhisperSttProvider } from "./providers/whisper.stt";
import { TtsProvider } from "./providers/tts.provider";
import { FillerIntent, PreparedFiller, ThinkingFillerService } from "./thinking-filler.service";
import { resolveFillerPlan, type FillerPlan } from "./filler-mode";
import { WebrtcService } from "./webrtc.service";
import { IVoiceProvider, VoiceSessionHandle } from "./interfaces/voice-provider";
import { randomUUID } from "crypto";
import { instanceId } from "../../common/instance-id";

type Emit = (event: string, payload?: Record<string, unknown>) => void;
type EmitPcm = (buf: Buffer) => void;

type Live = {
  sessionId: string;
  vad: SileroVad;
  chunks: Int16Array[];
  abort: AbortController;
  emit: Emit;
  emitPcm?: EmitPcm;
  speaking: boolean;
  pcmQ: Promise<void>;
  /** Bumped per turn and on interrupt, so filler callbacks can spot a stale turn. */
  turnId: number;
  /** Arm timer, then reused as the drain timer once the filler is playing. */
  fillerTimer: NodeJS.Timeout | null;
  /** In-flight LLM/canned clip prep for this turn. */
  fillerPending: Promise<PreparedFiller | null> | null;
  /** Plan used to prepare the pending filler (for markUsed / logs). */
  fillerPlan: FillerPlan | null;
  /** Epoch ms the current filler stops being audible; 0 when none is playing. */
  fillerEndsAt: number;
  /** True once the real answer's first PCM frame is on the wire. */
  answerAudioStarted: boolean;
  /** Start of the turn in flight, for time-to-first-audio. */
  turnStartedAt: number;
  /** Time-to-first-audio of the turn in flight. */
  ttfaMs: number;
  /** Recent time-to-first-audio samples; drives adaptive filler gating. */
  ttfa: number[];
  /** This student's A/B assignment, fixed for the session. */
  fillerCohort: boolean;
  /** Phrase spoken as thinking filler this turn (for LLM de-duplication). */
  lastFillerPhrase: string;
  /** Student utterance for the in-flight turn — committed when speech starts. */
  turnUtterance: string;
  /** Queue one turn at a time per session (pcmQ already serializes VAD; this covers text + STT). */
  turnQ: Promise<void>;
  /** Epoch ms the tutor last finished speaking (echo window). */
  lastSpokeAt: number;
};

/**
 * One streaming reply in progress. TTS is chained rather than parallel so
 * frames reach the client in the order the sentences were written.
 */
type SpeechStream = {
  /** Bumped synchronously on dispatch; `begun` only flips inside the chain. */
  dispatched: number;
  begun: boolean;
  failed: boolean;
  queue: Promise<void>;
  /**
   * The turn's own signal. interruptSession installs a fresh controller on
   * `live`, so checking live.abort here would let chunks queued by the cut
   * turn wake up and speak over the next one.
   */
  signal?: AbortSignal;
  /** Turn that queued this speech; stale after interrupt bumps live.turnId. */
  turnId: number;
  /** Text spoken so far — mirrored to the transcript as each PCM chunk goes out. */
  spokenText: string;
  /** Optional action tag for the progressive assistant transcript. */
  transcriptAction?: string;
  /** Once the full reply is published, stop overwriting with speakable prefixes. */
  transcriptFinal?: boolean;
};

const TTFA_SAMPLES = 8;
/**
 * A refusal the student should hear as MSG.notInTextbook instead.
 *
 * Covers both the canned FastAPI string and the wording the voice system
 * prompt itself prescribes when the retrieved context is too thin — the
 * model authors that sentence, so matching only the canned one silently
 * misses every model-authored refusal.
 */
const NOT_IN_CHAPTER =
  /couldn't find this in your chapter|don'?t see that (?:detail|information) in the textbook|don'?t have enough information about that/i;

@Injectable()
export class VoiceService implements IVoiceProvider, OnModuleInit {
  private readonly log = new Logger(VoiceService.name);
  private readonly live = new Map<string, Live>();
  private current: string | null = null;
  private draining = false;

  constructor(
    private readonly memory: ConversationMemoryService,
    private readonly ownership: SessionOwnershipService,
    private readonly summary: ConversationSummaryService,
    private readonly rag: RagClient,
    private readonly rewriter: QueryRewriterService,
    private readonly evaluator: AnswerEvaluatorService,
    private readonly questions: QuestionGeneratorService,
    private readonly recall: RecallService,
    private readonly progress: ProgressService,
    private readonly stt: WhisperSttProvider,
    private readonly tts: TtsProvider,
    private readonly filler: ThinkingFillerService,
    private readonly rtc: WebrtcService,
  ) {}

  async onModuleInit(): Promise<void> {
    loadSilero().catch((err) => this.log.warn(`silero preload: ${err}`));
  }

  async startSession(): Promise<VoiceSessionHandle> {
    const id = this.current || randomUUID();
    return { id };
  }

  async stopSession(): Promise<void> {
    if (this.current) await this.end(this.current);
  }

  async interrupt(): Promise<void> {
    if (this.current) await this.interruptSession(this.current);
  }

  async create(opts: {
    studentId: string;
    token: string;
    scope: SessionScope;
    agentMode?: AssistantAgentMode;
    conversationHistory?: ChatTurn[];
  }): Promise<VoiceSession> {
    if (this.draining) throw new Error("server_draining");
    const id = randomUUID();
    const conversationId = randomUUID();
    const history: ChatTurn[] = (opts.conversationHistory || [])
      .filter((t) => (t.role === "user" || t.role === "assistant") && Boolean(String(t.content || "").trim()))
      .map((t) => ({ role: t.role as "user" | "assistant", content: String(t.content).trim() }))
      .slice(-14);
    const session = this.memory.create({
      id,
      conversationId,
      studentId: opts.studentId,
      accessToken: opts.token,
      scope: opts.scope,
      agentMode: opts.agentMode,
      recentMessages: history,
      state: "IDLE",
    });
    await this.memory.save(session);
    // ponytail: remote redis/postgres must not block session_ready
    void this.progress.startSession({
      id,
      studentId: opts.studentId,
      conversationId,
      classLevel: opts.scope.classLevel,
      subject: opts.scope.subject || opts.agentMode || "assistant",
    });
    // Edge TTS needs a student JWT, so the filler cache cannot warm at boot.
    // First session of the process pays for it, in the background.
    this.filler.warm(opts.token);
    this.current = id;
    return session;
  }

  /** Keep FastAPI bearer fresh after resume / token refresh from the client. */
  async updateAccessToken(sessionId: string, token: string, studentId: string): Promise<boolean> {
    const session = await this.memory.get(sessionId);
    if (!session || session.studentId !== studentId) return false;
    session.accessToken = token;
    await this.memory.save(session);
    this.filler.warm(token);
    return true;
  }

  async attachTransport(
    sessionId: string,
    emit: Emit,
    emitPcm?: EmitPcm,
  ): Promise<"ok" | "owned_elsewhere"> {
    const claim = await this.ownership.claim(sessionId);
    if (claim === "owned_elsewhere") return "owned_elsewhere";
    const live: Live = {
      sessionId,
      vad: new SileroVad({ hangMs: 900 }),
      chunks: [],
      abort: new AbortController(),
      emit,
      emitPcm,
      speaking: false,
      pcmQ: Promise.resolve(),
      turnId: 0,
      fillerTimer: null,
      fillerPending: null,
      fillerPlan: null,
      fillerEndsAt: 0,
      answerAudioStarted: false,
      turnStartedAt: Date.now(),
      ttfaMs: 0,
      ttfa: [],
      fillerCohort: true,
      lastFillerPhrase: "",
      turnUtterance: "",
      turnQ: Promise.resolve(),
      lastSpokeAt: 0,
    };
    this.live.set(sessionId, live);
    void this.memory.get(sessionId).then((s) => {
      if (s) live.fillerCohort = this.filler.enabledFor(s.studentId);
    });
    return "ok";
  }

  /** Drop live WS state but keep Redis session for resume. */
  async detach(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    if (live) {
      live.abort.abort();
      this.clearFiller(live);
      this.filler.release(sessionId);
      this.live.delete(sessionId);
    }
    await this.ownership.release(sessionId);
    const session = await this.memory.get(sessionId);
    if (session && session.state !== "ENDED") {
      session.state = "IDLE";
      await this.memory.save(session);
    }
  }

  isDraining(): boolean {
    return this.draining;
  }

  setDraining(on: boolean): void {
    this.draining = on;
    this.log.warn(`draining=${on}`);
  }

  liveSessionCount(): number {
    return this.live.size;
  }

  getInstanceId(): string {
    return instanceId();
  }

  onPcm(sessionId: string, buf: Buffer): void {
    const live = this.live.get(sessionId);
    if (!live || buf.length < 10) return;
    live.pcmQ = live.pcmQ.then(() => this.consumePcm(live, buf)).catch((err) => {
      this.log.warn(`vad ${err}`);
    });
  }

  private async consumePcm(live: Live, buf: Buffer): Promise<void> {
    let { samples, sampleRate } = unpackPcm(buf);
    if (sampleRate !== PCM_SAMPLE_RATE) {
      samples = floatToInt16(resample(int16ToFloat(samples), sampleRate, PCM_SAMPLE_RATE));
    }
    const events = await live.vad.push(samples);
    const hadStart = events.includes("start");
    const hadStop = events.includes("stop");
    if (hadStart) {
      live.chunks = [samples];
      live.emit("student_started_speaking");
      // Filler audio is interruptible AI audio like any other — it does not set
      // `speaking`, so barge-in has to check it explicitly.
      if (live.speaking || this.fillerAudible(live)) {
        if (pcmSpeechRms(samples) < config.sttMinSpeechRms) return;
        void this.interruptSession(live.sessionId);
      }
    } else if (live.chunks.length > 0 || events.includes("speech")) {
      live.chunks.push(samples);
    }
    if (hadStop) {
      live.emit("student_stopped_speaking");
      const merged = concat(live.chunks);
      live.chunks = [];
      if (Date.now() - live.lastSpokeAt < config.sttPostPlaybackMs) {
        live.vad.reset();
        return;
      }
      void this.enqueueTurn(live.sessionId, () => this.handleUtterance(live.sessionId, merged));
    }
  }

  async handleText(
    sessionId: string,
    text: string,
    opts: { filler?: boolean; synthetic?: boolean } = {},
  ): Promise<void> {
    await this.enqueueTurn(sessionId, () => this.runTurn(sessionId, text, Date.now(), opts));
  }

  /** Serialize turns so concurrent STT/text cannot race on recentMessages. */
  private enqueueTurn(sessionId: string, work: () => Promise<void>): Promise<void> {
    const live = this.live.get(sessionId);
    if (!live) return work();
    const run = live.turnQ.then(work, work);
    // ponytail: single FIFO per session; upgrade to AbortController-linked queue if backlog grows
    live.turnQ = run.catch(() => undefined);
    return run;
  }

  async interruptSession(sessionId: string): Promise<void> {
    const live = this.live.get(sessionId);
    live?.abort.abort();
    if (live) {
      if (this.fillerAudible(live)) {
        voiceLog("filler_interrupted", { sessionId });
      }
      this.clearFiller(live);
      // Invalidates any filler callback still queued for the turn being cut.
      live.turnId += 1;
      live.abort = new AbortController();
      live.speaking = false;
    }
    const session = await this.memory.get(sessionId);
    if (session) {
      session.state = "INTERRUPTED";
      await this.memory.save(session);
    }
    live?.emit("ai_interrupted");
    live?.emit("student_started_speaking");
    if (live) {
      live.chunks = [];
      live.vad.reset();
      live.lastSpokeAt = Date.now();
    }
  }

  async end(sessionId: string): Promise<void> {
    const session = await this.memory.get(sessionId);
    if (session) {
      session.state = "ENDED";
      await this.progress.endSession(sessionId, session.startedAt);
    }
    const live = this.live.get(sessionId);
    live?.abort.abort();
    if (live) this.clearFiller(live);
    this.filler.release(sessionId);
    live?.emit("session_ended");
    this.live.delete(sessionId);
    await this.ownership.release(sessionId);
    await this.rtc.close(sessionId);
    await this.memory.drop(sessionId);
  }

  private async handleUtterance(sessionId: string, pcm: Int16Array): Promise<void> {
    const live = this.live.get(sessionId);
    const t0 = Date.now();
    live?.emit("ai_started_processing");
    const session = await this.memory.get(sessionId);
    if (!session) return;
    session.state = "PROCESSING";
    await this.memory.save(session);

    const minSamples = Math.floor((PCM_SAMPLE_RATE * config.sttMinUtteranceMs) / 1000);
    if (pcm.length < minSamples || pcmSpeechRms(pcm) < config.sttMinSpeechRms) {
      session.state = "LISTENING";
      await this.memory.save(session);
      live?.emit("ai_stopped_processing");
      return;
    }

    let text = "";
    try {
      const f32 = int16ToFloat(pcm);
      text = await this.stt.transcribe(f32, PCM_SAMPLE_RATE);
    } catch (err) {
      this.log.warn(`stt ${err}`);
      await this.speak(sessionId, MSG.sttFail);
      return;
    }
    voiceLog("stt", { sessionId, studentId: session.studentId, sttMs: Date.now() - t0 });
    text = postprocessTranscript(text, session.scope.subject);
    const lastAssistant = [...(session.recentMessages || [])]
      .reverse()
      .find((t) => t.role === "assistant")?.content || "";
    if (!text || !isMeaningfulTranscript(text) || isLikelyEcho(text, lastAssistant)) {
      session.state = "LISTENING";
      await this.memory.save(session);
      live?.emit("ai_stopped_processing");
      return;
    }
    await this.runTurn(sessionId, text, t0);
  }

  /** Fixed-line TTS greet for Ask AI — does not call student_assistant. */
  async speakAssistantGreeting(sessionId: string): Promise<void> {
    const text = "Hi! Ask me anything about school or the platform.";
    const live = this.live.get(sessionId);
    const session = await this.memory.get(sessionId);
    if (!session) return;
    live?.emit("transcript", assistantTranscript(0, text));
    const greetTurn: ChatTurn = { role: "assistant", content: text };
    session.recentMessages = [...session.recentMessages, greetTurn].slice(-14);
    await this.memory.save(session);
    await this.speak(sessionId, text);
  }

  async runTurn(
    sessionId: string,
    utterance: string,
    t0 = Date.now(),
    opts: { filler?: boolean; synthetic?: boolean } = {},
  ): Promise<void> {
    const live = this.live.get(sessionId);
    const session = await this.memory.get(sessionId);
    if (!session) return;
    session.state = "THINKING";
    await this.memory.save(session);
    live?.emit("ai_started_processing");

    if (session.agentMode) {
      await this.runAssistantTurn(sessionId, utterance, t0, opts);
      return;
    }

    const history = session.recentMessages;
    const chapterName = session.scope.chapterNames[0] || session.scope.chapter || "";
    const followup = followupIntent(utterance);
    const replyIntent = classifyReplyIntent(utterance, session.tutor.awaitingAnswer);
    const dialogueAct = dialogueActForUtterance(utterance, session.tutor.awaitingAnswer);
    if (replyIntent === "CLOSING") session.tutor.awaitingAnswer = false;
    let action = decideAction({
      utterance,
      awaitingAnswer: session.tutor.awaitingAnswer,
      turnsSinceCheck: session.tutor.turnsSinceCheck,
    });
    let ragFollowup: NestFollowupIntent | string = followup;
    if (action === "SIMPLIFY" || replyIntent === "DONT_KNOW") ragFollowup = "simplify";

    // Owned by this turn: interruptSession swaps in a fresh controller, so the
    // captured signal is the only way to tell "my work was cancelled" apart
    // from "a later turn started".
    const signal = live?.abort.signal;
    // Armed here, never awaited: the answer pipeline below starts on this same
    // tick, so the filler costs the real reply nothing.
    let turnId = 0;
    if (live) {
      turnId = ++live.turnId;
      live.answerAudioStarted = false;
      live.turnStartedAt = t0;
      live.turnUtterance = opts.synthetic ? "" : utterance;
      if (!opts.synthetic) {
        live.emit("transcript", userTranscriptPending(turnId, utterance));
      }
      if (opts.filler !== false) {
        const plan = resolveFillerPlan({
          utterance,
          action,
          followup,
          quizPending: session.tutor.awaitingAnswer,
          currentConcept: session.tutor.currentConcept || session.currentTopic,
          chapter: chapterName,
        });
        if (!plan.skip) {
          this.armFiller(live, turnId, plan, session.accessToken);
        }
      }
    }

    const speech: SpeechStream = {
      dispatched: 0,
      begun: false,
      failed: false,
      queue: Promise.resolve(),
      signal,
      turnId,
      spokenText: "",
    };
    let reply = "";
    /** Spoken after the streamed answer; never re-speaks what already went out. */
    let tail = "";
    let grade: AnswerGrade | undefined;
    let ragMs = 0;
    let retrievedIds: string[] = [];
    let pages: number[] = [];
    /** Retrieval may rewrite; LLM/history always keep the raw student utterance. */
    let retrievalQuery = utterance;
    const recall = isRecallQuestion(utterance);

    try {
      // Questions about the conversation are answered from the transcript, not
      // the chapter. Must come before EVALUATE and the rewriter: "what did I
      // ask before?" is neither an answer to grade nor a retrieval query, and
      // the rewriter would turn it into one.
      //
      // This wins even while awaiting an answer — "what was the question
      // again?" must not be graded as a wrong answer. awaitingAnswer is left
      // set, so the tutor still expects the real answer next turn.
      if (recall) {
        action = "RECALL";
        reply = await this.recall.answer(utterance, history, session.summary);
      } else if (dialogueAct && action !== "EVALUATE") {
        // LLM-first: closing / ack / intro — skip rewriter + chapter RAG.
        // Not used while EVALUATE is active ("yes" must still be graded).
        action = "ANSWER";
        const rag = await this.streamRag({
          session,
          live,
          speech,
          signal,
          query: utterance,
          guardNotFound: false,
          followup: "none",
          dialogueAct,
        });
        ragMs = rag.ms;
        retrievedIds = rag.retrievedIds;
        pages = rag.pages;
        reply = rag.answer;
        if (rag.voiceMeta) this.applyVoiceMeta(session, rag.voiceMeta, live);
        if (!reply) reply = MSG.didntCatch;
      } else if (action === "EVALUATE") {
        grade = await this.evaluator.grade(
          session.tutor.expectedAnswer,
          utterance,
          session.tutor.currentConcept,
        );
        const follow = afterEvaluate(grade);
        action = follow;
        const prefix =
          grade === "CORRECT"
            ? MSG.correct
            : grade === "PARTIALLY_CORRECT"
              ? MSG.partial
              : grade === "INCORRECT"
                ? MSG.incorrect
                : MSG.uncertain;
        session.tutor.awaitingAnswer = false;
        if (grade === "CORRECT") session.tutor.consecutiveCorrect += 1;
        if (grade === "INCORRECT") session.tutor.consecutiveIncorrect += 1;
        const next = nextDifficulty({
          difficulty: session.tutor.difficulty,
          consecutiveCorrect: session.tutor.consecutiveCorrect,
          consecutiveIncorrect: session.tutor.consecutiveIncorrect,
          simplifyRequested: followup === "simplify",
        });
        session.tutor.difficulty = next.difficulty;
        session.tutor.consecutiveCorrect = next.consecutiveCorrect;
        session.tutor.consecutiveIncorrect = next.consecutiveIncorrect;
        await this.progress.recordGrade({
          studentId: session.studentId,
          classLevel: session.scope.classLevel,
          subject: session.scope.subject,
          chapter: session.scope.chapterNames[0] || "",
          topic: session.tutor.currentConcept,
          grade,
          difficulty: session.tutor.difficulty,
          sessionId,
        });
        live?.emit("answer_evaluated", { grade, action, difficulty: session.tutor.difficulty });
        retrievalQuery = await this.rewriter.rewrite(utterance, history, chapterName);
        // The verdict is known before retrieval runs, so say it now — the
        // student hears "Exactly!" while the explanation is still being fetched.
        this.streamSay(live, session, speech, prefix);
        const rag = await this.streamRag({
          session,
          live,
          speech,
          signal,
          // Canonical student message — never the retrieval rewrite.
          query: utterance,
          guardNotFound: false,
          followup: ragFollowup,
        });
        ragMs = rag.ms;
        retrievedIds = rag.retrievedIds;
        pages = rag.pages;
        reply = `${prefix} ${rag.answer}`.trim();
        if (rag.voiceMeta) this.applyVoiceMeta(session, rag.voiceMeta, live);
        if (grade === "CORRECT" && next.difficulty > session.tutor.difficulty - 1) {
          tail = "Now let's try something slightly harder.";
          reply += ` ${tail}`;
        }
      } else if (action === "OUT_OF_SCOPE") {
        reply = MSG.outOfScope(session.scope.classLevel, session.scope.subject);
      } else {
        // New question / refusal while a check was open — drop the quiz latch.
        if (session.tutor.awaitingAnswer) session.tutor.awaitingAnswer = false;
        retrievalQuery = await this.rewriter.rewrite(utterance, history, chapterName);
        const rag = await this.streamRag({
          session,
          live,
          speech,
          signal,
          query: utterance,
          guardNotFound: true,
          followup: ragFollowup,
        });
        ragMs = rag.ms;
        retrievedIds = rag.retrievedIds;
        pages = rag.pages;
        reply = rag.answer;
        if (rag.voiceMeta) this.applyVoiceMeta(session, rag.voiceMeta, live);
        if (!reply) reply = MSG.notInTextbook;
        // Only swap in the canned refusal while nothing has been spoken yet.
        // Once sentences are on the wire, rewriting `reply` would leave the
        // transcript and the stored history saying something the student
        // never heard — and history is what the next turn retrieves against.
        if (speech.dispatched === 0 && NOT_IN_CHAPTER.test(reply)) {
          action = "OUT_OF_SCOPE";
          reply = MSG.notInTextbook;
        }
        session.tutor.currentConcept =
          topicFromQuestion(retrievalQuery) || session.tutor.currentConcept;
        session.currentTopic = session.tutor.currentConcept;
        if (followup === "simplify") action = "SIMPLIFY";
        if (followup === "example") action = "PROVIDE_EXAMPLE";
        if (followup === "quiz") action = "START_QUIZ";
        if (replyIntent === "DONT_KNOW") action = "SIMPLIFY";
      }

      session.tutor.turnsSinceCheck += 1;
      const skipScriptedQuiz =
        replyIntent === "CLOSING" ||
        replyIntent === "DONT_KNOW" ||
        !!dialogueAct ||
        action === "SIMPLIFY" ||
        isBareAcknowledgement(utterance);
      const scriptedQuiz =
        !skipScriptedQuiz &&
        !config.naturalCheckins &&
        (action === "START_QUIZ" || afterExplainShouldCheck(session.tutor, reply, action));
      if (scriptedQuiz) {
        const q = await this.questions.fromTextbook(
          session.tutor.currentConcept || session.scope.subject,
          reply,
          session.tutor.difficulty,
        );
        const check = `Can I ask you a quick question to check your understanding? ${q.question}`;
        tail = tail ? `${tail} ${check}` : check;
        reply = `${reply.replace(/\?+$/, "")} ${check}`;
        session.tutor.awaitingAnswer = true;
        session.tutor.expectedAnswer = q.expected;
        session.tutor.turnsSinceCheck = 0;
        action = "ASK_QUESTION";
        live?.emit("question_generated", { question: q.question });
      }

      session.tutor.action = action;

      // Discarded/barged-in turns must not pollute conversation history.
      if (!turnStillActive(signal, turnId, live?.turnId)) {
        voiceLog("turn_discarded", {
          sessionId,
          tutorAction: action,
          isRecall: recall,
        });
        await this.discardTurn(live, session, speech, turnId, opts);
        return;
      }

      if (!opts.synthetic && live) {
        live.emit("transcript", userTranscriptCommitted(turnId, utterance));
      }

      const turns: ChatTurn[] = opts.synthetic
        ? // Internal greet prompt is not a student utterance.
          [...history, { role: "assistant", content: reply }]
        : [...history, { role: "user", content: utterance }, { role: "assistant", content: reply }];
      session.summary = await this.summary.maybeFold(turns, session.summary);
      session.recentMessages = turns;
      if (!opts.synthetic) {
        await this.progress.recordMessage(session.conversationId, "user", utterance);
      }
      await this.progress.recordMessage(session.conversationId, "assistant", reply);
      await this.memory.save(session);

      voiceLog("turn", {
        sessionId,
        conversationId: session.conversationId,
        studentId: session.studentId,
        classLevel: session.scope.classLevel,
        subject: session.scope.subject,
        ragMs,
        totalMs: Date.now() - t0,
        retrievedIds,
        retrievedPages: pages,
        tutorAction: action,
        evaluation: grade,
        ttfaMs: live?.answerAudioStarted ? live.ttfaMs : undefined,
        streamed: speech.dispatched > 0,
        fillerCohort: live?.fillerCohort,
        isRecall: recall,
        retrievalRewrote: retrievalQuery.trim() !== utterance.trim(),
        synthetic: Boolean(opts.synthetic),
      });

      if (speech.dispatched > 0) {
        speech.transcriptAction = action;
        speech.transcriptFinal = true;
        // Publish the full reply as soon as we have it so a late TTS failure
        // cannot leave the UI stuck on a partial spoken prefix.
        live?.emit("transcript", assistantTranscript(turnId, reply, action));
        if (tail) this.streamSay(live, session, speech, tail);
        await this.finishSpeech(live, session, speech);
      } else {
        await this.speak(sessionId, reply, { turnId, signal, action });
      }
    } catch (err) {
      this.log.warn(`turn ${err}`);
      if (signal?.aborted) {
        await this.discardTurn(live, session, speech, turnId, opts);
        return;
      }
      session.state = "ERROR";
      await this.memory.save(session);
      live?.emit("voice_error", { message: MSG.llmFail });
      await this.speak(sessionId, MSG.llmFail);
    } finally {
      // A turn that ends without ever emitting audio (TTS threw) would
      // otherwise leave the timer armed to speak over the next one.
      if (live) this.clearFiller(live);
    }
  }

  /**
   * Ask AI Tutor voice: STT/TTS transport only.
   * Same FastAPI student_assistant stream as the text modal — no chapter orchestrator.
   */
  private async runAssistantTurn(
    sessionId: string,
    utterance: string,
    t0: number,
    opts: { filler?: boolean; synthetic?: boolean },
  ): Promise<void> {
    const live = this.live.get(sessionId);
    const session = await this.memory.get(sessionId);
    if (!session || !session.agentMode) return;

    const history = session.recentMessages;
    const signal = live?.abort.signal;
    let turnId = 0;
    if (live) {
      turnId = ++live.turnId;
      live.answerAudioStarted = false;
      live.turnStartedAt = t0;
      live.turnUtterance = opts.synthetic ? "" : utterance;
      if (!opts.synthetic) {
        live.emit("transcript", userTranscriptPending(turnId, utterance));
      }
      if (opts.filler !== false) {
        const plan = resolveFillerPlan({
          utterance,
          action: "ANSWER",
          followup: "none",
          quizPending: false,
          currentConcept: session.currentTopic,
          chapter: session.scope.chapterNames[0] || session.scope.chapter || "",
        });
        if (!plan.skip) {
          this.armFiller(live, turnId, plan, session.accessToken);
        }
      }
    }

    const speech: SpeechStream = {
      dispatched: 0,
      begun: false,
      failed: false,
      queue: Promise.resolve(),
      signal,
      turnId,
      spokenText: "",
    };

    try {
      const rag = await this.streamAssistant({
        session,
        live,
        speech,
        signal,
        query: utterance,
      });
      let reply = rag.answer;
      if (!reply) reply = MSG.didntCatch;

      if (!turnStillActive(signal, turnId, live?.turnId)) {
        await this.discardTurn(live, session, speech, turnId, opts);
        return;
      }

      if (!opts.synthetic && live) {
        live.emit("transcript", userTranscriptCommitted(turnId, utterance));
      }

      const turns: ChatTurn[] = opts.synthetic
        ? [...history, { role: "assistant", content: reply }]
        : [...history, { role: "user", content: utterance }, { role: "assistant", content: reply }];
      session.recentMessages = turns;
      if (!opts.synthetic) {
        await this.progress.recordMessage(session.conversationId, "user", utterance);
      }
      await this.progress.recordMessage(session.conversationId, "assistant", reply);
      await this.memory.save(session);

      voiceLog("turn", {
        sessionId,
        conversationId: session.conversationId,
        studentId: session.studentId,
        subject: session.agentMode || "assistant",
        ragMs: rag.ms,
        totalMs: Date.now() - t0,
        streamed: speech.dispatched > 0,
        synthetic: Boolean(opts.synthetic),
      });

      if (speech.dispatched > 0) {
        speech.transcriptAction = "ANSWER";
        speech.transcriptFinal = true;
        live?.emit("transcript", assistantTranscript(turnId, reply, "ANSWER"));
        await this.finishSpeech(live, session, speech);
      } else {
        await this.speak(sessionId, reply, { turnId, signal, action: "ANSWER" });
      }
    } catch (err) {
      this.log.warn(`assistant turn ${err}`);
      if (signal?.aborted) {
        await this.discardTurn(live, session, speech, turnId, opts);
        return;
      }
      session.state = "ERROR";
      await this.memory.save(session);
      live?.emit("voice_error", { message: MSG.llmFail });
      await this.speak(sessionId, MSG.llmFail);
    } finally {
      if (live) this.clearFiller(live);
    }
  }

  private async discardTurn(
    live: Live | undefined,
    session: VoiceSession,
    speech: SpeechStream,
    turnId: number,
    opts: { synthetic?: boolean } = {},
  ): Promise<void> {
    if (live && turnId > 0 && !opts.synthetic) {
      live.emit("turn_cancelled", turnCancelledPayload(turnId));
    }
    await this.releaseTurnAudio(live, session, speech);
  }

  /** Drop partial TTS and put the client back in listen mode after a cancelled turn. */
  private async releaseTurnAudio(
    live: Live | undefined,
    session: VoiceSession,
    speech?: SpeechStream,
  ): Promise<void> {
    if (!live) return;
    if (speech) {
      await speech.queue.catch(() => undefined);
      if (speech.begun || live.speaking) {
        live.speaking = false;
        await this.endSpeech(live, session);
        return;
      }
    }
    if (live.speaking) {
      live.speaking = false;
      await this.endSpeech(live, session);
      return;
    }
    if (session.state !== "LISTENING" && session.state !== "ENDED") {
      session.state = "LISTENING";
      await this.memory.save(session);
      live.emit("ai_stopped_speaking");
    }
  }

  private fillerAudible(live: Live): boolean {
    return live.fillerEndsAt > Date.now();
  }

  private clearFiller(live: Live): void {
    if (live.fillerTimer) clearTimeout(live.fillerTimer);
    live.fillerTimer = null;
    live.fillerPending = null;
    live.fillerPlan = null;
    live.fillerEndsAt = 0;
  }

  private armFiller(live: Live, turnId: number, plan: FillerPlan, accessToken: string): void {
    if (!config.thinkingFiller) return;
    this.clearFiller(live);
    if (!live.fillerCohort) return;
    if (!this.filler.shouldArm(live.ttfa)) {
      voiceLog("filler_skipped", { sessionId: live.sessionId, fillerReason: "session_fast" });
      return;
    }
    live.fillerPlan = plan;
    // Start LLM+TTS now so the clip is ready when the delay fires.
    live.fillerPending = this.filler.prepare(live.sessionId, plan, accessToken);
    live.fillerTimer = setTimeout(() => {
      live.fillerTimer = null;
      void this.playFiller(live, turnId);
    }, config.fillerDelayMs);
  }

  /**
   * Best-effort only. Every exit logs why and returns; a filler that cannot
   * play must never disturb the turn that is still producing the real answer.
   */
  private async playFiller(live: Live, turnId: number): Promise<void> {
    const sessionId = live.sessionId;
    const plan = live.fillerPlan;
    try {
      if (live.turnId !== turnId || live.abort.signal.aborted) return;
      if (live.answerAudioStarted) {
        voiceLog("filler_skipped", { sessionId, fillerReason: "fast_response" });
        return;
      }
      if (!live.emitPcm || !plan) return;

      const prepared = await (live.fillerPending ?? Promise.resolve(null));
      if (live.turnId !== turnId || live.answerAudioStarted || live.abort.signal.aborted) {
        voiceLog("filler_skipped", { sessionId, fillerReason: "fast_response" });
        return;
      }

      let clip = prepared?.clip ?? null;
      let intent: FillerIntent = prepared?.intent ?? plan.intent;
      if (!clip) {
        const fallback = this.filler.take(sessionId, plan.intent, plan.utterance);
        if (!fallback) {
          voiceLog("filler_skipped", { sessionId, fillerReason: "no_clip" });
          return;
        }
        clip = fallback;
      } else {
        this.filler.markUsed(sessionId, intent, prepared?.index ?? -1);
      }

      if (live.turnId !== turnId || live.answerAudioStarted) return;

      live.fillerEndsAt = Date.now() + clip.durationMs;
      live.lastFillerPhrase = clip.phrase;
      // Reusing ai_started_speaking keeps the client unchanged: it mutes the
      // mic uplink (no echo into STT) and arms barge-in. No transcript event,
      // so the filler never appears as an assistant message.
      live.emit("ai_started_speaking");
      live.emitPcm(clip.frame);
      voiceLog("filler_played", {
        sessionId,
        fillerPhrase: clip.phrase,
        fillerMs: clip.durationMs,
        fillerIntent: intent,
      });

      // Once it drains, put the UI back to "Thinking…" if the answer is still
      // in flight, rather than leaving it looking like the tutor is speaking.
      live.fillerTimer = setTimeout(() => {
        live.fillerTimer = null;
        live.fillerEndsAt = 0;
        if (live.turnId !== turnId || live.answerAudioStarted) return;
        if (live.abort.signal.aborted) return;
        live.emit("ai_started_processing");
      }, clip.durationMs);
    } catch (err) {
      this.log.warn(`filler ${err}`);
      live.fillerEndsAt = 0;
    }
  }

  private async awaitFillerHandoff(live: Live): Promise<void> {
    const remaining = live.fillerEndsAt - Date.now();
    if (remaining <= 0) return;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(remaining, config.fillerMaxHandoffMs)),
    );
  }

  private streaming(live?: Live): live is Live {
    return config.streamTts && !!live?.emitPcm;
  }

  /**
   * Retrieval that speaks each sentence as the model writes it.
   *
   * Falls back to the buffered path whenever streaming is off or there is no
   * audio transport, so the returned shape is identical either way.
   */
  private async streamAssistant(opts: {
    session: VoiceSession;
    live?: Live;
    speech: SpeechStream;
    signal?: AbortSignal;
    query: string;
  }): Promise<RagResult> {
    const { session, live, speech, signal, query } = opts;
    const history: ChatTurn[] = session.recentMessages;
    const ask = {
      token: session.accessToken,
      query,
      agentMode: session.agentMode || "free",
      history,
      signal,
    };

    if (!this.streaming(live)) {
      return this.safeAssistant(ask, live);
    }

    const committed = speech.dispatched > 0;
    let spoken = 0;
    try {
      const result = await this.rag.askAssistantStream(ask, {
        onSentence: (sentence) => {
          spoken += 1;
          this.streamSay(live, session, speech, sentence);
        },
      });
      if (committed && spoken === 0 && result.answer) {
        this.streamSay(live, session, speech, result.answer);
      }
      return result;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof RagAuthError) {
        this.log.warn("assistant stream auth expired");
        this.emitAuthExpired(live);
        if (committed) this.streamSay(live, session, speech, MSG.authExpired);
        return { answer: MSG.authExpired, retrievedIds: [], pages: [], images: [], ms: 0 };
      }
      this.log.warn(`assistant stream ${err}`);
      if (committed) this.streamSay(live, session, speech, MSG.ragFail);
      return { answer: MSG.ragFail, retrievedIds: [], pages: [], images: [], ms: 0 };
    }
  }

  private async safeAssistant(
    ask: Parameters<RagClient["askAssistantStream"]>[0],
    live?: Live,
  ): Promise<RagResult> {
    try {
      return await this.rag.askAssistantStream(ask, {});
    } catch (err) {
      if (ask.signal?.aborted) throw err;
      if (err instanceof RagAuthError) {
        this.log.warn("assistant auth expired");
        this.emitAuthExpired(live);
        return { answer: MSG.authExpired, retrievedIds: [], pages: [], images: [], ms: 0 };
      }
      this.log.warn(`assistant ${err}`);
      return { answer: MSG.ragFail, retrievedIds: [], pages: [], images: [], ms: 0 };
    }
  }

  private async streamRag(opts: {
    session: VoiceSession;
    live?: Live;
    speech: SpeechStream;
    signal?: AbortSignal;
    query: string;
    followup?: string;
    dialogueAct?: DialogueAct;
    /**
     * True on the plain-question path, where an answer of "I couldn't find
     * this in your chapter" gets swapped for MSG.notInTextbook afterwards.
     * Holding the first sentence until it has been tested keeps us from
     * speaking text the caller is about to discard.
     */
    guardNotFound: boolean;
  }): Promise<RagResult> {
    const { session, live, speech, signal, query, followup = "none", dialogueAct } = opts;
    const history: ChatTurn[] = session.summary
      ? [{ role: "assistant", content: session.summary }, ...session.recentMessages]
      : session.recentMessages;
    const ask = {
      token: session.accessToken,
      query,
      scope: session.scope,
      history,
      signal,
      tutorState: session.tutorState,
      explainedPoints: session.explainedPoints,
      quizPending: session.tutor.awaitingAnswer,
      quizQuestion: session.lastQuizQuestion,
      quizAttempts: session.quizAttempts,
      nestIntent: dialogueAct ? undefined : this.ragNestIntent(session, followup),
      dialogueAct,
      fillerPhrasePlayed: live?.lastFillerPhrase || session.lastFillerPhrase,
      affectTrajectory: session.affectTrajectory,
    };

    if (!this.streaming(live)) {
      const result = await this.safeRag(ask, live);
      if (result.images.length) opts.live?.emit("related_images", { images: result.images });
      return result;
    }

    // Once anything has been dispatched the turn is committed to streaming:
    // the caller will only speak the tail, so every fallback below has to put
    // its own text on the wire or the student hears a truncated answer.
    const committed = speech.dispatched > 0;
    let spoken = 0;
    let heldBack = false;
    try {
      const result = await this.rag.askStream(ask, {
        onSentence: (sentence) => {
          if (heldBack) return;
          if (spoken === 0 && opts.guardNotFound && NOT_IN_CHAPTER.test(sentence)) {
            heldBack = true;
            return;
          }
          spoken += 1;
          this.streamSay(live, session, speech, sentence);
        },
        onReplace: () => {
          // FastAPI rewrote the answer it had already streamed. Nothing spoken
          // yet means we can still fall back cleanly; otherwise the audio is
          // out and only the transcript can be corrected.
          if (spoken > 0) this.log.warn("rag replaced the answer after audio started");
          else heldBack = true;
        },
        onRelatedImages: (images) => {
          if (!live || !images.length) return;
          if (!turnStillActive(signal, speech.turnId, live.turnId)) return;
          live.emit("related_images", { images });
        },
      });
      if (committed && spoken === 0 && !opts.guardNotFound && result.answer) {
        this.streamSay(live, session, speech, result.answer);
      }
      return result;
    } catch (err) {
      if (signal?.aborted) throw err;
      if (err instanceof RagAuthError) {
        this.log.warn("rag stream auth expired");
        this.emitAuthExpired(live);
        if (committed) this.streamSay(live, session, speech, MSG.authExpired);
        return { answer: MSG.authExpired, retrievedIds: [], pages: [], images: [], ms: 0 };
      }
      this.log.warn(`rag stream ${err}`);
      if (committed) this.streamSay(live, session, speech, MSG.ragFail);
      return { answer: MSG.ragFail, retrievedIds: [], pages: [], images: [], ms: 0 };
    }
  }

  private emitAuthExpired(live: Live | undefined): void {
    live?.emit("token_expired", { message: MSG.authExpired });
  }

  private async safeRag(ask: Parameters<RagClient["ask"]>[0], live?: Live): Promise<RagResult> {
    try {
      return await this.rag.ask(ask);
    } catch (err) {
      if (ask.signal?.aborted) throw err;
      if (err instanceof RagAuthError) {
        this.log.warn("rag auth expired");
        this.emitAuthExpired(live);
        return { answer: MSG.authExpired, retrievedIds: [], pages: [], images: [], ms: 0 };
      }
      this.log.warn(`rag ${err}`);
      return { answer: MSG.ragFail, retrievedIds: [], pages: [], images: [], ms: 0 };
    }
  }

  /** Queue one chunk behind whatever is already synthesizing. Never throws. */
  private streamSay(
    live: Live | undefined,
    session: VoiceSession,
    speech: SpeechStream,
    chunk: string,
  ): void {
    if (!this.streaming(live) || !chunk.trim()) return;
    speech.dispatched += 1;
    speech.queue = speech.queue
      .then(async () => {
        if (speech.failed || !turnStillActive(speech.signal, speech.turnId, live?.turnId)) return;
        if (!speech.begun) {
          speech.begun = true;
          await this.beginSpeech(live, session, speech.turnId);
        }
        await this.speakChunk(live, session, chunk, speech.signal, speech.turnId, speech);
      })
      .catch((err) => {
        speech.failed = true;
        this.log.warn(`tts stream ${err}`);
        live.emit("voice_error", { message: MSG.ttsFail });
      });
  }

  private async finishSpeech(
    live: Live | undefined,
    session: VoiceSession,
    speech: SpeechStream,
  ): Promise<void> {
    await speech.queue;
    if (!live || !speech.begun) return;
    voiceLog("tts", { sessionId: live.sessionId, ttsMs: Date.now() - live.turnStartedAt });
    await this.endSpeech(live, session);
  }

  private async beginSpeech(live: Live, session: VoiceSession, turnId: number): Promise<void> {
    if (!turnStillActive(live.abort.signal, turnId, live.turnId)) return;
    if (live.speaking) {
      live.abort.abort();
      live.abort = new AbortController();
      live.speaking = false;
    }
    // Let a filler finish its last word before the client's ai_started_speaking
    // handler clears the playback queue. Normally a no-op: the filler drains
    // seconds before the answer's first chunk is synthesized.
    await this.awaitFillerHandoff(live);
    session.state = "SPEAKING";
    live.speaking = true;
    await this.memory.save(session);
    // Lock in the student line the moment we start speaking — otherwise the
    // client would reject assistant text while user.pending is still true.
    if (turnId > 0 && live.turnUtterance) {
      live.emit("transcript", userTranscriptCommitted(turnId, live.turnUtterance));
    }
    live.emit("ai_started_speaking");
  }

  /** Returns false when the turn was cut short and the rest should be dropped. */
  private async speakChunk(
    live: Live,
    session: VoiceSession,
    chunk: string,
    signal?: AbortSignal,
    turnId = 0,
    speech?: SpeechStream,
  ): Promise<boolean> {
    const cancelled = (): boolean =>
      !turnStillActive(signal, turnId, live.turnId) || live.abort.signal.aborted;
    if (cancelled()) return false;
    const say = speakable(chunk);
    if (!say) return true;
    let pcm: Float32Array;
    let sampleRate: number;
    try {
      ({ pcm, sampleRate } = await this.tts.synthesize(say, session.accessToken));
    } catch (err) {
      if (/http 401|http 403/.test(String(err))) {
        this.emitAuthExpired(live);
      }
      throw err;
    }
    // Synthesis is a network round trip with Edge TTS — the student may well
    // have barged in while it was out.
    if (cancelled()) return false;
    const at16 = resample(pcm, sampleRate, PCM_SAMPLE_RATE);
    const packed = packPcm(floatToInt16(at16), PCM_SAMPLE_RATE, false);
    // "Answer ready" is the first frame on the wire, not the reply string:
    // with Edge TTS every chunk is another network round trip, so the student
    // is still waiting long after RAG returned.
    if (!live.answerAudioStarted) {
      live.answerAudioStarted = true;
      live.ttfaMs = Date.now() - live.turnStartedAt;
      live.ttfa.push(live.ttfaMs);
      if (live.ttfa.length > TTFA_SAMPLES) live.ttfa.shift();
      this.clearFiller(live);
    }
    // ponytail: WS binary is the single audio transport — the client wires
    // playPcm to BOTH the WS and the RTC datachannel, so sending on both
    // played every sentence twice. Mic uplink already rides the WS and no
    // TURN server is configured, so WS is the one that works behind NAT.
    // Move to the datachannel only if you also drop the WS binary path.
    live.emitPcm?.(packed);
    // Mirror spoken text with the audio so the transcript keeps pace.
    if (turnId > 0 && speech && !speech.transcriptFinal) {
      speech.spokenText = speech.spokenText ? `${speech.spokenText} ${say}` : say;
      live.emit(
        "transcript",
        assistantTranscript(turnId, speech.spokenText, speech.transcriptAction),
      );
    }
    return true;
  }

  private async endSpeech(live: Live, session: VoiceSession): Promise<void> {
    live.emitPcm?.(packPcm(new Int16Array(0), PCM_SAMPLE_RATE, true));
    live.speaking = false;
    live.lastSpokeAt = Date.now();
    live.chunks = [];
    live.vad.reset();
    if (!live.abort.signal.aborted) {
      session.state = "LISTENING";
      await this.memory.save(session);
      live.emit("ai_stopped_speaking");
    }
  }

  /** Buffered path: the whole reply is already known. */
  private async speak(
    sessionId: string,
    text: string,
    opts: { turnId?: number; signal?: AbortSignal; action?: string } = {},
  ): Promise<void> {
    const live = this.live.get(sessionId);
    const session = await this.memory.get(sessionId);
    if (!live || !session) return;
    const turnId = opts.turnId ?? 0;
    if (!turnStillActive(opts.signal, turnId, live.turnId)) return;
    const speech: SpeechStream = {
      dispatched: 0,
      begun: false,
      failed: false,
      queue: Promise.resolve(),
      signal: opts.signal,
      turnId,
      spokenText: "",
      transcriptAction: opts.action,
    };
    await this.beginSpeech(live, session, turnId);
    speech.begun = true;
    // Full reply is already known on the buffered path — show it with first audio.
    if (turnId > 0 && text.trim()) {
      speech.transcriptFinal = true;
      live.emit("transcript", assistantTranscript(turnId, text, opts.action));
    }
    const t0 = Date.now();
    try {
      for (const chunk of splitSentences(text)) {
        if (!(await this.speakChunk(live, session, chunk, opts.signal, turnId, speech))) break;
      }
      voiceLog("tts", { sessionId, ttsMs: Date.now() - t0 });
    } catch (err) {
      this.log.warn(`tts ${err}`);
      live.emit("voice_error", { message: MSG.ttsFail });
    }
    await this.endSpeech(live, session);
  }

  private ragNestIntent(
    session: VoiceSession,
    followup: string,
  ): import("../tutor/interfaces").NestFollowupIntent | undefined {
    if (!config.naturalCheckins) {
      return followup !== "none" ? (followup as import("../tutor/interfaces").NestFollowupIntent) : undefined;
    }
    if (followup !== "none") return followup as import("../tutor/interfaces").NestFollowupIntent;
    if (session.tutor.turnsSinceCheck >= 2) return "quiz";
    return undefined;
  }

  private applyVoiceMeta(
    session: VoiceSession,
    meta: import("../tutor/interfaces").RagVoiceMeta,
    live?: Live,
  ): void {
    if (meta.tutor_state) {
      session.tutorState = meta.tutor_state as import("../tutor/interfaces").FastApiTutorState;
    }
    if (meta.explained_points?.length) {
      session.explainedPoints = meta.explained_points;
    }
    if (meta.affect_trajectory?.length) {
      session.affectTrajectory = meta.affect_trajectory;
    }
    if (meta.affect_hint && live) {
      live.emit("affect_hint", { hint: meta.affect_hint, primary: meta.affect_primary });
    }
  }
}

function concat(parts: Int16Array[]): Int16Array {
  const n = parts.reduce((a, b) => a + b.length, 0);
  const out = new Int16Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  const out: string[] = [];
  let buf = "";
  for (const p of parts) {
    buf = buf ? `${buf} ${p}` : p;
    if (buf.length >= 80) {
      out.push(buf);
      buf = "";
    }
  }
  if (buf) out.push(buf);
  return out.length ? out : [text];
}
