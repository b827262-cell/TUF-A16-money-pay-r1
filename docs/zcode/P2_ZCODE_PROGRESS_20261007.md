# P2 ZCode Progress — 2026-10-07

工作線：TUF-A16 money-pay-r1（未混入 AI-Quest-A1）
角色：ZCode 單一 source writer（本輪：source-level blocker review + 進度文檔）

## CURRENT_STATUS

Phase 2（P2 import identity governance + currency contract）source 收口完成。
上一輪（GLM-5.3 closeout）指出的 currency gate 矛盾已由 `1f800c4 fix: enforce P2 currency contract` 修正；
本輪 source-level blocker review 結論：**無新的 source blocker**，source code 零修改。
Production 維持唯讀未接觸、cutover NO-GO。下一步 gate 為 Production D1 READONLY preflight（需 Owner 提供存取途徑）。

## CURRENT_SHA

`1f800c4abacccb2d712112412fc19b22ad36f23b`（已驗證：worktree HEAD == CURRENT_SHA == origin/agent/p2-owner-implementation，ahead/behind = 0/0）

歷史：
- `1f800c4` fix: enforce P2 currency contract（route + 5 個新 currency 測試）
- `98ed442` feat: add P2 import identity governance（0005 migration + p2 contracts/shadow/idempotency + 測試）
- baseline：main @ `037bba2`

## ZCODE_CDP_9222

ACTIVE — `127.0.0.1:9222` 有 listener，回應 `Chrome/146.0.7680.80`（CDP protocol 1.3）。本輪未透過 CDP 執行任何動作。

## SOURCE_REVIEW

範圍：`agent/p2-owner-implementation` 相對 main 的全部差異（0005 migration、import route、p2-contracts、portfolio.ts、shadow route、測試）。

結論：**NO_SOURCE_BLOCKER**。要點：

1. `1f800c4` diff 僅含 `app/api/import/route.ts`（+36/-10）與新增 `tests/p2-import-currency.test.mjs`（168 行）。
   migration／schema／lib 自上輪完整 review 後**零變動**（`git diff 98ed442..1f800c4 -- drizzle/ db/schema.ts lib/` 為空）。
2. Currency gate（route.ts L119-123）位於 `if (p2)` 區塊的**第一個檢查**，在任何 governance DB 讀取與任何 INSERT 之前 → fail-closed、無部分寫入。
3. `app/api/import/route.ts` 是 imports／positions 的**唯一**寫入路徑（全 app/ worker/ grep 驗證），currency gate 無繞道；OCR/sync 皆走同一 route。
4. Type narrowing 修正（`LogicalImportRow` 型別抽出、`validateSupersedesChain` 明確標註、`!accountKey` 防禦檢查、`resolvedAccountKey/ScopeKey`）皆為行為保持或更嚴格，無行為回歸風險。
5. Production READONLY preflight 觀點：shadow route 為 GET-only；本輪差異不含任何讀取路徑變更、不含 migration apply 邏輯變更 → 無阻擋 preflight 的程式問題。

非阻擋觀察（僅記錄，依指示不修改）：currency 值僅驗「非空白」，未驗 ISO-4217 格式／大小寫正規化
（如 `"twd "` 原樣入庫；identity 層 matching 有 normalizeHardKey 大小寫正規化）。屬未來 hardening 候選，非 preflight／migration-safety blocker。

## SOURCE_CHANGES

本輪：**無**（NO_SOURCE_CHANGE_REQUIRED）。理由：Owner 指示「沒有新的 source blocker 不要為了有修改而修改」；
currency gate 已由 `1f800c4` 完整實作且有測試鎖定，其餘差異經 review 無 blocker。

## CURRENCY_POLICY

實作與測試對照（route.ts L119-123 + tests/p2-import-currency.test.mjs）：

| Gate | 實作 | 測試 |
|---|---|---|
| P2 missing currency → HTTP 400 | ✓（`!trimmed(row.currency)`，400 且 0 列寫入） | ✓ "P2 import missing currency returns HTTP 400" |
| P2 blank currency → HTTP 400 | ✓（trimmed 空白 → null） | ✓ "does not infer currency from a USD-looking fund name"（空白 + USD 命名基金 → 400） |
| explicit TWD → accepted | ✓ 201，入庫 TWD | ✓ |
| explicit USD → accepted | ✓ 201，入庫 USD | ✓ |
| currency inference → forbidden | ✓ gate 直接 400，無任何名稱/來源推斷 | ✓ USD-looking name 測試 |
| legacy missing currency → 既有 TWD 行為不變 | ✓ 非 p2 路徑維持 `row.currency ?? "TWD"` | ✓ "legacy import missing currency keeps the pre-existing TWD default" |

上輪獨立 probe（stub cloudflare:workers 直呼真 handler）與本輪 26/26 測試雙重確認，無回退。

## TEST_RESULTS

- targeted/migration tests：**26/26 PASS**（p2-import-currency 5 + p2-contracts 7 + p2-idempotency-index + p2-shadow-portfolio + import-idempotency；每測試皆 verbatim 套用 0000–0005 六個 migration 至 fresh in-memory DB）
- full regression：**77 tests / 73 PASS / 4 FAIL**；4 FAIL 與 main baseline 同名同因（ui-components 的 chart/sidebar 缺檔 ×2、rendered-html 的 cloudflare: scheme、scrollbar-width CSS assertion）→ 既有 baseline，非 P2 引入
- lint：**PASS**（exit 0）
- build（npm test 前置 vinext build）：PASS

## TYPECHECK_BASELINE

`tsc --noEmit`（repo 無 typecheck script，從未 tsc-clean）：

- branch @ `1f800c4`：**9 個錯誤，全數 baseline 類**：7× TS2307 `cloudflare:workers` 無法解析（6 個既有 route 檔 + db/index.ts，另 P2 新增的 shadow route 檔含**同類**環境性錯誤）、2× worker/index.ts Fetcher/D1Database（P2 未觸碰的檔）
- main baseline：9 個錯誤（7× TS2307 + 2× worker + 1× lib/portfolio.ts 型別錯誤）
- **P2 邏輯新增 diagnostics = 0**；`98ed442` 引入的 6 個 import-route strict-mode 診斷已由 `1f800c4` 全數消除；P2 並修掉 main 的 lib/portfolio.ts 錯誤
- 分類說明：shadow route 的 TS2307 與所有既有 route 檔同一環境性類別（`cloudflare:` scheme 需 CF types），不計為 P2 邏輯診斷

## PRODUCTION_READONLY_PREFLIGHT

**未執行（BLOCKED）**。Production 狀態：未查詢、未寫入（沿用上輪事實，本輪亦未接觸）。

既有本地間接證據（非 live 驗證）：
- production 備份 `backups/sites-d1-2026-10-06.json`：4 表 275 筆（imports 54、positions 205、ocr_documents 13、portfolio_snapshots 3）；schema = 0000–0004，**0005 未套用**
- 備份→sqlite restore path 已於本地獨立重放驗證（275 筆完整還原）
- production 無 `account_source_mappings` 表 → 目前無任何 registered mapping；`PRODUCTION_V2_ACCOUNT_IDENTITY_POLICY=REGISTERED_MAPPING_ONLY` 尚無法 live 驗證

## ACCESS_BLOCKERS

1. **無 production 存取憑證／途徑**：repo 無 wrangler 設定檔與 CF OAuth token（含 `.sites-runtime` 重導向 HOME）、shell 無 `SITES_SYNC_HEADERS`、無部署站 URL → 無法執行 readonly preflight（連 SELECT 都不可得），亦無法驗證 backup/restore 於 live 端的可用性。
2. （已解除）currency gate 矛盾 → `1f800c4` 已修正並驗證。

## GIT_SCOPE

- worktree `.worktrees/p2-owner-implementation`：分支 `agent/p2-owner-implementation`，HEAD = `1f800c4`，tracked 工作區乾淨；untracked 僅 `tsconfig.tsbuildinfo`（tsc build artifact，非 source，未提交）
- 本輪新增檔案僅本進度文檔（canonical repo `docs/zcode/P2_ZCODE_PROGRESS_20261007.md`，untracked）
- 無 secrets／.env／production dump／credentials 進入任何 commit；`backups/` 已 gitignore
- 禁令遵守：無 amend、無 force push、無 reset、無 main mutation

## UNRESOLVED_BLOCKERS

1. Production D1 READONLY preflight 無法執行（見 ACCESS_BLOCKERS #1）——唯一阻擋進入 Owner production gate 的硬阻塞。
2. （軟性，非阻塞）currency 格式 hardening 候選（見 SOURCE_REVIEW 非阻擋觀察）。

## OWNER_DECISIONS_REQUIRED

1. 提供 production readonly 驗證途徑（`SITES_SYNC_HEADERS`／部署站 URL，或 CF readonly 憑證），或由 Owner 自行執行 preflight；在 preflight 完成前 cutover 維持 NO-GO。
2. `COMMIT_PUSH=HOLD` 之解除時機與本進度文檔是否隨下次 commit 入庫（`docs/zcode/` 目前 untracked）。
3. （選填）是否要求後續 hardening commit：currency 值 ISO-4217 格式／大小寫正規化。

## NEXT_GATE

Production D1 **READONLY preflight** → Owner gate。通過條件（依前輪協定）：
- reachable/readable、expected tables、schema/version（production 應為 0000–0004，0005 未套用）、
  imports/positions 列數（對照 2026-10-06 備份：54 / 205，需重新讀取確認無漂移）
- backup/restore path 可用性確認
- `PRODUCTION_V2_ACCOUNT_IDENTITY_POLICY=REGISTERED_MAPPING_ONLY` 對照確認
- 全程禁止 INSERT／UPDATE／DELETE／migration apply／schema change／cutover／repair

## SOURCE_MUTATION=NO

## COMMIT_PUSH=HOLD

## PRODUCTION_MUTATION=NO

## PRODUCTION_CUTOVER=NO-GO


---

## TRACK_Z_BASELINE_CLEANUP_CLOSEOUT

更新時間：由 TUF A16 DC 實機執行。

### Branch / Git

- Branch: `agent/p2-zcode-baseline-cleanup`
- Base: `1f800c4abacccb2d712112412fc19b22ad36f23b`
- Commit: `99dd1e228f30da04f67e4007e82d4b59c053bba1`
- Commit message: `fix: clear baseline regression gates`
- Push: PASS
- LOCAL_SHA == REMOTE_SHA: YES
- Worktree: CLEAN

### Baseline cleanup

原本 4 個 main baseline regression 已全數解除：

1. rendered-html / `cloudflare:` Node loader：PASS
2. CSS catalog scrollbar utility：PASS
3. `components/ui/chart.tsx` missing：PASS
4. `components/ui/sidebar.tsx` missing：PASS

同時加入最小 Cloudflare runtime type shim，清除既有 `cloudflare:workers` / `Fetcher` / `D1Database` typecheck baseline。

### Verification

- build: PASS
- lint: PASS
- `tsc --noEmit`: PASS / 0 errors
- P2 targeted + migration: 26/26 PASS
- currency policy tests: 5/5 PASS
- full regression: **77/77 PASS**
- new regression: NO
- secrets scan: CLEAN
- scope: 7 files / baseline-cleanup only

### Production gate

- Production D1 live readonly preflight: BLOCKED_BY_ACCESS
- `CLOUDFLARE_API_TOKEN`: UNSET
- `CF_API_TOKEN`: UNSET
- `CLOUDFLARE_ACCOUNT_ID`: UNSET
- `SITES_SYNC_HEADERS`: UNSET
- `SITES_BASE_URL`: UNSET
- Production query performed: NO
- Production mutation performed: NO
- PRODUCTION_WRITE=NO
- PRODUCTION_CUTOVER=NO-GO

### Track status

```text
TRACK_P=BLOCKED_BY_ACCESS
TRACK_Z=DONE
TRACK_T=PASS_BY_DC_INDEPENDENT_VERIFICATION
TRACK_R=PASS_SCOPE_AND_SECRET_REVIEW
TRACK_H=READY_FOR_HANDOFF
OWNER_ACTION=PROVIDE_OR_RUN_PRODUCTION_READONLY_PREFLIGHT
```