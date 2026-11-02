import { PitchTracker } from './tracker.js';
import {
  ScaleDetector, MIN_DISTINCT_NOTES, midiToFreq, midiOctave, mod12, pcName, relativeOf,
} from './music.js';
import { renderFretboard, TUNING } from './fretboard.js';
import { pluckDecay, pluckSamples } from './pluck.js';

const $ = (id) => document.getElementById(id);

const SENSITIVITY = { alta: 6, media: 10, baixa: 16 }; // dB acima do ruído de fundo
const MEMORY = { curta: 8, media: 20, longa: 60, infinita: Infinity }; // segundos
const BLOCK_MS = 0.0107; // ~11 ms por análise (512 amostras a 48 kHz)
const ONSET_WEIGHT = 0.15; // peso extra no histograma a cada nota nova
const HISTORY_SIZE = 16;
const SCALE_UPDATE_MS = 250;
const IN_TUNE_CENTS = 5;
const DISPLAY_SMOOTH_S = 0.15; // constante de tempo da agulha (s)
const TEXT_UPDATE_MS = 250; // Hz, cents e cor mudam no máximo 4x por segundo
const TONE_VOLUME = 1; // o volume já vem ajustado de pluck.js
const TONE_TAIL_MS = 250; // depois do som, ignora o eco que o microfone ainda capta

const DEFAULTS = { notation: 'solfege', a4: 440, sensitivity: 'media', memory: 'media' };
const settings = loadSettings();
const params = new URLSearchParams(location.search);

const state = {
  running: false,
  starting: false,
  ctx: null,
  stream: null,
  tracker: null,
  worklet: null,
  analyser: null, // só no modo de compatibilidade (sem AudioWorklet)
  buf: null,
  raf: 0,
  lastAudioT: 0,
  block: 512,
  pending: 0,
  current: null,
  cents: 0,
  pitch: NaN, // altura mostrada (MIDI fracionário), suavizada
  lastRender: 0,
  lastText: 0,
  textNote: null,
  level: 0,
  shown: undefined,
  history: [],
  scale: null,
  weights: new Array(12).fill(0),
  lastScaleUpdate: 0,
  wakeLock: null,
  demoTimer: 0,
  target: null, // corda escolhida no afinador (MIDI), ou null para qualquer nota
};

// Som de referência do afinador, num AudioContext próprio: funciona com o
// microfone ligado ou desligado.
const tone = { ctx: null, src: null, mutedUntil: 0 };

const scaleDetector = new ScaleDetector({ memory: MEMORY[settings.memory] });

// ---------------------------------------------------------------- áudio

async function start() {
  if (state.running || state.starting) return;
  state.starting = true;
  setStatus('Abrindo o microfone…');
  const demo = params.has('demo');

  // O AudioContext precisa nascer dentro do toque do usuário (exigência do iOS).
  const Ctx = window.AudioContext || window.webkitAudioContext;
  const ctx = new Ctx({ latencyHint: 'interactive' });
  try {
    if (!demo) {
      if (!window.isSecureContext) throw Object.assign(new Error(), { name: 'InsecureContext' });
      if (!navigator.mediaDevices?.getUserMedia) throw Object.assign(new Error(), { name: 'NotSupported' });
      // Sem cancelamento de eco, supressão de ruído nem ganho automático:
      // esses filtros de voz distorcem o som do instrumento.
      state.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        video: false,
      });
    }
    await ctx.resume();

    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 60;
    // O Safari só processa o grafo se ele chegar ao destino; ganho zero evita microfonia.
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);

    state.block = 2 ** Math.round(Math.log2(BLOCK_MS * ctx.sampleRate));
    state.pending = 0;
    state.tracker = new PitchTracker(ctx.sampleRate, { a4: settings.a4, marginDb: SENSITIVITY[settings.sensitivity] });
    if (ctx.audioWorklet && !params.has('noworklet')) {
      // Captura no thread de áudio, em blocos fixos, sem perder amostras.
      await ctx.audioWorklet.addModule('js/capture-worklet.js');
      const node = new AudioWorkletNode(ctx, 'capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: { blockSize: state.block },
      });
      node.port.onmessage = (e) => onAudio(e.data);
      highpass.connect(node).connect(mute);
      state.worklet = node;
    } else {
      // Compatibilidade (iOS < 14.5): lê o AnalyserNode a cada quadro de vídeo.
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 8192;
      highpass.connect(analyser).connect(mute);
      state.analyser = analyser;
      state.buf = new Float32Array(analyser.fftSize);
    }

    if (demo) state.demoTimer = startDemo(ctx, highpass);
    else ctx.createMediaStreamSource(state.stream).connect(highpass);

    state.ctx = ctx;
    state.running = true;
    state.lastAudioT = ctx.currentTime;
    state.raf = requestAnimationFrame(tick);
    requestWakeLock();
    setStatus(listeningMessage());
  } catch (err) {
    ctx.close().catch(() => {});
    stopStream();
    setStatus(errorMessage(err), true);
  } finally {
    state.starting = false;
    renderStartButton();
  }
}

function stop() {
  cancelAnimationFrame(state.raf);
  clearInterval(state.demoTimer);
  state.running = false;
  stopStream();
  if (state.worklet) state.worklet.port.onmessage = null;
  state.worklet = null;
  state.analyser = null;
  state.ctx?.close().catch(() => {});
  state.ctx = null;
  state.wakeLock?.release().catch(() => {});
  state.wakeLock = null;
  state.current = null;
  state.level = 0;
  renderCurrent();
  $('level-fill').style.transform = 'scaleX(0)';
  setStatus('Pausado. Toque em “Começar” para ouvir de novo.');
  renderStartButton();
}

function stopStream() {
  state.stream?.getTracks().forEach((t) => t.stop());
  state.stream = null;
}

function errorMessage(err) {
  switch (err?.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Permissão do microfone negada. Libere o microfone para este site nas configurações do navegador e tente de novo.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'Nenhum microfone encontrado neste dispositivo.';
    case 'NotReadableError':
      return 'O microfone está sendo usado por outro aplicativo.';
    case 'InsecureContext':
      return 'O navegador só libera o microfone em páginas HTTPS. Abra o app por um endereço https://.';
    case 'NotSupported':
      return 'Este navegador não permite captar áudio. Use Chrome, Safari ou Firefox atualizados.';
    default:
      return `Não foi possível abrir o microfone (${err?.message || err}).`;
  }
}

/** Cada bloco de áudio passa pelo rastreador; o resultado alimenta a escala. */
function onAudio(chunk) {
  if (!state.running) return;
  const r = state.tracker.push(chunk);
  // Com o som de referência tocando, o microfone ouve o próprio alto-falante:
  // a leitura fica pausada para não mostrar o som de referência como se fosse a corda.
  if (performance.now() < tone.mutedUntil) r.note = null;
  const dt = chunk.length / state.ctx.sampleRate;
  // Afinando uma corda: a escala e o histórico ficam parados.
  const tuning = state.target !== null;
  if (!tuning) scaleDetector.decay(dt);
  state.level = r.level;
  if (r.note !== null && !tuning) {
    if (r.noteOn) {
      scaleDetector.onset(r.note, ONSET_WEIGHT);
      state.history.unshift(r.note);
      if (state.history.length > HISTORY_SIZE) state.history.pop();
      state.historyDirty = true;
    }
    scaleDetector.add(mod12(r.note), dt * r.voicing);
  }
  if (r.note !== null) {
    state.cents = r.cents;
  }
  state.current = r.note;
}

/**
 * Laço de desenho (um por quadro de vídeo). No modo de compatibilidade também
 * entrega ao rastreador as amostras novas do AnalyserNode.
 * @param {number} t timestamp do requestAnimationFrame
 */
function tick(t) {
  state.raf = requestAnimationFrame(tick);
  if (state.analyser) {
    // Quantas amostras chegaram desde a última leitura, pelo relógio de áudio
    // (exato), não pelo de vídeo (irregular). Entrega em blocos do mesmo
    // tamanho do AudioWorklet; o resto fica para o próximo quadro.
    const now = state.ctx.currentTime;
    const { buf, block } = state;
    state.pending = Math.min(buf.length, state.pending + Math.round((now - state.lastAudioT) * state.ctx.sampleRate));
    state.lastAudioT = now;
    const n = Math.floor(state.pending / block);
    if (n > 0) {
      state.analyser.getFloatTimeDomainData(buf);
      const rest = state.pending - n * block; // amostras mais novas, ainda não entregues
      for (let i = n; i > 0; i--) {
        const end = buf.length - rest - (i - 1) * block;
        onAudio(buf.subarray(end - block, end));
      }
      state.pending = rest;
    }
  }

  renderLevel(state.level);
  renderCurrent(t);
  if (state.historyDirty) {
    state.historyDirty = false;
    renderHistory();
  }
  if (t - state.lastScaleUpdate > SCALE_UPDATE_MS) {
    state.lastScaleUpdate = t;
    updateScale();
  }
}

/**
 * A agulha segue a altura suavizada a cada quadro; os números e a cor só
 * mudam a cada TEXT_UPDATE_MS (ou na hora, quando a nota muda), para dar
 * tempo de ler.
 */
function renderCurrent(now = performance.now()) {
  const dt = (now - state.lastRender) / 1000;
  state.lastRender = now;
  if (state.current === null) {
    $('note-card').dataset.state = 'idle';
    state.pitch = NaN;
    state.textNote = null;
  } else {
    const raw = state.current + state.cents / 100;
    // Salto de mais de meio tom (ou primeira leitura): mostra direto, sem arrastar.
    const jump = !(Math.abs(raw - state.pitch) < 0.5);
    state.pitch = jump ? raw : state.pitch + (raw - state.pitch) * (1 - Math.exp(-dt / DISPLAY_SMOOTH_S));
    const showText = state.current !== state.textNote || now - state.lastText >= TEXT_UPDATE_MS;
    if (showText) {
      state.lastText = now;
      state.textNote = state.current;
    }
    renderNote(state.current, (state.pitch - state.current) * 100, showText);
  }
  if (state.current !== state.shown) {
    state.shown = state.current;
    renderBoard();
  }
}

/**
 * Modo de demonstração (?demo na URL): toca notas sintetizadas com timbre de
 * corda dedilhada, para testar o app sem violão por perto.
 */
function startDemo(ctx, dest) {
  const melody = [57, 60, 62, 64, 67, 69, 72, 69, 67, 64, 62, 60, 57, 57]; // Lá menor pentatônica
  const harmonics = [0, 1, 0.7, 0.45, 0.3, 0.2, 0.12, 0.08, 0.05];
  const wave = ctx.createPeriodicWave(new Float32Array(harmonics.length), new Float32Array(harmonics));
  const out = ctx.createGain();
  out.gain.value = 0.25;
  out.connect(dest);
  out.connect(ctx.destination);
  let i = 0;
  const pluck = () => {
    const t = ctx.currentTime + 0.02;
    const osc = ctx.createOscillator();
    const env = ctx.createGain();
    osc.setPeriodicWave(wave);
    osc.frequency.value = midiToFreq(melody[i++ % melody.length], settings.a4);
    env.gain.setValueAtTime(0, t);
    env.gain.linearRampToValueAtTime(1, t + 0.005);
    env.gain.exponentialRampToValueAtTime(0.001, t + 1.2);
    osc.connect(env).connect(out);
    osc.start(t);
    osc.stop(t + 1.25);
  };
  pluck();
  return setInterval(pluck, 550);
}

// ------------------------------------------------------------- interface

function names(pc, flats) {
  const other = settings.notation === 'solfege' ? 'letters' : 'solfege';
  return { main: pcName(pc, settings.notation, flats), alt: pcName(pc, other, flats) };
}

const keyFlats = () => (state.scale ? state.scale.flats : false);

const formatHz = (freq) => `${freq.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} Hz`;
const formatCents = (c) => `${c > 0 ? '+' : '−'}${Math.abs(c)} cents`;

function renderNote(midi, cents, showText) {
  // Afinador de corda: o desvio é medido até a nota da corda escolhida.
  const off = state.target === null ? cents : offsetFromTarget(midi + cents / 100);
  $('tuner-needle').style.left = `${50 + Math.max(-50, Math.min(50, off))}%`;
  if (!showText) return;

  const pc = mod12(midi);
  const octave = midiOctave(midi);
  const card = $('note-card');
  setText('note-freq', formatHz(midiToFreq(midi + cents / 100, settings.a4)));
  if (state.target === null) {
    const { main, alt } = names(pc, keyFlats());
    setText('note-name', main);
    setText('note-octave', String(octave));
    setText('note-alt', `${alt}${octave}`);
    const c = Math.round(cents);
    setText('note-cents', c === 0 ? 'afinado' : formatCents(c));
    if (state.scale) card.classList.toggle('outside', !state.scale.pcs.has(pc));
    else card.classList.remove('outside');
  } else {
    renderTargetName();
    setText('note-alt', `ouvindo ${pcName(pc, settings.notation)}${octave}`);
    const c = Math.round(off);
    setText('note-cents', Math.abs(c) <= IN_TUNE_CENTS ? 'afinada' : `${formatCents(c)} · ${c < 0 ? 'aperte' : 'afrouxe'}`);
    card.classList.remove('outside');
  }

  const abs = Math.abs(off);
  card.dataset.state = abs <= IN_TUNE_CENTS ? 'in-tune' : abs <= 15 ? 'near' : 'off';
}

/**
 * Distância em cents da nota tocada até a corda escolhida, dobrada para ±600:
 * se o rastreador pegar um harmônico (uma oitava acima), o app não manda
 * apertar a corda uma oitava inteira.
 */
function offsetFromTarget(midi) {
  const d = (midi - state.target) * 100;
  return d - 1200 * Math.round(d / 1200);
}

function renderTargetName() {
  setText('note-name', pcName(mod12(state.target), settings.notation));
  setText('note-octave', String(midiOctave(state.target)));
}

/** Mostra a corda escolhida (ou limpa o cartão) enquanto nada está soando. */
function renderTargetIdle() {
  const card = $('note-card');
  card.dataset.state = 'idle';
  card.classList.remove('outside');
  setText('note-cents', '');
  if (state.target === null) {
    setText('note-name', '—');
    setText('note-octave', '');
    setText('note-alt', '');
    setText('note-freq', '');
    return;
  }
  const other = settings.notation === 'solfege' ? 'letters' : 'solfege';
  renderTargetName();
  setText('note-alt', `${pcName(mod12(state.target), other)}${midiOctave(state.target)}`);
  setText('note-freq', formatHz(midiToFreq(state.target, settings.a4)));
}

function stringNumber(midi) {
  return TUNING.indexOf(midi) + 1;
}

function listeningMessage() {
  if (params.has('demo')) return 'Modo demonstração: tocando uma escala sintetizada.';
  if (state.target !== null) return `Afinando a ${stringNumber(state.target)}ª corda: toque só ela, solta.`;
  return 'Ouvindo… toque uma nota no violão.';
}

/** Botões do afinador: Auto (qualquer nota) e as seis cordas, da 6ª (grave) à 1ª. */
function renderStrings() {
  const options = [{ value: '', label: 'Auto', num: 'nota' }].concat(
    [...TUNING].reverse().map((midi) => ({
      value: String(midi),
      label: pcName(mod12(midi), settings.notation),
      num: `${stringNumber(midi)}ª`,
    })),
  );
  const current = state.target === null ? '' : String(state.target);
  setHTML('strings', options.map((o) => `<label><input type="radio" name="string" value="${o.value}"${o.value === current ? ' checked' : ''}><span><small>${o.num}</small>${o.label}</span></label>`).join(''));
}

function bindStrings() {
  renderStrings();
  $('strings').addEventListener('change', (e) => {
    state.target = e.target.value === '' ? null : Number(e.target.value);
    state.textNote = null; // redesenha os números já no próximo quadro
    renderTargetIdle();
    stopTone();
    renderToneButton();
    if (state.running) setStatus(listeningMessage());
  });
  $('btn-tone').addEventListener('click', playTone);
}

// ------------------------------------------------------ som de referência

const targetLabel = () => `${pcName(mod12(state.target), settings.notation)}${midiOctave(state.target)}`;

/** Dedilha a corda escolhida (tocar de novo dedilha outra vez). */
function playTone() {
  if (state.target === null) return;
  const Ctx = window.AudioContext || window.webkitAudioContext;
  tone.ctx ??= new Ctx();
  const ctx = tone.ctx;
  ctx.resume().catch(() => {});
  stopTone();

  const freq = midiToFreq(state.target, settings.a4);
  const decay = pluckDecay(freq);
  const samples = pluckSamples(freq, ctx.sampleRate, { decay, seed: 1 + Math.floor(Math.random() * 1e6) });
  const buffer = ctx.createBuffer(1, samples.length, ctx.sampleRate);
  buffer.getChannelData(0).set(samples);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = TONE_VOLUME;
  src.connect(gain).connect(ctx.destination);
  src.onended = () => {
    if (tone.src !== src) return;
    tone.src = null;
    renderToneButton();
  };
  src.start();
  tone.src = src;
  // Pausa a leitura até o som cair uns 30 dB (metade do decaimento).
  tone.mutedUntil = performance.now() + decay * 500 + TONE_TAIL_MS;
  renderToneButton();
}

function stopTone() {
  if (!tone.src) return;
  tone.src.onended = null;
  tone.src.stop();
  tone.src = null;
  tone.mutedUntil = Math.min(tone.mutedUntil, performance.now() + TONE_TAIL_MS);
  renderToneButton();
}

function renderToneButton() {
  const btn = $('btn-tone');
  btn.hidden = state.target === null;
  $('tone-hint').hidden = state.target === null;
  btn.classList.toggle('is-playing', Boolean(tone.src));
  if (state.target !== null) btn.querySelector('span').textContent = `Ouvir ${targetLabel()}`;
}

function renderLevel(level) {
  $('level-fill').style.transform = `scaleX(${level.toFixed(3)})`;
}

function updateScale() {
  const est = scaleDetector.estimate();
  state.scale = est.status === 'ok' ? est.best : null;
  state.weights = est.weights;
  renderScale(est);
  renderHistogram(est.weights);
  renderBoard();
}

function scaleLabel(c) {
  return `${pcName(c.root, settings.notation, c.flats)} ${c.scale.name}`;
}

function renderScale(est) {
  const card = $('scale-card');
  card.dataset.state = est.status;
  if (est.status !== 'ok') {
    setText('scale-name', '—');
    $('scale-conf-fill').style.transform = 'scaleX(0)';
    setText('scale-conf', '');
    setText('scale-meta',
      est.status === 'empty'
        ? 'Toque algumas notas: a escala aparece aqui.'
        : `Notas diferentes captadas: ${est.distinct} de ${MIN_DISTINCT_NOTES} necessárias.`);
    setHTML('scale-notes', '');
    setHTML('scale-alts', '');
    return;
  }

  const best = est.best;
  setText('scale-name', scaleLabel(best));
  $('scale-conf-fill').style.transform = `scaleX(${best.prob.toFixed(3)})`;
  setText('scale-conf', `${Math.round(best.prob * 100)}% de confiança`);
  const rel = relativeOf(best.root, best.scale);
  setText('scale-meta', rel ? `Mesmas notas que ${scaleLabel(rel)}` : '');

  const chips = best.scale.intervals.map((iv) => {
    const pc = (best.root + iv) % 12;
    const played = est.weights[pc] >= 0.15;
    const cls = ['chip', iv === 0 ? 'is-root' : '', played ? 'is-played' : ''].join(' ').trim();
    return `<span class="${cls}">${pcName(pc, settings.notation, best.flats)}</span>`;
  });
  setHTML('scale-notes', chips.join(''));

  const alts = est.alternatives.map((c) => `<span class="alt">${scaleLabel(c)} <small>${Math.round(c.prob * 100)}%</small></span>`);
  setHTML('scale-alts', alts.length ? `<span class="alts-label">Também pode ser:</span> ${alts.join('')}` : '');
}

function renderHistogram(weights) {
  const flats = keyFlats();
  const bars = weights.map((w, pc) => {
    const inScale = state.scale?.pcs.has(pc);
    const isRoot = state.scale?.root === pc;
    const cls = ['bar', inScale ? 'in-scale' : '', isRoot ? 'is-root' : ''].join(' ').trim();
    return `<div class="${cls}"><div class="bar-track"><div class="bar-fill" style="transform:scaleY(${w.toFixed(3)})"></div></div><span>${pcName(pc, settings.notation, flats)}</span></div>`;
  });
  setHTML('histogram', bars.join(''));
}

function renderHistory() {
  const flats = keyFlats();
  const items = state.history.map((m) => `<span class="chip">${pcName(mod12(m), settings.notation, flats)}<sub>${midiOctave(m)}</sub></span>`);
  setHTML('history', items.length ? items.join('') : '<span class="muted">As últimas notas tocadas aparecem aqui.</span>');
}

function renderBoard() {
  const s = state.scale;
  const played = new Set();
  state.weights.forEach((w, pc) => { if (w >= 0.15) played.add(pc); });
  renderFretboard($('fretboard'), {
    scalePcs: s ? s.pcs : null,
    root: s ? s.root : null,
    flats: s ? s.flats : false,
    playedPcs: played,
    currentMidi: state.current,
    notation: settings.notation,
  });
}

function renderStartButton() {
  const btn = $('btn-start');
  btn.disabled = state.starting;
  btn.classList.toggle('is-running', state.running);
  btn.querySelector('span').textContent = state.running ? 'Parar' : 'Começar';
  btn.setAttribute('aria-pressed', String(state.running));
}

function setStatus(msg, isError = false) {
  const el = $('status');
  el.textContent = msg;
  el.classList.toggle('error', isError);
}

function setText(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function setHTML(id, html) {
  const el = $(id);
  if (el._html !== html) {
    el.innerHTML = html;
    el._html = html;
  }
}

// ------------------------------------------------------- configurações

function loadSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('notas-settings') || '{}');
    const s = { ...DEFAULTS, ...saved };
    if (!(s.sensitivity in SENSITIVITY)) s.sensitivity = DEFAULTS.sensitivity;
    if (!(s.memory in MEMORY)) s.memory = DEFAULTS.memory;
    if (!['solfege', 'letters'].includes(s.notation)) s.notation = DEFAULTS.notation;
    s.a4 = clampA4(s.a4);
    return s;
  } catch {
    return { ...DEFAULTS };
  }
}

function saveSettings() {
  try {
    localStorage.setItem('notas-settings', JSON.stringify(settings));
  } catch {
    /* armazenamento indisponível (aba anônima etc.) — segue só nesta sessão */
  }
}

function clampA4(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.max(415, Math.min(466, n)) : DEFAULTS.a4;
}

function bindSettings() {
  const sheet = $('settings');
  const open = () => {
    sheet.hidden = false;
    requestAnimationFrame(() => sheet.classList.add('open'));
  };
  const close = () => {
    sheet.classList.remove('open');
    setTimeout(() => { sheet.hidden = true; }, 200);
  };
  $('btn-settings').addEventListener('click', open);
  $('btn-close-settings').addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !sheet.hidden) close(); });

  for (const name of ['notation', 'sensitivity', 'memory']) {
    const input = document.querySelector(`input[name="${name}"][value="${settings[name]}"]`);
    if (input) input.checked = true;
    document.querySelectorAll(`input[name="${name}"]`).forEach((el) => {
      el.addEventListener('change', () => {
        settings[name] = el.value;
        saveSettings();
        if (name === 'memory') scaleDetector.setMemory(MEMORY[el.value]);
        if (name === 'sensitivity') state.tracker?.setMargin(SENSITIVITY[el.value]);
        if (name === 'notation') refreshAll();
      });
    });
  }

  const a4 = $('a4');
  const showA4 = () => {
    a4.value = settings.a4;
    setText('a4-value', `${settings.a4} Hz`);
    state.tracker?.setA4(settings.a4);
    if (state.current === null) renderTargetIdle();
  };
  showA4();
  a4.addEventListener('input', () => {
    settings.a4 = clampA4(a4.value);
    showA4();
    saveSettings();
  });
  $('a4-reset').addEventListener('click', () => {
    settings.a4 = DEFAULTS.a4;
    showA4();
    saveSettings();
  });
}

function refreshAll() {
  updateScale();
  renderHistory();
  renderStrings();
  renderToneButton();
  state.textNote = null;
  if (state.current === null) renderTargetIdle();
}

// ------------------------------------------------------------ sistema

async function requestWakeLock() {
  // Mantém a tela acesa enquanto o app escuta (quando o navegador permite).
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible') {
      state.wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch {
    /* sem suporte ou sem permissão: segue sem */
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') stopTone();
  if (document.visibilityState === 'visible' && state.running) {
    state.ctx?.resume().catch(() => {});
    requestWakeLock();
  }
});

$('btn-start').addEventListener('click', () => (state.running ? stop() : start()));
$('btn-reset').addEventListener('click', () => {
  scaleDetector.reset();
  state.history.length = 0;
  renderHistory();
  updateScale();
});
bindSettings();
bindStrings();
renderHistory();
updateScale();
renderStartButton();

// Usado nos testes automatizados (navegador sem interface): ?demo&autostart
if (params.has('demo') && params.has('autostart')) start();

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(() => {
      /* ex.: certificado autoassinado — o app funciona, só não fica offline */
    });
  });
}
