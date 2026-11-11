// Follows an append-only file of lines (a harness's JSONL transcript): the end of what is there, then each append.
// Runs on Node (the plugins are bundled for it): `node:*` only.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export class LineTail {
  private current: string | undefined;
  private offset = 0;
  /** Bytes after the last newline: kept as bytes, so a UTF-8 character split across two reads stays whole. */
  private partial: Buffer = Buffer.alloc(0);

  /** `onLine` gets each non-blank complete line; `live` is false for lines of the first read from a cut start. */
  constructor(private readonly onLine: (line: string, live: boolean) => void) {}

  get file(): string | undefined {
    return this.current;
  }

  /** Follows `file` from its last `startBytes` (the first, cut line skipped), reading what is there now. */
  open(file: string, startBytes: number): void {
    this.current = file;
    this.partial = Buffer.alloc(0);
    let size = 0;
    try {
      size = statSync(file).size;
    } catch {
      // Not written yet: read from its start once it is.
    }
    this.offset = Math.max(0, size - startBytes);
    this.readFrom(this.offset > 0);
  }

  /** Reads what was appended since the last read (a file that shrank is read again from its start). */
  read(): void {
    this.readFrom(false);
  }

  private readFrom(skipFirstLine: boolean): void {
    if (!this.current) return;
    let size: number;
    try {
      size = statSync(this.current).size;
    } catch {
      return;
    }
    if (size < this.offset) {
      this.offset = 0;
      this.partial = Buffer.alloc(0);
    }
    if (size === this.offset) return;
    let chunk: Buffer;
    let fd: number | undefined;
    try {
      fd = openSync(this.current, "r");
      chunk = Buffer.alloc(size - this.offset);
      readSync(fd, chunk, 0, chunk.length, this.offset);
      this.offset = size;
    } catch {
      // Removed or unreadable between stat and open: try again at the next read.
      return;
    } finally {
      if (fd !== undefined) closeSync(fd);
    }
    const data = Buffer.concat([this.partial, chunk]);
    const end = data.lastIndexOf(10);
    this.partial = Buffer.from(data.subarray(end + 1));
    if (end < 0) return;
    const lines = data.toString("utf8", 0, end).split("\n");
    if (skipFirstLine) lines.shift();
    for (const line of lines) {
      if (line.trim()) this.onLine(line, !skipFirstLine);
    }
  }
}
