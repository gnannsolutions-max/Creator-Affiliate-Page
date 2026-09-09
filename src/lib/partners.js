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
 * width/height sind die echten Maße der Dateien. Sie stehen hier, damit der
 * Browser den Platz kennt, bevor das Bild da ist – sonst hat das Element vor
 * dem Laden die Größe null, und der Browser hält es für unsichtbar.
 *
 * Eine Marke hinzufügen: Logo nach public/partners/ legen und hier eine Zeile
 * ergänzen. Eine Marke entfernen: Zeile löschen. Die Reihenfolge hier ist die
 * Reihenfolge auf der Seite.
 */
const PARTNERS = [
  { slug: 'ag1', name: 'AG1', width: 380, height: 153 },
  { slug: 'thorne', name: 'Thorne', width: 380, height: 57 },
  { slug: 'ritual', name: 'Ritual', width: 380, height: 119 },
  { slug: 'momentous', name: 'Momentous', width: 380, height: 152 },
  { slug: 'transparent-labs', name: 'Transparent Labs', width: 380, height: 60 },
  { slug: 'optimum-nutrition', name: 'Optimum Nutrition', width: 378, height: 78 },
  { slug: 'seed', name: 'Seed', width: 380, height: 92 },
  { slug: 'lmnt', name: 'LMNT', width: 160, height: 160 },
  { slug: 'bloom-nutrition', name: 'Bloom Nutrition', width: 380, height: 111 },
  { slug: 'maryruth', name: 'MaryRuth Organics', width: 380, height: 102 },
];

const all = () => PARTNERS.map((p) => ({ ...p, logo: `/partners/${p.slug}.png` }));

module.exports = { all, PARTNERS };
