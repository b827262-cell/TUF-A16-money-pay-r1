"use client";

import { PieChart as PieChartIcon } from "lucide-react";
import {
  Cell,
  Pie,
  PieChart as RechartsPieChart,
  ResponsiveContainer,
  Tooltip,
} from "recharts";
import {
  aggregateCostByCategory,
  aggregateCostByRiskReward,
  type CostAllocationPosition,
  type CostAllocationSlice,
} from "@/lib/portfolio-analytics";

const CHART_COLORS = ["#173b5f", "#e86d4b", "#137b63", "#b27b57", "#7c6c9c", "#c8a951", "#6c8b9b"];
const money = new Intl.NumberFormat("zh-TW", { style: "currency", currency: "TWD", maximumFractionDigits: 0 });

type PortfolioCostChartsProps = {
  positions: CostAllocationPosition[];
  totalCostBasisTwd: number;
};

function CostBreakdown({ data }: { data: CostAllocationSlice[] }) {
  return (
    <ul className="cost-breakdown">
      {data.map((item, index) => (
        <li key={item.key}>
          <div className="cost-breakdown-label">
            <i style={{ background: CHART_COLORS[index % CHART_COLORS.length] }} />
            <span>
              <b>{item.label}</b>
              <small>{item.positionCount} 筆持倉</small>
            </span>
          </div>
          <strong>
            {money.format(item.value)}
            <small>{item.percentage.toFixed(2)}%</small>
          </strong>
        </li>
      ))}
    </ul>
  );
}

function CostPie({ data, title }: { data: CostAllocationSlice[]; title: string }) {
  const hasCost = data.some((item) => item.value > 0);

  return (
    <article className="cost-chart-card">
      <div className="cost-chart-heading">
        <div>
          <h3>{title}</h3>
          <p>按總投資成本計算</p>
        </div>
        <span>{data.length} 類</span>
      </div>
      {hasCost ? (
        <div className="cost-chart-content">
          <div className="cost-pie" aria-label={`${title}圓餅圖`}>
            <ResponsiveContainer width="100%" height={220}>
              <RechartsPieChart>
                <Pie
                  data={data}
                  dataKey="value"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius={50}
                  outerRadius={82}
                  paddingAngle={2}
                  stroke="#fbf8f0"
                  strokeWidth={2}
                >
                  {data.map((item, index) => (
                    <Cell key={item.key} fill={CHART_COLORS[index % CHART_COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => money.format(Number(value ?? 0))} />
              </RechartsPieChart>
            </ResponsiveContainer>
          </div>
          <CostBreakdown data={data} />
        </div>
      ) : (
        <div className="cost-chart-empty">
          <PieChartIcon />
          <b>尚無可分配的成本</b>
          <span>總成本為 0 時，比例安全顯示為 0%。</span>
          <CostBreakdown data={data} />
        </div>
      )}
    </article>
  );
}

export function PortfolioCostCharts({ positions, totalCostBasisTwd }: PortfolioCostChartsProps) {
  const categoryData = aggregateCostByCategory(positions, totalCostBasisTwd);
  const riskData = aggregateCostByRiskReward(positions, totalCostBasisTwd);

  return (
    <section className="paper-card cost-visualization-card" aria-labelledby="cost-visualization-title">
      <div className="section-title">
        <div>
          <span>COST ALLOCATION</span>
          <h2 id="cost-visualization-title">投資比重與風險集中度</h2>
        </div>
        <PieChartIcon />
      </div>
      <p className="cost-visualization-intro">以持倉成本占目前總投資成本的比例呈現；風險圖只採用既有官方 RR 等級，未定義資料不做推測。</p>
      <div className="cost-chart-grid">
        <CostPie data={categoryData} title="依分類的成本占比" />
        <CostPie data={riskData} title="依風險報酬等級 RR 的成本占比" />
      </div>
    </section>
  );
}
