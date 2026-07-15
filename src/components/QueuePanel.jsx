import React, { useState } from 'react';
import { ArrowUpCircle, CircleCheck, Clock3, GripVertical, ListMusic, LoaderCircle, Play, Trash2, X } from 'lucide-react';
import { AnimatePresence, motion } from 'framer-motion';

export default function QueuePanel({ queue, history, preparationBySongId = {}, onPlayQueueItem, onRemoveFromQueue, autoPlayNext, setSharedState }) {
  const [dragOverIndex, setDragOverIndex] = useState(null);

  const moveQueueItem = (event, dropIndex) => {
    event.preventDefault();
    const dragIndex = Number(event.dataTransfer.getData('queueIndex'));
    setDragOverIndex(null);
    if (!Number.isInteger(dragIndex) || dragIndex === dropIndex) return;
    setSharedState((previous) => {
      const nextQueue = [...(previous.queue || [])];
      const [song] = nextQueue.splice(dragIndex, 1);
      nextQueue.splice(dropIndex, 0, song);
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
            {queue.map((song, index) => {
              const preparation = song.type === 'youtube' ? (preparationBySongId[song.id] || 'queued') : null;
              const readiness = preparation === 'ready'
                ? { label: '준비됨', icon: CircleCheck }
                : preparation === 'preparing'
                  ? { label: '준비 중', icon: LoaderCircle }
                  : preparation === 'failed'
                    ? { label: '준비 실패', icon: Clock3 }
                    : { label: '대기', icon: Clock3 };
              const ReadinessIcon = readiness.icon;
              return (
              <motion.div
                key={song.id || index}
                layout
                initial={{ opacity: 0, y: -8 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, x: 16 }}
                className={`queue-row ${dragOverIndex === index ? 'drag-over' : ''}`}
                draggable
                onDragStart={(event) => event.dataTransfer.setData('queueIndex', String(index))}
                onDragOver={(event) => { event.preventDefault(); setDragOverIndex(index); }}
                onDragLeave={() => setDragOverIndex(null)}
                onDrop={(event) => moveQueueItem(event, index)}
              >
                <span className="queue-grip"><GripVertical size={15} /> {index + 1}</span>
                <strong>{song.title}</strong>
                {song.type === 'youtube' && <span className={`queue-readiness is-${preparation}`} title={preparation === 'queued' ? '풀에 들어오면 준비를 시작합니다.' : `YouTube ${readiness.label}`}><ReadinessIcon size={13} /> {readiness.label}</span>}
                <button type="button" onClick={() => onPlayQueueItem(song.id)} className="queue-play-action" title="이 곡을 바로 현재 재생으로 가져오기"><Play size={14} /> 바로 재생</button>
                <button type="button" onClick={() => onRemoveFromQueue(song.id)} className="btn-icon btn-icon-danger" title="대기열에서 제거"><X size={15} /></button>
              </motion.div>
              );
            })}
          </AnimatePresence>
        )}
      </div>
      <details className="history-accordion">
        <summary>이전 재생 곡 ({history.length})</summary>
        <div className="history-list">
          {history.length === 0 ? <div className="queue-empty">아직 재생된 곡이 없습니다.</div> : history.map((song) => (
            <div key={song.id} className="history-item history-played">
              <span className="history-title">{song.title}</span>
              <div>
                <button type="button" onClick={() => setSharedState((previous) => ({ ...previous, queue: [{ ...song, id: Date.now().toString() }, ...(previous.queue || [])] }))} className="btn-icon" title="대기열 맨 위에 다시 추가"><ArrowUpCircle size={15} /></button>
                <button type="button" onClick={() => setSharedState((previous) => ({ ...previous, history: (previous.history || []).filter((item) => item.id !== song.id) }))} className="btn-icon btn-icon-danger" title="기록에서 삭제"><Trash2 size={15} /></button>
              </div>
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}
