import test from 'node:test';
import assert from 'node:assert/strict';

import {
  groupMappingsForOriginalLines,
  parseOriginalLineSelection,
} from '../src/lib/lyrics/lyricsAlignment.js';

const lines = ['L1', 'L2', 'L3', 'L4'].map((lineId) => ({ lineId }));

test('line alignment supports N:1 ranges and 1:N repeated mappings', () => {
  assert.deepEqual(parseOriginalLineSelection('1-2,4', lines), ['L1', 'L2', 'L4']);
  const grouped = groupMappingsForOriginalLines([
    { mappingId: 'M1', originalLineIds: ['L1'], displayKo: 'one' },
    { mappingId: 'M2', originalLineIds: ['L1'], displayKo: 'two' },
    { mappingId: 'M3', originalLineIds: ['L2', 'L3'], displayKo: 'three' },
  ], ['L1']);
  assert.deepEqual(grouped.map((mapping) => mapping.mappingId), ['M1', 'M2']);
});
