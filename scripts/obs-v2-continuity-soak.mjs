process.env.REKASONG_CONTINUITY_DURATION_MS ||= '600000';
process.env.REKASONG_CONTINUITY_GAP_MS ||= '590000';
process.env.REKASONG_CONTINUITY_DRIFT_LIMIT_MS ||= '1500';

if (!process.argv.includes('--continuity')) process.argv.push('--continuity');

await import('./obs-v2-smoke.mjs');
