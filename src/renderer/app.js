'use strict';
/* global api */

// ---------- tiny DOM helper (all text goes through textContent; no HTML injection) ----------
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'style') el.style.cssText = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
const $ = (id) => document.getElementById(id);

// ---------- state ----------
let S = null;
const ui = { view: 'distribute', selected: null, sheetFilter: '', assocFilter: '', previewSeq: 0, sending: null, testing: false, emailSettings: null, emailDraft: null, releaseNotes: [], staleWarned: false, display: { theme: 'dark', textSize: 'normal', contrast: 'normal', textSizes: [] } };

const STATE_INFO = {
  ready: { label: 'Ready to send', tone: 'green' },
  'needs-decision': { label: 'Needs your decision', tone: 'amber' },
  exception: { label: 'No exact match', tone: 'red' },
  'no-sheet': { label: 'No route sheet', tone: 'red' },
  skipped: { label: 'Not sending', tone: 'gray' },
};
const SENT_LABEL = { emailed: 'Emailed', copied: 'Copied', draft: 'Draft opened', 'mail-app': 'Mail app opened', manual: 'Marked sent' };

async function call(fn, ...args) {
  const r = await api[fn](...args);
  if (r && r.state) S = r.state;
  if (r && !r.ok) toast(r.error, 'error');
  render();
  return r || { ok: false };
}

/** Shows a message in the corner. `action` ({ label, run }) adds a button that also closes it. */
function toast(message, tone = '', details = [], action = null) {
  const t = h('div', { class: `toast ${tone}` }, message, details.length ? h('ul', {}, details.map((d) => h('li', {}, d))) : null,
    action ? h('div', { class: 'toast-action' }, h('button', { class: 'btn small', onclick: () => { t.remove(); action.run(); } }, action.label)) : null);
  $('toasts').append(t);
  setTimeout(() => t.remove(), action ? 15000 : tone === 'error' || details.length ? 9000 : 4500);
}

const badge = (text, tone) => h('span', { class: `badge ${tone}` }, text);
const stateBadge = (state) => badge(STATE_INFO[state].label, STATE_INFO[state].tone);
const statusBadge = (status) => (status ? badge(status, status === 'ACTIVE' ? 'green' : 'red') : badge('Not in associate data', 'red'));
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const firstName = (n) => String(n || '').split(/\s+/)[0];
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const localDay = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** True once the Associate Data import is a month old. */
const associatesStale = () => !!(S && S.associatesMeta && S.associatesMeta.refreshDueAt && Date.now() >= Date.parse(S.associatesMeta.refreshDueAt));
const daysSince = (iso) => Math.floor((Date.now() - Date.parse(iso)) / 86400000);
const byState = (state) => S.distribution.routes.filter((r) => r.state === state);

// ---------- layout ----------
function render() {
  if (!S) return;
  renderNav();
  $('runLabel').textContent = S.run.label;
  renderTopActions();
  const view = $('view');
  view.className = ui.view === 'sheets' ? 'flush' : '';
  const scroll = view.scrollTop;
  view.replaceChildren(
    { distribute: viewDistribute, sheets: viewSheets, associates: viewAssociates, history: viewHistory, email: viewEmail, features: viewFeatures, help: viewHelp }[ui.view](),
  );
  if (ui.view !== 'sheets') view.scrollTop = scroll;
}

function go(view, selected) {
  ui.view = view;
  if (selected !== undefined) ui.selected = selected;
  $('view').scrollTop = 0;
  render();
}

function renderNav() {
  const c = S.distribution.counts;
  const attention = c['needs-decision'] + c.exception + c['no-sheet'];
  const items = [
    ['distribute', 'Distribute', attention || null, c.exception + c['no-sheet'] ? 'bad' : 'warn'],
    ['sheets', 'Route Sheets', c.ready || null, ''],
    ['associates', 'Associates', S.associatesMeta ? S.associatesMeta.count : null, ''],
    ['history', 'History', S.runs.length || null, ''],
    ['email', 'Email settings', S.email.problem ? 'Set up' : null, 'warn'],
    ['features', 'Features log', null, ''],
    ['help', 'How to use', null, ''],
  ];
  $('nav').replaceChildren(...items.map(([id, label, count, tone]) =>
    h('button', { class: `nav-item ${ui.view === id ? 'active' : ''}`, onclick: () => (id === 'email' ? openEmailSettings() : go(id)) },
      h('span', {}, label), count != null ? h('span', { class: `nav-count ${id === 'distribute' || id === 'email' ? tone : ''}` }, count) : null)));
}

function renderTopActions() {
  const c = S.distribution.counts;
  $('topActions').replaceChildren(
    h('button', { class: 'btn', onclick: () => call('newRun').then(() => go('distribute')) }, 'New run'),
    h('button', {
      class: 'btn',
      disabled: !c.ready,
      title: 'Save an Outlook email draft and a PDF for every route that is ready, plus a summary report',
      onclick: async () => {
        const r = await call('exportAll');
        if (r.ok && r.result) toast(`Saved ${r.result.drafts} email drafts, the PDFs, and a summary to ${r.result.folder}`, 'ok');
      },
    }, `Export all (${c.ready})`),
    h('button', {
      class: 'btn primary',
      disabled: !!ui.sending || !S.email.unsent,
      title: S.email.problem
        ? 'Set up email in Email settings to send route sheets straight from the app'
        : 'Email every ready route sheet that is not marked as sent yet, each to its own driver',
      onclick: emailAll,
    }, ui.sending ? `Sending ${ui.sending.done} of ${ui.sending.total}…` : `Email all (${S.email.unsent})`),
  );
}

// ---------- sending email ----------
function reportSend(res) {
  const n = res.sent.length;
  const details = [
    ...res.failed.map((f) => `${f.routeCode} not sent: ${f.error}`),
    ...res.skipped.map((x) => `${x.routeCode} skipped: ${x.reason}`),
  ];
  const msg = `Emailed ${n} route sheet${n === 1 ? '' : 's'}${res.failed.length ? `. ${res.failed.length} could not be sent` : ''}.`;
  toast(msg, res.failed.length ? 'error' : 'ok', details);
}

function needsEmailSetup() {
  if (!S.email.problem) return false;
  toast(`Set up email first: ${S.email.problem}`, 'error');
  openEmailSettings();
  return true;
}

async function emailAll() {
  if (needsEmailSetup()) return;
  const r = await call('emailAll');
  ui.sending = null;
  render();
  if (r.ok && r.result) reportSend(r.result);
}

async function sendOne(routeCode) {
  if (needsEmailSetup()) return;
  const r = await call('sendEmail', routeCode);
  ui.sending = null;
  render();
  if (r.ok && r.result) {
    const to = S.run.sent[routeCode] && S.run.sent[routeCode].to;
    toast(`Emailed ${routeCode}${to && to.length ? ` to ${to.join(', ')}` : ''}.`, 'ok');
  }
}

// ---------- Distribute ----------
function viewDistribute() {
  const d = S.distribution;
  const c = d.counts;
  const hasData = S.run.sheetCount || S.run.routesFile;
  const root = h('div', {}, importCards());

  if (!hasData) {
    root.append(h('div', { class: 'panel empty section' },
      h('h2', {}, 'Start a run'),
      h('p', {}, '1. Import the Associate Data CSV (only needed when your roster changes).'),
      h('p', {}, '2. Import the route sheet PDF and the Routes export (.xlsx) for the day.'),
      h('p', { class: 'faint' }, 'You can also drag all the files onto this window at once.'),
      h('p', {}, 'New here? ', h('button', { class: 'link', onclick: () => go('help') }, 'Read How to use'), ' for step-by-step help.')));
    return root;
  }

  root.append(h('div', { class: 'grid stats' },
    stat(c.ready, 'Ready to send', 'green'),
    stat(c['needs-decision'], 'Need your decision', c['needs-decision'] ? 'amber' : 'gray'),
    stat(c.exception, 'No exact match', c.exception ? 'red' : 'gray'),
    stat(c['no-sheet'], 'Missing from the PDF', c['no-sheet'] ? 'red' : 'gray'),
    stat(d.people.notReceiving.length, 'People not getting a sheet', d.people.notReceiving.length ? 'amber' : 'gray')));

  if (!S.associatesMeta) {
    root.append(h('div', { class: 'callout warn section' }, h('div', {}, h('b', {}, 'Import the Associate Data CSV. '), 'Without it no Transporter ID can be matched, so nothing is ready to send.'),
      h('button', { class: 'btn', onclick: () => doImport('associates') }, 'Import Associate Data')));
  }

  const decisions = byState('needs-decision');
  if (decisions.length) {
    const withSuggestion = decisions.filter((r) => r.suggestion).length;
    root.append(section(
      `Choose who gets these route sheets (${decisions.length})`,
      'These routes list more than one Transporter ID. Only the driver you pick gets the sheet.',
      withSuggestion ? h('button', { class: 'btn', onclick: async () => { const r = await call('acceptSuggestions'); if (r.ok) toast(`Applied ${r.result} suggestion${r.result === 1 ? '' : 's'}. You can still change any of them below.`, 'ok'); } }, `Accept all ${withSuggestion} suggestions`) : null,
      h('div', { class: 'grid decisions' }, decisions.map(decisionCard))));
  }

  const exceptions = byState('exception');
  if (exceptions.length) {
    root.append(section(
      `No exact match (${exceptions.length})`,
      'These route sheets have no driver the app can confirm. Choose who should get each one, or don\'t send it.',
      null,
      h('div', { class: 'grid decisions' }, exceptions.map(exceptionCard))));
  }

  const noSheet = byState('no-sheet');
  if (noSheet.length) {
    root.append(section(`On the routes file but missing from the PDF (${noSheet.length})`, 'There is no route sheet to send for these routes. Get the missing pages and import the PDF again.', null,
      h('div', { class: 'panel table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Route'), h('th', {}, 'Listed driver(s)'), h('th', {}, 'Why'))),
        h('tbody', {}, noSheet.map((r) => h('tr', {},
          h('td', {}, h('b', {}, r.routeCode)),
          h('td', {}, r.listed.map((c) => h('div', {}, c.rosterName || c.routesName, ' ', h('span', { class: 'mono faint' }, c.transporterId)))),
          h('td', {}, r.headline))))))));
  }

  root.append(section(
    `People who won't get a route sheet (${d.people.notReceiving.length})`,
    'Everyone named on the routes file who is not receiving any route sheet right now, and why.',
    null,
    d.people.notReceiving.length
      ? h('div', { class: 'panel table-wrap' }, h('table', { class: 'data' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Transporter ID'), h('th', {}, 'Associate data'), h('th', {}, 'Route'), h('th', {}, 'Why'))),
        h('tbody', {}, d.people.notReceiving.flatMap((p) => p.routes.map((x, i) => h('tr', {},
          h('td', {}, i === 0 ? h('b', {}, p.name) : ''),
          h('td', { class: 'mono' }, i === 0 ? p.transporterId || '—' : ''),
          h('td', {}, i === 0 ? statusBadge(p.inRoster ? p.status : null) : ''),
          h('td', {}, h('button', { class: 'link', onclick: () => jumpTo(x.routeCode) }, x.routeCode)),
          h('td', {}, x.reason)))))))
      : h('div', { class: 'callout ok' }, 'Everyone listed on the routes file is getting a route sheet.')));

  if (d.people.multiple.length) {
    root.append(section('Getting more than one route sheet', 'Check these are intended.', null,
      h('div', { class: 'panel table-wrap' }, h('table', { class: 'data' },
        h('tbody', {}, d.people.multiple.map((p) => h('tr', {}, h('td', {}, h('b', {}, p.name)), h('td', { class: 'mono' }, p.transporterId), h('td', {}, p.routes.join(', ')))))))));
  }

  root.append(section('All routes', 'Click a route to open its route sheet.', null, allRoutesTable()));
  return root;
}

function jumpTo(routeCode) {
  const r = S.distribution.routes.find((x) => x.routeCode === routeCode);
  if (r && r.hasSheet) go('sheets', routeCode);
}

function stat(n, label, tone) {
  return h('div', { class: `panel stat ${tone}` }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, label));
}

function section(title, sub, action, body) {
  return h('div', { class: 'section' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, title), sub ? h('p', {}, sub) : null), action),
    body);
}

function importCards() {
  const a = S.associatesMeta;
  const pdf = S.run.pdf;
  const rf = S.run.routesFile;
  const multi = S.distribution.routes.filter((r) => r.listed.length > 1).length;
  const stale = associatesStale();
  const card = (title, ok, file, detail, warnings, kind, old = false) => h('div', { class: `panel import-card ${old ? 'stale' : ''}` },
    h('div', { class: 'title' }, h('span', { class: 'title-text' }, title, helpButton(kind, title)), old ? badge('Over a month old', 'amber') : ok ? badge('Loaded', 'green') : badge('Not loaded', 'gray')),
    h('div', { class: 'file' }, file || 'No file yet'),
    detail ? h('div', { class: 'detail' }, detail) : null,
    old ? h('div', { class: 'stale-note' }, `Last imported ${plural(daysSince(a.importedAt), 'day')} ago. Import the latest Associate Data so new drivers, status changes and email addresses are up to date.`) : null,
    warnings && warnings.length ? h('ul', { class: 'issues' }, warnings.map((w) => h('li', { class: 'warn' }, w))) : null,
    h('div', { class: 'card-actions' }, h('button', { class: ok && !old ? 'btn small' : 'btn primary small', onclick: () => doImport(kind) }, old ? 'Import new…' : ok ? 'Replace…' : 'Import…')));

  return h('div', {},
    h('div', { class: 'grid imports' },
      card('Associate Data', !!a, a && `${a.fileName} · ${fmtDateTime(a.importedAt)}`,
        a && `${a.count} associates · ${a.active} active · ${a.inactive} inactive${a.missingEmail ? ` · ${a.missingEmail} without email` : ''}`, a && a.warnings, 'associates', stale),
      card('Route Sheet PDF', !!pdf, pdf && `${pdf.fileName} · ${fmtDateTime(pdf.importedAt)}`,
        pdf && (S.run.checkFailures.length
          ? h('span', { style: 'color:var(--red)' }, `${S.run.sheetCount} sheets · ${S.run.checkFailures.length} failed the number check (${S.run.checkFailures.join(', ')})`)
          : h('span', {}, `${S.run.sheetCount} route sheets · `, h('span', { style: 'color:var(--green)' }, 'every sheet\'s numbers add up'))), pdf && pdf.warnings, 'pdf'),
      card('Routes File', !!rf, rf && `${rf.fileName} · ${fmtDateTime(rf.importedAt)}`,
        rf && `${S.distribution.routes.filter((r) => r.onRoutesFile).length} routes${multi ? ` · ${multi} with more than one Transporter ID` : ''}`, rf && rf.warnings, 'routes')),
    h('p', { class: 'faint', style: 'margin:8px 2px 0;font-size:12.5px' }, 'Tip: drag and drop the files onto this window.'));
}

// Where to download each file. Each step is text or a mix of text and { text, href } links, with an
// optional screenshot (from renderer/help) showing what to click.
const CORTEX = { text: 'Cortex', href: 'https://logistics.amazon.com/dspconsolev2' };
const IMPORT_HELP = {
  associates: [
    { text: ['Go to ', CORTEX, '.'] },
    { text: 'Open the Administration menu at the top and click Associates.', img: 'cortex-administration-menu.png' },
    { text: 'Click the My associates tab, then click the download button on the right.', img: 'cortex-my-associates-tab.png' },
    { text: 'Import the downloaded file here.' },
  ],
  routes: [
    { text: ['Go to ', CORTEX, '.'] },
    { text: 'Open the Operations menu at the top and click Delivery.', img: 'cortex-operations-menu.png' },
    { text: 'Stay on the Routes tab and click the download button on the right.', img: 'cortex-routes-tab.png' },
    { text: 'Import the downloaded file here.' },
  ],
  pdf: [
    { text: ['Go to ', { text: 'Slack', href: 'https://slack.com/' }, '.'] },
    { text: 'Navigate to your "escalations" chatroom and download the PDF for your Route Sheets.', img: 'slack-download-pdf.png' },
  ],
};

const helpButton = (kind, title) => h('button', { class: 'help-btn', type: 'button', title: `Where do I get the ${title}?`, 'aria-label': `Where do I get the ${title}?`, onclick: () => showImportHelp(kind, title) }, '?');

function showImportHelp(kind, title) {
  const part = (p) => (typeof p === 'string' ? p : h('a', { href: p.href, target: '_blank', rel: 'noopener' }, p.text));
  showModal(h('div', { class: 'modal panel help-modal', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'importHelpTitle' },
    h('h2', { id: 'importHelpTitle' }, `Where to get the ${title}`),
    h('div', { class: 'modal-body' }, h('ol', { class: 'help-steps' }, IMPORT_HELP[kind].map((step) => h('li', {},
      h('div', {}, [].concat(step.text).map(part)),
      step.img ? h('img', { class: 'help-shot', src: `help/${step.img}`, alt: '' }) : null)))),
    h('div', { class: 'toolbar', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => { closeModal(); doImport(kind); } }, 'Import…'),
      h('button', { class: 'btn primary', onclick: closeModal }, 'Got it'))));
}

async function doImport(kind) {
  const r = await call('import', kind);
  if (r.ok && r.result) toast(r.result.message, 'ok', r.result.warnings || []);
}

function routeMeta(r) {
  const s = r.sheet;
  if (!s) return 'No route sheet page';
  return [s.staging, s.waveTime, `${s.totalPackages} pkgs`, s.serviceType].filter(Boolean).join(' · ');
}

function candidateOption(r, c, { allowPick = true } = {}) {
  const name = c.rosterName || c.routesName || '(no name)';
  const suggested = r.suggestion && r.suggestion === c.transporterId;
  const why = [];
  if (suggested) why.push(h('div', { class: 'why good' }, `★ Suggested: ${r.suggestionReason}`));
  if (c.otherRoutes.length) why.push(h('div', { class: 'why warn' }, `Also listed on ${c.otherRoutes.join(', ')}`));
  if (c.problem) why.push(h('div', { class: 'why bad' }, c.problem));
  if (c.nameMismatch) why.push(h('div', { class: 'why warn' }, `Routes file name "${c.routesName}" doesn't match this ID's associate "${c.rosterName}"`));

  let action = null;
  if (allowPick) {
    if (c.valid) action = h('button', { class: suggested ? 'btn primary small' : 'btn small', onclick: () => call('setDecision', r.routeCode, { recipients: [c.transporterId] }) }, `Send to ${firstName(name)}`);
    else if (c.found) action = h('button', { class: 'btn small danger', title: 'This associate is not ACTIVE', onclick: () => call('setDecision', r.routeCode, { recipients: [c.transporterId], override: true }) }, 'Send anyway');
    else action = h('span', { class: 'faint', style: 'font-size:12px' }, "Can't send — not in associate data");
  }
  return h('div', { class: `option ${suggested ? 'suggested' : ''} ${c.valid ? '' : 'invalid'}` },
    h('div', {},
      h('div', { class: 'who' }, name),
      h('div', { class: 'sub' },
        h('span', { class: 'mono' }, c.transporterId || 'no Transporter ID'),
        c.found ? statusBadge(c.status) : statusBadge(null),
        c.found ? (c.email ? h('span', {}, c.email) : h('span', { style: 'color:var(--amber)' }, 'no email on file')) : null,
        c.routesName && c.rosterName && c.routesName !== c.rosterName ? h('span', { class: 'faint' }, `routes file: "${c.routesName}"`) : null),
      why),
    action);
}

function assignControl(r) {
  const select = h('select', {}, h('option', { value: '' }, 'Choose who should get it…'),
    h('optgroup', { label: 'Active associates' }, S.associates.filter((a) => a.status === 'ACTIVE').map((a) => h('option', { value: a.transporterId }, `${a.name} — ${a.transporterId}${a.email ? '' : ' (no email)'}`))),
    h('optgroup', { label: 'Inactive associates' }, S.associates.filter((a) => a.status !== 'ACTIVE').map((a) => h('option', { value: a.transporterId }, `${a.name} — ${a.transporterId} (${a.status})`))));
  return h('div', { class: 'assign' }, select,
    h('button', { class: 'btn small', onclick: () => { if (!select.value) return toast('Pick someone from the list first.', 'error'); call('setDecision', r.routeCode, { recipients: [select.value], manual: true }); } }, 'Assign'));
}

function decisionCard(r) {
  const valid = r.listed.filter((c) => c.valid);
  return h('div', { class: 'panel decision' },
    h('div', { class: 'decision-head' },
      h('div', {}, h('div', { class: 'route-code' }, r.routeCode), h('div', { class: 'route-meta' }, routeMeta(r))),
      badge(`${r.listed.length} Transporter IDs`, 'amber')),
    h('div', { class: 'question' }, 'Who should get this route sheet?'),
    r.listed.map((c) => candidateOption(r, c)),
    r.issues.filter((i) => i.level === 'info').length ? h('ul', { class: 'issues' }, r.issues.filter((i) => i.level === 'info').map((i) => h('li', { class: i.level }, i.text))) : null,
    h('div', { class: 'decision-foot' },
      valid.length > 1 ? h('button', { class: 'btn small', onclick: () => call('setDecision', r.routeCode, { recipients: valid.map((c) => c.transporterId) }) }, `Send to all ${valid.length}`) : null,
      h('button', { class: 'btn small', onclick: () => call('setDecision', r.routeCode, { skipped: true }) }, "Don't send"),
      h('button', { class: 'link', style: 'margin-left:auto', onclick: () => go('sheets', r.routeCode) }, 'Preview sheet')),
    h('details', {}, h('summary', { class: 'faint', style: 'cursor:pointer;font-size:13px' }, 'Send to someone else'), h('div', { style: 'margin-top:8px' }, assignControl(r))));
}

function exceptionCard(r) {
  return h('div', { class: 'panel decision exception' },
    h('div', { class: 'decision-head' },
      h('div', {}, h('div', { class: 'route-code' }, r.routeCode), h('div', { class: 'route-meta' }, routeMeta(r))),
      badge('No exact match', 'red')),
    h('div', { style: 'color:var(--red);font-weight:600' }, r.headline),
    h('ul', { class: 'issues' }, r.issues.map((i) => h('li', { class: i.level }, i.text))),
    r.listed.length ? h('div', {}, h('div', { class: 'question', style: 'margin-bottom:8px' }, 'Listed on the routes file'), r.listed.map((c) => candidateOption(r, c, { allowPick: r.sheet && r.sheet.checkOk }))) : null,
    h('div', { class: 'question' }, 'Who should get it?'),
    assignControl(r),
    h('div', { class: 'decision-foot' },
      h('button', { class: 'btn small', onclick: () => call('setDecision', r.routeCode, { skipped: true }) }, "Don't send"),
      h('button', { class: 'link', onclick: () => call('viewOriginal', r.routeCode) }, 'View original PDF page'),
      h('button', { class: 'link', style: 'margin-left:auto', onclick: () => go('sheets', r.routeCode) }, 'Preview sheet')));
}

function allRoutesTable() {
  const routes = S.distribution.routes;
  if (!routes.length) return h('div', { class: 'panel empty' }, 'No routes yet.');
  return h('div', { class: 'panel table-wrap' }, h('table', { class: 'data' },
    h('thead', {}, h('tr', {},
      h('th', {}, 'Route'), h('th', {}, 'Staging'), h('th', {}, 'Wave'), h('th', { class: 'num' }, 'Bags'), h('th', { class: 'num' }, 'Pkgs'),
      h('th', {}, 'On routes file'), h('th', {}, 'Sending to'), h('th', {}, 'Status'), h('th', {}, ''))),
    h('tbody', {}, routes.map((r) => h('tr', { class: r.hasSheet ? 'clickable' : '', onclick: () => jumpTo(r.routeCode) },
      h('td', {}, h('b', {}, r.routeCode)),
      h('td', {}, r.sheet ? r.sheet.staging : '—'),
      h('td', { style: 'white-space:nowrap' }, r.sheet ? r.sheet.waveTime : '—'),
      h('td', { class: 'num' }, r.sheet ? r.sheet.bagCount : '—'),
      h('td', { class: 'num' }, r.sheet ? r.sheet.totalPackages : '—'),
      h('td', {}, r.listed.length ? r.listed.map((c) => h('div', {}, c.rosterName || c.routesName, ' ', h('span', { class: 'mono faint' }, c.transporterId))) : h('span', { class: 'faint' }, 'Not on routes file')),
      h('td', {}, r.recipients.length ? r.recipients.map((p) => h('div', {}, p.name, p.email ? null : h('span', { style: 'color:var(--amber)' }, ' · no email'))) : h('span', { class: 'faint' }, '—')),
      h('td', {}, stateBadge(r.state), r.source === 'decision' ? h('div', { class: 'faint', style: 'font-size:12px;margin-top:3px' }, 'your choice') : null),
      h('td', {}, r.source === 'decision' ? h('button', { class: 'link', onclick: (e) => { e.stopPropagation(); call('setDecision', r.routeCode, null); } }, 'Change') : null))))));
}

// ---------- Route sheets ----------
function viewSheets() {
  const routes = S.distribution.routes.filter((r) => r.hasSheet);
  if (!routes.length) return h('div', { class: 'empty', style: 'padding:80px' }, 'Import a route sheet PDF on the Distribute page to see route sheets here.');
  if (!ui.selected || !routes.some((r) => r.routeCode === ui.selected)) {
    ui.selected = (routes.find((r) => r.state === 'ready') || routes[0]).routeCode;
  }
  const q = ui.sheetFilter.toLowerCase();
  const matches = (r) => !q || [r.routeCode, r.sheet.staging, ...r.recipients.map((p) => p.name), ...r.listed.map((c) => `${c.rosterName} ${c.routesName} ${c.transporterId}`)].join(' ').toLowerCase().includes(q);
  const groups = [
    ['Ready to send', routes.filter((r) => r.state === 'ready')],
    ['Waiting on you', routes.filter((r) => r.state === 'needs-decision' || r.state === 'exception')],
    ['Not sending', routes.filter((r) => r.state === 'skipped')],
  ];

  const search = h('input', { class: 'search', placeholder: 'Search route, staging, or driver', value: ui.sheetFilter, oninput: (e) => { ui.sheetFilter = e.target.value; const pos = e.target.selectionStart; render(); const s = document.querySelector('.sheet-list .search'); s.focus(); s.setSelectionRange(pos, pos); } });
  const list = h('div', { class: 'sheet-list' }, search,
    h('div', { class: 'sheet-items' }, groups.map(([label, rs]) => {
      const shown = rs.filter(matches);
      if (!shown.length) return null;
      return [h('div', { class: 'group-label' }, `${label} (${shown.length})`), shown.map(sheetListItem)];
    })));

  return h('div', { class: 'sheets' }, list, sheetDetail(routes.find((r) => r.routeCode === ui.selected)));
}

function sheetListItem(r) {
  const sent = S.run.sent[r.routeCode];
  let right = null;
  if (r.state === 'ready') right = sent ? badge(`✓ ${SENT_LABEL[sent.how] || 'Sent'}`, 'blue') : r.recipients.some((p) => !p.email) ? badge('No email', 'amber') : null;
  else right = stateBadge(r.state);
  return h('button', { class: `sheet-item ${ui.selected === r.routeCode ? 'active' : ''}`, onclick: () => { ui.selected = r.routeCode; render(); } },
    h('div', {}, h('span', { class: 'code' }, r.routeCode), h('span', { class: 'staging' }, r.sheet.staging)),
    h('div', {}, right),
    h('div', { class: 'to' }, r.recipients.length ? `→ ${r.recipients.map((p) => p.name).join(' & ')}` : r.headline));
}

function sheetDetail(r) {
  const ready = r.state === 'ready';
  const sent = S.run.sent[r.routeCode];
  const noEmail = ready && r.recipients.some((p) => !p.email);
  const s = r.sheet;

  const frame = h('iframe', { class: 'preview-frame', sandbox: 'allow-same-origin', title: 'Email preview' });
  frame.addEventListener('load', () => {
    try { frame.style.height = `${frame.contentDocument.documentElement.scrollHeight + 4}px`; } catch { /* ignore */ }
  });
  const seq = ++ui.previewSeq;
  api.preview(r.routeCode).then((res) => {
    if (seq !== ui.previewSeq || !res.ok || !res.result.html) return;
    frame.srcdoc = res.result.html;
  });

  const act = (label, fn, opts = {}) => h('button', { class: `btn small ${opts.primary ? 'primary' : ''}`, disabled: opts.disabled, title: opts.title, onclick: fn }, label);
  const needReady = { disabled: !ready, title: ready ? undefined : 'Choose who gets this route sheet on the Distribute page first' };

  const recipient = ready
    ? h('div', { class: 'recipient' },
      h('div', { class: 'eyebrow' }, 'Send to'),
      r.recipients.map((p) => h('div', {}, h('span', { class: 'name' }, p.name), ' ', h('span', { class: 'mono faint' }, p.transporterId), ' ',
        p.email ? h('span', { class: 'muted' }, p.email) : badge('No email on file', 'amber'))))
    : h('div', { class: 'recipient' }, h('div', { class: 'eyebrow' }, 'Send to'), h('div', { style: 'color:var(--amber);font-weight:600' }, r.headline),
      h('button', { class: 'link', style: 'text-align:left', onclick: () => go('distribute') }, 'Resolve on the Distribute page →'));

  const head = h('div', { class: 'detail-head' },
    h('div', { class: 'detail-title' },
      h('div', {}, h('div', { class: 'route-code', style: 'font-size:26px' }, r.routeCode, ' ', h('span', { class: 'muted', style: 'font-weight:500' }, s.staging)),
        h('div', { class: 'route-meta' }, [s.station, s.dateLabel, s.cycle, s.waveTime].filter(Boolean).join(' · '))),
      recipient),
    h('div', { class: 'toolbar' },
      act(ui.sending ? 'Sending…' : 'Send email', () => sendOne(r.routeCode), {
        disabled: !ready || noEmail || !!ui.sending,
        primary: ready && !noEmail && !S.email.problem,
        title: !ready ? needReady.title : noEmail ? 'No email address is on file for this driver'
          : S.email.problem ? 'Set up email in Email settings first' : `Sends this route sheet with its PDF page from ${S.email.fromAddress}`,
      }),
      act('Copy for email', async () => { const x = await call('copyEmail', r.routeCode); if (x.ok) toast('Copied. Paste into a new email (Ctrl+V). The tables keep their formatting.', 'ok'); }, { ...needReady, primary: ready && (noEmail || !!S.email.problem) }),
      act('Open email draft', () => call('openDraft', r.routeCode), { ...needReady, title: ready ? 'Opens a ready-to-send draft in Outlook with the PDF page attached' : needReady.title }),
      act('Copy + open mail app', async () => { const x = await call('openMailApp', r.routeCode); if (x.ok) toast('Your mail app is opening with the address and subject. Paste the copied sheet into the body.', 'ok'); }, needReady),
      act('Save PDF page', async () => { const x = await call('savePdf', r.routeCode); if (x.ok && x.result) toast(`Saved ${x.result}`, 'ok'); }),
      act('View original page', () => call('viewOriginal', r.routeCode)),
      h('span', { style: 'flex:1' }),
      ready ? (sent
        ? h('span', { class: 'toolbar' }, badge(`✓ ${SENT_LABEL[sent.how] || 'Sent'} ${fmtDateTime(sent.at)}`, 'blue'), h('button', { class: 'link', onclick: () => call('markSent', r.routeCode, null) }, 'Undo'))
        : act('Mark as sent', () => call('markSent', r.routeCode, 'manual'))) : null),
    noEmail ? h('div', { class: 'callout warn' }, 'No email address is on file for this driver. Use "Copy for email" and send it another way, or add their email to the Associate Data and import it again.') : null,
    ready && !noEmail && S.email.problem ? h('div', { class: 'callout' }, h('div', {}, 'To send route sheets straight from the app, set up email once.'), h('button', { class: 'btn small', onclick: openEmailSettings }, 'Set up email')) : null);

  const check = s.checkOk
    ? h('div', { style: 'color:var(--green);font-size:13px' }, `✓ Verified: ${s.bagCount} bags, ${s.overflowCount} overflow packages, ${s.totalPackages} total all add up`)
    : h('ul', { class: 'issues' }, s.checkProblems.map((p) => h('li', { class: 'error' }, p)));
  const fact = (k, v) => h('div', { class: 'fact' }, h('span', { class: 'k' }, k), h('span', { class: 'v' }, v ?? '—'));
  const side = h('div', { class: 'grid' },
    h('div', { class: 'panel facts' },
      h('div', { class: 'question' }, 'Route sheet'),
      fact('Route', r.routeCode), fact('Staging', s.staging), fact('Wave', s.waveTime), fact('Date', s.dateLabel),
      fact('Service type', s.serviceType), fact('Bags', s.bagCount), fact('Overflow packages', s.overflowCount),
      fact('Total packages', s.totalPackages), fact('Commercial packages', s.commercialPackages), fact('PDF page', s.pageNumber), check),
    h('div', { class: 'panel facts' },
      h('div', { class: 'question' }, 'Transporter ID match'),
      r.listed.length ? r.listed.map((c) => h('div', {},
        h('div', { style: 'font-weight:600' }, c.rosterName || c.routesName || '(no name)'),
        h('div', { class: 'sub', style: 'display:flex;gap:8px;align-items:center;margin-top:2px' }, h('span', { class: 'mono muted' }, c.transporterId || 'no ID'), statusBadge(c.found ? c.status : null)))) : h('div', { class: 'faint' }, 'Not on the routes file'),
      r.issues.length ? h('ul', { class: 'issues' }, r.issues.map((i) => h('li', { class: i.level }, i.text))) : h('div', { style: 'color:var(--green);font-size:13px' }, '✓ Exact match, nothing to review')));

  return h('div', { class: 'sheet-detail' }, head,
    h('div', { class: 'detail-body' }, h('div', {}, h('div', { class: 'preview-label' }, 'Email preview: exactly what the driver will see'), frame), side));
}

// ---------- Associates ----------
function viewAssociates() {
  const a = S.associatesMeta;
  const routesById = new Map();
  for (const r of S.distribution.routes) for (const c of r.listed) {
    if (!routesById.has(c.transporterId)) routesById.set(c.transporterId, []);
    routesById.get(c.transporterId).push(r.routeCode);
  }
  const q = ui.assocFilter.toLowerCase();
  const rows = S.associates.filter((x) => !q || `${x.name} ${x.transporterId} ${x.email} ${x.status}`.toLowerCase().includes(q));
  const today = new Date();
  const expired = (d) => { const t = new Date(d); return !Number.isNaN(t.getTime()) && t < today; };

  const search = h('input', { class: 'search', placeholder: 'Search name, Transporter ID, email', value: ui.assocFilter, oninput: (e) => { ui.assocFilter = e.target.value; const pos = e.target.selectionStart; render(); const s = document.querySelector('#view .search'); s.focus(); s.setSelectionRange(pos, pos); } });
  return h('div', {},
    h('div', { class: 'section-head' },
      h('div', {}, h('h2', {}, 'Associate Data'), h('p', {}, a ? `${a.fileName} · imported ${fmtDateTime(a.importedAt)} · ${a.count} associates (${a.active} active, ${a.inactive} inactive)${a.missingEmail ? ` · ${a.missingEmail} without email` : ''}` : 'Not imported yet. Route sheets are matched to associates by exact Transporter ID.')),
      h('div', { class: 'toolbar' }, search, h('button', { class: 'btn primary', onclick: () => doImport('associates') }, a ? 'Import new Associate Data' : 'Import Associate Data'))),
    a && a.warnings.length ? h('ul', { class: 'issues', style: 'margin-bottom:12px' }, a.warnings.map((w) => h('li', { class: 'warn' }, w))) : null,
    h('div', { class: 'panel table-wrap' }, rows.length ? h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Transporter ID'), h('th', {}, 'Status'), h('th', {}, 'Email'), h('th', {}, 'Phone'), h('th', {}, 'ID expiration'), h('th', {}, 'Qualifications'), h('th', {}, 'On this run'))),
      h('tbody', {}, rows.map((x) => h('tr', {},
        h('td', {}, h('b', {}, x.name), x.position ? h('div', { class: 'faint', style: 'font-size:12px' }, x.position) : null),
        h('td', { class: 'mono' }, x.transporterId),
        h('td', {}, statusBadge(x.status)),
        h('td', {}, x.email || h('span', { style: 'color:var(--amber)' }, 'none')),
        h('td', {}, x.workPhone || x.personalPhone || h('span', { class: 'faint' }, '—')),
        h('td', { style: expired(x.idExpiration) ? 'color:var(--red)' : '' }, x.idExpiration || '—', expired(x.idExpiration) ? ' (expired)' : ''),
        h('td', { class: 'muted', style: 'font-size:12.5px;max-width:260px' }, x.qualifications),
        h('td', {}, (routesById.get(x.transporterId) || []).map((code) => h('button', { class: 'link', style: 'margin-right:6px', onclick: () => jumpTo(code) }, code))))))) : h('div', { class: 'empty' }, a ? 'No associates match your search.' : 'Import the Associate Data CSV to get started.')));
}

// ---------- History ----------
async function changeOutputFolder() {
  const r = await call('changeOutputFolder');
  if (r.ok && r.result) toast(`Output folder changed to ${r.result.dir}.${r.result.moved ? ` Moved ${plural(r.result.moved, 'saved run')} there.` : ''}`, 'ok');
}

function viewHistory() {
  const o = S.output;
  return h('div', {},
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Saved runs'), h('p', {}, 'Every route sheet PDF you import is saved here with your decisions, so you can reopen or resend it later.')),
      h('div', { class: 'toolbar' },
        h('button', { class: 'btn', onclick: () => call('openOutputFolder') }, 'Open output folder'),
        h('button', { class: 'btn', title: 'Choose where saved runs are kept. The runs already saved move to the new folder.', onclick: changeOutputFolder }, 'Change output folder…'))),
    h('div', { class: 'output-path' }, h('span', { class: 'faint' }, o.isDefault ? 'Output folder (default): ' : 'Output folder: '), h('span', { class: 'mono' }, o.dir)),
    o.problem ? h('div', { class: 'callout warn', style: 'margin-bottom:12px' }, h('div', {}, o.problem), h('button', { class: 'btn small', onclick: changeOutputFolder }, 'Choose another folder')) : null,
    h('div', { class: 'panel table-wrap' }, S.runs.length ? h('table', { class: 'data' },
      h('thead', {}, h('tr', {}, h('th', {}, 'Run'), h('th', { class: 'num' }, 'Route sheets'), h('th', { class: 'num' }, 'Routes'), h('th', {}, 'Last changed'), h('th', {}, ''))),
      h('tbody', {}, S.runs.map((r) => h('tr', {},
        h('td', {}, h('b', {}, r.label), r.id === S.run.id ? h('span', { style: 'margin-left:8px' }, badge('Open', 'blue')) : null),
        h('td', { class: 'num' }, r.sheets),
        h('td', { class: 'num' }, r.routes),
        h('td', {}, fmtDateTime(r.updatedAt)),
        h('td', { class: 'toolbar', style: 'justify-content:flex-end' },
          h('button', { class: 'btn small', disabled: r.id === S.run.id, onclick: () => call('loadRun', r.id).then(() => go('distribute')) }, 'Open'),
          h('button', { class: 'btn small danger', onclick: () => call('deleteRun', r.id) }, 'Delete')))))) : h('div', { class: 'empty' }, 'No saved runs yet.')));
}

// ---------- Features log ----------
function viewFeatures() {
  const notes = ui.releaseNotes;
  return h('div', { class: 'features-view' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Features log'), h('p', {}, 'What changed in each version of the app, newest first.'))),
    notes.length
      ? notes.map((n) => h('div', { class: 'panel release-card' },
        h('div', { class: 'release-head' }, h('h3', {}, `Version ${n.version}`), n.version === appVersion ? badge('Installed', 'blue') : null),
        h('ul', {}, n.items.map((i) => h('li', {}, i)))))
      : h('div', { class: 'panel empty' }, 'No changes to show.'));
}

// ---------- How to use ----------
// Text parts: a string, { b } for bold, { href, text } for a web link, or { go, text } for a link to
// another page of the app. Keep this plain and short: people read it while they work (see CLAUDE.md).
const REPO_URL = 'https://github.com/JoMoCodes/Route-Sheets-Distributor';
const QA_URL = `${REPO_URL}/discussions/categories/q-a`;
const DISCUSSIONS_URL = `${REPO_URL}/discussions`;

const HELP = {
  firstTime: [
    ['Open ', { go: 'distribute', text: 'Distribute' }, ' in the left menu.'],
    ['On the ', { b: 'Associate Data' }, ' box, click ', { b: 'Import…' }, ' and pick your driver list. Click the ', { b: '?' }, ' on the box to see where to download it.'],
    ['Want to email sheets straight from the app? Open ', { go: 'email', text: 'Email settings' }, ' and follow the steps on the right of that page.'],
    ['Click ', { b: 'Send test email' }, ' to check it works. Look in your inbox (and spam folder).'],
    ['You only do this once. Import the driver list again when someone new starts or an email changes.'],
  ],
  everyDay: [
    ['Download today\'s ', { b: 'route sheet PDF' }, ' (from Slack) and ', { b: 'Routes file' }, ' (from Cortex). The ', { b: '?' }, ' on each box shows you where.'],
    ['Open ', { go: 'distribute', text: 'Distribute' }, '. Click ', { b: 'Import…' }, ' on ', { b: 'Route Sheet PDF' }, ' and pick the PDF.'],
    ['Click ', { b: 'Import…' }, ' on ', { b: 'Routes File' }, ' and pick the Routes file. (Or drag both files onto the window at once.)'],
    ['Look at the colored boxes at the top. Green is good. Yellow and red need you.'],
    ['Go down the page and make a choice for every yellow and red route. See ', { b: 'Making choices' }, ' below.'],
    ['Check ', { b: 'People who won\'t get a route sheet' }, '. Make sure nobody is left out by mistake.'],
    ['Click ', { b: 'Email all' }, ' at the top right to send every ready sheet. Or open ', { go: 'sheets', text: 'Route Sheets' }, ' and send them one at a time.'],
    ['That\'s it. The app saves your work by itself.'],
  ],
  colors: [
    [{ badge: 'Ready to send', tone: 'green' }, ' The app found exactly one driver. Nothing to do.'],
    [{ badge: 'Needs your decision', tone: 'amber' }, ' More than one driver is listed for this route. Pick who gets it.'],
    [{ badge: 'No exact match', tone: 'red' }, ' The app couldn\'t find the right driver. Pick someone, or don\'t send it.'],
    [{ badge: 'No route sheet', tone: 'red' }, ' The route is on the Routes file, but there\'s no page for it in the PDF.'],
    [{ badge: 'Not sending', tone: 'gray' }, ' You chose not to send it.'],
    [{ badge: '✓ Emailed', tone: 'blue' }, ' You already sent, copied or opened this one.'],
  ],
  choices: [
    [{ b: 'Send to [name]' }, ': that person gets the route sheet.'],
    [{ b: '★ Suggested' }, ': the app\'s best guess. ', { b: 'Accept all suggestions' }, ' picks every guess in one click.'],
    [{ b: 'Send anyway' }, ': the person is on your list but not marked ACTIVE. Only use it if you\'re sure.'],
    [{ b: 'Send to someone else' }, ' or ', { b: 'Assign' }, ': pick anyone from the drop-down list, then click ', { b: 'Assign' }, '.'],
    [{ b: 'Don\'t send' }, ': skip this route today.'],
    ['Changed your mind? In ', { b: 'All routes' }, ' at the bottom of Distribute, click ', { b: 'Change' }, ' next to the route.'],
  ],
  sending: [
    [{ b: 'Send email' }, ': sends it to the driver right now, with the PDF page attached. Needs Email settings.'],
    [{ b: 'Copy for email' }, ': copies the sheet. Paste it into any email with Ctrl + V.'],
    [{ b: 'Open email draft' }, ': opens a ready-to-go email in Outlook. You just click Send.'],
    [{ b: 'Copy + open mail app' }, ': copies the sheet and opens your email app. Paste it in.'],
    [{ b: 'Save PDF page' }, ': saves only this driver\'s page as a PDF.'],
    [{ b: 'View original page' }, ': shows the page from the original PDF, to double-check.'],
    [{ b: 'Mark as sent' }, ': puts a ✓ on it if you sent it some other way, like a text message.'],
  ],
  problems: [
    {
      q: 'Nothing is ready to send, or everything is red',
      a: [
        ['Check the ', { b: 'Associate Data' }, ' box on Distribute says ', { b: 'Loaded' }, '. If not, import it.'],
        ['If it says ', { b: 'Over a month old' }, ', download a fresh one from Cortex and import it.'],
        ['Make sure you picked today\'s files, not yesterday\'s.'],
      ],
    },
    {
      q: 'A driver shows "Not in associate data" or "INACTIVE"',
      a: [
        ['They\'re probably new, or their status changed. Download a fresh Associate Data from Cortex and import it.'],
        ['Still wrong? In Cortex, check they are Active and their Transporter ID is right.'],
        ['Need to send it today anyway? Use ', { b: 'Send anyway' }, ' or pick them with ', { b: 'Assign' }, '.'],
      ],
    },
    {
      q: 'A driver has "No email on file"',
      a: [
        ['Add their email in Cortex. Then download and import the Associate Data again.'],
        ['For today, use ', { b: 'Copy for email' }, ' and send it yourself, then click ', { b: 'Mark as sent' }, '.'],
      ],
    },
    {
      q: 'A route is "Missing from the PDF"',
      a: [
        ['The PDF has no page for that route. Download the PDF again, or ask for the missing page.'],
        ['Import the new PDF. Your choices so far are kept.'],
      ],
    },
    {
      q: 'A sheet "failed the number check"',
      a: [
        ['The bags and packages on that page don\'t add up, so the app won\'t send it on its own.'],
        ['Click ', { b: 'View original page' }, ' and compare. The PDF may be cut off. Download it again and re-import.'],
      ],
    },
    {
      q: 'Emails won\'t send',
      a: [
        ['Open ', { go: 'email', text: 'Email settings' }, '. A yellow box tells you what\'s missing.'],
        ['Use a Gmail ', { b: 'App Password' }, ', not your normal Gmail password.'],
        ['Click ', { b: 'Send test email' }, '. If it fails, make a new App Password and paste it in.'],
        ['Check the computer is online.'],
        ['Gmail only lets you send about 500 emails a day.'],
      ],
    },
    {
      q: 'I sent a sheet to the wrong person',
      a: [
        ['An email can\'t be unsent. Let that driver know to ignore it.'],
        ['On Distribute, in ', { b: 'All routes' }, ', click ', { b: 'Change' }, ' and pick the right person. Then send it again.'],
      ],
    },
    {
      q: 'I imported the wrong file',
      a: [
        ['Just import the right one. It replaces the wrong one.'],
        ['Or click ', { b: 'New run' }, ' at the top right to start over.'],
      ],
    },
    {
      q: 'I can\'t find yesterday\'s work',
      a: [
        ['Open ', { go: 'history', text: 'History' }, ' and click ', { b: 'Open' }, ' next to that day.'],
        ['If you clicked ', { b: 'Clear' }, ' when the app asked about earlier runs, they\'re gone.'],
      ],
    },
    {
      q: 'Everything is too small or hard to read',
      a: [['Use ', { b: 'Make the app easier to see' }, ' at the top of this page.']],
    },
  ],
  asking: [
    ['Say what you clicked, what you expected, and what happened instead.'],
    ['Add a picture of the screen. Press the Windows key + Shift + S, drag over the screen, then paste it with Ctrl + V.'],
    ['Say which version you have. It\'s at the bottom-left of the app (Version {v}).'],
    [{ b: 'Never post driver names, emails, phone numbers or route sheets.' }, ' Anyone on the internet can see these pages.'],
    ['You need a free GitHub account to post.'],
  ],
};

function helpText(parts) {
  return [].concat(parts).map((p) => {
    if (typeof p === 'string') return p.replace('{v}', appVersion || '…');
    if (p.b) return h('b', {}, p.b);
    if (p.badge) return badge(p.badge, p.tone);
    if (p.href) return h('a', { href: p.href, target: '_blank', rel: 'noopener' }, p.text);
    if (p.go) return h('button', { class: 'link', onclick: () => (p.go === 'email' ? openEmailSettings() : go(p.go)) }, p.text);
    return '';
  });
}

const helpList = (items, ordered = false) => h(ordered ? 'ol' : 'ul', { class: 'help-list' }, items.map((i) => h('li', {}, helpText(i))));

function viewHelp() {
  const d = ui.display;
  const choice = (label, current, options, key) => h('div', { class: 'display-row' },
    h('div', { class: 'field-label' }, label),
    h('div', { class: 'segmented', role: 'group', 'aria-label': label }, options.map(([id, text]) =>
      h('button', { class: `btn ${current === id ? 'primary' : ''}`, 'aria-pressed': String(current === id), onclick: () => setDisplay({ [key]: id }) }, text))));

  const sections = [
    ['see', 'Make the app easier to see', h('div', { class: 'panel help-card' },
      choice('Text size', d.textSize, d.textSizes.map((t) => [t.id, t.label]), 'textSize'),
      choice('Colors', d.theme, [['dark', 'Dark'], ['light', 'Light']], 'theme'),
      choice('Contrast', d.contrast, [['normal', 'Normal'], ['high', 'High contrast']], 'contrast'),
      helpList([
        ['Changes happen right away, and the app remembers them.'],
        [{ b: 'High contrast' }, ' makes gray text and borders darker (or brighter in Dark), so they\'re easier to read.'],
        [{ b: 'Light' }, ' colors are often easier to read in a bright room.'],
        ['Shortcut: hold ', { b: 'Ctrl' }, ' and press ', { b: '+' }, ' to make everything bigger, or ', { b: '−' }, ' to make it smaller. ', { b: 'Ctrl' }, ' and ', { b: '0' }, ' goes back to normal.'],
        ['You can also hold ', { b: 'Ctrl' }, ' and roll the mouse wheel.'],
        ['The ', { b: 'A−' }, ' and ', { b: 'A+' }, ' buttons at the bottom-left work on every page.'],
        ['Things look squished at a big size? Make the window fill the screen: double-click the bar at the very top of the window.'],
      ]))],
    ['first', 'Before your first day', h('div', { class: 'panel help-card' }, helpList(HELP.firstTime, true))],
    ['daily', 'Every day, step by step', h('div', { class: 'panel help-card' }, helpList(HELP.everyDay, true))],
    ['colors', 'What the colors mean', h('div', { class: 'panel help-card' }, helpList(HELP.colors))],
    ['choices', 'Making choices', h('div', { class: 'panel help-card' },
      h('p', { class: 'muted' }, 'These buttons are on the Distribute page, on each yellow or red route.'), helpList(HELP.choices))],
    ['sending', 'Ways to send a route sheet', h('div', { class: 'panel help-card' },
      h('p', { class: 'muted' }, 'Open Route Sheets and click a route on the left. You\'ll see exactly what the driver gets, and these buttons.'), helpList(HELP.sending))],
    ['problems', 'If something goes wrong', h('div', { class: 'help-problems' }, HELP.problems.map((p) =>
      h('details', { class: 'panel help-problem' }, h('summary', {}, p.q), helpList(p.a))))],
    ['stuck', 'Still stuck?', h('div', { class: 'panel help-card' },
      h('p', {}, 'Ask on the app\'s help forum. Someone will answer, and the answer stays there for the next person with the same problem.'),
      h('div', { class: 'toolbar' },
        h('a', { class: 'btn primary', href: QA_URL, target: '_blank', rel: 'noopener' }, 'Ask a question'),
        h('a', { class: 'btn', href: DISCUSSIONS_URL, target: '_blank', rel: 'noopener' }, 'See all discussions')),
      helpList([
        [{ b: 'Ask a question' }, ' is for "how do I…" and "this isn\'t working". Search it first, your question may already be answered.'],
        [{ b: 'See all discussions' }, ' is for ideas, tips and news about the app.'],
      ]),
      h('div', { class: 'field-label', style: 'margin-top:4px' }, 'When you ask, please:'),
      helpList(HELP.asking))],
  ];

  return h('div', { class: 'help-view' },
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'How to use'), h('p', {}, 'Everything you need to send route sheets, and what to do when something goes wrong.'))),
    h('div', { class: 'help-jump' }, h('span', { class: 'muted' }, 'Jump to:'),
      sections.map(([id, title]) => h('button', { class: 'btn small', onclick: () => $(`help-${id}`).scrollIntoView({ behavior: 'smooth', block: 'start' }) }, title))),
    sections.map(([id, title, body]) => h('div', { class: 'section', id: `help-${id}` }, h('h2', { class: 'help-title' }, title), body)));
}

// ---------- Email settings ----------
async function openEmailSettings() {
  const r = await api.emailSettings();
  if (r.ok) {
    ui.emailSettings = r.result;
    ui.emailDraft = { ...r.result, password: '', testTo: (ui.emailDraft && ui.emailDraft.testTo) || '' };
  } else {
    toast(r.error, 'error');
  }
  go('email');
}

async function saveEmail(extra = {}, { quiet = false } = {}) {
  const d = ui.emailDraft;
  const r = await call('saveEmailSettings', { ...d, ...extra });
  if (r.ok) {
    ui.emailSettings = r.result;
    ui.emailDraft = { ...r.result, password: '', testTo: d.testTo };
    render();
    if (!quiet) toast(r.result.problem ? `Saved. Still needed: ${r.result.problem}` : 'Email settings saved. You can send route sheets now.', r.result.problem ? '' : 'ok');
  }
  return r;
}

async function sendTest() {
  const saved = await saveEmail({}, { quiet: true });
  if (!saved.ok) return;
  if (saved.result.problem) return toast(saved.result.problem, 'error');
  ui.testing = true;
  render();
  const r = await call('testEmail', ui.emailDraft.testTo || '');
  ui.testing = false;
  render();
  if (r.ok) toast(`Settings saved and a test email was sent to ${r.result}. Check that inbox (and its spam folder).`, 'ok');
}

function viewEmail() {
  const s = ui.emailSettings;
  const d = ui.emailDraft;
  if (!s || !d) return h('div', { class: 'empty' }, 'Loading email settings…');
  const field = (key, label, hint, props = {}) => h('label', { class: 'field' },
    h('span', { class: 'field-label' }, label),
    h('input', { class: 'input', value: d[key] ?? '', oninput: (e) => { d[key] = e.target.value; }, ...props }),
    hint ? h('span', { class: 'field-hint' }, hint) : null);

  const status = s.problem
    ? h('div', { class: 'callout warn' }, h('div', {}, h('b', {}, 'Not set up yet. '), s.problem))
    : h('div', { class: 'callout ok' }, h('div', {}, h('b', {}, 'Email is set up. '), `Route sheets are sent from ${s.fromAddress}.`));

  return h('div', { class: 'email-view' },
    h('div', { class: 'section-head' }, h('div', {},
      h('h2', {}, 'Email settings'),
      h('p', {}, 'Send each driver their route sheet straight from the app, using a Gmail account and a Gmail App Password.'))),
    status,
    s.canStorePassword ? null : h('div', { class: 'callout warn', style: 'margin-top:12px' }, "This computer can't store passwords securely, so an App Password can't be saved here."),
    h('div', { class: 'email-grid section' },
      h('div', { class: 'panel form' },
        field('fromAddress', 'Gmail address to send from', 'Drivers see this as the sender. It must be the Google account that made the App Password.', { type: 'email', placeholder: 'dispatch@gmail.com' }),
        field('fromName', 'Sender name (optional)', 'Shown next to the address, for example "Dispatch – XYZ1".', { placeholder: 'Dispatch' }),
        field('password', 'App Password', s.hasPassword
          ? 'Saved and encrypted. Leave this blank to keep it, or type a new one to replace it.'
          : 'The 16-letter App Password from Google (not your normal password).', { type: 'password', autocomplete: 'off', placeholder: s.hasPassword ? '•••• •••• •••• ••••' : 'abcd efgh ijkl mnop' }),
        s.hasPassword ? h('div', {}, h('button', { class: 'link', onclick: () => saveEmail({ password: '', clearPassword: true }) }, 'Remove saved App Password')) : null,
        field('bcc', 'Send me a copy (optional)', 'Every route sheet email is also BCC\'d to this address, so you have a record.', { type: 'email', placeholder: 'you@example.com' }),
        h('details', {},
          h('summary', { class: 'faint', style: 'cursor:pointer' }, 'Advanced: other email providers'),
          h('div', { class: 'form', style: 'padding:12px 0 0' },
            field('smtpHost', 'Mail server (SMTP)', 'Gmail: smtp.gmail.com', { placeholder: 'smtp.gmail.com' }),
            field('smtpPort', 'Port', 'Gmail: 587. Use 465 only if your provider says so.', { type: 'number', min: 1, max: 65535 }),
            field('username', 'Login name (optional)', 'Leave blank to log in with the address above.', {}))),
        h('div', { class: 'toolbar', style: 'margin-top:4px' },
          h('button', { class: 'btn primary', onclick: () => saveEmail() }, 'Save'),
          h('span', { style: 'flex:1' }),
          h('input', { class: 'input', style: 'width:220px', type: 'email', placeholder: s.fromAddress || 'Send test to…', value: d.testTo || '', oninput: (e) => { d.testTo = e.target.value; } }),
          h('button', { class: 'btn', disabled: ui.testing, onclick: sendTest }, ui.testing ? 'Sending test…' : 'Send test email'))),
      h('div', { class: 'panel facts' },
        h('div', { class: 'question' }, 'Getting a Gmail App Password'),
        h('ol', { class: 'steps' },
          h('li', {}, 'Sign in to the Gmail account you will send from.'),
          h('li', {}, 'Turn on 2-Step Verification: Google Account → Security.'),
          h('li', {}, 'Open ', h('a', { href: 'https://myaccount.google.com/apppasswords', target: '_blank' }, 'myaccount.google.com/apppasswords'), ', type a name like "Route Sheets" and click Create.'),
          h('li', {}, 'Copy the 16-letter password Google shows, paste it here, and click Save.')),
        h('div', { class: 'faint', style: 'font-size:12.5px' }, 'Already use the Weekly Performance App? You can use the same App Password, but you have to type it in here once.'),
        h('div', { class: 'faint', style: 'font-size:12.5px' }, 'The password is encrypted and only works for your Windows account on this computer. Gmail allows about 500 emails a day.'))));
}

// ---------- display (theme, text size, contrast), drag & drop, boot ----------
function applyDisplay(d) {
  ui.display = { ...ui.display, ...d };
  document.documentElement.dataset.theme = ui.display.theme;
  document.documentElement.dataset.contrast = ui.display.contrast;
  $('themeToggle').textContent = ui.display.theme === 'dark' ? '☀  Light mode' : '☾  Dark mode';
  renderTextSizeBox();
}

/** Saves a display change; the main process applies it and sends it back via onDisplayChanged. */
async function setDisplay(patch) {
  applyDisplay(patch);
  const r = await api.setDisplay(patch);
  if (r.ok) applyDisplay(r.result);
  if (S && ui.view === 'help') render();
}

const textSizeIndex = () => Math.max(0, ui.display.textSizes.findIndex((t) => t.id === ui.display.textSize));
function stepText(step) {
  const sizes = ui.display.textSizes;
  const next = sizes[Math.min(sizes.length - 1, Math.max(0, textSizeIndex() + step))];
  if (next) setDisplay({ textSize: next.id });
}

function renderTextSizeBox() {
  const sizes = ui.display.textSizes;
  if (!sizes.length) return;
  const i = textSizeIndex();
  $('textSizeBox').replaceChildren(
    h('button', { class: 'btn small', disabled: i === 0, title: 'Make the text smaller (Ctrl -)', 'aria-label': 'Make the text smaller', onclick: () => stepText(-1) }, 'A−'),
    h('button', { class: 'link text-size-label', title: 'More ways to make the app easier to see', onclick: () => go('help') }, `Text: ${sizes[i].label}`),
    h('button', { class: 'btn small', disabled: i === sizes.length - 1, title: 'Make the text bigger (Ctrl +)', 'aria-label': 'Make the text bigger', onclick: () => stepText(1) }, 'A+'));
}

$('themeToggle').addEventListener('click', () => setDisplay({ theme: ui.display.theme === 'dark' ? 'light' : 'dark' }));
$('dataFolder').addEventListener('click', () => api.openDataFolder());

let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (!paths.length) return;
  const r = await call('importPaths', paths);
  if (r.ok) for (const x of r.result) toast(x.message, 'ok', x.warnings || []);
});

// ---------- updates ----------
let appVersion = '';
function renderUpdate(u) {
  const box = $('updateBox');
  const line = (text) => h('div', {}, text);
  const kids = [];
  box.className = `update-box ${u.state === 'ready' ? 'ready' : ''}`;
  if (u.state === 'ready') {
    kids.push(h('div', { style: 'font-weight:600' }, `Version ${u.version} is ready`),
      h('button', { class: 'btn good small', onclick: () => api.installUpdate() }, 'Restart to update'));
  } else if (u.state === 'downloading') {
    kids.push(line(`Downloading ${u.version || 'update'}${u.percent != null ? ` · ${u.percent}%` : ''}…`));
  } else if (u.state === 'checking') {
    kids.push(line('Checking for updates…'));
  } else if (u.state === 'error') {
    kids.push(line(`Update check failed: ${u.message}`), h('button', { class: 'link', style: 'text-align:left', onclick: () => api.checkForUpdates() }, 'Try again'));
  } else if (u.state === 'current') {
    kids.push(line('Up to date'), h('button', { class: 'link', style: 'text-align:left', onclick: () => api.checkForUpdates() }, 'Check for updates'));
  } else if (u.state === 'unsupported') {
    box.title = u.message || '';
  }
  box.replaceChildren(...kids, h('div', { class: 'version' }, `Version ${appVersion} · `,
    h('button', { class: 'link', onclick: () => go('features') }, 'Features log')));
}

// ---------- dialogs ----------
// One dialog shows at a time; others wait their turn (e.g. What's new, then the new-day question).
const modalQueue = [];

function showModal(dialog) {
  if (!$('modal').hidden) return modalQueue.push(dialog);
  $('modal').replaceChildren(dialog);
  $('modal').hidden = false;
  const focus = dialog.querySelector('.btn.primary');
  if (focus) focus.focus();
}

function closeModal() {
  $('modal').hidden = true;
  $('modal').replaceChildren();
  if (modalQueue.length) showModal(modalQueue.shift());
}

function showWhatsNew(notes) {
  if (!notes || !notes.length) return;
  const setUpEmail = S && S.email && S.email.problem;
  showModal(h('div', { class: 'modal panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'whatsNewTitle' },
    h('h2', { id: 'whatsNewTitle' }, `What's new in version ${notes[0].version}`),
    h('div', { class: 'modal-body' }, notes.map((n) => h('div', { class: 'release' },
      notes.length > 1 ? h('div', { class: 'eyebrow' }, `Version ${n.version}`) : null,
      h('ul', {}, n.items.map((i) => h('li', {}, i)))))),
    h('div', { class: 'toolbar', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: () => { closeModal(); go('features'); } }, 'See older changes'),
      setUpEmail ? h('button', { class: 'btn', onclick: () => { closeModal(); openEmailSettings(); } }, 'Set up email') : null,
      h('button', { class: 'btn primary', onclick: closeModal }, 'Got it'))));
}

// ---------- new day & old Associate Data ----------
/** The first time the app is used on a new day, offers to clear the runs from earlier days. */
async function checkNewDay() {
  const r = await api.newDayCheck();
  const n = r.ok ? r.result.previousRuns : 0;
  if (!n) return;
  showModal(h('div', { class: 'modal panel', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'newDayTitle' },
    h('h2', { id: 'newDayTitle' }, 'Clear earlier runs?'),
    h('div', { class: 'modal-body' },
      h('p', { style: 'margin:0' }, `It's a new day. You have ${plural(n, 'saved run')} from earlier days in History. Clear ${n === 1 ? 'it' : 'them'} to start the day fresh?`),
      h('p', { class: 'muted', style: 'margin:0' }, 'Their route sheets, decisions and sent marks are deleted from the output folder. Your Associate Data and settings are kept.')),
    h('div', { class: 'toolbar', style: 'justify-content:flex-end' },
      h('button', { class: 'btn', onclick: closeModal }, 'Keep them'),
      h('button', { class: 'btn primary', onclick: async () => {
        closeModal();
        const x = await call('clearPreviousRuns');
        if (x.ok) toast(`Cleared ${plural(x.result, 'earlier run')}. Your Associate Data is kept.`, 'ok');
      } }, `Clear ${plural(n, 'run')}`))));
}

/** Warns once per app session (and again after each re-import) when the Associate Data is a month old. */
function checkAssociatesAge() {
  if (!associatesStale()) {
    ui.staleWarned = false;
    return;
  }
  if (ui.staleWarned) return;
  ui.staleWarned = true;
  render();
  toast(`Your Associate Data was last imported ${plural(daysSince(S.associatesMeta.importedAt), 'day')} ago. Import the latest file so new drivers and email changes are included.`,
    'warn', [], { label: 'Import Associate Data', run: () => doImport('associates') });
}

let today = localDay();
setInterval(async () => {
  if (!S) return;
  if (localDay() !== today) {
    today = localDay();
    const r = await api.state();
    if (r.ok) { S = r.state; render(); }
    checkNewDay();
  }
  checkAssociatesAge();
}, 60 * 1000);

$('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
api.onUpdateStatus(renderUpdate);
api.onDisplayChanged((d) => { applyDisplay(d); if (S && ui.view === 'help') render(); });
api.onEmailProgress((p) => {
  ui.sending = p;
  if (S) renderTopActions();
});

(async function boot() {
  const info = await api.appInfo();
  if (info.ok) { appVersion = info.result.version; renderUpdate(info.result.update); }
  const display = await api.display();
  applyDisplay(display.ok ? display.result : { theme: 'dark' });
  const r = await api.state();
  S = r.state;
  render();
  const notes = await api.releaseNotes();
  if (notes.ok) ui.releaseNotes = notes.result;
  const news = await api.whatsNewOnStart();
  if (news.ok) showWhatsNew(news.result);
  checkAssociatesAge();
  checkNewDay();
})();
