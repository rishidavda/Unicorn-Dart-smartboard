'use strict';
/*
 * Game engine. Every game is a small strategy object; matches are rebuilt by
 * replaying an immutable dart log, which makes undo and score corrections
 * exact rather than "best effort".
 */

const CRICKET_TARGETS = [20, 19, 18, 17, 16, 15, 25];

function val(d) { return d.score * d.multiplier; }

function label(d) {
  if (!d.score) return 'MISS';
  if (d.score === 25) return d.multiplier === 2 ? 'BULL' : '25';
  return (d.multiplier === 3 ? 'T' : d.multiplier === 2 ? 'D' : '') + d.score;
}

function visitTotal(darts) { return darts.reduce((s, d) => s + val(d), 0); }

/* ---------------------------------------------------------------- X01 ---- */

const x01 = {
  id: 'x01',
  label: 'X01',
  blurb: 'Race from 501 (or 301/701) to exactly zero.',
  category: 'classics',
  players: { min: 1, max: 8 },
  rules: 'Everyone starts on the same number and races to exactly zero. Each turn is three darts; '
    + 'what you score comes off your total. With "Double to finish" on (the pub standard), your last '
    + 'dart must land in a double - going below zero, landing on one, or hitting zero without a '
    + 'double is a bust and your turn is wiped. First to zero wins the leg.',
  variants: [
    { id: '501', label: '501', config: { startScore: 501 } },
    { id: '301', label: '301', config: { startScore: 301 } },
    { id: '701', label: '701', config: { startScore: 701 } },
    { id: '1001', label: '1001', config: { startScore: 1001 } },
  ],
  options: [
    { key: 'doubleOut', label: 'Double to finish', type: 'bool', default: true },
    { key: 'doubleIn', label: 'Double to start', type: 'bool', default: false },
    { key: 'legsToWin', label: 'Legs to win', type: 'number', default: 1, min: 1, max: 11 },
  ],
  defaults: { startScore: 501, doubleOut: true, doubleIn: false, legsToWin: 1 },

  init(roster, cfg) {
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name,
        score: cfg.startScore,
        opened: !cfg.doubleIn,
        legs: 0,
        darts: 0, scored: 0,
        bestVisit: 0, tons: 0, oneEighties: 0,
        lastVisit: null,
      })),
      turn: 0,
      visit: [],
      visitStart: cfg.startScore,
      legNumber: 1,
      legStarter: 0,
      finished: false,
      winner: null,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    if (s.visit.length === 0) s.visitStart = p.score;
    s.visit.push(dart);
    p.darts++;

    let v = val(dart);
    if (cfg.doubleIn && !p.opened) {
      if (dart.multiplier === 2) p.opened = true;
      else v = 0;
    }

    const after = p.score - v;
    const isDouble = dart.multiplier === 2;

    // Winning dart
    if (after === 0 && (!cfg.doubleOut || isDouble)) {
      p.score = 0;
      p.scored += v;
      ev.push({ type: 'checkout', player: p.name,
                from: s.visitStart, darts: s.visit.length });
      closeVisit(s, p, ev, true);
      winLeg(this, s, cfg, p, ev);
      return ev;
    }

    // Bust: below zero, left on 1 (can't double out), or hit zero without a double
    if (after < 0 || (cfg.doubleOut && (after === 1 || after === 0))) {
      const why = after < 0 ? 'too many' : after === 1 ? 'left on 1' : 'needs a double';
      ev.push({ type: 'bust', player: p.name, reason: why });
      p.score = s.visitStart;
      closeVisit(s, p, ev, false);
      nextTurn(s);
      return ev;
    }

    p.score = after;
    p.scored += v;
    if (s.visit.length === 3) {
      closeVisit(s, p, ev, false);
      nextTurn(s);
    }
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      const dartsLeft = 3 - s.visit.length;
      if (cfg.doubleIn && !act.opened) hint = 'Hit any double to get started';
      else if (cfg.doubleOut) {
        const route = checkoutRoute(act.score, dartsLeft) || fallbackRoute(act.score, dartsLeft);
        hint = route && route.length ? `${act.score} to win: ${route.join(' ')}`
          : act.score > 170 ? `${act.score} to go - pile on the big scores`
          : `${act.score} left - no finish with ${dartsLeft} dart${dartsLeft === 1 ? '' : 's'}, leave yourself a double`;
      } else hint = `${act.score} to go - first to exactly zero wins`;
    }
    return {
      kind: 'x01',
      hint,
      title: `${cfg.startScore}${cfg.legsToWin > 1 ? ` · first to ${cfg.legsToWin} legs` : ''}`,
      subtitle: cfg.doubleOut ? 'double to finish' : 'straight finish',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn,
        primary: p.score,
        legs: p.legs,
        chips: [
          { k: 'avg', label: '3-dart avg', value: p.darts ? (p.scored / p.darts * 3).toFixed(1) : '—' },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit },
          { k: 'best', label: 'best', value: p.bestVisit || '—' },
          { k: 'tons', label: '100+', value: p.tons },
          { k: '180s', label: '180s', value: p.oneEighties },
        ],
        checkout: cfg.doubleOut ? checkoutRoute(p.score, 3 - s.visit.length) : null,
        needsDouble: cfg.doubleIn && !p.opened,
      })),
    };
  },
};

function closeVisit(s, p, ev, won) {
  const total = visitTotal(s.visit);
  p.lastVisit = total;
  if (total > p.bestVisit) p.bestVisit = total;
  if (total >= 100) p.tons++;
  if (total === 180) {
    p.oneEighties++;
    ev.push({ type: 'oneeighty', player: p.name });
  } else if (!won && total >= 140) {
    ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
  } else if (!won && total >= 100) {
    ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });
  }
  s.visit = [];
}

function nextTurn(s) {
  s.turn = (s.turn + 1) % s.players.length;
  s.visit = [];
  s.visitStart = s.players[s.turn].score;
}

function winLeg(game, s, cfg, p, ev) {
  p.legs++;
  if (p.legs >= (cfg.legsToWin || 1)) {
    s.finished = true;
    s.winner = { id: p.id, name: p.name };
    ev.push({ type: 'matchwin', player: p.name });
    return;
  }
  ev.push({ type: 'legwin', player: p.name, legs: p.legs });
  s.legNumber++;
  s.legStarter = (s.legStarter + 1) % s.players.length;
  s.turn = s.legStarter;
  s.visit = [];
  for (const q of s.players) {
    q.score = cfg.startScore;
    q.opened = !cfg.doubleIn;
    q.lastVisit = null;
  }
  s.visitStart = cfg.startScore;
}

/* Classic checkout routes so the TV can show "you need: T20 T20 D12". */
const CHECKOUTS = {
  170: ['T20', 'T20', 'BULL'], 167: ['T20', 'T19', 'BULL'], 164: ['T20', 'T18', 'BULL'],
  161: ['T20', 'T17', 'BULL'], 160: ['T20', 'T20', 'D20'], 158: ['T20', 'T20', 'D19'],
  157: ['T20', 'T19', 'D20'], 156: ['T20', 'T20', 'D18'], 155: ['T20', 'T19', 'D19'],
  154: ['T20', 'T18', 'D20'], 153: ['T20', 'T19', 'D18'], 152: ['T20', 'T20', 'D16'],
  151: ['T20', 'T17', 'D20'], 150: ['T20', 'T18', 'D18'], 149: ['T20', 'T19', 'D16'],
  148: ['T20', 'T16', 'D20'], 147: ['T20', 'T17', 'D18'], 146: ['T20', 'T18', 'D16'],
  145: ['T20', 'T15', 'D20'], 144: ['T20', 'T20', 'D12'], 143: ['T20', 'T17', 'D16'],
  142: ['T20', 'T14', 'D20'], 141: ['T20', 'T19', 'D12'], 140: ['T20', 'T20', 'D10'],
  139: ['T20', 'T13', 'D20'], 138: ['T20', 'T18', 'D12'], 137: ['T20', 'T19', 'D10'],
  136: ['T20', 'T20', 'D8'], 135: ['T20', 'T17', 'D12'], 134: ['T20', 'T14', 'D16'],
  133: ['T20', 'T19', 'D8'], 132: ['T20', 'T16', 'D12'], 131: ['T20', 'T13', 'D16'],
  130: ['T20', 'T18', 'D8'], 129: ['T19', 'T16', 'D12'], 128: ['T18', 'T14', 'D16'],
  127: ['T20', 'T17', 'D8'], 126: ['T19', 'T19', 'D6'], 125: ['T20', 'T19', 'D4'],
  124: ['T20', 'T16', 'D8'], 123: ['T19', 'T16', 'D9'], 122: ['T18', 'T20', 'D4'],
  121: ['T20', 'T11', 'D14'], 120: ['T20', '20', 'D20'], 119: ['T19', 'T10', 'D16'],
  118: ['T20', '18', 'D20'], 117: ['T20', '17', 'D20'], 116: ['T20', '16', 'D20'],
  115: ['T20', '15', 'D20'], 114: ['T20', '14', 'D20'], 113: ['T20', '13', 'D20'],
  112: ['T20', '12', 'D20'], 111: ['T20', '11', 'D20'], 110: ['T20', '10', 'D20'],
  109: ['T20', '9', 'D20'], 108: ['T20', '16', 'D16'], 107: ['T19', '18', 'D16'],
  106: ['T20', '10', 'D18'], 105: ['T20', '13', 'D16'], 104: ['T18', '18', 'D16'],
  103: ['T19', '10', 'D18'], 102: ['T20', '10', 'D16'], 101: ['T17', '10', 'D20'],
  100: ['T20', 'D20'], 99: ['T19', '10', 'D16'], 98: ['T20', 'D19'], 97: ['T19', 'D20'],
  96: ['T20', 'D18'], 95: ['T19', 'D19'], 94: ['T18', 'D20'], 93: ['T19', 'D18'],
  92: ['T20', 'D16'], 91: ['T17', 'D20'], 90: ['T20', 'D15'], 89: ['T19', 'D16'],
  88: ['T20', 'D14'], 87: ['T17', 'D18'], 86: ['T18', 'D16'], 85: ['T15', 'D20'],
  84: ['T20', 'D12'], 83: ['T17', 'D16'], 82: ['BULL', 'D16'], 81: ['T19', 'D12'],
  80: ['T20', 'D10'], 79: ['T19', 'D11'], 78: ['T18', 'D12'], 77: ['T19', 'D10'],
  76: ['T20', 'D8'], 75: ['T17', 'D12'], 74: ['T14', 'D16'], 73: ['T19', 'D8'],
  72: ['T16', 'D12'], 71: ['T13', 'D16'], 70: ['T18', 'D8'], 69: ['T19', 'D6'],
  68: ['T20', 'D4'], 67: ['T17', 'D8'], 66: ['T10', 'D18'], 65: ['T19', 'D4'],
  64: ['T16', 'D8'], 63: ['T13', 'D12'], 62: ['T10', 'D16'], 61: ['T15', 'D8'],
  60: ['20', 'D20'], 59: ['19', 'D20'], 58: ['18', 'D20'], 57: ['17', 'D20'],
  56: ['16', 'D20'], 55: ['15', 'D20'], 54: ['14', 'D20'], 53: ['13', 'D20'],
  52: ['12', 'D20'], 51: ['11', 'D20'], 50: ['BULL'], 49: ['9', 'D20'], 48: ['16', 'D16'],
  47: ['15', 'D16'], 46: ['6', 'D20'], 45: ['13', 'D16'], 44: ['12', 'D16'],
  43: ['11', 'D16'], 42: ['10', 'D16'], 41: ['9', 'D16'], 40: ['D20'], 39: ['7', 'D16'],
  38: ['D19'], 37: ['5', 'D16'], 36: ['D18'], 35: ['3', 'D16'], 34: ['D17'],
  33: ['1', 'D16'], 32: ['D16'], 31: ['15', 'D8'], 30: ['D15'], 29: ['13', 'D8'],
  28: ['D14'], 27: ['11', 'D8'], 26: ['D13'], 25: ['9', 'D8'], 24: ['D12'],
  23: ['7', 'D8'], 22: ['D11'], 21: ['5', 'D8'], 20: ['D10'], 19: ['3', 'D8'],
  18: ['D9'], 17: ['1', 'D8'], 16: ['D8'], 15: ['7', 'D4'], 14: ['D7'], 13: ['5', 'D4'],
  12: ['D6'], 11: ['3', 'D4'], 10: ['D5'], 9: ['1', 'D4'], 8: ['D4'], 7: ['3', 'D2'],
  6: ['D3'], 5: ['1', 'D2'], 4: ['D2'], 3: ['1', 'D1'], 2: ['D1'],
};

/*
 * The CHECKOUTS table holds the pro 3-dart routes; with 1 or 2 darts in hand
 * some scores (101, 104, 107, 110...) still finish via treble-then-bull, and
 * the hint must never deny a finish the engine would happily award. This
 * brute-force finds a route that fits the darts actually left.
 */
function isDoubleValue(v) { return v === 50 || (v % 2 === 0 && v >= 2 && v <= 40); }
function fallbackRoute(score, darts) {
  if (darts < 1 || score < 2) return null;
  if (isDoubleValue(score)) return [score === 50 ? 'BULL' : 'D' + score / 2];
  if (darts < 2) return null;
  const firsts = [];
  for (let n = 20; n >= 1; n--) firsts.push({ v: 3 * n, l: 'T' + n });
  firsts.push({ v: 25, l: '25' });
  for (let n = 20; n >= 1; n--) firsts.push({ v: n, l: String(n) });
  for (const f of firsts) {
    if (f.v < score && isDoubleValue(score - f.v)) {
      return [f.l, score - f.v === 50 ? 'BULL' : 'D' + (score - f.v) / 2];
    }
  }
  if (darts < 3) return null;
  for (const f of firsts) {
    const rest = f.v < score ? fallbackRoute(score - f.v, 2) : null;
    if (rest) return [f.l, ...rest];
  }
  return null;
}

function checkoutRoute(score, dartsLeft) {
  const route = CHECKOUTS[score];
  if (!route) return null;
  if (dartsLeft > 0 && route.length > dartsLeft) return null;
  return route;
}

/* ------------------------------------------------------------ Cricket ---- */

const cricket = {
  id: 'cricket',
  label: 'Cricket',
  blurb: 'Close 15–20 and the bull. Three marks closes a number; extras score.',
  category: 'classics',
  players: { min: 1, max: 8 },
  rules: 'The targets are 15 to 20 and the bull. Three marks close a number (a single is one mark, '
    + 'a double two, a treble three). Hit a number you have closed while others have not, and you '
    + 'score its value. The winner closes everything first with at least as many points as anyone '
    + 'else. Cut-throat flips it: extra hits pile points ONTO everyone who has not closed - and the '
    + 'LOWEST score wins.',
  variants: [
    { id: 'standard', label: 'Standard', config: { cutThroat: false } },
    { id: 'cutthroat', label: 'Cut-throat', config: { cutThroat: true } },
  ],
  options: [
    { key: 'cutThroat', label: 'Cut-throat (points go to opponents)', type: 'bool', default: false },
  ],
  defaults: { cutThroat: false },

  init(roster) {
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name,
        marks: Object.fromEntries(CRICKET_TARGETS.map((t) => [t, 0])),
        points: 0, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;

    const t = dart.score;
    if (CRICKET_TARGETS.includes(t)) {
      const hits = t === 25 ? Math.min(dart.multiplier, 2) : dart.multiplier;
      const before = p.marks[t];
      const total = before + hits;
      p.marks[t] = Math.min(total, 3);
      const overflow = Math.max(total - 3, 0);

      if (before < 3 && p.marks[t] === 3) {
        ev.push({ type: 'closed', player: p.name, target: t === 25 ? 'BULL' : t });
      }
      if (overflow > 0) {
        const openElsewhere = s.players.some((q) => q !== p && q.marks[t] < 3);
        if (openElsewhere) {
          const pts = overflow * t;
          if (cfg.cutThroat) {
            for (const q of s.players) if (q !== p && q.marks[t] < 3) q.points += pts;
          } else {
            p.points += pts;
            ev.push({ type: 'cricketpoints', player: p.name, points: pts, target: t });
          }
        }
      }
    }

    if (allClosed(p) && bestOnPoints(s, p, cfg)) {
      s.finished = true;
      s.winner = { id: p.id, name: p.name };
      p.legs++;
      ev.push({ type: 'matchwin', player: p.name });
      return ev;
    }
    if (s.visit.length === 3) { s.visit = []; s.turn = (s.turn + 1) % s.players.length; }
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      const nm = (t) => (t === 25 ? 'bull' : t);
      const mine = CRICKET_TARGETS.filter((t) => act.marks[t] < 3);
      const scoreOn = CRICKET_TARGETS.filter((t) => act.marks[t] >= 3 && !s.players.every((q) => q.marks[t] >= 3));
      hint = !mine.length
        ? (cfg.cutThroat ? 'All closed - keep your points lowest to win' : 'All closed - stay ahead on points to win')
        : `Close ${mine.slice(0, 3).map(nm).join(', ')}${mine.length > 3 ? '\u2026' : ''} - three marks each`
          + (scoreOn.length ? `, or score on ${nm(scoreOn[0])}` : '');
    }
    return {
      kind: 'cricket',
      hint,
      title: cfg.cutThroat ? 'Cricket · cut-throat' : 'Cricket',
      subtitle: 'close 20 → 15 and the bull',
      targets: CRICKET_TARGETS.map((t) => (t === 25 ? 'BULL' : String(t))),
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn,
        primary: p.points,
        marks: CRICKET_TARGETS.map((t) => ({
          target: t === 25 ? 'BULL' : String(t),
          count: p.marks[t],
          dead: s.players.every((q) => q.marks[t] >= 3),
        })),
        chips: [{ k: 'darts', label: 'darts', value: p.darts }],
      })),
    };
  },
};

function allClosed(p) { return CRICKET_TARGETS.every((t) => p.marks[t] >= 3); }
function bestOnPoints(s, p, cfg) {
  const others = s.players.filter((q) => q !== p);
  return cfg.cutThroat ? others.every((q) => p.points <= q.points)
                       : others.every((q) => p.points >= q.points);
}

/* ------------------------------------------------- Around the Clock ---- */

const atc = {
  id: 'atc',
  label: 'Around the Clock',
  blurb: 'Hit 1 to 20 in order, then the bull. Doubles and triples variants for the brave.',
  category: 'classics',
  players: { min: 1, max: 8 },
  rules: 'Hit 1, then 2, then 3 - all the way to 20, then finish on the bull. Any dart in the right '
    + 'number moves you on; first to the bull wins. Doubles only and Triples only variants demand '
    + 'that exact ring (the finishing bull is any bull). "Jump ahead": a double moves you on two '
    + 'numbers, a treble three.',
  variants: [
    { id: 'singles', label: 'Any hit counts', config: { fast: false, mode: 'any' } },
    { id: 'fast', label: 'Doubles/trebles jump ahead', config: { fast: true, mode: 'any' } },
    { id: 'doubles', label: 'Doubles only', config: { fast: false, mode: 'doubles' } },
    { id: 'triples', label: 'Triples only', config: { fast: false, mode: 'triples' } },
  ],
  options: [
    { key: 'fast', label: 'Doubles and trebles advance further', type: 'bool', default: false },
  ],
  defaults: { fast: false, mode: 'any' },

  init(roster) {
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, target: 1, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;

    const needBull = p.target > 20;
    // Doubles/triples only: nothing short of that ring moves you on - except
    // the bull at the end, where any bull counts.
    const ringOk = cfg.mode === 'triples' ? dart.multiplier === 3
      : cfg.mode === 'doubles' ? dart.multiplier === 2
      : true;
    const hit = needBull ? dart.score === 25 : dart.score === p.target && ringOk;
    if (hit) {
      const step = (cfg.fast && cfg.mode === 'any') ? Math.max(dart.multiplier, 1) : 1;
      p.target += needBull ? 1 : step;
      ev.push({ type: 'advance', player: p.name, target: p.target > 20 ? 'BULL' : p.target });
      if (needBull) {
        s.finished = true;
        s.winner = { id: p.id, name: p.name };
        p.legs++;
        ev.push({ type: 'matchwin', player: p.name });
        return ev;
      }
    }
    if (s.visit.length === 3) { s.visit = []; s.turn = (s.turn + 1) % s.players.length; }
    return ev;
  },

  view(s, cfg) {
    const mode = (cfg && cfg.mode) || 'any';
    const suffix = mode === 'triples' ? ' · Triples' : mode === 'doubles' ? ' · Doubles' : '';
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      hint = act.target > 20 ? 'Any bull wins it!'
        : cfg.mode === 'triples' ? `Hit treble ${act.target} - nothing else moves you on`
        : cfg.mode === 'doubles' ? `Hit double ${act.target} - nothing else moves you on`
        : cfg.fast ? `Hit ${act.target} - a double jumps 2 numbers, a treble 3`
        : `Hit ${act.target} - any bed of it counts`;
    }
    return {
      kind: 'atc',
      hint,
      title: 'Around the Clock' + suffix,
      subtitle: mode === 'triples' ? 'treble 1 → treble 20, then bull'
        : mode === 'doubles' ? 'double 1 → double 20, then bull'
        : 'hit 1 → 20, then bull',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn,
        primary: p.target > 20 ? 'BULL' : p.target,
        primaryLabel: 'needs',
        progress: Math.min((p.target - 1) / 21, 1),
        chips: [{ k: 'darts', label: 'darts', value: p.darts }],
      })),
    };
  },
};

/* --------------------------------------------------------- Count-up ---- */

const countup = {
  id: 'countup',
  label: 'Count-up',
  blurb: 'Highest score after a set number of rounds. Pure fun, no bust.',
  category: 'races',
  players: { min: 1, max: 8 },
  rules: 'Everyone throws the same number of three-dart rounds and simply adds everything up - no '
    + 'busts, no doubles needed. Highest total when the rounds run out wins. The friendliest game '
    + 'on the board.',
  variants: [
    { id: 'r8', label: '8 rounds', config: { rounds: 8 } },
    { id: 'r5', label: '5 rounds', config: { rounds: 5 } },
  ],
  options: [
    { key: 'rounds', label: 'Rounds', type: 'number', default: 8, min: 3, max: 20 },
  ],
  defaults: { rounds: 8 },

  init(roster, cfg) {
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, round: 1, darts: 0,
        bestVisit: 0, lastVisit: null, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null,
      rounds: cfg.rounds, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    p.score += val(dart);

    if (s.visit.length === 3) {
      const total = visitTotal(s.visit);
      p.lastVisit = total;
      if (total > p.bestVisit) p.bestVisit = total;
      if (total === 180) ev.push({ type: 'oneeighty', player: p.name });
      else if (total >= 140) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
      else if (total >= 100) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });

      p.round++;
      if (p.round > cfg.rounds) p.done = true;
      s.visit = [];
      s.turn = (s.turn + 1) % s.players.length;

      if (s.players.every((q) => q.done)) {
        const best = s.players.reduce((a, b) => (b.score > a.score ? b : a));
        s.finished = true;
        s.winner = { id: best.id, name: best.name };
        best.legs++;
        ev.push({ type: 'matchwin', player: best.name });
      }
    }
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act ? null
      : `Round ${Math.min(act.round, cfg.rounds)} of ${cfg.rounds} - throw big, there are no busts`;
    return {
      kind: 'countup',
      hint,
      title: `Count-up · ${cfg.rounds} rounds`,
      subtitle: 'highest total wins',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn,
        primary: p.score,
        chips: [
          { k: 'round', label: 'round', value: `${Math.min(p.round, cfg.rounds)}/${cfg.rounds}` },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit },
          { k: 'best', label: 'best', value: p.bestVisit || '—' },
        ],
      })),
    };
  },
};

/* ------------------------------------------------------------- Killer ---- */

/*
 * Everyone owns a number. Hit your own double to become a killer; killers who
 * hit another player's double take one of their lives. A killer who hits their
 * own double again takes their own life - the classic vindictive rule, and it
 * keeps the endgame honest. Last one standing wins.
 *
 * Numbers are assigned deterministically by seat, spread around the board -
 * assignment must survive a replay (undo rebuilds the match from the log), so
 * nothing here may involve chance.
 */
const KILLER_NUMBERS = [16, 8, 4, 12, 18, 6, 10, 14, 2, 20, 5, 15, 9, 11, 3, 17, 7, 19, 1, 13];

const killer = {
  id: 'killer',
  label: 'Killer',
  blurb: 'Hit your own double to arm up, then hunt everyone else\'s. Last life standing wins.',
  category: 'party',
  players: { min: 2, max: 8 },
  rules: 'Everyone is given a number and some lives. Hit your OWN double to become a killer. Killers '
    + 'take a life off an opponent every time they hit that player\'s double - and lose one of their '
    + 'own if they clip their own double again. Run out of lives and you are out; last one standing '
    + 'wins.',
  variants: [{ id: 'standard', label: 'Standard', config: {} }],
  options: [
    { key: 'lives', label: 'Lives each', type: 'number', default: 3, min: 1, max: 6 },
  ],
  defaults: { lives: 3 },

  init(roster, cfg) {
    return {
      players: roster.map((p, i) => ({
        id: p.id, name: p.name,
        number: KILLER_NUMBERS[i % KILLER_NUMBERS.length],
        lives: cfg.lives, killer: false, kills: 0, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  _advance(s) {
    if (s.finished) return;
    let hops = 0;
    do {
      s.turn = (s.turn + 1) % s.players.length;
    } while (s.players[s.turn].lives <= 0 && ++hops <= s.players.length);
  },

  _checkWin(s, ev) {
    const alive = s.players.filter((q) => q.lives > 0);
    if (alive.length === 1 && s.players.length > 1) {
      s.finished = true;
      s.winner = { id: alive[0].id, name: alive[0].name };
      ev.push({ type: 'matchwin', player: alive[0].name });
    }
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;

    if (dart.multiplier === 2) {
      if (dart.score === p.number && !p.killer) {
        p.killer = true;
        ev.push({ type: 'killer', player: p.name, number: p.number });
      } else if (p.killer && dart.score === p.number) {
        p.lives--;
        ev.push({ type: 'lifelost', player: p.name, victim: p.name, left: p.lives, own: true });
        if (p.lives === 0) ev.push({ type: 'eliminated', player: p.name });
      } else if (p.killer) {
        const victim = s.players.find((q) => q !== p && q.lives > 0 && q.number === dart.score);
        if (victim) {
          victim.lives--;
          p.kills++;
          ev.push({ type: 'lifelost', player: p.name, victim: victim.name, left: victim.lives });
          if (victim.lives === 0) ev.push({ type: 'eliminated', player: victim.name });
        }
      }
    }

    this._checkWin(s, ev);
    if (s.finished) { s.visit = []; return ev; }
    // Took your own last life: the visit dies with you.
    if (p.lives <= 0 || s.visit.length === 3) { s.visit = []; this._advance(s); }
    return ev;
  },

  endVisit(s) {
    s.visit = [];
    this._advance(s);
    return [];
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act && act.lives > 0) {
      if (!act.killer) hint = `Hit your own double - D${act.number} - to become a killer`;
      else {
        const prey = s.players.filter((q) => q.id !== act.id && q.lives > 0).map((q) => `D${q.number}`);
        hint = prey.length ? `You're a killer - hit ${prey.join(', ')} to take lives` : 'Last one standing!';
      }
    }
    return {
      kind: 'killer',
      hint,
      title: 'Killer',
      subtitle: 'double up, then take lives',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished && p.lives > 0,
        primary: p.lives > 0 ? '♥'.repeat(p.lives) : 'OUT',
        primaryLabel: 'lives',
        chips: [
          { k: 'no', label: 'your double', value: `D${p.number}` },
          { k: 'st', label: 'status', value: p.lives <= 0 ? 'out' : p.killer ? 'KILLER' : 'not armed' },
          { k: 'kills', label: 'lives taken', value: p.kills },
        ],
      })),
    };
  },
};

/* ----------------------------------------------------------- Shanghai ---- */

const shanghai = {
  id: 'shanghai',
  label: 'Shanghai',
  blurb: 'Round 1 scores on 1s, round 2 on 2s... single, double AND treble in one visit wins instantly.',
  category: 'party',
  players: { min: 1, max: 8 },
  rules: 'Round one only the 1s score, round two only the 2s, and so on. Singles, doubles and '
    + 'trebles of the round number all count. Hit the single, double AND treble of the number in '
    + 'one three-dart visit and that is SHANGHAI - you win on the spot. Otherwise, highest total '
    + 'when the rounds run out.',
  variants: [
    { id: 'r7', label: 'Rounds 1–7', config: { rounds: 7 } },
    { id: 'r10', label: 'Rounds 1–10', config: { rounds: 10 } },
  ],
  options: [
    { key: 'rounds', label: 'Rounds', type: 'number', default: 7, min: 5, max: 20 },
  ],
  defaults: { rounds: 7 },

  init(roster, cfg) {
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, round: 1, darts: 0,
        lastVisit: null, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  _finishVisit(s, cfg, ev) {
    const p = s.players[s.turn];
    const t = p.round;
    const mults = new Set(s.visit.filter((d) => d.score === t).map((d) => d.multiplier));
    p.lastVisit = s.visit.filter((d) => d.score === t).reduce((a, d) => a + t * d.multiplier, 0);
    if (mults.has(1) && mults.has(2) && mults.has(3)) {
      s.finished = true;
      s.winner = { id: p.id, name: p.name };
      ev.push({ type: 'shanghai', player: p.name, target: t });
      ev.push({ type: 'matchwin', player: p.name });
      s.visit = [];
      return;
    }
    p.round++;
    if (p.round > cfg.rounds) p.done = true;
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    if (s.players.every((q) => q.done)) {
      const best = s.players.reduce((a, b) => (b.score > a.score ? b : a));
      s.finished = true;
      s.winner = { id: best.id, name: best.name };
      ev.push({ type: 'matchwin', player: best.name });
    }
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    if (dart.score === p.round) p.score += p.round * dart.multiplier;
    if (s.visit.length === 3) this._finishVisit(s, cfg, ev);
    return ev;
  },

  endVisit(s, cfg) {
    const ev = [];
    this._finishVisit(s, cfg, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act && !act.done) {
      const r = Math.min(act.round, cfg.rounds);
      hint = `Only ${r}s score this round - single + double + treble is SHANGHAI, instant win`;
    }
    return {
      kind: 'shanghai',
      hint,
      title: `Shanghai · rounds 1–${cfg.rounds}`,
      subtitle: 'single + double + treble = instant win',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.score,
        chips: [
          { k: 'aim', label: 'aim for', value: p.done ? '—' : Math.min(p.round, cfg.rounds) },
          { k: 'round', label: 'round', value: `${Math.min(p.round, cfg.rounds)}/${cfg.rounds}` },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit },
        ],
      })),
    };
  },
};

/* ----------------------------------------------------------- Halve It ---- */

/*
 * A target per round. Score whatever you land on the target; miss it with all
 * three darts and your total is cut in half (rounded up - the kind version).
 */
const HALVEIT_SETS = {
  classic: ['20', '16', 'D7', '14', 'T10', '13', 'BULL'],
  numbers: ['20', '19', '18', '17', '16', '15', 'BULL'],
};

function halveTarget(token, dart) {
  if (token === 'BULL') return dart.score === 25 ? 25 * dart.multiplier : 0;
  const m = /^([DT]?)(\d+)$/.exec(token);
  const want = Number(m[2]);
  const mult = m[1] === 'D' ? 2 : m[1] === 'T' ? 3 : null;
  if (dart.score !== want) return 0;
  if (mult !== null && dart.multiplier !== mult) return 0;
  return want * dart.multiplier;
}

const halveit = {
  id: 'halveit',
  label: 'Halve It',
  blurb: 'A new target every round. Miss it with all three darts and your score is halved.',
  category: 'party',
  players: { min: 1, max: 8 },
  rules: 'Each round has a target - 20s, then 16s, then double 7, and so on. Only darts in the '
    + 'target count, and they add to your score. Miss the target with all three darts and your '
    + 'score is CUT IN HALF (rounded up). Highest score after the last target wins. Nerve required.',
  variants: [
    { id: 'classic', label: 'Classic (20 16 D7 14 T10 13 Bull)', config: { set: 'classic' } },
    { id: 'numbers', label: 'Big numbers (20…15, Bull)', config: { set: 'numbers' } },
  ],
  options: [],
  defaults: { set: 'classic' },

  init(roster, cfg) {
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, round: 1, darts: 0,
        lastVisit: null, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  _finishVisit(s, cfg, ev) {
    const targets = HALVEIT_SETS[cfg.set] || HALVEIT_SETS.classic;
    const p = s.players[s.turn];
    const token = targets[p.round - 1];
    const gained = s.visit.reduce((a, d) => a + halveTarget(token, d), 0);
    if (gained > 0) {
      p.score += gained;
      p.lastVisit = gained;
    } else {
      p.score = Math.ceil(p.score / 2);
      p.lastVisit = 0;
      ev.push({ type: 'halved', player: p.name, score: p.score, target: token });
    }
    p.round++;
    if (p.round > targets.length) p.done = true;
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    if (s.players.every((q) => q.done)) {
      const best = s.players.reduce((a, b) => (b.score > a.score ? b : a));
      s.finished = true;
      s.winner = { id: best.id, name: best.name };
      ev.push({ type: 'matchwin', player: best.name });
    }
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    if (s.visit.length === 3) this._finishVisit(s, cfg, ev);
    return ev;
  },

  endVisit(s, cfg) {
    const ev = [];
    this._finishVisit(s, cfg, ev);
    return ev;
  },

  view(s, cfg) {
    const targets = HALVEIT_SETS[cfg.set] || HALVEIT_SETS.classic;
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act && !act.done) {
      const t = targets[act.round - 1];
      const say = t === 'BULL' ? 'the bull' : t === 'D7' ? 'double 7' : t === 'T10' ? 'treble 10' : `the ${t}s`;
      hint = `Hit ${say} - miss with all three darts and your score halves`;
    }
    return {
      kind: 'halveit',
      hint,
      title: `Halve It · ${targets.join(' → ')}`,
      subtitle: 'miss the target three times and your score halves',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.score,
        chips: [
          { k: 'aim', label: 'aim for', value: p.done ? '—' : targets[p.round - 1] },
          { k: 'round', label: 'round', value: `${Math.min(p.round, targets.length)}/${targets.length}` },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit === 0 ? 'HALVED' : p.lastVisit },
        ],
      })),
    };
  },
};

const helpers = { val, label, visitTotal };
const extra = require('./games-extra')(helpers);
const GAMES = { x01, cricket, atc, countup, killer, shanghai, halveit, ...extra };

/* ------------------------------------------------------------- Match ---- */

class Match {
  constructor({ gameId, variantId, config, players }) {
    const game = GAMES[gameId];
    if (!game) throw new Error(`unknown game: ${gameId}`);
    const variant = (game.variants || []).find((v) => v.id === variantId);
    this.gameId = gameId;
    this.variantId = variantId || (game.variants && game.variants[0] && game.variants[0].id);
    this.config = { ...game.defaults, ...(variant ? variant.config : {}), ...(config || {}) };
    this.roster = players.map((p, i) => ({ id: p.id || `p${i + 1}`, name: p.name || `Player ${i + 1}` }));
    this.startedAt = new Date().toISOString();
    this.log = [];
    this.rebuild();
  }

  get game() { return GAMES[this.gameId]; }

  rebuild() {
    this.state = this.game.init(this.roster, this.config);
    for (const entry of this.log) this._apply(entry);
  }

  _apply(entry) {
    const s = this.state;
    if (s.finished) return [];
    if (entry.k === 'd') {
      const dart = { score: entry.s, multiplier: entry.m };
      const prior = s.visit.slice();
      const ev = this.game.applyDart(s, this.config, dart) || [];
      // A visit that just ended stays on the screens until the next dart lands
      if (s.visit.length === 0) s.lastVisitDarts = prior.concat([dart]);
      return ev;
    }
    if (entry.k === 't') {           // end visit early (board button / pad)
      const thrown = s.visit.slice();
      let ev = [];
      if (this.game.endVisit) {
        // Games with per-round bookkeeping close the round properly - Halve It
        // must still halve you if you pass, Killer must skip the dead.
        ev = this.game.endVisit(s, this.config) || [];
      } else {
        if (this.game.id === 'x01' && s.visit.length) {
          closeVisit(s, s.players[s.turn], ev, false);
        }
        s.visit = [];
        s.turn = (s.turn + 1) % s.players.length;
        if (s.players[s.turn]) s.visitStart = s.players[s.turn].score;
      }
      // An empty visit is a deliberate pass (walked up, threw nothing) - show
      // that on the screens as a 0 rather than leaving the previous summary up.
      s.lastVisitDarts = thrown;
      return ev;
    }
    if (entry.k === 'adj') {         // manual score correction
      const p = s.players.find((q) => q.id === entry.id);
      if (p) {
        if ('score' in p) p.score = entry.v;
        else if ('points' in p) p.points = entry.v;
        else if ('lives' in p) p.lives = Math.max(0, entry.v);
      }
      return [];
    }
    return [];
  }

  addDart(dart) {
    const entry = { k: 'd', s: dart.score, m: dart.multiplier };
    this.log.push(entry);
    return this._apply(entry);
  }

  endTurn() { const e = { k: 't' }; this.log.push(e); return this._apply(e); }

  adjust(playerId, value) {
    const e = { k: 'adj', id: playerId, v: value };
    this.log.push(e);
    return this._apply(e);
  }

  undo() {
    if (!this.log.length) return false;
    this.log.pop();
    this.rebuild();
    return true;
  }

  restart() { this.log = []; this.rebuild(); }

  view() {
    const v = this.game.view(this.state, this.config);
    return {
      ...v,
      gameId: this.gameId,
      variantId: this.variantId,
      config: this.config,
      finished: this.state.finished,
      winner: this.state.winner,
      legNumber: this.state.legNumber || 1,
      turnPlayerId: this.state.players[this.state.turn] && this.state.players[this.state.turn].id,
      visit: this.state.visit.map((d) => ({ ...d, label: label(d) })),
      visitTotal: visitTotal(this.state.visit),
      lastVisit: (this.state.lastVisitDarts || []).map((d) => ({ ...d, label: label(d) })),
      lastVisitTotal: visitTotal(this.state.lastVisitDarts || []),
      dartsInLog: this.log.filter((e) => e.k === 'd').length,
      canUndo: this.log.length > 0,
    };
  }

  toJSON() {
    return {
      gameId: this.gameId, variantId: this.variantId, config: this.config,
      players: this.roster, log: this.log, startedAt: this.startedAt,
    };
  }

  static fromJSON(data) {
    const m = new Match({
      gameId: data.gameId, variantId: data.variantId,
      config: data.config, players: data.players,
    });
    m.log = data.log || [];
    m.startedAt = data.startedAt || m.startedAt;
    m.rebuild();
    return m;
  }
}

function catalogue() {
  return Object.values(GAMES).map((g) => ({
    id: g.id, label: g.label, blurb: g.blurb,
    category: g.category || 'party',
    rules: g.rules || g.blurb,
    players: g.players || { min: 1, max: 8 },
    variants: g.variants || [], options: g.options || [], defaults: g.defaults,
  }));
}

module.exports = { Match, GAMES, catalogue, label, val, CRICKET_TARGETS };
