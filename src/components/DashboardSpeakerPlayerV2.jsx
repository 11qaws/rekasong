import React from 'react';

import { PLAYER_CLIENT_KINDS } from '../lib/onAirProtocol';
import OnAirPlayerV2 from './OnAirPlayerV2';

/**
 * Protocol v2 player owned by the dashboard's local speaker output.
 * The wrapper fixes the client identity so callers cannot accidentally mount
 * a generic or OBS-classified player on the speaker route.
 */
export default function DashboardSpeakerPlayerV2(props) {
  return (
    <OnAirPlayerV2
      {...props}
      clientKind={PLAYER_CLIENT_KINDS.DASHBOARD_SPEAKER}
    />
  );
}
