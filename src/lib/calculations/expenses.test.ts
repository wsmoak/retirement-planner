// src/lib/calculations/expenses.test.ts

import { describe, it, expect } from 'vitest';
import { calculateHealthcareCosts, calculateYearlyExpenses } from './expenses';
import type { PreMedicareCosts, MedicareCosts, RetirementPhase } from '@/types';

// Simple fixtures with a 0% healthcare-inflation default so expected values are exact;
// the inflation test below sets a nonzero rate deliberately.
const PRE_MED: PreMedicareCosts = { monthlyPremium: 1000, annualOutOfPocket: 2000 };
// Medicare monthly = 200 + 50 + 250 = 500 → $6,000/yr premiums.
const MED: MedicareCosts = {
    partBStandardPremium: 200,
    partDPremium: 50,
    medigapPremium: 250,
    expectIRMAA: false,
    irmaaSurcharge: 0,
    outOfPocketByPhase: { phase1: 3000, phase2: 5000, phase3: 8000 },
};
const PHASES: [RetirementPhase, RetirementPhase, RetirementPhase] = [
    { name: 'go_go', startAge: 60, endAge: 74, annualSpending: 60_000 },
    { name: 'slow_go', startAge: 75, endAge: 85, annualSpending: 50_000 },
    { name: 'no_go', startAge: 86, endAge: 95, annualSpending: 40_000 },
];

describe('calculateHealthcareCosts — two-track (MFJ) healthcare', () => {
    it('single filer (no spouseAge): one pre-Medicare track', () => {
        const r = calculateHealthcareCosts(60, 60, PRE_MED, MED, PHASES, 0);
        expect(r.premiums).toBe(12_000);
        expect(r.outOfPocket).toBe(2_000);
        expect(r.total).toBe(14_000);
    });

    it('MFJ, both spouses pre-Medicare: costs exactly double (equal per-person)', () => {
        const r = calculateHealthcareCosts(60, 60, PRE_MED, MED, PHASES, 0, 60);
        expect(r.premiums).toBe(24_000);
        expect(r.outOfPocket).toBe(4_000);
    });

    it('MFJ, mixed timelines: your Medicare track + spouse pre-Medicare track', () => {
        // You 66 (Medicare, go_go phase); spouse 63 (still pre-Medicare).
        const r = calculateHealthcareCosts(66, 60, PRE_MED, MED, PHASES, 0, 63);
        // You: $6,000 premiums + $3,000 OOP (go_go). Spouse: $12,000 + $2,000.
        expect(r.premiums).toBe(18_000);
        expect(r.outOfPocket).toBe(5_000);
    });

    it('inflates each track from its own clock: Medicare from 65, pre-Medicare from retirement', () => {
        // You 70 (Medicare, 5 yrs past 65); spouse 63 (pre-Medicare, 10 calendar yrs since
        // retirement at age 60). Rate 5%.
        const r = calculateHealthcareCosts(70, 60, PRE_MED, MED, PHASES, 0.05, 63);
        const you = 6_000 * 1.05 ** 5 + 3_000 * 1.05 ** 5; // premium + go_go OOP
        const spouse = 12_000 * 1.05 ** 10 + 2_000 * 1.05 ** 10;
        expect(r.total).toBeCloseTo(you + spouse, 4);
    });
});

describe('calculateYearlyExpenses — spouseAge wiring', () => {
    it('passing spouseAge adds the second healthcare track to the total', () => {
        const single = calculateYearlyExpenses(60, 60, PHASES, [], PRE_MED, MED, 0.03, 0);
        const couple = calculateYearlyExpenses(60, 60, PHASES, [], PRE_MED, MED, 0.03, 0, 60);
        expect(couple.healthcarePremiums).toBeCloseTo(single.healthcarePremiums * 2, 4);
        expect(couple.healthcareOutOfPocket).toBeCloseTo(single.healthcareOutOfPocket * 2, 4);
        // Living + one-time are unchanged; only healthcare doubles.
        expect(couple.living).toBe(single.living);
    });
});

describe('calculateHealthcareCosts — per-person pre-Medicare costs', () => {
    it('REGRESSION: omitting the spouse figures charges both at the primary rate', () => {
        const shared = calculateHealthcareCosts(60, 60, PRE_MED, MED, PHASES, 0, 58);
        const explicit = calculateHealthcareCosts(60, 60, PRE_MED, MED, PHASES, 0, 58, 60, PRE_MED);
        expect(explicit.premiums).toBeCloseTo(shared.premiums, 10);
        expect(explicit.outOfPocket).toBeCloseTo(shared.outOfPocket, 10);
    });

    it('bills each spouse their own premium', () => {
        const spouseCosts: PreMedicareCosts = { monthlyPremium: 250, annualOutOfPocket: 500 };
        const r = calculateHealthcareCosts(60, 60, PRE_MED, MED, PHASES, 0, 58, 60, spouseCosts);
        // 1000/mo + 250/mo = 15,000/yr, not 2 x 12,000.
        expect(r.premiums).toBeCloseTo(1000 * 12 + 250 * 12, 6);
        expect(r.outOfPocket).toBeCloseTo(2000 + 500, 6);
    });

    it('switches to the second stage at that person\'s own change age', () => {
        const staged: PreMedicareCosts = {
            monthlyPremium: 250,
            annualOutOfPocket: 500,
            secondStage: { startAge: 60, monthlyPremium: 1100, annualOutOfPocket: 3000 },
        };
        // Spouse aged 59 — still on the cheap plan.
        const before = calculateHealthcareCosts(65, 60, PRE_MED, MED, PHASES, 0, 59, 65, staged);
        // Spouse aged 60 — switched to individual cover.
        const after = calculateHealthcareCosts(66, 60, PRE_MED, MED, PHASES, 0, 60, 66, staged);
        // The primary is 65+ in both, so on Medicare; the change is entirely the spouse's.
        expect(after.premiums - before.premiums).toBeCloseTo((1100 - 250) * 12, 6);
        expect(after.outOfPocket - before.outOfPocket).toBeCloseTo(3000 - 500, 6);
    });

    it('models the staggered-retirement case end to end', () => {
        // You retire at 60 and ride your spouse's employer plan for $250/mo until Medicare.
        // Your spouse (5 years younger) pays that same deduction while working, then buys
        // individual cover at $1,100/mo when they retire at 60 — the year you turn 65.
        const you: PreMedicareCosts = { monthlyPremium: 250, annualOutOfPocket: 500 };
        const spouse: PreMedicareCosts = {
            monthlyPremium: 250,
            annualOutOfPocket: 500,
            secondStage: { startAge: 60, monthlyPremium: 1100, annualOutOfPocket: 3000 },
        };
        const at = (clockAge: number) =>
            calculateHealthcareCosts(clockAge, 60, you, MED, PHASES, 0, clockAge - 5, clockAge, spouse);

        // Clock 62: you 62 (employer plan), spouse 57 and still working — both cheap.
        expect(at(62).premiums).toBeCloseTo(250 * 12 * 2, 6);
        // Clock 65: you on Medicare ($6,000), spouse 60 and now on individual cover.
        expect(at(65).premiums).toBeCloseTo(6000 + 1100 * 12, 6);
        // Clock 70: both on Medicare.
        expect(at(70).premiums).toBeCloseTo(6000 * 2, 6);
    });
});
