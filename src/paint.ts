// Primitif gambar bergaya cetak risograf: teks meleset, stiker, halftone.
import { color } from './tokens';

type Ctx = CanvasRenderingContext2D;

export const clamp = (v: number, a: number, b: number) => Math.min(b, Math.max(a, v));
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 3);

/**
 * Teks dengan efek cetak meleset: lapisan tinta warna digeser, lalu tinta utama di atasnya.
 * `layers` berisi [warna, dx, dy] yang digambar lebih dulu.
 */
export function printText(
  ctx: Ctx,
  text: string,
  x: number,
  y: number,
  fill: string,
  layers: Array<[string, number, number]> = [],
  stroke?: { color: string; width: number },
): void {
  for (const [c, dx, dy] of layers) {
    ctx.fillStyle = c;
    ctx.fillText(text, x + dx, y + dy);
  }
  if (stroke) {
    ctx.lineJoin = 'round';
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color;
    ctx.strokeText(text, x, y);
  }
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

/** Kotak stiker bersudut tajam dengan bayangan keras (tanpa blur). */
export function sticker(
  ctx: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  fill: string,
  shadows: Array<[string, number]> = [],
  border?: { color: string; width: number },
): void {
  for (const [c, off] of shadows) {
    ctx.fillStyle = c;
    ctx.fillRect(x + off, y + off, w, h);
  }
  ctx.fillStyle = fill;
  ctx.fillRect(x, y, w, h);
  if (border) {
    ctx.lineWidth = border.width;
    ctx.strokeStyle = border.color;
    ctx.strokeRect(x + border.width / 2, y + border.width / 2, w - border.width, h - border.width);
  }
}

const patternCache = new Map<string, CanvasPattern>();

function makeTile(size: number): [HTMLCanvasElement, Ctx] {
  const c = document.createElement('canvas');
  c.width = size;
  c.height = size;
  return [c, c.getContext('2d')!];
}

/** Pola titik halftone (diagonal) dalam satu warna. */
export function halftone(ctx: Ctx, fill: string, cell = 10, r = 2.2): CanvasPattern {
  const key = `h|${fill}|${cell}|${r}`;
  const hit = patternCache.get(key);
  if (hit) return hit;
  const [c, g] = makeTile(cell * 2);
  g.fillStyle = fill;
  for (const [cx, cy] of [
    [cell / 2, cell / 2],
    [cell * 1.5, cell * 1.5],
  ]) {
    g.beginPath();
    g.arc(cx, cy, r, 0, Math.PI * 2);
    g.fill();
  }
  const p = ctx.createPattern(c, 'repeat')!;
  patternCache.set(key, p);
  return p;
}

export function heart(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x, y + s * 0.3);
  ctx.bezierCurveTo(x, y - s * 0.1, x - s * 0.5, y - s * 0.1, x - s * 0.5, y + s * 0.25);
  ctx.bezierCurveTo(x - s * 0.5, y + s * 0.55, x - s * 0.1, y + s * 0.7, x, y + s * 0.9);
  ctx.bezierCurveTo(x + s * 0.1, y + s * 0.7, x + s * 0.5, y + s * 0.55, x + s * 0.5, y + s * 0.25);
  ctx.bezierCurveTo(x + s * 0.5, y - s * 0.1, x, y - s * 0.1, x, y + s * 0.3);
  ctx.fill();
}

/** Bintang empat sudut (kilatan). */
export function spark(ctx: Ctx, x: number, y: number, s: number): void {
  const k = s * 0.22;
  ctx.beginPath();
  ctx.moveTo(x, y - s);
  ctx.quadraticCurveTo(x + k, y - k, x + s, y);
  ctx.quadraticCurveTo(x + k, y + k, x, y + s);
  ctx.quadraticCurveTo(x - k, y + k, x - s, y);
  ctx.quadraticCurveTo(x - k, y - k, x, y - s);
  ctx.fill();
}

/** Panah segitiga ke kanan. */
export function arrowRight(ctx: Ctx, x: number, y: number, s: number): void {
  ctx.beginPath();
  ctx.moveTo(x + s, y);
  ctx.lineTo(x, y - s * 0.75);
  ctx.lineTo(x, y + s * 0.75);
  ctx.closePath();
  ctx.fill();
}

/** Empat batang jari: yang terangkat tinggi dan berwarna, sisanya pendek dan samar. */
export function fingerBars(ctx: Ctx, x: number, y: number, h: number, up: number, fill: string, rest: string): number {
  const w = Math.round(h * 0.34);
  const gap = Math.round(h * 0.16);
  for (let i = 0; i < 4; i++) {
    const raised = i < up;
    const bh = raised ? h : Math.round(h * 0.36);
    ctx.fillStyle = raised ? fill : rest;
    ctx.fillRect(x + i * (w + gap), y + h - bh, w, bh);
  }
  return 4 * w + 3 * gap;
}

/** Pecah teks ke beberapa baris agar muat dalam lebar maksimum. */
export function wrapLines(ctx: Ctx, text: string, maxW: number): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let cur = '';
  for (const w of words) {
    const next = cur ? `${cur} ${w}` : w;
    if (ctx.measureText(next).width > maxW && cur) {
      lines.push(cur);
      cur = w;
    } else cur = next;
  }
  if (cur) lines.push(cur);
  return lines;
}

/** Ukuran font terbesar (<= maxPx) yang membuat teks muat dalam maxW. */
export function fitPx(ctx: Ctx, text: string, font: (px: number) => string, maxPx: number, maxW: number): number {
  ctx.font = font(maxPx);
  const w = ctx.measureText(text).width;
  return w <= maxW ? maxPx : Math.floor(maxPx * (maxW / w));
}

/**
 * Signature: cetak meleset biru-magenta. Hanya untuk nama akor target,
 * persen kekompakan, dan gelar di kartu hasil.
 */
export const misprint = (o: number): Array<[string, number, number]> => [
  [color.p1, -o, o * 0.6],
  [color.p2, o, -o * 0.4],
];

/**
 * Teks angka dengan lebar digit tetap (canvas tidak punya tabular-nums),
 * rata kanan di `right`. Mengembalikan lebar total.
 */
export function tabularText(ctx: Ctx, value: string, right: number, y: number): number {
  const cell = ctx.measureText('0').width;
  const widths = [...value].map((ch) => (/\d/.test(ch) ? cell : ctx.measureText(ch).width));
  const total = widths.reduce((a, b) => a + b, 0);
  const align = ctx.textAlign;
  ctx.textAlign = 'center';
  let x = right - total;
  [...value].forEach((ch, i) => {
    ctx.fillText(ch, x + widths[i] / 2, y);
    x += widths[i];
  });
  ctx.textAlign = align;
  return total;
}
