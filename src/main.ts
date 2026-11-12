import './style.css';
import { registerSW } from 'virtual:pwa-register';
import { S, MAX_LAYERS, uid, type LayerData, type SfxKind } from './state';
import { E, type Tool } from './engine';
import { initStrip, renderStrip, refreshActiveThumb, scrollToActive, closeFrameMenu } from './frames';
import { player } from './playback';
import { Audio, totalDurationSec } from './audio';
import { exportGif, exportVideo, deliver } from './exporter';

registerSW({ immediate: true });

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => document.getElementById(id) as HTMLInputElement;

let importTarget: 'frame' | 'bg' = 'frame';
let toastTimer: ReturnType<typeof setTimeout> | null = null;

function toast(msg: string): void {
  const t = $('toast');
  t.textContent = msg;
  t.classList.remove('hidden');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add('hidden'), 2200);
}

// ---------------- panels ----------------

const PANELS = ['panelOnion', 'panelLayers', 'panelBrush', 'panelGuides', 'panelSound'];
const SHEETS = ['sheetExport', 'sheetProjects'];

function closeOverlays(): void {
  for (const id of [...PANELS, ...SHEETS]) $(id).classList.add('hidden');
  closeFrameMenu();
  $('scrim').classList.add('hidden');
}

function openPanel(id: string): void {
  const el = $(id);
  const wasOpen = !el.classList.contains('hidden');
  closeOverlays();
  if (wasOpen) return;
  el.classList.remove('hidden');
  $('scrim').classList.remove('hidden');
}

// ---------------- meta / badges ----------------

function updateMeta(): void {
  const n = S.project.frames.length;
  $('projectName').textContent = S.project.name;
  $('projectMeta').textContent = `${n} frame${n === 1 ? '' : 's'} · ${S.project.fps} fps`;
  $('stripShowCount').textContent = String(n);
  const onion = S.project.onion;
  $('onionPct').textContent = Math.round(onion.opacity * 100) + '%';
  $('btnOnion').classList.toggle('on', onion.on);
  const badge = $('ghostBadge');
  if (onion.on && S.current > 0) {
    const from = Math.max(1, S.current - onion.count + 1);
    const label = onion.count === 1 || from === S.current ? `FRAME ${S.current}` : `FRAMES ${from}–${S.current}`;
    badge.textContent = `GHOST · ${label} · ${Math.round(onion.opacity * 100)}%`;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ---------------- colors ----------------

function renderColors(): void {
  const wrap = $('colors');
  wrap.innerHTML = '';
  for (const c of S.project.palette.slice(0, 7)) {
    const b = document.createElement('button');
    b.className = 'colordot' + (c.toLowerCase() === E.color.toLowerCase() ? ' active' : '');
    b.style.background = c;
    if (c.toLowerCase() === '#ffffff') b.style.border = '1px solid var(--line-soft)';
    b.setAttribute('aria-label', 'Color ' + c);
    b.addEventListener('click', () => {
      E.color = c;
      renderColors();
    });
    wrap.appendChild(b);
  }
  const add = document.createElement('button');
  add.className = 'colordot add';
  add.setAttribute('aria-label', 'More colors');
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
  add.addEventListener('click', () => input('colorInput').click());
  wrap.appendChild(add);
}

function useCustomColor(hex: string): void {
  E.color = hex;
  const pal = S.project.palette;
  const i = pal.findIndex((c) => c.toLowerCase() === hex.toLowerCase());
  if (i === -1) {
    pal.splice(1, 0, hex);
    if (pal.length > 7) pal.splice(7, pal.length - 7);
  }
  S.persistMeta();
  renderColors();
}

// ---------------- tools ----------------

function syncTools(): void {
  document.querySelectorAll<HTMLButtonElement>('#tools .toolbtn[data-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.tool === E.tool);
  });
}

function wireTools(): void {
  document.querySelectorAll<HTMLButtonElement>('#tools .toolbtn[data-tool]').forEach((b) => {
    b.addEventListener('click', () => {
      const t = b.dataset.tool as Tool;
      if (E.tool === t && ['pen', 'pencil', 'marker', 'eraser', 'shapes'].includes(t)) {
        $('brushTitle').textContent = t === 'shapes' ? 'Shapes' : t[0].toUpperCase() + t.slice(1);
        $('shapeKindRow').style.display = t === 'shapes' ? '' : 'none';
        ($('shapeKind') as HTMLElement).style.display = t === 'shapes' ? '' : 'none';
        openPanel('panelBrush');
        return;
      }
      E.setTool(t);
      syncTools();
      if (t === 'picker') toast('Tap the canvas to pick a color');
      if (t === 'lasso') toast('Draw around the part you want to move');
    });
  });
  $('btnGuides').addEventListener('click', () => openPanel('panelGuides'));
  $('btnUndo').addEventListener('click', () => E.undo());
  $('btnRedo').addEventListener('click', () => E.redo());
}

// ---------------- layers panel ----------------

function layerThumbCanvas(src: HTMLCanvasElement | undefined): HTMLCanvasElement {
  const t = document.createElement('canvas');
  t.width = 48;
  t.height = 36;
  const ctx = t.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, 48, 36);
  if (src) ctx.drawImage(src, 0, 0, 48, 36);
  return t;
}

function eyeSvg(on: boolean): string {
  return on
    ? '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7-10-7-10-7z"/><path d="M4 4l16 16"/></svg>';
}

function renderLayers(): void {
  const list = $('layerList');
  list.innerHTML = '';
  const f = S.frame;
  const rows = [...f.layers].reverse();
  for (const l of rows) list.appendChild(layerRow(l));
  list.appendChild(bgRow());
}

function layerRow(l: LayerData): HTMLElement {
  const row = document.createElement('div');
  row.className = 'layer-row' + (S.activeLayerId === l.id ? ' active' : '');
  const th = document.createElement('div');
  th.className = 'layer-thumb';
  th.appendChild(layerThumbCanvas(S.live.get(l.id)));
  row.appendChild(th);
  const nm = document.createElement('div');
  nm.className = 'layer-name';
  nm.innerHTML = `<div class="nm">${l.name}</div><div class="sub">${Math.round(l.opacity * 100)}%${l.visible ? '' : ' · hidden'}</div>`;
  row.appendChild(nm);
  const eye = document.createElement('button');
  eye.className = 'iconbtn small' + (l.visible ? '' : ' dim');
  eye.setAttribute('aria-label', l.visible ? 'Hide layer' : 'Show layer');
  eye.innerHTML = eyeSvg(l.visible);
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    l.visible = !l.visible;
    S.persistMeta();
    S.invalidateFrame(S.frame.id);
    E.render();
    renderLayers();
    void refreshActiveThumb();
  });
  row.appendChild(eye);
  row.addEventListener('click', () => {
    S.activeLayerId = l.id;
    renderLayers();
  });

  if (S.activeLayerId !== l.id) return row;
  const wrap = document.createElement('div');
  wrap.appendChild(row);
  wrap.appendChild(layerControls(l));
  return wrap;
}

function layerControls(l: LayerData): HTMLElement {
  const f = S.frame;
  const ctrl = document.createElement('div');
  ctrl.className = 'layer-ctrl';
  const op = document.createElement('input');
  op.type = 'range';
  op.min = '10';
  op.max = '100';
  op.value = String(Math.round(l.opacity * 100));
  op.setAttribute('aria-label', 'Layer opacity');
  op.addEventListener('input', () => {
    l.opacity = Number(op.value) / 100;
    S.persistMeta();
    S.invalidateFrame(f.id);
    E.render();
  });
  op.addEventListener('change', () => {
    renderLayers();
    void refreshActiveThumb();
  });
  ctrl.appendChild(op);

  const idx = f.layers.findIndex((x) => x.id === l.id);
  const mk = (label: string, svg: string, fn: () => void, disabled = false): void => {
    const b = document.createElement('button');
    b.className = 'iconbtn small';
    b.setAttribute('aria-label', label);
    b.innerHTML = svg;
    if (disabled) b.style.opacity = '0.35';
    else b.addEventListener('click', fn);
    ctrl.appendChild(b);
  };
  mk('Move layer up', '<svg viewBox="0 0 24 24"><path d="M6 15l6-6 6 6"/></svg>', () => {
    f.layers.splice(idx, 1);
    f.layers.splice(idx + 1, 0, l);
    afterLayerStructureChange();
  }, idx === f.layers.length - 1);
  mk('Move layer down', '<svg viewBox="0 0 24 24"><path d="M6 9l6 6 6-6"/></svg>', () => {
    f.layers.splice(idx, 1);
    f.layers.splice(idx - 1, 0, l);
    afterLayerStructureChange();
  }, idx === 0);
  mk('Delete layer', '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>', () => {
    if (f.layers.length <= 1) {
      toast('A frame needs at least one layer');
      return;
    }
    if (!confirm(`Delete layer "${l.name}"?`)) return;
    f.layers.splice(idx, 1);
    S.live.delete(l.id);
    S.activeLayerId = f.layers[Math.max(0, idx - 1)].id;
    afterLayerStructureChange();
  });
  return ctrl;
}

function afterLayerStructureChange(): void {
  S.persistMeta();
  S.invalidateFrame(S.frame.id);
  E.render();
  renderLayers();
  void refreshActiveThumb();
}

function bgRow(): HTMLElement {
  const active = S.activeLayerId === 'bg';
  const row = document.createElement('div');
  row.className = 'layer-row' + (active ? ' active' : '');
  const th = document.createElement('div');
  th.className = 'layer-thumb';
  th.appendChild(layerThumbCanvas(S.live.get('bg')));
  row.appendChild(th);
  const nm = document.createElement('div');
  nm.className = 'layer-name';
  nm.innerHTML = `<div class="nm">Background</div><div class="sub">under every frame · ${Math.round(S.project.bg.opacity * 100)}%</div>`;
  row.appendChild(nm);
  const photo = document.createElement('button');
  photo.className = 'iconbtn small';
  photo.setAttribute('aria-label', 'Set background from a photo');
  photo.innerHTML = '<svg viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/><path d="M3 17l6-6 4 4 3-3 5 5"/></svg>';
  photo.addEventListener('click', (e) => {
    e.stopPropagation();
    importTarget = 'bg';
    input('filePhotos').click();
  });
  row.appendChild(photo);
  const eye = document.createElement('button');
  eye.className = 'iconbtn small' + (S.project.bg.visible ? '' : ' dim');
  eye.setAttribute('aria-label', 'Toggle background');
  eye.innerHTML = eyeSvg(S.project.bg.visible);
  eye.addEventListener('click', (e) => {
    e.stopPropagation();
    S.project.bg.visible = !S.project.bg.visible;
    S.persistMeta();
    E.render();
    renderLayers();
    void refreshActiveThumb();
  });
  row.appendChild(eye);
  row.addEventListener('click', () => {
    S.activeLayerId = 'bg';
    renderLayers();
    toast('Drawing on the background now');
  });
  if (!active) return row;
  const wrap = document.createElement('div');
  wrap.appendChild(row);
  const ctrl = document.createElement('div');
  ctrl.className = 'layer-ctrl';
  const op = document.createElement('input');
  op.type = 'range';
  op.min = '10';
  op.max = '100';
  op.value = String(Math.round(S.project.bg.opacity * 100));
  op.setAttribute('aria-label', 'Background opacity');
  op.addEventListener('input', () => {
    S.project.bg.opacity = Number(op.value) / 100;
    S.persistMeta();
    E.render();
  });
  ctrl.appendChild(op);
  wrap.appendChild(ctrl);
  return wrap;
}

function wireLayersPanel(): void {
  $('btnLayers').addEventListener('click', () => {
    renderLayers();
    openPanel('panelLayers');
  });
  $('btnAddLayer').addEventListener('click', () => {
    const f = S.frame;
    if (f.layers.length >= MAX_LAYERS) {
      toast(`Up to ${MAX_LAYERS} layers per frame`);
      return;
    }
    const idx = S.activeLayerId === 'bg' ? f.layers.length - 1 : f.layers.findIndex((x) => x.id === S.activeLayerId);
    const nl: LayerData = { id: uid(), name: 'Layer ' + (f.layers.length + 1), visible: true, opacity: 1 };
    f.layers.splice(idx + 1, 0, nl);
    S.activeLayerId = nl.id;
    afterLayerStructureChange();
  });
}

// ---------------- onion panel ----------------

function syncOnionPanel(): void {
  const o = S.project.onion;
  $('onionToggle').classList.toggle('on', o.on);
  input('onionOpacity').value = String(Math.round(o.opacity * 100));
  $('onionOpVal').textContent = Math.round(o.opacity * 100) + '%';
  document.querySelectorAll<HTMLButtonElement>('#onionCount button').forEach((b) => {
    b.classList.toggle('active', Number(b.dataset.v) === o.count);
  });
}

function wireOnion(): void {
  $('btnOnion').addEventListener('click', () => {
    syncOnionPanel();
    openPanel('panelOnion');
  });
  $('onionToggle').addEventListener('click', () => {
    S.project.onion.on = !S.project.onion.on;
    S.persistMeta();
    syncOnionPanel();
    updateMeta();
    E.render();
  });
  input('onionOpacity').addEventListener('input', () => {
    S.project.onion.opacity = Number(input('onionOpacity').value) / 100;
    S.persistMeta();
    syncOnionPanel();
    updateMeta();
    E.render();
  });
  document.querySelectorAll<HTMLButtonElement>('#onionCount button').forEach((b) => {
    b.addEventListener('click', () => {
      S.project.onion.count = Number(b.dataset.v);
      S.persistMeta();
      syncOnionPanel();
      updateMeta();
      void S.warmOnion().then(() => E.render());
    });
  });
}

// ---------------- brush panel ----------------

function wireBrush(): void {
  const size = input('brushSize');
  size.addEventListener('input', () => {
    E.size = Number(size.value);
    $('brushSizeVal').textContent = E.size + ' px';
    const dot = document.querySelector<HTMLElement>('#brushPreview span')!;
    const d = Math.min(30, Math.max(3, E.size * 0.5));
    dot.style.width = d + 'px';
    dot.style.height = d + 'px';
  });
  $('pressureToggle').addEventListener('click', () => {
    E.pressureOn = !E.pressureOn;
    $('pressureToggle').classList.toggle('on', E.pressureOn);
  });
  document.querySelectorAll<HTMLButtonElement>('#shapeKind button').forEach((b) => {
    b.addEventListener('click', () => {
      E.shapeKind = b.dataset.v as typeof E.shapeKind;
      document.querySelectorAll('#shapeKind button').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
}

// ---------------- guides panel ----------------

function wireGuides(): void {
  $('gridToggle').addEventListener('click', () => {
    E.grid = !E.grid;
    $('gridToggle').classList.toggle('on', E.grid);
    E.renderOverlay();
  });
  document.querySelectorAll<HTMLButtonElement>('#symChips button').forEach((b) => {
    b.addEventListener('click', () => {
      E.sym = b.dataset.v as typeof E.sym;
      document.querySelectorAll('#symChips button').forEach((x) => x.classList.toggle('active', x === b));
      E.renderOverlay();
    });
  });
  document.querySelectorAll<HTMLButtonElement>('#perspChips button').forEach((b) => {
    b.addEventListener('click', () => {
      E.persp = b.dataset.v as typeof E.persp;
      document.querySelectorAll('#perspChips button').forEach((x) => x.classList.toggle('active', x === b));
      E.renderOverlay();
    });
  });
}

// ---------------- sound panel ----------------

function syncSound(): void {
  $('recLabel').textContent = Audio.recording ? 'Stop' : S.voiceBlob ? 'Re-record' : 'Record';
  document.querySelector('#btnRecVoice')!.classList.toggle('recording', Audio.recording);
  $('voiceInfo').textContent = S.voiceBlob ? `plays from frame ${S.project.voiceStart + 1}` : 'none yet';
  $('btnClearVoice').classList.toggle('hidden', !S.voiceBlob);
  $('musicInfo').textContent = S.musicBlob ? (S.musicName || 'added') : 'none yet';
  $('btnClearMusic').classList.toggle('hidden', !S.musicBlob);
  $('soundMeta').textContent = `${S.project.frames.length} frames · ${totalDurationSec().toFixed(1)} s`;
  const list = $('sfxList');
  list.innerHTML = '';
  for (const fx of S.project.sfx) {
    const tag = document.createElement('span');
    tag.className = 'sfxtag';
    tag.innerHTML = `${fx.kind[0].toUpperCase() + fx.kind.slice(1)} · frame ${fx.frame + 1} `;
    const x = document.createElement('button');
    x.setAttribute('aria-label', 'Remove effect');
    x.innerHTML = '<svg viewBox="0 0 24 24"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>';
    x.addEventListener('click', () => {
      S.project.sfx = S.project.sfx.filter((z) => z.id !== fx.id);
      S.persistMeta();
      syncSound();
    });
    tag.appendChild(x);
    list.appendChild(tag);
  }
}

function wireSound(): void {
  $('btnSound').addEventListener('click', () => {
    syncSound();
    openPanel('panelSound');
  });
  $('btnRecVoice').addEventListener('click', () => {
    void Audio.toggleRecord().then((r) => {
      if (r === 'denied') toast('Microphone access was blocked');
      if (r === 'started') toast('Recording… tap Stop when done');
      syncSound();
    });
  });
  Audio.onVoiceSaved = () => {
    toast('Voice recorded');
    syncSound();
  };
  $('btnClearVoice').addEventListener('click', () => {
    void S.saveAudio('voice', null).then(syncSound);
  });
  $('btnAddMusic').addEventListener('click', () => input('fileMusic').click());
  input('fileMusic').addEventListener('change', () => {
    const f = input('fileMusic').files?.[0];
    if (!f) return;
    S.musicName = f.name;
    void S.saveAudio('music', f).then(() => {
      toast('Music added');
      syncSound();
    });
    input('fileMusic').value = '';
  });
  $('btnClearMusic').addEventListener('click', () => {
    void S.saveAudio('music', null).then(syncSound);
  });
  document.querySelectorAll<HTMLButtonElement>('.chipbtn.sfx').forEach((b) => {
    b.addEventListener('click', () => {
      const kind = b.dataset.sfx as SfxKind;
      Audio.playSfx(kind);
      S.project.sfx.push({ id: uid(), kind, frame: S.current });
      S.persistMeta();
      syncSound();
      toast(`${kind[0].toUpperCase() + kind.slice(1)} placed on frame ${S.current + 1}`);
    });
  });
}

// ---------------- photo import ----------------

async function fileToBitmap(file: File): Promise<ImageBitmap> {
  return createImageBitmap(file);
}

function drawCover(ctx: CanvasRenderingContext2D, img: ImageBitmap, w: number, h: number): void {
  const s = Math.max(w / img.width, h / img.height);
  const dw = img.width * s;
  const dh = img.height * s;
  ctx.drawImage(img, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

async function importPhoto(file: File): Promise<void> {
  let bmp: ImageBitmap;
  try {
    bmp = await fileToBitmap(file);
  } catch {
    toast('Could not read that image');
    return;
  }
  if (importTarget === 'bg') {
    const c = S.layerCanvas('bg');
    const ctx = c.getContext('2d')!;
    ctx.clearRect(0, 0, c.width, c.height);
    drawCover(ctx, c ? bmp : bmp, c.width, c.height);
    S.markLayerDirty('bg');
    await S.flushLayerSaves();
    E.render();
    renderLayers();
    void refreshActiveThumb();
    toast('Background set from photo');
  } else {
    await S.addFrame(S.current);
    const f = S.frame;
    const photoLayer: LayerData = { id: uid(), name: 'Photo', visible: true, opacity: 1 };
    f.layers.unshift(photoLayer);
    const c = S.layerCanvas(photoLayer.id);
    drawCover(c.getContext('2d')!, bmp, c.width, c.height);
    S.markLayerDirty(photoLayer.id);
    await S.flushLayerSaves();
    S.activeLayerId = f.layers[f.layers.length - 1].id;
    afterFrameChange();
    renderStrip();
    scrollToActive();
    toast('Photo added as a new frame — draw on top of it');
  }
  bmp.close();
}

function wireImport(): void {
  $('btnCamera').addEventListener('click', () => {
    importTarget = 'frame';
    input('fileCamera').click();
  });
  $('btnPhotos').addEventListener('click', () => {
    importTarget = 'frame';
    input('filePhotos').click();
  });
  for (const id of ['fileCamera', 'filePhotos']) {
    input(id).addEventListener('change', () => {
      const f = input(id).files?.[0];
      if (f) void importPhoto(f);
      input(id).value = '';
    });
  }
}

// ---------------- export sheet ----------------

let exporting = false;

async function drawExportThumb(): Promise<void> {
  const c = $('exportThumb') as unknown as HTMLCanvasElement;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  const bg = S.live.get('bg');
  if (bg && S.project.bg.visible) ctx.drawImage(bg, 0, 0, c.width, c.height);
  const comp = await S.compositeOf(S.current);
  if (comp) ctx.drawImage(comp, 0, 0, c.width, c.height);
}

function exportSizeW(): number {
  const active = document.querySelector<HTMLButtonElement>('#exportSize button.active');
  return Number(active?.dataset.v ?? 480);
}

function setProgress(done: number, total: number, label: string): void {
  $('exportProgress').classList.remove('hidden');
  $('exportProgressBar').style.width = Math.round((done / total) * 100) + '%';
  $('exportProgressTxt').textContent = `${label} ${done}/${total}`;
}

function wireExport(): void {
  $('btnExport').addEventListener('click', () => {
    void drawExportThumb();
    $('exportName').textContent = S.project.name;
    $('exportMeta').textContent = `${S.project.frames.length} frames · ${totalDurationSec().toFixed(1)} s · ${S.project.fps} fps`;
    $('exportProgress').classList.add('hidden');
    openPanel('sheetExport');
  });
  $('btnExportCancel').addEventListener('click', closeOverlays);
  document.querySelectorAll<HTMLButtonElement>('#exportSize button').forEach((b) => {
    b.addEventListener('click', () => {
      document.querySelectorAll('#exportSize button').forEach((x) => x.classList.toggle('active', x === b));
    });
  });
  $('btnExportGif').addEventListener('click', () => void runExport('gif'));
  $('btnExportVideo').addEventListener('click', () => void runExport('video'));
}

async function runExport(kind: 'gif' | 'video'): Promise<void> {
  if (exporting) return;
  exporting = true;
  try {
    await S.flushLayerSaves();
    const name = S.project.name.replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-') || 'cartoon';
    if (kind === 'gif') {
      const blob = await exportGif(exportSizeW(), setProgress);
      $('exportProgressTxt').textContent = 'Done!';
      const how = await deliver(blob, name + '.gif');
      toast(how === 'shared' ? 'Shared!' : 'GIF saved');
    } else {
      const { blob, ext } = await exportVideo(exportSizeW(), setProgress);
      $('exportProgressTxt').textContent = 'Done!';
      const how = await deliver(blob, name + '.' + ext);
      toast(how === 'shared' ? 'Shared!' : 'Video saved');
    }
  } catch (err) {
    console.error(err);
    toast('Export failed — try a smaller size');
  } finally {
    exporting = false;
  }
}

// ---------------- projects sheet ----------------

async function renderProjects(): Promise<void> {
  const list = $('projectList');
  list.innerHTML = '';
  const all = await S.listProjects();
  for (const p of all) {
    const row = document.createElement('div');
    row.className = 'project-row' + (p.id === S.project.id ? ' current' : '');
    const th = document.createElement('div');
    th.className = 'pthumb';
    if (p.thumb) {
      const img = document.createElement('img');
      img.src = p.thumb;
      img.alt = '';
      th.appendChild(img);
    }
    row.appendChild(th);
    const info = document.createElement('div');
    info.className = 'pinfo';
    info.innerHTML = `<div class="strong">${p.name}</div><div class="panel-hint tight">${new Date(p.updatedAt).toLocaleDateString()}</div>`;
    row.appendChild(info);
    const del = document.createElement('button');
    del.className = 'iconbtn small';
    del.setAttribute('aria-label', 'Delete cartoon');
    del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M4 7h16"/><path d="M9 7V4h6v3"/><path d="M6 7l1 13h10l1-13"/></svg>';
    del.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete "${p.name}" forever? This cannot be undone.`)) return;
      await S.deleteProject(p.id);
      if (p.id === S.project.id) {
        await S.loadLastOrNew();
        afterProjectOpen();
      }
      void renderProjects();
    });
    row.appendChild(del);
    row.addEventListener('click', async () => {
      if (p.id === S.project.id) {
        closeOverlays();
        return;
      }
      await S.flushLayerSaves();
      await S.openProject(p.id);
      afterProjectOpen();
      closeOverlays();
    });
    list.appendChild(row);
  }
}

function wireProjects(): void {
  $('btnProjects').addEventListener('click', () => {
    void renderProjects();
    openPanel('sheetProjects');
  });
  $('btnProjectsClose').addEventListener('click', closeOverlays);
  $('btnNewProject').addEventListener('click', async () => {
    const name = prompt('Name your cartoon:', 'My Cartoon');
    if (name === null) return;
    await S.flushLayerSaves();
    await S.newProject(name.trim() || 'My Cartoon');
    afterProjectOpen();
    closeOverlays();
  });
  $('projectName').addEventListener('click', () => {
    const name = prompt('Rename cartoon:', S.project.name);
    if (name === null) return;
    S.project.name = name.trim() || S.project.name;
    S.persistMeta();
    updateMeta();
  });
}

// ---------------- strip show/hide ----------------

function wireStripToggle(): void {
  $('btnStripToggle').addEventListener('click', () => {
    $('stripWrap').classList.add('hidden');
    $('stripBar').classList.add('hidden');
    $('stripShow').classList.remove('hidden');
  });
  $('stripShow').addEventListener('click', () => {
    $('stripWrap').classList.remove('hidden');
    $('stripBar').classList.remove('hidden');
    $('stripShow').classList.add('hidden');
    renderStrip();
    scrollToActive();
  });
}

// ---------------- frame change plumbing ----------------

function afterFrameChange(): void {
  E.clearHistory();
  updateMeta();
  void S.warmOnion().then(() => E.render());
  E.render();
  if (!$('panelLayers').classList.contains('hidden')) renderLayers();
}

function afterProjectOpen(): void {
  E.clearHistory();
  E.sel = null;
  renderStrip();
  renderColors();
  afterFrameChange();
  updateMeta();
  scrollToActive();
}

// ---------------- selection toolbar ----------------

function wireSelection(): void {
  E.onSelectionChange = (active) => {
    $('selToolbar').classList.toggle('hidden', !active);
  };
  document.querySelectorAll<HTMLButtonElement>('#selToolbar button[data-selact]').forEach((b) => {
    b.addEventListener('click', () => {
      E.selAction(b.dataset.selact as 'flipH' | 'dup' | 'del' | 'done');
      if (b.dataset.selact === 'dup') toast('Copy stamped — drag to place the original');
    });
  });
}

// ---------------- boot ----------------

async function boot(): Promise<void> {
  await S.loadLastOrNew();
  S.onFramesChanged = () => renderStrip();

  E.init(
    $('paper') as unknown as HTMLCanvasElement,
    $('overlay') as unknown as HTMLCanvasElement,
    $('stage')
  );

  initStrip({
    onFrame: afterFrameChange,
    onMeta: () => {
      updateMeta();
      syncSound();
    }
  });
  player.init();
  player.onClose = () => {
    E.render();
    renderStrip();
    updateMeta();
  };
  player.onFpsChange = updateMeta;

  let thumbTimer: ReturnType<typeof setTimeout> | null = null;
  E.onChange = () => {
    updateMeta();
    if (thumbTimer) clearTimeout(thumbTimer);
    thumbTimer = setTimeout(() => {
      if (S.activeLayerId === 'bg') {
        S.thumbs.clear();
        void S.warmThumbs();
      } else {
        void refreshActiveThumb();
      }
    }, 500);
  };
  E.onColorPicked = (c) => {
    useCustomColor(c);
    syncTools();
    toast('Color picked');
  };

  wireTools();
  wireBrush();
  wireGuides();
  wireOnion();
  wireLayersPanel();
  wireSound();
  wireImport();
  wireExport();
  wireProjects();
  wireSelection();
  wireStripToggle();

  input('colorInput').addEventListener('change', () => useCustomColor(input('colorInput').value));
  $('scrim').addEventListener('click', closeOverlays);

  $('zoomIn').addEventListener('click', () => E.zoomBy(1.5));
  $('zoomOut').addEventListener('click', () => E.zoomBy(1 / 1.5));
  $('zoomPct').addEventListener('click', () => E.zoomReset());
  E.onViewChange = () => {
    $('zoomPct').textContent = E.zoomPct + '%';
    $('zoomPct').classList.toggle('zoomed', E.zoomPct !== 100);
  };

  $('btnSaveFrame').addEventListener('click', async () => {
    await S.flushLayerSaves();
    await refreshActiveThumb();
    await S.addFrame(S.current);
    afterFrameChange();
    renderStrip();
    scrollToActive();
    toast('Saved! Draw the next frame over the ghost');
  });

  $('btnPlay').addEventListener('click', async () => {
    await S.flushLayerSaves();
    E.commitSelection();
    player.openPlayer();
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) E.redo();
      else E.undo();
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) void S.flushLayerSaves();
  });
  window.addEventListener('pagehide', () => void S.flushLayerSaves());

  renderColors();
  renderStrip();
  afterFrameChange();
  updateMeta();
}

void boot();
