import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  prepareObsTestSceneDocument,
  replaceObsTestBrowserSource,
  validateObsPlayerUrl,
} from '../scripts/prepare-obs-test-browser-source.mjs'

const APP = 'https://11qaws.github.io/rekasong/'
const WORKER = 'https://rekasong-session.11qaws.workers.dev/'
const PLAYER_URL = `${APP}#/widget?mode=player&session=session-1234&token=private-player-token-1234&api=${encodeURIComponent(WORKER.slice(0, -1))}&protocol=2`

function sceneFixture({ rerouteAudio = true, visible = true } = {}) {
  return {
    current_scene: 'Scene',
    current_program_scene: 'Scene',
    name: 'Rekasong_Test',
    sources: [
      {
        name: 'Scene',
        id: 'scene',
        settings: {
          items: [{
            name: 'Browser',
            source_uuid: 'browser-uuid',
            visible,
          }],
        },
      },
      {
        name: 'Browser',
        id: 'browser_source',
        uuid: 'browser-uuid',
        settings: {
          url: 'https://example.invalid/old',
          reroute_audio: rerouteAudio,
        },
      },
    ],
  }
}

const preparation = {
  collectionName: 'Rekasong_Test',
  sceneName: 'Scene',
  sourceName: 'Browser',
  playerUrl: PLAYER_URL,
  expectedAppBaseUrl: APP,
  expectedWorkerBaseUrl: WORKER,
}

test('player handoff accepts only the approved app, Worker, widget role, and protocol', () => {
  const result = validateObsPlayerUrl(PLAYER_URL, {
    expectedAppBaseUrl: APP,
    expectedWorkerBaseUrl: WORKER,
  })
  assert.equal(result.appHost, '11qaws.github.io')
  assert.equal(result.appPath, '/rekasong/')
  assert.equal(result.workerHost, 'rekasong-session.11qaws.workers.dev')

  const wrongWorker = PLAYER_URL.replace(
    encodeURIComponent(WORKER.slice(0, -1)),
    encodeURIComponent('https://example.invalid'),
  )
  assert.throws(
    () => validateObsPlayerUrl(wrongWorker, {
      expectedAppBaseUrl: APP,
      expectedWorkerBaseUrl: WORKER,
    }),
    /Worker does not match/,
  )
})

test('scene preparation changes only one visible OBS-routed Browser source in the approved test scene', () => {
  const fixture = sceneFixture()
  const { document, report } = prepareObsTestSceneDocument(fixture, preparation)
  const browser = document.sources.find((source) => source.name === 'Browser')
  assert.equal(browser.settings.url, PLAYER_URL)
  assert.equal(report.controlAudioViaObs, true)
  assert.equal(report.sourceVisible, true)
  assert.equal(report.urlLength, PLAYER_URL.length)
  assert.equal(JSON.stringify(report).includes('private-player-token'), false)
})

test('scene preparation refuses disabled OBS audio, hidden sources, and collection mismatches', () => {
  assert.throws(
    () => prepareObsTestSceneDocument(sceneFixture({ rerouteAudio: false }), preparation),
    /Control audio via OBS/,
  )
  assert.throws(
    () => prepareObsTestSceneDocument(sceneFixture({ visible: false }), preparation),
    /must be visible/,
  )
  assert.throws(
    () => prepareObsTestSceneDocument(sceneFixture(), {
      ...preparation,
      collectionName: 'Not_The_Test_Collection',
    }),
    /collection name/,
  )
})

test('file replacement backs up first, writes the validated source atomically, and reports no token', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rekasong-obs-scene-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sceneFile = join(directory, 'scene.json')
  const handoffFile = join(directory, 'handoff.json')
  const backupFile = join(directory, 'backup', 'scene.json')
  const original = `${JSON.stringify(sceneFixture(), null, 2)}\n`
  await writeFile(sceneFile, original)
  await writeFile(handoffFile, JSON.stringify({ playerUrl: PLAYER_URL }))

  let stopCheckCount = 0
  const report = await replaceObsTestBrowserSource({
    sceneFile,
    handoffFile,
    backupFile,
    collectionName: preparation.collectionName,
    sceneName: preparation.sceneName,
    sourceName: preparation.sourceName,
    expectedAppBaseUrl: APP,
    expectedWorkerBaseUrl: WORKER,
    confirmObsStopped: async () => { stopCheckCount += 1 },
  })

  assert.equal(stopCheckCount, 1)
  assert.equal(await readFile(backupFile, 'utf8'), original)
  const saved = JSON.parse(await readFile(sceneFile, 'utf8'))
  assert.equal(saved.sources.find((source) => source.name === 'Browser').settings.url, PLAYER_URL)
  assert.equal(JSON.stringify(report).includes('private-player-token'), false)
})

test('a failed OBS-stopped precondition leaves the scene and backup untouched', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rekasong-obs-scene-stop-test-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const sceneFile = join(directory, 'scene.json')
  const handoffFile = join(directory, 'handoff.json')
  const backupFile = join(directory, 'backup.json')
  const original = JSON.stringify(sceneFixture())
  await writeFile(sceneFile, original)
  await writeFile(handoffFile, JSON.stringify({ playerUrl: PLAYER_URL }))

  await assert.rejects(
    replaceObsTestBrowserSource({
      sceneFile,
      handoffFile,
      backupFile,
      collectionName: preparation.collectionName,
      sceneName: preparation.sceneName,
      sourceName: preparation.sourceName,
      expectedAppBaseUrl: APP,
      expectedWorkerBaseUrl: WORKER,
      confirmObsStopped: async () => { throw new Error('OBS is running') },
    }),
    /OBS is running/,
  )
  assert.equal(await readFile(sceneFile, 'utf8'), original)
  await assert.rejects(readFile(backupFile, 'utf8'), /ENOENT/)
})
