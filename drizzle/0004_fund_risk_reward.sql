ALTER TABLE `positions` ADD `risk_reward_level` text;--> statement-breakpoint
CREATE INDEX `positions_risk_reward_level_idx` ON `positions` (`risk_reward_level`);--> statement-breakpoint
UPDATE positions SET asset_name = CASE asset_code
  WHEN '1641' THEN '富蘭克林多空策略基金-美元累積'
  WHEN '0815' THEN '富蘭克林全球平衡基金-美元季配息'
  WHEN '0376' THEN '富蘭克林全球房地產基金-美元季配息'
  ELSE asset_name END
WHERE asset_code IN ('1641','0815','0376')
  AND asset_name IN ('多空策略基金-美元累積','全球平衡基金-美元季配息','全球房地產基金-美元季配息');--> statement-breakpoint
UPDATE positions SET industry_theme = 'technology'
WHERE asset_type = '基金' AND asset_code = 'B20306';--> statement-breakpoint
UPDATE positions SET risk_reward_level = CASE asset_code
  WHEN '132' THEN 'RR5'
  WHEN '0376' THEN 'RR4'
  WHEN '0815' THEN 'RR3'
  WHEN '1641' THEN 'RR3'
  WHEN 'B06188' THEN 'RR2'
  WHEN 'B09463' THEN 'RR5'
  WHEN 'B20302' THEN 'RR4'
  WHEN 'B20306' THEN 'RR5'
  WHEN '069017' THEN 'RR2'
  WHEN '069015' THEN 'RR2'
  WHEN '042197' THEN 'RR3'
  ELSE NULL END
WHERE asset_type = '基金'
  AND asset_code IN ('132','0376','0815','1641','B06188','B09463','B20302','B20306','069017','069015','042197');
