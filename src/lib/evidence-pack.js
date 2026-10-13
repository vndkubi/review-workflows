'use strict';
// Deterministic evidence pack built at freeze time (no model). Workers use it
// for caller/consumer lookups instead of free filesystem search, which was
// measured at 3-7.5 minutes per command in the system this one is modelled on.
const { grepFiles, showFile } = require('./git');
const { analyzeImpact, renderImpact } = require('./impact');

const LIMITS = { refsPerSymbol: 50, symbols: 40, signals: 30 };

const SKIP_PATTERNS = [
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Pipfile\.lock|uv\.lock|gradle\.lockfile)$/,
  /\.min\.(js|css)$/,
  /(^|\/)(vendor|node_modules|dist|target|build|__generated__|generated-sources)\//,
  /\.(png|jpe?g|gif|ico|svg|pdf|jar|war|class|zip|gz|tgz|so|dll|exe|pyc|whl)$/i,
  /_pb2(_grpc)?\.py$/,
];

const LANGUAGES = {
  java: {
    match: /\.(java|kt)$/,
    // MyBatis mappers and Spring XML reference Java names, so XML is searched too.
    pathspecs: ['*.java', '*.kt', '*.xml'],
    declarations(line) {
      const out = [];
      const type = line.match(/\b(?:class|interface|enum|record|@interface)\s+([A-Z]\w*)/);
      if (type) out.push(type[1]);
      const method = line.match(
        /^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|protected|private|static|final|abstract|synchronized|default|native)\s+)*(?:<[^>]+>\s+)?[\w.$<>[\],?]+(?:\s*<[^>]*>)?\s+([a-zA-Z_]\w*)\s*\([^;]*$/,
      );
      if (method && !JAVA_KEYWORDS.has(method[1])) out.push(method[1]);
      return out;
    },
    fileSymbol(path) {
      const m = path.match(/([A-Z]\w*)\.(java|kt)$/);
      return m ? [m[1]] : [];
    },
  },
  python: {
    match: /\.py$/,
    pathspecs: ['*.py', '*.toml', '*.cfg', '*.ini', '*.yaml', '*.yml'],
    declarations(line) {
      const m = line.match(/^\s*(?:async\s+)?(?:def|class)\s+([A-Za-z_]\w*)/);
      return m ? [m[1]] : [];
    },
    fileSymbol(path) {
      const m = path.match(/([A-Za-z_]\w*)\.py$/);
      return m && m[1] !== '__init__' ? [m[1]] : [];
    },
  },
};

const JAVA_KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'else', 'throw', 'synchronized', 'super', 'this']);
// Names too generic to produce a meaningful caller list.
const STOP_SYMBOLS = new Set([
  'get', 'set', 'run', 'main', 'init', 'test', 'setUp', 'tearDown', 'toString', 'equals', 'hashCode', 'apply', 'call',
  'execute', 'handle', 'process', 'build', 'create', 'update', 'delete', 'save', 'find', 'value', 'values', 'of', 'from',
  '__init__', '__str__', '__repr__', '__eq__', '__hash__', 'self', 'cls', 'Test', 'Main', 'App', 'Config', 'Utils',
]);

const BOUNDARY_SIGNALS = [
  ['http', /@(Get|Post|Put|Delete|Patch|Request)Mapping|RestTemplate|WebClient|@FeignClient|HttpClient|\brequests\.(get|post|put|delete)|\bhttpx\.|@app\.(route|get|post)|APIRouter|@router\./],
  ['messaging', /@KafkaListener|KafkaTemplate|@RabbitListener|RabbitTemplate|JmsTemplate|@JmsListener|@SqsListener|\bcelery\b|@shared_task|\.send_task\(|producer\.send|consumer\.poll/],
  ['transaction', /@Transactional|TransactionTemplate|transaction\.atomic|session\.commit\(|\.rollback\(|@transaction/],
  ['resilience', /@Retryable|@CircuitBreaker|@TimeLimiter|\bRetry(Template)?\b|\btimeout\b|tenacity|backoff/i],
  ['persistence', /@Query|JdbcTemplate|EntityManager|\bexecute(Update|Query)?\(|cursor\.execute|\.objects\.(filter|update|delete)|<(select|insert|update|delete)\b/],
  ['concurrency', /synchronized|ReentrantLock|Atomic\w+|ConcurrentHashMap|@Async|CompletableFuture|ExecutorService|threading\.|asyncio\.(gather|Lock)|select_for_update/],
  ['security', /@PreAuthorize|@Secured|@RolesAllowed|SecurityContext|PasswordEncoder|\bjwt\b|permission_classes|login_required|\bcsrf\b/i],
];

function enclosingDeclaration(lang, lines, lineNo, maxWalk = 200) {
  for (let i = lineNo - 1; i >= 0 && i >= lineNo - 1 - maxWalk; i -= 1) {
    const found = lang.declarations(lines[i] || '');
    if (found.length) return found;
  }
  return [];
}

function isSkipped(path) {
  return SKIP_PATTERNS.some((re) => re.test(path));
}

function languageOf(path) {
  return Object.keys(LANGUAGES).find((name) => LANGUAGES[name].match.test(path)) || null;
}

// parsed: output of parsePatch; changed: output of git.changedFiles.
function buildEvidencePack({ cwd, base, head, changed, parsed }) {
  const byPath = new Map(parsed.map((f) => [f.path, f]));
  const reviewable = changed.filter((f) => !isSkipped(f.path));
  const skipped = changed.filter((f) => isSkipped(f.path));

  const symbols = new Map(); // name -> { language, declared_in:Set }
  const addSymbol = (name, language, file) => {
    if (!name || name.length < 4 || STOP_SYMBOLS.has(name)) return;
    if (!symbols.has(name)) symbols.set(name, { language, declared_in: new Set() });
    symbols.get(name).declared_in.add(file);
  };
  const signals = [];

  for (const f of reviewable) {
    const language = languageOf(f.path);
    const pf = byPath.get(f.path);
    if (language) {
      const lang = LANGUAGES[language];
      lang.fileSymbol(f.path).forEach((s) => addSymbol(s, language, f.path));
      const headLines = f.status === 'D' ? [] : String(showFile(cwd, head, f.path) || '').split('\n');
      for (const hunk of pf ? pf.hunks : []) {
        for (const l of hunk.lines) if (l.type !== ' ') lang.declarations(l.text).forEach((s) => addSymbol(s, language, f.path));
        // A body-only change leaves the declaration as context: find the
        // enclosing declaration of the first added line at head.
        const first = hunk.lines.find((l) => l.type === '+');
        if (first) enclosingDeclaration(lang, headLines, first.new_line).forEach((s) => addSymbol(s, language, f.path));
      }
    }
    for (const hunk of pf ? pf.hunks : []) {
      for (const l of hunk.lines) {
        if (l.type !== '+' || signals.length >= LIMITS.signals) continue;
        for (const [kind, re] of BOUNDARY_SIGNALS) {
          if (re.test(l.text)) {
            signals.push({ kind, path: f.path, line: l.new_line, text: l.text.trim().slice(0, 160) });
            break;
          }
        }
      }
    }
  }

  const symbolRows = [];
  for (const [name, info] of [...symbols.entries()].slice(0, LIMITS.symbols)) {
    const { files, truncated } = grepFiles(cwd, head, name, LANGUAGES[info.language].pathspecs, LIMITS.refsPerSymbol);
    symbolRows.push({ name, language: info.language, declared_in: [...info.declared_in], referenced_in: files, truncated });
  }

  // Call sites of the changed declarations, from a structural index that
  // ignores comments and strings (ARW_IMPACT=off skips it).
  let impact = null;
  if (process.env.ARW_IMPACT !== 'off') {
    try {
      impact = analyzeImpact({ cwd, base, parsed });
    } catch (err) {
      impact = { error: err.message, scanned: 0, changed: [], edges: [], truncated: false };
    }
  }
  return {
    reviewable,
    skipped,
    symbols: symbolRows,
    symbols_truncated: symbols.size > LIMITS.symbols,
    signals,
    impact,
    text: renderPack({ base, head, reviewable, skipped, byPath, symbolRows, symbolsTruncated: symbols.size > LIMITS.symbols, signals, cwd }) + (impact && !impact.error ? renderImpact(impact) : ''),
  };
}

function renderPack({ base, head, reviewable, skipped, byPath, symbolRows, symbolsTruncated, signals, cwd }) {
  const out = [];
  out.push('# Evidence pack (deterministic, built at freeze time; no model involved)');
  out.push(`base: ${base}`, `head: ${head}`, '');
  out.push(`## Changed files (${reviewable.length})`);
  for (const f of reviewable) {
    const pf = byPath.get(f.path);
    const size = pf ? ` (+${pf.added} -${pf.removed})` : '';
    const rename = f.old_path ? ` (from ${f.old_path})` : '';
    const lines = f.status === 'D' ? '' : ` [${countLines(showFile(cwd, head, f.path))} lines at head]`;
    out.push(`${f.status} ${f.path}${rename}${size}${lines} [${languageOf(f.path) || 'other'}]`);
  }
  if (skipped.length) {
    out.push('', `## Not reviewable (lockfiles, generated, vendored, binary) (${skipped.length})`);
    skipped.forEach((f) => out.push(`${f.status} ${f.path}`));
  }
  out.push('', `## Symbols -> referenced_in at head (cap ${LIMITS.refsPerSymbol} files per symbol)`);
  if (!symbolRows.length) out.push('(no symbols extracted)');
  for (const s of symbolRows) {
    out.push(`${s.name} [${s.language}] declared/changed in: ${s.declared_in.join(', ')}`);
    out.push(`  referenced_in (${s.referenced_in.length}${s.truncated ? '+, TRUNCATED' : ''}): ${s.referenced_in.join(', ') || '(none)'}`);
  }
  if (symbolsTruncated) out.push(`(symbol list truncated at ${LIMITS.symbols})`);
  out.push('', `## Boundary signals on added lines (cap ${LIMITS.signals})`);
  if (!signals.length) out.push('(none)');
  signals.forEach((s) => out.push(`[${s.kind}] ${s.path}:${s.line}  ${s.text}`));
  out.push('', '## Notes');
  out.push('- Symbol lookup is lexical (whole-word git grep); dynamic dispatch, reflection and DI wiring are not resolved.');
  out.push('- Other services and repositories were not searched: cross-service impact is UNKNOWN unless shown above.');
  return `${out.join('\n')}\n`;
}

function countLines(text) {
  if (text == null) return 0;
  return text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
}

module.exports = { buildEvidencePack, isSkipped, languageOf, LANGUAGES, LIMITS };
