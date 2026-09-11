import { Module } from "@nestjs/common";
import { ConversationModule } from "../conversation/conversation.module";
import { ProgressModule } from "../progress/progress.module";
import { RagModule } from "../rag/rag.module";
import { TutorModule } from "../tutor/tutor.module";
import { LlmModule } from "../llm/llm.module";
import { EdgeTtsProvider } from "./providers/edge.tts";
import { KokoroTtsProvider } from "./providers/kokoro.tts";
import { TtsProvider } from "./providers/tts.provider";
import { WhisperSttProvider } from "./providers/whisper.stt";
import { ThinkingFillerService } from "./thinking-filler.service";
import { VoiceController } from "./voice.controller";
import { VoiceGateway } from "./voice.gateway";
import { VoiceService } from "./voice.service";
import { WebrtcService } from "./webrtc.service";

@Module({
  imports: [ConversationModule, TutorModule, RagModule, ProgressModule, LlmModule],
  controllers: [VoiceController],
  providers: [
    VoiceService,
    VoiceGateway,
    WebrtcService,
    WhisperSttProvider,
    KokoroTtsProvider,
    EdgeTtsProvider,
    TtsProvider,
    ThinkingFillerService,
  ],
  exports: [VoiceService],
})
export class VoiceModule {}
