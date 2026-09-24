'use strict';
// App logic, independent of Electron so it can be tested with plain Node.

const fs = require('fs');
const path = require('path');
const { parseRouteSheetPdf } = require('./pdfParser');
const { readTable, parseAssociates, parseRoutes, parseCsvRows } = require('./tableParsers');
const { distribute, STATES } = require('./matcher');
const { buildRouteEmail, extractPages, safeFileName } = require('./exporter');
const { renderEmailHtml, subjectFor, esc } = require('./emailRender');

const DRAFT_ID = 'draft';

function localToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
  constructor(store) {
    this.store = store;
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
          }
        : null,
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

module.exports = { Service, runIdFor, runLabel, detectKind, renderSummaryHtml, STATE_LABEL, DRAFT_ID };
