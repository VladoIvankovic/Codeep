/**
 * Broad operational-impact estimate for hosted LLM inference.
 *
 * This is deliberately a range, not a meter reading:
 * - 0.3–1.5 J/token covers published H100 inference benchmarks.
 * - 0.27–1.08 L/kWh spans efficient direct cooling and a full-stack
 *   production estimate that also captures associated infrastructure.
 *
 * Model size, batching, context length, hardware, data-centre location and
 * provider efficiency can move the real result outside this band. Local
 * models are included because their token usage still consumes electricity,
 * but Codeep cannot measure the device directly.
 */

const ENERGY_JOULES_PER_TOKEN = { low: 0.3, high: 1.5 } as const;
const WATER_LITRES_PER_KWH = { low: 0.27, high: 1.08 } as const;

export interface ResourceImpactEstimate {
  energyWhLow: number;
  energyWhHigh: number;
  waterMlLow: number;
  waterMlHigh: number;
}

export function estimateResourceImpact(totalTokens: number): ResourceImpactEstimate {
  const tokens = Number.isFinite(totalTokens) ? Math.max(0, totalTokens) : 0;
  const energyWhLow = (tokens * ENERGY_JOULES_PER_TOKEN.low) / 3600;
  const energyWhHigh = (tokens * ENERGY_JOULES_PER_TOKEN.high) / 3600;
  return {
    energyWhLow,
    energyWhHigh,
    waterMlLow: (energyWhLow / 1000) * WATER_LITRES_PER_KWH.low * 1000,
    waterMlHigh: (energyWhHigh / 1000) * WATER_LITRES_PER_KWH.high * 1000,
  };
}

function compact(value: number): string {
  if (value === 0) return '0';
  if (value < 0.01) return value.toFixed(3);
  if (value < 1) return value.toFixed(2);
  if (value < 10) return value.toFixed(1);
  return Math.round(value).toLocaleString('en-US');
}

export function formatResourceImpact(estimate: ResourceImpactEstimate): {
  energy: string;
  water: string;
} {
  const energy = estimate.energyWhHigh >= 1000
    ? `${compact(estimate.energyWhLow / 1000)}–${compact(estimate.energyWhHigh / 1000)} kWh`
    : `${compact(estimate.energyWhLow)}–${compact(estimate.energyWhHigh)} Wh`;
  const water = estimate.waterMlHigh >= 1000
    ? `${compact(estimate.waterMlLow / 1000)}–${compact(estimate.waterMlHigh / 1000)} L`
    : `${compact(estimate.waterMlLow)}–${compact(estimate.waterMlHigh)} mL`;
  return { energy, water };
}

export function formatResourceImpactReport(totalTokens: number): string[] {
  const formatted = formatResourceImpact(estimateResourceImpact(totalTokens));
  return [
    '### Estimated compute impact',
    `**Electricity:** ${formatted.energy}  ·  **Cooling water:** ${formatted.water}`,
    '_Research-based range, not a provider measurement. Actual usage varies widely by model, hardware, batching, context length, data-centre location, and cooling system._',
  ];
}
