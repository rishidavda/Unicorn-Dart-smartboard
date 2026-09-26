/* Sticky home ports with a hand-set settings.ini PORT, both start orders,
 * the false "Wrong address!" warning, legacy migration, deliberate change,
 * the upgrade's shipped PORT=8080, a copied folder. TPORT = first of seven ports. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const dgram = require('dgram');
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
const setting = (name) => JSON.parse(fs.readFileSync(`${SP}/ports-${name}/settings.json`, 'utf8'));
(async () => {
  for (const n of ['A', 'B', 'L', 'C']) fs.rmSync(`${SP}/ports-${n}`, { recursive: true, force: true });
  const P = Number(process.env.TPORT || 8946);
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
  const L = process.env.TPORT ? P + 4 : 8080;
  fs.mkdirSync(`${SP}/ports-L`, { recursive: true });
  fs.writeFileSync(`${SP}/ports-L/settings.json`, JSON.stringify({ savedPort: L, autoConnect: false }));
  await boot('L', L);
  const l1 = await where(L);
  check('legacy 8080 home still honoured and gets its origin recorded', l1 && l1.port === L && !l1.displaced && setting('L').savedPortFrom === L, { l1, from: setting('L').savedPortFrom });
  await halt('L');

  // a deliberate settings.ini change moves the board
  const H = P + 5;
  await boot('A', H);
  const a4 = await where(H);
  check('changing PORT in settings.ini moves the board (no warning)', a4 && a4.id === idA && a4.port === H && !a4.displaced, a4);
  await halt('A');

  // an upgrade unzips the shipped settings.ini (PORT=8080) over the folder:
  // the hand-set home must survive it, and so must its origin
  await boot('A', 8080);
  const a5 = await where(H);
  check('upgrade ships PORT=8080: the hand-set home is kept, screens still reach it', a5 && a5.id === idA && a5.port === H && a5.home === H && !a5.displaced, a5);
  check('...and the home\'s origin is not rewritten to 8080', setting('A').savedPort === H && setting('A').savedPortFrom === H, [setting('A').savedPort, setting('A').savedPortFrom]);
  await halt('A');
  await boot('A', H);
  const a6 = await where(H);
  check('PORT set back by hand: still at home, no warning', a6 && a6.port === H && a6.home === H && !a6.displaced, a6);
  await halt('A');

  // a genuinely displaced home still warns: A's home held by a stranger
  const net = require('net');
  const stranger = net.createServer().listen(H);
  await wait(200);
  await boot('A', H);
  await wait(11000);                         // hold tries (2 x 5 s) then steps up
  const a7 = await where(H + 1);
  check('home genuinely taken: still warns, home not overwritten', a7 && a7.displaced && a7.home === H, a7);
  await halt('A'); stranger.close();
  check('...and the saved home stays 8956', setting('A').savedPort === H, setting('A').savedPort);

  // a folder copied from A, data\ and all, must not claim A's home
  await boot('A', H);
  fs.cpSync(`${SP}/ports-A`, `${SP}/ports-C`, { recursive: true });
  fs.rmSync(`${SP}/ports-C/hub.lock`, { force: true });
  await boot('C', H);
  const c1 = await where(H + 1), a8 = await where(H);
  check('copied folder: on the next port within seconds, no warning', c1 && !c1.displaced && c1.port === H + 1 && a8 && a8.port === H && !a8.displaced, { c1, a8 });
  check('copied folder: claims that port as its own home', setting('C').savedPort === H + 1 && setting('A').savedPort === H, [setting('C').savedPort, setting('A').savedPort]);
  await halt('C');
  // a copy made with an older version has no record of where its home was
  // saved: it claims A's, runs displaced - until the discovery scan spots
  // the shared identity and heals it, home and all
  const cs = setting('C');
  delete cs.savedPortAt; cs.savedPort = H; cs.savedPortFrom = H; cs.discoveryId = idA;
  fs.writeFileSync(`${SP}/ports-C/settings.json`, JSON.stringify(cs));
  await boot('C', H);
  await wait(11000);
  const c2 = await where(H + 1);
  check('old-style copy: claims the original\'s home and runs displaced', c2 && c2.displaced && c2.home === H && c2.id === idA, c2);
  await halt('A');                           // only the copy must react to the probe below
  const probe = dgram.createSocket('udp4');
  await new Promise((r) => probe.bind(0, () => { probe.setBroadcast(true); r(); }));
  const hello = 'WINCHDARTS_HELLO_V1 ' + JSON.stringify({ id: idA, boot: 'porttest' });
  let c3 = null;
  for (let i = 0; i < 10 && !(c3 && c3.id !== idA); i++) {
    probe.send(hello, 41786, '127.255.255.255', () => {});
    await wait(500);
    c3 = await where(H + 1);
  }
  probe.close();
  check('the scan heals it: fresh identity, warning gone, home = the port it runs on', c3 && c3.id !== idA && !c3.displaced && c3.home === H + 1 && setting('C').savedPort === H + 1, { c3, saved: setting('C').savedPort });
  check('...and the original\'s home is untouched', setting('A').savedPort === H && setting('A').discoveryId === idA, setting('A').savedPort);
  await halt('C');
  await boot('A', H); await boot('C', H);
  const c4 = await where(H + 1);
  check('healed copy restarts straight onto its own home', c4 && c4.id === c3.id && c4.port === H + 1 && c4.home === H + 1 && !c4.displaced, c4);
  await halt('A'); await halt('C');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); Object.values(hubs).forEach((h) => { try { h.kill(); } catch (_) {} }); process.exit(1); });
