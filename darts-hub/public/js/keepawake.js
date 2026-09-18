/*
 * Keep this screen awake. TVs, the players' iPad and the till iPad are
 * mounted and must never doze off mid-session - they stay lit until staff
 * power the oche down from the console.
 *
 * Two mechanisms: the Screen Wake Lock API where the browser offers it
 * (needs HTTPS on most browsers, so rarely on our LAN pages), and otherwise
 * a 2px muted looping video - the classic kiosk trick: a playing video
 * keeps the display on. Armed on load and re-armed on every touch and on
 * returning to the page, because both mechanisms lapse when the page is
 * backgrounded. iOS only allows play() after a gesture, and every one of
 * these screens gets touched (the TV needs its one unlock tap for sound
 * anyway), so the fallback arms itself on the first contact.
 */
(function () {
  'use strict';
  let lock = null;
  let vid = null;

  async function tryLock() {
    if (lock) return true;
    try {
      if (navigator.wakeLock && navigator.wakeLock.request) {
        lock = await navigator.wakeLock.request('screen');
        lock.addEventListener('release', function () { lock = null; });
        return true;
      }
    } catch (_) {}
    return false;
  }

  function videoFallback() {
    if (!vid) {
      vid = document.createElement('video');
      vid.src = '/keepawake.mp4';
      vid.loop = true;
      vid.muted = true;
      vid.setAttribute('muted', '');
      vid.playsInline = true;
      vid.setAttribute('playsinline', '');
      vid.style.cssText = 'position:fixed;left:-4px;top:-4px;width:2px;height:2px;opacity:.01;pointer-events:none';
      (document.body || document.documentElement).appendChild(vid);
    }
    vid.play().catch(function () {});
  }

  async function arm() {
    if (!(await tryLock())) videoFallback();
  }

  // Troubleshooting handle: type WinchesterAwake() in a console to see which
  // mechanism is holding the screen on ('wake-lock', 'video', or 'off').
  window.WinchesterAwake = function () {
    return lock ? 'wake-lock' : (vid && !vid.paused ? 'video' : 'off');
  };

  document.addEventListener('visibilitychange', function () { if (!document.hidden) arm(); });
  document.addEventListener('touchstart', arm, { passive: true });
  document.addEventListener('click', arm, { passive: true });
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { arm(); });
  else arm();
})();
