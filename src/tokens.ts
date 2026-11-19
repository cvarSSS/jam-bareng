// Token desain bersama untuk DOM (lewat CSS custom properties) dan canvas.
// Arah: flyer gig kampus cetak risograf. Kontrol tenang; tinta penuh hanya di momen permainan.

export const color = {
  /** Ramp netral bertinta (gelap). */
  bg: '#121316',
  surface: '#1a1b1f',
  raised: '#24252b',
  hairline: 'rgba(243,241,236,0.1)',
  /** Tiga peran teks. */
  ink: '#f3f1ec',
  inkDim: '#a9abb4',
  muted: '#80828c',
  /** Kertas: latar stiker dan kartu hasil. */
  paper: '#f3f1ec',
  /** Teks gelap di atas kertas dan tinta terang. */
  print: '#121316',
  /** Warna identitas pemain (dipakai seperti warna seri data). */
  p1: '#5b78ff',
  p2: '#ff4fb0',
  /** Hanya untuk momen kompak. */
  hot: '#ffe14a',
  /** Hanya untuk fals dan rekam. */
  fail: '#ff5a2b',
  shade: 'rgba(18,19,22,0.45)',
} as const;

export const font = {
  /** Wajah display: selalu kapital, hanya untuk angka dan teks momen. */
  display: "'Big Shoulders Display Variable', 'Arial Narrow', sans-serif",
  /** Wajah antarmuka: sentence case, bobot 400 sampai 600. */
  body: "'Archivo Variable', system-ui, sans-serif",
} as const;

/** Skala spasi 4px, dipakai DOM dan canvas. */
export const space = { 1: 4, 2: 8, 3: 12, 4: 16, 5: 20, 6: 24, 8: 32, 10: 40, 12: 48, 16: 64 } as const;

/**
 * Ukuran teks canvas (px). Canvas selalu punya sisi pendek 720 di kedua format,
 * jadi nilai absolut aman.
 */
export const text = {
  meta: 14,
  label: 16,
  body: 22,
  lane: 36,
  figure: 52,
  reaction: 80,
  chord: 112,
  countdown: 240,
} as const;

export const size = {
  /** Semua bentuk bersudut tajam: potongan stiker dan kertas. */
  radius: 0,
  icon: 20,
} as const;

export const motion = {
  /** Satu kurva untuk semua gerak. */
  ease: 'cubic-bezier(0.22, 1, 0.36, 1)',
  fast: 0.16,
  base: 0.32,
  enter: 0.44,
} as const;

export type PlayerId = 1 | 2;

export function playerColor(p: PlayerId): string {
  return p === 1 ? color.p1 : color.p2;
}

export function canvasFont(weight: number, px: number, family: string = font.display): string {
  return `${weight} ${Math.round(px)}px ${family}`;
}

/** Tulis token ke :root agar CSS memakai nilai yang sama dengan canvas. */
export function applyTokensToDom(root: HTMLElement = document.documentElement): void {
  const s = root.style;
  for (const [k, v] of Object.entries(color)) s.setProperty(`--c-${k}`, v);
  for (const [k, v] of Object.entries(font)) s.setProperty(`--f-${k}`, v);
  for (const [k, v] of Object.entries(space)) s.setProperty(`--s-${k}`, `${v}px`);
  s.setProperty('--radius', `${size.radius}px`);
  s.setProperty('--icon', `${size.icon}px`);
  s.setProperty('--ease', motion.ease);
  s.setProperty('--t-fast', `${motion.fast}s`);
  s.setProperty('--t-base', `${motion.base}s`);
  s.setProperty('--t-enter', `${motion.enter}s`);
}

/** Pastikan font sudah siap sebelum canvas menggambar teks. */
export async function loadFonts(): Promise<void> {
  if (!document.fonts) return;
  await Promise.allSettled([
    document.fonts.load(`900 64px ${font.display}`),
    document.fonts.load(`800 64px ${font.display}`),
    document.fonts.load(`600 16px ${font.body}`),
    document.fonts.load(`500 16px ${font.body}`),
  ]);
}
