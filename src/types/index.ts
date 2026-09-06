// src/types/index.ts

import { YearlyProjection } from '@/lib/calculations/yearlyProjection';

export type USState = 'AL' | 'AK' | 'AZ' | 'AR' | 'CA' | 'CO' | 'CT' | 'DE' | 'FL' | 'GA' |
    'HI' | 'ID' | 'IL' | 'IN' | 'IA' | 'KS' | 'KY' | 'LA' | 'ME' | 'MD' | 'MA' | 'MI' |
    'MN' | 'MS' | 'MO' | 'MT' | 'NE' | 'NV' | 'NH' | 'NJ' | 'NM' | 'NY' | 'NC' | 'ND' |
    'OH' | 'OK' | 'OR' | 'PA' | 'RI' | 'SC' | 'SD' | 'TN' | 'TX' | 'UT' | 'VT' | 'VA' |
    'WA' | 'WV' | 'WI' | 'WY' | 'DC';

export interface PersonalInfo {
    retirementAge: number;
    lifeExpectancy: number;
    state: USState;
    // Optional; the tax model defaults to 'single' when unset.
    filingStatus?: 'single' | 'married_joint';
    // MFJ only: the spouse's age in the year the primary retires. The simulation
    // is driven by the primary's age, so each year the spouse's age is derived as
    // spouseAgeAtRetirement + (currentAge − retirementAge). Used for per-spouse
    // age-65 deduction additions and the (older-spouse) RMD trigger. Couples are
    // modeled with pooled accounts — see docs/2-federal-tax-model.md.
    spouseAgeAtRetirement?: number;
    // MFJ only: the spouse's own life expectancy, in THEIR age frame (not the
    // household clock). Optional: scenarios saved before per-spouse mortality
    // existed have no value, and default to the spouse's age in the year the
    // primary reaches their own life expectancy — i.e. the old shared horizon,
    // so a previously saved plan recomputes to exactly the same numbers.
    // The simulation runs to the LATER of the two deaths, and the first death
    // triggers the survivor transition (MFJ→single, one Social Security check,
    // one healthcare track). See lib/calculations/household.ts.
    spouseLifeExpectancy?: number;
}

export interface RetirementPhase {
    name: 'go_go' | 'slow_go' | 'no_go';
    startAge: number;
    endAge: number;
    annualSpending: number;
}

export interface OneTimeExpense {
    id: string;
    description: string;
    amount: number;
    age: number;
}

/**
 * A one-off cash inflow at a chosen age — the mirror image of a one-time expense.
 *
 * The motivating case is **home equity**: downsizing or selling the house, which this
 * tool otherwise ignores entirely. Also covers an inheritance, a gift, or a business
 * sale. Whatever lands here is spent first and any surplus is reinvested into the
 * taxable account, which is what actually happens to sale proceeds.
 *
 * TREATED AS TAX-FREE. That is right for the dominant cases: a principal-residence
 * sale is mostly a return of basis, and the §121 exclusion ($250k single / $500k MFJ)
 * covers the gain for most long-held homes; inheritances and gifts are not income to
 * the recipient either. For a windfall that IS taxable — a business sale, gain above
 * the §121 exclusion, an inherited IRA — enter the amount you keep AFTER tax.
 */
export interface OneTimeIncome {
    id: string;
    description: string;
    amount: number;
    age: number;
}

export interface InvestmentAccount {
    balanceAtRetirement: number;
    expectedReturnRate: number;
    costBasisPercentage?: number; // Only for taxable accounts
}

export interface HSAAccount {
    balanceAtRetirement: number;
    expectedReturnRate: number;
    allowNonMedicalAfter65: boolean;  // Default: false - healthcare withdrawals after 65 only
}

export interface SocialSecurity {
    monthlyBenefitAtFRA: number;
    claimingAge: number;
    colaRate: number;
    taxablePercentage: number;
}

export interface Pension {
    id: string;
    name: string;
    monthlyAmount: number;
    startAge: number;
    colaRate: number;
    // Government pensions (federal/state/local/military) are fully state-tax-exempt in some
    // modeled states (New York); private pensions get a smaller, capped exclusion instead.
    // Optional so pre-existing saved pensions stay valid — undefined reads as private, the
    // conservative default (it never grants an exemption a pre-existing plan didn't ask for).
    isGovernment?: boolean;
}

export interface PartTimeWork {
    enabled: boolean;
    annualIncome: number;
    startAge: number;
    endAge: number;
}

export interface RentalIncome {
    enabled: boolean;
    annualNetIncome: number;
    startAge: number;
    endAge: number | null;
    inflationAdjusted: boolean;
}

export interface PreMedicareCosts {
    monthlyPremium: number;
    annualOutOfPocket: number;
    /**
     * Optional second stage of pre-Medicare coverage, beginning at `startAge` and
     * running until that person turns 65.
     *
     * Exists because pre-Medicare coverage frequently changes ONCE mid-retirement:
     * a retiree stays on a still-working spouse's employer plan for a modest payroll
     * deduction, and then — when that spouse retires — moves to individual coverage at
     * several times the price. Without this, the whole pre-65 window has to be entered
     * at one figure, which is either too high for the employer-covered years or too low
     * for the individual ones.
     *
     * Omitted for the common case of a single unchanging premium.
     */
    secondStage?: {
        /** The person's own age when coverage changes — usually their retirement age. */
        startAge: number;
        monthlyPremium: number;
        annualOutOfPocket: number;
    };
}

/**
 * Long-term care settings. Modeled as a STRESS TEST, not a probability: the user
 * chooses a scenario and the app reports it as a delta against a clean baseline.
 *
 * Deliberately not stochastic. Incidence and duration distributions are far weaker
 * than the market-return data (survey-based, definition-dependent, shifting as home
 * care substitutes for facilities), care need correlates with mortality and with the
 * spouse's own health in ways this engine does not model, and a draw would override
 * what the user actually knows about their family history. See
 * ~/Ideas/retirement-planner-long-term-care.md.
 */
export type CareType =
    | 'none'
    | 'adult_day'
    | 'home_health'
    | 'assisted_living'
    | 'nursing_home_semi'
    | 'nursing_home_private';

/** One person's care episode. */
export interface PersonCare {
    careType: CareType;
    /**
     * Years of care, occupying the FINAL N years of that person's life.
     *
     * Anchored to death rather than to an absolute age because care almost always
     * precedes death. Keying it to "starting at 85" produces incoherent runs — care
     * ending years before death for no reason, or starting after the person is gone.
     * Anchoring also makes it compose with the survivor transition for free: care
     * stops exactly when they die.
     */
    durationYears: number;
    /** Annual cost in retirement-year dollars, before LTC inflation. */
    annualCost: number;
}

export interface LongTermCareScenario {
    /** Master switch. When false the plan runs exactly as if this feature did not exist. */
    enabled: boolean;
    primary: PersonCare;
    /** MFJ only. */
    spouse?: PersonCare;
    /** LTC has historically outpaced general inflation, so it gets its own rate. */
    costInflationRate: number;
}

export interface MedicareCosts {
    partBStandardPremium: number;
    partDPremium: number;
    expectIRMAA: boolean;
    irmaaSurcharge: number;
    medigapPremium: number;
    outOfPocketByPhase: {
        phase1: number;
        phase2: number;
        phase3: number;
    };
}

export interface TaxSettings {
    combinedEffectiveRate: number;

    /**
     * Whether the engine computes the selected state's income tax itself.
     * - 'manual'  — `combinedEffectiveRate` is federal + state, folded together by the user.
     * - 'modeled' — `combinedEffectiveRate` is FEDERAL ONLY; state tax is computed from
     *               `stateTaxRules.json` for the states we model.
     *
     * Optional so scenarios saved before state tax existed stay valid. The engine and the
     * storage loader default a missing value to 'manual' so an old plan recomputes exactly as
     * it did when it was saved — switching it to 'modeled' would silently tax it twice
     * (state points are already inside its saved rate). New scenarios get 'modeled' from
     * DEFAULT_VALUES. See docs/5-state-tax-model.md.
     */
    stateTaxMode?: 'manual' | 'modeled';
}

export interface SimulationSettings {
    numberOfRuns: 1000 | 5000 | 10000;
    generalInflationRate: number;
    healthcareInflationRate: number;
    returnStdDeviation: number;
}

export interface UserInputs {
    personal: PersonalInfo;
    phases: [RetirementPhase, RetirementPhase, RetirementPhase];
    oneTimeExpenses: OneTimeExpense[];
    /**
     * Optional so scenarios saved before one-time income existed stay valid — a missing
     * value reads as an empty list, which reproduces the old numbers exactly.
     */
    oneTimeIncome?: OneTimeIncome[];
    accounts: {
        taxDeferred: InvestmentAccount;
        roth: InvestmentAccount;
        taxable: InvestmentAccount;
        hsa: HSAAccount;
    };
    withdrawalStrategy: {
        priorityOrder: Array<'taxable' | 'tax_deferred' | 'roth'>;
        // Note: HSA is handled separately - always used first for healthcare

        /**
         * Which sequencing strategy the engine applies:
         * - 'standard'        — spend strictly by priorityOrder (the conventional rule of thumb).
         * - 'tax_smart'       — each gap year, draw tax-deferred up to the standard-deduction
         *                       floor (≈ tax-free), then fall through to priorityOrder. Default.
         * - 'roth_conversion' — tax-smart PLUS Roth conversions in the gap years (Advanced;
         *                       not yet implemented — shown as "coming soon" in the wizard).
         * Optional so pre-existing saved scenarios (which lack it) stay valid; the engine and
         * the storage loader default a missing value to keep old plans faithful to how they
         * were computed.
         */
        strategy?: 'standard' | 'tax_smart' | 'roth_conversion';

        /** Advanced tier only: taxable-income ceiling to convert up to. Unused until Roth conversions ship. */
        conversionCeiling?: number;
    };
    income: {
        socialSecurity: SocialSecurity;
        // MFJ only: the spouse's own Social Security. Summed with the primary's
        // benefit into a single household SS stream before the provisional-income
        // formula. Absent for single filers.
        spouseSocialSecurity?: SocialSecurity;
        pensions: Pension[];
        partTimeWork: PartTimeWork;
        rentalIncome: RentalIncome;
    };
    healthcare: {
        preMedicare: PreMedicareCosts;
        /**
         * MFJ only: the spouse's own pre-Medicare costs. Optional — when absent the
         * spouse uses `preMedicare`, which is exactly how the model behaved before
         * per-person costs existed, so saved scenarios recompute unchanged.
         *
         * Separate because two spouses in the pre-65 window are frequently NOT paying
         * the same thing: one may sit on the other's employer plan for a payroll
         * deduction while the other buys individual coverage. Medicare costs stay
         * shared — Part B and Part D are standard amounts.
         */
        spousePreMedicare?: PreMedicareCosts;
        medicare: MedicareCosts;
    };
    tax: TaxSettings;
    simulation: SimulationSettings;
    /**
     * Optional so scenarios saved before long-term care existed stay valid — a missing
     * value reads as "no care scenario", which reproduces the old numbers exactly.
     */
    longTermCare?: LongTermCareScenario;
    mode: 'basic' | 'advanced';
}

export interface SimulationRun {
    runId: number;
    success: boolean;
    ageOfDepletion: number | null;
    finalBalance: number;
}

export interface SelectedRun {
    runId: number;
    percentile: 'p10' | 'p50' | 'p90';
    projections: YearlyProjection[];
}

export interface SimulationResults {
    timestamp: number;
    numberOfRuns: number;
    successRate: number;

    percentiles: {
        p10: number;
        p25: number;
        p50: number;
        p75: number;
        p90: number;
    };

    failedRuns: {
        count: number;
        medianAgeOfDepletion: number | null;
    };

    selectedRuns: {
        p10: SelectedRun;
        p50: SelectedRun;
        p90: SelectedRun;
    };

    /**
     * The SAME plan with the long-term-care scenario switched off.
     *
     * Present only when a care scenario is active. Long-term care is presented as a
     * stress test whose product is the comparison — "94% → 61%, costing $412k" — not a
     * single blended number, so the baseline has to survive alongside the stressed run.
     *
     * Dropped by `slimResults` when a scenario is saved (it is recomputed on the next
     * run), and never written into the verification bundle.
     */
    baselineWithoutCare?: SimulationResults;

    // Optional fields not needed for storage/comparison
    sampleRuns?: Array<{
        runId: number;
        projections: YearlyProjection[];
    }>;
}