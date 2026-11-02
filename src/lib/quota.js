'use strict';
// The account's usage limit (codex on a ChatGPT login): "You've hit your
// usage limit. ... try again at 7:09 AM." or, when it resets days later,
// "... try again at Oct 24th, 2026 1:51 AM." Retrying before then fails the
// same way, so a job stops and an eval waits or stops (eval.js).

const LIMIT = /hit your usage limit/i;
const AT = /try again at (?:([A-Z][a-z]{2})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}) )?(\d{1,2}):(\d{2}) ?([AP]M)/i;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function isUsageLimit(text) {
  return LIMIT.test(String(text || ''));
}

// When the limit resets, in local time (the CLI prints the user's clock), or
// null when the text names no time. A bare time already past is tomorrow's.
function usageLimitReset(text, now = new Date()) {
  const t = String(text || '');
  if (!isUsageLimit(t)) return null;
  const m = t.match(AT);
  if (!m) return null;
  const [, mon, day, year, h, min, ampm] = m;
  const hour = (Number(h) % 12) + (ampm.toUpperCase() === 'PM' ? 12 : 0);
  if (mon) {
    const month = MONTHS.indexOf(mon.toLowerCase());
    return month < 0 ? null : new Date(Number(year), month, Number(day), hour, Number(min), 0);
  }
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, Number(min), 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at;
}

// The last usage-limit message in a log, with its reset time.
function lastUsageLimit(text, now = new Date()) {
  const lines = String(text || '').split('\n').filter((l) => isUsageLimit(l));
  if (!lines.length) return null;
  const line = lines[lines.length - 1];
  return { message: line.trim().slice(0, 300), reset: usageLimitReset(line, now) };
}

module.exports = { isUsageLimit, usageLimitReset, lastUsageLimit };
