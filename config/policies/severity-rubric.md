# Severity rubric

Severity = impact × reachability × recoverability.

| Severity | Meaning | Examples |
|---|---|---|
| P1 | Reachable path causes data loss/corruption, wrong money, security breach, or outage. Hard to recover. | Double charge on retry; missing authz on a write endpoint; migration drops a column still read. |
| P2 | Reachable path produces wrong business behaviour that users or callers observe. Recoverable. | Discount boundary excludes the stated value; status never updated on error path. |
| P3 | Edge case or degraded behaviour; missing test for changed behaviour; risk without a demonstrated path. | Timeout missing on a rarely used call; no test for the negative case. |
| P4 | Minor correctness or maintainability issue with low impact. | Misleading log message; dead branch. |

Rules:
- P1/P2 need confidence LIKELY (a concrete trigger shown by code evidence). P1 also needs authority from a
  requirement or a checklist viewpoint; inferred authority (engineering judgement) supports at most P2, so a
  call that no longer compiles or a main flow that now fails can block without a checklist line.
- Test and process remarks (category test_gap / process) are suggestions: P4, outside the verdict.
- Not sure whether the path is reachable → lower the severity and say what is unknown.
- Style and naming preferences are not findings.

Labels (assigned by the runtime, not by workers):
- SUSPECTED — static evidence validated (L1); not executed.
- CONFIRMED — reproduced by an executed test that fails on the reviewed head (L3).
- NOT_A_BUG — withdrawn by the red-team with evidence.
