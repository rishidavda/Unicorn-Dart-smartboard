'use strict';
/*
 * Unicorn Smartboard driver (Bluetooth LE).
 *
 * Emits: 'dart'   {score, multiplier}   - a dart landed (already rotated)
 *        'button'                       - rim button = end of turn
 *        'status' {state, detail}        - idle|scanning|connected|error|off
 *
 * Windows 10/11 uses the native WinRT backend, Linux the HCI socket - both via
 * @stoprocent/noble, which ships prebuilt binaries for each.
 */
const EventEmitter = require('events');

const SERVICE_SCORING = 'fff0';
const CHAR_BUTTON = 'fff2';
const CHAR_THROWS = 'fff1';
const RING = [15, 2, 17, 3, 19, 7, 16, 8, 11, 14, 9, 12, 5, 20, 1, 18, 4, 13, 6, 10];

function normalise(id) {
  return String(id || '').toLowerCase().replace(/[:\-\s]/g, '');
}

/** 128-bit Bluetooth uuids collapse to their 4-hex short form. */
function shortUuid(u) {
  const x = String(u || '').toLowerCase().replace(/-/g, '');
  const m = /^0000([0-9a-f]{4})00001000800000805f9b34fb$/.exec(x);
  return m ? m[1] : x;
}

/** Rotate a reported segment to compensate for how the board is hung. */
function rotate(num, button) {
  if (num === 25 || !button) return num;
  const i = RING.indexOf(num) + RING.indexOf(Number(button));
  return RING[i >= RING.length ? i - RING.length : i];
}

class Board extends EventEmitter {
  constructor() {
    super();
    this.status = 'idle';
    this.detail = 'not started';
    this.peripheral = null;
    this.noble = null;
    this.wanted = null;
    this.buttonNumber = 20;
    this.discovered = [];
    this.scanning = false;
    this.moduleLoaded = false;
    this.loadError = null;      // kept verbatim so the diagnostics can show it
    this.lastError = null;
    this.step = 'not started';
    this.services = null;
    this.characteristics = null;
    this.subscribeError = null;
    this.enabledAt = null;
    this.enabledMode = null;
    this.notifications = 0;     // raw packets from the board, before any parsing
    this.lastPacket = null;
    this.lastPacketAt = null;
  }

  /** Everything a diagnosis needs, in one object. */
  diagnostics() {
    let nobleState = null;
    try { nobleState = this.noble ? (this.noble.state || this.noble._state || null) : null; } catch (_) {}
    return {
      status: this.status,
      detail: this.detail,
      step: this.step,
      moduleLoaded: this.moduleLoaded,
      loadError: this.loadError,
      lastError: this.lastError,
      nobleState,
      scanning: this.scanning,
      connected: !!this.peripheral,
      wanted: this.wanted || '(auto-detect)',
      buttonNumber: this.buttonNumber,
      services: this.services,
      characteristics: this.characteristics,
      subscribeError: this.subscribeError,
      enabledAt: this.enabledAt,
      enabledMode: this.enabledMode,
      packetsFromBoard: this.notifications,
      lastPacket: this.lastPacket,
      lastPacketAt: this.lastPacketAt,
      discovered: this.discovered,
    };
  }

  setStatus(state, detail) {
    this.status = state;
    this.detail = detail || '';
    this.emit('status', { state, detail: this.detail, discovered: this.discovered });
  }

  _noble() {
    if (!this.noble) {
      // Loaded lazily so the app still runs on machines without Bluetooth.
      this.noble = require('@stoprocent/noble');
      this.moduleLoaded = true;
      this.loadError = null;
      this.noble.on('discover', (p) => this._onDiscover(p));
      // noble can also fail asynchronously - surface that instead of dying
      this.noble.on('error', (err) => {
        this.lastError = String((err && err.message) || err);
        this.setStatus('error', `Bluetooth error: ${this.lastError}`);
      });
    }
    return this.noble;
  }

  _onDiscover(p) {
    const uuid = normalise(p.uuid);
    const addr = normalise(p.address);
    const name = (p.advertisement && p.advertisement.localName) || '';
    if (!this.discovered.some((d) => d.uuid === uuid)) {
      this.discovered.push({ uuid, address: addr, name });
      if (this.discovered.length > 40) this.discovered.shift();
      this.emit('status', { state: this.status, detail: this.detail, discovered: this.discovered });
    }
    const looksRight = /dart|joofunn|unicorn/i.test(name);
    const match = this.wanted ? (uuid === this.wanted || (addr && addr === this.wanted)) : looksRight;
    if (match && !this.peripheral) this._connect(p);
  }

  /** Start looking for the board. uuid may be blank: then we auto-pick a board-looking device. */
  connect({ uuid, buttonNumber }) {
    this.wanted = uuid ? normalise(uuid) : null;
    if (buttonNumber) this.buttonNumber = Number(buttonNumber);
    this.discovered = [];

    let noble;
    try {
      noble = this._noble();
    } catch (err) {
      this.moduleLoaded = false;
      this.loadError = {
        message: String(err && err.message || err),
        code: err && err.code,
        stack: String(err && err.stack || '').split('\n').slice(0, 6).join(' | '),
      };
      this.setStatus('error', `Bluetooth driver did not load: ${this.loadError.message}`);
      return;
    }

    const begin = () => {
      if (this.scanning) return;
      this.scanning = true;
      this.setStatus('scanning', this.wanted ? `looking for ${this.wanted}` : 'looking for any dartboard');
      try {
        noble.startScanning([], true);
      } catch (err) {
        this.scanning = false;
        this.setStatus('error', `could not start scanning: ${err.message}`);
      }
    };

    const state = noble.state || noble._state;
    if (state === 'poweredOn') begin();
    else {
      this.setStatus('idle', `waiting for Bluetooth (currently ${state || 'unknown'})`);
      noble.once('stateChange', (s) => {
        if (s === 'poweredOn') begin();
        else this.setStatus('off', `Bluetooth is ${s} - switch it on in Windows settings`);
      });
    }
  }

  _connect(peripheral) {
    this.peripheral = peripheral;
    try { this.noble.stopScanning(); } catch (_) {}
    this.scanning = false;
    const name = (peripheral.advertisement && peripheral.advertisement.localName) || 'dartboard';
    this.setStatus('connecting', `${name} (${peripheral.uuid})`);

    peripheral.once('disconnect', () => {
      if (this.peripheral === peripheral) {
        this.peripheral = null;
        this.setStatus('idle', 'board disconnected - press Reconnect');
        this.emit('lost');
      }
    });

    peripheral.connect((err) => {
      if (err) {
        this.lastError = String(err.message || err);
        return this.setStatus('error', `could not connect to the board: ${this.lastError}`);
      }
      this.step = 'discovering services';
      // Discover everything and match ourselves: backends disagree about
      // whether a uuid filter takes the short or the 128-bit form.
      peripheral.discoverServices([], (err2, services) => {
        if (err2 || !services || !services.length) {
          this.lastError = String((err2 && err2.message) || 'no services returned');
          return this.setStatus('error', `could not read the board's services: ${this.lastError}`);
        }
        this.services = services.map((s) => shortUuid(s.uuid));
        const svc = services.find((s) => shortUuid(s.uuid) === SERVICE_SCORING);
        if (!svc) {
          return this.setStatus('error',
            `scoring service ${SERVICE_SCORING} not found - this device offers ${this.services.join(', ')}`);
        }

        this.step = 'discovering characteristics';
        svc.discoverCharacteristics([], (err3, chars) => {
          if (err3 || !chars || !chars.length) {
            this.lastError = String((err3 && err3.message) || 'none returned');
            return this.setStatus('error', `could not read the board's characteristics: ${this.lastError}`);
          }
          this.characteristics = chars.map((c) => ({ uuid: shortUuid(c.uuid), properties: c.properties || [] }));
          const button = chars.find((c) => shortUuid(c.uuid) === CHAR_BUTTON);
          const throws = chars.find((c) => shortUuid(c.uuid) === CHAR_THROWS);
          if (!button || !throws) {
            return this.setStatus('error',
              `expected ${CHAR_THROWS}/${CHAR_BUTTON}, found ${this.characteristics.map((c) => c.uuid).join(', ')}`);
          }

          this.button = button;
          this.throws = throws;
          // Listen and subscribe BEFORE waking the board, and run the GATT
          // steps one at a time - overlapping operations get dropped on WinRT.
          throws.removeAllListeners('data');
          throws.on('data', (data) => this._onData(data));
          this.step = 'subscribing to throws';
          throws.subscribe((subErr) => {
            this.subscribeError = subErr ? String(subErr.message || subErr) : null;
            this._enable(button, name, 0);
          });
        });
      });
    });
  }

  /**
   * Put the board into scoring mode (0x03 on the button characteristic).
   * Tries write-without-response first, then with response: which one the
   * characteristic actually accepts differs between Bluetooth backends.
   */
  _enable(button, name, attempt) {
    const withoutResponse = attempt === 0;
    this.step = `enabling scoring (attempt ${attempt + 1})`;
    const done = (err) => {
      if (err && attempt === 0) return this._enable(button, name, 1);
      if (err) {
        this.lastError = String(err.message || err);
        return this.setStatus('error', `could not switch the board into scoring mode: ${this.lastError}`);
      }
      this.enabledAt = new Date().toISOString();
      this.enabledMode = withoutResponse ? 'write-without-response' : 'write-with-response';
      this.step = 'ready';
      this.setStatus('connected',
        `${name} ready${this.subscribeError ? ` (subscribe warning: ${this.subscribeError})` : ''}`);
    };
    try {
      button.write(Buffer.from([0x03]), withoutResponse, done);
    } catch (err) {
      done(err);
    }
  }

  _onData(data) {
    this.notifications++;
    this.lastPacket = data ? Buffer.from(data).toString('hex') : null;
    this.lastPacketAt = new Date().toISOString();
    this.emit('packet', { hex: this.lastPacket, at: this.lastPacketAt });
    if (!data || data.length < 2) return;
    const raw = data.readUInt8(0);
    const mult = data.readUInt8(1);
    if (raw === 85 && mult === 170) { this.emit('button'); return; }
    // 0 = thin single, 1 = fat single, 2 = double, 3 = treble
    const multiplier = mult === 0 ? 1 : mult;
    this.emit('dart', { score: rotate(raw, this.buttonNumber), multiplier, zone: mult === 0 ? 'inner' : 'outer' });
  }

  disconnect() {
    const p = this.peripheral;
    this.peripheral = null;
    try { if (this.noble) this.noble.stopScanning(); } catch (_) {}
    this.scanning = false;
    if (this.button) { try { this.button.write(Buffer.from([0x02]), true, () => {}); } catch (_) {} }
    if (p) { try { p.disconnect(() => {}); } catch (_) {} }
    this.setStatus('idle', 'disconnected');
  }
}

module.exports = { Board, rotate, normalise };
