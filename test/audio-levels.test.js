import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    BAND_RANGES,
    combinedAudioEnvelope,
    combinedBeatEnergy,
    compressAudioEnvelope,
    createBeatDetectorState,
    createVisualBeatState,
    dbToRawLevel,
    denseMixAttenuation,
    effectiveThreshold,
    hasAudibleActivity,
    isSteadyAmbientEnergy,
    mixBandDb,
    resetBeatDetector,
    smoothLevel,
    updateBandKick,
    updateBeatDetector,
    updateNoiseFloor,
    updateVisualBeatPulse,
} from '../lib/audio-levels.js';

function mockMagnitudes(values) {
    return {
        n_values: values.length,
        get_nth(i) {
            return values[i];
        },
    };
}

describe('audio-levels', () => {
    it('mixBandDb blends peak and average energy', () => {
        const magnitudes = mockMagnitudes([-40, -30, -50, -20]);
        const mixed = mixBandDb(magnitudes, 0, 4);
        assert.ok(mixed > -50);
        assert.ok(mixed < -20);
    });

    it('mixBandDb returns null for missing or empty input', () => {
        assert.equal(mixBandDb(null, 0, 4), null);
        assert.equal(mixBandDb(mockMagnitudes([]), 0, 0), null);
        assert.equal(mixBandDb(mockMagnitudes([-40]), 4, 4), null);
    });

    it('dbToRawLevel maps dB to 0-1 with sensitivity', () => {
        const quiet = dbToRawLevel(-70, -76, 1.0);
        const loud = dbToRawLevel(-20, -76, 1.0);
        const boosted = dbToRawLevel(-70, -76, 2.0);
        assert.ok(loud > quiet);
        assert.ok(boosted > quiet);
        assert.equal(dbToRawLevel(-76, -76, 1.0), 0);
    });

    it('smoothLevel applies attack and decay smoothing', () => {
        const rising = smoothLevel(0.2, 0.8, false, 0.5, 0.2, 0.9);
        const falling = smoothLevel(0.8, 0.1, false, 0.5, 0.2, 0.9);
        const silentDecay = smoothLevel(0.8, 0.1, true, 0.5, 0.2, 0.9);
        assert.ok(rising > 0.2);
        assert.ok(falling < 0.8);
        assert.ok(silentDecay < falling);
    });

    it('updateNoiseFloor tracks rising samples slowly', () => {
        const floor = updateNoiseFloor(-76, -60);
        assert.ok(floor > -76);
        assert.ok(floor < -60);
    });

    it('updateNoiseFloor drops immediately when sample is quieter', () => {
        assert.equal(updateNoiseFloor(-60, -80), -80);
    });

    it('effectiveThreshold adapts to measured noise floor', () => {
        assert.equal(effectiveThreshold(-76, -68), -60);
        assert.equal(effectiveThreshold(-76, -90), -76);
    });

    it('hasAudibleActivity requires a band above the activity floor', () => {
        assert.equal(hasAudibleActivity(0.05, 0.07, 0.06), false);
        assert.equal(hasAudibleActivity(0.05, 0.13, 0.06), true);
    });

    it('resetBeatDetector clears pulse and derivative state', () => {
        const state = createBeatDetectorState();
        state.previousEnergy = 0.5;
        state.averageEnergy = 0.4;
        state.energyHistory.push(0.2, 0.22);
        state.beatPulse = 0.8;
        state.cooldown = 0.1;
        resetBeatDetector(state);
        assert.equal(state.previousEnergy, 0);
        assert.equal(state.averageEnergy, 0);
        assert.deepEqual(state.energyHistory, []);
        assert.equal(state.beatPulse, 0);
        assert.equal(state.cooldown, 0);
    });

    it('updateBeatDetector fires on sharp energy rises', () => {
        const state = createBeatDetectorState();
        updateBeatDetector(state, 0.05, 0.016);
        updateBeatDetector(state, 0.2, 0.016);
        const pulse = updateBeatDetector(state, 0.65, 0.016);
        assert.ok(pulse > 0.5);
    });

    it('updateBeatDetector ignores steady low ambient energy', () => {
        const state = createBeatDetectorState();
        const dt = 0.016;
        let pulse = 0;

        for (let i = 0; i < 240; i++) {
            const phase = (i / 240) * Math.PI * 2;
            const energy = 0.19 + Math.sin(phase) * 0.03;
            pulse = updateBeatDetector(state, energy, dt);
        }

        assert.equal(pulse, 0);
        assert.ok(isSteadyAmbientEnergy(state.energyHistory));
    });

    it('updateBeatDetector keeps responding to isolated transients after ambient', () => {
        const state = createBeatDetectorState();
        const dt = 0.016;

        for (let i = 0; i < 120; i++)
            updateBeatDetector(state, 0.2 + Math.sin(i * 0.08) * 0.02, dt);

        updateBeatDetector(state, 0.24, dt);
        const pulse = updateBeatDetector(state, 0.62, dt);
        assert.ok(pulse > 0.5);
    });

    it('updateBeatDetector keeps responding when instruments raise the bass bed', () => {
        const state = createBeatDetectorState();
        const kickState = {average: 0};
        const dt = 0.016;
        let beats = 0;

        for (let i = 0; i < 32 * 30; i++) {
            const onBeat = i % 30 === 0;
            const bass = onBeat ? 0.85 : 0.55;
            const energy = combinedBeatEnergy(bass, 0.72, 0.65);
            const kickLevel = updateBandKick(kickState, energy);
            const pulse = updateBeatDetector(state, energy, dt, {kickLevel});
            if (pulse >= 0.9)
                beats++;
        }

        assert.ok(beats >= 8, `expected beats with instruments, got ${beats}`);
    });

    it('combinedBeatEnergy tracks gated bass and ignores mid/treble beds', () => {
        const bassOnly = combinedBeatEnergy(0.9, 0, 0);
        const bassWithBed = combinedBeatEnergy(0.9, 0.85, 0.8);
        const midOnly = combinedBeatEnergy(0.05, 0.9, 0.85);
        assert.ok(bassOnly > 0.85);
        assert.equal(bassOnly, bassWithBed);
        assert.ok(midOnly < 0.1);
    });

    it('combinedAudioEnvelope peaks on beat pulses and bass hits', () => {
        const quiet = combinedAudioEnvelope(0.05, 0.05, 0.05, 0);
        const bassHit = combinedAudioEnvelope(0.9, 0.2, 0.1, 0);
        const beatHit = combinedAudioEnvelope(0.3, 0.3, 0.2, 1);
        assert.ok(bassHit > quiet);
        assert.ok(beatHit > bassHit);
    });

    it('compressAudioEnvelope softens saturated combined levels', () => {
        const saturated = combinedAudioEnvelope(0.9, 0.85, 0.75, 0.2);
        const compressed = compressAudioEnvelope(saturated);
        assert.ok(saturated > 0.85);
        assert.ok(compressed < saturated);
        assert.ok(compressed > 0.5);
    });

    it('denseMixAttenuation reduces response for full-band mixes', () => {
        const sparse = denseMixAttenuation(0.8, 0.1, 0.05);
        const dense = denseMixAttenuation(0.85, 0.8, 0.75);
        assert.equal(sparse, 1.0);
        assert.ok(dense < 0.85);
        assert.ok(dense > 0.55);
    });

    it('updateVisualBeatPulse holds beat energy longer for rendering', () => {
        const state = createVisualBeatState();
        updateVisualBeatPulse(state, 1.0, 0.016);
        updateVisualBeatPulse(state, 0, 0.016);
        assert.ok(state.pulse > 0.85);
        for (let i = 0; i < 10; i++)
            updateVisualBeatPulse(state, 0, 0.016);
        assert.ok(state.pulse > 0.2);
    });

    it('updateVisualBeatPulse follows kick transients when beat detector is idle', () => {
        const state = createVisualBeatState();
        const kickState = {average: 0};
        let pulse = 0;

        for (let i = 0; i < 20; i++)
            updateBandKick(kickState, 0.55);
        pulse = updateVisualBeatPulse(state, 0, 0.016, {
            kickLevel: updateBandKick(kickState, 0.85),
        });
        assert.ok(pulse > 0.25, `kick pulse too weak: ${pulse}`);

        for (let i = 0; i < 5; i++)
            pulse = updateVisualBeatPulse(state, 0, 0.016, {kickLevel: 0});
        assert.ok(pulse > 0.04, `kick pulse decayed too fast: ${pulse}`);
    });

    it('updateBandKick tracks transients above a moving average', () => {
        const state = {average: 0};
        let kick = 0;
        for (let i = 0; i < 30; i++)
            kick = updateBandKick(state, 0.8);
        assert.ok(kick < 0.05);

        const spike = updateBandKick(state, 0.95);
        assert.ok(spike > 0.05);
    });

    it('band ranges cover all 16 spectrum bins', () => {
        assert.deepEqual(BAND_RANGES.bass, [0, 4]);
        assert.deepEqual(BAND_RANGES.mid, [4, 8]);
        assert.deepEqual(BAND_RANGES.treble, [8, 16]);
    });
});
