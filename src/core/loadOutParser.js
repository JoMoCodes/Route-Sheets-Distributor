'use strict';
// Reads the Load Out sheet PDF: one row per driver with their vehicle, pad, route, staging, bag
// count and overflow (OVS) count. Only the route code and pad are used to fill in pads; the bag,
// overflow and staging columns are compared against the route sheet so a mix-up is visible.
// Driver names on it are never used for matching (matching is by Transporter ID only).

const { groupLines } = require('./pdfParser');

const ROUTE_CODE_RE = /^[A-Z]{1,4}\d{1,6}$/;
// e.g. "Load Out - Saturday, October 10 2026"
const TITLE_RE = /^Load\s*Out\s*-\s*([A-Za-z]+),?\s*([A-Za-z]+)\s+(\d{1,2}),?\s*(\d{4})$/i;
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const COLUMNS = ['Driver', 'Vehicle', 'PAD', 'Notes', 'Shift Type', 'Routes', 'Staging', 'Bags', 'OVS'];
const KEYS = ['driver', 'vehicle', 'pad', 'notes', 'shiftType', 'routes', 'staging', 'bags', 'overflow'];

/** True when these text items look like a Load Out sheet page (title or column headings). */
function looksLikeLoadOut(items) {
  const strs = items.map((i) => String(i.str).replace(/\s+/g, ' ').trim());
  if (strs.some((s) => TITLE_RE.test(s) || /^Load\s*Out\b/i.test(s))) return true;
  return ['Driver', 'PAD', 'Routes'].every((c) => strs.includes(c));
}

/** "Saturday, October 10 2026" -> { date: '2026-10-10', dateLabel: 'Saturday, October 10, 2026' } */
function parseTitle(str) {
  const m = String(str).replace(/\s+/g, ' ').trim().match(TITLE_RE);
  if (!m) return null;
  const mon = MONTHS.indexOf(m[2].toLowerCase());
  if (mon === -1) return null;
  const day = Number(m[3]);
  const year = m[4];
  return { date: `${year}-${String(mon + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`, dateLabel: `${m[1]}, ${m[2]} ${day}, ${year}` };
}

/**
 * Pure parser over positioned text items from one or more pages, so it can be tested with plain objects.
 * @param {{str:string,x:number,y:number,width?:number,size?:number}[][]} pages items per page, y from the top
 * @returns {{date:string|null,dateLabel:string|null,rows:object[],skipped:object[],warnings:string[]}}
 */
function parseLoadOutPages(pages) {
  const result = { date: null, dateLabel: null, rows: [], skipped: [], warnings: [] };
  for (const [pageIndex, raw] of pages.entries()) {
    const items = raw.map((i) => ({ ...i, str: String(i.str).replace(/\s+/g, ' ').trim() })).filter((i) => i.str);
    for (const it of items) {
      const t = parseTitle(it.str);
      if (t && !result.date) Object.assign(result, t);
    }
    const lines = groupLines(items);
    const headerLine = lines.find((l) => {
      const strs = l.items.map((i) => i.str);
      return ['Driver', 'PAD', 'Routes'].every((c) => strs.includes(c));
    });
    if (!headerLine) {
      if (pageIndex === 0) result.warnings.push('The Driver / PAD / Routes headings were not found, so no rows could be read.');
      continue;
    }
    // Headings are centred over their columns; each cell goes to the heading whose centre is nearest.
    const centre = (i) => i.x + (typeof i.width === 'number' ? i.width / 2 : 0);
    const cols = COLUMNS.map((name) => {
      const it = headerLine.items.find((i) => i.str === name);
      return it ? { key: KEYS[COLUMNS.indexOf(name)], centre: centre(it) } : null;
    }).filter(Boolean);

    for (const l of lines) {
      if (l.y <= headerLine.y) continue;
      const cells = {};
      for (const it of l.items) {
        let best = null;
        let dist = Infinity;
        for (const c of cols) {
          const d = Math.abs(centre(it) - c.centre);
          if (d < dist) { dist = d; best = c.key; }
        }
        cells[best] = cells[best] ? `${cells[best]} ${it.str}` : it.str;
      }
      if (!cells.driver && !cells.routes) continue; // page footer etc.
      if (/^Page \d+ of \d+$/i.test(cells.driver || '')) continue;
      const codes = String(cells.routes || '').toUpperCase().split(/[\s,/]+/).filter((c) => ROUTE_CODE_RE.test(c));
      if (!codes.length) {
        result.skipped.push({ driver: cells.driver || '', shiftType: cells.shiftType || cells.vehicle || '' });
        continue;
      }
      const num = (v) => (v != null && /^\d+$/.test(String(v).trim()) ? Number(v) : null);
      for (const routeCode of codes) {
        result.rows.push({
          routeCode,
          driver: cells.driver || '',
          vehicle: cells.vehicle || '',
          pad: String(cells.pad || '').trim().slice(0, 10),
          notes: cells.notes || '',
          shiftType: cells.shiftType || '',
          staging: cells.staging || '',
          bags: num(cells.bags),
          overflow: num(cells.overflow),
        });
      }
    }
  }
  const noPad = result.rows.filter((r) => !r.pad).map((r) => r.routeCode);
  if (noPad.length) result.warnings.push(`No pad is printed on the Load Out for ${noPad.join(', ')}.`);
  const dupes = result.rows.map((r) => r.routeCode).filter((c, i, a) => a.indexOf(c) !== i);
  if (dupes.length) result.warnings.push(`${[...new Set(dupes)].join(', ')} appear more than once on the Load Out; the first row is used.`);
  if (!result.date) result.warnings.push('The date in the Load Out title could not be read, so it was not checked against this run.');
  return result;
}

module.exports = { looksLikeLoadOut, parseLoadOutPages, parseTitle };
