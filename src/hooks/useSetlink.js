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

      let mockData = [];
      if (publicId === 'ccd4cab1-5f67-40a1-92af-e6f8b80fc307') {
        mockData = [
          { id: 'setlink_1', title: '-ERROR', artist: 'niki', tags: ['VOCALOID', '릴리'], youtubeUrl: '' },
          { id: 'setlink_2', title: '(무)책임집합체', artist: '마사라다', tags: ['VOCALOID', '카사네 테토'], youtubeUrl: '' },
          { id: 'setlink_3', title: '+♂', artist: 'Giga', tags: ['VOCALOID', '카가미네 렌', '여자들'], youtubeUrl: '' },
          { id: 'setlink_4', title: '0verf1ow', artist: 'FUZI & Neru', tags: ['J-POP/애니'], youtubeUrl: '' },
          { id: 'setlink_5', title: '3년째의 바람', artist: '히로시와 키보', tags: ['J-POP/애니'], youtubeUrl: '' },
          { id: 'setlink_6', title: '3분짜리 곡을 듣는 데 걸리는 시간은 3분', artist: '오와타', tags: ['VOCALOID', '요와네 하쿠', '아키타 네루'], youtubeUrl: '' },
          { id: 'setlink_7', title: '5번째의 피에로', artist: 'mothy', tags: ['VOCALOID', '에빌리오스', '카가미네 렌'], youtubeUrl: '' },
          { id: 'setlink_8', title: '7 years', artist: 'Lukas Graham', tags: ['English'], youtubeUrl: '' },
          { id: 'setlink_9', title: '7.0×10^9의 천애고독', artist: 'Neru', tags: ['VOCALOID', '카가미네 린'], youtubeUrl: '' },
          { id: 'setlink_10', title: '7번째 나', artist: 'mayuko', tags: ['VOCALOID', '카가미네 렌'], youtubeUrl: '' },
          { id: 'setlink_11', title: '8 6', artist: 'Dasu', tags: ['VOCALOID', 'GUMI', '카가미네 렌'], youtubeUrl: '' },
          { id: 'setlink_12', title: '⑨destiny ~영원히 치르노의 턴~', artist: 'Silver Forest', tags: ['J-POP/애니', '동방 프로젝트', '치르노'], youtubeUrl: '' }
        ];
      } else {
        mockData = Array.from({ length: 50 }).map((_, i) => ({
          id: `setlink_${i}`,
          title: `Setlink 테스트 곡 ${i + 1}`,
          artist: i % 2 === 0 ? '아이유' : '요네즈 켄시',
          tags: ['J-POP', '애니송', '발라드'].sort(() => 0.5 - Math.random()).slice(0, 1),
          youtubeUrl: '' // 실제 연동 시 존재할 수 있음
        }));
      }

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
