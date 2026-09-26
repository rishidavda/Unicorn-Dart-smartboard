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
async function halt() { hub.kill('SIGINT'); await new Promise((r) => hub.once('exit', r)); await wait(300); }
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
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch(async (e) => { console.error('FATAL', e); try { hub.kill(); } catch (_) {} process.exit(1); });
