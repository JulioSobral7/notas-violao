/** Teoria musical: nomes das notas e identificação da escala. */

const NAMES = {
  solfege: {
    sharp: ['Dó', 'Dó♯', 'Ré', 'Ré♯', 'Mi', 'Fá', 'Fá♯', 'Sol', 'Sol♯', 'Lá', 'Lá♯', 'Si'],
    flat: ['Dó', 'Ré♭', 'Ré', 'Mi♭', 'Mi', 'Fá', 'Sol♭', 'Sol', 'Lá♭', 'Lá', 'Si♭', 'Si'],
  },
  letters: {
    sharp: ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'],
    flat: ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'],
  },
};

export const mod12 = (n) => ((n % 12) + 12) % 12;
export const freqToMidi = (freq, a4 = 440) => 69 + 12 * Math.log2(freq / a4);
export const midiToFreq = (midi, a4 = 440) => a4 * 2 ** ((midi - 69) / 12);
export const midiOctave = (midi) => Math.floor(midi / 12) - 1;

/** Nome da classe de altura (0 = Dó). notation: 'solfege' | 'letters'. */
export function pcName(pc, notation = 'solfege', flats = false) {
  return NAMES[notation][flats ? 'flat' : 'sharp'][mod12(pc)];
}

export const SCALES = [
  { id: 'major', name: 'maior', intervals: [0, 2, 4, 5, 7, 9, 11], minor: false },
  { id: 'minor', name: 'menor', intervals: [0, 2, 3, 5, 7, 8, 10], minor: true },
  { id: 'harmonic', name: 'menor harmônica', intervals: [0, 2, 3, 5, 7, 8, 11], minor: true },
  { id: 'pentaMajor', name: 'pentatônica maior', intervals: [0, 2, 4, 7, 9], minor: false },
  { id: 'pentaMinor', name: 'pentatônica menor', intervals: [0, 3, 5, 7, 10], minor: true },
  { id: 'blues', name: 'blues', intervals: [0, 3, 5, 6, 7, 10], minor: true },
];
const SCALE_BY_ID = Object.fromEntries(SCALES.map((s) => [s.id, s]));

/** Escala relativa (mesmas notas, outra tônica), quando faz sentido. */
const RELATIVE = { major: ['minor', 9], minor: ['major', 3], pentaMajor: ['pentaMinor', 9], pentaMinor: ['pentaMajor', 3] };
export function relativeOf(root, scale) {
  const rel = RELATIVE[scale.id];
  if (!rel) return null;
  const relRoot = mod12(root + rel[1]);
  const relScale = SCALE_BY_ID[rel[0]];
  return { root: relRoot, scale: relScale, flats: prefersFlats(relRoot, relScale.minor) };
}

// Tonalidades escritas com bemóis (Fá maior, Si♭ maior, Ré menor, ...).
const FLAT_MAJOR_ROOTS = new Set([1, 3, 5, 8, 10]);
const FLAT_MINOR_ROOTS = new Set([0, 2, 3, 5, 7, 10]);
export function prefersFlats(root, minor) {
  return (minor ? FLAT_MINOR_ROOTS : FLAT_MAJOR_ROOTS).has(root);
}

export const MIN_DISTINCT_NOTES = 4;
const MIN_TOTAL_WEIGHT = 0.6; // ~0,6 s de notas tocadas
const SOFTMAX_TEMPERATURE = 0.03;
const MAX_ONSETS = 24;

/**
 * Acumula quanto tempo cada classe de altura soou (com esquecimento
 * exponencial) e compara esse histograma com as escalas conhecidas.
 * Também guarda as notas recentes para saber qual foi a mais grave: no
 * violão ela costuma ser a tônica (início da escala, baixo do acorde).
 */
export class ScaleDetector {
  /** @param {{memory?: number}} opts memory = constante de tempo do esquecimento (s); Infinity = nunca esquece */
  constructor({ memory = 20 } = {}) {
    this.hist = new Float64Array(12);
    this.memory = memory;
    this.clock = 0;
    this.onsets = []; // {midi, t}
  }

  setMemory(seconds) {
    this.memory = seconds;
  }

  reset() {
    this.hist.fill(0);
    this.onsets.length = 0;
  }

  /** Soma `weight` (tipicamente segundos × clareza) à classe de altura `pc`. */
  add(pc, weight) {
    this.hist[mod12(pc)] += weight;
  }

  /** Registra o início de uma nota nova. */
  onset(midi, weight) {
    this.add(midi, weight);
    this.onsets.push({ midi, t: this.clock });
    if (this.onsets.length > MAX_ONSETS) this.onsets.shift();
  }

  decay(dt) {
    if (dt > 0) this.clock += dt;
    if (!Number.isFinite(this.memory) || dt <= 0) return;
    const f = Math.exp(-dt / this.memory);
    for (let i = 0; i < 12; i++) this.hist[i] *= f;
  }

  /**
   * @returns {{status: 'empty'|'few'|'ok', weights: number[], distinct: number,
   *            best?: object, alternatives?: object[]}}
   *          weights: histograma normalizado (máximo = 1), para exibição.
   */
  estimate() {
    const total = this.hist.reduce((a, b) => a + b, 0);
    const max = Math.max(...this.hist);
    const weights = Array.from(this.hist, (v) => (max > 0 ? v / max : 0));
    if (total < MIN_TOTAL_WEIGHT) return { status: 'empty', weights, distinct: 0 };

    const h = Array.from(this.hist, (v) => v / total);
    const hmax = max / total;
    const presentMin = Math.max(0.04, 0.15 * hmax);
    const present = h.map((v) => v >= presentMin);
    const distinct = present.filter(Boolean).length;
    if (distinct < MIN_DISTINCT_NOTES) return { status: 'few', weights, distinct };

    const recent = this.onsets.filter((o) => this.clock - o.t <= 1.5 * this.memory);
    const bassPc = recent.length ? mod12(Math.min(...recent.map((o) => o.midi))) : -1;

    const candidates = [];
    for (let root = 0; root < 12; root++) {
      for (const scale of SCALES) {
        let coverage = 0;
        let unused = 0;
        for (const iv of scale.intervals) {
          const pc = (root + iv) % 12;
          coverage += h[pc];
          if (!present[pc]) unused++;
        }
        const tonic = h[root] / hmax;
        const fifth = h[(root + 7) % 12] / hmax;
        // Quanto da energia cabe na escala, menos notas da escala que não
        // apareceram, mais bônus pela ênfase na tônica, na quinta e pela tônica
        // ser a nota mais grave (é o que separa Dó maior de Lá menor, que têm
        // as mesmas notas).
        let score = coverage - 0.06 * unused + 0.12 * tonic + 0.04 * fifth;
        if (root === bassPc) score += 0.05;
        if (!present[root]) score -= 0.1;
        candidates.push({ root, scale, score });
      }
    }
    candidates.sort((a, b) => b.score - a.score);

    const top = candidates[0].score;
    let sum = 0;
    for (const c of candidates) sum += (c.prob = Math.exp((c.score - top) / SOFTMAX_TEMPERATURE));
    for (const c of candidates) {
      c.prob /= sum;
      c.flats = prefersFlats(c.root, c.scale.minor);
      c.pcs = new Set(c.scale.intervals.map((iv) => (c.root + iv) % 12));
    }

    return {
      status: 'ok',
      weights,
      distinct,
      best: candidates[0],
      alternatives: candidates.slice(1, 4).filter((c) => c.prob >= 0.04),
    };
  }
}
