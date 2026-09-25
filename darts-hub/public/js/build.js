/*
 * Reload this screen once when its hub starts serving new page code - after
 * an upgrade, mounted TVs and iPads would otherwise run the old code for as
 * long as nobody touches them. The daily fresh start does not change the
 * fingerprint, so it never causes a reload.
 */
window.WinchesterBuild = (function () {
  'use strict';
  var loaded = null;
  return function (build) {
    if (!build) return;
    if (loaded === null) loaded = build;
    else if (build !== loaded) location.reload();
  };
})();
