import React, { useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useWidgetSync } from '../hooks/useRemoteSync';
import './Widget.css';

export default function Widget() {
  const [state, setState] = useState({ currentSong: null, queue: [] });

  // URL에서 파라미터 추출 (HashRouter 환경 대비)
  const hash = window.location.hash;
  const roomMatch = hash.match(/room=([^&]+)/);
  const keyMatch = hash.match(/key=([^&]+)/);
  const typeMatch = hash.match(/type=([^&]+)/);
  
  const searchParams = new URLSearchParams(window.location.search);
  const room = searchParams.get('room') || (roomMatch ? roomMatch[1] : null);
  const publicKeyB64 = searchParams.get('key') || (keyMatch ? keyMatch[1] : null);
  const type = searchParams.get('type') || (typeMatch ? typeMatch[1] : null);

  useWidgetSync(room, publicKeyB64, (payload) => {
    setState(payload.state);
  });

  const { currentSong, queue } = state;

  return (
    <div className="widget-container">
      {/* 몽환적인 별빛 배경 파티클 (배경은 투명하지만 별은 반짝임) */}
      <div className="star-particles">
        <div className="star-particle s1"></div>
        <div className="star-particle s2"></div>
        <div className="star-particle s3"></div>
      </div>

      {/* 1. Current Song (Top Left) */}
      {(!type || type === 'current') && (
        <div className="current-song-area">
        <AnimatePresence mode="wait">
          {currentSong && (
            <motion.div
              key={currentSong.id}
              initial={{ opacity: 0, y: 20, filter: 'blur(10px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -20, filter: 'blur(10px)' }}
              transition={{ duration: 0.6, ease: 'easeOut' }}
              className="current-song-title"
            >
              {currentSong.title}
            </motion.div>
          )}
        </AnimatePresence>
      </div>
      )}

      {/* 2. Setlist History (Right Side) */}
      {(!type || type === 'setlist') && (
        <div className="setlist-area">
        <motion.div 
          className="glass-panel setlist-panel"
          initial={{ opacity: 0, x: 50 }}
          animate={{ opacity: 1, x: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <div className="setlist-header">
            <span className="star">★</span> setlist <span className="star">★</span>
          </div>
          <div className="setlist-items">
            <AnimatePresence>
              {queue.map((song, index) => {
                const isCurrent = currentSong?.id === song.id;
                const isPast = queue.findIndex(s => s.id === currentSong?.id) > index;
                
                return (
                  <motion.div
                    key={song.id}
                    layout
                    initial={{ opacity: 0, x: 20 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.4 }}
                    className={`setlist-item ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}`}
                  >
                    {song.title}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        </motion.div>
      </div>
      )}
    </div>
  );
}
