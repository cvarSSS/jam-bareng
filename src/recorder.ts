// Rekam canvas + audio synth menjadi satu berkas video.

const MIME_CANDIDATES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1,mp4a.40.2',
  'video/mp4;codecs=avc1',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm',
];

export function pickMimeType(): string | null {
  if (typeof MediaRecorder === 'undefined') return null;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m)) ?? null;
}

export function canRecord(canvas: HTMLCanvasElement): boolean {
  return typeof canvas.captureStream === 'function' && pickMimeType() !== null;
}

export interface Recording {
  blob: Blob;
  ext: 'mp4' | 'webm';
  mime: string;
}

export class Recorder {
  private rec: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private mime = '';

  get active(): boolean {
    return this.rec !== null && this.rec.state !== 'inactive';
  }

  /** Jeda dan lanjutkan; bagian yang dijeda tidak masuk video (jadi potongan langsung). */
  pause(): void {
    if (this.rec?.state === 'recording' && typeof this.rec.pause === 'function') this.rec.pause();
  }

  resume(): void {
    if (this.rec?.state === 'paused') this.rec.resume();
  }

  start(canvas: HTMLCanvasElement, audio: MediaStream, bitrate = 6_000_000): boolean {
    const mime = pickMimeType();
    if (!mime || typeof canvas.captureStream !== 'function') return false;
    const video = canvas.captureStream(30);
    const stream = new MediaStream([...video.getVideoTracks(), ...audio.getAudioTracks()]);
    this.chunks = [];
    this.mime = mime;
    try {
      this.rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
    } catch {
      return false;
    }
    this.rec.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.rec.start(500);
    return true;
  }

  stop(): Promise<Recording | null> {
    const rec = this.rec;
    this.rec = null;
    if (!rec || rec.state === 'inactive') return Promise.resolve(null);
    return new Promise((resolve) => {
      rec.onstop = () => {
        rec.stream.getVideoTracks().forEach((t) => t.stop());
        if (!this.chunks.length) return resolve(null);
        const type = this.mime.split(';')[0];
        resolve({ blob: new Blob(this.chunks, { type }), ext: type === 'video/mp4' ? 'mp4' : 'webm', mime: type });
      };
      rec.stop();
    });
  }

  /** Batalkan tanpa menghasilkan berkas. */
  cancel(): void {
    const rec = this.rec;
    this.rec = null;
    if (rec && rec.state !== 'inactive') {
      rec.onstop = () => rec.stream.getVideoTracks().forEach((t) => t.stop());
      rec.stop();
    }
  }
}
