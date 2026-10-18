'use strict';
// The viewpoint matrix. Which checklist viewpoints a unit must answer is
// decided here, from what the unit's changed lines touch, not by the model:
// a reviewer then gives one verdict per assigned viewpoint, so two runs or
// two models answer the same questions and an unchecked viewpoint is visible.
// Signals are deliberately broad (a viewpoint asked needlessly costs one
// "not_applicable" row; one never asked is a blind spot), and a viewpoint the
// team's checklist lacks is never asked.

const SOURCE = /\.(java|kt|scala|groovy|py|js|jsx|ts|tsx|go|cs|rb|php)$/;
const TEST = /(^|\/)(test|tests|__tests__|spec)\/|Tests?\.(java|kt)$|(^|\/)test_[^/]*\.py$|_test\.(py|go)$|\.(test|spec)\.[jt]sx?$/;
const JAVA = /\.(java|kt)$/;
const PYTHON = /\.py$/;

const TX = /@Transactional|transaction\.atomic|select_for_update|with_for_update|\bbegin_nested\b/;
const WRITE = /\.(save|saveAll|saveAndFlush|merge|persist|update|delete|insert|bulk_update|bulk_create)\(|\b(UPDATE\s+\w+\s+SET|INSERT\s+INTO|DELETE\s+FROM)\b|@Modifying|session\.(add|commit)\b/i;
const OUTBOUND = /RestTemplate|WebClient|HttpClient|OkHttp|@FeignClient|HttpURLConnection|\.(postForObject|getForObject|postForEntity|getForEntity|exchange)\(|\brequests\.(get|post|put|patch|delete|request)\(|\bhttpx\.|urlopen\(|\bfetch\(|\baxios\b|KafkaTemplate|RabbitTemplate|JmsTemplate|\.send\(/;
const ENTRY = /@(Get|Post|Put|Delete|Patch|Request)Mapping|@(Rest)?Controller\b|@Path\(|@WebServlet|@(app|router|bp|blueprint)\.(route|get|post|put|patch|delete)\b|@api_view|\bAPIView\b/;
const CONSUMER = /@(Kafka|Rabbit|Jms|Sqs)Listener|@Retryable|@Scheduled|@StreamListener|\bonMessage\(|@shared_task|@app\.task|@celery|\bwebhook/i;
const CHECK_THEN_ACT = /\b(existsBy\w*|findBy\w*|get_or_create|putIfAbsent|computeIfAbsent|containsKey)\(|\.exists\(\)/;
const SHARED_STATE = /\bstatic\s+(?!final\b)[\w<>,.?\s[\]]+\s+\w+\s*[=;]|\bsynchronized\b|Concurrent\w+|Atomic(Integer|Long|Reference|Boolean)|ExecutorService|CompletableFuture|@Async|\bthreading\b|\bThread\(|ThreadPool/;
const COMPARISON = /\s(<|>|<=|>=)\s|compareTo\(|is(Before|After)\(|\bBETWEEN\b|\bbetween\(/;
const MONEY = /BigDecimal|\bDecimal\(|\bdouble\b|\bfloat\b|RoundingMode|setScale\(|\bround\(|\b(amount|price|money|currency|balance|fee|tax|total)\b/i;
const TIME = /Local(Date|DateTime|Time)|ZonedDateTime|OffsetDateTime|\bInstant\b|java\.util\.Date|\bCalendar\b|ZoneId|TimeZone|\bdatetime\b|\btimezone\b|\btimestamp\b|\butcnow\b/;

// Each rule: id, and when it applies to one changed file. `lines` and `all`
// are matched against the file's added and removed lines.
const RULES = [
  { id: 'CK-TX-1', source: true, lines: [TX, WRITE] },
  { id: 'CK-TX-2', source: true, lines: [TX, WRITE] },
  { id: 'CK-TX-3', lines: [/@Transactional/] },
  { id: 'CK-TX-4', all: [TX, OUTBOUND] },
  { id: 'CK-CC-1', lines: [CONSUMER] },
  { id: 'CK-CC-2', source: true, lines: [CHECK_THEN_ACT] },
  { id: 'CK-CC-3', source: true, lines: [SHARED_STATE] },
  { id: 'CK-ER-1', source: true, lines: [/\bcatch\s*\(|\bexcept\b|\.catch\(/] },
  { id: 'CK-ER-2', lines: [/retry|backoff|@Retryable|maxAttempts|tenacity/i] },
  { id: 'CK-ER-3', source: true, lines: [OUTBOUND] },
  { id: 'CK-ER-4', source: true, lines: [/InputStream|OutputStream|\b\w*(Reader|Writer)\b|\bConnection\b|ResultSet|\bStatement\b|\.lock\(\)|\bopen\(|\bSocket\b|try\s*\(/] },
  { id: 'CK-BZ-1', source: true, lines: [COMPARISON] },
  { id: 'CK-BZ-2', source: true, lines: [MONEY] },
  { id: 'CK-BZ-3', source: true, lines: [TIME] },
  { id: 'CK-BZ-4', source: true, lines: [ENTRY] },
  { id: 'CK-CP-1', paths: /\.(proto|avsc|graphql|wsdl|xsd)$|openapi|swagger/i, removed: [/\bpublic\s|@\w+Mapping|@JsonProperty|@Column|@Table|\bdef\s+\w+\s*\(/] },
  { id: 'CK-CP-2', paths: /(^|\/)(migrations?|flyway|liquibase|changelog|alembic)\/|\.sql$/i, lines: [/\b(ALTER|DROP)\s+TABLE\b|\bADD\s+COLUMN\b|\bRENAME\b/i] },
  { id: 'CK-CP-3', paths: /\.(properties|ya?ml|ini|cfg|toml|env)$/, lines: [/@Value\(|@ConfigurationProperties|getProperty\(|os\.environ|\bgetenv\(/] },
  { id: 'CK-SC-1', lines: [ENTRY, /@PreAuthorize|@Secured|@RolesAllowed|hasRole|hasAuthority|permission_classes|login_required/] },
  { id: 'CK-SC-2', paths: /Mapper\.xml$/, lines: [/create(Native)?Query\(|executeQuery\(|jdbcTemplate|cursor\.execute\(|\.raw\(|\$\{|ProcessBuilder|Runtime\.getRuntime|\bsubprocess\b|os\.system\(/] },
  { id: 'CK-SC-3', source: true, lines: [/password|passwd|secret|token|credential|\bssn\b|card_?number/i] },
  { id: 'CK-TS-1', source: true, always: true },
  { id: 'CK-TS-2', test: true, removedAny: true, lines: [/@(Disabled|Ignore)\b|@pytest\.mark\.(skip|xfail)|\.skip\(|\bxit\(|\bxdescribe\(/] },
  { id: 'CK-TS-3', source: true, lines: [COMPARISON] },
  { id: 'CK-PY-1', lang: PYTHON, lines: [/\bdef\s+\w+\(.*=\s*(\[\]|\{\}|set\(\))|\blambda\b/] },
  { id: 'CK-PY-2', lang: PYTHON, lines: [/\bdatetime\b|\butcnow\b|\.now\(/] },
  { id: 'CK-PY-3', lang: PYTHON, lines: [/\.objects\.|session\.query\(|\.query\(|\bselect\(/] },
  { id: 'CK-JV-1', lang: JAVA, lines: [/\bequals\(|\bhashCode\(|@Entity\b|@Id\b|@EqualsAndHashCode|@Data\b/] },
  { id: 'CK-JV-2', lang: JAVA, lines: [/BigDecimal/] },
  { id: 'CK-JV-3', paths: /mapper[^/]*\.xml$/i, lines: [/@Mapper\b|@(Select|Insert|Update|Delete)\(|resultMap|<(select|insert|update|delete)\b/] },
];

// No cap by default: quality first, a needless viewpoint costs one
// "not_applicable" row. ARW_UNIT_CHECKS caps it when a run must be cheaper.
function maxChecks() {
  const n = Number(process.env.ARW_UNIT_CHECKS);
  return Number.isInteger(n) && n > 0 ? n : Infinity;
}

// Checklist ids in the order the checklist lists them, each once.
function checklistIds(text) {
  const out = [];
  for (const m of String(text || '').matchAll(/^\s*-\s*(CK-[A-Z]+-[0-9]+):/gm)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

function changedLines(file) {
  const added = [];
  const removed = [];
  for (const h of file.hunks || []) for (const l of h.lines) if (l.type === '+') added.push(l.text);
  else if (l.type === '-') removed.push(l.text);
  return { added, removed };
}

function applies(rule, file) {
  const p = file.path || file.old_path || '';
  const isTest = TEST.test(p);
  if (rule.source && (!SOURCE.test(p) || isTest)) return false;
  if (rule.test && !isTest) return false;
  if (rule.lang && !rule.lang.test(p)) return false;
  const { added, removed } = changedLines(file);
  const all = [...added, ...removed];
  if (rule.always) return all.length > 0;
  if (rule.removedAny && removed.length) return true;
  if (rule.paths && rule.paths.test(p)) return true;
  if (rule.removed && rule.removed.some((re) => removed.some((l) => re.test(l)))) return true;
  if (rule.all) return rule.all.every((re) => all.some((l) => re.test(l)));
  return Boolean(rule.lines && rule.lines.some((re) => all.some((l) => re.test(l))));
}

// files: parsed patch entries of one unit. Returns checklist ids, in
// checklist order, at most `max`.
function selectChecks(files, checklistText, { max = maxChecks() } = {}) {
  const hit = new Set();
  for (const rule of RULES) if (files.some((f) => !f.binary && applies(rule, f))) hit.add(rule.id);
  return checklistIds(checklistText).filter((id) => hit.has(id)).slice(0, max);
}

// Whole-diff sweeps and seams answer no matrix: the substantive unit that
// owns a file answers for it.
const ANSWERING_KINDS = new Set(['business', 'technical', 'orphan']);

function assignChecks(units, parsed, checklistText) {
  const byPath = new Map(parsed.map((f) => [f.path, f]));
  for (const u of units) {
    const files = ANSWERING_KINDS.has(u.kind) ? u.covers.filter((c) => c.startsWith('file:')).map((c) => byPath.get(c.slice(5))).filter(Boolean) : [];
    u.checks = files.length ? selectChecks(files, checklistText) : [];
  }
  return units;
}

// The technical reviewer answers the matrix; a unit without one (business
// only, single-role mode) has its own reviewer answer.
function checkRole(unit) {
  return unit.roles.includes('technical') ? 'technical' : unit.roles[0];
}

module.exports = { RULES, TEST, checklistIds, selectChecks, assignChecks, checkRole };
