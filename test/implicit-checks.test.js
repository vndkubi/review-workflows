'use strict';
// Implicit requirements: what must stay true although nobody wrote it down.
// Seen in run 20261123-230429Z-repeat3b-luna-multi: Luna missed, in all three
// passes, defects of kinds no viewpoint asked about. The runtime now asks
// them from what the changed lines touch, like every other viewpoint.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { selectChecks } = require('../src/lib/viewpoint-checks');

const CHECKLIST = fs.readFileSync(path.join(__dirname, '..', 'config', 'policies', 'checklist.md'), 'utf8');
const file = (p, added, removed = []) => ({ path: p, hunks: [{ lines: [...added.map((text) => ({ type: '+', text })), ...removed.map((text) => ({ type: '-', text }))] }] });
const asks = (f, id) => assert.ok(selectChecks([f], CHECKLIST).includes(id), `${id} not asked for ${f.path}: ${selectChecks([f], CHECKLIST).join(', ')}`);
const notAsks = (f, id) => assert.ok(!selectChecks([f], CHECKLIST).includes(id), `${id} asked for ${f.path}`);

test('every new viewpoint is in the shared checklist', () => {
  for (const id of ['CK-NL-1', 'CK-CP-5', 'CK-DK-1', 'CK-OR-1', 'CK-FL-1', 'CK-TS-4', 'CK-PF-1']) {
    assert.match(CHECKLIST, new RegExp(`^- ${id}: `, 'm'), id);
  }
});

// keycloak-36880 M4: getResourceTypeResource may return null, then findByResource.
test('a value from a lookup that may be null is asked about before it is used', () => {
  asks(file('services/src/main/java/org/keycloak/ClientPermissionsV2.java', [
    '        Resource resource = getResourceTypeResource(session, server, AdminPermissionsSchema.CLIENTS_RESOURCE_TYPE);',
    '        policyStore.findByResource(server, resource);',
  ]), 'CK-NL-1');
  asks(file('app/models.py', ['    detector = Detector.objects.filter(id=pk).first()']), 'CK-NL-1');
  notAsks(file('README.md', ['Resource resource = find();']), 'CK-NL-1');
});

// sentry-5 M1: an endpoint returns HttpResponse where its base class expects a DRF Response.
test('a handler or overriding method is asked whether it keeps its framework or parent contract', () => {
  asks(file('src/sentry/issues/endpoints/browser_reporting_collector.py', [
    'class BrowserReportingCollectorEndpoint(Endpoint):',
    '        return HttpResponse(status=404)',
  ]), 'CK-CP-5');
  asks(file('src/main/java/acme/Form.java', ['    @Override', '    public void authenticate(AuthenticationFlowContext context) {']), 'CK-CP-5');
});

// sentry-5 M2: validated_data.get("detector_type") where the serializer field is "type".
test('keys written and read for the same payload are asked to match', () => {
  asks(file('src/sentry/workflow_engine/endpoints/validators/detector.py', [
    '        instance.type = validated_data.get("detector_type", instance.type)',
  ]), 'CK-DK-1');
  asks(file('src/main/java/acme/Dto.java', ['    @JsonProperty("client_id")']), 'CK-DK-1');
});

// sentry-5 M3: zip(error_ids, events.values()) assumes get_multi keeps the order.
test('code that may rely on an unguaranteed order is asked about it', () => {
  asks(file('src/sentry/replays/endpoints/project_replay_summarize_breadcrumbs.py', [
    '    for error_id, event in zip(error_ids, events.values()):',
  ]), 'CK-OR-1');
  asks(file('src/main/java/acme/Repo.java', ['        Map<String, Long> byId = new HashMap<>();']), 'CK-OR-1');
});

// keycloak-36880 M1: cleanup guarded by the V1 flag while the rest uses V2.
test('feature flags and guards are asked to agree along the flow', () => {
  asks(file('services/src/main/java/org/keycloak/AdminPermissions.java', [
    '        if (!Profile.isFeatureEnabled(Profile.Feature.ADMIN_FINE_GRAINED_AUTHZ)) return;',
  ]), 'CK-FL-1');
  asks(file('static/app/views/chart.tsx', ["  const enabled = organization.features.includes('use-table-widget');"]), 'CK-FL-1');
});

// sentry-80168 M3: a test passes 6 for group_2 where the data says 10.
test('constants and expected values in changed tests are asked to match their fixture', () => {
  asks(file('tests/sentry/workflow_engine/test_detector.py', ['            "group_2": 6,', '        assert result == expected']), 'CK-TS-4');
  notAsks(file('src/sentry/x.py', ['    assert value']), 'CK-TS-4');
});

// appsmith-817d146c: smart-substitution regexes ran in super-linear time.
test('a regular expression in the change is asked whether its run time is bounded by the input', () => {
  asks(file('app/server/appsmith-plugins/mongoPlugin/src/main/java/com/external/plugins/MongoPlugin.java', [
    '    private static final Pattern ISODATE = Pattern.compile("ISODate\\\\((.*?)\\\\)");',
  ]), 'CK-PF-1');
  asks(file('app/util.py', ['    m = re.sub(r"(a+)+$", "", text)']), 'CK-PF-1');
  asks(file('app/client/src/x.ts', ['  const ok = /^(\\w+\\s?)*$/.test(input);']), 'CK-PF-1');
});
