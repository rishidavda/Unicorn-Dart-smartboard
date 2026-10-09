/*
 * slowdisk.js - preload (node -r / NODE_OPTIONS=--require) that makes every
 * flush to disk slow, the way a busy Windows PC's is (a slow disk, Defender
 * scanning each new file, a OneDrive-synced folder).
 *   SLOWDISK_MS=n   each fsync (sync or async) takes at least n ms (default 400)
 * Synchronous flushes block the whole process for that long, exactly as a
 * real slow FlushFileBuffers does; asynchronous ones wait in the background.
 */
'use strict';
const fs = require('fs');
const MS = Number(process.env.SLOWDISK_MS) || 400;
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const fsyncSync = fs.fsyncSync;
fs.fsyncSync = function (fd) { block(MS); return fsyncSync.call(fs, fd); };
const fsync = fs.fsync;
fs.fsync = function (fd, cb) { setTimeout(() => fsync.call(fs, fd, cb), MS); };

const open = fs.promises.open;
fs.promises.open = async function (...args) {
  const fh = await open.apply(fs.promises, args);
  const sync = fh.sync.bind(fh);
  fh.sync = async () => { await new Promise((r) => setTimeout(r, MS)); return sync(); };
  return fh;
};
