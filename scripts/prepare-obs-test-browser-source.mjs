import { constants as fsConstants } from 'node:fs'
import {
  copyFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const PLAYER_HASH_PATH = '/widget'
const PLAYER_PARAMETER_NAMES = ['api', 'mode', 'protocol', 'session', 'token']

function invariant(condition, message) {
  if (!condition) throw new Error(message)
}

function normalizedBaseUrl(value, label) {
  const url = new URL(value)
  invariant(url.username === '' && url.password === '', `${label} must not contain credentials`)
  invariant(url.hash === '' && url.search === '', `${label} must not contain query or hash data`)
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`
  return url
}

export function validateObsPlayerUrl(playerUrl, {
  expectedAppBaseUrl,
  expectedWorkerBaseUrl,
}) {
  invariant(typeof playerUrl === 'string' && playerUrl.length > 0, 'handoff playerUrl is required')

  const actual = new URL(playerUrl)
  const expectedApp = normalizedBaseUrl(expectedAppBaseUrl, 'expected app base URL')
  const expectedWorker = normalizedBaseUrl(expectedWorkerBaseUrl, 'expected Worker base URL')

  invariant(actual.origin === expectedApp.origin, 'player URL app origin does not match the approved app')
  invariant(actual.pathname === expectedApp.pathname, 'player URL app path does not match the approved app')
  invariant(actual.username === '' && actual.password === '', 'player URL must not contain credentials')
  invariant(actual.search === '', 'player URL parameters must stay inside the widget hash')

  const hashUrl = new URL(actual.hash.slice(1), 'https://rekasong.invalid')
  invariant(hashUrl.pathname === PLAYER_HASH_PATH, 'player URL must open the widget route')
  invariant(hashUrl.searchParams.get('mode') === 'player', 'player URL mode must be player')
  invariant(hashUrl.searchParams.get('protocol') === '2', 'player URL protocol must be 2')
  invariant((hashUrl.searchParams.get('session') || '').length >= 8, 'player URL session is missing')
  invariant((hashUrl.searchParams.get('token') || '').length >= 16, 'player URL token is missing')

  const actualParameterNames = [...hashUrl.searchParams.keys()].sort()
  invariant(
    JSON.stringify(actualParameterNames) === JSON.stringify(PLAYER_PARAMETER_NAMES),
    'player URL contains an unexpected parameter set',
  )

  const worker = normalizedBaseUrl(hashUrl.searchParams.get('api') || '', 'player Worker URL')
  invariant(worker.href === expectedWorker.href, 'player URL Worker does not match the approved Worker')

  return {
    href: actual.href,
    appHost: actual.host,
    appPath: actual.pathname,
    workerHost: worker.host,
    length: actual.href.length,
  }
}

export function prepareObsTestSceneDocument(sceneDocument, {
  collectionName,
  sceneName,
  sourceName,
  playerUrl,
  expectedAppBaseUrl,
  expectedWorkerBaseUrl,
}) {
  invariant(sceneDocument && typeof sceneDocument === 'object', 'OBS scene collection JSON is invalid')
  invariant(sceneDocument.name === collectionName, 'OBS collection name does not match the approved test collection')
  invariant(sceneDocument.current_scene === sceneName, 'approved test scene is not the current scene')
  invariant(sceneDocument.current_program_scene === sceneName, 'approved test scene is not the program scene')

  const sources = Array.isArray(sceneDocument.sources) ? sceneDocument.sources : []
  const browserSources = sources.filter(
    (source) => source?.id === 'browser_source' && source?.name === sourceName,
  )
  invariant(browserSources.length === 1, 'the approved Browser source must exist exactly once')

  const browserSource = browserSources[0]
  invariant(browserSource.settings?.reroute_audio === true, 'Control audio via OBS must be enabled')
  invariant(typeof browserSource.uuid === 'string' && browserSource.uuid.length > 0, 'Browser source UUID is missing')

  const scenes = sources.filter((source) => source?.id === 'scene' && source?.name === sceneName)
  invariant(scenes.length === 1, 'the approved test scene must exist exactly once')
  const sceneItems = Array.isArray(scenes[0].settings?.items) ? scenes[0].settings.items : []
  const matchingItems = sceneItems.filter(
    (item) => item?.name === sourceName && item?.source_uuid === browserSource.uuid,
  )
  invariant(matchingItems.length === 1, 'the approved Browser source must belong to the test scene exactly once')
  invariant(matchingItems[0].visible === true, 'the approved Browser source must be visible before the test')

  const validatedUrl = validateObsPlayerUrl(playerUrl, {
    expectedAppBaseUrl,
    expectedWorkerBaseUrl,
  })
  browserSource.settings.url = validatedUrl.href

  return {
    document: sceneDocument,
    report: {
      collectionName,
      sceneName,
      sourceName,
      controlAudioViaObs: true,
      sourceVisible: true,
      appHost: validatedUrl.appHost,
      appPath: validatedUrl.appPath,
      workerHost: validatedUrl.workerHost,
      urlLength: validatedUrl.length,
    },
  }
}

export async function assertObsIsStopped() {
  invariant(process.platform === 'win32', 'automatic OBS process check currently supports Windows only')
  const { stdout } = await execFileAsync(
    'tasklist.exe',
    ['/FI', 'IMAGENAME eq obs64.exe', '/FO', 'CSV', '/NH'],
    { windowsHide: true },
  )
  invariant(!/"obs64\.exe"/i.test(stdout), 'OBS must be fully stopped before editing its test scene collection')
}

export async function replaceObsTestBrowserSource({
  sceneFile,
  handoffFile,
  backupFile,
  collectionName,
  sceneName,
  sourceName,
  expectedAppBaseUrl,
  expectedWorkerBaseUrl,
  confirmObsStopped = assertObsIsStopped,
}) {
  for (const [label, value] of Object.entries({ sceneFile, handoffFile, backupFile })) {
    invariant(typeof value === 'string' && isAbsolute(value), `${label} must be an absolute path`)
  }
  invariant(resolve(sceneFile) !== resolve(backupFile), 'backup file must differ from the scene file')

  await confirmObsStopped()

  const [sceneText, handoffText] = await Promise.all([
    readFile(sceneFile, 'utf8'),
    readFile(handoffFile, 'utf8'),
  ])
  const sceneDocument = JSON.parse(sceneText)
  const handoff = JSON.parse(handoffText)
  const prepared = prepareObsTestSceneDocument(sceneDocument, {
    collectionName,
    sceneName,
    sourceName,
    playerUrl: handoff.playerUrl,
    expectedAppBaseUrl,
    expectedWorkerBaseUrl,
  })

  await mkdir(dirname(backupFile), { recursive: true })
  await copyFile(sceneFile, backupFile, fsConstants.COPYFILE_EXCL)

  const suffix = `.rekasong-${process.pid}-${Date.now()}`
  const nextFile = `${sceneFile}${suffix}.next`
  const rollbackFile = `${sceneFile}${suffix}.rollback`
  const nextText = `${JSON.stringify(prepared.document, null, 4)}\n`

  try {
    await writeFile(nextFile, nextText, { encoding: 'utf8', flag: 'wx' })
    await rename(sceneFile, rollbackFile)
    try {
      await rename(nextFile, sceneFile)
    } catch (error) {
      await rename(rollbackFile, sceneFile).catch(() => {})
      throw error
    }
    await rm(rollbackFile, { force: true })
  } finally {
    await rm(nextFile, { force: true }).catch(() => {})
  }

  return {
    ...prepared.report,
    sceneFile,
    backupFile,
  }
}

function parseArguments(argv) {
  const result = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    invariant(key?.startsWith('--') && value, `invalid argument near ${key || '<end>'}`)
    invariant(result[key] === undefined, `duplicate argument ${key}`)
    result[key] = value
  }
  return result
}

async function main() {
  const args = parseArguments(process.argv.slice(2))
  const report = await replaceObsTestBrowserSource({
    sceneFile: args['--scene-file'],
    handoffFile: args['--handoff-file'],
    backupFile: args['--backup-file'],
    collectionName: args['--collection'],
    sceneName: args['--scene'],
    sourceName: args['--source'],
    expectedAppBaseUrl: args['--app'],
    expectedWorkerBaseUrl: args['--worker'],
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`OBS test source preparation failed: ${error.message}\n`)
    process.exitCode = 1
  })
}
