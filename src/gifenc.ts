/**
 * Minimal animated GIF89a encoder.
 * Uses a fixed 6x7x6 RGB palette (252 colors) with ordered dithering — plenty for drawings.
 */

const RL = 6, GL = 7, BL = 6; // levels per channel

function buildPalette(): Uint8Array {
  const pal = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < RL; r++)
    for (let g = 0; g < GL; g++)
      for (let b = 0; b < BL; b++) {
        pal[i * 3] = Math.round((r * 255) / (RL - 1));
        pal[i * 3 + 1] = Math.round((g * 255) / (GL - 1));
        pal[i * 3 + 2] = Math.round((b * 255) / (BL - 1));
        i++;
      }
  // remaining entries stay black
  return pal;
}

const PALETTE = buildPalette();

const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function quantize(rgba: Uint8ClampedArray, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const dith = (BAYER[(y & 3) * 4 + (x & 3)] / 16 - 0.5) * 24;
      const r = Math.min(255, Math.max(0, rgba[i] + dith));
      const g = Math.min(255, Math.max(0, rgba[i + 1] + dith));
      const b = Math.min(255, Math.max(0, rgba[i + 2] + dith));
      const ri = Math.round((r * (RL - 1)) / 255);
      const gi = Math.round((g * (GL - 1)) / 255);
      const bi = Math.round((b * (BL - 1)) / 255);
      out[y * w + x] = ri * GL * BL + gi * BL + bi;
    }
  }
  return out;
}

class ByteBuf {
  private chunks: number[] = [];
  byte(b: number): void {
    this.chunks.push(b & 0xff);
  }
  short(v: number): void {
    this.byte(v & 0xff);
    this.byte((v >> 8) & 0xff);
  }
  bytes(arr: ArrayLike<number>): void {
    for (let i = 0; i < arr.length; i++) this.byte(arr[i]);
  }
  str(s: string): void {
    for (let i = 0; i < s.length; i++) this.byte(s.charCodeAt(i));
  }
  toUint8(): Uint8Array {
    return Uint8Array.from(this.chunks);
  }
}

/** LZW encode indexed pixels into GIF image data sub-blocks. */
function lzw(minCodeSize: number, pixels: Uint8Array, buf: ByteBuf): void {
  const clearCode = 1 << minCodeSize;
  const eoi = clearCode + 1;
  let codeSize = minCodeSize + 1;
  let dict = new Map<string, number>();
  let next = eoi + 1;

  const reset = () => {
    dict = new Map();
    next = eoi + 1;
    codeSize = minCodeSize + 1;
  };

  // bit packer with 255-byte sub-blocks
  let cur = 0;
  let curBits = 0;
  const block: number[] = [];
  const flushBlock = () => {
    if (block.length) {
      buf.byte(block.length);
      buf.bytes(block);
      block.length = 0;
    }
  };
  const emit = (code: number) => {
    cur |= code << curBits;
    curBits += codeSize;
    while (curBits >= 8) {
      block.push(cur & 0xff);
      cur >>= 8;
      curBits -= 8;
      if (block.length === 255) flushBlock();
    }
  };

  emit(clearCode);
  reset();
  let prefix = String.fromCharCode(pixels[0]);
  for (let i = 1; i < pixels.length; i++) {
    const c = String.fromCharCode(pixels[i]);
    const joined = prefix + c;
    if (dict.has(joined)) {
      prefix = joined;
    } else {
      const code = prefix.length === 1 ? prefix.charCodeAt(0) : dict.get(prefix)!;
      emit(code);
      dict.set(joined, next++);
      if (next === 1 << codeSize && codeSize < 12) codeSize++;
      else if (next === 4096) {
        emit(clearCode);
        reset();
      }
      prefix = c;
    }
  }
  const code = prefix.length === 1 ? prefix.charCodeAt(0) : dict.get(prefix)!;
  emit(code);
  emit(eoi);
  if (curBits > 0) {
    block.push(cur & 0xff);
    if (block.length === 255) flushBlock();
  }
  flushBlock();
  buf.byte(0); // block terminator
}

export class GifEncoder {
  private buf = new ByteBuf();
  constructor(private w: number, private h: number) {
    this.buf.str('GIF89a');
    this.buf.short(w);
    this.buf.short(h);
    this.buf.byte(0xf7); // GCT, 256 colors, 8-bit
    this.buf.byte(0);
    this.buf.byte(0);
    this.buf.bytes(PALETTE);
    // Netscape loop extension (loop forever)
    this.buf.byte(0x21);
    this.buf.byte(0xff);
    this.buf.byte(11);
    this.buf.str('NETSCAPE2.0');
    this.buf.byte(3);
    this.buf.byte(1);
    this.buf.short(0);
    this.buf.byte(0);
  }

  /** delay in hundredths of a second */
  addFrame(rgba: Uint8ClampedArray, delay: number): void {
    const b = this.buf;
    b.byte(0x21);
    b.byte(0xf9);
    b.byte(4);
    b.byte(0); // no disposal, no transparency
    b.short(Math.max(2, Math.round(delay)));
    b.byte(0);
    b.byte(0);
    b.byte(0x2c); // image descriptor
    b.short(0);
    b.short(0);
    b.short(this.w);
    b.short(this.h);
    b.byte(0); // no local color table
    b.byte(8); // LZW min code size
    lzw(8, quantize(rgba, this.w, this.h), b);
  }

  finish(): Blob {
    this.buf.byte(0x3b);
    return new Blob([this.buf.toUint8().buffer as ArrayBuffer], { type: 'image/gif' });
  }
}
