'use strict';
// A tiny DOM shim for the plain browser app. No jsdom dependency: h() only
// creates elements and text nodes, so this is enough to prove the table does
// not turn model text into markup and that unverified work is warned about.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Node {
  constructor() {
    this.children = [];
  }
}

class Text extends Node {
  constructor(text) {
    super();
    this.text = String(text);
  }
  get textContent() {
    return this.text;
  }
}

class Element extends Node {
  constructor(tag) {
    super();
    this.tagName = tag;
    this.className = '';
    this.attributes = {};
    this.dataset = {};
  }
  append(...nodes) {
    for (const node of nodes.flat()) if (node != null) this.children.push(node instanceof Node ? node : new Text(node));
  }
  replaceChildren(...nodes) {
    this.children = [];
    this.append(...nodes);
  }
  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }
  addEventListener() {}
  get textContent() {
    return this.children.map((child) => child.textContent).join('');
  }
  set textContent(value) {
    this.children = [new Text(value)];
  }
}

function makeContext() {
  const byId = new Map();
  const body = new Element('body');
  const document = {
    body,
    createElement: (tag) => new Element(tag),
    createTextNode: (text) => new Text(text),
    getElementById: (id) => {
      if (!byId.has(id)) byId.set(id, new Element('div'));
      return byId.get(id);
    },
    querySelector: (selector) => (selector.includes('arw-token') ? { content: 'test-token' } : null),
  };
  const window = { addEventListener() {} };
  const context = vm.createContext({
    console,
    document,
    window,
    Node,
    URL,
    Blob,
    setInterval: () => 0,
    clearInterval() {},
    fetch: () => Promise.reject(new Error('no dashboard server in this test')),
  });
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'web', 'public', 'app.js'), 'utf8');
  vm.runInContext(`${source}\nthis.__prTable = prTable; this.__prSummary = prSummary;`, context, { filename: 'app.js' });
  return context;
}

function elements(root) {
  const out = [];
  const walk = (node) => {
    if (node instanceof Element) {
      out.push(node);
      node.children.forEach(walk);
    } else if (node.children) node.children.forEach(walk);
  };
  walk(root);
  return out;
}

const row = {
  id: 'appsmithorg__appsmith__42411',
  repo: 'appsmithorg/appsmith',
  pr: 42411,
  title: '<img src=x onerror="alert(1)">',
  status: 'EXECUTED_PASS',
  recommendation: 'no_blocking_findings',
  complete: true,
  counts: { P1: 0, P2: 0, P3: 0, P4: 0, withdrawn: 0 },
  confirmed: 0,
  usage: { calls: 8, tokens_in: 100, tokens_out: 10 },
  unverified: 4,
  cannot_determine: 1,
  gaps: 0,
  updated_at: '2026-11-04T00:00:00.000Z',
};

test('a row with unverified work warns and never gets a green badge', () => {
  const app = makeContext();
  const table = app.__prTable([row]);
  const text = table.textContent;
  assert.match(text, /4 unverified/);
  assert.match(text, /1 cannot determine/);
  assert.match(text, /0 gaps/);
  assert.match(text, /Verification/);
  assert.equal(elements(table).filter((el) => /badge ok/.test(el.className)).length, 0, 'no green badge while verification is pending');
});

test('pending verification turns only a green badge yellow; a failed run stays red', () => {
  const app = makeContext();
  const table = app.__prTable([{ ...row, status: 'INVALIDATED', recommendation: 'changes_requested', gaps: 3 }]);
  const classes = elements(table).filter((el) => /badge/.test(el.className)).map((el) => [el.className, el.textContent]);
  assert.ok(classes.some(([cls, text]) => cls === 'badge bad' && text === 'INVALIDATED'), 'INVALIDATED keeps its red badge');
  assert.ok(classes.some(([cls, text]) => cls === 'badge bad' && text === 'changes_requested'), 'changes_requested keeps its red badge');
});

test('an unvalidated row is not shown as verified', () => {
  const app = makeContext();
  const table = app.__prTable([{ ...row, validated: false, unverified: 0, cannot_determine: 0, gaps: 0 }]);
  assert.match(table.textContent, /not validated/);
  assert.equal(elements(table).filter((el) => /badge ok/.test(el.className)).length, 0);
});

test('h() renders model text as text, not markup', () => {
  const app = makeContext();
  const table = app.__prTable([row]);
  assert.match(table.textContent, /<img src=x onerror="alert\(1\)">/);
  assert.equal(elements(table).filter((el) => el.tagName === 'img').length, 0);
});

test('prSummary separates execution complete from verification pending', () => {
  const app = makeContext();
  const summary = app.__prSummary({
    verification: { unverified: 4, cannot_determine: 1, gaps: 0 },
    validation: {
      status: 'EXECUTED_PASS', recommendation: 'no_blocking_findings', complete: true,
      counts: { P1: 0, P2: 0, P3: 0, P4: 0, withdrawn: 0 },
      gaps: [], warnings: [], drift: [], size: null, opt_outs: [], carried_over: null,
      context_id: '0123456789abcdef', validated_at: '2026-11-04T00:00:00.000Z',
    },
  });
  assert.match(summary.textContent, /execution complete/);
  assert.match(summary.textContent, /4 unverified/);
  assert.match(summary.textContent, /1 cannot determine/);
  assert.equal(elements(summary).filter((el) => /badge ok/.test(el.className)).length, 0, 'no green badge while verification is pending');

  const incomplete = app.__prSummary({
    verification: { unverified: 1, cannot_determine: 0, gaps: 0 },
    validation: {
      status: 'EXECUTED_PASS', recommendation: 'changes_requested', complete: false,
      counts: { P1: 0, P2: 1, P3: 0, P4: 0, withdrawn: 0 },
      gaps: [], warnings: [], drift: [], size: null, opt_outs: [], carried_over: null,
      context_id: '0123456789abcdef', validated_at: '2026-11-04T00:00:00.000Z',
    },
  });
  assert.match(incomplete.textContent, /incomplete/);
  assert.doesNotMatch(incomplete.textContent, /execution complete/);
});
