// src/lib/constants.ts

import type {
    CareType,
    LongTermCareScenario,
    SocialSecurity,
    SpouseWork,
    USState,
    UserInputs,
} from '@/types';

/**
 * Seed values for a spouse's Social Security, applied when the user first switches
 * to married-filing-jointly. Mirrors the primary defaults so the couple starts from
 * a sensible, editable baseline.
 */
export const DEFAULT_SPOUSE_SOCIAL_SECURITY: SocialSecurity = {
    monthlyBenefitAtFRA: 1200,
    claimingAge: 67,
    colaRate: 0.030,
    taxablePercentage: 0.85,
};

/** Spouse's age the year the primary retires, seeded when the user first switches to
 *  married-filing-jointly. A sensible, editable baseline (spouse a couple years younger). */
export const DEFAULT_SPOUSE_AGE_AT_RETIREMENT = 56;

/**
 * Seed for the spouse's own earned income, switched OFF.
 *
 * The ages are the SPOUSE'S OWN, not the household clock — the common shape is a younger
 * spouse who keeps working until their own early sixties after the primary has retired.
 * Zero income so nothing changes until the user fills it in.
 */
export const DEFAULT_SPOUSE_WORK: SpouseWork = {
    enabled: false,
    annualIncome: 0,
    startAge: DEFAULT_SPOUSE_AGE_AT_RETIREMENT,
    endAge: 62,
};

/**
 * Share of the couple's living expenses the survivor still spends after the first
 * death.
 *
 * Emphatically NOT 0.5. Housing, utilities, property tax, insurance, and
 * maintenance barely move when a household goes from two people to one; only the
 * genuinely per-person costs (food, clothing, a second car, travel for two) fall
 * away. Planning literature and the ~consumption-equivalence scales behind it put
 * a survivor's needs near 70-80% of the couple's. 0.75 sits in the middle of that
 * band and is deliberately on the cautious side of halving.
 *
 * Healthcare is NOT covered by this factor — it is already modeled per person, so
 * the second track simply stops. This applies to phase-based living expenses only;
 * one-time expenses are discrete planned events (a roof, a car) and are left alone.
 */
export const SURVIVOR_SPENDING_FACTOR = 0.75;

// ─── Long-term care ───────────────────────────────────────────────────────────
//
// Approximate 2024 national medians, annualized (Genworth Cost of Care survey).
// EDITABLE DEFAULTS, not facts: regional variance is roughly 3x (Louisiana vs
// Connecticut), and these should be re-checked against the current survey rather
// than trusted indefinitely. The user can override the cost directly.
export const LTC_ANNUAL_COSTS: Record<CareType, number> = {
    none: 0,
    adult_day: 25_000,
    home_health: 78_000,
    assisted_living: 71_000,
    nursing_home_semi: 111_000,
    nursing_home_private: 128_000,
};

export const LTC_CARE_TYPE_LABELS: Record<CareType, string> = {
    none: 'No care',
    adult_day: 'Adult day care',
    home_health: 'Home health aide',
    assisted_living: 'Assisted living',
    nursing_home_semi: 'Nursing home (semi-private)',
    nursing_home_private: 'Nursing home (private room)',
};

/**
 * Care types where the person LIVES at the facility, so its fee already covers the
 * housing and food their household budget was paying for. Home-based care does not
 * displace those costs — they still live at home and eat there.
 */
export const LTC_FACILITY_CARE_TYPES: ReadonlySet<CareType> = new Set<CareType>([
    'assisted_living',
    'nursing_home_semi',
    'nursing_home_private',
]);

/**
 * Long-term care has historically inflated faster than general prices, so it gets its
 * own rate — the same treatment healthcare already has.
 */
export const LTC_DEFAULT_INFLATION = 0.045;

/**
 * Share of a ONE-PERSON household's living expenses absorbed when that person enters
 * a facility. Not 1.0: a home is often kept (upkeep, insurance, property tax) during
 * a facility stay, and personal spending continues. The remainder is deliberately
 * generous to the plan's downside.
 *
 * For a COUPLE the offset is not this number — it is derived from
 * SURVIVOR_SPENDING_FACTOR so the two cannot drift apart. See `livingExpenseOffset`
 * in longTermCare.ts.
 */
export const LTC_SOLO_FACILITY_OFFSET = 0.60;

/**
 * Seed scenario, switched OFF. A new plan therefore computes identically to one from
 * before this feature existed until the user deliberately turns the stress test on.
 *
 * The seeded episode is 3 years of assisted living for the primary — near the upper
 * end of the typical paid-care duration, which is the range worth testing against.
 */
export const DEFAULT_LONG_TERM_CARE: LongTermCareScenario = {
    enabled: false,
    primary: {
        careType: 'assisted_living',
        durationYears: 3,
        annualCost: LTC_ANNUAL_COSTS.assisted_living,
    },
    spouse: {
        careType: 'none',
        durationYears: 0,
        annualCost: 0,
    },
    costInflationRate: LTC_DEFAULT_INFLATION,
};

/**
 * Named starting points so nobody has to invent numbers. Durations sit where the risk
 * actually is: the widely-quoted "70% will need care" sweeps in brief and unpaid
 * episodes, while what breaks retirements is the ~15-20% needing 5+ years of paid care.
 */
export const LTC_PRESETS: ReadonlyArray<{
    id: string;
    label: string;
    description: string;
    apply: (isMFJ: boolean) => LongTermCareScenario;
}> = [
    {
        id: 'assisted_3y_one',
        label: '3 years assisted living, one of you',
        description: 'A common, moderate episode near the upper end of typical paid-care duration.',
        apply: () => ({
            enabled: true,
            primary: { careType: 'assisted_living', durationYears: 3, annualCost: LTC_ANNUAL_COSTS.assisted_living },
            spouse: { careType: 'none', durationYears: 0, annualCost: 0 },
            costInflationRate: LTC_DEFAULT_INFLATION,
        }),
    },
    {
        id: 'nursing_4y_one',
        label: '4 years nursing home, one of you',
        description: 'The tail case that breaks plans — roughly the 15-20% scenario.',
        apply: () => ({
            enabled: true,
            primary: { careType: 'nursing_home_semi', durationYears: 4, annualCost: LTC_ANNUAL_COSTS.nursing_home_semi },
            spouse: { careType: 'none', durationYears: 0, annualCost: 0 },
            costInflationRate: LTC_DEFAULT_INFLATION,
        }),
    },
    {
        id: 'home_5y_one',
        label: '5 years home health aide, one of you',
        description: 'Aging in place. Housing costs continue, so nothing is displaced.',
        apply: () => ({
            enabled: true,
            primary: { careType: 'home_health', durationYears: 5, annualCost: LTC_ANNUAL_COSTS.home_health },
            spouse: { careType: 'none', durationYears: 0, annualCost: 0 },
            costInflationRate: LTC_DEFAULT_INFLATION,
        }),
    },
    {
        id: 'both_assisted',
        label: 'Both of you need care',
        description: 'Two episodes of assisted living. Only meaningful for couples.',
        apply: (isMFJ) => ({
            enabled: true,
            primary: { careType: 'assisted_living', durationYears: 3, annualCost: LTC_ANNUAL_COSTS.assisted_living },
            spouse: isMFJ
                ? { careType: 'assisted_living', durationYears: 3, annualCost: LTC_ANNUAL_COSTS.assisted_living }
                : { careType: 'none', durationYears: 0, annualCost: 0 },
            costInflationRate: LTC_DEFAULT_INFLATION,
        }),
    },
];

export const US_STATES: { value: USState; label: string }[] = [
    { value: 'AL', label: 'Alabama' },
    { value: 'AK', label: 'Alaska' },
    { value: 'AZ', label: 'Arizona' },
    { value: 'AR', label: 'Arkansas' },
    { value: 'CA', label: 'California' },
    { value: 'CO', label: 'Colorado' },
    { value: 'CT', label: 'Connecticut' },
    { value: 'DE', label: 'Delaware' },
    { value: 'FL', label: 'Florida' },
    { value: 'GA', label: 'Georgia' },
    { value: 'HI', label: 'Hawaii' },
    { value: 'ID', label: 'Idaho' },
    { value: 'IL', label: 'Illinois' },
    { value: 'IN', label: 'Indiana' },
    { value: 'IA', label: 'Iowa' },
    { value: 'KS', label: 'Kansas' },
    { value: 'KY', label: 'Kentucky' },
    { value: 'LA', label: 'Louisiana' },
    { value: 'ME', label: 'Maine' },
    { value: 'MD', label: 'Maryland' },
    { value: 'MA', label: 'Massachusetts' },
    { value: 'MI', label: 'Michigan' },
    { value: 'MN', label: 'Minnesota' },
    { value: 'MS', label: 'Mississippi' },
    { value: 'MO', label: 'Missouri' },
    { value: 'MT', label: 'Montana' },
    { value: 'NE', label: 'Nebraska' },
    { value: 'NV', label: 'Nevada' },
    { value: 'NH', label: 'New Hampshire' },
    { value: 'NJ', label: 'New Jersey' },
    { value: 'NM', label: 'New Mexico' },
    { value: 'NY', label: 'New York' },
    { value: 'NC', label: 'North Carolina' },
    { value: 'ND', label: 'North Dakota' },
    { value: 'OH', label: 'Ohio' },
    { value: 'OK', label: 'Oklahoma' },
    { value: 'OR', label: 'Oregon' },
    { value: 'PA', label: 'Pennsylvania' },
    { value: 'RI', label: 'Rhode Island' },
    { value: 'SC', label: 'South Carolina' },
    { value: 'SD', label: 'South Dakota' },
    { value: 'TN', label: 'Tennessee' },
    { value: 'TX', label: 'Texas' },
    { value: 'UT', label: 'Utah' },
    { value: 'VT', label: 'Vermont' },
    { value: 'VA', label: 'Virginia' },
    { value: 'WA', label: 'Washington' },
    { value: 'WV', label: 'West Virginia' },
    { value: 'WI', label: 'Wisconsin' },
    { value: 'WY', label: 'Wyoming' },
    { value: 'DC', label: 'District of Columbia' },
];

export const DEFAULT_VALUES: UserInputs = {
    personal: {
        retirementAge: 58,
        lifeExpectancy: 90,
        state: 'GA',
        filingStatus: 'single',
    },
    phases: [
        { name: 'go_go', startAge: 58, endAge: 74, annualSpending: 50000 },
        { name: 'slow_go', startAge: 75, endAge: 85, annualSpending: 40000 },
        { name: 'no_go', startAge: 86, endAge: 90, annualSpending: 36000 },
    ],
    oneTimeExpenses: [],
    accounts: {
        taxDeferred: {  // e.g., Traditional IRA, 401(k)
            balanceAtRetirement: 300000,
            expectedReturnRate: 0.07,
        },
        roth: {         // e.g., Roth IRA, Roth 401(k)
            balanceAtRetirement: 300000,
            expectedReturnRate: 0.08,
        },
        taxable: {      // e.g., Brokerage Account
            balanceAtRetirement: 200000,
            expectedReturnRate: 0.08,
            costBasisPercentage: 0.70,
        },        
        hsa: {  // HSA Account (Health Savings Account)
            balanceAtRetirement: 150000,       // Typical HSA balance for someone retiring at 58
            expectedReturnRate: 0.06,          // Conservative growth (similar to tax-deferred)
            allowNonMedicalAfter65: false,      // Keep HSA for healthcare only (instead of Allowing general withdrawals after 65)
        },
    },
    withdrawalStrategy: {
        priorityOrder: ['taxable', 'tax_deferred', 'roth'],
        // Note: HSA is not in priority order - it's ALWAYS used first for healthcare
        // Tax-smart sequencing is the recommended default: it fills the standard-deduction
        // floor with tax-deferred draws in the gap years, then follows priorityOrder.
        strategy: 'tax_smart',
    },
    income: {
        socialSecurity: {
            monthlyBenefitAtFRA: 2400,
            claimingAge: 67,
            colaRate: 0.030,
            taxablePercentage: 0.85,
        },
        pensions: [],
        partTimeWork: {
            enabled: false,
            annualIncome: 0,
            startAge: 62,
            endAge: 70,
        },
        rentalIncome: {
            enabled: false,
            annualNetIncome: 0,
            startAge: 60,
            endAge: null,
            inflationAdjusted: true,
        },
    },
    healthcare: {
        preMedicare: {
            monthlyPremium: 900,
            annualOutOfPocket: 3000,
        },
        medicare: {
            partBStandardPremium: 200,
            partDPremium: 55,
            expectIRMAA: false,
            irmaaSurcharge: 0,
            medigapPremium: 215,
            outOfPocketByPhase: {
                phase1: 4000,
                phase2: 6500,
                phase3: 12000,
            },
        },
    },
    tax: {
        // Marginal rate applied to taxable income ABOVE the standard deduction
        // (the model now handles deductions + the SS provisional formula itself).
        // 12% reflects a typical retiree's top federal bracket. For a state the engine
        // models this is federal-only; otherwise add a few points for a state that
        // actually taxes retirement income (docs/5-state-tax-model.md §2 Rule 2).
        combinedEffectiveRate: 0.12,
        // New scenarios let the engine compute state tax for the states it models, which
        // makes the rate above federal-only. Scenarios saved before this existed load as
        // 'manual' so they keep computing exactly as they did (see scenarioStorage.ts).
        stateTaxMode: 'modeled',
    },
    simulation: {
        numberOfRuns: 10000,
        generalInflationRate: 0.03,
        healthcareInflationRate: 0.03,
        returnStdDeviation: 0.17,
    },
    longTermCare: DEFAULT_LONG_TERM_CARE,
    mode: 'basic',
};