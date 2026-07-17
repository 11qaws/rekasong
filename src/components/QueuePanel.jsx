import React, { useState } from 'react';
import { ArrowUpCircle, GripVertical, ListMusic, Play, Plus, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { createManualEntry, createQueueEntry, isPlayableSongDef } from '../lib/queueEntry';

// 드래그 페이로드 타입 검사 — 대기열↔이력 간 교차 드롭이나 외부(파일 등)
// 드래그가 잘못된 리스트에 하이라이트/드롭되지 않게 한다. dataTransfer의
// 커스텀 타입은 사양상 소문자로 저장되므로 소문자 리터럴로 비교한다.
const hasDragType = (event, type) => {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes(type));
};

export default function QueuePanel({ queue, history, onPlayQueueItem, onRemoveFromQueue, autoPlayNext, setSharedState }) {
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
    <section className="panel queue-panel glass-card" aria-label="다음 곡 대기열">
      <div className="queue-panel-header">
        <div className="playback-heading"><ListMusic size={17} /> 다음 곡 대기열 <span>{queue.length}</span></div>
        {queue.length > 0 && <button type="button" onClick={() => setSharedState((previous) => ({ ...previous, queue: [] }))} className="btn-icon btn-icon-danger" title="대기열 전체 비우기"><Trash2 size={15} /></button>}
      </div>
      <details className="playback-options">
        <summary>자동 다음 곡 {autoPlayNext ? '켜짐' : '꺼짐'}</summary>
        <label>
          <input type="checkbox" checked={autoPlayNext} onChange={(event) => setSharedState((previous) => ({ ...previous, autoPlayNext: event.target.checked }))} />
          <span>현재 곡이 끝나면 다음 곡 재생</span>
        </label>
      </details>
      <div className="queue-list">
        {queue.length === 0 ? (
          <div className="queue-empty">다음에 부를 곡이 없습니다.</div>
        ) : (
          <AnimatePresence initial={false}>
            {queue.map((entry, index) => (
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
                <button type="button" onClick={() => onPlayQueueItem(entry.entryId)} className="queue-play-action" title="이 곡을 바로 현재 재생으로 가져오기"><Play size={14} /> 바로 재생</button>
                <button type="button" onClick={() => onRemoveFromQueue(entry.entryId)} className="btn-icon btn-icon-danger" title="대기열에서 제거"><X size={15} /></button>
              </motion.div>
            ))}
          </AnimatePresence>
        )}
      </div>
      <details className="history-accordion">
        <summary>이전 재생 곡 ({history.length})</summary>
        {/* 표시 전용 항목 직접 추가 — 잘못 올라간 setlist를 손으로 고치는 입력줄.
            기존 클래스(glass-input/queue-play-action)만 재사용, 레이아웃만 인라인. */}
        <form className="history-manual-form" style={{ display: 'flex', alignItems: 'center', gap: '0.4rem', marginTop: '0.6rem' }} onSubmit={addManualHistoryItem}>
          <input
            className="glass-input"
            style={{ flex: '1 1 auto', minWidth: 0, padding: '0.45rem 0.6rem', fontSize: '0.84rem' }}
            value={manualTitle}
            onChange={(event) => setManualTitle(event.target.value)}
            placeholder="곡 제목 (표기용 직접 추가)"
            aria-label="직접 추가할 곡 제목"
          />
          <input
            className="glass-input"
            style={{ flex: '0 1 32%', minWidth: 0, padding: '0.45rem 0.6rem', fontSize: '0.84rem' }}
            value={manualArtist}
            onChange={(event) => setManualArtist(event.target.value)}
            placeholder="가수 (선택)"
            aria-label="직접 추가할 곡의 가수 (선택)"
          />
          <button type="submit" className="queue-play-action" disabled={!manualTitle.trim()} title="재생 없이 setlist 표기용으로 이전 재생 곡에 추가">
            <Plus size={14} /> 추가
          </button>
        </form>
        <div className="history-list">
          {history.length === 0 ? <div className="queue-empty">아직 재생된 곡이 없습니다.</div> : history.map((entry) => {
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
                <span className="queue-grip" title="드래그로 순서 변경"><GripVertical size={14} /></span>
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
                      ? '대기열 맨 위에 다시 추가'
                      : '직접 추가된 표기용 항목은 재생 정보(MR)가 없어 다시 부를 수 없습니다'}
                  ><ArrowUpCircle size={15} /></button>
                  <button type="button" onClick={() => setSharedState((previous) => ({ ...previous, history: (previous.history || []).filter((item) => item.entryId !== entry.entryId) }))} className="btn-icon btn-icon-danger" title="기록에서 삭제"><Trash2 size={15} /></button>
                </div>
              </div>
            );
          })}
        </div>
      </details>
    </section>
  );
}
