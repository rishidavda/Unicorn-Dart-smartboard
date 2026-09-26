/* Prisoner rule test + all-games sweep, engine level (no server). */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const { Match, GAMES } = require(process.env.GAMES_JS || require('path').join(HERE, '..', 'server', 'games.js'));
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
const d = (score, multiplier = 1) => ({ score, multiplier });

/* ------------------------------------------------------------ Prisoner --- */
{
  const m = new Match({ gameId: 'prisoner', players: [{ name: 'A' }, { name: 'B' }] });
  check('prisoner quietVisit flagged', m.view().quietVisit === true);
  check('prisoner hint names the 1s', /the 1s/.test(m.view().hint), m.view().hint);

  // A: hit 1, then two misses - no life lost (the visit touched the target)
  let ev = m.addDart(d(1)).concat(m.addDart(d(5)), m.addDart(d(5)));
  check('hit then misses: no life lost', !ev.some((e) => e.type === 'lifelost'));
  check('A advanced to 2', m.state.players[0].target === 2);
  check('advance event fired', ev.some((e) => e.type === 'advance' && e.target === 2));

  // B: blank visit - life lost with reason blank
  ev = m.addDart(d(9)).concat(m.addDart(d(9)), m.addDart(d(9)));
  const ll = ev.find((e) => e.type === 'lifelost');
  check('blank visit loses a life', !!ll && m.state.players[1].lives === 2);
  check('lifelost carries reason blank', ll && ll.reason === 'blank' && ll.left === 2, ll);

  // A: multi-climb - 2, 3, 4 in one visit
  m.addDart(d(2)); m.addDart(d(3)); m.addDart(d(4));
  check('multi-climb to 5 in one visit', m.state.players[0].target === 5);

  // B: two more blank visits - eliminated, A wins (last one standing)
  m.addDart(d(9)); m.addDart(d(9)); m.addDart(d(9)); // B lives 1
  m.addDart(d(9)); m.addDart(d(9)); m.addDart(d(9)); // A's turn? no - turn order: after B, A plays
  // Rebuild cleanly: track whose turn it is instead of guessing.
  const m2 = new Match({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'A' }, { name: 'B' }] });
  m2.addDart(d(1)); m2.addDart(d(5)); m2.addDart(d(5));         // A hits, advances
  ev = [].concat(m2.addDart(d(9)), m2.addDart(d(9)), m2.addDart(d(9)));  // B blank on last life
  check('last life: eliminated event', ev.some((e) => e.type === 'eliminated' && e.player === 'B'));
  check('last life: lifelost still reported first', ev.findIndex((e) => e.type === 'lifelost') < ev.findIndex((e) => e.type === 'eliminated'));
  check('survivor wins the match', m2.state.finished && m2.state.winner && m2.state.winner.name === 'A');
  check('matchwin comes with eliminated (elimwin call)', ev.some((e) => e.type === 'matchwin') && ev.some((e) => e.type === 'eliminated'));

  // 3 players: eliminated player is skipped
  const m3 = new Match({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
  m3.addDart(d(1)); m3.addDart(d(5)); m3.addDart(d(5));         // A
  m3.addDart(d(9)); m3.addDart(d(9)); m3.addDart(d(9));         // B out
  check('3p: game continues after one elimination', !m3.state.finished);
  check('3p: play skips to C', m3.state.players[m3.state.turn].name === 'C');
  m3.addDart(d(1)); m3.addDart(d(5)); m3.addDart(d(5));         // C hits 1
  check('3p: back to A, skipping B', m3.state.players[m3.state.turn].name === 'A');

  // Bull win: climb a solo player to 21 then hit the bull
  const m4 = new Match({ gameId: 'prisoner', config: { lives: 6 }, players: [{ name: 'A' }] });
  for (let t = 1; t <= 20; t++) {
    m4.addDart(d(t));
    if (m4.state.visit.length === 2) m4.addDart(d(21 <= 20 ? 21 : 5)); // never - keep visits natural
  }
  // after 20 single hits (visits of 3 close automatically only at 3 darts) -
  // simpler: end each visit early via endTurn after the hit
  const m5 = new Match({ gameId: 'prisoner', config: { lives: 6 }, players: [{ name: 'A' }] });
  for (let t = 1; t <= 20; t++) { m5.addDart(d(t)); m5.endTurn(); }
  check('solo climbed to the bull', m5.view().rows[0].primary === 'BULL');
  ev = m5.addDart(d(25));
  check('bull wins it', m5.state.finished && m5.state.winner && m5.state.winner.name === 'A');
  check('bull win is a matchwin without eliminated', ev.some((e) => e.type === 'matchwin') && !ev.some((e) => e.type === 'eliminated'));

  // Solo out of lives: board wins - finished with no winner
  const m6 = new Match({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'A' }] });
  m6.addDart(d(9)); m6.addDart(d(9)); m6.addDart(d(9));
  check('solo out of lives: finished, board wins', m6.state.finished && !m6.state.winner);

  // A deliberate pass costs a life
  const m7 = new Match({ gameId: 'prisoner', players: [{ name: 'A' }, { name: 'B' }] });
  ev = m7.endTurn();
  check('passing a visit costs a life', ev.some((e) => e.type === 'lifelost' && e.reason === 'blank'), ev);

  // Undo across a life loss restores it (replay engine)
  const m8 = new Match({ gameId: 'prisoner', players: [{ name: 'A' }, { name: 'B' }] });
  m8.addDart(d(9)); m8.addDart(d(9)); m8.addDart(d(9));
  check('life gone before undo', m8.state.players[0].lives === 2);
  m8.undo();
  check('undo restores the life', m8.state.players[0].lives === 3 && m8.state.visit.length === 2);
}

/* --------------------------------------------------------- Legs lifelost -- */
{
  const m = new Match({ gameId: 'legs', players: [{ name: 'A' }, { name: 'B' }] });
  m.addDart(d(20, 3)); m.addDart(d(20, 3)); m.addDart(d(20, 3));  // A sets mark 180
  const ev = [].concat(m.addDart(d(1)), m.addDart(d(1)), m.addDart(d(1)));  // B scores 3
  const ll = ev.find((e) => e.type === 'lifelost');
  check('legs: life lost carries reason mark + the mark', ll && ll.reason === 'mark' && ll.mark === 180, ll);
}

/* ------------------------------------------------------------- Killer ---- */
{
  // Classic (default): three of your own number arms you, rings count
  const m = new Match({ gameId: 'killer', players: [{ name: 'A' }, { name: 'B' }] });  // A=16, B=8
  check('killer default is classic 3-to-arm', m.config.arm === 'count');
  check('killer hint counts down from 3', /3 more/.test(m.view().hint), m.view().hint);

  let ev = m.addDart(d(16, 3));
  check('treble of own number arms in one dart', m.state.players[0].killer === true);
  check('killer event says any ring', ev.some((e) => e.type === 'killer' && e.anyRing));

  ev = m.addDart(d(8, 2));
  check('double on victim number takes 2 lives', m.state.players[1].lives === 1);
  check('lifelost carries taken 2', ev.some((e) => e.type === 'lifelost' && e.taken === 2 && e.victim === 'B' && e.left === 1), ev);

  ev = m.addDart(d(8, 3));
  check('treble takes only the life that exists', m.state.players[1].lives === 0);
  check('victim eliminated, killer wins', m.state.finished && m.state.winner && m.state.winner.name === 'A');

  const k2 = new Match({ gameId: 'killer', players: [{ name: 'A' }, { name: 'B' }] });
  ev = k2.addDart(d(16, 2));
  check('double of own number = 2 of 3', k2.state.players[0].hits === 2 && !k2.state.players[0].killer);
  check('arming progress event fired', ev.some((e) => e.type === 'arming' && e.hits === 2));
  k2.addDart(d(16, 1));
  check('single completes the arming', k2.state.players[0].killer === true);
  ev = k2.addDart(d(16, 2));
  check('own number as killer costs own lives by ring', k2.state.players[0].lives === 1
    && ev.some((e) => e.type === 'lifelost' && e.own && e.taken === 2), ev);

  const k3 = new Match({ gameId: 'killer', players: [{ name: 'A' }, { name: 'B' }] });
  k3.addDart(d(8, 3));
  check('unarmed player cannot take lives', k3.state.players[1].lives === 3);

  // Doubles-only variant keeps the old strict game
  const k4 = new Match({ gameId: 'killer', variantId: 'doubles', players: [{ name: 'A' }, { name: 'B' }] });
  k4.addDart(d(16, 1)); k4.addDart(d(16, 3));
  check('doubles-only: singles and trebles never arm', !k4.state.players[0].killer);
  k4.addDart(d(16, 2));
  check('doubles-only: own double arms in one dart', k4.state.players[0].killer === true);
  k4.endTurn();               // B passes
  k4.addDart(d(8, 2));
  check('doubles-only: victim double takes exactly one life', k4.state.players[1].lives === 2);
  k4.addDart(d(8, 3));
  check('doubles-only: treble on victim does nothing', k4.state.players[1].lives === 2);
}

/* --------------------------------------- review findings, regression ----- */
{
  // Count-up: "next player" uses the round up; the game can finish
  const m = new Match({ gameId: 'countup', variantId: 'r5', players: [{ name: 'A' }, { name: 'B' }] });
  m.addDart(d(20, 2)); m.addDart(d(20, 2)); m.endTurn();
  check('countup: early end still closes the round', m.state.players[0].round === 2 && m.state.players[0].lastVisit === 80,
    { round: m.state.players[0].round, last: m.state.players[0].lastVisit });
  for (let r = 0; r < 9; r++) m.endTurn();
  check('countup: game finishes when the rounds run out', m.state.finished === true);
  check('countup: highest total wins', m.state.winner && m.state.winner.name === 'A');

  // X01: a busted visit banks nothing - no 180 call, no stats, avg unpolluted
  const x = new Match({ gameId: 'x01', variantId: '501', players: [{ name: 'A' }, { name: 'B' }] });
  x.addDart(d(20, 3)); x.addDart(d(20, 3)); x.addDart(d(20, 3));   // real 180 -> 321
  x.endTurn();
  x.addDart(d(19, 3)); x.addDart(d(19, 3)); x.addDart(d(19, 3));   // 171 -> 150
  x.endTurn();
  const evb = [].concat(x.addDart(d(20, 3)), x.addDart(d(20, 3)), x.addDart(d(20, 3))); // 180 = bust
  const A = x.state.players[0];
  check('x01: busted 180 not celebrated', evb.some((e) => e.type === 'bust')
    && !evb.some((e) => e.type === 'oneeighty' || e.type === 'bigscore'), evb.map((e) => e.type));
  check('x01: busted visit banks no stats', A.oneEighties === 1 && A.tons === 2 && A.bestVisit === 180 && A.lastVisit === 0,
    { o: A.oneEighties, t: A.tons, b: A.bestVisit, l: A.lastVisit });
  check('x01: average drops the wiped turn', A.score === 150 && A.scored === 351 && A.darts === 9,
    { score: A.score, scored: A.scored, darts: A.darts });

  // X01 double-in: nothing counts before the opening double
  const di = new Match({ gameId: 'x01', variantId: '501', config: { doubleIn: true }, players: [{ name: 'A' }, { name: 'B' }] });
  const evd = [].concat(di.addDart(d(20, 3)), di.addDart(d(20, 3)), di.addDart(d(20, 3)));
  const P = di.state.players[0];
  check('double-in: unopened 180 is worth 0 and stays quiet',
    !evd.some((e) => e.type === 'oneeighty') && P.score === 501 && P.lastVisit === 0 && P.oneEighties === 0 && P.bestVisit === 0,
    { score: P.score, last: P.lastVisit });
  di.endTurn();
  di.addDart(d(20, 1)); di.addDart(d(20, 2)); di.addDart(d(20, 3));  // opens on dart 2
  check('double-in: stats count from the opening double only',
    P.lastVisit === 100 && P.tons === 1 && P.score === 401, { last: P.lastVisit, tons: P.tons, score: P.score });

  // Cut-throat cricket: a third-party dart seals a bystander's win instantly
  const c = new Match({ gameId: 'cricket', variantId: 'cutthroat', players: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] });
  c.addDart(d(15, 3)); c.addDart(d(16, 3)); c.addDart(d(17, 3));    // A closes 15-17
  c.addDart(d(20, 3)); c.addDart(d(20, 3)); c.addDart(d(1, 1));     // B closes 20, piles 60 onto A and C
  c.endTurn();                                                       // C passes
  c.addDart(d(18, 3)); c.addDart(d(19, 3)); c.addDart(d(20, 3));    // A closes 18-20
  c.endTurn(); c.endTurn();                                          // B, C pass
  c.addDart(d(25, 2)); c.addDart(d(25, 1)); c.addDart(d(1, 1));     // A closes the bull: all closed on 60
  check('cutthroat: closed out on 60 with a lower rival is not a win yet', !c.state.finished);
  c.endTurn();                                                       // B passes
  c.addDart(d(15, 3));                                               // C closes 15
  c.addDart(d(15, 3));                                               // +45 onto B (45 < 60, still open)
  check('cutthroat: not sealed while a rival is still lower', !c.state.finished);
  const evc = c.addDart(d(15, 3));                                   // +45 more: B on 90, A now lowest
  check('cutthroat: third-party dart seals the bystander win', c.state.finished && c.state.winner && c.state.winner.name === 'A',
    { finished: c.state.finished, winner: c.state.winner });
  check('cutthroat: matchwin fires on that dart', evc.some((e) => e.type === 'matchwin' && e.player === 'A'), evc.map((e) => e.type));
}

/* -------------------------------------------------- sweep every game ----- */
// Plays every game/variant with seeded pseudo-random darts. Checks nothing
// crashes, view() always renders, turns stay valid, winners are real players.
let seed = 42;
const rnd = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
const randDart = () => {
  const r = rnd();
  if (r < 0.06) return d(25, rnd() < 0.3 ? 2 : 1);
  const score = 1 + Math.floor(rnd() * 20);
  const mult = rnd() < 0.15 ? 3 : rnd() < 0.3 ? 2 : 1;
  return d(score, mult);
};

for (const [gid, g] of Object.entries(GAMES)) {
  for (const v of g.variants || [{ id: undefined }]) {
    const nPlayers = Math.max(2, (g.players && g.players.min) || 2);
    const players = Array.from({ length: Math.min(nPlayers, 3) }, (_, i) => ({ name: 'P' + (i + 1) }));
    const tag = `${gid}/${v.id || 'default'}`;
    try {
      const m = new Match({ gameId: gid, variantId: v.id, players });
      let darts = 0;
      let viewOk = true, turnOk = true, evOk = true;
      while (!m.state.finished && darts < 2000) {
        const ev = m.addDart(randDart()) || [];
        darts++;
        for (const e of ev) if (!e.type) evOk = false;
        // exercise an early end-of-turn now and then
        if (!m.state.finished && darts % 17 === 0) m.endTurn();
        const view = m.view();
        if (!view || !Array.isArray(view.rows) || view.rows.length !== players.length) viewOk = false;
        if (!m.state.finished) {
          const t = m.state.turn;
          if (!(t >= 0 && t < m.state.players.length)) turnOk = false;
        }
        // practice rounds run longer than a standard visit by design
        const visitCap = gid === 'checkout121' ? 6 : gid === 'fivedartdouble' ? 5 : 3;
        if (m.state.visit.length > visitCap) turnOk = false;
      }
      const w = m.state.winner;
      const winnerOk = !m.state.finished || w === null || w === undefined
        || m.roster.some((p) => p.id === w.id);
      const finished = m.state.finished;
      check(`sweep ${tag}: ${finished ? `finished in ${darts} darts` : `no crash in ${darts} darts`}`,
        viewOk && turnOk && evOk && winnerOk,
        viewOk && turnOk && evOk && winnerOk ? undefined : { viewOk, turnOk, evOk, winnerOk });
    } catch (e) {
      check(`sweep ${tag}`, false, e.message);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
