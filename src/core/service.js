'use strict';
// App logic, independent of Electron so it can be tested with plain Node.

const fs = require('fs');
const path = require('path');
const { parseRouteSheetPdf } = require('./pdfParser');
const { readTable, parseAssociates, parseRoutes, parseCsvRows } = require('./tableParsers');
const { distribute, STATES } = require('./matcher');
const { buildRouteEmail, extractPages, safeFileName } = require('./exporter');
const { renderEmailHtml, subjectFor, esc } = require('./emailRender');
const mailer = require('./mailer');
const { compareVersions, notesBetween } = require('./releaseNotes');

const DRAFT_ID = 'draft';

function localDay(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
const localToday = () => localDay(new Date());

/** The same moment one calendar month later; Jan 31 becomes the last day of February. */
function addMonth(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + 1);
  d.setDate(Math.min(day, new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate()));
  return d.toISOString();
}

/** The day a saved run is for: its route sheet date, or the day it was last changed if it has none. */
function runDay(run) {
  if (run.date) return run.date;
  const d = new Date(run.updatedAt || run.createdAt);
  return Number.isNaN(d.getTime()) ? '' : localDay(d);
}

function runIdFor(sheet) {
  const parts = [sheet.station, sheet.date, sheet.cycle].filter(Boolean).map((p) => String(p).replace(/[^A-Za-z0-9-]/g, ''));
  return parts.length ? parts.join('_') : `run_${Date.now()}`;
}

function runLabel(run) {
  if (!run || !run.date) return run && run.id === DRAFT_ID ? 'New run (no route sheet PDF yet)' : run?.id || '';
  const d = new Date(`${run.date}T12:00:00`);
  const pretty = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  return [run.station, pretty, run.cycle].filter(Boolean).join(' · ');
}

/** Guesses what kind of file this is from its extension and headers. */
async function detectKind(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (ext === '.xlsx') return 'routes';
  if (ext === '.csv' || ext === '.txt') {
    const header = (parseCsvRows(buffer.toString('utf8').split(/\r?\n/).slice(0, 5).join('\n'))[0] || []).map((h) => h.toLowerCase().replace(/[^a-z]/g, ''));
    if (header.includes('routecode')) return 'routes';
    if (header.includes('transporterid')) return 'associates';
  }
  throw new Error(`Can't tell what "${path.basename(filePath)}" is. Use the route sheet PDF, the Routes .xlsx/.csv, or the Associate Data .csv.`);
}

class Service {
  /**
   * @param {Store} store
   * @param {{secrets?: {available():boolean, encrypt(s:string):string, decrypt(s:string):string}, createTransport?: Function}} [options]
   *   secrets encrypts the email App Password (Electron safeStorage in the app); createTransport is nodemailer's, swappable in tests.
   */
  constructor(store, options = {}) {
    this.store = store;
    this.secrets = options.secrets || null;
    this.createTransport = options.createTransport || null;
    this.sending = false;
    // Reopen the last run only if it is for today; older runs stay available under History.
    const last = store.getSettings().lastRunId;
    const run = last && store.loadRun(last);
    this.run = run && (run.date >= localToday() || run.id === DRAFT_ID) ? run : this.emptyRun();
  }

  emptyRun() {
    return { id: DRAFT_ID, station: null, date: null, cycle: null, createdAt: new Date().toISOString(), pdf: null, sheets: [], routesFile: null, routes: [], decisions: {}, sent: {} };
  }

  persist() {
    if (!this.run.pdf && !this.run.routesFile) return;
    this.store.saveRun(this.run);
    this.store.setSettings({ lastRunId: this.run.id });
  }

  associates() {
    const a = this.store.getAssociates();
    return a ? a.associates : [];
  }

  distribution() {
    return distribute({ sheets: this.run.sheets, routes: this.run.routes, associates: this.associates(), decisions: this.run.decisions });
  }

  state() {
    const a = this.store.getAssociates();
    const list = a ? a.associates : [];
    return {
      associates: list,
      associatesMeta: a
        ? {
            fileName: a.fileName,
            importedAt: a.importedAt,
            count: list.length,
            active: list.filter((x) => x.status === 'ACTIVE').length,
            inactive: list.filter((x) => x.status !== 'ACTIVE').length,
            missingEmail: list.filter((x) => !x.email).length,
            warnings: a.warnings || [],
            // When this import is a month old and a newer Associate Data file should be imported.
            refreshDueAt: addMonth(a.importedAt),
          }
        : null,
      output: { dir: this.store.runsDir, isDefault: this.store.runsDir === this.store.defaultRunsDir, problem: this.store.outputDirProblem },
      runs: this.store.listRuns().map((r) => ({ id: r.id, label: runLabel(r), date: r.date, updatedAt: r.updatedAt, sheets: r.sheets.length, routes: r.routes.length })),
      run: {
        id: this.run.id,
        label: runLabel(this.run),
        station: this.run.station,
        date: this.run.date,
        cycle: this.run.cycle,
        pdf: this.run.pdf,
        routesFile: this.run.routesFile,
        sheetCount: this.run.sheets.length,
        checkFailures: this.run.sheets.filter((s) => !s.check.ok).map((s) => s.routeCode),
        sent: this.run.sent,
        decisions: this.run.decisions,
      },
      distribution: this.distribution(),
      email: { problem: this.emailProblem(), fromAddress: this.emailConfig().fromAddress, sending: this.sending, unsent: this.unsentRoutes().length },
    };
  }

  async importFile(filePath, buffer, kind) {
    buffer = buffer || fs.readFileSync(filePath);
    kind = kind || (await detectKind(filePath, buffer));
    const fileName = path.basename(filePath);
    const importedAt = new Date().toISOString();

    if (kind === 'associates') {
      const { associates, warnings } = parseAssociates(await readTable(filePath, buffer));
      if (!associates.length) throw new Error(`No associates were found in ${fileName}.`);
      this.store.saveAssociates({ fileName, importedAt, associates, warnings });
      return { kind, message: `Imported ${associates.length} associates from ${fileName}.`, warnings };
    }

    if (kind === 'routes') {
      const { routes, warnings } = parseRoutes(await readTable(filePath, buffer));
      if (!routes.length) throw new Error(`No routes were found in ${fileName}.`);
      // A routes file that shares no route codes with the open run's PDF belongs to a different day.
      if (this.run.sheets.length && !routes.some((r) => this.run.sheets.some((s) => s.routeCode === r.routeCode))) {
        this.run = this.emptyRun();
      }
      this.run.routes = routes;
      this.run.routesFile = { fileName, importedAt, warnings };
      this.pruneDecisions();
      this.persist();
      return { kind, message: `Imported ${routes.length} routes from ${fileName}.`, warnings };
    }

    if (kind === 'pdf') {
      const { sheets, pageErrors, pageCount } = await parseRouteSheetPdf(buffer);
      if (!sheets.length) throw new Error(`No route sheets were found in ${fileName}.`);
      const dupes = sheets.map((s) => s.routeCode).filter((c, i, a) => a.indexOf(c) !== i);
      const warnings = pageErrors.map((e) => e.message);
      if (dupes.length) warnings.push(`Route code(s) ${[...new Set(dupes)].join(', ')} appear on more than one page; only the first page is used.`);
      const unique = sheets.filter((s, i) => sheets.findIndex((x) => x.routeCode === s.routeCode) === i);

      const id = runIdFor(unique[0]);
      if (this.run.id !== id) {
        // Opening a PDF for a different day/cycle: continue that saved run if it exists,
        // carrying over a routes file imported into an unsaved draft.
        const existing = this.store.hasRun(id) ? this.store.loadRun(id) : null;
        const draft = this.run.id === DRAFT_ID ? this.run : null;
        if (draft && draft.routesFile) this.store.deleteRun(DRAFT_ID);
        this.run = existing || { ...this.emptyRun(), id };
        if (draft && draft.routesFile) {
          this.run.routes = draft.routes;
          this.run.routesFile = draft.routesFile;
        }
      }
      Object.assign(this.run, { station: unique[0].station, date: unique[0].date, cycle: unique[0].cycle, dateLabel: unique[0].dateLabel });
      this.run.sheets = unique;
      this.run.pdf = { fileName, importedAt, pageCount, warnings };
      this.store.saveRunPdf(id, buffer);
      this.pruneDecisions();
      this.persist();
      const failed = unique.filter((s) => !s.check.ok).length;
      return { kind, message: `Read ${unique.length} route sheets from ${fileName}${failed ? ` — ${failed} did not pass the number check` : ' — all numbers check out'}.`, warnings };
    }
    throw new Error(`Unknown import kind ${kind}`);
  }

  /** Drops decisions that no longer make sense after a re-import (e.g. a chosen driver left the route). */
  pruneDecisions() {
    const listed = new Map(this.run.routes.map((r) => [r.routeCode, r.drivers.map((d) => d.transporterId)]));
    for (const [code, d] of Object.entries(this.run.decisions)) {
      if (d.manual || d.skipped) continue;
      const ids = listed.get(code) || [];
      if (!(d.recipients || []).every((id) => ids.includes(id))) delete this.run.decisions[code];
    }
  }

  setDecision(routeCode, decision) {
    if (decision) this.run.decisions[routeCode] = { ...decision, at: new Date().toISOString() };
    else delete this.run.decisions[routeCode];
    this.persist();
  }

  acceptSuggestions() {
    let n = 0;
    for (const r of this.distribution().routes) {
      if (r.state === STATES.NEEDS_DECISION && r.suggestion) {
        this.run.decisions[r.routeCode] = { recipients: [r.suggestion], viaSuggestion: true, at: new Date().toISOString() };
        n++;
      }
    }
    this.persist();
    return n;
  }

  markSent(routeCode, how) {
    if (how) this.run.sent[routeCode] = { how, at: new Date().toISOString() };
    else delete this.run.sent[routeCode];
    this.persist();
  }

  loadRun(id) {
    const run = this.store.loadRun(id);
    if (!run) throw new Error('That run could not be found.');
    this.run = run;
    this.store.setSettings({ lastRunId: id });
  }

  newRun() {
    this.run = this.emptyRun();
    this.store.setSettings({ lastRunId: null });
  }

  deleteRun(id) {
    this.store.deleteRun(id);
    if (this.run.id === id) this.newRun();
  }

  // ---------- clearing earlier days ----------

  /** Saved runs from before `today` (YYYY-MM-DD, local). */
  previousRuns(today = localToday()) {
    return this.store.listRuns().filter((r) => runDay(r) < today);
  }

  /**
   * Called when the app opens and when the date changes while it is open. The first time on a
   * new day, returns how many runs from earlier days could be cleared (so the app can ask);
   * otherwise, or when there is nothing to clear, returns 0.
   */
  newDayCheck(today = localToday()) {
    if (this.store.getSettings().lastDayCheck === today) return { previousRuns: 0 };
    this.store.setSettings({ lastDayCheck: today });
    return { previousRuns: this.previousRuns(today).length };
  }

  /** Deletes every saved run from before today. The Associate Data and settings are kept. */
  clearPreviousRuns(today = localToday()) {
    if (this.sending) throw new Error('Wait for the emails to finish sending before clearing earlier runs.');
    const old = this.previousRuns(today);
    for (const r of old) this.store.deleteRun(r.id);
    if (old.some((r) => r.id === this.run.id)) this.newRun();
    return old.length;
  }

  // ---------- output folder ----------

  /** Moves the saved runs to `dir` and keeps saving them there. */
  setOutputDir(dir) {
    if (this.sending) throw new Error('Wait for the emails to finish sending before changing the output folder.');
    return this.store.setOutputDir(dir);
  }

  sheet(routeCode) {
    return this.run.sheets.find((s) => s.routeCode === routeCode) || null;
  }

  routeResult(routeCode) {
    return this.distribution().routes.find((r) => r.routeCode === routeCode) || null;
  }

  preview(routeCode) {
    const sheet = this.sheet(routeCode);
    const route = this.routeResult(routeCode);
    if (!sheet) return { route, sheet: null, html: null, subject: null };
    const recipient = route && route.recipients[0];
    return { route, sheet, html: renderEmailHtml(sheet, recipient), subject: subjectFor(sheet) };
  }

  async emailFor(routeCode) {
    const sheet = this.sheet(routeCode);
    const route = this.routeResult(routeCode);
    if (!sheet) throw new Error(`${routeCode} has no route sheet page.`);
    const recipients = route && route.state === STATES.READY ? route.recipients : [];
    return { route, recipients, ...(await buildRouteEmail(sheet, recipients, this.store.readRunPdf(this.run.id))) };
  }

  async sheetPdf(routeCode) {
    const sheet = this.sheet(routeCode);
    const pdf = this.store.readRunPdf(this.run.id);
    if (!sheet || !pdf) throw new Error('The original route sheet PDF for this run is not available.');
    return extractPages(pdf, [sheet.pageNumber]);
  }

  // ---------- what's new ----------

  /**
   * Release notes to show once, the first time a new version opens. A fresh install shows none.
   * Versions before 1.1.1 didn't record which version was last opened, so saved data with no
   * record means this is an update from one of those, and everything after 1.0.0 is new.
   */
  whatsNewOnStart(appVersion) {
    const settings = this.store.getSettings();
    const seen = settings.lastSeenVersion;
    let notes = [];
    if (seen) {
      if (compareVersions(appVersion, seen) > 0) notes = notesBetween(seen, appVersion);
    } else if (Object.keys(settings).length || this.store.getAssociates() || this.store.listRuns().length) {
      notes = notesBetween('1.0.0', appVersion);
    }
    if (seen !== appVersion) this.store.setSettings({ lastSeenVersion: appVersion });
    return notes;
  }

  // ---------- sending email ----------

  emailConfig() {
    return mailer.normalizeSettings(this.store.getSettings().email);
  }

  /** The saved App Password, decrypted. "" if none is saved or it can't be decrypted (e.g. settings copied from another PC). */
  emailPassword() {
    const blob = this.store.getSettings().emailPassword;
    if (!blob || !this.secrets) return '';
    try {
      return this.secrets.decrypt(blob) || '';
    } catch {
      return '';
    }
  }

  /** null when email is ready to use, otherwise what still needs setting up. */
  emailProblem() {
    return mailer.validateConfig(this.emailConfig(), this.emailPassword());
  }

  emailSettings() {
    return { ...this.emailConfig(), hasPassword: !!this.emailPassword(), canStorePassword: !!(this.secrets && this.secrets.available()), problem: this.emailProblem() };
  }

  /** Saves the email settings. `password` replaces the saved App Password when given; `clearPassword` removes it. */
  saveEmailSettings(input = {}) {
    const email = mailer.normalizeSettings(input);
    this.store.setSettings({ email });
    if (input.clearPassword) {
      this.store.setSettings({ emailPassword: '' });
    } else if (input.password && input.password.trim()) {
      if (!this.secrets || !this.secrets.available()) throw new Error("The other settings were saved, but this computer can't store the App Password securely, so the password was not saved.");
      // Gmail shows App Passwords in groups of four ("abcd efgh ijkl mnop"); the spaces are not part of it.
      const pass = /(^|\.)(gmail|googlemail)\.com$/i.test(email.smtpHost) ? input.password.replace(/\s+/g, '') : input.password.trim();
      this.store.setSettings({ emailPassword: this.secrets.encrypt(pass) });
    }
    return this.emailSettings();
  }

  /** Why this route can't be emailed right now, or null if it can. */
  sendProblem(route) {
    if (!route) return 'That route is not in this run.';
    if (route.state !== STATES.READY) return route.headline || 'This route sheet is not ready to send.';
    if (!route.recipients.length) return 'Nobody is chosen to receive this route sheet.';
    const noEmail = route.recipients.filter((p) => !p.email);
    if (noEmail.length) return `No email address on file for ${noEmail.map((p) => p.name).join(' & ')}.`;
    const bad = route.recipients.find((p) => !mailer.isEmail(p.email));
    if (bad) return `"${bad.email}" (${bad.name}) is not a valid email address.`;
    return null;
  }

  /** Routes "Email all" would send: ready, with an email address, and not already marked sent. */
  unsentRoutes() {
    return this.distribution().routes.filter((r) => !this.run.sent[r.routeCode] && !this.sendProblem(r)).map((r) => r.routeCode);
  }

  /**
   * Emails each route sheet to its driver(s) over one signed-in connection. Throws before sending
   * anything if email isn't set up or the login fails. Each success is saved as sent right away.
   * @returns {Promise<{sent:string[], failed:{routeCode:string,error:string}[], skipped:{routeCode:string,reason:string}[]}>}
   */
  async emailRoutes(routeCodes, onProgress = () => {}) {
    if (this.sending) throw new Error('Route sheets are already being sent. Wait for that to finish.');
    const config = this.emailConfig();
    const password = this.emailPassword();
    const problem = mailer.validateConfig(config, password);
    if (problem) throw new Error(`Email isn't set up yet: ${problem} Open Email settings to finish setting it up.`);

    this.sending = true;
    // Sent marks go to the run the emails came from, even if another run is opened meanwhile.
    const run = this.run;
    const result = { sent: [], failed: [], skipped: [] };
    let session = null;
    try {
      const pdf = this.store.readRunPdf(run.id);
      const jobs = [];
      for (const code of routeCodes) {
        const route = this.routeResult(code);
        const why = this.sendProblem(route);
        if (why) {
          result.skipped.push({ routeCode: code, reason: why });
          continue;
        }
        const e = await buildRouteEmail(this.sheet(code), route.recipients, pdf);
        jobs.push({
          routeCode: code,
          to: route.recipients.map((p) => p.email),
          message: mailer.buildMessage(config, {
            to: route.recipients.map((p) => ({ name: p.name, address: p.email })),
            subject: e.subject,
            html: e.html,
            text: e.text,
            attachments: e.pdf ? [{ filename: e.pdfName, content: e.pdf, contentType: 'application/pdf' }] : [],
          }),
        });
      }
      if (!jobs.length) return result;

      onProgress({ done: 0, total: jobs.length });
      session = await mailer.openSession(config, password, this.createTransport);
      for (const [i, job] of jobs.entries()) {
        const r = await session.send(job.message);
        if (r.ok) {
          run.sent[job.routeCode] = { how: 'emailed', at: new Date().toISOString(), to: job.to };
          this.store.saveRun(run);
          result.sent.push(job.routeCode);
        } else {
          result.failed.push({ routeCode: job.routeCode, error: r.error });
        }
        onProgress({ done: i + 1, total: jobs.length, routeCode: job.routeCode });
      }
      return result;
    } finally {
      if (session) session.close();
      this.sending = false;
    }
  }

  /** Sends a short test message (no attachment) to confirm the login works. */
  async sendTestEmail(to) {
    const config = this.emailConfig();
    const password = this.emailPassword();
    const problem = mailer.validateConfig(config, password);
    if (problem) throw new Error(problem);
    const address = String(to || config.fromAddress).trim();
    if (!mailer.isEmail(address)) throw new Error(`"${address}" is not a valid email address.`);
    const session = await mailer.openSession(config, password, this.createTransport);
    try {
      const r = await session.send(mailer.buildTestMessage(config, address));
      if (!r.ok) throw new Error(r.error);
      return address;
    } finally {
      session.close();
    }
  }

  /** Writes drafts, single-page PDFs and a summary into `<dir>/<run label>/`. Returns the folder. */
  async exportAll(dir) {
    const dist = this.distribution();
    const folder = path.join(dir, safeFileName(runLabel(this.run).replace(/·/g, '-')) || 'Route sheets');
    const drafts = path.join(folder, 'Email drafts');
    const pdfs = path.join(folder, 'Route sheet PDFs');
    fs.mkdirSync(drafts, { recursive: true });
    fs.mkdirSync(pdfs, { recursive: true });
    let written = 0;
    for (const r of dist.routes) {
      if (!r.hasSheet) continue;
      const e = await this.emailFor(r.routeCode);
      const who = r.state === STATES.READY ? r.recipients.map((p) => p.name).join(' & ') : 'UNASSIGNED';
      const base = safeFileName(`${r.routeCode} - ${who}`);
      if (e.pdf) fs.writeFileSync(path.join(pdfs, `${base}.pdf`), e.pdf);
      if (r.state === STATES.READY) {
        fs.writeFileSync(path.join(drafts, `${base}.eml`), e.eml);
        written++;
      }
    }
    fs.writeFileSync(path.join(folder, 'Distribution summary.html'), renderSummaryHtml(this.run, dist));
    fs.writeFileSync(path.join(folder, 'Distribution summary.csv'), renderSummaryCsv(dist));
    return { folder, drafts: written };
  }
}

const STATE_LABEL = {
  ready: 'Ready to send',
  'needs-decision': 'Needs your decision',
  exception: 'No exact match',
  'no-sheet': 'No route sheet',
  skipped: 'Not sending',
};

function renderSummaryHtml(run, dist) {
  const row = (cells) => `<tr>${cells.map((c) => `<td>${c}</td>`).join('')}</tr>`;
  const routes = dist.routes.map((r) => row([
    `<b>${esc(r.routeCode)}</b>`,
    esc(r.sheet?.staging || '—'),
    esc(r.sheet?.waveTime || '—'),
    esc(r.sheet?.totalPackages ?? '—'),
    esc(r.listed.map((c) => `${c.rosterName || c.routesName} (${c.transporterId || 'no ID'})`).join(', ') || '—'),
    esc(r.recipients.map((p) => `${p.name}${p.email ? ` <${p.email}>` : ' (no email)'}`).join(', ') || '—'),
    `<span class="s ${r.state}">${STATE_LABEL[r.state]}</span>`,
    esc(r.state === 'ready' ? r.issues.filter((i) => i.level !== 'info').map((i) => i.text).join('; ') : r.headline),
  ])).join('');
  const missing = dist.people.notReceiving.map((p) => row([esc(p.name), esc(p.transporterId || '—'), esc(p.routes.map((x) => x.routeCode).join(', ')), esc(p.routes.map((x) => x.reason).join('; '))])).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Distribution summary</title><style>
body{font-family:Segoe UI,Arial,sans-serif;color:#1b2430;margin:24px}table{border-collapse:collapse;width:100%;margin:8px 0 24px}
td,th{border-bottom:1px solid #e3e7ec;padding:6px 8px;text-align:left;font-size:13px;vertical-align:top}th{background:#f3f5f8}
.s{padding:2px 8px;border-radius:10px;font-size:12px;white-space:nowrap}.ready{background:#e3f4e8;color:#1d6b35}.needs-decision{background:#fff2d6;color:#7a5100}
.exception,.no-sheet{background:#fde4e2;color:#9b1c14}.skipped{background:#eceff3;color:#505a66}</style></head><body>
<h1>Route sheet distribution — ${esc(runLabel(run))}</h1>
<p>${dist.counts.ready} ready · ${dist.counts['needs-decision']} need a decision · ${dist.counts.exception} no exact match · ${dist.counts['no-sheet']} no route sheet · ${dist.counts.skipped} not sending</p>
<h2>People who will not get a route sheet (${dist.people.notReceiving.length})</h2>
${missing ? `<table><tr><th>Name</th><th>Transporter ID</th><th>Route(s)</th><th>Why</th></tr>${missing}</table>` : '<p>Everyone listed on the routes file gets a route sheet.</p>'}
<h2>All routes</h2>
<table><tr><th>Route</th><th>Staging</th><th>Wave</th><th>Pkgs</th><th>Listed on routes file</th><th>Sending to</th><th>Status</th><th>Notes</th></tr>${routes}</table>
</body></html>`;
}

function renderSummaryCsv(dist) {
  const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [['Route', 'Staging', 'Wave', 'Total Packages', 'Listed Transporter IDs', 'Recipient', 'Recipient Transporter ID', 'Recipient Email', 'Status', 'Reason'].map(q).join(',')];
  for (const r of dist.routes) {
    lines.push([r.routeCode, r.sheet?.staging, r.sheet?.waveTime, r.sheet?.totalPackages, r.listed.map((c) => c.transporterId).join(' | '),
      r.recipients.map((p) => p.name).join(' | '), r.recipients.map((p) => p.transporterId).join(' | '), r.recipients.map((p) => p.email).join(' | '),
      STATE_LABEL[r.state], r.headline].map(q).join(','));
  }
  return lines.join('\r\n');
}

module.exports = { Service, runIdFor, runLabel, detectKind, renderSummaryHtml, addMonth, STATE_LABEL, DRAFT_ID };
