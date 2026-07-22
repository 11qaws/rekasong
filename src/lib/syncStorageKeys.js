// Keep storage names in a dependency-free module so production code and
// browser acceptance harnesses exercise the exact same migration boundary.
export const LEGACY_SYNC_STORAGE_KEY = 'karaoke_app_state';
export const SHARED_SYNC_STORAGE_KEY = 'rekasong.shared-state.v1';
export const TAB_SYNC_STORAGE_KEY = 'rekasong.tab-playback-state.v1';
