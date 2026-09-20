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

/**
 * Keeps the most recent output of a session, bounded by UTF-8 size, so a client attaching later
 * can be shown what happened before it connected. A long-running process cannot grow it without
 * bound: whole chunks are dropped from the front, and only the chunk straddling the limit is cut.
 */
export class BoundedOutputBuffer implements OutputBuffer {
  private chunks: Array<{ text: string; bytes: number }> = [];
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
      this.chunks = [];
      this.totalBytes = 0;
      chunk = this.tail(chunk.text, this.maxBytes);
    }
    this.chunks.push(chunk);
    this.totalBytes += chunk.bytes;

    while (this.totalBytes > this.maxBytes) {
      const oldest = this.chunks[0];
      if (!oldest) break;
      const excess = this.totalBytes - this.maxBytes;
      if (oldest.bytes <= excess) {
        this.chunks.shift();
        this.totalBytes -= oldest.bytes;
      } else {
        const trimmed = this.tail(oldest.text, oldest.bytes - excess);
        this.totalBytes -= oldest.bytes - trimmed.bytes;
        this.chunks[0] = trimmed;
      }
    }
  }

  snapshot(): string {
    return this.chunks.map((chunk) => chunk.text).join('');
  }

  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
  }

  /** Longest suffix of `text` that fits in `maxBytes` without splitting a code point. */
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
      bytes = byteLength(candidate);
    }
    return { text: candidate, bytes };
  }
}
