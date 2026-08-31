import { Injectable } from "@nestjs/common";
import { TutorOrchestratorService } from "./tutor-orchestrator.service";

@Injectable()
export class TutorService {
  constructor(readonly orchestrator: TutorOrchestratorService) {}
}
