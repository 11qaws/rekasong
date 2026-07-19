const TERMINAL_CONNECTION_STATES = new Set(['disconnected', 'superseded', 'closed']);
const SAFE_IDLE_CONFIRMATION_REASONS = new Set(['not_confirmed', 'output_inactive']);

export const OUTPUT_CONTROL_AUTHORITY_STATES = Object.freeze({
  STARTING: 'starting',
  WRITABLE: 'writable',
  OTHER_OWNER: 'other_owner',
  OWNER_RELEASED: 'owner_released',
  UNAVAILABLE: 'unavailable',
});

function isStrongStoppedPlayback(confirmed) {
  return confirmed?.status === 'stopped'
    && confirmed.paused === true
    && confirmed.sourceDetached === true
    && confirmed.autoplayCancelled === true
    && confirmed.audible === false;
}

export function isSafeOutputControlTakeover(snapshot) {
  if (snapshot?.ready !== true || snapshot?.unknown === true
    || snapshot?.authorityUnknown === true || snapshot?.unknownLock) return false;
  const playerSnapshot = snapshot.playerSnapshot;
  const lease = playerSnapshot?.lease;
  const desired = snapshot.desiredTransport ?? playerSnapshot?.desiredTransport;
  const confirmed = snapshot.confirmedPlayback ?? playerSnapshot?.confirmedPlayback;
  const confirmedSafe = isStrongStoppedPlayback(confirmed)
    || (confirmed?.status === 'unknown'
      && SAFE_IDLE_CONFIRMATION_REASONS.has(confirmed.reasonCode));
  return lease?.status === 'inactive'
    && lease.leaseTarget === null
    && lease.clientKind === null
    && lease.switchId === null
    && snapshot.activeRun === null
    && playerSnapshot?.activeFamily === null
    && playerSnapshot?.activeCheckId === null
    && snapshot.pendingSwitch === null
    && snapshot.pendingTest === null
    && ['idle', 'stopped'].includes(desired?.status)
    && confirmedSafe;
}

export function deriveOutputControlAuthority(snapshot) {
  const connectionState = typeof snapshot?.state === 'string' ? snapshot.state : 'idle';
  if (TERMINAL_CONNECTION_STATES.has(connectionState)) {
    return Object.freeze({
      state: OUTPUT_CONTROL_AUTHORITY_STATES.UNAVAILABLE,
      writable: false,
      otherOwnerConnected: false,
      shouldRetryReleasedOwner: false,
      controlEpoch: null,
    });
  }
  if (snapshot?.ready !== true) {
    return Object.freeze({
      state: OUTPUT_CONTROL_AUTHORITY_STATES.STARTING,
      writable: false,
      otherOwnerConnected: false,
      shouldRetryReleasedOwner: false,
      controlEpoch: null,
    });
  }
  // A cached welcome/snapshot can still look writable after the coordinator
  // has fenced itself on an unknown command outcome or malformed evidence.
  // Unknown authority always wins over cached ownership.
  if (snapshot.authorityUnknown === true || snapshot.unknown === true || snapshot.unknownLock) {
    return Object.freeze({
      state: OUTPUT_CONTROL_AUTHORITY_STATES.UNAVAILABLE,
      writable: false,
      otherOwnerConnected: false,
      shouldRetryReleasedOwner: false,
      controlEpoch: snapshot.playerSnapshot?.controlLease?.controlEpoch ?? null,
    });
  }
  if (snapshot.writable === true) {
    return Object.freeze({
      state: OUTPUT_CONTROL_AUTHORITY_STATES.WRITABLE,
      writable: true,
      otherOwnerConnected: false,
      shouldRetryReleasedOwner: false,
      controlEpoch: snapshot.playerSnapshot?.controlLease?.controlEpoch ?? null,
    });
  }

  const self = snapshot.welcome?.controlInstanceId ?? null;
  const lease = snapshot.playerSnapshot?.controlLease ?? null;
  const owner = lease?.writableControlInstanceId ?? null;
  const controlEpoch = lease?.controlEpoch ?? null;
  const otherOwnerConnected = Boolean(
    owner
    && owner !== self
    && lease?.writableConnected === true,
  );
  if (otherOwnerConnected) {
    return Object.freeze({
      state: OUTPUT_CONTROL_AUTHORITY_STATES.OTHER_OWNER,
      writable: false,
      otherOwnerConnected: true,
      shouldRetryReleasedOwner: false,
      controlEpoch,
    });
  }
  if (!owner && lease?.writableConnected === false) {
    return Object.freeze({
      state: OUTPUT_CONTROL_AUTHORITY_STATES.OWNER_RELEASED,
      writable: false,
      otherOwnerConnected: false,
      shouldRetryReleasedOwner: true,
      controlEpoch,
    });
  }
  return Object.freeze({
    state: OUTPUT_CONTROL_AUTHORITY_STATES.UNAVAILABLE,
    writable: false,
    otherOwnerConnected: false,
    shouldRetryReleasedOwner: false,
    controlEpoch,
  });
}
