import { S, PW, PH, blankCanvas } from './state';
import { floodFill } from './fill';

export type Tool = 'pen' | 'pencil' | 'marker' | 'fill' | 'shapes' | 'eraser' | 'lasso' | 'picker';
export type SymMode = 'off' | 'v' | 'h' | 'm';
export type PerspMode = 'off' | '1' | '2';
export type ShapeKind = 'line' | 'rect' | 'ellipse';

interface Pt {
  x: number;
  y: number;
}

interface Sel {
  canvas: HTMLCanvasElement;
  w: number;
  h: number;
  cx: number;
  cy: number;
  scale: number;
  rot: number;
}

const TOOL_ALPHA: Record<string, number> = { pen: 1, pencil: 0.7, marker: 0.4 };
const TOOL_MUL: Record<string, number> = { pen: 1, pencil: 0.9, marker: 2.2, eraser: 1.6 };

class Engine {
  paper!: HTMLCanvasElement;
  overlay!: HTMLCanvasElement;
  stage!: HTMLElement;
  scale = 1;
  dpr = 1;

  tool: Tool = 'pen';
  prevTool: Tool = 'pen';
  color = '#2B2B33';
  size = 6;
  pressureOn = true;
  shapeKind: ShapeKind = 'line';
  grid = false;
  sym: SymMode = 'off';
  persp: PerspMode = 'off';

  zoom = 1;
  panX = 0;
  panY = 0;
  private pointers = new Map<number, Pt>();
  private pinch: { dist0: number; zoom0: number; c0: Pt } | null = null;
  onViewChange: () => void = () => {};

  private scratch = blankCanvas();
  private strokeActive = false;
  private strokeAlpha = 1;
  private strokeErase = false;
  private last: { x: number; y: number; p: number } | null = null;
  private shapeStart: Pt | null = null;
  private shapeCur: Pt | null = null;
  private lassoPts: Pt[] | null = null;
  sel: Sel | null = null;
  private selGesture:
    | { mode: 'move' | 'scale' | 'rotate'; start: Pt; orig: Sel }
    | null = null;

  private undoStack: { layerId: string; canvas: HTMLCanvasElement }[] = [];
  private redoStack: { layerId: string; canvas: HTMLCanvasElement }[] = [];

  onChange: () => void = () => {};
  onColorPicked: (c: string) => void = () => {};
  onSelectionChange: (active: boolean) => void = () => {};

  // ---------- setup ----------

  init(paper: HTMLCanvasElement, overlay: HTMLCanvasElement, stage: HTMLElement): void {
    this.paper = paper;
    this.overlay = overlay;
    this.stage = stage;
    new ResizeObserver(() => this.fit()).observe(stage);
    this.fit();

    paper.addEventListener('pointerdown', (e) => this.onDown(e));
    paper.addEventListener('pointermove', (e) => this.onMove(e));
    paper.addEventListener('pointerup', (e) => this.onUp(e));
    paper.addEventListener('pointercancel', (e) => this.onUp(e));
    paper.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          this.zoomBy(Math.exp(-e.deltaY * 0.0022));
        } else if (this.zoom > 1) {
          this.panX += (e.shiftKey ? e.deltaY : e.deltaX) / this.viewS;
          this.panY += (e.shiftKey ? 0 : e.deltaY) / this.viewS;
          this.clampPan();
          this.render();
          this.onViewChange();
        }
      },
      { passive: false }
    );
  }

  // ---------- zoom & pan ----------

  private get viewS(): number {
    return this.scale * this.zoom;
  }

  private clampPan(): void {
    const maxX = PW - PW / this.zoom;
    const maxY = PH - PH / this.zoom;
    this.panX = Math.min(Math.max(0, maxX), Math.max(0, this.panX));
    this.panY = Math.min(Math.max(0, maxY), Math.max(0, this.panY));
  }

  zoomBy(factor: number): void {
    const cx = this.panX + PW / this.zoom / 2;
    const cy = this.panY + PH / this.zoom / 2;
    this.zoom = Math.min(8, Math.max(1, this.zoom * factor));
    this.panX = cx - PW / this.zoom / 2;
    this.panY = cy - PH / this.zoom / 2;
    this.clampPan();
    this.render();
    this.onViewChange();
  }

  zoomReset(): void {
    this.zoom = 1;
    this.panX = 0;
    this.panY = 0;
    this.render();
    this.onViewChange();
  }

  get zoomPct(): number {
    return Math.round(this.zoom * 100);
  }

  private startPinch(): void {
    this.cancelStrokeForPinch();
    const [a, b] = [...this.pointers.values()];
    const dist0 = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    this.pinch = {
      dist0,
      zoom0: this.zoom,
      c0: { x: cx / this.viewS + this.panX, y: cy / this.viewS + this.panY }
    };
  }

  private applyPinch(): void {
    const [a, b] = [...this.pointers.values()];
    const p = this.pinch!;
    const dist = Math.max(20, Math.hypot(a.x - b.x, a.y - b.y));
    this.zoom = Math.min(8, Math.max(1, p.zoom0 * (dist / p.dist0)));
    const cx = (a.x + b.x) / 2;
    const cy = (a.y + b.y) / 2;
    this.panX = p.c0.x - cx / this.viewS;
    this.panY = p.c0.y - cy / this.viewS;
    this.clampPan();
    this.render();
    this.onViewChange();
  }

  private cancelStrokeForPinch(): void {
    if (this.strokeActive) {
      if (!this.strokeErase) this.undoStack.pop();
      this.strokeActive = false;
      this.last = null;
      this.scratch.getContext('2d')!.clearRect(0, 0, PW, PH);
    }
    this.shapeStart = null;
    this.shapeCur = null;
    this.lassoPts = null;
    this.selGesture = null;
  }

  fit(): void {
    const w = this.stage.clientWidth;
    const h = this.stage.clientHeight;
    if (w < 10 || h < 10) return;
    this.scale = Math.min(w / PW, h / PH);
    this.dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = Math.floor(PW * this.scale);
    const cssH = Math.floor(PH * this.scale);
    for (const c of [this.paper, this.overlay]) {
      c.width = Math.floor(cssW * this.dpr);
      c.height = Math.floor(cssH * this.dpr);
      c.style.width = cssW + 'px';
      c.style.height = cssH + 'px';
      c.style.left = Math.floor((w - cssW) / 2) + 'px';
      c.style.top = Math.floor((h - cssH) / 2) + 'px';
    }
    this.clampPan();
    this.render();
  }

  private toProj(e: PointerEvent): Pt {
    const r = this.paper.getBoundingClientRect();
    return {
      x: (e.clientX - r.left) / this.viewS + this.panX,
      y: (e.clientY - r.top) / this.viewS + this.panY
    };
  }

  // ---------- undo ----------

  private snapshot(layerId: string): void {
    const src = S.layerCanvas(layerId);
    const copy = blankCanvas();
    copy.getContext('2d')!.drawImage(src, 0, 0);
    this.undoStack.push({ layerId, canvas: copy });
    if (this.undoStack.length > 12) this.undoStack.shift();
    this.redoStack = [];
  }

  clearHistory(): void {
    this.undoStack = [];
    this.redoStack = [];
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }
  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  undo(): void {
    const u = this.undoStack.pop();
    if (!u) return;
    if (this.sel) this.sel = null; // selection pixels came from this state
    this.onSelectionChange(false);
    const cur = S.live.get(u.layerId);
    if (cur) {
      const copy = blankCanvas();
      copy.getContext('2d')!.drawImage(cur, 0, 0);
      this.redoStack.push({ layerId: u.layerId, canvas: copy });
      const ctx = cur.getContext('2d')!;
      ctx.clearRect(0, 0, PW, PH);
      ctx.drawImage(u.canvas, 0, 0);
      S.markLayerDirty(u.layerId);
    }
    this.render();
    this.onChange();
  }

  redo(): void {
    const r = this.redoStack.pop();
    if (!r) return;
    const cur = S.live.get(r.layerId);
    if (cur) {
      const copy = blankCanvas();
      copy.getContext('2d')!.drawImage(cur, 0, 0);
      this.undoStack.push({ layerId: r.layerId, canvas: copy });
      const ctx = cur.getContext('2d')!;
      ctx.clearRect(0, 0, PW, PH);
      ctx.drawImage(r.canvas, 0, 0);
      S.markLayerDirty(r.layerId);
    }
    this.render();
    this.onChange();
  }

  // ---------- symmetry ----------

  private symPoints(x: number, y: number): Pt[] {
    if (this.sym === 'v') return [{ x, y }, { x: PW - x, y }];
    if (this.sym === 'h') return [{ x, y }, { x, y: PH - y }];
    if (this.sym === 'm') {
      const out: Pt[] = [];
      const cx = PW / 2;
      const cy = PH / 2;
      const dx = x - cx;
      const dy = y - cy;
      for (let k = 0; k < 8; k++) {
        const a = (k * Math.PI) / 4;
        out.push({
          x: cx + dx * Math.cos(a) - dy * Math.sin(a),
          y: cy + dx * Math.sin(a) + dy * Math.cos(a)
        });
      }
      return out;
    }
    return [{ x, y }];
  }

  // ---------- pointer handling ----------

  private targetLayerCtx(): CanvasRenderingContext2D | null {
    const l = S.activeLayer;
    if (!l) return null;
    return S.layerCanvas(l.id).getContext('2d')!;
  }

  private onDown(e: PointerEvent): void {
    this.paper.setPointerCapture(e.pointerId);
    const r = this.paper.getBoundingClientRect();
    this.pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (this.pointers.size === 2) {
      this.startPinch();
      return;
    }
    if (!e.isPrimary || this.pinch) return;
    e.preventDefault();
    const p = this.toProj(e);

    if (this.sel) {
      const g = this.hitSelection(p);
      if (g) {
        this.selGesture = { mode: g, start: p, orig: { ...this.sel } };
        return;
      }
      this.commitSelection();
    }

    const layer = S.activeLayer;
    switch (this.tool) {
      case 'picker': {
        this.pickColor(p);
        return;
      }
      case 'fill': {
        if (!layer) return;
        this.snapshot(layer.id);
        floodFill(S.layerCanvas(layer.id), p.x, p.y, this.color, 30);
        S.markLayerDirty(layer.id);
        this.render();
        this.onChange();
        return;
      }
      case 'shapes': {
        if (!layer) return;
        this.shapeStart = p;
        this.shapeCur = p;
        this.renderOverlay();
        return;
      }
      case 'lasso': {
        this.lassoPts = [p];
        this.renderOverlay();
        return;
      }
      default: {
        if (!layer || !layer.visible) return;
        this.snapshot(layer.id);
        this.strokeActive = true;
        this.strokeErase = this.tool === 'eraser';
        this.strokeAlpha = TOOL_ALPHA[this.tool] ?? 1;
        this.scratch.getContext('2d')!.clearRect(0, 0, PW, PH);
        const pr = this.pressureOf(e);
        this.last = { x: p.x, y: p.y, p: pr };
        this.stampAt(p.x, p.y, pr);
        this.render();
      }
    }
  }

  private onMove(e: PointerEvent): void {
    if (this.pointers.has(e.pointerId)) {
      const r = this.paper.getBoundingClientRect();
      this.pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    }
    if (this.pinch && this.pointers.size >= 2) {
      this.applyPinch();
      return;
    }
    if (!e.isPrimary || this.pinch) return;

    if (this.selGesture && this.sel) {
      this.applySelGesture(this.toProj(e));
      this.render();
      this.renderOverlay();
      return;
    }
    if (this.shapeStart) {
      this.shapeCur = this.toProj(e);
      this.renderOverlay();
      return;
    }
    if (this.lassoPts) {
      this.lassoPts.push(this.toProj(e));
      this.renderOverlay();
      return;
    }
    if (!this.strokeActive || !this.last) return;

    const events = typeof e.getCoalescedEvents === 'function' ? e.getCoalescedEvents() : [e];
    for (const ev of events) {
      const p = this.toProj(ev as PointerEvent);
      const pr = this.pressureOf(ev as PointerEvent);
      this.stampSegment(this.last, { x: p.x, y: p.y, p: pr });
      this.last = { x: p.x, y: p.y, p: pr };
    }
    this.render();
  }

  private onUp(e: PointerEvent): void {
    this.pointers.delete(e.pointerId);
    if (this.pinch) {
      if (this.pointers.size < 2) this.pinch = null;
      return;
    }
    if (!e.isPrimary) return;

    if (this.selGesture) {
      this.selGesture = null;
      return;
    }
    if (this.shapeStart && this.shapeCur) {
      this.commitShape();
      return;
    }
    if (this.lassoPts) {
      this.finishLasso();
      return;
    }
    if (this.strokeActive) {
      const layer = S.activeLayer;
      if (layer) {
        if (!this.strokeErase) {
          const ctx = S.layerCanvas(layer.id).getContext('2d')!;
          ctx.globalAlpha = this.strokeAlpha;
          ctx.drawImage(this.scratch, 0, 0);
          ctx.globalAlpha = 1;
        }
        S.markLayerDirty(layer.id);
      }
      this.strokeActive = false;
      this.last = null;
      this.scratch.getContext('2d')!.clearRect(0, 0, PW, PH);
      this.render();
      this.onChange();
    }
  }

  private pressureOf(e: PointerEvent): number {
    if (!this.pressureOn) return 0.6;
    const p = e.pressure && e.pressure > 0 ? e.pressure : 0.5;
    return Math.min(1, Math.max(0.05, p));
  }

  private widthFor(pressure: number): number {
    const mul = TOOL_MUL[this.tool] ?? 1;
    const base = this.size * mul;
    if (!this.pressureOn) return base;
    return base * (0.35 + pressure * 0.95);
  }

  private stampAt(x: number, y: number, pressure: number): void {
    const r = Math.max(0.6, this.widthFor(pressure) / 2);
    const pts = this.symPoints(x, y);
    if (this.strokeErase) {
      const layer = S.activeLayer;
      if (!layer) return;
      const ctx = S.layerCanvas(layer.id).getContext('2d')!;
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = '#000';
      for (const pt of pts) {
        ctx.beginPath();
        ctx.arc(pt.x, pt.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.restore();
      return;
    }
    const ctx = this.scratch.getContext('2d')!;
    ctx.fillStyle = this.color;
    const jitter = this.tool === 'pencil' ? 0.7 : 0;
    for (const pt of pts) {
      const jx = jitter ? (Math.random() - 0.5) * jitter : 0;
      const jy = jitter ? (Math.random() - 0.5) * jitter : 0;
      ctx.beginPath();
      ctx.arc(pt.x + jx, pt.y + jy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private stampSegment(a: { x: number; y: number; p: number }, b: { x: number; y: number; p: number }): void {
    const dist = Math.hypot(b.x - a.x, b.y - a.y);
    const spacing = Math.max(0.75, (this.size * (TOOL_MUL[this.tool] ?? 1)) / 6);
    const steps = Math.max(1, Math.ceil(dist / spacing));
    for (let i = 1; i <= steps; i++) {
      const t = i / steps;
      this.stampAt(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.p + (b.p - a.p) * t);
    }
  }

  // ---------- shapes ----------

  private shapePath(ctx: CanvasRenderingContext2D, a: Pt, b: Pt): void {
    ctx.beginPath();
    if (this.shapeKind === 'line') {
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    } else if (this.shapeKind === 'rect') {
      ctx.rect(Math.min(a.x, b.x), Math.min(a.y, b.y), Math.abs(b.x - a.x), Math.abs(b.y - a.y));
    } else {
      ctx.ellipse((a.x + b.x) / 2, (a.y + b.y) / 2, Math.abs(b.x - a.x) / 2, Math.abs(b.y - a.y) / 2, 0, 0, Math.PI * 2);
    }
  }

  private symPairs(a: Pt, b: Pt): [Pt, Pt][] {
    const as = this.symPoints(a.x, a.y);
    const bs = this.symPoints(b.x, b.y);
    const out: [Pt, Pt][] = [];
    for (let i = 0; i < as.length; i++) out.push([as[i], bs[i]]);
    return out;
  }

  private commitShape(): void {
    const layer = S.activeLayer;
    if (layer && this.shapeStart && this.shapeCur) {
      this.snapshot(layer.id);
      const ctx = S.layerCanvas(layer.id).getContext('2d')!;
      ctx.save();
      ctx.strokeStyle = this.color;
      ctx.lineWidth = this.size;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      for (const [a, b] of this.symPairs(this.shapeStart, this.shapeCur)) {
        this.shapePath(ctx, a, b);
        ctx.stroke();
      }
      ctx.restore();
      S.markLayerDirty(layer.id);
      this.onChange();
    }
    this.shapeStart = null;
    this.shapeCur = null;
    this.render();
    this.renderOverlay();
  }

  // ---------- lasso selection ----------

  private finishLasso(): void {
    const pts = this.lassoPts;
    this.lassoPts = null;
    const layer = S.activeLayer;
    if (!pts || pts.length < 8 || !layer) {
      this.renderOverlay();
      return;
    }
    let minX = PW, minY = PH, maxX = 0, maxY = 0;
    for (const p of pts) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    minX = Math.max(0, Math.floor(minX));
    minY = Math.max(0, Math.floor(minY));
    maxX = Math.min(PW, Math.ceil(maxX));
    maxY = Math.min(PH, Math.ceil(maxY));
    const w = maxX - minX;
    const h = maxY - minY;
    if (w < 4 || h < 4) {
      this.renderOverlay();
      return;
    }
    this.snapshot(layer.id);
    const layerC = S.layerCanvas(layer.id);
    const selC = document.createElement('canvas');
    selC.width = w;
    selC.height = h;
    const sctx = selC.getContext('2d')!;
    sctx.save();
    sctx.translate(-minX, -minY);
    this.tracePath(sctx, pts);
    sctx.clip();
    sctx.drawImage(layerC, 0, 0);
    sctx.restore();

    const lctx = layerC.getContext('2d')!;
    lctx.save();
    this.tracePath(lctx, pts);
    lctx.clip();
    lctx.clearRect(minX, minY, w, h);
    lctx.restore();
    S.markLayerDirty(layer.id);

    this.sel = { canvas: selC, w, h, cx: minX + w / 2, cy: minY + h / 2, scale: 1, rot: 0 };
    this.onSelectionChange(true);
    this.render();
    this.renderOverlay();
  }

  private tracePath(ctx: CanvasRenderingContext2D, pts: Pt[]): void {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  private hitSelection(p: Pt): 'move' | 'scale' | 'rotate' | null {
    const s = this.sel!;
    // into local space
    const dx = p.x - s.cx;
    const dy = p.y - s.cy;
    const cos = Math.cos(-s.rot);
    const sin = Math.sin(-s.rot);
    const lx = (dx * cos - dy * sin) / s.scale;
    const ly = (dx * sin + dy * cos) / s.scale;
    const hw = s.w / 2;
    const hh = s.h / 2;
    const grab = 18 / this.viewS / s.scale;
    // rotate handle above top edge
    if (Math.hypot(lx, ly + hh + 34 / this.viewS / s.scale) < grab * 1.2) return 'rotate';
    for (const [cx2, cy2] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]] as [number, number][]) {
      if (Math.hypot(lx - cx2, ly - cy2) < grab) return 'scale';
    }
    if (Math.abs(lx) <= hw + grab / 2 && Math.abs(ly) <= hh + grab / 2) return 'move';
    return null;
  }

  private applySelGesture(p: Pt): void {
    const g = this.selGesture!;
    const s = this.sel!;
    if (g.mode === 'move') {
      s.cx = g.orig.cx + (p.x - g.start.x);
      s.cy = g.orig.cy + (p.y - g.start.y);
    } else if (g.mode === 'scale') {
      const d0 = Math.hypot(g.start.x - g.orig.cx, g.start.y - g.orig.cy);
      const d1 = Math.hypot(p.x - g.orig.cx, p.y - g.orig.cy);
      s.scale = Math.min(6, Math.max(0.1, g.orig.scale * (d1 / Math.max(1, d0))));
    } else {
      const a0 = Math.atan2(g.start.y - g.orig.cy, g.start.x - g.orig.cx);
      const a1 = Math.atan2(p.y - g.orig.cy, p.x - g.orig.cx);
      s.rot = g.orig.rot + (a1 - a0);
    }
  }

  selAction(act: 'flipH' | 'dup' | 'del' | 'done'): void {
    const s = this.sel;
    if (!s) return;
    if (act === 'flipH') {
      const f = document.createElement('canvas');
      f.width = s.w;
      f.height = s.h;
      const ctx = f.getContext('2d')!;
      ctx.translate(s.w, 0);
      ctx.scale(-1, 1);
      ctx.drawImage(s.canvas, 0, 0);
      s.canvas = f;
      this.render();
      return;
    }
    if (act === 'dup') {
      this.stampSelection();
      this.onChange();
      return;
    }
    if (act === 'del') {
      this.sel = null;
      this.onSelectionChange(false);
      const layer = S.activeLayer;
      if (layer) S.markLayerDirty(layer.id);
      this.render();
      this.renderOverlay();
      this.onChange();
      return;
    }
    this.commitSelection();
  }

  private stampSelection(): void {
    const s = this.sel;
    const layer = S.activeLayer;
    if (!s || !layer) return;
    const ctx = S.layerCanvas(layer.id).getContext('2d')!;
    ctx.save();
    ctx.translate(s.cx, s.cy);
    ctx.rotate(s.rot);
    ctx.scale(s.scale, s.scale);
    ctx.drawImage(s.canvas, -s.w / 2, -s.h / 2);
    ctx.restore();
    S.markLayerDirty(layer.id);
  }

  commitSelection(): void {
    if (!this.sel) return;
    this.stampSelection();
    this.sel = null;
    this.onSelectionChange(false);
    this.render();
    this.renderOverlay();
    this.onChange();
  }

  // ---------- color picking ----------

  private pickColor(p: Pt): void {
    const temp = blankCanvas();
    const ctx = temp.getContext('2d', { willReadFrequently: true })!;
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PW, PH);
    const bg = S.live.get('bg');
    if (bg && S.project.bg.visible) {
      ctx.globalAlpha = S.project.bg.opacity;
      ctx.drawImage(bg, 0, 0);
      ctx.globalAlpha = 1;
    }
    const layers = blankCanvas();
    S.compositeActive(layers);
    ctx.drawImage(layers, 0, 0);
    const d = ctx.getImageData(Math.floor(p.x), Math.floor(p.y), 1, 1).data;
    const hex =
      '#' +
      [d[0], d[1], d[2]].map((v) => v.toString(16).padStart(2, '0')).join('');
    this.color = hex;
    this.onColorPicked(hex);
    this.setTool(this.prevTool === 'picker' ? 'pen' : this.prevTool);
  }

  // ---------- tool switching ----------

  setTool(t: Tool): void {
    if (this.sel && t !== 'lasso') this.commitSelection();
    if (t !== this.tool) this.prevTool = this.tool;
    this.tool = t;
  }

  // ---------- rendering ----------

  render(): void {
    const ctx = this.paper.getContext('2d')!;
    const s = this.viewS;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#232129';
    ctx.fillRect(0, 0, this.paper.width, this.paper.height);
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, -this.dpr * s * this.panX, -this.dpr * s * this.panY);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, PW, PH);

    const bg = S.live.get('bg');
    if (bg && S.project.bg.visible) {
      ctx.globalAlpha = S.project.bg.opacity;
      ctx.drawImage(bg, 0, 0);
      ctx.globalAlpha = 1;
    }

    // onion ghosts (older frames fainter)
    const onion = S.project.onion;
    if (onion.on) {
      for (let k = onion.count; k >= 1; k--) {
        const idx = S.current - k;
        if (idx < 0) continue;
        const ghost = S.ghostOf(idx);
        if (!ghost) {
          void S.compositeOf(idx).then(() => this.render());
          continue;
        }
        ctx.globalAlpha = onion.opacity * (1 - ((k - 1) / Math.max(1, onion.count)) * 0.65);
        ctx.drawImage(ghost, 0, 0);
      }
      ctx.globalAlpha = 1;
    }

    const activeId = S.activeLayerId;
    for (const l of S.frame.layers) {
      if (l.visible) {
        const lc = S.live.get(l.id);
        if (lc) {
          ctx.globalAlpha = l.opacity;
          ctx.drawImage(lc, 0, 0);
          ctx.globalAlpha = 1;
        }
      }
      if (l.id === activeId && this.strokeActive && !this.strokeErase) {
        ctx.globalAlpha = this.strokeAlpha * (l.opacity ?? 1);
        ctx.drawImage(this.scratch, 0, 0);
        ctx.globalAlpha = 1;
      }
    }

    if (this.sel) {
      const s = this.sel;
      ctx.save();
      ctx.translate(s.cx, s.cy);
      ctx.rotate(s.rot);
      ctx.scale(s.scale, s.scale);
      ctx.drawImage(s.canvas, -s.w / 2, -s.h / 2);
      ctx.restore();
    }
    this.renderOverlay();
  }

  renderOverlay(): void {
    const ctx = this.overlay.getContext('2d')!;
    const s = this.viewS;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.overlay.width, this.overlay.height);
    ctx.setTransform(this.dpr * s, 0, 0, this.dpr * s, -this.dpr * s * this.panX, -this.dpr * s * this.panY);
    const px = 1 / s; // one screen pixel in project units

    if (this.grid) {
      ctx.strokeStyle = 'rgba(40,40,60,0.10)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (let x = 64; x < PW; x += 64) {
        ctx.moveTo(x, 0);
        ctx.lineTo(x, PH);
      }
      for (let y = 64; y < PH; y += 64) {
        ctx.moveTo(0, y);
        ctx.lineTo(PW, y);
      }
      ctx.stroke();
    }

    if (this.sym !== 'off') {
      ctx.strokeStyle = 'rgba(255,107,82,0.55)';
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([10 * px, 10 * px]);
      ctx.beginPath();
      if (this.sym === 'v' || this.sym === 'm') {
        ctx.moveTo(PW / 2, 0);
        ctx.lineTo(PW / 2, PH);
      }
      if (this.sym === 'h' || this.sym === 'm') {
        ctx.moveTo(0, PH / 2);
        ctx.lineTo(PW, PH / 2);
      }
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.persp !== 'off') {
      const vps = this.persp === '1' ? [{ x: PW / 2, y: PH * 0.4 }] : [{ x: PW * 0.08, y: PH * 0.42 }, { x: PW * 0.92, y: PH * 0.42 }];
      ctx.strokeStyle = 'rgba(60,125,255,0.22)';
      ctx.lineWidth = px;
      ctx.beginPath();
      for (const vp of vps) {
        for (let a = 0; a < Math.PI * 2; a += Math.PI / 10) {
          ctx.moveTo(vp.x, vp.y);
          ctx.lineTo(vp.x + Math.cos(a) * PW * 1.6, vp.y + Math.sin(a) * PW * 1.6);
        }
      }
      ctx.stroke();
    }

    if (this.shapeStart && this.shapeCur) {
      ctx.strokeStyle = this.color;
      ctx.globalAlpha = 0.7;
      ctx.lineWidth = this.size;
      ctx.lineCap = 'round';
      for (const [a, b] of this.symPairs(this.shapeStart, this.shapeCur)) {
        this.shapePath(ctx, a, b);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }

    if (this.lassoPts && this.lassoPts.length > 1) {
      ctx.strokeStyle = '#FF6B52';
      ctx.lineWidth = 2 * px;
      ctx.setLineDash([7 * px, 6 * px]);
      this.tracePath(ctx, this.lassoPts);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.sel) {
      const s = this.sel;
      ctx.save();
      ctx.translate(s.cx, s.cy);
      ctx.rotate(s.rot);
      ctx.scale(s.scale, s.scale);
      const hw = s.w / 2;
      const hh = s.h / 2;
      const hs = 8 * px / s.scale;
      ctx.strokeStyle = '#FF6B52';
      ctx.lineWidth = (2.5 * px) / s.scale;
      ctx.setLineDash([(7 * px) / s.scale, (6 * px) / s.scale]);
      ctx.strokeRect(-hw, -hh, s.w, s.h);
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffffff';
      for (const [hx, hy] of [[-hw, -hh], [hw, -hh], [-hw, hh], [hw, hh]] as [number, number][]) {
        ctx.beginPath();
        ctx.rect(hx - hs, hy - hs, hs * 2, hs * 2);
        ctx.fill();
        ctx.stroke();
      }
      // rotate handle
      ctx.beginPath();
      ctx.moveTo(0, -hh);
      ctx.lineTo(0, -hh - (34 * px) / s.scale);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(0, -hh - (34 * px) / s.scale, hs * 1.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
      ctx.restore();
    }
  }
}

export const E = new Engine();
