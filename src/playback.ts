import { S, PW, PH } from './state';
import { Audio, frameStartSec } from './audio';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

class Player {
  open = false;
  playing = false;
  pos = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  onClose: (() => void) | null = null;
  onFpsChange: (() => void) | null = null;

  init(): void {
    $('btnPlayerBack').addEventListener('click', () => this.close());
    $('btnPlayPause').addEventListener('click', () => (this.playing ? this.pause() : void this.play()));
    $('btnPrevFrame').addEventListener('click', () => void this.step(-1));
    $('btnNextFrame').addEventListener('click', () => void this.step(1));
    $('btnLoop').addEventListener('click', () => {
      S.project.loop = !S.project.loop;
      S.persistMeta();
      this.syncUi();
    });
    ($('playScrub') as unknown as HTMLInputElement).addEventListener('input', (e) => {
      this.pause();
      this.pos = Number((e.target as HTMLInputElement).value);
      void this.draw();
      this.syncUi();
    });
    const fpsRange = $('fpsRange') as unknown as HTMLInputElement;
    fpsRange.addEventListener('input', () => {
      S.project.fps = Number(fpsRange.value);
      S.persistMeta();
      this.syncUi();
      this.onFpsChange?.();
    });
    document.querySelectorAll<HTMLButtonElement>('#fpsChips button').forEach((b) => {
      b.addEventListener('click', () => {
        S.project.fps = Number(b.dataset.v);
        S.persistMeta();
        this.syncUi();
        this.onFpsChange?.();
      });
    });
    new ResizeObserver(() => this.fit()).observe($('playerStage'));
  }

  openPlayer(): void {
    this.open = true;
    this.pos = 0;
    $('player').classList.remove('hidden');
    $('playerName').textContent = S.project.name;
    this.fit();
    void this.draw();
    this.syncUi();
    void this.play();
  }

  close(): void {
    this.pause();
    this.open = false;
    $('player').classList.add('hidden');
    this.onClose?.();
  }

  private fit(): void {
    const stage = $('playerStage');
    const c = $('playCanvas') as unknown as HTMLCanvasElement;
    const w = stage.clientWidth;
    const h = stage.clientHeight;
    if (w < 10 || h < 10) return;
    const scale = Math.min(w / PW, h / PH);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.style.width = Math.floor(PW * scale) + 'px';
    c.style.height = Math.floor(PH * scale) + 'px';
    c.width = Math.floor(PW * scale * dpr);
    c.height = Math.floor(PH * scale * dpr);
    void this.draw();
  }

  private async draw(): Promise<void> {
    const c = $('playCanvas') as unknown as HTMLCanvasElement;
    const ctx = c.getContext('2d')!;
    ctx.setTransform(c.width / PW, 0, 0, c.height / PH, 0, 0);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PW, PH);
    const bg = S.live.get('bg');
    if (bg && S.project.bg.visible) {
      ctx.globalAlpha = S.project.bg.opacity;
      ctx.drawImage(bg, 0, 0);
      ctx.globalAlpha = 1;
    }
    const comp = await S.compositeOf(this.pos);
    if (comp) ctx.drawImage(comp, 0, 0);
    // prefetch upcoming frames
    for (let k = 1; k <= 3; k++) {
      const n = this.pos + k;
      if (n < S.project.frames.length) void S.compositeOf(n);
    }
  }

  private syncUi(): void {
    const n = S.project.frames.length;
    $('playFrameLbl').textContent = `Frame ${this.pos + 1} of ${n}`;
    $('playLoopLbl').textContent = S.project.loop ? 'loop on' : 'loop off';
    const scrub = $('playScrub') as unknown as HTMLInputElement;
    scrub.max = String(n - 1);
    scrub.value = String(this.pos);
    $('fpsVal').textContent = S.project.fps + ' fps';
    ($('fpsRange') as unknown as HTMLInputElement).value = String(S.project.fps);
    document.querySelectorAll<HTMLButtonElement>('#fpsChips button').forEach((b) => {
      b.classList.toggle('active', Number(b.dataset.v) === S.project.fps);
    });
    $('btnLoop').classList.toggle('on', S.project.loop);
    $('playBadge').textContent = this.playing ? 'PLAYING' : 'PAUSED';
    $('playPauseIcon').innerHTML = this.playing
      ? '<rect x="6" y="5" width="4.5" height="14" rx="1.5"/><rect x="13.5" y="5" width="4.5" height="14" rx="1.5"/>'
      : '<path d="M8 5v14l11-7-11-7z"/>';
  }

  async play(): Promise<void> {
    if (this.playing) return;
    if (this.pos >= S.project.frames.length - 1 && !S.project.loop) this.pos = 0;
    this.playing = true;
    this.syncUi();
    if (Audio.hasAnySound) void Audio.startPreview(frameStartSec(this.pos));
    const tick = async (): Promise<void> => {
      if (!this.playing) return;
      await this.draw();
      this.syncUi();
      const holdMs = (S.project.frames[this.pos].hold * 1000) / S.project.fps;
      this.timer = setTimeout(() => {
        if (!this.playing) return;
        if (this.pos < S.project.frames.length - 1) {
          this.pos++;
          void tick();
        } else if (S.project.loop) {
          this.pos = 0;
          if (Audio.hasAnySound) void Audio.startPreview(0);
          void tick();
        } else {
          this.pause();
        }
      }, holdMs);
    };
    void tick();
  }

  pause(): void {
    this.playing = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    Audio.stopPreview();
    if (this.open) this.syncUi();
  }

  private async step(d: number): Promise<void> {
    this.pause();
    this.pos = Math.min(S.project.frames.length - 1, Math.max(0, this.pos + d));
    await this.draw();
    this.syncUi();
  }
}

export const player = new Player();
