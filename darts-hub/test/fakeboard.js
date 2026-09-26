/*
 * Boots the real server with a fake Bluetooth stack behaving like a real
 * Unicorn board: fff0 service, fff1 notify throws, fff2 write-only button,
 * battery service, continuous advertising while scanned, and a dart thrown
 * every 2 seconds once anyone subscribes.
 */
const EventEmitter = require('events');
const Module = require('module');

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
peripheral.uuid = 'aabbccddeeff';
peripheral.address = 'aa:bb:cc:dd:ee:ff';
peripheral.advertisement = { localName: 'Unicorn Darts' };
peripheral.connect = (cb) => cb(process.env.FAKE_CONNECT_FAIL ? new Error('the device is unreachable') : null);
peripheral.discoverServices = (_f, cb) => cb(null, [service, batteryService]);
peripheral.disconnect = (cb) => cb && cb();

const noble = new EventEmitter();
noble.state = 'poweredOn';
let advertising = null;
noble.startScanning = () => {
  clearInterval(advertising);
  advertising = setInterval(() => noble.emit('discover', peripheral), 400);
};
noble.stopScanning = () => { clearInterval(advertising); advertising = null; };

const orig = Module._load;
Module._load = function (request, ...rest) {
  if (request === '@stoprocent/noble') return noble;
  return orig.call(this, request, ...rest);
};

global.__fake = { throws, writes, peripheral };
// The board throws by itself: T20-ish dart every 2 seconds once subscribed.
const beds = [[20, 3], [20, 1], [19, 3], [5, 1], [1, 1], [18, 1], [12, 2]];
let n = 0;
setInterval(() => {
  try {
    const [sc, m] = beds[n++ % beds.length];
    throws.emit('data', Buffer.from([sc, m]), true);
  } catch (_) {}
}, 2000);

require(process.env.SERVER_JS || require('path').join(__dirname, '..', 'server', 'server.js'));
