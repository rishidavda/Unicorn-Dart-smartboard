/*
 * Boots the real server with a fake Bluetooth stack behaving like a real
 * Unicorn board: fff0 service, fff1 notify throws, fff2 write-only button,
 * battery service, continuous advertising while scanned, and a dart thrown
 * every 2 seconds once anyone subscribes.
 *
 * Opt-in knobs that model the real backends more closely (all off by default):
 *   FAKE_CONNECT_FAIL=1          every connect is refused ("the device is unreachable")
 *   FAKE_CONNECT_FAIL_TIMES=n    the first n connects are refused, then accepted
 *   FAKE_CONNECT_DELAY_MS=n      connect completes asynchronously after n ms (WinRT takes seconds)
 *   FAKE_DISCONNECT_EVENT=1      p.disconnect() on a live link emits 'disconnect', like noble does
 *   FAKE_SECOND_BOARD=1          a second dartboard advertises too (uuid 112233445566)
 *   FAKE_DOUBLE_CONNECT_ERR=1    a connect() while one is still pending fails at once with
 *                                "Peripheral already connecting", like noble (needs FAKE_CONNECT_DELAY_MS)
 *   FAKE_FIRST_ABSENT=1          the first board never advertises (batteries out, another oche's PC holds it)
 *   FAKE_FIRST_AFTER_MS=n        the first board only advertises n ms after start
 *   FAKE_SECOND_AFTER_MS=n       the second board (FAKE_SECOND_BOARD) only advertises n ms after start
 *   FAKE_HOOK_PORT=n             http://127.0.0.1:n/stats  -> connect attempts, scans, per-board state
 *   FAKE_LOAD_FAIL=n             the first n loads of the Bluetooth driver fail (ERR_DLOPEN_FAILED)
 *                                http://127.0.0.1:n/drop[?board=i] -> that board drops the link by itself
 *                                http://127.0.0.1:n/warn[?board=i] -> noble's "unknown peripheral ... read!" warning
 */
const EventEmitter = require('events');
const Module = require('module');

const stats = { connectAttempts: 0, scans: 0, doubleConnects: 0 };

function makeBoard(uuid, address, localName) {
  const throws = new EventEmitter();
  throws.uuid = '0000fff1-0000-1000-8000-00805f9b34fb';
  throws.properties = ['notify'];
  throws.subscribe = (cb) => cb(null);
  throws.removeAllListeners = EventEmitter.prototype.removeAllListeners.bind(throws);

  const writes = [];
  const button = {
    uuid: '0000fff2-0000-1000-8000-00805f9b34fb',
    properties: ['write'],
    write(buf, withoutResponse, cb) {
      writes.push({ byte: buf[0], withoutResponse });
      if (cb) cb(null);
    },
  };

  const service = {
    uuid: '0000fff0-0000-1000-8000-00805f9b34fb',
    discoverCharacteristics: (_f, cb) => cb(null, [throws, button]),
  };

  const batteryChar = {
    uuid: '00002a19-0000-1000-8000-00805f9b34fb',
    properties: ['read'],
    read: (cb) => cb(null, Buffer.from([Number(process.env.FAKE_BATTERY || 76)])),
  };
  const batteryService = {
    uuid: '0000180f-0000-1000-8000-00805f9b34fb',
    discoverCharacteristics: (_f, cb) => cb(null, [batteryChar]),
  };

  const peripheral = new EventEmitter();
  peripheral.uuid = uuid;
  peripheral.address = address;
  peripheral.addressType = 'public';
  peripheral.rssi = -60;
  peripheral.advertisement = { localName };
  peripheral.connected = false;
  peripheral.attempts = 0;
  peripheral.connect = (cb) => {
    if (process.env.FAKE_DOUBLE_CONNECT_ERR && peripheral.connecting) {
      stats.doubleConnects++;
      return cb(new Error('Peripheral already connecting'));
    }
    peripheral.attempts++;
    stats.connectAttempts++;
    const refuse = !!process.env.FAKE_CONNECT_FAIL
      || peripheral.attempts <= Number(process.env.FAKE_CONNECT_FAIL_TIMES || 0);
    const finish = () => {
      peripheral.connecting = false;
      if (!refuse) peripheral.connected = true;
      cb(refuse ? new Error('the device is unreachable') : null);
    };
    const delay = Number(process.env.FAKE_CONNECT_DELAY_MS || 0);
    if (delay > 0) { peripheral.connecting = true; setTimeout(finish, delay); } else finish();
  };
  peripheral.discoverServices = (_f, cb) => cb(null, [service, batteryService]);
  peripheral.disconnect = (cb) => {
    const wasLive = peripheral.connected;
    peripheral.connected = false;
    if (cb) cb();
    if (process.env.FAKE_DISCONNECT_EVENT && wasLive) setImmediate(() => peripheral.emit('disconnect'));
  };
  // The board itself lets go (batteries out, out of range).
  peripheral.drop = () => { peripheral.connected = false; peripheral.emit('disconnect'); };
  return { peripheral, throws, button, writes };
}

const boards = [makeBoard('aabbccddeeff', 'aa:bb:cc:dd:ee:ff', 'Unicorn Darts')];
if (process.env.FAKE_SECOND_BOARD) boards.push(makeBoard('112233445566', '11:22:33:44:55:66', 'Unicorn Darts 2'));
const { throws, writes, peripheral } = boards[0];

const noble = new EventEmitter();
noble.state = 'poweredOn';
let advertising = null;
const T0 = Date.now();
// Which boards are on air right now (the knobs above can keep one off air).
const onAir = (b, i) => {
  if (i === 0) return !process.env.FAKE_FIRST_ABSENT && Date.now() - T0 >= Number(process.env.FAKE_FIRST_AFTER_MS || 0);
  return Date.now() - T0 >= Number(process.env.FAKE_SECOND_AFTER_MS || 0);
};
noble.startScanning = () => {
  stats.scans++;
  clearInterval(advertising);
  advertising = setInterval(() => boards.forEach((b, i) => { if (onAir(b, i)) noble.emit('discover', b.peripheral); }), 400);
};
noble.stopScanning = () => { clearInterval(advertising); advertising = null; };

// FAKE_LOAD_FAIL=n: the first n loads of the driver fail the way the real
// one does when Windows' Bluetooth stack is not up yet (straight after logon).
let loadFails = Number(process.env.FAKE_LOAD_FAIL) || 0;
stats.loadAttempts = 0;
const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@stoprocent/noble') {
    stats.loadAttempts++;
    if (loadFails > 0) {
      loadFails--;
      const err = new Error('error: -529697949 \\\\?\\C:\\WinchesterDarts\\node_modules\\@stoprocent\\noble\\prebuilds\\win32-x64\\node.napi.node');
      err.code = 'ERR_DLOPEN_FAILED';
      throw err;
    }
    return noble;
  }
  return orig.call(this, request, ...rest);
};

global.__fake = { throws, writes, peripheral };
// The board throws by itself: T20-ish dart every 2 seconds once subscribed.
const beds = [[20, 3], [20, 1], [19, 3], [5, 1], [1, 1], [18, 1], [12, 2]];
let n = 0;
setInterval(() => {
  try {
    const [sc, m] = beds[n++ % beds.length];
    boards.forEach((b) => b.throws.emit('data', Buffer.from([sc, m]), true));
  } catch (_) {}
}, 2000);

if (Number(process.env.FAKE_HOOK_PORT)) {
  require('http').createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/drop') boards[Number(u.searchParams.get('board') || 0)].peripheral.drop();
    if (u.pathname === '/warn') noble.emit('warning', `unknown peripheral ${boards[Number(u.searchParams.get('board') || 0)].peripheral.uuid}, 0000fff1-0000-1000-8000-00805f9b34fb read!`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({
      ...stats,
      boards: boards.map((b) => ({
        uuid: b.peripheral.uuid,
        connected: b.peripheral.connected,
        attempts: b.peripheral.attempts,
        disconnectListeners: b.peripheral.listenerCount('disconnect'),
        dataListeners: b.throws.listenerCount('data'),
        writes: b.writes.map((w) => w.byte),
      })),
    }));
  }).listen(Number(process.env.FAKE_HOOK_PORT), '127.0.0.1');
}

require(process.env.SERVER_JS || require('path').join(__dirname, '..', 'server', 'server.js'));
