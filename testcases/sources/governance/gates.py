"""Ordered governance testcase section: gates."""
from __future__ import annotations


# ===========================================================================
# governance/gates.md — delivery gates P0..P5 (SRS 24, implement/09)
# governance/dod.md — Definition of Done, ten pillars (SRS 27, SRS 28)
# ===========================================================================
_GATE_PRE = [
    "Namespace " + NS + "gate-<case_id>-<worker_id>; the gate registry and the evidence registry are read from fixtures/offline/governance.json (gate_registry, gate_evidence_state) and no evidence may be created, simulated or back-dated inside the run.",
    "Frozen clock " + CLOCK + "; every required evidence artifact is classified as runtime, mock or design before any status is written.",
]
_GATE_AUTO = ("The gate-evaluation code and the run-report writer run as real code under test while the evidence registry is data. The "
              "oracle is the pair (evidence registry, run-report status): a gate that reads PASS without a real artifact fails the case, and "
              "a missing runtime is reported NOT_RUN instead of being allowed to fall through to PASS.")

_DOD_PRE = [
    "Namespace " + NS + "dod-<case_id>-<worker_id>; the DoD pillar registry is read from fixtures/offline/governance.json (dod_pillars, dod_state) and no pillar may be added, removed, merged or re-kinded inside the run.",
    "Frozen clock " + CLOCK + "; each pillar is scored against its own artifact and kind, so a document cannot stand in for a runtime artifact and mock coverage cannot close any pillar.",
]

_GATE_ROWS = (
    {"gate": "P0", "name": "Foundation", "priority": "critical",
     "entry": "canonical contracts, Customer 360, the Agent/Skill/Workflow contract, authority, policy, evidence, audit and the connector framework exist with frozen contracts",
     "exit": "no authority bypass and no lost trace",
     "reqs": ("SRS-24", "NFR-001", "NFR-002", "TC-E2E-006", "TC-E2E-009"),
     "facets": ("entity:Evidence", "stage:EVIDENCE"),
     "risk": "An authority bypass or a lost trace is signed off as a foundation pass, so every later gate and pilot inherits a control that was never demonstrated.",
     "owner": "Platform/QA"},
    {"gate": "P1", "name": "Customer Care Pilot", "priority": "critical",
     "entry": "the conversation agent, intent detection, identity resolution, ERP lookup, order status, FAQ and escalation paths are implemented",
     "exit": "one real conversation handled end to end with evidence",
     "reqs": ("SRS-24", "PILOT-03", "OBJ-003", "FR-CS-001"),
     "facets": ("entity:Service Case", "kpi:AI Resolution Rate", "memory:Customer Context"),
     "risk": "A care pilot is declared passed on a scripted conversation, so the first real customer question exposes an identity, lookup or escalation defect that the gate was supposed to catch.",
     "owner": "Customer Care/QA"},
    {"gate": "P2", "name": "Sales Pilot", "priority": "critical",
     "entry": "qualification, product search, recommendation, cart recovery, cross-sell and order assistance are implemented",
     "exit": "AI action to order to revenue evidence",
     "reqs": ("SRS-24", "PILOT-02", "OBJ-002", "SAL-03"),
     "facets": ("entity:Order", "kpi:Lead-to-Order Conversion", "stage:ACTION"),
     "risk": "A sales pilot is declared passed without a real order and a revenue row, so attribution and order-handling defects surface only after go-live.",
     "owner": "Sales/Finance"},
    {"gate": "P3", "name": "Marketing Pilot", "priority": "high",
     "entry": "audience, campaign, content, approval, channel execution and attribution are implemented",
     "exit": "audience, campaign, approval, real channel execution and attribution all evidenced",
     "reqs": ("SRS-24", "PILOT-01", "OBJ-001", "MKT-06"),
     "facets": ("entity:Campaign", "kpi:Campaign Revenue", "stage:APPROVAL"),
     "risk": "The pilot is signed off without a real provider send receipt, so a campaign is reported as delivered although no channel ever accepted it.",
     "owner": "Marketing/QA"},
    {"gate": "P4", "name": "Cross-Domain Orchestration", "priority": "high",
     "entry": "marketing, sales, care/success and retention can be orchestrated across one customer journey",
     "exit": "marketing to sales to care to retention without losing customer context",
     "reqs": ("SRS-24", "OBJ-005", "FR-ORC-001", "PILOT-01", "PILOT-02"),
     "facets": ("memory:Customer Context", "stage:CONTEXT", "kpi:Retention"),
     "risk": "Context is lost between agents and the customer repeats themselves to every stage, which is the exact failure the orchestration gate exists to prevent.",
     "owner": "Solution Architect/QA"},
    {"gate": "P5", "name": "Controlled Autonomy", "priority": "high",
     "entry": "low-risk actions are qualified for promotion from recommend to draft to auto-execute while high-risk actions keep approval",
     "exit": "a low-risk action promoted with high-risk approval still required",
     "reqs": ("SRS-24", "OBJ-006", "NFR-001", "AUTH-4", "PILOT-04"),
     "facets": ("stage:APPROVAL", "entity:Approval", "kpi:Autonomous Completion Rate"),
     "risk": "Autonomy is promoted by widening a limit rather than by evidence, so a high-risk action executes without the approval that the gate claims is retained.",
     "owner": "Governance/Finance"},
)


def _gate_case(row: dict) -> dict:
    """One delivery gate: exit criterion, required evidence kinds and the NOT_RUN rule."""
    gate = row["gate"]
    evidence_kind = GOVERNANCE_FIXTURE["gate_evidence_state"][gate]
    evidence_list = GOVERNANCE_FIXTURE["gate_registry"][gate]["required_evidence"]
    kinds = ", ".join(name + "=" + evidence_kind.get(name, "absent") for name in evidence_list)
    return case(
        "GOV-GATE-" + gate,
        gate + " " + row["name"] + ": exit criterion '" + row["exit"] + "' is signed only on real runtime evidence",
        GATE_SUITE, "governance", list(row["reqs"]),
        list(row["facets"]), "baseline", gate, row["priority"],
        row["risk"],
        [GOV_FX, ENV_EXAMPLE],
        _GATE_PRE + [
            gate + " entry conditions are recorded as: " + row["entry"] + ".",
            "The evidence registry for " + gate + " lists " + ", ".join(evidence_list) + " with the kinds " + kinds + ", and the "
            "case evidence includes no application-runtime artifact.",
        ],
        {"gate": gate, "name": row["name"], "owner": row["owner"], "entry_conditions": row["entry"],
         "exit_criterion": row["exit"], "required_evidence": list(evidence_list),
         "evidence_kind": dict(evidence_kind), "runtime_available": False,
         "expected_status": "NOT_RUN", "mock_coverage_is_gate_evidence": False},
        [("Read the entry conditions and the required evidence list for " + gate,
          "The registry lists the entry conditions and each required artifact with its kind (" + kinds + "), and none of them is a runtime artifact."),
         ("Attempt to sign " + gate + " off from the offline and mock suite results",
          "Rejected: mock coverage shows the control logic against substituted boundaries and cannot evidence the exit criterion, so the status stays unapproved."),
         ("Attempt to sign " + gate + " off from the design documents",
          "Every artifact keeps its real kind; design artifacts remain gaps and no artifact is upgraded by the attempt."),
         ("Evaluate the gate with the real runtime absent",
          "The status is NOT_RUN naming the missing runtime artifacts, with no approver, no signature and no PASS anywhere in the record."),
         ("Attempt to close " + gate + " with evidence belonging to another gate",
          "The artifact is rejected as belonging to another gate, which keeps its own status.")],
        [gate + " is never reported PASS: when the required runtime artifact is absent, the admissible outcomes are NOT_RUN for the "
         "missing evidence and BLOCKED_PREREQUISITE for a missing lock, and each required artifact is listed with its own kind and status.",
         "A mock or substituted-boundary artifact is never accepted as gate evidence; mock coverage is reported as specification coverage only.",
         "The exit criterion '" + row["exit"] + "' is evaluated only against artifacts of kind runtime, and design or absent artifacts are "
         "listed as gaps against the owning role " + row["owner"] + ".",
         "All " + str(len(evidence_list)) + " required evidence items are reported individually, so a partial pack cannot be summarised as done."],
        ["Treating a green offline or mock suite as gate evidence.",
         "Marking the gate passed while a required evidence item is absent.",
         "Re-labelling a design document or a mock receipt as a runtime artifact."],
        ["Gate evidence registry snapshot listing each required artifact with its kind and status.",
         "Run-report row for the gate with the status NOT_RUN, the missing items and no approver signature.",
         "Mock-coverage report kept separate from the gate record and labelled as specification coverage."],
        ["Delete " + NS + " gate-report rows after exporting the registry snapshot; the registry fixture and the design documents are left unchanged."],
        _GATE_AUTO,
        prereq=[gate + " requires real runtime evidence (" + ", ".join(evidence_list) + ") from live adapters, real data and upstream "
                "receipts; no such runtime evidence is present in this case, so the gate is NOT_RUN and any PASS claim is BLOCKED_PREREQUISITE."],
        refs=[IMPL09, SRS],
    )


_add(*[_gate_case(row) for row in _GATE_ROWS])

_add(
    case(
        "GOV-GATE-MOCK-NOT-EVIDENCE", "Mock coverage is specification coverage and never closes a gate",
        GATE_SUITE, "governance", ["SRS-24", "NFR-002", "SRS-27"],
        ["stage:EVIDENCE", "entity:Evidence"], "blueprint", "P0", "high",
        "A fully green offline suite is presented as the pilot evidence pack, so nobody notices that no real connector, real customer or upstream receipt was ever involved and the gate is passed on a substitute.",
        [GOV_FX, ENV_EXAMPLE],
        _GATE_PRE + ["The offline suite produces receipts from substituted boundaries, while every gate in the registry requires artifacts of kind runtime.",
                    "The evidence registry classifies each artifact by kind, and mock artifacts are never promoted by the harness."],
        {"artifacts": [{"artifact": "erp_lookup_receipt", "produced_by": "offline mock ERP", "kind": "mock"},
                       {"artifact": "provider_send_receipt", "produced_by": "nothing", "kind": "absent"},
                       {"artifact": "order_confirmation", "produced_by": "offline mock commerce", "kind": "mock"}],
         "gate_required_kind": "runtime", "expected_verdict": "NOT_EVIDENCE",
         "mock_suite_result": "all green", "mock_suite_scope": "substituted boundaries only"},
        [("Collect the artifacts the offline suite produced",
          "Each artifact is registered with the boundary that produced it and is classified as mock or absent, never as runtime."),
         ("Submit the artifact pack as evidence for a gate",
          "The pack is rejected as gate evidence; the gate keeps its earlier status and the rejection names each artifact and its kind."),
         ("Re-run the offline suite to show the green result",
          "The green result is recorded as specification coverage: it shows that the control logic matches the contract against substituted boundaries."),
         ("Attempt to promote a mock artifact to a runtime artifact through the registry",
          "The promotion is refused; a kind can only change when the artifact is produced by the real boundary with its own receipt.")],
        ["Mock artifacts never satisfy a gate whose required kind is runtime, and the gate is not reported PASS on a green offline suite.",
         "The distinction is preserved in the record: specification coverage is listed separately from gate evidence, with the substituted boundary named.",
         "The rejection names each artifact and its kind, so a reader can see exactly what would have to be produced for real.",
         "No registry write from the run can change an artifact's kind."],
        ["Reporting an all-green offline suite as pilot evidence.",
         "Promoting a mock receipt to a runtime receipt.",
         "Omitting the boundary identity from the artifact record."],
        ["Artifact classification table with the producing boundary per artifact.",
         "Gate-evidence rejection record naming each artifact and kind.",
         "Specification-coverage report kept separate from the gate record."],
        ["Delete " + NS + " artifact and rejection rows after export."],
        _GATE_AUTO,
        prereq=["No live adapter, provider or upstream system is reachable in this case, so every artifact here is mock or absent and "
                "no gate can be evidenced; any claim to the contrary is BLOCKED_PREREQUISITE."],
        refs=[IMPL09, IMPL08, SRS],
    ),
    case(
        "GOV-GATE-MISSING-RUNTIME", "A missing runtime is reported NOT_RUN for every gate instead of being skipped",
        GATE_SUITE, "governance", ["SRS-24", "SRS-27", "NFR-009"],
        ["stage:EXECUTION", "entity:Execution"], "baseline", "P0", "critical",
        "A gate is silently skipped rather than reported NOT_RUN, so the roadmap shows progress that no evidence supports and the missing runtime is discovered after a pilot date has been committed.",
        [GOV_FX, ENV_EXAMPLE],
        _GATE_PRE + ["gate_evidence_state.runtime_available is false, so none of the six gates can produce a runtime artifact.",
                    "The run is required to emit one status row per gate, and a skipped gate must be visible as NOT_RUN with its missing artifacts."],
        {"gates": ["P0", "P1", "P2", "P3", "P4", "P5"],
         "runtime_available": False,
         "expected_status_per_gate": {"P0": "NOT_RUN", "P1": "NOT_RUN", "P2": "NOT_RUN",
                                      "P3": "NOT_RUN", "P4": "NOT_RUN", "P5": "NOT_RUN"},
         "silent_skip_allowed": False, "pass_allowed": False},
        [("Evaluate all six gates with runtime artifacts absent from the registry",
          "Every gate produces a status row; each is NOT_RUN and names the runtime artifacts it lacks."),
         ("Check that no gate is missing from the report",
          "Six rows exist, one per gate; a gate that cannot be evaluated is still reported rather than omitted."),
         ("Attempt to mark an unevaluated gate as passed by omission",
          "The attempt is refused and the report explicitly states that absent evidence is not a pass; the roadmap figure counts zero passed gates."),
         ("Attempt to run the gates against the mock environment to produce a status",
          "The mock environment produces specification coverage only; the gate statuses stay NOT_RUN because no required runtime artifact exists.")],
        ["All six gates appear in the run report with the status NOT_RUN and the list of missing runtime artifacts.",
         "No gate is silently skipped, and no unevaluated gate is counted as passed in any summary or roadmap figure.",
         "Mock-environment results are recorded as specification coverage and do not change a gate status.",
         "The missing runtime is named once per gate with the owning role, so the blocker is actionable rather than a generic failure."],
        ["Omitting a gate from the report because it could not be evaluated.",
         "Counting an unevaluated gate as passed by default.",
         "Substituting a mock environment result for a runtime gate status."],
        ["Run-report rows for all six gates with the NOT_RUN status and the missing artifacts.",
         "Roadmap summary showing zero gates passed.",
         "Specification-coverage report kept separate from the gate record."],
        ["Delete " + NS + " gate-report rows after export."],
        _GATE_AUTO,
        prereq=["The evidence registry marks runtime artifacts absent, so all six gates are NOT_RUN; a PASS for any gate here would be a reporting "
                "defect and is BLOCKED_PREREQUISITE."],
        refs=[IMPL09, SRS],
    ),
)


# --- governance/dod.md — Definition of Done, ten pillars (SRS 27) -----------
_DOD_META = {
    1: (("SRS-14", "SRS-27", "FR-C360-001"), ("stage:CONTEXT",), "P0"),
    2: (("SRS-27", "AUTH-1", "SRS-11"), ("entity:Agent",), "P0"),
    3: (("SRS-27", "SRS-11"), ("entity:Skill",), "P0"),
    4: (("SRS-27", "API-001", "API-003"), ("entity:Action",), "P0"),
    5: (("SRS-27", "BR-008", "NFR-001", "AUTH-3"), ("stage:DECISION",), "P0"),
    6: (("SRS-27", "AUTH-4", "SCR-003"), ("entity:Approval", "stage:APPROVAL"), "P0"),
    7: (("SRS-27", "BR-005", "BR-006", "NFR-003"), ("stage:EXECUTION", "entity:Execution"), "P1"),
    8: (("SRS-27", "NFR-002", "SRS-17"), ("entity:Evidence", "stage:EVIDENCE"), "P1"),
    9: (("SRS-27", "SRS-20", "OBJ-006"), ("entity:Outcome", "stage:OUTCOME"), "P2"),
    10: (("SRS-27", "TC-E2E-001", "TC-E2E-009"), ("stage:LEARNING",), "P0"),
}


def _dod_case(pillar: dict) -> dict:
    """One Definition of Done pillar: real artifact required, missing runtime is NOT_RUN."""
    pid = pillar["id"]
    reqs, facets, gate = _DOD_META[pid]
    runtime = pillar["kind"] == "runtime"
    status = "NOT_RUN" if runtime else "DESIGN_ONLY"
    evidence_kind = GOVERNANCE_FIXTURE["dod_state"]["evidence_kind_by_pillar"][str(pid)]
    risk = (pillar["dod_item"] + " is declared done although no real execution, receipt, empirical metric or CI run ever produced "
            "evidence, so the programme advances on paper and the gap appears only when a pilot depends on it."
            if runtime else
            pillar["dod_item"] + " is declared done because a written contract exists for it, so the distance between a design document "
            "and a working capability stays invisible to every decision made on the DoD.")
    return case(
        "GOV-DOD-" + str(pid).zfill(2),
        "DoD pillar " + str(pid) + " " + pillar["name"] + ": " + pillar["dod_item"] + " needs the real artifact, not a document",
        DOD_SUITE, "governance", list(reqs), list(facets),
        "baseline", gate, "critical" if runtime else "high",
        risk,
        [GOV_FX, ENV_EXAMPLE],
        _DOD_PRE + [
            "Pillar " + str(pid) + " (" + pillar["name"] + ") is expected to be justified by the artifact '" + pillar["evidence"]
            + "', which the evidence registry holds in the form '" + evidence_kind + "'.",
            "the evidence registry has no application-runtime artifact, so a runtime pillar cannot be closed and a blueprint pillar can only reach DESIGN_ONLY.",
        ],
        {"pillar": pid, "name": pillar["name"], "dod_item": pillar["dod_item"], "kind": pillar["kind"],
         "required_evidence": pillar["evidence"], "evidence_state": evidence_kind,
         "runtime_available": False, "expected_status": status, "closable_by_mock_or_design": False},
        [("Collect the artifact that would justify pillar " + str(pid) + " (" + pillar["dod_item"] + ")",
          "The artifact '" + pillar["evidence"] + "' is registered with its kind '" + evidence_kind + "', and no real-form artifact of that name exists."),
         ("Attempt to close the pillar from the artifact as it stands",
          "The pillar is reported " + status + "; a design artifact cannot close a runtime pillar and a missing artifact cannot close any pillar."),
         ("Attempt to close the pillar from mock coverage or from another pillar's artifact",
          "Both attempts are refused: mock coverage is specification coverage, and a neighbouring pillar's artifact is not evidence for this pillar."),
         ("Request the missing artifact through the owning role and re-read the DoD summary",
          "The gap is recorded against the owning role with the artifact name, and the summary lists pillar " + str(pid) + " exactly once with the status " + status + " and no PASS.")],
        ["Pillar " + str(pid) + " is reported with its own status " + status + ": a missing runtime yields NOT_RUN and a design artifact yields "
         "DESIGN_ONLY, never PASS.",
         pillar["dod_item"] + " is satisfied only by the artifact '" + pillar["evidence"] + "' in its real form; the current form '" + evidence_kind
         + "' is recorded as a gap rather than as completion.",
         "Mock or substituted-boundary output and a neighbouring pillar's artifact are both rejected as evidence for this pillar.",
         "The DoD summary lists each pillar exactly once with a status and the artifact that justifies it, so no pillar inherits another pillar's status."],
        ["Declaring the pillar done because a specification or a document exists.",
         "Reusing another pillar's evidence to close this one.",
         "Editing a status without the artifact that justifies it."],
        ["Pillar evidence-registry row with the artifact name, kind and status.",
         "DoD summary excerpt listing this pillar once with its status and the owning role."],
        ["Delete " + NS + " DoD report rows after export; the registry fixture and the design documents are unchanged."],
        _GATE_AUTO,
        prereq=["The required runtime artifact is absent from the evidence registry, so pillar " + str(pid) + " cannot be evidenced here; its status is " + status
                + " and any completion claim is BLOCKED_PREREQUISITE."],
        refs=[IMPL09, SRS],
    )


_add(*[_dod_case(pillar) for pillar in GOVERNANCE_FIXTURE["dod_pillars"]])

_add(
    case(
        "GOV-DOD-COMPLETENESS", "DoD completeness: ten pillars, and a capability is done only when all ten hold",
        DOD_SUITE, "governance", ["SRS-27", "OBJ-006"],
        ["stage:LEARNING", "entity:Outcome"], "blueprint", "P0", "high",
        "A pillar is quietly dropped until the Definition of Done collapses into 'the agent can chat', so the system is declared complete without real execution, real evidence or a real outcome.",
        [GOV_FX],
        _DOD_PRE + ["The DoD registry lists ten pillars across the two kinds (six blueprint, four runtime), and no pillar may be removed, merged or re-kinded inside the run.",
                    "The completion rule is that a capability needs all ten, so a single unmet pillar keeps the capability open."],
        {"expected_pillar_count": 10,
         "dod_items": [pillar["dod_item"] for pillar in GOVERNANCE_FIXTURE["dod_pillars"]],
         "blueprint_pillars": GOVERNANCE_FIXTURE["dod_state"]["blueprint_pillars"],
         "runtime_pillars": GOVERNANCE_FIXTURE["dod_state"]["runtime_pillars"],
         "expected_status_by_kind": {"blueprint": "DESIGN_ONLY", "runtime": "NOT_RUN"},
         "capability_done_requires_all_ten": True, "runtime_available": False},
        [("Enumerate the ten DoD pillars and their kinds",
          "Ten pillars are listed with their items (data, agent, skill, tool, policy, approval, execution, evidence, outcome, test) and their kinds; none is missing or duplicated."),
         ("Evaluate each pillar against its artifact",
          "The six blueprint pillars reach DESIGN_ONLY and the four runtime pillars are NOT_RUN, and no pillar is reported PASS."),
         ("Determine whether any capability is done",
          "No capability is done while a runtime pillar is unmet, and the report names the unmet pillars rather than returning a single boolean without reasons."),
         ("Attempt to drop or merge a pillar so the DoD reads complete",
          "The attempt is refused: the pillar count stays 10 and the completion rule still requires every pillar, so the DoD cannot be shortened by the run.")],
        ["All ten DoD pillars are enumerated exactly once with their item and kind, and the blueprint/runtime split is 6/4.",
         "No pillar is reported PASS in this repository: blueprint pillars are DESIGN_ONLY and runtime pillars are NOT_RUN.",
         "A capability is done only when all ten pillars hold; a single unmet pillar keeps it open and the unmet pillars are named.",
         "The pillar count and the completion rule cannot be changed by a run, a fixture edit or a summary author, so the DoD cannot be shortened into a passing state."],
        ["Removing or merging a pillar so the DoD reads complete.",
         "Declaring a capability done while a runtime pillar is unmet.",
         "Reporting the DoD as a single boolean without naming the unmet pillars."],
        ["DoD summary listing the ten pillars with their item, kind and status.",
         "Completion evaluation naming the unmet runtime pillars and the blocked capability."],
        ["Delete " + NS + " DoD report rows after export."],
        _GATE_AUTO,
        prereq=["The required runtime artifacts are absent from the evidence registry, so the four runtime pillars cannot be satisfied and no capability can be declared done; "
                "completion is BLOCKED_PREREQUISITE."],
        refs=[IMPL09, SRS],
    ),
)
