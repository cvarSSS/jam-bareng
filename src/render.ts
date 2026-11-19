// Semua visual permainan digambar di satu canvas agar bisa direkam.
import { CHALLENGE_BARS, CHALLENGE_BEATS, CHORD_FINGERS, LANES, type GameEvent, type GameView, type ResultData } from './game';
import {
  arrowRight,
  clamp,
  easeOut,
  fingerBars,
  fitPx,
  halftone,
  heart,
  misprint,
  printText,
  spark,
  sticker,
  tabularText,
  wrapLines,
} from './paint';
import { canvasFont, color, font, playerColor, space, text, type PlayerId } from './tokens';
import { grooveLabel, levelLabel } from './challenge';
import type { ChordName, Pt } from './tracking';

export type Format = 'landscape' | 'vertical';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface View {
  dst: Rect;
  /** Rentang x sumber dalam koordinat kamera tercermin (0..1). */
  x0: number;
  x1: number;
}

export interface Layout {
  format: Format;
  W: number;
  H: number;
  pad: number;
  p1: Rect;
  p2: Rect;
  views: View[];
}

export function makeLayout(format: Format): Layout {
  const pad = space[6];
  if (format === 'landscape') {
    const W = 1280;
    const H = 720;
    return {
      format,
      W,
      H,
      pad,
      p1: { x: 0, y: 0, w: W / 2, h: H },
      p2: { x: W / 2, y: 0, w: W / 2, h: H },
      views: [{ dst: { x: 0, y: 0, w: W, h: H }, x0: 0, x1: 1 }],
    };
  }
  const W = 720;
  const H = 1280;
  const p1 = { x: 0, y: 0, w: W, h: H / 2 };
  const p2 = { x: 0, y: H / 2, w: W, h: H / 2 };
  return {
    format,
    W,
    H,
    pad,
    p1,
    p2,
    views: [
      { dst: p1, x0: 0, x1: 0.5 },
      { dst: p2, x0: 0.5, x1: 1 },
    ],
  };
}

/** Skala "cover" untuk satu view terhadap ukuran video. */
function coverOf(v: View, vw: number, vh: number) {
  const srcW = (v.x1 - v.x0) * vw;
  const scale = Math.max(v.dst.w / srcW, v.dst.h / vh);
  const dw = srcW * scale;
  const dh = vh * scale;
  return { scale, ox: v.dst.x + (v.dst.w - dw) / 2, oy: v.dst.y + (v.dst.h - dh) / 2 };
}

export interface FrameInput {
  now: number;
  beatDur: number;
  view: GameView;
  p1Pts: Pt[] | null;
  p2Pts: Pt[] | null;
  p1Chord: ChordName | null;
  p2Open: boolean;
  p2Lane: number | null;
  recording: boolean;
  cameraReady: boolean;
  /** Cek posisi sebelum hitung mundur; null bila tidak sedang cek. */
  ready?: { p1: boolean; p2: boolean; progress: number } | null;
}

const BONES: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const TIPS = [4, 8, 12, 16, 20];

type PopupStyle = 'kompak' | 'fire' | 'sehati' | 'fail' | 'break';

interface Popup {
  text: string;
  sub?: string;
  x: number;
  y: number;
  t0: number;
  dur: number;
  style: PopupStyle;
  px: number;
  rot: number;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  spin: number;
  t0: number;
  life: number;
  fill: string;
  r: number;
  shape: 'rect' | 'spark' | 'heart';
}

interface Flash {
  rect: Rect;
  fill: string;
  t0: number;
  dur: number;
  peak: number;
}

interface Glitch {
  player: PlayerId;
  t0: number;
  bars: Array<[y: number, h: number, dx: number]>;
}

const nowSec = () => performance.now() / 1000;
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
/** Denyut 1 di awal ketukan, turun ke 0 di akhir ketukan. */
const beatPulse = (f: FrameInput) => Math.max(0, 1 - (f.now - f.view.beatT) / f.beatDur);

export class Renderer {
  readonly ctx: CanvasRenderingContext2D;
  layout: Layout;
  private popups: Popup[] = [];
  private particles: Particle[] = [];
  private flashes: Flash[] = [];
  private glitches: Glitch[] = [];
  private shake = { 1: { t0: -9, amp: 0 }, 2: { t0: -9, amp: 0 }, all: { t0: -9, amp: 0 } };
  private resultShownAt = -1;
  private calm = reducedMotion();

  constructor(
    readonly canvas: HTMLCanvasElement,
    format: Format,
  ) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D tidak tersedia');
    this.ctx = ctx;
    this.layout = makeLayout(format);
    this.applySize();
  }

  setFormat(format: Format): void {
    this.layout = makeLayout(format);
    this.applySize();
  }

  private applySize(): void {
    this.canvas.width = this.layout.W;
    this.canvas.height = this.layout.H;
  }

  region(p: PlayerId): Rect {
    return p === 1 ? this.layout.p1 : this.layout.p2;
  }

  /** Petakan landmark (koordinat kamera tercermin) ke piksel canvas dengan crop yang sama dengan video. */
  mapPoints(p: PlayerId, pts: Pt[], vw: number, vh: number): Pt[] {
    const v = this.layout.views.length === 1 ? this.layout.views[0] : this.layout.views[p - 1];
    const c = coverOf(v, vw, vh);
    return pts.map((q) => ({ x: c.ox + (q.x - v.x0) * vw * c.scale, y: c.oy + q.y * vh * c.scale }));
  }

  /** Posisi y relatif terhadap area pemain (0 atas, 1 bawah). */
  regionY(p: PlayerId, y: number): number {
    const r = this.region(p);
    return (y - r.y) / r.h;
  }

  laneY(i: number): number {
    const r = this.layout.p2;
    // Jalur 0 (Do) paling bawah, rentang 0.1..0.9 area.
    return r.y + r.h * (0.9 - (i + 0.5) * 0.16);
  }

  /** Tinggi panel ketukan. */
  private static readonly HUD_H = 88;

  /** Batas atas konten P1. Di vertikal, panel ketukan menempati bagian paling atas. */
  private p1Top(): number {
    const L = this.layout;
    return L.format === 'landscape' ? L.pad : L.pad + Renderer.HUD_H + space[4];
  }

  /** Titik tengah untuk teks reaksi bersama (di atas HUD ketukan). */
  private sharedSpot(): Pt {
    const L = this.layout;
    return L.format === 'landscape' ? { x: L.W / 2, y: 216 } : { x: L.W / 2, y: L.H / 2 - 112 };
  }

  // ---------- Efek dari event permainan ----------

  onEvent(ev: GameEvent): void {
    const t = nowSec();
    const L = this.layout;
    const amp = (n: number) => (this.calm ? 0 : n);
    if (ev.kind === 'judge') {
      if (ev.p1ok && ev.p2ok) this.kompak(ev.combo, t, amp);
      for (const p of [1, 2] as const) {
        const ok = p === 1 ? ev.p1ok : ev.p2ok;
        const txt = p === 1 ? ev.p1Text : ev.p2Text;
        if (!ok && txt) this.fail(p, txt, t, amp);
      }
    } else if (ev.kind === 'comboBreak') {
      const at = this.sharedSpot();
      this.popups.push({
        text: 'COMBO PUTUS',
        sub: `x${ev.lost} melayang`,
        x: at.x,
        y: at.y + 112,
        t0: t + 0.05,
        dur: 1.4,
        style: 'break',
        px: text.figure,
        rot: -0.05,
      });
      this.shake.all = { t0: t, amp: amp(12) };
    } else if (ev.kind === 'finish') {
      this.flashes.push({ rect: { x: 0, y: 0, w: L.W, h: L.H }, fill: color.paper, t0: t, dur: 0.56, peak: 0.5 });
      this.burst(L.W / 2, L.H / 2, 48, 3);
      this.shake.all = { t0: t, amp: amp(12) };
    } else if (ev.kind === 'result') {
      this.resultShownAt = t;
    } else if (ev.kind === 'count') {
      this.shake.all = { t0: t, amp: amp(ev.index === 3 ? 6 : 3) };
    }
  }

  /** Kompak: makin panjang combo, makin besar teks, kilatan, dan partikelnya. */
  private kompak(combo: number, t: number, amp: (n: number) => number): void {
    const L = this.layout;
    const level = combo >= 16 ? 3 : combo >= 8 ? 2 : 1;
    const style: PopupStyle = level === 3 ? 'sehati' : level === 2 ? 'fire' : 'kompak';
    const at = this.sharedSpot();
    this.popups = this.popups.filter((p) => p.style === 'fail' || p.style === 'break');
    this.popups.push({
      text: level === 3 ? 'SEHATI!' : level === 2 ? 'ON FIRE!' : 'KOMPAK!',
      sub: `x${combo}`,
      ...at,
      t0: t,
      dur: 0.76,
      style,
      px: text.reaction + (level - 1) * 16,
      rot: this.calm ? 0 : rand(-0.06, 0.06),
    });
    this.burst(at.x, at.y, 8 + level * 8, level);
    const fill = level === 3 ? color.p2 : color.hot;
    this.flashes.push({ rect: { x: 0, y: 0, w: L.W, h: L.H }, fill, t0: t, dur: 0.2 + level * 0.08, peak: 0.08 + level * 0.07 });
    if (level >= 2) this.shake.all = { t0: t, amp: amp(level * 3) };
  }

  /** Salah: setengah layar berkedip vermilion, bergetar, dan muncul teks acak. */
  private fail(p: PlayerId, txt: string, t: number, amp: (n: number) => number): void {
    const L = this.layout;
    const r = this.region(p);
    this.flashes.push({ rect: r, fill: color.fail, t0: t, dur: 0.28, peak: 0.26 });
    this.shake[p] = { t0: t, amp: amp(8) };
    this.glitches.push({
      player: p,
      t0: t,
      bars: Array.from({ length: 4 }, () => [rand(0, r.h), rand(4, 16), rand(-32, 32)]),
    });
    this.popups = this.popups.filter((q) => !(q.style === 'fail' && q.x >= r.x && q.x < r.x + r.w && q.y >= r.y && q.y < r.y + r.h));
    this.popups.push({
      text: txt,
      x: r.x + r.w * (p === 1 ? 0.62 : 0.42) + rand(-1, 1) * r.w * 0.06,
      y: r.y + r.h * (L.format === 'landscape' ? 0.56 : 0.5) + rand(-1, 1) * r.h * 0.05,
      t0: t,
      dur: 0.64,
      style: 'fail',
      px: 64,
      rot: this.calm ? 0 : rand(-0.12, 0.12),
    });
  }

  resetResult(): void {
    this.resultShownAt = -1;
  }

  private burst(x: number, y: number, n: number, level: number): void {
    const t = nowSec();
    const fills = [color.p1, color.p2, color.hot, color.paper];
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = rand(160, 420) * (0.75 + level * 0.25);
      const shape = level === 3 && i % 3 === 0 ? 'heart' : level >= 2 && i % 4 === 0 ? 'spark' : 'rect';
      this.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 120,
        spin: rand(-12, 12),
        t0: t,
        life: rand(0.6, 1.1),
        fill: shape === 'heart' ? color.p2 : fills[i % fills.length],
        r: shape === 'rect' ? rand(4, 8) : rand(8, 14),
        shape,
      });
    }
  }

  private shakeOffset(key: 1 | 2 | 'all', t: number): Pt {
    const s = this.shake[key];
    const k = t - s.t0;
    if (k > 0.32 || s.amp === 0) return { x: 0, y: 0 };
    const a = s.amp * (1 - k / 0.32);
    return { x: Math.sin(k * 95) * a, y: Math.cos(k * 73) * a * 0.6 };
  }

  // ---------- Gambar frame ----------

  draw(video: HTMLVideoElement | null, f: FrameInput): void {
    const ctx = this.ctx;
    const L = this.layout;
    const t = nowSec();
    ctx.save();
    ctx.fillStyle = color.bg;
    ctx.fillRect(0, 0, L.W, L.H);

    const g = this.shakeOffset('all', t);
    ctx.translate(g.x, g.y);

    for (const p of [1, 2] as const) {
      const r = this.region(p);
      const o = this.shakeOffset(p, t);
      ctx.save();
      ctx.beginPath();
      ctx.rect(r.x, r.y, r.w, r.h);
      ctx.clip();
      ctx.translate(o.x, o.y);
      this.drawCamera(video, f.cameraReady, p);
      this.drawGlitch(p, t);
      ctx.restore();
    }

    this.drawFlashes(t);
    this.drawDivider();
    this.drawLanes(f);
    this.drawHands(f);
    this.drawLabels(f);
    if (f.view.phase === 'countdown' || f.view.phase === 'challenge') this.drawTargetCard(f);
    this.drawBeatHud(f);
    this.drawParticles(t);
    this.drawPopups(t);
    if (f.view.countLabel) this.drawCountdown(f);
    if (f.ready) this.drawReady(f.ready);
    this.drawWatermark();
    if (f.recording) this.drawRec(t);
    ctx.restore();

    if (f.view.phase === 'result' && f.view.result) {
      if (this.resultShownAt < 0) this.resultShownAt = t;
      this.drawResult(f.view.result, t - this.resultShownAt);
    }
  }

  private drawCamera(video: HTMLVideoElement | null, ready: boolean, p: PlayerId): void {
    const ctx = this.ctx;
    const r = this.region(p);
    if (video && ready && video.videoWidth) {
      this.drawVideo(video, p);
      ctx.fillStyle = color.shade;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    } else {
      ctx.fillStyle = color.surface;
      ctx.fillRect(r.x, r.y, r.w, r.h);
    }
    // Tinta identitas pemain di atas kamera.
    ctx.globalCompositeOperation = 'soft-light';
    ctx.globalAlpha = 0.4;
    ctx.fillStyle = playerColor(p);
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 1;
  }

  private drawVideo(video: HTMLVideoElement, p: PlayerId): void {
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    const L = this.layout;
    const v = L.views.length === 1 ? L.views[0] : L.views[p - 1];
    const c = coverOf(v, vw, vh);
    // Bagian sumber yang terlihat, dalam koordinat tercermin.
    const mx0 = v.x0 + (v.dst.x - c.ox) / c.scale / vw;
    const mw = v.dst.w / c.scale / vw;
    const sy = (v.dst.y - c.oy) / c.scale;
    const sh = v.dst.h / c.scale;
    const sx = (1 - (mx0 + mw)) * vw;
    const ctx = this.ctx;
    ctx.save();
    ctx.translate(v.dst.x + v.dst.w, v.dst.y);
    ctx.scale(-1, 1);
    ctx.drawImage(video, sx, sy, mw * vw, sh, 0, 0, v.dst.w, v.dst.h);
    ctx.restore();
  }

  private drawGlitch(p: PlayerId, t: number): void {
    const ctx = this.ctx;
    const r = this.region(p);
    this.glitches = this.glitches.filter((g) => t - g.t0 < 0.24);
    for (const g of this.glitches) {
      if (g.player !== p) continue;
      const k = (t - g.t0) / 0.24;
      ctx.globalAlpha = 0.85 * (1 - k);
      g.bars.forEach(([y, h, dx], i) => {
        ctx.fillStyle = i % 2 ? color.fail : color.bg;
        ctx.fillRect(r.x + dx * (1 - k), r.y + y, r.w, h);
      });
      ctx.globalAlpha = 1;
    }
  }

  private drawDivider(): void {
    const ctx = this.ctx;
    const L = this.layout;
    ctx.save();
    ctx.strokeStyle = color.paper;
    ctx.globalAlpha = 0.5;
    ctx.lineWidth = 2;
    ctx.setLineDash([12, 8]);
    ctx.beginPath();
    if (L.format === 'landscape') {
      ctx.moveTo(L.W / 2, 0);
      ctx.lineTo(L.W / 2, L.H);
    } else {
      ctx.moveTo(0, L.H / 2);
      ctx.lineTo(L.W, L.H / 2);
    }
    ctx.stroke();
    ctx.restore();
  }

  /** Label stiker kecil, sentence case. Mengembalikan lebarnya. */
  private tag(x: number, y: number, label: string, fill: string | null, ink: string): number {
    const ctx = this.ctx;
    ctx.font = canvasFont(600, text.label, font.body);
    const w = Math.ceil(ctx.measureText(label).width) + space[3] * 2;
    const h = space[8];
    if (fill) sticker(ctx, x, y, w, h, fill);
    else sticker(ctx, x, y, w, h, color.bg, [], { color: color.hairline, width: 1 });
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x + space[3], y + h / 2 + 1);
    return w;
  }

  private tagWidth(label: string): number {
    this.ctx.font = canvasFont(600, text.label, font.body);
    return Math.ceil(this.ctx.measureText(label).width) + space[3] * 2;
  }

  private drawLabels(f: FrameInput): void {
    const L = this.layout;
    this.tag(L.p1.x + L.pad, L.p1.y + this.p1Top(), 'Pemain 1 · Akor', color.p1, color.print);
    this.tag(L.p2.x + L.pad, L.p2.y + L.pad, 'Pemain 2 · Melodi', color.p2, color.print);
    if (f.view.phase === 'free') {
      const label = 'Latihan bebas';
      const w = this.tagWidth(label);
      // Di sisi kanan area Pemain 1, supaya tidak menimpa label Pemain 2.
      const x = L.format === 'landscape' ? L.W / 2 - L.pad - w : L.W - L.pad - w;
      this.tag(x, this.p1Top(), label, null, color.inkDim);
    }
  }

  private drawLanes(f: FrameInput): void {
    const ctx = this.ctx;
    const r = this.layout.p2;
    const L = this.layout;
    const laneH = r.h * 0.16;
    const v = f.view;
    const target = v.targetLane !== null && (v.phase === 'challenge' || v.phase === 'countdown') ? v.targetLane : -1;
    // Di ketukan ke-4, jalur akor berikutnya sudah ditandai supaya Pemain 2 bisa bergerak lebih awal.
    const upcoming = v.phase === 'challenge' && v.beatInBar === 3 && v.nextLane !== null ? v.nextLane : -1;
    const next = upcoming !== target ? upcoming : -1;
    const pulse = beatPulse(f);
    const top = this.laneY(LANES.length - 1) - laneH / 2;

    ctx.fillStyle = color.hairline;
    for (let i = 0; i <= LANES.length; i++) ctx.fillRect(r.x, Math.round(top + i * laneH), r.w, 1);

    for (let i = 0; i < LANES.length; i++) {
      const cy = this.laneY(i);
      const y = cy - laneH / 2;
      const isTarget = i === target;
      const isCurrent = f.p2Open && f.p2Lane === i;
      if (isTarget) {
        ctx.globalAlpha = 0.45 + pulse * 0.35;
        ctx.fillStyle = halftone(ctx, color.p2, 8, 2.2);
        ctx.fillRect(r.x, y, r.w, laneH);
        ctx.globalAlpha = 1;
        const bw = 4 + pulse * 4;
        ctx.strokeStyle = color.p2;
        ctx.lineWidth = bw;
        ctx.strokeRect(r.x + bw / 2, y + bw / 2, r.w - bw, laneH - bw);

        // Penanda "ke sini": bergeser hanya mengikuti ketukan.
        const nudge = this.calm ? 0 : pulse * space[3];
        ctx.font = canvasFont(600, text.label, font.body);
        const label = 'Ke sini';
        const tw = Math.ceil(ctx.measureText(label).width);
        const ch = space[10];
        const cx = r.x + L.pad + nudge;
        const cw = space[3] + tw + space[2] + space[3] + space[3];
        sticker(ctx, cx, cy - ch / 2, cw, ch, color.p2, [[color.print, 4]]);
        ctx.fillStyle = color.print;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx + space[3], cy + 1);
        arrowRight(ctx, cx + space[3] + tw + space[2], cy, space[3]);
      } else if (i === next) {
        ctx.save();
        ctx.strokeStyle = color.p2;
        ctx.lineWidth = 3;
        ctx.setLineDash([12, 8]);
        ctx.strokeRect(r.x + 2, y + 2, r.w - 4, laneH - 4);
        ctx.restore();
        if (isCurrent) {
          ctx.fillStyle = 'rgba(243,241,236,0.08)';
          ctx.fillRect(r.x, y, r.w, laneH);
        }
        ctx.font = canvasFont(600, text.label, font.body);
        const label = 'Berikutnya';
        const tw = Math.ceil(ctx.measureText(label).width);
        const ch = space[8];
        const cx = r.x + L.pad;
        sticker(ctx, cx, cy - ch / 2, tw + space[3] * 2, ch, color.bg, [], { color: color.p2, width: 2 });
        ctx.fillStyle = color.p2;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, cx + space[3], cy + 1);
      } else if (isCurrent) {
        ctx.fillStyle = 'rgba(243,241,236,0.08)';
        ctx.fillRect(r.x, y, r.w, laneH);
      }
      const lit = isTarget || isCurrent || i === next;
      const nameX = r.x + r.w - L.pad;
      ctx.textAlign = 'right';
      ctx.textBaseline = 'alphabetic';
      ctx.font = canvasFont(800, text.lane);
      ctx.fillStyle = lit ? color.ink : color.inkDim;
      ctx.fillText(LANES[i].name.toUpperCase(), nameX, cy + 8);
      ctx.font = canvasFont(500, text.meta, font.body);
      ctx.fillStyle = lit ? color.ink : color.muted;
      ctx.fillText(LANES[i].note, nameX, cy + 28);
    }
  }

  private drawHands(f: FrameInput): void {
    const ctx = this.ctx;
    const L = this.layout;
    const pulse = beatPulse(f);
    const skeleton = (pts: Pt[], p: PlayerId) => {
      ctx.strokeStyle = playerColor(p);
      ctx.lineWidth = 6;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (const [a, b] of BONES) {
        ctx.moveTo(pts[a].x, pts[a].y);
        ctx.lineTo(pts[b].x, pts[b].y);
      }
      ctx.stroke();
      ctx.fillStyle = color.paper;
      pts.forEach((q, i) => {
        ctx.beginPath();
        ctx.arc(q.x, q.y, TIPS.includes(i) ? 6 : 4, 0, Math.PI * 2);
        ctx.fill();
      });
    };

    if (f.p1Pts) {
      skeleton(f.p1Pts, 1);
      const top = f.p1Pts.reduce((m, q) => (q.y < m.y ? q : m), f.p1Pts[0]);
      if (f.p1Chord) {
        ctx.font = canvasFont(900, text.figure);
        const w = Math.ceil(ctx.measureText(f.p1Chord).width) + space[6];
        const h = 64;
        const x = clamp(top.x - w / 2, L.p1.x + space[2], L.p1.x + L.p1.w - w - space[2]);
        const y = Math.max(L.p1.y + space[2], top.y - h - space[6]);
        sticker(ctx, x, y, w, h, color.p1, [[color.print, 4]]);
        ctx.fillStyle = color.print;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(f.p1Chord, x + w / 2, y + h / 2 + 2);
      } else {
        const w = this.tagWidth('Diam');
        const x = clamp(top.x - w / 2, L.p1.x + space[2], L.p1.x + L.p1.w - w - space[2]);
        this.tag(x, Math.max(L.p1.y + space[2], top.y - space[8] - space[6]), 'Diam', null, color.inkDim);
      }
    }

    if (f.p2Pts) {
      skeleton(f.p2Pts, 2);
      const palm = f.p2Pts[9];
      const open = f.p2Open && f.p2Lane !== null;
      const rad = 40 * (open && !this.calm ? 1 + pulse * 0.16 : 1);
      ctx.beginPath();
      ctx.arc(palm.x, palm.y, rad, 0, Math.PI * 2);
      ctx.fillStyle = open ? color.p2 : color.bg;
      ctx.fill();
      ctx.lineWidth = open ? 4 : 2;
      ctx.strokeStyle = open ? color.print : color.inkDim;
      ctx.stroke();
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      if (open) {
        ctx.fillStyle = color.print;
        ctx.font = canvasFont(900, 32);
        ctx.fillText(LANES[f.p2Lane!].name.toUpperCase(), palm.x, palm.y + 2);
      } else {
        ctx.fillStyle = color.inkDim;
        ctx.font = canvasFont(600, text.meta, font.body);
        ctx.fillText('Diam', palm.x, palm.y + 1);
      }
    }
  }

  /** Momen 1: kartu target akor, stiker kertas dengan nama akor tercetak meleset. */
  private drawTargetCard(f: FrameInput): void {
    const v = f.view;
    if (!v.target) return;
    const ctx = this.ctx;
    const L = this.layout;
    const r = L.p1;
    const w = 224;
    const h = 272;
    const ip = space[4];
    const x = r.x + L.pad;
    const y = r.y + this.p1Top() + space[8] + space[4];
    const hot = v.beatInBar === 3 && v.phase === 'challenge' && !!v.next;

    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(-0.025);
    sticker(ctx, 0, 0, w, h, color.paper, [[color.p1, 8]]);

    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.font = canvasFont(600, text.meta, font.body);
    ctx.fillStyle = color.print;
    ctx.fillText('Target akor', ip, ip);

    ctx.textBaseline = 'alphabetic';
    ctx.font = canvasFont(900, text.chord);
    printText(ctx, v.target, ip, ip + 120, color.print, misprint(4));

    const n = CHORD_FINGERS[v.target];
    const barsY = 152;
    const barH = 36;
    const bw = fingerBars(ctx, ip, barsY, barH, n, color.p1, 'rgba(18,19,22,0.18)');
    ctx.font = canvasFont(600, text.label, font.body);
    ctx.fillStyle = color.print;
    ctx.textBaseline = 'bottom';
    ctx.fillText(`${n} jari`, ip + bw + space[3], barsY + barH);

    // Strip "berikutnya": jadi kuning di ketukan ke-4.
    const sh = 48;
    const sy = h - sh;
    ctx.fillStyle = hot ? color.hot : color.print;
    ctx.fillRect(0, sy, w, sh);
    ctx.textBaseline = 'middle';
    ctx.font = canvasFont(600, text.meta, font.body);
    ctx.fillStyle = hot ? color.print : color.paper;
    if (v.next) {
      ctx.fillText('Berikutnya', ip, sy + sh / 2 + 1);
      ctx.textAlign = 'right';
      ctx.font = canvasFont(900, 32);
      ctx.fillText(v.next, w - ip, sy + sh / 2 + 2);
    } else {
      ctx.fillText('Akor terakhir', ip, sy + sh / 2 + 1);
    }
    ctx.restore();
  }

  private drawBeatHud(f: FrameInput): void {
    const ctx = this.ctx;
    const L = this.layout;
    const v = f.view;
    const w = L.format === 'landscape' ? 432 : L.W - L.pad * 2;
    const h = Renderer.HUD_H;
    const x = Math.round(L.W / 2 - w / 2);
    const y = L.format === 'landscape' ? L.H - L.pad - h : L.pad;
    sticker(ctx, x, y, w, h, color.bg, [], { color: color.hairline, width: 1 });

    const ip = space[5];
    // Empat kotak ketukan.
    const cell = 24;
    const cy = y + 40;
    const pulse = beatPulse(f);
    for (let i = 0; i < 4; i++) {
      const bx = x + ip + i * (cell + space[2]);
      const on = v.phase !== 'result' && i === v.beatInBar;
      if (on) {
        const grow = this.calm ? 0 : pulse * 4;
        ctx.fillStyle = v.phase === 'challenge' ? color.hot : color.paper;
        ctx.fillRect(bx - grow / 2, cy - cell / 2 - grow / 2, cell + grow, cell + grow);
      } else {
        ctx.strokeStyle = 'rgba(243,241,236,0.3)';
        ctx.lineWidth = 2;
        ctx.strokeRect(bx + 1, cy - cell / 2 + 1, cell - 2, cell - 2);
      }
    }

    // Angka utama di kanan, digit selebar tetap.
    const right = x + w - ip;
    let label: string;
    let value: string;
    if (v.phase === 'free') {
      label = 'Tempo';
      value = `${Math.round(60 / f.beatDur)} BPM`;
    } else if (v.phase === 'countdown') {
      label = 'Siap-siap';
      value = '0%';
    } else {
      label = 'Kekompakan';
      value = `${v.percent}%`;
    }
    ctx.textBaseline = 'alphabetic';
    ctx.font = canvasFont(900, text.figure);
    ctx.fillStyle = color.ink;
    const baseY = cy + 18;
    const vw = tabularText(ctx, value, right, baseY);
    ctx.textAlign = 'right';
    ctx.font = canvasFont(500, text.meta, font.body);
    ctx.fillStyle = color.inkDim;
    ctx.fillText(label, right - vw - space[3], baseY - 4);
    if (v.phase === 'challenge' && v.combo >= 2) {
      ctx.font = canvasFont(800, 24);
      ctx.fillStyle = color.hot;
      ctx.fillText(`x${v.combo}`, right - vw - space[3], baseY - 24);
    }

    // Progress: satu garis tipis dengan takik tiap 4 birama.
    const py = y + h - space[4];
    const pw = w - ip * 2;
    const prog = v.beat < 0 ? 0 : clamp((v.beat + 1) / CHALLENGE_BEATS, 0, 1);
    ctx.fillStyle = 'rgba(243,241,236,0.16)';
    ctx.fillRect(x + ip, py, pw, 2);
    ctx.fillStyle = color.hot;
    ctx.fillRect(x + ip, py - 1, pw * prog, 4);
    ctx.fillStyle = 'rgba(243,241,236,0.3)';
    for (let i = 4; i < CHALLENGE_BARS; i += 4) ctx.fillRect(x + ip + (pw * i) / CHALLENGE_BARS - 1, py - 4, 2, 10);
  }

  /** Cek posisi: tiap pemain diminta mengangkat tangan di sisinya sebelum hitung mundur. */
  private drawReady(r: { p1: boolean; p2: boolean; progress: number }): void {
    const ctx = this.ctx;
    const L = this.layout;
    for (const p of [1, 2] as const) {
      const reg = this.region(p);
      const ok = p === 1 ? r.p1 : r.p2;
      const cx = reg.x + reg.w / 2;
      // Di bagian atas area pemain, supaya tidak menutupi tangan.
      const cy = reg.y + (L.format === 'landscape' ? 168 : reg === L.p1 ? 216 : 120);
      const label = ok ? 'SIAP' : 'ANGKAT TANGAN';
      ctx.font = canvasFont(900, 56);
      const w = Math.ceil(ctx.measureText(label).width) + space[10];
      const h = 88;
      if (ok) sticker(ctx, cx - w / 2, cy - h / 2, w, h, playerColor(p), [[color.print, 6]]);
      else sticker(ctx, cx - w / 2, cy - h / 2, w, h, color.bg, [], { color: playerColor(p), width: 3 });
      ctx.fillStyle = ok ? color.print : color.ink;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, cx, cy + 3);
      ctx.font = canvasFont(600, text.label, font.body);
      ctx.fillStyle = color.ink;
      ctx.fillText(p === 1 ? 'Pemain 1 di sisi ini' : 'Pemain 2 di sisi ini', cx, cy + h / 2 + space[6]);
    }
    // Garis tahan: penuh berarti hitung mundur dimulai.
    const bw = 320;
    const bx = L.W / 2 - bw / 2;
    const by = L.format === 'landscape' ? L.H * 0.78 : L.H / 2 - space[4];
    ctx.fillStyle = color.bg;
    ctx.fillRect(bx - space[3], by - space[8], bw + space[6], space[12] + space[2]);
    ctx.font = canvasFont(600, text.label, font.body);
    ctx.fillStyle = color.ink;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(r.p1 && r.p2 ? 'Tahan sebentar' : 'Dua tangan harus kelihatan', L.W / 2, by - space[4]);
    ctx.fillStyle = 'rgba(243,241,236,0.18)';
    ctx.fillRect(bx, by + space[2], bw, 4);
    ctx.fillStyle = color.hot;
    ctx.fillRect(bx, by + space[2], bw * clamp(r.progress, 0, 1), 4);
  }

  private drawCountdown(f: FrameInput): void {
    const ctx = this.ctx;
    const L = this.layout;
    const k = clamp((f.now - f.view.beatT) / f.beatDur, 0, 1);
    const label = f.view.countLabel ?? '';
    ctx.save();
    ctx.translate(L.W / 2, L.format === 'landscape' ? 320 : 384);
    const sc = this.calm ? 1 : 1.4 - easeOut(k * 3) * 0.4;
    ctx.scale(sc, sc);
    ctx.globalAlpha = k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const px = label.length > 1 ? fitPx(ctx, label, (p) => canvasFont(900, p), 208, L.W * 0.8) : text.countdown;
    ctx.font = canvasFont(900, px);
    printText(ctx, label, 0, 0, color.paper, [[color.print, 8, 8]], { color: color.print, width: 10 });
    ctx.restore();
  }

  private drawFlashes(t: number): void {
    const ctx = this.ctx;
    this.flashes = this.flashes.filter((fl) => t - fl.t0 < fl.dur);
    for (const fl of this.flashes) {
      ctx.globalAlpha = fl.peak * (1 - (t - fl.t0) / fl.dur);
      ctx.fillStyle = fl.fill;
      ctx.fillRect(fl.rect.x, fl.rect.y, fl.rect.w, fl.rect.h);
    }
    ctx.globalAlpha = 1;
  }

  private drawParticles(t: number): void {
    const ctx = this.ctx;
    this.particles = this.particles.filter((p) => t - p.t0 < p.life);
    for (const p of this.particles) {
      const k = t - p.t0;
      ctx.globalAlpha = 1 - k / p.life;
      ctx.fillStyle = p.fill;
      ctx.save();
      ctx.translate(p.x + p.vx * k, p.y + p.vy * k + 520 * k * k);
      ctx.rotate(p.spin * k);
      if (p.shape === 'rect') ctx.fillRect(-p.r, -p.r * 0.5, p.r * 2, p.r);
      else if (p.shape === 'spark') spark(ctx, 0, 0, p.r);
      else heart(ctx, 0, -p.r * 0.4, p.r * 1.6);
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }

  /** Momen reaksi: teks tebal dengan bayangan cetak keras. */
  private drawPopups(t: number): void {
    const ctx = this.ctx;
    this.popups = this.popups.filter((p) => t - p.t0 < p.dur);
    for (const p of this.popups) {
      const k = (t - p.t0) / p.dur;
      if (k < 0) continue;
      ctx.save();
      const drift = p.style === 'break' ? easeOut(k) * 32 : -k * 20;
      ctx.translate(p.x, p.y + drift);
      ctx.rotate(p.rot + (p.style === 'break' ? k * 0.08 : 0));
      const slam = this.calm ? 1 : k < 0.12 ? 1.5 - (k / 0.12) * 0.5 : 1;
      ctx.scale(slam, slam);
      ctx.globalAlpha = k > 0.72 ? 1 - (k - 0.72) / 0.28 : 1;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = canvasFont(900, p.px);
      const drop = Math.round(p.px * 0.07);
      if (p.style === 'fail') {
        printText(ctx, p.text, 0, 0, color.fail, [[color.print, drop, drop]], { color: color.print, width: 8 });
      } else if (p.style === 'break') {
        const tw = ctx.measureText(p.text).width;
        const h = 72;
        sticker(ctx, -tw / 2 - space[5], -h / 2, tw + space[10], h, color.fail, [[color.print, 6]]);
        ctx.fillStyle = color.print;
        ctx.fillText(p.text, 0, 3);
        if (p.sub) {
          ctx.font = canvasFont(600, text.label, font.body);
          ctx.fillStyle = color.ink;
          ctx.fillText(p.sub, 0, h / 2 + space[6]);
        }
      } else {
        const fill = p.style === 'sehati' ? color.p2 : color.hot;
        printText(ctx, p.text, 0, 0, fill, [[color.print, drop, drop]], { color: color.print, width: 10 });
        if (p.sub) {
          ctx.font = canvasFont(800, 32);
          const tw = ctx.measureText(p.sub).width;
          const by = p.px * 0.5 + space[6];
          sticker(ctx, -tw / 2 - space[2], by - 20, tw + space[4], 40, color.print);
          ctx.fillStyle = fill;
          ctx.fillText(p.sub, 0, by + 2);
        }
      }
      ctx.restore();
    }
  }

  /** Logo: tiga kotak tinta + nama produk. */
  private logo(x: number, y: number, ink: string, px: number): number {
    const ctx = this.ctx;
    const m = px * 0.8;
    ctx.fillStyle = color.p1;
    ctx.fillRect(x, y + m * 0.2, m * 0.55, m * 0.7);
    ctx.fillStyle = color.p2;
    ctx.fillRect(x + m * 0.35, y + m * 0.1, m * 0.55, m * 0.7);
    ctx.fillStyle = color.hot;
    ctx.fillRect(x + m * 0.22, y + m * 0.35, m * 0.5, m * 0.4);
    ctx.font = canvasFont(800, px);
    ctx.fillStyle = ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    const tx = x + m + space[2];
    ctx.fillText('JAM BARENG', tx, y + m * 0.55 + 1);
    return tx + ctx.measureText('JAM BARENG').width - x;
  }

  private drawWatermark(): void {
    const ctx = this.ctx;
    const L = this.layout;
    const px = 28;
    ctx.font = canvasFont(800, px);
    const w = px * 0.8 + space[2] + ctx.measureText('JAM BARENG').width;
    ctx.globalAlpha = 0.9;
    this.logo(L.W - L.pad - w, L.H - L.pad - px * 0.9, color.ink, px);
    ctx.globalAlpha = 1;
  }

  private drawRec(t: number): void {
    const ctx = this.ctx;
    const L = this.layout;
    const x = L.pad;
    const y = L.format === 'landscape' ? L.H - L.pad - 12 : L.H / 2 - L.pad - 12;
    ctx.fillStyle = color.fail;
    ctx.globalAlpha = Math.floor(t * 1.6) % 2 === 0 ? 1 : 0.35;
    ctx.fillRect(x, y - 6, 12, 12);
    ctx.globalAlpha = 1;
    ctx.font = canvasFont(600, text.meta, font.body);
    ctx.fillStyle = color.ink;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('Merekam', x + space[5], y + 1);
  }

  // ---------- Kartu hasil (momen 2) ----------

  drawResult(d: ResultData, k: number): void {
    const ctx = this.ctx;
    const L = this.layout;
    const land = L.format === 'landscape';
    const calm = this.calm;
    const enter = calm ? 1 : easeOut(k / 0.44);

    ctx.save();
    ctx.globalAlpha = enter * 0.9;
    ctx.fillStyle = color.bg;
    ctx.fillRect(0, 0, L.W, L.H);
    ctx.globalAlpha = enter;

    const w = land ? 976 : 640;
    const h = land ? 600 : 1104;
    const x = (L.W - w) / 2;
    const y = (L.H - h) / 2 - (land ? 4 : 8);
    const stampK = calm ? 1 : clamp((k - 1.4) / 0.2, 0, 1);
    const thud = !calm && stampK > 0 && stampK < 1 ? Math.sin(stampK * Math.PI) * 4 : 0;

    ctx.translate(L.W / 2, L.H / 2 + (1 - enter) * 24 + thud);
    ctx.rotate(-0.012);
    ctx.translate(-L.W / 2, -L.H / 2);

    // Kertas dengan dua lapis tinta di belakangnya.
    sticker(ctx, x, y, w, h, color.paper, [
      [color.p1, 16],
      [color.p2, 8],
    ]);
    // Sudut halftone.
    const hs = land ? 176 : 192;
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(x + w, y);
    ctx.lineTo(x + w - hs, y);
    ctx.lineTo(x + w, y + hs);
    ctx.closePath();
    ctx.clip();
    ctx.globalAlpha = enter * 0.2;
    ctx.fillStyle = halftone(ctx, color.print, 10, 2.6);
    ctx.fillRect(x + w - hs, y, hs, hs);
    ctx.restore();

    const ip = space[10];
    const ctaH = 80;
    const colW = land ? 440 : w - ip * 2;
    const left = x + ip;

    // Logo kecil dan info level/groove.
    const logoW = this.logo(left, y + ip, color.print, 24);
    ctx.font = canvasFont(600, text.meta, font.body);
    ctx.fillStyle = 'rgba(18,19,22,0.62)';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(`${levelLabel(d.meta.level)} · ${grooveLabel(d.meta.groove)}`, left + logoW + space[4], y + ip + 11);

    // Persen kekompakan (signature).
    let cy = y + ip + space[12] + space[3];
    ctx.font = canvasFont(600, text.label, font.body);
    ctx.fillStyle = color.print;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    ctx.fillText('Kekompakan', left, cy);

    const shown = Math.round(d.percent * easeOut((k - 0.3) / 1.0));
    const numPx = land ? 232 : 280;
    ctx.textBaseline = 'alphabetic';
    ctx.font = canvasFont(900, numPx);
    const numY = cy + space[6] + numPx * 0.8;
    // Lebar digit tetap agar angka tidak bergoyang saat menghitung naik.
    const cell = ctx.measureText('0').width;
    const digits = String(shown);
    const reserve = cell * String(d.percent).length;
    for (const [c, dx, dy] of misprint(6)) {
      ctx.fillStyle = c;
      [...digits].forEach((ch, i) => ctx.fillText(ch, left + i * cell + dx, numY + dy));
    }
    ctx.fillStyle = color.print;
    [...digits].forEach((ch, i) => ctx.fillText(ch, left + i * cell, numY));
    ctx.font = canvasFont(900, numPx * 0.4);
    ctx.fillText('%', left + reserve + space[2], numY);

    // Gelar (signature), muncul dengan sapuan dari kiri.
    cy = numY + space[6];
    const titleK = calm ? 1 : easeOut((k - 1.0) / 0.32);
    const titlePx = fitPx(ctx, d.title, (p) => canvasFont(900, p), 64, colW - space[8]);
    ctx.font = canvasFont(900, titlePx);
    const tw = Math.ceil(ctx.measureText(d.title).width) + space[8];
    const th = 80;
    ctx.save();
    ctx.beginPath();
    ctx.rect(left - space[2], cy - space[2], (tw + space[4]) * titleK, th + space[4]);
    ctx.clip();
    sticker(ctx, left, cy, tw, th, color.hot);
    ctx.textBaseline = 'middle';
    printText(ctx, d.title, left + space[4], cy + th / 2 + 3, color.print, misprint(3));
    ctx.restore();

    // Kalimat lucu.
    cy += th + space[5];
    ctx.font = canvasFont(500, text.body, font.body);
    ctx.fillStyle = color.print;
    ctx.textBaseline = 'top';
    const lineH = 32;
    const quip = wrapLines(ctx, d.quip, colW).slice(0, 2);
    quip.forEach((line, i) => ctx.fillText(line, left, cy + i * lineH));
    cy += quip.length * lineH;

    // Kolom statistik.
    const sx = land ? left + colW + space[12] : left;
    const sw = land ? x + w - ip - sx : colW;
    // Di vertikal, sisa ruang dibagi rata ke tiga jeda di atas blok statistik.
    const blocks = 152 + 72 + 92;
    const vgap = land ? 0 : Math.max(space[8], (y + h - ctaH - ip - cy - blocks) / 3);
    let sy = land ? y + ip + space[12] + space[3] : cy + vgap;
    const gutter = space[6];
    const cellW = (sw - gutter) / 2;
    const players: Array<[PlayerId, number]> = [
      [1, d.p1Acc],
      [2, d.p2Acc],
    ];
    players.forEach(([p, acc], i) => {
      const px = sx + i * (cellW + gutter);
      ctx.font = canvasFont(600, text.meta, font.body);
      ctx.fillStyle = color.print;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(p === 1 ? 'Pemain 1 · Akor' : 'Pemain 2 · Melodi', px, sy);
      ctx.textBaseline = 'alphabetic';
      ctx.font = canvasFont(900, 88);
      const accShown = Math.round(acc * easeOut((k - 0.5) / 1.0));
      ctx.fillText(`${accShown}%`, px, sy + space[6] + 80);
      ctx.fillStyle = playerColor(p);
      ctx.fillRect(px, sy + space[6] + 80 + space[3], cellW * (accShown / 100), 8);
    });
    sy += land ? 152 : 152 + vgap - space[8];

    // Stempel biang kerok.
    const isCulprit = d.culprit.startsWith('Biang');
    const stampColor = isCulprit ? color.fail : d.culprit.startsWith('Dua') ? color.p1 : color.print;
    const stampText = d.culprit.toUpperCase();
    // Stempel tidak boleh melewati kolom statistik (sisakan ruang untuk rotasinya).
    ctx.font = canvasFont(900, fitPx(ctx, stampText, (px) => canvasFont(900, px), 44, sw - space[10] - space[6]));
    const stw = Math.ceil(ctx.measureText(stampText).width) + space[10];
    const sth = 72;
    if (stampK > 0) {
      ctx.save();
      ctx.translate(sx + stw / 2, sy + sth / 2);
      ctx.rotate(-0.05);
      const sc = calm ? 1 : 1.3 - easeOut(stampK) * 0.3;
      ctx.scale(sc, sc);
      ctx.globalAlpha = enter * stampK;
      ctx.strokeStyle = stampColor;
      ctx.lineWidth = 4;
      ctx.strokeRect(-stw / 2, -sth / 2, stw, sth);
      ctx.lineWidth = 2;
      ctx.strokeRect(-stw / 2 + space[2], -sth / 2 + space[2], stw - space[4], sth - space[4]);
      ctx.fillStyle = stampColor;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(stampText, 0, 3);
      ctx.restore();
    }
    sy += sth + (land ? space[8] : vgap);

    // Combo, tempo, dan rekor pasangan.
    const recordLabel = d.newRecord ? 'Rekor baru' : 'Rekor kalian';
    const recordValue = d.newRecord ? `${d.percent}%` : d.best !== null ? `${d.best}%` : '-';
    const facts: Array<[string, string]> = [
      ['Combo terpanjang', `${d.maxCombo}`],
      ['Tempo (BPM)', `${d.bpm}`],
      [recordLabel, recordValue],
    ];
    const factW = (sw - gutter * 2) / 3;
    facts.forEach(([label, value], i) => {
      const fx = sx + i * (factW + gutter);
      ctx.fillStyle = color.print;
      ctx.fillRect(fx, sy, factW, 2);
      ctx.font = canvasFont(600, text.meta, font.body);
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(label, fx, sy + space[3]);
      ctx.font = canvasFont(900, fitPx(ctx, value, (px) => canvasFont(900, px), 48, factW - space[4]));
      const vy = sy + space[3] + space[6];
      if (i === 2 && d.newRecord) {
        const vw = Math.ceil(ctx.measureText(value).width);
        sticker(ctx, fx - space[1], vy - space[1], vw + space[3], 52, color.hot);
        ctx.fillStyle = color.print;
      }
      ctx.fillText(value, fx + (i === 2 && d.newRecord ? space[1] : 0), vy);
    });

    // Ajakan di pita bawah.
    const ctaK = calm ? 1 : easeOut((k - 1.6) / 0.32);
    ctx.globalAlpha = enter * ctaK;
    ctx.fillStyle = color.print;
    ctx.fillRect(x, y + h - ctaH, w, ctaH);
    ctx.font = canvasFont(900, 48);
    ctx.fillStyle = color.paper;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('BERANI TANTANG TEMANMU?', left, y + h - ctaH / 2 + 3);
    ctx.fillStyle = color.hot;
    arrowRight(ctx, x + w - ip - space[5], y + h - ctaH / 2, space[4]);
    ctx.globalAlpha = enter;

    // Hasil melawan tantangan teman: stiker yang ditempel menyilang di tepi atas kartu.
    const goal = d.meta.target;
    if (goal !== null && ctaK > 0) {
      const win = d.percent > goal;
      const tie = d.percent === goal;
      const label = win ? `MENANG LAWAN ${goal}%` : tie ? `SERI DI ${goal}%` : `KALAH DARI ${goal}%`;
      ctx.font = canvasFont(900, 36);
      const vw = Math.ceil(ctx.measureText(label).width) + space[8];
      const vh = 56;
      ctx.save();
      ctx.translate(x + w - vw / 2 - space[8], y + space[2]);
      ctx.rotate(0.05);
      const sc = calm ? 1 : 1.3 - ctaK * 0.3;
      ctx.scale(sc, sc);
      ctx.globalAlpha = enter * ctaK;
      sticker(ctx, -vw / 2, -vh / 2, vw, vh, win ? color.hot : tie ? color.paper : color.fail, [[color.print, 5]], tie ? { color: color.print, width: 3 } : undefined);
      ctx.fillStyle = color.print;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(label, 0, 3);
      ctx.restore();
    }
    ctx.restore();
  }
}
