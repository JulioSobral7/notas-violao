/** Desenha o braço do violão (afinação padrão, casas 0–12) em um <svg>. */

import { mod12, pcName } from './music.js';

export const TUNING = [64, 59, 55, 50, 45, 40]; // Mi4 Si3 Sol3 Ré3 Lá2 Mi2 — corda aguda em cima, como na tablatura
const FRETS = 12;
const LABEL_W = 30;
const OPEN_W = 36;
const FRET_W = 46;
const TOP = 16;
const GAP = 26;
const WIDTH = LABEL_W + OPEN_W + FRETS * FRET_W + 8;
const BOARD_BOTTOM = TOP + GAP * (TUNING.length - 1);
const HEIGHT = BOARD_BOTTOM + 36;
const INLAYS = [3, 5, 7, 9];

const fretX = (f) => LABEL_W + OPEN_W + f * FRET_W; // posição do traste f (0 = pestana)
const noteX = (f) => (f === 0 ? LABEL_W + OPEN_W / 2 : fretX(f) - FRET_W / 2);
const stringY = (s) => TOP + s * GAP;

let lastKey = '';

/**
 * @param {SVGSVGElement} svg
 * @param {object} o
 * @param {Set<number>|null} o.scalePcs  notas da escala detectada (ou null)
 * @param {number|null} o.root           tônica da escala
 * @param {boolean} o.flats
 * @param {Set<number>} o.playedPcs      notas captadas (usadas quando não há escala)
 * @param {number|null} o.currentMidi    nota soando agora
 * @param {'solfege'|'letters'} o.notation
 */
export function renderFretboard(svg, o) {
  const key = [
    o.scalePcs ? [...o.scalePcs].join(',') : '-', o.root, o.flats,
    [...o.playedPcs].join(','), o.currentMidi, o.notation,
  ].join('|');
  if (key === lastKey) return;
  lastKey = key;

  const parts = [];
  parts.push(`<rect class="fb-wood" x="${LABEL_W + OPEN_W}" y="${TOP - 8}" width="${FRETS * FRET_W}" height="${BOARD_BOTTOM - TOP + 16}" rx="3"/>`);

  for (const f of INLAYS) {
    parts.push(`<circle class="fb-inlay" cx="${noteX(f)}" cy="${(TOP + BOARD_BOTTOM) / 2}" r="4.5"/>`);
  }
  parts.push(`<circle class="fb-inlay" cx="${noteX(12)}" cy="${stringY(1) + GAP / 2}" r="4.5"/>`);
  parts.push(`<circle class="fb-inlay" cx="${noteX(12)}" cy="${stringY(3) + GAP / 2}" r="4.5"/>`);

  for (let f = 0; f <= FRETS; f++) {
    const cls = f === 0 ? 'fb-nut' : 'fb-fret';
    parts.push(`<line class="${cls}" x1="${fretX(f)}" y1="${TOP - 8}" x2="${fretX(f)}" y2="${BOARD_BOTTOM + 8}"/>`);
    if (f > 0) parts.push(`<text class="fb-num" x="${noteX(f)}" y="${HEIGHT - 6}">${f}</text>`);
  }

  TUNING.forEach((open, s) => {
    const y = stringY(s);
    parts.push(`<line class="fb-string" x1="${LABEL_W}" y1="${y}" x2="${fretX(FRETS)}" y2="${y}" stroke-width="${0.8 + s * 0.35}"/>`);
    parts.push(`<text class="fb-label" x="${LABEL_W / 2}" y="${y}">${pcName(open, o.notation)}</text>`);
  });

  TUNING.forEach((open, s) => {
    for (let f = 0; f <= FRETS; f++) {
      const midi = open + f;
      const pc = mod12(midi);
      const isCurrent = midi === o.currentMidi;
      const inSet = o.scalePcs ? o.scalePcs.has(pc) : o.playedPcs.has(pc);
      if (!inSet && !isCurrent) continue;
      let cls = 'fb-dot';
      if (o.scalePcs) cls += pc === o.root ? ' is-root' : ' is-scale';
      else cls += ' is-played';
      if (o.scalePcs && !o.scalePcs.has(pc)) cls += ' is-outside';
      if (isCurrent) cls += ' is-current';
      const x = noteX(f);
      const y = stringY(s);
      parts.push(`<g class="${cls}"><circle cx="${x}" cy="${y}" r="10.5"/><text x="${x}" y="${y}">${pcName(pc, o.notation, o.flats)}</text></g>`);
    }
  });

  svg.setAttribute('viewBox', `0 0 ${WIDTH} ${HEIGHT}`);
  svg.innerHTML = parts.join('');
}
