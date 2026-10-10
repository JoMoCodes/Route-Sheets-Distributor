'use strict';
// Decides who receives each route sheet. Matching is by exact Transporter ID only.
//
// A route sheet is sent automatically only when ALL of these are true:
//   - the route has a page in the PDF and that page passed its number check,
//   - the routes file lists exactly one Transporter ID for it,
//   - that ID is in the associate data and is ACTIVE.
// Anything else waits for a decision from the user and is explained in plain words.

const { namesAgree } = require('./tableParsers');

const STATES = {
  READY: 'ready',
  NEEDS_DECISION: 'needs-decision', // more than one Transporter ID on the route
  EXCEPTION: 'exception', // no exact match possible
  SKIPPED: 'skipped', // user chose not to send
  NO_SHEET: 'no-sheet', // route is on the routes file but has no PDF page
};

function summarizeSheet(s, pad = null, padSource = null) {
  if (!s) return null;
  return {
    pageNumber: s.pageNumber,
    pageNumbers: s.pageNumbers || [s.pageNumber],
    staging: s.staging,
    waveTime: s.waveTime,
    pad, // the pad for this sheet (typed for the route, from the Load Out, or for its wave), or null
    padSource, // 'typed' | 'loadout' | 'wave' | null
    serviceType: s.serviceType,
    dsp: s.dsp,
    station: s.station,
    date: s.date,
    dateLabel: s.dateLabel,
    cycle: s.cycle,
    bagCount: s.bagCount,
    overflowCount: s.overflowCount,
    totalPackages: s.totalPackages,
    commercialPackages: s.commercialPackages,
    checkOk: s.check.ok,
    checkProblems: s.check.problems,
    notes: s.check.notes || [],
  };
}

const person = (a) => ({ transporterId: a.transporterId, name: a.name, email: a.email, status: a.status });

/**
 * @param {object} input
 * @param {object[]} input.sheets     from pdfParser
 * @param {object[]} input.routes     from parseRoutes
 * @param {object[]} input.associates from parseAssociates
 * @param {Object<string,{recipients?:string[],skipped?:boolean}>} input.decisions keyed by route code
 * @param {Object<string,string>} input.wavePads pad number for each wave time, e.g. { '09:50 AM': '3' }
 * @param {{typed?:object,route?:object,wave?:object}} [input.pads] pads by route code typed by hand, by route
 *   code from the Load Out, and by wave time; a typed pad wins, then the Load Out, then the wave.
 * @param {object[]} [input.loadOutRows] rows from the Load Out sheet, compared against each route sheet.
 */
function distribute({ sheets = [], routes = [], associates = [], decisions = {}, wavePads = {}, pads = null, loadOutRows = [] }) {
  const roster = new Map(associates.map((a) => [a.transporterId, a]));
  const sheetByCode = new Map(sheets.map((s) => [s.routeCode, s]));
  const routeByCode = new Map(routes.map((r) => [r.routeCode, r]));
  const allPads = { typed: {}, route: {}, wave: wavePads || {}, ...(pads || {}) };
  const loadOutByCode = new Map(loadOutRows.map((r) => [r.routeCode, r]));

  // Which routes each Transporter ID is listed on (used to explain and suggest duplicates).
  const routesById = new Map();
  for (const r of routes) {
    for (const d of r.drivers) {
      if (!d.transporterId) continue;
      if (!routesById.has(d.transporterId)) routesById.set(d.transporterId, []);
      routesById.get(d.transporterId).push(r.routeCode);
    }
  }

  const codes = [...new Set([...sheets.map((s) => s.routeCode), ...routes.map((r) => r.routeCode)])];
  const results = codes.map((routeCode) => {
    const sheet = sheetByCode.get(routeCode) || null;
    const route = routeByCode.get(routeCode) || null;
    const issues = [];

    const listed = (route ? route.drivers : []).map((d) => {
      const a = d.transporterId ? roster.get(d.transporterId) : null;
      const c = {
        transporterId: d.transporterId,
        routesName: d.driverName,
        found: !!a,
        rosterName: a ? a.name : null,
        status: a ? a.status : null,
        email: a ? a.email : '',
        otherRoutes: d.transporterId ? (routesById.get(d.transporterId) || []).filter((x) => x !== routeCode) : [],
        nameMismatch: !!a && !!d.driverName && !namesAgree(d.driverName, a.name),
        problem: null,
      };
      const label = d.driverName || c.rosterName || 'Unnamed driver';
      if (!d.transporterId) c.problem = `${label} has no Transporter ID on the routes file`;
      else if (!a) c.problem = `Transporter ID ${d.transporterId} (${label}) is not in the associate data`;
      else if (a.status !== 'ACTIVE') c.problem = `${a.name} (${d.transporterId}) is ${a.status} in the associate data`;
      c.valid = !c.problem;
      return c;
    });

    for (const c of listed) {
      if (c.problem) issues.push({ level: 'error', text: c.problem });
      if (c.nameMismatch) issues.push({ level: 'warn', text: `Name check: routes file says "${c.routesName}" but ${c.transporterId} belongs to "${c.rosterName}" in the associate data` });
    }
    if (sheet && !sheet.check.ok) {
      for (const p of sheet.check.problems) issues.push({ level: 'error', text: `Route sheet check failed: ${p}` });
    }
    if (sheet) for (const n of sheet.check.notes || []) issues.push({ level: 'info', text: n });
    // The Load Out sheet prints the bag count, overflow (OVS) count and staging for each route.
    // A difference from the route sheet is worth a look, but the route sheet stays the source of truth.
    const lo = sheet && loadOutByCode.get(routeCode);
    if (lo) {
      if (lo.bags !== null && sheet.bagCount !== null && lo.bags !== sheet.bagCount) issues.push({ level: 'warn', text: `Load Out says ${lo.bags} bags but the route sheet says ${sheet.bagCount}` });
      if (lo.overflow !== null && sheet.overflowCount !== null && lo.overflow !== sheet.overflowCount) issues.push({ level: 'warn', text: `Load Out says ${lo.overflow} overflow packages (OVS) but the route sheet says ${sheet.overflowCount}` });
      if (lo.staging && sheet.staging && !stagingAgree(lo.staging, sheet.staging)) issues.push({ level: 'warn', text: `Load Out says staging ${lo.staging} but the route sheet says ${sheet.staging}` });
    }
    const { pad, padSource } = resolvePad(allPads, routeCode, sheet && sheet.waveTime);

    const res = {
      routeCode,
      hasSheet: !!sheet,
      onRoutesFile: !!route,
      sheet: summarizeSheet(sheet, pad, padSource),
      listed,
      kind: !sheet ? 'no-sheet' : listed.length === 0 ? 'unassigned' : listed.length > 1 ? 'duplicate' : 'single',
      state: null,
      source: 'auto',
      recipients: [],
      suggestion: null,
      suggestionReason: null,
      headline: '',
      issues,
    };

    // Suggest a recipient for duplicate routes: the only valid ID, or the only one not listed elsewhere.
    const valid = listed.filter((c) => c.valid);
    if (res.kind === 'duplicate' && valid.length) {
      const unique = valid.filter((c) => c.otherRoutes.length === 0);
      if (valid.length === 1) {
        res.suggestion = valid[0].transporterId;
        res.suggestionReason = 'Only active associate found in the associate data for this route';
      } else if (unique.length === 1) {
        res.suggestion = unique[0].transporterId;
        res.suggestionReason = 'Only driver on this route who is not also listed on another route';
      }
    }

    if (!sheet) {
      res.state = STATES.NO_SHEET;
      res.headline = 'No page for this route in the route sheet PDF';
      issues.unshift({ level: 'error', text: `${routeCode} is on the routes file but has no page in the route sheet PDF, so there is nothing to send.` });
      return res;
    }

    const decision = decisions[routeCode];
    if (decision) {
      res.source = 'decision';
      if (decision.skipped) {
        res.state = STATES.SKIPPED;
        res.headline = 'You chose not to send this route sheet';
        return res;
      }
      const chosen = (decision.recipients || []).map((id) => roster.get(id)).filter(Boolean);
      const missing = (decision.recipients || []).filter((id) => !roster.has(id));
      for (const id of missing) issues.push({ level: 'error', text: `Previously chosen recipient ${id} is no longer in the associate data` });
      if (chosen.length) {
        res.recipients = chosen.map(person);
        res.state = STATES.READY;
        res.headline = decision.manual ? 'Assigned by you' : 'Resolved by you';
        for (const a of chosen) if (a.status !== 'ACTIVE') issues.push({ level: 'warn', text: `${a.name} is ${a.status} — you chose to send anyway` });
      }
    }

    if (!res.state) {
      res.source = 'auto';
      if (!sheet.check.ok) {
        res.state = STATES.EXCEPTION;
        res.headline = 'Route sheet numbers did not add up — review the original page before sending';
      } else if (res.kind === 'unassigned') {
        res.state = STATES.EXCEPTION;
        res.headline = route ? 'Routes file lists no driver for this route' : 'Route is in the PDF but not on the routes file';
        if (!route) issues.unshift({ level: 'error', text: `${routeCode} has a route sheet page but is not on the routes file, so no driver is assigned.` });
        else issues.unshift({ level: 'error', text: `${routeCode} is on the routes file with no Transporter ID.` });
      } else if (res.kind === 'duplicate') {
        res.state = STATES.NEEDS_DECISION;
        res.headline = `${listed.length} Transporter IDs are listed on this route`;
      } else if (!listed[0].valid) {
        res.state = STATES.EXCEPTION;
        res.headline = listed[0].problem;
      } else {
        const a = roster.get(listed[0].transporterId);
        res.recipients = [person(a)];
        res.state = STATES.READY;
        res.headline = 'Exact Transporter ID match';
      }
    }

    for (const r of res.recipients) {
      if (!r.email) issues.push({ level: 'warn', text: `No email on file for ${r.name} — copy the sheet and send it another way` });
    }
    return res;
  });

  results.sort((a, b) => stateOrder(a.state) - stateOrder(b.state) || waveKey(a).localeCompare(waveKey(b)) || a.routeCode.localeCompare(b.routeCode, undefined, { numeric: true }));

  return { routes: results, people: summarizePeople(results, roster), counts: countStates(results), waves: summarizeWaves(sheets, allPads) };
}

function padFor(wavePads, waveTime) {
  return (waveTime && wavePads && wavePads[waveTime]) || null;
}

/**
 * The pad for one route and where it came from: typed by hand for that route, else from the
 * Load Out sheet, else the pad typed for its wave time.
 * @returns {{pad:string|null, padSource:'typed'|'loadout'|'wave'|null}}
 */
function resolvePad(pads, routeCode, waveTime) {
  const p = { typed: {}, route: {}, wave: {}, ...(pads || {}) };
  if (routeCode && p.typed[routeCode]) return { pad: p.typed[routeCode], padSource: 'typed' };
  if (routeCode && p.route[routeCode]) return { pad: p.route[routeCode], padSource: 'loadout' };
  const wave = padFor(p.wave, waveTime);
  return wave ? { pad: wave, padSource: 'wave' } : { pad: null, padSource: null };
}

/** "STG.G09" on the Load Out means the same as "STG.G9.1" on the route sheet. */
function stagingAgree(loadOutStaging, sheetStaging) {
  const norm = (v) => String(v || '').toUpperCase().replace(/\s+/g, '').split('.').map((seg) => seg.replace(/^([A-Z]*)0+(\d)/, '$1$2'));
  if (!String(loadOutStaging || '').trim() || !String(sheetStaging || '').trim()) return true;
  const a = norm(loadOutStaging);
  const b = norm(sheetStaging);
  return a.every((seg, i) => b[i] === seg);
}

/**
 * Each wave time on the route sheets, earliest first, with how many routes it has, the pad typed for
 * the wave, and how many of its routes got a pad from the Load Out, by hand, or not at all.
 */
function summarizeWaves(sheets, pads) {
  const p = { typed: {}, route: {}, wave: {}, ...(pads || {}) };
  const waves = new Map();
  for (const s of sheets) {
    if (!s.waveTime) continue;
    if (!waves.has(s.waveTime)) waves.set(s.waveTime, { waveTime: s.waveTime, routes: 0, pad: padFor(p.wave, s.waveTime), fromLoadOut: 0, typed: 0, unpadded: 0 });
    const w = waves.get(s.waveTime);
    w.routes++;
    const { padSource } = resolvePad(p, s.routeCode, s.waveTime);
    if (padSource === 'loadout') w.fromLoadOut++;
    else if (padSource === 'typed') w.typed++;
    else if (!padSource) w.unpadded++;
  }
  return [...waves.values()].sort((a, b) => waveSortKey(a.waveTime).localeCompare(waveSortKey(b.waveTime)));
}

function stateOrder(s) {
  return [STATES.NEEDS_DECISION, STATES.EXCEPTION, STATES.NO_SHEET, STATES.READY, STATES.SKIPPED].indexOf(s);
}
function waveKey(r) {
  return waveSortKey(r.sheet && r.sheet.waveTime);
}
/** "09:50 AM" -> "09:50", "1:05 PM" -> "13:05", so wave times sort in clock order. */
function waveSortKey(waveTime) {
  if (!waveTime) return '99';
  const m = String(waveTime).match(/(\d+):(\d+)\s*([AP])M/i);
  if (!m) return String(waveTime);
  let h = Number(m[1]) % 12;
  if (m[3].toUpperCase() === 'P') h += 12;
  return `${String(h).padStart(2, '0')}:${m[2]}`;
}

function countStates(results) {
  const counts = { total: results.length };
  for (const s of Object.values(STATES)) counts[s] = 0;
  for (const r of results) counts[r.state]++;
  counts.missingEmail = results.filter((r) => r.state === STATES.READY && r.recipients.some((p) => !p.email)).length;
  return counts;
}

/** Everyone named on the routes file who ends up with no route sheet, and why; plus anyone getting more than one. */
function summarizePeople(results, roster) {
  const received = new Map(); // transporterId -> [routeCodes]
  for (const r of results) {
    if (r.state !== STATES.READY) continue;
    for (const p of r.recipients) {
      if (!received.has(p.transporterId)) received.set(p.transporterId, []);
      received.get(p.transporterId).push(r.routeCode);
    }
  }

  const missing = new Map();
  for (const r of results) {
    for (const c of r.listed) {
      const key = c.transporterId || `name:${c.routesName}`;
      if (c.transporterId && received.has(c.transporterId)) continue;
      if (!missing.has(key)) {
        missing.set(key, {
          transporterId: c.transporterId,
          name: c.rosterName || c.routesName || '(no name)',
          inRoster: c.found,
          status: c.status,
          routes: [],
        });
      }
      missing.get(key).routes.push({ routeCode: r.routeCode, reason: reasonNotReceiving(r, c) });
    }
  }

  const multiple = [...received.entries()]
    .filter(([, codes]) => codes.length > 1)
    .map(([id, codes]) => ({ transporterId: id, name: roster.get(id)?.name || id, routes: codes }));

  return { notReceiving: [...missing.values()].sort((a, b) => a.name.localeCompare(b.name)), multiple };
}

function reasonNotReceiving(r, c) {
  const others = r.listed.filter((x) => x !== c).map((x) => x.rosterName || x.routesName || x.transporterId);
  switch (r.state) {
    case STATES.NO_SHEET:
      return `No page for ${r.routeCode} in the route sheet PDF`;
    case STATES.SKIPPED:
      return `You chose not to send ${r.routeCode}`;
    case STATES.READY:
      return `${r.routeCode} is going to ${r.recipients.map((p) => p.name).join(' & ')} instead`;
    case STATES.NEEDS_DECISION:
      return `Waiting on your decision — ${r.routeCode} also lists ${others.join(', ')}`;
    default:
      return c.problem || r.headline;
  }
}

module.exports = { distribute, STATES, summarizeSheet, summarizeWaves, waveSortKey, resolvePad, stagingAgree };
