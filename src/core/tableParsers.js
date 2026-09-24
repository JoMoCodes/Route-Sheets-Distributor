'use strict';
// Reads the Associate Data export (CSV) and the Routes export (XLSX or CSV).

const path = require('path');
const Papa = require('papaparse');

const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const headerKey = (s) => norm(s).toLowerCase().replace(/[^a-z0-9]/g, '');
const normId = (s) => norm(s).toUpperCase();

/** Finds a column index by trying several accepted header spellings. */
function col(headers, ...names) {
  const keys = headers.map(headerKey);
  for (const n of names) {
    const i = keys.indexOf(headerKey(n));
    if (i !== -1) return i;
  }
  return -1;
}

function parseCsvRows(text) {
  const res = Papa.parse(text.replace(/^﻿/, ''), { skipEmptyLines: 'greedy' });
  return res.data.map((r) => r.map((c) => (c == null ? '' : String(c))));
}

async function readTable(filePath, buffer) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.csv' || ext === '.txt') return parseCsvRows(buffer.toString('utf8'));
  if (ext === '.xlsx') {
    const mod = require('read-excel-file/node');
    const readXlsx = mod.default || mod;
    const sheets = await readXlsx(buffer);
    // Use the first sheet that has a recognisable header row.
    const withData = sheets.find((s) => s.data && s.data.length) || sheets[0];
    return (withData ? withData.data : []).map((r) => r.map((c) => (c == null ? '' : c instanceof Date ? c.toLocaleDateString('en-US') : String(c))));
  }
  throw new Error(`Unsupported file type "${ext}". Use .csv or .xlsx.`);
}

/** Splits a person name into lowercase word tokens for comparison. */
function nameTokens(name) {
  return norm(name).toLowerCase().replace(/[^a-z\s'-]/g, ' ').split(/\s+/).filter(Boolean);
}

/**
 * Checks that the name printed next to a Transporter ID on the routes file plausibly belongs to the
 * roster entry (every word of the short name appears in the roster name). Matching is always by ID;
 * this only exists to catch a wrong ID typed against the wrong person.
 */
function namesAgree(routesName, rosterName) {
  const a = nameTokens(routesName);
  const b = new Set(nameTokens(rosterName));
  if (!a.length || !b.size) return true;
  return a.every((t) => b.has(t));
}

/** Associate Data CSV → { associates, warnings } */
function parseAssociates(rows) {
  if (!rows.length) throw new Error('The associate file is empty.');
  const headers = rows[0];
  const c = {
    name: col(headers, 'Name and ID', 'Name', 'Associate Name', 'Driver name'),
    id: col(headers, 'TransporterID', 'Transporter Id', 'Transporter ID'),
    position: col(headers, 'Position'),
    qualifications: col(headers, 'Qualifications'),
    idExpiration: col(headers, 'ID expiration', 'ID Expiration Date'),
    personalPhone: col(headers, 'Personal Phone Number', 'Personal Phone'),
    workPhone: col(headers, 'Work Phone Number', 'Work Phone'),
    email: col(headers, 'Email', 'Email Address'),
    status: col(headers, 'Status'),
  };
  if (c.id === -1) throw new Error('Could not find a "TransporterID" column in the associate file.');
  if (c.name === -1) throw new Error('Could not find a "Name and ID" (name) column in the associate file.');

  const get = (r, i) => (i === -1 ? '' : norm(r[i]));
  const associates = [];
  const warnings = [];
  const seen = new Map();
  rows.slice(1).forEach((r, idx) => {
    const transporterId = normId(r[c.id]);
    const name = get(r, c.name);
    if (!transporterId && !name) return;
    const line = idx + 2;
    if (!transporterId) {
      warnings.push(`Row ${line}: ${name} has no Transporter ID and was skipped.`);
      return;
    }
    if (seen.has(transporterId)) {
      warnings.push(`Row ${line}: Transporter ID ${transporterId} is listed twice (${seen.get(transporterId)} and ${name}). The first entry is used.`);
      return;
    }
    seen.set(transporterId, name);
    associates.push({
      transporterId,
      name,
      position: get(r, c.position),
      qualifications: get(r, c.qualifications),
      idExpiration: get(r, c.idExpiration),
      personalPhone: get(r, c.personalPhone),
      workPhone: get(r, c.workPhone),
      email: get(r, c.email),
      status: (get(r, c.status) || 'UNKNOWN').toUpperCase(),
    });
  });
  associates.sort((a, b) => a.name.localeCompare(b.name));
  return { associates, warnings };
}

/** Routes export → { routes: [{routeCode, transporterIds[], driverNames[]}], warnings } */
function parseRoutes(rows) {
  if (!rows.length) throw new Error('The routes file is empty.');
  // Some exports have a title row above the header; find the header row.
  const hIdx = rows.findIndex((r) => col(r, 'Route code', 'Route') !== -1 && col(r, 'Transporter Id', 'TransporterID') !== -1);
  if (hIdx === -1) throw new Error('Could not find "Route code" and "Transporter Id" columns in the routes file.');
  const headers = rows[hIdx];
  const c = {
    route: col(headers, 'Route code', 'Route'),
    id: col(headers, 'Transporter Id', 'TransporterID'),
    name: col(headers, 'Driver name', 'Driver', 'Name'),
    dsp: col(headers, 'DSP'),
    serviceType: col(headers, 'Delivery Service Type'),
    departure: col(headers, 'Planned Departure Time'),
  };
  const split = (v) => String(v ?? '').split('|').map(norm);

  const byCode = new Map();
  const warnings = [];
  rows.slice(hIdx + 1).forEach((r, idx) => {
    const routeCode = normId(r[c.route]);
    if (!routeCode) return;
    const line = hIdx + idx + 2;
    const ids = split(r[c.id]).map(normId);
    const names = c.name === -1 ? [] : split(r[c.name]);
    const pairs = [];
    const count = Math.max(ids.length, names.length);
    for (let i = 0; i < count; i++) {
      const transporterId = ids[i] || '';
      const driverName = names[i] || '';
      if (!transporterId && !driverName) continue;
      pairs.push({ transporterId, driverName });
    }
    if (ids.filter(Boolean).length !== names.filter(Boolean).length && c.name !== -1) {
      warnings.push(`Row ${line} (${routeCode}): ${ids.filter(Boolean).length} Transporter ID(s) but ${names.filter(Boolean).length} driver name(s) — IDs and names were paired in order.`);
    }
    const extra = {
      dsp: c.dsp === -1 ? '' : norm(r[c.dsp]),
      serviceType: c.serviceType === -1 ? '' : norm(r[c.serviceType]),
      plannedDeparture: c.departure === -1 ? '' : norm(r[c.departure]),
    };
    if (byCode.has(routeCode)) {
      warnings.push(`Row ${line}: route ${routeCode} appears more than once; the drivers were combined.`);
      const existing = byCode.get(routeCode);
      for (const p of pairs) if (!existing.drivers.some((d) => d.transporterId === p.transporterId)) existing.drivers.push(p);
    } else {
      byCode.set(routeCode, { routeCode, drivers: pairs, ...extra });
    }
  });
  return { routes: [...byCode.values()], warnings };
}

module.exports = { readTable, parseCsvRows, parseAssociates, parseRoutes, namesAgree, nameTokens, norm, normId };
