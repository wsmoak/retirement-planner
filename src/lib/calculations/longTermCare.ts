// src/lib/calculations/longTermCare.ts

import type { LongTermCareScenario, PersonCare, PersonalInfo } from '@/types';
import {
    LTC_FACILITY_CARE_TYPES,
    LTC_SOLO_FACILITY_OFFSET,
    SURVIVOR_SPENDING_FACTOR,
} from '@/lib/constants';
import { resolveSpouseLifeExpectancy, type HouseholdComposition } from '@/lib/calculations/household';

/**
 * Long-term care for one simulated year.
 *
 * ── Why this is a stress test, not a probability ──────────────────────────────
 * Every other risk in this engine that varies run to run is a market return. LTC is
 * deliberately NOT drawn per run, even though it is the largest single retirement
 * risk, because the distributions are far weaker than the return data: incidence
 * rests on surveys with a definitional problem at the core ("needing care" spans
 * help with buttons to locked memory care), the mix is shifting as home care
 * substitutes for facilities, care need correlates with mortality and with the
 * spouse's own health in ways this engine does not model, and a healthy spouse
 * providing unpaid care — the largest real-world offset — is not represented at all.
 *
 * A draw would also override what the user actually knows: family history, a
 * diagnosis, an owned policy, children nearby. So the user picks a scenario and the
 * app reports it as a delta against a clean baseline. See
 * ~/Ideas/retirement-planner-long-term-care.md for the full argument.
 */
export interface CareStatus {
    primaryInCare: boolean;
    spouseInCare: boolean;
    /** Whether anyone is receiving care this year. */
    anyCare: boolean;
    /** This year's total care cost for the household, inflated. */
    annualCost: number;
    /**
     * Fraction of household living expenses displaced by facility care, because a
     * facility's fee already covers the housing and food the household budget was
     * paying for. Zero for home-based care — they still live at home and eat there.
     */
    livingExpenseOffset: number;
}

export const NO_CARE: CareStatus = {
    primaryInCare: false,
    spouseInCare: false,
    anyCare: false,
    annualCost: 0,
    livingExpenseOffset: 0,
};

/**
 * True when `personAge` falls inside the care window: the FINAL `durationYears`
 * of a life ending at `deathAge`.
 *
 * Anchored to death rather than to an absolute start age because care almost always
 * precedes death. A duration longer than the remaining plan simply starts the care
 * earlier; it never runs past the death year, so it can never disagree with the
 * survivor transition.
 */
function inCareWindow(personAge: number, deathAge: number, care: PersonCare): boolean {
    if (care.careType === 'none' || care.durationYears <= 0) return false;
    return personAge > deathAge - care.durationYears && personAge <= deathAge;
}

/** Care cost for one person this year, inflated from retirement-year dollars. */
function personCost(care: PersonCare, inflationFactor: number): number {
    return care.annualCost * inflationFactor;
}

/**
 * Resolves who is receiving care this year and what it costs.
 *
 * @param currentAge - The household clock (see household.ts — never re-based)
 * @param personal - Plan personal inputs, for the two death ages
 * @param household - This year's survivorship state
 * @param ltc - The care scenario; undefined or disabled yields NO_CARE
 * @param yearsSinceRetirement - Drives LTC cost inflation
 */
export function resolveCare(
    currentAge: number,
    personal: PersonalInfo,
    household: HouseholdComposition,
    ltc: LongTermCareScenario | undefined,
    yearsSinceRetirement: number
): CareStatus {
    if (!ltc || !ltc.enabled) return NO_CARE;

    const inflationFactor = Math.pow(1 + ltc.costInflationRate, Math.max(0, yearsSinceRetirement));

    // A dead person receives no care. `inCareWindow` already ends the window at the
    // death age, but the alive checks keep this true even if inputs disagree.
    const primaryInCare =
        household.primaryAlive && inCareWindow(currentAge, personal.lifeExpectancy, ltc.primary);

    const spouseLifeExpectancy = resolveSpouseLifeExpectancy(personal);
    const spouseAlive = household.spouseAgeNotional !== undefined && household.deceased !== 'spouse';
    const spouseInCare =
        ltc.spouse !== undefined &&
        spouseAlive &&
        spouseLifeExpectancy !== undefined &&
        household.spouseAgeNotional !== undefined &&
        inCareWindow(household.spouseAgeNotional, spouseLifeExpectancy, ltc.spouse);

    const annualCost =
        (primaryInCare ? personCost(ltc.primary, inflationFactor) : 0) +
        (spouseInCare && ltc.spouse ? personCost(ltc.spouse, inflationFactor) : 0);

    return {
        primaryInCare,
        spouseInCare,
        anyCare: primaryInCare || spouseInCare,
        annualCost,
        livingExpenseOffset: livingExpenseOffset(household, ltc, primaryInCare, spouseInCare),
    };
}

/**
 * How much of the household's living expenses a facility stay displaces.
 *
 * Two cases, and the couple one is DERIVED rather than chosen so it cannot drift
 * away from the survivor model:
 *
 * - **One of two living people in a facility** → `1 − SURVIVOR_SPENDING_FACTOR`.
 *   That is exactly the marginal cost of the second person, so a couple with one
 *   spouse in a facility spends what a one-person household spends. Housing and
 *   utilities do not move; their food and personal spending shift into the fee.
 * - **Every living person in a facility** → `LTC_SOLO_FACILITY_OFFSET`. Not 1.0: a
 *   home is often kept during a stay, and personal spending continues.
 *
 * Home-based care displaces nothing.
 */
function livingExpenseOffset(
    household: HouseholdComposition,
    ltc: LongTermCareScenario,
    primaryInCare: boolean,
    spouseInCare: boolean
): number {
    const primaryInFacility = primaryInCare && LTC_FACILITY_CARE_TYPES.has(ltc.primary.careType);
    const spouseInFacility =
        spouseInCare && ltc.spouse !== undefined && LTC_FACILITY_CARE_TYPES.has(ltc.spouse.careType);

    const inFacility = (primaryInFacility ? 1 : 0) + (spouseInFacility ? 1 : 0);
    if (inFacility === 0) return 0;

    // Living people this year: two while the couple is intact, otherwise one.
    const living = household.deceased === null && household.spouseAge !== undefined ? 2 : 1;

    return inFacility >= living ? LTC_SOLO_FACILITY_OFFSET : 1 - SURVIVOR_SPENDING_FACTOR;
}
