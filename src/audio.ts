import { S, type SfxKind } from './state';

/** Timeline helpers */
export function frameStartSec(index: number): number {
  const fps = S.project.fps;
  let beats = 0;
  for (let i = 0; i < index && i < S.project.frames.length; i++) beats += S.project.frames[i].hold;
  return beats / fps;
}

export function totalDurationSec(): number {
  return frameStartSec(S.project.frames.length);
}

function synthBuffer(ctx: BaseAudioContext, kind: SfxKind): AudioBuffer {
  const sr = ctx.sampleRate;
  let dur = 0.4;
  if (kind === 'pop') dur = 0.12;
  if (kind === 'ding') dur = 0.6;
  const buf = ctx.createBuffer(1, Math.ceil(sr * dur), sr);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) {
    const t = i / sr;
    if (kind === 'boing') {
      const f = 260 - 180 * Math.min(1, t / 0.3);
      const wob = 1 + 0.25 * Math.sin(2 * Math.PI * 18 * t);
      d[i] = Math.sin(2 * Math.PI * f * wob * t) * Math.exp(-5 * t) * 0.6;
    } else if (kind === 'pop') {
      const f = 420 + 300 * Math.exp(-40 * t);
      d[i] = (Math.sin(2 * Math.PI * f * t) + (Math.random() - 0.5) * 0.4 * Math.exp(-60 * t)) * Math.exp(-28 * t) * 0.7;
    } else {
      d[i] = (Math.sin(2 * Math.PI * 880 * t) * 0.6 + Math.sin(2 * Math.PI * 1320 * t) * 0.25) * Math.exp(-4.5 * t) * 0.5;
    }
  }
  return buf;
}

class AudioMgr {
  private ctx: AudioContext | null = null;
  private sfxBufs = new Map<string, AudioBuffer>();
  private decoded = new WeakMap<Blob, AudioBuffer>();
  private liveSources: AudioScheduledSourceNode[] = [];
  private recorder: MediaRecorder | null = null;
  private recStream: MediaStream | null = null;
  recording = false;

  ensure(): AudioContext {
    if (!this.ctx) this.ctx = new AudioContext();
    if (this.ctx.state === 'suspended') void this.ctx.resume();
    return this.ctx;
  }

  private sfxBuf(ctx: BaseAudioContext, kind: SfxKind): AudioBuffer {
    const key = kind + ':' + ctx.sampleRate;
    let b = this.sfxBufs.get(key);
    if (!b) {
      b = synthBuffer(ctx, kind);
      this.sfxBufs.set(key, b);
    }
    return b;
  }

  /** Immediate one-shot (used when placing an effect). */
  playSfx(kind: SfxKind): void {
    const ctx = this.ensure();
    const src = ctx.createBufferSource();
    src.buffer = this.sfxBuf(ctx, kind);
    src.connect(ctx.destination);
    src.start();
  }

  private async decode(ctx: BaseAudioContext, blob: Blob): Promise<AudioBuffer | null> {
    const hit = this.decoded.get(blob);
    if (hit && hit.sampleRate === ctx.sampleRate) return hit;
    try {
      const ab = await blob.arrayBuffer();
      const buf = await ctx.decodeAudioData(ab.slice(0));
      this.decoded.set(blob, buf);
      return buf;
    } catch {
      return null;
    }
  }

  /**
   * Schedule the project's full soundtrack on `ctx` into `dest`,
   * as heard from timeline position `fromSec`. Returns started sources.
   */
  async schedule(ctx: AudioContext, dest: AudioNode, fromSec: number): Promise<AudioScheduledSourceNode[]> {
    const started: AudioScheduledSourceNode[] = [];
    const now = ctx.currentTime + 0.06;
    const add = (buf: AudioBuffer, atSec: number, gainV = 1) => {
      const end = atSec + buf.duration;
      if (end <= fromSec) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const g = ctx.createGain();
      g.gain.value = gainV;
      src.connect(g).connect(dest);
      if (atSec >= fromSec) src.start(now + (atSec - fromSec));
      else src.start(now, fromSec - atSec);
      started.push(src);
    };

    if (S.voiceBlob) {
      const b = await this.decode(ctx, S.voiceBlob);
      if (b) add(b, frameStartSec(S.project.voiceStart), 1);
    }
    if (S.musicBlob) {
      const b = await this.decode(ctx, S.musicBlob);
      if (b) add(b, 0, 0.55);
    }
    for (const fx of S.project.sfx) {
      add(this.sfxBuf(ctx, fx.kind), frameStartSec(fx.frame), 0.9);
    }
    return started;
  }

  async startPreview(fromSec: number): Promise<void> {
    const ctx = this.ensure();
    this.stopPreview();
    this.liveSources = await this.schedule(ctx, ctx.destination, fromSec);
  }

  stopPreview(): void {
    for (const s of this.liveSources) {
      try {
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.liveSources = [];
  }

  get hasAnySound(): boolean {
    return !!(S.voiceBlob || S.musicBlob || S.project.sfx.length);
  }

  async toggleRecord(): Promise<'started' | 'stopped' | 'denied'> {
    if (this.recording && this.recorder) {
      this.recorder.stop();
      return 'stopped';
    }
    try {
      this.recStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      return 'denied';
    }
    const chunks: Blob[] = [];
    const rec = new MediaRecorder(this.recStream);
    this.recorder = rec;
    this.recording = true;
    rec.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    rec.onstop = () => {
      this.recording = false;
      this.recStream?.getTracks().forEach((t) => t.stop());
      this.recStream = null;
      const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
      S.project.voiceStart = S.current;
      void S.saveAudio('voice', blob);
      this.onVoiceSaved?.();
    };
    rec.start();
    return 'started';
  }

  onVoiceSaved: (() => void) | null = null;
}

export const Audio = new AudioMgr();
