import { Module } from "@nestjs/common";
import { LlmClient } from "./llm.client";

@Module({
  providers: [LlmClient],
  exports: [LlmClient],
})
export class LlmModule {}
