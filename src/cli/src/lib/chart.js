'use strict';

const { money, num } = require('./format');
const { formatDateDe } = require('./dates');

/**
 * Server-gerenderter Balkenchart als Inline-SVG.
 *
 * Bewusst ohne Chart-Bibliothek: eine Zeitreihe mit einer Serie braucht keine
 * 90 kB JavaScript, und so funktioniert das Dashboard auch ohne CDN.
 *
 * Gestaltung nach den Grundregeln für Datenvisualisierung:
 *   - eine Serie  -> keine Legende, der Titel benennt sie
 *   - Balken mit 4 px abgerundeten Datenenden, an der Grundlinie verankert
 *   - 2 px Abstand zwischen benachbarten Balken
 *   - zurückgenommenes Raster, Text in Textfarben statt in der Serienfarbe
 *   - selektive Direktbeschriftung (nur der höchste Balken), Hover für den Rest
 */
function barChart(days, { valueKey = 'revenue', height = 220 } = {}) {
  const data = Array.isArray(days) ? days : [];
  if (!data.length) return '<p class="empty">Noch keine Daten für den Verlauf.</p>';

  const padTop = 18;
  const padBottom = 28;
  const padLeft = 56;
  const padRight = 12;
  const barGap = 2;

  const width = Math.max(960, data.length * 32);
  const plotW = width - padLeft - padRight;
  const plotH = height - padTop - padBottom;

  const values = data.map((d) => Number(d[valueKey]) || 0);
  const rawMax = Math.max(...values, 0);
  const max = niceCeil(rawMax);
  const maxIndex = values.indexOf(rawMax);

  const step = plotW / data.length;
  const barW = Math.max(3, step - barGap);
  const y = (v) => padTop + plotH - (max === 0 ? 0 : (v / max) * plotH);

  const ticks = max === 0 ? [0] : [0, max / 2, max];
  const grid = ticks
    .map((t) => {
      const ty = y(t);
      return `<line class="c-grid" x1="${padLeft}" x2="${width - padRight}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" />
      <text class="c-axis" x="${padLeft - 8}" y="${(ty + 4).toFixed(1)}" text-anchor="end">${axisLabel(t)}</text>`;
    })
    .join('\n      ');

  const bars = data
    .map((d, i) => {
      const v = Number(d[valueKey]) || 0;
      const x = padLeft + i * step + barGap / 2;
      const top = y(v);
      const h = padTop + plotH - top;
      const tip = `${formatDateDe(d.day)} · ${money(d.revenue)} · ${num(d.orders)} ${
        d.orders === 1 ? 'Bestellung' : 'Bestellungen'
      }`;
      const shape =
        h < 0.5
          ? `<rect class="c-bar c-bar--zero" x="${x.toFixed(1)}" y="${(padTop + plotH - 1).toFixed(1)}" width="${barW.toFixed(1)}" height="1" />`
          : `<path class="c-bar" d="${roundedTopBar(x, top, barW, h, 4)}" />`;
      return `<g class="c-col" data-tip="${escapeAttr(tip)}">
        <rect class="c-hit" x="${(padLeft + i * step).toFixed(1)}" y="${padTop}" width="${step.toFixed(1)}" height="${plotH}" />
        ${shape}
      </g>`;
    })
    .join('\n      ');

  // X-Achse: erster, letzter und etwa jeder fünfte Tag
  const labelEvery = Math.ceil(data.length / 6);
  const xLabels = data
    .map((d, i) => {
      if (i !== 0 && i !== data.length - 1 && i % labelEvery !== 0) return '';
      const x = padLeft + i * step + step / 2;
      const anchor = i === 0 ? 'start' : i === data.length - 1 ? 'end' : 'middle';
      const px = i === 0 ? padLeft : i === data.length - 1 ? width - padRight : x;
      return `<text class="c-axis" x="${px.toFixed(1)}" y="${height - 8}" text-anchor="${anchor}">${shortDate(d.day)}</text>`;
    })
    .filter(Boolean)
    .join('\n      ');

  // Direktbeschriftung nur für den Spitzenwert
  let peak = '';
  if (rawMax > 0 && maxIndex >= 0) {
    const x = padLeft + maxIndex * step + step / 2;
    const ty = y(rawMax) - 6;
    const anchor = maxIndex < 2 ? 'start' : maxIndex > data.length - 3 ? 'end' : 'middle';
    peak = `<text class="c-peak" x="${x.toFixed(1)}" y="${ty.toFixed(1)}" text-anchor="${anchor}">${money(rawMax)}</text>`;
  }

  return `<div class="chart-scroll">
  <svg class="chart" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img"
       aria-label="Tagesumsatz der letzten ${data.length} Tage. Die Einzelwerte stehen in der Bestellliste darunter.">
      ${grid}
      <line class="c-baseline" x1="${padLeft}" x2="${width - padRight}" y1="${padTop + plotH}" y2="${padTop + plotH}" />
      ${bars}
      ${peak}
      ${xLabels}
  </svg>
</div>`;
}

function roundedTopBar(x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h);
  const right = x + w;
  const bottom = y + h;
  return [
    `M${x.toFixed(1)},${bottom.toFixed(1)}`,
    `L${x.toFixed(1)},${(y + radius).toFixed(1)}`,
    `Q${x.toFixed(1)},${y.toFixed(1)} ${(x + radius).toFixed(1)},${y.toFixed(1)}`,
    `L${(right - radius).toFixed(1)},${y.toFixed(1)}`,
    `Q${right.toFixed(1)},${y.toFixed(1)} ${right.toFixed(1)},${(y + radius).toFixed(1)}`,
    `L${right.toFixed(1)},${bottom.toFixed(1)}`,
    'Z',
  ].join(' ');
}

function niceCeil(value) {
  if (!value || value <= 0) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const m of [1, 1.25, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
    if (value <= magnitude * m) return magnitude * m;
  }
  return magnitude * 10;
}

function axisLabel(value) {
  if (value === 0) return '0';
  if (value >= 1000) return `${new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 }).format(value / 1000)} k`;
  return new Intl.NumberFormat('de-DE', { maximumFractionDigits: 0 }).format(value);
}

function shortDate(iso) {
  const [, m, d] = String(iso).split('-');
  return `${d}.${m}.`;
}

function escapeAttr(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

module.exports = { barChart };
