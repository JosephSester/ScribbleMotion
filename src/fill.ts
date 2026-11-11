/** Scanline flood fill on a canvas, with tolerance, writing `hex` color. */
export function floodFill(canvas: HTMLCanvasElement, sx: number, sy: number, hex: string, tolerance = 30): void {
  const w = canvas.width;
  const h = canvas.height;
  sx = Math.floor(sx);
  sy = Math.floor(sy);
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  const img = ctx.getImageData(0, 0, w, h);
  const d = img.data;
  const idx = (x: number, y: number) => (y * w + x) * 4;

  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const rgb = m ? parseInt(m[1], 16) : 0;
  const fr = (rgb >> 16) & 255;
  const fg = (rgb >> 8) & 255;
  const fb = rgb & 255;

  const si = idx(sx, sy);
  const tr = d[si], tg = d[si + 1], tb = d[si + 2], ta = d[si + 3];
  // Already the fill color?
  if (ta === 255 && tr === fr && tg === fg && tb === fb) return;

  const tol = tolerance;
  const match = (i: number): boolean => {
    const a = d[i + 3];
    if (ta < 10) return a < 10; // filling transparent area: match transparency only
    return (
      Math.abs(d[i] - tr) <= tol &&
      Math.abs(d[i + 1] - tg) <= tol &&
      Math.abs(d[i + 2] - tb) <= tol &&
      Math.abs(a - ta) <= tol
    );
  };
  const paint = (i: number): void => {
    d[i] = fr;
    d[i + 1] = fg;
    d[i + 2] = fb;
    d[i + 3] = 255;
  };

  const visited = new Uint8Array(w * h);
  const stack: number[] = [sx, sy];
  while (stack.length) {
    const y = stack.pop()!;
    let x = stack.pop()!;
    let i = idx(x, y);
    // walk left
    while (x >= 0 && !visited[y * w + x] && match(i)) {
      x--;
      i -= 4;
    }
    x++;
    i += 4;
    let spanUp = false;
    let spanDown = false;
    while (x < w && !visited[y * w + x] && match(i)) {
      paint(i);
      visited[y * w + x] = 1;
      if (y > 0) {
        const up = idx(x, y - 1);
        const ok = !visited[(y - 1) * w + x] && match(up);
        if (ok && !spanUp) {
          stack.push(x, y - 1);
          spanUp = true;
        } else if (!ok) spanUp = false;
      }
      if (y < h - 1) {
        const dn = idx(x, y + 1);
        const ok = !visited[(y + 1) * w + x] && match(dn);
        if (ok && !spanDown) {
          stack.push(x, y + 1);
          spanDown = true;
        } else if (!ok) spanDown = false;
      }
      x++;
      i += 4;
    }
  }
  ctx.putImageData(img, 0, 0);
}
