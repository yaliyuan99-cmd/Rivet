# Assumptions and open items

Where the Figma prototype was silent, a reasonable choice was made and written down. This page has what most needs your attention. Each area's full list is in `docs/assumptions/`: [workspace](assumptions/workspace.md), [evaluation](assumptions/evaluation.md), [expert and published](assumptions/expert.md), [datasets and assurance](assumptions/datasets.md), [external, advisor and admin](assumptions/external.md).

## Blocked on you

| Item | What happens today | What is needed |
|---|---|---|
| Figma link | The brief's `[FIGMA LINK]` was blank, so `Untitled` in the Rivet team folder was used as the spec | Confirm it is the right file |
| Terms of Service and Privacy Policy | `/legal/terms` and `/legal/privacy` say the text has not been supplied. No legal text was invented | The real text |
| AI provider key | Runs use the labelled synthetic adapter. Claude models appear only with a key. The Anthropic adapter, judge and Advisor LLM mode have only run against a mock | `ANTHROPIC_API_KEY` |
| Email provider | Messages go to `/dev/outbox`. Pages say so instead of claiming email was sent | `RESEND_API_KEY` and a sending domain |
| GitHub, LinkedIn, Hugging Face | Buttons stay disabled with the reason. The flows have only run against a mock provider | OAuth app credentials (callbacks are in `assumptions/workspace.md`) |
| Hosting and production database | Runs on SQLite and a local folder. Nothing is deployed | A host, and a decision on storage if the host has no disk |
| Base44 data | Not migrated: the plan blocks export and functions | Only if there is real data worth moving |

## Decisions to confirm

**Product**

- **Reports are readable by any verified account;** private sources and outputs stay permission-checked.
- **A task's owner keeps access** to their own tasks after being removed from the workspace, as `server/lib/permissions.ts` reads the frames' "task owner" rules.
- **Sharing a task does not open its private source pack.** Readers see the pack's label and hash, not its records.
- **Sensitive-data flags block a dataset upload with no override,** so a false positive means editing the file.
- **Owners see a person's name and credentials when they type that person's exact, verified email** while inviting, because the members frame shows this. It is rate limited, but it is a limited lookup.

**Honesty over matching the sample text**

- **"24 sealed run receipts →" reads "1 sealed run receipt · 23 authored fixtures →".** Only BIO-042 has a sealed run; the rest are authored fixtures.
- **"Intervals overlap … do not establish a statistically decisive ordering" is kept but is loose.** It holds for the per-model intervals. Read as paired differences, Aster − Lumen gives [4.6, 14.7], which excludes zero. The methodology page says overlap is not a significance test. Consider rewording it in Figma.
- **The system-check note** now says receipts are computed for real over synthetic fixtures, since the checks are real. Counts are real too (for example 13 of 13 rather than 72 of 72), and the timeout rate is measured.
- **An approved connection's token** reads "Not issued yet" until the client exchanges its code.
- **Mid-run text:** the frames show Meridian mid-score at 6 / 9, which the real stage order (output, score, seal per model) cannot produce. The same wording appears at 4 / 9.
- **Hashes are real,** so they differ from the frames' sample values.

**Design**

- **Design annotations are dropped or made real:** "/ DESKTOP" and "/ MOBILE" go; "/ LIGHT" is a working theme toggle; the default theme is dark, per "Dark-first".
- **Light-theme alert text is slightly darker** than the sheet: `#126550` and `#984342` on their surfaces. The sheet's own accent and danger reach only 4.4:1 there, under its 4.5:1 target.
- **Field editing replaces some static text in the frames.** The rubric reads as the frame's text until "Edit" opens a criterion. The password field shows strength inside the box.

## Screens the prototype implied but did not draw

Built with the same patterns: sign in, forgot and reset password, returning-user Home, reports index, review queue, agent assurance index, administration index and queues, leaderboard methodology, access policy dialog, invitation acceptance, legal pages, the Atlas demo client and the dev outbox.
