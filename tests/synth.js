// Síntese de "performances" de violão realistas para medir o erro dos detectores.
// Cada performance traz o áudio e o gabarito (qual nota deveria estar soando).

export const SR = 48000;

export function makeRng(seed = 1) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
}

const midiFreq = (m, a4 = 440) => a4 * 2 ** ((m - 69) / 12);

/**
 * Soma em `out` uma nota de violão por síntese aditiva: harmônicos com
 * inarmonicidade de corda, agudos decaindo mais rápido, posição do ataque
 * (que zera alguns harmônicos, como no instrumento real) e ruído da palhetada.
 */
function addNote(out, start, { midi, detune = 0, vibrato = 0, damp = null, gain = 1 }, rand) {
  const f0 = midiFreq(midi + detune / 100);
  const B = 6e-5;
  const beta = 0.1 + rand() * 0.15;
  const tau1 = Math.min(3, 1.6 * Math.sqrt(110 / f0));
  const end = Math.min(out.length, damp !== null ? damp + Math.ceil(0.12 * SR) : start + Math.ceil(5 * tau1 * SR));
  const dampDecay = Math.exp(-1 / (0.015 * SR));
  const attack = Math.ceil(0.002 * SR);

  const partials = [];
  let norm = 0;
  for (let k = 1; k <= 24; k++) {
    const fk = k * f0 * Math.sqrt(1 + B * k * k);
    if (fk > 6000) break;
    const amp = (Math.abs(Math.sin(Math.PI * k * beta)) / k) * (0.6 + 0.8 * rand());
    norm += amp;
    partials.push({ fk, amp, decay: Math.exp(-1 / ((tau1 / (1 + 0.3 * (k - 1))) * SR)), phase: rand() * 2 * Math.PI });
  }

  for (const p of partials) {
    const a = (gain * p.amp) / norm;
    let env = 1;
    if (vibrato === 0) {
      const w = (2 * Math.PI * p.fk) / SR;
      const c = Math.cos(w), s = Math.sin(w);
      let x = Math.cos(p.phase), y = Math.sin(p.phase);
      for (let i = start; i < end; i++) {
        const ramp = i - start < attack ? (i - start) / attack : 1;
        out[i] += a * env * ramp * y;
        const nx = x * c - y * s;
        y = x * s + y * c;
        x = nx;
        env *= p.decay;
        if (damp !== null && i >= damp) env *= dampDecay;
      }
    } else {
      let phase = p.phase;
      for (let i = start; i < end; i++) {
        const t = (i - start) / SR;
        const ramp = i - start < attack ? (i - start) / attack : 1;
        out[i] += a * env * ramp * Math.sin(phase);
        phase += (2 * Math.PI * p.fk * 2 ** ((vibrato / 1200) * Math.sin(2 * Math.PI * 5.5 * t))) / SR;
        env *= p.decay;
        if (damp !== null && i >= damp) env *= dampDecay;
      }
    }
  }

  // Ruído do ataque (unha/palheta): 8 ms de ruído filtrado.
  let lp = 0;
  const n = Math.ceil(0.008 * SR);
  for (let i = 0; i < n && start + i < out.length; i++) {
    lp += 0.3 * (rand() * 2 - 1 - lp);
    out[start + i] += gain * 0.25 * lp * (1 - i / n);
  }
}

/** Biquad do "Audio EQ Cookbook" (RBJ), in-place. */
export function biquad(x, type, freq, q = Math.SQRT1_2) {
  const w = (2 * Math.PI * freq) / SR;
  const cw = Math.cos(w), alpha = Math.sin(w) / (2 * q);
  let b0, b1, b2;
  if (type === 'highpass') { b0 = (1 + cw) / 2; b1 = -(1 + cw); b2 = (1 + cw) / 2; }
  else { b0 = (1 - cw) / 2; b1 = 1 - cw; b2 = (1 - cw) / 2; }
  const a0 = 1 + alpha, a1 = -2 * cw, a2 = 1 - alpha;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = (b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2) / a0;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
}

/** Reverberação curta de sala (Schroeder: 4 pentes + 2 passa-tudo). */
function reverb(x, wet) {
  const combs = [0.0297, 0.0371, 0.0411, 0.0437].map((d) => ({ buf: new Float32Array(Math.round(d * SR)), i: 0, g: 0.72 }));
  const aps = [0.005, 0.0017].map((d) => ({ buf: new Float32Array(Math.round(d * SR)), i: 0, g: 0.7 }));
  for (let n = 0; n < x.length; n++) {
    let s = 0;
    for (const c of combs) {
      const y = c.buf[c.i];
      c.buf[c.i] = x[n] + c.g * y;
      c.i = (c.i + 1) % c.buf.length;
      s += y;
    }
    s /= combs.length;
    for (const a of aps) {
      const d = a.buf[a.i];
      const y = -a.g * s + d;
      a.buf[a.i] = s + a.g * y;
      a.i = (a.i + 1) % a.buf.length;
      s = y;
    }
    x[n] += wet * s;
  }
}

const TUNING = [40, 45, 50, 55, 59, 64];

/** Corda em que a nota seria tocada na 1ª posição (casas 0–4); acima disso, a 1ª corda. */
function stringOf(midi) {
  for (let s = TUNING.length - 1; s >= 0; s--) {
    const fret = midi - TUNING[s];
    if (fret >= 0 && fret <= 4) return { string: s, fret };
  }
  return { string: TUNING.length - 1, fret: midi - TUNING[TUNING.length - 1] };
}

/**
 * @param {Array<{midi:number, dur:number, gap?:number, detune?:number, vibrato?:number}>} seq
 * @param {{phone?: boolean, snr?: number|null, reverb?: number, sympathetic?: boolean, seed?: number}} cond
 * @returns {{x: Float32Array, events: Array<{midi:number, cents:number, start:number, end:number}>}}
 *          start/end em segundos; fora dos eventos o gabarito é "sem nota".
 *
 * Modelo físico simples: nota presa para de soar quando o dedo sai (na próxima
 * nota); corda solta continua vibrando por baixo das próximas notas até a
 * mesma corda ser tocada de novo (ou uma pausa, ou 1,5 s). Em pausas tudo é abafado.
 */
export function perform(seq, cond = {}, leadIn = 1.0, tail = 0.6) {
  const rand = makeRng(cond.seed ?? 7);
  let total = leadIn + tail;
  for (const n of seq) total += n.dur + (n.gap ?? 0);
  const x = new Float32Array(Math.ceil(total * SR));
  const events = [];

  let t = leadIn;
  const starts = [];
  for (const n of seq) {
    starts.push(t);
    t += n.dur + (n.gap ?? 0);
  }
  seq.forEach((n, idx) => {
    const start = starts[idx];
    const end = start + n.dur;
    const { string, fret } = stringOf(n.midi);
    let dampT = end;
    if (fret === 0 && !(n.gap > 0)) {
      dampT = Math.min(start + 1.5, starts.at(-1) + seq.at(-1).dur);
      for (let j = idx + 1; j < seq.length; j++) {
        if (stringOf(seq[j].midi).string === string) { dampT = Math.min(dampT, starts[j]); break; }
        if (seq[j].gap > 0) { dampT = Math.min(dampT, starts[j] + seq[j].dur); break; }
      }
      dampT = Math.max(dampT, end);
    }
    const detune = n.detune ?? 0;
    const damp = Math.round(dampT * SR);
    addNote(x, Math.round(start * SR), { midi: n.midi, detune, vibrato: n.vibrato ?? 0, damp, gain: 0.8 + 0.4 * rand() }, rand);
    if (cond.sympathetic && rand() < 0.35) {
      // Corda solta grave vibrando por simpatia, ~20 dB abaixo.
      addNote(x, Math.round(start * SR), { midi: rand() < 0.5 ? 40 : 45, damp: Math.round(end * SR), gain: 0.1 }, rand);
    }
    events.push({ midi: n.midi, cents: detune, start, end, vibrato: n.vibrato ?? 0 });
  });

  if (cond.reverb) reverb(x, cond.reverb);

  // Nível típico de microfone de celular sem ganho automático (~−30 dBFS RMS nas notas).
  let e = 0, cnt = 0;
  for (const ev of events) {
    for (let i = Math.round(ev.start * SR); i < Math.round(ev.end * SR); i++) { e += x[i] * x[i]; cnt++; }
  }
  const scale = 0.03 / Math.sqrt(e / cnt);
  for (let i = 0; i < x.length; i++) x[i] *= scale;

  if (cond.snr != null) {
    const amp = 0.03 / 10 ** (cond.snr / 20);
    let brown = 0;
    for (let i = 0; i < x.length; i++) {
      const w = rand() * 2 - 1;
      brown = 0.995 * brown + 0.1 * w; // ruído de sala é mais grave que o branco
      x[i] += (amp * (0.6 * w + 0.8 * brown)) / 0.577; // RMS ≈ amp
    }
  }
  if (cond.phone) {
    // Microfone de celular: corta graves (~180 Hz, 4ª ordem) e agudos acima de ~8 kHz.
    biquad(x, 'highpass', 180);
    biquad(x, 'highpass', 180);
    biquad(x, 'lowpass', 8000);
  }
  return { x, events };
}

// ------------------------------------------------------------ repertório

const r = makeRng(99);
const jitter = (amount) => Math.round((r() * 2 - 1) * amount);

const G_MAJOR_2OCT = [43, 45, 47, 48, 50, 52, 54, 55, 57, 59, 60, 62, 64, 66, 67];
export const SCENARIOS = [
  {
    name: 'Escala Sol maior, 2 oitavas',
    seq: [...G_MAJOR_2OCT, ...G_MAJOR_2OCT.slice(0, -1).reverse()].map((midi) => ({ midi, dur: 0.32, detune: jitter(8) })),
  },
  {
    name: 'Cordas graves (6ª e 5ª)',
    seq: [40, 43, 45, 47, 40, 42, 44, 45, 48, 47, 45, 43, 41, 40].map((midi) => ({ midi, dur: 0.42, detune: jitter(10) })),
  },
  {
    name: 'Saltos de oitava',
    seq: [45, 57, 40, 52, 50, 62, 43, 55, 47, 59, 52, 64, 45, 57].map((midi) => ({ midi, dur: 0.45, detune: jitter(6) })),
  },
  {
    name: 'Melodia com notas repetidas',
    seq: [57, 57, 60, 62, 62, 64, 64, 62, 60, 57, 55, 57, 57, 52, 55, 57].map((midi, i) => ({ midi, dur: [0.25, 0.25, 0.5, 0.3][i % 4], gap: i % 4 === 2 ? 0.15 : 0, detune: jitter(8) })),
  },
  {
    name: 'Notas longas com vibrato',
    seq: [52, 57, 62, 55, 59, 64].map((midi) => ({ midi, dur: 1.3, gap: 0.2, vibrato: 12, detune: jitter(15) })),
  },
  {
    name: 'Região aguda',
    seq: [64, 67, 69, 71, 72, 74, 76, 79, 81, 83, 84, 86, 88, 84, 81, 76].map((midi) => ({ midi, dur: 0.28, detune: jitter(8) })),
  },
];

export const CONDITIONS = [
  { name: 'limpo', phone: false, snr: null, reverb: 0 },
  { name: 'celular, sala, 25 dB', phone: true, snr: 25, reverb: 0.25, sympathetic: true },
  { name: 'celular, sala, 12 dB', phone: true, snr: 12, reverb: 0.3, sympathetic: true },
];
