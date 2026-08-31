import { Module } from "@nestjs/common";
import { LlmModule } from "../llm/llm.module";
import { ConversationMemoryService } from "./conversation-memory.service";
import { ConversationService } from "./conversation.service";
import { ConversationSummaryService } from "./conversation-summary.service";
import { SessionOwnershipService } from "./session-ownership.service";

@Module({
  imports: [LlmModule],
  providers: [
    ConversationMemoryService,
    ConversationService,
    ConversationSummaryService,
    SessionOwnershipService,
  ],
  exports: [
    ConversationMemoryService,
    ConversationService,
    ConversationSummaryService,
    SessionOwnershipService,
  ],
})
export class ConversationModule {}
