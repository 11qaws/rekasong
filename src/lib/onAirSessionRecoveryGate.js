/**
 * Page-lifetime gate for automatic On-Air session recovery.
 *
 * React StrictMode, effect re-runs, and Dashboard remounts may all attempt the
 * same recovery. Keeping the claim outside React makes that work fail closed:
 * exactly one caller can start an automatic credential rotation until the page
 * is reloaded. There is intentionally no reset API.
 */
let claimed = false;

export const onAirSessionRecoveryGate = Object.freeze({
  claim() {
    if (claimed) return false;
    claimed = true;
    return true;
  },
});
