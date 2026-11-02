/**
 * Detecção da frequência fundamental pelo McLeod Pitch Method (MPM).
 *
 * O MPM usa a "função de diferença quadrada normalizada" (NSDF), que lida bem
 * com os harmônicos fortes do violão e erra pouco de oitava. A autocorrelação
 * é calculada via FFT (O(n log n)), o que permite janelas longas — necessárias
 * para as notas graves (Mi2 ≈ 82 Hz) — sem pesar no processador do celular.
 */

/** FFT radix-2 complexa, iterativa e in-place, com tabelas pré-calculadas. */
export class FFT {
  constructor(n) {
    this.n = n;
    const bits = Math.log2(n);
    this.rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) this.rev[i] = reverseBits(i, bits);
    this.cos = new Float64Array(n / 2);
    this.sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
  }

  transform(re, im) {
    const { n, rev, cos, sin } = this;
    for (let i = 0; i < n; i++) {
      const j = rev[i];
      if (j > i) {
        let t = re[i]; re[i] = re[j]; re[j] = t;
        t = im[i]; im[i] = im[j]; im[j] = t;
      }
    }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let j = start, k = 0; j < start + half; j++, k += step) {
          const l = j + half;
          const tre = re[l] * cos[k] + im[l] * sin[k];
          const tim = im[l] * cos[k] - re[l] * sin[k];
          re[l] = re[j] - tre;
          im[l] = im[j] - tim;
          re[j] += tre;
          im[j] += tim;
        }
      }
    }
  }
}

const hannCache = new Map();
/** Janela de Hann de tamanho n (memorizada) e a soma dos seus pesos. */
export function hann(n) {
  let w = hannCache.get(n);
  if (!w) {
    w = new Float64Array(n);
    for (let i = 0; i < n; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    hannCache.set(n, w);
  }
  return w;
}

export class PitchDetector {
  /**
   * @param {number} bufferSize  tamanho máximo da janela de análise (amostras)
   * @param {number} sampleRate  taxa de amostragem do AudioContext
   * @param {object} [opts]
   * @param {number} [opts.minFreq=60]   menor frequência aceita (Hz)
   * @param {number} [opts.maxFreq=1600] maior frequência aceita (Hz)
   * @param {number} [opts.cutoff=0.93]  fração do pico máximo para escolher o período
   */
  constructor(bufferSize, sampleRate, { minFreq = 60, maxFreq = 1600, cutoff = 0.93 } = {}) {
    this.bufferSize = bufferSize;
    this.sampleRate = sampleRate;
    this.cutoff = cutoff;
    this.minLag = Math.max(2, Math.floor(sampleRate / maxFreq));
    this.maxLag = Math.min(bufferSize - 2, Math.ceil(sampleRate / minFreq));

    const n = nextPow2(bufferSize * 2); // zero-padding evita autocorrelação circular
    this.n = n;
    this.fft = new FFT(n);
    this.re = new Float64Array(n);
    this.im = new Float64Array(n);
    this.x = new Float64Array(bufferSize);
    this.nsdf = new Float64Array(bufferSize);
    /** Espectro de magnitude (janela de Hann, normalizado pela soma da janela) da última analyze(). */
    this.mag = new Float64Array(n / 2);
    this.binHz = sampleRate / n;
  }

  /**
   * Análise de uma janela: período pelo MPM (escolhendo um só candidato).
   * @param {Float32Array} buf  amostras no domínio do tempo
   * @returns {{freq: number, clarity: number, rms: number}}
   *          freq = 0 quando nenhuma altura confiável foi encontrada.
   */
  detect(buf) {
    const N = this.bufferSize;
    const { x, re, im } = this;
    const energy = this.#load(buf, 0, N);
    const rms = Math.sqrt(energy / N);
    if (energy < 1e-10) return { freq: 0, clarity: 0, rms };

    re.fill(0);
    im.fill(0);
    re.set(x.subarray(0, N));
    this.fft.transform(re, im);
    for (let k = 0; k < this.n; k++) {
      re[k] = re[k] * re[k] + im[k] * im[k];
      im[k] = 0;
    }
    this.fft.transform(re, im);

    const peaks = this.#nsdfPeaks(N, energy, this.maxLag);
    let highest = 0;
    for (const p of peaks) highest = Math.max(highest, this.nsdf[p]);
    if (highest <= 0) return { freq: 0, clarity: 0, rms };

    // O primeiro pico acima de cutoff·máximo é o período fundamental
    // (escolher o maior pico tenderia a errar uma oitava para baixo).
    for (const p of peaks) {
      if (this.nsdf[p] < this.cutoff * highest) continue;
      const { period, value } = nsdfAt(this.nsdf, p);
      return { freq: this.sampleRate / period, clarity: Math.min(1, value), rms };
    }
    return { freq: 0, clarity: 0, rms };
  }

  /**
   * Análise completa das últimas `length` amostras de `buf`: todos os candidatos
   * do MPM (picos da NSDF) e, de brinde, o espectro de magnitude em this.mag.
   * Uma só FFT complexa carrega o sinal cru (parte real, para a autocorrelação)
   * e o sinal janelado (parte imaginária, para o espectro).
   * @returns {{rms: number, length: number, candidates: Array<{freq: number, clarity: number}>}}
   */
  analyze(buf, length = this.bufferSize) {
    const N = Math.min(length, this.bufferSize, buf.length);
    const { x, re, im, mag, n } = this;
    const energy = this.#load(buf, buf.length - N, N);
    const rms = Math.sqrt(energy / N);
    if (energy < 1e-10) {
      mag.fill(0);
      return { rms, length: N, candidates: [] };
    }

    const w = hann(N);
    let wsum = 0;
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < N; i++) {
      re[i] = x[i];
      im[i] = x[i] * w[i];
      wsum += w[i];
    }
    this.fft.transform(re, im);

    // Separa as transformadas: X = (Z[k] + Z*[n−k]) / 2 e Y = (Z[k] − Z*[n−k]) / 2i.
    for (let k = 0; k <= n / 2; k++) {
      const j = (n - k) % n;
      const ar = re[k], ai = im[k], br = re[j], bi = -im[j];
      const xr = (ar + br) / 2, xi = (ai + bi) / 2;
      const yr = (ai - bi) / 2, yi = -(ar - br) / 2;
      if (k < n / 2) mag[k] = Math.hypot(yr, yi) / (wsum / 2);
      const p = xr * xr + xi * xi;
      re[k] = p; re[j] = p;
      im[k] = 0; im[j] = 0;
    }
    this.fft.transform(re, im);

    const maxLag = Math.min(this.maxLag, Math.floor(N / 2));
    const peaks = this.#nsdfPeaks(N, energy, maxLag);
    let highest = 0;
    for (const p of peaks) highest = Math.max(highest, this.nsdf[p]);
    const candidates = [];
    for (const p of peaks) {
      if (this.nsdf[p] < 0.5 * highest) continue;
      const { period, value } = nsdfAt(this.nsdf, p);
      candidates.push({ freq: this.sampleRate / period, clarity: Math.min(1, value) });
    }
    return { rms, length: N, candidates };
  }

  /** Copia N amostras (a partir de offset) sem a média para this.x; devolve a energia. */
  #load(buf, offset, N) {
    let mean = 0;
    for (let i = 0; i < N; i++) mean += buf[offset + i];
    mean /= N;
    let energy = 0;
    for (let i = 0; i < N; i++) {
      const v = buf[offset + i] - mean;
      this.x[i] = v;
      energy += v * v;
    }
    return energy;
  }

  /**
   * Com a autocorrelação r(τ)·n em this.re, calcula a NSDF
   * n(τ) = 2·r(τ) / m(τ), com m(τ) = Σ (x[j]² + x[j+τ]²) atualizado incrementalmente,
   * e devolve os picos-chave (máximo de cada trecho positivo entre cruzamentos por zero).
   */
  #nsdfPeaks(N, energy, maxLag) {
    const { x, re, nsdf } = this;
    const limit = maxLag + 2;
    let m = 2 * energy;
    nsdf[0] = 1;
    for (let tau = 1; tau < limit; tau++) {
      m -= x[tau - 1] * x[tau - 1] + x[N - tau] * x[N - tau];
      nsdf[tau] = m > 1e-12 ? (2 * re[tau]) / this.n / m : 0;
    }

    const peaks = [];
    let tau = 1;
    while (tau < limit && nsdf[tau] > 0) tau++; // pula o lóbulo central em τ = 0
    let best = -1;
    for (; tau < limit - 1; tau++) {
      if (nsdf[tau] > 0) {
        if (best < 0 || nsdf[tau] > nsdf[best]) best = tau;
      } else if (best >= 0) {
        if (best >= this.minLag) peaks.push(best);
        best = -1;
      }
    }
    if (best >= this.minLag) peaks.push(best);
    return peaks;
  }
}

/** Interpolação parabólica do pico da NSDF em p. */
function nsdfAt(nsdf, p) {
  const a = nsdf[p - 1], b = nsdf[p], c = nsdf[p + 1];
  const denom = a - 2 * b + c;
  const shift = denom !== 0 ? (0.5 * (a - c)) / denom : 0;
  return { period: p + shift, value: b - 0.25 * (a - c) * shift };
}

function nextPow2(v) {
  let p = 1;
  while (p < v) p <<= 1;
  return p;
}

function reverseBits(v, bits) {
  let r = 0;
  for (let i = 0; i < bits; i++) {
    r = (r << 1) | (v & 1);
    v >>= 1;
  }
  return r;
}
