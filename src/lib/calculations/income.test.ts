// src/lib/calculations/income.test.ts

import { describe, it, expect } from 'vitest';
import { calculateYearlyIncome, calculateGovernmentPensionIncome } from './income';
import type { SocialSecurity, PartTimeWork, RentalIncome, Pension } from '@/types';

const primarySS: SocialSecurity = {
    monthlyBenefitAtFRA: 2500,
    claimingAge: 67,
    colaRate: 0.03,
    taxablePercentage: 0.85,
};

const spouseSS: SocialSecurity = {
    monthlyBenefitAtFRA: 1800,
    claimingAge: 67,
    colaRate: 0.03,
    taxablePercentage: 0.85,
};

const noWork: PartTimeWork = { enabled: false, annualIncome: 0, startAge: 62, endAge: 70 };
const noRental: RentalIncome = {
    enabled: false,
    annualNetIncome: 0,
    startAge: 60,
    endAge: null,
    inflationAdjusted: false,
};

describe('calculateYearlyIncome — household Social Security (MFJ)', () => {
    it('single filer: only the primary benefit', () => {
        // Age 67 = FRA, claimed at 67 → 2500·12·1.0 = 30,000.
        const result = calculateYearlyIncome(67, primarySS, [], noWork, noRental, 0.03);
        expect(result.socialSecurity).toBeCloseTo(30000, 6);
    });

    it('MFJ: sums both spouses\' benefits into one stream', () => {
        // Primary 30,000 + spouse (1800·12·1.0) 21,600 = 51,600.
        const result = calculateYearlyIncome(67, primarySS, [], noWork, noRental, 0.03, spouseSS, 67);
        expect(result.socialSecurity).toBeCloseTo(51600, 6);
        expect(result.socialSecurityFull).toBeCloseTo(51600, 6);
    });

    it('MFJ: spouse who has not reached their claiming age adds nothing', () => {
        // spouseAge 64 < claimingAge 67 → spouse benefit 0; only the primary's 30,000.
        const result = calculateYearlyIncome(67, primarySS, [], noWork, noRental, 0.03, spouseSS, 64);
        expect(result.socialSecurity).toBeCloseTo(30000, 6);
    });
});

// The government/private split exists only for New York's source-dependent retirement benefit
// (docs/5-state-tax-model.md §4.5) — no other state distinguishes pension sources.
describe('calculateGovernmentPensionIncome', () => {
    const govPension: Pension = {
        id: '1',
        name: 'NY State Pension',
        monthlyAmount: 1000,
        startAge: 65,
        colaRate: 0,
        isGovernment: true,
    };
    const privatePension: Pension = {
        id: '2',
        name: 'Corp Pension',
        monthlyAmount: 800,
        startAge: 62,
        colaRate: 0,
    };

    it('sums only the pensions flagged isGovernment', () => {
        expect(calculateGovernmentPensionIncome(65, [govPension, privatePension])).toBeCloseTo(12000, 6);
    });

    it('is 0 when no pension is flagged government, including pre-existing pensions with no flag at all', () => {
        expect(calculateGovernmentPensionIncome(65, [privatePension])).toBe(0);
    });

    it('is 0 before the government pension has started', () => {
        expect(calculateGovernmentPensionIncome(64, [govPension])).toBe(0);
    });

    it('never exceeds the total pension income it is a subset of', () => {
        const total = calculateYearlyIncome(65, primarySS, [govPension, privatePension], noWork, noRental, 0.03)
            .pensions;
        expect(calculateGovernmentPensionIncome(65, [govPension, privatePension])).toBeLessThan(total);
    });
});

describe('calculateYearlyIncome — spouse earned income', () => {
    // She earns $80k from her own age 55 to 59 — a younger spouse still working full
    // time, not "part-time work". Her ages, not the household clock.
    const spouseWork: PartTimeWork = {
        enabled: true, annualIncome: 80_000, startAge: 55, endAge: 59,
    };

    it('REGRESSION: omitting spouseWork leaves the household unchanged', () => {
        const without = calculateYearlyIncome(67, primarySS, [], noWork, noRental, 0.03, spouseSS, 64);
        const undef = calculateYearlyIncome(
            67, primarySS, [], noWork, noRental, 0.03, spouseSS, 64, null, undefined
        );
        expect(undef.partTimeWork).toBe(without.partTimeWork);
        expect(undef.socialSecurity).toBeCloseTo(without.socialSecurity, 10);
    });

    it('lands in the years keyed to HER age, not the clock', () => {
        // Clock 62, spouse 57 → inside her 55-59 window.
        const inside = calculateYearlyIncome(
            62, primarySS, [], noWork, noRental, 0.03, spouseSS, 57, null, spouseWork
        );
        expect(inside.partTimeWork).toBe(80_000);

        // Clock 65, spouse 60 → past her window, even though the clock is higher.
        const outside = calculateYearlyIncome(
            65, primarySS, [], noWork, noRental, 0.03, spouseSS, 60, null, spouseWork
        );
        expect(outside.partTimeWork).toBe(0);
    });

    it('sums both spouses\' wages and payroll tax into the household total', () => {
        const hisWork: PartTimeWork = { enabled: true, annualIncome: 20_000, startAge: 62, endAge: 70 };
        const r = calculateYearlyIncome(
            62, primarySS, [], hisWork, noRental, 0.03, spouseSS, 57, null, spouseWork
        );
        expect(r.partTimeWork).toBe(100_000);
        expect(r.partTimePayrollTax).toBeCloseTo(100_000 * 0.0765, 6);
    });

    it('applies the earnings test to HER benefit, using HER earnings', () => {
        // Spouse aged 64 (below FRA) claiming at 62, earning $80k. Without the test her
        // benefit would be the full reduced-claiming amount; with it, $80k is far over
        // the limit so $1 is withheld per $2 of excess.
        const claimingEarly: SocialSecurity = { ...spouseSS, claimingAge: 62 };
        const working: PartTimeWork = { ...spouseWork, startAge: 60, endAge: 66 };

        const withWork = calculateYearlyIncome(
            69, primarySS, [], noWork, noRental, 0.03, claimingEarly, 64, null, working
        );
        const withoutWork = calculateYearlyIncome(
            69, primarySS, [], noWork, noRental, 0.03, claimingEarly, 64
        );
        // Her check is smaller because SHE is working, and the household total falls with it.
        expect(withWork.socialSecurity).toBeLessThan(withoutWork.socialSecurity);
    });

    it('does NOT let her earnings touch his benefit', () => {
        // He claims early at 62 and is 64 — squarely in earnings-test territory — but he
        // earns nothing. Only her wages exist, and they must not reduce his check.
        const hisEarly: SocialSecurity = { ...primarySS, claimingAge: 62 };
        const working: PartTimeWork = { ...spouseWork, startAge: 55, endAge: 66 };

        const hisAlone = calculateYearlyIncome(64, hisEarly, [], noWork, noRental, 0.03);
        const withHerWages = calculateYearlyIncome(
            64, hisEarly, [], noWork, noRental, 0.03, undefined, 59, null, working
        );
        // No spouse SS configured, so the household benefit is his alone — unchanged.
        expect(withHerWages.socialSecurity).toBeCloseTo(hisAlone.socialSecurity, 10);
        // Her wages still show up as household income and payroll tax.
        expect(withHerWages.partTimeWork).toBe(80_000);
    });

    it('stops her wages when she dies', () => {
        const alive = calculateYearlyIncome(
            62, primarySS, [], noWork, noRental, 0.03, spouseSS, 57, null, spouseWork
        );
        const dead = calculateYearlyIncome(
            62, primarySS, [], noWork, noRental, 0.03, spouseSS, 57, 'spouse', spouseWork
        );
        expect(alive.partTimeWork).toBe(80_000);
        expect(dead.partTimeWork).toBe(0);
    });
});
