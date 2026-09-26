const HERE = __dirname;
const SP = process.env.DARTS_TEST_TMP || require('path').join(require('os').tmpdir(), 'winchester-test');
require('fs').mkdirSync(SP, { recursive: true });
const { spawn } = require('child_process');
const fs = require('fs');
const { io } = require('socket.io-client');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = process.env.TPORT || '8893';
async function probe(label, env, expect) {
  fs.rmSync(`${SP}/hubOff`, { recursive: true, force: true });
  const c = spawn('node', [process.env.SERVER_JS || require('path').join(HERE, '..', 'server', 'server.js')],
    { env: { ...process.env, PORT, DARTS_DATA: `${SP}/hubOff`, ...env }, stdio: 'ignore' });
  await wait(2500);
  const s = io(`http://127.0.0.1:${PORT}`);
  const st = await new Promise((r) => s.once('state', r));
  const ok = st.server.freshStart === expect;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label} — freshStart=${JSON.stringify(st.server.freshStart)}`);
  s.close(); c.kill(); await wait(800);
  return ok;
}
(async () => {
  const r = [
    await probe('not started by the exe: never restarts itself', { DAILY_RESTART: '09:00' }, null),
    await probe('DAILY_RESTART=OFF disables it', { WINCHESTER_SUPERVISED: '1', DAILY_RESTART: 'OFF' }, null),
    await probe('blank DAILY_RESTART= is off (missing = 09:00 is checked in freshedge)', { WINCHESTER_SUPERVISED: '1', DAILY_RESTART: '' }, null),
    await probe('custom time honoured', { WINCHESTER_SUPERVISED: '1', DAILY_RESTART: '06:30' }, `06:3${Number(PORT) % 10}`),
    await probe('nonsense time is treated as off', { WINCHESTER_SUPERVISED: '1', DAILY_RESTART: '25:99' }, null),
  ];
  process.exit(r.every(Boolean) ? 0 : 1);
})();
