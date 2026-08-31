import { Body, Controller, Get, Headers, Param, Post, Req, UseGuards } from "@nestjs/common";
import { SkipThrottle } from "@nestjs/throttler";
import { JwtAuthGuard } from "../../common/auth.guard";
import { config, iceServers } from "../../config";
import { ConversationService } from "../conversation/conversation.service";
import { SessionOwnershipService } from "../conversation/session-ownership.service";
import { ProgressService } from "../progress/progress.service";
import { AnswerEvaluatorService } from "../tutor/answer-evaluator.service";
import { VoiceService } from "./voice.service";
import { EvaluateDto, StartSessionDto, TutorQueryDto } from "./dto/session.dto";

type Authed = { user: { studentId: string; role: string }; headers: { authorization?: string } };

@Controller()
export class VoiceController {
  constructor(
    private readonly voice: VoiceService,
    private readonly conversations: ConversationService,
    private readonly progress: ProgressService,
    private readonly evaluator: AnswerEvaluatorService,
    private readonly ownership: SessionOwnershipService,
  ) {}

  @SkipThrottle()
  @Get("rtc/health")
  async health() {
    const redis = await this.ownership.ping();
    return {
      status: this.voice.isDraining() ? "draining" : "ok",
      voice: "ws-pcm",
      instanceId: this.voice.getInstanceId(),
      draining: this.voice.isDraining(),
      liveSessions: this.voice.liveSessionCount(),
      redis: redis ? "up" : "down",
    };
  }

  @SkipThrottle()
  @Post("rtc/admin/drain")
  drain(@Body() body: { draining?: boolean }, @Headers("x-admin-secret") secret?: string) {
    if (!config.adminSecret || secret !== config.adminSecret) {
      return { ok: false, error: "unauthorized" };
    }
    this.voice.setDraining(Boolean(body.draining));
    return { ok: true, draining: this.voice.isDraining() };
  }

  @SkipThrottle()
  @Get("rtc/voice/ice")
  ice() {
    return { iceServers: iceServers() };
  }

  @UseGuards(JwtAuthGuard)
  @Post("rtc/voice/session")
  async start(@Body() body: StartSessionDto, @Req() req: Authed) {
    if (this.voice.isDraining()) throw new Error("server_draining");
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const session = await this.voice.create({
      studentId: req.user.studentId,
      token,
      scope: {
        board: body.board,
        classLevel: body.classLevel,
        subject: body.subject,
        chapterIds: body.chapterIds || [],
        chapterNames: body.chapterNames || [],
        chapter: body.chapter,
      },
    });
    return {
      id: session.id,
      conversationId: session.conversationId,
      iceServers: iceServers(),
    };
  }

  @UseGuards(JwtAuthGuard)
  @Post("rtc/voice/session/:id/end")
  async end(@Param("id") id: string) {
    await this.voice.end(id);
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Get("rtc/conversations/:id")
  async conversation(@Param("id") id: string) {
    const session = await this.conversations.get(id);
    if (session) {
      return {
        id: session.conversationId,
        sessionId: session.id,
        messages: session.recentMessages,
        summary: session.summary,
        tutor: session.tutor,
      };
    }
    return { id, messages: await this.progress.conversationMessages(id) };
  }

  @UseGuards(JwtAuthGuard)
  @Get("rtc/conversations/:id/messages")
  messages(@Param("id") id: string) {
    return this.progress.conversationMessages(id);
  }

  @UseGuards(JwtAuthGuard)
  @Post("rtc/tutor/query")
  async query(@Body() body: TutorQueryDto) {
    await this.voice.handleText(body.sessionId, body.query);
    return { ok: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post("rtc/tutor/evaluate")
  evaluate(@Body() body: EvaluateDto) {
    return this.evaluator.grade(body.expected, body.student, body.concept || "").then((grade) => ({ grade }));
  }

  @UseGuards(JwtAuthGuard)
  @Get("rtc/students/:id/progress")
  studentProgress(@Param("id") id: string, @Req() req: Authed) {
    if (id !== req.user.studentId && req.user.role !== "tutor") {
      return [];
    }
    return this.progress.studentProgress(id);
  }
}
