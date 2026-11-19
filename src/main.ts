import '@fontsource-variable/big-shoulders-display/wght';
import '@fontsource-variable/archivo/wght';
import './style.css';
import { AudioEngine } from './audio';
import {
  GROOVES as GROOVE_LIST,
  LEVELS,
  grooveLabel,
  inviteUrl,
  levelLabel,
  loadPrefs,
  newCode,
  readInvite,
  recordScore,
  savePrefs,
  seededRandom,
  type GrooveId,
  type Invite,
  type LevelId,
  type Prefs,
} from './challenge';
import { buildResult, buildSequence, Game, LANES, TEMPOS, type GameView, type PlayerInput, type ResultData } from './game';
import { Recorder, canRecord, type Recording } from './recorder';
import { Renderer } from './render';
import { mountIcons } from './icons';
import { applyTokensToDom, loadFonts } from './tokens';
import { CHORD_BY_FINGERS, createHandTracker, Debounce, detectHands, type ChordName, type Hands, type Pt } from './tracking';
import type { HandLandmarker } from '@mediapipe/tasks-vision';

applyTokensToDom();
mountIcons();
void loadFonts();

const $ = <T extends HTMLElement>(sel: string) => document.querySelector(sel) as T;

const intro = $('#intro');
const stage = $('#stage');
const startBtn = $<HTMLButtonElement>('#start');
const statusEl = $('#status');
const errorEl = $('#error');
const inviteEl = $('#invite');
const canvas = $<HTMLCanvasElement>('#canvas');
const video = $<HTMLVideoElement>('#video');
const controlBar = $('#controls');
const challengeBtn = $<HTMLButtonElement>('#challenge');
const challengeLabel = challengeBtn.querySelector('.label') as HTMLElement;
const cancelReadyBtn = $<HTMLButtonElement>('#cancel-ready');
const recToggle = $<HTMLInputElement>('#rec');
const inviteChip = $('#invite-chip');
const inviteChipText = $('#invite-chip-text');
const dropInviteBtn = $<HTMLButtonElement>('#drop-invite');
const resultBar = $('#result-actions');
const downloadBtn = $<HTMLButtonElement>('#download');
const downloadLabel = downloadBtn.querySelector('.label') as HTMLElement;
const shortBtn = $<HTMLButtonElement>('#download-short');
const imageBtn = $<HTMLButtonElement>('#save-image');
const shareBtn = $<HTMLButtonElement>('#share');
const linkBtn = $<HTMLButtonElement>('#copy-link');
const againBtn = $<HTMLButtonElement>('#again');
const freeBtn = $<HTMLButtonElement>('#free');
const resultNote = $('#result-note');

const params = new URLSearchParams(location.search);
const prefs: Prefs = loadPrefs();
if (params.get('format') === 'vertical') prefs.format = 'vertical';
let invite: Invite | null = readInvite(location.search);

const renderer = new Renderer(canvas, prefs.format);

let audio: AudioEngine | null = null;
let game: Game | null = null;
let tracker: HandLandmarker | null = null;
/** Video penuh dan video pendek (awal + akhir tantangan) direkam bersamaan. */
const fullRec = new Recorder();
const shortRec = new Recorder();
let fullVideo: Recording | null = null;
let shortVideo: Recording | null = null;
let lastResult: ResultData | null = null;
/** Info tantangan yang sedang atau terakhir dimainkan, untuk link. */
let current: { code: string; level: LevelId; groove: GrooveId; bpm: number } | null = null;
/** Naik setiap tantangan dimulai, agar timer rekaman lama tidak menghentikan rekaman baru. */
let runId = 0;

/** Video pendek: jeda setelah 2 birama pertama, lanjut lagi di 3 birama terakhir. */
const SHORT_PAUSE_BEAT = 8;
const SHORT_RESUME_BEAT = 52;

// ---------- Keadaan input tangan ----------
const chordDb = new Debounce<ChordName | null>(null, 3);
let hands: Hands = { p1: null, p2: null };
let p2Open = false;
let p2Lane: number | null = null;
let lastVideoTime = -1;

// Penghalus input melodi: membuka telapak langsung terbaca, tetapi menutup baru diterima
// setelah beberapa frame, dan tangan yang hilang sesaat dari deteksi tidak memutus nada.
const CLOSE_FRAMES = 3;
const LOST_FRAMES = 4;
/** Telapak harus melewati batas jalur sejauh ini (dalam satuan tinggi jalur) sebelum pindah jalur. */
const LANE_HYSTERESIS = 0.25;
let p2ClosedFor = 0;
let p2LostFor = 0;

function readInput(): PlayerInput {
  return { chord: chordDb.value, p2Open, p2Lane };
}

function laneFromY(yRegion: number, prev: number | null): number {
  // Posisi kontinu dalam satuan jalur: 0 di batas bawah Do, 5 di batas atas La.
  const k = ((0.9 - yRegion) / 0.8) * LANES.length;
  if (prev !== null && k > prev - LANE_HYSTERESIS && k < prev + 1 + LANE_HYSTERESIS) return prev;
  return Math.min(LANES.length - 1, Math.max(0, Math.floor(k)));
}

function updateHands(): void {
  if (!tracker || video.readyState < 2) return;
  if (video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;
  hands = detectHands(tracker, video, performance.now());
  chordDb.push(hands.p1 ? CHORD_BY_FINGERS[hands.p1.fingers] : null);

  if (!hands.p2) {
    if (++p2LostFor >= LOST_FRAMES) {
      p2Open = false;
      p2Lane = null;
    }
    return;
  }
  p2LostFor = 0;
  const palm = renderer.mapPoints(2, [hands.p2.pts[9]], video.videoWidth, video.videoHeight)[0];
  p2Lane = laneFromY(renderer.regionY(2, palm.y), p2Lane);
  if (hands.p2.fingers >= 2) {
    p2Open = true;
    p2ClosedFor = 0;
  } else if (++p2ClosedFor >= CLOSE_FRAMES) {
    p2Open = false;
  }
}

// ---------- Pengaturan ----------

/** Pengaturan yang berlaku: dari link tantangan bila ada, kalau tidak dari pilihan pemain. */
function settings(): { bpm: number; level: LevelId; groove: GrooveId } {
  return invite ? { bpm: invite.bpm, level: invite.level, groove: invite.groove } : prefs;
}

function setSegmented(groupId: string, value: string): void {
  document.querySelectorAll<HTMLButtonElement>(`#${groupId} button`).forEach((b) => {
    b.setAttribute('aria-pressed', String(b.dataset.value === value));
  });
}

function reflectSettings(): void {
  const s = settings();
  setSegmented('tempo', TEMPOS.find((t) => t.bpm === s.bpm)?.id ?? 'normal');
  setSegmented('level', s.level);
  setSegmented('groove', s.groove);
  setSegmented('format', prefs.format);
  recToggle.checked = prefs.rec;
  if (game) {
    game.bpm = s.bpm;
    game.groove = s.groove;
  }
  inviteChip.hidden = !invite;
  if (invite) inviteChipText.textContent = `Tantangan teman: kalahkan ${invite.score}%`;
}

function onSegment(groupId: string, apply: (value: string) => void): void {
  document.querySelectorAll<HTMLButtonElement>(`#${groupId} button`).forEach((b) => {
    b.addEventListener('click', () => {
      if (busy()) return;
      apply(b.dataset.value!);
      savePrefs(prefs);
      reflectSettings();
    });
  });
}

onSegment('tempo', (v) => (prefs.bpm = TEMPOS.find((t) => t.id === v)?.bpm ?? 100));
onSegment('level', (v) => (prefs.level = LEVELS.find((l) => l.id === v)?.id ?? 'sedang'));
onSegment('groove', (v) => (prefs.groove = GROOVE_LIST.find((g) => g.id === v)?.id ?? 'pop'));
onSegment('format', (v) => {
  prefs.format = v === 'vertical' ? 'vertical' : 'landscape';
  renderer.setFormat(prefs.format);
});
recToggle.addEventListener('change', () => {
  prefs.rec = recToggle.checked;
  savePrefs(prefs);
});

dropInviteBtn.addEventListener('click', () => {
  invite = null;
  history.replaceState(null, '', location.pathname);
  reflectSettings();
});

// ---------- Cek posisi, lalu tantangan ----------

/** Kedua tangan harus terlihat selama ini sebelum hitung mundur dimulai. */
const READY_HOLD_MS = 700;
let readying: { since: number | null } | null = null;

function busy(): boolean {
  if (readying) return true;
  const p = game?.view.phase;
  return !!game && (game.schedPhase !== 'free' || (p !== undefined && p !== 'free'));
}

function syncControls(): void {
  const b = busy();
  challengeBtn.disabled = b && !readying;
  challengeLabel.textContent = readying ? 'Langsung mulai' : 'Mulai Tantangan';
  cancelReadyBtn.hidden = !readying;
  document
    .querySelectorAll<HTMLButtonElement>('#tempo button, #level button, #groove button, #format button')
    .forEach((x) => (x.disabled = b || (!!invite && x.closest('#format') === null)));
  recToggle.disabled = b;
  dropInviteBtn.disabled = b;
}

challengeBtn.addEventListener('click', () => (readying ? beginChallenge() : askReady()));
cancelReadyBtn.addEventListener('click', () => (readying = null));
againBtn.addEventListener('click', () => askReady());
freeBtn.addEventListener('click', () => {
  hideResult();
  renderer.resetResult();
  game?.toFree();
});

function askReady(): void {
  if (!game) return;
  hideResult();
  renderer.resetResult();
  if (game.schedPhase !== 'free') game.toFree();
  readying = { since: null };
}

function readyState(): { p1: boolean; p2: boolean; progress: number } | null {
  if (!readying) return null;
  const p1 = !!hands.p1;
  const p2 = !!hands.p2;
  const now = performance.now();
  if (p1 && p2) readying.since ??= now;
  else readying.since = null;
  const progress = readying.since === null ? 0 : (now - readying.since) / READY_HOLD_MS;
  return { p1, p2, progress };
}

function beginChallenge(): void {
  if (!game || !audio) return;
  readying = null;
  const s = settings();
  const code = invite?.code ?? newCode();
  current = { code, level: s.level, groove: s.groove, bpm: s.bpm };
  game.bpm = s.bpm;
  game.groove = s.groove;
  const seq = buildSequence(s.level, seededRandom(`${code}:${s.level}`));

  runId++;
  fullRec.cancel();
  shortRec.cancel();
  fullVideo = null;
  shortVideo = null;
  if (prefs.rec && canRecord(canvas)) {
    fullRec.start(canvas, audio.streamDest.stream);
    shortRec.start(canvas, audio.streamDest.stream, 4_000_000);
  }
  game.startChallenge(seq, { level: s.level, groove: s.groove, code, target: invite?.score ?? null });
}

// ---------- Hasil ----------

function hideResult(): void {
  resultBar.hidden = true;
  controlBar.hidden = false;
}

function showResult(data: ResultData): void {
  lastResult = data;
  resultBar.hidden = false;
  controlBar.hidden = true;
  const recOn = fullRec.active;
  downloadBtn.hidden = !recOn;
  shortBtn.hidden = true;
  downloadBtn.disabled = true;
  downloadLabel.textContent = 'Menyiapkan video…';
  downloadBtn.classList.add('is-loading');
  shareBtn.hidden = typeof navigator.share !== 'function';
  resultNote.textContent = recOn ? '' : 'Rekaman mati. Nyalakan "Rekam otomatis" kalau mau dapat videonya.';
  if (!recOn) return;
  const id = runId;
  window.setTimeout(async () => {
    if (id !== runId) return;
    shortVideo = await shortRec.stop();
    shortBtn.hidden = !shortVideo;
  }, 3000);
  window.setTimeout(async () => {
    if (id !== runId) return;
    fullVideo = await fullRec.stop();
    downloadBtn.classList.remove('is-loading');
    if (!fullVideo) {
      downloadBtn.hidden = true;
      resultNote.textContent = 'Video gagal direkam di browser ini.';
      return;
    }
    downloadBtn.disabled = false;
    downloadLabel.textContent = 'Download video';
  }, 4000);
}

const baseName = () => `jam-bareng-kompak-${lastResult?.percent ?? 0}`;

function saveBlob(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function challengeLink(): string | null {
  if (!current || !lastResult) return null;
  return inviteUrl({ ...current, score: lastResult.percent });
}

downloadBtn.addEventListener('click', () => {
  if (fullVideo) saveBlob(fullVideo.blob, `${baseName()}.${fullVideo.ext}`);
});
shortBtn.addEventListener('click', () => {
  if (shortVideo) saveBlob(shortVideo.blob, `${baseName()}-pendek.${shortVideo.ext}`);
});

/** Kartu hasil 9:16 sebagai PNG, digambar ulang dalam keadaan akhir animasinya. */
function resultImage(data: ResultData): Promise<Blob | null> {
  const c = document.createElement('canvas');
  new Renderer(c, 'vertical').drawResult(data, 10);
  return new Promise((res) => c.toBlob(res, 'image/png'));
}

imageBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  const blob = await resultImage(lastResult);
  if (blob) saveBlob(blob, `${baseName()}.png`);
});

linkBtn.addEventListener('click', async () => {
  const link = challengeLink();
  if (!link) return;
  // Link langsung terlihat, jadi tetap bisa disalin manual kalau izin clipboard ditolak atau tertahan.
  resultNote.textContent = link;
  try {
    await navigator.clipboard.writeText(link);
    resultNote.textContent = `Link tantangan disalin: ${link}`;
  } catch {
    /* tetap tampilkan link apa adanya */
  }
});

shareBtn.addEventListener('click', async () => {
  if (!lastResult) return;
  const link = challengeLink();
  const text = `Kekompakan kami ${lastResult.percent}%. Berani kalahkan?`;
  // Video pendek paling pas untuk Reels/TikTok; kalau belum ada, pakai video penuh.
  const rec = shortVideo ?? fullVideo;
  const file = rec ? new File([rec.blob], `${baseName()}${rec === shortVideo ? '-pendek' : ''}.${rec.ext}`, { type: rec.mime }) : null;
  const withFile = file && typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] });
  try {
    await navigator.share(withFile ? { files: [file], title: 'Jam Bareng', text: link ? `${text} ${link}` : text } : { title: 'Jam Bareng', text, url: link ?? undefined });
  } catch (err) {
    if ((err as DOMException).name !== 'AbortError') resultNote.textContent = 'Gagal membagikan. Coba download dulu.';
  }
});

// ---------- Mulai ----------
function showError(msg: string): void {
  errorEl.textContent = msg;
  errorEl.hidden = false;
  statusEl.textContent = '';
  startBtn.disabled = false;
  startBtn.classList.remove('is-loading');
}

function cameraErrorMessage(err: unknown): string {
  const name = (err as DOMException)?.name ?? '';
  if (!window.isSecureContext) return 'Kamera cuma bisa dipakai lewat HTTPS. Buka lewat alamat https:// atau localhost.';
  if (name === 'NotAllowedError' || name === 'SecurityError')
    return 'Akses kamera ditolak. Izinkan kamera di pengaturan browser (ikon gembok di samping alamat), lalu coba lagi.';
  if (name === 'NotFoundError' || name === 'OverconstrainedError')
    return 'Kamera tidak ditemukan. Pastikan webcam terpasang, lalu coba lagi.';
  if (name === 'NotReadableError') return 'Kamera sedang dipakai aplikasi lain. Tutup aplikasinya, lalu coba lagi.';
  return 'Kamera gagal dinyalakan. Muat ulang halaman, lalu coba lagi.';
}

if (invite) {
  inviteEl.hidden = false;
  inviteEl.innerHTML = `Ada yang menantang kalian: kalahkan <b>${invite.score}%</b> di level ${levelLabel(invite.level)}, groove ${grooveLabel(invite.groove)}, ${invite.bpm} BPM.`;
}

startBtn.addEventListener('click', async () => {
  startBtn.disabled = true;
  startBtn.classList.add('is-loading');
  errorEl.hidden = true;
  // AudioContext dibuat di dalam klik agar diizinkan browser (terutama iOS).
  audio ??= new AudioEngine();
  void audio.resume();

  statusEl.textContent = 'Menyalakan kamera…';
  let stream: MediaStream;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('', 'NotFoundError');
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
  } catch (err) {
    showError(cameraErrorMessage(err));
    return;
  }
  video.srcObject = stream;
  try {
    await video.play();
  } catch {
    /* iOS kadang menolak play() pertama; video tetap jalan karena muted + playsinline. */
  }

  statusEl.textContent = 'Memuat pelacak tangan…';
  try {
    tracker = await createHandTracker();
  } catch (err) {
    console.error(err);
    stream.getTracks().forEach((t) => t.stop());
    showError('Model pelacak tangan gagal dimuat. Cek koneksi internet, lalu muat ulang halaman.');
    return;
  }

  await loadFonts();
  game = new Game(audio, readInput);
  enterStage();
  game.start();
  requestAnimationFrame(loop);
});

function enterStage(): void {
  intro.hidden = true;
  stage.hidden = false;
  reflectSettings();
}

function frameHands(): { p1: Pt[] | null; p2: Pt[] | null } {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  return {
    p1: hands.p1 ? renderer.mapPoints(1, hands.p1.pts, vw, vh) : null,
    p2: hands.p2 ? renderer.mapPoints(2, hands.p2.pts, vw, vh) : null,
  };
}

function loop(): void {
  if (!game || !audio) return;
  updateHands();
  const ready = readyState();
  if (ready && ready.progress >= 1) beginChallenge();
  game.tick();
  for (const ev of game.drain(audio.now)) {
    if (ev.kind === 'beat' && ev.phase === 'challenge') {
      if (ev.beat === SHORT_PAUSE_BEAT) shortRec.pause();
      if (ev.beat === SHORT_RESUME_BEAT) shortRec.resume();
    }
    if (ev.kind === 'result') {
      // Rekor dicatat sebelum kartu pertama kali digambar.
      Object.assign(ev.data, recordScore(ev.data.meta.level, ev.data.percent));
      showResult(ev.data);
    }
    renderer.onEvent(ev);
  }
  syncControls();
  const fh = frameHands();
  renderer.draw(video, {
    now: audio.now,
    beatDur: 60 / game.bpm,
    view: game.view,
    p1Pts: fh.p1,
    p2Pts: fh.p2,
    p1Chord: chordDb.value,
    p2Open,
    p2Lane,
    recording: fullRec.active,
    cameraReady: video.readyState >= 2,
    ready: readying ? ready : null,
  });
  requestAnimationFrame(loop);
}

// ---------- Contoh kartu hasil (layar pembuka dan mode demo) ----------

/** Data contoh: 50 dari 64 ketukan kompak (78%), menang melawan tantangan teman 71%. */
function sampleResult(): ResultData {
  return {
    ...buildResult(50, 58, 53, 14, 100, { level: 'susah', groove: 'koplo', code: 'K7Q2M', target: 71 }),
    title: 'DUO KOMPAK',
    quip: 'Dikit lagi bisa manggung di nikahan tetangga.',
    best: 82,
    newRecord: false,
  };
}

async function drawPreview(): Promise<void> {
  const el = document.querySelector<HTMLCanvasElement>('#preview');
  if (!el) return;
  await loadFonts();
  // Kartu digambar dalam keadaan akhir animasinya.
  new Renderer(el, 'vertical').drawResult(sampleResult(), 10);
}
void drawPreview();

// ---------- Mode demo untuk screenshot tanpa kamera ----------
// ?demo=result  kartu hasil dengan data dummy
// ?demo=hud     HUD tantangan dengan tangan sintetis
// ?demo=ready   layar cek posisi
// tambah &format=vertical untuk 9:16

/** Tangan sintetis: `up` = jumlah jari terangkat (telunjuk dulu). */
function fakeHand(cx: number, cy: number, up: number): Pt[] {
  const base: Array<[number, number]> = [
    [0, 0], [-0.04, -0.03], [-0.07, -0.07], [-0.09, -0.1], [-0.11, -0.13],
    [-0.03, -0.12], [-0.035, -0.17], [-0.04, -0.2], [-0.045, -0.23],
    [0, -0.13], [0, -0.185], [0, -0.22], [0, -0.25],
    [0.03, -0.12], [0.035, -0.17], [0.04, -0.2], [0.045, -0.225],
    [0.055, -0.1], [0.065, -0.14], [0.07, -0.165], [0.075, -0.185],
  ];
  const k = 1.6;
  const pts = base.map(([x, y]) => ({ x: cx + x * k * 0.5625, y: cy + y * k }));
  [5, 9, 13, 17].forEach((mcp, i) => {
    if (i < up) return;
    for (let j = 1; j <= 3; j++) pts[mcp + j] = { x: pts[mcp].x + (j === 2 ? 0.006 : 0.003), y: pts[mcp].y + 0.02 * j * 0.6 };
  });
  return pts;
}

function runDemo(kind: string): void {
  intro.hidden = true;
  stage.hidden = false;
  reflectSettings();
  const result = sampleResult();
  const t0 = performance.now() / 1000;
  const view: GameView = {
    phase: kind === 'result' ? 'result' : kind === 'ready' ? 'free' : 'challenge',
    beatInBar: 3,
    beatT: 0,
    beat: 27,
    target: 'Am',
    next: 'F',
    targetLane: 4,
    nextLane: 0,
    percent: 71,
    combo: 9,
    countLabel: null,
    result: kind === 'result' ? result : null,
    resultT: 0,
  };
  if (kind === 'result') {
    lastResult = result;
    resultBar.hidden = false;
    controlBar.hidden = true;
    downloadBtn.disabled = false;
    shortBtn.hidden = false;
    shareBtn.hidden = false;
    resultNote.textContent = '';
  }
  const p1Raw = fakeHand(0.27, 0.78, 3);
  const p2Raw = fakeHand(0.74, 0.62, 4);
  const draw = () => {
    const now = performance.now() / 1000 - t0;
    view.beatT = Math.floor(now / 0.6) * 0.6;
    view.beatInBar = Math.floor(now / 0.6) % 4;
    renderer.draw(null, {
      now,
      beatDur: 0.6,
      view,
      p1Pts: kind !== 'result' ? renderer.mapPoints(1, p1Raw, 1280, 720) : null,
      p2Pts: kind === 'hud' ? renderer.mapPoints(2, p2Raw, 1280, 720) : null,
      p1Chord: 'Am',
      p2Open: true,
      p2Lane: 4,
      recording: kind === 'hud',
      cameraReady: false,
      ready: kind === 'ready' ? { p1: true, p2: false, progress: 0 } : null,
    });
    requestAnimationFrame(draw);
  };
  if (kind === 'hud') {
    window.setInterval(() => {
      const t = performance.now() / 1000 - t0;
      renderer.onEvent({
        kind: 'judge', t, beat: 27, p1ok: true, p2ok: true,
        combo: 9, percent: 71, p1Text: null, p2Text: null,
      });
    }, 1200);
  }
  draw();
}

const demo = params.get('demo');
if (demo) runDemo(demo);
