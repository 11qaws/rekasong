import React, { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { useWidgetSync } from '../hooks/useRemoteSync';
import OnAirPlayer from '../components/OnAirPlayer';
import './Widget.css';

export default function Widget() {
  const [state, setState] = useState({ currentSong: null, queue: [], history: [] });

  // URL에서 파라미터 추출 (HashRouter 환경 대비)
  const hash = window.location.hash;
  const roomMatch = hash.match(/room=([^&]+)/);
  const keyMatch = hash.match(/key=([^&]+)/);
  const typeMatch = hash.match(/type=([^&]+)/);
  
  const searchParams = new URLSearchParams(window.location.search);
  const hashParams = new URLSearchParams(hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '');
  const room = searchParams.get('room') || (roomMatch ? roomMatch[1] : null);
  const publicKeyB64 = searchParams.get('key') || (keyMatch ? keyMatch[1] : null);
  const type = searchParams.get('type') || (typeMatch ? typeMatch[1] : null);
  const mode = searchParams.get('mode') || hashParams.get('mode') || '';
  const session = searchParams.get('session') || hashParams.get('session') || '';
  const token = searchParams.get('token') || hashParams.get('token') || '';
  const apiBaseUrl = searchParams.get('api') || hashParams.get('api') || '';

  useWidgetSync(room, publicKeyB64, (payload) => {
    setState(payload.state);
  });

  useEffect(() => {
    if (mode !== 'display' || !apiBaseUrl || !session || !token) return undefined;

    let socket;
    try {
      const url = new URL(`/v1/sessions/${encodeURIComponent(session)}/ws`, apiBaseUrl);
      url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
      url.searchParams.set('role', 'display');
      url.searchParams.set('token', token);
      socket = new WebSocket(url.toString());
      socket.onmessage = (event) => {
        try {
          const payload = JSON.parse(event.data);
          if ((payload.type === 'snapshot' || payload.type === 'display_state') && payload.display) {
            setState(payload.display);
          }
          if (payload.type === 'session_ended') setState({ currentSong: null, history: [] });
        } catch {
          // Keep the information widget visible while its session reconnects.
        }
      };
    } catch {
      // The OBS browser source will retry after its normal refresh/reconnect cycle.
    }

    return () => socket?.close();
  }, [mode, apiBaseUrl, session, token]);

  if (mode === 'player') {
    return <OnAirPlayer apiBaseUrl={apiBaseUrl} room={session} token={token} />;
  }

  const { currentSong, history = [] } = state;
  // The broadcast-facing list is the songs already sung plus the song that is
  // currently on air. The dashboard queue is deliberately kept private so it
  // does not reveal upcoming requests to viewers.
  const setlist = [...history, ...(currentSong ? [currentSong] : [])];

  return (
    <div className="widget-container">
      {/* 몽환적인 별빛 배경 파티클 (배경은 투명하지만 별은 반짝임) */}
      <div className="star-particles">
        <div className="star-particle s1"></div>
        <div className="star-particle s2"></div>
        <div className="star-particle s3"></div>
      </div>

      {/* Album Art Background Blur */}
      <AnimatePresence>
        {currentSong?.type === 'youtube' && (
          <motion.div
            key={`bg-${currentSong.id}`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.3 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 1.5 }}
            className="widget-bg-blur"
            style={{ backgroundImage: currentSong.type === 'youtube' ? `url(https://img.youtube.com/vi/${currentSong.src}/maxresdefault.jpg)` : 'url(https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=1920&auto=format&fit=crop)' }}
          />
        )}
      </AnimatePresence>

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
            >
              <div className="album-art-container">
                <div className="vinyl-record">
                  <img 
                    src={currentSong.type === 'youtube' ? `https://img.youtube.com/vi/${currentSong.src}/mqdefault.jpg` : 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=200&auto=format&fit=crop'} 
                    alt="Album Art" 
                    className="album-art-img" 
                    onError={(e) => { e.target.onerror = null; e.target.src = 'https://images.unsplash.com/photo-1514525253161-7a46d19cd819?q=80&w=200&auto=format&fit=crop'; }}
                  />
                </div>
              </div>
              <div className="current-song-text" style={{display: 'flex', flexDirection: 'column', gap: '0.2rem', alignItems: 'flex-start'}}>
                {currentSong.source === 'meloming' && <div style={{fontSize:'12px', background:'var(--eureka-emerald)', color:'#fff', padding:'2px 8px', borderRadius:'10px', display:'inline-block'}}>Meloming</div>}
                {currentSong.source === 'setlink' && <div style={{fontSize:'12px', background:'var(--eureka-azure)', color:'#fff', padding:'2px 8px', borderRadius:'10px', display:'inline-block'}}>Setlink</div>}
                <span>{currentSong.title}</span>
                {currentSong.tags && currentSong.tags.length > 0 && (
                  <div style={{fontSize:'12px', color:'rgba(255,255,255,0.7)', marginTop:'2px'}}>
                    {currentSong.tags.map(t => `#${t}`).join(' ')}
                  </div>
                )}
              </div>
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
                {setlist.map((song) => {
                  const isCurrent = currentSong?.id === song.id;
                  const isPast = !isCurrent;
                  
                  return (
                      <motion.div
                        key={song.id}
                        layout
                        layoutId={`song-${song.id}`}
                        initial={{ opacity: 0, x: 20 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, scale: 0.9 }}
                        transition={{ duration: 0.4 }}
                        className={`setlist-item ${isCurrent ? 'current' : ''} ${isPast ? 'past' : ''}`}
                      >
                      {isCurrent && <span style={{marginRight:'8px', color:'var(--eureka-emerald)', fontSize:'18px'}}>▶</span>}
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
