/* Sticky home ports with a hand-set settings.ini PORT, both start orders,
 * the false "Wrong address!" warning, legacy migration (two legacy homes
 * through the upgrade's PORT=8080 and a re-typed hand-set port), deliberate
 * change, the upgrade's shipped PORT=8080, a renamed folder, a copied folder
 * (started second, started first, and Find boards from its console).
 * TPORT = first of seven ports. */
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
// What Find boards on a hub with identity `id` sends out: probe until the hub on `port` answers `healed`.
async function scan(id, port, healed) {
  const probe = dgram.createSocket('udp4');
  await new Promise((r) => probe.bind(0, () => { probe.setBroadcast(true); r(); }));
  const hello = 'WINCHDARTS_HELLO_V1 ' + JSON.stringify({ id, boot: 'porttest' });
  let st = null;
  for (let i = 0; i < 10 && !healed(st); i++) {
    probe.send(hello, 41786, '127.255.255.255', () => {});
    await wait(500);
    st = await where(port);
  }
  probe.close();
  return st;
}
(async () => {
  for (const n of ['A', 'B', 'B2', 'L', 'L1', 'L2', 'C', 'C2', 'D', 'E']) fs.rmSync(`${SP}/ports-${n}`, { recursive: true, force: true });
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

  // B's folder renamed (a tidy-up, Downloads -> C:\): it is still B, not a
  // copy - even started first it must leave A's 8946 alone
  fs.renameSync(`${SP}/ports-B`, `${SP}/ports-B2`);
  await boot('B2', P); await boot('A', P);
  const b4 = await where(P + 1), a3 = await where(P);
  check('renamed folder started first: keeps its own port, A keeps its own', b4 && b4.id === idB && b4.port === P + 1 && !b4.displaced && a3 && a3.id === idA && a3.port === P && !a3.displaced, { b4, a3 });
  check('...and its home is re-signed for the new folder', setting('B2').savedPort === P + 1 && setting('B2').savedPortPath === require('path').resolve(`${SP}/ports-B2`), setting('B2').savedPortPath);
  await halt('A'); await halt('B2');

  // legacy data (home saved before this release, no savedPortFrom): migrates
  const L = process.env.TPORT ? P + 4 : 8080;
  fs.mkdirSync(`${SP}/ports-L`, { recursive: true });
  fs.writeFileSync(`${SP}/ports-L/settings.json`, JSON.stringify({ savedPort: L, autoConnect: false }));
  await boot('L', L);
  const l1 = await where(L);
  check('legacy home still honoured and gets its origin recorded (never as the shipped 8080)', l1 && l1.port === L && !l1.displaced && setting('L').savedPortFrom === (L === 8080 ? undefined : L), { l1, from: setting('L').savedPortFrom });
  await halt('L');
  // two legacy homes claimed from a hand-set PORT go through the upgrade's
  // PORT=8080 run: 8080 must not be recorded as their origin, or re-typing
  // the hand-set port afterwards reads as a move and the boards can swap
  for (const [n, port] of [['L1', P + 2], ['L2', P + 3]]) {
    fs.mkdirSync(`${SP}/ports-${n}`, { recursive: true });
    fs.writeFileSync(`${SP}/ports-${n}/settings.json`, JSON.stringify({ savedPort: port, autoConnect: false }));
  }
  await boot('L1', 8080); await boot('L2', 8080);
  const l2a = await where(P + 2), l2b = await where(P + 3);
  check('upgrade run (PORT=8080) keeps both legacy homes', l2a && l2b && l2a.port === P + 2 && l2b.port === P + 3 && !l2a.displaced && !l2b.displaced, { l2a, l2b });
  check('...without recording 8080 as their origin', setting('L1').savedPortFrom === undefined && setting('L2').savedPortFrom === undefined, [setting('L1').savedPortFrom, setting('L2').savedPortFrom]);
  await halt('L1'); await halt('L2');
  await boot('L2', P + 2); await boot('L1', P + 2);
  const l3a = await where(P + 2), l3b = await where(P + 3);
  check('hand-set PORT re-typed into both, second board first: no swap', l3a && l3b && l3a.id === l2a.id && l3b.id === l2b.id && !l3a.displaced && !l3b.displaced, { l3a, l3b });
  check('...and that port is now the recorded origin of both homes', setting('L1').savedPortFrom === P + 2 && setting('L2').savedPortFrom === P + 2, [setting('L1').savedPortFrom, setting('L2').savedPortFrom]);
  await halt('L1'); await halt('L2');

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
  await halt('C'); await halt('A');

  // a copy made with everything closed and started FIRST: A's home is free,
  // but it is A's - the copy steps past it and A gets it back
  const as = setting('A'); as.boardUuid = 'aabbccddeeff';
  fs.writeFileSync(`${SP}/ports-A/settings.json`, JSON.stringify(as));
  fs.cpSync(`${SP}/ports-A`, `${SP}/ports-C2`, { recursive: true });
  fs.rmSync(`${SP}/ports-C2/hub.lock`, { force: true });
  await boot('C2', H); await boot('A', H);
  const c5 = await where(H + 1), a9 = await where(H);
  check('copy started first: steps past the inherited home, the original gets it back', c5 && c5.port === H + 1 && !c5.displaced && a9 && a9.id === idA && a9.port === H && !a9.displaced, { c5, a9 });
  check('...and each folder saves its own', setting('C2').savedPort === H + 1 && setting('A').savedPort === H, [setting('C2').savedPort, setting('A').savedPort]);
  // Find boards pressed on the COPY's console: its probe carries the shared
  // id to both hubs - only the copy may take it as "you are the clone"
  const c6 = await scan(idA, H + 1, (s) => s && s.id !== idA);
  const a10 = await where(H);
  check('Find boards from the copy: the copy heals - fresh id, board lock dropped, own home kept', c6 && c6.id !== idA && !c6.displaced && c6.home === H + 1 && setting('C2').savedPort === H + 1 && setting('C2').boardUuid === '', { c6, saved: setting('C2').savedPort, board: setting('C2').boardUuid });
  check('...and the original keeps its id, its board and its home', a10 && a10.id === idA && a10.port === H && !a10.displaced && setting('A').discoveryId === idA && setting('A').boardUuid === 'aabbccddeeff' && setting('A').savedPort === H, { a10, saved: setting('A').savedPort, board: setting('A').boardUuid });
  await halt('C2');
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
  const c3 = await scan(idA, H + 1, (s) => s && s.id !== idA);
  check('the scan heals it: fresh identity, warning gone, home = the port it runs on', c3 && c3.id !== idA && !c3.displaced && c3.home === H + 1 && setting('C').savedPort === H + 1, { c3, saved: setting('C').savedPort });
  check('...and the original\'s home is untouched', setting('A').savedPort === H && setting('A').discoveryId === idA, setting('A').savedPort);
  await halt('C');
  await boot('A', H); await boot('C', H);
  const c4 = await where(H + 1);
  check('healed copy restarts straight onto its own home', c4 && c4.id === c3.id && c4.port === H + 1 && c4.home === H + 1 && !c4.displaced, c4);
  await halt('A'); await halt('C');

  // the original itself displaced (a stranger on its home) and probed with
  // its own id: whatever it takes as the clone's cue, its home is not up for grabs
  const stranger2 = net.createServer().listen(H);
  await wait(200);
  await boot('A', H);
  await wait(11000);
  const idNow = setting('A').discoveryId;
  const a11 = await scan(idNow, H + 1, (s) => s && s.id !== idNow);
  check('displaced original probed: never adopts its refuge as home, still warns', a11 && a11.port === H + 1 && a11.displaced && a11.home === H && setting('A').savedPort === H, { a11, saved: setting('A').savedPort });
  await halt('A'); stranger2.close();

  // A "looks like a move" verdict is a single existsSync check at one
  // instant - wrong for a moment (a USB stick not yet mounted, a network
  // share still connecting) while the real original is actually alive and
  // holding that port must never be trusted permanently: the copy loses the
  // race, and its settings.json must be left exactly as it was, not stamped
  // with a false "this port is mine" that would survive for ever.
  const G = H + 2;
  await boot('D', G);
  const d1 = await where(G);
  const dSettings = setting('D');
  fs.mkdirSync(`${SP}/ports-E`, { recursive: true });
  fs.writeFileSync(`${SP}/ports-E/settings.json`, JSON.stringify({
    ...dSettings, savedPort: dSettings.savedPort,
    savedPortAt: 'some-other-folder', savedPortPath: '/does/not/exist/right-now', boardUuid: '',
  }));
  await boot('E', G);       // same settings.ini PORT as D's own - D is still running on it
  await wait(11000);        // the port-hold + fallback takes longer than boot()'s own wait
  const e1 = await where(G + 1);
  check('a copy that loses a live race for the port it looks like it moved to is displaced, not merged with the original', e1 && e1.displaced && e1.home === G, { e1, d1 });
  check('...and its settings are left untouched - no false "this is my home" is ever written', setting('E').savedPortAt === 'some-other-folder' && setting('E').savedPortPath === '/does/not/exist/right-now', setting('E'));
  await halt('D'); await halt('E');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); Object.values(hubs).forEach((h) => { try { h.kill(); } catch (_) {} }); process.exit(1); });
