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
          className="setlist-wrapper"
          initial={{ opacity: 0, y: -30 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, delay: 0.2 }}
        >
          <div className="setlist-body">
            <div className="setlist-header">
              <span className="dot">·</span> setlist <span className="dot">·</span>
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
          </div>
          
          {/* 1920x1080 비율에 맞춘 더 깊고 날카로운 V컷 꼬리(Tail) SVG (배경 중첩 방지를 위해 테두리만 렌더링) */}
          <svg className="setlist-tail" viewBox="0 0 340 70">
            <path 
              d="M 0.75 0 L 0.75 69 L 170 9 L 339.25 69 L 339.25 0" 
              fill="none" 
              stroke="rgba(255, 255, 255, 0.9)" 
              strokeWidth="1.5" 
            />
          </svg>
        </motion.div>
      </div>
      )}
    </div>
  );
}
