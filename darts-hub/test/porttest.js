/* Sticky home ports with a hand-set settings.ini PORT, both start orders,
 * the false "Wrong address!" warning, legacy migration, deliberate change. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = process.env.SERVER_JS || require('path').join(HERE, '..', 'server', 'server.js');
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
const hubs = {};
async function boot(name, iniPort) {
  hubs[name] = spawn('node', [`${HERE}/fakeboard.js`], {
    env: { ...process.env, SERVER_JS: SERVER, PORT: String(iniPort), DARTS_DATA: `${SP}/ports-${name}`, DARTS_PORT_HOLD_TRIES: '2' },
    stdio: 'ignore' });
  await wait(2200);
}
async function halt(name) { const h = hubs[name]; h.kill('SIGINT'); await new Promise((r) => h.once('exit', r)); }
async function where(port) {
  const s = io(`http://127.0.0.1:${port}`, { reconnection: false, timeout: 1500 });
  const st = await new Promise((res) => { s.once('state', res); s.once('connect_error', () => res(null)); });
  s.close();
  return st && { name: st.settings.boardName, port: st.server.port, home: st.server.homePort, displaced: st.server.displaced, id: st.settings.discoveryId };
}
(async () => {
  for (const n of ['A', 'B', 'L']) fs.rmSync(`${SP}/ports-${n}`, { recursive: true, force: true });
  const P = 8946;
  // first ever boot: A then B, both settings.ini PORT=8946
  await boot('A', P); await boot('B', P);
  const a1 = await where(P), b1 = await where(P + 1);
  check('first boot: A on 8946, B steps to 8947, no warning', a1 && b1 && a1.port === P && b1.port === P + 1 && !a1.displaced && !b1.displaced, { a1, b1 });
  const idA = a1.id, idB = b1.id;
  await halt('A'); await halt('B');
  // reboot in the OTHER order: B first - must take its own 8947, not A's 8946
  await boot('B', P); await boot('A', P);
  const a2 = await where(P), b2 = await where(P + 1);
  check('reboot B-first: each board back on its own port', a2 && b2 && a2.id === idA && b2.id === idB, { a2, b2 });
  check('reboot: no false "Wrong address!" on either', a2 && b2 && !a2.displaced && !b2.displaced);
  // B restarts on its own while A holds 8946 (the daily fresh start case)
  await halt('B'); await boot('B', P);
  const b3 = await where(P + 1);
  check('B relaunched alone: home 8947, no warning', b3 && b3.id === idB && b3.port === P + 1 && !b3.displaced, b3);
  await halt('A'); await halt('B');

  // legacy data (home saved before this release, no savedPortFrom): migrates
  fs.mkdirSync(`${SP}/ports-L`, { recursive: true });
  fs.writeFileSync(`${SP}/ports-L/settings.json`, JSON.stringify({ savedPort: 8080, autoConnect: false }));
  await boot('L', 8080);
  const l1 = await where(8080);
  const lset = JSON.parse(fs.readFileSync(`${SP}/ports-L/settings.json`, 'utf8'));
  check('legacy 8080 home still honoured and gets its origin recorded', l1 && l1.port === 8080 && !l1.displaced && lset.savedPortFrom === 8080, { l1, from: lset.savedPortFrom });
  await halt('L');

  // a deliberate settings.ini change moves the board
  await boot('A', 8956);
  const a4 = await where(8956);
  check('changing PORT in settings.ini moves the board (no warning)', a4 && a4.id === idA && a4.port === 8956 && !a4.displaced, a4);
  await halt('A');

  // a genuinely displaced home still warns: A's home 8956 held by a stranger
  const net = require('net');
  const stranger = net.createServer().listen(8956);
  await wait(200);
  await boot('A', 8956);
  await wait(11000);                         // hold tries (2 x 5 s) then steps up
  const a5 = await where(8957);
  check('home genuinely taken: still warns, home not overwritten', a5 && a5.displaced && a5.home === 8956, a5);
  await halt('A'); stranger.close();
  const aset = JSON.parse(fs.readFileSync(`${SP}/ports-A/settings.json`, 'utf8'));
  check('...and the saved home stays 8956', aset.savedPort === 8956, aset.savedPort);
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); Object.values(hubs).forEach((h) => { try { h.kill(); } catch (_) {} }); process.exit(1); });
