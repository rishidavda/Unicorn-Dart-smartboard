/*
 * A fake Tapo smart plug: the plug's own local HTTP API, both handshakes,
 * so the hub's driver is exercised for real rather than mocked away.
 *
 *   FAKE_PLUG_PORT=n            listen on 127.0.0.1:n (default 9300)
 *   FAKE_PLUG_MODE=klap|legacy  which protocol this plug speaks (default klap)
 *   FAKE_PLUG_EMAIL / FAKE_PLUG_PASSWORD   the Tapo account it accepts
 *   FAKE_PLUG_COMPAT=0          firmware 1.4+ with the Tapo app's Third-Party
 *                               Compatibility switch off: handshake1 answers 403
 *                               (POST /compat?on=1 switches it on)
 *   FAKE_PLUG_SLEEP_UDP=n       asleep after a power cut: its API drops every
 *                               connection until a valid TP-Link discovery probe
 *                               (TDP v2, op 1, CRC good, an RSA key) arrives on UDP n
 *
 * Test hooks (plain JSON, no encryption):
 *   GET  /state            -> { on, sets, logins, mode, seqErrors, sigErrors }
 *   POST /fail?on=1|0      -> refuse every plug request with HTTP 503 (a plug that is off the network)
 *   POST /forget           -> drop every session (a plug that rebooted)
 *   POST /compat?on=1|0    -> the Third-Party Compatibility switch
 *   POST /sleep            -> fall asleep again (a second power cut)
 */
const http = require('http');
const crypto = require('crypto');
const dgram = require('dgram');

const PORT = Number(process.env.FAKE_PLUG_PORT || 9300);
const MODE = process.env.FAKE_PLUG_MODE === 'legacy' ? 'legacy' : 'klap';
const EMAIL = process.env.FAKE_PLUG_EMAIL || 'oche@example.com';
const PASSWORD = process.env.FAKE_PLUG_PASSWORD || 'lights123';

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const sha1 = (b) => crypto.createHash('sha1').update(b).digest();
const enc = (s) => Buffer.from(String(s), 'utf8');
const AUTH = sha256(Buffer.concat([sha1(enc(EMAIL)), sha1(enc(PASSWORD))]));

const device = { on: false, sets: 0, logins: 0, seqErrors: 0, sigErrors: 0, authErrors: 0, refused: 0, probes: 0, badProbes: 0 };
let failing = false;
let compat = process.env.FAKE_PLUG_COMPAT !== '0';
const SLEEP_UDP = Number(process.env.FAKE_PLUG_SLEEP_UDP) || 0;
let asleep = !!SLEEP_UDP;

// A TP-Link discovery probe, checked the way a plug would: header, length,
// CRC32 (computed with the seed in its place) and an RSA key in the payload.
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function validProbe(msg) {
  if (msg.length < 16 || msg[0] !== 2 || msg[1] !== 0 || msg.readUInt16BE(2) !== 1 || msg.readUInt16BE(4) !== msg.length - 16) return false;
  const crc = msg.readUInt32BE(12);
  const copy = Buffer.from(msg); copy.writeUInt32BE(0x5A6B7C8D, 12);
  if (crc32(copy) !== crc) return false;
  try { return /BEGIN PUBLIC KEY/.test(JSON.parse(msg.subarray(16).toString('utf8')).params.rsa_key); } catch (_) { return false; }
}
if (SLEEP_UDP) {
  const u = dgram.createSocket('udp4');
  u.on('message', (msg) => { if (validProbe(msg)) { device.probes++; asleep = false; } else device.badProbes++; });
  u.bind(SLEEP_UDP, '127.0.0.1');
}
const sessions = new Map();   // TP_SESSIONID -> session

function body(req) {
  return new Promise((resolve) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); });
}
function send(res, status, data, headers = {}) { res.writeHead(status, headers); res.end(data); }
function sessionOf(req) {
  const m = /TP_SESSIONID=([^;]+)/.exec(req.headers.cookie || '');
  return m ? sessions.get(m[1]) : null;
}
function newSession(extra) {
  const id = crypto.randomBytes(8).toString('hex');
  sessions.set(id, { id, ...extra });
  return sessions.get(id);
}

/* What the plug does with a decoded request. */
function handle(req) {
  if (req.method === 'set_device_info') {
    device.on = !!(req.params && req.params.device_on);
    device.sets++;
    return { error_code: 0 };
  }
  if (req.method === 'get_device_info') {
    return { error_code: 0, result: { device_on: device.on, model: 'P100', nickname: Buffer.from('Oche lights').toString('base64') } };
  }
  return { error_code: -1008 };
}

/* ---- KLAP ---- */
async function klap(req, res, url) {
  if (url.pathname === '/app/handshake1' && !compat) { device.refused++; return send(res, 403, 'Forbidden'); }
  if (url.pathname === '/app/handshake1') {
    const local = await body(req);
    if (local.length !== 16) return send(res, 400, 'bad seed');
    const remote = crypto.randomBytes(16);
    const s = newSession({ local, remote, stage: 1 });
    // A wrong account still gets a reply - a hash the client cannot match
    return send(res, 200, Buffer.concat([remote, sha256(Buffer.concat([local, remote, AUTH]))]),
      { 'set-cookie': `TP_SESSIONID=${s.id};TIMEOUT=86400`, 'content-type': 'application/octet-stream' });
  }
  if (url.pathname === '/app/handshake2') {
    const s = sessionOf(req);
    const proof = await body(req);
    if (!s || s.stage !== 1) return send(res, 403, 'no session');
    if (!sha256(Buffer.concat([s.remote, s.local, AUTH])).equals(proof)) { device.authErrors++; return send(res, 403, 'bad proof'); }
    s.key = sha256(Buffer.concat([enc('lsk'), s.local, s.remote, AUTH])).subarray(0, 16);
    const ivFull = sha256(Buffer.concat([enc('iv'), s.local, s.remote, AUTH]));
    s.ivBase = ivFull.subarray(0, 12);
    s.seq = ivFull.readInt32BE(28);
    s.sig = sha256(Buffer.concat([enc('ldk'), s.local, s.remote, AUTH])).subarray(0, 28);
    s.stage = 2;
    device.logins++;
    return send(res, 200, '');
  }
  if (url.pathname === '/app/request') {
    const s = sessionOf(req);
    const data = await body(req);
    if (!s || s.stage !== 2) return send(res, 403, 'no session');
    const seq = Number(url.searchParams.get('seq'));
    if (seq !== s.seq + 1) { device.seqErrors++; return send(res, 403, 'bad seq'); }
    s.seq = seq;
    const seqBuf = Buffer.alloc(4); seqBuf.writeInt32BE(seq);
    const ct = data.subarray(32);
    if (!sha256(Buffer.concat([s.sig, seqBuf, ct])).equals(data.subarray(0, 32))) { device.sigErrors++; return send(res, 403, 'bad signature'); }
    const iv = Buffer.concat([s.ivBase, seqBuf]);
    const d = crypto.createDecipheriv('aes-128-cbc', s.key, iv);
    const request = JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'));
    const reply = enc(JSON.stringify(handle(request)));
    const c = crypto.createCipheriv('aes-128-cbc', s.key, iv);
    const rct = Buffer.concat([c.update(reply), c.final()]);
    return send(res, 200, Buffer.concat([sha256(Buffer.concat([s.sig, seqBuf, rct])), rct]), { 'content-type': 'application/octet-stream' });
  }
  return send(res, 404, 'not found');
}

/* ---- legacy securePassthrough ---- */
async function legacy(req, res, url) {
  if (url.pathname !== '/app') return send(res, 404, 'not found');
  let j;
  try { j = JSON.parse((await body(req)).toString('utf8')); } catch (_) { return send(res, 200, JSON.stringify({ error_code: -1003 })); }
  if (j.method === 'handshake') {
    const kb = crypto.randomBytes(32);
    const encrypted = crypto.publicEncrypt({ key: j.params.key, padding: crypto.constants.RSA_PKCS1_PADDING }, kb);
    const s = newSession({ key: kb.subarray(0, 16), iv: kb.subarray(16, 32), token: null });
    return send(res, 200, JSON.stringify({ error_code: 0, result: { key: encrypted.toString('base64') } }),
      { 'set-cookie': `TP_SESSIONID=${s.id};TIMEOUT=1440`, 'content-type': 'application/json' });
  }
  if (j.method === 'securePassthrough') {
    const s = sessionOf(req);
    if (!s) return send(res, 200, JSON.stringify({ error_code: 9999 }));
    const d = crypto.createDecipheriv('aes-128-cbc', s.key, s.iv);
    const inner = JSON.parse(Buffer.concat([d.update(Buffer.from(j.params.request, 'base64')), d.final()]).toString('utf8'));
    let reply;
    if (inner.method === 'login_device') {
      const okUser = inner.params.username === Buffer.from(sha1(enc(EMAIL)).toString('hex')).toString('base64');
      const okPass = inner.params.password === Buffer.from(PASSWORD).toString('base64');
      if (okUser && okPass) { s.token = crypto.randomBytes(6).toString('hex'); device.logins++; reply = { error_code: 0, result: { token: s.token } }; }
      else { device.authErrors++; reply = { error_code: -1501 }; }
    } else if (!s.token || url.searchParams.get('token') !== s.token) {
      reply = { error_code: 9999 };
    } else reply = handle(inner);
    const c = crypto.createCipheriv('aes-128-cbc', s.key, s.iv);
    const rct = Buffer.concat([c.update(enc(JSON.stringify(reply))), c.final()]).toString('base64');
    return send(res, 200, JSON.stringify({ error_code: 0, result: { response: rct } }), { 'content-type': 'application/json' });
  }
  return send(res, 200, JSON.stringify({ error_code: -1008 }));
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname === '/state') return send(res, 200, JSON.stringify({ ...device, mode: MODE, failing, compat, asleep }), { 'content-type': 'application/json' });
    if (url.pathname === '/fail') { failing = url.searchParams.get('on') !== '0'; return send(res, 200, 'ok'); }
    if (url.pathname === '/forget') { sessions.clear(); return send(res, 200, 'ok'); }
    if (url.pathname === '/compat') { compat = url.searchParams.get('on') !== '0'; return send(res, 200, 'ok'); }
    if (url.pathname === '/sleep') { asleep = true; sessions.clear(); return send(res, 200, 'ok'); }
    if (asleep && url.pathname.startsWith('/app')) { device.refused++; req.socket.destroy(); return undefined; }
    if (failing) return send(res, 503, 'plug unreachable');
    if (MODE === 'klap') return await klap(req, res, url);
    return await legacy(req, res, url);
  } catch (e) {
    return send(res, 500, String(e.message || e));
  }
}).listen(PORT, '127.0.0.1', () => console.log(`fake ${MODE} plug on ${PORT}`));
