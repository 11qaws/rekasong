const ACCENTED_ASCII = Object.freeze({
  A: 'Å', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ğ', H: 'Ĥ', I: 'Î', J: 'Ĵ',
  K: 'Ķ', L: 'Ļ', M: 'Ṁ', N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ',
  U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẍ', Y: 'Ŷ', Z: 'Ž',
  a: 'å', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ğ', h: 'ĥ', i: 'î', j: 'ĵ',
  k: 'ķ', l: 'ļ', m: 'ṁ', n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ',
  u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẍ', y: 'ŷ', z: 'ž',
});

const PROTECTED_SEGMENT_SOURCE = String.raw`\{\{[^{}]+\}\}|\$\{[^{}]+\}|https?:\/\/[^\s<>"']+|[\w.+-]+@[\w.-]+\.\w+|\b(?:Rekasong|YouTube|Setlink|Meloming|Cloudflare|GitHub|Chrome|Edge|Windows|macOS)\b|\b[A-Z][A-Z0-9_-]{1,}\b|\b[vV]\d+(?:\.\d+)*\b|\b\d+(?:\.\d+)*(?:ms|px|Hz|kHz|KiB|MiB|GiB|B|%)?\b`;

export const PSEUDO_LOCALE_EXPANSION_RATIO = 0.4;

export function pseudoLocalizeText(value) {
  const input = String(value ?? '');
  if (!input.trim()) return input;

  const leadingWhitespace = input.match(/^\s*/u)?.[0] ?? '';
  const trailingWhitespace = input.match(/\s*$/u)?.[0] ?? '';
  const body = input.slice(leadingWhitespace.length, input.length - trailingWhitespace.length);
  const protectedSegment = new RegExp(`^(?:${PROTECTED_SEGMENT_SOURCE})$`, 'u');
  const segments = body.split(new RegExp(`(${PROTECTED_SEGMENT_SOURCE})`, 'gu'));
  let transformableLetters = 0;

  const transformed = segments.map((segment) => {
    if (!segment || protectedSegment.test(segment)) return segment;
    return segment.replace(/[A-Za-z]/g, (letter) => {
      transformableLetters += 1;
      return ACCENTED_ASCII[letter] ?? letter;
    });
  }).join('');

  if (transformableLetters === 0) return input;
  const padding = '·'.repeat(Math.max(
    1,
    Math.ceil(transformableLetters * PSEUDO_LOCALE_EXPANSION_RATIO),
  ));
  return `${leadingWhitespace}⟦${transformed} ${padding}⟧${trailingWhitespace}`;
}
