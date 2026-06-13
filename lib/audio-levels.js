import {clamp} from './utils.js';

export const SPECTRUM_BANDS = 16;
export const BAND_RANGES = {
    bass: [0, 4],
    mid: [4, 8],
    treble: [8, 16],
};

export const BEAT_DECAY_PER_SEC = 7.0;
export const BEAT_MIN_ENERGY = 0.16;
export const BEAT_SPIKE_RATIO = 1.16;
export const BEAT_KICK_THRESHOLD = 0.11;
export const BEAT_MIN_DELTA = 0.07;
export const BEAT_INSTANT_DELTA = 0.045;
export const BEAT_EMA_RISE = 0.16;
export const BEAT_EMA_FALL = 0.04;
export const BEAT_COOLDOWN_SEC = 0.12;
export const BEAT_ACTIVITY_MIN = 0.08;
export const BEAT_STEADY_VARIANCE_MAX = 0.0022;
export const BEAT_STEADY_ENERGY_MAX = 0.48;
export const BEAT_HISTORY_SIZE = 10;
export const NOISE_FLOOR_MARGIN_DB = 8;
export const VISUAL_BEAT_DECAY_PER_SEC = 3.8;
export const VISUAL_KICK_GAIN = 2.6;

export function mixBandDb(magnitudes, start, count) {
    if (!magnitudes || count <= 0)
        return null;

    let sum = 0;
    let peak = magnitudes.get_nth(start);
    for (let i = 0; i < count; i++) {
        const idx = start + i;
        if (idx >= magnitudes.n_values)
            break;
        const db = magnitudes.get_nth(idx);
        sum += db;
        if (db > peak)
            peak = db;
    }

    const used = Math.min(count, magnitudes.n_values - start);
    if (used <= 0)
        return null;

    const avgDb = sum / used;
    return peak * 0.45 + avgDb * 0.55;
}

export function dbToRawLevel(mixedDb, thresholdDb, sensitivity = 1.0) {
    const raw = clamp(
        (mixedDb - thresholdDb) / -thresholdDb,
        0,
        1
    );
    return clamp(Math.pow(raw * clamp(sensitivity, 0.25, 3.0), 0.88), 0, 1);
}

export function smoothLevel(current, target, silent, attack, decay, silenceDecay) {
    const smooth = target > current
        ? attack
        : (silent ? silenceDecay : decay);
    return clamp(current + (target - current) * smooth, 0, 1);
}

export function updateNoiseFloor(floorDb, sampleDb, alpha = 0.04) {
    if (sampleDb >= floorDb)
        return floorDb + (sampleDb - floorDb) * alpha;
    return sampleDb;
}

export function effectiveThreshold(baseThresholdDb, noiseFloorDb, marginDb = NOISE_FLOOR_MARGIN_DB) {
    return Math.max(baseThresholdDb, noiseFloorDb + marginDb);
}

export function createBeatDetectorState() {
    return {
        previousEnergy: 0,
        averageEnergy: 0,
        energyHistory: [],
        beatPulse: 0,
        cooldown: 0,
    };
}

export function resetBeatDetector(state) {
    state.previousEnergy = 0;
    state.averageEnergy = 0;
    state.energyHistory.length = 0;
    state.beatPulse = 0;
    state.cooldown = 0;
}

function beatEmaAlpha(rate, dt) {
    return 1 - Math.pow(1 - rate, dt * 60);
}

function pushEnergyHistory(history, energy, size = BEAT_HISTORY_SIZE) {
    history.push(energy);
    if (history.length > size)
        history.shift();
}

function energyHistoryStats(history) {
    const mean = history.reduce((sum, value) => sum + value, 0) / history.length;
    const variance = history.reduce((sum, value) => sum + (value - mean) ** 2, 0) / history.length;
    return {mean, variance};
}

export function isSteadyAmbientEnergy(history, {
    varianceMax = BEAT_STEADY_VARIANCE_MAX,
    energyMax = BEAT_STEADY_ENERGY_MAX,
    minSamples = 6,
} = {}) {
    if (!history || history.length < minSamples)
        return false;

    const {mean, variance} = energyHistoryStats(history);
    if (mean > energyMax)
        return false;

    return variance <= varianceMax;
}

export function hasAudibleActivity(bass, mid, treble, minLevel = BEAT_ACTIVITY_MIN) {
    return Math.max(bass, mid, treble) >= minLevel;
}

export function updateBeatDetector(state, energy, dt, {
    minEnergy = BEAT_MIN_ENERGY,
    spikeRatio = BEAT_SPIKE_RATIO,
    minDelta = BEAT_MIN_DELTA,
    instantDelta = BEAT_INSTANT_DELTA,
    emaRise = BEAT_EMA_RISE,
    emaFall = BEAT_EMA_FALL,
    cooldownSec = BEAT_COOLDOWN_SEC,
    decayPerSec = BEAT_DECAY_PER_SEC,
    kickLevel = 0,
    kickThreshold = BEAT_KICK_THRESHOLD,
} = {}) {
    const safeDt = Math.max(dt, 0.001);
    const previousEnergy = state.previousEnergy;
    const instantRise = energy - previousEnergy;
    state.previousEnergy = energy;

    pushEnergyHistory(state.energyHistory, energy);
    const steadyAmbient = isSteadyAmbientEnergy(state.energyHistory);

    const averageEnergy = state.averageEnergy;
    const deltaFromAverage = energy - averageEnergy;
    const ratioFromAverage = averageEnergy > 0.04
        ? energy / averageEnergy
        : 0;

    state.cooldown = Math.max(0, state.cooldown - safeDt);

    const coldStartBeat = averageEnergy < 0.06 &&
        energy >= minEnergy &&
        energy < 0.55 &&
        instantRise >= minDelta;
    const onsetBeat = !steadyAmbient &&
        energy >= minEnergy &&
        deltaFromAverage >= minDelta &&
        instantRise >= instantDelta &&
        ratioFromAverage >= spikeRatio;
    const kickBeat = kickLevel >= kickThreshold && averageEnergy >= 0.15;

    if ((onsetBeat || coldStartBeat || kickBeat) && state.cooldown <= 0) {
        state.beatPulse = 1.0;
        state.cooldown = cooldownSec;
    } else {
        state.beatPulse = Math.max(0, state.beatPulse - decayPerSec * safeDt);
    }

    const emaAlpha = energy > averageEnergy
        ? beatEmaAlpha(emaRise, safeDt)
        : beatEmaAlpha(emaFall, safeDt);
    state.averageEnergy = averageEnergy + (energy - averageEnergy) * emaAlpha;

    return state.beatPulse;
}

export function combinedBeatEnergy(bass, mid, treble) {
    // Beats come from bass/kick transients; mid/treble beds raise the baseline and mask them.
    return clamp((bass - 0.08) / 0.92, 0, 1);
}

export function combinedAudioEnvelope(bass, mid, treble, beatPulse = 0) {
    const gatedBass = clamp((bass - 0.08) / 0.92, 0, 1);
    return clamp(
        gatedBass * 0.52 + mid * 0.28 + treble * 0.1 + beatPulse * 0.62,
        0,
        1
    );
}

export function updateVisualBeatPulse(state, beatPulse, dt, {
    attack = 0.94,
    decayPerSec = VISUAL_BEAT_DECAY_PER_SEC,
    kickLevel = 0,
    kickGain = VISUAL_KICK_GAIN,
} = {}) {
    const safeDt = Math.max(dt, 0.001);
    const kickPulse = clamp(kickLevel * kickGain, 0, 1);
    const pulse = clamp(Math.max(beatPulse, kickPulse), 0, 1);

    if (pulse > state.pulse)
        state.pulse = state.pulse + (pulse - state.pulse) * attack;
    else
        state.pulse = Math.max(0, state.pulse - decayPerSec * safeDt);

    return state.pulse;
}

export function createVisualBeatState() {
    return {pulse: 0};
}

export function compressAudioEnvelope(envelope, {
    knee = 0.58,
    ratio = 0.55,
} = {}) {
    const e = clamp(envelope, 0, 1);
    if (e <= knee)
        return e;
    return knee + (e - knee) * ratio;
}

export function denseMixAttenuation(bass, mid, treble, {
    avgThreshold = 0.52,
    minFactor = 0.58,
} = {}) {
    const avg = (bass + mid + treble) / 3;
    if (avg <= avgThreshold)
        return 1.0;

    const excess = clamp((avg - avgThreshold) / (1 - avgThreshold), 0, 1);
    return 1.0 - excess * (1 - minFactor);
}

export function updateBandKick(state, level, {
    riseSmooth = 0.52,
    fallSmooth = 0.14,
    sustainSmooth = 0.42,
    sustainDelta = 0.03,
} = {}) {
    const average = state.average ?? 0;
    const previousLevel = state.previousLevel ?? level;
    const levelDelta = Math.abs(level - previousLevel);
    state.previousLevel = level;

    let smooth = level > average ? riseSmooth : fallSmooth;
    if (level > 0.45 && levelDelta < sustainDelta)
        smooth = Math.max(smooth, sustainSmooth);

    const nextAverage = average + (level - average) * smooth;
    const kick = Math.max(0, level - nextAverage);
    state.average = nextAverage;
    return kick;
}
