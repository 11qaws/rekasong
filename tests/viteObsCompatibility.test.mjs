import test from 'node:test'
import assert from 'node:assert/strict'

import viteConfig, { OBS_CEF_BUILD_TARGET } from '../vite.config.js'

test('production build explicitly targets the Chromium version embedded in OBS 30.2', () => {
  assert.equal(OBS_CEF_BUILD_TARGET, 'chrome103')
  assert.equal(viteConfig.build.target, OBS_CEF_BUILD_TARGET)
  assert.equal(viteConfig.build.cssTarget, OBS_CEF_BUILD_TARGET)
})
