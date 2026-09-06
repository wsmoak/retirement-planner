// src/lib/calculations/yearlyProjection.test.ts

import { describe, it, expect } from 'vitest';
import { runCompleteSimulation } from './yearlyProjection';
import { createSeededRNG } from './random';
import { DEFAULT_VALUES, SURVIVOR_SPENDING_FACTOR, LTC_SOLO_FACILITY_OFFSET } from '../constants';
import type { UserInputs } from '@/types';

/** Deep-ish clone of the defaults with per-test overrides. */
function makeInputs(overrides: Partial<UserInputs> = {}): UserInputs {
    return structuredClone({ ...DEFAULT_VALUES, ...overrides });
}

describe('runCompleteSimulation — success metric', () => {
    it('a richly funded, low-spend plan never depletes → success, positive balance', () => {
        const inputs = makeInputs();
        inputs.accounts.taxDeferred.balanceAtRetirement = 5_000_000;
        inputs.accounts.roth.balanceAtRetirement = 5_000_000;
        inputs.accounts.taxable.balanceAtRetirement = 5_000_000;
        // Use a benign, positive return sequence via a fixed seed + modest spend.
        inputs.phases.forEach(p => { p.annualSpending = 20_000; });

        const r = runCompleteSimulation(inputs, createSeededRNG(1));
        expect(r.success).toBe(true);
        expect(r.ageOfDepletion).toBeNull();
        expect(r.finalBalance).toBeGreaterThan(0);
    });

    it('a tiny portfolio with heavy spending depletes → failure, $0 final balance', () => {
        const inputs = makeInputs();
        inputs.accounts.taxDeferred.balanceAtRetirement = 10_000;
        inputs.accounts.roth.balanceAtRetirement = 0;
        inputs.accounts.taxable.balanceAtRetirement = 0;
        inputs.accounts.hsa.balanceAtRetirement = 0;
        inputs.phases.forEach(p => { p.annualSpending = 80_000; });
        // No outside income so the portfolio must carry all spending.
        inputs.income.socialSecurity.monthlyBenefitAtFRA = 0;

        const r = runCompleteSimulation(inputs, createSeededRNG(1));
        expect(r.success).toBe(false);
        expect(r.ageOfDepletion).not.toBeNull();
        // The key regression guard: a failed run reports exactly $0, never stranded pennies.
        expect(r.finalBalance).toBe(0);
    });

    it('produces one projection row per retirement year', () => {
        const inputs = makeInputs();
        const r = runCompleteSimulation(inputs, createSeededRNG(1));
        const expectedYears = inputs.personal.lifeExpectancy - inputs.personal.retirementAge + 1;
        expect(r.projections).toHaveLength(expectedYears);
    });

    it('is deterministic for a fixed seed', () => {
        const a = runCompleteSimulation(makeInputs(), createSeededRNG(7));
        const b = runCompleteSimulation(makeInputs(), createSeededRNG(7));
        expect(a.finalBalance).toBe(b.finalBalance);
        expect(a.ageOfDepletion).toBe(b.ageOfDepletion);
    });
});

describe('runCompleteSimulation — tax-smart vs standard sequencing', () => {
    const lifetimeTax = (r: ReturnType<typeof runCompleteSimulation>) =>
        r.projections.reduce((sum, p) => sum + p.taxes.total, 0);
    const gapTaxDeferred = (r: ReturnType<typeof runCompleteSimulation>, ssClaimAge: number) =>
        r.projections
            .filter(p => p.age < ssClaimAge)
            .reduce((sum, p) => sum + p.portfolio.withdrawals.taxDeferred, 0);

    // The classic gap-year case: a healthy taxable buffer plus delayed Social Security (70).
    // Under 'standard', the taxable account covers all gap-year spending so the large
    // tax-deferred balance sits untouched and later drives big, torpedo-triggering RMDs.
    // 'tax_smart' instead draws that tax-deferred down to the deduction floor (tax-free)
    // during the gap, cutting lifetime tax and preserving the higher-return taxable account.
    const SS_CLAIM_AGE = 70;
    function gapYearPlan(strategy: 'standard' | 'tax_smart'): UserInputs {
        const inputs = makeInputs();
        // Pin the gap length so the scenario doesn't inherit (and break with) the mutable
        // DEFAULT_VALUES.retirementAge: a fixed 10-year gap (60 → SS at 70) keeps the taxable
        // buffer sufficient to cover the whole gap under 'standard' sequencing.
        inputs.personal.retirementAge = 60;
        inputs.accounts.taxDeferred.balanceAtRetirement = 900_000;
        inputs.accounts.taxable.balanceAtRetirement = 600_000;
        inputs.accounts.roth.balanceAtRetirement = 100_000;
        inputs.accounts.hsa.balanceAtRetirement = 0;
        inputs.income.socialSecurity.claimingAge = SS_CLAIM_AGE;
        inputs.phases.forEach(p => { p.annualSpending = 55_000; });
        // Deterministic returns so the ONLY difference between runs is the strategy.
        inputs.simulation.returnStdDeviation = 0;
        inputs.withdrawalStrategy.strategy = strategy;
        return inputs;
    }

    it('tax-smart pays less lifetime tax and leaves more behind', () => {
        const std = runCompleteSimulation(gapYearPlan('standard'), createSeededRNG(42));
        const smart = runCompleteSimulation(gapYearPlan('tax_smart'), createSeededRNG(42));

        expect(lifetimeTax(smart)).toBeLessThan(lifetimeTax(std));
        expect(smart.finalBalance).toBeGreaterThan(std.finalBalance);
    });

    it('draws tax-deferred during the gap years, unlike standard sequencing', () => {
        const std = runCompleteSimulation(gapYearPlan('standard'), createSeededRNG(42));
        const smart = runCompleteSimulation(gapYearPlan('tax_smart'), createSeededRNG(42));

        // Standard leaves tax-deferred untouched in the gap (taxable covers spending);
        // tax-smart proactively fills the deduction floor from it.
        expect(gapTaxDeferred(std, SS_CLAIM_AGE)).toBeCloseTo(0, -1);
        expect(gapTaxDeferred(smart, SS_CLAIM_AGE)).toBeGreaterThan(100_000);
    });

    it('never produces a negative balance under tax-smart sequencing', () => {
        const smart = runCompleteSimulation(gapYearPlan('tax_smart'), createSeededRNG(42));
        for (const p of smart.projections) {
            expect(p.portfolio.balances.total).toBeGreaterThanOrEqual(0);
        }
    });
});

describe('runCompleteSimulation — RMD start age (flat 75, SECURE 2.0 born 1960+)', () => {
    // Big taxable buffer + standard sequencing so tax-deferred is untouched until the
    // RMD forces it; zero volatility for determinism.
    function rmdPlan(retirementAge: number): UserInputs {
        const inputs = makeInputs();
        inputs.personal.retirementAge = retirementAge;
        inputs.personal.lifeExpectancy = 90;
        inputs.accounts.taxDeferred.balanceAtRetirement = 1_000_000;
        inputs.accounts.roth.balanceAtRetirement = 0;
        inputs.accounts.taxable.balanceAtRetirement = 2_000_000;
        inputs.accounts.hsa.balanceAtRetirement = 0;
        inputs.phases = [
            { name: 'go_go', startAge: retirementAge, endAge: 74, annualSpending: 30_000 },
            { name: 'slow_go', startAge: 75, endAge: 85, annualSpending: 30_000 },
            { name: 'no_go', startAge: 86, endAge: 90, annualSpending: 30_000 },
        ];
        inputs.withdrawalStrategy.strategy = 'standard';
        inputs.simulation.returnStdDeviation = 0;
        return inputs;
    }
    const rmdAt = (r: ReturnType<typeof runCompleteSimulation>, age: number) =>
        r.projections.find(p => p.age === age)!.portfolio.rmdAmount;

    it('no RMD before 75 — begins exactly at 75, regardless of retirement age', () => {
        for (const retireAge of [55, 67]) {
            const r = runCompleteSimulation(rmdPlan(retireAge), createSeededRNG(1));
            expect(rmdAt(r, 73)).toBe(0);
            expect(rmdAt(r, 74)).toBe(0);
            expect(rmdAt(r, 75)).toBeGreaterThan(0);
        }
    });

    it('MFJ: the household RMD starts when the OLDER spouse turns 75', () => {
        // Primary retires at 62; spouse is 4 years older, so the older spouse turns 75 when
        // the primary is 71 → RMD begins at primary age 71 (not 75).
        const inputs = rmdPlan(62);
        inputs.personal.filingStatus = 'married_joint';
        inputs.personal.spouseAgeAtRetirement = 66; // spouse hits 75 at primary age 71
        const r = runCompleteSimulation(inputs, createSeededRNG(1));
        expect(rmdAt(r, 70)).toBe(0);
        expect(rmdAt(r, 71)).toBeGreaterThan(0);
    });
});

describe('runCompleteSimulation — married filing jointly', () => {
    const lifetimeTax = (r: ReturnType<typeof runCompleteSimulation>) =>
        r.projections.reduce((sum, p) => sum + p.taxes.total, 0);

    // A couple, both 67 at retirement. `spouseMonthly` = 0 keeps household income
    // identical to the single case (so filing status is the only difference); a positive
    // value adds a second SS stream. 'standard' strategy + zero volatility isolate the
    // tax model from the tax-smart fill and market noise.
    function couplePlan(mfj: boolean, spouseMonthly: number): UserInputs {
        const inputs = makeInputs();
        inputs.personal.retirementAge = 67;
        inputs.personal.lifeExpectancy = 90;
        inputs.phases = [
            { name: 'go_go', startAge: 67, endAge: 74, annualSpending: 70_000 },
            { name: 'slow_go', startAge: 75, endAge: 85, annualSpending: 60_000 },
            { name: 'no_go', startAge: 86, endAge: 90, annualSpending: 50_000 },
        ];
        inputs.accounts.taxDeferred.balanceAtRetirement = 1_200_000;
        inputs.accounts.roth.balanceAtRetirement = 100_000;
        inputs.accounts.taxable.balanceAtRetirement = 200_000;
        inputs.accounts.hsa.balanceAtRetirement = 0;
        inputs.income.socialSecurity.monthlyBenefitAtFRA = 2_500;
        inputs.income.socialSecurity.claimingAge = 67;
        inputs.simulation.returnStdDeviation = 0;
        inputs.withdrawalStrategy.strategy = 'standard';
        // Zero healthcare so single vs MFJ differ ONLY in filing status. MFJ's two-track
        // healthcare would otherwise double the couple's costs and muddy the tax isolation.
        inputs.healthcare.preMedicare = { monthlyPremium: 0, annualOutOfPocket: 0 };
        inputs.healthcare.medicare = {
            ...inputs.healthcare.medicare,
            partBStandardPremium: 0,
            partDPremium: 0,
            medigapPremium: 0,
            expectIRMAA: false,
            irmaaSurcharge: 0,
            outOfPocketByPhase: { phase1: 0, phase2: 0, phase3: 0 },
        };
        if (mfj) {
            inputs.personal.filingStatus = 'married_joint';
            inputs.personal.spouseAgeAtRetirement = 67;
            inputs.income.spouseSocialSecurity = {
                monthlyBenefitAtFRA: spouseMonthly,
                claimingAge: 67,
                colaRate: 0.03,
                taxablePercentage: 0.85,
            };
        } else {
            inputs.personal.filingStatus = 'single';
        }
        return inputs;
    }

    it('combines both spouses\' Social Security into the projection income', () => {
        const r = runCompleteSimulation(couplePlan(true, 1_800), createSeededRNG(3));
        // Year 0 (age 67 = FRA, both claim at 67): 30,000 + 21,600 = 51,600.
        expect(r.projections[0].income.socialSecurity).toBeCloseTo(51_600, 0);
    });

    it('pays less lifetime tax than a single filer at identical income (bigger joint floor)', () => {
        // Spouse SS = 0 → household income identical to single; only the deduction and SS
        // thresholds differ, so MFJ must owe strictly less tax over the plan.
        const single = runCompleteSimulation(couplePlan(false, 0), createSeededRNG(3));
        const mfj = runCompleteSimulation(couplePlan(true, 0), createSeededRNG(3));

        // Same household income each year (sanity check the isolation).
        expect(mfj.projections[0].income.socialSecurity)
            .toBeCloseTo(single.projections[0].income.socialSecurity, 0);
        expect(lifetimeTax(mfj)).toBeLessThan(lifetimeTax(single));
    });
});

// Regression: withdrawals were sized at the flat marginal rate, ignoring that each drawn dollar
// drags up to $0.85 of Social Security into the taxable base. Every year after SS started came
// out short — the plan spent money it never withdrew, which flatters the success rate. Before
// the fix this ran to −$2,613 across ages 67–78 of the default plan.
describe('withdrawals cover the year they fund', () => {
    /**
     * Phantom spending across a seed sweep: dollars the plan spent without withdrawing them.
     * A depleted year genuinely cannot fund itself, so those are shortfalls, not leaks.
     */
    function leakage(inputs: UserInputs, seeds = 60) {
        let worstYear = 0;
        let totalLeak = 0;
        for (let seed = 1; seed <= seeds; seed++) {
            for (const p of runCompleteSimulation(inputs, createSeededRNG(seed)).projections) {
                if (p.shortfall > 0.5) continue;
                if (p.netCashFlow < 0) totalLeak += -p.netCashFlow;
                if (p.netCashFlow < worstYear) worstYear = p.netCashFlow;
            }
        }
        return { worstYear, leakPerRun: totalLeak / seeds };
    }

    // With no state tax the solve is exact, so nothing should leak at all.
    it('leaks nothing in a no-income-tax state', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'TX';

        const { worstYear, leakPerRun } = leakage(inputs);
        // Was −$2,613 worst year and ~$9,000 per run under the flat-rate gross-up.
        expect(worstYear).toBeGreaterThan(-1);
        expect(leakPerRun).toBeLessThan(1);
    });

    // A state that taxes income must leak no more than one that doesn't. It used to: while the
    // gross-up multiplied by one probed rate, Georgia ran to −$362 in the worst year and ~$12 per
    // run. Sizing against the state's own formula closed that to the same sub-dollar rounding as
    // Texas — so the state gross-up is exact now, not an estimate with a disclosed residual.
    it('leaks no more in Georgia than in a no-income-tax state', () => {
        const inputs = makeInputs();      // default state is GA
        const { worstYear, leakPerRun } = leakage(inputs);
        expect(worstYear).toBeGreaterThan(-1);
        expect(leakPerRun).toBeLessThan(1);
    });

    // Virginia is the harder case and the reason the gross-up takes a function: its age deduction
    // phases out dollar-for-dollar, so the marginal rate doubles inside a $12,000 band that a
    // normal year's draw crosses. It carries ~4× Georgia's tax bill here and still leaks nothing.
    it('leaks nothing in Virginia, across the age-deduction phase-out', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'VA';

        const { worstYear, leakPerRun } = leakage(inputs);
        expect(worstYear).toBeGreaterThan(-1);
        expect(leakPerRun).toBeLessThan(1);
    });

    // California has no age-tiered exclusion or deduction to phase, but it does have the
    // exemption-credit's step-function phase-out and the surtax's kink at $1,000,000 — neither
    // reachable at the default plan's income, so this mainly guards against a regression that
    // would surface only once a future test pushes income into either zone.
    it('leaks nothing in California', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'CA';

        const { worstYear, leakPerRun } = leakage(inputs);
        expect(worstYear).toBeGreaterThan(-1);
        expect(leakPerRun).toBeLessThan(1);
    });

    // New York's benefit-recapture surtax is resolved into extra bracket rows rather than a
    // separate mechanism (§4.5), so — like Georgia's flat rate and unlike Virginia's phase-out —
    // it cannot by itself prove the gross-up handles a changing marginal rate. What it does add
    // is the source-split retirement benefit: this default plan's pensions are all private, so
    // this mainly guards the exclusion and the recapture rows against a regression.
    it('leaks nothing in New York', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'NY';

        const { worstYear, leakPerRun } = leakage(inputs);
        expect(worstYear).toBeGreaterThan(-1);
        expect(leakPerRun).toBeLessThan(1);
    });

    it('holds for an early claiming age, which lands SS squarely in the phase-in', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'TX';
        inputs.income.socialSecurity.claimingAge = 62;
        inputs.personal.filingStatus = 'married_joint';
        inputs.personal.spouseAgeAtRetirement = 58;

        expect(leakage(inputs).worstYear).toBeGreaterThan(-1);
    });

    // MFJ in Virginia stacks the two hardest interactions: a pooled $24,000 age-deduction cap
    // means-tested on combined income, and both spouses' SS in the provisional-income formula.
    it('holds for a married couple in Virginia', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'VA';
        inputs.personal.filingStatus = 'married_joint';
        inputs.personal.spouseAgeAtRetirement = 63;

        expect(leakage(inputs).worstYear).toBeGreaterThan(-1);
    });
});

describe('state tax', () => {
    it('reports a real $0 for a no-income-tax state and folds it into the total', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'TX';
        inputs.tax.stateTaxMode = 'modeled';

        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        for (const p of r.projections) {
            expect(p.taxes.stateTax).toBe(0);
            expect(p.taxes.total).toBeCloseTo(
                p.taxes.onFixedIncome + p.taxes.onWithdrawals + p.taxes.payrollTax + p.taxes.stateTax,
                6
            );
        }
    });

    it('reports $0 for an unmodeled state — its burden stays inside the marginal rate', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'NJ';
        inputs.tax.stateTaxMode = 'modeled';

        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        expect(r.projections.every(p => p.taxes.stateTax === 0)).toBe(true);
    });

    // Legacy scenarios load with stateTaxMode 'manual'; they must compute exactly as before.
    it('manual mode produces identical results to modeled mode while every state is $0', () => {
        const manual = makeInputs();
        manual.personal.state = 'FL';
        manual.tax.stateTaxMode = 'manual';

        const modeled = makeInputs();
        modeled.personal.state = 'FL';
        modeled.tax.stateTaxMode = 'modeled';

        const a = runCompleteSimulation(manual, createSeededRNG(11));
        const b = runCompleteSimulation(modeled, createSeededRNG(11));
        expect(a.finalBalance).toBe(b.finalBalance);
        expect(a.ageOfDepletion).toBe(b.ageOfDepletion);
    });

    // Georgia is the first modeled state with a nonzero bill, so it is where the cash-flow-gap
    // and final-tax touch points finally get end-to-end coverage (docs §9).
    it('GA: charges real tax in the gap years and folds it into the total', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'GA';
        inputs.tax.stateTaxMode = 'modeled';

        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        const gapYears = r.projections.filter(p => p.age < 62);
        const later = r.projections.filter(p => p.age >= 65);

        // No retirement exclusion before 62, then $65,000/person from 65 — so the GA bill is
        // front-loaded into exactly the years the tax-smart strategy draws hardest.
        expect(gapYears.some(p => p.taxes.stateTax > 0)).toBe(true);
        const gapTax = gapYears.reduce((s, p) => s + p.taxes.stateTax, 0);
        const laterTax = later.reduce((s, p) => s + p.taxes.stateTax, 0);
        expect(gapTax).toBeGreaterThan(laterTax);

        for (const p of r.projections) {
            expect(p.taxes.total).toBeCloseTo(
                p.taxes.onFixedIncome + p.taxes.onWithdrawals + p.taxes.payrollTax + p.taxes.stateTax,
                6
            );
        }
    });

    // Regression: the gross-up rate is probed at the year's expected draw, not at fixed income
    // alone. Probing fixed income leaves a 58-year-old with no pension reading 0% — GA's $15k
    // deduction swallows the probe — so the entire state bill went unfunded and the first year
    // spent money it never withdrew (netCashFlow = −stateTax exactly).
    it('GA: funds the state bill from withdrawals in the first year', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'GA';
        inputs.tax.stateTaxMode = 'modeled';

        const first = runCompleteSimulation(inputs, createSeededRNG(7)).projections[0];
        expect(first.taxes.stateTax).toBeGreaterThan(0);
        // Was −$602 — exactly the state tax owed, i.e. the whole bill unfunded. Now within a cent:
        // sizing against the state's own formula leaves only the $1 convergence residual, which
        // can fall either side of zero instead of always over-withdrawing.
        expect(first.netCashFlow).toBeGreaterThan(-1);
        expect(first.netCashFlow).toBeGreaterThan(-first.taxes.stateTax / 100);
    });

    it('GA in manual mode reports $0 — a legacy scenario is not taxed twice', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'GA';
        inputs.tax.stateTaxMode = 'manual';

        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        expect(r.projections.every(p => p.taxes.stateTax === 0)).toBe(true);
    });

    // Virginia's benefit is shaped the opposite way to Georgia's: it starts at 65 (not 62), it is
    // means-tested rather than capped by income type, and it *shrinks* as income rises.
    it('VA: charges tax before 65 and keeps charging it after, unlike Georgia', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'VA';
        inputs.tax.stateTaxMode = 'modeled';

        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        expect(r.projections.every(p => p.netCashFlow >= -1)).toBe(true);

        for (const p of r.projections) {
            expect(p.taxes.total).toBeCloseTo(
                p.taxes.onFixedIncome + p.taxes.onWithdrawals + p.taxes.payrollTax + p.taxes.stateTax,
                6
            );
        }

        // Georgia's exclusion zeroes its bill out from 65; Virginia's means test does not, because
        // a withdrawal large enough to fund the year also phases the age deduction away.
        const ga = makeInputs();
        ga.personal.state = 'GA';
        ga.tax.stateTaxMode = 'modeled';
        const gaRun = runCompleteSimulation(ga, createSeededRNG(7));

        const from65 = (run: typeof r) =>
            run.projections.filter(p => p.age >= 65).reduce((s, p) => s + p.taxes.stateTax, 0);
        expect(from65(r)).toBeGreaterThan(from65(gaRun));
    });

    // California has no age-tiered exclusion or deduction — unlike Georgia and Virginia, its
    // bill does not fall or phase as the retiree ages, only with the ordinary bracket schedule.
    it('CA: charges real tax with no age-based benefit to phase, and folds it into the total', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'CA';
        inputs.tax.stateTaxMode = 'modeled';

        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        expect(r.projections.some(p => p.taxes.stateTax > 0)).toBe(true);

        for (const p of r.projections) {
            expect(p.taxes.total).toBeCloseTo(
                p.taxes.onFixedIncome + p.taxes.onWithdrawals + p.taxes.payrollTax + p.taxes.stateTax,
                6
            );
        }
    });

    // New York has no age-tiered benefit either — its recapture surtax is resolved into the
    // ordinary bracket rows (§4.5), so like California its bill does not fall as the retiree ages.
    it('NY: charges real tax and folds it into the total', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'NY';
        inputs.tax.stateTaxMode = 'modeled';

        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        expect(r.projections.some(p => p.taxes.stateTax > 0)).toBe(true);

        for (const p of r.projections) {
            expect(p.taxes.total).toBeCloseTo(
                p.taxes.onFixedIncome + p.taxes.onWithdrawals + p.taxes.payrollTax + p.taxes.stateTax,
                6
            );
        }
    });

    // The one behavior unique to New York: two otherwise-identical plans differing only in
    // whether the pension is government or private source should owe different state tax, because
    // government pensions are fully exempt and private ones only get the capped $20,000 exclusion.
    it('NY: a government pension owes less state tax than an identical private one', () => {
        const withPension = (isGovernment: boolean) => {
            const inputs = makeInputs();
            inputs.personal.state = 'NY';
            inputs.tax.stateTaxMode = 'modeled';
            inputs.income.pensions = [
                { id: '1', name: 'Pension', monthlyAmount: 5000, startAge: 60, colaRate: 0, isGovernment },
            ];
            return runCompleteSimulation(inputs, createSeededRNG(7));
        };

        const government = withPension(true);
        const privateSource = withPension(false);

        const totalStateTax = (run: ReturnType<typeof withPension>) =>
            run.projections.reduce((sum, p) => sum + p.taxes.stateTax, 0);

        expect(totalStateTax(government)).toBeLessThan(totalStateTax(privateSource));
    });

    it('keeps the cash-flow identity: income + withdrawals = expenses + tax + net', () => {
        const inputs = makeInputs();
        inputs.personal.state = 'WA';
        inputs.tax.stateTaxMode = 'modeled';

        const r = runCompleteSimulation(inputs, createSeededRNG(3));
        for (const p of r.projections) {
            const lhs = p.income.totalBeforeWithdrawals + p.portfolio.withdrawals.total;
            const rhs = p.expenses.total + p.taxes.total + p.netCashFlow;
            expect(lhs).toBeCloseTo(rhs, 4);
        }
    });
});

describe('runCompleteSimulation — one-time income (home equity)', () => {
    function plan(): UserInputs {
        const inputs = makeInputs();
        inputs.personal.retirementAge = 65;
        inputs.personal.lifeExpectancy = 90;
        inputs.personal.filingStatus = 'single';
        inputs.accounts.taxDeferred.balanceAtRetirement = 800_000;
        inputs.accounts.roth.balanceAtRetirement = 200_000;
        inputs.accounts.taxable.balanceAtRetirement = 200_000;
        inputs.accounts.hsa.balanceAtRetirement = 0;
        inputs.simulation.returnStdDeviation = 0;
        inputs.simulation.generalInflationRate = 0;
        inputs.withdrawalStrategy.strategy = 'standard';
        return inputs;
    }
    const at = (r: ReturnType<typeof runCompleteSimulation>, age: number) =>
        r.projections.find(p => p.age === age)!;

    it('REGRESSION: an absent list changes nothing', () => {
        const without = runCompleteSimulation(plan(), createSeededRNG(5));
        const empty = plan();
        empty.oneTimeIncome = [];
        const withEmpty = runCompleteSimulation(empty, createSeededRNG(5));
        expect(withEmpty.finalBalance).toBeCloseTo(without.finalBalance, 6);
    });

    it('lands only in its own year', () => {
        const inputs = plan();
        inputs.oneTimeIncome = [{ id: '1', description: 'Sell the house', amount: 300_000, age: 80 }];
        const r = runCompleteSimulation(inputs, createSeededRNG(5));
        expect(at(r, 79).income.oneTimeIncome).toBe(0);
        expect(at(r, 80).income.oneTimeIncome).toBeCloseTo(300_000, 6);
        expect(at(r, 81).income.oneTimeIncome).toBe(0);
    });

    it('is tax-free — a big inflow adds no tax', () => {
        const withoutSale = runCompleteSimulation(plan(), createSeededRNG(5));
        const inputs = plan();
        inputs.oneTimeIncome = [{ id: '1', description: 'Sell the house', amount: 300_000, age: 80 }];
        const withSale = runCompleteSimulation(inputs, createSeededRNG(5));

        // By 80 the RMD exceeds the year's need in BOTH runs, so both withdraw exactly the
        // same forced minimum — the sale changes nothing about the draw.
        expect(at(withSale, 80).portfolio.withdrawals.total)
            .toBeCloseTo(at(withoutSale, 80).portfolio.withdrawals.total, 6);

        // Same income, same draw — so if the $300k proceeds were taxable the bill would
        // jump. It doesn't move at all.
        expect(at(withSale, 80).taxes.total).toBeCloseTo(at(withoutSale, 80).taxes.total, 6);
    });

    it('reinvests the surplus and leaves the plan better off', () => {
        const inputs = plan();
        inputs.oneTimeIncome = [{ id: '1', description: 'Sell the house', amount: 300_000, age: 80 }];
        const withSale = runCompleteSimulation(inputs, createSeededRNG(5));
        const withoutSale = runCompleteSimulation(plan(), createSeededRNG(5));
        expect(withSale.finalBalance).toBeGreaterThan(withoutSale.finalBalance);
        // Proceeds beyond the year's need go into the taxable account, not nowhere.
        expect(at(withSale, 80).portfolio.balances.taxable)
            .toBeGreaterThan(at(withoutSale, 80).portfolio.balances.taxable);
    });

    it('inflates from retirement like every other dollar figure', () => {
        const inputs = plan();
        inputs.simulation.generalInflationRate = 0.03;
        inputs.oneTimeIncome = [{ id: '1', description: 'Sell the house', amount: 300_000, age: 80 }];
        const r = runCompleteSimulation(inputs, createSeededRNG(5));
        expect(at(r, 80).income.oneTimeIncome).toBeCloseTo(300_000 * 1.03 ** 15, 4);
    });

    it('still funds every year it claims to (the cash-flow identity holds)', () => {
        const inputs = plan();
        inputs.oneTimeIncome = [{ id: '1', description: 'Sell the house', amount: 300_000, age: 80 }];
        const r = runCompleteSimulation(inputs, createSeededRNG(5));
        for (const p of r.projections) {
            const lhs = p.income.totalBeforeWithdrawals + p.portfolio.withdrawals.total;
            const rhs = p.expenses.total + p.taxes.total + p.netCashFlow;
            expect(lhs).toBeCloseTo(rhs, 4);
        }
    });

    it('takes the RMD even in a year the sale covers everything', () => {
        // Regression for a real bug this feature exposed: the surplus branch used to skip
        // the RMD entirely. An RMD is a legal minimum keyed to age and balance — it does
        // not care whether the money is needed — and skipping it understated that year's
        // taxable income AND left the tax-deferred balance too high for every later year.
        const inputs = plan();
        inputs.phases.forEach(p => { p.annualSpending = 20_000; });
        inputs.oneTimeIncome = [{ id: '1', description: 'Sell the house', amount: 900_000, age: 80 }];
        const r = runCompleteSimulation(inputs, createSeededRNG(5));

        const year = at(r, 80);
        // Income massively exceeds spending, so this is the surplus branch.
        expect(year.income.totalBeforeWithdrawals).toBeGreaterThan(year.expenses.total);
        expect(year.portfolio.rmdAmount).toBeGreaterThan(0);
        expect(year.portfolio.withdrawals.taxDeferred).toBeCloseTo(year.portfolio.rmdAmount, 6);
        // And it is taxed rather than arriving free.
        expect(year.taxes.total).toBeGreaterThan(0);
    });
});

describe('runCompleteSimulation — long-term care stress test', () => {
    /** Single filer, retires 65, dies 90. Care occupies the final 3 years: 88, 89, 90. */
    function carePlan(ltc?: Partial<UserInputs['longTermCare']>): UserInputs {
        const inputs = makeInputs();
        inputs.personal.retirementAge = 65;
        inputs.personal.lifeExpectancy = 90;
        inputs.personal.filingStatus = 'single';
        inputs.phases = [
            { name: 'go_go', startAge: 65, endAge: 74, annualSpending: 60_000 },
            { name: 'slow_go', startAge: 75, endAge: 85, annualSpending: 52_000 },
            { name: 'no_go', startAge: 86, endAge: 90, annualSpending: 46_000 },
        ];
        inputs.accounts.taxDeferred.balanceAtRetirement = 1_500_000;
        inputs.accounts.roth.balanceAtRetirement = 300_000;
        inputs.accounts.taxable.balanceAtRetirement = 300_000;
        inputs.accounts.hsa.balanceAtRetirement = 0;
        inputs.income.socialSecurity.monthlyBenefitAtFRA = 2_600;
        inputs.income.socialSecurity.claimingAge = 67;
        inputs.simulation.returnStdDeviation = 0;
        inputs.withdrawalStrategy.strategy = 'standard';
        inputs.longTermCare = {
            enabled: true,
            primary: { careType: 'nursing_home_semi', durationYears: 3, annualCost: 110_000 },
            spouse: { careType: 'none', durationYears: 0, annualCost: 0 },
            costInflationRate: 0,
            ...ltc,
        };
        return inputs;
    }

    const at = (r: ReturnType<typeof runCompleteSimulation>, age: number) =>
        r.projections.find(p => p.age === age)!;

    it('REGRESSION: a disabled scenario reproduces the plan exactly', () => {
        const off = runCompleteSimulation(carePlan({ enabled: false }), createSeededRNG(3));
        const absent = makeInputs();
        absent.personal.retirementAge = 65;
        absent.personal.lifeExpectancy = 90;
        absent.personal.filingStatus = 'single';
        absent.phases = carePlan().phases;
        absent.accounts = structuredClone(carePlan().accounts);
        absent.income.socialSecurity.monthlyBenefitAtFRA = 2_600;
        absent.income.socialSecurity.claimingAge = 67;
        absent.simulation.returnStdDeviation = 0;
        absent.withdrawalStrategy.strategy = 'standard';
        delete absent.longTermCare;

        const none = runCompleteSimulation(absent, createSeededRNG(3));
        expect(off.finalBalance).toBeCloseTo(none.finalBalance, 6);
        expect(off.projections.map(p => p.taxes.total))
            .toEqual(none.projections.map(p => p.taxes.total));
    });

    it('bills care only inside the final-N-years window', () => {
        const r = runCompleteSimulation(carePlan(), createSeededRNG(3));
        expect(at(r, 87).expenses.longTermCare).toBe(0);
        expect(at(r, 88).expenses.longTermCare).toBeCloseTo(110_000, 6);
        expect(at(r, 90).expenses.longTermCare).toBeCloseTo(110_000, 6);
    });

    it('displaces living expenses for facility care but not for home care', () => {
        const facility = runCompleteSimulation(carePlan(), createSeededRNG(3));
        const home = runCompleteSimulation(
            carePlan({ primary: { careType: 'home_health', durationYears: 3, annualCost: 110_000 } }),
            createSeededRNG(3)
        );
        // Same phase and same year, so only the offset differs.
        expect(at(facility, 88).expenses.living).toBeLessThan(at(home, 88).expenses.living);
        expect(at(facility, 88).expenses.living / at(home, 88).expenses.living)
            .toBeCloseTo(1 - LTC_SOLO_FACILITY_OFFSET, 6);
        // Home care displaces nothing, so it matches the no-care year's living expense.
        const off = runCompleteSimulation(carePlan({ enabled: false }), createSeededRNG(3));
        expect(at(home, 88).expenses.living).toBeCloseTo(at(off, 88).expenses.living, 6);
    });

    it('itemizes in a care year: the same cash need costs less tax when it is medical', () => {
        // Controlled comparison. Both plans need an extra $110k at age 90 and nothing
        // else differs — same phases, same balances, same seed, zero inflation so the
        // two amounts stay equal. One is HOME care (deductible, and displaces no living
        // expense, so the cash requirement matches exactly); the other is an ordinary
        // one-time expense. The only difference left is deductibility.
        const medical = carePlan({
            primary: { careType: 'home_health', durationYears: 1, annualCost: 110_000 },
        });
        medical.simulation.generalInflationRate = 0;

        const ordinary = carePlan({ enabled: false });
        ordinary.simulation.generalInflationRate = 0;
        ordinary.oneTimeExpenses = [
            { id: '1', description: 'Boat', amount: 110_000, age: 90 },
        ];

        const m = at(runCompleteSimulation(medical, createSeededRNG(3)), 90);
        const o = at(runCompleteSimulation(ordinary, createSeededRNG(3)), 90);

        // Same total spending in the year, and by 90 the RMD on the pooled tax-deferred
        // balance exceeds the cash need in BOTH runs — so the withdrawal is identical and
        // this is a clean controlled comparison: same income, same draw, only the
        // deductibility of the expense differs.
        expect(m.expenses.total).toBeCloseTo(o.expenses.total, 4);
        expect(m.portfolio.withdrawals.total).toBeCloseTo(o.portfolio.withdrawals.total, 6);

        // The medical version itemizes a deduction far above the standard one, so it pays
        // materially less tax on that identical income.
        expect(m.taxes.total).toBeLessThan(o.taxes.total * 0.75);
    });

    it('costs more overall and depletes the portfolio faster', () => {
        const withCare = runCompleteSimulation(carePlan(), createSeededRNG(3));
        const without = runCompleteSimulation(carePlan({ enabled: false }), createSeededRNG(3));
        expect(withCare.finalBalance).toBeLessThan(without.finalBalance);
    });

    it('still funds every year it claims to (the cash-flow identity holds)', () => {
        const r = runCompleteSimulation(carePlan(), createSeededRNG(3));
        for (const p of r.projections) {
            const lhs = p.income.totalBeforeWithdrawals + p.portfolio.withdrawals.total;
            const rhs = p.expenses.total + p.taxes.total + p.netCashFlow;
            expect(lhs).toBeCloseTo(rhs, 4);
        }
    });

    it('routes care through the HSA tax-free before taxable accounts', () => {
        const inputs = carePlan();
        inputs.accounts.hsa.balanceAtRetirement = 500_000;
        const r = runCompleteSimulation(inputs, createSeededRNG(3));
        // Long-term care is a qualified medical expense, so the HSA covers it first.
        expect(at(r, 88).portfolio.hsaForHealthcare).toBeGreaterThan(100_000);
    });
});

describe('runCompleteSimulation — per-spouse life expectancy & the survivor transition', () => {
    /**
     * Couple retires the same year: primary 67, spouse 65 (a constant 2-year gap).
     * Phase boundaries are placed so the death year lands mid-phase, keeping the
     * spending comparison free of a phase step.
     */
    function survivorPlan(spouseLifeExpectancy?: number): UserInputs {
        const inputs = makeInputs();
        inputs.personal.retirementAge = 67;
        inputs.personal.lifeExpectancy = 95;
        inputs.personal.filingStatus = 'married_joint';
        inputs.personal.spouseAgeAtRetirement = 65;
        if (spouseLifeExpectancy !== undefined) {
            inputs.personal.spouseLifeExpectancy = spouseLifeExpectancy;
        }
        inputs.phases = [
            { name: 'go_go', startAge: 67, endAge: 74, annualSpending: 70_000 },
            { name: 'slow_go', startAge: 75, endAge: 85, annualSpending: 60_000 },
            { name: 'no_go', startAge: 86, endAge: 95, annualSpending: 50_000 },
        ];
        inputs.accounts.taxDeferred.balanceAtRetirement = 2_000_000;
        inputs.accounts.roth.balanceAtRetirement = 500_000;
        inputs.accounts.taxable.balanceAtRetirement = 500_000;
        inputs.accounts.hsa.balanceAtRetirement = 0;
        inputs.income.socialSecurity.monthlyBenefitAtFRA = 3_000;
        inputs.income.socialSecurity.claimingAge = 67;
        inputs.income.spouseSocialSecurity = {
            monthlyBenefitAtFRA: 1_500, claimingAge: 67, colaRate: 0.03, taxablePercentage: 0.85,
        };
        inputs.simulation.returnStdDeviation = 0;
        inputs.withdrawalStrategy.strategy = 'standard';
        return inputs;
    }

    // Spouse (65 at retirement) lives to 80 → last alive at clock 82, gone from 83.
    const DEATH_CLOCK_AGE = 83;
    const at = (r: ReturnType<typeof runCompleteSimulation>, clockAge: number) =>
        r.projections.find(p => p.age === clockAge)!;

    it('REGRESSION: omitting spouseLifeExpectancy reproduces the old shared horizon exactly', () => {
        const legacy = runCompleteSimulation(survivorPlan(), createSeededRNG(7));
        // The legacy default puts the spouse's death in the same year as the primary's,
        // so an explicit equivalent must produce identical output.
        const explicit = runCompleteSimulation(survivorPlan(93), createSeededRNG(7));
        expect(legacy.projections.length).toBe(explicit.projections.length);
        expect(legacy.finalBalance).toBeCloseTo(explicit.finalBalance, 6);
        expect(legacy.projections.map(p => p.taxes.total))
            .toEqual(explicit.projections.map(p => p.taxes.total));
    });

    it('runs to the LAST death when the spouse outlives the primary', () => {
        const inputs = survivorPlan(90);
        inputs.personal.lifeExpectancy = 85;
        // Spouse reaches 90 at clock age 67 + (90 - 65) = 92.
        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        expect(r.projections[r.projections.length - 1].age).toBe(92);
        expect(r.projections.length).toBe(92 - 67 + 1);
    });

    it('does not shorten the run when the spouse dies first', () => {
        const r = runCompleteSimulation(survivorPlan(80), createSeededRNG(7));
        expect(r.projections[r.projections.length - 1].age).toBe(95);
    });

    it('drops the smaller Social Security check at the first death', () => {
        const r = runCompleteSimulation(survivorPlan(80), createSeededRNG(7));
        const before = at(r, DEATH_CLOCK_AGE - 1).income.socialSecurity;
        const after = at(r, DEATH_CLOCK_AGE).income.socialSecurity;
        // Two checks (3000 + 1500) become the larger one alone, so roughly a third of
        // the household benefit disappears — far more than one year of COLA adds back.
        expect(after).toBeLessThan(before * 0.75);
        expect(after).toBeGreaterThan(0);
    });

    it('drops to one healthcare track at the first death', () => {
        const r = runCompleteSimulation(survivorPlan(80), createSeededRNG(7));
        const before = at(r, DEATH_CLOCK_AGE - 1).expenses.healthcarePremiums;
        const after = at(r, DEATH_CLOCK_AGE).expenses.healthcarePremiums;
        // Both are past 65, so the two tracks are equal — one leaving halves the cost
        // (before healthcare inflation adds a little back).
        expect(after).toBeLessThan(before * 0.6);
        expect(after).toBeGreaterThan(0);
    });

    it('steps household living expenses down to the survivor factor', () => {
        const r = runCompleteSimulation(survivorPlan(80), createSeededRNG(7));
        const before = at(r, DEATH_CLOCK_AGE - 1).expenses.living;
        const after = at(r, DEATH_CLOCK_AGE).expenses.living;
        // Same phase either side, so the only movements are the factor and one year
        // of general inflation.
        const inflation = 1 + DEFAULT_VALUES.simulation.generalInflationRate;
        expect(after / before).toBeCloseTo(SURVIVOR_SPENDING_FACTOR * inflation, 4);
    });

    it('keeps the household clock intact across a PRIMARY death', () => {
        const inputs = survivorPlan(95);
        inputs.personal.lifeExpectancy = 80;   // primary dies first, at clock 80
        // A one-time expense keyed to the user's own age frame must still fire on time.
        inputs.oneTimeExpenses = [{ id: '1', description: 'Roof', amount: 30_000, age: 88 }];
        const r = runCompleteSimulation(inputs, createSeededRNG(7));
        expect(at(r, 88).expenses.oneTimeExpenses).toBeGreaterThan(0);
        expect(at(r, 87).expenses.oneTimeExpenses).toBe(0);
    });

    it('taxes the survivor at a higher effective rate on the same withdrawals', () => {
        // Isolate the filing-status flip: no Social Security and no healthcare, so the
        // only things separating the two runs at the same clock age are the standard
        // deduction (MFJ vs single) and the survivor spending factor.
        const strip = (i: UserInputs) => {
            i.income.socialSecurity.monthlyBenefitAtFRA = 0;
            i.income.spouseSocialSecurity = {
                monthlyBenefitAtFRA: 0, claimingAge: 67, colaRate: 0.03, taxablePercentage: 0.85,
            };
            i.healthcare.preMedicare = { monthlyPremium: 0, annualOutOfPocket: 0 };
            i.healthcare.medicare = {
                ...i.healthcare.medicare,
                partBStandardPremium: 0, partDPremium: 0, medigapPremium: 0,
                expectIRMAA: false, irmaaSurcharge: 0,
                outOfPocketByPhase: { phase1: 0, phase2: 0, phase3: 0 },
            };
            return i;
        };
        const widowed = runCompleteSimulation(strip(survivorPlan(80)), createSeededRNG(7));
        const intact = runCompleteSimulation(strip(survivorPlan()), createSeededRNG(7));

        const w = at(widowed, DEATH_CLOCK_AGE);
        const i = at(intact, DEATH_CLOCK_AGE);

        // By this age the RMD on the pooled balance exceeds the cash-flow gap, so BOTH
        // runs are forced to withdraw exactly the same amount — the balances entering
        // the death year are still identical. That makes this a clean controlled
        // comparison: same withdrawal, same ordinary income, only the filing status
        // differs.
        expect(w.portfolio.withdrawals.total).toBeCloseTo(i.portfolio.withdrawals.total, 6);

        // And the survivor pays MORE tax on that identical income, because the standard
        // deduction roughly halved. That is the survivor's penalty, in one number.
        expect(w.taxes.total).toBeGreaterThan(i.taxes.total);
    });
});
