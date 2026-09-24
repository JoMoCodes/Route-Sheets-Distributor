'use strict';
// Reads a route sheet PDF (one route per page) into structured data.
// Every value is kept exactly as printed on the sheet; nothing is rounded or renamed.

const path = require('path');
const { pathToFileURL } = require('url');

let pdfjsPromise = null;
function loadPdfjs() {
  if (!pdfjsPromise) {
    // pdfjs-dist ships ES modules only; resolve through the unpacked path when running from an asar archive.
    const modPath = require.resolve('pdfjs-dist/legacy/build/pdf.mjs').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
    pdfjsPromise = import(pathToFileURL(modPath).href).then((pdfjs) => {
      const workerPath = modPath.replace(/pdf\.mjs$/, 'pdf.worker.mjs');
      pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href;
      return pdfjs;
    });
  }
  return pdfjsPromise;
}

function standardFontsUrl() {
  const dir = path.join(path.dirname(require.resolve('pdfjs-dist/package.json')), 'standard_fonts') + path.sep;
  return pathToFileURL(dir.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep)).href;
}

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const ROUTE_CODE_RE = /^[A-Z]{1,4}\d{1,6}$/;
// e.g. "XYZ1 · THU, SEP 24, 2026 · CYCLE_1 · 09:50 AM"
const DATE_LINE_RE = /^(\S+)\s*·\s*([A-Za-z]{3}),\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{4})\s*·\s*(\S+)\s*·\s*(\d{1,2}:\d{2}\s*[AP]M)$/i;
const BAGS_RE = /^(\d+)\s+bags?$/i;
// The "fl" ligature in "overflow" is often lost during extraction ("over\u0001ow", "overow").
const OVERFLOW_RE = /^(\d+)\s+over/i;
const INT_RE = /^\d+$/;

/** Groups positioned text items into visual lines (top-to-bottom, left-to-right). */
function groupLines(items, tolerance = 3) {
  const sorted = [...items].sort((a, b) => a.y - b.y || a.x - b.x);
  const lines = [];
  for (const it of sorted) {
    const line = lines.find((l) => Math.abs(l.y - it.y) <= tolerance);
    if (line) line.items.push(it);
    else lines.push({ y: it.y, items: [it] });
  }
  for (const l of lines) l.items.sort((a, b) => a.x - b.x);
  return lines.sort((a, b) => a.y - b.y);
}

/**
 * Pure page parser, independent of pdf.js so it can be tested with plain objects.
 * @param {{str:string,x:number,y:number,size:number}[]} items  y measured from the top of the page
 * @param {number} pageWidth
 * @param {number} pageNumber 1-based
 */
function parsePageItems(items, pageWidth, pageNumber) {
  const clean = items
    .map((i) => ({ ...i, str: String(i.str).replace(/\s+/g, ' ').trim() }))
    .filter((i) => i.str.length > 0);

  const sheet = {
    pageNumber,
    routeCode: null,
    staging: null,
    dsp: null,
    serviceType: null,
    station: null,
    weekday: null,
    date: null, // ISO yyyy-mm-dd
    dateLabel: null, // exactly as printed, e.g. "THU, SEP 24, 2026"
    cycle: null,
    waveTime: null,
    bagCount: null,
    overflowCount: null,
    bags: [],
    overflow: [],
    totalPackages: null,
    commercialPackages: null,
    check: { ok: false, problems: [] },
  };

  // Header: the two largest text items are the staging location and route code.
  const big = clean.filter((i) => i.size >= 20).sort((a, b) => a.y - b.y);
  const codeItem = big.find((i) => ROUTE_CODE_RE.test(i.str));
  if (codeItem) sheet.routeCode = codeItem.str.toUpperCase();
  const stagingItem = big.find((i) => i !== codeItem && (!codeItem || i.y < codeItem.y)) || big.find((i) => i !== codeItem);
  if (stagingItem) sheet.staging = stagingItem.str;

  const lines = groupLines(clean);
  const lineText = (l) => l.items.map((i) => i.str).join(' ');

  for (const l of lines) {
    for (const it of l.items) {
      const m = it.str.match(DATE_LINE_RE);
      if (m && !sheet.date) {
        sheet.station = m[1];
        sheet.weekday = m[2].toUpperCase();
        const mon = MONTHS[m[3].toUpperCase()];
        if (mon) sheet.date = `${m[5]}-${String(mon).padStart(2, '0')}-${String(m[4]).padStart(2, '0')}`;
        sheet.dateLabel = `${m[2]}, ${m[3]} ${m[4]}, ${m[5]}`;
        sheet.cycle = m[6];
        sheet.waveTime = m[7].replace(/\s+/g, ' ').toUpperCase();
      }
    }
  }
  // Service line is the "·"-separated line printed just above the date line.
  const serviceItem = clean.find((i) => i.str.includes('·') && !DATE_LINE_RE.test(i.str) && i.size < 20);
  if (serviceItem) {
    const parts = serviceItem.str.split('·').map((s) => s.trim());
    if (parts.length > 1) {
      sheet.dsp = parts[0];
      sheet.serviceType = parts.slice(1).join(' · ');
    } else {
      sheet.serviceType = serviceItem.str;
    }
  }

  const bagsHeader = clean.find((i) => BAGS_RE.test(i.str));
  const overflowHeader = clean.find((i) => OVERFLOW_RE.test(i.str));
  if (bagsHeader) sheet.bagCount = Number(bagsHeader.str.match(BAGS_RE)[1]);
  if (overflowHeader) sheet.overflowCount = Number(overflowHeader.str.match(OVERFLOW_RE)[1]);

  const splitX = overflowHeader ? overflowHeader.x - 10 : pageWidth / 2;
  const tableTop = Math.min(bagsHeader ? bagsHeader.y : Infinity, overflowHeader ? overflowHeader.y : Infinity);

  const leftLines = groupLines(clean.filter((i) => i.x < splitX && i.y > (bagsHeader ? bagsHeader.y : tableTop)));
  const rightLines = groupLines(clean.filter((i) => i.x >= splitX && i.y > (overflowHeader ? overflowHeader.y : tableTop)));

  // Columns are located from the table headings so a blank cell (e.g. a missing Sort Zone)
  // stays blank instead of shifting the rest of the row left.
  const leftCols = findColumns(leftLines, ['Sort Zone', 'Bag', 'Pkgs']);
  for (const l of leftLines) {
    const row = readRow(l.items, leftCols, ['sortZone', 'bag', 'packages']);
    if (!row) continue;
    sheet.bags.push({ index: row.index, sortZone: row.sortZone, bag: row.bag, packages: row.packages });
  }

  const rightCols = findColumns(rightLines, ['Sort Zone', 'Pkgs']);
  for (const l of rightLines) {
    const text = lineText(l);
    const total = text.match(/^Total Packages\s+(\d+)$/i);
    const commercial = text.match(/^Commercial Packages\s+(\d+)$/i);
    if (total) { sheet.totalPackages = Number(total[1]); continue; }
    if (commercial) { sheet.commercialPackages = Number(commercial[1]); continue; }
    const row = readRow(l.items, rightCols, ['sortZone', 'packages']);
    if (!row) continue;
    sheet.overflow.push({ index: row.index, sortZone: row.sortZone, packages: row.packages });
  }
  // Totals can sit outside the right column on other layouts; fall back to a whole-page search.
  if (sheet.totalPackages === null || sheet.commercialPackages === null) {
    for (const l of lines) {
      const text = lineText(l);
      const total = text.match(/Total Packages\s+(\d+)/i);
      const commercial = text.match(/Commercial Packages\s+(\d+)/i);
      if (total && sheet.totalPackages === null) sheet.totalPackages = Number(total[1]);
      if (commercial && sheet.commercialPackages === null) sheet.commercialPackages = Number(commercial[1]);
    }
  }

  sheet.check = verifySheet(sheet);
  return sheet;
}

/**
 * Finds the column heading line and returns each column's left edge / right edge.
 * Headings like "Bag" and "Pkgs" are right-aligned, "Sort Zone" is left-aligned.
 */
function findColumns(lines, names) {
  for (const l of lines) {
    const text = l.items.map((i) => i.str).join(' ');
    if (!names.every((n) => text.includes(n))) continue;
    const cols = {};
    for (const n of names) {
      // Headings may be one item ("Sort Zone") or split into words.
      const first = n.split(' ')[0];
      const last = n.split(' ').slice(-1)[0];
      const a = l.items.find((i) => i.str === n || i.str.startsWith(first));
      const b = [...l.items].reverse().find((i) => i.str === n || i.str.endsWith(last));
      if (!a || !b) return null;
      cols[n] = { left: a.x, right: b.x + (b.width || 0) };
    }
    return { y: l.y, cols };
  }
  return null;
}

/** Reads one table row: "#" then the named columns. Returns null if the line is not a data row. */
function readRow(items, header, keys) {
  if (!items.length || !INT_RE.test(items[0].str)) return null;
  if (header && items[0].y <= header.y) return null;
  const index = Number(items[0].str);
  const rest = items.slice(1);
  const row = { index };
  const names = header ? Object.keys(header.cols) : null;

  if (header && rest.every((i) => typeof i.width === 'number')) {
    for (const k of keys) row[k] = [];
    for (const it of rest) {
      // Pick the column whose alignment edge is closest to this item.
      let best = null;
      let bestDist = Infinity;
      names.forEach((n, ci) => {
        const c = header.cols[n];
        const leftAligned = n === 'Sort Zone';
        const d = leftAligned ? Math.abs(it.x - c.left) : Math.abs(it.x + it.width - c.right);
        if (d < bestDist) { bestDist = d; best = ci; }
      });
      row[keys[best]].push(it.str);
    }
    for (const k of keys) row[k] = row[k].join(' ');
  } else {
    // No positional info: fall back to reading left-to-right.
    if (rest.length < keys.length) return null;
    const last = rest[rest.length - 1];
    row[keys[keys.length - 1]] = last.str;
    if (keys.length === 3) {
      row[keys[0]] = rest[0].str;
      row[keys[1]] = rest.slice(1, -1).map((i) => i.str).join(' ');
    } else {
      row[keys[0]] = rest.slice(0, -1).map((i) => i.str).join(' ');
    }
  }
  if (!INT_RE.test(row.packages)) return null;
  row.packages = Number(row.packages);
  return row;
}

/** Cross-checks the numbers printed on the sheet against each other so nothing is silently dropped. */
function verifySheet(s) {
  const problems = [];
  if (!s.routeCode) problems.push('Route code not found on page');
  if (!s.staging) problems.push('Staging location not found on page');
  if (!s.date) problems.push('Station/date/cycle line not found on page');
  if (s.bagCount === null) problems.push('"bags" heading not found');
  else if (s.bags.length !== s.bagCount) problems.push(`Heading says ${s.bagCount} bags but ${s.bags.length} bag rows were read`);
  const seqOk = (rows) => rows.every((r, i) => r.index === i + 1);
  if (!seqOk(s.bags)) problems.push('Bag rows are not numbered 1..N in order');
  if (!seqOk(s.overflow)) problems.push('Overflow rows are not numbered 1..N in order');
  const bagPkgs = s.bags.reduce((a, r) => a + r.packages, 0);
  const ovPkgs = s.overflow.reduce((a, r) => a + r.packages, 0);
  if (s.overflowCount === null) problems.push('"overflow" heading not found');
  else if (ovPkgs !== s.overflowCount) problems.push(`Heading says ${s.overflowCount} overflow packages but rows add up to ${ovPkgs}`);
  if (s.totalPackages === null) problems.push('Total Packages not found');
  else if (bagPkgs + ovPkgs !== s.totalPackages) problems.push(`Bags (${bagPkgs}) + overflow (${ovPkgs}) = ${bagPkgs + ovPkgs}, but Total Packages says ${s.totalPackages}`);
  if (s.commercialPackages === null) problems.push('Commercial Packages not found');
  // Blank cells are printed that way on the original sheet; they are not read errors, but the
  // driver needs to know, so they are reported separately.
  const notes = [];
  for (const b of s.bags) {
    if (!b.sortZone) notes.push(`Bag #${b.index} (${b.bag || 'no bag label'}) has no Sort Zone printed on the sheet`);
    if (!b.bag) notes.push(`Bag #${b.index} (${b.sortZone || 'no sort zone'}) has no Bag label printed on the sheet`);
  }
  for (const o of s.overflow) if (!o.sortZone) notes.push(`Overflow #${o.index} has no Sort Zone printed on the sheet`);
  return { ok: problems.length === 0, problems, notes, bagPackages: bagPkgs, overflowPackages: ovPkgs };
}

/** Parses a route sheet PDF buffer. Returns { sheets, pageErrors, pageCount }. */
async function parseRouteSheetPdf(buffer) {
  const pdfjs = await loadPdfjs();
  const data = new Uint8Array(buffer.buffer ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) : buffer);
  const task = pdfjs.getDocument({
    data,
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
    standardFontDataUrl: standardFontsUrl(),
  });
  const doc = await task.promise;
  const sheets = [];
  const pageErrors = [];
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      const items = content.items
        .filter((i) => typeof i.str === 'string')
        .map((i) => ({
          str: i.str,
          x: i.transform[4],
          y: viewport.height - i.transform[5],
          width: i.width,
          size: Math.abs(i.transform[3]) || i.height,
        }));
      const sheet = parsePageItems(items, viewport.width, p);
      if (!sheet.routeCode) {
        pageErrors.push({ pageNumber: p, message: `Page ${p} does not look like a route sheet (no route code found).` });
        continue;
      }
      sheets.push(sheet);
    }
  } finally {
    await task.destroy();
  }
  return { sheets, pageErrors, pageCount: sheets.length + pageErrors.length };
}

module.exports = { parseRouteSheetPdf, parsePageItems, verifySheet, groupLines, findColumns, readRow };
