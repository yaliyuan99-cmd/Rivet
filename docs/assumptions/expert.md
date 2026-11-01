# Expert review and Published evidence: assumptions and deviations

Where the frames or the brief left something open, this is what the slice does and why. Everything here is a choice someone can reverse.

## Things worth a decision

- **"Do not establish a statistically decisive ordering" is true of the per-model intervals only.** All three seeded intervals overlap, so the page says so, as the frame does. But the same paired resamples, read as paired differences, give Aster − Lumen [4.6, 14.7], which excludes zero (Aster − Meridian [-1.2, 9.5] and Meridian − Lumen [-1.2, 11.7] do not). No authored sample with these headline numbers can avoid this without strongly negative correlation between models. The leaderboard keeps the frame's sentence because the brief asks for it when the intervals overlap, and the methodology page states that overlap is "a cautious reading of per-model intervals, not a pairwise significance test". If this ever carries real data, consider reporting paired differences.
- **"24 sealed run receipts →" is not true, so it does not say that.** Fixtures are not sealed runs. The link reads "1 sealed run receipt · 23 authored fixtures →", computed from the sample, and the alert keeps "24 authored task fixtures". BIO-042 v1.0 is both: an authored fixture (`is_fixture = 1`) that also has a real report and sealed evidence behind it. A sealed receipt means "has a report behind it"; "authored fixture" in the link means "has nothing behind it". The 23 fixtures are labelled `BIO-F01`–`BIO-F23` so they cannot be mistaken for real tasks.

## Applications

- **A draft has no real code.** `applications.code` is `NOT NULL`, so a draft holds a placeholder (`DRAFT-1a2b3c4d`) and takes the next `APP-n` at submission. A resubmission keeps its code. The status line reads "Reviewer application / New" or "/ Draft" until then.
- **One draft per person.** A second create continues the existing draft. A draft counts as open for the one-per-domain rule, enforced by a partial unique index as well as in code.
- **Files:** PDF, PNG, JPEG or WebP, up to 10 MB, 30 uploads an hour. The type comes from the file's first bytes, not the browser's claim; SVG is refused because it can carry script. Files upload as soon as they are chosen.
- **Downloads** are limited to the owner and admins, read as 404 for anyone else, and only serve credential uploads. An admin opening someone's document is audited. A file whose bytes fail their hash is refused.
- **Research profile** accepts a bare link such as `orcid.example/0000-…`, as the frame shows. It is printed as text, never rendered as a link.
- **Withdrawal** applies to an application in review. It frees the domain. The `/review/application` page shows the one waiting on you first, then one in review, then the latest decision; `?code=APP-n` opens a specific one. A withdrawn application alone sends you back to apply.
- **Domain after submission:** it cannot change while an admin has asked for more evidence. Withdraw and apply again instead.
- **`/review` with a pending application and a credential in another domain** shows the queue, with a link to the application.

## Credential decisions

- **Decline** is an added action, with a confirmation, since the frame shows none. It emails the rationale. The applicant may apply again.
- **Verify and decline also email the applicant**, not just "Request more evidence". If an email fails, the decision stands, and the admin is told exactly what failed. The status changes before the mail goes out because network calls cannot run inside a transaction.
- **Evidence rows are computed, so they do not all read like the frame.** "Domain and name match / Confirmed" means the institutional email's domain equals the verified account email's domain and the legal name equals the account name, ignoring titles. It does not prove the person controls that mailbox. "PhD certificate" became "Credential document" because Rivet cannot know what a file is. "Fixture hash verified" appears on seeded applications and "Hash verified" otherwise, each only after re-reading the bytes on that request. "Publication list / Three demo records" has no data behind it, so that row shows the research profile and background as supplied, labelled as supplied.
- **The approved domain can differ from the requested one**, because the frame makes it a select. The credential is created for the approved domain only.
- **An admin cannot decide their own application** (rule ported from the old code).
- **While waiting on an applicant,** an admin can only decline. Verifying waits for the resubmission.

## Reviews

- **The queue has no frame.** It uses the kit's rows and the frames' voice. Its copy is authored, and it lists requested reviews in credentialed domains, your drafts and your submitted reviews. It never lists requests in domains you hold no credential for: their existence is private. Direct links to those read as 404 unless the task is otherwise readable, while writes return the permission reason.
- **Claiming needs no prior read of the evidence, but allows it:** a credentialed non-owner can open a requested review and read the sealed outputs first, to check for conflicts.
- **Independence:** a draft is visible only to its expert. The owner, workspace members and admins see the text from submission on. Other readers of a shared task see it once finalized. A returned review is visible to its expert and to admins.
- **Fields beyond the frame:** a per-model "Reviewer annotation", which the evidence page's "Reviewer annotation" section reads, and "Finding", which the adjudication frame and report quote. Each model has its own tab; the tab shows how many of its fields need fixing, so nothing is hidden on a tab out of view.
- **Scores start blank** rather than prefilled from the machine score, to keep the assessment independent. The sealed score is shown as a hint. Scores are whole numbers from 0 to the criterion's points. The server rebuilds the structure from the frozen rubric, so a client cannot change a criterion's name or points.
- **Submission minimums:** 20 characters for assessment, rationale and finding; 10 for each annotation; a score and a note for every criterion on every model; the conflict attestation.
- **A credential is checked on every write.** Revoking one stops saving and submitting at once.
- **A returned review reopens at once,** with the admin's note, and saving moves it back to draft. Each submission is copied to the append-only `review_submissions` table, so reworking one cannot lose what was first submitted. That is why it is a table rather than a column: existing dev databases pick it up on boot without an `ALTER TABLE`.

## Adjudication

- **The select decides.** With "Accept expert findings" chosen, both buttons act, as in the frame. With "Return to expert" chosen, "Finalize & freeze report" is disabled with that reason, so the irreversible action cannot fire against the select.
- **Only finalizing needs the checks box.** A review may be returned because those checks failed.
- **An admin cannot decide a review they wrote or a task they own** (ported from the old code; the frame's "reviewer eligibility" check).
- **`ADJ-n` is assigned at the first decision** and repeats if the review is decided again, per the schema. Before that, the page previews the next free number, as the frame shows one before any decision. If another review is decided first, the real number is the next one along.
- **Final score = the expert's recommended total.** Sealed evidence never changes. If the two differ, the adjudication and report show "Sealed 75" next to the score, and the report's scores JSON records `sealedScore`. The label stays the evidence's (`demo` or `judge`).
- **Live report text is generated, with no model involved:**
  - **Headline:** the first sentence of the expert's finding, cut at a word near 140 characters.
  - **Summary:** the score ordering, ties stated, then the finding quoted whole, then "These findings do not establish real model capability." (or, for a non-synthetic report, "One task does not establish general model capability.").
  - **Limitations:** always "n = 1 task. No population confidence interval.", then the synthetic labels if they apply, then the scan's risk and matched phrases, then the first acknowledgement quoted, then "Model training exposure remains unknown." A version without a scan says so.
- **A report's manifest also records each evidence hash** (`evidenceSha256`), which the seeded BIO-042 manifest does not, so a live report's hash chains to its evidence. A report is synthetic when the task is or any evidence is scored `demo`.

## Reports

- **Any verified account can read a finalized report**, as the brief asks. Private sources and outputs stay permission-checked: the evidence codes and review link appear as links only for people who can open them, and everyone else is told they stay private.
- **Copying** puts this on the clipboard: the citation, the versioned URL from `publicUrl`, the top evidence's hash and the report's hash. The page changes only after the clipboard call succeeds; otherwise it says nothing was copied.
- **The copied frame's "Scope and limitations" paragraph differs from the report frame's.** A frozen report cannot change its text when you copy it, so both states show the frozen text.
- **"HASH VERIFIED" requires everything to pass on that request:** the report's hash, its manifest matching the shown columns, and every evidence seal. Otherwise the page renders `<HashMismatch>`, and copying and downloading are refused.
- **The rail adds the report's own hash**, so the downloaded file can be checked against the page. The Markdown file prints the manifest as one line, byte for byte, and its hash.
- **The index has no frame.** Filters are domain and text (code, title, owner, expert), kept in the URL.

## Leaderboard

- **Missing runs:** a resample averages the tasks a model has among those drawn, and the page says how many runs are missing. Below two tasks a model gets no interval and no plot, and the page says the ordering cannot be read.
- **A task's versions count separately.** "BIO-044 v1.0" and "BIO-044 v1.1" are different frozen contracts, so each joins the sample when finalized.
- **The domain filter is in the rail, where the frame prints it,** as a real select. Its value is in the URL. The first domain (Biology) is the default.
- **"Open BIO-042 evidence"** opens the evidence when the viewer may read it, otherwise the report. "Included task" is the newest report in the sample, so it moves when a new task is finalized.
- **The plot's axis is the frame's 60–100,** widened only if a bound falls below 60.
- **The frame's spacing** in "87.4   [83.1, 91.2]   n=24" is three spaces, taken from the reference image; the dump collapses them.
- **The fixtures were tuned** by `scripts/tune-leaderboard-fixtures.ts` until the real bootstrap prints the frame's numbers. They are authored, and the page says so.

## Kit gaps, worked around locally

- No select fits the rail's plain text; `DomainFilter` is local.
- `FieldFile` cannot be cleared, so it is remounted after a failed upload to allow picking the same file again.
