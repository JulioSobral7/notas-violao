// Métricas de acerto de detectores de nota sobre performances sintéticas.
import { SR } from './synth.js';
import { PitchDetector } from '../js/pitch.js';
import { freqToMidi } from '../js/music.js';

export const HOP = 512;
const GRACE = 0.12; // s após o ataque fora da conta de acerto (é latência, medida à parte)
const RELEASE = 0.35; // s após o fim da nota em que "ainda soando" não conta como falso positivo

/**
 * Reprodução fiel da lógica da versão anterior do app: detect() a 60 quadros/s
 * na janela de 4096 amostras, limiar fixo de RMS, mediana de 5 leituras e
 * 3 quadros iguais para trocar de nota.
 */
export class LegacyTracker {
  constructor(sampleRate = SR) {
    this.buf = new Float32Array(4096);
    this.det = new PitchDetector(4096, sampleRate, { minFreq: 60, maxFreq: 1600 });
    this.frame = sampleRate / 60;
    this.acc = 0;
    this.recent = [];
    this.current = null;
    this.pending = null;
    this.pendingCount = 0;
    this.centsEma = 0;
    this.silence = 0;
  }

  push(chunk) {
    this.buf.copyWithin(0, chunk.length);
    this.buf.set(chunk, this.buf.length - chunk.length);
    this.acc += chunk.length;
    while (this.acc >= this.frame) {
      this.acc -= this.frame;
      this.step(1 / 60);
    }
    const noteOn = this.current !== null && this.current !== this.prevOut;
    this.prevOut = this.current;
    return { note: this.current, cents: this.centsEma, noteOn };
  }

  step(dt) {
    const { freq, clarity, rms } = this.det.detect(this.buf);
    if (freq > 0 && clarity >= 0.85 && rms >= 0.006) {
      this.silence = 0;
      const midi = freqToMidi(freq);
      if (this.recent.length && Math.abs(midi - median(this.recent)) > 0.7) this.recent.length = 0;
      this.recent.push(midi);
      if (this.recent.length > 5) this.recent.shift();
      const smooth = median(this.recent);
      const nearest = Math.round(smooth);
      if (nearest === this.current) this.pendingCount = 0;
      else if (nearest === this.pending) {
        if (++this.pendingCount >= 3) {
          this.current = nearest;
          this.pending = null;
          this.pendingCount = 0;
          this.centsEma = (smooth - nearest) * 100;
        }
      } else {
        this.pending = nearest;
        this.pendingCount = 1;
      }
      if (this.current === nearest) this.centsEma += ((smooth - nearest) * 100 - this.centsEma) * 0.3;
    } else {
      this.silence += dt;
      this.recent.length = 0;
      this.pending = null;
      this.pendingCount = 0;
      if (this.silence > 0.3) this.current = null;
    }
  }
}

function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Passa a performance pelo rastreador em blocos de HOP amostras e compara a
 * nota exibida a cada bloco com o gabarito.
 * @param {() => {push(chunk: Float32Array): {note: number|null, cents: number}}} makeTracker
 */
export function evaluate(makeTracker, { x, events }) {
  const tracker = makeTracker();
  const out = [];
  const t0 = performance.now();
  for (let i = 0; i + HOP <= x.length; i += HOP) {
    const r = tracker.push(x.subarray(i, i + HOP));
    out.push({ t: (i + HOP) / SR, note: r.note, cents: r.cents, noteOn: r.noteOn });
  }
  const msPerHop = (performance.now() - t0) / out.length;

  const m = {
    frames: 0, correct: 0, octave: 0, wrong: 0, missed: 0,
    silentFrames: 0, falseVoiced: 0,
    notes: events.length, missedNotes: 0, latencies: [],
    spurious: 0, centsSq: 0, centsN: 0, msPerHop,
    histOk: 0, histExtra: 0,
  };

  let ei = 0;
  for (const o of out) {
    while (ei < events.length && events[ei].end <= o.t) ei++;
    const ev = events[ei] && events[ei].start <= o.t ? events[ei] : null;
    if (ev) {
      if (o.t < ev.start + GRACE) continue;
      m.frames++;
      if (o.note === ev.midi) {
        m.correct++;
        if (!ev.vibrato && o.t >= ev.start + 0.2) {
          m.centsSq += (o.cents - ev.cents) ** 2;
          m.centsN++;
        }
      } else if (o.note === null) m.missed++;
      else if ((o.note - ev.midi) % 12 === 0) m.octave++;
      else m.wrong++;
    } else {
      const prev = events[ei - 1];
      if (prev && o.t < prev.end + RELEASE) continue;
      m.silentFrames++;
      if (o.note !== null) m.falseVoiced++;
    }
  }

  // Latência: do ataque até a nota certa aparecer e ficar por 3 blocos.
  for (const ev of events) {
    let run = 0;
    let found = null;
    for (const o of out) {
      if (o.t < ev.start) continue;
      if (o.t >= ev.end) break;
      run = o.note === ev.midi ? run + 1 : 0;
      if (run === 3) { found = o.t - 2 * (HOP / SR) - ev.start; break; }
    }
    if (found === null) m.missedNotes++;
    else m.latencies.push(found);
  }

  // Histórico: cada nota tocada deve gerar exatamente um evento "nota nova"
  // com a nota certa, entre o ataque e o fim da nota (+ latência).
  const used = new Set();
  for (const ev of events) {
    const hit = out.findIndex((o, i) => o.noteOn && !used.has(i) && o.note === ev.midi && o.t >= ev.start && o.t < ev.end + 0.15);
    if (hit >= 0) { used.add(hit); m.histOk++; }
  }
  out.forEach((o, i) => { if (o.noteOn && !used.has(i)) m.histExtra++; });

  // Trocas espúrias: trechos de nota exibida que não batem com nenhuma nota
  // tocada naquele intervalo (nem com a anterior, que pode ainda estar soando).
  let seg = null;
  const closeSeg = () => {
    if (!seg) return;
    const ok = events.some((ev) => ev.midi === seg.note && ev.start <= seg.end && ev.end + RELEASE >= seg.start);
    if (!ok) m.spurious++;
    seg = null;
  };
  for (const o of out) {
    if (seg && o.note === seg.note) { seg.end = o.t; continue; }
    closeSeg();
    if (o.note !== null) seg = { note: o.note, start: o.t, end: o.t };
  }
  closeSeg();
  return m;
}

export function merge(list) {
  const t = { frames: 0, correct: 0, octave: 0, wrong: 0, missed: 0, silentFrames: 0, falseVoiced: 0, notes: 0, missedNotes: 0, latencies: [], spurious: 0, centsSq: 0, centsN: 0, msPerHop: 0, histOk: 0, histExtra: 0 };
  for (const m of list) {
    for (const k of Object.keys(t)) {
      if (k === 'latencies') t.latencies.push(...m.latencies);
      else if (k === 'msPerHop') t.msPerHop += m.msPerHop / list.length;
      else t[k] += m[k];
    }
  }
  return t;
}

export function summarize(m) {
  const lat = [...m.latencies].sort((a, b) => a - b);
  const q = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.floor(p * lat.length))] * 1000 : NaN);
  return {
    acerto: (100 * m.correct) / m.frames,
    oitava: (100 * m.octave) / m.frames,
    outraNota: (100 * m.wrong) / m.frames,
    semNota: (100 * m.missed) / m.frames,
    falsoPositivo: m.silentFrames ? (100 * m.falseVoiced) / m.silentFrames : 0,
    espuriasPor100: (100 * m.spurious) / m.notes,
    notasPerdidas: m.missedNotes,
    latMediana: q(0.5),
    latP90: q(0.9),
    centsRms: Math.sqrt(m.centsSq / Math.max(1, m.centsN)),
    msPorBloco: m.msPerHop,
    historicoOk: (100 * m.histOk) / m.notes,
    historicoExtras: (100 * m.histExtra) / m.notes,
  };
}
