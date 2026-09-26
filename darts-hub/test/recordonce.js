/* A finished game is recorded exactly once across hub restarts; a replayed
 * (restarted) game is a new record. Also: saves survive a torn file. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = process.env.SERVER_JS || require('path').join(HERE, '..', 'server', 'server.js');
const PORT = Number(process.env.TPORT || 8897);
const DATA = `${SP}/hubRec`;
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };

let hub = null;
async function boot() {
  hub = spawn('node', [`${HERE}/fakeboard.js`], { env: { ...process.env, SERVER_JS: SERVER, PORT: String(PORT), DARTS_DATA: DATA, DARTS_REPORTS: `${DATA}-reports` }, stdio: 'ignore' });
  await wait(2500);
}
async function halt() { if (hub.exitCode === null) { hub.kill('SIGINT'); await new Promise((r) => hub.once('exit', r)); } await wait(300); }
const alive = () => new Promise((res) => http.get(`http://127.0.0.1:${PORT}/tv`, (r) => { r.resume(); res(r.statusCode === 200); }).on('error', () => res(false)));
async function connect() {
  const s = io(`http://127.0.0.1:${PORT}`, { reconnection: false });
  s.st = null; s.on('state', (x) => { s.st = x; });
  await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); await wait(300);
  return s;
}
const history = () => JSON.parse(fs.readFileSync(`${DATA}/history.json`, 'utf8'));
const report = () => new Promise((res) => http.get(`http://127.0.0.1:${PORT}/api/report-today?pin=1234`, (r) => {
  const chunks = []; r.on('data', (c) => chunks.push(c)); r.on('end', () => res(Buffer.concat(chunks).toString('latin1')));
}));

(async () => {
  fs.rmSync(DATA, { recursive: true, force: true });
  fs.rmSync(`${DATA}-reports`, { recursive: true, force: true });
  await boot();
  let s = await connect();
  s.emit('sessionStart', 60); await wait(200);
  s.emit('prizeStart', { name: 'Pat' }); await wait(300);
  for (let n = 1; n <= 20; n++) { s.emit('dart', { score: n, multiplier: 3 }); await wait(40); }
  s.emit('dart', { score: 25, multiplier: 1 }); await wait(600);
  check('prize game won', s.st.match && s.st.match.finished && s.st.match.winner && s.st.match.winner.name === 'Pat');
  check('recorded once before the restart', history().length === 1 && history()[0].prize.outcome === 'won', history().length);
  s.close();

  // --- the hub restarts (daily fresh start, crash, reboot - all the same) ---
  await halt(); await boot();
  s = await connect();
  check('finished prize game restored after restart', s.st.match && s.st.match.finished);
  s.emit('sessionEnd'); await wait(800);
  check('ending the session after a restart does NOT record it again', history().length === 1, history().map((h) => [h.game, h.winner]));
  const pdf = await report();
  const won = (pdf.match(/CASH PRIZE WON/g) || []).length;
  check('report shows the prize once', won === 1 && /Cash prizes paid out: -£1000\.00/.test(pdf), { won, paid: (pdf.match(/Cash prizes paid out: [^)]*\)/) || [])[0] });

  // --- a replayed game is a new game with its own record ---
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'countup', variantId: 'r5', players: [{ name: 'Rex' }] }); await wait(300);
  for (let i = 0; i < 15; i++) { s.emit('dart', { score: 20, multiplier: 1 }); await wait(30); }
  await wait(400);
  check('count-up finished and recorded', s.st.match.finished && history().length === 2, history().length);
  s.emit('restart'); await wait(300);
  for (let i = 0; i < 15; i++) { s.emit('dart', { score: 19, multiplier: 1 }); await wait(30); }
  await wait(400);
  check('restarted game that finishes again IS recorded', history().length === 3, history().length);
  s.close();
  await halt(); await boot();
  s = await connect();
  s.emit('sessionEnd'); await wait(800);
  check('...and not a fourth time after another restart', history().length === 3, history().length);
  s.close();
  await halt();

  // --- a torn history file is recovered from the previous copy ---
  const good = fs.readFileSync(`${DATA}/history.json`, 'utf8');
  fs.writeFileSync(`${DATA}/history.json`, good.slice(0, Math.floor(good.length / 2)));   // power cut mid-write
  await boot();
  s = await connect();
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'countup', variantId: 'r5', players: [{ name: 'Sue' }] }); await wait(300);
  for (let i = 0; i < 15; i++) { s.emit('dart', { score: 5, multiplier: 1 }); await wait(30); }
  await wait(500);
  const h = history();
  // The damaged file is replaced by the previous save (one game behind) -
  // before this fix the hub started with an EMPTY history and overwrote it.
  check('damaged history.json falls back to the previous save instead of empty',
    h.length === 3 && h[0].winner === 'Pat' && h[1].winner === 'Rex' && h[2].winner === 'Sue', h.map((x) => x.winner));
  check('no temp files left behind', !fs.readdirSync(DATA).some((f) => f.endsWith('.tmp')), fs.readdirSync(DATA));
  s.close();
  await halt();

  // --- history recovered from an OLDER .bak (one game behind: Pat, Rex) while
  // the finished Sue game is still on disk: it must be recorded again
  const torn = fs.readFileSync(`${DATA}/history.json`, 'utf8');
  fs.writeFileSync(`${DATA}/history.json`, torn.slice(0, Math.floor(torn.length / 2)));
  const hist = () => { try { return history() || []; } catch (_) { return []; } };   // torn or null on disk = nothing re-recorded
  await boot();
  s = await connect();
  check('history recovered from an older .bak: the finished game on disk is recorded again (once)',
    hist().length === 3 && hist()[2].winner === 'Sue' && hist().filter((x) => x.winner === 'Sue').length === 1, hist().map((x) => x.winner));
  check('...and the staff console is told the recovered copy may be a save behind',
    s.st && s.st.warnings.some((w) => /history\.json/.test(w) && /previous save/.test(w)), s.st && s.st.warnings);
  s.emit('sessionEnd'); await wait(800);
  check('...ending the session does not record it a second time', hist().length === 3, hist().length);
  s.close(); await halt();

  // --- history.json that parses to the wrong thing (null) counts as damaged
  fs.writeFileSync(`${DATA}/history.json`, 'null');
  await boot();
  s = await connect();
  check('history.json = null: the hub still serves a state, from the previous copy',
    s.st && Array.isArray(s.st.history50) && s.st.history50.length === 2, s.st && s.st.history50 && s.st.history50.length);
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'countup', variantId: 'r5', players: [{ name: 'Kim' }] }); await wait(300);
  for (let i = 0; i < 15; i++) { s.emit('dart', { score: 5, multiplier: 1 }); await wait(30); }
  await wait(500);
  check('...and the next finished game is recorded, hub still up', await alive() && hist().length === 3 && hist()[2].winner === 'Kim', hist().map((x) => x.winner));
  s.close(); await halt();

  // --- a record for a game still running (crash between the history save
  // and the match save) is dropped at boot; a torn alive.json is no drama
  const h3 = hist();
  const stale = { key: 'stale-key', at: new Date().toISOString(), game: 'countup', players: ['Zed'], winner: 'Zed', darts: 15 };
  fs.writeFileSync(`${DATA}/history.json`, JSON.stringify(h3.concat([stale])));
  fs.writeFileSync(`${DATA}/history.json.bak`, JSON.stringify(h3.concat([stale])));
  fs.writeFileSync(`${DATA}/match.json`, JSON.stringify({ gameId: 'countup', variantId: 'r5', config: { rounds: 5 }, startedAt: 'stale-key',
    players: [{ id: 'p1', name: 'Zed' }], log: [{ k: 'd', s: 20, m: 1 }] }));
  fs.writeFileSync(`${DATA}/alive.json`, '{"t":');
  fs.rmSync(`${DATA}/alive.json.bak`, { force: true });
  await boot();
  s = await connect();
  check('unfinished game whose record is already in history: the record is dropped at boot',
    hist().length === 3 && !hist().some((x) => x.key === 'stale-key') && s.st && s.st.match && !s.st.match.finished, hist().map((x) => x.winner));
  check('torn alive.json: no warning, nothing set aside for a hand recovery, a fresh stamp written',
    s.st && !s.st.warnings.some((w) => /alive\.json/.test(w)) && !fs.readdirSync(DATA).some((f) => /^alive\.json\.damaged/.test(f))
      && JSON.parse(fs.readFileSync(`${DATA}/alive.json`, 'utf8')).t > 0,
    { warnings: s.st && s.st.warnings, files: fs.readdirSync(DATA).filter((f) => /alive/.test(f)) });
  s.close(); await halt();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { hub.kill(); } catch (_) {} process.exit(1); });
