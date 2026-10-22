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

export type QuizItem = {
  question: string;
  /** "" when unknown (tutor's own check-in on a non-math topic) — the grader judges from the question. */
  expected: string;
  figure?: RagRelatedImage;
  attempts: number;
  grade?: AnswerGrade;
  done: boolean;
  /** Answer was given away after two misses (or on closing) — not counted as correct. */
  revealed?: boolean;
};

export type TutorSnapshot = {
  action: TutorAction;
  /** True while any quiz item is still open. */
  awaitingAnswer: boolean;
  quiz: QuizItem[];
  currentConcept: string;
  difficulty: number;
  consecutiveCorrect: number;
  consecutiveIncorrect: number;
  turnsSinceCheck: number;
};

/** FastAPI TutorState enum values */
export type FastApiTutorState =
  | "LISTENING"
  | "TEACHING"
  | "CHECKING_UNDERSTANDING"
  | "QUIZING"
  | "CLARIFYING";

export type NestFollowupIntent = "simplify" | "example" | "quiz" | "repeat" | "none";

export type RagVoiceMeta = {
  tutor_state?: string;
  explained_points?: string[];
  affect_summary?: string;
  affect_hint?: string;
  affect_primary?: string;
  affect_trajectory?: string[];
  /** SymPy answer to the check question the reply ended on (math only). */
  quiz_expected?: string;
};

/** Textbook figure payload from FastAPI related_images events. */
export type RagRelatedImage = {
  url: string;
  caption?: string | null;
  page?: number | null;
  textbook_upload_id?: string;
  relevance?: number;
  subtopic?: string | null;
  title?: string | null;
  figure_number?: string | null;
  file_name?: string | null;
  content_kind?: string | null;
};
