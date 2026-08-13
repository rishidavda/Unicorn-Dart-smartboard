/* Venue branding: crest + wordmark, drawn from the hub's settings.
 * Drop a file at /brand/logo.png (or .svg) to replace the crest entirely. */
(function (global) {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';

  /** The house crest: a dartboard roundel with crossed darts and a monogram. */
  function crestSvg(initial) {
    return `
<svg viewBox="0 0 120 120" role="img" aria-label="venue crest" class="crest-svg">
  <circle cx="60" cy="60" r="57" class="c-rim"/>
  <circle cx="60" cy="60" r="52" class="c-face"/>
  <g class="c-ring">
    ${[...Array(20)].map((_, i) => {
      const a1 = (i * 18 - 9) * Math.PI / 180, a2 = (i * 18 + 9) * Math.PI / 180;
      const r1 = 40, r2 = 52;
      const p = (r, a) => `${(60 + r * Math.sin(a)).toFixed(2)} ${(60 - r * Math.cos(a)).toFixed(2)}`;
      return i % 2 === 0
        ? `<path d="M ${p(r2, a1)} A ${r2} ${r2} 0 0 1 ${p(r2, a2)} L ${p(r1, a2)} A ${r1} ${r1} 0 0 0 ${p(r1, a1)} Z"/>`
        : '';
    }).join('')}
  </g>
  <circle cx="60" cy="60" r="39" class="c-inner"/>
  <!-- crossed darts -->
  <g class="c-dart">
    <path d="M34 86 L74 40 L79 44 L39 90 Z"/>
    <path d="M28 92 L38 84 L42 88 L34 98 Z" class="c-flight"/>
    <path d="M86 86 L46 40 L41 44 L81 90 Z"/>
    <path d="M92 92 L82 84 L78 88 L86 98 Z" class="c-flight"/>
  </g>
  <circle cx="60" cy="60" r="15" class="c-bull"/>
  <text x="60" y="61" class="c-mono" text-anchor="middle" dominant-baseline="central">${initial}</text>
</svg>`;
  }

  /**
   * Render the lockup into a container.
   * opts: { name, tagline, size: 'sm'|'md'|'lg'|'xl', stacked: bool, logoUrl }
   */
  function render(el, opts) {
    if (!el) return;
    opts = opts || {};
    const name = (opts.name || 'The Winchester').trim();
    const tagline = opts.tagline === undefined ? 'Darts' : opts.tagline;
    const initial = (name.replace(/^the\s+/i, '')[0] || 'W').toUpperCase();

    const mark = opts.logoUrl
      ? `<img class="crest-img" src="${opts.logoUrl}" alt="">`
      : crestSvg(initial);

    el.className = 'brand ' + (opts.size || 'md')
      + (opts.stacked ? ' stacked' : '')
      + (opts.logoUrl && opts.logoWide ? ' wordmark' : '');
    el.innerHTML =
      `<span class="brand-mark">${mark}</span>` +
      `<span class="brand-words">` +
        `<span class="brand-name">${escapeHtml(name)}</span>` +
        (tagline ? `<span class="brand-tag">${escapeHtml(tagline)}</span>` : '') +
        (opts.location ? `<span class="brand-place">${escapeHtml(opts.location)}</span>` : '') +
      `</span>`;
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** Apply the colour theme to the document. */
  function applyTheme(theme) {
    document.documentElement.setAttribute('data-brand', theme || 'green');
  }

  /** Set the browser tab title as "<venue> · <page>". */
  function title(name, page) {
    document.title = `${name || 'The Winchester'} · ${page}`;
  }

  global.Brand = { render, applyTheme, title, crestSvg };
})(window);
