/**
 * 供应申报恢复链。
 *
 * 检查点同时记住两类事实：
 * - persistedRecordIds：已经持久化的记录；
 * - notifications：已经发出的入库通知。
 * 因此停机后从头重放同一份文件时，已完成的步骤不会重复执行，
 * 重试只返回既有结果；同名文件内容发生变化则暂停，交由人工比较。
 */
import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { analyzeDeclarations, parseDeclarationFile, reintegrateDeclaration } from './declaration.js';
import { createNullLogger } from './logging.js';

export const CHECKPOINT_STATES = Object.freeze({
  PROCESSING: 'processing',
  COMPLETED: 'completed',
  PAUSED_CONFLICT: 'paused_conflict',
});

export class RecoveryError extends Error {
  constructor(message, options) {
    super(message, options);
    this.name = 'RecoveryError';
  }
}

function hashText(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 内存检查点仓库：进程内有效，测试用它模拟“同一仓库、两个服务实例”。 */
export function createMemoryCheckpointStore() {
  const files = new Map();
  return {
    async load(name) {
      return files.has(name) ? structuredClone(files.get(name)) : null;
    },
    async save(name, checkpoint) {
      files.set(name, structuredClone(checkpoint));
    },
    async delete(name) {
      files.delete(name);
    },
    async snapshot() {
      return structuredClone(Object.fromEntries(files));
    },
  };
}

/** 文件检查点仓库：临时文件 + 改名落盘，避免半截检查点。 */
export function createFileCheckpointStore(path) {
  async function readAll() {
    try {
      return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return {};
      throw error;
    }
  }
  async function writeAll(data) {
    await mkdir(dirname(path), { recursive: true });
    const tmp = join(dirname(path), `.checkpoint-${process.pid}-${Date.now()}.tmp`);
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, path);
  }
  return {
    async load(name) {
      const all = await readAll();
      return all.files?.[name] ?? null;
    },
    async save(name, checkpoint) {
      const all = await readAll();
      all.files = { ...(all.files ?? {}), [name]: checkpoint };
      await writeAll(all);
    },
    async delete(name) {
      const all = await readAll();
      if (all.files) delete all.files[name];
      await writeAll(all);
    },
  };
}

function emptyCheckpoint(contentHash) {
  return {
    contentHash,
    state: CHECKPOINT_STATES.PROCESSING,
    fileId: null,
    analysis: null,
    persistedRecordIds: [],
    notifications: [],
    result: null,
    conflict: null,
  };
}

/**
 * 创建恢复链服务。
 * persist(record, context)：持久化一条合法申报；
 * notify(notification)：发出一条入库通知（每个批次一条，notificationId 确定）；
 * 两者都可能因停机抛错，检查点会在每个副作用之后落盘，重放时自动续跑。
 */
export function createRecoveryService({ store, persist, notify, logger } = {}) {
  if (!store) throw new RecoveryError('恢复链需要检查点仓库');
  const log = logger ?? createNullLogger();
  const persistRecord = persist ?? (async () => {});
  const sendNotification = notify ?? (async () => {});

  async function persistPending(name, checkpoint) {
    for (const item of checkpoint.analysis.pending) {
      if (checkpoint.persistedRecordIds.includes(item.recordId)) continue;
      await persistRecord(item.record, { file: name, index: item.index });
      checkpoint.persistedRecordIds.push(item.recordId);
      await store.save(name, checkpoint);
      log.info('record_persisted', { file: name, index: item.index, recordId: item.recordId });
    }
  }

  async function notifyPending(name, checkpoint) {
    for (const item of checkpoint.analysis.pending) {
      if (item.type !== 'batch') continue;
      const notificationId = `inbound:${checkpoint.fileId}:${item.recordId}`;
      if (checkpoint.notifications.some((n) => n.notificationId === notificationId)) continue;
      const notification = {
        notificationId,
        kind: 'inbound_notification',
        fileId: checkpoint.fileId,
        recordId: item.recordId,
      };
      await sendNotification(notification);
      checkpoint.notifications.push(notification);
      await store.save(name, checkpoint);
      log.info('notification_sent', { file: name, notificationId, recordId: item.recordId });
    }
  }

  async function complete(name, checkpoint) {
    const { analysis } = checkpoint;
    const result = {
      status: 'completed',
      file: name,
      fileId: checkpoint.fileId,
      contentHash: checkpoint.contentHash,
      pending: analysis.pending,
      quarantine: analysis.quarantine,
      associations: analysis.associations,
      issues: analysis.issues,
      persistedRecordIds: [...checkpoint.persistedRecordIds],
      notifications: [...checkpoint.notifications],
    };
    checkpoint.state = CHECKPOINT_STATES.COMPLETED;
    checkpoint.result = result;
    await store.save(name, checkpoint);
    log.info('file_completed', {
      file: name,
      pending: analysis.pending.length,
      quarantined: analysis.quarantine.length,
      notifications: checkpoint.notifications.length,
    });
    return result;
  }

  async function processFile(name, text, checkpoint) {
    const parsed = parseDeclarationFile(text);
    if (parsed.kind === 'unsupported_version') {
      // 版本超出支持范围：保留原文，不猜测解析，也不产生任何副作用。
      const result = {
        status: 'unsupported_version',
        file: name,
        schemaVersion: parsed.schemaVersion,
        rawText: parsed.rawText,
      };
      checkpoint.state = CHECKPOINT_STATES.COMPLETED;
      checkpoint.result = result;
      await store.save(name, checkpoint);
      log.warn('unsupported_version_kept_raw', { file: name, schemaVersion: parsed.schemaVersion });
      return result;
    }

    checkpoint.fileId = parsed.fileId ?? name;
    checkpoint.analysis = analyzeDeclarations(parsed.entries);
    await store.save(name, checkpoint);
    log.info('file_scanned', {
      file: name,
      fileId: checkpoint.fileId,
      pending: checkpoint.analysis.pending.length,
      quarantined: checkpoint.analysis.quarantine.length,
    });
    for (const item of checkpoint.analysis.quarantine) {
      log.info('record_quarantined', {
        file: name,
        index: item.index,
        recordId: item.recordId,
        category: item.category,
        record: item.record,
      });
    }

    await persistPending(name, checkpoint);
    await notifyPending(name, checkpoint);
    return complete(name, checkpoint);
  }

  async function recoverFile({ name, text }) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new RecoveryError('恢复链需要文件名作为检查点标识');
    }
    const contentHash = hashText(text);
    const existing = await store.load(name);

    if (existing && existing.state === CHECKPOINT_STATES.PAUSED_CONFLICT) {
      // 已暂停的冲突必须经人工比较结论解除，重放不再自动处理。
      return conflictResult(name, existing);
    }
    if (existing && existing.contentHash === contentHash) {
      if (existing.state === CHECKPOINT_STATES.COMPLETED) {
        log.info('replay_returns_existing', { file: name, contentHash });
        return existing.result;
      }
      log.info('replay_resumes', { file: name, persisted: existing.persistedRecordIds.length });
      return processFile(name, text, existing);
    }
    if (existing) {
      const paused = {
        ...existing,
        state: CHECKPOINT_STATES.PAUSED_CONFLICT,
        conflict: {
          previousState: existing.state,
          expectedHash: existing.contentHash,
          receivedHash: contentHash,
          receivedText: text,
        },
      };
      await store.save(name, paused);
      log.warn('content_conflict_paused', { file: name, expectedHash: existing.contentHash, receivedHash: contentHash });
      return conflictResult(name, paused);
    }

    const checkpoint = emptyCheckpoint(contentHash);
    await store.save(name, checkpoint);
    return processFile(name, text, checkpoint);
  }

  function conflictResult(name, checkpoint) {
    return {
      status: 'conflict',
      file: name,
      expectedHash: checkpoint.conflict.expectedHash,
      receivedHash: checkpoint.conflict.receivedHash,
      persistedRecordIds: [...checkpoint.persistedRecordIds],
      notifications: [...checkpoint.notifications],
    };
  }

  /** 修正隔离项并携带原位置重新并入；并入后照常持久化、发通知。 */
  async function applyCorrections(name, corrections) {
    const checkpoint = await store.load(name);
    if (!checkpoint || checkpoint.state !== CHECKPOINT_STATES.COMPLETED || !checkpoint.analysis) {
      throw new RecoveryError(`文件 ${name} 尚未完成处理，无法并入修正`);
    }
    let analysis = checkpoint.analysis;
    for (const correction of corrections) {
      analysis = reintegrateDeclaration(analysis, correction);
      log.info('correction_merged', { file: name, index: correction.index, recordId: correction.record?.record_id });
    }
    checkpoint.analysis = analysis;
    checkpoint.state = CHECKPOINT_STATES.PROCESSING;
    await store.save(name, checkpoint);
    await persistPending(name, checkpoint);
    await notifyPending(name, checkpoint);
    return complete(name, checkpoint);
  }

  /** 人工比较结论：keep_original 恢复原状态；reprocess 以新原文重新处理。 */
  async function resolveConflict(name, decision = {}) {
    const checkpoint = await store.load(name);
    if (!checkpoint || checkpoint.state !== CHECKPOINT_STATES.PAUSED_CONFLICT) {
      throw new RecoveryError(`文件 ${name} 没有待处理的内容冲突`);
    }
    if (decision.action === 'keep_original') {
      const restored = { ...checkpoint, state: checkpoint.conflict.previousState, conflict: null };
      await store.save(name, restored);
      log.info('conflict_resolved', { file: name, action: 'keep_original' });
      return restored.result ?? { status: restored.state, file: name };
    }
    if (decision.action === 'reprocess') {
      if (typeof decision.text !== 'string') {
        throw new RecoveryError('reprocess 需要提供人工确认后的文件原文');
      }
      await store.delete(name);
      log.info('conflict_resolved', { file: name, action: 'reprocess' });
      return recoverFile({ name, text: decision.text });
    }
    throw new RecoveryError(`未知的人工比较结论: ${decision.action}`);
  }

  return { recoverFile, applyCorrections, resolveConflict };
}
