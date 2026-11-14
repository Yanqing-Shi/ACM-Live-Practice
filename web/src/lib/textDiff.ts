export type TextEdit = {
  /** Offset in the old text where the change starts. */
  start: number;
  /** Offset in the old text where the change ends (exclusive). */
  end: number;
  /** Replacement for old.slice(start, end). */
  text: string;
};

/**
 * The single smallest replacement that turns `before` into `after`, or null
 * when they are equal. Applying only the changed span (rather than replacing
 * the whole document) keeps an observer's scroll position and selection.
 */
export function minimalEdit(before: string, after: string): TextEdit | null {
  if (before === after) return null;

  const maxPrefix = Math.min(before.length, after.length);
  let prefix = 0;

  while (prefix < maxPrefix && before.charCodeAt(prefix) === after.charCodeAt(prefix)) {
    prefix++;
  }

  const maxSuffix = maxPrefix - prefix;
  let suffix = 0;

  while (
    suffix < maxSuffix &&
    before.charCodeAt(before.length - 1 - suffix) ===
      after.charCodeAt(after.length - 1 - suffix)
  ) {
    suffix++;
  }

  // Never split a surrogate pair: widen the edit to whole characters.
  const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
  const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

  if (prefix > 0 && isHigh(before.charCodeAt(prefix - 1))) prefix--;
  if (suffix > 0 && isLow(before.charCodeAt(before.length - suffix))) suffix--;

  return {
    start: prefix,
    end: before.length - suffix,
    text: after.slice(prefix, after.length - suffix),
  };
}

export function applyTextEdit(before: string, edit: TextEdit | null): string {
  if (!edit) return before;

  return before.slice(0, edit.start) + edit.text + before.slice(edit.end);
}
