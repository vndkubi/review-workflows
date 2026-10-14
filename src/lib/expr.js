'use strict';
// Expected-result expressions of a spec rule, e.g. "min(total * 0.1, 100000)".
// The model declares them, a person approves them at the SPEC gate, and only
// this code evaluates them, per scenario row. Grammar:
//   expr   := term (("+" | "-") term)*
//   term   := unary (("*" | "/") unary)*
//   unary  := "-" unary | atom
//   atom   := number | variable | func "(" expr ("," expr)* ")" | "(" expr ")"
//   func   := min | max | round | floor | ceil | abs
// round(x) and round(x, digits) round half away from zero.

const FUNCS = {
  min: { arity: [1, Infinity], fn: (...a) => Math.min(...a) },
  max: { arity: [1, Infinity], fn: (...a) => Math.max(...a) },
  round: { arity: [1, 2], fn: (x, d = 0) => roundHalfAway(x, d) },
  floor: { arity: [1, 1], fn: (x) => Math.floor(x + 1e-9) },
  ceil: { arity: [1, 1], fn: (x) => Math.ceil(x - 1e-9) },
  abs: { arity: [1, 1], fn: (x) => Math.abs(x) },
};

function roundHalfAway(x, digits) {
  if (!Number.isInteger(digits) || digits < 0 || digits > 10) throw new Error('round(x, digits): digits must be an integer from 0 to 10');
  const f = 10 ** digits;
  // The epsilon absorbs binary noise (1.005 * 100 = 100.49999...).
  return (Math.sign(x) * Math.round(Math.abs(x) * f + 1e-7)) / f;
}

function tokenize(text) {
  const tokens = [];
  const re = /\s*(?:(\d+(?:\.\d+)?|\.\d+)|([a-z][a-z0-9_]*)|(.))/gy;
  let m;
  while (re.lastIndex < text.length && (m = re.exec(text))) {
    if (m[1] != null) tokens.push({ t: 'num', v: Number(m[1]) });
    else if (m[2] != null) tokens.push({ t: 'id', v: m[2] });
    else if (m[3] != null) {
      if (!'+-*/(),'.includes(m[3])) throw new Error(`unexpected "${m[3]}"`);
      tokens.push({ t: m[3] });
    }
  }
  return tokens;
}

// Returns { ast, variables: [ids] }; throws Error with a readable message.
function parseExpr(text) {
  if (typeof text !== 'string' || !text.trim()) throw new Error('empty expression');
  if (text.length > 300) throw new Error('expression longer than 300 characters');
  const tokens = tokenize(text);
  let i = 0;
  const variables = new Set();
  const peek = () => tokens[i];
  const take = (t) => {
    const tok = tokens[i];
    if (!tok || tok.t !== t) throw new Error(`expected "${t}"${tok ? ` but found ${tok.v != null ? tok.v : `"${tok.t}"`}` : ' at the end'}`);
    i += 1;
    return tok;
  };
  let depth = 0;
  const expr = () => {
    if ((depth += 1) > 40) throw new Error('expression nested too deeply');
    let node = term();
    while (peek() && (peek().t === '+' || peek().t === '-')) node = { op: tokens[i++].t, a: node, b: term() };
    depth -= 1;
    return node;
  };
  const term = () => {
    let node = unary();
    while (peek() && (peek().t === '*' || peek().t === '/')) node = { op: tokens[i++].t, a: node, b: unary() };
    return node;
  };
  const unary = () => {
    if (peek() && peek().t === '-') {
      i += 1;
      return { op: 'neg', a: unary() };
    }
    return atom();
  };
  const atom = () => {
    const tok = peek();
    if (!tok) throw new Error('unexpected end of expression');
    if (tok.t === 'num') {
      i += 1;
      return { num: tok.v };
    }
    if (tok.t === '(') {
      i += 1;
      const node = expr();
      take(')');
      return node;
    }
    if (tok.t === 'id') {
      i += 1;
      if (peek() && peek().t === '(') {
        const f = FUNCS[tok.v];
        if (!f) throw new Error(`unknown function ${tok.v}() (allowed: ${Object.keys(FUNCS).join(', ')})`);
        i += 1;
        const args = [expr()];
        while (peek() && peek().t === ',') {
          i += 1;
          args.push(expr());
        }
        take(')');
        if (args.length < f.arity[0] || args.length > f.arity[1]) throw new Error(`${tok.v}() takes ${f.arity[0] === f.arity[1] ? f.arity[0] : `${f.arity[0]}..${f.arity[1] === Infinity ? 'n' : f.arity[1]}`} argument(s)`);
        return { fn: tok.v, args };
      }
      variables.add(tok.v);
      return { v: tok.v };
    }
    throw new Error(`unexpected "${tok.t}"`);
  };
  const ast = expr();
  if (i < tokens.length) throw new Error(`unexpected ${tokens[i].v != null ? tokens[i].v : `"${tokens[i].t}"`} after the expression`);
  return { ast, variables: [...variables] };
}

// env: { variable: number }. Throws on a missing variable, a division by
// zero or a non-finite result.
function evalAst(node, env) {
  if (node.num != null) return node.num;
  if (node.v != null) {
    const x = env[node.v];
    if (typeof x !== 'number' || !Number.isFinite(x)) throw new Error(`variable ${node.v} has no numeric value`);
    return x;
  }
  if (node.fn) return FUNCS[node.fn].fn(...node.args.map((a) => evalAst(a, env)));
  if (node.op === 'neg') return -evalAst(node.a, env);
  const a = evalAst(node.a, env);
  const b = evalAst(node.b, env);
  if (node.op === '/' && b === 0) throw new Error('division by zero');
  const r = { '+': a + b, '-': a - b, '*': a * b, '/': a / b }[node.op];
  if (!Number.isFinite(r)) throw new Error('non-finite result');
  return r;
}

function evaluate(text, env) {
  return evalAst(parseExpr(text).ast, env);
}

module.exports = { parseExpr, evalAst, evaluate, roundHalfAway, FUNCS };
