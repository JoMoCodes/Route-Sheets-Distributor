'use strict';
// Produces the files that leave the app: a one-page PDF per route (cut from the original PDF,
// byte-for-byte the same page) and .eml email drafts that Outlook opens ready to send.

const { PDFDocument } = require('pdf-lib');
const { renderEmailHtml, renderEmailText, subjectFor } = require('./emailRender');

async function extractPages(pdfBuffer, pageNumbers) {
  const src = await PDFDocument.load(pdfBuffer, { updateMetadata: false });
  const out = await PDFDocument.create();
  const pages = await out.copyPages(src, pageNumbers.map((n) => n - 1));
  pages.forEach((p) => out.addPage(p));
  out.setTitle(src.getTitle() || 'Route sheet');
  return Buffer.from(await out.save());
}

const wrap76 = (b64) => b64.replace(/.{1,76}/g, '$&\r\n');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${Buffer.from(s, 'utf8').toString('base64')}?=`);
const safeFileName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

/**
 * Builds an RFC 822 email draft. "X-Unsent: 1" makes Outlook open it as a new, editable message.
 * @param {{to:string[], subject:string, html:string, text:string, attachments?:{filename:string, content:Buffer, contentType:string}[]}} m
 */
function buildEml(m) {
  const mixed = `mixed_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const alt = `alt_${Math.random().toString(36).slice(2)}`;
  const lines = [
    'X-Unsent: 1',
    `To: ${m.to.filter(Boolean).join(', ')}`,
    `Subject: ${encodeHeader(m.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    '',
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    '',
    `--${alt}`,
    'Content-Type: text/plain; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(m.text, 'utf8').toString('base64')),
    `--${alt}`,
    'Content-Type: text/html; charset="utf-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(m.html, 'utf8').toString('base64')),
    `--${alt}--`,
  ];
  for (const a of m.attachments || []) {
    lines.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${a.filename}"`,
      `Content-Disposition: attachment; filename="${a.filename}"`,
      'Content-Transfer-Encoding: base64',
      '',
      wrap76(a.content.toString('base64')),
    );
  }
  lines.push(`--${mixed}--`, '');
  return lines.join('\r\n');
}

/** Everything needed to send one route sheet to its recipients. */
async function buildRouteEmail(sheet, recipients, pdfBuffer) {
  const primary = recipients[0];
  const html = renderEmailHtml(sheet, primary);
  const text = renderEmailText(sheet, primary);
  const subject = subjectFor(sheet);
  const pdfName = safeFileName(`${sheet.routeCode} ${sheet.staging || ''} route sheet.pdf`);
  const attachments = [];
  if (pdfBuffer) attachments.push({ filename: pdfName, content: await extractPages(pdfBuffer, [sheet.pageNumber]), contentType: 'application/pdf' });
  const eml = buildEml({ to: recipients.map((r) => r.email).filter(Boolean), subject, html, text, attachments });
  return { html, text, subject, eml, pdfName, pdf: attachments[0] ? attachments[0].content : null };
}

module.exports = { extractPages, buildEml, buildRouteEmail, safeFileName };
