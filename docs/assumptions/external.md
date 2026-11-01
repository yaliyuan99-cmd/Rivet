# External access, Audit Advisor and Administration: assumptions

Where the frames or the brief left something open, this is what was decided and why. Everything else follows `docs/BUILDING.md` and the frame dumps.

## External access (OAuth)

- **Resource parameter.** `resource=task:BIO-042`, or the bare code. It names one task. The boundary is pinned to the task's newest frozen version when the request is created, and the consent page shows that version.
- **The `Access token` row on the approved receipt.** The frame says `Issued / Expires 15:45 UTC` the moment Maya approves. In a real authorization code flow the token does not exist until the client exchanges the code, so saying "Issued" would be false. Before the exchange the row reads `Not issued yet / Atlas receives it when it exchanges the one-time code`. After it, the row is the frame's: `Issued / Expires 15:45 UTC`, from the real token. The receipt refreshes itself while it waits.
- **Return to Atlas mints a fresh code.** Only the hash of a code is stored, so a reloaded receipt cannot recover one. Approve issues a code (and returns it, for API clients), and `POST /api/oauth/requests/:code/return` replaces it with a new one each time the button is used, so someone slow to read the receipt is never stranded with a dead code.
  - Codes live 5 minutes. A new one can be minted for 10 minutes after approval. Past that the approval has lapsed and the receipt says so.
  - Once the client has a token, the button is disabled with the reason, because there is nothing left to send.
- **A wrong verifier does not burn the code.** Someone holding a stolen code cannot guess a 43-character verifier, and burning would let them lock out the real client. A replayed code does revoke everything it issued (RFC 6749 section 4.1.2).
- **Errors that go back to the client.** A bad scope, state, challenge or resource shows an error page offering "Return to the client", which carries the RFC error. An unknown client or a wrong redirect shows an error page with no way onward, as the brief requires. Neither redirects by itself.
- **Reloads and repeats.** The same client, user, state and challenge always find the same request. A fresh attempt needs a new state and challenge, as the expired frame says.
- **The demo client's redirect follows the public URL.** The same data folder served from another address (dev on 5173, production on 8787) would otherwise break the demo. Every other client is held to exactly what it registered.
- **Expiry redirect.** "Return to Atlas" from an expired request sends `error=access_denied` with the state and an `error_description` saying the link expired. RFC 6749 has no closer code.
- **Denied, while an earlier connection is live.** The frame's "Not connected" and "Atlas cannot access..." would be false then, so those two lines change to say the earlier connection stays until it expires or is revoked.
- **Extra states on the approved page, not in the frames.** `Connection revoked` and `Connection not completed`, using the same layout, so the receipt stays true after it is first shown.
- **No seeded connection.** The first live request has to be `OAUTH-042`, so nothing is seeded before it, and Profile lists no authorized client until someone runs the flow. The frame's connection on Profile appears once they do.
- **External reads are audited.** Every bearer read, refusal and Advisor query adds an `oauth.api_*` row. They are left out of Operational events, which would otherwise fill with them.
- **External Advisor questions do not join the user's thread.** A client asking on someone's behalf should not write into their conversation. The audit log has them.
- **The demo client shares an origin with Rivet,** so its verifier sits in the same browser's `sessionStorage` and its token in page memory. It stands in for an external client and the page says so. It uses only `/oauth/token` and `/api/external/*`, with cookies left out of each request.
- **No CORS headers.** A real client on another origin calls these endpoints from its server. Browser-based external clients would need an allow-list, which has not been built.
- **Scope text** uses the real report code when the version has a report, and "the frozen report" when it does not.
- **Finding the demo.** No frame links to `/atlas-demo`, so nothing in the app does. It is reached by its URL, as an external client's own site would be.

## Audit Advisor

- **Retrieval.** BM25 (k1 1.2, b 0.75) with light stemming over each authorized record. Evidence outputs rank below rationales, dataset records, the review and the report, because a model output is a claim being audited. Answers quote the records and always say who said it, so a model's claim never reads as Advisor's own.
- **What counts as authorized.** All read on the request:
  - Evidence and rubric rationales, from one run (the report's run, else the newest with evidence), if the user can read the task. A seal that fails is quarantined, left out, and shown with `HashMismatch`.
  - Dataset records, only if `canReadDataset` passes for that user. An expert or administrator outside the workspace sees `Withheld` in the rail and gets no dataset records.
  - The review, with the same rule the review page applies: the expert always, any task reader once finalized, the owner's side and administrators while it is submitted.
  - The report's limitations, if the report still matches its hash.
- **Long dataset fields** (over 240 characters, such as the DS-BIO-07 plate readout) are neither searched nor quoted. They are data, not words.
- **When it refuses.** These are deliberate heuristics, not a language model.
  - A term the records do not contain, unless it is a generic word of the kind any question uses.
  - A yes/no question that claims cause or proof, or a "what caused..." question, unless it points at the records (a source ID, a model, "the result") and a record states the limit. Then it answers from that record, leading with `No.` as the frame does (or "The authorized records do not establish that." when the question is not a yes/no one). Otherwise: `The authorized evidence does not include causal controls. I cannot establish that claim.`
  - Clinical questions, always.
  - Generalizations, unless a record says they cannot be generalized.
  - An instruction to change a record gets "Audit Advisor is read-only".
- **Seeded answer.** It is the frame's text, word for word, and the page labels it `Seeded demo answer / Authored for this synthetic story`. Asking the same question live gives a similar but extractive answer.
- **LLM mode.** With `ANTHROPIC_API_KEY` set, the model (`claude-opus-5-5`) gets the top 8 retrieved records and the question, nothing else, and has no tools. Its citations are checked against those records and renumbered. The deterministic refusals stay in front, so a question retrieval refuses never reaches the model.
  - An invalid citation, a refusal or an API failure falls back to the retrieval answer, and the page says why.
  - Server-side refusal fallbacks are on (`fallbacks: "default"`), as recommended for this model.
  - It has been tested against a mock only. No real key was used.
- **Task selector** is an addition to the frame. It lists frozen versions, so a thread on v1.0 stays reachable after v1.1 is frozen.

## Administration

- **`/admin` has no frame.** It uses the same patterns: the header, `AdminTabs`, an alert from the latest check, and queue counts read on each visit. `AdminTabs` sits under the page header on every page here. The locked state uses the words in the navigation note, "Administration locked / Admin role required".
- **Models.** The frame's rationale text is a placeholder, because a pre-filled required field would mean nothing. One earlier revision is seeded with that wording so the history is not empty. The history is added below the frame's actions.
  - Editing the display name does not rename frozen versions or evidence. They keep what they pinned.
- **Check receipts are real.** The frame's note said receipts are synthetic fixtures. It now reads: "Check receipts are computed for real over the synthetic fixtures on this instance. They do not describe a live production service."
  - The numbers are whatever is true, so they differ from the frame's samples (72 of 72, 4.2%).
  - The seeded receipts are computed for real during seeding, over everything every slice has seeded, stamped 14:42 UTC on 15 Oct 2026 to match the story.
- **What each check does.**
  - *Artifact hashes* covers evidence seals, report hashes (and that the report's columns still match its manifest), trace hashes, frozen task version hashes, and a re-hash of stored dataset bytes.
  - *Immutability* really attempts UPDATE and DELETE on all ten tables inside a transaction that always rolls back. A table with no rows gets a probe row first, with foreign keys deferred.
  - *Private access* uses fresh probe users (non-member, removed member, active member, administrator, credentialed expert) against every real task and dataset plus fixtures, inside the same kind of rollback. It also fails if a private dataset is pinned into another workspace's task.
  - *OAuth state & PKCE* runs the real verification functions, a live code through the real exchange in a rollback, and rules about what is stored (only hashes, only from approved requests).
  - *Provider timeouts* is timeouts over provider calls. Calls are stages that ran, plus one for each timeout, because a timed-out call leaves no finished stage. Exactly 3% does not warn.
  - *Domain enforcement* runs four fixture cases per domain through `canReviewTask`, plus one for each review on file. A credential revoked after a review was submitted does not count against that review.
- **Integrity failures block runs.** The rail says so, so it is enforced. Triggers at the end of `60-advisor-admin.sql` refuse to insert a run or resume one while the newest check run has a failed Artifact hashes or Immutability receipt. A later passing run lifts the block.
  - Starting or resuming a run shows the failed receipt as the reason, through `integrityBlockReason()`.
- **Operational events** come from run logs (timeouts, unavailable providers, restarts) and an allow-list of audit actions: dataset hash results and deletions, credential decisions, adjudications, model edits, failed runs, replayed codes, release approvals. The two audit rows behind the frame's events are seeded, and the dataset one is only written if the bytes really match.
- **The export** is JSON: every check run and up to 200 events.
- **Cost of a run.** The checks hold the database's single write transaction while they run. That is fine at this scale, but would need batching on a large instance.

## Differences from the frames not fixed here

- The frames show Alex Rivera inside Helix Lab. The seed gives him no workspace, because membership would widen what he can read, so the navigation reads "Rivet administration / No workspace" on his pages.
