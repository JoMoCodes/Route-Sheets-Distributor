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
