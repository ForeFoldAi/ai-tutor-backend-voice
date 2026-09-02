import { Logger } from "@nestjs/common";
import {
  OnGatewayConnection,
  OnGatewayDisconnect,
  WebSocketGateway,
} from "@nestjs/websockets";
import type { IncomingMessage } from "http";
import type { WebSocket } from "ws";
import { verifyAccessToken } from "../../common/jwt";
import { MSG } from "../../common/messages";
import { iceServers } from "../../config";
import { ConversationMemoryService } from "../conversation/conversation-memory.service";
import { VoiceService } from "./voice.service";
import { WebrtcService } from "./webrtc.service";

type Client = WebSocket & { sessionId?: string; studentId?: string; greetText?: string };

@WebSocketGateway({ path: "/rtc/voice" })
export class VoiceGateway implements OnGatewayConnection, OnGatewayDisconnect {
  private readonly log = new Logger(VoiceGateway.name);

  constructor(
    private readonly voice: VoiceService,
    private readonly rtc: WebrtcService,
    private readonly memory: ConversationMemoryService,
  ) {}

  handleConnection(client: Client, req: IncomingMessage): void {
    client.on("message", (raw, isBinary) => {
      if (isBinary) {
        const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as ArrayBuffer);
        if (client.sessionId && buf.length > 0) this.voice.onPcm(client.sessionId, buf);
        return;
      }
      void this.onMessage(client, String(raw));
    });
    try {
      const host = req.headers.host || "localhost";
      const url = new URL(req.url || "/", `http://${host}`);
      const token = url.searchParams.get("token") || "";
      const user = verifyAccessToken(token);
      client.studentId = user.studentId;
      this.log.log(`ws connected student=${user.studentId}`);
      this.send(client, "session_started", { iceServers: iceServers() });
    } catch {
      this.send(client, "voice_error", { message: "Please sign in again." });
      client.close();
    }
  }

  handleDisconnect(client: Client): void {
    if (client.sessionId) void this.voice.detach(client.sessionId);
  }

  private async onMessage(client: Client, raw: string): Promise<void> {
    let msg: { type?: string; [k: string]: unknown };
    try {
      msg = JSON.parse(raw) as { type?: string };
    } catch {
      return;
    }
    const type = String(msg.type || "");
    try {
      if (type === "session_start") {
        if (this.voice.isDraining()) {
          this.send(client, "voice_error", { message: "Voice server is restarting. Try again in a moment." });
          return;
        }
        this.log.log(`session_start student=${client.studentId || "?"}`);
        await this.startCall(client, msg);
        return;
      }
      if (type === "session_resume") {
        if (this.voice.isDraining()) {
          this.send(client, "voice_error", { message: "Voice server is restarting. Try again in a moment." });
          return;
        }
        await this.resumeCall(client, msg);
        return;
      }
      const sessionId = String(msg.sessionId || client.sessionId || "");
      if (!sessionId) return;
      if (type === "sdp_offer") {
        const answer = await this.rtc.acceptOffer(
          sessionId,
          { type: "offer", sdp: String(msg.sdp || "") },
          (buf) => this.voice.onPcm(sessionId, buf),
          (ice) => this.send(client, "ice", ice),
        );
        this.send(client, "sdp_answer", answer);
        if (client.greetText) {
          const text = client.greetText;
          client.greetText = undefined;
          void this.voice.handleText(sessionId, text, { filler: false, synthetic: true });
        }
        return;
      }
      if (type === "ice") {
        await this.rtc.addIce(sessionId, {
          candidate: String(msg.candidate || ""),
          sdpMid: (msg.sdpMid as string) ?? null,
          sdpMLineIndex: (msg.sdpMLineIndex as number) ?? null,
        });
        return;
      }
      if (type === "interrupt") {
        await this.voice.interruptSession(sessionId);
        return;
      }
      if (type === "token_update") {
        const sessionId = String(msg.sessionId || client.sessionId || "");
        const token = String(msg.token || "");
        if (!sessionId || !token || !client.studentId) return;
        const ok = await this.voice.updateAccessToken(sessionId, token, client.studentId);
        if (!ok) this.send(client, "voice_error", { message: "Session expired. Start a new voice session." });
        return;
      }
      if (type === "text") {
        await this.voice.handleText(sessionId, String(msg.text || ""));
        return;
      }
      if (type === "session_end") {
        await this.voice.end(sessionId);
        client.sessionId = undefined;
        return;
      }
    } catch (err) {
      this.log.warn(`${type} ${err}`);
      if (String(err).includes("server_draining")) {
        this.send(client, "voice_error", { message: "Voice server is restarting. Try again in a moment." });
        return;
      }
      this.send(client, "voice_error", { message: MSG.webrtcFail });
    }
  }

  private wireTransport(client: Client, sessionId: string): Promise<"ok" | "owned_elsewhere"> {
    return this.voice.attachTransport(
      sessionId,
      (event, payload) => this.send(client, event, payload),
      (buf) => {
        if (client.readyState !== 1) return;
        client.send(buf);
      },
    );
  }

  private async startCall(client: Client, msg: Record<string, unknown>): Promise<void> {
    const token = String(msg.token || "");
    const user = verifyAccessToken(token);
    const session = await this.voice.create({
      studentId: user.studentId,
      token,
      scope: {
        board: String(msg.board || ""),
        classLevel: String(msg.classLevel || ""),
        subject: String(msg.subject || ""),
        chapterIds: Array.isArray(msg.chapterIds) ? msg.chapterIds.map(String) : [],
        chapterNames: Array.isArray(msg.chapterNames) ? msg.chapterNames.map(String) : [],
        chapter: msg.chapter ? String(msg.chapter) : undefined,
      },
    });
    client.sessionId = session.id;
    const attached = await this.wireTransport(client, session.id);
    if (attached === "owned_elsewhere") {
      await this.voice.end(session.id);
      this.send(client, "voice_error", {
        message: "Session is active on another server. Close other tabs and try again.",
      });
      return;
    }
    this.log.log(`session ready id=${session.id} student=${user.studentId}`);
    const greet = String(msg.greet || "") === "1";
    this.send(client, "session_ready", {
      sessionId: session.id,
      conversationId: session.conversationId,
      iceServers: iceServers(),
      resumed: false,
    });
    if (greet) {
      void this.voice.handleText(
        session.id,
        "Greet me briefly and ask what I would like to learn today. Do not start teaching yet.",
        { filler: false, synthetic: true },
      );
    }
  }

  private async resumeCall(client: Client, msg: Record<string, unknown>): Promise<void> {
    const token = String(msg.token || "");
    const user = verifyAccessToken(token);
    const sessionId = String(msg.sessionId || "");
    if (!sessionId) {
      this.send(client, "voice_error", { message: "Missing session id." });
      return;
    }
    const session = await this.memory.get(sessionId);
    if (!session || session.studentId !== user.studentId) {
      this.send(client, "voice_error", { message: "Session expired. Start a new voice session." });
      return;
    }
    const updated = await this.voice.updateAccessToken(sessionId, token, user.studentId);
    if (!updated) {
      this.send(client, "voice_error", { message: "Session expired. Start a new voice session." });
      return;
    }
    client.sessionId = sessionId;
    const attached = await this.wireTransport(client, sessionId);
    if (attached === "owned_elsewhere") {
      client.sessionId = undefined;
      this.send(client, "voice_error", {
        message: "Session is active on another server. Close other tabs and try again.",
      });
      return;
    }
    session.state = "LISTENING";
    await this.memory.save(session);
    this.log.log(`session resumed id=${sessionId} student=${user.studentId}`);
    this.send(client, "session_ready", {
      sessionId: session.id,
      conversationId: session.conversationId,
      iceServers: iceServers(),
      resumed: true,
    });
  }

  private send(client: WebSocket, type: string, payload: Record<string, unknown> = {}): void {
    if (client.readyState !== 1) return;
    client.send(JSON.stringify({ type, ...payload }));
  }
}
