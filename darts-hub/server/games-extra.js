'use strict';
/*
 * The extended game library - every game beyond the core eight. Same engine
 * contract as server/games.js (which merges this in): deterministic state,
 * replay-safe, each game runs its own turn logic. Drafted per-game, tested
 * against the real engine, and adversarially reviewed before landing here.
 */
module.exports = (helpers) => {
  const { val, label, visitTotal } = helpers;

const highscore = {
  id: 'highscore',
  label: 'High Score',
  blurb: 'Race your running total to the target. Every dart counts, no busts.',
  category: 'races',
  players: { min: 1, max: 8 },
  rules: 'Race your running total to the target. Each turn you throw three darts and every '
    + 'point counts - no busts, no doubles, nothing to close. Singles, doubles, trebles and '
    + 'the bull all simply add up. The moment your total reaches or passes the target you '
    + 'win, even part-way through a visit - later players get no reply. Pressing next player '
    + 'early scores your remaining darts as misses. Play to 500, 750 or 1000; 750 is the '
    + 'classic race.',
  variants: [
    { id: 't750', label: '750 up', config: { target: 750 } },
    { id: 't500', label: '500 up', config: { target: 500 } },
    { id: 't1000', label: '1000 up', config: { target: 1000 } },
  ],
  options: [
    { key: 'target', label: 'Target', type: 'number', default: 750, min: 100, max: 2000 },
  ],
  defaults: { target: 750 },

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error('High Score needs 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, darts: 0, lastVisit: null, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    p.score += val(dart);

    // Reach or pass the target and it's over on the spot, mid-visit included.
    if (p.score >= cfg.target) {
      const total = visitTotal(s.visit);
      p.lastVisit = total;
      s.visit = [];
      s.finished = true;
      s.winner = { id: p.id, name: p.name };
      p.legs = (p.legs || 0) + 1;
      // A 180 is celebrated even when it wins the match (same as x01's
      // closeVisit on a winning visit); bigscore stays quiet on game shot.
      if (total === 180) ev.push({ type: 'oneeighty', player: p.name });
      ev.push({ type: 'matchwin', player: p.name });
      return ev;
    }
    if (s.visit.length === 3) {
      const total = visitTotal(s.visit);
      p.lastVisit = total;
      if (total === 180) ev.push({ type: 'oneeighty', player: p.name });
      else if (total >= 140) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
      else if (total >= 100) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });
      s.visit = [];
      s.turn = (s.turn + 1) % s.players.length;
    }
    return ev;
  },

  // Rim button: unthrown darts are misses, so the visit closes on what landed.
  endVisit(s, cfg) {
    if (s.finished) return [];
    const ev = [];
    const p = s.players[s.turn];
    const total = visitTotal(s.visit);
    p.lastVisit = total;
    if (total >= 140) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
    else if (total >= 100) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act ? null
      : `${Math.max(cfg.target - act.score, 0)} to go - reach ${cfg.target} and it's over on the spot`;
    return {
      kind: 'highscore',
      hint,
      title: `High Score · ${cfg.target} up`,
      subtitle: 'first to reach or pass the target wins',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: !s.finished && i === s.turn,
        primary: p.score,
        progress: Math.min(p.score / cfg.target, 1),
        chips: [
          { k: 'togo', label: 'to go', value: Math.max(cfg.target - p.score, 0) },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit },
        ],
      })),
    };
  },
};

const ninedart = {
  id: 'ninedart',
  label: '9-Dart Challenge',
  blurb: 'Nine darts each, count everything - highest total takes it.',
  category: 'races',
  players: { min: 1, max: 8 },
  rules: 'Everyone throws exactly nine darts - three visits of three - and every dart counts at '
    + 'face value: no busts, no doubles required. When all nine darts are down, the highest total '
    + 'wins. Ties are settled by the highest single visit, and if that is level too the earlier '
    + 'seat in the throwing order takes it. Passing or ending a visit early counts the untaken '
    + 'darts as misses. Big visits get their due: 100-plus and 140-plus are celebrated, and a 180 '
    + 'brings the house down.',
  variants: [
    { id: 'std', label: 'Nine darts', config: {} },
  ],
  options: [],
  defaults: {},

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error('9-Dart Challenge takes 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, round: 1, darts: 0,
        bestVisit: 0, lastVisit: null, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  _finishVisit(s, ev) {
    const p = s.players[s.turn];
    const total = visitTotal(s.visit);
    p.lastVisit = total;
    if (total > p.bestVisit) p.bestVisit = total;
    if (total === 180) ev.push({ type: 'oneeighty', player: p.name });
    else if (total >= 140) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
    else if (total >= 100) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });

    p.round++;
    if (p.round > 3) p.done = true;
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;

    if (s.players.every((q) => q.done)) {
      // Highest total; ties go to the best single visit, then the earlier seat.
      const best = s.players.reduce((a, b) => (
        b.score > a.score || (b.score === a.score && b.bestVisit > a.bestVisit) ? b : a));
      s.finished = true;
      s.winner = { id: best.id, name: best.name };
      best.legs = (best.legs || 0) + 1;
      ev.push({ type: 'matchwin', player: best.name });
    }
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    p.score += val(dart);
    if (s.visit.length === 3) this._finishVisit(s, ev);
    return ev;
  },

  endVisit(s, cfg) {
    const ev = [];
    const p = s.players[s.turn];
    // Untaken darts are thrown misses - an empty visit is a pass of three.
    while (s.visit.length < 3) { s.visit.push({ score: 0, multiplier: 1 }); p.darts++; }
    this._finishVisit(s, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act ? null
      : `${9 - act.darts} dart${9 - act.darts === 1 ? '' : 's'} left - every point counts, highest total wins`;
    return {
      kind: 'ninedart',
      hint,
      title: '9-Dart Challenge',
      subtitle: 'nine darts each · highest total wins',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.score,
        progress: Math.min(p.darts / 9, 1),
        chips: [
          { k: 'darts', label: 'darts', value: `${p.darts}/9` },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit },
          { k: 'best', label: 'best', value: p.bestVisit || '—' },
        ],
      })),
    };
  },
};

const baseball = {
  id: 'baseball',
  label: 'Baseball',
  blurb: 'Nine innings of runs on the inning number - a treble is a home run.',
  category: 'party',
  players: { min: 1, max: 8 },
  rules: 'Nine innings. In inning 1 everyone throws three darts at the 1, in inning 2 at the 2, '
    + 'and so on up to the 9. Each dart in the inning\'s number scores runs equal to its ring: a '
    + 'single is 1 run, a double 2, and a treble 3 - a home run. Everything else, bull included, '
    + 'scores nothing. Highest run total after nine innings wins. If the leaders are tied, extra '
    + 'innings continue on 10, 11, up to 20; if it is still level after 20, the tied player '
    + 'earliest in the throwing order wins - batting first, they reached the score first.',
  variants: [
    { id: 'standard', label: '9 innings', config: {} },
  ],
  options: [],
  defaults: {},

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error('Baseball needs 1-8 players');
    return {
      players: roster.map((p) => ({
        // The run total lives in `score` so the engine's manual-correction path
        // ('adj' log entries / the pad's Set button) can write it; the view
        // labels it "runs".
        id: p.id, name: p.name, score: 0, lastInning: null, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, inning: 1, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    // Targets run 1..20, so the bull can never score.
    if (dart.score === s.inning) {
      p.score += dart.multiplier;
      if (dart.multiplier === 3) ev.push({ type: 'homerun', player: p.name });
    }
    if (s.visit.length === 3) this._closeVisit(s, ev);
    return ev;
  },

  // Remaining darts are misses; an empty visit is a deliberate pass.
  endVisit(s, cfg) {
    const ev = [];
    if (s.finished) return ev;
    this._closeVisit(s, ev);
    return ev;
  },

  _closeVisit(s, ev) {
    const p = s.players[s.turn];
    p.lastInning = s.visit.reduce((n, d) => n + (d.score === s.inning ? d.multiplier : 0), 0);
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    if (s.turn !== 0) return;
    if (s.inning < 9) { s.inning++; return; }
    const top = Math.max(...s.players.map((q) => q.score));
    const leaders = s.players.filter((q) => q.score === top);
    if (leaders.length > 1 && s.inning < 20) { s.inning++; return; } // extra innings, 10..20
    // Batting first, the earliest-seated leader reached the score first.
    const w = leaders[0];
    s.finished = true;
    s.winner = { id: w.id, name: w.name };
    w.legs = (w.legs || 0) + 1;
    ev.push({ type: 'matchwin', player: w.name });
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act ? null
      : `Score on the ${s.inning}s - single 1 run, double 2, treble 3`;
    return {
      kind: 'baseball',
      hint,
      title: 'Baseball',
      subtitle: s.finished ? 'game over'
        : (s.inning > 9 ? `extra inning · target ${s.inning}` : `inning ${s.inning} · target ${s.inning}`),
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: !s.finished && i === s.turn,
        primary: p.score, primaryLabel: 'runs',
        legs: p.legs,
        chips: [
          { k: 'inning', label: 'inning', value: s.inning > 9 ? `E${s.inning}` : `${s.inning}/9` },
          { k: 'last', label: 'last inning', value: p.lastInning === null ? '—' : p.lastInning },
        ],
      })),
    };
  },
};

const golf = {
  id: 'golf',
  label: 'Golf',
  blurb: 'Play holes 1-18 on the board. Trebles are hole-in-ones; lowest strokes wins.',
  category: 'party',
  players: { min: 1, max: 8 },
  rules: 'The board becomes a golf course: holes 1 to 18 are the numbers 1 to 18. Throw up to '
    + 'three darts at the hole number; only your best dart counts - a treble is a hole-in-one '
    + 'and ends the hole for 1 stroke, a double scores 2, a single 3. Miss the number with all '
    + 'three and take 5. Press next player to bank your best score early (banking with nothing '
    + 'thrown still costs 5). Lowest stroke total after 18 holes wins; a tie goes to whoever '
    + 'threw first.',
  variants: [
    { id: 'standard', label: '18 holes', config: {} },
  ],
  options: [],
  defaults: {},

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error('Golf needs 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, strokes: 0, hole: 1, lastHole: null,
        darts: 0, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  // Close the current player's hole with the best dart in the visit (5 if none).
  _close(s, ev) {
    const p = s.players[s.turn];
    let best = 5;
    for (const d of s.visit) {
      if (d.score !== p.hole) continue;
      const v = d.multiplier === 3 ? 1 : d.multiplier === 2 ? 2 : 3;
      if (v < best) best = v;
    }
    p.strokes += best;
    p.lastHole = best;
    p.hole++;
    if (p.hole > 18) p.done = true;
    s.visit = [];
    if (s.players.every((q) => q.done)) {
      const w = s.players.reduce((a, b) => (b.strokes < a.strokes ? b : a));
      s.finished = true;
      s.winner = { id: w.id, name: w.name };
      w.legs = (w.legs || 0) + 1;
      ev.push({ type: 'matchwin', player: w.name });
      return;
    }
    do { s.turn = (s.turn + 1) % s.players.length; } while (s.players[s.turn].done);
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    if (dart.score === p.hole && dart.multiplier === 3) {
      // Nothing can beat 1 stroke, so a treble ends the hole on the spot.
      ev.push({ type: 'holeinone', player: p.name, hole: p.hole });
      this._close(s, ev);
      return ev;
    }
    if (s.visit.length === 3) this._close(s, ev);
    return ev;
  },

  endVisit(s, cfg) {
    // Bank early: keep the best dart so far - an empty visit is a pass and costs 5.
    const ev = [];
    this._close(s, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act && act.hole <= 18) {
      hint = `Hole ${act.hole}: land in the ${act.hole}s - treble is best, a miss costs most`;
    }
    return {
      kind: 'golf',
      hint,
      title: 'Golf',
      subtitle: 'lowest strokes over holes 1-18 wins',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.strokes,
        primaryLabel: 'strokes',
        legs: p.legs,
        progress: Math.min((p.hole - 1) / 18, 1),
        chips: [
          { k: 'hole', label: 'hole', value: `${Math.min(p.hole, 18)}/18` },
          { k: 'last', label: 'last hole', value: p.lastHole === null ? '—' : p.lastHole },
        ],
      })),
    };
  },
};

const scram = {
  id: 'scram',
  label: 'Scram',
  blurb: 'One stops, one scores. Close the board, swap roles - biggest total takes it.',
  category: 'party',
  players: { min: 2, max: 2 },
  rules: 'Two players, two halves. In half one Player A is the stopper and Player B the scorer, '
    + 'and the stopper always throws first. Any stopper dart in an open number from 1 to 20 '
    + 'closes that number - the bull does nothing. The scorer banks number times multiplier for '
    + 'darts in open numbers; closed numbers and the bull score nothing. You alternate '
    + 'three-dart visits. The moment all twenty numbers are closed the half ends: every number '
    + 'reopens and the roles swap. After both halves the higher total wins. On a tie the win '
    + 'goes to whoever threw fewer darts as scorer, and if still level Player A wins.',
  variants: [
    { id: 'std', label: 'Standard', config: {} },
  ],
  options: [],
  defaults: {},

  init(roster) {
    if (roster.length !== 2) throw new Error('Scram is for exactly 2 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, scoringDarts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
      half: 1, open: Array.from({ length: 20 }, (_, i) => i + 1),
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    const stopperSeat = s.half === 1 ? 0 : 1;

    if (s.turn === stopperSeat) {
      if (dart.score >= 1 && dart.score <= 20 && s.open.includes(dart.score)) {
        s.open = s.open.filter((n) => n !== dart.score);
        ev.push({ type: 'closed', player: p.name, target: dart.score });
        if (!s.open.length) {
          s.visit = [];
          if (s.half === 1) {
            // board cleared: reopen everything, swap roles, new stopper throws
            s.half = 2;
            s.open = Array.from({ length: 20 }, (_, i) => i + 1);
            s.turn = 1;
          } else {
            const [a, b] = s.players;
            const w = a.score !== b.score ? (a.score > b.score ? a : b)
              : a.scoringDarts !== b.scoringDarts
                ? (a.scoringDarts < b.scoringDarts ? a : b)
                : a;
            s.finished = true;
            s.winner = { id: w.id, name: w.name };
            w.legs = (w.legs || 0) + 1;
            ev.push({ type: 'matchwin', player: w.name });
          }
          return ev;
        }
      }
    } else {
      p.scoringDarts++;
      if (dart.score >= 1 && dart.score <= 20 && s.open.includes(dart.score)) {
        p.score += val(dart);
      }
    }

    if (s.visit.length === 3) {
      if (s.turn !== stopperSeat) {
        // open set never changes during a scorer visit, so score it after the fact
        const total = s.visit.reduce((t, d) => t
          + (d.score >= 1 && d.score <= 20 && s.open.includes(d.score) ? val(d) : 0), 0);
        if (total === 180) ev.push({ type: 'oneeighty', player: p.name });
        else if (total >= 140) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
        else if (total >= 100) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });
      }
      s.visit = [];
      s.turn = (s.turn + 1) % s.players.length;
    }
    return ev;
  },

  endVisit(s, cfg) {
    const ev = [];
    if (s.finished) return ev;
    // remaining darts count as thrown misses; the third dart closes the visit
    do {
      ev.push(...scram.applyDart(s, cfg, { score: 0, multiplier: 1 }));
    } while (s.visit.length);
    return ev;
  },

  view(s, cfg) {
    const stopperSeat = s.half === 1 ? 0 : 1;
    const actIdx = s.turn;
    const hint = s.finished ? null
      : actIdx === (s.half === 1 ? 0 : 1)
        ? `You're the stopper - hit open numbers to close them off`
        : `You're the scorer - pile points on the ${s.open.length} open number${s.open.length === 1 ? '' : 's'}`;
    return {
      kind: 'scram',
      hint,
      title: 'Scram',
      subtitle: `half ${s.half} · ${s.open.length} numbers open · higher total wins`,
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.score, primaryLabel: 'points', legs: p.legs,
        chips: [
          { k: 'role', label: 'role', value: i === stopperSeat ? 'STOPPER' : 'SCORER' },
          { k: 'open', label: 'open', value: s.open.length },
          { k: 'half', label: 'half', value: `${s.half}/2` },
        ],
      })),
    };
  },
};

const gotcha = {
  id: 'gotcha',
  label: 'Gotcha',
  blurb: 'Race to exactly the target - land on a rival\'s score and knock them back to zero.',
  category: 'party',
  players: { min: 2, max: 8 },
  rules: 'Race from zero to exactly the target - 201, 301 or 501 - adding up everything you hit '
    + 'over three-dart visits. Go past the target and you are bust: the visit is void, your '
    + 'score returns to where it started and your turn ends. The sting: if your running total '
    + 'ever lands exactly on an opponent\'s score above zero, you GOTCHA them and they crash '
    + 'back to zero - rivals sharing that score all drop. Knock-backs made before a bust still '
    + 'stand. Land bang on the target to win.',
  variants: [
    { id: '301', label: '301', config: { target: 301 } },
    { id: '201', label: '201', config: { target: 201 } },
    { id: '501', label: '501', config: { target: 501 } },
  ],
  options: [
    { key: 'target', label: 'Target', type: 'number', default: 301, min: 101, max: 1001 },
  ],
  defaults: { target: 301 },

  init(roster, cfg) {
    if (roster.length < 2 || roster.length > 8) throw new Error('Gotcha needs 2-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, darts: 0, lastVisit: null, legs: 0,
      })),
      turn: 0, visit: [], visitStart: 0, finished: false, winner: null, legNumber: 1,
    };
  },

  _close(s, p) {
    p.lastVisit = visitTotal(s.visit);
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    s.visitStart = s.players[s.turn].score;
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    if (s.visit.length === 0) s.visitStart = p.score;
    s.visit.push(dart);
    p.darts++;

    const after = p.score + val(dart);
    if (after > cfg.target) {
      ev.push({ type: 'bust', player: p.name, reason: 'too many' });
      p.score = s.visitStart;
      this._close(s, p);
      return ev;
    }
    p.score = after;

    if (after === cfg.target) {
      p.lastVisit = visitTotal(s.visit);
      s.visit = [];
      s.finished = true;
      s.winner = { id: p.id, name: p.name };
      p.legs++;
      ev.push({ type: 'matchwin', player: p.name });
      return ev;
    }

    // A scoring dart that lands your total on a rival's zeroes every rival there.
    if (val(dart) > 0) {
      for (const q of s.players) {
        if (q !== p && q.score === after) {
          q.score = 0;
          ev.push({ type: 'gotcha', player: p.name, victim: q.name });
        }
      }
    }

    if (s.visit.length === 3) this._close(s, p);
    return ev;
  },

  endVisit(s, cfg) {
    // Remaining darts count as misses: no score change, no bust, no gotcha.
    this._close(s, s.players[s.turn]);
    return [];
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act ? null
      : `Land exactly on ${cfg.target} - ${cfg.target - act.score} to go. Match a rival's total and they drop to nought`;
    return {
      kind: 'gotcha',
      hint,
      title: `Gotcha · ${cfg.target}`,
      subtitle: 'exact total wins - land on a rival and they drop to zero',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.score,
        legs: p.legs,
        progress: Math.min(p.score / cfg.target, 1),
        chips: [
          { k: 'togo', label: 'to go', value: cfg.target - p.score },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit },
        ],
      })),
    };
  },
};

const dragon = {
  id: 'dragon',
  label: 'Chase the Dragon',
  blurb: 'Climb 10 to 20 in order, then outer bull, then the bull - tail to head.',
  category: 'party',
  players: { min: 1, max: 8 },
  rules: 'Chase the dragon from tail to head. Hit 10, then 11, then 12 - all the way up to 20 - '
    + 'then the outer bull (25), and finally the inner bull (50) to reach the head and win. A '
    + 'dart only moves you on if it hits your current target: any ring counts for 10 to 20, but '
    + 'the 25 step needs the single outer bull and the last step needs the double bull exactly. '
    + 'Miss and you stay put. Three darts a visit, everyone takes turns; first to the dragon\'s '
    + 'head wins. The Trebles variant demands the treble ring on every number from 10 to 20.',
  variants: [
    { id: 'any', label: 'Any ring counts', config: { trebles: false } },
    { id: 'trebles', label: 'Trebles only (10-20)', config: { trebles: true } },
  ],
  options: [
    { key: 'trebles', label: 'Steps 10-20 need the treble ring', type: 'bool', default: false },
  ],
  defaults: { trebles: false },

  // steps 0-10 = numbers 10..20, 11 = outer bull (25), 12 = inner bull (50)
  _target(step) {
    if (step >= 13) return 'WIN';
    if (step === 12) return 'BULL';
    if (step === 11) return '25';
    return 10 + step;
  },

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error('Chase the Dragon needs 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, step: 0, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;

    const hit = p.step === 12 ? dart.score === 25 && dart.multiplier === 2
      : p.step === 11 ? dart.score === 25 && dart.multiplier === 1
      : dart.score === 10 + p.step && (!cfg.trebles || dart.multiplier === 3);
    if (hit) {
      p.step++;
      if (p.step === 13) {
        s.finished = true;
        s.winner = { id: p.id, name: p.name };
        p.legs = (p.legs || 0) + 1;
        ev.push({ type: 'matchwin', player: p.name });
        return ev;
      }
      ev.push({ type: 'advance', player: p.name, target: this._target(p.step) });
    }
    if (s.visit.length === 3) { s.visit = []; s.turn = (s.turn + 1) % s.players.length; }
    return ev;
  },

  endVisit(s, cfg) {
    const ev = [];
    if (s.finished) return ev;
    // Remaining darts (all three on an empty-visit pass) land as misses,
    // closing the visit exactly as thrown darts would.
    const need = 3 - s.visit.length;
    for (let i = 0; i < need; i++) ev.push(...this.applyDart(s, cfg, { score: 0, multiplier: 1 }));
    return ev;
  },

  view(s, cfg) {
    const trebles = !!(cfg && cfg.trebles);
    const act = s.players[s.turn];
    const t = act ? this._target(act.step) : null;
    const say = typeof t === 'number' && cfg && cfg.trebles ? `treble ${t}`
      : t === 'BULL' ? 'the bull' : t === '25' ? 'the outer bull (25)' : t;
    const hint = s.finished || !act ? null
      : `Hit ${say} - only that exact bed climbs the dragon`;
    return {
      kind: 'dragon',
      hint,
      title: 'Chase the Dragon' + (trebles ? ' · Trebles' : ''),
      subtitle: trebles ? 'treble 10 → treble 20, then 25, then bull'
        : 'tail to head: 10 → 20, then 25, then bull',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: this._target(p.step),
        primaryLabel: 'needs',
        progress: Math.min(p.step / 13, 1),
        chips: [{ k: 'darts', label: 'darts', value: p.darts }],
      })),
    };
  },
};

const aroundboard = {
  id: 'aroundboard',
  label: 'Around the Board',
  blurb: 'Race round the rim in its real clockwise order - 20 to 5 - then finish on the bull.',
  category: 'classics',
  players: { min: 1, max: 8 },
  rules: 'Work your way round the board in its real clockwise order, starting from the top: '
    + '20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5 - then finish '
    + 'on the bull. Any ring of the right number counts: single, double or treble all move '
    + 'you on exactly one place, and any bull (25 or 50) takes the win. Three darts a visit, '
    + 'then play passes on. First player to reach and hit the bull wins the game.',
  variants: [
    { id: 'standard', label: 'Any hit counts', config: {} },
  ],
  options: [],
  defaults: {},

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error('Around the Board takes 1-8 players');
    return {
      // the board's physical order, clockwise from the top
      order: [20, 1, 18, 4, 13, 6, 10, 15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5],
      players: roster.map((p) => ({
        id: p.id, name: p.name, idx: 0, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;

    const needBull = p.idx >= 20;
    const hit = needBull ? dart.score === 25 : dart.score === s.order[p.idx];
    if (hit) {
      p.idx++;
      ev.push({ type: 'advance', player: p.name, target: p.idx >= 20 ? 'BULL' : s.order[p.idx] });
      if (needBull) {
        s.finished = true;
        s.winner = { id: p.id, name: p.name };
        p.legs = (p.legs || 0) + 1;
        ev.push({ type: 'matchwin', player: p.name });
        return ev;
      }
    }
    if (s.visit.length === 3) { s.visit = []; s.turn = (s.turn + 1) % s.players.length; }
    return ev;
  },

  endVisit(s) {
    const p = s.players[s.turn];
    // remaining darts are thrown misses; an empty visit is a full pass
    while (s.visit.length < 3) { s.visit.push({ score: 0, multiplier: 1 }); p.darts++; }
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    return [];
  },

  view(s) {
    const act = s.players[s.turn];
    const hint = s.finished || !act ? null
      : `Hit ${act.idx >= 20 ? 'the bull' : `the ${s.order[act.idx]}s`} - any bed, clockwise round the rim`;
    return {
      kind: 'aroundboard',
      hint,
      title: 'Around the Board',
      subtitle: '20 → 1 → 18 … clockwise round the rim, then bull',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.idx >= 20 ? 'BULL' : s.order[p.idx],
        primaryLabel: 'needs',
        progress: Math.min(p.idx / 21, 1),
        chips: [{ k: 'darts', label: 'darts', value: p.darts }],
      })),
    };
  },
};

const tennis = {
  id: 'tennis',
  label: 'Tennis',
  blurb: 'Trade three-dart visits point by point - tennis scoring, first to a set number of games.',
  category: 'party',
  players: { min: 2, max: 2 },
  rules: 'Two players trade three-dart visits, one point at a time. The opener throws a full visit, '
    + 'then the other replies; the higher visit total takes the point, and a tied point is replayed '
    + 'with the same opener (no point awarded). Points score like tennis: 0, 15, 30, 40, game - and '
    + 'deuce at 40-40 is no-ad, so the next point wins the game. Players alternate who throws first '
    + 'on each new point. First to the set number of games (3 by default, or 6) wins the match.',
  variants: [
    { id: 'g3', label: 'First to 3 games', config: { gamesToWin: 3 } },
    { id: 'g6', label: 'First to 6 games', config: { gamesToWin: 6 } },
  ],
  options: [
    { key: 'gamesToWin', label: 'Games to win', type: 'number', default: 3, min: 1, max: 9 },
  ],
  defaults: { gamesToWin: 3 },

  init(roster) {
    if (roster.length !== 2) throw new Error('Tennis needs exactly 2 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, games: 0, pts: 0, pointsWon: 0, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
      opener: 0,       // seat that throws first in the current point
      pending: null,   // opener's visit total while the reply is thrown
    };
  },

  _point(s, cfg, ev, seat) {
    const w = s.players[seat];
    const l = s.players[1 - seat];
    w.pointsWon++;
    if (w.pts < 3) { w.pts++; return; }
    // at 40 the point takes the game - no-ad, so this covers 40-40 too
    w.games++;
    w.pts = 0; l.pts = 0;
    if (w.games >= cfg.gamesToWin) {
      s.finished = true;
      s.winner = { id: w.id, name: w.name };
      w.legs = (w.legs || 0) + 1;
      ev.push({ type: 'matchwin', player: w.name });
      return;
    }
    ev.push({ type: 'legwin', player: w.name, legs: w.games });
    s.legNumber++;
  },

  _closeVisit(s, cfg, ev) {
    const p = s.players[s.turn];
    const total = visitTotal(s.visit);
    if (total === 180) ev.push({ type: 'oneeighty', player: p.name });
    else if (total >= 140) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
    else if (total >= 100) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });
    s.visit = [];
    if (s.pending === null) {          // opener done - reply visit follows
      s.pending = total;
      s.turn = 1 - s.opener;
      return;
    }
    const openerTotal = s.pending;
    s.pending = null;
    if (openerTotal === total) {       // tie - replay the point, same opener
      s.turn = s.opener;
      return;
    }
    this._point(s, cfg, ev, openerTotal > total ? s.opener : 1 - s.opener);
    if (!s.finished) { s.opener = 1 - s.opener; s.turn = s.opener; }
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    s.players[s.turn].darts++;
    s.visit.push(dart);
    if (s.visit.length === 3) this._closeVisit(s, cfg, ev);
    return ev;
  },

  endVisit(s, cfg) {
    // unthrown darts count as misses; an empty visit is a pass scoring 0
    const ev = [];
    this._closeVisit(s, cfg, ev);
    return ev;
  },

  view(s, cfg) {
    const calls = ['0', '15', '30', '40'];
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      const o = s.players[1 - s.turn];
      const call = act.pts === 3 && o.pts === 3 ? 'deuce' : `${calls[act.pts]}-${calls[o.pts]}`;
      hint = `Outscore ${o.name}'s visit to take the point (${call})`;
    }
    return {
      kind: 'tennis',
      hint,
      title: `Tennis · first to ${cfg.gamesToWin} games`,
      subtitle: 'higher visit takes the point · no-ad deuce',
      rows: s.players.map((p, i) => {
        const o = s.players[1 - i];
        return {
          id: p.id, name: p.name, active: !s.finished && i === s.turn,
          primary: p.games, primaryLabel: 'games',
          progress: Math.min(p.games / cfg.gamesToWin, 1),
          chips: [
            { k: 'game', label: 'game', value: p.pts === 3 && o.pts === 3 ? 'deuce' : `${calls[p.pts]}-${calls[o.pts]}` },
            { k: 'pts', label: 'points won', value: p.pointsWon },
          ],
        };
      }),
    };
  },
};

const legs = {
  id: 'legs',
  label: 'Legs',
  blurb: 'Beat the last best visit or lose a leg. Last player with legs left wins.',
  category: 'party',
  players: { min: 2, max: 8 },
  rules: 'Everyone starts with the same number of legs. The first player throws three darts and '
    + 'that total sets the mark. From then on, each visit must BEAT the current mark - score '
    + 'more and your total becomes the new mark for the next player; equal or less and you lose '
    + 'a leg (the mark stays). Passing or ending your visit early counts too - unthrown darts '
    + 'are misses. Lose all your legs and you are out; play skips you. Last player standing '
    + 'wins.',
  variants: [
    { id: 'l3', label: '3 legs each', config: { legs: 3 } },
    { id: 'l5', label: '5 legs each', config: { legs: 5 } },
  ],
  options: [
    { key: 'legs', label: 'Legs each', type: 'number', default: 3, min: 1, max: 10 },
  ],
  defaults: { legs: 3 },

  init(roster, cfg) {
    if (roster.length < 2 || roster.length > 8) throw new Error('Legs needs 2-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, lives: cfg.legs, lastVisit: null, darts: 0, legs: 0,
      })),
      mark: null,
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

  _closeVisit(s, cfg, ev) {
    const p = s.players[s.turn];
    const total = visitTotal(s.visit);
    p.lastVisit = total;
    if (s.mark === null) {
      s.mark = total;                // opening visit sets the mark, risk-free
    } else if (total > s.mark) {
      s.mark = total;                // equal is not enough - the mark must be beaten
    } else {
      p.lives--;
      ev.push({ type: 'lifelost', player: p.name, victim: p.name, left: p.lives });
      if (p.lives === 0) ev.push({ type: 'eliminated', player: p.name });
    }
    const alive = s.players.filter((q) => q.lives > 0);
    if (alive.length === 1) {
      s.finished = true;
      s.winner = { id: alive[0].id, name: alive[0].name };
      alive[0].legs++;
      ev.push({ type: 'matchwin', player: alive[0].name });
    }
    s.visit = [];
    this._advance(s);
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    s.players[s.turn].darts++;
    s.visit.push(dart);
    if (s.visit.length === 3) this._closeVisit(s, cfg, ev);
    return ev;
  },

  endVisit(s, cfg) {
    if (s.finished) return [];
    const ev = [];
    // Unthrown darts are misses; a full pass is a 0 visit and is judged
    // like any other - only the game-opening visit is safe.
    this._closeVisit(s, cfg, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act ? null
      : s.mark === null ? 'Set the mark - this visit becomes the score to beat'
      : `Beat ${s.mark} or lose a leg`;
    return {
      kind: 'legs',
      hint,
      title: 'Legs',
      subtitle: 'beat the mark or lose a leg',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished && p.lives > 0,
        primary: p.lives > 0 ? '♥'.repeat(p.lives) : 'OUT',
        primaryLabel: 'legs',
        chips: [
          { k: 'mark', label: 'mark', value: s.mark === null ? '—' : s.mark },
          { k: 'last', label: 'last visit', value: p.lastVisit === null ? '—' : p.lastVisit },
        ],
      })),
    };
  },
};

const suddendeath = {
  id: 'suddendeath',
  label: 'Sudden Death',
  blurb: 'Lowest visit each round is out. Ties all go together. Last one standing wins.',
  category: 'party',
  players: { min: 2, max: 8 },
  rules: 'Everyone throws one three-dart visit each round - just score as much as you can. When '
    + 'the round is complete, the player with the lowest visit total is eliminated. If two or '
    + 'more tie for the lowest, they are all out together - unless that would knock out '
    + 'everybody left, in which case the round is a stand-off and nobody goes. Survivors move '
    + 'on and the next round begins with the lowest surviving seat. Passing or ending your '
    + 'visit early counts the untaken darts as misses. Last player standing wins.',
  variants: [
    { id: 'standard', label: 'Standard', config: {} },
  ],
  options: [],
  defaults: {},

  init(roster) {
    if (roster.length < 2 || roster.length > 8) throw new Error('Sudden Death needs 2-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, alive: true, visitScore: null, rounds: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, round: 1, legNumber: 1,
    };
  },

  // Shared by applyDart and endVisit: bank the visit total, and once every
  // survivor has thrown this round, knock out the lowest.
  _close(s, ev) {
    const p = s.players[s.turn];
    const total = visitTotal(s.visit);
    p.visitScore = total;
    if (total === 180) ev.push({ type: 'oneeighty', player: p.name });
    else if (total >= 140) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 140 });
    else if (total >= 100) ev.push({ type: 'bigscore', player: p.name, score: total, tier: 100 });
    s.visit = [];

    const alive = s.players.filter((q) => q.alive);
    if (alive.some((q) => q.visitScore === null)) {
      let i = s.turn;
      do { i = (i + 1) % s.players.length; } while (!(s.players[i].alive && s.players[i].visitScore === null));
      s.turn = i;
      return;
    }
    // Round complete - everyone tied for lowest goes, unless that would
    // empty the board, in which case the round is a stand-off.
    const low = Math.min(...alive.map((q) => q.visitScore));
    const out = alive.filter((q) => q.visitScore === low);
    if (out.length < alive.length) {
      for (const q of out) { q.alive = false; ev.push({ type: 'eliminated', player: q.name }); }
    }
    for (const q of s.players) { if (q.alive) q.rounds++; q.visitScore = null; }
    s.round++;
    const left = s.players.filter((q) => q.alive);
    if (left.length === 1) {
      const w = left[0];
      s.finished = true;
      s.winner = { id: w.id, name: w.name };
      w.legs = (w.legs || 0) + 1;
      s.turn = s.players.indexOf(w);
      ev.push({ type: 'matchwin', player: w.name });
      return;
    }
    s.turn = s.players.findIndex((q) => q.alive);
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    s.visit.push(dart);
    if (s.visit.length === 3) suddendeath._close(s, ev);
    return ev;
  },

  endVisit(s, cfg) {
    // Untaken darts count as misses; an empty visit is a pass scoring 0
    const ev = [];
    if (s.finished) return ev;
    suddendeath._close(s, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      const thrown = s.players.filter((q) => q.alive && q.visitScore !== null);
      const low = thrown.length ? Math.min(...thrown.map((q) => q.visitScore)) : null;
      hint = low === null ? `Round ${s.round}: lowest visit is knocked out - throw big`
        : `Lowest so far is ${low} - don't finish bottom`;
    }
    return {
      kind: 'suddendeath',
      hint,
      title: 'Sudden Death',
      subtitle: s.finished ? 'last one standing' : `round ${s.round} · lowest visit is out`,
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: !s.finished && i === s.turn,
        primary: (!s.finished && i === s.turn && s.visit.length) ? visitTotal(s.visit)
          : p.visitScore === null ? '—' : p.visitScore,
        primaryLabel: 'this round',
        legs: p.legs,
        chips: [
          { k: 'status', label: 'status', value: p.alive ? 'in' : 'OUT' },
          { k: 'rounds', label: 'survived', value: p.rounds },
        ],
      })),
    };
  },
};

/* --------------------------------------------------------- Prisoner ---- */

/*
 * Survival Around the Clock. Climb your own target 1 → 20 → bull, any ring.
 * A visit with no dart in your target costs a life; no lives = locked up.
 */
const prisoner = {
  id: 'prisoner',
  label: 'Prisoner',
  blurb: 'Around the Clock with three lives: a blank visit costs one, the bull sets you free.',
  category: 'party',
  players: { min: 1, max: 8 },
  rules: 'Everyone has three lives and their own target, starting at 1 and climbing to 20, then '
    + 'the bull. Any ring of your number counts, and every hit moves you on one - you can climb '
    + 'several numbers in a single visit. Finish a three-dart visit without a single dart in your '
    + 'target and you lose a life; a passed visit counts as three misses. Lose all your lives and '
    + 'you are locked up and skipped. Win by hitting the finishing bull - any bull will do - or by '
    + 'being the last player still free. Playing solo, simply beat the board to the bull before '
    + 'your lives run out.',
  variants: [{ id: 'standard', label: 'Standard', config: {} }],
  options: [
    { key: 'lives', label: 'Lives each', type: 'number', default: 3, min: 1, max: 6 },
  ],
  defaults: { lives: 3 },

  init(roster, cfg) {
    if (roster.length < 1 || roster.length > 8) throw new Error('Prisoner needs 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, target: 1, lives: cfg.lives, darts: 0, legs: 0,
      })),
      turn: 0, visit: [], visitHit: false, finished: false, winner: null, legNumber: 1,
    };
  },

  _advance(s) {
    let hops = 0;
    do {
      s.turn = (s.turn + 1) % s.players.length;
    } while (s.players[s.turn].lives <= 0 && ++hops <= s.players.length);
  },

  _closeVisit(s, ev) {
    const p = s.players[s.turn];
    if (!s.visitHit) {
      p.lives--;
      ev.push({ type: 'lifelost', player: p.name, victim: p.name, left: p.lives });
      if (p.lives === 0) ev.push({ type: 'eliminated', player: p.name });
    }
    s.visit = [];
    s.visitHit = false;
    const alive = s.players.filter((q) => q.lives > 0);
    if (s.players.length > 1 && alive.length === 1) {
      s.finished = true;
      s.winner = { id: alive[0].id, name: alive[0].name };
      alive[0].legs = (alive[0].legs || 0) + 1;
      ev.push({ type: 'matchwin', player: alive[0].name });
      return;
    }
    if (alive.length === 0) { s.finished = true; return; }   // solo: the board wins
    this._advance(s);
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;

    const needBull = p.target > 20;
    const hit = needBull ? dart.score === 25 : dart.score === p.target;
    if (hit) {
      s.visitHit = true;
      p.target++;
      ev.push({ type: 'advance', player: p.name, target: p.target > 20 ? 'BULL' : p.target });
      if (needBull) {
        s.finished = true;
        s.winner = { id: p.id, name: p.name };
        p.legs = (p.legs || 0) + 1;
        ev.push({ type: 'matchwin', player: p.name });
        s.visit = [];
        s.visitHit = false;
        return ev;
      }
    }
    if (s.visit.length === 3) this._closeVisit(s, ev);
    return ev;
  },

  endVisit(s) {
    // Remaining darts count as thrown misses; an empty visit is a deliberate
    // pass, which is three misses - the visit still costs a life if blank.
    const ev = [];
    this._closeVisit(s, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act || act.lives <= 0 ? null
      : `Hit ${act.target > 20 ? 'the bull' : `the ${act.target}s`} - score nothing this visit and it costs a life`;
    return {
      kind: 'prisoner',
      hint,
      title: 'Prisoner',
      subtitle: 'climb 1 → 20, then the bull · a blank visit costs a life',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished && p.lives > 0,
        primary: p.target > 20 ? 'BULL' : p.target,
        primaryLabel: 'needs',
        progress: Math.min((p.target - 1) / 21, 1),
        chips: [
          { k: 'lives', label: 'lives', value: p.lives > 0 ? '♥'.repeat(p.lives) : 'OUT' },
          { k: 'darts', label: 'darts', value: p.darts },
        ],
      })),
    };
  },
};

const nearestbull = {
  id: 'nearestbull',
  label: 'Nearest the Bull',
  blurb: 'Three darts at the bull every round - 50 scores 2, 25 scores 1, most points wins.',
  category: 'party',
  players: { min: 1, max: 8 },
  rules: 'Bulls only. Each round every player throws three darts at the bull: the inner bull '
    + '(50) scores 2 points, the outer bull (25) scores 1 point, and anything else scores '
    + 'nothing. Play the set number of rounds (10 by default) - most points at the end wins. '
    + 'If the leaders are tied, everyone throws sudden-death rounds until a full round ends '
    + 'with one clear leader. Darts you do not throw when a turn is ended early count as '
    + 'misses.',
  variants: [
    { id: 'r10', label: '10 rounds', config: { rounds: 10 } },
    { id: 'r5', label: '5 rounds', config: { rounds: 5 } },
  ],
  options: [
    { key: 'rounds', label: 'Rounds', type: 'number', default: 10, min: 3, max: 15 },
  ],
  defaults: { rounds: 10 },

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error('Nearest the Bull needs 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, points: 0, bulls: 0, outers: 0, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1, round: 1,
    };
  },

  _finishVisit(s, cfg, ev) {
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    if (s.turn !== 0) return;
    // Full round done. After the last scheduled round a lone leader wins;
    // tied leaders send everyone into sudden-death rounds until one breaks.
    if (s.round >= cfg.rounds) {
      const top = Math.max(...s.players.map((q) => q.points));
      const leaders = s.players.filter((q) => q.points === top);
      if (leaders.length === 1) {
        const w = leaders[0];
        s.finished = true;
        s.winner = { id: w.id, name: w.name };
        w.legs = (w.legs || 0) + 1;
        ev.push({ type: 'matchwin', player: w.name });
        return;
      }
    }
    s.round++;
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    const pts = dart.score === 25 ? dart.multiplier : 0; // 25 = 1 pt, bull = 2
    p.points += pts;
    if (pts === 2) p.bulls++;
    else if (pts === 1) p.outers++;
    if (s.visit.length === 3) this._finishVisit(s, cfg, ev);
    return ev;
  },

  endVisit(s, cfg) {
    // Unthrown darts are misses and score nothing - just close the round.
    const ev = [];
    this._finishVisit(s, cfg, ev);
    return ev;
  },

  view(s, cfg) {
    const sudden = s.round > cfg.rounds;
    const hint = s.finished ? null
      : sudden ? 'Sudden death - win the round outright to take the game'
      : 'Aim for the bull - 50 scores 2 points, 25 scores 1';
    return {
      kind: 'nearestbull',
      hint,
      title: `Nearest the Bull · ${cfg.rounds} rounds`,
      subtitle: sudden ? 'sudden death - a clear lead after a full round wins'
        : '50 = 2 pts, 25 = 1 pt, most points wins',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.points,
        primaryLabel: 'points',
        chips: [
          { k: 'bulls', label: 'bulls', value: p.bulls },
          { k: 'outers', label: '25s', value: p.outers },
          { k: 'round', label: 'round', value: `${s.round}/${cfg.rounds}` },
        ],
      })),
    };
  },
};

const bobs27 = {
  id: 'bobs27',
  label: "Bob's 27",
  blurb: 'Doubles practice from 27 points - hit each double or pay its value.',
  category: 'practice',
  players: { min: 1, max: 8 },
  rules: 'Doubles practice. Everyone starts on 27 points. Rounds run double 1 up to double 20, '
    + 'then the outer 25, then the double bull - 22 rounds. Three darts a round, and only that '
    + "round's exact target counts. Hit it and you add its value for every hit; miss with all "
    + 'three darts and you subtract it. Fall below 1 point and you are eliminated and skipped '
    + 'from then on. Survive all 22 rounds and the highest score wins. If everyone busts, the '
    + 'player who lasted the most rounds wins, with the better score before busting breaking '
    + 'ties, then throwing order.',
  variants: [{ id: 'standard', label: 'Standard', config: {} }],
  options: [],
  defaults: {},

  // Rounds 1-20 aim at that double; 21 is the outer 25; 22 is the double bull.
  _target(round) {
    if (round <= 20) return { score: round, multiplier: 2, value: round * 2, label: 'D' + round };
    if (round === 21) return { score: 25, multiplier: 1, value: 25, label: '25' };
    return { score: 25, multiplier: 2, value: 50, label: 'DBULL' };
  },

  init(roster) {
    if (roster.length < 1 || roster.length > 8) throw new Error("Bob's 27 needs 1 to 8 players");
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 27, round: 1, darts: 0,
        out: false, done: false, bustRound: null, preBust: null, legs: 0,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  _closeRound(s, ev) {
    const p = s.players[s.turn];
    const t = this._target(p.round);
    const hits = s.visit.filter((d) => d.score === t.score && d.multiplier === t.multiplier).length;
    const before = p.score;
    if (hits > 0) p.score += t.value * hits;
    else p.score -= t.value;
    if (p.score < 1) {
      p.out = true;
      p.bustRound = p.round;
      p.preBust = before;      // tie-break: score going into the fatal round
      ev.push({ type: 'eliminated', player: p.name });
    } else {
      p.round++;
      if (p.round > 22) p.done = true;
    }
    s.visit = [];
    for (let i = 1; i <= s.players.length; i++) {
      const n = (s.turn + i) % s.players.length;
      if (!s.players[n].out && !s.players[n].done) { s.turn = n; return; }
    }
    // Everyone is done or out. Survivors: best score. All busted: longest
    // survivor, then the best score going into the fatal round, then order.
    const alive = s.players.filter((q) => !q.out);
    const win = alive.length
      ? alive.reduce((a, b) => (b.score > a.score ? b : a))
      : s.players.reduce((a, b) => (b.bustRound > a.bustRound
        || (b.bustRound === a.bustRound && b.preBust > a.preBust) ? b : a));
    s.finished = true;
    s.winner = { id: win.id, name: win.name };
    win.legs = (win.legs || 0) + 1;
    ev.push({ type: 'matchwin', player: win.name });
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    if (s.visit.length === 3) this._closeRound(s, ev);
    return ev;
  },

  endVisit(s, cfg) {
    // Unthrown darts are misses: the round still settles, so a pass subtracts.
    const ev = [];
    this._closeRound(s, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    const hint = s.finished || !act || act.out || act.done ? null
      : `Hit ${this._target(act.round).label} - miss with all three and its value comes off your 27`;
    return {
      kind: 'bobs27',
      hint,
      title: "Bob's 27",
      subtitle: 'hit the double or lose its value',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.score,
        progress: Math.min((p.round - 1) / 22, 1),
        chips: [
          { k: 'target', label: 'target', value: p.out ? 'OUT' : p.done ? '—' : this._target(p.round).label },
          { k: 'round', label: 'round', value: `${Math.min(p.round, 22)}/22` },
        ],
      })),
    };
  },
};

const checkout121 = {
  id: 'checkout121',
  label: '121 Checkout',
  blurb: 'Six darts a round to take out exactly 121 on a double. Most checkouts wins.',
  category: 'practice',
  players: { min: 1, max: 8 },
  rules: 'Pure checkout practice. Each round you get six darts to take out exactly 121, '
    + 'finishing on a double. Going below zero, leaving exactly 1, or hitting zero without a '
    + 'double is a bust - but a bust does not end your six darts: the count resets to 121 and '
    + 'your remaining darts carry on. The moment you check out, your turn ends. After the set '
    + 'number of rounds (default 5), most checkouts wins; ties go to whoever used fewer darts '
    + 'across their successful checkouts, then to seating order.',
  variants: [
    { id: 'r5', label: '5 rounds', config: { rounds: 5 } },
    { id: 'r3', label: '3 rounds', config: { rounds: 3 } },
    { id: 'r10', label: '10 rounds', config: { rounds: 10 } },
  ],
  options: [
    { key: 'rounds', label: 'Rounds', type: 'number', default: 5, min: 3, max: 10 },
  ],
  defaults: { rounds: 5 },

  init(roster, cfg) {
    if (roster.length < 1 || roster.length > 8) throw new Error('121 Checkout needs 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name,
        checkouts: 0, checkoutDarts: 0,
        left: 121, attemptDarts: 0,
        round: 1, darts: 0, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    p.attemptDarts++;

    const after = p.left - val(dart);
    if (after === 0 && dart.multiplier === 2) {
      p.checkouts++;
      p.checkoutDarts += p.attemptDarts;
      ev.push({ type: 'checkout', player: p.name, from: 121, darts: p.attemptDarts });
      this._closeTurn(s, cfg, p, ev);  // a checkout ends the turn immediately
      return ev;
    }
    if (after < 0 || after === 1 || after === 0) {
      const why = after < 0 ? 'too many' : after === 1 ? 'left on 1' : 'needs a double';
      ev.push({ type: 'bust', player: p.name, reason: why });
      p.left = 121;                    // a bust restarts the attempt, not the turn
      p.attemptDarts = 0;
    } else {
      p.left = after;
    }
    if (s.visit.length === 6) this._closeTurn(s, cfg, p, ev);
    return ev;
  },

  endVisit(s, cfg) {
    const ev = [];
    if (s.finished) return ev;
    let need = 6 - s.visit.length;     // an empty visit is a pass: six misses
    while (need-- > 0 && !s.finished) {
      ev.push(...this.applyDart(s, cfg, { score: 0, multiplier: 1 }));
    }
    return ev;
  },

  _closeTurn(s, cfg, p, ev) {
    p.left = 121;
    p.attemptDarts = 0;
    p.round++;
    if (p.round > cfg.rounds) p.done = true;
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    if (s.players.every((q) => q.done)) {
      // most checkouts, then fewest darts across successful checkouts, then seat
      const best = s.players.reduce((a, b) => (
        b.checkouts > a.checkouts
        || (b.checkouts === a.checkouts && b.checkoutDarts < a.checkoutDarts) ? b : a));
      s.finished = true;
      s.winner = { id: best.id, name: best.name };
      best.legs++;
      ev.push({ type: 'matchwin', player: best.name });
    }
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      const dl = 6 - s.visit.length;
      hint = `Take out ${act.left} - double to finish, ${dl} dart${dl === 1 ? '' : 's'} of 6 left`;
    }
    return {
      kind: 'checkout121',
      hint,
      title: `121 Checkout · ${cfg.rounds} rounds`,
      subtitle: 'six darts to take out 121, double to finish',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: !s.finished && i === s.turn,
        primary: p.checkouts,
        primaryLabel: 'checkouts',
        legs: p.legs,
        chips: [
          { k: 'left', label: 'left', value: p.left },
          { k: 'darts', label: 'darts left', value: !s.finished && i === s.turn ? 6 - s.visit.length : 6 },
          { k: 'round', label: 'round', value: `${Math.min(p.round, cfg.rounds)}/${cfg.rounds}` },
        ],
      })),
    };
  },
};

const fivedartdouble = {
  id: 'fivedartdouble',
  label: '5-Dart Double Challenge',
  blurb: 'Five darts a turn, only doubles count. Highest total after the rounds wins.',
  category: 'practice',
  players: { min: 1, max: 8 },
  rules: 'Each player throws five darts per turn. Only doubles count: any dart in a double ring '
    + 'scores that double\'s value - double 20 is 40, double bull is 50. Singles, trebles and '
    + 'misses score nothing. Everyone gets the same number of rounds (8 by default) and the '
    + 'highest total when the rounds run out wins. Ties are broken by most doubles hit, then by '
    + 'earliest seat in the throwing order. A brutal, honest workout for your finishing.',
  variants: [
    { id: 'r8', label: '8 rounds', config: { rounds: 8 } },
    { id: 'r5', label: '5 rounds', config: { rounds: 5 } },
  ],
  options: [
    { key: 'rounds', label: 'Rounds', type: 'number', default: 8, min: 3, max: 15 },
  ],
  defaults: { rounds: 8 },

  init(roster, cfg) {
    if (roster.length < 1 || roster.length > 8) {
      throw new Error('5-Dart Double Challenge is for 1-8 players');
    }
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, score: 0, doubles: 0, round: 1, darts: 0,
        lastVisit: null, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null,
      rounds: cfg.rounds, legNumber: 1,
    };
  },

  // Shared round close - endVisit's phantom misses score nothing, so both
  // paths finish the round identically.
  _closeRound(s, cfg, ev) {
    const p = s.players[s.turn];
    p.lastVisit = s.visit.reduce((t, d) => t + (d.multiplier === 2 && d.score ? val(d) : 0), 0);
    p.round++;
    if (p.round > cfg.rounds) p.done = true;
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    if (s.players.every((q) => q.done)) {
      // Tie-break: points, then most doubles hit, then seating order
      const best = s.players.reduce((a, b) => (
        b.score > a.score || (b.score === a.score && b.doubles > a.doubles) ? b : a));
      s.finished = true;
      s.winner = { id: best.id, name: best.name };
      best.legs = (best.legs || 0) + 1;
      ev.push({ type: 'matchwin', player: best.name });
    }
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    if (dart.multiplier === 2 && dart.score) {   // any double, D-bull included
      p.score += val(dart);
      p.doubles++;
    }
    if (s.visit.length === 5) this._closeRound(s, cfg, ev);
    return ev;
  },

  endVisit(s, cfg) {
    const ev = [];
    // Remaining darts count as misses; an empty visit is a pass and the
    // round still closes on 0.
    this._closeRound(s, cfg, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      const dl = 5 - s.visit.length;
      hint = `Doubles only - ${dl} dart${dl === 1 ? '' : 's'} left this turn`;
    }
    return {
      kind: 'fivedartdouble',
      hint,
      title: `5-Dart Double Challenge · ${cfg.rounds} rounds`,
      subtitle: 'five darts a turn, only doubles score',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: !s.finished && i === s.turn,
        primary: p.score,
        chips: [
          { k: 'doubles', label: 'doubles', value: p.doubles },
          { k: 'round', label: 'round', value: `${Math.min(p.round, cfg.rounds)}/${cfg.rounds}` },
          { k: 'last', label: 'last', value: p.lastVisit === null ? '—' : p.lastVisit },
        ],
      })),
    };
  },
};

const challenge170 = {
  id: 'challenge170',
  label: '170 Challenge',
  blurb: 'Three darts at the big fish: treble 20, treble 20, bull. Most 170 take-outs wins.',
  category: 'practice',
  players: { min: 1, max: 8 },
  rules: 'The big fish. Each round you get three darts to take out exactly 170 - that means '
    + 'treble 20, treble 20, then the 50 bull, and the bull must be your last dart. Land it and '
    + 'you bank a take-out. Play the set number of rounds (default 5); every dart you throw also '
    + 'adds to your total points. Most take-outs when the rounds run out wins; if it is level, '
    + 'higher total points decides, and if still level the earlier seat takes it.',
  variants: [
    { id: 'r5', label: '5 rounds', config: { rounds: 5 } },
    { id: 'r10', label: '10 rounds', config: { rounds: 10 } },
  ],
  options: [
    { key: 'rounds', label: 'Rounds', type: 'number', default: 5, min: 3, max: 10 },
  ],
  defaults: { rounds: 5 },

  init(roster, cfg) {
    if (roster.length < 1 || roster.length > 8) throw new Error('170 Challenge needs 1-8 players');
    return {
      players: roster.map((p) => ({
        id: p.id, name: p.name, takeouts: 0, points: 0, round: 1, darts: 0,
        lastVisit: null, legs: 0, done: false,
      })),
      turn: 0, visit: [], finished: false, winner: null, legNumber: 1,
    };
  },

  // A take-out is exactly 170 in the full three darts with the 50 bull last.
  _finishVisit(s, cfg, ev) {
    const p = s.players[s.turn];
    const total = visitTotal(s.visit);
    const last = s.visit[s.visit.length - 1];
    p.lastVisit = total;
    if (s.visit.length === 3 && total === 170 && last.score === 25 && last.multiplier === 2) {
      p.takeouts++;
      ev.push({ type: 'checkout', player: p.name, from: 170, darts: 3 });
    }
    p.round++;
    if (p.round > cfg.rounds) p.done = true;
    s.visit = [];
    s.turn = (s.turn + 1) % s.players.length;
    if (s.players.every((q) => q.done)) {
      const best = s.players.reduce((a, b) => (
        b.takeouts > a.takeouts || (b.takeouts === a.takeouts && b.points > a.points) ? b : a));
      s.finished = true;
      s.winner = { id: best.id, name: best.name };
      best.legs = (best.legs || 0) + 1;
      ev.push({ type: 'matchwin', player: best.name });
    }
  },

  applyDart(s, cfg, dart) {
    const ev = [];
    const p = s.players[s.turn];
    s.visit.push(dart);
    p.darts++;
    p.points += val(dart);
    if (s.visit.length === 3) this._finishVisit(s, cfg, ev);
    return ev;
  },

  // Unthrown darts are misses: no take-out is possible, but the round is spent.
  endVisit(s, cfg) {
    const ev = [];
    this._finishVisit(s, cfg, ev);
    return ev;
  },

  view(s, cfg) {
    const act = s.players[s.turn];
    let hint = null;
    if (!s.finished && act) {
      const left = Math.max(0, 170 - visitTotal(s.visit));
      hint = left === 50 ? 'Bull to take it out!'
        : left === 0 ? 'Taken out!' : `${left} left - the classic is T20, T20, bull`;
    }
    return {
      kind: 'challenge170',
      hint,
      title: `170 Challenge · ${cfg.rounds} rounds`,
      subtitle: 'T20, T20, bull last - most take-outs wins',
      rows: s.players.map((p, i) => ({
        id: p.id, name: p.name, active: i === s.turn && !s.finished,
        primary: p.takeouts,
        primaryLabel: 'take-outs',
        legs: p.legs,
        chips: [
          { k: 'attempt', label: 'attempt', value: i === s.turn && !s.finished
            ? visitTotal(s.visit) : (p.lastVisit === null ? '—' : p.lastVisit) },
          { k: 'round', label: 'round', value: `${Math.min(p.round, cfg.rounds)}/${cfg.rounds}` },
          { k: 'points', label: 'points', value: p.points },
        ],
      })),
    };
  },
};

  return { highscore, ninedart, baseball, golf, scram, gotcha, dragon, aroundboard, tennis, legs, suddendeath, prisoner, nearestbull, bobs27, checkout121, fivedartdouble, challenge170 };
};
