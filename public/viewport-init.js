// Pinch zoom stays available (low vision). Only iOS also gets maximum-scale=1:
// it zooms into any text field under 16px on focus otherwise, and it ignores
// the value for the user's own pinch, so zooming still works there.
(() => {
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const viewport = document.querySelector('meta[name="viewport"]');
  if (ios && viewport) viewport.setAttribute('content', 'width=device-width, initial-scale=1.0, maximum-scale=1.0');
})();
