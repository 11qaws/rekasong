export const OUTPUT_VOLUME_PROFILES_STORAGE_KEY = 'rekasong.output-volume-profiles.v1';
export const LEGACY_OUTPUT_VOLUME_STORAGE_KEY = 'rekasong_volume';
export const DEFAULT_OUTPUT_VOLUME = 100;

const OUTPUT_MODES = new Set(['speaker', 'obs']);

export function clampOutputVolume(value, fallback = DEFAULT_OUTPUT_VOLUME) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(100, numeric));
}

export function createOutputVolumeProfiles(candidate = null, fallback = DEFAULT_OUTPUT_VOLUME) {
  const safeFallback = clampOutputVolume(fallback, DEFAULT_OUTPUT_VOLUME);
  const source = candidate && typeof candidate === 'object' && !Array.isArray(candidate)
    ? candidate
    : {};
  return Object.freeze({
    version: 1,
    speaker: clampOutputVolume(source.speaker, safeFallback),
    obs: clampOutputVolume(source.obs, safeFallback),
  });
}

export function loadOutputVolumeProfiles(storage) {
  if (!storage || typeof storage.getItem !== 'function') return createOutputVolumeProfiles();
  try {
    const stored = storage.getItem(OUTPUT_VOLUME_PROFILES_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (parsed?.version === 1) return createOutputVolumeProfiles(parsed);
    }
  } catch {
    // A damaged profile is equivalent to no profile. Legacy migration below
    // remains available and playback must never depend on storage health.
  }

  try {
    const legacy = storage.getItem(LEGACY_OUTPUT_VOLUME_STORAGE_KEY);
    if (legacy !== null) {
      const migrated = clampOutputVolume(legacy, DEFAULT_OUTPUT_VOLUME);
      return createOutputVolumeProfiles({ speaker: migrated, obs: migrated });
    }
  } catch {
    // Storage access may be blocked. Use the ordinary full-volume default.
  }
  return createOutputVolumeProfiles();
}

export function saveOutputVolumeProfiles(storage, profiles) {
  if (!storage || typeof storage.setItem !== 'function') return false;
  const normalized = createOutputVolumeProfiles(profiles);
  try {
    storage.setItem(OUTPUT_VOLUME_PROFILES_STORAGE_KEY, JSON.stringify(normalized));
    return true;
  } catch {
    return false;
  }
}

export function updateOutputVolumeProfile(profiles, mode, volume) {
  if (!OUTPUT_MODES.has(mode)) return createOutputVolumeProfiles(profiles);
  const normalized = createOutputVolumeProfiles(profiles);
  return createOutputVolumeProfiles({
    ...normalized,
    [mode]: clampOutputVolume(volume, normalized[mode]),
  });
}

export function outputVolumeForMode(profiles, mode) {
  const normalized = createOutputVolumeProfiles(profiles);
  return mode === 'obs' ? normalized.obs : normalized.speaker;
}
