'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { PDFDocument } = require('pdf-lib');

const { parseRouteSheetPdf, parsePageItems } = require('../src/core/pdfParser');
const { parseAssociates, parseRoutes, parseCsvRows, namesAgree } = require('../src/core/tableParsers');
const { distribute } = require('../src/core/matcher');
const { buildEml, extractPages } = require('../src/core/exporter');
const { renderEmailHtml } = require('../src/core/emailRender');
const { Store } = require('../src/core/store');
const { Service, detectKind } = require('../src/core/service');
const { ASSOCIATES_CSV, ROUTES_CSV, buildRouteSheetPdf } = require('./fixtures');

let pdfBuffer;
let parsed;
test.before(async () => {
  pdfBuffer = await buildRouteSheetPdf();
  parsed = await parseRouteSheetPdf(pdfBuffer);
});

const associates = () => parseAssociates(parseCsvRows(ASSOCIATES_CSV)).associates;
const routes = () => parseRoutes(parseCsvRows(ROUTES_CSV)).routes;
const byCode = (d, code) => d.routes.find((r) => r.routeCode === code);

test('PDF: reads header, bags, overflow and totals exactly as printed', () => {
  assert.equal(parsed.sheets.length, 8);
  const s = parsed.sheets[0];
  assert.equal(s.routeCode, 'CX101');
  assert.equal(s.staging, 'STG.A1.1');
  assert.equal(s.dsp, 'ACME');
  assert.equal(s.serviceType, 'Standard Parcel Electric - Rivian MEDIUM');
  assert.equal(s.station, 'XYZ1');
  assert.equal(s.date, '2026-09-24');
  assert.equal(s.cycle, 'CYCLE_1');
  assert.equal(s.waveTime, '09:50 AM');
  assert.deepEqual(s.bags, [
    { index: 1, sortZone: 'A-1.1A', bag: 'Green 1069', packages: 18 },
    { index: 2, sortZone: '', bag: 'Orange 5270', packages: 11 },
    { index: 3, sortZone: 'A-1.3A', bag: 'Navy 0566', packages: 5 },
  ]);
  assert.deepEqual(s.overflow, [
    { index: 1, sortZone: 'A-99.JW', packages: 1 },
    { index: 2, sortZone: 'A-6.3U', packages: 2 },
  ]);
  assert.equal(s.totalPackages, 37);
  assert.equal(s.commercialPackages, 4);
});

test('PDF: a blank Sort Zone stays blank (row is not shifted) and is reported as a note', () => {
  const s = parsed.sheets[0];
  assert.equal(s.check.ok, true);
  assert.deepEqual(s.check.notes, ['Bag #2 (Orange 5270) has no Sort Zone printed on the sheet']);
});

test('PDF: numbers that do not add up fail the check', () => {
  const s = parsed.sheets.find((x) => x.routeCode === 'CX108');
  assert.equal(s.check.ok, false);
  assert.match(s.check.problems.join(' '), /Total Packages says 99/);
});

test('PDF: parser works from positioned items without widths (fallback path)', () => {
  const items = [
    { str: 'STG.X1.1', x: 36, y: 60, size: 57 }, { str: 'CX1', x: 36, y: 130, size: 36 },
    { str: 'ACME · Svc', x: 348, y: 138, size: 10.5 }, { str: 'XYZ1 · THU, SEP 24, 2026 · CYCLE_1 · 09:50 AM', x: 346, y: 155, size: 10.5 },
    { str: '1 bags', x: 36, y: 225, size: 15 }, { str: '2 overflow', x: 322, y: 225, size: 15 },
    { str: '1', x: 36, y: 274, size: 10.5 }, { str: 'Z-1', x: 67, y: 274, size: 10.5 }, { str: 'Green 1', x: 171, y: 274, size: 10.5 }, { str: '5', x: 253, y: 274, size: 10.5 },
    { str: '1', x: 322, y: 274, size: 10.5 }, { str: 'Z-9', x: 358, y: 274, size: 10.5 }, { str: '2', x: 540, y: 274, size: 10.5 },
    { str: 'Total Packages', x: 322, y: 320, size: 10.5 }, { str: '7', x: 540, y: 320, size: 10.5 },
    { str: 'Commercial Packages', x: 322, y: 337, size: 10.5 }, { str: '0', x: 540, y: 337, size: 10.5 },
  ];
  const s = parsePageItems(items, 612, 1);
  assert.equal(s.check.ok, true, s.check.problems.join('; '));
  assert.deepEqual(s.bags, [{ index: 1, sortZone: 'Z-1', bag: 'Green 1', packages: 5 }]);
});

test('Associates: parses, collapses double spaces, uppercases IDs, flags duplicates', () => {
  const csv = `${ASSOCIATES_CSV}\nDupe Person,aaaa1111,,,,,,,ACTIVE`;
  const { associates: list, warnings } = parseAssociates(parseCsvRows(csv));
  assert.equal(list.length, 5);
  assert.equal(list.find((a) => a.transporterId === 'AAAA1111').name, 'Alice Marie Driver');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /listed twice/);
});

test('Routes: splits pipe-separated Transporter IDs and names in order', () => {
  const r = routes().find((x) => x.routeCode === 'CX102');
  assert.deepEqual(r.drivers, [
    { transporterId: 'BBBB2222', driverName: 'Bob Builder' },
    { transporterId: 'EEEE5555', driverName: 'Eve Helper' },
  ]);
});

test('Name check tolerates middle names but catches a different person', () => {
  assert.equal(namesAgree('Alice Driver', 'Alice Marie Driver'), true);
  assert.equal(namesAgree('Carol Smith', 'Carol Jane  Smith'), true);
  assert.equal(namesAgree('Bob Builder', 'Alice Marie Driver'), false);
});

test('Distribute: exact single match is ready; everything else needs a person to decide', () => {
  const d = distribute({ sheets: parsed.sheets, routes: routes(), associates: associates() });
  assert.equal(byCode(d, 'CX101').state, 'ready');
  assert.deepEqual(byCode(d, 'CX101').recipients.map((p) => p.transporterId), ['AAAA1111']);

  const dup = byCode(d, 'CX102');
  assert.equal(dup.state, 'needs-decision');
  assert.equal(dup.suggestion, 'BBBB2222', 'Eve is on two routes, so Bob is suggested');

  assert.equal(byCode(d, 'CX104').state, 'exception');
  assert.match(byCode(d, 'CX104').headline, /INACTIVE/);
  assert.equal(byCode(d, 'CX105').state, 'exception');
  assert.match(byCode(d, 'CX105').headline, /not in the associate data/);
  assert.equal(byCode(d, 'CX107').state, 'exception');
  assert.match(byCode(d, 'CX107').headline, /not on the routes file/);
  assert.equal(byCode(d, 'CX108').state, 'exception');
  assert.match(byCode(d, 'CX108').headline, /did not add up/);
  assert.equal(byCode(d, 'CX999').state, 'no-sheet');
});

test('Distribute: explains who gets no route sheet and why; flags people getting several', () => {
  const d = distribute({ sheets: parsed.sheets, routes: routes(), associates: associates(), decisions: { CX102: { recipients: ['BBBB2222'] }, CX103: { skipped: true } } });
  const eve = d.people.notReceiving.find((p) => p.transporterId === 'EEEE5555');
  assert.deepEqual(eve.routes.map((r) => r.reason), ['CX102 is going to Bob Builder instead', 'You chose not to send CX103']);
  const zed = d.people.notReceiving.find((p) => p.transporterId === 'ZZZZ9999');
  assert.equal(zed.inRoster, false);
  assert.match(zed.routes[0].reason, /not in the associate data/);
  const alice = d.people.notReceiving.find((p) => p.transporterId === 'AAAA1111');
  assert.equal(alice, undefined, 'Alice receives CX101, so she is not listed even though CX999 has no sheet');
  assert.deepEqual(d.people.multiple.map((p) => [p.transporterId, p.routes]), [['AAAA1111', ['CX101', 'CX106']]]);
});

test('Distribute: manual assignment resolves an exception', () => {
  const d = distribute({ sheets: parsed.sheets, routes: routes(), associates: associates(), decisions: { CX107: { recipients: ['EEEE5555'], manual: true } } });
  assert.equal(byCode(d, 'CX107').state, 'ready');
  assert.equal(byCode(d, 'CX107').recipients[0].name, 'Eve Helper');
});

test('Email HTML escapes values and marks blank cells', () => {
  const s = { ...parsed.sheets[0], staging: '<b>x</b>' };
  const html = renderEmailHtml(s, { name: 'Alice Marie Driver' });
  assert.ok(html.includes('&lt;b&gt;x&lt;/b&gt;'));
  assert.ok(html.includes('Hi Alice,'));
  assert.ok(html.includes('blank on sheet'));
});

test('EML draft opens as unsent with recipients, HTML body and PDF attachment', async () => {
  const pdf = await extractPages(pdfBuffer, [1]);
  const doc = await PDFDocument.load(pdf);
  assert.equal(doc.getPageCount(), 1);
  const eml = buildEml({ to: ['a@example.com'], subject: 'Route Sheet: CX101 · STG', html: '<p>hi</p>', text: 'hi', attachments: [{ filename: 'x.pdf', content: pdf, contentType: 'application/pdf' }] });
  assert.match(eml, /^X-Unsent: 1\r\n/);
  assert.match(eml, /\r\nTo: a@example\.com\r\n/);
  assert.match(eml, /Subject: =\?UTF-8\?B\?/);
  assert.match(eml, /Content-Type: text\/html/);
  assert.match(eml, /filename="x.pdf"/);
});

test('Service: import in any order, persist decisions, export drafts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsd-'));
  try {
    const files = { a: path.join(dir, 'AssociateData.csv'), r: path.join(dir, 'Routes.csv'), p: path.join(dir, 'sheets.pdf') };
    fs.writeFileSync(files.a, ASSOCIATES_CSV);
    fs.writeFileSync(files.r, ROUTES_CSV);
    fs.writeFileSync(files.p, pdfBuffer);
    assert.equal(await detectKind(files.a, fs.readFileSync(files.a)), 'associates');
    assert.equal(await detectKind(files.r, fs.readFileSync(files.r)), 'routes');

    const store = new Store(path.join(dir, 'data'));
    const sv = new Service(store);
    await sv.importFile(files.r);
    await sv.importFile(files.a);
    await sv.importFile(files.p);
    assert.equal(sv.run.id, 'XYZ1_2026-09-24_CYCLE1');
    assert.equal(sv.run.routes.length, 7, 'routes imported before the PDF are carried into the run');
    assert.equal(sv.acceptSuggestions(), 2);

    const reopened = new Service(store);
    reopened.loadRun('XYZ1_2026-09-24_CYCLE1');
    assert.deepEqual(reopened.run.decisions.CX102.recipients, ['BBBB2222']);

    const out = await reopened.exportAll(path.join(dir, 'out'));
    const drafts = fs.readdirSync(path.join(out.folder, 'Email drafts'));
    assert.ok(drafts.includes('CX101 - Alice Marie Driver.eml'));
    assert.ok(fs.existsSync(path.join(out.folder, 'Distribution summary.html')));
    assert.equal(out.drafts, reopened.state().distribution.counts.ready);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------- email sending (fake SMTP transport; nothing leaves the machine) ----------
const mailer = require('../src/core/mailer');

const fakeSecrets = {
  available: () => true,
  encrypt: (s) => `enc:${Buffer.from(s).toString('base64')}`,
  decrypt: (b) => {
    if (!b.startsWith('enc:')) throw new Error('not ours');
    return Buffer.from(b.slice(4), 'base64').toString();
  },
};

/** Records what would be sent; `fail` makes chosen recipients' sends fail, `authFail` rejects the login. */
function fakeTransport({ fail = [], authFail = false } = {}) {
  const log = { options: null, sent: [], verified: 0, closed: 0 };
  const create = (options) => {
    log.options = options;
    return {
      verify: async () => {
        log.verified++;
        if (authFail) throw Object.assign(new Error('Invalid login: 535-5.7.8 Username and Password not accepted'), { code: 'EAUTH', responseCode: 535 });
        return true;
      },
      sendMail: async (m) => {
        if (m.to.some((t) => fail.includes(t.address || t))) throw Object.assign(new Error('Mailbox unavailable'), { code: 'EENVELOPE', response: '550 Mailbox unavailable' });
        log.sent.push(m);
        return { messageId: String(log.sent.length) };
      },
      close: () => { log.closed++; },
    };
  };
  return { create, log };
}

async function serviceWithRun(dir, transport) {
  const files = { a: path.join(dir, 'AssociateData.csv'), r: path.join(dir, 'Routes.csv'), p: path.join(dir, 'sheets.pdf') };
  fs.writeFileSync(files.a, ASSOCIATES_CSV);
  fs.writeFileSync(files.r, ROUTES_CSV);
  fs.writeFileSync(files.p, pdfBuffer);
  const store = new Store(path.join(dir, 'data'));
  const sv = new Service(store, { secrets: fakeSecrets, createTransport: transport && transport.create });
  for (const f of [files.a, files.r, files.p]) await sv.importFile(f);
  return { sv, store };
}

test('Mailer: Gmail defaults use STARTTLS on 587; 465 uses TLS from the start', () => {
  const s = mailer.normalizeSettings({ fromAddress: ' me@gmail.com ' });
  assert.equal(s.smtpHost, 'smtp.gmail.com');
  assert.equal(s.fromAddress, 'me@gmail.com');
  const o = mailer.transportOptions(s, 'pw');
  assert.equal(o.port, 587);
  assert.equal(o.secure, false);
  assert.equal(o.requireTLS, true);
  assert.deepEqual(o.auth, { user: 'me@gmail.com', pass: 'pw' }, 'login defaults to the From address');
  assert.equal(mailer.transportOptions({ ...s, smtpPort: 465, username: 'other' }, 'pw').secure, true);
  assert.equal(mailer.transportOptions({ ...s, username: 'other' }, 'pw').auth.user, 'other');
});

test('Mailer: explains what is missing and turns SMTP errors into plain words', () => {
  const s = mailer.normalizeSettings({});
  assert.match(mailer.validateConfig(s, 'pw'), /From/);
  assert.match(mailer.validateConfig({ ...s, fromAddress: 'nope' }, 'pw'), /not a valid email/);
  assert.match(mailer.validateConfig({ ...s, fromAddress: 'me@gmail.com' }, ''), /App Password/);
  assert.match(mailer.validateConfig({ ...s, fromAddress: 'me@gmail.com', bcc: 'x' }, 'pw'), /BCC/);
  assert.equal(mailer.validateConfig({ ...s, fromAddress: 'me@gmail.com' }, 'pw'), null);
  assert.match(mailer.describeError({ code: 'EAUTH', message: 'Invalid login' }), /App Password/);
  assert.match(mailer.describeError({ code: 'ETIMEDOUT', message: 'timeout' }), /Could not reach/);
  assert.match(mailer.describeError({ responseCode: 550, response: '550 5.4.5 Daily user sending limit exceeded' }), /daily sending limit/);
});

test('Email settings: App Password is stored encrypted, Gmail spaces removed, unreadable blobs count as not set', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsd-'));
  try {
    const store = new Store(path.join(dir, 'data'));
    const sv = new Service(store, { secrets: fakeSecrets });
    assert.match(sv.emailSettings().problem, /From/);
    const saved = sv.saveEmailSettings({ fromAddress: 'dispatch@gmail.com', fromName: 'Dispatch', password: 'abcd efgh ijkl mnop' });
    assert.equal(saved.hasPassword, true);
    assert.equal(saved.problem, null);
    assert.equal(saved.password, undefined, 'the password is never sent back to the screen');
    const raw = fs.readFileSync(path.join(dir, 'data', 'settings.json'), 'utf8');
    assert.ok(!raw.includes('abcd'), 'no plain-text password in settings.json');
    assert.equal(sv.emailPassword(), 'abcdefghijklmnop');

    sv.saveEmailSettings({ ...saved, fromName: 'Dispatch 2' });
    assert.equal(sv.emailPassword(), 'abcdefghijklmnop', 'saving with a blank password keeps the saved one');

    store.setSettings({ emailPassword: 'from-another-pc' });
    assert.equal(sv.emailSettings().hasPassword, false);
    assert.match(sv.emailProblem(), /App Password/);

    sv.saveEmailSettings({ ...saved, password: 'x' });
    assert.equal(sv.saveEmailSettings({ ...saved, clearPassword: true }).hasPassword, false);
    assert.throws(() => new Service(store, { secrets: { ...fakeSecrets, available: () => false } }).saveEmailSettings({ ...saved, password: 'x' }), /securely/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Email all: sends one email per ready route with its PDF page, marks each sent, skips what it cannot send', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsd-'));
  const t = fakeTransport({ fail: ['eve@example.com'] });
  try {
    const { sv, store } = await serviceWithRun(dir, t);
    await assert.rejects(sv.emailRoutes(['CX101']), /isn't set up/);
    assert.equal(t.log.verified, 0, 'nothing is attempted before email is set up');

    sv.saveEmailSettings({ fromAddress: 'dispatch@gmail.com', fromName: 'Dispatch', password: 'pw', bcc: 'boss@example.com' });
    sv.setDecision('CX102', { recipients: ['BBBB2222'] });
    sv.setDecision('CX103', { recipients: ['CCCC3333'] }); // Carol has no email
    sv.setDecision('CX107', { recipients: ['EEEE5555'], manual: true }); // Eve's mailbox rejects

    const ready = sv.distribution().routes.filter((r) => r.state === 'ready').map((r) => r.routeCode);
    const unsent = sv.unsentRoutes();
    assert.ok(!unsent.includes('CX103'), 'a driver with no email is left out of Email all');
    assert.equal(sv.state().email.unsent, unsent.length);

    const progress = [];
    const out = await sv.emailRoutes([...unsent, 'CX103', 'CX104'], (p) => progress.push(p));
    assert.deepEqual(out.failed.map((f) => f.routeCode), ['CX107']);
    assert.match(out.failed[0].error, /refused the address/);
    assert.deepEqual(out.skipped.map((x) => x.routeCode), ['CX103', 'CX104']);
    assert.match(out.skipped[0].reason, /No email address on file for Carol/);
    assert.deepEqual(out.sent.sort(), unsent.filter((c) => c !== 'CX107').sort());
    assert.ok(ready.includes('CX101'));
    assert.equal(t.log.verified, 1, 'one login for the whole batch');
    assert.equal(t.log.closed, 1);
    assert.deepEqual(progress.at(-1), { done: unsent.length, total: unsent.length, routeCode: unsent.at(-1) });

    const m = t.log.sent.find((x) => x.subject.includes('CX101'));
    assert.deepEqual(m.from, { name: 'Dispatch', address: 'dispatch@gmail.com' });
    assert.deepEqual(m.to, [{ name: 'Alice Marie Driver', address: 'alice@example.com' }]);
    assert.equal(m.bcc, 'boss@example.com');
    assert.ok(m.html.includes('Hi Alice,'));
    assert.equal(m.attachments.length, 1);
    assert.equal(m.attachments[0].contentType, 'application/pdf');
    assert.equal((await PDFDocument.load(m.attachments[0].content)).getPageCount(), 1);

    const saved = store.loadRun(sv.run.id);
    assert.equal(saved.sent.CX101.how, 'emailed');
    assert.deepEqual(saved.sent.CX101.to, ['alice@example.com']);
    assert.equal(saved.sent.CX107, undefined, 'a failed send is not marked sent');
    assert.deepEqual(sv.unsentRoutes(), ['CX107'], 'only the failed one is left for the next Email all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Email all: a rejected login stops the batch before anything is sent', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rsd-'));
  const t = fakeTransport({ authFail: true });
  try {
    const { sv } = await serviceWithRun(dir, t);
    sv.saveEmailSettings({ fromAddress: 'dispatch@gmail.com', password: 'wrong' });
    await assert.rejects(sv.emailRoutes(sv.unsentRoutes()), /Gmail rejected the login/);
    await assert.rejects(sv.sendTestEmail(), /Gmail rejected the login/);
    assert.equal(t.log.sent.length, 0);
    assert.deepEqual(sv.run.sent, {});
    assert.equal(sv.sending, false, 'a failed batch does not block the next one');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
