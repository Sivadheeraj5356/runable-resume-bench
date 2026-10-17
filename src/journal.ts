/**
 * journal.ts - append-only JSONL checkpoint journal.
 *
 * The journal is the single source of truth for what a durable workflow has
 * already done. Every completed step and every completed side effect appends
 * one line. On resume, the runner reads the journal and skips work that is
 * already recorded, so a crashed process never repeats finished work.
 *
 * Crash safety: a process can die halfway through writing a line, leaving a
 * torn final line. `Journal.load` detects a corrupt tail, truncates the file
 * back to the last complete record, and keeps going. A corrupt line anywhere
 * other than the tail is a hard error, because that means the file was
 * damaged by something other than a crash-on-write.
 */

import { appendFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export type RecordKind = 'step' | 'effect';

export interface JournalRecord {
  kind: RecordKind;
  workflowId: string;
  stepId: string;
  /** Effect name; undefined for step records. */
  name?: string;
  /** Hash of the step input, so stale memo entries cannot be reused after inputs change. */
  inputHash: string;
  /** Serialized return value, replayed on resume. */
  value: unknown;
  at: string;
  durationMs: number;
}

/** Deterministic stringify (sorted object keys) so identical inputs hash identically. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function hashInput(input: unknown): string {
  return createHash('sha256').update(stableStringify(input)).digest('hex').slice(0, 16);
}

export class Journal {
  readonly path: string;
  readonly records: JournalRecord[];

  private constructor(path: string, records: JournalRecord[]) {
    this.path = path;
    this.records = records;
  }

  /**
   * Load a journal from disk. Missing file means a fresh run. A torn final
   * line (crash mid-write) is truncated in place and recovery is reported.
   */
  static load(path: string): { journal: Journal; recoveredTornWrite: boolean } {
    if (!existsSync(path)) return { journal: new Journal(path, []), recoveredTornWrite: false };
    const raw = readFileSync(path, 'utf8');
    const lines = raw.split('\n');
    const records: JournalRecord[] = [];
    let recoveredTornWrite = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.trim() === '') continue;
      try {
        records.push(JSON.parse(line) as JournalRecord);
      } catch {
        const isTail = i >= lines.length - 2; // last line, or second-to-last before a trailing newline
        if (!isTail) {
          throw new Error(`journal ${path} is corrupt at line ${i + 1} (not a crash tail); refusing to resume`);
        }
        // Truncate the file back to the last complete record.
        const byteOffset = raw.indexOf(line);
        writeFileSync(path, raw.slice(0, byteOffset));
        recoveredTornWrite = true;
        break;
      }
    }
    return { journal: new Journal(path, records), recoveredTornWrite };
  }

  lookup(kind: RecordKind, workflowId: string, stepId: string, name: string | undefined, inputHash: string): JournalRecord | undefined {
    for (let i = this.records.length - 1; i >= 0; i--) {
      const r = this.records[i];
      if (r.kind === kind && r.workflowId === workflowId && r.stepId === stepId && r.name === name && r.inputHash === inputHash) {
        return r;
      }
    }
    return undefined;
  }

  append(record: JournalRecord): void {
    appendFileSync(this.path, JSON.stringify(record) + '\n');
    this.records.push(record);
  }

  get sizeBytes(): number {
    return existsSync(this.path) ? statSync(this.path).size : 0;
  }
}
