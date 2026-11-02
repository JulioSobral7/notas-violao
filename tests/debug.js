// Linha do tempo de um cenário: tests/debug.html?s=<cenário>&c=<condição>&t=new|old
import { SR, SCENARIOS, CONDITIONS, perform } from './synth.js';
import { LegacyTracker, HOP } from './eval.js';
import { PitchTracker } from '../js/tracker.js';
const q = new URLSearchParams(location.search);
const s = SCENARIOS[+q.get('s')], c = CONDITIONS[+q.get('c')];
const p = perform(s.seq, { ...c, seed: 11 + +q.get('s') });
const tr = q.get('t') === 'old' ? new LegacyTracker(SR) : new PitchTracker(SR);
const lines = [];
for (let i = 0; i + HOP <= p.x.length; i += HOP) {
  const r = tr.push(p.x.subarray(i, i + HOP));
  const t = (i + HOP) / SR;
  const ev = p.events.find((e) => e.start <= t && t < e.end);
  lines.push(`${t.toFixed(3)} truth ${ev ? ev.midi : '-'} out ${r.note ?? '-'} ${r.onset ? 'ONSET' : '     '}${r.noteOn ? ' ON' : '   '} cents ${r.cents.toFixed(1)} tc ${ev ? ev.cents : '-'} flux ${(tr.prevFlux ?? 0).toFixed(3)} spr ${(tr.lastSpread ?? 0).toFixed(2)} v ${(r.voicing ?? 0).toFixed(2)} floor ${(tr.floorDb ?? 0).toFixed(1)} rms ${(20 * Math.log10(r.rms + 1e-9)).toFixed(1)}`);
}
document.getElementById('out').textContent = lines.join('\n');
document.title = 'OK';
