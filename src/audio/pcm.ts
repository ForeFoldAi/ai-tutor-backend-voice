export const PCM_SAMPLE_RATE = 16000;

export function floatToInt16(input: Float32Array): Int16Array {
  const out = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    out[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return out;
}

export function int16ToFloat(input: Int16Array): Float32Array {
  const out = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i] / 0x8000;
  return out;
}

export function resample(input: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate) return input;
  const ratio = fromRate / toRate;
  const outLen = Math.max(1, Math.round(input.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const src = i * ratio;
    const i0 = Math.floor(src);
    const i1 = Math.min(input.length - 1, i0 + 1);
    const t = src - i0;
    out[i] = input[i0] * (1 - t) + input[i1] * t;
  }
  return out;
}

/** Frame: [uint32le sampleRate][uint8 flags][3 bytes pad][int16le pcm...]  flags bit0 = end */
export function packPcm(samples: Int16Array, sampleRate = PCM_SAMPLE_RATE, end = false): Buffer {
  const buf = Buffer.alloc(8 + samples.length * 2);
  buf.writeUInt32LE(sampleRate, 0);
  buf.writeUInt8(end ? 1 : 0, 4);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buf, 8);
  return buf;
}

/** Mono 16-bit PCM wrapped in a 44-byte RIFF/WAVE header. */
export function int16ToWav(samples: Int16Array, sampleRate = PCM_SAMPLE_RATE): Buffer {
  const data = samples.length * 2;
  const buf = Buffer.alloc(44 + data);
  buf.write("RIFF", 0, "ascii");
  buf.writeUInt32LE(36 + data, 4);
  buf.write("WAVEfmt ", 8, "ascii");
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write("data", 36, "ascii");
  buf.writeUInt32LE(data, 40);
  Buffer.from(samples.buffer, samples.byteOffset, samples.byteLength).copy(buf, 44);
  return buf;
}

export function unpackPcm(buf: Buffer): { samples: Int16Array; sampleRate: number; end: boolean } {
  const sampleRate = buf.readUInt32LE(0);
  const end = (buf.readUInt8(4) & 1) === 1;
  const n = (buf.length - 8) / 2;
  const samples = new Int16Array(n);
  for (let i = 0; i < n; i++) samples[i] = buf.readInt16LE(8 + i * 2);
  return { samples, sampleRate, end };
}
