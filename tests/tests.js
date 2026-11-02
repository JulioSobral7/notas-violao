// Testes dos algoritmos com sinais sintéticos. Rodar com tests/run.sh
// (ou abrir tests/test.html num navegador servido por HTTP).
import { PitchDetector } from '../js/pitch.js';
import { ScaleDetector, freqToMidi, midiToFreq, pcName } from '../js/music.js';
import { PitchTracker } from '../js/tracker.js';
import { pluckDecay, pluckSamples } from '../js/pluck.js';

const SR = 48000;
const N = 4096;
const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// Gerador pseudoaleatório determinístico (testes reproduzíveis).
let seed = 12345;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

/** Tom com harmônicos (amplitudes dadas), leve inarmonicidade de corda e ruído. */
function harmonicTone(freq, amps, { noise = 0.01, offset = 0 } = {}) {
  const buf = new Float32Array(N);
  const phases = amps.map(() => rand() * 2 * Math.PI);
  const B = 0.00008; // inarmonicidade típica de corda de aço/nylon
  for (let i = 0; i < N; i++) {
    const t = (i + offset) / SR;
    let v = 0;
    amps.forEach((a, k) => {
      const h = k + 1;
      const fh = freq * h * Math.sqrt(1 + B * h * h);
      if (fh < SR / 2) v += a * Math.sin(2 * Math.PI * fh * t + phases[k]);
    });
    buf[i] = 0.2 * v + noise * (rand() * 2 - 1);
  }
  return buf;
}

/** Corda dedilhada (Karplus-Strong); devolve uma janela após o ataque. */
function karplusStrong(freq, skip = 0.12) {
  const total = Math.ceil(skip * SR) + N;
  const period = SR / freq; // atraso do laço = L + 0,5 (média) + atraso do passa-tudo
  const L = Math.floor(period - 0.6);
  const frac = period - 0.5 - L;
  const c = (1 - frac) / (1 + frac);
  const y = new Float32Array(total);
  let apIn = 0, apOut = 0;
  for (let n = 0; n < total; n++) {
    const exc = n < L ? rand() * 2 - 1 : 0;
    const avg = 0.996 * 0.5 * ((y[n - L] || 0) + (y[n - L - 1] || 0));
    const ap = c * avg + apIn - c * apOut;
    apIn = avg;
    apOut = ap;
    y[n] = exc + ap;
  }
  return y.subarray(total - N).map((v) => v * 0.2);
}

const detector = new PitchDetector(N, SR);

function testPitch(label, midi, buf, tolCents = 5) {
  const { freq, clarity } = detector.detect(buf);
  const got = freq > 0 ? freqToMidi(freq) : NaN;
  const err = (got - midi) * 100;
  const ok = Math.round(got) === midi && Math.abs(err) <= tolCents;
  check(`${label} ${pcName(midi % 12, 'letters')}${Math.floor(midi / 12) - 1}`, ok,
    `${freq.toFixed(2)} Hz, erro ${err.toFixed(1)} cents, clareza ${clarity.toFixed(2)}`);
}

// Notas do violão: Mi2 (40) até Mi6 (88, casa 24 da 1ª corda)
const GUITAR = [];
for (let m = 40; m <= 88; m++) GUITAR.push(m);

const typical = [1, 0.8, 0.6, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05, 0.03];
const weakFundamental = [0.15, 1, 0.8, 0.5, 0.35, 0.2, 0.1, 0.05]; // mic de celular corta graves
const strong2nd = [0.6, 1, 0.4, 0.3, 0.1];

for (const m of GUITAR) testPitch('timbre típico', m, harmonicTone(midiToFreq(m), typical));
for (const m of GUITAR.filter((x) => x <= 59)) testPitch('fundamental fraca', m, harmonicTone(midiToFreq(m), weakFundamental));
for (const m of GUITAR) testPitch('2º harmônico forte', m, harmonicTone(midiToFreq(m), strong2nd));
for (const m of GUITAR.filter((x) => x <= 76)) testPitch('Karplus-Strong', m, karplusStrong(midiToFreq(m)), 8);

// Desafinação: Lá2 com +20 cents deve ser Lá2 e medir +20.
{
  const f = midiToFreq(45 + 0.2);
  const { freq } = detector.detect(harmonicTone(f, typical));
  const cents = (freqToMidi(freq) - 45) * 100;
  check('desafinado +20 cents', Math.abs(cents - 20) < 2, `${cents.toFixed(1)} cents`);
}
// Silêncio/ruído não deve virar nota com clareza alta.
{
  const noise = new Float32Array(N).map(() => 0.05 * (rand() * 2 - 1));
  const { clarity } = detector.detect(noise);
  check('ruído branco tem clareza baixa', clarity < 0.85, `clareza ${clarity.toFixed(2)}`);
  const r = detector.detect(new Float32Array(N));
  check('silêncio não detecta nada', r.freq === 0, `freq ${r.freq}`);
}

// Desempenho: tempo médio por análise.
{
  const buf = harmonicTone(110, typical);
  const t0 = performance.now();
  const runs = 200;
  for (let i = 0; i < runs; i++) detector.detect(buf);
  const ms = (performance.now() - t0) / runs;
  check('desempenho (< 4 ms por análise)', ms < 4, `${ms.toFixed(2)} ms`);
}

// ------------------------------------------------------- rastreador

// Nota sustentada em outra taxa de amostragem (iPhones usam 44,1 ou 48 kHz).
function sustained(midi, sr, amps, seconds = 0.7) {
  const n = Math.round(seconds * sr);
  const x = new Float32Array(n);
  const f = midiToFreq(midi);
  const phases = amps.map(() => rand() * 2 * Math.PI);
  for (let i = 0; i < n; i++) {
    let v = 0;
    amps.forEach((a, k) => {
      const fh = f * (k + 1) * Math.sqrt(1 + 4e-5 * (k + 1) ** 2);
      if (fh < sr / 2) v += a * Math.sin((2 * Math.PI * fh * i) / sr + phases[k]);
    });
    x[i] = 0.03 * v * Math.exp(-i / sr / 1.5) + 0.0005 * (rand() * 2 - 1);
  }
  return x;
}

for (const sr of [44100, 48000]) {
  for (const [label, amps] of [['timbre típico', typical], ['fundamental fraca', weakFundamental]]) {
    for (const midi of [40, 45, 50, 55, 59, 64, 69, 76, 84, 88]) {
      if (label === 'fundamental fraca' && midi > 59) continue;
      const tracker = new PitchTracker(sr);
      const x = sustained(midi, sr, amps);
      let r;
      for (let i = 0; i + 512 <= x.length; i += 512) r = tracker.push(x.subarray(i, i + 512));
      check(`rastreador ${sr / 1000} kHz, ${label} ${pcName(midi % 12, 'letters')}${Math.floor(midi / 12) - 1}`,
        r.note === midi && Math.abs(r.cents) < 3, `nota ${r.note}, ${r.cents.toFixed(1)} cents`);
    }
  }
}

// --------------------------------------------- referência do afinador

/**
 * Frequência exata de um sinal periódico: pico da autocorrelação perto de K
 * períodos (o erro de interpolação fica dividido por K).
 */
function preciseFreq(x, sr, approx, start, len) {
  const K = Math.max(1, Math.floor((0.05 * sr) / (sr / approx)));
  const corr = (lag) => {
    let c = 0;
    for (let i = start; i < start + len; i++) c += x[i] * x[i + lag];
    return c;
  };
  const center = Math.round((K * sr) / approx);
  let best = center;
  for (let lag = center - 3; lag <= center + 3; lag++) if (corr(lag) > corr(best)) best = lag;
  const [a, b, c] = [corr(best - 1), corr(best), corr(best + 1)];
  const lag = best + (0.5 * (a - c)) / (a - 2 * b + c);
  return (K * sr) / lag;
}

const dbAt = (x, sr, t) => {
  const i = Math.round(t * sr), n = Math.round(0.05 * sr);
  let e = 0;
  for (let k = i; k < i + n; k++) e += x[k] * x[k];
  return 10 * Math.log10(e / n);
};

for (const sr of [44100, 48000]) {
  for (const midi of [40, 45, 50, 55, 59, 64]) {
    const name = `${pcName(midi % 12, 'letters')}${Math.floor(midi / 12) - 1}`;
    const f = midiToFreq(midi);
    const x = pluckSamples(f, sr, { seed: midi });
    const err = 1200 * Math.log2(preciseFreq(x, sr, f, Math.round(0.3 * sr), Math.round(0.4 * sr)) / f);
    check(`referência ${sr / 1000} kHz ${name}: afinação exata`, Math.abs(err) < 1, `${err >= 0 ? '+' : ''}${err.toFixed(2)} cents`);

    // O próprio rastreador do app reconhece a nota enquanto ela soa (0,1–0,6 s).
    const tracker = new PitchTracker(sr);
    const notes = [], cents = [];
    for (let i = 0; i + 512 <= Math.round(0.6 * sr); i += 512) {
      const r = tracker.push(x.subarray(i, i + 512).map((v) => 0.05 * v + 0.0005 * (rand() * 2 - 1)));
      if (i < 0.1 * sr) continue;
      notes.push(r.note);
      if (r.note === midi) cents.push(r.cents);
    }
    const hit = cents.length / notes.length;
    const med = cents.sort((a, b) => a - b)[cents.length >> 1] ?? NaN;
    check(`referência ${sr / 1000} kHz ${name}: rastreador`, hit > 0.95 && Math.abs(med) < 3,
      `${Math.round(hit * 100)}% dos blocos na nota certa, mediana ${med.toFixed(1)} cents`);

    // Decai como corda: ~−30 dB na metade do tempo (os agudos somem antes).
    const T = pluckDecay(f);
    const drop = dbAt(x, sr, T / 2) - dbAt(x, sr, 0.05);
    const dc = x.reduce((a, v) => a + v, 0) / x.length;
    check(`referência ${sr / 1000} kHz ${name}: decaimento`, drop < -25 && drop > -45 && Math.abs(dc) < 1e-3,
      `${drop.toFixed(1)} dB em ${(T / 2).toFixed(2)} s, média ${dc.toExponential(1)}`);

    // Volume: média do primeiro meio segundo em −12 dBFS, sem passar do limite.
    let e = 0, peak = 0;
    const head = Math.round(0.5 * sr);
    for (let i = 0; i < x.length; i++) {
      if (i < head) e += x[i] * x[i];
      peak = Math.max(peak, Math.abs(x[i]));
    }
    const loud = 10 * Math.log10(e / head);
    check(`referência ${sr / 1000} kHz ${name}: volume`, Math.abs(loud + 12) < 1 && peak <= 0.951,
      `média ${loud.toFixed(1)} dBFS, pico ${peak.toFixed(3)}`);
  }
}

// ------------------------------------------------------------ escalas

/** Simula a execução: cada nota soa `dur` segundos (pc = nota MIDI). */
function play(notes, { dur = 0.4, memory = 20, noise = [] } = {}) {
  const sd = new ScaleDetector({ memory });
  const dt = 1 / 60;
  const all = [...notes];
  for (const m of all) {
    sd.onset(m, 0.15);
    for (let t = 0; t < dur; t += dt) {
      sd.decay(dt);
      sd.add(m, dt * 0.95);
    }
  }
  for (const [m, w] of noise) sd.add(m, w);
  return sd.estimate();
}

function testScale(label, notes, expected, opts) {
  const est = play(notes, opts);
  const got = est.status === 'ok' ? `${pcName(est.best.root)} ${est.best.scale.name}` : est.status;
  const alts = est.alternatives?.map((c) => `${pcName(c.root)} ${c.scale.name} ${Math.round(c.prob * 100)}%`).join(', ');
  check(`escala: ${label}`, got === expected,
    `→ ${got}${est.best ? ` (${Math.round(est.best.prob * 100)}%)` : ''}${alts ? ` | alt: ${alts}` : ''}`);
}

const C = 48, A = 45, E = 40, G = 43;
const up = (root, ivs) => ivs.map((i) => root + i);
const updown = (root, ivs) => { const u = up(root, [...ivs, 12]); return [...u, ...u.slice(0, -1).reverse()]; };

testScale('Dó maior subindo e descendo', updown(C, [0, 2, 4, 5, 7, 9, 11]), 'Dó maior');
testScale('Lá menor subindo e descendo', updown(A, [0, 2, 3, 5, 7, 8, 10]), 'Lá menor');
testScale('Sol maior subindo e descendo', updown(G, [0, 2, 4, 5, 7, 9, 11]), 'Sol maior');
testScale('Lá pentatônica menor', updown(A, [0, 3, 5, 7, 10]), 'Lá pentatônica menor');
testScale('Dó pentatônica maior', updown(C, [0, 2, 4, 7, 9]), 'Dó pentatônica maior');
testScale('Mi blues', updown(E, [0, 3, 5, 6, 7, 10]), 'Mi blues');
testScale('Lá menor harmônica', updown(A, [0, 2, 3, 5, 7, 8, 11]), 'Lá menor harmônica');
testScale('Fá maior (com Si♭)', updown(41, [0, 2, 4, 5, 7, 9, 11]), 'Fá maior');
testScale('Dó maior com notas erradas esporádicas', updown(C, [0, 2, 4, 5, 7, 9, 11]), 'Dó maior',
  { noise: [[49, 0.08], [54, 0.06]] });
testScale('Mi menor começando no Mi grave', updown(E, [0, 2, 3, 5, 7, 8, 10]), 'Mi menor');
testScale('Sol maior só descendo', up(G, [0, 2, 4, 5, 7, 9, 11, 12]).reverse(), 'Sol maior');
testScale('poucas notas → aguardando', [45, 48, 52], 'few');
testScale('esquecimento: troca de Dó maior para Mi menor',
  [...updown(C, [0, 2, 4, 5, 7, 9, 11]), ...updown(E, [0, 2, 3, 5, 7, 8, 10]), ...updown(E, [0, 2, 3, 5, 7, 8, 10])],
  'Mi menor', { memory: 8 });

// ------------------------------------------------------------- saída
const failed = results.filter((r) => !r.ok);
const lines = results.map((r) => `${r.ok ? 'ok  ' : 'FALHOU'} ${r.name} — ${r.detail}`);
document.getElementById('out').textContent =
  `${results.length - failed.length}/${results.length} testes passaram\n\n` +
  (failed.length ? `FALHAS:\n${failed.map((r) => `  ${r.name} — ${r.detail}`).join('\n')}\n\n` : '') +
  lines.join('\n');
document.title = failed.length ? 'FALHOU' : 'OK';
