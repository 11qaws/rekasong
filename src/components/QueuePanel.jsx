import React, { useState } from 'react';
import { AlertTriangle, ArrowUpCircle, Check, GripVertical, ListMusic, Loader2, Play, Plus, RotateCcw, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { createManualEntry, createQueueEntry, isPlayableSongDef } from '../lib/queueEntry';
import { getOutputMessage as t } from '../copy/outputMessages';
import { songPrepareState } from '../lib/preparePipeline';

// Stage 6c(계약 §5): 대기열 행의 준비 상태 표시 정의. 실패가 방송 전에 눈에
// 띄는 것이 이 표시의 존재 이유다 — ready는 조용히, 실패만 강조한다.
// 로컬 파일 등 준비가 필요 없는 소스도 같은 '준비됨'으로 표시해 소스가 달라도
// 동일하게 동작한다는 확신을 준다(songPrepareState가 단일 판정 지점).
const PREPARE_BADGES = {
  ready: { labelKey: 'prepare.badge.ready.label', titleKey: 'prepare.badge.ready.title' },
  preparing: { labelKey: 'prepare.badge.preparing.label', titleKey: 'prepare.badge.preparing.title' },
  failed: { labelKey: 'prepare.badge.failed.label', titleKey: 'prepare.block.failed' },
  unavailable: { labelKey: 'prepare.badge.unavailable.label', titleKey: 'prepare.block.unavailable' },
  session_invalid: { labelKey: 'prepare.badge.sessionInvalid.label', titleKey: 'prepare.block.sessionInvalid' },
  session_ended: { labelKey: 'prepare.badge.sessionEnded.label', titleKey: 'prepare.block.sessionEnded' },
  network_error: { labelKey: 'prepare.badge.networkError.label', titleKey: 'prepare.block.networkError' },
  server_error: { labelKey: 'prepare.badge.serverError.label', titleKey: 'prepare.block.serverError' },
  temporarily_unavailable: {
    labelKey: 'prepare.badge.temporarilyUnavailable.label',
    titleKey: 'prepare.block.temporarilyUnavailable'
  },
  unreachable: {
    labelKey: 'prepare.badge.temporarilyUnavailable.label',
    titleKey: 'prepare.block.temporarilyUnavailable'
  },
  blocked: { labelKey: 'prepare.badge.blocked.label', titleKey: 'prepare.block.blocked' }
};

const prepareBadgeKind = (state) => state?.connectionKind || state?.kind || 'preparing';

function PrepareBadge({ state }) {
  const kind = state?.kind || 'preparing';
  const badgeKind = prepareBadgeKind(state);
  const badge = PREPARE_BADGES[badgeKind] || PREPARE_BADGES.preparing;
  const message = t(badge.titleKey);
  const title = state?.reason
    ? t('prepare.badge.reasonDetail', { message, reason: state.reason })
    : message;
  const isConnectionDelay = kind === 'unreachable';
  return (
    <span className={`queue-prepare-badge is-${isConnectionDelay ? 'unreachable' : kind}`} title={title}>
      {kind === 'ready' && <Check size={11} />}
      {kind === 'preparing' && <Loader2 size={11} className="spinner" />}
      {(kind === 'failed' || kind === 'unavailable' || kind === 'blocked') && <AlertTriangle size={11} />}
      {isConnectionDelay && <Loader2 size={11} className="spinner" />}
      {t(badge.labelKey)}
    </span>
  );
}

// 드래그 페이로드 타입 검사 — 대기열↔이력 간 교차 드롭이나 외부(파일 등)
// 드래그가 잘못된 리스트에 하이라이트/드롭되지 않게 한다. dataTransfer의
// 커스텀 타입은 사양상 소문자로 저장되므로 소문자 리터럴로 비교한다.
const hasDragType = (event, type) => {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes(type));
};

export default function QueuePanel({ queue, history, onPlayQueueItem, onRemoveFromQueue, autoPlayNext, setSharedState, prepareStates, onRetryPrepare }) {
  const [dragOverEntryId, setDragOverEntryId] = useState(null);
  const [dragOverHistoryEntryId, setDragOverHistoryEntryId] = useState(null);
  const [manualTitle, setManualTitle] = useState('');
  const [manualArtist, setManualArtist] = useState('');

  // D-21: 드래그 시작 시의 인덱스가 아니라 entryId로 항목을 식별하고, 드롭
  // 시점의 최신 대기열에서 위치를 다시 계산한다. 드래그 중 자동 다음 곡으로
  // 대기열이 소비되어도 엉뚱한 곡이 이동하지 않는다.
  const moveQueueItem = (event, targetEntryId) => {
    event.preventDefault();
    const draggedEntryId = event.dataTransfer.getData('queueEntryId');
    setDragOverEntryId(null);
    if (!draggedEntryId || draggedEntryId === targetEntryId) return;
    setSharedState((previous) => {
      const nextQueue = [...(previous.queue || [])];
      const fromIndex = nextQueue.findIndex((entry) => entry.entryId === draggedEntryId);
      const toIndex = nextQueue.findIndex((entry) => entry.entryId === targetEntryId);
      if (fromIndex < 0 || toIndex < 0) return previous;
      const [moved] = nextQueue.splice(fromIndex, 1);
      nextQueue.splice(toIndex, 0, moved);
      return { ...previous, queue: nextQueue };
    });
  };

  // 이력(setlist) 재정렬 — 대기열과 동일한 D-21 방식(entryId 기준, 드롭 시점 재계산).
  const moveHistoryItem = (event, targetEntryId) => {
    event.preventDefault();
    const draggedEntryId = event.dataTransfer.getData('historyEntryId');
    setDragOverHistoryEntryId(null);
    if (!draggedEntryId || draggedEntryId === targetEntryId) return;
    setSharedState((previous) => {
      const nextHistory = [...(previous.history || [])];
      const fromIndex = nextHistory.findIndex((entry) => entry.entryId === draggedEntryId);
      const toIndex = nextHistory.findIndex((entry) => entry.entryId === targetEntryId);
      if (fromIndex < 0 || toIndex < 0) return previous;
      const [moved] = nextHistory.splice(fromIndex, 1);
      nextHistory.splice(toIndex, 0, moved);
      return { ...previous, history: nextHistory };
    });
  };

  // 표시 전용(수동) 항목 추가 — setlist 표기용, 재생 src 없음(§manual).
  const addManualHistoryItem = (event) => {
    event.preventDefault();
    const title = manualTitle.trim();
    if (!title) return;
    const entry = createManualEntry(title, manualArtist);
    setSharedState((previous) => ({ ...previous, history: [...(previous.history || []), entry] }));
    setManualTitle('');
    setManualArtist('');
  };

  return (
    <section className="panel queue-panel glass-card" aria-label={t('queue.region.label')}>
      <div className="queue-panel-header">
        <div className="playback-heading"><ListMusic size={17} /> {t('queue.heading')} <span>{queue.length}</span></div>
        {queue.length > 0 && <button type="button" onClick={() => setSharedState((previous) => ({ ...previous, queue: [] }))} className="btn-icon btn-icon-danger" title={t('queue.action.clear.title')}><Trash2 size={15} /></button>}
      </div>
      <details className="playback-options">
        <summary>{t('queue.autoplay.summary', {
          state: t(autoPlayNext ? 'queue.autoplay.on' : 'queue.autoplay.off')
        })}</summary>
        <label>
          <input type="checkbox" checked={autoPlayNext} onChange={(event) => setSharedState((previous) => ({ ...previous, autoPlayNext: event.target.checked }))} />
          <span>{t('queue.autoplay.label')}</span>
        </label>
      </details>
      <div className="queue-list">
        {queue.length === 0 ? (
          <div className="queue-empty">{t('queue.empty')}</div>
        ) : (
          <AnimatePresence initial={false}>
            {queue.map((entry, index) => {
              const prep = songPrepareState(entry.song, prepareStates);
              // 실패 행은 '바로 재생' 자리에 '다시 시도'를 놓는다 — 어차피 재생이
              // 불가한 버튼을 남겨 두는 대신, 지금 가능한 유일한 회복 행동을 준다.
              // unavailable(영구 실패)도 force 재시도로만 되살릴 수 있다(비공개→공개 전환 등).
              const retryable = ['failed', 'unavailable', 'unreachable'].includes(prep.kind);
              const refreshesConnection = ['session_invalid', 'session_ended'].includes(prep.connectionKind);
              const prepBadge = PREPARE_BADGES[prepareBadgeKind(prep)] || PREPARE_BADGES.preparing;
              return (
                <motion.div
                  key={entry.entryId}
                  layout
                  initial={{ opacity: 0, y: -8 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, x: 16 }}
                  className={`queue-row ${dragOverEntryId === entry.entryId ? 'drag-over' : ''}`}
                  draggable
                  onDragStart={(event) => event.dataTransfer.setData('queueEntryId', entry.entryId)}
                  onDragOver={(event) => {
                    if (!hasDragType(event, 'queueentryid')) return;
                    event.preventDefault();
                    setDragOverEntryId(entry.entryId);
                  }}
                  onDragLeave={() => setDragOverEntryId(null)}
                  onDrop={(event) => moveQueueItem(event, entry.entryId)}
                >
                  <span className="queue-grip"><GripVertical size={15} /> {index + 1}</span>
                  <strong>{entry.song.title}</strong>
                  <PrepareBadge state={prep} />
                  {retryable ? (
                    <button
                      type="button"
                      onClick={() => onRetryPrepare(entry.song.src)}
                      className="queue-play-action"
                      title={t(refreshesConnection
                        ? 'prepare.action.refreshConnection.title'
                        : 'prepare.action.retry.title')}
                    >
                      <RotateCcw size={14} />
                      {t(refreshesConnection
                        ? 'prepare.action.refreshConnection.label'
                        : 'prepare.action.retry.label')}
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => onPlayQueueItem(entry.entryId)}
                      className="queue-play-action"
                      disabled={prep.kind !== 'ready'}
                      title={prep.kind === 'ready'
                        ? t('prepare.action.playNow.title')
                        : t(prepBadge.titleKey)}
                    ><Play size={14} /> {t('queue.action.playNow.label')}</button>
                  )}
                  <button type="button" onClick={() => onRemoveFromQueue(entry.entryId)} className="btn-icon btn-icon-danger" title={t('queue.action.remove.title')}><X size={15} /></button>
                </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>
      <details className="history-accordion">
        <summary>{t('queue.history.summary', { count: history.length })}</summary>
        {/* 표시 전용 항목 직접 추가 — 잘못 올라간 setlist를 손으로 고치는 입력줄.
            기존 클래스(glass-input/queue-play-action)만 재사용, 레이아웃만 인라인. */}
        <form className="history-manual-form" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.6rem' }} onSubmit={addManualHistoryItem}>
          <input
            className="glass-input"
            style={{ flex: '1 1 auto', minWidth: 0, padding: '0.45rem 0.6rem', fontSize: '0.84rem' }}
            value={manualTitle}
            onChange={(event) => setManualTitle(event.target.value)}
            placeholder={t('queue.history.manual.title.placeholder')}
            aria-label={t('queue.history.manual.title.label')}
          />
          <input
            className="glass-input"
            style={{ flex: '0 1 32%', minWidth: 0, padding: '0.45rem 0.6rem', fontSize: '0.84rem' }}
            value={manualArtist}
            onChange={(event) => setManualArtist(event.target.value)}
            placeholder={t('queue.history.manual.artist.placeholder')}
            aria-label={t('queue.history.manual.artist.label')}
          />
          <button type="submit" className="queue-play-action" disabled={!manualTitle.trim()} title={t('queue.history.manual.add.title')}>
            <Plus size={14} /> {t('queue.history.manual.add.label')}
          </button>
        </form>
        <div className="history-list">
          {history.length === 0 ? <div className="queue-empty">{t('queue.history.empty')}</div> : history.map((entry) => {
            const manual = entry.song?.manual === true;
            const replayable = isPlayableSongDef(entry.song);
            const isDragOver = dragOverHistoryEntryId === entry.entryId;
            return (
              <div
                key={entry.entryId}
                className={`history-item history-played${isDragOver ? ' queue-item draggable drag-over' : ''}`}
                draggable
                onDragStart={(event) => event.dataTransfer.setData('historyEntryId', entry.entryId)}
                onDragOver={(event) => {
                  if (!hasDragType(event, 'historyentryid')) return;
                  event.preventDefault();
                  setDragOverHistoryEntryId(entry.entryId);
                }}
                onDragLeave={() => setDragOverHistoryEntryId(null)}
                onDrop={(event) => moveHistoryItem(event, entry.entryId)}
              >
                <span className="queue-grip" title={t('queue.history.reorder.title')}><GripVertical size={14} /></span>
                <span className="history-title">
                  {entry.song.title}
                  {manual && entry.song.artist ? <span className="history-artist"> — {entry.song.artist}</span> : null}
                </span>
                <div>
                  <button
                    type="button"
                    onClick={() => {
                      if (!replayable) return;
                      // 다시 부르기 = 완료 항목 복구가 아니라 새 entryId의 새 QueueEntry(§1, §4-6).
                      const replay = createQueueEntry(entry.song);
                      setSharedState((previous) => ({ ...previous, queue: [replay, ...(previous.queue || [])] }));
                    }}
                    className="btn-icon"
                    disabled={!replayable}
                    title={replayable
                      ? t('queue.history.replay.title')
                      : t('queue.history.replay.unavailableTitle')}
                  ><ArrowUpCircle size={15} /></button>
                  <button type="button" onClick={() => setSharedState((previous) => ({ ...previous, history: (previous.history || []).filter((item) => item.entryId !== entry.entryId) }))} className="btn-icon btn-icon-danger" title={t('queue.history.remove.title')}><Trash2 size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </section>
  );
}
