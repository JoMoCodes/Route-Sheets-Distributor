'use strict';
// "What's new" notes shown once after the app updates. Add an entry at the top for every
// release, written for the person using the app (not for developers), newest first.

const RELEASE_NOTES = [
  {
    version: '1.1.1',
    items: [
      'Updates now install quietly. Click "Restart to update" and the app reopens by itself, with no setup screens.',
      'The installer now asks whether you want a desktop shortcut.',
      'This "What\'s new" window appears once after each update. Reopen it any time from the bottom-left corner.',
    ],
  },
  {
    version: '1.1.0',
    items: [
      'Email route sheets straight from the app. Set it up once in Email settings with a Gmail App Password.',
      '"Send email" on a route sheet sends it to that driver, with the original PDF page attached.',
      '"Email all" sends every ready route sheet that hasn\'t been sent yet. Each driver gets their own email.',
    ],
  },
  {
    version: '1.0.0',
    items: ['First release.'],
  },
];

/** Compares "1.2.3" style versions: negative if a < b, 0 if equal, positive if a > b. */
function compareVersions(a, b) {
  const pa = String(a).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b).split('-')[0].split('.').map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

/** Notes for versions after `fromVersion` up to and including `toVersion`, newest first. */
function notesBetween(fromVersion, toVersion) {
  return RELEASE_NOTES.filter((n) => compareVersions(n.version, fromVersion) > 0 && compareVersions(n.version, toVersion) <= 0);
}

module.exports = { RELEASE_NOTES, compareVersions, notesBetween };
