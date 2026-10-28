---
name: packet-contract-change
description: Add or change a field, verdict kind or evidence form that review models answer with (config/schemas/review.schema.json and the other output schemas). Use when a change touches config/schemas/*.json, the validator, or what a packet, finding or verdict may contain.
---

# Changing a model output contract

Every commit that changed `config/schemas/review.schema.json` also changed `src/lib/validate.js` and
`src/lib/prompts.js`. Missing one of them shows up later as repair calls or rejected packets, not as a
test failure.

## Files that move together
1. `config/schemas/<name>.schema.json`: the only source of truth for the shape.
2. `src/lib/validate.js`: the checks a schema cannot express (quotes against `git show`, anchors,
   cross-references). A new field that carries evidence must be checked here.
3. `src/lib/prompts.js`: what the model is told to write. Same field names as the schema.
4. `src/lib/anchors.js` when the field can cite a hunk id (`H3`, `H3:47`) instead of a quote: the
   runtime fills in path, lines and quote.
5. Scripted answers: `test/fixtures/fake-review-executor.js` and the helpers in `test/helpers.js`,
   so the end-to-end tests produce the new shape.
6. Display: `src/lib/report.js` and the dashboard (`src/web/`) when people should see the field.

## Structured output rules
- codex gets `--output-schema` with `strictSchema()` from `src/lib/schema.js`: every property becomes
  required, optional ones become nullable, `additionalProperties` is false. `stripNulls` removes the
  nulls before the real schema validates. So an optional field must be optional in the schema, not
  only in the prompt.
- `CODEX_OUTPUT_SCHEMA=0` turns structured output off for providers that lack it; the repair loop must
  still reach a valid packet.

## Frozen contexts
`config/schemas/*.json` is hashed into every frozen context, and so are `src/lib/*.js`. After this
change every older context is stale: say "older contexts need a refresh" in the commit body.

## Check
1. A test that sends the new shape through `scriptedExecutor` and asserts what the validator accepts
   and rejects (missing field, wrong type, a quote that is not in the file).
2. `node scripts/test.js test/e2e.test.js` and then `npm test`.
3. Re-validate a stored packet on a copy of the runs:
   `ARW_RUNS_DIR=<copy of runs> node src/cli/arw.js validate --repo <owner/name> --pr <n>`
   (refused as drift when the run was frozen by an older tool; refresh it with a new review).
