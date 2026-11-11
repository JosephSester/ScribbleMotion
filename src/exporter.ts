import { S, PW, PH } from './state';
import { GifEncoder } from './gifenc';
import { Audio } from './audio';

export interface ExportProgress {
  (done: number, total: number, label: string): void;
}

/** Draw one finished frame (background + layers) onto a w×h canvas. */
async function renderFrame(index: number, ctx: CanvasRenderingContext2D, w: number, h: number): Promise<void> {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  const bg = S.live.get('bg');
  if (bg && S.project.bg.visible) {
    ctx.globalAlpha = S.project.bg.opacity;
    ctx.drawImage(bg, 0, 0, w, h);
    ctx.globalAlpha = 1;
  }
  const comp = await S.compositeOf(index);
  if (comp) ctx.drawImage(comp, 0, 0, w, h);
}

export async function exportGif(sizeW: number, onProgress: ExportProgress): Promise<Blob> {
  const w = sizeW;
  const h = Math.round((sizeW * PH) / PW);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  const enc = new GifEncoder(w, h);
  const frames = S.project.frames;
  const delayPerBeat = 100 / S.project.fps; // hundredths of a second
  for (let i = 0; i < frames.length; i++) {
    await renderFrame(i, ctx, w, h);
    enc.addFrame(ctx.getImageData(0, 0, w, h).data, frames[i].hold * delayPerBeat);
    onProgress(i + 1, frames.length, 'Drawing GIF frames…');
    await new Promise((r) => setTimeout(r, 0));
  }
  return enc.finish();
}

function pickVideoMime(): { mime: string; ext: string } {
  const candidates: [string, string][] = [
    ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'],
    ['video/mp4', 'mp4'],
    ['video/webm;codecs=vp9,opus', 'webm'],
    ['video/webm', 'webm']
  ];
  for (const [mime, ext] of candidates) {
    try {
      if (MediaRecorder.isTypeSupported(mime)) return { mime, ext };
    } catch {
      /* keep looking */
    }
  }
  return { mime: '', ext: 'webm' };
}

export async function exportVideo(
  sizeW: number,
  onProgress: ExportProgress
): Promise<{ blob: Blob; ext: string }> {
  const w = sizeW;
  const h = Math.round((sizeW * PH) / PW);
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d')!;
  await renderFrame(0, ctx, w, h);

  const stream = c.captureStream(30);
  let audioCtx: AudioContext | null = null;
  if (Audio.hasAnySound) {
    try {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      await Audio.schedule(audioCtx, dest, 0);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    } catch {
      audioCtx = null;
    }
  }

  const { mime, ext } = pickVideoMime();
  const rec = new MediaRecorder(stream, mime ? { mimeType: mime, videoBitsPerSecond: 8_000_000 } : undefined);
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => {
    if (e.data.size) chunks.push(e.data);
  };
  const stopped = new Promise<void>((res) => {
    rec.onstop = () => res();
  });
  rec.start(250);

  const frames = S.project.frames;
  const frameMs = 1000 / S.project.fps;
  const t0 = performance.now();
  let acc = 0;
  for (let i = 0; i < frames.length; i++) {
    await renderFrame(i, ctx, w, h);
    onProgress(i + 1, frames.length, 'Recording video…');
    acc += frames[i].hold * frameMs;
    const wait = t0 + acc - performance.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  // small tail so the last frame lands in the recording
  await new Promise((r) => setTimeout(r, 180));
  rec.stop();
  await stopped;
  if (audioCtx) void audioCtx.close();
  return { blob: new Blob(chunks, { type: mime || 'video/webm' }), ext };
}

/** Share via the system share sheet when possible, else download. */
export async function deliver(blob: Blob, filename: string): Promise<'shared' | 'downloaded'> {
  const file = new File([blob], filename, { type: blob.type });
  const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
  if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
    try {
      await nav.share({ files: [file], title: S.project.name });
      return 'shared';
    } catch {
      /* fall through to download (user may have cancelled) */
    }
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
  return 'downloaded';
}
