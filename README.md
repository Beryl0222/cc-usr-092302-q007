# 重点药品报送对账

监管部门对齐药企、园区和地区上报的重点药品生产供应事实。

`fixtures/supply_declaration.json` 保存一条经过脱敏的业务样例，源代码只定义读取这份样例所需的最小合同。后续模块应保持既有标识和时间含义，新增状态必须说明迁移方式。

## 本地检查

运行 `npm test`。

## 申报文件恢复链

停机重放曾造成两类事故：重复发送入库通知，以及把“先明细、后批次主记录”的正常申报误判为孤儿。恢复链由以下模块组成：

| 模块 | 职责 |
| --- | --- |
| `src/contracts.js` | 既有最小读取合同 `loadRecord`，保持不变 |
| `src/reader.js` | 原文指纹、信封/NDJSON 解析、版本闸门、逐条位置 `{index, line}` |
| `src/pipeline.js` | 纯函数：四类问题分类、文件末乱序关联、隔离修正回并 |
| `src/checkpoint.js` | 原子落盘的检查点存储与冲突/版本状态 |
| `src/service.js` | 持久化与入库通知的幂等编排、停机恢复、原文保留 |
| `src/logging.js` | 普通日志脱敏（供应商字段与业务原文不输出） |

### 支持的文件形状（当前 schema_version = 1）

- NDJSON：每行一条记录，允许空行；`line` 为 1 基行号；
- 批式信封：`{"schema_version":1,"file_id":"...","records":[...]}`（支持 pretty 打印）；
- 单条记录对象：与既有样例同形状（`record_id` + 顶层 `schema_version`）。

记录信封：`{record_id, record_type, payload, schema_version?}`，其中
`record_type` 为 `batch_master` 或 `batch_detail`，两类的
`payload.batch_no` 必须是非空字符串。

### 位置与关联

- 每条记录的 `index`（文件内 0 基原始序号）贯穿待提交集合、隔离项、
  报告和检查点；NDJSON 另带 `line`。
- 明细与批次主记录的关系统一在**整份文件读取结束后**完成，明细先于
  主记录出现是正常情形，关联结果以 `association.order`
  （`detail_first` / `master_first`）说明先后。
- 文件结束仍找不到主记录的明细才报“确实缺失批次关系”。

### 四类分开的报告

`malformedShapes`（错误字段形状，含无法解析的原文）、`unknownTypes`
（未知申报类型）、`duplicates`（重复标识，给出首次与重复两个位置）、
`missingRelations`（文件结束仍缺失的批次关系）。部分记录不合规时，
其余合法申报照常进入待提交集合；隔离项 id 稳定为 `q<index>`，携带
原位置，可用 `reintegrate(batch, {q<index>: 修正记录})` 重新并入，
修正缺失的主记录后先前被隔离的明细会自动恢复关联。

### 检查点状态与迁移

检查点（`checkpoint_version: 1`）同时记住已持久化记录（按 `index`）
与已发出通知（按 `record_id`），每个副作用登记后原子落盘：

- `crashed`：提交中停机，重放同一文件只补缺口，不重复持久化/通知；
- `ready`：完成。同文件同内容重试直接返回既有结果，零副作用；
  携带隔离修正的重投是一次新提交，已完成部分仍不重复；
- `content_conflict`：同名文件内容指纹变化，暂停并逐字保留来文，
  交人工比较，不做任何合并或猜测；
- `unsupported_version`：文件版本高于支持范围，逐字保留原文，
  不按低版本形状解析。

版本演进约定：同版本只允许新增可选字段；出现更高版本时一律走
`unsupported_version` 保留原文，待人工迁移，绝不在代码中猜测解析。

普通日志只保留 `file_id`、`record_id`、`index/line`、`batch_no`、
计数等追踪字段；供应商名称、联系方式、价格数量与业务原文均脱敏
（见 `src/logging.js` 的 `SENSITIVE_KEYS`）。
