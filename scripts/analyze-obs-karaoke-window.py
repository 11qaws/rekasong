#!/usr/bin/env python3
"""Measure mic-to-backing-track offset drift from an OBS split-track recording.

The analyzer decodes the direct MR and microphone tracks through ffmpeg, builds
440/880 Hz amplitude envelopes at 1 ms resolution, and correlates each ten
second marker cycle. A product window includes markers at both its start and
end (0..300 seconds is therefore 31 markers, not 30). It reports the original
long-run evidence separately from the bounded per-song window and never changes
OBS or app state.
"""

from __future__ import annotations

import argparse
import json
import math
import subprocess
from pathlib import Path

import numpy as np


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("recording", type=Path)
    parser.add_argument("--ffmpeg", default="ffmpeg")
    parser.add_argument("--mr-map", default="0:a:1")
    parser.add_argument("--mic-map", default="0:a:2")
    parser.add_argument("--sample-rate", type=int, default=8_000)
    parser.add_argument("--cycle-seconds", type=float, default=10.0)
    parser.add_argument("--expected-cycles", type=int, default=60)
    parser.add_argument("--song-window-seconds", type=float, default=300.0)
    parser.add_argument("--observation-seconds", type=float, default=30.0)
    parser.add_argument("--maximum-lag-ms", type=int, default=200)
    return parser.parse_args()


def decode_track(ffmpeg: str, recording: Path, stream_map: str, sample_rate: int) -> np.ndarray:
    command = [
        ffmpeg,
        "-v",
        "error",
        "-i",
        str(recording),
        "-map",
        stream_map,
        "-vn",
        "-ac",
        "1",
        "-ar",
        str(sample_rate),
        "-f",
        "f32le",
        "pipe:1",
    ]
    completed = subprocess.run(command, check=True, stdout=subprocess.PIPE)
    signal = np.frombuffer(completed.stdout, dtype="<f4")
    if signal.size == 0:
        raise RuntimeError(f"ffmpeg decoded no samples for {stream_map}")
    return signal


def tone_envelope(signal: np.ndarray, sample_rate: int, frequency_hz: float) -> np.ndarray:
    """Return a quadrature amplitude envelope sampled at exactly 1 kHz."""
    hop = sample_rate // 1_000
    if hop <= 0 or sample_rate % 1_000 != 0:
        raise ValueError("sample rate must be a positive multiple of 1000")
    window = max(hop, round(sample_rate * 0.020))
    starts = np.arange(0, signal.size - window + 1, hop, dtype=np.int64)
    sample_index = np.arange(signal.size, dtype=np.float32)
    phase = np.float32(2.0 * math.pi * frequency_hz / sample_rate) * sample_index

    cosine_mix = signal * np.cos(phase).astype(np.float32, copy=False)
    cosine_sum = np.concatenate((np.zeros(1), np.cumsum(cosine_mix, dtype=np.float64)))
    in_phase = (cosine_sum[starts + window] - cosine_sum[starts]) / window
    del cosine_mix, cosine_sum

    sine_mix = signal * np.sin(phase).astype(np.float32, copy=False)
    sine_sum = np.concatenate((np.zeros(1), np.cumsum(sine_mix, dtype=np.float64)))
    quadrature = (sine_sum[starts + window] - sine_sum[starts]) / window
    del sample_index, phase, sine_mix, sine_sum

    return (2.0 * np.hypot(in_phase, quadrature)).astype(np.float32)


def contiguous_regions(mask: np.ndarray, merge_gap_ms: int = 80) -> list[tuple[int, int]]:
    padded = np.concatenate(([False], mask, [False]))
    transitions = np.diff(padded.astype(np.int8))
    starts = np.flatnonzero(transitions == 1)
    ends = np.flatnonzero(transitions == -1)
    regions: list[list[int]] = []
    for start, end in zip(starts, ends, strict=True):
        if regions and start - regions[-1][1] <= merge_gap_ms:
            regions[-1][1] = int(end)
        else:
            regions.append([int(start), int(end)])
    return [(start, end) for start, end in regions]


def marker_regions(envelope_440: np.ndarray, expected_cycles: int, cycle_ms: int) -> list[tuple[int, int]]:
    baseline = float(np.percentile(envelope_440, 50.0))
    active_level = float(np.percentile(envelope_440, 98.0))
    if active_level <= baseline:
        raise RuntimeError("MR 440 Hz marker energy was not distinguishable from the baseline")
    threshold = baseline + 0.42 * (active_level - baseline)
    candidates = [
        region
        for region in contiguous_regions(envelope_440 >= threshold)
        if 220 <= region[1] - region[0] <= 700
    ]
    if len(candidates) < expected_cycles:
        raise RuntimeError(
            f"found only {len(candidates)} plausible 440 Hz markers; expected {expected_cycles}"
        )

    # Select the contiguous periodic run with the lowest interval error. This
    # discards recording setup sounds without assuming a fixed recording start.
    best: tuple[float, list[tuple[int, int]]] | None = None
    for start_index in range(0, len(candidates) - expected_cycles + 1):
        run = candidates[start_index : start_index + expected_cycles]
        centers = np.asarray([(start + end) / 2.0 for start, end in run])
        intervals = np.diff(centers)
        interval_error = float(np.median(np.abs(intervals - cycle_ms)))
        span_error = abs(float(centers[-1] - centers[0]) - cycle_ms * (expected_cycles - 1))
        score = interval_error + span_error / max(1, expected_cycles - 1)
        if best is None or score < best[0]:
            best = (score, run)
    assert best is not None
    run = best[1]
    centers = np.asarray([(start + end) / 2.0 for start, end in run])
    maximum_interval_error = float(np.max(np.abs(np.diff(centers) - cycle_ms)))
    if maximum_interval_error > 120:
        raise RuntimeError(
            f"marker run is not periodic enough; maximum interval error was {maximum_interval_error:.1f} ms"
        )
    return run


def normalized_envelope(envelope: np.ndarray) -> np.ndarray:
    baseline = float(np.percentile(envelope, 50.0))
    scale = float(np.percentile(envelope, 99.0)) - baseline
    if scale <= 0:
        raise RuntimeError("tone envelope has no usable dynamic range")
    return np.clip((envelope - baseline) / scale, 0.0, 3.0).astype(np.float32)


def correlation_at_lag(reference: np.ndarray, candidate: np.ndarray) -> float:
    reference_centered = reference - float(np.mean(reference))
    candidate_centered = candidate - float(np.mean(candidate))
    denominator = float(np.linalg.norm(reference_centered) * np.linalg.norm(candidate_centered))
    if denominator <= 0:
        return -1.0
    return float(np.dot(reference_centered, candidate_centered) / denominator)


def cycle_delay(
    mr_envelope: np.ndarray,
    mic_envelope: np.ndarray,
    marker_region: tuple[int, int],
    maximum_lag_ms: int,
) -> tuple[float, float]:
    marker_start, _marker_end = marker_region
    # Include all three 880 Hz pulses and the 440 Hz long tone, plus enough
    # silence on both sides to make the envelope correlation unambiguous.
    start = marker_start - 600
    end = marker_start + 650
    if start < maximum_lag_ms or end + maximum_lag_ms >= mic_envelope.size:
        raise RuntimeError("marker window leaves the decoded recording bounds")
    reference = mr_envelope[start:end]
    lags = np.arange(-maximum_lag_ms, maximum_lag_ms + 1, dtype=np.int32)
    correlations = np.asarray(
        [correlation_at_lag(reference, mic_envelope[start + lag : end + lag]) for lag in lags],
        dtype=np.float64,
    )
    best_index = int(np.argmax(correlations))
    fractional = 0.0
    if 0 < best_index < correlations.size - 1:
        left, middle, right = correlations[best_index - 1 : best_index + 2]
        curvature = left - 2.0 * middle + right
        if abs(curvature) > 1e-12:
            fractional = float(np.clip(0.5 * (left - right) / curvature, -0.5, 0.5))
    return float(lags[best_index]) + fractional, float(correlations[best_index])


def median_edge_drift(delays: np.ndarray, start: int, count: int, edge_cycles: int = 5) -> float:
    window = delays[start : start + count]
    return float(np.median(window[-edge_cycles:]) - np.median(window[:edge_cycles]))


def linear_drift(delays: np.ndarray, cycle_seconds: float) -> tuple[float, float]:
    elapsed_seconds = np.arange(delays.size, dtype=np.float64) * cycle_seconds
    slope_ms_per_second, intercept_ms = np.polyfit(elapsed_seconds, delays, 1)
    span_seconds = float(elapsed_seconds[-1] - elapsed_seconds[0])
    return float(slope_ms_per_second * span_seconds), float(intercept_ms)


def window_linear_drift(
    delays: np.ndarray,
    start: int,
    count: int,
    cycle_seconds: float,
    target_seconds: float,
) -> float:
    window = delays[start : start + count]
    elapsed_seconds = np.arange(window.size, dtype=np.float64) * cycle_seconds
    slope_ms_per_second = np.polyfit(elapsed_seconds, window, 1)[0]
    return float(slope_ms_per_second * target_seconds)


def main() -> None:
    args = parse_args()
    if not args.recording.is_file():
        raise FileNotFoundError(args.recording)
    if args.expected_cycles < 7:
        raise ValueError("expected-cycles must be at least 7")
    if not math.isfinite(args.cycle_seconds) or args.cycle_seconds <= 0:
        raise ValueError("cycle-seconds must be positive and finite")
    if not math.isfinite(args.song_window_seconds) or args.song_window_seconds <= 0:
        raise ValueError("song-window-seconds must be positive and finite")
    if not math.isfinite(args.observation_seconds) or args.observation_seconds <= 0:
        raise ValueError("observation-seconds must be positive and finite")
    if args.maximum_lag_ms < 0:
        raise ValueError("maximum-lag-ms must be non-negative")
    cycle_ms = round(args.cycle_seconds * 1_000)
    song_intervals = args.song_window_seconds / args.cycle_seconds
    rounded_song_intervals = round(song_intervals)
    if not math.isclose(song_intervals, rounded_song_intervals, abs_tol=1e-9):
        raise ValueError("song window must be an exact multiple of the marker cycle")
    # Both endpoints belong to the measured window. For a 300 second window
    # sampled every 10 seconds this is 30 intervals and 31 marker cycles.
    song_cycle_count = rounded_song_intervals + 1
    if song_cycle_count < 7 or song_cycle_count > args.expected_cycles:
        raise ValueError("song window must contain 7..expected-cycles endpoint-inclusive markers")
    observation_intervals = args.observation_seconds / args.cycle_seconds
    rounded_observation_intervals = round(observation_intervals)
    if rounded_observation_intervals < 1 or not math.isclose(
        observation_intervals,
        rounded_observation_intervals,
        abs_tol=1e-9,
    ):
        raise ValueError("observation cadence must be a positive exact multiple of the marker cycle")
    if rounded_observation_intervals >= args.expected_cycles:
        raise ValueError("observation cadence must leave at least one marker pair")

    mr_signal = decode_track(args.ffmpeg, args.recording, args.mr_map, args.sample_rate)
    mic_signal = decode_track(args.ffmpeg, args.recording, args.mic_map, args.sample_rate)
    usable_samples = min(mr_signal.size, mic_signal.size)
    mr_signal = mr_signal[:usable_samples]
    mic_signal = mic_signal[:usable_samples]

    mr_440 = tone_envelope(mr_signal, args.sample_rate, 440.0)
    mr_880 = tone_envelope(mr_signal, args.sample_rate, 880.0)
    mic_440 = tone_envelope(mic_signal, args.sample_rate, 440.0)
    mic_880 = tone_envelope(mic_signal, args.sample_rate, 880.0)
    del mr_signal, mic_signal

    regions = marker_regions(mr_440, args.expected_cycles, cycle_ms)
    mr_combined = normalized_envelope(mr_440) + normalized_envelope(mr_880)
    mic_combined = normalized_envelope(mic_440) + normalized_envelope(mic_880)
    delays_and_correlations = [
        cycle_delay(mr_combined, mic_combined, region, args.maximum_lag_ms)
        for region in regions
    ]
    delays = np.asarray([item[0] for item in delays_and_correlations], dtype=np.float64)
    correlations = np.asarray([item[1] for item in delays_and_correlations], dtype=np.float64)

    long_drift, intercept = linear_drift(delays, args.cycle_seconds)
    rolling_drifts = np.asarray(
        [
            median_edge_drift(delays, start, song_cycle_count)
            for start in range(0, delays.size - song_cycle_count + 1)
        ],
        dtype=np.float64,
    )
    rolling_linear_fit_drifts = np.asarray(
        [
            window_linear_drift(
                delays,
                start,
                song_cycle_count,
                args.cycle_seconds,
                args.song_window_seconds,
            )
            for start in range(0, delays.size - song_cycle_count + 1)
        ],
        dtype=np.float64,
    )
    first_song_drift = median_edge_drift(delays, 0, song_cycle_count)
    last_song_drift = median_edge_drift(delays, delays.size - song_cycle_count, song_cycle_count)
    worst_edge_drift = float(np.max(np.abs(rolling_drifts)))
    worst_linear_fit_drift = float(np.max(np.abs(rolling_linear_fit_drifts)))
    edge_statistic_pass = worst_edge_drift <= 10.0
    linear_fit_pass = worst_linear_fit_drift <= 10.0
    observation_deltas = delays[rounded_observation_intervals:] - delays[:-rounded_observation_intervals]
    elapsed_seconds = np.arange(delays.size, dtype=np.float64) * args.cycle_seconds
    slope_ms_per_second = np.polyfit(elapsed_seconds, delays, 1)[0]
    detrended = delays - (intercept + slope_ms_per_second * elapsed_seconds)

    report = {
        "recording": str(args.recording.resolve()),
        "streams": {"mr": args.mr_map, "mic": args.mic_map},
        "analysis": {
            "decodeSampleRateHz": args.sample_rate,
            "envelopeResolutionMs": 1,
            "cycleSeconds": args.cycle_seconds,
            "cyclesDetected": int(delays.size),
            "minimumCorrelation": round(float(np.min(correlations)), 6),
            "medianCorrelation": round(float(np.median(correlations)), 6),
        },
        "longStressRun": {
            "spanSeconds": round((delays.size - 1) * args.cycle_seconds, 3),
            "firstFiveToLastFiveMedianDriftMs": round(
                median_edge_drift(delays, 0, delays.size), 3
            ),
            "linearDriftMs": round(long_drift, 3),
            "linearRateMsPerMinute": round(float(slope_ms_per_second * 60.0), 4),
            "medianOffsetMs": round(float(np.median(delays)), 3),
            "detrendedJitterP95Ms": round(float(np.percentile(np.abs(detrended), 95)), 3),
        },
        "perSongWindow": {
            "targetSeconds": args.song_window_seconds,
            "markerCycles": song_cycle_count,
            "markerIntervals": rounded_song_intervals,
            "measuredMarkerSpanSeconds": round((song_cycle_count - 1) * args.cycle_seconds, 3),
            "endpointCovered": True,
            "unmeasuredTailSeconds": 0.0,
            "firstWindowDriftMs": round(first_song_drift, 3),
            "lastWindowDriftMs": round(last_song_drift, 3),
            "worstAbsoluteRollingDriftMs": round(worst_edge_drift, 3),
            "firstWindowLinearFitDriftMs": round(float(rolling_linear_fit_drifts[0]), 3),
            "lastWindowLinearFitDriftMs": round(float(rolling_linear_fit_drifts[-1]), 3),
            "worstAbsoluteLinearFitDriftMs": round(worst_linear_fit_drift, 3),
            "rollingWindowCount": int(rolling_drifts.size),
            "driftLimitMs": 10.0,
            "edgeStatisticPass": edge_statistic_pass,
            "linearFitPass": linear_fit_pass,
            "driftPass": bool(edge_statistic_pass and linear_fit_pass),
            "decision": "passed" if edge_statistic_pass and linear_fit_pass else "retest_required",
            "fixedOffsetLimitMs": 20.0,
            "fixedOffsetPass": bool(abs(float(np.median(delays))) <= 20.0),
        },
        "periodicObservation": {
            "cadenceSeconds": args.observation_seconds,
            "samplePairCount": int(observation_deltas.size),
            "medianAbsoluteChangeMs": round(float(np.median(np.abs(observation_deltas))), 3),
            "p95AbsoluteChangeMs": round(float(np.percentile(np.abs(observation_deltas), 95)), 3),
            "worstAbsoluteChangeMs": round(float(np.max(np.abs(observation_deltas))), 3),
            "policy": "observe_only_no_seek_restart_or_rate_change",
        },
        "cycleOffsetsMs": [round(float(value), 3) for value in delays],
    }
    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
