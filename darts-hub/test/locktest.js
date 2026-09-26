/* The single-instance lock can never leave the oche dark: stale locks (a
 * reused pid, a pre-boot file, a torn file, a dead port) are taken over,
 * two copies started in the same tick leave exactly one, every way of
 * closing the hub removes the lock, and a fresh WinchesterDarts.exe takes
 * over from an orphaned hub. Also: stray .tmp files, damaged history set
 * aside with a warning, and a game's record replaced/removed around undo.
 * TPORT = first of four ports. */
const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const fs = require('fs');
const os = require('os');
const http = require('http');
const { spawn } = require('child_process');
const { io } = require('socket.io-client');
const { chromium } = require('playwright-core');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const SERVER = process.env.SERVER_JS || require('path').join(HERE, '..', 'server', 'server.js');
const P = Number(process.env.TPORT || 8975);
let pass = 0, fail = 0;
const check = (l, ok, x) => { (ok ? pass++ : fail++); console.log(`${ok ? 'PASS' : 'FAIL'}  ${l}${x !== undefined ? ' — ' + JSON.stringify(x) : ''}`); };
const dir = (name) => `${SP}/lock-${name}`;
const lockOf = (name) => { try { return JSON.parse(fs.readFileSync(`${dir(name)}/hub.lock`, 'utf8')); } catch (_) { return null; } };
const children = [];
function start(name, port, env) {
  const out = [];
  const child = spawn('node', [`${HERE}/fakeboard.js`], {
    env: { ...process.env, SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: dir(name), DARTS_REPORTS: `${dir(name)}-reports`, DARTS_PORT_HOLD_TRIES: '1', ...env },
    stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  child.out = out;
  child.code = 'running';
  child.done = new Promise((r) => child.once('exit', (code) => { child.code = code; r(code); }));
  children.push(child);
  return child;
}
async function stop(child, sig = 'SIGINT') { if (child.code === 'running') { child.kill(sig); } return child.done; }
const hubId = (port) => new Promise((res) => {
  const r = http.get({ host: '127.0.0.1', port, path: '/api/hub-id', timeout: 1500 }, (rs) => {
    let b = ''; rs.on('data', (c) => { b += c; }); rs.on('end', () => { try { res(JSON.parse(b)); } catch (_) { res(null); } });
  });
  r.on('timeout', () => r.destroy()); r.on('error', () => res(null));
});
async function state(port) {
  const s = io(`http://127.0.0.1:${port}`, { reconnection: false, timeout: 1500 });
  const st = await new Promise((res) => { s.once('state', res); s.once('connect_error', () => res(null)); });
  s.close(); return st;
}
async function staff(port) {
  const s = io(`http://127.0.0.1:${port}`, { reconnection: false });
  s.st = null; s.on('state', (x) => { s.st = x; });
  await wait(400);
  await new Promise((r) => s.emit('unlock', '1234', r));
  s.emit('boardDisconnect'); await wait(300);
  return s;
}
const hist = (name) => { try { return JSON.parse(fs.readFileSync(`${dir(name)}/history.json`, 'utf8')); } catch (_) { return []; } };
const dart = async (s, score, multiplier = 1) => { s.emit('dart', { score, multiplier }); await wait(60); };

(async () => {
  for (const n of ['stale', 'other', 'tick', 'sig', 'orphan', 'tmp', 'dmg', 'undo']) fs.rmSync(dir(n), { recursive: true, force: true });
  fs.mkdirSync(dir('stale'), { recursive: true });
  const sleeper = spawn('sleep', ['300']);   // a live process that is NOT a hub (a reused pid)
  const bootedAt = Date.now() - os.uptime() * 1000;

  // 1. locks that must never block a start
  const stale = async (label, lock) => {
    fs.writeFileSync(`${dir('stale')}/hub.lock`, typeof lock === 'string' ? lock : JSON.stringify(lock));
    const c = start('stale', P, {});
    await wait(3500);
    const id = await hubId(P);
    check(label, id && id.pid === c.pid && (lockOf('stale') || {}).pid === c.pid, id && id.pid);
    await stop(c);
  };
  await stale('lock naming a live unrelated process with a dead port: hub starts', { pid: sleeper.pid, at: 'x', startedAt: Date.now(), port: P + 3, folder: 'x' });
  await stale('lock naming a live unrelated process, "starting" for 10 minutes: hub starts', { pid: sleeper.pid, at: 'x', startedAt: Date.now() - 600000 });
  await stale('lock from before this boot: hub starts', { pid: sleeper.pid, at: 'x', startedAt: bootedAt - 3600000 });
  await stale('unreadable lock: hub starts', '{"pid":');
  fs.writeFileSync(`${dir('stale')}/hub.lock`, JSON.stringify({ pid: sleeper.pid, at: 'x', startedAt: Date.now() }));
  let c = start('stale', P, {});
  let code = await Promise.race([c.done, wait(6000).then(() => 'still running')]);
  check('a lock taken seconds ago by a live process is respected (exit 64)', code === 64 && /ALREADY STARTING/.test(c.out.join('')), code);
  await stop(c);
  // a hub of ANOTHER folder answering on the lock's port proves nothing
  const other = start('other', P + 1, {});
  await wait(2500);
  fs.writeFileSync(`${dir('stale')}/hub.lock`, JSON.stringify({ pid: other.pid, at: 'x', startedAt: Date.now(), port: P + 1 }));
  c = start('stale', P, {});
  await wait(3500);
  check('lock whose port is held by a hub of a different folder: hub starts', ((await hubId(P)) || {}).pid === c.pid, (await hubId(P)) && (await hubId(P)).pid);
  await stop(other);
  // ...but a hub that does answer for this folder is left alone
  const before = lockOf('stale');
  const d = start('stale', P + 2, {});
  code = await Promise.race([d.done, wait(8000).then(() => 'still running')]);
  check('a hub that answers on its port is left alone (exit 64)', code === 64 && /ALREADY RUNNING/.test(d.out.join('')), code);
  check('...and its lock is untouched', JSON.stringify(lockOf('stale')) === JSON.stringify(before));
  await stop(c);
  check('lock removed on exit', !fs.existsSync(`${dir('stale')}/hub.lock`));

  // 2. two copies started in the same instant (startup shortcut + logon task)
  for (let i = 1; i <= 3; i++) {
    fs.rmSync(dir('tick'), { recursive: true, force: true });
    const a = start('tick', P, {}), b = start('tick', P, {});
    await wait(5000);
    const codes = [a.code, b.code];
    const alive = [a, b].filter((x) => x.code === 'running');
    const id = await hubId(P);
    check(`same-tick start ${i}: exactly one hub survives`, alive.length === 1 && codes.includes(64) && id && id.pid === alive[0].pid, { codes, pid: id && id.pid });
    for (const x of [a, b]) await stop(x);
  }

  // 3. every way of closing the hub removes the lock
  for (const sig of ['SIGTERM', 'SIGHUP', 'SIGINT']) {
    fs.rmSync(dir('sig'), { recursive: true, force: true });
    const s = start('sig', P, {});
    await wait(2500);
    check(`${sig}: lock carries the port while running`, (lockOf('sig') || {}).port === P, lockOf('sig'));
    code = await stop(s, sig);
    check(`${sig}: hub exits and removes the lock`, code === 0 && !fs.existsSync(`${dir('sig')}/hub.lock`), code);
  }

  // 4. an orphan (its exe ended in Task Manager) hands over to a new exe
  const deadLauncher = spawn('sleep', ['300']);
  deadLauncher.kill('SIGKILL'); await new Promise((r) => deadLauncher.once('exit', r));
  const a = start('orphan', P, { WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(deadLauncher.pid), DAILY_RESTART: '09:00' });
  await wait(2500);
  const aid = await hubId(P);
  check('orphan: hub-id says so', aid && aid.orphan === true && aid.pid === a.pid, aid);
  let s = await staff(P);
  check('orphan: staff card explains the exe was ended and how to take over',
    s.st && s.st.server.freshStart === null && /WinchesterDarts\.exe was ended/.test(s.st.server.freshStartNote || '') && /takes over/.test(s.st.server.freshStartNote || ''), s.st && s.st.server.freshStartNote);
  s.emit('savePlayers', [{ id: 'p1', name: 'Orphan Annie' }]); await wait(300);
  s.close();
  const plain = start('orphan', P, {});
  code = await Promise.race([plain.done, wait(8000).then(() => 'still running')]);
  check('plain start (npm start) beside an orphan still refuses', code === 64 && /double-click WinchesterDarts\.exe and it takes over/.test(plain.out.join('')), code);
  const b = start('orphan', P, { WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(sleeper.pid), DAILY_RESTART: '09:00' });
  code = await Promise.race([a.done, wait(15000).then(() => 'still running')]);
  check('new exe: the orphan saves and exits', code === 0, code);
  await wait(4000);
  const bid = await hubId(P);
  check('new exe: comes up on the home port with the lock', bid && bid.pid === b.pid && bid.orphan === false && (lockOf('orphan') || {}).pid === b.pid, bid);
  const bst = await state(P);
  check('new exe: data intact and the fresh start back on', bst && bst.roster.some((p) => p.name === 'Orphan Annie') && bst.server.freshStart === `09:0${P % 10}`, bst && [bst.roster, bst.server.freshStart]);
  await stop(b);

  // 5. a power cut mid-save leaves <name>.json.tmp behind
  fs.mkdirSync(dir('tmp'), { recursive: true });
  fs.writeFileSync(`${dir('tmp')}/history.json.tmp`, '[{"half":');
  fs.writeFileSync(`${dir('tmp')}/settings.json.tmp`, '{"half":');
  c = start('tmp', P, {});
  await wait(2500);
  check('stray .json.tmp files removed at boot', !fs.readdirSync(dir('tmp')).some((f) => f.endsWith('.tmp')), fs.readdirSync(dir('tmp')));
  await stop(c);

  // 6. history.json AND its .bak both damaged
  fs.mkdirSync(dir('dmg'), { recursive: true });
  fs.writeFileSync(`${dir('dmg')}/history.json`, '[{"winner":"Pat"');
  fs.writeFileSync(`${dir('dmg')}/history.json.bak`, '[{"winn');
  c = start('dmg', P, {});
  await wait(2500);
  let files = fs.readdirSync(dir('dmg'));
  check('both copies damaged: set aside under .damaged-<time>', files.some((f) => /^history\.json\.damaged-/.test(f)) && files.some((f) => /^history\.json\.bak\.damaged-/.test(f)) && !files.includes('history.json'), files);
  s = await staff(P);
  check('...and the staff console is warned', s.st && s.st.warnings.length === 1 && /history\.json .*damaged/.test(s.st.warnings[0]) && /damaged-/.test(s.st.warnings[0]), s.st && s.st.warnings);
  check('...history starts empty', s.st && s.st.history50.length === 0);
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'countup', variantId: 'r5', players: [{ name: 'Sue' }] }); await wait(300);
  for (let i = 0; i < 15; i++) await dart(s, 5);
  await wait(400);
  check('new games recorded after the set-aside', hist('dmg').length === 1 && hist('dmg')[0].winner === 'Sue', hist('dmg').length);
  s.close(); await stop(c);
  // main damaged, .bak good: the recovery must not be undone by the next save
  const good = JSON.stringify([{ winner: 'A' }, { winner: 'B' }, { winner: 'C' }]);
  fs.writeFileSync(`${dir('dmg')}/history.json.bak`, good);
  fs.writeFileSync(`${dir('dmg')}/history.json`, good.slice(0, 20));
  // Sue's finished game is still on disk and missing from this .bak: it
  // would (rightly) be recorded again at boot - not what this step counts.
  fs.rmSync(`${dir('dmg')}/match.json`, { force: true }); fs.rmSync(`${dir('dmg')}/match.json.bak`, { force: true });
  c = start('dmg', P, {});
  await wait(2500);
  s = await staff(P);
  s.emit('sessionStart', 60); await wait(200);
  s.emit('newMatch', { gameId: 'countup', variantId: 'r5', players: [{ name: 'Rex' }] }); await wait(300);
  for (let i = 0; i < 15; i++) await dart(s, 5);
  await wait(400);
  const bak1 = JSON.parse(fs.readFileSync(`${dir('dmg')}/history.json.bak`, 'utf8'));
  check('recovered from .bak: the first save keeps the good .bak (never the damaged file)', bak1.length === 3 && hist('dmg').length === 4 && s.st.warnings.length === 1 && /previous save was used/.test(s.st.warnings[0]), { bak: bak1.length, warnings: s.st.warnings });
  s.emit('restart'); await wait(300);
  for (let i = 0; i < 15; i++) await dart(s, 5);
  await wait(400);
  const bak2 = JSON.parse(fs.readFileSync(`${dir('dmg')}/history.json.bak`, 'utf8'));
  check('...and the second save rolls the .bak forward as usual', bak2.length === 4 && hist('dmg').length === 5, { bak: bak2.length, hist: hist('dmg').length });
  s.close(); await stop(c);

  // 7. one record per game, whatever undo does to its result
  const players = [{ name: 'Sue' }, { name: 'Rex' }];
  const x01 = (sock) => { sock.emit('newMatch', { gameId: 'x01', variantId: '301', config: { startScore: 60, doubleOut: false }, players }); };
  const rec = () => hist('undo').map((h) => [h.winner, h.darts]);
  c = start('undo', P, {});
  await wait(2500);
  s = await staff(P);
  s.emit('sessionStart', 60); await wait(200);
  x01(s); await wait(300);
  await dart(s, 20); await dart(s, 20); await dart(s, 20);
  await wait(300);
  check('x01 finished: Sue recorded', s.st.match.finished && rec().length === 1 && rec()[0][0] === 'Sue', rec());
  s.emit('undo'); await wait(300);
  check('undo of the finishing dart reopens the game and removes its record', !s.st.match.finished && rec().length === 0, rec());
  await dart(s, 1); await dart(s, 20, 3);
  await wait(300);
  check('a different winner after the undo: still one record, now Rex', s.st.match.finished && rec().length === 1 && rec()[0][0] === 'Rex' && rec()[0][1] === 4, rec());
  s.emit('undo'); await wait(300);
  await dart(s, 20); await dart(s, 20); await dart(s, 20);
  await wait(300);
  check('same winner re-finishing after an undo: the record is corrected, not doubled', rec().length === 1 && rec()[0][0] === 'Rex' && rec()[0][1] === 6, rec());
  s.close(); await stop(c);
  c = start('undo', P, {});
  await wait(2500);
  s = await staff(P);
  check('finished game restored after a restart, one record', s.st.match && s.st.match.finished && rec().length === 1);
  s.emit('undo'); await wait(300);
  check('undo after the restart removes the record too', !s.st.match.finished && rec().length === 0, rec());
  await dart(s, 20);
  await wait(300);
  check('re-finish after that: recorded once', s.st.match.finished && rec().length === 1 && rec()[0][0] === 'Rex', rec());
  s.emit('restart'); await wait(300);
  await dart(s, 20); await dart(s, 20); await dart(s, 20);
  await wait(300);
  check('a replayed game is a new record', rec().length === 2 && rec()[1][0] === 'Sue', rec());
  const api = await new Promise((res) => http.get(`http://127.0.0.1:${P}/api/history`, (r) => { let b = ''; r.on('data', (x) => { b += x; }); r.on('end', () => res(JSON.parse(b))); }));
  check('/api/history agrees', api.history.length === 2, api.history.map((h) => h.winner));
  const br = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium' });
  const pg = await br.newPage({ viewport: { width: 1280, height: 900 } });
  await pg.goto(`http://127.0.0.1:${P}/board`);
  await wait(2500);
  const rows = await pg.$$eval('#rows tr', (trs) => trs.map((tr) => [...tr.querySelectorAll('td')].slice(1, 4).map((td) => td.textContent.trim())));
  const row = (n) => rows.find((r) => r[0] === n) || [];
  check('leaderboard: Rex 1 win of 2 played, Sue 1 of 2 - no ghost wins', rows.length === 2 && row('Rex')[1] === '1' && row('Rex')[2] === '2' && row('Sue')[1] === '1' && row('Sue')[2] === '2', rows);
  await br.close();
  s.close(); await stop(c);

  sleeper.kill('SIGKILL');
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); children.forEach((h) => { try { h.kill(); } catch (_) {} }); process.exit(1); });
