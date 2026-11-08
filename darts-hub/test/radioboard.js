/*
 * Boots the real server like fakeboard.js, but the hub gets the REAL
 * @stoprocent/noble Noble class (lib/noble.js:
 * state getter, _onStateChange, startScanning's throw/queue, cleanup when the
 * radio leaves poweredOn) driven by a FAKE binding that models the WinRT
 * binding: nothing is emitted at start(); the first radio state arrives
 * asynchronously (DeviceWatcher enumeration), later states only on change
 * (BLEManager::OnRadio dedups), poweredOff aborts a running scan (scanStop),
 * and a pending connect fails when the radio drops.
 *
 *   FAKE_RADIO="1000:poweredOff,4000:poweredOn"   radio script, ms after binding start()
 *   FAKE_HOOK_PORT=n   /radio?state=poweredOff     change the radio state now
 *                      /stats                       binding + noble listener counts
 *   FAKE_CONNECT_DELAY_MS=n                         connect completes after n ms
 *   FAKE_LATE_CONNECT_EVENT=1                       a connect pending when the radio dropped still
 *                                                   reports later (noble: "unknown peripheral ... connected!")
 *   FAKE_ADVERTISE_FROM_MS=n                        board only advertises n ms after binding start
 *   FAKE_START_THROW=1 [FAKE_START_THROW_TIMES=n]   the binding's start() throws (Bluetooth stack not
 *                                                   ready at logon), for every start or the first n;
 *                                                   noble.withBindings() hands out a fresh instance, as
 *                                                   the real module does
 *   FAKE_SCAN_ABORT_UNTIL_MS=n                      a scan started in the first n ms aborts at once
 *   FAKE_GATT_HANG_TIMES=n                          the first n service discoveries never answer (a WinRT
 *                                                   GetGattServicesAsync that never completes)
 *   FAKE_GATT_UNREACHABLE_TIMES=n                   the first n service discoveries fail "Device is unreachable
 *                                                   while discovering services" (WinRT: the board is held by a
 *                                                   phone or the other darts window - its connect still succeeds)
 *   FAKE_SUBSCRIBE_SILENT=1                         the subscribe reply never arrives, but darts do
 *   FAKE_WRITE_DELAY_MS=n                           a write (the board's 0x03 "scoring on") is answered after n ms
 *   FAKE_OTHERS=n                                   n other Bluetooth devices (phones, earbuds) advertising
 *   hooks: /deaf?on=1|0   the radio says ON but hears nothing at all (adverts stop)
 *          /drop          the board drops the live link (batteries, range)
 * Used by radiotest.js.
 */
const EventEmitter = require('events');
const Module = require('module');
const REPO = require('path').join(__dirname, '..');
const Noble = require(`${REPO}/node_modules/@stoprocent/noble/lib/noble.js`);

const t0 = Date.now();
const log = (...a) => console.log(`[radio +${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...a);
const stats = { scansStarted: 0, scanStops: 0, connects: 0, states: [], warnings: [], startCalls: 0, instances: 1 };

const BOARD = 'aabbccddeeff';
class FakeWinrt extends EventEmitter {
  constructor() {
    super();
    this.radio = 'initial';
    this.scanning = false;
    this.adv = null;
    this.connected = new Set();
    this.pending = new Map();
    this.dartTimer = null;
    this.startedAt = 0;
    this.deaf = false;
    this.gattCalls = 0;
  }
  setRadio(s) {
    // BLEManager::OnRadio emits only when the AdapterState enum changes, but
    // Off and Disabled are different enums that both read "poweredOff":
    // a trailing "!" models that (same string, emitted again).
    const force = /!$/.test(s); s = s.replace(/!$/, '');
    if (s === this.radio && !force) return;
    this.radio = s;
    stats.states.push({ at: Date.now() - t0, s });
    log('binding emits stateChange', s);
    if (s !== 'poweredOn') {
      // The advertisement watcher aborts with the radio
      if (this.scanning) { this.scanning = false; clearInterval(this.adv); this.adv = null; stats.scanStops++; this.emit('scanStop'); }
      for (const [id, t] of this.pending) {
        if (!process.env.FAKE_LATE_CONNECT_EVENT) { clearTimeout(t); this.pending.delete(id); }
      }
      clearInterval(this.dartTimer); this.dartTimer = null;
      this.connected.clear();
    }
    this.emit('stateChange', s);
  }
  start() {
    // FAKE_START_THROW=1: creating the WinRT watchers fails (stack not ready at logon)
    stats.startCalls++;
    if (process.env.FAKE_START_THROW && stats.startCalls <= Number(process.env.FAKE_START_THROW_TIMES || 1e9)) { log('binding start() THROWS'); throw new Error('The RPC server is unavailable.'); }
    this.startedAt = Date.now();
    log('binding start() - first state arrives asynchronously');
    const script = String(process.env.FAKE_RADIO || '300:poweredOn').split(',').filter(Boolean);
    for (const step of script) {
      const [ms, s] = step.split(':');
      setTimeout(() => this.setRadio(s), Number(ms));
    }
  }
  startScanning(_uuids, _dup) {
    stats.scansStarted++;
    log('binding startScanning (radio', this.radio + ')');
    this.scanning = true;
    clearInterval(this.adv);
    this.adv = setInterval(() => {
      if (Date.now() - this.startedAt < Number(process.env.FAKE_ADVERTISE_FROM_MS || 0)) return;
      if (this.deaf) return;
      for (let i = 0; i < Number(process.env.FAKE_OTHERS || 0); i++) {
        this.emit('discover', `0000000000${String(i).padStart(2, '0')}`, `00:00:00:00:00:${String(i).padStart(2, '0')}`, 'random', true, { localName: `Phone ${i}`, serviceUuids: [] }, -80, true);
      }
      if (this.connected.has(BOARD) || this.pending.has(BOARD)) return;   // a linked board stops advertising
      this.emit('discover', BOARD, 'aa:bb:cc:dd:ee:ff', 'public', true, { localName: 'Unicorn Darts', serviceUuids: [] }, -60, true);
    }, 400);
    this.emit('scanStart', false);
    // FAKE_SCAN_ABORT_UNTIL_MS: the watcher aborts at once (radio reported On
    // but the adapter is not really up yet) - WinRT then emits scanStop.
    if (Date.now() - this.startedAt < Number(process.env.FAKE_SCAN_ABORT_UNTIL_MS || 0)) {
      setTimeout(() => { this.scanning = false; clearInterval(this.adv); this.adv = null; stats.scanStops++; log('binding: advertisement watcher ABORTED -> scanStop'); this.emit('scanStop'); }, 100);
    }
  }
  stopScanning() {
    if (this.scanning) stats.scanStops++;
    this.scanning = false; clearInterval(this.adv); this.adv = null;
    this.emit('scanStop');
  }
  connect(id) {
    stats.connects++;
    const delay = Number(process.env.FAKE_CONNECT_DELAY_MS || 50);
    const t = setTimeout(() => {
      this.pending.delete(id);
      if (this.radio !== 'poweredOn') { this.emit('connect', id, new Error('radio is off')); return; }
      this.connected.add(id);
      this.emit('connect', id, null);
    }, delay);
    this.pending.set(id, t);
  }
  disconnect(id) {
    const was = this.connected.delete(id);
    clearInterval(this.dartTimer); this.dartTimer = null;
    setImmediate(() => this.emit('disconnect', id, was ? 'local' : 'not connected'));
  }
  discoverServices(id) {
    this.gattCalls++;
    stats.gatt = this.gattCalls;
    if (this.gattCalls <= Number(process.env.FAKE_GATT_HANG_TIMES || 0)) { log('binding discoverServices NEVER ANSWERS'); return; }
    if (this.gattCalls <= Number(process.env.FAKE_GATT_HANG_TIMES || 0) + Number(process.env.FAKE_GATT_UNREACHABLE_TIMES || 0)) {
      log('binding discoverServices: Device is unreachable');
      setImmediate(() => this.emit('servicesDiscover', id, [], new Error('Device is unreachable while discovering services')));
      return;
    }
    setImmediate(() => this.emit('servicesDiscover', id, ['fff0', '180f']));
  }
  drop() {
    for (const id of [...this.connected]) {
      this.connected.delete(id);
      clearInterval(this.dartTimer); this.dartTimer = null;
      log('binding: board dropped the link', id);
      this.emit('disconnect', id, 'remote');
    }
  }
  discoverCharacteristics(id, svc) {
    const chars = svc === 'fff0'
      ? [{ uuid: 'fff1', properties: ['notify'] }, { uuid: 'fff2', properties: ['write'] }]
      : [{ uuid: '2a19', properties: ['read'] }];
    setImmediate(() => this.emit('characteristicsDiscover', id, svc, chars));
  }
  write(id, svc, ch) {
    stats.writes = (stats.writes || 0) + 1;
    const ms = Number(process.env.FAKE_WRITE_DELAY_MS || 0);
    if (ms) setTimeout(() => this.emit('write', id, svc, ch), ms);
    else setImmediate(() => this.emit('write', id, svc, ch));
  }
  read(id, svc, ch) { setImmediate(() => this.emit('read', id, svc, ch, Buffer.from([76]), false)); }
  notify(id, svc, ch, on) {
    if (!process.env.FAKE_SUBSCRIBE_SILENT) setImmediate(() => this.emit('notify', id, svc, ch, on));
    if (on && !this.dartTimer) {
      const beds = [[20, 3], [20, 1], [19, 3], [5, 1]]; let n = 0;
      this.dartTimer = setInterval(() => {
        if (!this.connected.has(id)) return;
        const [sc, m] = beds[n++ % beds.length];
        this.emit('read', id, 'fff0', 'fff1', Buffer.from([sc, m]), true);
      }, 2000);
    }
  }
  addressToId(a) { return String(a).toLowerCase().replace(/:/g, ''); }
}

let bindings = new FakeWinrt();
let noble = new Noble(bindings);
noble.on('warning', (w) => { stats.warnings.push(String(w)); });
// The real module's default export is an instance carrying withBindings();
// after a failed start the hub asks it for a fresh one.
const fresh = () => {
  bindings = new FakeWinrt();
  const n = new Noble(bindings);
  n.on('warning', (w) => { stats.warnings.push(String(w)); });
  n.withBindings = fresh;
  stats.instances++;
  log('fresh noble instance', stats.instances);
  global.__radio = { bindings, noble: n };
  noble = n;
  return n;
};
noble.withBindings = fresh;
global.__radio = { bindings, noble };

const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@stoprocent/noble') return noble;
  return orig.call(this, request, ...rest);
};

if (Number(process.env.FAKE_HOOK_PORT)) {
  require('http').createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/radio') global.__radio.bindings.setRadio(u.searchParams.get('state'));
    if (u.pathname === '/deaf') { global.__radio.bindings.deaf = u.searchParams.get('on') === '1'; log('radio deaf', global.__radio.bindings.deaf); }
    if (u.pathname === '/drop') global.__radio.bindings.drop();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ...stats,
      radio: global.__radio.bindings.radio,
      nobleState: global.__radio.noble._state,
      stateChangeListeners: global.__radio.noble.listenerCount('stateChange'),
      scanning: global.__radio.bindings.scanning,
      connected: [...global.__radio.bindings.connected],
    }));
  }).listen(Number(process.env.FAKE_HOOK_PORT), '127.0.0.1');
}

process.on('exit', (c) => log('hub process exiting with code', c));
require(process.env.SERVER_JS || `${REPO}/server/server.js`);
