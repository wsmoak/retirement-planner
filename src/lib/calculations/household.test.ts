// src/lib/calculations/household.test.ts

import { describe, it, expect } from 'vitest';
import type { PersonalInfo } from '@/types';
import {
    resolveHousehold,
    resolveSpouseLifeExpectancy,
    simulationHorizon,
} from './household';
import { SURVIVOR_SPENDING_FACTOR } from '@/lib/constants';

const single: PersonalInfo = {
    retirementAge: 60,
    lifeExpectancy: 90,
    state: 'GA',
    filingStatus: 'single',
};

/** Primary retires at 60, spouse is 56 that year — a constant 4-year age gap. */
const couple: PersonalInfo = {
    retirementAge: 60,
    lifeExpectancy: 90,
    state: 'GA',
    filingStatus: 'married_joint',
    spouseAgeAtRetirement: 56,
};

describe('resolveSpouseLifeExpectancy', () => {
    it('is undefined for a single filer', () => {
        expect(resolveSpouseLifeExpectancy(single)).toBeUndefined();
    });

    it('defaults to the legacy shared horizon when unset', () => {
        // Primary reaches 90 after 30 years; the spouse (56 at retirement) is 86 then.
        expect(resolveSpouseLifeExpectancy(couple)).toBe(86);
    });

    it('uses the explicit value when given', () => {
        expect(resolveSpouseLifeExpectancy({ ...couple, spouseLifeExpectancy: 94 })).toBe(94);
    });
});

describe('simulationHorizon', () => {
    it('is the primary life expectancy for a single filer', () => {
        expect(simulationHorizon(single)).toBe(90);
    });

    it('REGRESSION: an MFJ plan with no spouse life expectancy keeps the old shared horizon', () => {
        expect(simulationHorizon(couple)).toBe(90);
    });

    it('extends when the spouse outlives the primary', () => {
        // Spouse lives to 94, i.e. 38 years past retirement → clock age 98.
        expect(simulationHorizon({ ...couple, spouseLifeExpectancy: 94 })).toBe(98);
    });

    it('stays at the primary life expectancy when the spouse dies first', () => {
        // Spouse lives to 80 → clock age 84, earlier than the primary's 90.
        expect(simulationHorizon({ ...couple, spouseLifeExpectancy: 80 })).toBe(90);
    });
});

describe('resolveHousehold — single filer', () => {
    it('reports one living person and never a death transition', () => {
        const h = resolveHousehold(75, single);
        expect(h.filingStatus).toBe('single');
        expect(h.filerAge).toBe(75);
        expect(h.spouseAge).toBeUndefined();
        expect(h.deceased).toBeNull();
        expect(h.spendingFactor).toBe(1);
        expect(h.rmdAge).toBe(75);
    });
});

describe('resolveHousehold — both alive', () => {
    it('files jointly, exposes the spouse age, and spends in full', () => {
        const h = resolveHousehold(70, couple);
        expect(h.filingStatus).toBe('married_joint');
        expect(h.filerAge).toBe(70);
        expect(h.spouseAge).toBe(66);
        expect(h.deceased).toBeNull();
        expect(h.spendingFactor).toBe(1);
    });

    it('keys the pooled RMD to the OLDER spouse', () => {
        // Primary 70, spouse 66 → the primary is older.
        expect(resolveHousehold(70, couple).rmdAge).toBe(70);
        // Flip the gap: spouse is 4 years OLDER than the primary.
        const olderSpouse = { ...couple, spouseAgeAtRetirement: 64 };
        expect(resolveHousehold(70, olderSpouse).rmdAge).toBe(74);
    });

    it('counts the life-expectancy year itself as alive', () => {
        const h = resolveHousehold(90, { ...couple, spouseLifeExpectancy: 94 });
        expect(h.primaryAlive).toBe(true);
        expect(h.deceased).toBeNull();
    });
});

describe('resolveHousehold — spouse dies first', () => {
    // Spouse lives to 80 → gone from clock age 85 onward.
    const plan = { ...couple, spouseLifeExpectancy: 80 };

    it('collapses to a single filer the year after the spouse dies', () => {
        const h = resolveHousehold(85, plan);
        expect(h.deceased).toBe('spouse');
        expect(h.filingStatus).toBe('single');
        // The primary is the survivor, so the tax code still looks at the clock.
        expect(h.filerAge).toBe(85);
        // undefined is what collapses the two-person tax/healthcare tracks to one.
        expect(h.spouseAge).toBeUndefined();
        expect(h.spendingFactor).toBe(SURVIVOR_SPENDING_FACTOR);
        expect(h.rmdAge).toBe(85);
    });

    it('still had both spouses the year before', () => {
        const h = resolveHousehold(84, plan);
        expect(h.deceased).toBeNull();
        expect(h.filingStatus).toBe('married_joint');
        expect(h.spouseAge).toBe(80);
    });
});

describe('resolveHousehold — primary dies first', () => {
    // Primary lives to 90; spouse to 94 → survives to clock age 98.
    const plan = { ...couple, spouseLifeExpectancy: 94 };

    it('moves the filer role onto the surviving spouse', () => {
        const h = resolveHousehold(95, plan);
        expect(h.deceased).toBe('primary');
        expect(h.primaryAlive).toBe(false);
        expect(h.filingStatus).toBe('single');
        // The clock reads 95, but the living person is 91 — the tax code must see 91.
        expect(h.filerAge).toBe(91);
        expect(h.spouseAge).toBeUndefined();
        // Notional age survives death so the survivor benefit can keep its COLA.
        expect(h.spouseAgeNotional).toBe(91);
        expect(h.spendingFactor).toBe(SURVIVOR_SPENDING_FACTOR);
    });

    it('keys the RMD to the survivor, not the dead primary', () => {
        expect(resolveHousehold(95, plan).rmdAge).toBe(91);
    });

    it('runs the clock past the primary death without disturbing it', () => {
        // The clock is only retirementAge + n; it keeps counting so that phases and
        // pension start ages stay in the frame the user typed them in.
        expect(resolveHousehold(98, plan).filerAge).toBe(94);
        expect(resolveHousehold(98, plan).deceased).toBe('primary');
    });
});

describe('resolveHousehold — simultaneous deaths', () => {
    it('never fires a survivor transition when both die the same year', () => {
        // Spouse's 86 coincides with the primary's 90 (the legacy default).
        const plan = { ...couple, spouseLifeExpectancy: 86 };
        for (let age = 60; age <= simulationHorizon(plan); age++) {
            expect(resolveHousehold(age, plan).deceased).toBeNull();
        }
    });
});
