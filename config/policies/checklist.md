# Review checklist (curated viewpoints)

A finding that violates one of these viewpoints may cite its id as authority
`{ "kind": "curated_viewpoint", "id": "<ID>" }` with evidence quoting the line below.
Replace or extend this file with your team's own checklist; ids must stay unique.

## Transactions and data consistency
- CK-TX-1: A read-modify-write of shared state runs in one transaction with a lock, a version check, or an atomic update.
- CK-TX-2: A multi-step write either completes fully or rolls back; no partial state is visible after a failure.
- CK-TX-3: Spring `@Transactional` is effective: public method, called through the proxy, rollback configured for the checked exceptions thrown.
- CK-TX-4: External calls (HTTP, messaging) are not made inside a database transaction unless failure handling is explicit.

## Concurrency and idempotency
- CK-CC-1: Handlers of retried or redelivered messages and requests are idempotent (dedupe key, unique constraint, or state check).
- CK-CC-2: Check-then-act on shared resources is atomic.
- CK-CC-3: Shared mutable state accessed from several threads or tasks is synchronized or confined.

## Error handling and recovery
- CK-ER-1: Exceptions are not swallowed; failures are logged with context and surfaced or retried deliberately.
- CK-ER-2: Retries have a limit and backoff, and only retry operations that are safe to repeat.
- CK-ER-3: Every outbound network call has a timeout.
- CK-ER-4: Resources (connections, streams, files, locks) are released on every path.

## Business correctness
- CK-BZ-1: Boundary conditions match the requirement wording (inclusive/exclusive, "or more", "up to").
- CK-BZ-2: Money uses exact decimal types and an explicit rounding mode; currency is carried with the amount.
- CK-BZ-3: Date and time logic states its time zone; comparisons use the same zone and precision.
- CK-BZ-4: Null, empty and missing inputs have defined behaviour on every public entry point.

## Compatibility
- CK-CP-1: Public API, message and database contract changes are backward compatible or versioned.
- CK-CP-2: Database migrations are safe for existing data and for the old code version during rollout.
- CK-CP-3: Renamed or removed configuration keys keep a fallback or fail fast at startup.

## Security
- CK-SC-1: Authorization is checked on the server side for every new or changed entry point.
- CK-SC-2: Queries, commands and templates are built with parameters, never string concatenation of input.
- CK-SC-3: Secrets and personal data are not logged or returned in errors.

## Tests
- CK-TS-1: Changed behaviour has a test that fails without the change.
- CK-TS-2: Tests are not weakened, skipped or deleted to make the change pass.
- CK-TS-3: Boundary and negative cases of the changed rule are tested.

## Python specifics
- CK-PY-1: No mutable default arguments; no late-binding closures over loop variables.
- CK-PY-2: Datetimes are timezone-aware where they cross process or storage boundaries.
- CK-PY-3: ORM queries are not issued inside loops over result sets (N+1).

## Java specifics
- CK-JV-1: `equals`/`hashCode` stay consistent for objects used in sets, maps or JPA identity.
- CK-JV-2: `BigDecimal` comparison uses `compareTo` when scale may differ.
- CK-JV-3: MyBatis mapper XML matches the Java mapper signature and result mapping.
