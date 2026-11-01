# Assumptions: Datasets and Agent assurance

Choices made where the frames and the brief left something open. Anything here can be changed without touching frozen data.

## Datasets

**The 48 KB in the frames is real.** The frames print DS-BIO-07 as 48 KB, and every size on the page comes from the stored bytes, so the seed gives each of its three records an authored `plate_readout` column of synthetic well values. The file really is 48 KB, its hash really covers those bytes, and the column never appears on a page. It is deterministic, so the seeded hash does not change between instances.

**A file that fails validation keeps no bytes.** It may hold exactly what should not be retained, and `Storage` has no delete. The server validates in memory, then writes a `dataset_drafts` row with the receipt, `passed = 0` and no `upload_id`. `POST /api/datasets` refuses it and repeats what failed. Files that pass are stored with an `uploads` row. The upload call answers 201 either way, because the receipt is the result; the page reads `passed`.

**Receipts never hold a flagged value.** They record kind, count, row and column. A duplicate source ID that is itself sensitive is reported as "a flagged value".

**A sensitive-data flag blocks creation.** The brief says a failed validation blocks creation, and the frame's receipt treats "No flags" as the passing state, so there is no override. The cost is that a false positive means editing the file. The patterns:

- Email addresses.
- Phone numbers: `+` international with 8–15 digits, NANP grouping, trunk-prefix grouping.
- National IDs: US SSN shape, UK NINO, Canadian SIN with its Luhn check, and labelled numbers such as "Passport number X1234567".
- Medical records: labelled numbers such as "MRN: 00123456", "Patient ID 8842", "NHS number …".
- A column named like one of these (`patient_id`, `mrn`, `email`, `dob`, …) with a value in it, whatever the value looks like.

Bare runs of numbers such as `1000 2000 3000` are not flagged: lab data is full of them.

**PDFs are not scanned.** Records are not parsed and the receipt says so: "Not scanned: PDF text is not read". It never says "No flags" for a file it did not read. The rights checkbox is the only safeguard there.

**Spreadsheet row numbers.** Failures name rows with the header as row 1, whatever physical line a multi-line record starts on. Quoting problems name physical lines, because that is where a text editor will find them. JSONL failures name lines.

**Column names** match after trimming and lowercasing, and records keep the lowercased names.

**"Synthetic" is read from the file.** A version is synthetic when every record's `provenance` cell says authored, synthetic, fixture or demo. That is what drives "3 synthetic source records" and the `SYNTHETIC` status. A real upload on a demo instance is not labelled synthetic. A PDF is never labelled synthetic, because Rivet did not read it.

**"Explicit limits." appears only when the data has limits.** The heading count comes from the records. DS-BIO-07 has a `limit` column and reads as in the frame; DS-BIO-08 reads "Twelve observations." The detail page lists the first 50 records and says when there are more.

**Visibility follows the workspace default.** The frames have no per-dataset control, and `workspaces.default_visibility` says it covers "new tasks and datasets". The filter means: Private is this workspace's private entries; Shared is every shared dataset the user can read, marked "Shared by …" when it is from another workspace; All is both. The seed adds `DS-BIO-06`, a shared Northbridge dataset, so that the Shared filter has a real row and the disabled delete state can be reached. Its code is below the counter, so the next new dataset is still DS-BIO-10.

**Attachment labels.** A list row names frozen pins first ("Attached to BIO-042"). With only draft tasks it reads "Attached to BIO-043 (draft)". With nothing, "Authored demo" if synthetic, otherwise "Not attached". Outside the workspace, only tasks that are themselves shared are named, so a shared dataset cannot reveal a private task code.

**The delete page keeps the frame's four impact rows.** Draft attachments and agent traces, which the frame does not show but which are real references, are added to the rail instead.

**Deletion and attachments.** A deleted library entry stays readable and downloadable by workspace members, because "retained for authorized audit" has to mean something. People outside the workspace get a 404. Triggers in `30-datasets.sql` refuse any newly written reference to a deleted dataset from `tasks` or `task_versions`, whichever route writes it. An existing draft attachment stays in place but cannot freeze. The task routes also check this and give a friendlier message; the triggers are the backstop.

**Task attachment activity comes from triggers,** so the library feed stays complete without another slice writing to `dataset_activity`. Authored demo tasks are left out when they are inserted; otherwise the seed would add rows to the frame's three-row feed. A starter task counts as authored, so its attachment first appears in the feed when it is frozen.

**Version field.** Editable, prefilled with the next minor version, and must be higher than every existing version. The frames show v0.2 existing, so a person can choose their own number. A new version can restate provenance, so each version keeps its own statement.

**Domain select.** Added between name and version for new datasets, as the brief allows.

**The button's code is a promise.** "Create DS-BIO-10 v1.0" sends the code it shows. If someone took it first, the server answers 409 and the page refreshes the label rather than creating a different code silently.

**Identical bytes.** Refused for a new version of the same dataset, at upload and again at creation. The same bytes as a *different* dataset are allowed: that is a separate library entry with its own provenance.

**Activity times** print as the frame does ("14:20 UTC"), with the full date in the `title` attribute.

**One open upload per person and destination.** Choosing another file replaces the earlier draft, and Cancel deletes the draft row. The bytes of an abandoned valid upload stay on disk because `Storage` has no delete; they are unreferenced and content-addressed.

**Tampered bytes.** Detail pages and downloads re-hash on every request. A browser following a download link is sent to the detail page, which explains the mismatch; an API client gets a 409. Every mismatch is audited. Creation also re-checks, so a version cannot pin bytes that changed after validation.

**Scale.** A 95 MB CSV of about 690,000 rows was tested over real HTTP: upload and validation took about 5.5 s, creation about 4 s, and the detail page about 3 s. Parsing runs on the server's one thread, so other requests wait up to a few seconds during that. A worker would fix this; it is not worth the complexity on a single-instance demo.

## Agent assurance

**Index page (no frame).** Same patterns as the rest of the app. "Every release leaves a trail." is authored copy. It lists gates with their candidates, regressions and traces, and adds "Traces for expert review" for someone with a verified credential. Import is a JSON textarea with "Fill in an example", because the format is not guessable; the example imports as it stands.

**The not-yet-run gate page (no frame).** "The release gate has not run." with the same rail. This is what Maya sees on rc.19 before she clicks Run gate.

**The frame's draft regression is reached live.** REG-BIO-042 has to be active for the gate frames to be true, so its page shows the active state, with "Save rule version" as the primary action. The frame's draft state is the path from TRACE-044: Dr. Patel confirms a finding, Maya turns it into a regression, and REG-BIO-044 opens as "Confirmed finding / Ready to activate".

**Candidates.** Each trace carries its `candidate`; one gate exists per workspace and domain, created on the first import. Only Biology has a suite, so other domains store the trace with no gate.

**A run is per candidate.** `gate_runs` is unique on gate and candidate, so re-running means importing a new candidate, as the frame's "Rerun the same frozen suite as a new release candidate" says. A second run of the same candidate is refused, so nothing can overwrite or dilute an earlier failure.

**biology-gate v1 has 26 required and 4 advisory checks.** Advisory ones (sole cause, absolute language, dismissed alternatives, repeated citations) count in the 30 and show as failed, but do not block by themselves. An active regression on one of them makes it blocking under its policy. That is what "turn a finding into a safeguard" means in practice, and it is what makes the policy select real:

- *Block release on high-severity findings*: a failure blocks if the source finding is high severity.
- *Block release on any finding*: a failure always blocks.

There is deliberately no non-blocking policy, and an active regression cannot be deactivated: either would be a bypass.

**A confirmed finding stands on its own trace.** If an expert's finding maps to a check whose pattern does not catch that trace, the check still fails for that trace once its regression is active. Until then, `claim_flags_resolved` blocks it: a medium or high finding must be held by an active regression. A candidate with a confirmed high-severity finding therefore cannot pass.

**Approval re-evaluates.** A pass is a snapshot, so approving re-runs the checks on current state without writing a run. A later finding, regression or tampered byte refuses it, with the reason. A database trigger also refuses a `release_decisions` row for any run that did not pass.

**Regex rule limits.** The causal rule is a rule, not a reader. It looks for causal language per clause, skips clauses negated or hedged before the causal word, or qualified or left open, and accepts a cited record that describes a deletion, knockout, complementation, rescue or isogenic control. It will miss paraphrases. The expert finding is the backstop, which is the point of the flow.

**Who can read a trace.** Workspace members, plus a verified reviewer in the trace's domain once it is flagged or has an adjudication; that is what asks for outside review. An unflagged trace stays private. Gates and regressions are members only. An administrator has no special access: a workspace role or a credential is what grants it.

**Who can review.** `canReviewTask`'s rules, with two trace-specific reasons: "You own this trace", and "You own this workspace", since a workspace owner is not independent of a trace in their own workspace. Any number of findings can be appended.

**Codes.** Findings take `ADJ-TRACE-n` from the `adjudication:trace` counter. It is seeded one short of 44 (and `regression:BIO` likewise) so that the first live finding on TRACE-044 reads ADJ-TRACE-044 and its regression REG-BIO-044. Clarifications are not decisions, so they take `CLAR-TRACE-n`.

**Clarification email.** The clarification is recorded first, then mailed. If mail fails, the entry stands and the page says plainly that the owner was not emailed.

**Authored for the story.** TRACE-044's claim ("Reduced permeability plays no role in this phenotype."), rc.20 and Harness 0.8.20 are authored, and synthetic like everything else in the seed. TRACE-043 has one extra step, "Check causal evidence", because the frame says rc.19 "adds a causal-evidence check before drafting".

**The gate report is JSON,** as the most verifiable format: every check, the pinned regression versions, the trace hash re-verified at download, and any decision.

**All 30 checks are one click away.** The frame shows the four groups; a native `details` element under them lists every check.

## Local workarounds

Added in `datasets.css` and `assurance.css`, using kit tokens only:

- The kit has no select drawn as a secondary action, which "Private datasets ▾" needs.
- `FieldFile` cannot reset its input, so choosing the same corrected file again would not fire. The page remounts it with a `key`.
- Textareas use `field-sizing: content`, so long statements stay fully visible at phone width in browsers that support it.
