import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/**
 * 检查点存储。
 *
 * 每个申报文件以 file_id 为键保存一份检查点，它同时记住两类事实：
 *   1. 已持久化的记录（persisted，按文件内 index）；
 *   2. 已发出的入库通知（notifications，按 record_id 幂等键）。
 *
 * 因此重放同一文件时，已完成的副作用不会重复：既不会重复入库，也
 * 不会重复发送通知（修复事故中的双重入库通知）。
 *
 * 同名文件内容变化（内容指纹不一致）时不允许覆盖或合并：检查点
 * 标记为 CONTENT_CONFLICT 并暂停，交由人工比较两份内容。
 *
 * 写入采用临时文件 + 原子 rename；状态迁移版本化（checkpoint_version）。
 */

export const STATUS_READY = 'ready'; // 处理完成，结果可复用
export const STATUS_PAUSED_CONFLICT = 'content_conflict'; // 内容冲突，人工处理
export const STATUS_UNSUPPORTED = 'unsupported_version'; // 高版本原文已保留
export const STATUS_CRASHED = 'crashed'; // 上次处理中途停止，可安全续跑

export const CHECKPOINT_VERSION = 1;

export class ContentConflictError extends Error {
  constructor(fileId, previousHash, currentHash) {
    super(
      `文件 '${fileId}' 内容与已处理版本不一致（已暂停，需人工比较）`,
    );
    this.name = 'ContentConflictError';
    this.fileId = fileId;
    this.previousHash = previousHash;
    this.currentHash = currentHash;
  }
}

export class UnsupportedVersionError extends Error {
  constructor(declared, supported) {
    super(`文件版本 ${declared} 超出支持范围（当前支持 <= ${supported}）`);
    this.name = 'UnsupportedVersionError';
    this.declared = declared;
    this.supported = supported;
  }
}

/** 基于目录的检查点存储；生产用磁盘，测试可传入内存目录实现。 */
export class FsCheckpointStore {
  constructor(rootDir) {
    this.rootDir = rootDir;
  }

  pathFor(fileId) {
    return join(this.rootDir, `${encodeURIComponent(fileId)}.json`);
  }

  async load(fileId) {
    let text;
    try {
      text = await readFile(this.pathFor(fileId), 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return JSON.parse(text);
  }

  async save(fileId, checkpoint) {
    await mkdir(this.rootDir, { recursive: true });
    const target = this.pathFor(fileId);
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random()
      .toString(36)
      .slice(2)}`;
    await writeFile(tmp, JSON.stringify(checkpoint), 'utf8');
    await rename(tmp, target);
  }
}
