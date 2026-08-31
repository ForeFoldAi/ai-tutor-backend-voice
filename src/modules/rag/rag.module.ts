import { Module } from "@nestjs/common";
import { RagClient } from "./rag.client";

@Module({
  providers: [RagClient],
  exports: [RagClient],
})
export class RagModule {}
