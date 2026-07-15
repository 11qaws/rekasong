import { useState, useCallback, useEffect } from 'react';

// 멜로밍 노래책 연동 Hook
export function useMeloming(channelId) {
  const [songs, setSongs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchSongs = useCallback(async () => {
    if (!channelId) {
      setSongs([]);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    try {
      // TODO: 실제 멜로밍 API 엔드포인트로 교체
      // const res = await fetch(`https://openapi.meloming.com/v1/channels/${channelId}/songs`);
      // const data = await res.json();
      
      // 목업 데이터 (수백 개의 곡을 시뮬레이션)
      await new Promise(resolve => setTimeout(resolve, 800)); // 네트워크 딜레이
      if (channelId === 'error') {
        throw new Error('채널을 찾을 수 없습니다.');
      }

      const mockData = Array.from({ length: 200 }).map((_, i) => ({
        id: `melo_${i}`,
        title: `멜로밍 등록 곡 ${i + 1}`,
        artist: i % 3 === 0 ? '이세계아이돌' : 'QWER',
        tags: ['밴드', '아이돌', '신나는'].sort(() => 0.5 - Math.random()).slice(0, 1),
        youtubeUrl: '' 
      }));

      mockData.unshift(
        { id: 'm1', title: 'KIDDING', artist: '이세계아이돌', tags: ['아이돌'], youtubeUrl: '' },
        { id: 'm2', title: 'Discord', artist: 'QWER', tags: ['밴드'], youtubeUrl: '' },
        { id: 'm3', title: '사건의 지평선', artist: '윤하', tags: ['발라드'], youtubeUrl: '' }
      );

      setSongs(mockData);
    } catch (err) {
      setError(err.message || '노래책을 불러오는 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, [channelId]);

  useEffect(() => {
    fetchSongs();
  }, [fetchSongs, channelId]);

  return { songs, isLoading, error, refresh: fetchSongs, isDemo: true };
}
