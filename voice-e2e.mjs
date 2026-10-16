// Voice-to-voice check: speaks a 16 kHz mono WAV into /rtc/voice in real time (VAD + STT + RAG + TTS),
// records the tutor's spoken reply to reply.wav and prints every event with timings.
//   node voice-e2e.mjs <tokenFile> <question.wav> <subject> <chapterId> "<chapterName>" [out.wav]
import { readFileSync, writeFileSync } from "fs";
import WebSocket from "ws";

const [tokFile, wavFile, subject, chapterId, chapterName, outFile = "reply.wav"] = process.argv.slice(2);
const token = readFileSync(tokFile, "utf8").trim();
const wav = readFileSync(wavFile);
const question = new Int16Array(wav.buffer.slice(wav.byteOffset + 44, wav.byteOffset + wav.length));
const FRAME = 4096; // same as the browser's ScriptProcessor: 256 ms per frame
const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
const reply = [];
let spokeEnd = 0;
let firstAudio = 0;
let answered = false;

const pack = (samples) => {
  const buf = Buffer.alloc(8 + samples.length * 2);
  buf.writeUInt32LE(16000, 0);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buf, 8);
  return buf;
};

const ws = new WebSocket(`ws://127.0.0.1:8080/rtc/voice?token=${encodeURIComponent(token)}`);
ws.binaryType = "nodebuffer";

async function speak(sid) {
  const silence = new Int16Array(FRAME);
  const frames = [];
  for (let i = 0; i < 2; i++) frames.push(silence);
  for (let o = 0; o < question.length; o += FRAME) {
    const f = new Int16Array(FRAME);
    f.set(question.subarray(o, o + FRAME));
    frames.push(f);
  }
  for (let i = 0; i < 12; i++) frames.push(silence); // ~3 s of silence so the VAD ends the turn
  console.log(`${ts()}  >> speaking ${(question.length / 16000).toFixed(1)}s of audio`);
  for (const [i, f] of frames.entries()) {
    ws.send(pack(f));
    if (i === frames.length - 13) spokeEnd = Date.now();
    await new Promise((r) => setTimeout(r, 256));
  }
}

function finish(why) {
  const pcm = Buffer.concat(reply);
  const hdr = Buffer.alloc(44);
  hdr.write("RIFF", 0); hdr.writeUInt32LE(36 + pcm.length, 4); hdr.write("WAVE", 8); hdr.write("fmt ", 12);
  hdr.writeUInt32LE(16, 16); hdr.writeUInt16LE(1, 20); hdr.writeUInt16LE(1, 22); hdr.writeUInt32LE(16000, 24);
  hdr.writeUInt32LE(32000, 28); hdr.writeUInt16LE(2, 32); hdr.writeUInt16LE(16, 34); hdr.write("data", 36);
  hdr.writeUInt32LE(pcm.length, 40);
  writeFileSync(outFile, Buffer.concat([hdr, pcm]));
  console.log(`\n--- ${why} ---`);
  if (spokeEnd && firstAudio) console.log(`time from end of question to first reply audio: ${((firstAudio - spokeEnd) / 1000).toFixed(1)}s`);
  console.log(`reply audio: ${(pcm.length / 32000).toFixed(1)}s -> ${outFile}`);
  try { ws.close(); } catch {}
  process.exit(0);
}

ws.on("message", (raw, isBinary) => {
  if (isBinary) {
    if (raw.length > 8) {
      if (!firstAudio && spokeEnd) firstAudio = Date.now();
      if (spokeEnd) reply.push(raw.subarray(8));
    }
    return;
  }
  const msg = JSON.parse(String(raw));
  const extra =
    msg.type === "transcript" ? ` [${msg.role}${msg.final === false ? ", partial" : ""}] ${msg.text}` :
    msg.type === "related_images" ? ` ${msg.images.map((i) => i.caption || i.url).join(" | ")}` :
    msg.type === "voice_error" ? ` ${msg.message}` : "";
  console.log(`${ts()}  ${msg.type}${extra}`);
  if (msg.type === "session_started") {
    ws.send(JSON.stringify({
      type: "session_start", token, greet: "0", board: "CBSE", classLevel: "CLASS_8", subject,
      chapterIds: [chapterId], chapterNames: [chapterName],
    }));
  }
  if (msg.type === "session_ready") void speak(msg.sessionId);
  if (msg.type === "transcript" && msg.role === "assistant") answered = true;
  if (msg.type === "ai_stopped_speaking" && answered) setTimeout(() => finish("turn complete"), 500);
});
ws.on("error", (e) => finish("ws error: " + e.message));
setTimeout(() => finish("timeout (120s)"), 120000);
