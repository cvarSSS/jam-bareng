// Synth buatan sendiri dengan Web Audio API. Semua bunyi dijadwalkan pada waktu AudioContext.

export const midiToHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class AudioEngine {
  readonly ctx: AudioContext;
  readonly out: GainNode;
  /** Aliran audio untuk perekam. */
  readonly streamDest: MediaStreamAudioDestinationNode;
  private noise: AudioBuffer;

  constructor() {
    const Ctor: typeof AudioContext =
      window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    this.ctx = new Ctor({ latencyHint: 'interactive' });
    const comp = this.ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    this.out = this.ctx.createGain();
    this.out.gain.value = 0.85;
    this.out.connect(comp);
    comp.connect(this.ctx.destination);
    this.streamDest = this.ctx.createMediaStreamDestination();
    comp.connect(this.streamDest);

    const len = this.ctx.sampleRate;
    this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  get now(): number {
    return this.ctx.currentTime;
  }

  resume(): Promise<void> {
    return this.ctx.state === 'running' ? Promise.resolve() : this.ctx.resume();
  }

  private env(t: number, peak: number, attack: number, decay: number): GainNode {
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    return g;
  }

  private noiseSrc(t: number, dur: number): AudioBufferSourceNode {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur);
    return src;
  }

  kick(t: number, level = 1): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(150, t);
    o.frequency.exponentialRampToValueAtTime(45, t + 0.13);
    const g = this.env(t, 0.9 * level, 0.003, 0.34);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.4);
  }

  hat(t: number, level = 1): void {
    const src = this.noiseSrc(t, 0.08);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7500;
    const g = this.env(t, 0.13 * level, 0.002, 0.05);
    src.connect(hp).connect(g).connect(this.out);
  }

  snare(t: number, level = 1): void {
    const src = this.noiseSrc(t, 0.22);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 1900;
    bp.Q.value = 0.8;
    const g = this.env(t, 0.42 * level, 0.002, 0.17);
    src.connect(bp).connect(g).connect(this.out);
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.setValueAtTime(220, t);
    o.frequency.exponentialRampToValueAtTime(160, t + 0.08);
    const og = this.env(t, 0.3 * level, 0.002, 0.08);
    o.connect(og).connect(this.out);
    o.start(t);
    o.stop(t + 0.12);
  }

  /** Kendang sintetis: dhut (rendah, nadanya naik), tak (tepak), ket (tepak kecil). */
  kendang(t: number, kind: 'dhut' | 'tak' | 'ket', level = 1): void {
    const o = this.ctx.createOscillator();
    if (kind === 'dhut') {
      o.type = 'sine';
      o.frequency.setValueAtTime(95, t);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.07);
      o.frequency.exponentialRampToValueAtTime(120, t + 0.25);
      const g = this.env(t, 0.75 * level, 0.004, 0.28);
      o.connect(g).connect(this.out);
      o.start(t);
      o.stop(t + 0.32);
      return;
    }
    const hi = kind === 'tak';
    o.type = 'triangle';
    o.frequency.setValueAtTime(hi ? 460 : 720, t);
    o.frequency.exponentialRampToValueAtTime(hi ? 320 : 600, t + 0.05);
    const g = this.env(t, (hi ? 0.32 : 0.16) * level, 0.002, hi ? 0.07 : 0.04);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.1);
    const src = this.noiseSrc(t, 0.05);
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = hi ? 2800 : 4200;
    const ng = this.env(t, (hi ? 0.14 : 0.07) * level, 0.001, 0.03);
    src.connect(bp).connect(ng).connect(this.out);
  }

  /** Akor gaya strum: sawtooth + lowpass, jeda antar-nada sekitar 16 ms. */
  strum(midis: number[], t: number, dur: number, accent: boolean, detuneCents = 0): void {
    const peak = accent ? 0.075 : 0.05;
    midis.forEach((m, i) => {
      const at = t + i * 0.016;
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToHz(m);
      o.detune.value = detuneCents;
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 0.7;
      lp.frequency.setValueAtTime(accent ? 3200 : 2200, at);
      lp.frequency.exponentialRampToValueAtTime(600, at + dur);
      const g = this.env(at, peak, 0.006, dur);
      o.connect(lp).connect(g).connect(this.out);
      o.start(at);
      o.stop(at + dur + 0.05);
    });
  }

  /** Melodi gaya pluck: triangle + sedikit square. */
  pluck(midi: number, t: number, detuneCents = 0): void {
    const hz = midiToHz(midi);
    const tri = this.ctx.createOscillator();
    tri.type = 'triangle';
    tri.frequency.value = hz;
    tri.detune.value = detuneCents;
    const sq = this.ctx.createOscillator();
    sq.type = 'square';
    sq.frequency.value = hz;
    sq.detune.value = detuneCents;
    const sqGain = this.ctx.createGain();
    sqGain.gain.value = 0.18;
    const lp = this.ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.setValueAtTime(4200, t);
    lp.frequency.exponentialRampToValueAtTime(1200, t + 0.3);
    const g = this.env(t, 0.22, 0.004, 0.42);
    tri.connect(lp);
    sq.connect(sqGain).connect(lp);
    lp.connect(g).connect(this.out);
    for (const o of [tri, sq]) {
      o.start(t);
      o.stop(t + 0.5);
    }
  }

  cymbal(t: number): void {
    const src = this.noiseSrc(t, 2.6);
    const hp = this.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 4500;
    const g = this.env(t, 0.32, 0.004, 2.4);
    src.connect(hp).connect(g).connect(this.out);
    // Lapisan logam: beberapa square dengan rasio tidak harmonis.
    const metal = this.ctx.createGain();
    metal.gain.value = 0.025;
    const bp = this.ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 9000;
    metal.connect(bp).connect(g);
    for (const r of [2, 3, 4.16, 5.43, 6.79, 8.21]) {
      const o = this.ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = 40 * r;
      o.connect(metal);
      o.start(t);
      o.stop(t + 2.6);
    }
  }

  /** Trombon sedih "wah-wah-wah-wahhh". */
  sadTrombone(t: number): void {
    const notes = [58, 57, 56, 55];
    const lens = [0.32, 0.32, 0.32, 1.1];
    let at = t;
    notes.forEach((m, i) => {
      const dur = lens[i];
      const o = this.ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = midiToHz(m);
      if (i === notes.length - 1) {
        const lfo = this.ctx.createOscillator();
        lfo.frequency.value = 6;
        const depth = this.ctx.createGain();
        depth.gain.value = 18;
        lfo.connect(depth).connect(o.detune);
        lfo.start(at);
        lfo.stop(at + dur);
      }
      const lp = this.ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.Q.value = 6;
      lp.frequency.setValueAtTime(350, at);
      lp.frequency.linearRampToValueAtTime(1400, at + Math.min(0.14, dur * 0.4));
      lp.frequency.linearRampToValueAtTime(450, at + dur);
      const g = this.env(at, 0.16, 0.03, dur);
      o.connect(lp).connect(g).connect(this.out);
      o.start(at);
      o.stop(at + dur + 0.05);
      at += dur;
    });
  }

  /** Bunyi ketukan hitung mundur. */
  tick(t: number, high: boolean): void {
    const o = this.ctx.createOscillator();
    o.type = 'sine';
    o.frequency.value = high ? 1568 : 1046;
    const g = this.env(t, 0.22, 0.002, 0.12);
    o.connect(g).connect(this.out);
    o.start(t);
    o.stop(t + 0.15);
  }

  /** Denting kecil saat combo naik level. */
  chime(t: number): void {
    [84, 88, 91, 96].forEach((m, i) => {
      const o = this.ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = midiToHz(m);
      const at = t + i * 0.045;
      const g = this.env(at, 0.09, 0.003, 0.5);
      o.connect(g).connect(this.out);
      o.start(at);
      o.stop(at + 0.55);
    });
  }
}
