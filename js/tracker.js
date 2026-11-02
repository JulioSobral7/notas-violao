/**
 * Rastreador de notas para violão: recebe o áudio em blocos pequenos e decide,
 * bloco a bloco, qual nota está soando.
 *
 * Etapas (inspiradas no pYIN e na estimação de f0 por soma de harmônicos):
 *  1. Piso de ruído adaptativo — o limiar de "tem nota" se ajusta ao ambiente.
 *  2. Detecção de ataque (fluxo espectral) — marca o início de cada nota.
 *  3. Espectro de novidade — no ataque guarda o espectro do que já soava
 *     (cordas soltas, ressonância) e analisa só o que a nota nova acrescentou.
 *  4. Saliência harmônica — para cada nota possível soma a energia nos seus
 *     harmônicos e desconta a energia entre eles (evita erro de oitava, mesmo
 *     quando o microfone do celular corta a fundamental).
 *  5. Viterbi online (HMM) — escolhe a sequência de notas mais provável,
 *     com atraso fixo de poucos blocos; elimina o "pisca-pisca".
 *  6. Afinação fina pelo MPM (js/pitch.js), com fallback espectral.
 */
import { FFT, PitchDetector, hann } from './pitch.js';

const LOW = 38; // Ré2 (afinação "drop D")
const HIGH = 90; // Fá♯6
const NOTES = HIGH - LOW + 1;
const STATES = NOTES + 1; // estado 0 = sem nota
const SUB = 5; // subdivisões por semitom na grade de saliência (0,2 semitom)
const MAX_HARMONICS = 20;
const MAX_HARM_HZ = 5000;
const INHARMONICITY = 5e-5;
const LAG = 3; // blocos de atraso da decisão (~32 ms a 48 kHz)
const HOLD = 0.25; // s mantendo a última nota em pequenas falhas
const NOVELTY_TIME = 2.0; // s máximos usando o espectro de novidade após um ataque
const NOVELTY_CHECK_HOPS = 6; // blocos após o ataque para confirmar que surgiu algo novo
const POST_ONSET_HOPS = 5;
const ONSET_REFRACTORY = 6;
const REPEAT_WAIT = 3; // blocos
const MIN_NOTE_HOPS = 4; // uma troca de nota só entra no histórico se durar isso

const sigmoid = (x) => 1 / (1 + Math.exp(-x));
const midiToHz = (m, a4) => a4 * 2 ** ((m - 69) / 12);

export class PitchTracker {
  /**
   * @param {number} sampleRate
   * @param {{a4?: number, marginDb?: number}} [opts]
   *        marginDb: quantos dB acima do ruído de fundo o som precisa estar.
   */
  constructor(sampleRate, { a4 = 440, marginDb = 10 } = {}) {
    this.sr = sampleRate;
    this.a4 = a4;
    this.marginDb = marginDb;
    this.maxWin = sampleRate > 50000 ? 8192 : 4096;
    this.minWin = this.maxWin / 2;
    this.buf = new Float32Array(this.maxWin);
    this.det = new PitchDetector(this.maxWin, sampleRate, { minFreq: 65, maxFreq: 1600 });
    this.binHz = this.det.binHz;
    this.kMax = Math.min(this.det.mag.length - 2, Math.ceil((MAX_HARM_HZ * 1.1) / this.binHz));
    this.spec = new Float64Array(this.kMax + 1);
    this.pre = new Float64Array(this.kMax + 1); // previsão do que já soava antes do ataque
    this.preDecay = new Float64Array(this.kMax + 1);
    this.lastMag = new Float64Array(this.kMax + 1);
    this.prevMag = new Float64Array(this.kMax + 1);
    this.comp = new Float64Array(this.kMax + 1);
    this.sorted = new Float64Array(this.kMax + 1);
    this.kLo = Math.ceil(60 / this.binHz);
    this.grid = new Float64Array(NOTES * SUB);
    this.sal = new Float64Array(NOTES);

    // Ataque: FFT curta (~21 ms) sobre o fim do buffer.
    this.onsetN = sampleRate > 50000 ? 2048 : 1024;
    this.onsetFft = new FFT(this.onsetN);
    this.oRe = new Float64Array(this.onsetN);
    this.oIm = new Float64Array(this.onsetN);
    this.oLo = Math.max(1, Math.floor(60 / (sampleRate / this.onsetN)));
    this.oHi = Math.min(this.onsetN / 2 - 1, Math.ceil(5000 / (sampleRate / this.onsetN)));
    this.prevLog = new Float64Array(this.onsetN / 2);
    this.fluxHist = [];
    this.prevFlux = 0;
    this.lastFlux = 0;
    this.lastSpread = 0;

    this.floorDb = -60; // até calibrar: ruído típico de microfone de celular
    this.calib = [];
    this.sinceOnset = Infinity; // amostras
    this.hopsSinceOnset = Infinity;
    this.noveltyActive = false;

    this.delta = new Float64Array(STATES);
    this.delta.fill(-1e9);
    this.delta[0] = 0;
    this.nextDelta = new Float64Array(STATES);
    this.emit = new Float64Array(STATES);
    this.back = Array.from({ length: LAG }, () => new Int16Array(STATES));
    this.frame = 0;
    this.onsetFrames = [];
    this.lastChangeFrame = -Infinity;
    this.pendingOn = null;

    this.lastNote = null;
    this.lastVoicedTime = -Infinity;
    this.time = 0;
    this.centsEma = 0;
    this.outNote = null;
  }

  setA4(a4) { this.a4 = a4; }
  setMargin(db) { this.marginDb = db; }

  /**
   * Processa um bloco de áudio novo (tipicamente 512 amostras).
   * @param {Float32Array} chunk
   * @returns {{note: number|null, cents: number, freq: number, rms: number, level: number,
   *            voicing: number, onset: boolean, noteOn: boolean}}
   *   note: nota MIDI exibida (com atraso de LAG blocos); noteOn: começou uma nota
   *   (inclusive repetição da mesma nota) — útil para histórico e escala.
   */
  push(chunk) {
    const len = Math.min(chunk.length, this.buf.length);
    const dt = chunk.length / this.sr;
    this.time += dt;
    this.buf.copyWithin(0, len);
    this.buf.set(chunk.subarray(chunk.length - len), this.buf.length - len);

    // 1. Nível e piso de ruído.
    let e = 0;
    const tail = this.onsetN;
    for (let i = this.buf.length - tail; i < this.buf.length; i++) e += this.buf[i] * this.buf[i];
    const rms = Math.sqrt(e / tail);
    const rmsDb = 20 * Math.log10(rms + 1e-10);

    // 2. Ataque.
    const onset = this.#detectOnset(rmsDb);
    if (onset) {
      // Guarda o que já soava e quanto cada faixa estava decaindo por bloco,
      // para prever (e descontar) essas cordas nos blocos seguintes.
      for (let k = 0; k <= this.kMax; k++) {
        const prev = this.prevMag[k];
        this.pre[k] = this.lastMag[k];
        this.preDecay[k] = prev > 0 ? Math.max(0.85, Math.min(1, this.lastMag[k] / prev)) : 1;
      }
      this.noveltyActive = true;
      this.sinceOnset = len;
      this.hopsSinceOnset = 0;
      // Só ataques fortes contam como "mesma nota tocada de novo"; os fracos
      // (vibrato, abafamento) servem apenas para destravar trocas de nota.
      if (this.lastFlux >= 0.3 && this.lastSpread >= 0.35) this.onsetFrames.push(this.frame);
    } else {
      this.sinceOnset += len;
      this.hopsSinceOnset++;
    }

    // 3. Análise com janela alinhada ao ataque.
    const win = Math.max(this.minWin, Math.min(this.maxWin, this.sinceOnset));
    const analysis = this.det.analyze(this.buf, win);
    const mag = this.det.mag;
    this.prevMag.set(this.lastMag);
    for (let k = 0; k <= this.kMax; k++) this.lastMag[k] = mag[k];

    let useNovelty = false;
    if (this.noveltyActive && this.sinceOnset < NOVELTY_TIME * this.sr) {
      let eAll = 0, eNew = 0;
      for (let k = 0; k <= this.kMax; k++) {
        if (this.hopsSinceOnset > 0) this.pre[k] *= this.preDecay[k];
        const d = Math.max(0, mag[k] - this.pre[k]);
        this.spec[k] = d;
        eAll += mag[k] * mag[k];
        eNew += d * d;
      }
      // Logo após o ataque exige bastante energia nova; confirmada a nota,
      // segue com a novidade enquanto restar algo dela.
      const early = this.hopsSinceOnset < NOVELTY_CHECK_HOPS;
      useNovelty = eNew > (early ? 0.15 : 0.03) * eAll;
      if (this.hopsSinceOnset === NOVELTY_CHECK_HOPS && eNew < 0.15 * eAll) this.noveltyActive = false;
    }
    if (!useNovelty) for (let k = 0; k <= this.kMax; k++) this.spec[k] = mag[k];

    // 4. Saliência harmônica por nota. O fundo de ruído do espectro é a mediana
    // das magnitudes (os harmônicos ocupam poucas faixas), medida a cada bloco.
    const { sorted, kLo, kMax } = this;
    const m = kMax - kLo + 1;
    sorted.set(mag.subarray(kLo, kMax + 1));
    const noiseMag = sorted.subarray(0, m).sort()[m >> 1];
    const smax = this.#salience(this.spec, 3 * noiseMag);

    // Voz/sem voz: energia acima do ruído e estrutura harmônica.
    const vEnergy = sigmoid((rmsDb - this.floorDb - this.marginDb) / 2) * sigmoid((rmsDb + 65) / 2);
    const vHarm = sigmoid((smax - 1.2) / 0.3);
    const voicing = Math.min(0.98, Math.max(0.02, vEnergy * vHarm));

    // Piso de energia (portão de sensibilidade). Calibração: os primeiros blocos
    // sem nota (o violão pode já estar soando ao tocar em "Começar"). Depois,
    // desce rápido e só sobe, devagar, quando não há nota.
    if (this.calib.length < 8) {
      if (vHarm < 0.3) {
        this.calib.push(rmsDb);
        if (this.calib.length === 8) this.floorDb = Math.min(...this.calib);
      }
    } else if (rmsDb < this.floorDb) this.floorDb += (rmsDb - this.floorDb) * 0.25;
    else if (vHarm < 0.3) this.floorDb += dt * 3;
    this.floorDb = Math.max(-100, Math.min(-25, this.floorDb));

    // 5. Viterbi.
    const decided = this.#viterbi(smax, voicing);
    const decidedFrame = this.frame - LAG;
    this.frame++;

    // Saída com "hold" para pequenas falhas.
    let note = decided > 0 ? LOW + decided - 1 : null;
    if (note !== null) {
      this.lastVoicedTime = this.time;
      this.lastNote = note;
    } else if (this.lastNote !== null && this.time - this.lastVoicedTime < HOLD) {
      note = this.lastNote;
    }

    // Evento de nota nova: troca de nota, ou ataque sem troca (a mesma nota
    // tocada de novo). O ataque espera alguns blocos de decisão para não
    // duplicar uma troca que acontece logo antes ou logo depois dele.
    let noteOn = false;
    if (note !== this.outNote) {
      this.pendingOn = note !== null ? { note, frame: decidedFrame } : null;
      if (note !== null) this.lastChangeFrame = decidedFrame;
    }
    if (this.pendingOn && decidedFrame - this.pendingOn.frame >= MIN_NOTE_HOPS - 1) {
      noteOn = true;
      this.pendingOn = null;
    }
    while (this.onsetFrames.length && this.onsetFrames[0] + REPEAT_WAIT <= decidedFrame) {
      const of = this.onsetFrames.shift();
      // …e o som precisa continuar presente (descarta o "ataque" do abafamento).
      if (decided > 0 && voicing > 0.5 && this.lastChangeFrame < of - REPEAT_WAIT) noteOn = true;
    }
    if (note !== this.outNote) this.centsEma = NaN;
    this.outNote = note;

    // 6. Afinação fina.
    let freq = 0;
    if (note !== null && decided > 0) {
      freq = this.#refine(note, analysis.candidates);
      if (freq > 0) {
        const cents = 1200 * Math.log2(freq / midiToHz(note, this.a4));
        this.centsEma = Number.isNaN(this.centsEma) ? cents : this.centsEma + (cents - this.centsEma) * 0.3;
      }
    }

    const level = Math.max(0, Math.min(1, (rmsDb + 60) / 50));
    return {
      note,
      cents: Number.isNaN(this.centsEma) ? 0 : this.centsEma,
      freq,
      rms,
      level,
      voicing,
      onset,
      noteOn,
    };
  }

  #detectOnset(rmsDb) {
    const N = this.onsetN;
    const w = hann(N);
    const off = this.buf.length - N;
    for (let i = 0; i < N; i++) {
      this.oRe[i] = this.buf[off + i] * w[i];
      this.oIm[i] = 0;
    }
    this.onsetFft.transform(this.oRe, this.oIm);
    const floorMag = 2 * 10 ** (this.floorDb / 20) * Math.sqrt(6 / N) * (N / 4);
    let flux = 0;
    let spread = 0;
    for (let k = this.oLo; k <= this.oHi; k++) {
      const l = Math.log(Math.max(Math.hypot(this.oRe[k], this.oIm[k]), floorMag));
      const d = l - this.prevLog[k];
      if (d > 0) flux += d;
      if (d > 0.3) spread++;
      this.prevLog[k] = l;
    }
    flux /= this.oHi - this.oLo + 1;
    // Palhetada levanta muitas faixas ao mesmo tempo; batimento entre cordas, poucas.
    spread /= this.oHi - this.oLo + 1;
    this.lastSpread = spread;

    const hist = this.fluxHist;
    const med = hist.length ? [...hist].sort((a, b) => a - b)[hist.length >> 1] : 0;
    hist.push(flux);
    if (hist.length > 30) hist.shift();
    this.lastFlux = flux;
    const rising = flux > this.prevFlux;
    this.prevFlux = flux;
    return rising && flux > Math.max(0.2, 2.5 * med) && spread > 0.2 && this.hopsSinceOnset >= ONSET_REFRACTORY
      && rmsDb > this.floorDb + this.marginDb / 2;
  }

  /** Preenche this.sal (saliência por nota) e devolve a maior. */
  #salience(spec, noiseRef) {
    const { comp, kMax, binHz, grid, sal } = this;
    let maxMag = 0;
    for (let k = 0; k <= kMax; k++) if (spec[k] > maxMag) maxMag = spec[k];
    const ref = Math.max(noiseRef, maxMag * Math.exp(-6), 1e-12);
    for (let k = 0; k <= kMax; k++) comp[k] = spec[k] > ref ? Math.log(spec[k] / ref) : 0;

    const peak = (f) => {
      const tol = Math.max(binHz, f * 0.006);
      const i0 = Math.max(0, Math.floor((f - tol) / binHz));
      const i1 = Math.min(kMax, Math.ceil((f + tol) / binHz));
      let m = 0;
      for (let i = i0; i <= i1; i++) if (comp[i] > m) m = comp[i];
      return m;
    };

    for (let g = 0; g < grid.length; g++) {
      const f = midiToHz(LOW - 0.4 + g / SUB, this.a4);
      let s = 0;
      for (let k = 1; k <= MAX_HARMONICS && k * f < MAX_HARM_HZ; k++) {
        const wk = (Math.sqrt(k) * (f + 27)) / (k * f + 320);
        s += wk * peak(k * f * Math.sqrt(1 + INHARMONICITY * k * k));
        s -= 0.5 * wk * peak((k - 0.5) * f);
      }
      grid[g] = s;
    }
    let smax = 0;
    for (let n = 0; n < NOTES; n++) {
      let m = -Infinity;
      for (let j = 0; j < SUB; j++) m = Math.max(m, grid[n * SUB + j]);
      sal[n] = m;
      if (m > smax) smax = m;
    }
    return smax;
  }

  /** Um passo do Viterbi online; devolve o estado decidido LAG blocos atrás. */
  #viterbi(smax, voicing) {
    const { delta, nextDelta, emit, sal } = this;
    const eps = 1e-4;
    let qsum = 0;
    for (let n = 0; n < NOTES; n++) {
      const r = smax > 0 && sal[n] > 0 ? (sal[n] / smax) ** 8 : 0;
      emit[n + 1] = r;
      qsum += r;
    }
    emit[0] = Math.log(1 - voicing + eps);
    for (let n = 1; n < STATES; n++) emit[n] = Math.log(voicing * (qsum > 0 ? emit[n] / qsum : 1 / NOTES) + eps);

    const post = this.hopsSinceOnset <= POST_ONSET_HOPS;
    const pSwitch = post ? 0.4 : 0.004;
    const pOff = post ? 0.05 : 0.01;
    const pOn = post ? 0.5 : 0.1;
    const lStay = Math.log(1 - pSwitch - pOff);
    const lSwitch = Math.log(pSwitch / (NOTES - 1));
    const lOct = Math.log(post ? 0.7 : 0.05); // oitava sem ataque é quase sempre erro
    const lOff = Math.log(pOff);
    const lOn = Math.log(pOn / NOTES);
    const lSilent = Math.log(1 - pOn);

    const back = this.back[this.frame % LAG];
    // Estado "sem nota".
    let best = delta[0] + lSilent, arg = 0;
    for (let n = 1; n < STATES; n++) {
      const v = delta[n] + lOff;
      if (v > best) { best = v; arg = n; }
    }
    nextDelta[0] = best + emit[0];
    back[0] = arg;
    // Notas.
    for (let m = 1; m < STATES; m++) {
      best = delta[m] + lStay; arg = m;
      const vOn = delta[0] + lOn;
      if (vOn > best) { best = vOn; arg = 0; }
      for (let n = 1; n < STATES; n++) {
        if (n === m) continue;
        const v = delta[n] + lSwitch + ((n - m) % 12 === 0 ? lOct : 0);
        if (v > best) { best = v; arg = n; }
      }
      nextDelta[m] = best + emit[m];
      back[m] = arg;
    }
    let top = -Infinity, s = 0;
    for (let n = 0; n < STATES; n++) if (nextDelta[n] > top) { top = nextDelta[n]; s = n; }
    for (let n = 0; n < STATES; n++) delta[n] = nextDelta[n] - top;

    // Volta LAG−1 passos pelos ponteiros: decisão do quadro frame−(LAG−1)… na prática
    // o estado mais provável há LAG blocos dado tudo que veio depois.
    const steps = Math.min(LAG, this.frame + 1);
    for (let i = 0; i < steps; i++) s = this.back[(this.frame - i + LAG) % LAG][s];
    return s;
  }

  /**
   * Frequência precisa da nota decidida. Primeiro pelos picos dos 6 primeiros
   * harmônicos no espectro completo, com correção de inarmonicidade da corda e
   * peso k (o erro de f0 vindo do harmônico k cai com 1/k). Se não houver
   * harmônicos claros, usa o candidato do MPM que concordar com a nota.
   */
  #refine(note, candidates) {
    const spec = this.lastMag;
    const f0 = midiToHz(note, this.a4);
    let peakMax = 0;
    for (let k = 0; k <= this.kMax; k++) if (spec[k] > peakMax) peakMax = spec[k];
    let num = 0, den = 0, found = 0;
    for (let k = 1; k <= 6 && k * f0 < MAX_HARM_HZ; k++) {
      const stretch = k * Math.sqrt(1 + INHARMONICITY * k * k);
      const fk = f0 * stretch;
      const tol = fk * 0.03;
      const i0 = Math.max(1, Math.floor((fk - tol) / this.binHz));
      const i1 = Math.min(this.kMax - 1, Math.ceil((fk + tol) / this.binHz));
      let p = i0;
      for (let i = i0; i <= i1; i++) if (spec[i] > spec[p]) p = i;
      if (spec[p] < 0.02 * peakMax || spec[p] <= spec[p - 1] || spec[p] <= spec[p + 1]) continue;
      const a = Math.log(spec[p - 1]), b = Math.log(spec[p]), c = Math.log(spec[p + 1]);
      const shift = (0.5 * (a - c)) / (a - 2 * b + c);
      const w = spec[p] * k;
      num += (((p + shift) * this.binHz) / stretch) * w;
      den += w;
      found++;
    }
    if (found >= 2) return num / den;

    let bestC = null;
    for (const c of candidates) {
      const m = 69 + 12 * Math.log2(c.freq / this.a4);
      if (Math.abs(m - note) < 0.5 && c.clarity > 0.6 && (!bestC || c.clarity > bestC.clarity)) bestC = c;
    }
    return bestC ? bestC.freq : 0;
  }
}
