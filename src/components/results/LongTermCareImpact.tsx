// src/components/results/LongTermCareImpact.tsx
//
// The deliverable of the long-term-care stress test: the DELTA, not a single blended
// number. Baseline and stressed run are always shown together, so the success rate the
// user has been reading all along stays visible and comparable.

import type { SimulationResults, UserInputs } from '@/types';
import { formatMoney } from '@/lib/format';
import { LTC_CARE_TYPE_LABELS } from '@/lib/constants';
import { HeartPulse, TrendingDown } from 'lucide-react';

interface Props {
    results: SimulationResults;
    inputs: UserInputs;
}

export function LongTermCareImpact({ results, inputs }: Props) {
    const baseline = results.baselineWithoutCare;
    const ltc = inputs.longTermCare;

    // Nothing to compare against unless a care scenario actually ran.
    if (!baseline || !ltc?.enabled) return null;

    const withCare = results.successRate;
    const without = baseline.successRate;
    const successDrop = without - withCare;

    const medianWith = results.percentiles.p50;
    const medianWithout = baseline.percentiles.p50;
    const medianCost = medianWithout - medianWith;

    const isMFJ = inputs.personal.filingStatus === 'married_joint';
    const describe = (who: 'primary' | 'spouse') => {
        const care = who === 'primary' ? ltc.primary : ltc.spouse;
        if (!care || care.careType === 'none' || care.durationYears <= 0) return null;
        const label = isMFJ ? (who === 'primary' ? 'You' : 'Your spouse') : 'You';
        return `${label}: ${care.durationYears} ${care.durationYears === 1 ? 'year' : 'years'} of ${LTC_CARE_TYPE_LABELS[care.careType].toLowerCase()} (${formatMoney(care.annualCost)}/yr)`;
    };
    const episodes = [describe('primary'), describe('spouse')].filter(Boolean) as string[];

    return (
        <div className="border-2 border-amber-300 bg-amber-50 rounded-xl p-6 space-y-4">
            <div className="flex items-start gap-3">
                <HeartPulse className="w-6 h-6 text-amber-600 shrink-0 mt-0.5" />
                <div>
                    <h3 className="text-lg font-semibold text-amber-900">
                        Long-Term Care Stress Test
                    </h3>
                    <p className="text-sm text-amber-800 mt-1">
                        A scenario you chose, priced against your plan — not a prediction that this
                        will happen.
                    </p>
                </div>
            </div>

            {episodes.length > 0 && (
                <ul className="text-sm text-amber-900 space-y-1 ml-9 list-disc">
                    {episodes.map((e) => <li key={e}>{e}</li>)}
                </ul>
            )}

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div className="bg-white rounded-lg p-4 border border-amber-200">
                    <div className="text-xs uppercase tracking-wide text-gray-500">Without care</div>
                    <div className="text-3xl font-bold text-gray-900 mt-1">
                        {(without * 100).toFixed(0)}%
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                        Median ending: {formatMoney(medianWithout)}
                    </div>
                </div>

                <div className="bg-white rounded-lg p-4 border border-amber-200">
                    <div className="text-xs uppercase tracking-wide text-gray-500">With care</div>
                    <div className="text-3xl font-bold text-amber-700 mt-1">
                        {(withCare * 100).toFixed(0)}%
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                        Median ending: {formatMoney(medianWith)}
                    </div>
                </div>

                <div className="bg-white rounded-lg p-4 border border-amber-200">
                    <div className="text-xs uppercase tracking-wide text-gray-500 flex items-center gap-1">
                        <TrendingDown className="w-3 h-3" /> Impact
                    </div>
                    <div className="text-3xl font-bold text-amber-700 mt-1">
                        −{(successDrop * 100).toFixed(0)} pts
                    </div>
                    <div className="text-xs text-gray-500 mt-1">
                        {medianCost > 0
                            ? `Costs about ${formatMoney(medianCost)} of ending balance`
                            : 'No measurable cost to the median outcome'}
                    </div>
                </div>
            </div>

            <p className="text-sm text-amber-900">
                {successDrop <= 0.02 ? (
                    <>Your plan <strong>absorbs this scenario</strong> with little change. Testing a
                    longer or more expensive episode would tell you where the real limit is.</>
                ) : successDrop < 0.15 ? (
                    <>Your plan takes a <strong>real but survivable</strong> hit from this scenario.</>
                ) : (
                    <>This scenario is a <strong>material risk to the plan.</strong> Worth considering
                    long-term care insurance, a dedicated reserve, or home equity you have not counted.</>
                )}
            </p>

            <p className="text-xs text-amber-800 border-t border-amber-200 pt-3">
                <strong>Read this before acting on it.</strong> Medicare covers no custodial care,
                but Medicaid does after assets are spent down — and it protects part of a surviving
                spouse&apos;s assets and income. A plan that &quot;fails&quot; here transitions to
                Medicaid, not to destitution. Selling a house is how many families actually pay for
                care — there is no home value modeled here, but you can enter the sale as{' '}
                <strong>one-time income</strong> on the Plan step. Left out, both make this estimate
                <strong> pessimistic</strong>; leaving out care entirely would have been far more
                optimistic.
            </p>
        </div>
    );
}
