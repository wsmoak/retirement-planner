# Married Filing Jointly (Couples) Model

How the simulator models a two-person household, what we deliberately share vs. keep
separate between spouses, and where we sit relative to other retirement tools. The tax
mechanics (MFJ standard deduction, provisional-income SS, RMD age) live in
[`2-federal-tax-model.md`](2-federal-tax-model.md); this document is the couples design and roadmap.

## Design principle: one "you-anchored" timeline

The engine runs a single loop driven by the **primary** person's age
(`retirementAge → lifeExpectancy`), with `year = 2026 + (age − retirementAge)`. The spouse
is represented by an **age offset** (`spouseAgeAtRetirement`) plus their own Social Security.
Everything joint (spending, accounts, taxes, household healthcare) is shared; the spouse is
spouse-aware only where it materially changes the math. We call the two people **"You"** and
**"Your spouse"** — neutral, inclusive of all marriages, and matching the model's asymmetry
(You anchor the timeline).

Because You anchor the timeline, the **event markers** in the results (🎂 Retire, 🏥 Medicare,
💰 Social Security, 📊 RMDs, 💊 HSA depleted) follow **your (primary) age**, not the spouse's.
The Annual Breakdown shows the spouse's age next to yours (`you | spouse`) for context, but the
markers are your milestones. (Healthcare *costs* still switch each spouse to Medicare at their
own 65 internally — that's the two-track cost model, separate from the primary-age markers.)

## Decisions

| # | Matter | Decision |
|---|---|---|
| 1 | Filing status | First-class **single** or **MFJ** (Step 1 selector) |
| 2 | Survivor's penalty | **Modeled.** At the first death: filing flips MFJ→single, the smaller SS check stops, healthcare drops to one track, and living expenses step down to `SURVIVOR_SPENDING_FACTOR` (0.75). Mortality itself is still deterministic — see #3 |
| 3 | Life expectancy | **Per spouse.** Each has their own planning age; the sim runs to the **later** of the two. Fixed ages, not a distribution, so the survivor period's *length* is an assumption |
| 4 | Retirement timing | **Same year** — sim starts when you retire; spouse rides your calendar at a constant age gap |
| 5 | Younger spouse still working | **Not modeled** (no spouse earned income; only your part-time) |
| 6 | Accounts | **Pooled** (one combined set) |
| 7 | RMD | **Flat age 75**; for the pool, triggered when the **older** spouse turns 75, using that age's divisor on the whole balance |
| 8 | Social Security | **Two own-record streams** summed for the provisional-income formula while both are alive; the **larger one alone** after the first death. COLA and taxable-% are **shared** household values. No spousal (≤50%) top-up |
| 9 | Standard deduction | MFJ base + **per-spouse** age-65 additions + senior bonus (senior count 0/1/2 from both ages) |
| 10 | Spending phases | Household spending, keyed to **your** age |
| 11 | Healthcare | **Two tracks** — each spouse pre-Medicare until their own 65, then Medicare — assuming equal per-person costs |

## Shared vs. separate, by wizard step

| Step | Shared | Separate (per person) |
|---|---|---|
| 1 Personal | Retirement year, life expectancy, state, filing status | Spouse **age** |
| 2 Phases | Household spending (by your age) | — |
| 3 Accounts | All balances (pooled) | — |
| 4 Income | COLA, SS taxable %, pensions, rental | **Social Security** (benefit + claiming age) per spouse |
| 5 Healthcare | Cost assumptions (per-person amounts) | **Medicare transition** by each spouse's age |
| 6 Tax/Sim | Rate, inflation, runs, filing status | — |
| 7 Strategy | Withdrawal order (pooled) | — |

## Known simplifications (disclosed)

- **Deterministic mortality.** The survivor's *penalty* is modeled, but both deaths are fixed
  ages the user chooses rather than draws from a mortality distribution. So the plan answers
  "what if we die at these two ages" and not "what is the chance this works across all the ways
  we might die." Probabilistic mortality is the remaining half of this gap.
- **A survivor spends 75% of the couple's living expenses** (`SURVIVOR_SPENDING_FACTOR`), a flat
  constant rather than a user input. Housing and utilities barely move when a household goes from
  two to one, so halving would be badly wrong; the 70-80% band is the usual planning estimate.
  Healthcare is not covered by this factor — it is already per person, so the second track simply
  stops.
- **Pooled accounts + one RMD trigger** (older spouse while both live, the survivor after).
  Over-distributes slightly during a large spousal age gap — conservative (taxable income pulled
  forward; excess reinvested).
- **Equal per-person healthcare costs**; the accuracy that matters (each spouse's Medicare
  timing) is modeled, but we don't take separate premium/OOP figures per spouse.
- **Own-record SS only** — the survivor takes the larger of the two own-record benefits, which is
  the substance of the survivor rule, but there is no spousal (≤50%) top-up.
- **Part-time work belongs to the primary**, so it stops if the primary dies first. The spouse's
  own earned income is not modeled at all.

## How other tools handle these choices

Retirement tools split into two tiers:

- **Comprehensive planners** — Boldin (ex-NewRetirement), ProjectionLab, MaxiFi/ESPlanner,
  Pralana Gold — model the couple as **two distinct people** with individual mortality and a
  full **survivor transition** (filing flips to single, deduction halves, IRMAA thresholds
  drop, the smaller SS ends, accounts pass to the survivor with their own RMD schedule).
  They support **different retirement dates**, **per-spouse life expectancy**, and **spousal/
  survivor SS** rules.
- **FIRE historical simulators** — cFIREsim, FI Calc, FIRECalc — are portfolio + spending
  engines. A couple is entered as **combined balances** and SS as income streams; they
  generally do **not** model MFJ tax brackets, the survivor's penalty, or per-spouse mortality.

**Where we sit:** we keep the **FIRE-sim tier**'s pooled portfolio, but on the two things that
actually drive a couple's late-retirement outcome — MFJ **tax** mechanics (provisional-income
SS, MFJ standard deduction with per-spouse senior additions, older-spouse RMD, two-track
healthcare) and the **survivor transition** (per-spouse life expectancy, MFJ→single on first
death, the smaller SS check stopping, one healthcare track, a spending step-down) — we now sit
with the comprehensive planners. What still separates us from them is **pooled rather than
per-spouse accounts**, **deterministic rather than probabilistic mortality**, and the absence of
spousal-top-up SS rules.

## Roadmap

- **Phase 1 (done):** two-person MFJ — combined SS, MFJ deduction, older-spouse RMD,
  pooled accounts, two-track healthcare. Shared horizon, no survivor penalty.
- **Phase 2 (done):** per-spouse life expectancy and the survivor's ("widow's") penalty — the
  simulation runs to the later death, and the first death flips filing status to single, drops
  the smaller SS check, collapses to one healthcare track, and steps living expenses down.
  Implemented in [`../src/lib/calculations/household.ts`](../src/lib/calculations/household.ts);
  see the survivor-penalty notes in [`2-federal-tax-model.md`](2-federal-tax-model.md).
- **Phase 3 (next, highest value):** **probabilistic mortality** — replace the two fixed ages
  with per-person distributions, which turns the success rate from "does it survive these two
  chosen ages" into a joint-survival-weighted probability.
- **Later:** different retirement dates; separate per-spouse accounts (true per-account RMD
  timing); spousal/survivor SS benefit rules; the spouse's own earned income.

> Phase numbers here track the **couples** model. The tax doc's own roadmap numbers the
> **state-tax** module separately; per-state work is scoped in the slot-5 state-tax doc, not here.

Sources: [Boldin — assumptions when first spouse passes](https://help.boldin.com/en/articles/9293023-assumptions-when-the-first-spouse-passes),
[Boldin — spousal Social Security](https://help.boldin.com/en/articles/5753178-spousal-social-security),
[ProjectionLab — modeling the death of a spouse](https://projectionlab.com/help/life-expectancy-milestone),
[MaxiFi — survivor benefits](https://www.maxifi.com/financial-glossary/survivor-benefits),
[CNBC — the survivor's penalty](https://www.cnbc.com/2026/05/15/survivors-penalty-spouse-dies.html),
[cFIREsim](https://alistair-marshall.github.io/cFIREsim-open/), [FI Calc](https://ficalc.app/),
[FIRECalc](https://www.firecalc.com/).
