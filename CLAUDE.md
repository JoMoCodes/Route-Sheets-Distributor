# Notes for Claude

## Write summaries like you're explaining to a five-year-old

The people who read this repo's pull requests and the app's Features log are not
programmers. Anything written for them must be in plain, everyday words:

- **Pull request summaries** (title and description) and
- **Release notes** in `src/core/releaseNotes.js` (they show in the app's
  "What's new" window and Features log page).

How to write them:

- Say what changed **for the person using the app**, not how the code works.
  Good: "The app now reminds you when your driver list is over a month old."
  Bad: "Added `refreshDueAt` to `associatesMeta` and a staleness check in the renderer."
- Short sentences. One idea per bullet.
- No code words: no file names, function names, settings keys, "IPC", "renderer",
  "state", "refactor", "API", etc. Use the names people see in the app
  (button labels, page names like **History** or **Distribute**).
- If something is technical but matters, explain what it means in real life
  ("If the folder is on a USB stick that's unplugged, the app saves to its usual
  folder instead").
- Keep headings and titles short and plain, with no descriptions in brackets.
  Good: "What changed". Bad: "What changed (in plain words)".
- Use the PR template's sections. A short "For whoever maintains the app"
  section at the end may use technical words, but only there.
