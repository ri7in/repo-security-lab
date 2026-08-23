# Publishing source locations: the one decision left

Status as of 23 August 2026. Read the correction first, it changes the question.

## A correction to what I told you

Earlier I said the risk of publishing paths was "already closed" because reports
are `noindex`, report IDs are 16 random bytes, and reports auto-delete after 30
days. All three of those are true and I verified them live.

They close the wrong threat.

Those three things stop **passive discovery**: Google indexing the reports,
someone guessing a URL, reports piling up forever. They do nothing about the
case that actually matters, which is **someone using the tool on purpose**.
Anyone can type any username. The person who runs the scan holds the link. So
an attacker types a target's username and receives a precise, ranked, deduped
map of where that target's live credentials sit. `noindex` is irrelevant to
them, because they were never searching, they were scanning.

I moved too fast when I said the risk was handled, and the option I offered you
said publishing paths "costs nothing in confidentiality." Confidentiality is not
the cost. Targeting is. You picked option 3 against a description that undersold
this, which is my fault, so the decision is worth taking once more with the real
tradeoff visible.

## Your argument still holds, and it is strong

An attacker can clone the repo and run gitleaks themselves, for free, today. The
source is public. Nothing in a report is capability they did not already have.

So the marginal harm is **convenience, not capability**. That is a real
distinction and it is why this is defensible rather than obviously wrong. It is
also why "a report that says rule 17 matched a few times" is not caution, it is
just a useless report. Vagueness protects nobody here.

Two facts genuinely reduce the harm, and I confirmed both:

- Reports are keyed by opaque request ID, not by username. There is no
  browsable `/reports/for/<user>`. You cannot enumerate people.
- Secret values never exist on our side at all. Gitleaks runs under
  `--redact=100`, so a location is a path and a line and there is no field in
  the schema capable of holding the value.

## The actual decision

Not "should reports show paths." They should. The decision is **whose** repos
get locations published:

**A. Locations for anyone.** Simplest. Anyone scans anyone, everyone sees paths
and lines. Fastest to ship, no auth. Accepts that the tool becomes a
convenience layer for finding a stranger's live keys.

**B. Locations only for your own account.** Anyone can still scan anyone and
see the summary, but paths and lines appear only when the requester proves the
account is theirs via GitHub OAuth. Costs $0 (GitHub OAuth is free). Costs a
session layer and breaks the current "requires no account" promise on the
privacy page. Gets essentially all the product value, because the person who
needs the path is the owner who has to fix it.

**C. Ship A, add a takedown route.** Publish locations for anyone, and state a
removal path by report ID. Cheap. Reactive rather than preventive, and relies
on people knowing they were scanned.

I recommend **B**. The whole value of a location is that the person who can fix
the leak can find it, and that person is the owner. Gating on ownership loses
almost no product value and removes the sharp edge entirely. It is more work
than A, but it is the version of this tool I would be comfortable having
scanned me.

If you want A, say so and I will build A. It is your product and your call, and
your reasoning for it is sound.

## What is already done

Committed and green: 362 tests, typecheck clean, lint clean.

- `5a36eff` fixes a latent migration bug found while planning this. The last
  migration block stamped itself with `SCHEMA_VERSION` instead of the literal
  `7`, so adding migration 8 would have run migration 7, recorded it as 8, then
  skipped migration 8 forever while reporting the database fully migrated. This
  had nothing to do with locations and would have bitten the next migration
  whoever wrote it.
- `4fca5f7` adds the two contract schemas and nothing else. No code produces or
  consumes them. Behaviour is unchanged and the live service is untouched.

**The live site still publishes source-blind reports. Nothing shipped.**

## A problem with the existing proof, worth knowing either way

`apps/api/test/e2e.test.ts` is the test treated as the egress guarantee. Its
fixture writes a tar entry at `fixture-repo/credential.txt` and plants canaries
in the file **contents**. It asserts those contents never appear in responses or
logs.

It never asserts anything about the **path**. So if locations started shipping
tomorrow, that test would stay green, and the suite would report the guarantee
intact while the guarantee had changed.

That blind spot exists right now, independent of this decision. Whatever you
choose, the first step is planting a path canary in that fixture and watching
the test go red before any behaviour changes. If it does not go red, the proof
was never proving what it claimed.

## What is left, once you choose

Roughly two hours for A, half a day for B.

1. Path canary in `apps/api/test/e2e.test.ts` and
   `packages/worker/test/worker.test.ts`. Must go red first.
2. `locations` onto `publicFindingSchema` in `packages/contracts/src/api.ts`.
3. `collectReview` and locations emitted from `apps/scan-domain/src/index.ts`,
   carried through `apps/scan-worker/src/bubblewrap-domain.ts`.
4. Join locations onto findings in `packages/worker/src/worker.ts`, after
   `broker.accept()` returns, never inside the packet.
5. Storage: D1 needs no migration, `findings_json` is opaque. SQLite needs
   migration 8, now safe to add.
6. UI in `apps/web/`.
7. Every user-facing sentence that currently promises the opposite. There are
   about a dozen across `apps/web/index.html`, `apps/web/public/privacy.html`,
   `README.md`, `SECURITY.md`, `CONTRIBUTING.md`, `docs/threat-model.md`,
   `docs/architecture.md`, and the Apps Script email template. These must ship
   in the same deploy as the behaviour, or the site states something untrue.

Step 7 is why I stopped rather than shipping this while you were out. Changing
what a live security tool publishes about people who did not ask to be scanned,
and rewriting its privacy promises to match, is a decision I did not think I
should make on your behalf from a one-word answer.
