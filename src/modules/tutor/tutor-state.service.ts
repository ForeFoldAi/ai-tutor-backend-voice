import { Injectable } from "@nestjs/common";
import { TutorSnapshot } from "./interfaces";

export function defaultSnapshot(): TutorSnapshot {
  return {
    action: "ANSWER",
    awaitingAnswer: false,
    expectedAnswer: "",
    currentConcept: "",
    difficulty: 3,
    consecutiveCorrect: 0,
    consecutiveIncorrect: 0,
    turnsSinceCheck: 0,
  };
}

@Injectable()
export class TutorStateService {
  fresh = defaultSnapshot;
}
