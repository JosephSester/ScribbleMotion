import Dexie, { type Table } from 'dexie';

/** Project pixel size (4:3). All drawing happens in this coordinate space. */
export const PW = 1280;
export const PH = 960;
export const MAX_LAYERS = 10;

export type SfxKind = 'boing' | 'pop' | 'ding';

export interface LayerData {
  id: string;
  name: string;
  visible: boolean;
  opacity: number; // 0..1
}

export interface FrameData {
  id: string;
  hold: number; // 1..8 beats
  layers: LayerData[]; // bottom -> top
}

export interface SfxPlacement {
  id: string;
  kind: SfxKind;
  frame: number; // frame index when placed (0-based)
}

export interface ProjectData {
  id: string;
  name: string;
  fps: number;
  loop: boolean;
  onion: { on: boolean; opacity: number; count: number };
  frames: FrameData[];
  palette: string[];
  sfx: SfxPlacement[];
  voiceStart: number;
  bg: { visible: boolean; opacity: number };
  thumb?: string;
  updatedAt: number;
}

interface BlobRow {
  key: string; // layer id, or 'bg:<pid>' / 'voice:<pid>' / 'music:<pid>'
  projectId: string;
  blob: Blob;
}

class DB extends Dexie {
  projects!: Table<ProjectData, string>;
  blobs!: Table<BlobRow, string>;
  constructor() {
    super('scribble-motion');
    this.version(1).stores({
      projects: 'id, updatedAt',
      blobs: 'key, projectId'
    });
  }
}

export const db = new DB();

export const uid = () =>
  Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-4);

export const DEFAULT_PALETTE = ['#2B2B33', '#FF6B52', '#3C7DFF', '#2EC4A6', '#FFB13D', '#9B7BFF', '#FFFFFF'];

export function blankCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = PW;
  c.height = PH;
  return c;
}

export function canvasToBlob(c: HTMLCanvasElement): Promise<Blob> {
  return new Promise((res, rej) =>
    c.toBlob((b) => (b ? res(b) : rej(new Error('toBlob failed'))), 'image/png')
  );
}

async function blobToCanvas(blob: Blob): Promise<HTMLCanvasElement> {
  const bmp = await createImageBitmap(blob);
  const c = blankCanvas();
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

/** Central runtime store (one open project at a time). */
class Store {
  project!: ProjectData;
  current = 0; // active frame index
  activeLayerId = '';
  /** Live canvases for the ACTIVE frame's layers, plus the shared background under key 'bg'. */
  live = new Map<string, HTMLCanvasElement>();
  /** Composite cache for inactive frames (layers only, no background). */
  private compCache = new Map<string, ImageBitmap>();
  /** Small thumbnail dataURLs per frame id. */
  thumbs = new Map<string, string>();
  clipboard: { frame: FrameData; blobs: Map<string, Blob> } | null = null;
  voiceBlob: Blob | null = null;
  musicBlob: Blob | null = null;
  musicName = '';
  private dirtyLayers = new Set<string>();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private metaTimer: ReturnType<typeof setTimeout> | null = null;
  onFramesChanged: (() => void) | null = null;

  get frame(): FrameData {
    return this.project.frames[this.current];
  }
  get activeLayer(): LayerData | undefined {
    if (this.activeLayerId === 'bg') {
      return { id: 'bg', name: 'Background', visible: this.project.bg.visible, opacity: this.project.bg.opacity };
    }
    return this.frame.layers.find((l) => l.id === this.activeLayerId);
  }
  layerCanvas(id: string): HTMLCanvasElement {
    let c = this.live.get(id);
    if (!c) {
      c = blankCanvas();
      this.live.set(id, c);
    }
    return c;
  }

  // ---------- project lifecycle ----------

  makeProjectData(name: string): ProjectData {
    const layer: LayerData = { id: uid(), name: 'Drawing', visible: true, opacity: 1 };
    return {
      id: uid(),
      name,
      fps: 12,
      loop: true,
      onion: { on: true, opacity: 0.5, count: 2 },
      frames: [{ id: uid(), hold: 1, layers: [layer] }],
      palette: [...DEFAULT_PALETTE],
      sfx: [],
      voiceStart: 0,
      bg: { visible: true, opacity: 1 },
      updatedAt: Date.now()
    };
  }

  async newProject(name: string): Promise<void> {
    const p = this.makeProjectData(name);
    await db.projects.put(p);
    await this.openProject(p.id);
  }

  async openProject(id: string): Promise<boolean> {
    const p = await db.projects.get(id);
    if (!p) return false;
    this.project = p;
    this.current = 0;
    this.live.clear();
    this.compCache.forEach((b) => b.close());
    this.compCache.clear();
    this.thumbs.clear();
    this.dirtyLayers.clear();
    this.voiceBlob = (await db.blobs.get('voice:' + p.id))?.blob ?? null;
    const music = await db.blobs.get('music:' + p.id);
    this.musicBlob = music?.blob ?? null;
    const bgRow = await db.blobs.get('bg:' + p.id);
    this.live.set('bg', bgRow ? await blobToCanvas(bgRow.blob) : blankCanvas());
    await this.loadFrameIntoLive(0);
    localStorage.setItem('sm-last-project', p.id);
    void this.warmThumbs();
    return true;
  }

  async loadLastOrNew(): Promise<void> {
    const last = localStorage.getItem('sm-last-project');
    if (last && (await this.openProject(last))) return;
    const newest = await db.projects.orderBy('updatedAt').last();
    if (newest && (await this.openProject(newest.id))) return;
    await this.newProject('My Cartoon');
  }

  // ---------- frame switching & persistence ----------

  private async loadFrameIntoLive(index: number): Promise<void> {
    const f = this.project.frames[index];
    for (const l of f.layers) {
      if (this.live.has(l.id)) continue;
      const row = await db.blobs.get(l.id);
      this.live.set(l.id, row ? await blobToCanvas(row.blob) : blankCanvas());
    }
    this.current = index;
    if (!f.layers.some((l) => l.id === this.activeLayerId)) {
      this.activeLayerId = f.layers[f.layers.length - 1].id;
    }
  }

  async switchFrame(index: number): Promise<void> {
    if (index === this.current || index < 0 || index >= this.project.frames.length) return;
    await this.flushLayerSaves();
    const old = this.frame;
    // Drop old frame's live canvases (they are persisted now).
    for (const l of old.layers) this.live.delete(l.id);
    this.invalidateFrame(old.id);
    await this.loadFrameIntoLive(index);
    void this.warmOnion();
  }

  markLayerDirty(id: string): void {
    this.dirtyLayers.add(id);
    this.invalidateFrame(this.frame.id);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => void this.flushLayerSaves(), 900);
  }

  async flushLayerSaves(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    const ids = [...this.dirtyLayers];
    this.dirtyLayers.clear();
    for (const id of ids) {
      const c = this.live.get(id);
      if (!c) continue;
      const blob = await canvasToBlob(c);
      const key = id === 'bg' ? 'bg:' + this.project.id : id;
      await db.blobs.put({ key, projectId: this.project.id, blob });
    }
    if (ids.length) this.persistMeta();
  }

  persistMeta(): void {
    if (this.metaTimer) clearTimeout(this.metaTimer);
    this.metaTimer = setTimeout(() => {
      this.project.updatedAt = Date.now();
      this.project.thumb = this.thumbs.get(this.project.frames[0]?.id ?? '') ?? this.project.thumb;
      void db.projects.put(this.project);
    }, 500);
  }

  // ---------- composites, onion, thumbs ----------

  invalidateFrame(frameId: string): void {
    const b = this.compCache.get(frameId);
    if (b) {
      b.close();
      this.compCache.delete(frameId);
    }
  }

  /** Synchronous composite of the ACTIVE frame from live canvases (no background). */
  compositeActive(target?: HTMLCanvasElement): HTMLCanvasElement {
    const c = target ?? blankCanvas();
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, PW, PH);
    for (const l of this.frame.layers) {
      if (!l.visible) continue;
      const lc = this.live.get(l.id);
      if (!lc) continue;
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(lc, 0, 0);
    }
    ctx.globalAlpha = 1;
    return c;
  }

  /** Async composite (layers only) of any frame; cached as ImageBitmap for inactive frames. */
  async compositeOf(index: number): Promise<ImageBitmap | HTMLCanvasElement | null> {
    const f = this.project.frames[index];
    if (!f) return null;
    if (index === this.current) return this.compositeActive();
    const hit = this.compCache.get(f.id);
    if (hit) return hit;
    const c = blankCanvas();
    const ctx = c.getContext('2d')!;
    for (const l of f.layers) {
      if (!l.visible) continue;
      let img: HTMLCanvasElement | ImageBitmap | null = this.live.get(l.id) ?? null;
      if (!img) {
        const row = await db.blobs.get(l.id);
        if (!row) continue;
        img = await createImageBitmap(row.blob);
      }
      ctx.globalAlpha = l.opacity;
      ctx.drawImage(img, 0, 0);
      if (img instanceof ImageBitmap) img.close();
    }
    ctx.globalAlpha = 1;
    const bmp = await createImageBitmap(c);
    this.compCache.set(f.id, bmp);
    if (this.compCache.size > 24) {
      const first = this.compCache.keys().next().value as string;
      this.compCache.get(first)?.close();
      this.compCache.delete(first);
    }
    return bmp;
  }

  /** Cached ghost for render loops: returns only if already cached. */
  ghostOf(index: number): ImageBitmap | null {
    const f = this.project.frames[index];
    if (!f) return null;
    return this.compCache.get(f.id) ?? null;
  }

  async warmOnion(): Promise<void> {
    const n = this.project.onion.count;
    for (let k = 1; k <= n; k++) {
      const i = this.current - k;
      if (i >= 0) await this.compositeOf(i);
    }
  }

  async makeThumb(index: number): Promise<string> {
    const f = this.project.frames[index];
    const comp = await this.compositeOf(index);
    const t = document.createElement('canvas');
    t.width = 108;
    t.height = 81;
    const ctx = t.getContext('2d')!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 108, 81);
    const bg = this.live.get('bg');
    if (bg && this.project.bg.visible) {
      ctx.globalAlpha = this.project.bg.opacity;
      ctx.drawImage(bg, 0, 0, 108, 81);
      ctx.globalAlpha = 1;
    }
    if (comp) ctx.drawImage(comp, 0, 0, 108, 81);
    const url = t.toDataURL('image/jpeg', 0.7);
    this.thumbs.set(f.id, url);
    return url;
  }

  async warmThumbs(): Promise<void> {
    for (let i = 0; i < this.project.frames.length; i++) {
      if (!this.thumbs.has(this.project.frames[i].id)) {
        await this.makeThumb(i);
        this.onFramesChanged?.();
      }
    }
  }

  // ---------- frame operations ----------

  private blankFrame(): FrameData {
    return { id: uid(), hold: 1, layers: [{ id: uid(), name: 'Drawing', visible: true, opacity: 1 }] };
  }

  /** Insert a blank frame after `after` (or at end) and switch to it. */
  async addFrame(after?: number): Promise<void> {
    await this.flushLayerSaves();
    const f = this.blankFrame();
    const at = after === undefined ? this.project.frames.length : after + 1;
    this.project.frames.splice(at, 0, f);
    await this.switchFrame(at);
    this.thumbs.set(f.id, await this.makeThumb(at));
    this.persistMeta();
  }

  /** Serialize one frame's layers to blobs (from live if active, else from storage). */
  private async frameBlobs(index: number): Promise<Map<string, Blob>> {
    const f = this.project.frames[index];
    const out = new Map<string, Blob>();
    for (const l of f.layers) {
      const liveC = this.live.get(l.id);
      if (liveC) {
        out.set(l.id, await canvasToBlob(liveC));
      } else {
        const row = await db.blobs.get(l.id);
        if (row) out.set(l.id, row.blob);
      }
    }
    return out;
  }

  async copyFrame(index: number): Promise<void> {
    const f = this.project.frames[index];
    this.clipboard = {
      frame: JSON.parse(JSON.stringify(f)) as FrameData,
      blobs: await this.frameBlobs(index)
    };
  }

  /** Paste clipboard (or a copy of frame src) after index. Returns new index or -1. */
  async pasteAfter(index: number): Promise<number> {
    if (!this.clipboard) return -1;
    await this.flushLayerSaves();
    const src = this.clipboard;
    const nf: FrameData = { id: uid(), hold: src.frame.hold, layers: [] };
    for (const l of src.frame.layers) {
      const nid = uid();
      nf.layers.push({ ...l, id: nid });
      const blob = src.blobs.get(l.id);
      if (blob) await db.blobs.put({ key: nid, projectId: this.project.id, blob });
    }
    this.project.frames.splice(index + 1, 0, nf);
    const thumbSrc = this.thumbs.get(src.frame.id);
    if (thumbSrc) this.thumbs.set(nf.id, thumbSrc);
    this.persistMeta();
    return index + 1;
  }

  async duplicateFrame(index: number): Promise<number> {
    const keep = this.clipboard;
    await this.copyFrame(index);
    const at = await this.pasteAfter(index);
    this.clipboard = keep;
    return at;
  }

  async deleteFrame(index: number): Promise<void> {
    const f = this.project.frames[index];
    if (!f) return;
    const wasActive = index === this.current;
    for (const l of f.layers) {
      this.live.delete(l.id);
      await db.blobs.delete(l.id);
    }
    this.invalidateFrame(f.id);
    this.thumbs.delete(f.id);
    this.project.frames.splice(index, 1);
    if (this.project.frames.length === 0) this.project.frames.push(this.blankFrame());
    const target = Math.min(wasActive ? index : this.current > index ? this.current - 1 : this.current, this.project.frames.length - 1);
    this.current = -1; // force reload
    await this.loadFrameIntoLive(Math.max(0, target));
    this.persistMeta();
  }

  /** Wipe every layer of one frame back to blank paper (keeps the frame and its layers). */
  async clearFrame(index: number): Promise<void> {
    const f = this.project.frames[index];
    if (!f) return;
    for (const l of f.layers) {
      const live = this.live.get(l.id);
      if (live) {
        live.getContext('2d')!.clearRect(0, 0, PW, PH);
        this.markLayerDirty(l.id);
      } else {
        await db.blobs.delete(l.id);
      }
    }
    this.invalidateFrame(f.id);
    await this.makeThumb(index);
    this.persistMeta();
  }

  async moveFrame(from: number, to: number): Promise<void> {
    if (from === to || from < 0 || to < 0) return;
    const activeId = this.frame.id;
    const [f] = this.project.frames.splice(from, 1);
    this.project.frames.splice(to, 0, f);
    this.current = this.project.frames.findIndex((x) => x.id === activeId);
    this.persistMeta();
  }

  // ---------- project list ----------

  async listProjects(): Promise<ProjectData[]> {
    return db.projects.orderBy('updatedAt').reverse().toArray();
  }

  async deleteProject(id: string): Promise<void> {
    await db.blobs.where('projectId').equals(id).delete();
    await db.projects.delete(id);
  }

  async saveAudio(kind: 'voice' | 'music', blob: Blob | null): Promise<void> {
    const key = kind + ':' + this.project.id;
    if (blob) await db.blobs.put({ key, projectId: this.project.id, blob });
    else await db.blobs.delete(key);
    if (kind === 'voice') this.voiceBlob = blob;
    else this.musicBlob = blob;
    this.persistMeta();
  }
}

export const S = new Store();
