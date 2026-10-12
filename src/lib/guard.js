'use strict';
// Deterministic guards on text that reaches a model:
// - redactSecrets: removes credentials before ticket text, PR bodies or the
//   evidence pack are frozen or sent (frozen snapshots hold the redacted text,
//   so quotes still match).
// - scanInjection: finds instruction-like text aimed at an AI reviewer in PR
//   content (added diff lines, PR body, ticket). A model cannot be relied on
//   to resist it, so a person is told where it is.

const SECRET_PATTERNS = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----/g],
  ['github-token', /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}\b/g],
  ['aws-access-key', /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['openai-key', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g],
  ['bearer', /\b(Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/g],
  // key = value assignments whose name says secret; the value is replaced.
  ['assignment', /\b((?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[:=]\s*["']?)([^\s"'<>]{6,})/gi],
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)([^\s@/]{3,})(@)/gi],
];

// Returns { text, redactions: [{ kind, count }] }.
function redactSecrets(input) {
  let text = String(input == null ? '' : input);
  const counts = new Map();
  for (const [kind, re] of SECRET_PATTERNS) {
    text = text.replace(re, (...m) => {
      // "password: required for login" is prose, not a credential.
      if (kind === 'assignment' && !/\d/.test(m[2]) && m[2].length < 16) return m[0];
      counts.set(kind, (counts.get(kind) || 0) + 1);
      if (kind === 'assignment') return `${m[1]}[REDACTED:${kind}]`;
      if (kind === 'bearer') return `${m[1]}[REDACTED:bearer]`;
      if (kind === 'url-credentials') return `${m[1]}[REDACTED]${m[3]}`;
      return `[REDACTED:${kind}]`;
    });
  }
  return { text, redactions: [...counts].map(([kind, count]) => ({ kind, count })) };
}

const INJECTION_PATTERNS = [
  ['override', /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|system|your)\b[^.\n]{0,30}\b(instructions?|prompts?|rules?|guidelines|messages?)\b/i],
  ['role', /\b(you are now|act as|pretend to be|from now on you|new instructions?:|system prompt|developer message)\b/i],
  ['verdict', /\b(approve|lgtm|mark (it|this) as (safe|passed|approved)|do not (report|flag|mention)|no (issues|findings) (here|found)|skip (the )?review)\b[^.\n]{0,40}\b(pr|pull request|change|review|code|finding|this)\b/i],
  ['addressed-to-ai', /\b(ai|llm|assistant|reviewer bot|code ?reviewer|codex|claude|gpt)\b[^.\n]{0,30}\b(must|should|please|needs? to)\b[^.\n]{0,30}\b(approve|ignore|not report|say|output|respond)\b/i],
  ['exfiltration', /\b(print|send|post|upload|exfiltrate|reveal)\b[^.\n]{0,30}\b(env(ironment)? variables?|secrets?|tokens?|credentials?|ssh keys?|\.env)\b/i],
];

// sources: [{ where, lines: [{ line, text }] }] -> hits [{ where, line, kind, text }]
function scanInjection(sources) {
  const hits = [];
  for (const src of sources) {
    for (const { line, text } of src.lines) {
      for (const [kind, re] of INJECTION_PATTERNS) {
        if (re.test(text)) {
          hits.push({ where: src.where, line, kind, text: String(text).trim().slice(0, 200) });
          break;
        }
      }
    }
  }
  return hits;
}

function textLines(text) {
  return String(text || '').split('\n').map((t, i) => ({ line: i + 1, text: t }));
}

// Added lines of a parsed patch (patch.parsePatch output).
function addedLines(parsed) {
  return parsed.map((f) => ({ where: f.path, lines: f.hunks.flatMap((h) => h.lines.filter((l) => l.type === '+').map((l) => ({ line: l.new_line, text: l.text }))) }));
}

module.exports = { redactSecrets, scanInjection, textLines, addedLines, SECRET_PATTERNS, INJECTION_PATTERNS };
