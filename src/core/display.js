'use strict';
// How big and how sharp the app looks. Saved in settings.json as { textSize, contrast, theme }.

/** Text sizes, smallest first. `zoom` is the window zoom factor. */
const TEXT_SIZES = [
  { id: 'normal', label: 'Normal', zoom: 1 },
  { id: 'large', label: 'Large', zoom: 1.15 },
  { id: 'larger', label: 'Larger', zoom: 1.3 },
  { id: 'largest', label: 'Largest', zoom: 1.5 },
];

/** Fills in defaults and drops anything unknown. */
function normalizeDisplay(settings = {}) {
  return {
    theme: settings.theme === 'light' ? 'light' : 'dark',
    textSize: TEXT_SIZES.some((s) => s.id === settings.textSize) ? settings.textSize : 'normal',
    contrast: settings.contrast === 'high' ? 'high' : 'normal',
  };
}

const zoomFor = (textSize) => (TEXT_SIZES.find((s) => s.id === textSize) || TEXT_SIZES[0]).zoom;

/** The text size one step bigger (`step` 1) or smaller (-1), stopping at the ends. */
function stepTextSize(textSize, step) {
  const i = Math.max(0, TEXT_SIZES.findIndex((s) => s.id === textSize));
  return TEXT_SIZES[Math.min(TEXT_SIZES.length - 1, Math.max(0, i + step))].id;
}

module.exports = { TEXT_SIZES, normalizeDisplay, zoomFor, stepTextSize };
