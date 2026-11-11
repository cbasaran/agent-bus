// Follows an append-only file of lines (a harness's JSONL transcript): the end of what is there, then each append.
// Runs on Node (the plugins are bundled for it): `node:*` only.
import { closeSync, openSync, readSync, statSync } from "node:fs";

export class LineTail {
  private current: string | undefined;
  private offset = 0;
  private partial = "";

  /** `onLine` gets each non-blank complete line; `live` is false for lines of the first read from a cut start. */
  constructor(private readonly onLine: (line: string, live: boolean) => void) {}

  get file(): string | undefined {
    return this.current;
  }

  /** Follows `file` from its last `startBytes` (the first, cut line skipped), reading what is there now. */
  open(file: string, startBytes: number): void {
    this.current = file;
    this.partial = "";
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
      this.partial = "";
    }
    if (size === this.offset) return;
    const fd = openSync(this.current, "r");
    let chunk: string;
    try {
      const buf = Buffer.alloc(size - this.offset);
      readSync(fd, buf, 0, buf.length, this.offset);
      this.offset = size;
      chunk = buf.toString("utf8");
    } finally {
      closeSync(fd);
    }
    const lines = (this.partial + chunk).split("\n");
    this.partial = lines.pop() ?? "";
    if (skipFirstLine) lines.shift();
    for (const line of lines) {
      if (line.trim()) this.onLine(line, !skipFirstLine);
    }
  }
}
