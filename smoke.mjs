// End-to-end smoke check of the voice pipeline: gateway auth -> session ->
// text turn -> FastAPI RAG -> Kokoro TTS -> PCM downlink over the WS.
// Skips STT (sends `text`), so it isolates everything else.
//
// Needs both servers up (:8080 and :8000) and a student access token:
//   cd ../../ai-tutor-backend && ./.venv/bin/python -c \
//     "import sys;sys.path.insert(0,'.');from app.core.security import create_access_token;\
//      print(create_access_token('1','STUDENT'))" > /tmp/tok
//   node smoke.mjs /tmp/tok
//
// Expect: one PCM frame per sentence chunk plus a final 8-byte end packet.
// If frames come out doubled, something is sending audio on both the WS and
// the RTC datachannel again (see voice.service.ts speak()).
import { readFileSync } from "fs";
import WebSocket from "ws";

const token = readFileSync(process.argv[2], "utf8").trim();
const ws = new WebSocket(`ws://127.0.0.1:8080/rtc/voice?token=${encodeURIComponent(token)}`);
ws.binaryType = "arraybuffer";

let pcmFrames = 0;
let pcmBytes = 0;
let sid = "";
const seen = [];

const done = (why) => {
  console.log(`\n--- ${why} ---`);
  console.log("events:", seen.join(" -> ") || "(none)");
  console.log(`pcm frames: ${pcmFrames}, bytes: ${pcmBytes}`);
  try { ws.close(); } catch {}
  process.exit(0);
};

ws.on("open", () => console.log("ws open"));

ws.on("message", (raw, isBinary) => {
  if (isBinary) {
    pcmFrames++;
    pcmBytes += raw.byteLength ?? raw.length;
    if (pcmFrames === 1) console.log("first PCM frame:", raw.byteLength ?? raw.length, "bytes");
    return;
  }
  const msg = JSON.parse(String(raw));
  seen.push(msg.type);
  if (msg.type === "voice_error") console.log("  voice_error:", msg.message);
  if (msg.type === "transcript") console.log(`  [${msg.role}]`, String(msg.text).slice(0, 160));

  if (msg.type === "session_started") {
    ws.send(JSON.stringify({
      type: "session_start", token, greet: "0",
      board: "CBSE", classLevel: "CLASS_8", subject: "Social",
      chapterIds: ["33"], chapterNames: ["Chapter 2 - Reshaping India's Political Map"],
    }));
  }
  if (msg.type === "session_ready") {
    sid = msg.sessionId;
    console.log("session_ready:", sid);
    // Skip STT; drive a turn straight through RAG + TTS.
    ws.send(JSON.stringify({ type: "text", sessionId: sid, text: "What is a political map?" }));
  }
  if (msg.type === "ai_stopped_speaking") done("turn complete");
});

ws.on("error", (e) => done("ws error: " + e.message));
ws.on("close", () => done("ws closed"));
setTimeout(() => done("timeout (180s)"), 180000);
