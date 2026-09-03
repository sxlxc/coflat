export interface LinePosition { readonly line: number; readonly column: number }

interface ShiftNode { readonly add: number; readonly left: ShiftNode | null; readonly right: ShiftNode | null }

function addSuffix(node: ShiftNode | null, from: number, left: number, right: number, delta: number): ShiftNode | null {
  if (delta === 0 || from >= right) return node;
  if (from <= left) return Object.freeze({ add: (node?.add ?? 0) + delta, left: node?.left ?? null, right: node?.right ?? null });
  const middle = (left + right) >>> 1;
  return Object.freeze({
    add: node?.add ?? 0,
    left: addSuffix(node?.left ?? null, from, left, middle, delta),
    right: addSuffix(node?.right ?? null, from, middle, right, delta),
  });
}

function shiftAt(node: ShiftNode | null, index: number, left: number, right: number): number {
  if (!node) return 0;
  if (right - left === 1) return node.add;
  const middle = (left + right) >>> 1;
  return node.add + (index < middle ? shiftAt(node.left, index, left, middle) : shiftAt(node.right, index, middle, right));
}

/** Immutable UTF-16 line index. CRLF belongs to the preceding line. */
export class LineIndex {
  readonly length: number;
  readonly #text: string;
  readonly #baseStarts: readonly number[];
  readonly #shifts: ShiftNode | null;
  #materialized: readonly number[] | null = null;

  constructor(text: string, knownStarts?: readonly number[], shifts: ShiftNode | null = null, trustedStarts = false) {
    if (knownStarts) {
      this.#baseStarts = trustedStarts ? knownStarts : Object.freeze([...knownStarts]);
    } else {
      const starts = [0];
      for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) starts.push(i + 1);
      }
      this.#baseStarts = Object.freeze(starts);
    }
    this.#shifts = shifts;
    this.length = text.length;
    this.#text = text;
  }

  get starts(): readonly number[] {
    return this.#materialized ??= Object.freeze(Array.from({ length: this.lineCount }, (_, line) => this.lineStart(line)));
  }

  update(newText: string, changes: readonly { oldFrom: number; oldTo: number; newFrom: number; newTo: number }[]): LineIndex {
    if (changes.length !== 1) return new LineIndex(newText);
    const change = changes[0]!;
    // If line endings changed, rebuilding is the simple correctness path.
    const oldWidth = change.oldTo - change.oldFrom, newWidth = change.newTo - change.newFrom;
    if (this.#text.slice(change.oldFrom, change.oldTo).includes("\n") || newText.slice(change.newFrom, change.newTo).includes("\n")) return new LineIndex(newText);
    const delta = newWidth - oldWidth;
    const suffix = this.lineAt(change.oldTo) + 1;
    return new LineIndex(newText, this.#baseStarts, addSuffix(this.#shifts, suffix, 0, this.lineCount, delta), true);
  }

  get lineCount(): number { return this.#baseStarts.length; }

  lineAt(offset: number): number {
    if (!Number.isInteger(offset) || offset < 0 || offset > this.length) throw new RangeError(`Offset ${offset} is outside 0..${this.length}`);
    let low = 0, high = this.lineCount;
    while (low + 1 < high) {
      const middle = (low + high) >>> 1;
      if (this.lineStart(middle) <= offset) low = middle; else high = middle;
    }
    return low;
  }

  lineStart(line: number): number {
    const value = this.#baseStarts[line];
    if (value === undefined) throw new RangeError(`Line ${line} is outside 0..${this.lineCount - 1}`);
    return value + shiftAt(this.#shifts, line, 0, this.lineCount);
  }

  lineEnd(line: number): number {
    if (line < 0 || line >= this.lineCount) throw new RangeError(`Line ${line} is outside 0..${this.lineCount - 1}`);
    return line + 1 < this.lineCount ? this.lineStart(line + 1) : this.length;
  }

  positionAt(offset: number): LinePosition {
    const line = this.lineAt(offset);
    return { line, column: offset - this.lineStart(line) };
  }
}
