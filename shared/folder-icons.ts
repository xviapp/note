export const FOLDER_ICON_MAX_BYTES = 128 * 1024;
export const FOLDER_ICON_MIMES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
];

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function isFolderEmoji(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 64 &&
    [...graphemes.segment(value)].length === 1 &&
    /\p{Extended_Pictographic}|\p{Regional_Indicator}|\u20e3/u.test(value)
  );
}
