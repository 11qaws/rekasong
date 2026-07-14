import React, { useState, useRef, useEffect } from 'react';
import YouTube from 'react-youtube';
import { useSyncState } from '../hooks/useSyncState';
import { getOrCreateRoom, getOrCreateSigningKeys, publishSync } from '../hooks/useRemoteSync';
import jsmediatags from 'jsmediatags/dist/jsmediatags.min.js';

import SearchPanel from '../components/SearchPanel';
import StagingPanel from '../components/StagingPanel';
import LivePanel from '../components/LivePanel';
import './Dashboard.css';

export default function Dashboard() {
  const [state, setSharedState] = useSyncState();
  const [activeVideoId, setActiveVideoId] = useState('');
  const [localAudioSrc, setLocalAudioSrc] = useState(null);

  const [stagedItem, setStagedItem] = useState(null);
  
  const [room] = useState(() => getOrCreateRoom());
  const [signingKeys, setSigningKeys] = useState(null);

  useEffect(() => {
    if (!signingKeys) {
      getOrCreateSigningKeys().then(setSigningKeys).catch(() => {});
    }
  }, [signingKeys]);

  // Update remote widget when state changes
  useEffect(() => {
    if (room && signingKeys) {
      const payload = { state, timestamp: Date.now() };
      publishSync(payload, room, signingKeys.privateKey);
    }
  }, [state, room, signingKeys]);

  const handleSelectSearchResult = (video) => {
    setStagedItem({
      type: 'youtube',
      src: video.id,
      title: video.title,
      artist: video.channelTitle
    });
  };

  const handleLocalFileDrop = (file) => {
    const url = URL.createObjectURL(file);
    setStagedItem({
      type: 'local',
      src: url,
      title: file.name,
      artist: '',
      file: file
    });

    // Try parsing tags for better alias
    jsmediatags.read(file, {
      onSuccess: (tag) => {
        if (tag.tags.title) {
          setStagedItem(prev => ({
            ...prev,
            title: tag.tags.title,
            artist: tag.tags.artist || ''
          }));
        }
      },
      onError: (error) => {
        console.log('No ID3 tags found:', error.type);
      }
    });
  };

  const handleAliasChange = (field, value) => {
    setStagedItem(prev => ({ ...prev, [field]: value }));
  };

  const handleGoLive = async () => {
    if (!stagedItem) return;

    const newSong = {
      id: Date.now().toString(),
      type: stagedItem.type,
      title: stagedItem.title,
      artist: stagedItem.artist,
      src: stagedItem.src
    };

    if (stagedItem.type === 'youtube') {
      setActiveVideoId(stagedItem.src);
      setLocalAudioSrc(null);
    } else if (stagedItem.type === 'local') {
      setActiveVideoId('');
      
      // Need to convert to base64 to send to widget if widget also plays audio?
      // Wait, widget doesn't play audio in this design, Dashboard does.
      // But we still need base64 if we want the widget to have access. 
      // Actually, if Dashboard is the only player, we don't need to send the whole 10MB base64 to the Widget!
      // The widget only needs title and artist.
      setLocalAudioSrc(stagedItem.src);
    }

    setSharedState(prev => ({
      ...prev,
      currentSong: newSong,
      history: [...(prev.history || []), newSong]
    }));

    // Clear staging area after go live
    setStagedItem(null);
  };

  const onLivePlayerReady = (event) => {
    event.target.playVideo();
  };

  return (
    <div className="dashboard-container">
      <header className="dashboard-header">
        <h1 className="logo">Rekasong</h1>
        <p className="subtitle">The Ultimate VTuber Karaoke Dashboard</p>
      </header>

      <div className="dashboard-grid">
        <SearchPanel 
          onSelectResult={handleSelectSearchResult} 
          onLocalFileDrop={handleLocalFileDrop} 
        />
        <StagingPanel 
          stagedItem={stagedItem}
          onAliasChange={handleAliasChange}
          onGoLive={handleGoLive}
        />
        <LivePanel 
          room={room}
          publicKeyB64={signingKeys?.publicKeyB64}
          history={state.history || []}
          currentSong={state.currentSong}
        />
      </div>

      {/* Hidden Live Players */}
      <div className="live-players-hidden">
        {activeVideoId && (
          <YouTube 
            videoId={activeVideoId} 
            opts={{ width: '200', height: '112', playerVars: { autoplay: 1 } }} 
            onReady={onLivePlayerReady}
          />
        )}
        {localAudioSrc && (
          <audio src={localAudioSrc} autoPlay />
        )}
      </div>
    </div>
  );
}
