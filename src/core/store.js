'use strict';
// Local JSON storage under the app's user-data folder:
//   associates.json              latest Associate Data import
//   settings.json                last opened run, theme, output folder
//   runs/<runId>/run.json        one route sheet run (sheets, routes, decisions, sent marks)
//   runs/<runId>/route-sheets.pdf original PDF, kept so single pages can be re-exported later
// The runs live in the "output folder": `runs/` by default, or any folder chosen in History
// (settings.outputDir), in which case each <runId>/ folder sits directly inside that folder.

const fs = require('fs');
const path = require('path');

class Store {
  constructor(dir) {
    this.dir = dir;
    this.defaultRunsDir = path.join(dir, 'runs');
    fs.mkdirSync(this.defaultRunsDir, { recursive: true });
    // Why the chosen output folder can't be used right now (e.g. a USB drive that is unplugged).
    // Runs are then read from and saved to the default folder until it is back.
    this.outputDirProblem = null;
    this.runsDir = this.defaultRunsDir;
    const chosen = this.getSettings().outputDir;
    if (chosen) {
      try {
        fs.mkdirSync(chosen, { recursive: true });
        this.runsDir = chosen;
      } catch (err) {
        this.outputDirProblem = `The output folder ${chosen} can't be opened (${err.code || err.message}), so runs are saved in the default folder for now.`;
      }
    }
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

  /** Ids of the run folders (folders holding a run.json) in the output folder. */
  runIds(dir = this.runsDir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((d) => d.isDirectory() && /^[A-Za-z0-9_.-]+$/.test(d.name) && fs.existsSync(path.join(dir, d.name, 'run.json')))
      .map((d) => d.name);
  }

  /**
   * Makes `newDir` the output folder and moves every saved run into it. Checks everything
   * before moving anything, so a problem leaves the runs where they were.
   * @returns {{dir:string, moved:number}}
   */
  setOutputDir(newDir) {
    const to = path.resolve(newDir);
    const from = path.resolve(this.runsDir);
    const same = (a, b) => (process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b);
    const inside = (child, parent) => {
      const rel = path.relative(parent, child);
      return !!rel && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    if (same(to, from)) return { dir: to, moved: 0 };

    const ids = this.runIds(from);
    const into = ids.find((id) => same(to, path.join(from, id)) || inside(to, path.join(from, id)));
    if (into) throw new Error(`The output folder can't go inside the saved run "${into}". Choose a different folder.`);
    fs.mkdirSync(to, { recursive: true });
    const clash = ids.filter((id) => fs.existsSync(path.join(to, id)));
    if (clash.length) throw new Error(`${to} already has a folder named ${clash.join(', ')}. Move or rename it first, or choose a different folder.`);

    const moved = [];
    try {
      for (const id of ids) {
        moveDir(path.join(from, id), path.join(to, id));
        moved.push(id);
      }
    } catch (err) {
      // Put back what already moved, so every run stays in one folder.
      for (const id of moved) {
        try { moveDir(path.join(to, id), path.join(from, id)); } catch { /* left in the new folder */ }
      }
      throw new Error(`The saved runs could not be moved to ${to}: ${err.message}`);
    }
    this.runsDir = to;
    this.outputDirProblem = null;
    this.setSettings({ outputDir: same(to, path.resolve(this.defaultRunsDir)) ? null : to });
    return { dir: to, moved: ids.length };
  }

  listRuns() {
    return this.runIds()
      .map((id) => this.loadRun(id))
      .filter(Boolean)
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || String(b.updatedAt).localeCompare(String(a.updatedAt)));
  }
}

/** Moves a folder, copying it when it goes to another drive (where a plain rename fails). */
function moveDir(from, to) {
  try {
    fs.renameSync(from, to);
  } catch (err) {
    if (err.code !== 'EXDEV' && err.code !== 'EPERM') throw err;
    fs.cpSync(from, to, { recursive: true, errorOnExist: true, force: false });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

module.exports = { Store };
