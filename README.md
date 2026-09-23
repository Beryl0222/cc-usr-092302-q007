# 重点药品报送对账

监管部门对齐药企、园区和地区上报的重点药品生产供应事实。

`fixtures/supply_declaration.json` 保存一条经过脱敏的业务样例，源代码只定义读取这份样例所需的最小合同。后续模块应保持既有标识和时间含义，新增状态必须说明迁移方式。

## 申报文件恢复链

`src/recovery.js` 负责停机后的申报文件重放，`src/declaration.js` 负责扫描与校验，`src/logging.js` 负责日志脱敏。

### 申报文件格式（schema_version: 1）

```json
{
  "schema_version": 1,
  "file_id": "decl-2026-09-20-001",
  "records": [
    { "record_id": "B-1", "declaration_type": "batch",  "drug_code": "D-100", "quantity": 500, "occurred_at": "..." },
    { "record_id": "D-1", "declaration_type": "detail", "batch_record_id": "B-1", "drug_code": "D-100", "quantity": 50, "occurred_at": "..." }
  ]
}
```

- 每条记录从原始顺序保留 `index`（0 起），文件内所有报告都用它定位；
- 明细→批次的关联在整份文件扫描完成后统一结算，先明细后批次的正常申报不会被当成孤儿；
- 版本超出支持范围（当前仅支持 1）的文件保留原文、不猜测解析，结果状态为 `unsupported_version`。

### 问题分类（四类分开报告）

| 类别 | 含义 |
| --- | --- |
| `duplicate_identifier` | 同一记录号在文件内出现多次，报告全部位置 |
| `unknown_declaration_type` | 申报类型不是 `batch` / `detail` |
| `missing_batch_relation` | 明细引用的批次在整份文件中不存在（或已被隔离） |
| `invalid_field_shape` | 字段形状错误（类型、必填、取值范围） |

部分记录不合规时，合法申报仍进入待提交集合；隔离项修正后经 `applyCorrections` 携带原位置重新并入。

### 检查点状态机与迁移

检查点按文件名记录：`processing`（处理中）→ `completed`（已完成），同名文件内容变化时进入 `paused_conflict`（暂停，待人工比较）。

- 检查点同时记住 `persistedRecordIds`（已持久化记录）与 `notifications`（已发出的入库通知），每个副作用落盘一次，因此停机后重放只续跑未完成部分，相同文件重试只返回既有结果；
- `paused_conflict` 不会自动解除：人工比较后调用 `resolveConflict`，`keep_original` 恢复暂停前状态，`reprocess` 以确认后的原文重新处理；
- 迁移方式：基线版本没有检查点仓库，首次运行所有文件按新文件处理；既有 `loadRecord` 合同与样例不受影响。`paused_conflict` 是新增状态，旧文件不会进入该状态，只有“同名但内容哈希不同”的重放才会触发。

### 日志

普通日志只含记录号、位置、类别等技术标识；供应商敏感字段（名称、电话、邮箱、地址、信用代码）由 `src/logging.js` 统一替换为 `***`。

## 本地检查

运行 `npm test`。
