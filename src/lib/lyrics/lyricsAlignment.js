export function parseOriginalLineSelection(value, originalLines) {
  const indexes = new Set();
  for (const token of String(value || '').split(',')) {
    const range = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/u);
    if (!range) continue;
    const start = Number(range[1]);
    const end = Number(range[2] || range[1]);
    for (let index = Math.min(start, end); index <= Math.max(start, end); index += 1) {
      indexes.add(index);
    }
  }
  return Object.freeze(
    [...indexes].map((index) => originalLines[index - 1]?.lineId).filter(Boolean),
  );
}

export function groupMappingsForOriginalLines(mappings, originalLineIds) {
  const selected = new Set(originalLineIds || []);
  return Object.freeze((mappings || []).filter((mapping) => (
    (mapping.originalLineIds || []).some((lineId) => selected.has(lineId))
  )));
}
