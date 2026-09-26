/* End-to-end: boot the real hub, play Prisoner over socket.io, verify the
 * caller specials, noscore flag and the new clips being served. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const PORT = Number(process.env.TPORT || 8899);
const { io } = require('socket.io-client');
const http = require('http');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
const head = (path) => new Promise((res) => http.get({ host: '127.0.0.1', port: 8899, path }, (r) => { r.resume(); res(r.statusCode); }).on('error', () => res(0)));

(async () => {
  const s = io(`http://127.0.0.1:${PORT}`);
  const visits = [], cels = [];
  s.on('visit', (v) => visits.push(v));
  s.on('celebrate', (e) => cels.push(e));
  await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  // The fake board throws by itself every 2s - release it so only the
  // test's darts land and the visits stay deterministic.
  s.emit('boardDisconnect'); await wait(400);
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'prisoner', config: { lives: 1 }, players: [{ name: 'A' }, { name: 'B' }] });
  await wait(300);
  const dart = (sc, m = 1) => { s.emit('dart', { score: sc, multiplier: m }); };

  // A: hits the 1 then two misses - turn passes with no special, no total call
  dart(1); dart(5); dart(5); await wait(400);
  check('visit emitted for A', visits.length === 1);
  check('prisoner visit is noscore', visits[0] && visits[0].noscore === true, visits[0]);
  check('no special on a scoring visit', visits[0] && visits[0].special === null);

  // B: blank visit on the last life - lifelost + eliminated + matchwin, elimwin call
  dart(9); dart(9); dart(9); await wait(400);
  check('visit emitted for B', visits.length === 2);
  check('elimwin call on last-life loss (not game shot)', visits[1] && visits[1].special === 'elimwin', visits[1] && visits[1].special);
  check('lifelost celebrate with reason blank', cels.some((e) => e.type === 'lifelost' && e.reason === 'blank'));
  check('eliminated celebrate fired', cels.some((e) => e.type === 'eliminated' && e.player === 'B'));
  check('matchwin celebrate for A', cels.some((e) => e.type === 'matchwin' && e.player === 'A'));

  // mid-game life loss says lifelost (fresh 2-life game)
  s.emit('newMatch', { gameId: 'prisoner', config: { lives: 2 }, players: [{ name: 'A' }, { name: 'B' }] });
  await wait(250); visits.length = 0;
  dart(1); dart(5); dart(5); await wait(300);   // A
  dart(9); dart(9); dart(9); await wait(300);   // B blank, one life left
  check('mid-game blank visit calls lifelost', visits[1] && visits[1].special === 'lifelost', visits[1] && visits[1].special);

  // an X01 game still calls the total and is not noscore
  s.emit('newMatch', { gameId: 'x01', variantId: '501', players: [{ name: 'A' }, { name: 'B' }] });
  await wait(250); visits.length = 0;
  dart(20, 3); dart(20, 3); dart(5); await wait(300);
  check('501 visit keeps its total call', visits[0] && visits[0].noscore === false && visits[0].total === 125, visits[0]);

  // the three new caller clips are served
  check('lifelost.mp3 served', await head('/sounds/lifelost.mp3') === 200);
  check('eliminated.mp3 served', await head('/sounds/eliminated.mp3') === 200);
  check('elimwin.mp3 served', await head('/sounds/elimwin.mp3') === 200);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
