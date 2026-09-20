import { describe, expect, it } from 'vitest';
import { BoundedOutputBuffer } from './output-buffer.js';

const bytes = (text: string) => new TextEncoder().encode(text).length;

describe('BoundedOutputBuffer', () => {
  it('returns everything while under the limit', () => {
    const buffer = new BoundedOutputBuffer(100);
    buffer.append('hello ');
    buffer.append('world');
    expect(buffer.snapshot()).toBe('hello world');
    expect(buffer.byteSize).toBe(11);
  });

  it('drops the oldest output first', () => {
    const buffer = new BoundedOutputBuffer(10);
    buffer.append('aaaa');
    buffer.append('bbbb');
    buffer.append('cccc');
    expect(buffer.snapshot()).toBe('aabbbbcccc');
    buffer.append('dddddd');
    expect(buffer.snapshot()).toBe('ccccdddddd');
  });

  it('cuts the chunk that straddles the limit to use the full capacity', () => {
    const buffer = new BoundedOutputBuffer(10);
    buffer.append('0123456789');
    buffer.append('abc');
    expect(buffer.snapshot()).toBe('3456789abc');
    expect(buffer.byteSize).toBe(10);
  });

  it('keeps only the tail of a single oversized chunk', () => {
    const buffer = new BoundedOutputBuffer(5);
    buffer.append('old');
    buffer.append('0123456789');
    expect(buffer.snapshot()).toBe('56789');
  });

  it('measures UTF-8 bytes, not characters', () => {
    const buffer = new BoundedOutputBuffer(6);
    buffer.append('ééééé');
    expect(buffer.snapshot()).toBe('ééé');
    expect(buffer.byteSize).toBe(6);
  });

  it('never splits a code point, even when that wastes a few bytes', () => {
    const buffer = new BoundedOutputBuffer(6);
    buffer.append('a😀😀');
    expect(buffer.snapshot()).toBe('😀');
    buffer.clear();
    buffer.append('😀');
    buffer.append('😀');
    expect(buffer.snapshot()).toBe('😀');
    expect([...buffer.snapshot()].every((c) => c.codePointAt(0)! > 0xffff)).toBe(true);
  });

  it('stays within the limit under sustained output', () => {
    const buffer = new BoundedOutputBuffer(1024);
    let all = '';
    for (let i = 0; i < 2000; i++) {
      const line = `line ${i} — ✓ ${'x'.repeat(i % 37)}\r\n`;
      all += line;
      buffer.append(line);
      expect(buffer.byteSize).toBeLessThanOrEqual(1024);
    }
    const snapshot = buffer.snapshot();
    expect(bytes(snapshot)).toBe(buffer.byteSize);
    expect(all.endsWith(snapshot)).toBe(true);
    expect(bytes(snapshot)).toBeGreaterThan(1024 - 4);
  });

  it('can be disabled and cleared', () => {
    const disabled = new BoundedOutputBuffer(0);
    disabled.append('x');
    expect(disabled.snapshot()).toBe('');
    const buffer = new BoundedOutputBuffer(10);
    buffer.append('x');
    buffer.clear();
    expect(buffer.snapshot()).toBe('');
    expect(buffer.byteSize).toBe(0);
  });

  it('rejects an invalid size', () => {
    expect(() => new BoundedOutputBuffer(-1)).toThrow();
    expect(() => new BoundedOutputBuffer(1.5)).toThrow();
  });
});
