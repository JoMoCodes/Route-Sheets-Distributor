'use strict';
// Builds the route sheet as email-safe HTML (tables + inline styles only) so it looks the same
// pasted into Outlook, Gmail, or opened on a phone. Values are copied verbatim from the PDF.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const BAG_COLORS = {
  green: '#2e7d32', yellow: '#f4c20d', black: '#111111', navy: '#1f3a6e', orange: '#ef6c00', blue: '#1e6fd9',
  red: '#c62828', purple: '#6a1b9a', pink: '#d81b60', white: '#ffffff', gray: '#8a8f98', grey: '#8a8f98', brown: '#6d4c41', teal: '#00897b',
};

function bagSwatch(label) {
  const color = BAG_COLORS[String(label || '').split(' ')[0].toLowerCase()];
  if (!color) return '';
  return `<span style="display:inline-block;width:12px;height:12px;border-radius:3px;background:${color};border:1px solid #9aa3ad;vertical-align:-1px;margin-right:6px;"></span>`;
}

function firstName(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

function subjectFor(sheet) {
  const date = sheet.dateLabel ? titleCase(sheet.dateLabel) : sheet.date || '';
  return `Route Sheet: ${sheet.routeCode} · ${sheet.staging || ''} · ${date}${sheet.waveTime ? ' · ' + sheet.waveTime : ''}${sheet.pad ? ' · Pad ' + sheet.pad : ''}`;
}

function titleCase(s) {
  return String(s).toLowerCase().replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

const FONT = "font-family:Segoe UI,Helvetica,Arial,sans-serif;";
const cell = 'padding:6px 10px;border-bottom:1px solid #e3e7ec;font-size:14px;color:#1b2430;';
const head = 'padding:6px 10px;white-space:nowrap;border-bottom:2px solid #1b2430;font-size:12px;color:#5b6675;text-transform:uppercase;letter-spacing:.04em;text-align:left;';
const blank = '<span style="color:#b3261e;font-style:italic;">blank on sheet</span>';

/**
 * @param {object} sheet full parsed sheet (with bags/overflow), plus `pad` when the user chose one for its wave
 * @param {{name?:string}} [recipient]
 */
function renderEmailHtml(sheet, recipient) {
  const date = sheet.dateLabel ? titleCase(sheet.dateLabel) : sheet.date || '';
  const greet = recipient && recipient.name ? `<p style="margin:0 0 14px;font-size:15px;color:#1b2430;">Hi ${esc(firstName(recipient.name))}, here is your route sheet for ${esc(date)}.</p>` : '';

  // Gray boxes, except the date: a maroon one with white writing, so drivers check it is the right day.
  const GRAY_BOX = { bg: '#f3f5f8', border: '#dde2e8', label: '#5b6675', value: '#1b2430' };
  const DATE_BOX = { bg: '#8b1a2b', border: '#6f1422', label: '#f6d8dd', value: '#ffffff' };

  // Values stay on one line; only the date may wrap, on a narrow phone.
  const infoBox = (label, value, { big = false, wrap = false, colors = GRAY_BOX } = {}) => `
      <td style="padding:10px;background:${colors.bg};border:1px solid ${colors.border};border-radius:6px;text-align:center;vertical-align:middle;">
        <div style="font-size:11px;color:${colors.label};text-transform:uppercase;letter-spacing:.05em;">${esc(label)}</div>
        <div style="font-size:${big ? 24 : 17}px;font-weight:700;color:${colors.value};margin-top:2px;${wrap ? '' : 'white-space:nowrap;'}">${esc(value || '—')}</div>
      </td>`;

  // The pad is the one thing a driver must not miss, so it gets the biggest box: a tall blue column
  // on the right, beside the route, staging, wave and date. Longer pads get a smaller number, and
  // only those may wrap (at a space), so the three columns still fit on a phone.
  const pad = String(sheet.pad || '');
  const padText = pad.length <= 2 ? 'font-size:44px;white-space:nowrap;' : pad.length <= 4 ? 'font-size:30px;white-space:nowrap;' : 'font-size:22px;';
  const padBox = pad ? `
      <td rowspan="2" width="24%" style="padding:10px 6px;background:#1e6fd9;border:1px solid #185cc0;border-radius:6px;color:#ffffff;text-align:center;vertical-align:middle;">
        <div style="font-size:18px;font-weight:800;color:#ffffff;text-transform:uppercase;letter-spacing:.04em;white-space:nowrap;">Pad #</div>
        <div style="${padText}font-weight:800;line-height:1.1;margin-top:4px;">${esc(pad)}</div>
      </td>` : '';

  const bagRows = sheet.bags.map((b) => `
        <tr>
          <td style="${cell}color:#5b6675;width:28px;">${b.index}</td>
          <td style="${cell}white-space:nowrap;">${b.sortZone ? esc(b.sortZone) : blank}</td>
          <td style="${cell}font-weight:700;white-space:nowrap;">${b.bag ? bagSwatch(b.bag) + esc(b.bag) : blank}</td>
          <td style="${cell}text-align:right;">${b.packages}</td>
        </tr>`).join('');

  const overflowRows = sheet.overflow.map((o) => `
        <tr>
          <td style="${cell}color:#5b6675;width:28px;">${o.index}</td>
          <td style="${cell}font-weight:700;white-space:nowrap;">${o.sortZone ? esc(o.sortZone) : blank}</td>
          <td style="${cell}text-align:right;">${o.packages}</td>
        </tr>`).join('');

  const notes = (sheet.check && sheet.check.notes) || [];
  const notesHtml = notes.length
    ? `<p style="margin:14px 0 0;padding:10px 12px;background:#fff4e5;border:1px solid #f0c27b;border-radius:6px;font-size:13px;color:#6b4200;"><b>Note:</b> ${notes.map(esc).join('<br>')}. Check with dispatch before loading.</p>`
    : '';

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(subjectFor(sheet))}</title></head>
<body style="margin:0;padding:0;background:#ffffff;">
<div style="${FONT}max-width:560px;margin:0 auto;padding:16px;color:#1b2430;background:#ffffff;">
  ${greet}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="6" style="border-collapse:separate;">
    <tr>${infoBox('Route', sheet.routeCode, { big: true })}${infoBox('Staging', sheet.staging, { big: true })}${padBox}</tr>
    <tr>${infoBox('Wave', sheet.waveTime)}${infoBox('Date', date, { wrap: true, colors: DATE_BOX })}</tr>
  </table>
  <p style="margin:8px 6px 0;font-size:13px;color:#5b6675;">${esc([sheet.station, sheet.cycle, sheet.serviceType].filter(Boolean).join(' · '))}</p>

  <h2 style="margin:22px 6px 6px;font-size:18px;color:#1b2430;">${sheet.bagCount ?? sheet.bags.length} Bags</h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr><th style="${head}">#</th><th style="${head}">Sort Zone</th><th style="${head}">Bag</th><th style="${head}text-align:right;">Pkgs</th></tr>
    ${bagRows}
  </table>

  <h2 style="margin:22px 6px 6px;font-size:18px;color:#1b2430;">Overflow <span style="font-weight:400;color:#5b6675;font-size:14px;">(${sheet.overflowCount ?? ''} packages)</span></h2>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">
    <tr><th style="${head}">#</th><th style="${head}">Sort Zone</th><th style="${head}text-align:right;">Pkgs</th></tr>
    ${overflowRows}
  </table>

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:18px;">
    <tr><td style="padding:8px 10px;font-size:15px;font-weight:700;background:#1b2430;color:#ffffff;">Total Packages</td><td style="padding:8px 10px;font-size:15px;font-weight:700;background:#1b2430;color:#ffffff;text-align:right;">${sheet.totalPackages ?? ''}</td></tr>
    <tr><td style="padding:8px 10px;font-size:14px;background:#f3f5f8;">Commercial Packages</td><td style="padding:8px 10px;font-size:14px;background:#f3f5f8;text-align:right;font-weight:700;">${sheet.commercialPackages ?? ''}</td></tr>
  </table>
  ${notesHtml}
</div>
</body></html>`;
}

/** Plain-text version for the email's text part and for pasting where HTML isn't supported. */
function renderEmailText(sheet, recipient) {
  const date = sheet.dateLabel ? titleCase(sheet.dateLabel) : sheet.date || '';
  const lines = [];
  if (recipient && recipient.name) lines.push(`Hi ${firstName(recipient.name)}, here is your route sheet for ${date}.`, '');
  lines.push(`ROUTE: ${sheet.routeCode}    STAGING: ${sheet.staging}`);
  lines.push(`WAVE: ${sheet.waveTime}    DATE: ${date}`);
  if (sheet.pad) lines.push(`PAD #: ${sheet.pad}`);
  lines.push([sheet.station, sheet.cycle, sheet.serviceType].filter(Boolean).join(' · '), '');
  lines.push(`${sheet.bagCount} BAGS`);
  const w = Math.max(9, ...sheet.bags.map((b) => b.sortZone.length));
  for (const b of sheet.bags) lines.push(`${String(b.index).padStart(2)}  ${(b.sortZone || '(blank)').padEnd(w)}  ${(b.bag || '(blank)').padEnd(12)} ${String(b.packages).padStart(3)}`);
  lines.push('', `OVERFLOW (${sheet.overflowCount} packages)`);
  for (const o of sheet.overflow) lines.push(`${String(o.index).padStart(2)}  ${(o.sortZone || '(blank)').padEnd(w)}  ${String(o.packages).padStart(3)}`);
  lines.push('', `Total Packages: ${sheet.totalPackages}`, `Commercial Packages: ${sheet.commercialPackages}`);
  const notes = (sheet.check && sheet.check.notes) || [];
  if (notes.length) lines.push('', 'NOTE: ' + notes.join('; ') + '. Check with dispatch before loading.');
  return lines.join('\r\n');
}

module.exports = { renderEmailHtml, renderEmailText, subjectFor, esc, firstName };
