# Evaluation and Discovery: assumptions

Decisions the frames and brief left open. Each one can be changed without touching the data contract unless noted.

## Scan and freeze

- **Scan corpus.** The scan compares a prompt only with documents the owner may read: other tasks in reach, every published report, and the records of datasets they can read. Scanning other workspaces' private content would let anyone test guesses about it by reading the findings, so "no match" is scoped and the page says what was compared. The base44 prototype scoped its corpus the same way.
- **A task's own source pack is excluded** from phrase matching, because a prompt is expected to overlap with its own sources.
- **Near-duplicate phrase.** A shared run of 3 to 12 tokens with at least 2 non-stopwords. It is low risk: BIO-043's real scan reports "off-target effects", which it shares with DS-BIO-08. 13 tokens or more goes to 13-gram coverage, which is high risk, as is an exact match. Neither blocks a freeze; the owner acknowledges what was found.
- **13-gram coverage is its own line.** The frame shows four findings; the brief names this as a separate check, so live scans show five. A prompt under 13 words reads "Not checkable" rather than clean. SCAN-041 and SCAN-042 were seeded with four findings and still show four.
- **Acknowledgement wording** is built from what the scan found, using the frame's sentences where they apply: a sentence about terminology only when a phrase matched, a sentence about synthetic records only when the pack is synthetic. "Training exposure cannot be ruled out." is always there.
- **Scan codes.** `SCAN-043` shares its task's number. Rescanning replaces the open preview under the same code. A later version gets `SCAN-042-2`. Task numbers repeat across domains, so a clash takes the prefix: `SCAN-CHEM-043`.
- **Citations without records.** A prompt citing an ID such as E09 that the attached pack lacks gets a warning on the freeze page, not a refusal. IDs like E10 also occur in ordinary text, and a false positive must not stop a freeze.

## Drafts

- **Draft saves are lenient.** A half-typed draft always saves; completeness is enforced at "Review & freeze" and again at freeze. Only creating the row needs a title and a domain, because the domain picks the code.
- **Autosave** fires 1 second after the last edit and saves in order. A new form allocates its code on the first save; the address changes to `/tasks/:code/edit` without a remount, so focus is not lost. A starter form does not save until it is edited, so visiting the page does not use up a task code.
- **Changing domain** on a never-frozen draft takes a new code from the new prefix (BIO-044 to CHEM-001) and drops its preview. Once a version exists the domain is fixed, because review credentials depend on it.
- **Run settings** are shown, not editable, as in the frame.
- **`short_title` and `featured_note`** are new `tasks` columns, so BIO-042 can read "Antibiotic resistance mechanism" and carry the frame's Featured copy. Editing a title clears `short_title`. A task with no authored note gets a Featured sentence built from its rubric and source count.

## Access

- **Shared tasks stay readable during a revision.** `canReadTask` admits shared readers only to frozen tasks, so its access row reports frozen when a frozen version exists. Those readers see only the frozen version: the draft is withheld from the page, search and filters.
- **Sharing a task does not open its private source pack.** Evidence still shows the pack's label and hash, and says the records are private. Members, reviewers and anyone who can read the dataset see them. The frame's note, "cannot download private source files by default", is about AI clients; applying it to people is the conservative reading, because the pack may belong to another member.
- **Shared task heading.** The frame only has "Private by design." A shared task reads "Shared for inspection." with its access statement changed to match.
- **Owner-only checks missing from `permissions.ts`** (edit, freeze, change visibility, stop a run, request a review) live in the route files with the same shape and their own reasons, since that file belongs to another slice.
- **Reviewer annotations** show once a review is `submitted` or `finalized`, as briefed. A review that was returned shows the honest empty state.
- **One review covers a frozen version.** That is how `POST /api/reviews` works, so a later run of a reviewed version shows that review ("Expert review finalized on RUN-1042") and "Request expert review" is disabled with the route's own reason.

## Runs

- **Log lines.** One per commit, with the frame's wording, plus "Rubric scoring started" when a score stage begins and "CP-00n committed" at each whole model. The frames' running and interrupted samples show Meridian mid-score at 6 / 9, which the stage order cannot produce; real progress lines are used, so the same wording appears at 4 / 9. A log line that said an artifact's hash was verified is reworded once that artifact fails verification, so nothing on the page still claims it.
- **`failed` state.** The frames have no design for it. A provider refusal or a rejected key cannot be fixed by retrying, so such a run shows what is preserved and points back to the task. Temporary provider errors use the `provider_timeout` reason with "Provider unavailable at …" copy, because resume is the right remedy and the schema has no other reason.
- **Queued runs at boot** wait for the worker. Only `running` and `stopping` runs are marked `server_restart`.
- **One active run per task.** A second is refused with the code of the first. An interrupted run does not block a new one.
- **Up to four runs execute at once;** others stay queued, which is the frame's "Waiting for worker".
- **Resume after a model is disabled** still finishes: disabling prevents new selection, and the run's revisions are already pinned. A missing Anthropic key does block it, with that reason.
- **Consequential difference.** Authored on RUN-1042 through a new `runs` column. Live runs generate it from the scores: the highest and lowest totals, the widest criterion gap and the lower model's rationale. A re-run of the starter's authored outputs uses the authored sentence, since it describes those exact outputs.

## Demo adapter

- **Authored outputs** come back when the prompt equals the starter prompt. Authored scores also need the starter rubric and records E01 to E03. Without them the text is scored normally, so citations of records that do not exist lose points. `server/engine/demoStory.ts` mirrors the seed; a test fails if they drift.
- **The starter in a new workspace** has no E01 to E03. The editor offers "Add the authored source pack", which sends the authored CSV through the normal upload validation and attaches the new dataset.
- **The scorer** starts each criterion at full points and states each deduction with its size, placing a criterion by keywords in its name, then its guidance. A criterion it cannot place gets an even mix of the four signals. It is a demo heuristic and is labelled `demo` everywhere.

## Anthropic adapter

- **Settings reported honestly.** `claude-opus-5-5` rejects `temperature` and the Messages API has no `seed`, so neither is sent. Sealed evidence records the pinned values under `pinnedSettings`, what was sent under `appliedSettings`, and plain sentences under `settingsNotes`, shown in the editor, results and evidence pages.
- **No refusal fallback.** Anthropic's guidance suggests `fallbacks` by default on this model. It is deliberately off, for the run and for the judge: a fallback answers with a different model, and evidence must come from the pinned revision. A refusal fails the run and says so.
- **Effort and limits.** The model call uses `effort: medium` and `max_tokens` from the pin (8000), which also covers thinking. A cut-off answer is sealed with `truncated: true`; no answer at all fails. The judge uses `effort: high` and 16000 tokens.
- **Judge.** Structured output through `messages.parse`. It sees the answer as untrusted evidence and is not told the model's identity. A score outside the rubric publishes nothing and interrupts the run so it can resume. The judge model is Claude Opus 5.5, as nothing named another.
- **Registry rows.** With a key set, Claude Opus 5.5, Sonnet 5.5 and Haiku 5.5 are registered, since an evaluation compares 2 to 4 models. `context_k` is 1000 and `output_k` is 128, from Anthropic's model table. The cutoff is left "Unknown / Not claimed", as an administrator can state it through the registry. The judge is always Claude Opus 5.5.
