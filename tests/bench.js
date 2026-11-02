// Comparação antes × depois dos detectores em performances sintéticas realistas.
// Rodar com tests/run.sh (ou abrir tests/bench.html servido por HTTP).
import { SR, SCENARIOS, CONDITIONS, perform } from './synth.js';
import { LegacyTracker, evaluate, merge, summarize } from './eval.js';
import { PitchTracker } from '../js/tracker.js';

const trackers = [
  ['anterior', () => new LegacyTracker(SR)],
  ['novo', () => new PitchTracker(SR)],
];

// ?seed=N troca as sementes da síntese (teste de generalização com dados não vistos).
const seedOffset = Number(new URLSearchParams(location.search).get('seed') ?? 0);
const f = (v, d = 1) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const lines = [];
const all = {};
const detail = [];

for (const cond of CONDITIONS) {
  const perfs = SCENARIOS.map((s, i) => ({ s, p: perform(s.seq, { ...cond, seed: 11 + i + seedOffset }) }));
  for (const [name, make] of trackers) {
    const per = perfs.map(({ s, p }) => ({ s, m: evaluate(make, p) }));
    all[`${cond.name}|${name}`] = summarize(merge(per.map((x) => x.m)));
    for (const { s, m } of per) detail.push([cond.name, name, s.name, summarize(m)]);
  }
}

const header = 'condição               detector   acerto  oitava  outra  sem nota  falso+  espúrias/100  perdidas  lat.med  lat.p90  cents  ms/bloco  hist.ok  hist.extra';
lines.push(header, '-'.repeat(header.length));
for (const cond of CONDITIONS) {
  for (const [name] of trackers) {
    const r = all[`${cond.name}|${name}`];
    lines.push([
      cond.name.padEnd(22), name.padEnd(9), `${f(r.acerto)}%`.padStart(7), `${f(r.oitava)}%`.padStart(7),
      `${f(r.outraNota)}%`.padStart(6), `${f(r.semNota)}%`.padStart(9), `${f(r.falsoPositivo)}%`.padStart(7),
      f(r.espuriasPor100).padStart(13), String(r.notasPerdidas).padStart(9), `${f(r.latMediana, 0)}ms`.padStart(8),
      `${f(r.latP90, 0)}ms`.padStart(8), f(r.centsRms).padStart(6), f(r.msPorBloco, 2).padStart(9),
      `${f(r.historicoOk)}%`.padStart(8), `${f(r.historicoExtras)}%`.padStart(11),
    ].join(' '));
  }
}
lines.push('', 'Por cenário (acerto / oitava / espúrias por 100 notas / latência mediana):');
for (const [c, n, s, r] of detail) {
  lines.push(`  ${c.padEnd(22)} ${n.padEnd(9)} ${s.padEnd(30)} ${f(r.acerto).padStart(5)}%  ${f(r.oitava).padStart(4)}%  ${f(r.espuriasPor100).padStart(5)}  ${f(r.latMediana, 0).padStart(4)}ms`);
}

// Metas do plano (só para o detector novo).
const fails = [];
{
  const hard = all[`${CONDITIONS[1].name}|novo`];
  const checks = [
    ['acerto ≥ 98% (celular, 25 dB)', hard.acerto >= 98],
    ['erro de oitava < 0,5% (todas as condições)', CONDITIONS.every((c) => all[`${c.name}|novo`].oitava < 0.5)],
    ['latência mediana ≤ 80 ms (todas)', CONDITIONS.every((c) => all[`${c.name}|novo`].latMediana <= 80)],
    ['< 1 ms por bloco', CONDITIONS.every((c) => all[`${c.name}|novo`].msPorBloco < 1)],
    ['histórico: ≥ 98% das notas, ≤ 2% de extras (todas)', CONDITIONS.every((c) => all[`${c.name}|novo`].historicoOk >= 98 && all[`${c.name}|novo`].historicoExtras <= 2)],
  ];
  lines.push('', 'Metas:');
  for (const [name, ok] of checks) {
    lines.push(`  ${ok ? 'ok    ' : 'FALHOU'} ${name}`);
    if (!ok) fails.push(name);
  }
}

document.getElementById('out').textContent = lines.join('\n');
document.title = fails.length ? 'FALHOU' : 'OK';
