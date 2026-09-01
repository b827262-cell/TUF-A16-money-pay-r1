import { CLASSIFICATION_LABELS, type AssetCategory } from "@/lib/position-classification";

export const UNCLASSIFIED_LABEL = "未分類/不適用";

export type CostAllocationPosition = {
  assetName: string;
  assetType: string;
  assetCategory: AssetCategory | string | null;
  riskRewardLevel: string | null;
  costBasisTwd: number;
};

export type CostAllocationSlice = {
  key: string;
  label: string;
  value: number;
  percentage: number;
  positionCount: number;
};

function finiteNumber(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Returns a position's cost share without producing NaN/Infinity for an empty portfolio. */
export function getPositionCostShare(costBasisTwd: number, totalCostBasisTwd: number): number {
  const total = finiteNumber(totalCostBasisTwd);
  if (total === 0) return 0;
  return (finiteNumber(costBasisTwd) / total) * 100;
}

function costCategoryLabel(assetCategory: CostAllocationPosition["assetCategory"]): string {
  if (!assetCategory) return UNCLASSIFIED_LABEL;
  return (CLASSIFICATION_LABELS.assetCategory as Record<string, string>)[assetCategory] ?? assetCategory;
}

function isFundPosition(position: CostAllocationPosition): boolean {
  return /基金|fund/i.test(`${position.assetType} ${position.assetName}`);
}

function riskRewardLabel(position: CostAllocationPosition): string {
  // Only use an existing official RR field. Do not infer a level from the name or category.
  if (isFundPosition(position) && /^RR[1-5]$/.test(position.riskRewardLevel ?? "")) {
    return position.riskRewardLevel as string;
  }
  return UNCLASSIFIED_LABEL;
}

function aggregateCost(
  positions: CostAllocationPosition[],
  getBucket: (position: CostAllocationPosition) => { key: string; label: string },
  totalCostBasisTwd: number,
): CostAllocationSlice[] {
  const groups = new Map<string, { key: string; label: string; value: number; positionCount: number }>();

  for (const position of positions) {
    const bucket = getBucket(position);
    const current = groups.get(bucket.key) ?? { ...bucket, value: 0, positionCount: 0 };
    current.value += finiteNumber(position.costBasisTwd);
    current.positionCount += 1;
    groups.set(bucket.key, current);
  }

  return [...groups.values()]
    .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label, "zh-Hant"))
    .map((group) => ({
      ...group,
      percentage: getPositionCostShare(group.value, totalCostBasisTwd),
    }));
}

export function aggregateCostByCategory(
  positions: CostAllocationPosition[],
  totalCostBasisTwd: number,
): CostAllocationSlice[] {
  return aggregateCost(
    positions,
    (position) => {
      const label = costCategoryLabel(position.assetCategory);
      return { key: `category:${label}`, label };
    },
    totalCostBasisTwd,
  );
}

export function aggregateCostByRiskReward(
  positions: CostAllocationPosition[],
  totalCostBasisTwd: number,
): CostAllocationSlice[] {
  return aggregateCost(
    positions,
    (position) => {
      const label = riskRewardLabel(position);
      return { key: `risk:${label}`, label };
    },
    totalCostBasisTwd,
  );
}
