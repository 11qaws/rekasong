import React, { useState } from 'react';
import { History, ListPlus, Play, SkipForward } from 'lucide-react';
import { getAppMessage as t } from '../copy/appMessages';
import {
  SONG_DRAG_DATA_TYPE,
  SONG_DROP_ACTIONS,
  SONG_DROP_DESTINATIONS,
} from '../lib/songDragAction';

const hasSongDragType = (event) => {
  const types = event.dataTransfer?.types;
  return Boolean(types && Array.from(types).includes(SONG_DRAG_DATA_TYPE));
};

export default function SongDropTray({
  candidate,
  hasCurrentSong,
  outputMode,
  playAction,
  onDrop,
}) {
  const [activeDestination, setActiveDestination] = useState(null);
  if (!candidate) return null;

  const playTarget = hasCurrentSong
    ? {
        icon: SkipForward,
        label: t('songDrag.target.playNext'),
        help: t('songDrag.target.playNextHelp'),
      }
    : playAction === SONG_DROP_ACTIONS.PLAY_WHEN_READY
      ? {
          icon: Play,
          label: t('songDrag.target.playWhenReady'),
          help: t('songDrag.target.playWhenReadyHelp'),
        }
      : outputMode === 'obs' && playAction === SONG_DROP_ACTIONS.QUEUE_FRONT
        ? {
            icon: ListPlus,
            label: t('songDrag.target.obsQueueFirst'),
            help: t('songDrag.target.obsQueueFirstHelp'),
          }
        : {
            icon: Play,
            label: t('songDrag.target.playNow'),
            help: t('songDrag.target.playNowHelp'),
          };

  const destinations = [
    {
      id: SONG_DROP_DESTINATIONS.PLAY,
      ...playTarget,
    },
    {
      id: SONG_DROP_DESTINATIONS.QUEUE,
      icon: ListPlus,
      label: t('songDrag.target.queue'),
      help: t('songDrag.target.queueHelp'),
    },
    {
      id: SONG_DROP_DESTINATIONS.HISTORY,
      icon: History,
      label: t('songDrag.target.history'),
      help: t('songDrag.target.historyHelp'),
    },
  ];

  return (
    <aside className="song-drop-tray" aria-hidden="true" data-song-drop-tray="visible">
      <div className="song-drop-tray-copy">
        <strong>{t('songDrag.heading', { title: candidate.title })}</strong>
        <span>{t('songDrag.help')}</span>
      </div>
      <div className="song-drop-targets">
        {destinations.map(({ id, icon: Icon, label, help }) => (
          <div
            key={id}
            className={`song-drop-target${activeDestination === id ? ' is-active' : ''}`}
            data-song-drop-destination={id}
            onDragEnter={(event) => {
              if (!hasSongDragType(event)) return;
              event.preventDefault();
              setActiveDestination(id);
            }}
            onDragOver={(event) => {
              if (!hasSongDragType(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              if (activeDestination !== id) setActiveDestination(id);
            }}
            onDragLeave={(event) => {
              if (event.currentTarget.contains(event.relatedTarget)) return;
              setActiveDestination((current) => current === id ? null : current);
            }}
            onDrop={(event) => {
              if (!hasSongDragType(event)) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = 'copy';
              setActiveDestination(null);
              onDrop(id);
            }}
          >
            <Icon size={22} aria-hidden="true" />
            <strong>{label}</strong>
            <span>{help}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
