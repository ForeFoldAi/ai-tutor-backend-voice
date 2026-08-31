import { Logger } from "@nestjs/common";

const log = new Logger("voice");

export type VoiceLog = {
  conversationId?: string;
  studentId?: string;
  sessionId?: string;
  classLevel?: string;
  subject?: string;
  sttMs?: number;
  ragMs?: number;
  llmMs?: number;
  ttsMs?: number;
  totalMs?: number;
  retrievedIds?: string[];
  retrievedPages?: number[];
  tutorAction?: string;
  questionType?: string;
  evaluation?: string;
  fillerPhrase?: string;
  fillerMs?: number;
  fillerReason?: string;
  fillerCached?: number;
  fillerIntent?: string;
  /** A/B arm: false means this student never hears fillers. */
  fillerCohort?: boolean;
  /** Time from turn start to the first answer frame — the perceived latency. */
  ttfaMs?: number;
  /** Whether the answer was spoken sentence-by-sentence as it was generated. */
  streamed?: boolean;
  isRecall?: boolean;
  retrievalRewrote?: boolean;
  synthetic?: boolean;
  error?: string;
};

export function voiceLog(event: string, fields: VoiceLog): void {
  log.log({ event, ...fields });
}
