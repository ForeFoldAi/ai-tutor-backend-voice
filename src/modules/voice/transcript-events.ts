/** WS transcript payloads — shared shape for tests and VoiceService emits. */
export type TranscriptEmit = {
  role: "user" | "assistant";
  text: string;
  turnId: number;
  pending?: boolean;
  action?: string;
};

export function userTranscriptPending(turnId: number, text: string): TranscriptEmit {
  return { role: "user", text, turnId, pending: true };
}

export function userTranscriptCommitted(turnId: number, text: string): TranscriptEmit {
  return { role: "user", text, turnId, pending: false };
}

export function assistantTranscript(
  turnId: number,
  text: string,
  action?: string,
): TranscriptEmit {
  return { role: "assistant", text, turnId, ...(action ? { action } : {}) };
}

export function turnCancelledPayload(turnId: number): { type: "turn_cancelled"; turnId: number } {
  return { type: "turn_cancelled", turnId };
}
