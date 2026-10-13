'use strict';
/*
 * A Tapo smart plug that follows the oche: on while time is sold and the
 * board is powered, off when the timer ends, is cleared, or staff power the
 * oche down. Local network only - the plug's own HTTP API on port 80, no
 * cloud, no internet - although the plug still insists on the Tapo account's
 * email and password for its login handshake.
 *
 * Two generations of that handshake exist: KLAP on current firmware and the
 * older RSA "securePassthrough" on plugs that never took a firmware update.
 * Both are here, tried in that order and remembered.
 *
 * Nothing in this file may block or break the hub: every call has a timeout,
 * every failure is recorded for the staff card and retried on a backoff, and
 * a plug that cannot be reached leaves the game entirely alone.
 */
const crypto = require('crypto');
const dgram = require('dgram');
const EventEmitter = require('events');

const TIMEOUT_MS = 6000;
const RETRY_MS = [2000, 5000, 10000, 30000, 60000];   // then every 60 s
const HEAL_MS = 60000;                                 // re-check the plug's real state

const sha256 = (b) => crypto.createHash('sha256').update(b).digest();
const sha1 = (b) => crypto.createHash('sha1').update(b).digest();
const enc = (s) => Buffer.from(String(s), 'utf8');

const CASE_HINT = ' - type both exactly as the Tapo app shows them (Me), capitals included';
const ERRORS = {
  '-1005': 'AES decode failed', '-1006': 'request length error', '-1008': 'invalid request',
  '-1301': 'the plug reported a device error (-1301)', '-1101': 'session error', '-1501': `the plug rejected the Tapo email or password${CASE_HINT}`,
  '-1002': 'the plug did not know that request (-1002)', '-1003': 'malformed request', '-20601': `the plug rejected the Tapo email or password${CASE_HINT}`,
  1003: 'this plug only speaks KLAP', 1100: 'handshake failed', 1111: 'login failed', 9999: 'session timed out',
};
function checkError(res) {
  const code = res && res.error_code;
  if (!code) return;
  const err = new Error(ERRORS[String(code)] || `plug error ${code}${res.msg ? ` (${res.msg})` : ''}`);
  if (code === -1501 || code === -20601 || code === 1111) err.code = 'AUTH';
  if (code === -1101 || code === 9999) err.code = 'SESSION';
  if (code === 1003) err.code = 'NO_LEGACY';
  throw err;
}

/*
 * After a power cut or a firmware update some Tapo plugs (P110 1.4.6+) keep
 * their local API on port 80 shut until something on the network sends them
 * a TP-Link discovery probe on UDP 20002 (the Tapo app does, when its device
 * list is refreshed). When the plug can't be reached we send that probe
 * ourselves - byte for byte python-kasa's _AesDiscoveryQuery; the reply is
 * not needed. Fire-and-forget: never throws, never blocks (the key is made
 * once, off the main thread), at most one probe per plug per 10 s.
 */
const TDP_PORT = Number(process.env.TAPO_TDP_PORT) || 20002;   // env only for tests
const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
function crc32(buf) { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
let tdpKey = null;
const lastWake = new Map();
function tdpProbe(pem, serial) {
  const payload = enc(JSON.stringify({ params: { rsa_key: pem } }));
  const msg = Buffer.alloc(16 + payload.length);
  msg.writeUInt8(2, 0); msg.writeUInt8(0, 1); msg.writeUInt16BE(1, 2);       // TDP v2, type 0, op 1 = probe
  msg.writeUInt16BE(payload.length, 4); msg.writeUInt8(17, 6); msg.writeUInt8(0, 7);
  serial.copy(msg, 8);
  msg.writeUInt32BE(0x5A6B7C8D, 12);                                           // CRC seed, then the CRC itself
  payload.copy(msg, 16);
  msg.writeUInt32BE(crc32(msg), 12);
  return msg;
}
function wakePlug(url) {
  try {
    const host = new URL(url).hostname;
    if (!host || host.includes(':') || host.startsWith('[')) return;   // Tapo plugs are IPv4 only
    if (Date.now() - (lastWake.get(host) || 0) < 10000) return;
    lastWake.set(host, Date.now());
    if (!tdpKey) {
      tdpKey = new Promise((resolve) => crypto.generateKeyPair('rsa',
        { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } },
        (err, pem) => resolve(err ? null : pem)));
    }
    tdpKey.then((pem) => {
      if (!pem) { tdpKey = null; return; }
      let sock = null;
      const close = () => { try { sock.close(); } catch (_) {} };
      try {
        const msg = tdpProbe(pem, crypto.randomBytes(4));
        sock = dgram.createSocket('udp4');
        sock.on('error', close);
        sock.unref();
        sock.send(msg, TDP_PORT, host, close);
      } catch (_) { if (sock) close(); }
    }).catch(() => {});
  } catch (_) { /* a wake-up probe must never cost the hub anything */ }
}

// One request, reply body included, all inside the timeout (fetch() itself
// resolves as soon as the headers arrive: a reply that stalls after them
// must not hold the plug's queue for minutes).
async function post(url, body, headers) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch(url, { method: 'POST', body, headers, signal: ctl.signal, redirect: 'manual' });
    const buf = Buffer.from(await r.arrayBuffer());
    return { status: r.status, ok: r.ok, headers: r.headers, buf };
  } catch (e) {
    const where = url.replace(/^https?:\/\/([^/]+).*/, '$1');
    wakePlug(url);                    // can't reach it: perhaps it is asleep after a power cut
    if (e.name === 'AbortError') throw new Error(`no answer from ${where} within ${TIMEOUT_MS / 1000} s`);
    const cause = e.cause || {};
    throw new Error(`${where}: ${cause.code || cause.message || e.message}`);
  } finally { clearTimeout(timer); }
}

function cookieOf(res) {
  const all = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [res.headers.get('set-cookie') || ''];
  const first = all[0] || '';
  return first.split(';')[0];
}

/* ------------------------------------------------------------- KLAP ----- */

class Klap {
  constructor(base, email, password) {
    this.base = base;
    this.auth = sha256(Buffer.concat([sha1(enc(email)), sha1(enc(password))]));
  }

  async login() {
    const local = crypto.randomBytes(16);
    const r1 = await post(`${this.base}/app/handshake1`, local, { 'content-type': 'application/octet-stream' });
    if (r1.status === 404) { const e = new Error('KLAP not supported'); e.code = 'NO_KLAP'; throw e; }
    if (r1.status === 403) {
      // Firmware 1.4 and later: local control is off until the Tapo app's
      // Third-Party Compatibility switch is on (it is off by default).
      const e = new Error('the plug refused local control - in the Tapo app turn on Me > Third-Party Services > Third-Party Compatibility (if it is already on, switch it off, wait a minute, then on again)');
      e.code = 'FORBIDDEN';
      throw e;
    }
    if (!r1.ok) throw new Error(`handshake1: HTTP ${r1.status}`);
    const body = r1.buf;
    // A KLAP handshake1 reply is exactly a 16-byte seed and a 32-byte hash
    // (python-kasa rejects any other length the same way): anything else is
    // some other device's web page, not a wrong password.
    if (body.length !== 48) throw new Error(`something answered at this address, but not like a Tapo plug (${body.length} bytes) - check the address`);
    const remote = body.subarray(0, 16);
    const serverHash = body.subarray(16, 48);
    if (!sha256(Buffer.concat([local, remote, this.auth])).equals(serverHash)) {
      const e = new Error(`the plug rejected the Tapo email or password${CASE_HINT}`); e.code = 'AUTH'; throw e;
    }
    this.cookie = cookieOf(r1);
    const r2 = await post(`${this.base}/app/handshake2`, sha256(Buffer.concat([remote, local, this.auth])),
      { 'content-type': 'application/octet-stream', cookie: this.cookie });
    if (!r2.ok) throw new Error(`handshake2: HTTP ${r2.status}`);
    this.key = sha256(Buffer.concat([enc('lsk'), local, remote, this.auth])).subarray(0, 16);
    const ivFull = sha256(Buffer.concat([enc('iv'), local, remote, this.auth]));
    this.ivBase = ivFull.subarray(0, 12);
    this.seq = ivFull.readInt32BE(28);
    this.sig = sha256(Buffer.concat([enc('ldk'), local, remote, this.auth])).subarray(0, 28);
  }

  async send(req) {
    this.seq += 1;
    const seqBuf = Buffer.alloc(4);
    seqBuf.writeInt32BE(this.seq);
    const iv = Buffer.concat([this.ivBase, seqBuf]);
    const c = crypto.createCipheriv('aes-128-cbc', this.key, iv);
    const ct = Buffer.concat([c.update(enc(JSON.stringify(req))), c.final()]);
    const body = Buffer.concat([sha256(Buffer.concat([this.sig, seqBuf, ct])), ct]);
    const r = await post(`${this.base}/app/request?seq=${this.seq}`, body,
      { 'content-type': 'application/octet-stream', cookie: this.cookie });
    if (!r.ok) { const e = new Error(`request: HTTP ${r.status}`); e.code = 'SESSION'; throw e; }
    const data = r.buf;
    let plain;
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', this.key, iv);
      plain = JSON.parse(Buffer.concat([d.update(data.subarray(32)), d.final()]).toString('utf8'));
    } catch (e) { const err = new Error(`could not read the plug's reply (${e.message})`); err.code = 'SESSION'; throw err; }
    checkError(plain);
    return plain.result;
  }
}

/* ------------------------------------------ legacy securePassthrough ----- */

// PKCS#1 v1.5 unpadding by hand: Node no longer allows RSA_PKCS1_PADDING on
// private decryption (CVE-2023-46809) and the alternative is a process-wide
// security revert. We are the client talking to a plug on the LAN, so the
// padding-oracle concern that flag guards against does not apply here.
function rsaDecryptPkcs1(privateKey, data) {
  const raw = crypto.privateDecrypt({ key: privateKey, padding: crypto.constants.RSA_NO_PADDING }, data);
  if (raw[0] !== 0 || raw[1] !== 2) throw new Error('bad RSA padding from the plug');
  const sep = raw.indexOf(0, 2);
  if (sep < 10) throw new Error('bad RSA padding from the plug');
  return raw.subarray(sep + 1);
}

class Passthrough {
  constructor(base, email, password) { this.base = base; this.email = email; this.password = password; }

  async login() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
      modulusLength: 1024,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
    });
    const r = await post(`${this.base}/app`, JSON.stringify({ method: 'handshake', params: { key: publicKey } }),
      { 'content-type': 'application/json' });
    if (!r.ok) throw new Error(`handshake: HTTP ${r.status}`);
    const j = JSON.parse(new TextDecoder().decode(r.buf));
    checkError(j);
    this.cookie = cookieOf(r);
    const kb = rsaDecryptPkcs1(privateKey, Buffer.from(j.result.key, 'base64'));
    this.key = kb.subarray(0, 16);
    this.iv = kb.subarray(16, 32);
    const login = await this.send({
      method: 'login_device',
      params: {
        username: Buffer.from(sha1(enc(this.email)).toString('hex')).toString('base64'),
        password: Buffer.from(this.password).toString('base64'),
      },
      requestTimeMils: 0,
    });
    this.token = login.token;
  }

  async send(req) {
    const c = crypto.createCipheriv('aes-128-cbc', this.key, this.iv);
    const ct = Buffer.concat([c.update(enc(JSON.stringify(req))), c.final()]).toString('base64');
    const url = `${this.base}/app${this.token ? `?token=${encodeURIComponent(this.token)}` : ''}`;
    const r = await post(url, JSON.stringify({ method: 'securePassthrough', params: { request: ct } }),
      { 'content-type': 'application/json', cookie: this.cookie });
    if (!r.ok) { const e = new Error(`request: HTTP ${r.status}`); e.code = 'SESSION'; throw e; }
    const j = JSON.parse(new TextDecoder().decode(r.buf));
    checkError(j);
    let inner;
    try {
      const d = crypto.createDecipheriv('aes-128-cbc', this.key, this.iv);
      inner = JSON.parse(Buffer.concat([d.update(Buffer.from(j.result.response, 'base64')), d.final()]).toString('utf8'));
    } catch (e) { const err = new Error(`could not read the plug's reply (${e.message})`); err.code = 'SESSION'; throw err; }
    checkError(inner);
    return inner.result;
  }
}

/* ------------------------------------------------------------ device ----- */

class TapoPlug {
  constructor({ host, email, password, protocol }) {
    this.base = `http://${String(host).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`;
    this.email = email;
    this.password = password;
    this.protocol = protocol || 'auto';
    this.session = null;
    this.using = null;
  }

  async _session() {
    if (this.session) return this.session;
    const order = this.protocol === 'passthrough' ? ['passthrough']
      : this.protocol === 'klap' ? ['klap'] : ['klap', 'passthrough'];
    let last = null;
    for (const p of order) {
      const s = p === 'klap' ? new Klap(this.base, this.email, this.password) : new Passthrough(this.base, this.email, this.password);
      try {
        await s.login();
        this.session = s;
        this.using = p;
        this.protocol = p;              // remembered: no more probing
        return s;
      } catch (e) {
        last = e;
        if (p === 'klap' && e.code === 'NO_KLAP' && order.length > 1) continue;
        throw e;
      }
    }
    throw last;
  }

  async _call(req) {
    let s = await this._session();
    try {
      return await s.send(req);
    } catch (e) {
      this.session = null;
      if (e.code === 'SESSION') {       // the plug forgot us (it reboots, it times sessions out): log in again once
        s = await this._session();
        return s.send(req);
      }
      throw e;
    }
  }

  setOn(on) { return this._call({ method: 'set_device_info', params: { device_on: !!on } }); }

  async isOn() {
    const info = await this._call({ method: 'get_device_info' });
    return !!(info && info.device_on);
  }
}

/* -------------------------------------------------------- controller ----- */

/*
 * Keeps the plug in step with what the hub wants. set(true/false) is called
 * on every state change and is idempotent; a change is applied at once and
 * retried on a backoff until the plug confirms it; once a minute the plug's
 * real state is read back and corrected (somebody pressed the button on the
 * plug, the plug rebooted, the hub restarted). Switching off can be delayed
 * by a few minutes so the lights don't drop the instant the timer ends.
 */
class PlugController extends EventEmitter {
  constructor() {
    super();
    this.cfg = null;
    this.plug = null;
    this.want = null;          // what the hub wants: true / false / null (nothing configured)
    this.actual = null;        // last state the plug confirmed
    this.lastError = null;
    this.lastErrorCode = null;  // AUTH (wrong Tapo account), FORBIDDEN (app switch off), ...
    this.lastErrorAt = 0;
    this.lastOkAt = 0;
    this.attempts = 0;
    this.testAt = 0;           // when staff last pressed Test on/off (it stands for a minute)
    this.busy = false;
    this.dirty = false;
    this.retryTimer = null;
    this.offTimer = null;
    this.offDueAt = null;
    this.healTimer = setInterval(() => this._heal(), HEAL_MS);
    if (this.healTimer.unref) this.healTimer.unref();
  }

  configure(cfg) {
    const next = cfg && cfg.enabled && cfg.host ? cfg : null;
    const key = next ? `${next.host}|${next.email}|${next.password}` : '';
    if (key !== this._key) {
      this._key = key;
      this.plug = next ? new TapoPlug({ host: next.host, email: next.email, password: next.password }) : null;
      this.actual = null;
      this.lastError = null;
      this.lastErrorCode = null;
      this.attempts = 0;
      clearTimeout(this.retryTimer); this.retryTimer = null;
      if (this.plug && this.want !== null) this._apply();
    }
    this.cfg = next;
    if (!next) { this.want = null; this._cancelOff(); }
  }

  // now: switch off at once, skipping (and cutting short) the off delay -
  // the oche powered off at closing, the PC perhaps shut down right after.
  set(on, now) {
    if (!this.plug) return;
    if (on) {
      this._cancelOff();
      if (this.want !== true) { this.want = true; this._apply(); }
      return;
    }
    if (now) this._cancelOff();
    if (this.want === false) return;
    const delay = now ? 0 : Math.max(0, Number(this.cfg.offDelayMin) || 0) * 60000;
    if (delay > 0 && this.want === true) {
      if (this.offTimer) return;                  // already counting down
      this.offDueAt = Date.now() + delay;
      this.offTimer = setTimeout(() => { this.offTimer = null; this.offDueAt = null; this.want = false; this._apply(); }, delay);
      if (this.offTimer.unref) this.offTimer.unref();
      this.emit('change');
      return;
    }
    this.want = false;
    this._apply();
  }

  _cancelOff() {
    if (!this.offTimer) return;
    clearTimeout(this.offTimer);
    this.offTimer = null;
    this.offDueAt = null;
  }

  async _apply() {
    if (!this.plug || this.want === null) return;
    if (this.busy) { this.dirty = true; return; }
    clearTimeout(this.retryTimer); this.retryTimer = null;
    this.busy = true;
    const want = this.want;
    try {
      await this.plug.setOn(want);
      this.actual = want;
      this.lastOkAt = Date.now();
      this.lastError = null;
      this.lastErrorCode = null;
      this.attempts = 0;
    } catch (e) {
      this.lastError = e.message || String(e);
      this.lastErrorCode = e.code || null;
      this.lastErrorAt = Date.now();
      this.attempts++;
      const wait = RETRY_MS[Math.min(this.attempts - 1, RETRY_MS.length - 1)];
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this._apply(); }, wait);
      if (this.retryTimer.unref) this.retryTimer.unref();
    } finally {
      this.busy = false;
    }
    this.emit('change');
    if (this.dirty || (this.want !== null && this.want !== want && !this.retryTimer)) { this.dirty = false; this._apply(); }
  }

  async _heal() {
    if (!this.plug || this.want === null || this.busy || this.retryTimer) return;
    const testAt = this.testAt;
    this.busy = true;
    try {
      const on = await this.plug.isOn();
      this.lastOkAt = Date.now();
      this.lastError = null;
      this.lastErrorCode = null;
      if (this.testAt === testAt) this.actual = on;   // a Test landed mid-read: its own result stands
    } catch (e) {
      this.lastError = e.message || String(e);
      this.lastErrorCode = e.code || null;
      this.lastErrorAt = Date.now();
    } finally {
      this.busy = false;
    }
    if (this.testAt !== testAt) { this.emit('change'); return; }   // the test has its minute; the next heal corrects it
    const pending = this.dirty;      // a switch asked for while this check held the plug
    this.dirty = false;
    if (pending || (this.actual !== this.want && !this.lastError)) this._apply();
    else this.emit('change');
  }

  /** Staff pressed Test on / Test off: switch it now and say how it went. */
  test(on, cb) {
    const done = typeof cb === 'function' ? cb : () => {};
    if (!this.plug) return done({ ok: false, error: 'no plug set up on this board' });
    this.plug.setOn(!!on).then(() => {
      this.actual = !!on;
      this.lastOkAt = Date.now();
      this.lastError = null;
      this.lastErrorCode = null;
      // The test stands for a full minute: the next check of the plug is a
      // minute from now (not whenever the fixed minute tick happens to fall),
      // and a retry left over from before the plug answered is dropped.
      this.testAt = Date.now();
      clearTimeout(this.retryTimer); this.retryTimer = null;
      clearInterval(this.healTimer);
      this.healTimer = setInterval(() => this._heal(), HEAL_MS);
      if (this.healTimer.unref) this.healTimer.unref();
      this.emit('change');
      done({ ok: true, protocol: this.plug.using });
    }).catch((e) => {
      this.lastError = e.message || String(e);
      this.lastErrorCode = e.code || null;
      this.lastErrorAt = Date.now();
      this.emit('change');
      done({ ok: false, error: this.lastError });
    });
  }

  status() {
    return {
      enabled: !!this.plug,
      host: this.cfg ? this.cfg.host : '',
      want: this.want,
      actual: this.actual,
      ok: !!this.plug && !this.lastError && this.lastOkAt > 0,
      error: this.lastError,
      authFailed: this.lastErrorCode === 'AUTH',        // it answered, but turned the Tapo account down
      forbidden: this.lastErrorCode === 'FORBIDDEN',    // it answered, but local control is switched off
      lastOkAt: this.lastOkAt || null,
      lastErrorAt: this.lastErrorAt || null,
      offDueAt: this.offDueAt,
      protocol: this.plug ? this.plug.using : null,
    };
  }

  stop() {
    clearInterval(this.healTimer);
    clearTimeout(this.retryTimer);
    this._cancelOff();
  }
}

module.exports = { TapoPlug, PlugController, Klap, Passthrough, checkError, tdpProbe };
