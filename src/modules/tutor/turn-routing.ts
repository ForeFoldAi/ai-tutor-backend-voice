import { isRecallQuestion } from "./query-rewriter";

export type TurnPipeline = "recall" | "evaluate" | "rag" | "out_of_scope";

/** Mirrors the first branches in VoiceService.runTurn — recall always wins. */
export function resolveTurnPipeline(utterance: string, action: string): TurnPipeline {
  if (isRecallQuestion(utterance)) return "recall";
  if (action === "EVALUATE") return "evaluate";
  if (action === "OUT_OF_SCOPE") return "out_of_scope";
  return "rag";
}
