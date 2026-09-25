'use strict';
// Sends route sheet emails over SMTP with nodemailer. Defaults are wired for Gmail
// (smtp.gmail.com port 587 with STARTTLS) signed in with a Gmail App Password, but any
// SMTP server works. Independent of Electron so it can be tested with plain Node; the
// password is encrypted/decrypted by the caller (see main.js, Electron safeStorage).

const DEFAULT_EMAIL_SETTINGS = {
  smtpHost: 'smtp.gmail.com',
  smtpPort: 587,
  fromAddress: '',
  fromName: '',
  username: '',
  bcc: '',
};

const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const isEmail = (s) => EMAIL_RE.test(String(s || '').trim());

/** Fills in defaults and cleans up what the user typed. */
function normalizeSettings(s) {
  const v = { ...DEFAULT_EMAIL_SETTINGS, ...(s || {}) };
  const port = Number.parseInt(v.smtpPort, 10);
  return {
    smtpHost: String(v.smtpHost || '').trim(),
    smtpPort: Number.isFinite(port) ? port : 0,
    fromAddress: String(v.fromAddress || '').trim(),
    fromName: String(v.fromName || '').trim(),
    username: String(v.username || '').trim(),
    bcc: String(v.bcc || '').trim(),
  };
}

/** Returns null when the settings look complete enough to try sending, otherwise a plain-words reason. */
function validateConfig(s, password) {
  if (!s.smtpHost) return 'No mail server is set.';
  if (!(s.smtpPort > 0 && s.smtpPort < 65536)) return 'The mail server port is not valid.';
  if (!s.fromAddress) return 'No "From" email address is set.';
  if (!isEmail(s.fromAddress)) return `"${s.fromAddress}" is not a valid email address.`;
  if (s.bcc && !isEmail(s.bcc)) return `The BCC address "${s.bcc}" is not a valid email address.`;
  if (!password) return 'No App Password is saved.';
  return null;
}

function transportOptions(s, password) {
  return {
    host: s.smtpHost,
    port: s.smtpPort,
    // Port 465 expects TLS from the first byte; 587 (Gmail) must upgrade with STARTTLS.
    secure: s.smtpPort === 465,
    requireTLS: s.smtpPort !== 465,
    auth: { user: s.username || s.fromAddress, pass: password },
    // One connection is reused for a whole batch instead of logging in per email.
    pool: true,
    maxConnections: 1,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  };
}

/** Turns nodemailer/SMTP errors into guidance a non-technical user can act on. */
function describeError(err) {
  const code = err && err.code;
  const msg = String((err && (err.response || err.message)) || err || 'Unknown error');
  if (code === 'EAUTH' || (err && err.responseCode === 535)) {
    return 'Gmail rejected the login. Check that (1) the From address is the Google account that made the App Password, '
      + '(2) 2-Step Verification is on for that account, and (3) you used the 16-letter App Password, not your normal Google password.';
  }
  if (/certificate|ssl|tls/i.test(msg) || code === 'ETLS') {
    return 'A secure connection to the mail server failed. Check the server and port (Gmail uses smtp.gmail.com, port 587).';
  }
  if (['ECONNECTION', 'ESOCKET', 'ETIMEDOUT', 'EDNS', 'ECONNREFUSED', 'ENOTFOUND'].includes(code)) {
    return 'Could not reach the mail server. Check the internet connection, and the server and port (Gmail uses smtp.gmail.com, port 587).';
  }
  if (/daily user sending limit|sending limit exceeded/i.test(msg)) {
    return 'Gmail says this account hit its daily sending limit. Try again tomorrow, or send the rest with "Export all".';
  }
  if (code === 'EENVELOPE') return `The mail server refused the address: ${msg}`;
  return msg;
}

function fromHeader(s) {
  return s.fromName ? { name: s.fromName, address: s.fromAddress } : s.fromAddress;
}

/** A nodemailer message for one route sheet email (see exporter.buildRouteEmail). */
function buildMessage(s, email) {
  return {
    from: fromHeader(s),
    to: email.to,
    bcc: s.bcc || undefined,
    subject: email.subject,
    text: email.text,
    html: email.html,
    attachments: (email.attachments || []).map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
  };
}

function buildTestMessage(s, to) {
  return {
    from: fromHeader(s),
    to,
    subject: 'Test email from Route Sheet Distributor',
    text: 'This is a test message confirming your email settings work.\n\nIf you received this, Route Sheet Distributor can send route sheets from this account.',
  };
}

/**
 * Opens one signed-in SMTP connection for sending many emails in a row. Throws (with a
 * plain-words message) if the server can't be reached or the login is rejected, so a batch
 * stops before it starts. Call send() per email, then close().
 */
async function openSession(s, password, createTransport) {
  const transport = (createTransport || require('nodemailer').createTransport)(transportOptions(s, password));
  try {
    await transport.verify();
  } catch (err) {
    transport.close();
    throw new Error(describeError(err));
  }
  return {
    async send(message) {
      try {
        await transport.sendMail(message);
        return { ok: true };
      } catch (err) {
        return { ok: false, error: describeError(err) };
      }
    },
    close() {
      try { transport.close(); } catch { /* closing should never break a batch */ }
    },
  };
}

module.exports = { DEFAULT_EMAIL_SETTINGS, normalizeSettings, validateConfig, transportOptions, describeError, buildMessage, buildTestMessage, openSession, isEmail };
