ALTER TABLE `positions` ADD `last_purchase_date` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `purchase_date_basis` text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE `positions` ADD `asset_category` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `invest_region` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `market_cap_tier` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `invest_style` text;--> statement-breakpoint
ALTER TABLE `positions` ADD `industry_theme` text;--> statement-breakpoint
CREATE INDEX `positions_asset_category_idx` ON `positions` (`asset_category`);--> statement-breakpoint
CREATE INDEX `positions_last_purchase_date_idx` ON `positions` (`last_purchase_date`);
--> statement-breakpoint
UPDATE positions SET asset_category = CASE
  WHEN asset_type LIKE '%ETF%' OR asset_name LIKE '%ETF%' THEN CASE
    WHEN asset_name LIKE '%債%' OR lower(asset_name) LIKE '%bond%' THEN 'etf_bond'
    WHEN asset_name LIKE '%黃金%' OR lower(asset_name) LIKE '%gold%' OR asset_name LIKE '%商品%' THEN 'etf_commodity'
    WHEN asset_name LIKE '%股票%' OR lower(asset_name) LIKE '%equity%' OR asset_name LIKE '%台灣%' OR asset_name LIKE '%美國%' OR asset_name LIKE '%科技%' OR asset_name LIKE '%指數%' THEN 'etf_stock'
    ELSE 'etf_other' END
  WHEN asset_type LIKE '%證券%' OR asset_type LIKE '%股票%' OR lower(asset_type) LIKE '%stock%' THEN 'stock'
  WHEN asset_type LIKE '%基金%' OR lower(asset_type) LIKE '%fund%' OR asset_name LIKE '%基金%' THEN CASE
    WHEN asset_name LIKE '%貨幣%' OR lower(asset_name) LIKE '%money market%' THEN 'money_market_fund'
    WHEN asset_name LIKE '%平衡%' OR asset_name LIKE '%資產配置%' OR asset_name LIKE '%多重資產%' THEN 'balanced_fund'
    WHEN asset_name LIKE '%債%' OR lower(asset_name) LIKE '%bond%' THEN 'bond_fund'
    WHEN asset_name LIKE '%股票%' OR lower(asset_name) LIKE '%equity%' OR lower(asset_name) LIKE '%stock%' THEN 'stock_fund'
    ELSE 'other_fund' END
  ELSE 'other' END
WHERE asset_category IS NULL;
--> statement-breakpoint
UPDATE positions SET invest_region = CASE
  WHEN asset_name LIKE '%全球%' OR asset_name LIKE '%環球%' OR lower(asset_name) LIKE '%global%' OR lower(asset_name) LIKE '%world%' THEN 'global'
  WHEN asset_name LIKE '%新興市場%' OR lower(asset_name) LIKE '%emerging%' THEN 'emerging_markets'
  WHEN asset_name LIKE '%亞太%' OR asset_name LIKE '%亞洲%' OR lower(asset_name) LIKE '%asia%' THEN 'asia_pacific'
  WHEN asset_name LIKE '%美洲%' OR lower(asset_name) LIKE '%americas%' THEN 'americas'
  WHEN asset_name LIKE '%歐洲%' OR lower(asset_name) LIKE '%europe%' THEN 'europe'
  WHEN asset_name LIKE '%美國%' OR lower(asset_name) LIKE '%usa%' THEN 'usa'
  WHEN asset_name LIKE '%台灣%' OR lower(asset_name) LIKE '%taiwan%' THEN 'taiwan'
  WHEN asset_name LIKE '%日本%' OR lower(asset_name) LIKE '%japan%' THEN 'japan'
  WHEN asset_name LIKE '%中國%' OR asset_name LIKE '%大中華%' OR lower(asset_name) LIKE '%china%' THEN 'china'
  ELSE 'unknown' END
WHERE invest_region IS NULL;
--> statement-breakpoint
UPDATE positions SET market_cap_tier = CASE
  WHEN asset_category NOT IN ('stock_fund','etf_stock','stock') THEN 'not_applicable'
  WHEN asset_name LIKE '%中小型%' THEN 'mixed'
  WHEN asset_name LIKE '%微型%' OR lower(asset_name) LIKE '%micro%' THEN 'micro'
  WHEN asset_name LIKE '%小型%' OR lower(asset_name) LIKE '%small cap%' THEN 'small'
  WHEN asset_name LIKE '%中型%' OR lower(asset_name) LIKE '%mid cap%' THEN 'mid'
  WHEN asset_name LIKE '%大型%' OR lower(asset_name) LIKE '%large cap%' THEN 'large'
  ELSE 'unknown' END
WHERE market_cap_tier IS NULL;
--> statement-breakpoint
UPDATE positions SET invest_style = CASE
  WHEN asset_category NOT IN ('stock_fund','etf_stock','stock') THEN 'not_applicable'
  WHEN asset_name LIKE '%成長%' OR asset_name LIKE '%增長%' OR lower(asset_name) LIKE '%growth%' THEN 'growth'
  WHEN asset_name LIKE '%價值%' OR lower(asset_name) LIKE '%value%' THEN 'value'
  WHEN asset_name LIKE '%均衡%' OR lower(asset_name) LIKE '%blend%' THEN 'blend'
  ELSE 'unknown' END
WHERE invest_style IS NULL;
--> statement-breakpoint
UPDATE positions SET industry_theme = CASE
  WHEN asset_name LIKE '%科技%' OR lower(asset_name) LIKE '%technology%' OR asset_name LIKE '%人工智慧%' OR asset_name LIKE '%半導體%' THEN 'technology'
  WHEN asset_name LIKE '%醫療%' OR asset_name LIKE '%生技%' OR lower(asset_name) LIKE '%healthcare%' THEN 'healthcare'
  WHEN asset_name LIKE '%必需消費%' OR lower(asset_name) LIKE '%consumer staples%' THEN 'consumer_staples'
  WHEN asset_name LIKE '%非必需消費%' OR lower(asset_name) LIKE '%consumer discretionary%' THEN 'consumer_discretionary'
  WHEN asset_name LIKE '%公用事業%' OR lower(asset_name) LIKE '%utilities%' THEN 'utilities'
  WHEN asset_name LIKE '%金融%' OR lower(asset_name) LIKE '%financial%' THEN 'financials'
  WHEN asset_name LIKE '%能源%' OR lower(asset_name) LIKE '%energy%' THEN 'energy'
  WHEN asset_name LIKE '%航運%' OR asset_name LIKE '%工業%' OR lower(asset_name) LIKE '%industrials%' THEN 'industrials'
  WHEN asset_name LIKE '%房地產%' OR lower(asset_name) LIKE '%real estate%' OR lower(asset_name) LIKE '%reit%' THEN 'real_estate'
  WHEN asset_name LIKE '%黃金%' OR lower(asset_name) LIKE '%gold%' OR asset_name LIKE '%商品%' THEN 'commodity'
  WHEN asset_category IN ('bond_fund','etf_bond','bond_direct') THEN 'fixed_income'
  WHEN asset_category = 'balanced_fund' THEN 'diversified'
  WHEN asset_category IN ('money_market_fund','structured') THEN 'not_applicable'
  ELSE 'unknown' END
WHERE industry_theme IS NULL;
