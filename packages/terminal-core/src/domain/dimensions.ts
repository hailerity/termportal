import { TerminalError } from './errors.js';

export const DIMENSION_LIMITS = { minCols: 2, maxCols: 1000, minRows: 1, maxRows: 500 } as const;

export function assertValidDimensions(cols: number, rows: number): void {
  const { minCols, maxCols, minRows, maxRows } = DIMENSION_LIMITS;
  const valid =
    Number.isInteger(cols) &&
    Number.isInteger(rows) &&
    cols >= minCols &&
    cols <= maxCols &&
    rows >= minRows &&
    rows <= maxRows;
  if (!valid) {
    throw new TerminalError(
      'INVALID_DIMENSIONS',
      `Terminal dimensions must be integers within ${minCols}-${maxCols} columns and ${minRows}-${maxRows} rows.`,
    );
  }
}
