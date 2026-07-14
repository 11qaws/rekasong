import { useState, useCallback, useEffect } from 'react';

// Setlink 노래책 연동 Hook
export function useSetlink(publicId) {
  const [songs, setSongs] = useState([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchSongs = useCallback(async () => {
    if (!publicId) {
      setSongs([]);
      return;
    }
    
    setIsLoading(true);
    setError(null);
    try {
      // TODO: 실제 Setlink API 엔드포인트로 교체
      // const res = await fetch(`https://setlink.jp/api/public/list?id=${publicId}`);
      // const data = await res.json();
      
      // 목업 데이터 (수백 개의 곡을 시뮬레이션하기 위해 100개의 더미 데이터 생성)
      await new Promise(resolve => setTimeout(resolve, 600)); // 네트워크 딜레이
      if (publicId === 'error') {
        throw new Error('공개 리스트를 찾을 수 없습니다.');
      }

      const mockData = Array.from({ length: 150 }).map((_, i) => ({
        id: `setlink_${i}`,
        title: `Setlink 테스트 곡 ${i + 1}`,
        artist: i % 2 === 0 ? '아이유' : '요네즈 켄시',
        tags: ['J-POP', '애니송', '발라드'].sort(() => 0.5 - Math.random()).slice(0, 1),
        youtubeUrl: '' // 실제 연동 시 존재할 수 있음
      }));
      
      // 특별한 곡 몇 개 추가
      mockData.unshift(
        { id: 's1', title: 'Lemon', artist: '요네즈 켄시', tags: ['J-POP'], youtubeUrl: '' },
        { id: 's2', title: '좋은 날', artist: '아이유', tags: ['K-POP'], youtubeUrl: '' },
        { id: 's3', title: '아이돌 (Idol)', artist: 'YOASOBI', tags: ['J-POP', '애니송'], youtubeUrl: '' }
      );

      setSongs(mockData);
    } catch (err) {
      setError(err.message || '노래책을 불러오는 중 오류가 발생했습니다.');
    } finally {
      setIsLoading(false);
    }
  }, [publicId]);

  useEffect(() => {
    fetchSongs();
  }, [fetchSongs]);

  return { songs, isLoading, error, refresh: fetchSongs };
}
