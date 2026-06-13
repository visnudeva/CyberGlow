import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    combinedBeatEnergy,
    compressAudioEnvelope,
    createBeatDetectorState,
    createVisualBeatState,
    denseMixAttenuation,
    updateBandKick,
    updateBeatDetector,
    updateVisualBeatPulse,
} from '../lib/audio-levels.js';
import {clamp, lerp} from '../lib/utils.js';

const DT = 0.016;
const NEON_AUDIO_SCALE_MAX = 0.16;
const NEON_AUDIO_BEAT_SCALE_MAX = 0.2;
const NEON_AUDIO_BASS_GATE = 0.06;
const NEON_AUDIO_SCALE_DECAY_SMOOTH = 0.62;
const NEON_AUDIO_ATTACK_SMOOTH = 0.92;
const NEON_AUDIO_DECAY_SMOOTH = 0.68;
const NEON_AUDIO_BEAT_ATTACK_SMOOTH = 0.96;
const NEON_AUDIO_BEAT_RELEASE_SMOOTH = 0.14;
const NEON_AUDIO_BEAT_COLOR_MAX = 0.52;

function gatedBass(bass) {
    return clamp((bass - NEON_AUDIO_BASS_GATE) / (1 - NEON_AUDIO_BASS_GATE), 0, 1);
}

function audioReactSmooth(current, target) {
    return target > current ? NEON_AUDIO_ATTACK_SMOOTH : NEON_AUDIO_DECAY_SMOOTH;
}

function kickWithInstrumentsPattern(beats = 32) {
    const frames = [];
    for (let i = 0; i < beats * 30; i++) {
        const onBeat = i % 30 === 0;
        frames.push({
            bass: onBeat ? 0.85 : 0.55,
            mid: 0.72,
            treble: 0.65,
        });
    }
    return frames;
}

function simulateAudioReact(frames) {
    const beatState = createBeatDetectorState();
    const visualBeatState = createVisualBeatState();
    const bassKickState = {average: 0};
    let audioScale = 1.0;
    let beatColorBoost = 0;
    let beatCount = 0;
    let peakScale = 1.0;
    let minScaleDuringSilence = 1.0;

    for (const {bass, mid, treble} of frames) {
        const gated = gatedBass(bass);
        const energy = combinedBeatEnergy(bass, mid, treble);
        const kick = updateBandKick(bassKickState, gated);
        const beat = updateBeatDetector(beatState, energy, DT, {kickLevel: kick});
        if (beat >= 0.9)
            beatCount++;
        const visualBeat = updateVisualBeatPulse(visualBeatState, beat, DT, {kickLevel: kick});

        const density = denseMixAttenuation(gated, mid, treble);
        compressAudioEnvelope(
            clamp(gated * 0.52 + mid * 0.28 + treble * 0.1 + visualBeat * 0.62, 0, 1)
        );

        const targetScale = 1.0
            + kick * NEON_AUDIO_SCALE_MAX * density
            + visualBeat * NEON_AUDIO_BEAT_SCALE_MAX;
        let scaleSmooth = visualBeat >= 0.25 && targetScale > audioScale
            ? NEON_AUDIO_BEAT_ATTACK_SMOOTH
            : audioReactSmooth(audioScale, targetScale);
        if (visualBeat < 0.1 && audioScale > 1.01)
            scaleSmooth = Math.min(scaleSmooth, NEON_AUDIO_SCALE_DECAY_SMOOTH);
        audioScale = lerp(audioScale, targetScale, scaleSmooth);

        const targetBeatColor = visualBeat * NEON_AUDIO_BEAT_COLOR_MAX;
        beatColorBoost = lerp(
            beatColorBoost,
            targetBeatColor,
            targetBeatColor > beatColorBoost
                ? NEON_AUDIO_BEAT_ATTACK_SMOOTH
                : NEON_AUDIO_BEAT_RELEASE_SMOOTH
        );

        peakScale = Math.max(peakScale, audioScale);
        if (bass < 0.15 && mid < 0.15 && visualBeat < 0.1)
            minScaleDuringSilence = Math.min(minScaleDuringSilence, audioScale);
    }

    return {
        peakScale,
        minScaleDuringSilence,
        finalScale: audioScale,
        beatCount,
        beatColorBoost,
    };
}

function kickDrumPattern(beats = 32) {
    const frames = [];
    for (let i = 0; i < beats * 30; i++) {
        const onBeat = i % 30 === 0;
        frames.push({
            bass: onBeat ? 0.85 : 0.12 + Math.random() * 0.04,
            mid: onBeat ? 0.35 : 0.18 + Math.random() * 0.05,
            treble: 0.1 + Math.random() * 0.08,
        });
    }
    return frames;
}

function denseOrchestralPattern(samples = 480) {
    const frames = [];
    for (let i = 0; i < samples; i++) {
        const wobble = Math.sin(i * 0.05) * 0.06;
        frames.push({
            bass: 0.72 + wobble,
            mid: 0.78 + wobble * 0.8,
            treble: 0.68 + wobble * 0.5,
        });
    }
    return frames;
}

function edmBuildPattern(samples = 480) {
    const frames = [];
    for (let i = 0; i < samples; i++) {
        const beat = i % 22 === 0;
        const build = i / samples;
        frames.push({
            bass: beat ? 0.9 : 0.2 + build * 0.35,
            mid: 0.25 + build * 0.45 + (beat ? 0.2 : 0),
            treble: 0.15 + build * 0.3 + (beat ? 0.15 : 0),
        });
    }
    return frames;
}

describe('audio-reaction simulation', () => {
    it('kick drums produce visible scale pulses and recover between hits', () => {
        const result = simulateAudioReact(kickDrumPattern());
        assert.ok(result.beatCount >= 8, `expected beats, got ${result.beatCount}`);
        assert.ok(result.peakScale >= 1.12, `peak scale too weak: ${result.peakScale}`);
        assert.ok(result.minScaleDuringSilence <= 1.05, `scale stuck: ${result.minScaleDuringSilence}`);
    });

    it('kick drums stay visible when other instruments are playing', () => {
        const result = simulateAudioReact(kickWithInstrumentsPattern());
        assert.ok(result.beatCount >= 8, `expected beats with instruments, got ${result.beatCount}`);
        assert.ok(result.peakScale >= 1.12, `peak scale too weak with instruments: ${result.peakScale}`);
        assert.ok(result.beatColorBoost >= 0.02, `beat color too weak with instruments: ${result.beatColorBoost}`);
    });

    it('dense orchestral mix does not pin scale near maximum', () => {
        const result = simulateAudioReact(denseOrchestralPattern());
        assert.ok(result.finalScale <= 1.08, `dense mix stuck zoomed: ${result.finalScale}`);
        assert.ok(result.peakScale <= 1.21, `dense mix peak too high: ${result.peakScale}`);
    });

    it('edm build keeps beat response while levels rise', () => {
        const result = simulateAudioReact(edmBuildPattern());
        assert.ok(result.beatCount >= 10, `edm beats missed: ${result.beatCount}`);
        assert.ok(result.peakScale >= 1.14, `edm peak too weak: ${result.peakScale}`);
        assert.ok(result.beatColorBoost >= 0.12, `beat color too weak: ${result.beatColorBoost}`);
    });
});
