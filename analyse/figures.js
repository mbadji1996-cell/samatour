'use strict';
// Génère les figures SVG du document technique à partir de analyse/resultats.json.
const fs = require('fs');
const path = require('path');
const R = JSON.parse(fs.readFileSync(path.join(__dirname, 'resultats.json'), 'utf8'));
const OUT = path.join(__dirname, 'figures');
fs.mkdirSync(OUT, { recursive: true });

// Couleurs validées (dataviz validate_palette : CVD ΔE 27.8, contraste ≥ 3:1)
const SANS = '#c2410c'; // sans Sama Tour
const AVEC = '#2b3fbf'; // avec Sama Tour
const INK = '#16203a', MUTED = '#5f6b85', GRID = '#e3e7f0';
const FONT = "font-family=\"'Segoe UI', Arial, sans-serif\"";

function svg(w, h, body) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" ${FONT}>${body}</svg>`;
}
const legend = (x, y) => `
  <rect x="${x}" y="${y - 9}" width="12" height="12" rx="3" fill="${SANS}"/><text x="${x + 18}" y="${y + 1}" font-size="12" fill="${INK}">Sans Sama Tour</text>
  <rect x="${x + 130}" y="${y - 9}" width="12" height="12" rx="3" fill="${AVEC}"/><text x="${x + 148}" y="${y + 1}" font-size="12" fill="${INK}">Avec Sama Tour</text>`;

// Figure 1 : temps passé sur place
(function () {
  const P = R.principal;
  const groups = [
    ['Tous les patients', P.surPlace.A.moyenne, P.surPlace.B.moyenne],
    ['Patients ayant attendu chez eux', P.patientsMaison.A, P.patientsMaison.B],
  ];
  const W = 620, H = 300, top = 40, base = 250, max = 200, scale = (base - top) / max;
  let b = legend(40, 22);
  for (let v = 0; v <= max; v += 50) {
    const y = base - v * scale;
    b += `<line x1="60" x2="${W - 20}" y1="${y}" y2="${y}" stroke="${GRID}"/><text x="52" y="${y + 4}" font-size="11" fill="${MUTED}" text-anchor="end">${v}</text>`;
  }
  b += `<text x="14" y="${(top + base) / 2}" font-size="11" fill="${MUTED}" transform="rotate(-90 14 ${(top + base) / 2})" text-anchor="middle">minutes sur place</text>`;
  groups.forEach(([label, a, c], i) => {
    const cx = 175 + i * 270, bw = 64;
    [[a, SANS, cx - bw - 1], [c, AVEC, cx + 1]].forEach(([v, col, x]) => {
      const y = base - v * scale;
      b += `<path d="M${x} ${base} V${y + 4} q0 -4 4 -4 h${bw - 8} q4 0 4 4 V${base} Z" fill="${col}"/>`;
      b += `<text x="${x + bw / 2}" y="${y - 6}" font-size="13" font-weight="700" fill="${INK}" text-anchor="middle">${Math.round(v)} min</text>`;
    });
    b += `<text x="${cx}" y="${base + 20}" font-size="12.5" fill="${INK}" text-anchor="middle">${label}</text>`;
  });
  b += `<line x1="60" x2="${W - 20}" y1="${base}" y2="${base}" stroke="${MUTED}"/>`;
  fs.writeFileSync(path.join(OUT, 'fig1-attente-sur-place.svg'), svg(W, H + 10, b));
})();

// Figure 2 : occupation de la salle d'attente au cours de la matinée
(function () {
  const A = R.principal.salle.courbeA, B = R.principal.salle.courbeB;
  const W = 620, H = 290, left = 60, right = W - 20, top = 40, base = 245;
  const tMax = 8 * 60; // 6 h -> 14 h
  const max = 25;
  const x = (t) => left + (t / tMax) * (right - left), y = (v) => base - (v / max) * (base - top);
  let b = legend(40, 22);
  for (let v = 0; v <= max; v += 5) b += `<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}"/><text x="${left - 8}" y="${y(v) + 4}" font-size="11" fill="${MUTED}" text-anchor="end">${v}</text>`;
  for (let hh = 6; hh <= 14; hh += 1) b += `<text x="${x((hh - 6) * 60)}" y="${base + 18}" font-size="11" fill="${MUTED}" text-anchor="middle">${hh} h</text>`;
  b += `<text x="14" y="${(top + base) / 2}" font-size="11" fill="${MUTED}" transform="rotate(-90 14 ${(top + base) / 2})" text-anchor="middle">patients dans la salle</text>`;
  const line = (arr, col) => `<path d="${arr.slice(0, tMax).map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(v).toFixed(1)}`).join(' ')}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round"/>`;
  b += line(A, SANS) + line(B, AVEC);
  b += `<line x1="${x(120)}" x2="${x(120)}" y1="${top}" y2="${base}" stroke="${MUTED}" stroke-dasharray="3 4"/><text x="${x(120) + 4}" y="${top + 10}" font-size="11" fill="${MUTED}">début des consultations</text>`;
  b += `<line x1="${left}" x2="${right}" y1="${base}" y2="${base}" stroke="${MUTED}"/>`;
  fs.writeFileSync(path.join(OUT, 'fig2-salle-attente.svg'), svg(W, H, b));
})();

// Figure 3 : effet selon la part de patients équipés d'un téléphone
(function () {
  const S = R.sensibilite;
  const W = 620, H = 270, left = 60, right = W - 20, top = 30, base = 225, max = 80;
  const y = (v) => base - (v / max) * (base - top);
  let b = '';
  for (let v = 0; v <= max; v += 20) b += `<line x1="${left}" x2="${right}" y1="${y(v)}" y2="${y(v)}" stroke="${GRID}"/><text x="${left - 8}" y="${y(v) + 4}" font-size="11" fill="${MUTED}" text-anchor="end">${v} %</text>`;
  b += `<text x="14" y="${(top + base) / 2}" font-size="11" fill="${MUTED}" transform="rotate(-90 14 ${(top + base) / 2})" text-anchor="middle">baisse du temps sur place</text>`;
  const step = (right - left) / S.length, bw = 70;
  S.forEach((s, i) => {
    const cx = left + step * (i + 0.5), yy = y(s.reductionSurPlacePct);
    b += `<path d="M${cx - bw / 2} ${base} V${yy + 4} q0 -4 4 -4 h${bw - 8} q4 0 4 4 V${base} Z" fill="${AVEC}"/>`;
    b += `<text x="${cx}" y="${yy - 6}" font-size="13" font-weight="700" fill="${INK}" text-anchor="middle">−${Math.round(s.reductionSurPlacePct)} %</text>`;
    b += `<text x="${cx}" y="${base + 18}" font-size="12" fill="${INK}" text-anchor="middle">${s.partTelephone} % équipés</text>`;
  });
  b += `<line x1="${left}" x2="${right}" y1="${base}" y2="${base}" stroke="${MUTED}"/>`;
  fs.writeFileSync(path.join(OUT, 'fig3-sensibilite.svg'), svg(W, H, b));
})();

console.log('Figures écrites dans', OUT);
