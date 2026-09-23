import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CHECKPOINT_VERSION,
  ContentConflictError,
  STATUS_CRASHED,
  STATUS_PAUSED_CONFLICT,
  STATUS_READY,
  STATUS_UNSUPPORTED,
  UnsupportedVersionError,
} from './checkpoint.js';
import { createSafeLogger } from './logging.js';
import {
  processEntries,
  reintegrate,
} from './pipeline.js';
import {
  SUPPORTED_SCHEMA_VERSION,
  extractEntries,
  hashRaw,
} from './reader.js';

/**
 * 供应协同恢复服务。
 *
 * 处理一个申报文件的完整生命周期：
 *   读取（版本闸门）→ 分类与文件末关联 → 持久化 → 入库通知，
 * 每一步都落在检查点里；任意时刻停机后重放同一文件都只补齐缺口，
 * 绝不重复持久化或重复通知。
 */
export class SupplyCollaborationService {
  /**
   * @param {object} options
   * @param {import('./checkpoint.js').FsCheckpointStore} options.store 检查点存储
   * @param {string} [options.preserveDir] 高版本/冲突原文保留目录
   * @param {(entry: object) => Promise<void>} options.persistRecord
   *        持久化单条合法申报（entry 含 index/line/record/association）
   * @param {(entry: object) => Promise<void>} options.sendNotification
   *        发送入库通知；按 record_id 幂等
   * @param {() => string} [options.now] 可注入时钟
   * @param {object} [options.logger]
   */
  constructor({
    store,
    preserveDir,
    persistRecord,
    sendNotification,
    onEntryPersisted,
    onEntryCommitted,
    now = () => new Date().toISOString(),
    logger = console,
  }) {
    this.store = store;
    this.preserveDir = preserveDir;
    this.persistRecord = persistRecord;
    this.sendNotification = sendNotification;
    // 两个检查点落盘后的提交边界回调，供测试在确定性位置模拟停机：
    // persisted 边界在持久化登记之后、通知之前；committed 在两者之后。
    this.onEntryPersisted = onEntryPersisted ?? null;
    this.onEntryCommitted = onEntryCommitted ?? null;
    this.now = now;
    this.log = createSafeLogger(logger);
  }

  /**
   * 处理（或恢复处理）一个申报文件。
   *
   * @param {object} input
   * @param {string} input.fileId 文件名/投递标识（同名重试必须一致）
   * @param {string} input.rawText 文件原文（解析前字节）
   * @param {Record<string, object>} [input.corrections]
   *        隔离项修正，键为 qid（q<index>），值为修正后的完整记录
   * @returns {Promise<object>} 结构化结果；同文件重试返回既有结果
   */
  async processFile({ fileId, rawText, corrections }) {
    const contentHash = hashRaw(rawText);

    // 1) 版本闸门：超限版本保留原文，绝不猜测解析。
    let extracted;
    try {
      extracted = extractEntries(rawText);
    } catch (error) {
      if (error.kind === 'unsupported_version') {
        const rawPath = await this.preserveRaw(
          fileId,
          `unsupported-v${error.declared}`,
          contentHash,
          rawText,
        );
        await this.store.save(fileId, {
          checkpoint_version: CHECKPOINT_VERSION,
          file_id: fileId,
          content_hash: contentHash,
          status: STATUS_UNSUPPORTED,
          declared_version: error.declared,
          supported_version: error.supported,
          preserved_raw: rawPath,
          created_at: this.now(),
          updated_at: this.now(),
        });
        this.log.warn('file_unsupported_version_preserved', {
          file_id: fileId,
          declared_version: error.declared,
          supported_version: error.supported,
          preserved_raw: rawPath,
        });
        throw new UnsupportedVersionError(
          error.declared,
          error.supported,
        );
      }
      throw error;
    }

    const prior = await this.store.load(fileId);

    // 2) 同名文件内容变化：暂停并保留来文，交人工比较。
    if (prior && prior.content_hash !== contentHash) {
      const rawPath = await this.preserveRaw(
        fileId,
        'content-conflict',
        contentHash,
        rawText,
      );
      await this.store.save(fileId, {
        ...prior,
        status: STATUS_PAUSED_CONFLICT,
        conflict: {
          previous_hash: prior.content_hash,
          current_hash: contentHash,
          preserved_incoming_raw: rawPath,
          detected_at: this.now(),
        },
        updated_at: this.now(),
      });
      this.log.error('file_content_conflict_paused', {
        file_id: fileId,
        previous_hash: prior.content_hash,
        current_hash: contentHash,
        preserved_incoming_raw: rawPath,
      });
      throw new ContentConflictError(
        fileId,
        prior.content_hash,
        contentHash,
      );
    }

    // 3) 分类、关联与隔离修正（纯函数；重放时重新计算，不存敏感载荷）。
    let batch = processEntries(extracted.entries);
    if (corrections) {
      batch = reintegrate(batch, corrections);
    }
    const plan = batch.pending.map((entry) => ({
      index: entry.index,
      line: entry.line,
      record_id: entry.record.record_id,
      record_type: entry.record.record_type,
      batch_no: entry.record.payload?.batch_no ?? null,
      association: entry.association,
    }));
    const summaries = summarizeBatch(batch);

    // 4) 全新文件：先落“提交中”检查点。若在持久化开始前停机，
    //    重放时看到该状态会从零安全续跑（尚无副作用）。
    if (!prior) {
      const checkpoint = {
        checkpoint_version: CHECKPOINT_VERSION,
        file_id: fileId,
        content_hash: contentHash,
        schema_version:
          extracted.envelope?.schema_version ?? SUPPORTED_SCHEMA_VERSION,
        status: STATUS_CRASHED,
        phase: 'commit',
        plan,
        persisted: [],
        notifications: [],
        result: null,
        ...summaries,
        created_at: this.now(),
        updated_at: this.now(),
      };
      await this.store.save(fileId, checkpoint);
    }

    const current = (await this.store.load(fileId)) ?? prior;

    // 5) 相同文件、内容未变且没有新修正：只返回既有结果，不触发副作用。
    //    携带隔离修正的重投是一次新的提交尝试，必须继续走完提交循环；
    //    已持久化/已通知的记录由下面的幂等集合保证不会重复。
    if (
      current.status === STATUS_READY &&
      (!corrections || Object.keys(corrections).length === 0)
    ) {
      this.log.info('file_replayed_returning_existing_result', {
        file_id: fileId,
        content_hash: contentHash,
        persisted_count: current.persisted.length,
        notifications_count: current.notifications.length,
      });
      return current.result;
    }
    if (current.status === STATUS_PAUSED_CONFLICT) {
      // 理论上前置分支已按 hash 拦截；保留防御性分支。
      throw new ContentConflictError(fileId, current.content_hash, contentHash);
    }

    // 携带修正重投：以最新计划与报告刷新检查点摘要。
    if (corrections && Object.keys(corrections).length > 0) {
      current.plan = plan;
      Object.assign(current, summaries);
    }
    current.status = STATUS_CRASHED;
    current.phase = 'commit';
    current.updated_at = this.now();
    await this.store.save(fileId, current);
    const persistedSet = new Set(current.persisted);
    const notifiedSet = new Set(current.notifications.map((n) => n.record_id));

    for (const entry of batch.pending) {
      // 6) 持久化：已持久化的记录跳过（崩溃在持久化之后时）。
      if (!persistedSet.has(entry.index)) {
        await this.persistRecord(entry);
        persistedSet.add(entry.index);
        current.persisted = [...current.persisted, entry.index].sort(
          (a, b) => a - b,
        );
        current.updated_at = this.now();
        await this.store.save(fileId, current);
        this.log.info('record_persisted', {
          file_id: fileId,
          record_id: entry.record.record_id,
          index: entry.index,
          line: entry.line,
        });
        if (this.onEntryPersisted) {
          await this.onEntryPersisted(entry);
        }
      }

      // 7) 入库通知：按 record_id 幂等。崩溃在通知之后时绝不重发。
      if (!notifiedSet.has(entry.record.record_id)) {
        await this.sendNotification(entry);
        notifiedSet.add(entry.record.record_id);
        current.notifications = [
          ...current.notifications,
          {
            record_id: entry.record.record_id,
            index: entry.index,
            notified_at: this.now(),
          },
        ];
        current.updated_at = this.now();
        await this.store.save(fileId, current);
        this.log.info('warehouse_notification_sent', {
          file_id: fileId,
          record_id: entry.record.record_id,
          index: entry.index,
          batch_no: entry.record.payload?.batch_no ?? null,
          association_order: entry.association?.order ?? null,
        });
      }

      // 检查点已同时记录持久化与通知；此处是崩溃模拟的提交边界。
      if (this.onEntryCommitted) {
        await this.onEntryCommitted(entry);
      }
    }

    // 8) 收尾：检查点同时记住已持久化记录与已发通知，标记就绪。
    const result = Object.freeze({
      status: STATUS_READY,
      file_id: fileId,
      content_hash: contentHash,
      resumed: current.persisted.length > 0 || current.notifications.length > 0,
      persisted: Object.freeze([...current.persisted]),
      notifications: Object.freeze(
        current.notifications.map((n) => n.record_id),
      ),
      ...summaries,
    });
    current.status = STATUS_READY;
    current.phase = 'done';
    current.result = result;
    current.updated_at = this.now();
    await this.store.save(fileId, current);

    this.log.info('file_processed', {
      file_id: fileId,
      content_hash: contentHash,
      persisted_count: result.persisted.length,
      notifications_count: result.notifications.length,
      quarantined_count: result.quarantine.length,
      report_counts: {
        malformed_shapes: result.reports.malformedShapes.length,
        unknown_types: result.reports.unknownTypes.length,
        duplicates: result.reports.duplicates.length,
        missing_relations: result.reports.missingRelations.length,
      },
    });

    return result;
  }

  async preserveRaw(fileId, reason, contentHash, rawText) {
    if (!this.preserveDir) return null;
    await mkdir(this.preserveDir, { recursive: true });
    const safeReason = reason.replace(/[^a-zA-Z0-9._-]/g, '_');
    const path = join(
      this.preserveDir,
      `${encodeURIComponent(fileId)}.${safeReason}.${contentHash.slice(0, 12)}.raw`,
    );
    await writeFile(path, rawText, 'utf8');
    return path;
  }
}

/** 检查点只保存追踪所需的非敏感摘要（位置、标识、类别与原因）。 */
function summarizeBatch(batch) {
  return {
    reports: {
      malformedShapes: batch.reports.malformedShapes.map((r) => ({
        index: r.index,
        line: r.line,
        reason: r.reason,
        record_id: r.record?.record_id ?? null,
      })),
      unknownTypes: batch.reports.unknownTypes.map((r) => ({ ...r })),
      duplicates: batch.reports.duplicates.map((r) => ({ ...r })),
      missingRelations: batch.reports.missingRelations.map((r) => ({ ...r })),
    },
    quarantine: batch.quarantine.map((q) => ({
      qid: q.qid,
      index: q.index,
      line: q.line,
      category: q.category,
      reason: q.reason,
      record_id: q.record?.record_id ?? null,
    })),
    associations: batch.associations.map((a) => ({
      batch_no: a.batch_no,
      master: a.master,
      details: a.details,
    })),
  };
}
