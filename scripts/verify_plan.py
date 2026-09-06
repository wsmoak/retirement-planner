#!/usr/bin/env python3
"""
Retirement Plan Verification Script (v2 — JSON bundle)
======================================================
Independently re-checks a simulation run for mathematical consistency.

As of v2 this reads a SINGLE self-describing JSON file exported from the app
("Export Verification JSON" button on the Annual Breakdown tab). That bundle
contains the full user inputs, the simulation settings, the aggregate results,
and the complete p10/p50/p90 year-by-year projections. Because inputs AND
results live in the same file, there is no longer a hand-maintained PLAN dict
to keep in sync — every expected value is derived from the inputs the app
actually ran with.

What is verified (deterministic, derived from inputs):
  - Social Security  (FRA benefit x claiming-age factor x COLA, + earnings test)
  - Rental income    (base x general inflation from start age)
  - Living expenses   (phase spending x general inflation from retirement)
  - Healthcare premiums   (pre-Medicare and Medicare, inflated correctly;
                      two per-person tracks summed for MFJ)
  - Healthcare out-of-pocket (pre-Medicare and Medicare, inflated correctly;
                      two per-person tracks summed for MFJ)
  - Income tax       (provisional-income SS formula + standard-deduction floor +
                      marginal rate) and payroll tax (7.65% of part-time work)
  - State income tax (GA's age-tiered exclusion, VA's means-tested age deduction and
                      graduated brackets, CA's brackets-by-status + exemption credit +
                      surtax, NY's brackets-by-status (recapture resolved into extra
                      bracket rows) + source-split retirement benefit; $0 for the nine
                      no-income-tax states)
  - RMDs             (IRS Uniform Lifetime divisor on the start-of-year tax-deferred
                      balance, from age 75; MFJ pools under the OLDER spouse's age)
  - Component sums: Total Income / Expenses / Tax / Withdrawals
  - Cash-flow identity: Income + Withdrawals = Expenses + Taxes + Net Cash Flow
  - Funding: withdrawals actually cover the year they fund (netCashFlow >= 0). This is
             the check that catches a broken gross-up — the plan "spending" money it
             never withdrew — which two separate bugs did before it existed.

The TAX_RULES table below MUST stay in sync with TAX_RULES in
src/lib/calculations/taxes.ts. See docs/2-federal-tax-model.md for the model and sources.

What is NOT verified (stochastic):
  - Portfolio account balances (random returns each year).
    Instead: implied annual return per account is checked for plausibility.

Workflow:
  1. Run a simulation in the app.
  2. On the Annual Breakdown tab, click "Export Verification JSON".
  3. Save the downloaded retirement-verification-<timestamp>.json into THIS
     scripts/ folder (works the same on macOS and Windows).
  4. Run this script — it automatically picks the newest bundle in scripts/.

Usage:
  python verify_plan.py                              # newest bundle in scripts/
  python verify_plan.py --json path/to/bundle.json
  python verify_plan.py --percentile p10 --tolerance 0.03
"""

import argparse
import glob
import json
import math
import os
import sys

# ─── DEFAULTS ─────────────────────────────────────────────────────────────────
DEFAULT_TOLERANCE = 0.02          # ±2% (tighter than v1: the split is now exact)
PLAUSIBLE_RETURN_MIN = -0.60      # Flag if implied annual return < -60%
PLAUSIBLE_RETURN_MAX = 1.50       # Flag if implied annual return > +150%
MEDICARE_AGE = 65
FULL_RETIREMENT_AGE = 67

# Social Security claiming-age adjustment factors (must match the app).
SS_ADJUSTMENT_FACTORS = {
    62: 0.70, 63: 0.75, 64: 0.80, 65: 0.867, 66: 0.933,
    67: 1.0, 68: 1.08, 69: 1.16, 70: 1.24,
}
EARNINGS_TEST_BEFORE_FRA = 23400
EARNINGS_TEST_IN_FRA_YEAR = 62160

# Age at which this tool starts RMDs — a flat 75 (SECURE 2.0 for those born 1960+), matching
# RMD_START_AGE in src/lib/calculations/rmd.ts.
RMD_START_AGE = 75

# IRS Uniform Lifetime Table divisors — must mirror RMD_TABLE in src/lib/calculations/rmd.ts.
# Duplicated by hand (like TAX_RULES below) rather than shared: this is a published IRS table, so
# an independent transcription is exactly the kind of error worth catching. Ages 101+ reuse 100.
RMD_DIVISORS = {
    73: 26.5, 74: 25.5, 75: 24.6, 76: 23.7, 77: 22.9, 78: 22.0, 79: 21.1,
    80: 20.2, 81: 19.4, 82: 18.5, 83: 17.7, 84: 16.8, 85: 16.0, 86: 15.2,
    87: 14.4, 88: 13.7, 89: 12.9, 90: 12.2, 91: 11.5, 92: 10.8, 93: 10.1,
    94: 9.5, 95: 8.9, 96: 8.4, 97: 7.8, 98: 7.3, 99: 6.8, 100: 6.4,
}

# Largest negative netCashFlow treated as rounding rather than a funding failure. The engine's
# gross-up solve converges to within $1, so a few cents either side of zero is expected; anything
# bigger means withdrawals did not cover the year.
FUNDING_TOLERANCE = 1.0

# Share of AGI below which medical expenses are not deductible (IRC 213(a)).
# Mirrors MEDICAL_EXPENSE_AGI_FLOOR in src/lib/calculations/taxes.ts.
MEDICAL_EXPENSE_AGI_FLOOR = 0.075

# Tax-rule constants — must mirror TAX_RULES in src/lib/calculations/taxes.ts
TAX_RULES = {
    "standard_deduction": {"single": 16100, "married_joint": 32200},   # 2026
    "additional_65": {"single": 2050, "married_joint": 1650},          # 2026
    "senior_bonus": 6000,
    "senior_bonus_last_year": 2028,
    "ss_thresholds": {
        "single": {"base": 25000, "second": 34000},
        "married_joint": {"base": 32000, "second": 44000},
    },
    "ss_max_taxable_fraction": 0.85,
}


# Directory containing this script — bundles are expected to be saved here.
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))

# Per-state tax constants, read from the SAME file the TypeScript engine uses. Deliberately
# shared rather than re-declared here: a wrong constant is caught by human review against the
# primary source, while a wrong *formula* is what this script independently re-derives.
# See docs/5-state-tax-model.md.
STATE_RULES_PATH = os.path.join(
    SCRIPT_DIR, os.pardir, "src", "lib", "calculations", "stateTaxRules.json"
)


def load_state_tax_rules() -> dict:
    try:
        with open(STATE_RULES_PATH, encoding="utf-8") as f:
            return json.load(f).get("states", {})
    except FileNotFoundError:
        print(f"Warning: state tax rules not found at {STATE_RULES_PATH} — "
              "treating all states as unmodeled.")
        return {}


STATE_TAX_RULES = load_state_tax_rules()


def pick_for_year(schedule: list, year: int) -> dict:
    """Entry from a year-keyed schedule governing `year`.

    The last entry already in force, or the earliest one for years before the schedule
    starts. Mirrors `pickForYear` in stateTax.ts.
    """
    chosen = schedule[0]
    for entry in schedule:
        if entry["fromYear"] <= year:
            chosen = entry
    return chosen


# ─── BUNDLE LOADING ─────────────────────────────────────────────────────────────
def find_newest_bundle() -> str | None:
    """Return the newest retirement-verification-*.json saved in scripts/."""
    candidates = glob.glob(os.path.join(SCRIPT_DIR, "retirement-verification-*.json"))
    if not candidates:
        return None
    return max(candidates, key=os.path.getmtime)


def load_bundle(path: str) -> dict:
    with open(path, encoding="utf-8") as f:
        return json.load(f)


# ─── EXPECTED-VALUE FORMULAS (derived from the bundle's inputs) ─────────────────
class Plan:
    """Expected-value formulas built from the app inputs in the bundle."""

    def __init__(self, inputs: dict):
        self.inputs = inputs
        self.retirement_age = inputs["personal"]["retirementAge"]
        sim = inputs["simulation"]
        self.gen_infl = sim["generalInflationRate"]
        self.hc_infl = sim["healthcareInflationRate"]
        self.phases = inputs["phases"]
        self.ss = inputs["income"]["socialSecurity"]
        self.pensions = inputs["income"].get("pensions", []) or []
        self.rental = inputs["income"]["rentalIncome"]
        self.part_time = inputs["income"]["partTimeWork"]
        self.pre_med = inputs["healthcare"]["preMedicare"]
        # Per-person pre-Medicare costs. Absent on plans saved before spouses could differ,
        # and then the spouse simply uses the primary's figures — the old behavior exactly.
        self.spouse_pre_med = inputs["healthcare"].get("spousePreMedicare") or self.pre_med
        self.med = inputs["healthcare"]["medicare"]
        self.filing = inputs["personal"].get("filingStatus") or "single"
        self.eff_rate = inputs["tax"]["combinedEffectiveRate"]
        self.state = inputs["personal"]["state"]
        # Absent mode = scenario saved before state tax existed; state is folded into the rate.
        self.state_mode = inputs["tax"].get("stateTaxMode") or "manual"
        self.ss_cap = self.ss.get("taxablePercentage", TAX_RULES["ss_max_taxable_fraction"])
        self.cost_basis = inputs["accounts"]["taxable"].get("costBasisPercentage", 0.70)
        # MFJ: spouse SS stream + spouse age for per-spouse deduction seniors.
        self.spouse_ss = inputs["income"].get("spouseSocialSecurity")
        self.spouse_age_at_ret = inputs["personal"].get("spouseAgeAtRetirement")
        # Per-spouse mortality. `spouseLifeExpectancy` is absent on plans saved before the
        # survivor model existed; it then defaults to the spouse's age in the year the primary
        # reaches their own life expectancy — the old shared horizon, so such a plan verifies
        # exactly as it always did. Mirrors resolveSpouseLifeExpectancy in
        # src/lib/calculations/household.ts.
        # One-off inflows (home equity, inheritance). Absent on older plans → empty.
        self.one_time_income = inputs.get("oneTimeIncome") or []
        # Long-term care stress test. Absent on plans saved before the feature existed,
        # and switched off by default, so either way the plan verifies as it always did.
        self.ltc = inputs.get("longTermCare")
        self.life_expectancy = inputs["personal"]["lifeExpectancy"]
        if self.filing != "married_joint" or self.spouse_age_at_ret is None:
            self.spouse_life_expectancy = None
        else:
            self.spouse_life_expectancy = inputs["personal"].get(
                "spouseLifeExpectancy",
                self.spouse_age_at_ret + (self.life_expectancy - self.retirement_age),
            )

    # -- phase helpers --
    def get_phase(self, age: int) -> dict:
        for p in self.phases:
            if p["startAge"] <= age <= p["endAge"]:
                return p
        return self.phases[-1]

    def yrs_from_retirement(self, age: int) -> int:
        return age - self.retirement_age

    # -- income --
    def part_time_income(self, age: int) -> float:
        w = self.part_time
        if not w.get("enabled") or age < w["startAge"] or age > w["endAge"]:
            return 0.0
        return w["annualIncome"]

    # -- survivorship (mirrors src/lib/calculations/household.ts) --
    #
    # `age` throughout this file is the HOUSEHOLD CLOCK — the primary's age frame, in which
    # the user entered phases, one-time expenses, and pension/rental/part-time start ages. It
    # keeps counting past a primary death (it is only retirement_age + n). The person-level
    # facts come from the helpers below, so the clock is never re-based.
    #
    # Convention: a person lives THROUGH their life-expectancy year and is gone after it.

    # -- long-term care (mirrors src/lib/calculations/longTermCare.ts) --
    #
    # A stress test the user switches on, not a drawn risk. Care occupies the FINAL
    # `durationYears` of a person's life, so it can never disagree with the death dates
    # the survivor model already fixed.

    LTC_FACILITY_TYPES = {"assisted_living", "nursing_home_semi", "nursing_home_private"}
    LTC_SOLO_FACILITY_OFFSET = 0.60          # mirrors src/lib/constants.ts
    SURVIVOR_SPENDING_FACTOR = 0.75          # mirrors src/lib/constants.ts

    def _care_for(self, who: str) -> dict | None:
        ltc = self.ltc
        if not ltc or not ltc.get("enabled"):
            return None
        care = ltc.get(who)
        if not care or care.get("careType") == "none" or care.get("durationYears", 0) <= 0:
            return None
        return care

    def _in_care_window(self, person_age: int, death_age: int, care: dict) -> bool:
        return death_age - care["durationYears"] < person_age <= death_age

    def primary_in_care(self, age: int) -> bool:
        care = self._care_for("primary")
        if care is None or not self.primary_alive(age):
            return False
        return self._in_care_window(age, self.life_expectancy, care)

    def spouse_in_care(self, age: int) -> bool:
        care = self._care_for("spouse")
        sp = self.spouse_age_notional(age)
        if care is None or sp is None or self.spouse_life_expectancy is None:
            return False
        if self.deceased(age) == "spouse":
            return False
        return self._in_care_window(sp, self.spouse_life_expectancy, care)

    def exp_long_term_care(self, age: int) -> float:
        if not self.ltc or not self.ltc.get("enabled"):
            return 0.0
        infl = (1 + self.ltc.get("costInflationRate", 0.0)) ** max(0, self.yrs_from_retirement(age))
        total = 0.0
        if self.primary_in_care(age):
            total += self.ltc["primary"]["annualCost"] * infl
        if self.spouse_in_care(age):
            total += self.ltc["spouse"]["annualCost"] * infl
        return total

    def ltc_living_offset(self, age: int) -> float:
        """Share of living expenses a facility fee already covers. Home care displaces none."""
        if not self.ltc or not self.ltc.get("enabled"):
            return 0.0
        p = self.primary_in_care(age) and \
            self.ltc["primary"]["careType"] in self.LTC_FACILITY_TYPES
        s = self.spouse_in_care(age) and \
            self.ltc.get("spouse", {}).get("careType") in self.LTC_FACILITY_TYPES
        in_facility = (1 if p else 0) + (1 if s else 0)
        if in_facility == 0:
            return 0.0
        living = 2 if (self.deceased(age) is None and self.spouse_age(age) is not None) else 1
        return self.LTC_SOLO_FACILITY_OFFSET if in_facility >= living \
            else 1 - self.SURVIVOR_SPENDING_FACTOR

    def medical_expenses(self, age: int, row: dict) -> float:
        """Deductible medical expenses — care years only, mirroring yearlyProjection.ts."""
        care = self.exp_long_term_care(age)
        if care <= 0:
            return 0.0
        exp = row["expenses"]
        return care + exp["healthcarePremiums"] + exp["healthcareOutOfPocket"]

    def spouse_age_notional(self, age: int) -> int | None:
        """Spouse's age ignoring death — kept so a survivor benefit can go on receiving COLA."""
        if self.filing != "married_joint" or self.spouse_age_at_ret is None:
            return None
        return self.spouse_age_at_ret + (age - self.retirement_age)

    def primary_alive(self, age: int) -> bool:
        return age <= self.life_expectancy

    def spouse_alive(self, age: int) -> bool:
        sp = self.spouse_age_notional(age)
        return sp is not None and sp <= self.spouse_life_expectancy

    def deceased(self, age: int) -> str | None:
        """'primary', 'spouse', or None while both are alive (always None for a single filer)."""
        if self.spouse_age_notional(age) is None:
            return None
        if self.primary_alive(age) and self.spouse_alive(age):
            return None
        return "spouse" if self.primary_alive(age) else "primary"

    def filing_at(self, age: int) -> str:
        """Filing status THIS year — single from the first death onward."""
        return "single" if self.deceased(age) else self.filing

    def filer_age(self, age: int) -> int:
        """The LIVING filer's age, for anything the tax code scopes to a person."""
        if self.deceased(age) == "primary":
            return self.spouse_age_notional(age)
        return age

    def spending_factor(self, age: int) -> float:
        """Living-expense multiplier; SURVIVOR_SPENDING_FACTOR in src/lib/constants.ts."""
        return 0.75 if self.deceased(age) else 1.0

    def spouse_age(self, age: int) -> int | None:
        """Spouse's age as the per-spouse logic should see it: None once the household is
        down to one person, which is what collapses two-person tracks to one."""
        if self.deceased(age) is not None:
            return None
        return self.spouse_age_notional(age)

    def _ss_benefit(self, s: dict, own_age: int) -> float:
        """Base SS benefit (claiming factor + COLA), no earnings test."""
        claiming = s["claimingAge"]
        if own_age < claiming:
            return 0.0
        factor = SS_ADJUSTMENT_FACTORS.get(claiming, 1.0)
        return s["monthlyBenefitAtFRA"] * 12 * factor * (1 + s["colaRate"]) ** (own_age - claiming)

    def exp_ss(self, age: int) -> float:
        # Primary benefit with the earnings test. Part-time work belongs to the primary, so
        # it (and the test) stop at their death.
        primary = self._ss_benefit(self.ss, age)
        earnings = 0.0 if self.deceased(age) == "primary" else self.part_time_income(age)
        if age < FULL_RETIREMENT_AGE and earnings > 0:
            if age == FULL_RETIREMENT_AGE:
                over = max(0.0, earnings - EARNINGS_TEST_IN_FRA_YEAR)
                primary = max(0.0, primary - over / 3)
            else:
                over = max(0.0, earnings - EARNINGS_TEST_BEFORE_FRA)
                primary = max(0.0, primary - over / 2)

        # Spouse benefit (MFJ, no earnings test). Uses the NOTIONAL age so the amount stays
        # available as the basis for a survivor benefit after the spouse has died.
        sp_age = self.spouse_age_notional(age)
        spouse = (self._ss_benefit(self.spouse_ss, sp_age)
                  if self.spouse_ss is not None and sp_age is not None else 0.0)
        # Both checks while the couple is intact; the LARGER one alone once it is not.
        if self.deceased(age):
            return max(primary, spouse)
        return primary + spouse

    def exp_pensions(self, age: int) -> float:
        total = 0.0
        for p in self.pensions:
            if age >= p["startAge"]:
                total += p["monthlyAmount"] * 12 * (1 + p["colaRate"]) ** (age - p["startAge"])
        return total

    def exp_government_pensions(self, age: int) -> float:
        """Government-source subset of `exp_pensions` — only New York's retirement benefit
        distinguishes pension sources (docs/5-state-tax-model.md §4.5)."""
        total = 0.0
        for p in self.pensions:
            if p.get("isGovernment") and age >= p["startAge"]:
                total += p["monthlyAmount"] * 12 * (1 + p["colaRate"]) ** (age - p["startAge"])
        return total

    def exp_rental(self, age: int) -> float:
        r = self.rental
        if not r.get("enabled") or age < r["startAge"]:
            return 0.0
        end = r.get("endAge")
        if end is not None and age > end:
            return 0.0
        base = r["annualNetIncome"]
        if r.get("inflationAdjusted"):
            return base * (1 + self.gen_infl) ** (age - r["startAge"])
        return base

    def exp_one_time_income(self, age: int) -> float:
        """One-off inflows landing this year — home sale, inheritance, gift.

        Mirrors `calculateOneTimeIncome` in src/lib/calculations/income.ts. Entered in
        retirement-year dollars and inflated at the general rate, like one-time expenses.
        Deliberately TAX-FREE: it never enters any taxable base, so a home sale reduces
        the year's cash need without inflating AGI (see the OneTimeIncome type).
        """
        total = 0.0
        for entry in (self.one_time_income or []):
            if entry["age"] == age:
                total += entry["amount"] * (1 + self.gen_infl) ** (age - self.retirement_age)
        return total

    # -- expenses --
    def exp_living(self, age: int) -> float:
        if age < self.retirement_age:
            return 0.0
        phase = self.get_phase(age)
        return (phase["annualSpending"]
                * (1 + self.gen_infl) ** self.yrs_from_retirement(age)
                * self.spending_factor(age)
                * (1 - self.ltc_living_offset(age)))

    # Healthcare is per-person: pre-Medicare inflates by calendar years since retirement
    # (same for both spouses — they retire the same year); Medicare inflates from each
    # person's own 65. MFJ sums two tracks (equal per-person costs); the Medicare OOP
    # phase is keyed to your age.
    @staticmethod
    def _pre_med_stage(pre_med: dict, person_age: int) -> dict:
        """Pre-Medicare coverage can change ONCE before 65 — typically when the employer
        plan covering this person ends. Returns whichever stage governs `person_age`."""
        stage = pre_med.get("secondStage")
        if stage is not None and person_age >= stage["startAge"]:
            return stage
        return pre_med

    def _person_hc_premiums(self, person_age: int, yrs_since_ret: int,
                            pre_med: dict | None = None) -> float:
        if person_age < MEDICARE_AGE:
            stage = self._pre_med_stage(pre_med or self.pre_med, person_age)
            return stage["monthlyPremium"] * 12 * (1 + self.hc_infl) ** yrs_since_ret
        yrs = person_age - MEDICARE_AGE
        monthly = (
            self.med["partBStandardPremium"]
            + self.med["partDPremium"]
            + self.med["medigapPremium"]
            + (self.med["irmaaSurcharge"] if self.med.get("expectIRMAA") else 0)
        )
        return monthly * 12 * (1 + self.hc_infl) ** yrs

    def _person_hc_oop(self, person_age: int, yrs_since_ret: int, phase_name: str,
                       pre_med: dict | None = None) -> float:
        if person_age < MEDICARE_AGE:
            stage = self._pre_med_stage(pre_med or self.pre_med, person_age)
            return stage["annualOutOfPocket"] * (1 + self.hc_infl) ** yrs_since_ret
        yrs = person_age - MEDICARE_AGE
        oop_by_phase = self.med["outOfPocketByPhase"]
        base = {"go_go": oop_by_phase["phase1"],
                "slow_go": oop_by_phase["phase2"],
                "no_go": oop_by_phase["phase3"]}.get(phase_name, 0)
        return base * (1 + self.hc_infl) ** yrs

    def exp_hc_premiums(self, age: int) -> float:
        if age < self.retirement_age:
            return 0.0
        yrs_since_ret = age - self.retirement_age
        # The first track insures the LIVING filer — after a primary death that is the
        # surviving spouse, whose Medicare timing runs off their own age, not the clock.
        total = self._person_hc_premiums(self.filer_age(age), yrs_since_ret)
        sp_age = self.spouse_age(age)
        if sp_age is not None:
            total += self._person_hc_premiums(sp_age, yrs_since_ret, self.spouse_pre_med)
        return total

    def exp_hc_oop(self, age: int) -> float:
        if age < self.retirement_age:
            return 0.0
        yrs_since_ret = age - self.retirement_age
        phase_name = self.get_phase(age)["name"]
        total = self._person_hc_oop(self.filer_age(age), yrs_since_ret, phase_name)
        sp_age = self.spouse_age(age)
        if sp_age is not None:
            total += self._person_hc_oop(sp_age, yrs_since_ret, phase_name, self.spouse_pre_med)
        return total

    # -- taxes --
    def taxable_social_security(
        self, ss_benefit: float, other_income: float, filing: str
    ) -> float:
        """IRS provisional-income formula, capped at the user's max fraction.

        `filing` is the status for the year in question, not the plan's — a survivor files
        single against the lower thresholds."""
        if ss_benefit <= 0:
            return 0.0
        th = TAX_RULES["ss_thresholds"][filing]
        base, second = th["base"], th["second"]
        provisional = other_income + 0.5 * ss_benefit
        if provisional <= base:
            taxable = 0.0
        elif provisional <= second:
            taxable = min(0.5 * ss_benefit, 0.5 * (provisional - base))
        else:
            tier1 = min(0.5 * ss_benefit, 0.5 * (second - base))
            taxable = min(0.85 * ss_benefit, 0.85 * (provisional - second) + tier1)
        return min(taxable, self.ss_cap * ss_benefit)

    def standard_deduction(self, age: int, year: int) -> float:
        sp_age = self.spouse_age(age)
        filing = self.filing_at(age)
        # The age-65 addition and senior bonus belong to whoever is alive to claim them.
        seniors = ((1 if self.filer_age(age) >= 65 else 0)
                   + (1 if sp_age is not None and sp_age >= 65 else 0))
        infl = (1 + self.gen_infl) ** max(0, age - self.retirement_age)
        ded = (TAX_RULES["standard_deduction"][filing]
               + TAX_RULES["additional_65"][filing] * seniors) * infl
        if seniors and year <= TAX_RULES["senior_bonus_last_year"]:
            ded += TAX_RULES["senior_bonus"] * seniors
        return ded

    def deduction(self, age: int, year: int, medical: float, agi: float) -> float:
        """The deduction actually taken: the greater of the standard one and an itemized
        medical deduction (IRC 213(a), 7.5% of AGI floor).

        A long-term-care year is the one year a retiree realistically itemizes, and the
        amounts dwarf the standard deduction — so charging tax on the withdrawals that
        fund the care without it would badly overstate the bill. Mirrors
        `calculateDeduction` in src/lib/calculations/taxes.ts.
        """
        standard = self.standard_deduction(age, year)
        if medical <= 0:
            return standard
        return max(standard, max(0.0, medical - MEDICAL_EXPENSE_AGI_FLOOR * max(0.0, agi)))

    def expected_income_tax(self, row: dict) -> float:
        """Expected onFixedIncome + onWithdrawals for a projection row."""
        inc = row["income"]
        wd = row["portfolio"]["withdrawals"]
        hsa_nonmed = max(0.0, wd["hsa"] - row["portfolio"]["hsaForHealthcare"])
        brokerage_gain = wd["taxable"] * (1 - self.cost_basis)
        ordinary_wd = wd["taxDeferred"] + hsa_nonmed

        other_excl_ss = (inc["pensions"] + inc["partTimeWork"] + inc["rentalIncome"]
                         + ordinary_wd + brokerage_gain)
        taxable_ss = self.taxable_social_security(
            inc["socialSecurity"], other_excl_ss, self.filing_at(int(row["age"]))
        )

        fixed_base = taxable_ss + inc["pensions"] + inc["partTimeWork"] + inc["rentalIncome"]
        wd_base = ordinary_wd + brokerage_gain

        ded = self.deduction(
            int(row["age"]),
            int(row["year"]),
            self.medical_expenses(int(row["age"]), row),
            fixed_base + wd_base,
        )
        fixed_taxable = max(0.0, fixed_base - ded)
        ded_left = max(0.0, ded - fixed_base)
        wd_taxable = max(0.0, wd_base - ded_left)
        return (fixed_taxable + wd_taxable) * self.eff_rate

    # -- RMDs --
    def expected_rmd(self, age: int, start_tax_deferred: float) -> float:
        """RMD for the year, from the start-of-year tax-deferred balance.

        For MFJ this tool pools both spouses' accounts under a single RMD trigger — the OLDER
        spouse's age — so distributions begin no later than required (docs/4-married-filing-jointly.md).
        That decision is only visible end-to-end here, which is why it is re-derived rather than
        assumed.

        After a first death the trigger follows the SURVIVOR alone: a spouse beneficiary may
        treat an inherited IRA as their own, so their schedule is the real one. Keying it to the
        household clock instead would use a dead person's age — and once the primary is the one
        who died, that age is both wrong and too high, over-distributing the pool.
        """
        sp_age = self.spouse_age(age)
        if sp_age is not None:
            rmd_age = max(age, sp_age)
        else:
            rmd_age = self.filer_age(age)
        if rmd_age < RMD_START_AGE:
            return 0.0
        divisor = RMD_DIVISORS.get(rmd_age, RMD_DIVISORS[100])
        return start_tax_deferred / divisor

    # -- state tax --
    def _state_standard_deduction(self, rules: dict, year: int, filing: str) -> float:
        entry = pick_for_year(rules["standardDeduction"], year)
        return entry["married"] if filing == "married_joint" else entry["single"]

    def _count_at_least_age(self, age: int, min_age: int) -> int:
        """Taxpayers on the return who have reached `min_age`: 1 for single, 0-2 for MFJ."""
        sp_age = self.spouse_age(age)
        return (1 if age >= min_age else 0) + (1 if sp_age is not None and sp_age >= min_age else 0)

    def _va_age_deduction(self, benefit: dict, age: int, afagi: float) -> float:
        """Virginia's age deduction: $12,000 per taxpayer 65+, phased out $1 per $1 of AFAGI
        above $50,000 single / $75,000 married.

        AFAGI is federal AGI less federally taxable SS, which is what `agi` already is here. The
        means test is per RETURN on COMBINED income against a pooled cap, so — unlike Georgia's
        per-person exclusion — pooled accounts give the statutory answer with no attribution
        needed (docs/5-state-tax-model.md §4.3).
        """
        eligible = self._count_at_least_age(age, benefit["minAge"])
        if eligible == 0:
            return 0.0
        limit = benefit["threshold"]["married" if self.filing_at(age) == "married_joint" else "single"]
        cap = benefit["perPerson"] * eligible
        return max(0.0, cap - benefit["reductionPerDollar"] * max(0.0, afagi - limit))

    def _ny_pension_exclusion(
        self, benefit: dict, age: int, government_pension: float,
        private_pension: float, tax_deferred: float
    ) -> float:
        """New York: government pensions are fully exempt (no cap, no age test — Tax Law
        §612(c)(3)); private pension/annuity/IRA income instead gets a $20,000-per-qualifying-
        person exclusion (§612(c)(3-a), age 59½, modeled as 60 — the engine has no fractional
        age). Not poolable across spouses, same family of simplification as Georgia's exclusion
        (docs/5-state-tax-model.md §4.5, §6)."""
        eligible_people = self._count_at_least_age(age, benefit["minAge"])
        private_eligible = private_pension + tax_deferred
        private_excluded = min(eligible_people * benefit["privateExclusionPerPerson"], private_eligible)
        return government_pension + private_excluded

    def _personal_exemptions(self, rules: dict, age: int) -> float:
        """Virginia's personal exemptions: per filer, plus an addition per filer aged 65+."""
        exemption = rules.get("personalExemption")
        if exemption is None:
            return 0.0
        filers = 2 if self.filing_at(age) == "married_joint" else 1
        return (exemption["perFiler"] * filers
                + exemption["age65Addition"] * self._count_at_least_age(age, 65))

    def _apply_rate(self, rate: dict, taxable: float, filing: str) -> float:
        """Flat rate (GA), one bracket schedule (VA), or brackets by filing status (CA).
        `upTo: null` marks the top bracket."""
        if rate["kind"] == "flat":
            return taxable * rate["rate"]

        brackets = (
            rate["married" if filing == "married_joint" else "single"]
            if rate["kind"] == "graduated_by_status"
            else rate["brackets"]
        )

        tax = 0.0
        floor = 0.0
        for bracket in brackets:
            if taxable <= floor:
                break
            ceiling = bracket["upTo"] if bracket["upTo"] is not None else float("inf")
            tax += (min(taxable, ceiling) - floor) * bracket["rate"]
            floor = ceiling
        return tax

    def _ga_exclusion(self, rules: dict, row: dict, gains: float) -> float:
        """Georgia's retirement-income exclusion: per person, age-tiered, capped by that
        person's eligible income. Pooled accounts cannot attribute a withdrawal to a spouse,
        so the combined cap is applied to combined income (docs/5-state-tax-model.md §6)."""
        benefit = rules["retirementBenefit"]
        tiers = pick_for_year(benefit["tiers"], int(row["year"]))

        def tier(age: int) -> float:
            if age >= 65:
                return tiers["age65"]
            return tiers["age62"] if age >= 62 else 0.0

        age = int(row["age"])
        sp_age = self.spouse_age(age)
        cap = tier(age) + (tier(sp_age) if sp_age is not None else 0.0)

        # Enumerated categories only. A non-medical HSA distribution is federal "other
        # income" and matches none of them, so it gets no exclusion.
        inc = row["income"]
        eligible = (inc["pensions"] + inc["rentalIncome"] + gains
                    + row["portfolio"]["withdrawals"]["taxDeferred"]
                    + min(inc["partTimeWork"], benefit["earnedIncomeSublimit"]))
        return min(cap, eligible)

    def _ca_exemption_credit(self, credit: dict, age: int, agi: float) -> float:
        """California's personal/senior exemption CREDIT — subtracted from computed tax, not
        taxable income (the opposite ordering from Virginia's `personalExemption`). Phased out
        $6 (single/MFS) or $12 (married) per $2,500 increment of state AGI over the threshold,
        floored at $0 (R&TC §17054, docs/5-state-tax-model.md §4.4)."""
        married = self.filing_at(age) == "married_joint"
        filers = 2 if married else 1
        base = credit["perFiler"] * filers + credit["age65Addition"] * self._count_at_least_age(age, 65)

        phase_out = credit["phaseOut"]
        threshold = phase_out["threshold"]["married" if married else "single"]
        per_increment = phase_out["reductionPerIncrement"]["married" if married else "single"]
        increments = math.ceil(max(0.0, agi - threshold) / phase_out["increment"])
        return max(0.0, base - increments * per_increment)

    def expected_state_tax(self, row: dict) -> float:
        """Expected state income tax for one projection row.

        Unmodeled states report $0 (their burden is folded into the user's marginal rate) and the
        nine no-income-tax states owe a real $0. Georgia, Virginia, California, and New York are
        re-derived here. Any other income-taxing state raises rather than silently returning 0 —
        a deliberate tripwire so adding a state to the JSON without a formula here cannot pass
        unnoticed.
        """
        if self.state_mode != "modeled":
            return 0.0
        rules = STATE_TAX_RULES.get(self.state)
        if rules is None or not rules.get("taxesIncome", False):
            return 0.0
        if self.state not in ("GA", "VA", "CA", "NY"):
            raise NotImplementedError(f"No state-tax formula for {self.state}")

        inc = row["income"]
        wd = row["portfolio"]["withdrawals"]
        hsa_nonmed = max(0.0, wd["hsa"] - row["portfolio"]["hsaForHealthcare"])
        gains = wd["taxable"] * (1 - self.cost_basis)
        age = int(row["age"])

        # State AGI = federal AGI − federally taxable SS. Every modeled income-tax state exempts
        # Social Security, so it is simply never added; state deductions are not inflated (they
        # are not indexed) — except California's, whose entry is itself a snapshot of TY2025.
        agi = (inc["pensions"] + inc["partTimeWork"] + inc["rentalIncome"]
               + wd["taxDeferred"] + gains + hsa_nonmed)

        # Virginia imposes no tax below the filing threshold (§ 58.1-321). Georgia and California
        # have no such floor, so the key is absent there.
        threshold = rules.get("filingThreshold")
        if threshold is not None:
            limit = threshold["married" if self.filing_at(age) == "married_joint" else "single"]
            if agi < limit:
                return 0.0

        benefit_rules = rules.get("retirementBenefit")
        if benefit_rules is None:
            benefit = 0.0
        elif benefit_rules["kind"] == "ga_exclusion":
            benefit = self._ga_exclusion(rules, row, gains)
        elif benefit_rules["kind"] == "va_age_deduction":
            benefit = self._va_age_deduction(benefit_rules, age, agi)
        else:
            government_pension = self.exp_government_pensions(age)
            private_pension = inc["pensions"] - government_pension
            benefit = self._ny_pension_exclusion(
                benefit_rules, age, government_pension, private_pension, wd["taxDeferred"]
            )

        deduction = self._state_standard_deduction(rules, int(row["year"]), self.filing_at(age))
        exemptions = self._personal_exemptions(rules, age)
        taxable = max(0.0, agi - benefit - deduction - exemptions)

        bracket_tax = self._apply_rate(rules["rate"], taxable, self.filing_at(age))

        credit_rules = rules.get("exemptionCredit")
        credit = self._ca_exemption_credit(credit_rules, age, agi) if credit_rules is not None else 0.0
        regular_tax = max(0.0, bracket_tax - credit)

        surtax_rules = rules.get("surtax")
        surtax = (
            surtax_rules["rate"] * max(0.0, taxable - surtax_rules["threshold"])
            if surtax_rules is not None
            else 0.0
        )

        return regular_tax + surtax


# ─── CHECK HELPERS ──────────────────────────────────────────────────────────────
def within_tol(actual: float, expected: float, tol: float) -> bool:
    if abs(expected) < 1e-9:
        return abs(actual) <= 1.0
    return abs(actual - expected) / abs(expected) <= tol


def fmt_diff(actual: float, expected: float) -> str:
    if abs(expected) < 1e-9:
        return f"expected $0  got ${actual:,.0f}"
    d = (actual - expected) / abs(expected) * 100
    sign = "+" if d >= 0 else ""
    return f"{sign}{d:.1f}%   actual ${actual:,.0f}   expected ~${expected:,.0f}"


# ─── MAIN VERIFICATION ──────────────────────────────────────────────────────────
def verify(bundle: dict, percentile: str, tol: float) -> int:
    PASS, FAIL, WARN = "[PASS]", "[FAIL]", "[WARN]"

    plan = Plan(bundle["inputs"])
    projections = bundle["projections"][percentile]

    total = 0
    n_fail = 0

    def chk(label, actual, expected, issues):
        nonlocal total, n_fail
        total += 1
        if not within_tol(actual, expected, tol):
            n_fail += 1
            issues.append(f"    {FAIL} {label}: {fmt_diff(actual, expected)}")

    # Starting balances for the implied-return check.
    acc = bundle["inputs"]["accounts"]
    prev_bal = {
        "taxDeferred": acc["taxDeferred"]["balanceAtRetirement"],
        "roth": acc["roth"]["balanceAtRetirement"],
        "taxable": acc["taxable"]["balanceAtRetirement"],
        "hsa": acc["hsa"]["balanceAtRetirement"],
    }

    res = bundle["results"]
    print(f"\n{'=' * 68}")
    print(f"  RETIREMENT PLAN VERIFICATION  ({percentile}, tolerance ±{tol * 100:.0f}%)")
    print(f"{'=' * 68}")
    print(f"  Generated : {bundle.get('generatedAt', '?')}")
    print(f"  Runs      : {res['numberOfRuns']:,}   "
          f"Success rate: {res['successRate'] * 100:.1f}%")
    print(f"  Percentile final balances: "
          f"p10 ${res['percentiles']['p10']:,.0f}  "
          f"p50 ${res['percentiles']['p50']:,.0f}  "
          f"p90 ${res['percentiles']['p90']:,.0f}")
    print(f"{'=' * 68}\n")

    for p in projections:
        age = int(p["age"])
        phase = plan.get_phase(age)
        issues: list[str] = []

        inc = p["income"]
        exp = p["expenses"]
        tax = p["taxes"]
        wd = p["portfolio"]["withdrawals"]
        bal = p["portfolio"]["balances"]

        # Income
        chk("Social Security", inc["socialSecurity"], plan.exp_ss(age), issues)
        chk("Pensions", inc["pensions"], plan.exp_pensions(age), issues)
        chk("Rental Income", inc["rentalIncome"], plan.exp_rental(age), issues)

        # Expenses
        chk("Living Expenses", exp["living"], plan.exp_living(age), issues)
        chk("Long-Term Care", exp.get("longTermCare", 0.0), plan.exp_long_term_care(age), issues)
        chk("Healthcare Premiums", exp["healthcarePremiums"], plan.exp_hc_premiums(age), issues)
        chk("Healthcare Out-of-Pocket", exp["healthcareOutOfPocket"], plan.exp_hc_oop(age), issues)

        # Component sums
        # `oneTimeIncome` is absent from bundles exported before one-off inflows existed.
        chk("Total Income = SS + Pensions + Work + Rental + One-Time Income",
            inc["totalBeforeWithdrawals"],
            inc["socialSecurity"] + inc["pensions"] + inc["partTimeWork"] + inc["rentalIncome"]
            + inc.get("oneTimeIncome", 0.0),
            issues)

        chk("One-Time Income", inc.get("oneTimeIncome", 0.0),
            plan.exp_one_time_income(age), issues)

        # `longTermCare` is absent from bundles exported before the care stress test existed.
        chk("Total Expenses = Living + Premiums + OOP + One-Time + Long-Term Care",
            exp["total"],
            exp["living"] + exp["healthcarePremiums"] + exp["healthcareOutOfPocket"]
            + exp["oneTimeExpenses"] + exp.get("longTermCare", 0.0),
            issues)

        # `stateTax` is absent from bundles exported before state tax was modeled.
        state_tax = tax.get("stateTax", 0.0)

        chk("Total Tax = Fixed-income + Payroll + Withdrawal + State",
            tax["total"],
            tax["onFixedIncome"] + tax["payrollTax"] + tax["onWithdrawals"] + state_tax,
            issues)

        chk("State Tax", state_tax, plan.expected_state_tax(p), issues)

        # Independent recomputation of the tax model (provisional-income SS +
        # standard-deduction floor + flat marginal rate).
        chk("Income Tax (SS provisional + deduction floor + rate)",
            tax["onFixedIncome"] + tax["onWithdrawals"],
            plan.expected_income_tax(p),
            issues)

        chk("Payroll Tax = 7.65% of part-time work",
            tax["payrollTax"],
            inc["partTimeWork"] * 0.0765,
            issues)

        chk("Total WD = TaxDeferred + Roth + Taxable + HSA",
            wd["total"],
            wd["taxDeferred"] + wd["roth"] + wd["taxable"] + wd["hsa"],
            issues)

        # Cash-flow identity
        lhs = inc["totalBeforeWithdrawals"] + wd["total"]
        rhs = exp["total"] + tax["total"] + p["netCashFlow"]
        chk("Cash Flow: Income + WD = Expenses + Tax + NCF", lhs, rhs, issues)

        # RMD, from the START-of-year tax-deferred balance (returns are applied after
        # withdrawals, so that is the previous year's closing balance).
        chk("RMD = start-of-year tax-deferred / Uniform Lifetime divisor",
            p["portfolio"]["rmdAmount"],
            plan.expected_rmd(age, prev_bal["taxDeferred"]),
            issues)

        # Funding: the year's withdrawals must actually cover it. A negative netCashFlow outside
        # a genuine shortfall means the gross-up under-withdrew and the plan spent money it never
        # took out — understating depletion risk. This is an absolute-dollar check, not a
        # relative one, because the correct value is 0 and `within_tol` cannot express that.
        total += 1
        if p["shortfall"] <= 0.5 and p["netCashFlow"] < -FUNDING_TOLERANCE:
            n_fail += 1
            issues.append(
                f"    {FAIL} Withdrawals do not cover the year: "
                f"netCashFlow ${p['netCashFlow']:,.2f} with no reported shortfall "
                f"(state tax ${state_tax:,.2f})")

        # Implied-return plausibility (informational)
        for key, wkey in (("taxDeferred", "taxDeferred"), ("roth", "roth"),
                          ("taxable", "taxable"), ("hsa", "hsa")):
            start = prev_bal[key]
            end = bal[key]
            w = wd[wkey]
            if start > 0:
                r = (end + w - start) / start
                if r < PLAUSIBLE_RETURN_MIN or r > PLAUSIBLE_RETURN_MAX:
                    issues.append(
                        f"    {WARN} {key} implied return {r * 100:.1f}%  "
                        f"(start=${start:,.0f} wd=${w:,.0f} end=${end:,.0f})")
            prev_bal[key] = end

        if issues:
            print(f"  Age {age}  [{phase['name']}]")
            for line in issues:
                print(line)
            print()

    passed = total - n_fail
    print(f"{'=' * 68}")
    print(f"  SUMMARY")
    print(f"{'=' * 68}")
    print(f"  Years checked : {len(projections)}")
    print(f"  Total checks  : {total}")
    print(f"  {PASS} Passed : {passed}  ({passed / total * 100:.0f}%)")
    print(f"  {FAIL} Failed : {n_fail}")
    print()
    if n_fail == 0:
        print(f"  All deterministic checks passed within ±{tol * 100:.0f}% tolerance.")
        print("  The numbers are consistent with the plan inputs.")
    else:
        print(f"  {n_fail} check(s) failed — review the output above.")
    print("  Note: portfolio balance checks are informational (stochastic returns).")
    print(f"{'=' * 68}\n")

    return 1 if n_fail else 0


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Verify a retirement-verification JSON bundle")
    ap.add_argument("--json", default=None,
                    help="Path to the verification bundle (default: newest in scripts/)")
    ap.add_argument("--percentile", default="p50", choices=["p10", "p50", "p90"],
                    help="Which projection to verify (default: p50)")
    ap.add_argument("--tolerance", default=DEFAULT_TOLERANCE, type=float, metavar="T",
                    help="Relative tolerance, e.g. 0.02 = ±2%% (default: %(default)s)")
    args = ap.parse_args()

    path = args.json or find_newest_bundle()
    if not path:
        print("No verification bundle found in the scripts/ folder. Export one from "
              "the app (Annual Breakdown → 'Export Verification JSON'), save it into "
              "scripts/, or pass --json <file>.")
        sys.exit(1)
    if not os.path.exists(path):
        print(f"Bundle not found: {path}")
        sys.exit(1)

    print(f"Bundle    : {path}")
    print(f"Percentile: {args.percentile}")
    print(f"Tolerance : ±{args.tolerance * 100:.0f}%")

    bundle = load_bundle(path)
    if bundle.get("schema") != "retirement-verification/v1":
        print(f"Warning: unexpected schema '{bundle.get('schema')}' — proceeding anyway.")

    sys.exit(verify(bundle, args.percentile, args.tolerance))
