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
const ui = { view: 'distribute', selected: null, sheetFilter: '', assocFilter: '', previewSeq: 0 };

const STATE_INFO = {
  ready: { label: 'Ready to send', tone: 'green' },
  'needs-decision': { label: 'Needs your decision', tone: 'amber' },
  exception: { label: 'No exact match', tone: 'red' },
  'no-sheet': { label: 'No route sheet', tone: 'red' },
  skipped: { label: 'Not sending', tone: 'gray' },
};
const SENT_LABEL = { copied: 'Copied', draft: 'Draft opened', 'mail-app': 'Mail app opened', manual: 'Marked sent' };

async function call(fn, ...args) {
  const r = await api[fn](...args);
  if (r && r.state) S = r.state;
  if (r && !r.ok) toast(r.error, 'error');
  render();
  return r || { ok: false };
}

function toast(message, tone = '', details = []) {
  const t = h('div', { class: `toast ${tone}` }, message, details.length ? h('ul', {}, details.map((d) => h('li', {}, d))) : null);
  $('toasts').append(t);
  setTimeout(() => t.remove(), tone === 'error' || details.length ? 9000 : 4500);
}

const badge = (text, tone) => h('span', { class: `badge ${tone}` }, text);
const stateBadge = (state) => badge(STATE_INFO[state].label, STATE_INFO[state].tone);
const statusBadge = (status) => (status ? badge(status, status === 'ACTIVE' ? 'green' : 'red') : badge('Not in associate data', 'red'));
const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '');
const firstName = (n) => String(n || '').split(/\s+/)[0];
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
    { distribute: viewDistribute, sheets: viewSheets, associates: viewAssociates, history: viewHistory }[ui.view](),
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
  ];
  $('nav').replaceChildren(...items.map(([id, label, count, tone]) =>
    h('button', { class: `nav-item ${ui.view === id ? 'active' : ''}`, onclick: () => go(id) },
      h('span', {}, label), count != null ? h('span', { class: `nav-count ${id === 'distribute' ? tone : ''}` }, count) : null)));
}

function renderTopActions() {
  const c = S.distribution.counts;
  $('topActions').replaceChildren(
    h('button', { class: 'btn', onclick: () => call('newRun').then(() => go('distribute')) }, 'New run'),
    h('button', {
      class: 'btn primary',
      disabled: !c.ready,
      title: 'Save an Outlook email draft and a PDF for every route that is ready, plus a summary report',
      onclick: async () => {
        const r = await call('exportAll');
        if (r.ok && r.result) toast(`Saved ${r.result.drafts} email drafts, the PDFs, and a summary to ${r.result.folder}`, 'ok');
      },
    }, `Export all (${c.ready})`),
  );
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
      h('p', { class: 'faint' }, 'You can also drag all the files onto this window at once.')));
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
  const card = (title, ok, file, detail, warnings, kind) => h('div', { class: 'panel import-card' },
    h('div', { class: 'title' }, title, ok ? badge('Loaded', 'green') : badge('Not loaded', 'gray')),
    h('div', { class: 'file' }, file || 'No file yet'),
    detail ? h('div', { class: 'detail' }, detail) : null,
    warnings && warnings.length ? h('ul', { class: 'issues' }, warnings.map((w) => h('li', { class: 'warn' }, w))) : null,
    h('div', {}, h('button', { class: ok ? 'btn small' : 'btn primary small', onclick: () => doImport(kind) }, ok ? 'Replace…' : 'Import…')));

  return h('div', {},
    h('div', { class: 'grid imports' },
      card('Associate Data', !!a, a && `${a.fileName} · ${fmtDateTime(a.importedAt)}`,
        a && `${a.count} associates · ${a.active} active · ${a.inactive} inactive${a.missingEmail ? ` · ${a.missingEmail} without email` : ''}`, a && a.warnings, 'associates'),
      card('Route Sheet PDF', !!pdf, pdf && `${pdf.fileName} · ${fmtDateTime(pdf.importedAt)}`,
        pdf && (S.run.checkFailures.length
          ? h('span', { style: 'color:var(--red)' }, `${S.run.sheetCount} sheets · ${S.run.checkFailures.length} failed the number check (${S.run.checkFailures.join(', ')})`)
          : h('span', {}, `${S.run.sheetCount} route sheets · `, h('span', { style: 'color:var(--green)' }, 'every sheet\'s numbers add up'))), pdf && pdf.warnings, 'pdf'),
      card('Routes File', !!rf, rf && `${rf.fileName} · ${fmtDateTime(rf.importedAt)}`,
        rf && `${S.distribution.routes.filter((r) => r.onRoutesFile).length} routes${multi ? ` · ${multi} with more than one Transporter ID` : ''}`, rf && rf.warnings, 'routes')),
    h('p', { class: 'faint', style: 'margin:8px 2px 0;font-size:12.5px' }, 'Tip: drag and drop the files onto this window.'));
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
      act('Copy for email', async () => { const x = await call('copyEmail', r.routeCode); if (x.ok) toast('Copied. Paste into a new email (Ctrl+V). The tables keep their formatting.', 'ok'); }, { ...needReady, primary: ready }),
      act('Open email draft', () => call('openDraft', r.routeCode), { ...needReady, title: ready ? 'Opens a ready-to-send draft in Outlook with the PDF page attached' : needReady.title }),
      act('Copy + open mail app', async () => { const x = await call('openMailApp', r.routeCode); if (x.ok) toast('Your mail app is opening with the address and subject. Paste the copied sheet into the body.', 'ok'); }, needReady),
      act('Save PDF page', async () => { const x = await call('savePdf', r.routeCode); if (x.ok && x.result) toast(`Saved ${x.result}`, 'ok'); }),
      act('View original page', () => call('viewOriginal', r.routeCode)),
      h('span', { style: 'flex:1' }),
      ready ? (sent
        ? h('span', { class: 'toolbar' }, badge(`✓ ${SENT_LABEL[sent.how] || 'Sent'} ${fmtDateTime(sent.at)}`, 'blue'), h('button', { class: 'link', onclick: () => call('markSent', r.routeCode, null) }, 'Undo'))
        : act('Mark as sent', () => call('markSent', r.routeCode, 'manual'))) : null),
    noEmail ? h('div', { class: 'callout warn' }, 'No email address is on file for this driver. Use "Copy for email" and send it another way, or add their email to the Associate Data and import it again.') : null);

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
function viewHistory() {
  return h('div', {},
    h('div', { class: 'section-head' }, h('div', {}, h('h2', {}, 'Saved runs'), h('p', {}, 'Every route sheet PDF you import is saved here with your decisions, so you can reopen or resend it later.'))),
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

// ---------- theme, drag & drop, boot ----------
function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  $('themeToggle').textContent = theme === 'dark' ? '☀  Light mode' : '☾  Dark mode';
}

$('themeToggle').addEventListener('click', async () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  await api.setTheme(next);
});
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
  box.replaceChildren(...kids, h('div', { class: 'version' }, `Version ${appVersion}`));
}
api.onUpdateStatus(renderUpdate);

(async function boot() {
  const info = await api.appInfo();
  if (info.ok) { appVersion = info.result.version; renderUpdate(info.result.update); }
  const theme = await api.getTheme();
  applyTheme(theme.result || 'dark');
  const r = await api.state();
  S = r.state;
  render();
})();
