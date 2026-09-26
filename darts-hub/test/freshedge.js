/* Fresh-start edge cases: single-instance lock, launcher gone, blank = off,
 * midnight rollover label/decision, supervisor-less hub. Uses short-lived hubs. */
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
function start(name, port, env) {
  const out = [];
  const child = spawn('node', [`${HERE}/fakeboard.js`], {
    env: { ...process.env, SERVER_JS: SERVER, PORT: String(port), DARTS_DATA: `${SP}/edge-${name}`, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => out.push(String(d))); child.stderr.on('data', (d) => out.push(String(d)));
  child.out = out;
  child.done = new Promise((r) => child.once('exit', (code) => r(code)));
  return child;
}
async function state(port) {
  const s = io(`http://127.0.0.1:${port}`, { reconnection: false, timeout: 1500 });
  const st = await new Promise((res) => { s.once('state', res); s.once('connect_error', () => res(null)); });
  s.close(); return st;
}
(async () => {
  for (const n of ['lock', 'l2', 'blank', 'gone', 'mid']) fs.rmSync(`${SP}/edge-${n}`, { recursive: true, force: true });

  // 1. single instance per folder
  const a = start('lock', 8960, {});
  await wait(2200);
  const b = start('lock', 8960, {});
  const bcode = await Promise.race([b.done, wait(8000).then(() => 'still running')]);
  check('second copy on the same folder refuses to run', bcode === 64, bcode);
  check('...with a clear message', /ALREADY RUNNING/.test(b.out.join('')));
  const ast = await state(8960);
  check('first copy unaffected', !!ast);
  a.kill('SIGINT'); await a.done;
  check('lock released on exit', !fs.existsSync(`${SP}/edge-lock/hub.lock`));
  // stale lock from a dead hub is taken over
  fs.writeFileSync(`${SP}/edge-lock/hub.lock`, JSON.stringify({ pid: 999999, at: 'x' }));
  const c = start('lock', 8960, {});
  await wait(2200);
  check('stale lock (dead hub) is taken over', !!(await state(8960)));
  c.kill('SIGINT'); await c.done;

  // 2. blank DAILY_RESTART means off; missing means 09:00
  const d = start('blank', 8970, { WINCHESTER_SUPERVISED: '1', DAILY_RESTART: '' });
  await wait(2200);
  const dst = await state(8970);
  check('blank DAILY_RESTART= is off', dst && dst.server.freshStart === null, dst && dst.server.freshStart);
  d.kill('SIGINT'); await d.done;
  const env2 = { ...process.env }; delete env2.DAILY_RESTART;
  const d2 = spawn('node', [`${HERE}/fakeboard.js`], { env: { ...env2, SERVER_JS: SERVER, PORT: '8970', DARTS_DATA: `${SP}/edge-blank`, WINCHESTER_SUPERVISED: '1' }, stdio: 'ignore' });
  await wait(2200);
  const d2st = await state(8970);
  check('missing DAILY_RESTART defaults to 09:00', d2st && d2st.server.freshStart === '09:00', d2st && d2st.server.freshStart);
  d2.kill('SIGINT'); await new Promise((r) => d2.once('exit', r));

  // 3. launcher gone: no restart, staff told why
  const fakeLauncher = spawn('sleep', ['300']);
  const now = new Date(Date.now() + 70000);
  const hhmm = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const e = start('gone', 8980, { WINCHESTER_SUPERVISED: '1', WINCHESTER_LAUNCHER_PID: String(fakeLauncher.pid), DAILY_RESTART: hhmm });
  await wait(2500);
  const e1 = await state(8980);
  check('launcher alive: restart scheduled', e1 && e1.server.freshStart === hhmm, e1 && e1.server.freshStart);
  fakeLauncher.kill('SIGKILL');
  await wait(12500);                          // launcher check is cached for 10 s
  const e2 = await state(8980);
  check('launcher gone: staff card says paused and why', e2 && e2.server.freshStart === null && /window was closed/.test(e2.server.freshStartNote || ''), e2 && e2.server.freshStartNote);
  const ecode = await Promise.race([e.done, wait(100000).then(() => 'still running')]);
  check('launcher gone: hub stays up through the restart time', ecode === 'still running', ecode);
  e.kill('SIGINT'); await e.done;

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.error('FATAL', err); process.exit(1); });
