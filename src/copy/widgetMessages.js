export const WIDGET_LOCALE_STORAGE_KEY = 'rekasong.locale';

export const widgetMessageCatalog = Object.freeze({
  ko: Object.freeze({
    'widget.playback.failed': '재생 실패',
    'widget.playback.skipping': '스킵 중…',
    'widget.playback.discarding': '취소 중…',
    'widget.playback.starting': '재생 시작 중…',
    'widget.playback.buffering': '버퍼링…',
    'widget.playback.paused': '일시정지',
    'widget.albumArt': '앨범 아트',
  }),
  en: Object.freeze({
    'widget.playback.failed': 'Playback failed',
    'widget.playback.skipping': 'Skipping…',
    'widget.playback.discarding': 'Removing…',
    'widget.playback.starting': 'Starting playback…',
    'widget.playback.buffering': 'Buffering…',
    'widget.playback.paused': 'Paused',
    'widget.albumArt': 'Album art',
  }),
});

export function normalizeWidgetLocale(value) {
  return String(value || '').trim().toLowerCase().split('-')[0] === 'en' ? 'en' : 'ko';
}

export function getWidgetMessage(key, locale = 'ko') {
  const normalized = normalizeWidgetLocale(locale);
  return widgetMessageCatalog[normalized]?.[key] ?? widgetMessageCatalog.ko[key] ?? key;
}
