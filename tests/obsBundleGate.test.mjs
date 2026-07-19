import assert from 'node:assert/strict';
import test from 'node:test';

import { collectObsPlayerArtifacts } from '../scripts/check-obs-player-bundle.mjs';

test('OBS bundle artifacts include the player static transitive closure only', () => {
  const manifest = {
    'index.html': {
      file: 'assets/index.js',
      isEntry: true,
      dynamicImports: ['src/pages/Dashboard.jsx', 'src/pages/Widget.jsx'],
      css: ['assets/index.css'],
    },
    '_runtime.js': { file: 'assets/runtime.js' },
    '_fixture.js': {
      file: 'assets/onAirTestFixture.js',
      imports: ['_fixture-helper.js'],
    },
    '_fixture-helper.js': {
      file: 'assets/fixture-helper.js',
      css: ['assets/player.css'],
      assets: ['assets/player-tone.ogg'],
    },
    'src/pages/Dashboard.jsx': { file: 'assets/Dashboard.js' },
    'src/pages/DisplayWidget.jsx': { file: 'assets/DisplayWidget.js' },
    'src/components/OnAirPlayer.jsx': { file: 'assets/OnAirPlayer.js' },
    'src/pages/Widget.jsx': {
      file: 'assets/Widget.js',
      src: 'src/pages/Widget.jsx',
      imports: ['_runtime.js'],
      dynamicImports: [
        'src/pages/DisplayWidget.jsx',
        'src/components/OnAirPlayer.jsx',
        'src/components/OnAirPlayerV2.jsx',
      ],
    },
    'src/components/OnAirPlayerV2.jsx': {
      file: 'assets/OnAirPlayerV2.js',
      src: 'src/components/OnAirPlayerV2.jsx',
      imports: ['index.html', '_fixture.js'],
    },
  };

  assert.deepEqual(collectObsPlayerArtifacts(manifest), [
    'index.html',
    'assets/OnAirPlayerV2.js',
    'assets/Widget.js',
    'assets/fixture-helper.js',
    'assets/index.css',
    'assets/index.js',
    'assets/onAirTestFixture.js',
    'assets/player-tone.ogg',
    'assets/player.css',
    'assets/runtime.js',
  ]);
});
