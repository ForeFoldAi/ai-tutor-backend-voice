import { Module } from "@nestjs/common";
import { ThrottlerGuard, ThrottlerModule } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { config } from "./config";
import { ConversationModule } from "./modules/conversation/conversation.module";
import { ProgressModule } from "./modules/progress/progress.module";
import { RagModule } from "./modules/rag/rag.module";
import { TutorModule } from "./modules/tutor/tutor.module";
import { VoiceModule } from "./modules/voice/voice.module";

@Module({
  imports: [
    ThrottlerModule.forRoot({
      throttlers: [{ ttl: 60000, limit: config.rateLimitPerMin }],
    }),
    ConversationModule,
    TutorModule,
    RagModule,
    ProgressModule,
    VoiceModule,
  ],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerGuard }],
})
export class AppModule {}
