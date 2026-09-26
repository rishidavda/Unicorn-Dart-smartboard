/* Fix-tab corrections end to end on the real hub and pages: a typed
 * 1000000000 lives can't kill the hub (nor its replay), an emptied box is
 * refused, a finished game can't be corrected, the caller and the TV cards
 * follow corrections, undo keeps the current visit's calls, Session End and
 * Power off wipe queued cards, and logs from the previous release replay as
 * that release played them. Boots its own hub(s). */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { chromium } = require('playwright-core');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = process.env.SERVER_JS || require('path').join(HERE, '..', 'server', 'server.js');
const { Match } = require(process.env.GAMES_JS || require('path').join(HERE, '..', 'server', 'games.js'));
const PORT = Number(process.env.TPORT || 8897);
const URL = `http://127.0.0.1:${PORT}`;
const DATA = `${SP}/hubAdj`;
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + (typeof x === 'string' ? x : JSON.stringify(x)) : ''}`); };

let hub = null;
async function boot() {
  hub = spawn('node', [`${HERE}/fakeboard.js`], { env: { ...process.env, SERVER_JS: SERVER, PORT: String(PORT), DARTS_DATA: DATA, DARTS_REPORTS: `${DATA}-reports` }, stdio: 'ignore' });
  await wait(2500);
}
async function halt() { hub.kill('SIGINT'); await new Promise((r) => hub.once('exit', r)); await wait(300); }
const alive = () => new Promise((res) => http.get(`${URL}/tv`, (r) => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
const saved = () => JSON.parse(fs.readFileSync(`${DATA}/match.json`, 'utf8'));
const history = () => { try { return JSON.parse(fs.readFileSync(`${DATA}/history.json`, 'utf8')); } catch (_) { return []; } };
async function connect() {
  const s = io(URL, { reconnection: false });
  s.st = null; s.visits = []; s.on('state', (x) => { s.st = x; }); s.on('visit', (v) => s.visits.push(v));
  await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  // The fake board throws by itself every 2 s - release it so only the
  // test's darts land.
  s.emit('boardDisconnect'); await wait(300);
  return s;
}

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(`${DATA}-reports`, { recursive: true, force: true });
  await boot();
  let s = await connect();
  s.emit('sessionStart', 60); await wait(200);
  const dart = (sc, m = 1) => s.emit('dart', { score: sc, multiplier: m });
  const adjust = (i, value) => s.emit('adjust', { playerId: s.st.match.rows[i].id, value });
  const game = async (req) => { s.emit('newMatch', req); await wait(400); s.visits.length = 0; };
  const row = (i) => s.st.match.rows[i];

  const b = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const tv = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  const pad = await b.newPage({ viewport: { width: 820, height: 1180 } });
  const errors = [];
  for (const [n, p] of [['tv', tv], ['pad', pad]]) p.on('pageerror', (e) => errors.push(`${n}: ${e.message}`));
  await tv.goto(`${URL}/tv`); await pad.goto(`${URL}/pad`); await wait(800);
  await tv.evaluate(() => {
    window.__cel = [];
    const c = document.getElementById('cel');
    new MutationObserver(() => { if (/show/.test(c.className)) window.__cel.push(document.getElementById('celtext').innerText.replace(/\n/g, ' ')); })
      .observe(c, { attributes: true, attributeFilter: ['class'] });
  });
  const cards = () => tv.evaluate(() => window.__cel.splice(0));
  const celUp = () => tv.$eval('#cel', (el) => /show/.test(el.className));
  const cardUp = () => tv.$eval('#turncard', (el) => el.classList.contains('show'));

  // --- D1: a huge lives value is clamped to the game's cap, the hub lives on
  await game({ gameId: 'killer', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  adjust(1, 1000000000); await wait(500);
  check('killer: 1000000000 lives clamps to 6 (the option max)', s.st && row(1).adjust.value === 6 && row(1).primary === '♥'.repeat(6), s.st && row(1).adjust);
  check('...and the hub is still serving', await alive() && s.connected);
  check('...the correction is logged as written', saved().log.slice(-1)[0].v === 1000000000, saved().log.slice(-1)[0]);
  const before = saved().log.length;
  adjust(1, ''); adjust(1, null); adjust(1, 'abc'); adjust(1, 'Infinity'); adjust(0, NaN); await wait(400);
  check('empty / non-numeric box: ignored, nobody knocked out, nothing logged',
    row(0).adjust.value === 3 && row(1).adjust.value === 6 && !s.st.match.finished && saved().log.length === before && history().length === 0,
    { lives: [row(0).adjust.value, row(1).adjust.value], log: saved().log.length });

  await game({ gameId: 'legs', players: [{ name: 'Ann' }, { name: 'Bob' }] });
  check('legs: the row carries its own cap of 10', row(0).adjust.max === 10, row(0).adjust);
  adjust(0, 99); await wait(300);
  check('legs: 99 legs clamps to 10, not 6', row(0).adjust.value === 10, row(0).adjust.value);
  await pad.click('[data-tab="fix"]'); await wait(400);
  const maxes = await pad.$$eval('#adjustlist input', (els) => els.map((e) => e.max));
  check('pad: legs boxes take up to 10', maxes.length === 2 && maxes.every((m) => m === '10'), maxes);

  // --- D-empty on the real pad: an emptied box is refused, not sent as 0
  await game({ gameId: 'prisoner', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  await wait(400);
  const logBefore = saved().log.length;
  await pad.fill('#adjustlist input >> nth=1', '');
  await pad.click('#adjustlist button >> nth=1'); await wait(400);
  const toastText = await pad.$eval('#toast', (el) => el.textContent);
  check('pad: emptied lives box says "Type a number first"', /type a number first/i.test(toastText), toastText);
  check('pad: nothing sent - Sam keeps 3 lives, game on, log untouched',
    row(1).adjust.value === 3 && !s.st.match.finished && saved().log.length === logBefore && history().length === 0,
    { lives: row(1).adjust.value, finished: s.st.match.finished });

  // --- D2: a life given back mid-visit takes its "Life lost!" with it
  await game({ gameId: 'killer', players: [{ name: 'Ash' }, { name: 'Sam' }] });   // 16, 8
  dart(16, 3); dart(1); dart(1); await wait(300); s.emit('endTurn'); await wait(200);   // Ash armed, Sam passes
  s.visits.length = 0;
  dart(8, 1); await wait(300);                                                     // mis-read: Sam "loses" a life
  adjust(1, 3); await wait(300);                                                   // staff give it back
  dart(1); dart(1); await wait(500);
  check('killer: life restored mid-visit -> the visit ends with no stale "lifelost"',
    s.visits.length === 1 && s.visits[0].player === 'Ash' && s.visits[0].special === null, s.visits.map((v) => [v.player, v.special]));

  // --- D2/D3: the thrower knocked out by a correction ends THAT visit; the
  // next player's visit is their own
  await game({ gameId: 'killer', players: [{ name: 'Ash' }, { name: 'Sam' }, { name: 'Cy' }] });   // 16, 8, 4
  dart(16, 3); dart(1); dart(1); await wait(300); s.emit('endTurn'); s.emit('endTurn'); await wait(300);   // Ash armed, Sam and Cy pass
  s.visits.length = 0; await cards();
  dart(8, 1); await wait(300);                                                     // Ash takes a life off Sam
  adjust(0, 0); await wait(500);                                                   // ...then Ash is corrected out
  const cut = s.visits[0];
  check('killer: the interrupted visit gets its card - Ash, one dart, eliminated',
    cut && cut.player === 'Ash' && cut.special === 'eliminated' && cut.darts.length === 1 && cut.darts[0].label === '8', cut);
  check('...and the turn is Sam\'s', s.st.match.turnPlayerId === row(1).id && !s.st.match.finished);
  const outCards = await cards();
  check('...TV shows ASH OUT!', outCards.some((t) => /ASH OUT!/.test(t)), outCards);
  dart(1); dart(1); dart(1); await wait(500);
  check('killer: Sam\'s blank visit carries no special from Ash\'s half-visit',
    s.visits.length === 2 && s.visits[1].player === 'Sam' && s.visits[1].special === null, s.visits.map((v) => [v.player, v.special]));

  await game({ gameId: 'prisoner', players: [{ name: 'Ash' }, { name: 'Bo' }, { name: 'Cy' }] });
  dart(1); await wait(300);                                                        // Ash hits with dart 1
  adjust(0, 0); await wait(400);                                                   // staff set Ash to 0
  check('prisoner: correction out of the thrower moves the turn to Bo', s.st.match.turnPlayerId === row(1).id);
  dart(9); dart(9); dart(9); await wait(500);
  check('prisoner: Bo\'s blank visit still costs a life (Ash\'s hit does not carry over)',
    row(1).adjust.value === 2 && s.visits[1] && s.visits[1].player === 'Bo' && s.visits[1].special === 'lifelost',
    { lives: row(1).adjust.value, visits: s.visits.map((v) => [v.player, v.special]) });
  const replayed = Match.fromJSON(saved());
  check('prisoner: the saved log replays the same way', replayed.state.players[1].lives === 2 && replayed.state.players[0].lives === 0,
    replayed.state.players.map((p) => p.lives));

  // --- D7: undoing dart 2 keeps dart 1's life for the caller
  await game({ gameId: 'killer', players: [{ name: 'Ash' }, { name: 'Sam' }] });
  dart(16, 3); dart(1); dart(1); await wait(300); s.emit('endTurn'); await wait(200);
  s.visits.length = 0;
  dart(8, 1); dart(1); await wait(300);
  s.emit('undo'); await wait(300);
  check('undo dart 2: Sam is still a life down', row(1).adjust.value === 2, row(1).adjust.value);
  dart(1); dart(1); await wait(500);
  check('undo dart 2: the visit still ends with "Life lost!"',
    s.visits.length === 1 && s.visits[0].special === 'lifelost', s.visits.map((v) => [v.player, v.special]));

  // --- D5: undo takes the visit card down with the cards
  await game({ gameId: 'x01', variantId: '501', players: [{ name: 'Ann' }, { name: 'Bob' }] });
  dart(20, 3); dart(20, 3); dart(20, 3); await wait(600);
  check('x01: the 180 visit card is up', await cardUp());
  s.emit('undo'); await wait(400);
  check('undo hides the visit card', !(await cardUp()) && !(await celUp()));

  // --- D4: a finished game cannot be corrected - the win card still plays
  await game({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  dart(1); dart(5); dart(5); await wait(1500); await cards();
  dart(9); dart(9); dart(9); await wait(600);                                     // LIFE LOST up, OUT + WINS queued
  check('prisoner: game over, Ash wins', s.st.match.finished && s.st.match.winner.name === 'Ash');
  const doneLog = saved().log.length;
  await pad.click('[data-tab="fix"]'); await wait(300);
  const fixText = await pad.$eval('#adjustlist', (el) => el.innerText);
  check('pad: Fix tab says game over, no boxes', /game over/i.test(fixText) && /Undo last dart/.test(fixText) && !(await pad.$('#adjustlist input')), fixText);
  adjust(0, 2); await wait(400);
  check('adjust after the win: nothing logged, still finished', saved().log.length === doneLog && s.st.match.finished && row(0).adjust.value === 1,
    { log: saved().log.length, lives: row(0).adjust.value });
  await wait(12000);
  const winCards = await cards();
  check('...and the OUT! and WINS! cards still play', winCards.some((t) => /SAM OUT!/.test(t)) && winCards.some((t) => /ASH WINS!/.test(t)), winCards);
  check('...the win is recorded once', history().length === 1, history().length);

  // --- D6: Session End and Power off wipe whatever is still queued
  s.emit('sessionStart', 60); await wait(200);
  await game({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  dart(1); dart(5); dart(5); await wait(600);
  dart(9); dart(9); dart(9); await wait(600); await cards();                      // LIFE LOST up, OUT + WINS queued
  s.emit('sessionEnd'); await wait(400);
  check('session end: no card showing, welcome screen back', !(await celUp()) && !s.st.match && !(await cardUp()));
  await wait(8000);
  const afterEnd = await cards();
  check('session end: nothing queued plays afterwards', afterEnd.length === 0, afterEnd);

  s.emit('sessionStart', 60); await wait(200);
  await game({ gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'Ash' }, { name: 'Sam' }] });
  dart(1); dart(5); dart(5); await wait(600);
  dart(9); dart(9); dart(9); await wait(600); await cards();
  s.emit('powerOff'); await wait(500);
  check('power off: standby screen, no card', (await tv.$eval('#standby', (el) => !el.hidden)) && !(await celUp()));
  await wait(8000);
  const afterOff = await cards();
  check('power off: nothing plays behind the standby screen', afterOff.length === 0, afterOff);
  s.emit('powerOn'); await wait(500);
  s.emit('boardDisconnect'); await wait(300);

  check('no page errors on TV or pad', errors.length === 0, errors);
  await b.close();
  s.close();

  // --- D1: a match.json already holding a huge value replays and serves
  await halt();
  fs.writeFileSync(`${DATA}/match.json`, JSON.stringify({
    gameId: 'killer', variantId: 'standard', config: { lives: 3, arm: 'count' }, startedAt: new Date().toISOString(),
    players: [{ id: 'p1', name: 'Ash' }, { id: 'p2', name: 'Sam' }],
    log: [{ k: 'set', id: 'p2', v: 1000000000 }, { k: 'adj', id: 'p1', v: 1000000000 }],
  }));
  await boot();
  s = await connect();
  check('huge saved corrections (new and legacy kinds) replay: hub up, both on 6 lives',
    await alive() && s.st && s.st.match && s.st.match.rows.map((r) => r.adjust.value).join() === '6,6', s.st && s.st.match && s.st.match.rows.map((r) => r.adjust.value));
  s.close();

  // --- D8: the previous release's corrections replay as it applied them
  await halt();
  fs.writeFileSync(`${DATA}/match.json`, JSON.stringify({
    gameId: 'killer', variantId: 'standard', config: { lives: 3, arm: 'count' }, startedAt: new Date().toISOString(),
    players: [{ id: 'p1', name: 'Ash' }, { id: 'p2', name: 'Sam' }, { id: 'p3', name: 'Cy' }],
    // Ash arms; the old pad's box (pre-filled 0) sets Ash to 0 lives - which
    // back then neither knocked Ash out nor moved the turn; Ash then took a
    // life off Sam with the 8.
    log: [{ k: 'd', s: 16, m: 3 }, { k: 'adj', id: 'p1', v: 0 }, { k: 'd', s: 8, m: 1 }],
  }));
  await boot();
  s = await connect();
  const m = s.st && s.st.match;
  check('legacy killer log: Ash 0, Sam 2, Cy 3 and the turn with Sam - as the old release played it',
    m && m.rows.map((r) => r.adjust.value).join() === '0,2,3' && m.turnPlayerId === 'p2' && !m.finished,
    m && { lives: m.rows.map((r) => r.adjust.value), turn: m.turnPlayerId });
  s.close();
  await halt();
  const c170 = Match.fromJSON({ gameId: 'challenge170', players: [{ id: 'p1', name: 'A' }], log: [{ k: 'adj', id: 'p1', v: 5 }] });
  check('legacy 170 Challenge points correction still lands', c170.state.players[0].points === 5, c170.state.players[0].points);
  const frac = Match.fromJSON({ gameId: 'prisoner', players: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], log: [{ k: 'adj', id: 'p1', v: 2.5 }] });
  check('legacy fractional lives replay unrounded', frac.state.players[0].lives === 2.5, frac.state.players[0].lives);
  const eng = new Match({ gameId: 'legs', players: [{ name: 'A' }, { name: 'B' }] });
  eng.adjust('p1', 4.4); eng.adjust('p2', 1e9);
  check('engine: new corrections round and cap by the game (legs 4, 10)', eng.state.players[0].lives === 4 && eng.state.players[1].lives === 10 && !eng.state.finished,
    eng.state.players.map((p) => p.lives));

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { hub.kill(); } catch (_) {} process.exit(1); });
