import { lookupFundRiskReward, type RiskRewardLevel } from "@/lib/fund-risk-reward";

export type PurchaseDateBasis = "exact" | "lower_bound" | "unknown";
export type AssetCategory =
  | "stock_fund" | "bond_fund" | "balanced_fund" | "money_market_fund" | "other_fund"
  | "etf_stock" | "etf_bond" | "etf_commodity" | "etf_other"
  | "stock" | "bond_direct" | "structured" | "other";
export type InvestRegion =
  | "global" | "americas" | "europe" | "asia_pacific" | "emerging_markets"
  | "japan" | "usa" | "taiwan" | "china" | "other_region" | "mixed"
  | "not_applicable" | "unknown";
export type MarketCapTier = "large" | "mid" | "small" | "micro" | "mixed" | "not_applicable" | "unknown";
export type InvestStyle = "growth" | "value" | "blend" | "not_applicable" | "unknown";
export type IndustryTheme =
  | "technology" | "healthcare" | "consumer_staples" | "consumer_discretionary"
  | "utilities" | "financials" | "energy" | "industrials" | "real_estate"
  | "materials" | "communication_services" | "diversified" | "fixed_income"
  | "commodity" | "not_applicable" | "unknown";

export type PositionClassification = {
  lastPurchaseDate: string | null;
  purchaseDateBasis: PurchaseDateBasis;
  assetCategory: AssetCategory | null;
  investRegion: InvestRegion | null;
  marketCapTier: MarketCapTier | null;
  investStyle: InvestStyle | null;
  industryTheme: IndustryTheme | null;
  riskRewardLevel: RiskRewardLevel | null;
};
const PURCHASE_DATE_KEYS = ["購入日", "申購日", "申購日期", "交易日", "成交日期", "PurchaseDate", "TradeDate", "SubscribeDate"];
const EQUITY_CATEGORIES = new Set<AssetCategory>(["stock_fund", "etf_stock", "stock"]);

function textOf(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}

export function normalizeExplicitPurchaseDate(value: unknown): string | null {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const normalized = raw.replace(/[./]/g, "-");
  const match = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (!match) return null;
  const iso = `${match[1]}-${match[2].padStart(2, "0")}-${match[3].padStart(2, "0")}`;
  const [year, month, day] = iso.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day ? iso : null;
}

function explicitPurchaseDate(raw: Record<string, string> = {}): string | null {
  for (const key of PURCHASE_DATE_KEYS) {
    const value = normalizeExplicitPurchaseDate(raw[key]);
    if (value) return value;
  }
  return null;
}
export function inferAssetCategory(assetType: string, assetName: string): AssetCategory | null {
  const type = textOf(assetType);
  const name = textOf(assetName);
  if (type.includes("etf") || name.includes("etf")) {
    if (/債|bond|fixed income/.test(name)) return "etf_bond";
    if (/黃金|gold|商品|commodity/.test(name)) return "etf_commodity";
    if (/股票|equity|台灣|美國|科技|指數/.test(name)) return "etf_stock";
    return "etf_other";
  }
  if (/證券|股票|stock/.test(type)) return "stock";
  if (/債券|bond/.test(type) && !/基金|fund/.test(type)) return "bond_direct";
  if (/基金|fund/.test(type) || /基金|fund/.test(name)) {
    if (/貨幣|money market/.test(name)) return "money_market_fund";
    if (/平衡|資產配置|多重資產|balanced|multi[- ]?asset/.test(name)) return "balanced_fund";
    if (/債|bond|fixed income/.test(name)) return "bond_fund";
    if (/股票|equity|stock/.test(name)) return "stock_fund";
    return "other_fund";
  }
  if (/結構|structured/.test(type) || /結構|structured/.test(name)) return "structured";
  return type ? "other" : null;
}

export function inferInvestRegion(assetName: string): InvestRegion {
  const name = textOf(assetName);
  if (/全球|環球|global|world/.test(name)) return "global";
  if (/新興市場|emerging/.test(name)) return "emerging_markets";
  if (/亞太|亞洲|asia|asian/.test(name)) return "asia_pacific";
  if (/美洲|americas|latin america/.test(name)) return "americas";
  if (/歐洲|europe/.test(name)) return "europe";
  if (/美國|usa|u\.s\.|america/.test(name)) return "usa";
  if (/台灣|taiwan/.test(name)) return "taiwan";
  if (/日本|japan/.test(name)) return "japan";
  if (/中國|大中華|china/.test(name)) return "china";
  return "unknown";
}
export function inferMarketCapTier(category: AssetCategory | null, assetName: string): MarketCapTier | null {
  if (!category) return null;
  if (!EQUITY_CATEGORIES.has(category)) return "not_applicable";
  const name = textOf(assetName);
  if (/中小型|mid.?small/.test(name)) return "mixed";
  if (/微型|micro/.test(name)) return "micro";
  if (/小型|small cap|small-cap/.test(name)) return "small";
  if (/中型|mid cap|mid-cap/.test(name)) return "mid";
  if (/大型|large cap|large-cap/.test(name)) return "large";
  return "unknown";
}

export function inferInvestStyle(category: AssetCategory | null, assetName: string): InvestStyle | null {
  if (!category) return null;
  if (!EQUITY_CATEGORIES.has(category)) return "not_applicable";
  const name = textOf(assetName);
  if (/成長|增長|growth/.test(name)) return "growth";
  if (/價值|value/.test(name)) return "value";
  if (/均衡|blend/.test(name)) return "blend";
  return "unknown";
}

export function inferIndustryTheme(category: AssetCategory | null, assetName: string): IndustryTheme | null {
  if (!category) return null;
  const name = textOf(assetName);
  if (/科技|technology|ai|人工智慧|半導體|資安|網路安全|cyber|security/.test(name)) return "technology";
  if (/醫療|healthcare|生技/.test(name)) return "healthcare";
  if (/必需消費|consumer staples/.test(name)) return "consumer_staples";
  if (/非必需消費|consumer discretionary/.test(name)) return "consumer_discretionary";
  if (/公用事業|utilities/.test(name)) return "utilities";
  if (/金融|financial/.test(name)) return "financials";
  if (/能源|energy/.test(name)) return "energy";
  if (/航運|工業|industrials/.test(name)) return "industrials";
  if (/房地產|real estate|reit/.test(name)) return "real_estate";
  if (/黃金|gold|商品|commodity/.test(name)) return "commodity";
  if (category === "bond_fund" || category === "etf_bond" || category === "bond_direct") return "fixed_income";
  if (category === "balanced_fund") return "diversified";
  return category === "money_market_fund" || category === "structured" ? "not_applicable" : "unknown";
}
export function classifyPosition(input: { assetCode?: string | null; assetType: string; assetName: string; raw?: Record<string, string> }): PositionClassification {
  const assetCategory = inferAssetCategory(input.assetType, input.assetName);
  const lastPurchaseDate = explicitPurchaseDate(input.raw ?? {});
  return {
    lastPurchaseDate,
    purchaseDateBasis: lastPurchaseDate ? "exact" : "unknown",
    assetCategory,
    investRegion: assetCategory ? inferInvestRegion(input.assetName) : null,
    marketCapTier: inferMarketCapTier(assetCategory, input.assetName),
    investStyle: inferInvestStyle(assetCategory, input.assetName),
    industryTheme: inferIndustryTheme(assetCategory, input.assetName),
    riskRewardLevel: /基金|fund/i.test(input.assetType) || /基金|fund/i.test(input.assetName)
      ? lookupFundRiskReward(input.assetCode, input.assetName)?.level ?? null
      : null,
  };
}

export const CLASSIFICATION_LABELS = {
  assetCategory: {
    stock_fund: "股票型基金", bond_fund: "債券型基金", balanced_fund: "平衡／多資產基金",
    money_market_fund: "貨幣市場基金", other_fund: "其他基金", etf_stock: "股票 ETF",
    etf_bond: "債券 ETF", etf_commodity: "商品 ETF", etf_other: "其他 ETF",
    stock: "股票／證券", bond_direct: "直接債券", structured: "結構型商品", other: "其他",
  },
  investRegion: {
    global: "全球", americas: "美洲", europe: "歐洲", asia_pacific: "亞太", emerging_markets: "新興市場",
    japan: "日本", usa: "美國", taiwan: "台灣", china: "中國／大中華", other_region: "其他地區",
    mixed: "多地區", not_applicable: "不適用", unknown: "地區未知",
  },
  marketCapTier: { large: "大型", mid: "中型", small: "小型", micro: "微型", mixed: "混合市值", not_applicable: "不適用", unknown: "市值未知" },
  investStyle: { growth: "成長", value: "價值", blend: "均衡", not_applicable: "不適用", unknown: "風格未知" },
  industryTheme: {
    technology: "科技", healthcare: "醫療", consumer_staples: "必需消費", consumer_discretionary: "非必需消費",
    utilities: "公用事業", financials: "金融", energy: "能源", industrials: "工業／航運", real_estate: "房地產",
    materials: "原物料", communication_services: "通訊服務", diversified: "多元配置", fixed_income: "固定收益",
    commodity: "商品／黃金", not_applicable: "不適用", unknown: "主題未知",
  },
} as const;
