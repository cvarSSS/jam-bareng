// Penjadwal ketukan (berbasis AudioContext.currentTime) dan logika permainan.
import type { AudioEngine } from './audio';
import type { GrooveId, LevelId } from './challenge';
import type { ChordName } from './tracking';

export const TEMPOS = [
  { id: 'santai', label: 'Santai', bpm: 84 },
  { id: 'normal', label: 'Normal', bpm: 100 },
  { id: 'ngebut', label: 'Ngebut', bpm: 120 },
] as const;

export const CHORD_MIDI: Record<ChordName, number[]> = {
  C: [48, 52, 55, 60, 64],
  G: [43, 47, 50, 55, 59],
  Am: [45, 52, 57, 60, 64],
  F: [41, 48, 53, 57, 60],
};

export const CHORD_FINGERS: Record<ChordName, number> = { C: 1, G: 2, Am: 3, F: 4 };

/** Jalur melodi dari bawah ke atas: pentatonik C. */
export const LANES = [
  { name: 'Do', note: 'C5', midi: 72 },
  { name: 'Re', note: 'D5', midi: 74 },
  { name: 'Mi', note: 'E5', midi: 76 },
  { name: 'Sol', note: 'G5', midi: 79 },
  { name: 'La', note: 'A5', midi: 81 },
] as const;

export const CHORDS: ChordName[] = ['C', 'G', 'Am', 'F'];
/**
 * Jalur yang berisi nada akor (Do C, Re D, Mi E, Sol G, La A).
 * Target melodi acak dipilih dari sini, jadi selalu enak didengar.
 */
export const CHORD_LANES: Record<ChordName, number[]> = {
  C: [0, 2, 3],
  G: [1, 3],
  Am: [0, 2, 4],
  F: [0, 4],
};
/** Level Gampang: pola tetap yang bisa dihafal. */
const EASY_LANE: Record<ChordName, number> = { C: 2, G: 3, Am: 4, F: 0 };

export const CHALLENGE_BARS = 16;
export const CHALLENGE_BEATS = CHALLENGE_BARS * 4;

const pickOther = <T>(xs: readonly T[], prev: T | undefined, rnd: () => number): T => {
  const options = xs.filter((x) => x !== prev);
  return options[Math.floor(rnd() * options.length)];
};

/** Akor acak dari C, G, Am, F. Tidak pernah sama dengan sebelumnya, supaya Pemain 1 selalu ganti. */
export function randomChords(count = CHALLENGE_BARS, rnd: () => number = Math.random): ChordName[] {
  const out: ChordName[] = [];
  for (let i = 0; i < count; i++) out.push(pickOther(CHORDS, out[i - 1], rnd));
  return out;
}

/** Satu target jalur per akor, dipilih dari nada akornya. Tidak pernah sama dengan sebelumnya. */
export function randomMelody(chords: ChordName[], rnd: () => number = Math.random): number[] {
  const out: number[] = [];
  chords.forEach((c, i) => out.push(pickOther(CHORD_LANES[c], out[i - 1], rnd)));
  return out;
}

export interface Sequence {
  chords: ChordName[];
  melody: number[];
}

/**
 * Urutan 16 birama untuk satu tantangan.
 * Gampang: C-G-Am-F tetap. Sedang: acak tiap 2 birama. Susah: acak tiap birama.
 */
export function buildSequence(level: LevelId, rnd: () => number = Math.random): Sequence {
  if (level === 'gampang') {
    const chords = Array.from({ length: CHALLENGE_BARS }, (_, b) => CHORDS[b % CHORDS.length]);
    return { chords, melody: chords.map((c) => EASY_LANE[c]) };
  }
  const span = level === 'sedang' ? 2 : 1;
  const chords = randomChords(CHALLENGE_BARS / span, rnd);
  const melody = randomMelody(chords, rnd);
  const expand = <T>(xs: T[]) => xs.flatMap((x) => Array<T>(span).fill(x));
  return { chords: expand(chords), melody: expand(melody) };
}

// ---------- Groove ----------

type Hit = [step: number, level: number];
interface Groove {
  kick: Hit[];
  snare: Hit[];
  hat: Hit[];
  dhut?: Hit[];
  tak?: Hit[];
  ket?: Hit[];
  /** Geser not 1/8 di antara ketukan, dalam satuan 1/16. */
  swing: number;
}

const every = (from: number, by: number, level: number): Hit[] =>
  Array.from({ length: Math.ceil((16 - from) / by) }, (_, i) => [from + i * by, level] as Hit);

/** Pola satu birama dalam 16 langkah (1/16). */
export const GROOVES: Record<GrooveId, Groove> = {
  pop: {
    kick: [[0, 1], [8, 1]],
    snare: [],
    hat: every(0, 2, 0.55).map(([s]) => [s, s % 4 === 0 ? 1 : 0.55] as Hit),
    swing: 0,
  },
  koplo: {
    kick: [],
    snare: [],
    hat: every(2, 4, 0.7),
    dhut: [[0, 1], [6, 0.8], [8, 1], [14, 0.8]],
    tak: [[4, 1], [12, 1]],
    ket: [[3, 1], [7, 0.8], [10, 1], [11, 0.7], [15, 0.8]],
    swing: 0,
  },
  punk: {
    kick: [[0, 1], [6, 0.8], [8, 1], [10, 0.8]],
    snare: [[4, 1], [12, 1]],
    hat: every(0, 2, 0.8),
    swing: 0,
  },
  lofi: {
    kick: [[0, 0.9], [7, 0.6], [10, 0.8]],
    snare: [[4, 0.55], [12, 0.55]],
    hat: every(0, 2, 0.35),
    swing: 0.34,
  },
};

const LOOKAHEAD = 0.1;
/** Akor dan melodi diputuskan sedekat mungkin dengan ketukan, bukan saat dijadwalkan. */
const DECIDE_AHEAD = 0.03;
/** Toleransi telat: tangan yang baru sampai di posisi benar dalam jendela ini tetap dihitung kompak. */
export const GRACE = 0.16;
const FAIL_TEXTS = ['FALS!', 'MELESET!', 'WADUH!', 'EH SALAH!', 'AMBYAR!'];

export interface PlayerInput {
  chord: ChordName | null;
  p2Open: boolean;
  p2Lane: number | null;
}

export type Phase = 'free' | 'countdown' | 'challenge' | 'outro' | 'result';

/** Info tantangan yang ikut tercetak di kartu hasil. */
export interface ChallengeMeta {
  level: LevelId;
  groove: GrooveId;
  code: string;
  /** Skor teman yang harus dikalahkan, atau null bila bukan dari link. */
  target: number | null;
}

export interface ResultData {
  percent: number;
  p1Acc: number;
  p2Acc: number;
  maxCombo: number;
  bpm: number;
  title: string;
  quip: string;
  culprit: string;
  meta: ChallengeMeta;
  /** Rekor sebelum permainan ini (diisi main.ts dari penyimpanan lokal). */
  best: number | null;
  newRecord: boolean;
}

export type GameEvent =
  | { kind: 'beat'; t: number; phase: 'free' | 'challenge'; beatInBar: number; beat: number; target: ChordName | null }
  | { kind: 'count'; t: number; index: number; label: string }
  | {
      kind: 'judge';
      t: number;
      beat: number;
      p1ok: boolean;
      p2ok: boolean;
      combo: number;
      percent: number;
      p1Text: string | null;
      p2Text: string | null;
    }
  | { kind: 'comboBreak'; t: number; lost: number }
  | { kind: 'finish'; t: number }
  | { kind: 'result'; t: number; data: ResultData };

/** Keadaan yang dibaca renderer, diperbarui saat event benar-benar terdengar. */
export interface GameView {
  phase: Phase;
  beatInBar: number;
  beatT: number;
  /** Indeks ketukan tantangan 0..63, -1 bila belum mulai. */
  beat: number;
  target: ChordName | null;
  next: ChordName | null;
  /** Jalur melodi target birama ini dan birama berikutnya. */
  targetLane: number | null;
  nextLane: number | null;
  percent: number;
  combo: number;
  countLabel: string | null;
  result: ResultData | null;
  resultT: number;
}

const TITLES: Array<{ min: number; title: string; quips: string[] }> = [
  { min: 85, title: 'SOULMATE MUSIK', quips: ['Satu frekuensi. Nikah aja.', 'Kalian latihan diam-diam, ya?'] },
  {
    min: 65,
    title: 'DUO KOMPAK',
    quips: ['Dikit lagi bisa manggung di nikahan tetangga.', 'Chemistry-nya dapet, jam terbangnya kurang dikit.'],
  },
  {
    min: 40,
    title: 'LUMAYAN LAH',
    quips: ['Kadang nyambung, kadang kayak sinyal di lift.', 'Setengah kompak, setengah nekat.'],
  },
  {
    min: 20,
    title: 'KAYAK TOM & JERRY',
    quips: ['Kejar-kejaran terus, nggak pernah ketemu.', 'Satu ke kiri, satu ke kanan. Klasik.'],
  },
  {
    min: 0,
    title: 'BUBAR AJA BANDNYA',
    quips: ['Fals-nya kedengeran sampai RT sebelah.', 'Tetangga udah siap-siap lapor Pak RT.'],
  },
];

const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)];

export function buildResult(
  kompak: number,
  p1Hits: number,
  p2Hits: number,
  maxCombo: number,
  bpm: number,
  meta: ChallengeMeta,
): ResultData {
  const pct = (n: number) => Math.round((n / CHALLENGE_BEATS) * 100);
  const percent = pct(kompak);
  const p1Acc = pct(p1Hits);
  const p2Acc = pct(p2Hits);
  const tier = TITLES.find((x) => percent >= x.min) ?? TITLES[TITLES.length - 1];
  let culprit: string;
  if (p1Acc >= 80 && p2Acc >= 80) culprit = 'Dua-duanya jago';
  else if (Math.abs(p1Acc - p2Acc) < 10) culprit = 'Sama-sama bikin kacau';
  else culprit = `Biang kerok: Pemain ${p1Acc < p2Acc ? 1 : 2}`;
  return {
    percent,
    p1Acc,
    p2Acc,
    maxCombo,
    bpm,
    title: tier.title,
    quip: pick(tier.quips),
    culprit,
    meta,
    best: null,
    newRecord: false,
  };
}

/** Satu ketukan yang nadanya belum diputuskan. `target` null berarti latihan bebas. */
interface PendingBeat {
  t: number;
  beat: number;
  target: ChordName | null;
  lane: number | null;
  accent: boolean;
  dur: number;
  p1: { done: boolean; ok: boolean };
  p2: { done: boolean; ok: boolean };
}

/** Detune fals acak: plus/minus 45..70 cent. */
const falsCents = () => (Math.random() < 0.5 ? -1 : 1) * (45 + Math.random() * 25);

export class Game {
  bpm = 100;
  groove: GrooveId = 'pop';
  private phase: Phase = 'free';
  private running = false;
  /** Langkah 1/16 sejak awal pola birama. */
  private step = 0;
  private nextT = 0;
  private cBeat = 0;
  private stats = { kompak: 0, p1: 0, p2: 0, combo: 0, maxCombo: 0 };
  private lastFail = '';
  private queue: GameEvent[] = [];
  private pending: PendingBeat[] = [];
  private seq: Sequence = buildSequence('sedang');
  private meta: ChallengeMeta = { level: 'sedang', groove: 'pop', code: '', target: null };

  view: GameView = {
    phase: 'free',
    beatInBar: 0,
    beatT: 0,
    beat: -1,
    target: null,
    next: null,
    targetLane: null,
    nextLane: null,
    percent: 0,
    combo: 0,
    countLabel: null,
    result: null,
    resultT: 0,
  };

  constructor(
    private audio: AudioEngine,
    private readInput: () => PlayerInput,
  ) {}

  get schedPhase(): Phase {
    return this.phase;
  }

  private get stepDur(): number {
    return 60 / this.bpm / 4;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextT = this.audio.now + 0.12;
    this.step = 0;
    // setInterval hanya untuk membangunkan penjadwal; waktu bunyi dari AudioContext.
    window.setInterval(() => this.tick(), 25);
  }

  /** Kembali ke latihan bebas (setelah kartu hasil ditutup). */
  toFree(): void {
    this.phase = 'free';
    this.view = {
      ...this.view,
      phase: 'free',
      beat: -1,
      target: null,
      next: null,
      targetLane: null,
      nextLane: null,
      countLabel: null,
      result: null,
    };
    this.queue = [];
    this.pending = [];
    if (!this.running) this.start();
    else {
      this.nextT = Math.max(this.nextT, this.audio.now + 0.12);
      this.step = 0;
    }
  }

  /** Mulai hitung mundur di ketukan berikutnya, dengan urutan dan info tantangan ini. */
  startChallenge(seq: Sequence, meta: ChallengeMeta): void {
    this.stats = { kompak: 0, p1: 0, p2: 0, combo: 0, maxCombo: 0 };
    this.seq = seq;
    this.meta = meta;
    this.cBeat = 0;
    this.phase = 'countdown';
    // Lompat ke awal ketukan berikutnya, lalu pola groove dimulai dari awal birama.
    while (this.step % 4 !== 0) {
      this.nextT += this.stepDur;
      this.step++;
    }
    this.step = 0;
  }

  /** Dipanggil setiap tick & setiap frame. */
  tick(): void {
    if (!this.running) return;
    const horizon = this.audio.now + LOOKAHEAD;
    // Bila tab sempat tertidur, lompati ketukan yang sudah lewat.
    if (this.nextT < this.audio.now - 0.2) this.nextT = this.audio.now + 0.05;
    while (this.nextT < horizon) {
      this.scheduleStep(this.step, this.nextT);
      this.nextT += this.stepDur;
      this.step++;
    }
    this.resolve();
  }

  /** Ambil event yang waktunya sudah lewat, dan perbarui view. */
  drain(now: number): GameEvent[] {
    const due: GameEvent[] = [];
    while (this.queue.length && this.queue[0].t <= now) {
      const ev = this.queue.shift()!;
      this.applyView(ev);
      due.push(ev);
    }
    return due;
  }

  private emit(ev: GameEvent): void {
    this.queue.push(ev);
    this.queue.sort((a, b) => a.t - b.t);
  }

  private applyView(ev: GameEvent): void {
    const v = this.view;
    switch (ev.kind) {
      case 'beat':
        v.phase = ev.phase;
        v.beatInBar = ev.beatInBar;
        v.beatT = ev.t;
        v.countLabel = null;
        if (ev.phase === 'challenge') {
          const bar = Math.floor(ev.beat / 4);
          v.beat = ev.beat;
          v.target = ev.target;
          v.next = this.seq.chords[bar + 1] ?? null;
          v.targetLane = this.seq.melody[bar];
          v.nextLane = this.seq.melody[bar + 1] ?? null;
        }
        break;
      case 'count':
        v.phase = 'countdown';
        v.beatInBar = ev.index;
        v.beatT = ev.t;
        v.countLabel = ev.label;
        v.beat = -1;
        v.percent = 0;
        v.combo = 0;
        v.target = this.seq.chords[0];
        v.next = this.seq.chords[1];
        v.targetLane = this.seq.melody[0];
        v.nextLane = this.seq.melody[1];
        v.result = null;
        break;
      case 'judge':
        v.percent = ev.percent;
        v.combo = ev.combo;
        break;
      case 'finish':
        v.phase = 'outro';
        v.beat = CHALLENGE_BEATS;
        v.beatT = ev.t;
        break;
      case 'result':
        v.phase = 'result';
        v.result = ev.data;
        v.resultT = ev.t;
        break;
      case 'comboBreak':
        break;
    }
  }

  private failText(): string {
    let t = pick(FAIL_TEXTS);
    if (t === this.lastFail) t = pick(FAIL_TEXTS);
    this.lastFail = t;
    return t;
  }

  /** Bunyikan drum groove untuk satu langkah 1/16. */
  private playGroove(s16: number, t: number, drumsOnly: 'hat' | 'all'): void {
    const a = this.audio;
    const g = GROOVES[this.groove];
    // Swing: not 1/8 di antara ketukan digeser sedikit.
    const at = s16 % 4 === 2 ? t + g.swing * this.stepDur : t;
    const hitAt = (hits: Hit[] | undefined, fn: (level: number) => void) => {
      const h = hits?.find(([s]) => s === s16);
      if (h) fn(h[1]);
    };
    hitAt(g.hat, (l) => a.hat(at, l));
    if (drumsOnly === 'hat') return;
    hitAt(g.kick, (l) => a.kick(at, l));
    hitAt(g.snare, (l) => a.snare(at, l));
    hitAt(g.dhut, (l) => a.kendang(at, 'dhut', l));
    hitAt(g.tak, (l) => a.kendang(at, 'tak', l));
    hitAt(g.ket, (l) => a.kendang(at, 'ket', l));
  }

  private scheduleStep(step: number, t: number): void {
    const a = this.audio;
    const s16 = step % 16;
    const isBeat = step % 4 === 0;
    const beatDur = this.stepDur * 4;

    if (this.phase === 'result' || this.phase === 'outro') return;

    if (this.phase === 'countdown') {
      this.playGroove(s16, t, 'hat');
      if (!isBeat) return;
      const labels = ['SIAP', '3', '2', '1'];
      a.tick(t, this.cBeat === 0);
      this.emit({ kind: 'count', t, index: this.cBeat, label: labels[this.cBeat] });
      this.cBeat++;
      if (this.cBeat >= 4) {
        this.phase = 'challenge';
        // Hitung mundur pas 16 langkah, jadi birama pertama tantangan otomatis mulai di awal pola groove.
        this.cBeat = 0;
      }
      return;
    }

    if (this.phase === 'free') {
      this.playGroove(s16, t, 'all');
      if (!isBeat) return;
      const bib = s16 / 4;
      this.queueBeat(t, -1, null, null, bib === 0, beatDur);
      this.emit({ kind: 'beat', t, phase: 'free', beatInBar: bib, beat: -1, target: null });
      return;
    }

    // Tantangan: drum tetap di grid; akor dan melodi diputuskan di resolve().
    const beat = this.cBeat;
    if (beat >= CHALLENGE_BEATS) {
      if (isBeat) this.finish(t, beatDur);
      else this.playGroove(s16, t, 'all');
      return;
    }
    this.playGroove(s16, t, 'all');
    if (!isBeat) return;
    const bib = beat % 4;
    const bar = Math.floor(beat / 4);
    const target = this.seq.chords[bar];
    this.queueBeat(t, beat, target, this.seq.melody[bar], bib === 0, beatDur);
    this.emit({ kind: 'beat', t, phase: 'challenge', beatInBar: bib, beat, target });
    this.cBeat++;
  }

  private queueBeat(t: number, beat: number, target: ChordName | null, lane: number | null, accent: boolean, beatDur: number): void {
    this.pending.push({
      t,
      beat,
      target,
      lane,
      accent,
      dur: beatDur * 0.95,
      p1: { done: false, ok: false },
      p2: { done: false, ok: false },
    });
  }

  /**
   * Putuskan nada tiap ketukan. Posisi benar dibunyikan normal (paling cepat tepat di ketukan,
   * atau sedikit telat bila tangan baru sampai). Bila sampai jendela toleransi habis masih salah,
   * nadanya dibunyikan fals.
   */
  private resolve(force = false): void {
    const a = this.audio;
    const now = a.now;
    while (this.pending.length) {
      const pb = this.pending[0];
      if (!force && now < pb.t - DECIDE_AHEAD) return;
      const input = this.readInput();
      const at = Math.max(pb.t, now);
      const late = at - pb.t;
      const playChord = (cents: number) => {
        if (input.chord) a.strum(CHORD_MIDI[input.chord], at, Math.max(0.12, pb.dur - late), pb.accent, cents);
      };
      const playMelody = (cents: number) => {
        if (input.p2Open && input.p2Lane !== null) a.pluck(LANES[input.p2Lane].midi, at, cents);
      };

      if (pb.target === null) {
        playChord(0);
        playMelody(0);
        this.pending.shift();
        continue;
      }

      const expired = force || now >= pb.t + GRACE;
      if (!pb.p1.done) {
        const ok = input.chord === pb.target;
        if (ok || expired) {
          pb.p1 = { done: true, ok };
          if (!force) playChord(ok ? 0 : falsCents());
        }
      }
      if (!pb.p2.done) {
        const ok = input.p2Open && input.p2Lane === pb.lane;
        if (ok || expired) {
          pb.p2 = { done: true, ok };
          if (!force) playMelody(ok ? 0 : falsCents());
        }
      }
      if (!pb.p1.done || !pb.p2.done) return;
      this.pending.shift();
      this.judge(pb, at);
    }
  }

  private judge(pb: PendingBeat, at: number): void {
    const a = this.audio;
    const s = this.stats;
    const p1ok = pb.p1.ok;
    const p2ok = pb.p2.ok;
    if (p1ok) s.p1++;
    if (p2ok) s.p2++;
    if (p1ok && p2ok) {
      s.kompak++;
      s.combo++;
      s.maxCombo = Math.max(s.maxCombo, s.combo);
      if (s.combo === 8 || s.combo % 16 === 0) a.chime(at);
    } else {
      if (s.combo >= 4) {
        a.sadTrombone(at + 0.02);
        this.emit({ kind: 'comboBreak', t: at, lost: s.combo });
      }
      s.combo = 0;
    }
    this.emit({
      kind: 'judge',
      t: at,
      beat: pb.beat,
      p1ok,
      p2ok,
      combo: s.combo,
      percent: Math.round((s.kompak / (pb.beat + 1)) * 100),
      p1Text: p1ok ? null : this.failText(),
      p2Text: p2ok ? null : this.failText(),
    });
  }

  private finish(t: number, beatDur: number): void {
    const a = this.audio;
    // Pastikan semua ketukan sudah dinilai sebelum hasil dihitung.
    this.resolve(true);
    // Setelah ini penjadwal diam sampai toFree().
    this.phase = 'result';
    a.kick(t, 1.2);
    a.strum(CHORD_MIDI.C, t, beatDur * 4, true);
    a.cymbal(t);
    this.emit({ kind: 'finish', t });
    const s = this.stats;
    const data = buildResult(s.kompak, s.p1, s.p2, s.maxCombo, this.bpm, this.meta);
    this.emit({ kind: 'result', t: t + beatDur * 2, data });
  }
}
