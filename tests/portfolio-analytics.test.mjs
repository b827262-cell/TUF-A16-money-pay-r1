import assert from "node:assert/strict";
import test, { after } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createServer } from "vite";

const vite = await createServer({
  appType: "custom",
  configFile: false,
  root: new URL("..", import.meta.url).pathname,
  resolve: { alias: { "@": new URL("..", import.meta.url).pathname } },
  server: { middlewareMode: true },
});

after(async () => {
  await vite.close();
});

const {
  aggregateCostByCategory,
  aggregateCostByRiskReward,
  getPositionCostShare,
  UNCLASSIFIED_LABEL,
} = await vite.ssrLoadModule("/lib/portfolio-analytics.ts");
const { PortfolioCostCharts } = await vite.ssrLoadModule("/components/portfolio-cost-charts.tsx");

const positions = [
  { assetName: "全球平衡基金", assetType: "基金", assetCategory: "balanced_fund", riskRewardLevel: "RR3", costBasisTwd: 400 },
  { assetName: "全球股票基金", assetType: "基金", assetCategory: "stock_fund", riskRewardLevel: "RR5", costBasisTwd: 350 },
  { assetName: "中華電", assetType: "證券", assetCategory: "stock", riskRewardLevel: "RR5", costBasisTwd: 250 },
  { assetName: "待分類基金", assetType: "基金", assetCategory: null, riskRewardLevel: null, costBasisTwd: 0 },
];

test("position cost shares add up to 100% and handle zero totals", () => {
  const shares = positions.map((position) => getPositionCostShare(position.costBasisTwd, 1000));
  assert.ok(Math.abs(shares.reduce((sum, share) => sum + share, 0) - 100) < 0.000001);
  assert.equal(getPositionCostShare(100, 0), 0);
  assert.equal(getPositionCostShare(0, 0), 0);
  assert.ok(Number.isFinite(getPositionCostShare(100, 0)));
});

test("aggregates cost by understandable category labels and preserves counts", () => {
  const data = aggregateCostByCategory(positions, 1000);

  assert.deepEqual(
    data.map(({ label, value, percentage, positionCount }) => ({ label, value, percentage, positionCount })),
    [
      { label: "平衡／多資產基金", value: 400, percentage: 40, positionCount: 1 },
      { label: "股票型基金", value: 350, percentage: 35, positionCount: 1 },
      { label: "股票／證券", value: 250, percentage: 25, positionCount: 1 },
      { label: UNCLASSIFIED_LABEL, value: 0, percentage: 0, positionCount: 1 },
    ],
  );
  assert.equal(data.reduce((sum, item) => sum + item.percentage, 0), 100);
});

test("aggregates only existing official RR values for funds", () => {
  const data = aggregateCostByRiskReward(positions, 1000);

  assert.deepEqual(
    data.map(({ label, value, percentage, positionCount }) => ({ label, value, percentage, positionCount })),
    [
      { label: "RR3", value: 400, percentage: 40, positionCount: 1 },
      { label: "RR5", value: 350, percentage: 35, positionCount: 1 },
      { label: UNCLASSIFIED_LABEL, value: 250, percentage: 25, positionCount: 2 },
    ],
  );
});

test("zero-cost portfolios remain safe and show zero allocation percentages", () => {
  const zeroPositions = positions.map((position) => ({ ...position, costBasisTwd: 0 }));
  const categoryData = aggregateCostByCategory(zeroPositions, 0);
  const riskData = aggregateCostByRiskReward(zeroPositions, 0);

  assert.ok(categoryData.every((item) => item.percentage === 0 && item.value === 0));
  assert.ok(riskData.every((item) => item.percentage === 0 && item.value === 0));
});

test("renders both cost visualization titles and breakdown values", () => {
  const html = renderToStaticMarkup(
    React.createElement(PortfolioCostCharts, { positions, totalCostBasisTwd: 1000 }),
  );

  assert.match(html, /投資比重與風險集中度/);
  assert.match(html, /依分類的成本占比/);
  assert.match(html, /依風險報酬等級 RR 的成本占比/);
  assert.match(html, /平衡／多資產基金/);
  assert.match(html, /RR5/);
  assert.match(html, /未分類\/不適用/);
});
