export type RiskRewardLevel = "RR1" | "RR2" | "RR3" | "RR4" | "RR5";

export type FundRiskReward = {
  level: RiskRewardLevel;
  sourceUrl: string;
};

/**
 * Exact Taiwan fund-code lookups verified against the manager's Taiwan site,
 * manager material, or an authorized Taiwan fund-risk table. An unknown code/name stays null;
 * the application must never infer an RR level from a fund name or asset class.
 */
const FUND_RISK_REWARD_BY_CODE: Record<string, FundRiskReward> = {
  "132": { level: "RR5", sourceUrl: "https://www.franklin.com.tw/Fund/132" },
  "0376": { level: "RR4", sourceUrl: "https://www.franklin.com.tw/Fund/0376" },
  "0815": { level: "RR3", sourceUrl: "https://www.franklin.com.tw/Fund/0815" },
  "1641": { level: "RR3", sourceUrl: "https://www.franklin.com.tw/Fund/1641" },
  "B06188": { level: "RR2", sourceUrl: "https://www.bankchb.com/chb_2a_resource/leap_do/gallery/1703675303635/113%E5%B9%B4Q1%E5%9C%8B%E5%A4%96%E5%9F%BA%E9%87%91%E9%A2%A8%E9%9A%AA%E6%94%B6%E7%9B%8A%E7%AD%89%E7%B4%9A%E4%B8%80%E8%A6%BD%E8%A1%A8.pdf" },
  "B09463": { level: "RR5", sourceUrl: "https://www.blackrock.com/tw/literature/investor-education/bgf-world-gold-fund-investor-brochure-tw.pdf" },
  "B20302": { level: "RR4", sourceUrl: "https://tw.allianzgi.com/zh-tw/products-solutions/luxemberg/allianz-global-artificial-intelligence-amf2-usd?nav=overview" },
  "B20306": { level: "RR5", sourceUrl: "https://tw.allianzgi.com/-/media/allianzgi/ap/taiwan/documents/factsheet/series/2024/06/27/03/04/agif-mpu.pdf?hash=A31E15B468486514E5FBC1ACA0D651BC&rev=b00c0ca33800462fab640a0647e7bd36" },
  "069017": { level: "RR2", sourceUrl: "https://www.bankchb.com/chb_2a_resource/leap_do/gallery/1703675303635/113年Q1國外基金風險收益等級一覽表.pdf" },
  "069015": { level: "RR2", sourceUrl: "https://www.bankchb.com/chb_2a_resource/leap_do/gallery/1703675303635/113年Q1國外基金風險收益等級一覽表.pdf" },
  "042197": { level: "RR3", sourceUrl: "https://www.blackrock.com/tw/literature/investor-education/bgf-global-allocation-fund-investor-brochure-tw.pdf" },
};

const FUND_RISK_REWARD_BY_NAME: Record<string, FundRiskReward> = {
  "富蘭克林黃金基金": FUND_RISK_REWARD_BY_CODE["132"],
  "全球房地產基金-美元季配息": FUND_RISK_REWARD_BY_CODE["0376"],
  "富蘭克林全球房地產基金-美元季配息": FUND_RISK_REWARD_BY_CODE["0376"],
  "全球平衡基金-美元季配息": FUND_RISK_REWARD_BY_CODE["0815"],
  "富蘭克林全球平衡基金-美元季配息": FUND_RISK_REWARD_BY_CODE["0815"],
  "多空策略基金-美元累積": FUND_RISK_REWARD_BY_CODE["1641"],
  "富蘭克林多空策略基金-美元累積": FUND_RISK_REWARD_BY_CODE["1641"],
  "法巴美元短期債券基金/月配(美元)": FUND_RISK_REWARD_BY_CODE["B06188"],
  "貝萊德世界黃金A10美元總報酬穩定配息": FUND_RISK_REWARD_BY_CODE["B09463"],
  "安聯AI人工智慧AMf2固定月配美元": FUND_RISK_REWARD_BY_CODE["B20302"],
  "安聯網路資安趨勢AMf2固定月配美元": FUND_RISK_REWARD_BY_CODE["B20306"],
  "PIMCO全球投資級別債券基金-M級類別(月收息股份)": FUND_RISK_REWARD_BY_CODE["069017"],
  "PIMCO全球債券基金-M級類別(月收息強化股份)": FUND_RISK_REWARD_BY_CODE["069015"],
  "貝萊德環球資產配置基金A10美元(總報酬穩定配息)": FUND_RISK_REWARD_BY_CODE["042197"],
};

function normalizeKey(value: string | null | undefined): string {
  return String(value ?? "").replace(/\s+/g, "").trim();
}

export function lookupFundRiskReward(assetCode: string | null | undefined, assetName: string): FundRiskReward | null {
  if (!assetName) return null;
  return FUND_RISK_REWARD_BY_CODE[normalizeKey(assetCode)] ?? FUND_RISK_REWARD_BY_NAME[normalizeKey(assetName)] ?? null;
}
