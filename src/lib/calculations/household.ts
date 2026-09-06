// src/lib/calculations/household.ts

import type { PersonalInfo } from '@/types';
import { SURVIVOR_SPENDING_FACTOR } from '@/lib/constants';

/**
 * Which member of the couple has died, as of the year being resolved.
 * `null` while both are alive (and always, for a single filer).
 */
export type DeceasedPerson = 'primary' | 'spouse' | null;

/**
 * The household's composition for one simulated year.
 *
 * ── The two roles of "age" ────────────────────────────────────────────────────
 * The simulation loop is keyed to the PRIMARY's age, and that number does double
 * duty in this engine:
 *
 *   1. **The household clock.** Spending phases, one-time expenses, and pension /
 *      rental / part-time start ages are all expressed in the primary's age frame,
 *      because that is the frame the user typed them in ("Go-Go until 75" means
 *      *their* 75).
 *   2. **The primary person's own age.** Their Social Security, their Medicare
 *      timing, their age-65 deduction addition.
 *
 * Per-spouse life expectancy breaks role 2 — the primary may die before the
 * simulation ends — but it must NOT disturb role 1, or every phase boundary and
 * pension start age silently shifts onto the other person's calendar.
 *
 * So the clock is never swapped or re-based. `currentAge` keeps counting past a
 * primary death (it is only `retirementAge + n`), and this struct supplies the
 * person-level facts that the clock can no longer stand in for: who is alive,
 * whose age the tax code should look at, and what the household still spends.
 *
 * Because the whole engine already guards its per-spouse logic on
 * `spouseAge !== undefined`, handing back `undefined` here is what makes taxes,
 * state tax, and healthcare collapse to single-person behavior after a death.
 */
export interface HouseholdComposition {
    /** Filing status THIS year — flips to 'single' the year after the first death. */
    filingStatus: 'single' | 'married_joint';

    /**
     * The living filer's age, for anything the tax code scopes to a person: the
     * age-65 standard-deduction addition, the senior bonus, and the state
     * age-based retirement exclusions (GA/VA/NY/CA).
     *
     * While both are alive this is the primary's age. After a PRIMARY death the
     * survivor is the spouse, so this becomes the spouse's age — otherwise the
     * engine would keep crediting a dead person's age to a living filer.
     */
    filerAge: number;

    /**
     * The spouse's age as the engine's per-spouse logic should see it: their real
     * age while both are alive, `undefined` once the household is down to one
     * person (or was never a couple). Feeding `undefined` is what collapses the
     * two-person tax/healthcare tracks to one.
     */
    spouseAge: number | undefined;

    /**
     * The spouse's age ignoring death — kept for MFJ households even after a death
     * so the *survivor* benefit can keep receiving COLA (a survivor inherits the
     * larger benefit, and that benefit goes on being indexed). `undefined` only
     * for single filers.
     */
    spouseAgeNotional: number | undefined;

    /** False once the household clock passes the primary's life expectancy. */
    primaryAlive: boolean;

    /** Who has died, if anyone. Drives the one shared first-death transition. */
    deceased: DeceasedPerson;

    /**
     * Multiplier on household living expenses. 1 while the household is intact;
     * `SURVIVOR_SPENDING_FACTOR` afterwards. A survivor does not spend half — the
     * house, the car, and the utilities do not halve — so this is well above 0.5.
     */
    spendingFactor: number;

    /**
     * Age governing the pooled RMD trigger. While both are alive this stays the
     * OLDER spouse's age, so the pool starts distributing no later than required.
     * After a death it keys to the survivor alone: a spouse beneficiary may treat
     * an inherited IRA as their own, so the survivor's schedule is the real one.
     */
    rmdAge: number;
}

/**
 * The spouse's own life expectancy, defaulting to the legacy shared horizon.
 *
 * Scenarios saved before this field existed have no value for it. The default
 * reproduces the old behavior EXACTLY — both spouses alive to the primary's life
 * expectancy — by handing back the spouse's age in the year the primary reaches
 * theirs. That keeps every previously saved plan recomputing to the same numbers.
 */
export function resolveSpouseLifeExpectancy(personal: PersonalInfo): number | undefined {
    if (personal.filingStatus !== 'married_joint' || personal.spouseAgeAtRetirement === undefined) {
        return undefined;
    }
    return (
        personal.spouseLifeExpectancy ??
        personal.spouseAgeAtRetirement + (personal.lifeExpectancy - personal.retirementAge)
    );
}

/**
 * The last age (on the household clock) the simulation should run through.
 *
 * The plan has to be funded until the LAST death, not the first — the survivor's
 * years are precisely the ones a shared horizon gets wrong. Expressed in the
 * primary's age frame so the loop bound stays a plain comparison against the
 * clock.
 */
export function simulationHorizon(personal: PersonalInfo): number {
    const spouseLifeExpectancy = resolveSpouseLifeExpectancy(personal);
    if (spouseLifeExpectancy === undefined || personal.spouseAgeAtRetirement === undefined) {
        return personal.lifeExpectancy;
    }
    // Translate the spouse's death out of their own age frame and into the clock's.
    const spouseDeathOnClock =
        personal.retirementAge + (spouseLifeExpectancy - personal.spouseAgeAtRetirement);
    return Math.max(personal.lifeExpectancy, spouseDeathOnClock);
}

/**
 * Resolves who is alive, and what that implies, for one year of the simulation.
 *
 * Death convention: a person lives THROUGH their life-expectancy year and is gone
 * in every year after it. So a life expectancy of 90 means the last year they are
 * counted — for spending, Social Security, healthcare, and the deduction — is the
 * year the clock reads 90.
 *
 * @param currentAge - The household clock (the primary's age this year)
 * @param personal - The plan's personal inputs
 */
export function resolveHousehold(
    currentAge: number,
    personal: PersonalInfo
): HouseholdComposition {
    const isMFJ = personal.filingStatus === 'married_joint';
    const spouseLifeExpectancy = resolveSpouseLifeExpectancy(personal);

    // Single filer (or an MFJ plan with no spouse age recorded): one person, no
    // transition to model. They are alive for every year the loop runs.
    if (!isMFJ || personal.spouseAgeAtRetirement === undefined || spouseLifeExpectancy === undefined) {
        return {
            filingStatus: personal.filingStatus ?? 'single',
            filerAge: currentAge,
            spouseAge: undefined,
            spouseAgeNotional: undefined,
            primaryAlive: true,
            deceased: null,
            spendingFactor: 1,
            rmdAge: currentAge,
        };
    }

    // Both spouses retire the same calendar year, so the age gap is constant and
    // the spouse's age is just the clock plus that gap.
    const spouseAgeNotional =
        personal.spouseAgeAtRetirement + (currentAge - personal.retirementAge);

    const primaryAlive = currentAge <= personal.lifeExpectancy;
    const spouseAlive = spouseAgeNotional <= spouseLifeExpectancy;
    const bothAlive = primaryAlive && spouseAlive;

    // Exactly one of these can be true inside the horizon: the loop stops at the
    // later death, so the pair is never both-dead in a simulated year.
    const deceased: DeceasedPerson = bothAlive ? null : primaryAlive ? 'spouse' : 'primary';

    return {
        // The survivor's penalty in one line: the household files single from here
        // on, with roughly half the standard deduction and compressed brackets.
        filingStatus: bothAlive ? 'married_joint' : 'single',
        filerAge: primaryAlive ? currentAge : spouseAgeNotional,
        spouseAge: bothAlive ? spouseAgeNotional : undefined,
        spouseAgeNotional,
        primaryAlive,
        deceased,
        spendingFactor: bothAlive ? 1 : SURVIVOR_SPENDING_FACTOR,
        rmdAge: bothAlive
            ? Math.max(currentAge, spouseAgeNotional)
            : primaryAlive
                ? currentAge
                : spouseAgeNotional,
    };
}
