// src/components/wizard/LongTermCareSection.tsx
//
// Long-term care input. Presented as a STRESS TEST — the user picks a scenario and
// the Results page reports it as a delta against a clean baseline — not as a
// probability folded into the headline number. See longTermCare.ts for why.

import { useInputs } from '@/contexts/InputsContext';
import {
    DEFAULT_LONG_TERM_CARE,
    LTC_ANNUAL_COSTS,
    LTC_CARE_TYPE_LABELS,
    LTC_PRESETS,
} from '@/lib/constants';
import type { CareType, PersonCare } from '@/types';
import { CurrencyField } from '@/components/common/CurrencyField';
import { NumberField } from '@/components/common/NumberField';
import { PercentField } from '@/components/common/PercentField';
import { CollapsibleHelpPanel } from '@/components/common/CollapsibleHelpPanel';

const CARE_TYPES: CareType[] = [
    'none',
    'adult_day',
    'home_health',
    'assisted_living',
    'nursing_home_semi',
    'nursing_home_private',
];

export function LongTermCareSection() {
    const { inputs, updateLongTermCare, setLongTermCare } = useInputs();
    const ltc = inputs.longTermCare ?? DEFAULT_LONG_TERM_CARE;
    const isMFJ = inputs.personal.filingStatus === 'married_joint';

    const updatePerson = (who: 'primary' | 'spouse', data: Partial<PersonCare>) => {
        const current = who === 'primary' ? ltc.primary : (ltc.spouse ?? DEFAULT_LONG_TERM_CARE.spouse!);
        updateLongTermCare({ [who]: { ...current, ...data } });
    };

    // Changing the care type re-seeds the cost, since the whole point of the dropdown is
    // to avoid making people look up what a nursing home costs.
    const changeCareType = (who: 'primary' | 'spouse', careType: CareType) => {
        updatePerson(who, { careType, annualCost: LTC_ANNUAL_COSTS[careType] });
    };

    const personFields = (who: 'primary' | 'spouse', label: string) => {
        const care = who === 'primary' ? ltc.primary : (ltc.spouse ?? DEFAULT_LONG_TERM_CARE.spouse!);
        return (
            <div className="border rounded-lg p-4 space-y-3">
                <h4 className="font-medium text-sm">{label}</h4>
                <div>
                    <label className="block text-sm font-medium mb-1">Type of care</label>
                    <select
                        value={care.careType}
                        onChange={(e) => changeCareType(who, e.target.value as CareType)}
                        className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500"
                    >
                        {CARE_TYPES.map((t) => (
                            <option key={t} value={t}>{LTC_CARE_TYPE_LABELS[t]}</option>
                        ))}
                    </select>
                </div>
                {care.careType !== 'none' && (
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                        <NumberField
                            label="Years of care"
                            value={care.durationYears}
                            onChange={(durationYears) => updatePerson(who, { durationYears })}
                            min={0}
                            max={20}
                            helperText="Modeled as the final years of life"
                        />
                        <CurrencyField
                            label="Annual cost"
                            value={care.annualCost}
                            onChange={(annualCost) => updatePerson(who, { annualCost })}
                            helperText="In today's dollars"
                        />
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="border-t pt-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-lg font-semibold">Long-Term Care Stress Test</h3>
                    <p className="text-sm text-gray-600 mt-1">
                        Assisted living, a nursing home, or care at home. Turn this on and the
                        Results page shows your plan <strong>with and without</strong> it, side by side.
                    </p>
                </div>
                <label className="flex items-center gap-2 shrink-0">
                    <input
                        type="checkbox"
                        checked={ltc.enabled}
                        onChange={(e) => updateLongTermCare({ enabled: e.target.checked })}
                        className="w-4 h-4"
                    />
                    <span className="text-sm font-medium">{ltc.enabled ? 'On' : 'Off'}</span>
                </label>
            </div>

            <div className="bg-amber-50 border border-amber-200 rounded-md p-3">
                <p className="text-sm text-amber-900">
                    This is a <strong>what-if, not a probability.</strong> The app does not guess
                    whether you will need care — you choose a scenario and it prices it. Roughly a
                    third of people never need paid care; what breaks retirement plans is the
                    15–20% who need <strong>five or more years</strong> of it.
                </p>
            </div>

            {ltc.enabled && (
                <>
                    <div>
                        <p className="text-sm font-medium mb-2">Start from a scenario</p>
                        <div className="flex flex-wrap gap-2">
                            {LTC_PRESETS.filter(p => isMFJ || p.id !== 'both_assisted').map((preset) => (
                                <button
                                    key={preset.id}
                                    type="button"
                                    onClick={() => setLongTermCare(preset.apply(isMFJ))}
                                    title={preset.description}
                                    className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50 focus:ring-2 focus:ring-blue-500"
                                >
                                    {preset.label}
                                </button>
                            ))}
                        </div>
                    </div>

                    <div className={`grid grid-cols-1 ${isMFJ ? 'lg:grid-cols-2' : ''} gap-4`}>
                        {personFields('primary', isMFJ ? 'You' : 'Your care')}
                        {isMFJ && personFields('spouse', 'Your spouse')}
                    </div>

                    <div className="max-w-xs">
                        <PercentField
                            label="Care cost inflation"
                            value={ltc.costInflationRate}
                            onChange={(costInflationRate) => updateLongTermCare({ costInflationRate })}
                            min={0}
                            max={0.10}
                            step={0.005}
                            helperText="Care has historically outpaced general inflation"
                        />
                    </div>
                </>
            )}

            <CollapsibleHelpPanel title="What this models — and what it doesn't" variant="info">
                <p><strong>What it does:</strong></p>
                <ul className="space-y-1 ml-4 list-disc">
                    <li>
                        Care occupies the <strong>final years of that person's life</strong>, because
                        care almost always precedes death. It stops automatically at their death.
                    </li>
                    <li>
                        A facility stay <strong>displaces part of your household budget</strong> —
                        the fee already covers housing and food. Care at home displaces nothing.
                    </li>
                    <li>
                        Care is a <strong>deductible medical expense</strong> above 7.5% of income.
                        This is the one year a retiree is likely to itemize, and it substantially
                        cuts the tax on the withdrawals that fund the care.
                    </li>
                    <li>Your HSA pays for care first, tax-free — it is the best source for this.</li>
                </ul>
                <p className="mt-2"><strong>What it doesn't:</strong></p>
                <ul className="space-y-1 ml-4 list-disc">
                    <li>
                        <strong>Medicaid.</strong> Medicare covers no custodial care at all, but
                        Medicaid does once assets are spent down, and it protects a portion of a
                        surviving spouse's assets and income. So "running out" here does not mean
                        destitution — it means a transition this tool does not model.
                    </li>
                    <li>
                        <strong>Home equity.</strong> Care is often funded by selling a house, and
                        this tool models no home equity, so it overstates the damage for homeowners.
                    </li>
                    <li>
                        <strong>Long-term care insurance</strong> and unpaid care from family.
                    </li>
                    <li>
                        <strong>Regional cost differences.</strong> The defaults are national
                        medians; the real spread between the cheapest and priciest states is
                        roughly threefold. Override the cost if you know your area.
                    </li>
                </ul>
            </CollapsibleHelpPanel>
        </div>
    );
}
