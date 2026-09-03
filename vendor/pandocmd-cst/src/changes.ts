export interface TextChange {
  readonly oldFrom: number; readonly oldTo: number;
  readonly newFrom: number; readonly newTo: number;
}

export interface ChangedRange extends TextChange {}

export type SemanticChangeKind = "reference-resolution" | "heading-identifier" | "footnote-target" | "example-number";

export interface SemanticChangedRange extends ChangedRange {
  readonly kinds: readonly SemanticChangeKind[];
}

export class InvalidTextChangeError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidTextChangeError"; }
}

export interface UnchangedSegment {
  readonly oldFrom: number; readonly oldTo: number;
  readonly newFrom: number; readonly newTo: number;
}

export function validateChanges(oldText: string, newText: string, changes: readonly TextChange[]): readonly UnchangedSegment[] {
  if (changes.length === 0) {
    if (oldText !== newText) throw new InvalidTextChangeError("An empty change list is valid only when the text is unchanged");
    return Object.freeze([{ oldFrom: 0, oldTo: oldText.length, newFrom: 0, newTo: newText.length }]);
  }
  const segments: UnchangedSegment[] = [];
  let oldCursor = 0, newCursor = 0;
  for (let i = 0; i < changes.length; i++) {
    const change = changes[i]!;
    for (const [name, value] of Object.entries(change)) {
      if (!Number.isSafeInteger(value)) throw new InvalidTextChangeError(`Change ${i} ${name} must be an integer`);
    }
    if (change.oldFrom < oldCursor || change.newFrom < newCursor) throw new InvalidTextChangeError(`Change ${i} overlaps or is out of order`);
    if (change.oldFrom < 0 || change.oldTo < change.oldFrom || change.oldTo > oldText.length) throw new InvalidTextChangeError(`Change ${i} has an invalid old range`);
    if (change.newFrom < 0 || change.newTo < change.newFrom || change.newTo > newText.length) throw new InvalidTextChangeError(`Change ${i} has an invalid new range`);
    const oldGap = change.oldFrom - oldCursor;
    const newGap = change.newFrom - newCursor;
    if (oldGap !== newGap || oldText.slice(oldCursor, change.oldFrom) !== newText.slice(newCursor, change.newFrom)) {
      throw new InvalidTextChangeError(`Unchanged text before change ${i} is inconsistent with newText`);
    }
    if (oldGap > 0) segments.push({ oldFrom: oldCursor, oldTo: change.oldFrom, newFrom: newCursor, newTo: change.newFrom });
    oldCursor = change.oldTo;
    newCursor = change.newTo;
  }
  if (oldText.length - oldCursor !== newText.length - newCursor || oldText.slice(oldCursor) !== newText.slice(newCursor)) {
    throw new InvalidTextChangeError("Text after the final change is inconsistent with newText");
  }
  if (oldCursor < oldText.length) segments.push({ oldFrom: oldCursor, oldTo: oldText.length, newFrom: newCursor, newTo: newText.length });
  return Object.freeze(segments);
}

export function mergeChangedRanges(ranges: readonly ChangedRange[]): readonly ChangedRange[] {
  if (ranges.length < 2) return Object.freeze(ranges.map(range => ({ ...range })));
  const result: ChangedRange[] = [];
  for (const range of ranges) {
    const last = result[result.length - 1];
    if (last && range.oldFrom <= last.oldTo && range.newFrom <= last.newTo) {
      result[result.length - 1] = {
        oldFrom: last.oldFrom, oldTo: Math.max(last.oldTo, range.oldTo),
        newFrom: last.newFrom, newTo: Math.max(last.newTo, range.newTo),
      };
    } else result.push({ ...range });
  }
  return Object.freeze(result);
}
