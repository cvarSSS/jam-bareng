// Kode tantangan (seed), link untuk menantang teman, dan rekor pasangan di browser ini.

export type LevelId = 'gampang' | 'sedang' | 'susah';
export type GrooveId = 'pop' | 'koplo' | 'punk' | 'lofi';

export const LEVELS: Array<{ id: LevelId; label: string }> = [
  { id: 'gampang', label: 'Gampang' },
  { id: 'sedang', label: 'Sedang' },
  { id: 'susah', label: 'Susah' },
];

export const GROOVES: Array<{ id: GrooveId; label: string }> = [
  { id: 'pop', label: 'Pop' },
  { id: 'koplo', label: 'Koplo' },
  { id: 'punk', label: 'Punk' },
  { id: 'lofi', label: 'Lo-fi' },
];

export const levelLabel = (id: LevelId) => LEVELS.find((l) => l.id === id)?.label ?? id;
export const grooveLabel = (id: GrooveId) => GROOVES.find((g) => g.id === id)?.label ?? id;

/** Huruf tanpa yang mudah tertukar (0/O, 1/I/L). */
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = /^[A-HJKMNP-Z2-9]{4,8}$/;

export function newCode(len = 5): string {
  let s = '';
  for (let i = 0; i < len; i++) s += ALPHABET[Math.floor(Math.random() * ALPHABET.length)];
  return s;
}

/** RNG deterministik (mulberry32) dari kode tantangan. */
export function seededRandom(code: string): () => number {
  let h = 2166136261;
  for (const ch of code) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  let a = h >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Invite {
  code: string;
  level: LevelId;
  bpm: number;
  groove: GrooveId;
  /** Skor yang harus dikalahkan. */
  score: number;
}

const BPMS = [84, 100, 120];

/** Baca tantangan dari URL. Mengembalikan null bila tidak ada atau tidak valid. */
export function readInvite(search: string): Invite | null {
  const p = new URLSearchParams(search);
  const code = (p.get('t') ?? '').toUpperCase();
  const level = p.get('l') as LevelId;
  const groove = p.get('g') as GrooveId;
  const bpm = Number(p.get('b'));
  const score = Number(p.get('s'));
  if (!CODE_RE.test(code)) return null;
  if (!LEVELS.some((l) => l.id === level) || !GROOVES.some((g) => g.id === groove)) return null;
  if (!BPMS.includes(bpm) || !Number.isInteger(score) || score < 0 || score > 100) return null;
  return { code, level, bpm, groove, score };
}

export function inviteUrl(inv: Invite): string {
  const u = new URL(location.origin + location.pathname);
  u.searchParams.set('t', inv.code);
  u.searchParams.set('l', inv.level);
  u.searchParams.set('b', String(inv.bpm));
  u.searchParams.set('g', inv.groove);
  u.searchParams.set('s', String(inv.score));
  return u.toString();
}

// ---------- Penyimpanan lokal (boleh gagal; game tetap jalan tanpa ini) ----------

const KEY_BEST = 'jam-bareng:rekor';
const KEY_PREFS = 'jam-bareng:pengaturan';

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* mode privat atau penyimpanan diblokir */
  }
}

/** Rekor terbaik per level sebelum permainan ini, lalu simpan skor baru bila lebih tinggi. */
export function recordScore(level: LevelId, percent: number): { best: number | null; newRecord: boolean } {
  const all = readJson<Record<string, number>>(KEY_BEST, {});
  const prev = typeof all[level] === 'number' ? all[level] : null;
  const newRecord = prev === null || percent > prev;
  if (newRecord) writeJson(KEY_BEST, { ...all, [level]: percent });
  return { best: prev, newRecord };
}

export interface Prefs {
  bpm: number;
  level: LevelId;
  groove: GrooveId;
  format: 'landscape' | 'vertical';
  rec: boolean;
}

export const DEFAULT_PREFS: Prefs = { bpm: 100, level: 'sedang', groove: 'pop', format: 'landscape', rec: true };

export function loadPrefs(): Prefs {
  return readJson(KEY_PREFS, DEFAULT_PREFS);
}

export function savePrefs(p: Prefs): void {
  writeJson(KEY_PREFS, p);
}
