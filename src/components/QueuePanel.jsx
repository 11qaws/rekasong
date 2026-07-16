import React, { useState } from 'react';
import { ArrowUpCircle, GripVertical, ListMusic, Play, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';
import { createQueueEntry } from '../lib/queueEntry';

export default function QueuePanel({ queue, history, onPlayQueueItem, onRemoveFromQueue, autoPlayNext, setSharedState }) {
  const [dragOverEntryId, setDragOverEntryId] = useState(null);

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
                onDragOver={(event) => { event.preventDefault(); setDragOverEntryId(entry.entryId); }}
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
        <div className="history-list">
          {history.length === 0 ? <div className="queue-empty">아직 재생된 곡이 없습니다.</div> : history.map((entry) => (
            <div key={entry.entryId} className="history-item history-played">
              <span className="history-title">{entry.song.title}</span>
              <div>
                <button
                  type="button"
                  onClick={() => {
                    // 다시 부르기 = 완료 항목 복구가 아니라 새 entryId의 새 QueueEntry(§1, §4-6).
                    const replay = createQueueEntry(entry.song);
                    setSharedState((previous) => ({ ...previous, queue: [replay, ...(previous.queue || [])] }));
                  }}
                  className="btn-icon"
                  title="대기열 맨 위에 다시 추가"
                ><ArrowUpCircle size={15} /></button>
                <button type="button" onClick={() => setSharedState((previous) => ({ ...previous, history: (previous.history || []).filter((item) => item.entryId !== entry.entryId) }))} className="btn-icon btn-icon-danger" title="기록에서 삭제"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
