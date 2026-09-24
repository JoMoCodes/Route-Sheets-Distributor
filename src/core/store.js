'use strict';
// Local JSON storage under the app's user-data folder:
//   associates.json              latest Associate Data import
//   settings.json                last opened run, theme
//   runs/<runId>/run.json        one route sheet run (sheets, routes, decisions, sent marks)
//   runs/<runId>/route-sheets.pdf original PDF, kept so single pages can be re-exported later

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.runsDir = path.join(dir, 'runs');
    fs.mkdirSync(this.runsDir, { recursive: true });
  }

  readJson(file, fallback) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return fallback;
    }
  }

  writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 1));
    fs.renameSync(tmp, file);
  }

  getSettings() { return this.readJson(path.join(this.dir, 'settings.json'), {}); }
  setSettings(patch) {
    const next = { ...this.getSettings(), ...patch };
    this.writeJson(path.join(this.dir, 'settings.json'), next);
    return next;
  }

  getAssociates() { return this.readJson(path.join(this.dir, 'associates.json'), null); }
  saveAssociates(data) { this.writeJson(path.join(this.dir, 'associates.json'), data); }

  runDir(id) {
    if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new Error(`Invalid run id: ${id}`);
    return path.join(this.runsDir, id);
  }
  runPdfPath(id) { return path.join(this.runDir(id), 'route-sheets.pdf'); }
  hasRun(id) { return fs.existsSync(path.join(this.runDir(id), 'run.json')); }
  loadRun(id) { return this.readJson(path.join(this.runDir(id), 'run.json'), null); }

  saveRun(run) {
    run.updatedAt = new Date().toISOString();
    this.writeJson(path.join(this.runDir(run.id), 'run.json'), run);
  }

  saveRunPdf(id, buffer) {
    fs.mkdirSync(this.runDir(id), { recursive: true });
    fs.writeFileSync(this.runPdfPath(id), buffer);
  }

  readRunPdf(id) {
    const p = this.runPdfPath(id);
    return fs.existsSync(p) ? fs.readFileSync(p) : null;
  }

  /** Moves a run to a new id (used when a draft run gets its real station/date/cycle). */
  renameRun(fromId, toId) {
    if (fromId === toId) return;
    const from = this.runDir(fromId);
    const to = this.runDir(toId);
    if (!fs.existsSync(from)) return;
    fs.rmSync(to, { recursive: true, force: true });
    fs.renameSync(from, to);
  }

  deleteRun(id) { fs.rmSync(this.runDir(id), { recursive: true, force: true }); }

  listRuns() {
    return fs.readdirSync(this.runsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => this.loadRun(d.name))
      .filter(Boolean)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}

module.exports = { Store };
