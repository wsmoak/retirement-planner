// src/lib/calculations/longTermCare.test.ts

import { describe, it, expect } from 'vitest';
import type { LongTermCareScenario, PersonalInfo } from '@/types';
import { resolveHousehold } from './household';
import { resolveCare, NO_CARE } from './longTermCare';
import { LTC_SOLO_FACILITY_OFFSET, SURVIVOR_SPENDING_FACTOR } from '@/lib/constants';

const single: PersonalInfo = {
    retirementAge: 65,
    lifeExpectancy: 90,
    state: 'GA',
    filingStatus: 'single',
};

/** Primary retires at 65 and dies at 90; spouse is 63 then and dies at 94. */
const couple: PersonalInfo = {
    retirementAge: 65,
    lifeExpectancy: 90,
    state: 'GA',
    filingStatus: 'married_joint',
    spouseAgeAtRetirement: 63,
    spouseLifeExpectancy: 94,
};

function scenario(over: Partial<LongTermCareScenario> = {}): LongTermCareScenario {
    return {
        enabled: true,
        primary: { careType: 'assisted_living', durationYears: 3, annualCost: 70_000 },
        spouse: { careType: 'none', durationYears: 0, annualCost: 0 },
        costInflationRate: 0,
        ...over,
    };
}

/** resolveCare against the household state for the same clock age. */
function careAt(age: number, personal: PersonalInfo, ltc?: LongTermCareScenario) {
    return resolveCare(age, personal, resolveHousehold(age, personal), ltc, age - personal.retirementAge);
}

describe('resolveCare — switched off', () => {
    it('is NO_CARE when the scenario is absent', () => {
        expect(careAt(88, single, undefined)).toEqual(NO_CARE);
    });

    it('is NO_CARE when the scenario is disabled', () => {
        expect(careAt(88, single, scenario({ enabled: false }))).toEqual(NO_CARE);
    });

    it('is NO_CARE for a careType of none', () => {
        const s = scenario({ primary: { careType: 'none', durationYears: 3, annualCost: 70_000 } });
        expect(careAt(89, single, s).anyCare).toBe(false);
    });
});

describe('resolveCare — the window is the final N years of life', () => {
    // Primary dies at 90, 3 years of care → ages 88, 89, 90.
    it('covers exactly the final N years', () => {
        expect(careAt(87, single, scenario()).primaryInCare).toBe(false);
        expect(careAt(88, single, scenario()).primaryInCare).toBe(true);
        expect(careAt(90, single, scenario()).primaryInCare).toBe(true);
    });

    it('never runs past the death year', () => {
        // 91 is beyond the horizon for a single filer, but the guard must hold anyway.
        expect(careAt(91, single, scenario()).primaryInCare).toBe(false);
    });

    it('starts earlier rather than overrunning when the duration exceeds the plan', () => {
        const s = scenario({ primary: { careType: 'assisted_living', durationYears: 50, annualCost: 70_000 } });
        expect(careAt(65, single, s).primaryInCare).toBe(true);
        expect(careAt(90, single, s).primaryInCare).toBe(true);
    });
});

describe('resolveCare — cost', () => {
    it('is zero outside the window and the full amount inside it', () => {
        expect(careAt(87, single, scenario()).annualCost).toBe(0);
        expect(careAt(88, single, scenario()).annualCost).toBe(70_000);
    });

    it('inflates from retirement at the LTC rate, not the general one', () => {
        const s = scenario({ costInflationRate: 0.05 });
        // Age 88 is 23 years after retirement at 65.
        expect(careAt(88, single, s).annualCost).toBeCloseTo(70_000 * 1.05 ** 23, 4);
    });

    it('sums both spouses when both are in care', () => {
        const s = scenario({
            primary: { careType: 'assisted_living', durationYears: 3, annualCost: 70_000 },
            spouse: { careType: 'nursing_home_semi', durationYears: 20, annualCost: 110_000 },
        });
        // Clock 88 → primary 88 (in care), spouse 86 with a 20-year window ending at 94.
        const c = careAt(88, couple, s);
        expect(c.primaryInCare).toBe(true);
        expect(c.spouseInCare).toBe(true);
        expect(c.annualCost).toBe(180_000);
    });
});

describe('resolveCare — a dead person receives no care', () => {
    it('stops the primary\'s care at their death even if the spouse lives on', () => {
        // Primary dies at 90; the spouse survives to clock 96. A long primary window
        // must not leak into the survivor's years.
        const s = scenario({ primary: { careType: 'assisted_living', durationYears: 30, annualCost: 70_000 } });
        expect(careAt(90, couple, s).primaryInCare).toBe(true);
        expect(careAt(91, couple, s).primaryInCare).toBe(false);
        expect(careAt(91, couple, s).annualCost).toBe(0);
    });

    it('gives the surviving spouse care in their own final years', () => {
        const s = scenario({
            primary: { careType: 'none', durationYears: 0, annualCost: 0 },
            spouse: { careType: 'nursing_home_semi', durationYears: 2, annualCost: 110_000 },
        });
        // Spouse dies at 94 → clock 96. Their final two years are spouse-age 93-94.
        expect(careAt(94, couple, s).spouseInCare).toBe(false);   // spouse is 92
        expect(careAt(95, couple, s).spouseInCare).toBe(true);    // spouse is 93
        expect(careAt(96, couple, s).spouseInCare).toBe(true);    // spouse is 94
    });
});

describe('resolveCare — living-expense offset', () => {
    it('is zero for home-based care, which displaces nothing', () => {
        const s = scenario({ primary: { careType: 'home_health', durationYears: 3, annualCost: 78_000 } });
        expect(careAt(88, single, s).livingExpenseOffset).toBe(0);
    });

    it('uses the couple offset — derived from the survivor factor — for one of two', () => {
        // Clock 88: both alive, primary in a facility.
        const c = careAt(88, couple, scenario());
        expect(c.livingExpenseOffset).toBeCloseTo(1 - SURVIVOR_SPENDING_FACTOR, 10);
    });

    it('uses the solo offset when every living person is in a facility', () => {
        expect(careAt(88, single, scenario()).livingExpenseOffset).toBe(LTC_SOLO_FACILITY_OFFSET);

        const both = scenario({
            spouse: { careType: 'assisted_living', durationYears: 20, annualCost: 70_000 },
        });
        expect(careAt(88, couple, both).livingExpenseOffset).toBe(LTC_SOLO_FACILITY_OFFSET);
    });

    it('treats a lone survivor in a facility as solo', () => {
        // Clock 91: the primary is gone, the spouse survives and is in a facility.
        const s = scenario({
            primary: { careType: 'none', durationYears: 0, annualCost: 0 },
            spouse: { careType: 'assisted_living', durationYears: 10, annualCost: 70_000 },
        });
        const c = careAt(91, couple, s);
        expect(c.spouseInCare).toBe(true);
        expect(c.livingExpenseOffset).toBe(LTC_SOLO_FACILITY_OFFSET);
    });
});
