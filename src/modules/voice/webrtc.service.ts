import { Injectable, Logger } from "@nestjs/common";
import { RTCIceCandidate, RTCPeerConnection } from "werift";
import { iceServers } from "../../config";

export type IceJson = { candidate: string; sdpMid?: string | null; sdpMLineIndex?: number | null };

@Injectable()
export class WebrtcService {
  private readonly log = new Logger(WebrtcService.name);
  private readonly peers = new Map<
    string,
    {
      pc: RTCPeerConnection;
      send: ((buf: Buffer) => void) | null;
      pending: Buffer[];
      onPcm: (buf: Buffer) => void;
    }
  >();

  async acceptOffer(
    sessionId: string,
    sdp: { type: "offer"; sdp: string },
    onPcm: (buf: Buffer) => void,
    onIce: (ice: IceJson) => void,
  ): Promise<{ type: string; sdp: string }> {
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    // ponytail: PCM over datachannel, not RTP tracks. Add audio transceivers if AEC/jitter needs native WebRTC media.
    const rec = { pc, send: null as ((buf: Buffer) => void) | null, pending: [] as Buffer[], onPcm };
    this.peers.set(sessionId, rec);

    pc.onIceCandidate.subscribe((c) => {
      if (!c?.candidate) return;
      onIce({
        candidate: c.candidate,
        sdpMid: c.sdpMid,
        sdpMLineIndex: c.sdpMLineIndex,
      });
    });

    pc.onDataChannel.subscribe((dc) => {
      rec.send = (buf) => dc.send(buf);
      dc.onMessage.subscribe((data) => {
        const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
        rec.onPcm(buf);
      });
      for (const p of rec.pending) {
        try {
          dc.send(p);
        } catch (err) {
          this.log.debug(`flush ${err}`);
        }
      }
      rec.pending = [];
    });

    await pc.setRemoteDescription(sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    return { type: "answer", sdp: pc.localDescription?.sdp || answer.sdp || "" };
  }

  async addIce(sessionId: string, ice: IceJson): Promise<void> {
    const rec = this.peers.get(sessionId);
    if (!rec || !ice.candidate) return;
    await rec.pc.addIceCandidate(
      new RTCIceCandidate({
        candidate: ice.candidate,
        sdpMid: ice.sdpMid ?? undefined,
        sdpMLineIndex: ice.sdpMLineIndex ?? undefined,
      }),
    );
  }

  sendPcm(sessionId: string, buf: Buffer): void {
    const rec = this.peers.get(sessionId);
    if (!rec) return;
    if (!rec.send) {
      rec.pending.push(buf);
      return;
    }
    try {
      rec.send(buf);
    } catch (err) {
      this.log.debug(`send ${err}`);
    }
  }

  async close(sessionId: string): Promise<void> {
    const rec = this.peers.get(sessionId);
    this.peers.delete(sessionId);
    try {
      rec?.pc.close();
    } catch {
      /* ignore */
    }
  }
}
