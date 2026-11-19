import { FilesetResolver, HandLandmarker, type NormalizedLandmark } from '@mediapipe/tasks-vision';

const WASM_PATH = `${import.meta.env.BASE_URL}mediapipe`;
const MODEL_URL =
  'https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task';

export type ChordName = 'C' | 'G' | 'Am' | 'F';
export const CHORD_BY_FINGERS: Record<number, ChordName | null> = { 0: null, 1: 'C', 2: 'G', 3: 'Am', 4: 'F' };

/** Titik landmark dalam koordinat kamera yang sudah dicerminkan (0..1). */
export interface Pt {
  x: number;
  y: number;
}

export interface TrackedHand {
  /** 21 landmark, x sudah dicerminkan, ternormalisasi ke frame kamera penuh. */
  pts: Pt[];
  fingers: number;
}

export interface Hands {
  p1: TrackedHand | null;
  p2: TrackedHand | null;
}

export async function createHandTracker(): Promise<HandLandmarker> {
  const fileset = await FilesetResolver.forVisionTasks(WASM_PATH);
  const make = (delegate: 'GPU' | 'CPU') =>
    HandLandmarker.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: MODEL_URL, delegate },
      runningMode: 'VIDEO',
      numHands: 2,
      minHandDetectionConfidence: 0.5,
      minHandPresenceConfidence: 0.5,
      minTrackingConfidence: 0.5,
    });
  try {
    return await make('GPU');
  } catch (err) {
    console.warn('Delegate GPU gagal, pindah ke CPU.', err);
    return make('CPU');
  }
}

const FINGERS: Array<[tip: number, pip: number]> = [
  [8, 6],
  [12, 10],
  [16, 14],
  [20, 18],
];

/** Hitung jari terangkat (jempol tidak dihitung). Jarak dihitung dalam piksel kamera. */
export function countFingers(lm: NormalizedLandmark[], vw: number, vh: number): number {
  const wx = lm[0].x * vw;
  const wy = lm[0].y * vh;
  const dist = (i: number) => Math.hypot(lm[i].x * vw - wx, lm[i].y * vh - wy);
  let n = 0;
  for (const [tip, pip] of FINGERS) if (dist(tip) > 1.12 * dist(pip)) n++;
  return n;
}

let lastTs = -1;

/** Deteksi tangan lalu bagi ke pemain berdasarkan landmark 9 setelah dicerminkan. */
export function detectHands(tracker: HandLandmarker, video: HTMLVideoElement, now: number): Hands {
  const out: Hands = { p1: null, p2: null };
  // detectForVideo menolak timestamp yang tidak naik.
  const ts = now <= lastTs ? lastTs + 1 : now;
  lastTs = ts;
  const res = tracker.detectForVideo(video, ts);
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  for (const lm of res.landmarks) {
    const pts = lm.map((p) => ({ x: 1 - p.x, y: p.y }));
    const hand: TrackedHand = { pts, fingers: countFingers(lm, vw, vh) };
    if (pts[9].x < 0.5) out.p1 ??= hand;
    else out.p2 ??= hand;
  }
  return out;
}

/** Debounce: nilai baru diterima setelah stabil selama `frames` frame berturut-turut. */
export class Debounce<T> {
  private candidate: T;
  private count = 0;
  constructor(
    public value: T,
    private frames: number,
  ) {
    this.candidate = value;
  }
  push(v: T): T {
    if (v === this.value) {
      this.count = 0;
      this.candidate = v;
      return this.value;
    }
    if (v === this.candidate) this.count++;
    else {
      this.candidate = v;
      this.count = 1;
    }
    if (this.count >= this.frames) {
      this.value = v;
      this.count = 0;
    }
    return this.value;
  }
}
