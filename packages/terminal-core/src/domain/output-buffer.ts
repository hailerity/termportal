export interface OutputBuffer {
  append(data: string): void;
  snapshot(): string;
  clear(): void;
}

const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/** How far into a cut chunk we look for a line break to restart the replay cleanly. */
const LINE_SEARCH_WINDOW = 4096;
/** Dropped chunks are compacted away once this many have accumulated at the front. */
const COMPACT_THRESHOLD = 1024;

/**
 * Keeps the most recent output of a session, bounded by UTF-8 size, so a client attaching later
 * can be shown what happened before it connected. A long-running process cannot grow it without
 * bound: whole chunks are dropped from the front, and only the chunk straddling the limit is cut.
 *
 * A cut never splits a code point, and it prefers to restart just after a line break so the
 * replay does not begin in the middle of an escape sequence. This is a byte history, not a
 * terminal-state snapshot: once a full-screen program's setup sequences have been trimmed away,
 * its replay can look wrong until the program redraws.
 */
export class BoundedOutputBuffer implements OutputBuffer {
  private chunks: Array<{ text: string; bytes: number }> = [];
  /** Index of the oldest live chunk; avoids an O(n) Array.shift() per output event. */
  private head = 0;
  private totalBytes = 0;

  constructor(private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 0) {
      throw new Error('Output buffer size must be a non-negative integer.');
    }
  }

  get byteSize(): number {
    return this.totalBytes;
  }

  append(data: string): void {
    if (data === '' || this.maxBytes === 0) return;
    let chunk = { text: data, bytes: byteLength(data) };
    if (chunk.bytes >= this.maxBytes) {
      // The new chunk alone fills the buffer; everything older is gone.
      this.clear();
      chunk = this.tail(chunk.text, this.maxBytes);
    }
    this.chunks.push(chunk);
    this.totalBytes += chunk.bytes;

    while (this.totalBytes > this.maxBytes) {
      const oldest = this.chunks[this.head];
      if (!oldest) break;
      const excess = this.totalBytes - this.maxBytes;
      if (oldest.bytes <= excess) {
        this.head++;
        this.totalBytes -= oldest.bytes;
      } else {
        const trimmed = this.tail(oldest.text, oldest.bytes - excess);
        this.totalBytes -= oldest.bytes - trimmed.bytes;
        this.chunks[this.head] = trimmed;
      }
    }
    if (this.head >= COMPACT_THRESHOLD && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  snapshot(): string {
    let text = '';
    for (let i = this.head; i < this.chunks.length; i++) text += this.chunks[i]?.text ?? '';
    return text;
  }

  clear(): void {
    this.chunks = [];
    this.head = 0;
    this.totalBytes = 0;
  }

  /** Longest clean suffix of `text` that fits in `maxBytes`. */
  private tail(text: string, maxBytes: number): { text: string; bytes: number } {
    // Every UTF-16 code unit encodes to at most 3 bytes, so this suffix is always long enough.
    let start = Math.max(0, text.length - maxBytes);
    let candidate = text.slice(start);
    let bytes = byteLength(candidate);
    while (bytes > maxBytes && start < text.length) {
      const step = Math.max(1, Math.ceil((bytes - maxBytes) / 3));
      start += step;
      candidate = text.slice(start);
      bytes = byteLength(candidate);
    }
    if (candidate.length > 0 && isLowSurrogate(candidate.charCodeAt(0))) {
      candidate = candidate.slice(1);
    }
    // Nothing was cut: the text already starts wherever the process started it.
    if (candidate.length === text.length) return { text: candidate, bytes };
    // CSI/SGR sequences (colours, cursor moves) never contain a line break, so restarting just
    // after one keeps them whole. String sequences (OSC/DCS payloads) may span lines; those
    // can still be cut, which only a terminal-state serializer could avoid.
    const lineBreak = candidate.slice(0, LINE_SEARCH_WINDOW).indexOf('\n');
    if (lineBreak !== -1 && lineBreak + 1 < candidate.length) {
      candidate = candidate.slice(lineBreak + 1);
    }
    return { text: candidate, bytes: byteLength(candidate) };
  }
}
