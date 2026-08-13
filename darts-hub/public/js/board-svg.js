/* Shared dartboard renderer used by both screens. */
(function (global) {
  'use strict';

  const ORDER = [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5];
  const R = { bullI: 4.0, bullO: 10.0, trebI: 61.5, trebO: 67.5, dblI: 94.0, dblO: 100.0, num: 111 };
  const NS = 'http://www.w3.org/2000/svg';

  function el(name, attrs) {
    const e = document.createElementNS(NS, name);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }
  function polar(r, deg) {
    const a = (deg - 90) * Math.PI / 180;
    return [r * Math.cos(a), r * Math.sin(a)];
  }
  function sector(r1, r2, a1, a2) {
    const [x1, y1] = polar(r2, a1), [x2, y2] = polar(r2, a2);
    const [x3, y3] = polar(r1, a2), [x4, y4] = polar(r1, a1);
    return `M ${x1} ${y1} A ${r2} ${r2} 0 0 1 ${x2} ${y2} L ${x3} ${y3} A ${r1} ${r1} 0 0 0 ${x4} ${y4} Z`;
  }

  /** Draw a board into an <svg>. opts: {numbers, interactive, onHit} */
  function render(svg, opts) {
    opts = opts || {};
    svg.setAttribute('viewBox', '-120 -120 240 240');
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    svg.appendChild(el('circle', { cx: 0, cy: 0, r: 118, class: 'db-surround' }));

    const hit = (score, multiplier) => {
      if (opts.onHit) opts.onHit({ score, multiplier });
    };

    ORDER.forEach((num, i) => {
      const a1 = i * 18 - 9, a2 = i * 18 + 9;
      const dark = i % 2 === 0;
      const bed = dark ? 'db-dark' : 'db-light';
      const ring = dark ? 'db-red' : 'db-green';
      const zones = [
        { r1: R.bullO, r2: R.trebI, cls: bed, mult: 1, id: `s${num}i` },
        { r1: R.trebI, r2: R.trebO, cls: ring, mult: 3, id: `t${num}` },
        { r1: R.trebO, r2: R.dblI, cls: bed, mult: 1, id: `s${num}o` },
        { r1: R.dblI, r2: R.dblO, cls: ring, mult: 2, id: `d${num}` },
      ];
      for (const z of zones) {
        const p = el('path', { d: sector(z.r1, z.r2, a1, a2), class: `db-bed ${z.cls}`, 'data-id': z.id });
        if (opts.interactive) {
          p.classList.add('db-tap');
          p.addEventListener('pointerdown', (e) => { e.preventDefault(); hit(num, z.mult); });
        }
        svg.appendChild(p);
      }
      if (opts.numbers !== false) {
        const [nx, ny] = polar(R.num, i * 18);
        const t = el('text', { x: nx, y: ny, class: 'db-num', 'text-anchor': 'middle', 'dominant-baseline': 'central' });
        t.textContent = num;
        svg.appendChild(t);
      }
    });

    const outer = el('circle', { cx: 0, cy: 0, r: R.bullO, class: 'db-bed db-green', 'data-id': 's25' });
    const inner = el('circle', { cx: 0, cy: 0, r: R.bullI, class: 'db-bed db-red', 'data-id': 'd25' });
    if (opts.interactive) {
      outer.classList.add('db-tap');
      inner.classList.add('db-tap');
      outer.addEventListener('pointerdown', (e) => { e.preventDefault(); hit(25, 1); });
      inner.addEventListener('pointerdown', (e) => { e.preventDefault(); hit(25, 2); });
    }
    svg.appendChild(outer);
    svg.appendChild(inner);
  }

  /** Flash the bed(s) a dart landed in. */
  function flash(svg, dart, className) {
    const ids = [];
    if (!dart || !dart.score) return;
    if (dart.score === 25) ids.push(dart.multiplier === 2 ? 'd25' : 's25');
    else if (dart.multiplier === 3) ids.push(`t${dart.score}`);
    else if (dart.multiplier === 2) ids.push(`d${dart.score}`);
    else ids.push(`s${dart.score}i`, `s${dart.score}o`);
    for (const id of ids) {
      const node = svg.querySelector(`[data-id="${id}"]`);
      if (!node) continue;
      node.classList.remove(className);
      void node.getBoundingClientRect();
      node.classList.add(className);
      setTimeout(() => node.classList.remove(className), 1600);
    }
  }

  function label(d) {
    if (!d || !d.score) return 'MISS';
    if (d.score === 25) return d.multiplier === 2 ? 'BULL' : '25';
    return (d.multiplier === 3 ? 'T' : d.multiplier === 2 ? 'D' : '') + d.score;
  }

  global.DartBoard = { render, flash, label, ORDER };
})(window);
