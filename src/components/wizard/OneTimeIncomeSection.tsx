// src/components/wizard/OneTimeIncomeSection.tsx
//
// One-off cash inflows — the mirror image of one-time expenses. The motivating case is
// home equity: this tool models no house, so downsizing or selling has to be entered as
// a lump sum on the year it lands.

import { useInputs } from '@/contexts/InputsContext';
import { CurrencyField } from '@/components/common/CurrencyField';
import { CollapsibleHelpPanel } from '@/components/common/CollapsibleHelpPanel';
import { Trash2 } from 'lucide-react';
import { simulationHorizon } from '@/lib/calculations/household';

export function OneTimeIncomeSection() {
    const {
        inputs,
        addOneTimeIncome,
        removeOneTimeIncome,
        updateOneTimeIncome,
    } = useInputs();

    const { personal } = inputs;
    const entries = inputs.oneTimeIncome ?? [];
    const horizon = simulationHorizon(personal);

    const handleAdd = () => {
        addOneTimeIncome({
            id: Date.now().toString(),
            description: 'Sell the house',
            amount: 300_000,
            // Default to the No-Go phase, which is when downsizing most often happens.
            age: Math.min(horizon, Math.max(personal.retirementAge, inputs.phases[2].startAge)),
        });
    };

    return (
        <div className="border-t pt-6 space-y-4">
            <div className="flex items-start justify-between gap-4">
                <div>
                    <h3 className="text-lg font-semibold">One-Time Income</h3>
                    <p className="text-sm text-gray-600 mt-1">
                        Money arriving in a single year — selling or downsizing the house, an
                        inheritance, a gift. Spent first; whatever is left over is reinvested.
                    </p>
                </div>
                <button
                    type="button"
                    onClick={handleAdd}
                    className="px-3 py-1.5 text-sm border rounded-md hover:bg-gray-50 focus:ring-2 focus:ring-blue-500 shrink-0"
                >
                    + Add
                </button>
            </div>

            {entries.length === 0 ? (
                <p className="text-sm text-gray-500 italic">
                    None. If you plan to sell the house, add it here — the simulator models no
                    home equity otherwise.
                </p>
            ) : (
                <div className="space-y-3">
                    {entries.map((entry) => (
                        <div key={entry.id} className="flex flex-wrap items-end gap-3 border rounded-lg p-3">
                            <div className="flex-1 min-w-[10rem]">
                                <label className="block text-sm font-medium mb-1">Description</label>
                                <input
                                    type="text"
                                    value={entry.description}
                                    onChange={(e) => updateOneTimeIncome(entry.id, { description: e.target.value })}
                                    className="w-full px-3 py-2 border rounded-md focus:ring-2 focus:ring-blue-500"
                                    placeholder="Sell the house"
                                />
                            </div>
                            <div className="w-40">
                                <CurrencyField
                                    label="Amount"
                                    value={entry.amount}
                                    onChange={(amount) => updateOneTimeIncome(entry.id, { amount })}
                                    step={5000}
                                />
                            </div>
                            <div className="w-24">
                                <label className="block text-sm font-medium mb-1">Age</label>
                                <input
                                    type="number"
                                    value={entry.age}
                                    onChange={(e) =>
                                        updateOneTimeIncome(entry.id, {
                                            age: parseInt(e.target.value) || personal.retirementAge,
                                        })
                                    }
                                    className="w-full px-3 py-2 border rounded-md bg-white text-center focus:ring-2 focus:ring-blue-500"
                                    min={personal.retirementAge}
                                    max={horizon}
                                />
                            </div>
                            <button
                                type="button"
                                onClick={() => removeOneTimeIncome(entry.id)}
                                aria-label={`Remove ${entry.description || 'entry'}`}
                                className="p-2 text-gray-400 hover:text-red-600"
                            >
                                <Trash2 className="w-4 h-4" />
                            </button>
                        </div>
                    ))}
                </div>
            )}

            <CollapsibleHelpPanel title="How this is treated" variant="info">
                <ul className="space-y-1 ml-4 list-disc">
                    <li>
                        Entered in <strong>today&apos;s dollars</strong> and inflated forward like every
                        other figure, so a house &quot;worth $400k today&quot; is worth more when sold at
                        80. Housing does not really track general inflation, but one rate keeps this
                        on the same footing as the rest of the plan.
                    </li>
                    <li>
                        <strong>Treated as tax-free.</strong> That is right for the usual cases: a
                        home sale is mostly a return of what you paid, and the $250k single /
                        $500k married exclusion covers the gain on most long-held homes.
                        Inheritances and gifts are not income to you either.
                    </li>
                    <li>
                        If your windfall <strong>is</strong> taxable — a business sale, gain above that
                        exclusion, an inherited IRA — enter the amount you keep <strong>after</strong>{' '}
                        tax. The simulator will not compute it for you.
                    </li>
                    <li>
                        Selling the house does not reduce your spending here. If you expect to spend
                        less afterwards, lower the phase spending as well; if you will rent, that
                        rent is part of your ordinary spending.
                    </li>
                </ul>
            </CollapsibleHelpPanel>
        </div>
    );
}
