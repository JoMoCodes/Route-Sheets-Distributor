'use strict';
// "What's new" notes shown once after the app updates and on the Features log page. Add an
// entry at the top for every release, newest first. Write them ELI5-style for the person
// using the app, not for developers: plain words, short sentences, no code or file names.
// See CLAUDE.md.

const RELEASE_NOTES = [
  {
    version: '1.4.1',
    items: [
      'On each route sheet email, the pad now sits in a tall blue box on the right, next to the route, staging, wave and date. It used to be a wide box underneath them.',
      'Pad numbers like 1 or 12 are shown extra big, so drivers can spot them at a glance.',
      'The top of the email takes up less room, so drivers see their bag list sooner.',
    ],
  },
  {
    version: '1.4.0',
    items: [
      'After you import the route sheet PDF, a new "Pad for each wave" box on the Distribute page lists every wave time. Type the pad number next to each one.',
      'The pad shows in a bright blue box near the top of every route sheet email, so drivers can\'t miss it. The email subject line says it too.',
      'Each route\'s pad also shows in the All routes list, on the Route Sheets page, and in the summary files from Export all. Pads are saved with the day\'s run.',
    ],
  },
  {
    version: '1.3.0',
    items: [
      'New "How to use" page in the left menu. It walks you through each day step by step, explains the colors, and lists what to do when something goes wrong.',
      'Make the text bigger with the A+ button at the bottom-left, or hold Ctrl and press +. The app remembers your size.',
      'On How to use you can also turn on High contrast, which makes gray text darker and easier to read.',
      'Still stuck? The How to use page has an "Ask a question" button that opens the app\'s help forum.',
    ],
  },
  {
    version: '1.2.1',
    items: [
      'Each box on the Distribute page now has a "?" button. Click it to see where to download that file, with pictures.',
      'The Associate Data and Routes File help links you straight to Cortex. The Route Sheet PDF help links you to Slack.',
      'The Import buttons on the Distribute page now line up with each other.',
    ],
  },
  {
    version: '1.2.0',
    items: [
      'New "Features log" page in the left menu. It shows what changed in every version, so you can look back any time.',
      'Each new day, the app asks if you want to clear out the old days\' runs. Your driver list (Associate Data) and settings always stay.',
      'If your driver list is over a month old, the Associate Data box turns yellow and reminds you to import a fresh one.',
      'On the History page you can now open the folder where your runs are saved, or pick a new folder. Your old runs move to the new folder too.',
    ],
  },
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
