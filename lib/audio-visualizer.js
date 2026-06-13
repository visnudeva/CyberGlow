import Gst from 'gi://Gst';
import Gvc from 'gi://Gvc';
import GLib from 'gi://GLib';

import {
    BAND_RANGES,
    combinedBeatEnergy,
    createBeatDetectorState,
    dbToRawLevel,
    effectiveThreshold,
    hasAudibleActivity,
    mixBandDb,
    resetBeatDetector,
    smoothLevel,
    SPECTRUM_BANDS,
    updateBandKick,
    updateBeatDetector,
    updateNoiseFloor,
} from './audio-levels.js';
import {
    clearDefaultMonitorDeviceCache,
    fetchDefaultMonitorDeviceFromPactl,
    getCachedDefaultMonitorDevice,
    isAudioRuntimeReady,
} from './audio-pactl.js';

const SPECTRUM_THRESHOLD_DB = -76;
const SPECTRUM_INTERVAL_NS = 12000000;
const LEVEL_SENSITIVITY = 1.28;
const BASS_RESPONSE_CURVE = 0.68;
const BASS_ATTACK_SMOOTH = 0.95;
const BASS_DECAY_SMOOTH = 0.62;
const BASS_SILENCE_RAW = 0.06;
const BASS_SILENCE_DECAY_SMOOTH = 0.82;
const MID_ATTACK_SMOOTH = 0.93;
const MID_DECAY_SMOOTH = 0.66;
const TREBLE_ATTACK_SMOOTH = 0.88;
const TREBLE_DECAY_SMOOTH = 0.6;
const SILENCE_HOLD_SEC = 3.0;
const NOISE_FLOOR_SAMPLES = 30;

export class AudioVisualizer {
    constructor() {
        this._mixer = null;
        this._pipeline = null;
        this._busWatchConnected = false;
        this._defaultSinkChangedId = 0;
        this._monitorDevice = null;

        this._bassLevel = 0;
        this._midLevel = 0;
        this._trebleLevel = 0;
        this._beatPulse = 0;
        this._lastActiveMonotonic = 0;
        this._isSilent = true;

        this._enabled = false;
        this._gstInitialized = false;
        this._pipelineRetryId = 0;

        this._noiseFloorDb = SPECTRUM_THRESHOLD_DB;
        this._noiseFloorSamples = 0;
        this._beatState = createBeatDetectorState();
        this._bassKickState = {average: 0};
        this._lastSpectrumMonotonic = 0;
    }

    get bassLevel() {
        return this._bassLevel;
    }

    get midLevel() {
        return this._midLevel;
    }

    get trebleLevel() {
        return this._trebleLevel;
    }

    get beatPulse() {
        return this._beatPulse;
    }

    get isSilent() {
        return this._isSilent;
    }

    get activityLevel() {
        return Math.max(
            this._bassLevel,
            this._midLevel,
            this._trebleLevel,
            this._beatPulse
        );
    }

    enable() {
        if (this._enabled)
            return;

        this._enabled = true;
        this._resetLevels();
        this._lastActiveMonotonic = GLib.get_monotonic_time();

        if (!this._ensureGst()) {
            this._enabled = false;
            return;
        }

        this._mixer = new Gvc.MixerControl({name: 'CyberGlow Audio'});
        this._mixer.connect('state-changed', (_control, state) => {
            if (state !== Gvc.MixerControlState.READY)
                return;
            this._ensurePipelineStarted();
        });

        try {
            this._defaultSinkChangedId = this._mixer.connect('default-sink-changed', () => {
                if (!this._enabled)
                    return;
                clearDefaultMonitorDeviceCache();
                this._restartPipelineIfNeeded();
            });
        } catch {
            // default-sink-changed is unavailable on some Gvc builds.
        }

        this._mixer.open();
        this._schedulePipelineRetry(250);
    }

    disable() {
        this._enabled = false;
        this._clearPipelineRetry();
        this._stopPipeline();
        this._closeMixer();
        this._resetLevels();
    }

    _resetLevels() {
        this._bassLevel = 0;
        this._midLevel = 0;
        this._trebleLevel = 0;
        this._beatPulse = 0;
        this._isSilent = true;
        this._noiseFloorDb = SPECTRUM_THRESHOLD_DB;
        this._noiseFloorSamples = 0;
        this._beatState = createBeatDetectorState();
        this._bassKickState = {average: 0};
        this._lastSpectrumMonotonic = 0;
        this._monitorDevice = null;
    }

    _ensureGst() {
        if (this._gstInitialized)
            return true;

        try {
            Gst.init(null);
            this._gstInitialized = true;
            return true;
        } catch (err) {
            console.error('[CyberGlow] failed to initialize GStreamer:', err);
            return false;
        }
    }

    _closeMixer() {
        if (!this._mixer)
            return;

        if (this._defaultSinkChangedId) {
            this._mixer.disconnect(this._defaultSinkChangedId);
            this._defaultSinkChangedId = 0;
        }

        try {
            this._mixer.close();
        } catch {
            // Best-effort cleanup during disable.
        }
        this._mixer = null;
    }

    _defaultMonitorDevice() {
        try {
            const sink = this._mixer?.get_default_sink?.();
            if (sink)
                return `${sink.get_name()}.monitor`;
        } catch {
            // Fall through to the pactl fallback.
        }

        if (!isAudioRuntimeReady())
            return null;

        const cached = getCachedDefaultMonitorDevice();
        if (cached)
            return cached;

        fetchDefaultMonitorDeviceFromPactl(device => {
            if (device && this._enabled)
                this._restartPipelineIfNeeded();
        });
        return null;
    }

    _ensurePipelineStarted() {
        if (!this._enabled)
            return;

        if (this._mixer?.get_state?.() !== Gvc.MixerControlState.READY) {
            this._schedulePipelineRetry(500);
            return;
        }

        this._restartPipelineIfNeeded();
    }

    _schedulePipelineRetry(delayMs) {
        if (!this._enabled || this._pipeline)
            return;

        if (this._pipelineRetryId)
            return;

        this._pipelineRetryId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._pipelineRetryId = 0;
            if (!this._enabled)
                return GLib.SOURCE_REMOVE;
            this._ensurePipelineStarted();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearPipelineRetry() {
        if (!this._pipelineRetryId)
            return;
        GLib.source_remove(this._pipelineRetryId);
        this._pipelineRetryId = 0;
    }

    _restartPipelineIfNeeded() {
        const device = this._defaultMonitorDevice();
        if (!device)
            return;

        if (this._monitorDevice === device && this._pipeline)
            return;

        this._startPipeline();
    }

    _makeElements(usePipeWire) {
        const src = Gst.ElementFactory.make(usePipeWire ? 'pipewiresrc' : 'pulsesrc', 'src');
        const convert = Gst.ElementFactory.make('audioconvert', 'convert');
        const spectrum = Gst.ElementFactory.make('spectrum', 'spectrum');
        const sink = Gst.ElementFactory.make('fakesink', 'sink');
        return {src, convert, spectrum, sink};
    }

    _configureSource(src, usePipeWire, monitorDevice) {
        if (!monitorDevice)
            return;

        if (usePipeWire)
            src.set_property('target-object', monitorDevice);
        else
            src.set_property('device', monitorDevice);
    }

    _configureSpectrum(spectrum) {
        spectrum.set_property('bands', SPECTRUM_BANDS);
        spectrum.set_property('threshold', SPECTRUM_THRESHOLD_DB);
        spectrum.set_property('post-messages', true);
        spectrum.set_property('message-magnitude', true);
        spectrum.set_property('interval', SPECTRUM_INTERVAL_NS);
    }

    _linkPipeline(src, convert, spectrum, sink) {
        return src.link(convert) && convert.link(spectrum) && spectrum.link(sink);
    }

    _startPipeline() {
        this._stopPipeline();

        const monitorDevice = this._defaultMonitorDevice();
        if (!monitorDevice) {
            this._schedulePipelineRetry(750);
            return;
        }

        const attempts = [false, true];

        for (const usePipeWire of attempts) {
            const {src, convert, spectrum, sink} = this._makeElements(usePipeWire);
            if (!src || !convert || !spectrum || !sink) {
                console.error('[CyberGlow] GStreamer plugins missing (need pulsesrc/pipewiresrc, spectrum, fakesink)');
                return;
            }

            this._configureSource(src, usePipeWire, monitorDevice);

            this._configureSpectrum(spectrum);

            const pipeline = Gst.Pipeline.new('cyberglow-audio');
            pipeline.add(src);
            pipeline.add(convert);
            pipeline.add(spectrum);
            pipeline.add(sink);

            if (!this._linkPipeline(src, convert, spectrum, sink)) {
                pipeline.set_state(Gst.State.NULL);
                continue;
            }

            const bus = pipeline.get_bus();
            bus.add_signal_watch();
            this._busWatchConnected = true;
            bus.connect('message::element', (_bus, message) => {
                this._onElementMessage(message);
            });

            const stateChange = pipeline.set_state(Gst.State.PLAYING);
            if (stateChange === Gst.StateChangeReturn.FAILURE) {
                bus.remove_signal_watch();
                this._busWatchConnected = false;
                pipeline.set_state(Gst.State.NULL);
                continue;
            }

            this._pipeline = pipeline;
            this._monitorDevice = monitorDevice;
            this._noiseFloorSamples = 0;
            this._noiseFloorDb = SPECTRUM_THRESHOLD_DB;
            return;
        }

        console.error('[CyberGlow] failed to start audio visualizer pipeline');
    }

    _stopPipeline() {
        if (!this._pipeline)
            return;

        const bus = this._pipeline.get_bus();
        if (this._busWatchConnected) {
            bus.remove_signal_watch();
            this._busWatchConnected = false;
        }

        this._pipeline.set_state(Gst.State.NULL);
        this._pipeline = null;
    }

    _processBandRange(magnitudes, [start, end], {
        silenceRaw = BASS_SILENCE_RAW,
        attack = BASS_ATTACK_SMOOTH,
        decay = BASS_DECAY_SMOOTH,
        silenceDecay = BASS_SILENCE_DECAY_SMOOTH,
        current = 0,
        responseCurve = BASS_RESPONSE_CURVE,
    }) {
        const mixedDb = mixBandDb(magnitudes, start, end - start);
        if (mixedDb === null)
            return current;

        if (this._noiseFloorSamples < NOISE_FLOOR_SAMPLES)
            this._noiseFloorDb = updateNoiseFloor(this._noiseFloorDb, mixedDb);

        const thresholdDb = effectiveThreshold(
            SPECTRUM_THRESHOLD_DB,
            this._noiseFloorDb
        );
        const raw = dbToRawLevel(mixedDb, thresholdDb, LEVEL_SENSITIVITY);
        const shaped = Math.pow(raw, responseCurve);
        const silent = raw < silenceRaw;
        const target = silent ? 0 : shaped;
        return smoothLevel(current, target, silent, attack, decay, silenceDecay);
    }

    _markActivity(level) {
        if (level > 0.1) {
            this._lastActiveMonotonic = GLib.get_monotonic_time();
            this._isSilent = false;
            return;
        }

        const elapsedSec = (GLib.get_monotonic_time() - this._lastActiveMonotonic) / 1000000;
        this._isSilent = elapsedSec >= SILENCE_HOLD_SEC;
    }

    _readSpectrumMagnitudes(structure) {
        const [ok, magnitudes] = structure.get_list('magnitude');
        if (ok && magnitudes?.n_values > 0)
            return magnitudes;

        const value = structure.get_value('magnitude');
        if (value && typeof value.get_nth === 'function' && value.n_values > 0)
            return value;

        return null;
    }

    _onElementMessage(message) {
        const structure = message.get_structure();
        if (!structure || structure.get_name() !== 'spectrum')
            return;

        const magnitudes = this._readSpectrumMagnitudes(structure);
        if (!magnitudes || magnitudes.n_values === 0)
            return;

        if (this._noiseFloorSamples < NOISE_FLOOR_SAMPLES)
            this._noiseFloorSamples++;

        const now = GLib.get_monotonic_time();
        const dt = this._lastSpectrumMonotonic > 0
            ? Math.min((now - this._lastSpectrumMonotonic) / 1000000, 0.12)
            : SPECTRUM_INTERVAL_NS / 1000000000;
        this._lastSpectrumMonotonic = now;

        this._bassLevel = this._processBandRange(magnitudes, BAND_RANGES.bass, {
            current: this._bassLevel,
        });
        this._midLevel = this._processBandRange(magnitudes, BAND_RANGES.mid, {
            current: this._midLevel,
            attack: MID_ATTACK_SMOOTH,
            decay: MID_DECAY_SMOOTH,
            silenceRaw: 0.06,
        });
        this._trebleLevel = this._processBandRange(magnitudes, BAND_RANGES.treble, {
            current: this._trebleLevel,
            attack: TREBLE_ATTACK_SMOOTH,
            decay: TREBLE_DECAY_SMOOTH,
            silenceRaw: 0.05,
            responseCurve: 0.74,
        });

        const calibrated = this._noiseFloorSamples >= NOISE_FLOOR_SAMPLES;
        const audible = hasAudibleActivity(
            this._bassLevel,
            this._midLevel,
            this._trebleLevel
        );

        if (!calibrated || !audible) {
            resetBeatDetector(this._beatState);
            this._bassKickState = {average: 0};
            this._beatPulse = 0;
        } else {
            const gatedBass = Math.max(0, Math.min(1, (this._bassLevel - 0.08) / 0.92));
            const kickLevel = updateBandKick(this._bassKickState, gatedBass);
            const energy = combinedBeatEnergy(
                this._bassLevel,
                this._midLevel,
                this._trebleLevel
            );
            this._beatPulse = updateBeatDetector(this._beatState, energy, dt, {kickLevel});
        }

        this._markActivity(Math.max(
            this._bassLevel,
            this._midLevel,
            this._trebleLevel,
            this._beatPulse
        ));
    }
}
