import { describe, expect, it } from 'vitest';
import {
  estimateResourceImpact,
  formatResourceImpact,
  formatResourceImpactReport,
} from './resourceImpact';

describe('resource impact estimate', () => {
  it('uses the documented energy and water ranges', () => {
    const impact = estimateResourceImpact(1_000_000);
    expect(impact.energyWhLow).toBeCloseTo(83.333, 3);
    expect(impact.energyWhHigh).toBeCloseTo(416.667, 3);
    expect(impact.waterMlLow).toBeCloseTo(22.5, 3);
    expect(impact.waterMlHigh).toBeCloseTo(450, 3);
  });

  it('clamps invalid or negative token totals to zero', () => {
    expect(estimateResourceImpact(-10)).toEqual(estimateResourceImpact(0));
    expect(estimateResourceImpact(Number.NaN)).toEqual(estimateResourceImpact(0));
  });

  it('formats small and large ranges in readable units', () => {
    expect(formatResourceImpact(estimateResourceImpact(1_000))).toEqual({
      energy: '0.08–0.42 Wh',
      water: '0.02–0.45 mL',
    });
    expect(formatResourceImpact(estimateResourceImpact(10_000_000)).energy).toContain('kWh');
  });

  it('labels the result as an estimate instead of a measurement', () => {
    expect(formatResourceImpactReport(1_000).join('\n')).toContain('not a provider measurement');
  });
});
