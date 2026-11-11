import { S } from './state';

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

export interface StripCallbacks {
  /** Called after the active frame changed (switch/add/delete/reorder/paste). */
  onFrame: () => void;
  /** Called when metadata (hold, count) changed but frame stayed. */
  onMeta: () => void;
}

let cb: StripCallbacks;
let menuIndex = -1;

export function initStrip(callbacks: StripCallbacks): void {
  cb = callbacks;
  const strip = $('strip');
  strip.addEventListener('scroll', updateScrollbar, { passive: true });

  $('frameMenu').addEventListener('click', (e) => e.stopPropagation());
  document.querySelectorAll<HTMLButtonElement>('#frameMenu > button[data-fact]').forEach((b) => {
    b.addEventListener('click', () => void menuAction(b.dataset.fact!));
  });
  $('holdMinus').addEventListener('click', () => changeHold(-1));
  $('holdPlus').addEventListener('click', () => changeHold(1));
}

export function closeFrameMenu(): void {
  $('frameMenu').classList.add('hidden');
  menuIndex = -1;
}

function changeHold(delta: number): void {
  if (menuIndex < 0) return;
  const f = S.project.frames[menuIndex];
  f.hold = Math.min(8, Math.max(1, f.hold + delta));
  $('holdVal').textContent = f.hold + (f.hold === 1 ? ' beat' : ' beats');
  S.persistMeta();
  renderStrip();
  cb.onMeta();
}

async function menuAction(act: string): Promise<void> {
  const i = menuIndex;
  closeFrameMenu();
  hideScrim();
  if (i < 0) return;
  if (act === 'dup') {
    const at = await S.duplicateFrame(i);
    await S.switchFrame(at);
    cb.onFrame();
  } else if (act === 'copy') {
    await S.copyFrame(i);
    cb.onMeta();
  } else if (act === 'paste') {
    const at = await S.pasteAfter(i);
    if (at >= 0) {
      await S.switchFrame(at);
      cb.onFrame();
    }
  } else if (act === 'del') {
    await S.deleteFrame(i);
    cb.onFrame();
  }
  renderStrip();
}

function hideScrim(): void {
  document.getElementById('scrim')?.classList.add('hidden');
}

function openFrameMenu(index: number, anchor: HTMLElement): void {
  menuIndex = index;
  const menu = $('frameMenu');
  const f = S.project.frames[index];
  $('frameMenuTitle').textContent = 'FRAME ' + (index + 1);
  $('holdVal').textContent = f.hold + (f.hold === 1 ? ' beat' : ' beats');
  const pasteBtn = menu.querySelector<HTMLButtonElement>('button[data-fact="paste"]')!;
  pasteBtn.disabled = !S.clipboard;
  pasteBtn.style.opacity = S.clipboard ? '1' : '0.4';
  menu.classList.remove('hidden');
  const r = anchor.getBoundingClientRect();
  const mw = 250;
  let left = Math.min(Math.max(8, r.left), window.innerWidth - mw - 8);
  menu.style.left = left + 'px';
  menu.style.top = Math.min(r.bottom + 8, window.innerHeight - 340) + 'px';
  const scrim = document.getElementById('scrim')!;
  scrim.classList.remove('hidden');
  const close = () => {
    closeFrameMenu();
    scrim.classList.add('hidden');
    scrim.removeEventListener('click', close);
  };
  scrim.addEventListener('click', close);
}

function updateScrollbar(): void {
  const strip = $('strip');
  const bar = $('stripBarInd');
  const total = strip.scrollWidth;
  const vis = strip.clientWidth;
  if (total <= vis + 2) {
    bar.style.width = '100%';
    bar.style.left = '0';
    return;
  }
  const frac = vis / total;
  const pos = strip.scrollLeft / (total - vis);
  bar.style.width = Math.max(10, frac * 100) + '%';
  bar.style.left = pos * (100 - Math.max(10, frac * 100)) + '%';
}

export function renderStrip(): void {
  const strip = $('strip');
  strip.innerHTML = '';
  const frames = S.project.frames;
  frames.forEach((f, i) => {
    const t = document.createElement('div');
    t.className = 'thumb' + (i === S.current ? ' active' : '');
    t.dataset.index = String(i);
    const img = document.createElement('img');
    img.alt = 'Frame ' + (i + 1);
    const thumb = S.thumbs.get(f.id);
    if (thumb) img.src = thumb;
    t.appendChild(img);
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    t.appendChild(num);
    if (f.hold > 1) {
      const ht = document.createElement('span');
      ht.className = 'holdtag';
      ht.textContent = '×' + f.hold;
      t.appendChild(ht);
    }
    wireThumb(t, i);
    strip.appendChild(t);
  });
  const add = document.createElement('button');
  add.className = 'addtile';
  add.setAttribute('aria-label', 'Add a new frame');
  add.innerHTML = '<svg viewBox="0 0 24 24"><path d="M12 5v14"/><path d="M5 12h14"/></svg>';
  add.addEventListener('click', () => {
    void S.addFrame().then(() => {
      renderStrip();
      cb.onFrame();
      scrollToActive();
    });
  });
  strip.appendChild(add);
  updateScrollbar();
}

export function scrollToActive(): void {
  const strip = $('strip');
  const el = strip.querySelector<HTMLElement>('.thumb.active');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

/** Tap = select; long-press = menu; long-press then drag = reorder. */
function wireThumb(el: HTMLElement, index: number): void {
  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let startX = 0;
  let startY = 0;
  let mode: 'tap' | 'menu' | 'drag' | 'cancelled' = 'tap';
  let dropAt = -1;
  let mark: HTMLElement | null = null;

  const clearMark = () => {
    mark?.remove();
    mark = null;
  };

  el.addEventListener('pointerdown', (e) => {
    startX = e.clientX;
    startY = e.clientY;
    mode = 'tap';
    pressTimer = setTimeout(() => {
      mode = 'menu';
      if (navigator.vibrate) navigator.vibrate(10);
      openFrameMenu(index, el);
    }, 480);
  });

  el.addEventListener('pointermove', (e) => {
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    if (mode === 'tap' && Math.hypot(dx, dy) > 10) {
      // horizontal pan = native scroll; cancel everything
      if (pressTimer) clearTimeout(pressTimer);
      mode = 'cancelled';
      return;
    }
    if ((mode === 'menu' || mode === 'drag') && Math.hypot(dx, dy) > 12) {
      if (mode === 'menu') {
        closeFrameMenu();
        hideScrim();
        mode = 'drag';
        el.classList.add('dragging');
        el.setPointerCapture(e.pointerId);
      }
      // find insertion point
      const strip = $('strip');
      const thumbs = [...strip.querySelectorAll<HTMLElement>('.thumb')];
      dropAt = thumbs.length - 1;
      for (let i = 0; i < thumbs.length; i++) {
        const r = thumbs[i].getBoundingClientRect();
        if (e.clientX < r.left + r.width / 2) {
          dropAt = i;
          break;
        }
        dropAt = i + 1;
      }
      clearMark();
      mark = document.createElement('div');
      mark.className = 'dropmark';
      const ref = thumbs[dropAt];
      if (ref) strip.insertBefore(mark, ref);
      else strip.insertBefore(mark, strip.querySelector('.addtile'));
    }
  });

  const finish = (e: PointerEvent) => {
    if (pressTimer) clearTimeout(pressTimer);
    el.classList.remove('dragging');
    if (mode === 'drag') {
      clearMark();
      let to = dropAt;
      if (to > index) to -= 1;
      if (to >= 0 && to !== index) {
        void S.moveFrame(index, to).then(() => {
          renderStrip();
          cb.onFrame();
        });
      } else {
        renderStrip();
      }
    } else if (mode === 'tap') {
      const dx = Math.hypot(e.clientX - startX, e.clientY - startY);
      if (dx < 10 && index !== S.current) {
        void S.switchFrame(index).then(() => {
          renderStrip();
          cb.onFrame();
        });
      }
    }
    mode = 'cancelled';
  };
  el.addEventListener('pointerup', finish);
  el.addEventListener('pointercancel', () => {
    if (pressTimer) clearTimeout(pressTimer);
    el.classList.remove('dragging');
    clearMark();
    mode = 'cancelled';
  });
}

/** Refresh just the active frame's thumbnail image in place. */
export async function refreshActiveThumb(): Promise<void> {
  await S.makeThumb(S.current);
  const strip = $('strip');
  const el = strip.querySelector<HTMLImageElement>(`.thumb[data-index="${S.current}"] img`);
  const url = S.thumbs.get(S.frame.id);
  if (el && url) el.src = url;
}
