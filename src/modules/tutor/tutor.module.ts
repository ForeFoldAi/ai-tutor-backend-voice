import { Module } from "@nestjs/common";
import { LlmModule } from "../llm/llm.module";
import { AnswerEvaluatorService } from "./answer-evaluator.service";
import { DifficultyManagerService } from "./difficulty-manager.service";
import { QuestionGeneratorService } from "./question-generator.service";
import { QueryRewriterService } from "./query-rewriter.service";
import { RecallService } from "./recall.service";
import { TutorOrchestratorService } from "./tutor-orchestrator.service";
import { TutorService } from "./tutor.service";
import { TutorStateService } from "./tutor-state.service";

@Module({
  imports: [LlmModule],
  providers: [
    TutorService,
    TutorOrchestratorService,
    TutorStateService,
    QuestionGeneratorService,
    AnswerEvaluatorService,
    DifficultyManagerService,
    QueryRewriterService,
    RecallService,
  ],
  exports: [
    TutorService,
    TutorOrchestratorService,
    TutorStateService,
    QuestionGeneratorService,
    AnswerEvaluatorService,
    DifficultyManagerService,
    QueryRewriterService,
    RecallService,
  ],
})
export class TutorModule {}
