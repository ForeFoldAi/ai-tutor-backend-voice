import { Injectable } from "@nestjs/common";

export function nextDifficulty(opts: {
  difficulty: number;
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  simplifyRequested: boolean;
}): { difficulty: number; consecutiveCorrect: number; consecutiveIncorrect: number } {
  let { difficulty, consecutiveCorrect, consecutiveIncorrect } = opts;
  if (opts.simplifyRequested) {
    return {
      difficulty: Math.max(1, difficulty - 1),
      consecutiveCorrect: 0,
      consecutiveIncorrect: 0,
    };
  }
  if (consecutiveCorrect >= 2) {
    difficulty = Math.min(5, difficulty + 1);
    consecutiveCorrect = 0;
  }
  if (consecutiveIncorrect >= 2) {
    difficulty = Math.max(1, difficulty - 1);
    consecutiveIncorrect = 0;
  }
  return { difficulty, consecutiveCorrect, consecutiveIncorrect };
}

@Injectable()
export class DifficultyManagerService {
  apply = nextDifficulty;
}
