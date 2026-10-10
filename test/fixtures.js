'use strict';
// Synthetic test data shaped like the real exports (no real associate data is stored in the repo).

const { PDFDocument, StandardFonts } = require('pdf-lib');

const ASSOCIATES_CSV = [
  'Name and ID,TransporterID,Position,Qualifications,ID expiration,Personal Phone Number,Work Phone Number,Email,Status',
  'Alice  Marie Driver,AAAA1111,"Helper, Driver","CDV, EDV",5/19/2032,,,alice@example.com,ACTIVE',
  'Bob Builder,BBBB2222,"Helper, Driver","CDV",1/30/2032,,,bob@example.com,ACTIVE',
  'Carol Jane  Smith,CCCC3333,"Helper, Driver","CDV",1/30/2032,,,,ACTIVE',
  'Dan Old,DDDD4444,"Helper, Driver","CDV",1/30/2020,,,dan@example.com,INACTIVE',
  'Eve Helper,EEEE5555,"Helper, Driver","CDV",1/30/2032,,,eve@example.com,ACTIVE',
].join('\n');

const ROUTES_CSV = [
  'Route code,DSP,Transporter Id,Driver name,Route progress',
  'CX101,,AAAA1111,Alice Driver,',
  'CX102,,BBBB2222|EEEE5555,Bob Builder|Eve Helper,',
  'CX103,,CCCC3333|EEEE5555,Carol Smith|Eve Helper,',
  'CX104,,DDDD4444,Dan Old,',
  'CX105,,ZZZZ9999,Zed Unknown,',
  'CX106,,AAAA1111,Alice Driver,',
  'CX999,,AAAA1111,Alice Driver,',
].join('\n');

/** A route sheet page laid out like the real ones (US Letter, two columns). */
const SHEETS = [
  {
    routeCode: 'CX101', staging: 'STG.A1.1', service: 'Standard Parcel Electric - Rivian MEDIUM', wave: '09:50 AM',
    bags: [['1', 'A-1.1A', 'Green 1069', '18'], ['2', '', 'Orange 5270', '11'], ['3', 'A-1.3A', 'Navy 0566', '5']],
    overflow: [['1', 'A-99.JW', '1'], ['2', 'A-6.3U', '2']],
    total: 37, commercial: 4,
  },
  { routeCode: 'CX102', staging: 'STG.A2.1', service: 'Standard Parcel', wave: '09:55 AM', bags: [['1', 'B-1.1A', 'Yellow 1', '10']], overflow: [['1', 'B-9.9X', '3']], total: 13, commercial: 0 },
  { routeCode: 'CX103', staging: 'STG.A3.1', service: 'Standard Parcel', wave: '09:55 AM', bags: [['1', 'C-1.1A', 'Black 7', '10']], overflow: [['1', 'C-9.9X', '3']], total: 13, commercial: 0 },
  { routeCode: 'CX104', staging: 'STG.A4.1', service: 'Standard Parcel', wave: '09:55 AM', bags: [['1', 'D-1.1A', 'Black 8', '10']], overflow: [], total: 10, commercial: 0 },
  { routeCode: 'CX105', staging: 'STG.A5.1', service: 'Standard Parcel', wave: '09:55 AM', bags: [['1', 'E-1.1A', 'Black 9', '10']], overflow: [], total: 10, commercial: 0 },
  { routeCode: 'CX106', staging: 'STG.A6.1', service: 'Standard Parcel', wave: '09:55 AM', bags: [['1', 'F-1.1A', 'Black 1', '10']], overflow: [], total: 10, commercial: 0 },
  // In the PDF but not on the routes file:
  { routeCode: 'CX107', staging: 'STG.A7.1', service: 'Standard Parcel', wave: '09:55 AM', bags: [['1', 'G-1.1A', 'Black 2', '10']], overflow: [], total: 10, commercial: 0 },
  // Numbers deliberately don't add up (total says 99):
  { routeCode: 'CX108', staging: 'STG.A8.1', service: 'Standard Parcel', wave: '09:55 AM', bags: [['1', 'H-1.1A', 'Black 3', '10']], overflow: [], total: 99, commercial: 0 },
];

async function buildRouteSheetPdf(sheets = SHEETS) {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const s of sheets) {
    if (s.blank) { doc.addPage([612, 792]); continue; } // a blank trailing page, as some exports have
    let page = doc.addPage([612, 792]);
    let shift = 0; // a "continued" sheet draws its tables on a second page, starting near the top
    const top = (y) => 792 - (y - shift); // author in top-down coordinates like the real sheet
    const text = (str, x, y, size = 10.5, f = font) => str && page.drawText(str, { x, y: top(y), size, font: f });
    const right = (str, rx, y, size = 10.5, f = font) => str && page.drawText(str, { x: rx - f.widthOfTextAtSize(str, size), y: top(y), size, font: f });

    text(s.staging, 36, 100, 57);
    text(s.routeCode, 36, 160, 36);
    right(`ACME · ${s.service}`, 576, 140);
    right(`XYZ1 · THU, SEP 24, 2026 · CYCLE_1 · ${s.wave}`, 576, 157);
    if (s.continued) { page = doc.addPage([612, 792]); shift = 220; }
    const ovTotal = s.overflow.reduce((a, r) => a + Number(r[2]), 0);
    text(`${s.bags.length} bags`, 36, 235, 15, bold);
    text(`${ovTotal} overflow`, 322, 235, 15, bold);
    text('Sort Zone', 67, 262); right('Bag', 230, 262); right('Pkgs', 266, 262);
    text('Sort Zone', 358, 262); right('Pkgs', 552, 262);
    s.bags.forEach((b, i) => {
      const y = 280 + i * 16.5;
      text(b[0], 36, y); text(b[1], 67, y); right(b[2], 230, y, 10.5, bold); right(b[3], 266, y);
    });
    s.overflow.forEach((o, i) => {
      const y = 280 + i * 16.5;
      text(o[0], 322, y); text(o[1], 358, y, 10.5, bold); right(o[2], 552, y);
    });
    const ty = 290 + Math.max(s.bags.length, s.overflow.length) * 16.5 + 20;
    text('Total Packages', 322, ty, 10.5, bold); right(String(s.total), 552, ty, 10.5, bold);
    text('Commercial Packages', 322, ty + 17, 10.5, bold); right(String(s.commercial), 552, ty + 17, 10.5, bold);
  }
  return Buffer.from(await doc.save());
}

/** Rows for a Load Out sheet matching SHEETS: driver, vehicle, pad, shift type, route, staging, bags, OVS. */
const LOAD_OUT_ROWS = [
  ['Alice Driver', '637281 (LMR)', '1', 'Electric Route', 'CX101', 'STG.A1', '3', '3'],
  ['Bob Builder', '618915', '2', 'Electric Route', 'CX102', 'STG.A2', '1', '3'],
  ['Andrew Backup', '', '', 'Backup Driver', '', '', '', ''],
  ['Carol Smith', '615807', '2', 'Electric Route', 'CX103', 'STG.A03', '1', '3'],
  ['Dan Old', '619438', '', 'Electric Route', 'CX104', 'STG.A4', '1', '0'],
  // Bags deliberately disagree with the route sheet (which has 1 bag):
  ['Zed Unknown', '615845', '1', 'Electric Route', 'CX105', 'STG.A5', '9', '0'],
];

/** A Load Out sheet PDF laid out like the real one: a title, centred column headings, one row per driver. */
async function buildLoadOutPdf(rows = LOAD_OUT_ROWS, title = 'Load Out - Thursday, September 24 2026') {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  const text = (str, x, y, size = 7.5) => str && page.drawText(str, { x, y: 792 - y, size, font });
  text(title, 39, 45, 9.4);
  text('Page 1 of 1', 537, 44, 7.1);
  const heads = [['Driver', 91], ['Vehicle', 165], ['PAD', 216], ['Notes', 278], ['Shift Type', 355], ['Routes', 415], ['Staging', 457], ['Bags', 500], ['OVS', 532]];
  for (const [name, x] of heads) text(name, x, 169);
  const xs = [60, 165, 221, 350, 416, 450, 505, 536];
  rows.forEach((r, i) => {
    const y = 185 + i * 15;
    r.forEach((cell, c) => text(cell, xs[c], y));
  });
  return Buffer.from(await doc.save());
}

module.exports = { ASSOCIATES_CSV, ROUTES_CSV, SHEETS, LOAD_OUT_ROWS, buildRouteSheetPdf, buildLoadOutPdf };
