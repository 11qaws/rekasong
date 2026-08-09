import { useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, FileUp, Plus, Trash2, X } from 'lucide-react';

import useLyricsRepository from '../../hooks/useLyricsRepository.js';
import { importLyricsText } from '../../lib/lyrics/lyricsImport.js';
import {
  createLyricDocument,
  createSongWork,
  createTrackVersion,
  createTranslationRevision,
  sanitizeLyricsRef,
} from '../../lib/lyrics/lyricsSchema.js';
import {
  createPlaybackLyricsPackage,
  sha256TextHash,
} from '../../lib/lyrics/lyricsPackage.js';
import { msToTick } from '../../lib/lyrics/lyricsTempoMap.js';
import { compileLyricsTimeline } from '../../lib/lyrics/lyricsCueTimeline.js';
import {
  groupMappingsForOriginalLines,
  parseOriginalLineSelection,
} from '../../lib/lyrics/lyricsAlignment.js';
import { getLyricsMessage as t } from '../../copy/lyricsMessages.js';
import LyricsOverlayPreview from './LyricsOverlayPreview.jsx';
import LyricsTimelineEditor from './LyricsTimelineEditor.jsx';
import { apiUrl } from '../../lib/api.js';

import './LyricsPreparationWorkspace.css';

const STEPS = ['identity', 'original', 'translation', 'timing', 'preview'];
const SOURCE_TIERS = [
  ['official_same_release', 'source.officialSameRelease'],
  ['official_same_work', 'source.officialSameWork'],
  ['community_consensus', 'source.communityConsensus'],
  ['trusted_web', 'source.trustedWeb'],
  ['machine_contextual', 'source.machineContextual'],
  ['machine_literal', 'source.machineLiteral'],
];

const VERSION_KINDS = [
  ['original_vocal', 'identity.version.original'],
  ['official_instrumental', 'identity.version.instrumental'],
  ['karaoke', 'identity.version.karaoke'],
  ['live', 'identity.version.live'],
  ['cover', 'identity.version.cover'],
  ['edited', 'identity.version.edited'],
  ['unknown', 'identity.version.unknown'],
];

const nonEmptyLines = (value) => String(value ?? '').replace(/\r\n?/gu, '\n')
  .split('\n').map((line) => line.trim()).filter(Boolean);

function initialCues(original, mappings) {
  const lineById = new Map(original.lines.map((line) => [line.lineId, line]));
  const timed = original.timedCues.length > 0
    ? original.timedCues
    : original.lines.map((line, index) => ({ kind: 'lyric', anchorMs: (index + 1) * 5_000, lineIds: [line.lineId] }));
  return timed.map((cue, index) => {
    const matchedMappings = groupMappingsForOriginalLines(mappings, cue.lineIds || []);
    return {
      cueId: `${cue.kind === 'blank' ? 'B' : 'C'}${String(index + 1).padStart(3, '0')}`,
      kind: cue.kind,
      anchorMs: cue.anchorMs,
      originalLineIds: cue.lineIds || [],
      originalLines: (cue.lineIds || []).map((lineId) => lineById.get(lineId)?.text).filter(Boolean),
      translationMappingIds: matchedMappings.map((mapping) => mapping.mappingId),
      translationLinesKo: matchedMappings.map((mapping) => mapping.displayKo).filter(Boolean),
      romanizationLines: [],
      transitionOverride: null,
      reviewStatus: 'approved',
    };
  });
}

function sourceTierOptions() {
  return SOURCE_TIERS.map(([value, key]) => <option value={value} key={value}>{t(key)}</option>);
}

export default function LyricsPreparationWorkspace({
  entry,
  sessionRoom = '',
  publishPackage = null,
  onComplete,
  onClose,
}) {
  const ids = useRef({
    songWorkId: `song-work:${crypto.randomUUID()}`,
    trackVersionId: `track-version:${crypto.randomUUID()}`,
    lyricDocumentId: `lyrics:${crypto.randomUUID()}`,
    translationRevisionId: `translation:${crypto.randomUUID()}:r1`,
    tempoMapId: `tempo:${crypto.randomUUID()}`,
    cueSheetRevisionId: `cue-sheet:${crypto.randomUUID()}:r1`,
    packageId: `lyrics-package:${crypto.randomUUID()}`,
  }).current;
  const repository = useLyricsRepository();
  const [step, setStep] = useState(0);
  const [title, setTitle] = useState(entry?.song?.title || '');
  const [artist, setArtist] = useState(entry?.song?.artist || '');
  const [versionKind, setVersionKind] = useState(entry?.song?.type === 'local' ? 'karaoke' : 'unknown');
  const [originalLanguage, setOriginalLanguage] = useState('ja');
  const [originalText, setOriginalText] = useState('');
  const [originalFileName, setOriginalFileName] = useState('');
  const [originalSourceTier, setOriginalSourceTier] = useState('trusted_web');
  const [originalSourceTitle, setOriginalSourceTitle] = useState('');
  const [originalSourceUrl, setOriginalSourceUrl] = useState('');
  const [translationText, setTranslationText] = useState('');
  const [translationSourceTier, setTranslationSourceTier] = useState('trusted_web');
  const [translationSourceTitle, setTranslationSourceTitle] = useState('');
  const [translationSourceUrl, setTranslationSourceUrl] = useState('');
  const [translatorName, setTranslatorName] = useState('');
  const [officialAdaptation, setOfficialAdaptation] = useState(false);
  const [lockedByUser, setLockedByUser] = useState(false);
  const [mappingDrafts, setMappingDrafts] = useState([]);
  const [bpm, setBpm] = useState('');
  const [firstDownbeat, setFirstDownbeat] = useState('0');
  const [numerator, setNumerator] = useState('4');
  const [denominator, setDenominator] = useState('4');
  const [cueHistory, setCueHistory] = useState({ past: [], present: [], future: [] });
  const [previewTimeMs, setPreviewTimeMs] = useState(0);
  const [requireLyrics, setRequireLyrics] = useState(false);
  const [displaySettings, setDisplaySettings] = useState({
    positionPreset: 'right_center',
    offsetX: 0,
    offsetY: 0,
    areaWidth: 840,
    originalFontSize: 62,
    translationFontSize: 40,
    fontFamily: 'Inter, Pretendard, "Noto Sans KR", sans-serif',
    fontWeight: 800,
    textAlign: 'right',
    strokeWidth: 0,
    shadowStrength: 0.8,
    opacity: 1,
    mode: 'original_ko',
  });
  const [saveState, setSaveState] = useState({ status: 'idle', message: '' });
  const [aiState, setAiState] = useState({ status: 'idle', message: '' });

  const original = useMemo(() => importLyricsText({
    text: originalText,
    filename: originalFileName,
  }), [originalFileName, originalText]);
  const mappings = useMemo(() => mappingDrafts.map((mapping, index) => ({
    mappingId: mapping.mappingId || `M${String(index + 1).padStart(3, '0')}`,
    originalLineIds: parseOriginalLineSelection(mapping.originalInput, original.lines),
    displayKo: mapping.displayKo,
    literalKo: null,
    reviewStatus: lockedByUser ? 'locked' : 'approved',
    notes: [],
  })).filter((mapping) => mapping.originalLineIds.length > 0 && mapping.displayKo.trim()), [
    lockedByUser,
    mappingDrafts,
    original.lines,
  ]);

  const tempoMap = useMemo(() => {
    const parsedBpm = Number(bpm);
    return Number.isFinite(parsedBpm) && parsedBpm > 0 ? {
      tempoMapId: ids.tempoMapId,
      trackVersionId: ids.trackVersionId,
      ppq: 960,
      segments: [{
        startTick: 0,
        startMs: Math.max(0, Number(firstDownbeat) || 0) * 1_000,
        bpm: parsedBpm,
        numerator: Math.max(1, Number(numerator) || 4),
        denominator: [1, 2, 4, 8, 16].includes(Number(denominator)) ? Number(denominator) : 4,
        downbeatTick: 0,
        confidence: 1,
        source: 'user_confirmed',
      }],
      status: 'confirmed',
    } : {
      tempoMapId: ids.tempoMapId,
      trackVersionId: ids.trackVersionId,
      ppq: 960,
      segments: [],
      status: 'fixed_ms_fallback',
    };
  }, [bpm, denominator, firstDownbeat, ids.tempoMapId, ids.trackVersionId, numerator]);

  const sortedCues = useMemo(() => [...cueHistory.present]
    .sort((a, b) => a.anchorMs - b.anchorMs)
    .map((cue) => ({
      ...cue,
      anchorTick: tempoMap.segments.length > 0 ? msToTick(tempoMap, cue.anchorMs) : null,
    })), [cueHistory.present, tempoMap]);

  const draftPackage = useMemo(() => ({
    timingMode: tempoMap.segments.length > 0 ? 'tempo_map' : 'fixed_ms_fallback',
    ppq: 960,
    transitionRule: {
      fadeStartTicksBeforeAnchor: 960,
      fadeEndTicksBeforeAnchor: 480,
      fallbackFadeStartMsBeforeAnchor: 600,
      fallbackFadeEndMsBeforeAnchor: 300,
    },
    tempoSegments: tempoMap.segments,
    cues: sortedCues,
    displayDefaults: displaySettings,
  }), [displaySettings, sortedCues, tempoMap]);
  const timingConflictCount = useMemo(() => (
    compileLyricsTimeline(draftPackage).filter((item) => item.collision).length
  ), [draftPackage]);
  const updateDisplaySetting = (field, value) => setDisplaySettings((current) => ({
    ...current,
    [field]: value,
  }));

  const setCues = (next) => setCueHistory((current) => ({
    past: [...current.past, current.present].slice(-50),
    present: next,
    future: [],
  }));
  const undoCues = () => setCueHistory((current) => current.past.length === 0 ? current : ({
    past: current.past.slice(0, -1),
    present: current.past.at(-1),
    future: [current.present, ...current.future].slice(0, 50),
  }));
  const redoCues = () => setCueHistory((current) => current.future.length === 0 ? current : ({
    past: [...current.past, current.present].slice(-50),
    present: current.future[0],
    future: current.future.slice(1),
  }));

  const readFile = async (file, setter, nameSetter = null) => {
    if (!file) return;
    setter(await file.text());
    nameSetter?.(file.name);
  };

  const syncMappingsFromText = (value) => {
    setTranslationText(value);
    setMappingDrafts(nonEmptyLines(value).map((displayKo, index) => ({
      mappingId: `M${String(index + 1).padStart(3, '0')}`,
      originalInput: String(Math.min(index + 1, Math.max(1, original.lines.length))),
      displayKo,
    })));
  };

  const createAiTranslationDraft = async () => {
    if (original.lines.length === 0 || mappingDrafts.length > 0) return;
    setAiState({ status: 'loading', message: t('translation.aiLoading') });
    try {
      const contentHash = await sha256TextHash(original.lines.map((line) => line.text).join('\n'));
      const response = await fetch(apiUrl('/api/lyrics-translate'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentHash,
          title,
          artist,
          originalLines: original.lines.map((line) => line.text),
        }),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || !Array.isArray(result.translations)) throw new Error(result.error || 'failed');
      syncMappingsFromText(result.translations.join('\n'));
      setTranslationSourceTier('machine_contextual');
      setTranslationSourceTitle(t('translation.aiSource'));
      if (result.cacheKey) {
        await repository.putProviderCache({
          cacheKey: result.cacheKey,
          providerId: result.providerId,
          model: result.model,
          policyVersion: result.policyVersion,
          contentHash,
          translations: result.translations,
          storedAt: Date.now(),
        });
      }
      setAiState({ status: 'ready', message: t('translation.aiReady') });
    } catch {
      setAiState({ status: 'error', message: t('translation.aiFailed') });
    }
  };

  const nextStep = () => {
    if (step === 2 && cueHistory.present.length === 0) {
      setCueHistory({ past: [], present: initialCues(original, mappings), future: [] });
    }
    setStep((current) => Math.min(STEPS.length - 1, current + 1));
  };

  const canContinue = step === 0
    ? Boolean(title.trim())
    : step === 1 ? original.lines.length > 0
      : step === 2 ? mappings.length > 0
        : step === 3 ? sortedCues.some((cue) => cue.kind === 'lyric')
          : true;

  const complete = async () => {
    setSaveState({ status: 'saving', message: '' });
    try {
      const now = Date.now();
      const originalHash = await sha256TextHash(original.lines.map((line) => line.text).join('\n'));
      const translationHash = await sha256TextHash(mappings.map((mapping) => mapping.displayKo).join('\n'));
      const songWork = createSongWork({
        songWorkId: ids.songWorkId,
        canonicalTitle: title,
        canonicalArtist: artist,
        originalLanguage,
        identityStatus: 'confirmed',
        identityEvidence: [{ kind: 'user_input', label: 'user_input', value: `${artist} - ${title}` }],
        now,
      });
      const trackVersion = createTrackVersion({
        trackVersionId: ids.trackVersionId,
        songWorkId: ids.songWorkId,
        sourceType: entry?.song?.type || 'local',
        sourceIdentity: entry?.song?.assetId || entry?.song?.src || '',
        durationMs: Math.max(0, ...sortedCues.map((cue) => cue.anchorMs)) + 5_000,
        versionKind,
        versionLabel: versionKind,
      });
      const lyricDocument = createLyricDocument({
        lyricDocumentId: ids.lyricDocumentId,
        songWorkId: ids.songWorkId,
        language: originalLanguage,
        source: {
          tier: originalSourceTier,
          providerId: 'user-import',
          title: originalSourceTitle,
          url: originalSourceUrl || null,
          retrievedAt: now,
          contentHash: originalHash,
        },
        lines: original.lines,
      });
      const translationRevision = createTranslationRevision({
        translationRevisionId: ids.translationRevisionId,
        songWorkId: ids.songWorkId,
        lyricDocumentId: ids.lyricDocumentId,
        sourceTier: translationSourceTier,
        translationType: officialAdaptation ? 'official_adaptation' : 'semantic_translation',
        source: {
          providerId: 'user-import',
          title: translationSourceTitle,
          url: translationSourceUrl || null,
          translatorName: translatorName || null,
          retrievedAt: now,
          contentHash: translationHash,
        },
        mappings,
        lockedByUser,
        now,
      });
      const cueSheet = {
        cueSheetRevisionId: ids.cueSheetRevisionId,
        songWorkId: ids.songWorkId,
        trackVersionId: ids.trackVersionId,
        lyricDocumentId: ids.lyricDocumentId,
        translationRevisionId: ids.translationRevisionId,
        cues: sortedCues,
        createdAt: now,
      };
      const playbackPackage = await createPlaybackLyricsPackage({
        packageId: ids.packageId,
        songWorkId: ids.songWorkId,
        trackVersionId: ids.trackVersionId,
        cueSheetRevisionId: ids.cueSheetRevisionId,
        translationRevisionId: ids.translationRevisionId,
        durationMs: trackVersion.durationMs,
        timingMode: draftPackage.timingMode,
        ppq: 960,
        tempoSegments: tempoMap.segments,
        cues: sortedCues,
        displayDefaults: displaySettings,
      });
      const bundle = { songWork, trackVersion, lyricDocument, translationRevision, tempoMap, cueSheet, playbackPackage };
      await repository.savePreparationBundle(bundle);
      let published = null;
      try {
        published = typeof publishPackage === 'function' ? await publishPackage(playbackPackage) : null;
      } catch {
        setSaveState({ status: 'warning', message: t('workspace.publishFailed') });
      }
      const lyricsRef = sanitizeLyricsRef({
        packageId: playbackPackage.packageId,
        packageHash: playbackPackage.packageHash,
        schemaVersion: playbackPackage.schemaVersion,
        status: 'ready',
        requireLyrics,
        timingMode: playbackPackage.timingMode,
        songWorkId: ids.songWorkId,
        trackVersionId: ids.trackVersionId,
        cueSheetRevisionId: ids.cueSheetRevisionId,
        assetId: published?.assetId,
        sessionRoom: published?.sessionRoom || sessionRoom,
      });
      await onComplete?.({ bundle, playbackPackage, lyricsRef });
      if (!published && typeof publishPackage === 'function') return;
      setSaveState({ status: 'saved', message: t('workspace.savedLocal') });
      onClose?.();
    } catch {
      setSaveState({ status: 'error', message: t('workspace.error') });
    }
  };

  return (
    <div className="lyrics-workspace-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose?.();
    }}>
      <section className="lyrics-workspace" role="dialog" aria-modal="true" aria-labelledby="lyrics-workspace-title">
        <header>
          <div>
            <span>{t('workspace.step', { current: step + 1, total: STEPS.length })}</span>
            <h2 id="lyrics-workspace-title">{t('workspace.title')}</h2>
          </div>
          <button type="button" className="lyrics-icon-button" aria-label={t('workspace.close')} onClick={onClose}><X size={20} /></button>
        </header>
        <nav aria-label={t('workspace.title')}>
          {STEPS.map((name, index) => (
            <button type="button" key={name} className={index === step ? 'active' : ''} onClick={() => index < step && setStep(index)}>{index + 1}</button>
          ))}
        </nav>
        <div className="lyrics-workspace-body">
          {step === 0 && (
            <div className="lyrics-step">
              <h3>{t('step.identity.title')}</h3><p>{t('step.identity.help')}</p>
              <label><span>{t('identity.title')}</span><input value={title} onChange={(event) => setTitle(event.target.value)} /></label>
              <label><span>{t('identity.artist')}</span><input value={artist} onChange={(event) => setArtist(event.target.value)} /></label>
              <label><span>{t('identity.version')}</span><select value={versionKind} onChange={(event) => setVersionKind(event.target.value)}>{VERSION_KINDS.map(([value, key]) => <option value={value} key={value}>{t(key)}</option>)}</select></label>
              <label><span>{t('identity.originalLanguage')}</span><input value={originalLanguage} maxLength="16" onChange={(event) => setOriginalLanguage(event.target.value)} placeholder="ja" /></label>
            </div>
          )}
          {step === 1 && (
            <div className="lyrics-step">
              <h3>{t('step.original.title')}</h3><p>{t('step.original.help')}</p>
              <label className="lyrics-file-action"><FileUp size={15} /> {t('original.file')}<input type="file" accept=".lrc,.srt,.vtt,.ttml,.xml,.json,.txt,text/*" onChange={(event) => readFile(event.target.files?.[0], setOriginalText, setOriginalFileName)} /></label>
              <label><span>{t('original.text')}</span><textarea rows="10" value={originalText} placeholder={t('original.placeholder')} onChange={(event) => { setOriginalText(event.target.value); setOriginalFileName(''); }} /></label>
              <div className="lyrics-grid-three">
                <label><span>{t('original.sourceTier')}</span><select value={originalSourceTier} onChange={(event) => setOriginalSourceTier(event.target.value)}>{sourceTierOptions()}</select></label>
                <label><span>{t('original.sourceTitle')}</span><input value={originalSourceTitle} onChange={(event) => setOriginalSourceTitle(event.target.value)} /></label>
                <label><span>{t('original.sourceUrl')}</span><input type="url" value={originalSourceUrl} onChange={(event) => setOriginalSourceUrl(event.target.value)} /></label>
              </div>
              <output>{t('original.summary', { lines: original.lines.length, cues: original.timedCues.length, warnings: original.warnings.length })}</output>
            </div>
          )}
          {step === 2 && (
            <div className="lyrics-step">
              <h3>{t('step.translation.title')}</h3><p>{t('step.translation.help')}</p>
              <label className="lyrics-file-action"><FileUp size={15} /> {t('translation.text')}<input type="file" accept=".txt,.srt,.vtt,.json,text/*" onChange={async (event) => syncMappingsFromText(await event.target.files?.[0]?.text() || '')} /></label>
              <label><span>{t('translation.text')}</span><textarea rows="7" value={translationText} placeholder={t('translation.placeholder')} onChange={(event) => syncMappingsFromText(event.target.value)} /></label>
              <div className="lyrics-inline-actions">
                <button
                  type="button"
                  onClick={createAiTranslationDraft}
                  disabled={original.lines.length === 0 || mappingDrafts.length > 0 || aiState.status === 'loading'}
                >{aiState.status === 'loading' ? t('translation.aiLoading') : t('translation.aiAction')}</button>
                <span role="status">{aiState.message || t('translation.aiUnavailable')}</span>
              </div>
              <div className="lyrics-grid-three">
                <label><span>{t('translation.sourceTier')}</span><select value={translationSourceTier} onChange={(event) => setTranslationSourceTier(event.target.value)}>{sourceTierOptions()}</select></label>
                <label><span>{t('translation.sourceTitle')}</span><input value={translationSourceTitle} onChange={(event) => setTranslationSourceTitle(event.target.value)} /></label>
                <label><span>{t('translation.sourceUrl')}</span><input type="url" value={translationSourceUrl} onChange={(event) => setTranslationSourceUrl(event.target.value)} /></label>
                <label><span>{t('translation.translator')}</span><input value={translatorName} onChange={(event) => setTranslatorName(event.target.value)} /></label>
              </div>
              <fieldset className="lyrics-mapping-list"><legend>{t('translation.mapping')}</legend>{mappingDrafts.map((mapping, index) => (
                <div key={mapping.mappingId} className="lyrics-mapping-row">
                  <label><span>{t('translation.originalLines')}</span><input value={mapping.originalInput} onChange={(event) => setMappingDrafts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, originalInput: event.target.value } : item))} /></label>
                  <label><span>{t('translation.koLine')}</span><input value={mapping.displayKo} onChange={(event) => setMappingDrafts((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, displayKo: event.target.value } : item))} /></label>
                  <button type="button" className="lyrics-icon-button" aria-label={t('translation.removeMapping')} onClick={() => setMappingDrafts((items) => items.filter((_, itemIndex) => itemIndex !== index))}><Trash2 size={15} /></button>
                </div>
              ))}<button type="button" onClick={() => setMappingDrafts((items) => [...items, { mappingId: `M${crypto.randomUUID()}`, originalInput: '', displayKo: '' }])}><Plus size={14} /> {t('translation.addMapping')}</button></fieldset>
              <label className="lyrics-check"><input type="checkbox" checked={officialAdaptation} onChange={(event) => setOfficialAdaptation(event.target.checked)} /> {t('translation.adaptation')}</label>
              <label className="lyrics-check"><input type="checkbox" checked={lockedByUser} onChange={(event) => setLockedByUser(event.target.checked)} /> {t('translation.lock')}</label>
            </div>
          )}
          {step === 3 && (
            <div className="lyrics-step">
              <h3>{t('step.timing.title')}</h3><p>{t('step.timing.help')}</p>
              <div className="lyrics-timing-fields">
                <label><span>{t('timing.bpm')}</span><input type="number" min="0" step="0.001" value={bpm} onChange={(event) => setBpm(event.target.value)} /></label>
                <label><span>{t('timing.firstDownbeat')}</span><input type="number" min="0" step="0.01" value={firstDownbeat} onChange={(event) => setFirstDownbeat(event.target.value)} /></label>
                <label><span>{t('timing.numerator')}</span><input type="number" min="1" value={numerator} onChange={(event) => setNumerator(event.target.value)} /></label>
                <label><span>{t('timing.denominator')}</span><select value={denominator} onChange={(event) => setDenominator(event.target.value)}>{[1, 2, 4, 8, 16].map((value) => <option value={value} key={value}>{value}</option>)}</select></label>
                <output>{t(tempoMap.segments.length > 0 ? 'timing.mode.tempo' : 'timing.mode.fallback')}</output>
              </div>
              <LyricsTimelineEditor history={cueHistory} onChange={setCues} onUndo={undoCues} onRedo={redoCues} />
              {timingConflictCount > 0 && <aside role="status">{t('timing.conflictCount', { count: timingConflictCount })}</aside>}
            </div>
          )}
          {step === 4 && (
            <div className="lyrics-step">
              <h3>{t('step.preview.title')}</h3><p>{t('step.preview.help')}</p>
              <LyricsOverlayPreview playbackPackage={draftPackage} timeMs={previewTimeMs} />
              <label><span>{t('preview.time')} · {(previewTimeMs / 1_000).toFixed(2)}s</span><input type="range" min="0" max={Math.max(1_000, ...sortedCues.map((cue) => cue.anchorMs + 1_000))} step="16" value={previewTimeMs} onChange={(event) => setPreviewTimeMs(Number(event.target.value))} /></label>
              <div className="lyrics-preview-meta"><span>{t('preview.source', { source: t(SOURCE_TIERS.find(([value]) => value === translationSourceTier)?.[1] || 'source.trustedWeb') })}</span><span>{t('preview.timing', { mode: t(tempoMap.segments.length > 0 ? 'timing.mode.tempo' : 'timing.mode.fallback') })}</span></div>
              <label className="lyrics-check"><input type="checkbox" checked={requireLyrics} onChange={(event) => setRequireLyrics(event.target.checked)} /> {t('preview.require')}</label>
              <details className="lyrics-style-settings">
                <summary>{t('preview.style')}</summary>
                <div className="lyrics-grid-three">
                  <label><span>{t('preview.position')}</span><select value={displaySettings.positionPreset} onChange={(event) => updateDisplaySetting('positionPreset', event.target.value)}><option value="right_center">{t('preview.position.right')}</option><option value="center">{t('preview.position.center')}</option><option value="lower_third">{t('preview.position.lower')}</option></select></label>
                  <label><span>{t('preview.align')}</span><select value={displaySettings.textAlign} onChange={(event) => updateDisplaySetting('textAlign', event.target.value)}><option value="right">{t('preview.align.right')}</option><option value="center">{t('preview.align.center')}</option><option value="left">{t('preview.align.left')}</option></select></label>
                  <label><span>{t('preview.width')}</span><input type="number" min="320" max="1600" value={displaySettings.areaWidth} onChange={(event) => updateDisplaySetting('areaWidth', Number(event.target.value))} /></label>
                  <label><span>{t('preview.originalSize')}</span><input type="number" min="28" max="120" value={displaySettings.originalFontSize} onChange={(event) => updateDisplaySetting('originalFontSize', Number(event.target.value))} /></label>
                  <label><span>{t('preview.translationSize')}</span><input type="number" min="22" max="100" value={displaySettings.translationFontSize} onChange={(event) => updateDisplaySetting('translationFontSize', Number(event.target.value))} /></label>
                  <label><span>{t('preview.weight')}</span><select value={displaySettings.fontWeight} onChange={(event) => updateDisplaySetting('fontWeight', Number(event.target.value))}>{[500, 600, 700, 800, 900].map((weight) => <option key={weight} value={weight}>{weight}</option>)}</select></label>
                  <label><span>{t('preview.offsetX')}</span><input type="number" min="-800" max="800" value={displaySettings.offsetX} onChange={(event) => updateDisplaySetting('offsetX', Number(event.target.value))} /></label>
                  <label><span>{t('preview.offsetY')}</span><input type="number" min="-500" max="500" value={displaySettings.offsetY} onChange={(event) => updateDisplaySetting('offsetY', Number(event.target.value))} /></label>
                  <label><span>{t('preview.stroke')}</span><input type="number" min="0" max="6" step="0.5" value={displaySettings.strokeWidth} onChange={(event) => updateDisplaySetting('strokeWidth', Number(event.target.value))} /></label>
                </div>
              </details>
            </div>
          )}
          {saveState.message && <div className={`lyrics-save-message is-${saveState.status}`} role="status">{saveState.message}</div>}
        </div>
        <footer>
          <button type="button" onClick={() => setStep((current) => Math.max(0, current - 1))} disabled={step === 0}><ArrowLeft size={15} /> {t('workspace.previous')}</button>
          {step < STEPS.length - 1 ? (
            <button type="button" className="primary" onClick={nextStep} disabled={!canContinue}>{t('workspace.next')} <ArrowRight size={15} /></button>
          ) : (
            <button type="button" className="primary" onClick={complete} disabled={!canContinue || saveState.status === 'saving'}>{saveState.status === 'saving' ? t('workspace.saving') : t('workspace.complete')}</button>
          )}
        </footer>
      </section>
    </div>
  );
}
