// src/components/wizard/PreMedicareCostFields.tsx
//
// One person's pre-Medicare coverage costs, with an optional second stage.
//
// Two spouses in the pre-65 window are frequently NOT paying the same thing — one can
// sit on the other's employer plan for a payroll deduction while the other buys
// individual coverage — and a single person's cost often changes once, when the plan
// covering them ends. Both facts need their own inputs; a single household figure
// cannot express either.

import type { PreMedicareCosts } from '@/types';
import { CurrencyField } from '@/components/common/CurrencyField';
import { NumberField } from '@/components/common/NumberField';

interface Props {
    title: string;
    /** Age this person is when the simulation starts — the floor for a change age. */
    startAge: number;
    costs: PreMedicareCosts;
    onChange: (data: Partial<PreMedicareCosts>) => void;
}

export function PreMedicareCostFields({ title, startAge, costs, onChange }: Props) {
    const stage = costs.secondStage;

    const toggleSecondStage = (on: boolean) => {
        onChange({
            secondStage: on
                ? {
                    // Default the change to the midpoint of the pre-65 window, which is
                    // roughly where a younger spouse's own retirement tends to land.
                    startAge: Math.min(64, Math.max(startAge + 1, Math.round((startAge + 65) / 2))),
                    monthlyPremium: costs.monthlyPremium,
                    annualOutOfPocket: costs.annualOutOfPocket,
                }
                : undefined,
        });
    };

    const updateStage = (data: Partial<NonNullable<PreMedicareCosts['secondStage']>>) => {
        if (!stage) return;
        onChange({ secondStage: { ...stage, ...data } });
    };

    return (
        <div className="border rounded-lg p-4 space-y-3">
            <h4 className="font-medium text-sm">{title}</h4>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <CurrencyField
                    label={stage ? 'Monthly premium (first stage)' : 'Monthly premium'}
                    value={costs.monthlyPremium}
                    onChange={(monthlyPremium) => onChange({ monthlyPremium })}
                    step={25}
                    helperText={
                        stage
                            ? `Until age ${stage.startAge}`
                            : 'Individual: $600–1,200/mo. On a spouse’s employer plan: far less'
                    }
                />
                <CurrencyField
                    label="Annual out-of-pocket"
                    value={costs.annualOutOfPocket}
                    onChange={(annualOutOfPocket) => onChange({ annualOutOfPocket })}
                    step={100}
                    helperText="Deductibles, copays, prescriptions"
                />
            </div>

            <label className="flex items-center gap-2 text-sm">
                <input
                    type="checkbox"
                    checked={stage !== undefined}
                    onChange={(e) => toggleSecondStage(e.target.checked)}
                    className="w-4 h-4"
                />
                <span>Coverage changes before 65 (e.g. leaving an employer plan)</span>
            </label>

            {stage && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 bg-gray-50 rounded-md p-3">
                    <NumberField
                        label="Changes at age"
                        value={stage.startAge}
                        onChange={(startAge) => updateStage({ startAge })}
                        min={startAge}
                        max={64}
                        helperText="Their own age"
                    />
                    <CurrencyField
                        label="Monthly premium after"
                        value={stage.monthlyPremium}
                        onChange={(monthlyPremium) => updateStage({ monthlyPremium })}
                        step={25}
                        helperText="Until they turn 65"
                    />
                    <CurrencyField
                        label="Out-of-pocket after"
                        value={stage.annualOutOfPocket}
                        onChange={(annualOutOfPocket) => updateStage({ annualOutOfPocket })}
                        step={100}
                        helperText="Per year"
                    />
                </div>
            )}
        </div>
    );
}
