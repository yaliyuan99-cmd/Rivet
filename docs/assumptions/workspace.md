# Workspace slice: assumptions and open items

Covers workspaces, invitations, profile, connected accounts, GitHub sign-in, Home and the legal pages.

## Blocked on you

1. **Legal text.** The Terms of Service and Privacy Policy have not been supplied, and none has been written. `/legal/terms` and `/legal/privacy` say so plainly, and say this instance is a demo. The sign-up checkbox still links to them. When the text arrives, decide whether existing accounts must accept it.
2. **Real OAuth apps.** No GitHub, LinkedIn or Hugging Face credentials exist yet, so all three have only run against a mock provider. Provider URLs, scopes and response fields come from public documentation. Check each one against the live provider before relying on it. To enable a provider, set the variables in `.env.example` and register these callbacks:
   - GitHub: `<RIVET_PUBLIC_URL>/api/auth/github/callback`, for sign-in and connecting a profile. A GitHub OAuth app allows one callback.
   - LinkedIn: `<RIVET_PUBLIC_URL>/api/profile/connections/linkedin/callback`, with OpenID Connect sign-in enabled on the app.
   - Hugging Face: `<RIVET_PUBLIC_URL>/api/profile/connections/huggingface/callback`, with scopes `openid profile`.

## Decisions to confirm

- **Naming people while inviting.** The members frame shows "Dr. Samira Patel" and her credential for a typed address. To do that from real data, an owner who types an exact address sees the display name and verified credentials of a verified account with that address. Any verified user can create a workspace and so become an owner, which makes this a limited lookup, capped at 60 per 10 minutes. Unverified accounts are never named. To remove the lookup, stop returning the name and credentials from `POST /api/workspaces/:id/invitations/preview`; the rows then show the address only.
- **A removed member who owns tasks.** Removal takes away workspace access, but `server/lib/permissions.ts` still lets a task owner read and run their own task. Home stops listing that workspace. Decide whether ownership should outlast membership.
- **GitHub accounts and the terms.** An account created through GitHub has `terms_accepted_at` left empty, because nobody ticked a box on that path.
- **An unverified registration of the same address.** If GitHub proves an address that an unverified account holds, that account's password is cleared and its sessions end, so whoever registered it first keeps no way in. The real owner can set a password with "Forgot password".

## Assumptions

**Screens with no frame**

- **Returning Home** is built from kit parts: "What needs attention", "Recent tasks", "Recent reports", with the frame's rail and actions. "Create task" comes from the browse frame.
- **What needs attention** also lists runs in progress, your own draft or returned reviews, and invitations waiting for your address. An invitation has no link because only its hash is stored. On first run this section appears only when it has something in it, so a pending applicant still sees their status.
- **Recent tasks** cover the active workspace. **Recent reports** also include reports you own or reviewed elsewhere.
- **First run** applies when you have no workspace, or no tasks in any workspace you belong to. Someone with tasks elsewhere who switches to an empty workspace still sees the returning page.
- **`/w/:slug`** was added because the create frame displays that URL. It opens the workspace for members and reads as not found for everyone else.
- **`/auth/github/failed`** was added as the landing page for a failed GitHub sign-in.

**Invitations and members**

- Invitations last 7 days, are limited to 30 sends an hour per person, and an expired one can be replaced by a new one.
- `/invitations/:token` sits in the access shell because an invitee may have no account yet. The link is remembered for an hour in that browser, so signing in or verifying returns to it. If storage is blocked, reopening the email link still works.
- The role select offers Member and Owner. Owners can manage members. Nobody can remove themselves or the workspace's creator, so a workspace always has an owner.
- If the invitation email cannot be delivered, the invitation is revoked and the send reports the failure.

**Copy that differs from the frames**

- The scope line says "Their verified Biology credential" rather than "Her", since Rivet holds no pronouns.
- First-run step 2 says "the starter task" rather than "BIO-042", since a new user's task gets its own code.
- With nothing typed, the scope line says "The person you invite".
- Added controls: "Create another workspace", and confirmation dialogs for Remove and Disconnect.

**Workspaces**

- Slugs are 3 to 48 lowercase letters, numbers and single hyphens.
- A code is `WS-` plus the slug's first word. If that is taken, it uses the whole slug, then a number.
- The visibility select and the privacy checkbox are one setting, so they cannot disagree. Shared reads "Any verified account can read frozen work", matching `canReadTask` and `canReadDataset`.

**Connected profiles**

- Rivet stores the provider's user id, handle and profile URL. The provider's access token is discarded after reading the profile.
- Connecting asks GitHub for `read:user` only; sign-in also asks for `user:email`. Sign-in accepts only the address GitHub marks both primary and verified.
- LinkedIn's OpenID profile has no public handle, so the name is shown instead.
- Maya's seeded connections are flagged `is_synthetic` and have no profile URL, so a demo handle cannot link to a real person.
- Expired or revoked AI client tokens are not listed.

**Testing against a mock**

Set `RIVET_OAUTH_GITHUB_BASE_URL`, `RIVET_OAUTH_LINKEDIN_BASE_URL` or `RIVET_OAUTH_HUGGINGFACE_BASE_URL` to send that provider's requests to another host. `tests/e2e/workspace.spec.ts` explains how to run its GitHub tests this way.
