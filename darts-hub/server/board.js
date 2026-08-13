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
      this.noble.on('discover', (p) => this._onDiscover(p));
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
      this.setStatus('error', `Bluetooth unavailable: ${err.message}`);
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
      if (err) return this.setStatus('error', `connect failed: ${err.message || err}`);
      peripheral.discoverServices([SERVICE_SCORING], (err2, services) => {
        if (err2 || !services || !services[0]) {
          return this.setStatus('error', 'scoring service not found - is this the smartboard?');
        }
        services[0].discoverCharacteristics([CHAR_BUTTON, CHAR_THROWS], (err3, chars) => {
          if (err3 || !chars) return this.setStatus('error', 'board characteristics not found');
          const button = chars.find((c) => c.uuid === CHAR_BUTTON);
          const throws = chars.find((c) => c.uuid === CHAR_THROWS);
          if (!button || !throws) return this.setStatus('error', 'board characteristics missing');

          this.button = button;
          this.throws = throws;
          button.write(Buffer.from([0x03]), true, () => {});
          throws.subscribe(() => {});
          throws.on('data', (data) => this._onData(data));
          this.setStatus('connected', `${name} ready`);
        });
      });
    });
  }

  _onData(data) {
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
