/**
 * Som de corda dedilhada para a referência do afinador: Karplus-Strong
 * estendido (Jaffe & Smith, 1983). Um ruído curto circula numa linha de
 * atraso do tamanho de um período; a cada volta, um filtro de média tira um
 * pouco dos agudos, como a corda real perde o brilho enquanto vibra.
 */

/** Quanto tempo a corda leva para cair 60 dB: graves soam mais que agudos. */
export function pluckDecay(freq) {
  return Math.max(1.5, 4.5 - Math.log2(freq / 82.41)); // Mi2 ≈ 4,5 s, Mi4 ≈ 2,5 s
}

/**
 * @param {number} freq        frequência da nota (Hz)
 * @param {number} sampleRate
 * @param {object} [o]
 * @param {number} [o.decay]        segundos até cair 60 dB (também é a duração)
 * @param {number} [o.brightness]   0–1: suavidade do ataque (dedo ≈ 0,4, palheta ≈ 0,9)
 * @param {number} [o.pickPosition] onde a corda é tocada, em fração do comprimento a partir do cavalete
 * @param {number} [o.seed]         semente do ruído do ataque
 * @param {number} [o.loudness]     volume médio do primeiro meio segundo (dBFS)
 * @returns {Float32Array} amostras, com picos até CEILING
 */
export function pluckSamples(freq, sampleRate, {
  decay = pluckDecay(freq), brightness = 0.45, pickPosition = 0.13, seed = 1, loudness = -12,
} = {}) {
  // Atraso total do laço = um período: N amostras da linha, 0,5 do filtro de
  // média e d (fracionário, entre 0,1 e 1,1) do passa-tudo. Sem o passa-tudo
  // a nota sairia até ~6 cents fora nas cordas agudas.
  const period = sampleRate / freq;
  const N = Math.floor(period - 0.6);
  const d = period - 0.5 - N;
  const C = (1 - d) / (1 + d);
  const loss = 10 ** (-3 / (freq * decay)); // por volta: −60 dB em `decay` s

  // Ataque: ruído suavizado, sem componente contínua, com o "pente" da
  // posição do toque (tocar perto do cavalete realça os harmônicos).
  let s = Math.max(1, Math.floor(seed)) % 2147483647;
  const noise = () => ((s = (s * 16807) % 2147483647) / 2147483647) * 2 - 1;
  const raw = new Float32Array(N);
  let lp = 0;
  for (let i = 0; i < N; i++) raw[i] = lp += (noise() - lp) * brightness;
  const mean = raw.reduce((a, b) => a + b, 0) / N;
  const pick = Math.max(1, Math.round(pickPosition * N));
  const line = raw.map((v, i) => v - (i >= pick ? raw[i - pick] : mean));

  const len = Math.ceil(decay * sampleRate);
  const out = new Float32Array(len);
  let idx = 0, prev = 0, apIn = 0, apOut = 0;
  for (let n = 0; n < len; n++) {
    const y = line[idx];
    out[n] = y;
    const avg = loss * 0.5 * (y + prev);
    prev = y;
    const ap = C * avg + apIn - C * apOut;
    apIn = avg;
    apOut = ap;
    line[idx] = ap;
    if (++idx === N) idx = 0;
  }

  // Tira o resto de componente contínua.
  let x1 = 0, y1 = 0;
  for (let n = 0; n < len; n++) {
    y1 = out[n] - x1 + 0.995 * y1;
    x1 = out[n];
    out[n] = y1;
  }

  // Volume: o ataque tem picos 16–19 dB acima da média; normalizar pelo pico
  // deixaria o som baixo no alto-falante do celular. Normaliza pela média do
  // primeiro meio segundo e segura os picos com um limitador.
  const head = Math.min(len, Math.round(0.5 * sampleRate));
  const target = 10 ** (loudness / 20);
  const headRms = (g, m) => {
    let e = 0;
    for (let n = 0; n < head; n++) e += (out[n] * m * (g ? g[n] : 1)) ** 2;
    return Math.sqrt(e / head) || 1;
  };
  // O limitador tira um pouco da média ao segurar os picos: corrige em poucas rodadas.
  let makeup = target / headRms(null, 1);
  let gain;
  for (let i = 0; ; i++) {
    gain = limiterGain(out, makeup, sampleRate);
    const r = headRms(gain, makeup);
    if (i === 4 || Math.abs(r / target - 1) < 0.02) break;
    makeup *= target / r;
  }

  // Os últimos 50 ms somem suavemente (sem estalo no fim do buffer).
  const fade = Math.min(len, Math.round(0.05 * sampleRate));
  for (let n = 0; n < len; n++) {
    const g = n >= len - fade ? (len - n) / fade : 1;
    out[n] *= makeup * gain[n] * g;
  }
  return out;
}

const CEILING = 0.95;

/**
 * Ganho de um limitador (o buffer inteiro já está pronto, então ele "vê" o
 * pico antes de chegar): por blocos de 1 ms, baixa o ganho o bastante para
 * nenhum pico passar de CEILING e solta devagar (~80 ms), para o volume não
 * "bombear" e a afinação não mudar.
 */
function limiterGain(x, makeup, sampleRate) {
  const B = Math.max(1, Math.round(0.001 * sampleRate));
  const blocks = Math.ceil(x.length / B);
  const need = new Float32Array(blocks);
  for (let b = 0; b < blocks; b++) {
    let p = 0;
    for (let n = b * B; n < Math.min(x.length, (b + 1) * B); n++) p = Math.max(p, Math.abs(x[n]));
    need[b] = Math.min(1, CEILING / (p * makeup || 1));
  }
  const release = 1 - Math.exp(-1 / 80); // por bloco de 1 ms
  const g = new Float32Array(blocks);
  let cur = 1;
  for (let b = 0; b < blocks; b++) {
    // Olha um bloco à frente: o ganho já está baixo quando o pico chega.
    const target = Math.min(need[b], need[b + 1] ?? 1, b > 0 ? need[b - 1] : 1);
    cur = target < cur ? target : cur + (target - cur) * release;
    g[b] = cur;
  }
  // Interpola entre os centros dos blocos (sem degraus no ganho).
  const out = new Float32Array(x.length);
  for (let n = 0; n < x.length; n++) {
    const pos = n / B - 0.5;
    const b0 = Math.max(0, Math.floor(pos));
    const b1 = Math.min(blocks - 1, b0 + 1);
    const t = Math.min(1, Math.max(0, pos - b0));
    out[n] = g[b0] + (g[b1] - g[b0]) * t;
  }
  return out;
}
