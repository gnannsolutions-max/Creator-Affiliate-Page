'use strict';

/**
 * Marken, mit denen das Programm zusammenarbeitet – für die Logoleiste auf der
 * Startseite.
 *
 * Die Logos liegen als weiße PNG mit transparentem Hintergrund unter
 * public/partners/<slug>.png. Einheitlich weiß, weil zehn Logos in zehn
 * Hausfarben auf dunklem Grund unruhig wirken und mehrere davon (Optimum
 * Nutrition, LMNT) ohnehin schon weiß sind.
 *
 * Eine Marke hinzufügen: Logo als PNG oder SVG nach public/partners/ legen und
 * hier eine Zeile ergänzen. Eine Marke entfernen: Zeile löschen. Die Reihenfolge
 * hier ist die Reihenfolge auf der Seite.
 */
const PARTNERS = [
  { slug: 'ag1', name: 'AG1' },
  { slug: 'thorne', name: 'Thorne' },
  { slug: 'ritual', name: 'Ritual' },
  { slug: 'momentous', name: 'Momentous' },
  { slug: 'transparent-labs', name: 'Transparent Labs' },
  { slug: 'optimum-nutrition', name: 'Optimum Nutrition' },
  { slug: 'seed', name: 'Seed' },
  { slug: 'lmnt', name: 'LMNT' },
  { slug: 'bloom-nutrition', name: 'Bloom Nutrition' },
  { slug: 'maryruth', name: "MaryRuth Organics" },
];

const all = () => PARTNERS.map((p) => ({ ...p, logo: `/partners/${p.slug}.png` }));

module.exports = { all, PARTNERS };
