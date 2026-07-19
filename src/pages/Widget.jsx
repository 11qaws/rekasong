import { lazy, Suspense } from 'react';

const DisplayWidget = lazy(() => import('./DisplayWidget'));
const OnAirPlayer = lazy(async () => {
  const [, playerModule] = await Promise.all([
    import('./Widget.css'),
    import('../components/OnAirPlayer'),
  ]);
  return playerModule;
});
const OnAirPlayerV2 = lazy(() => import('../components/OnAirPlayerV2'));

export default function Widget() {
  // URL에서 파라미터 추출 (HashRouter 환경 대비). 기존 OBS URL과의 호환을
  // 위해 query 우선순위와 room/key/type 정규식 fallback을 그대로 유지한다.
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
  const protocol = searchParams.get('protocol') || hashParams.get('protocol') || '';

  if (mode === 'player') {
    if (protocol === '2') {
      return (
        <Suspense fallback={<div data-on-air-player-v2-state="loading" aria-hidden="true" />}>
          <OnAirPlayerV2 apiBaseUrl={apiBaseUrl} room={session} token={token} />
        </Suspense>
      );
    }

    return (
      <Suspense fallback={null}>
        <OnAirPlayer apiBaseUrl={apiBaseUrl} room={session} token={token} />
      </Suspense>
    );
  }

  return (
    <Suspense fallback={null}>
      <DisplayWidget
        room={room}
        publicKeyB64={publicKeyB64}
        type={type}
        mode={mode}
        session={session}
        token={token}
        apiBaseUrl={apiBaseUrl}
      />
    </Suspense>
  );
}
