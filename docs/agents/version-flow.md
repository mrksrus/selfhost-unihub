# Road to 1.0: versions, decisions and testing

Part of the [agent guide](../../AGENTS.md). Read it when you start, decide, build, release or finish a version, or record a test result.


[docs/ROADMAP.md](../ROADMAP.md) is the public plan up to 1.0: what 1.0 contains, the versions with their themes, the foundations F1 to F15, the scope rules and the parking lot. Contributors and clones without the private files follow it.

The maintainer's private plan holds the details. It lives in `.private/road-to-1.0/` of the canonical checkout: the `projectRoot` reported by the project-preferences `locate` helper. Git and Docker ignore `.private/`. Worktrees read and write those canonical files, never copies. Keep their contents (decisions, test results, devices, known-bug details) out of commits, issues, PRs and public documents. The only public reflection is docs/ROADMAP.md, a summary without dates, which changes when a version's theme, main contents or the parking lot change.

| File | Holds |
| --- | --- |
| `ROAD-TO-1.0.md` | Scope rules, version status, each version's goal, scope, foundations and tests, known bugs, parking lot, change log |
| `DECISIONS.md` | Open questions with a recommendation, when each is needed, and the maintainer's answers |
| `ARCHITECTURE-AND-SECURITY.md` | Foundations F1 to F15 and the reasoning behind [Building toward 1.0](building-toward-1.0.md) |
| `TEST-TRACKER.md` | The maintainer's results on real phones, the live server, several people and real providers, and the session log |

**Scope.** Work only on what the current version lists, or on a bug in what already exists. Bug fixes ship in patch releases, never together with features. Any other idea, including an agent's own, goes to the parking lot as a proposal. Only the maintainer swaps something into a version, and the swap is dated in the roadmap's change log.

**A version runs in five steps.** One thread owns a version's steps and its updates to these files; another thread proposes its updates instead of editing them.

1. **Start.** When the maintainer asks for the roadmap or the next version:
   - read all four files
   - take the next version from the status table
   - summarise its goal, scope and foundations, the decisions due, and tracker rows still ❌ or ⚠️ from earlier versions
   - resolve the branch (`feat/0.N.0-<theme>` from `main`) and its starting commit
2. **Decide.** Ask the decisions due for this version in one round, recommendation first.
   - Record the answers in `DECISIONS.md` and in the roadmap's version text and change log.
   - If an answer changes a version's main contents or the parking lot, update docs/ROADMAP.md in the version's PR.
   - Durable product or design choices also go into PROJECT-PREFERENCES.md.
   - The version's list is then closed, and its status becomes "in development".
3. **Build.** Implement against the version text and [Building toward 1.0](building-toward-1.0.md), with focused checks, independent review and the release contract.
   - Prove the version end to end with the e2e suite (PROJECT-PREFERENCES P-28): every row an agent can reproduce locally gets a test, and the agent records its result with the test path.
   - Add tracker rows only for what no agent can reach (P real phone, S live server, X real provider, U real people), marked *must* where they gate the release, and give the maintainer that short list.
   - An agent fills in a row only for a check it ran itself, and says so in the note.
4. **Test and fix.** After the release, or on a candidate image the maintainer installs, the status becomes "testing".
   - Every result the maintainer reports goes into the tracker in the same session.
   - A ❌ becomes a "Problems found" entry and a fix on the patch release's branch `fix/0.N.x-<topic>` (one branch per patch release, one commit per fix), released as a patch.
5. **Finish.** When every *must* row is ✅ or deferred in writing by the maintainer:
   - the status becomes "done"
   - the change log gets an entry
   - the next version starts at step 1

**Before a thread ends,** or when the maintainer says they are done:

- record every result and problem reported in the chat in the tracker, with version and device
- add a session-log line
- update the version status and the change log
- state the next step

Test results never live only in a chat.
