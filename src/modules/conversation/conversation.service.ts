import { Injectable } from "@nestjs/common";
import { ConversationMemoryService, VoiceSession } from "./conversation-memory.service";

@Injectable()
export class ConversationService {
  constructor(private readonly memory: ConversationMemoryService) {}

  get(id: string): Promise<VoiceSession | null> {
    return this.memory.get(id);
  }
}
