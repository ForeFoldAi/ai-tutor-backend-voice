export type TutorAction =
  | "ANSWER"
  | "EXPLAIN"
  | "ASK_QUESTION"
  | "GIVE_HINT"
  | "EVALUATE"
  | "SIMPLIFY"
  | "PROVIDE_EXAMPLE"
  | "START_QUIZ"
  | "CONTINUE_LESSON"
  | "OUT_OF_SCOPE"
  | "RECALL"
  | "REQUEST_CLARIFICATION";

export type AnswerGrade = "CORRECT" | "PARTIALLY_CORRECT" | "INCORRECT" | "UNCERTAIN";

export type VoiceState =
  | "IDLE"
  | "LISTENING"
  | "PROCESSING"
  | "THINKING"
  | "SPEAKING"
  | "INTERRUPTED"
  | "ERROR"
  | "ENDED";

export type ChatTurn = { role: "user" | "assistant"; content: string };

export type SessionScope = {
  board: string;
  classLevel: string;
  subject: string;
  chapterIds: string[];
  chapterNames: string[];
  chapter?: string;
};

export type TutorSnapshot = {
  action: TutorAction;
  awaitingAnswer: boolean;
  expectedAnswer: string;
  currentConcept: string;
  difficulty: number;
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  turnsSinceCheck: number;
};
