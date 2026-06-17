import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {UnderglowManager} from './lib/underglow.js';
import {AudioVisualizer} from './lib/audio-visualizer.js';
import {
    compressAudioEnvelope,
    createVisualBeatState,
    denseMixAttenuation,
    updateBandKick,
    updateVisualBeatPulse,
} from './lib/audio-levels.js';
import {
    clamp,
    expRand,
    getGlowWidthPasses,
    lerp,
    parseColorStringToRgb01,
} from './lib/utils.js';

function rand(min, max) { return min + Math.random() * (max - min); }

const PERF_TIERS = {
    normal: {
        frameMsCalm: 48,
        frameMsFlicker: 16,
        glowPasses: 13,
        glowInnerBand: true,
        rainDrops: 78,
        dustCount: 15,
        dustHalos: true,
    },
    powerSaver: {
        frameMsCalm: 48,
        frameMsFlicker: 20,
        glowPasses: 13,
        glowInnerBand: true,
        rainDrops: 78,
        dustCount: 15,
        dustHalos: true,
    },
};

const RAIN_ALPHA_BUCKETS = 5;

const NEON_GLOW_SIZE = 1.15;
const NEON_GLOW_STRENGTH = 8.0;
const NEON_BRIGHTNESS = 8.0;
const NEON_CORE_WIDTH = 7.5;
const NEON_CORE_BORDER_WIDTH = 0.65;
const NEON_GLITCH_MEAN_INTERVAL = 3.5;
const NEON_GLITCH_MAX_DURATION = 0.2;
const NEON_GLITCH_MAX_STRENGTH = 0.85;
const NEON_GLITCH_PULSE_BRIGHTNESS = 1.0;
const NEON_HUM_MIN = 1.0;
const NEON_HUM_MAX = 1.0;
const NEON_AUDIO_SCALE_MAX = 0.16;
const NEON_AUDIO_ATTACK_SMOOTH = 0.92;
const NEON_AUDIO_DECAY_SMOOTH = 0.68;
const NEON_AUDIO_SCALE_DECAY_SMOOTH = 0.62;
const NEON_AUDIO_FRAME_MS_FAST = 16;
const NEON_AUDIO_FRAME_MS_MED = 20;
const NEON_AUDIO_GLOW_MID_MAX = 0.14;
const NEON_AUDIO_RAIN_BASS_MAX = 0.48;
const NEON_AUDIO_DUST_TREBLE_MAX = 1.45;
const NEON_AUDIO_BEAT_COLOR_MAX = 0.52;
const NEON_AUDIO_BEAT_SCALE_MAX = 0.2;
const NEON_AUDIO_BEAT_ATTACK_SMOOTH = 0.96;
const NEON_AUDIO_BEAT_RELEASE_SMOOTH = 0.14;
const NEON_AUDIO_RAIN_ALPHA_BASS_MAX = 0.3;
const NEON_AUDIO_DUST_BRIGHTNESS_TREBLE_MAX = 0.36;
const NEON_AUDIO_BEAT_GLITCH_THRESHOLD = 0.52;
const NEON_AUDIO_BASS_GATE = 0.06;
const NEON_AUDIO_HUM_BLEND = 0.1;
const HEAVY_STARTUP_DELAY_MS = 2000;

const NeonShapeEffect = {
    shape: null,
    dust: [],
    rainDrops: [],
    _settings: null,
    _musicReactive: false,
    _bassLevel: 0,
    _midLevel: 0,
    _trebleLevel: 0,
    _beatPulse: 0,
    _visualBeatPulse: 0,
    _visualBeatState: null,
    _rainSpeedMult: 1.0,
    _dustTwinkleMult: 1.0,
    _densityFactor: 1.0,
    _w: 0,
    _h: 0,
    _perfTier: 'normal',
    _glowPassCount: PERF_TIERS.normal.glowPasses,
    _glowInnerBand: PERF_TIERS.normal.glowInnerBand,
    _dustHalos: PERF_TIERS.normal.dustHalos,
    _pathCache: new Map(),
    _pathCacheKey: '',
    _pathScratchSurface: null,
    _pathScratchCtx: null,
    init(w, h, settings = null) {
        this._settings = settings;
        this._w = w;
        this._h = h;
        this._applyPerfCounts(w, h);
        this._invalidatePathCache();
        this.shape = {
            cx: w / 2,
            cy: h / 2,
            size: Math.min(w, h) * 0.3,
            color: [0, 1, 0.5],
            flickerLevel: 1.0,
            inFlickerEpisode: false,
            episodeT: 0,
            episodeDur: 0,
            flickerPhase: 0,
            nextFlickerIn: expRand(NEON_GLITCH_MEAN_INTERVAL),
            humPhase: rand(0, Math.PI * 2),
            humSpeed: rand(0.50, 0.85),
            humWobble: rand(0, Math.PI * 2),
            humWobbleSpeed: rand(0.14, 0.25),
            intensityLevel: 1.0,
            audioScale: 1.0,
            beatColorBoost: 0,
            audioGlowBoost: 1.0,
            _bassKick: {average: 0},
        };
    },
    setMusicReactive(enabled) {
        this._musicReactive = enabled;
        if (!enabled) {
            this._bassLevel = 0;
            this._midLevel = 0;
            this._trebleLevel = 0;
            this._beatPulse = 0;
            this._visualBeatPulse = 0;
            this._visualBeatState = null;
            this._rainSpeedMult = 1.0;
            this._dustTwinkleMult = 1.0;
            this._densityFactor = 1.0;
            if (this.shape) {
                this.shape.audioScale = 1.0;
                this.shape.beatColorBoost = 0;
                this.shape.audioGlowBoost = 1.0;
                this.shape._bassKick = {average: 0};
            }
        }
    },
    setAudioLevels({bass, mid, treble, beatPulse} = {}) {
        if (bass !== undefined)
            this._bassLevel = clamp(bass, 0, 1);
        if (mid !== undefined)
            this._midLevel = clamp(mid, 0, 1);
        if (treble !== undefined)
            this._trebleLevel = clamp(treble, 0, 1);
        if (beatPulse !== undefined)
            this._beatPulse = clamp(beatPulse, 0, 1);
    },
    setPerfTier(tier) {
        if (tier !== 'powerSaver')
            tier = 'normal';
        if (this._perfTier === tier)
            return;
        this._perfTier = tier;
        const cfg = PERF_TIERS[tier];
        this._glowPassCount = cfg.glowPasses;
        this._glowInnerBand = cfg.glowInnerBand;
        this._dustHalos = cfg.dustHalos;
        this._invalidatePathCache();
        if (this._w > 0 && this._h > 0) {
            this._applyPerfCounts(this._w, this._h);
            this._invalidatePathCache();
        }
    },
    _invalidatePathCache() {
        this._pathCacheKey = '';
        this._pathCache.clear();
    },
    _getPathScratchContext() {
        if (!this._pathScratchSurface) {
            this._pathScratchSurface = new Cairo.ImageSurface(Cairo.Format.Alpha, 1, 1);
            this._pathScratchCtx = new Cairo.Context(this._pathScratchSurface);
        }
        return this._pathScratchCtx;
    },
    _rebuildPathCacheIfNeeded(w, h, type) {
        const s = this.shape;
        const key = `${w}|${h}|${type}|${s.cx}|${s.cy}|${s.size}|${this._glowPassCount}`;
        if (this._pathCacheKey === key)
            return;

        this._pathCacheKey = key;
        this._pathCache.clear();

        const offsets = new Set([0]);
        for (const p of getGlowWidthPasses(NEON_GLOW_SIZE, this._glowPassCount)) {
            const half = p.w / 2;
            offsets.add(half);
            offsets.add(-half);
        }

        const scratch = this._getPathScratchContext();
        for (const offset of offsets) {
            scratch.newPath();
            this._traceShapePath(scratch, w, h, type, offset);
            this._pathCache.set(offset, scratch.copyPath());
        }
    },
    _appendCachedShapePath(ctx, w, h, type, offset) {
        const path = this._pathCache.get(offset);
        if (path) {
            ctx.appendPath(path);
            return;
        }
        this._traceShapePath(ctx, w, h, type, offset);
    },
    _applyPerfCounts(w, h) {
        const cfg = PERF_TIERS[this._perfTier] ?? PERF_TIERS.normal;
        while (this.dust.length > cfg.dustCount)
            this.dust.pop();
        while (this.dust.length < cfg.dustCount)
            this.dust.push(this._makeDust(w, h, true));

        while (this.rainDrops.length > cfg.rainDrops)
            this.rainDrops.pop();
        while (this.rainDrops.length < cfg.rainDrops)
            this.rainDrops.push(this._makeRainDrop(w, h, true));
    },
    _makeDust(w, h, scattered) {
        return {
            x: rand(0, w),
            y: scattered ? rand(-h, h) : rand(0, h),
            size: rand(0.4, 3.2),
            speedX: rand(-28, 28),
            speedY: rand(-32, 32),
            driftPhase: rand(0, Math.PI * 2),
            driftSpeed: rand(0.4, 1.8),
            alpha: rand(0.18, 0.62),
            twinklePhase: rand(0, Math.PI * 2),
            twinkleSpeed: rand(1.5, 5.5),
        };
    },
    _updateDust(dt, w, h) {
        const twinkleMult = this._musicReactive ? this._dustTwinkleMult : 1.0;
        for (const d of this.dust) {
            d.driftPhase += d.driftSpeed * dt;
            d.twinklePhase += d.twinkleSpeed * twinkleMult * dt;
            d.x += (d.speedX + Math.sin(d.driftPhase) * 14) * dt;
            d.y += (d.speedY + Math.cos(d.driftPhase * 0.85) * 10) * dt;
            if (d.x < -12) d.x = w + 12;
            else if (d.x > w + 12) d.x = -12;
            if (d.y < -12) d.y = h + 12;
            else if (d.y > h + 12) d.y = -12;
        }
    },
    _getNeonType() {
        if (!this._settings) return 0;
        const shape = this._settings.get_int('neon-shape');
        return clamp(shape === 3 ? 2 : shape, 0, 2);
    },
    _buildGlowPasses(gsz, glowAlpha) {
        const passes = getGlowWidthPasses(gsz, this._glowPassCount);
        return passes.map(p => ({
            w: p.w,
            a: glowAlpha * p.alphaScale,
        }));
    },
    _computeRoundedPolygonCornerArcs(cx, cy, circumRadius, n, rot, cornerRadius) {
        const vertices = [];
        for (let i = 0; i < n; i++) {
            const theta = rot + (Math.PI * 2 * i) / n;
            vertices.push([
                cx + Math.cos(theta) * circumRadius,
                cy + Math.sin(theta) * circumRadius,
            ]);
        }

        const r = cornerRadius;
        const arcs = [];

        for (let i = 0; i < n; i++) {
            const prev = vertices[(i - 1 + n) % n];
            const curr = vertices[i];
            const next = vertices[(i + 1) % n];

            const inX = curr[0] - prev[0];
            const inY = curr[1] - prev[1];
            const outX = next[0] - curr[0];
            const outY = next[1] - curr[1];
            const inLen = Math.hypot(inX, inY);
            const outLen = Math.hypot(outX, outY);
            const inUx = inX / inLen;
            const inUy = inY / inLen;
            const outUx = outX / outLen;
            const outUy = outY / outLen;

            const dot = clamp(-inUx * outUx - inUy * outUy, -1, 1);
            const angle = Math.acos(dot);
            const tanHalf = Math.tan(angle / 2);
            let inset = r / tanHalf;
            inset = Math.min(inset, inLen * 0.45, outLen * 0.45);
            const arcRadius = inset * tanHalf;

            const startX = curr[0] - inUx * inset;
            const startY = curr[1] - inUy * inset;
            const endX = curr[0] + outUx * inset;
            const endY = curr[1] + outUy * inset;

            let bisX = -inUx + outUx;
            let bisY = -inUy + outUy;
            const bisLen = Math.hypot(bisX, bisY);
            bisX /= bisLen;
            bisY /= bisLen;
            const centerDist = arcRadius / Math.sin(angle / 2);
            const centerX = curr[0] + bisX * centerDist;
            const centerY = curr[1] + bisY * centerDist;

            const startAngle = Math.atan2(startY - centerY, startX - centerX);
            let endAngle = Math.atan2(endY - centerY, endX - centerX);
            while (endAngle <= startAngle)
                endAngle += Math.PI * 2;

            const midAngle = (startAngle + endAngle) / 2;
            arcs.push({
                startX,
                startY,
                endX,
                endY,
                centerX,
                centerY,
                arcRadius,
                startAngle,
                endAngle,
                midX: centerX + Math.cos(midAngle) * arcRadius,
                midY: centerY + Math.sin(midAngle) * arcRadius,
            });
        }

        return arcs;
    },
    _traceRoundedPolygonPath(ctx, cx, cy, circumRadius, n, rot, cornerRadius) {
        const arcs = this._computeRoundedPolygonCornerArcs(
            cx, cy, circumRadius, n, rot, cornerRadius
        );
        ctx.newPath();
        for (let i = 0; i < arcs.length; i++) {
            const arc = arcs[i];
            if (i === 0)
                ctx.moveTo(arc.startX, arc.startY);
            else
                ctx.lineTo(arc.startX, arc.startY);
            ctx.arc(arc.centerX, arc.centerY, arc.arcRadius, arc.startAngle, arc.endAngle);
        }
        ctx.closePath();
    },
    _shapeCornerRadius(size) {
        return size * 0.055;
    },
    _cornerRadiusForOffset(baseCorner, offset) {
        const r = baseCorner + offset;
        if (offset >= 0)
            return Math.max(r, 0);
        return Math.max(r, baseCorner);
    },
    _traceShapePath(ctx, w, h, type, offset = 0) {
        const s = this.shape;
        const cx = s.cx;
        const cy = s.cy;
        const radius = Math.max(s.size + offset, 1);

        if (type === 2) {
            ctx.newPath();
            ctx.arc(cx, cy, radius, 0, Math.PI * 2);
            return;
        }

        const baseCorner = this._shapeCornerRadius(s.size);
        const cornerRadius = this._cornerRadiusForOffset(baseCorner, offset);

        const rot = type === 1 ? Math.PI / 2 : -Math.PI / 2;
        this._traceRoundedPolygonPath(ctx, cx, cy, radius, 3, rot, cornerRadius);
    },
    _getNeonColor() {
        if (!this._settings)
            return this.shape.color;
        const parsed = parseColorStringToRgb01(this._settings.get_string('neon-color'));
        return parsed || this.shape.color;
    },
    _rainReversed() {
        if (!this._settings)
            return false;
        return this._settings.get_boolean('reverse-rain');
    },
    _makeRainDrop(w, h, scattered) {
        const reverse = this._rainReversed();
        const speed = rand(400, 900);
        let y;
        if (scattered)
            y = rand(-h, h);
        else if (reverse)
            y = rand(h + 10, h + 200);
        else
            y = rand(-200, -10);
        return {
            x: rand(0, w),
            y,
            speed,
            len: lerp(13, 35, (speed - 400) / 500),
            alpha: rand(0.22, 0.58),
            wind: rand(-20, 20),
        };
    },
    _updateRain(dt, w, h) {
        const reverse = this._rainReversed();
        const speedMult = this._musicReactive ? this._rainSpeedMult : 1.0;
        for (const d of this.rainDrops) {
            const verticalSpeed = d.speed * speedMult * dt * (reverse ? -1 : 1);
            d.y += verticalSpeed;
            d.x += d.wind * dt;
            if (reverse) {
                if (d.y < -10)
                    Object.assign(d, this._makeRainDrop(w, h, false));
            } else if (d.y > h + 10) {
                Object.assign(d, this._makeRainDrop(w, h, false));
            }
        }
    },
    _drawRain(ctx, color, flickerMult, alphaMult = 1.0) {
        if (!this.rainDrops.length)
            return;
        const [cr, cg, cb] = color;
        const reverse = this._rainReversed();
        const streak = reverse ? -1 : 1;
        ctx.setLineCap(Cairo.LineCap.ROUND);
        ctx.setLineWidth(1.85);

        const buckets = Array.from({length: RAIN_ALPHA_BUCKETS}, () => []);
        for (const d of this.rainDrops) {
            const a = clamp(d.alpha * flickerMult * alphaMult, 0.0, 1.0);
            if (a < 0.02)
                continue;
            buckets[Math.min(RAIN_ALPHA_BUCKETS - 1, Math.floor(a * RAIN_ALPHA_BUCKETS))].push(d);
        }

        for (let b = 0; b < RAIN_ALPHA_BUCKETS; b++) {
            const drops = buckets[b];
            if (!drops.length)
                continue;
            ctx.setSourceRGBA(cr, cg, cb, (b + 0.5) / RAIN_ALPHA_BUCKETS);
            ctx.newPath();
            for (const d of drops) {
                ctx.moveTo(d.x, d.y);
                ctx.lineTo(d.x + d.wind * 0.05, d.y + d.len * streak);
            }
            ctx.stroke();
        }
    },
    _sampleFlickerLevel(on, maxStrength) {
        const depth = clamp(maxStrength, 0.05, 1.0);
        if (!on)
            return rand(0.0, Math.max(0.02, 1.0 - depth));
        if (Math.random() < 0.35)
            return rand(0.25, 0.65);
        return rand(0.88, 1.0);
    },
    _flickerTogglePeriodForLevel(level) {
        const off = level < 0.4;
        if (off)
            return 1.0 / rand(48, 78);
        return 1.0 / rand(22, 42);
    },
    _updateIntensityHum(dt) {
        const s = this.shape;
        s.humPhase += s.humSpeed * dt;
        s.humWobble += s.humWobbleSpeed * dt;
        const primary = 0.5 + 0.5 * Math.sin(s.humPhase);
        const secondary = 0.5 + 0.5 * Math.sin(s.humPhase * 0.41 + s.humWobble);
        const blend = primary * 0.62 + secondary * 0.38;
        const shaped = Math.pow(blend, 0.88);
        return lerp(NEON_HUM_MIN, NEON_HUM_MAX, shaped);
    },
    _audioReactSmooth(current, target) {
        return target > current ? NEON_AUDIO_ATTACK_SMOOTH : NEON_AUDIO_DECAY_SMOOTH;
    },
    _triggerBeatGlitch() {
        const s = this.shape;
        if (s.inFlickerEpisode)
            return;

        s.inFlickerEpisode = true;
        s.episodeT = 0;
        s.flickerPhase = 0;
        s.flickerLevel = this._sampleFlickerLevel(false, NEON_GLITCH_MAX_STRENGTH);
        s._flickerTogglePeriod = this._flickerTogglePeriodForLevel(s.flickerLevel);
        s.episodeDur = rand(0.05, 0.14);
        s.nextFlickerIn = expRand(NEON_GLITCH_MEAN_INTERVAL);
    },
    _gatedBassLevel(bass = this._bassLevel) {
        return clamp((bass - NEON_AUDIO_BASS_GATE) / (1 - NEON_AUDIO_BASS_GATE), 0, 1);
    },
    _audioEnvelope(bass, mid, treble, beat) {
        const gatedBass = this._gatedBassLevel(bass);
        return clamp(
            gatedBass * 0.52 + mid * 0.28 + treble * 0.1 + beat * 0.62,
            0,
            1
        );
    },
    _updateAudioReact(humIntensity, dt) {
        const s = this.shape;
        if (!this._musicReactive) {
            s.audioScale = lerp(s.audioScale ?? 1.0, 1.0, 0.12);
            s.beatColorBoost = lerp(s.beatColorBoost ?? 0, 0, 0.18);
            s.audioGlowBoost = lerp(s.audioGlowBoost ?? 1.0, 1.0, 0.12);
            this._rainSpeedMult = lerp(this._rainSpeedMult, 1.0, 0.12);
            this._dustTwinkleMult = lerp(this._dustTwinkleMult, 1.0, 0.12);
            return;
        }

        const bass = this._bassLevel;
        const mid = this._midLevel;
        const treble = this._trebleLevel;
        const gatedBass = this._gatedBassLevel(bass);
        if (!s._bassKick)
            s._bassKick = {average: 0};
        const bassKick = updateBandKick(s._bassKick, gatedBass);

        const beat = this._beatPulse;
        if (!this._visualBeatState)
            this._visualBeatState = createVisualBeatState();
        const visualBeat = updateVisualBeatPulse(this._visualBeatState, beat, dt, {
            kickLevel: bassKick,
        });
        this._visualBeatPulse = visualBeat;
        const density = denseMixAttenuation(gatedBass, mid, treble);
        this._densityFactor = density;

        const envelope = compressAudioEnvelope(
            this._audioEnvelope(bass, mid, treble, visualBeat)
        );

        const targetScale = 1.0
            + bassKick * NEON_AUDIO_SCALE_MAX * density
            + visualBeat * NEON_AUDIO_BEAT_SCALE_MAX;
        const currentScale = s.audioScale ?? 1.0;
        let scaleSmooth = visualBeat >= 0.25 && targetScale > currentScale
            ? NEON_AUDIO_BEAT_ATTACK_SMOOTH
            : this._audioReactSmooth(currentScale, targetScale);
        if (visualBeat < 0.1 && currentScale > 1.01)
            scaleSmooth = Math.min(scaleSmooth, NEON_AUDIO_SCALE_DECAY_SMOOTH);
        s.audioScale = lerp(currentScale, targetScale, scaleSmooth);

        const audioIntensity = lerp(NEON_HUM_MIN, NEON_HUM_MAX, envelope);
        const targetIntensity = lerp(audioIntensity, humIntensity, NEON_AUDIO_HUM_BLEND);
        const currentIntensity = s.intensityLevel ?? humIntensity;
        const intensitySmooth = visualBeat > (s._lastVisualBeat ?? 0)
            ? NEON_AUDIO_BEAT_ATTACK_SMOOTH
            : this._audioReactSmooth(currentIntensity, targetIntensity);
        s.intensityLevel = lerp(currentIntensity, targetIntensity, intensitySmooth);
        s._lastVisualBeat = visualBeat;

        const targetBeatColor = visualBeat * NEON_AUDIO_BEAT_COLOR_MAX;
        s.beatColorBoost = lerp(
            s.beatColorBoost ?? 0,
            targetBeatColor,
            targetBeatColor > (s.beatColorBoost ?? 0)
                ? NEON_AUDIO_BEAT_ATTACK_SMOOTH
                : NEON_AUDIO_BEAT_RELEASE_SMOOTH
        );

        const targetGlowBoost = 1.0 + mid * NEON_AUDIO_GLOW_MID_MAX * density + visualBeat * 0.22;
        s.audioGlowBoost = lerp(s.audioGlowBoost ?? 1.0, targetGlowBoost, this._audioReactSmooth(s.audioGlowBoost ?? 1.0, targetGlowBoost));

        const targetRainSpeed = 1.0 + gatedBass * NEON_AUDIO_RAIN_BASS_MAX * density + visualBeat * 0.28;
        this._rainSpeedMult = lerp(this._rainSpeedMult, targetRainSpeed, this._audioReactSmooth(this._rainSpeedMult, targetRainSpeed));

        const targetDustTwinkle = 1.0 + treble * NEON_AUDIO_DUST_TREBLE_MAX * density + mid * 0.18 * density;
        this._dustTwinkleMult = lerp(this._dustTwinkleMult, targetDustTwinkle, this._audioReactSmooth(this._dustTwinkleMult, targetDustTwinkle));

        if (visualBeat >= NEON_AUDIO_BEAT_GLITCH_THRESHOLD)
            this._triggerBeatGlitch();
    },
    update(dt) {
        const w = Main.layoutManager.primaryMonitor.width;
        const h = Main.layoutManager.primaryMonitor.height;
        this._updateDust(dt, w, h);
        this._updateRain(dt, w, h);
        const humIntensity = this._updateIntensityHum(dt);
        if (this._musicReactive)
            this._updateAudioReact(humIntensity, dt);
        else
            this.shape.intensityLevel = humIntensity;

        const s = this.shape;
        const meanInterval = NEON_GLITCH_MEAN_INTERVAL;
        const maxDur = NEON_GLITCH_MAX_DURATION;
        const maxStrength = NEON_GLITCH_MAX_STRENGTH;

        if (s.inFlickerEpisode) {
            s.episodeT += dt;
            s.flickerPhase += dt;
            let togglePeriod = s._flickerTogglePeriod ?? this._flickerTogglePeriodForLevel(s.flickerLevel);
            while (s.flickerPhase >= togglePeriod) {
                s.flickerPhase -= togglePeriod;
                const on = Math.random() < 0.48;
                s.flickerLevel = this._sampleFlickerLevel(on, maxStrength);
                togglePeriod = this._flickerTogglePeriodForLevel(s.flickerLevel);
                s._flickerTogglePeriod = togglePeriod;
            }
            if (s.episodeT >= s.episodeDur) {
                s.inFlickerEpisode = false;
                s.flickerLevel = 1.0;
                s.nextFlickerIn = expRand(meanInterval);
            }
            return;
        }

        s.flickerLevel = 1.0;
        s.nextFlickerIn -= dt;
        if (s.nextFlickerIn <= 0 && !this._musicReactive) {
            s.inFlickerEpisode = true;
            s.episodeT = 0;
            s.flickerPhase = 0;
            s.flickerLevel = this._sampleFlickerLevel(false, maxStrength);
            s._flickerTogglePeriod = this._flickerTogglePeriodForLevel(s.flickerLevel);
            const minEp = 0.08;
            const maxEp = Math.max(minEp, maxDur * 4.0);
            s.episodeDur = rand(minEp, maxEp);
        }
    },
    draw(ctx, w, h) {
        const s = this.shape;
        s.color = this._getNeonColor();
        const type = this._getNeonType();

        const baseAlpha = 0.38;
        const level = clamp(s.flickerLevel ?? 1.0, 0.0, 1.0);
        const flickerMix = clamp(NEON_GLITCH_PULSE_BRIGHTNESS, 0.0, 2.0);
        const flickerMult = clamp(1.0 - (1.0 - level) * flickerMix, 0.0, 1.0);
        const intensityMin = NEON_HUM_MIN;
        const intensityMult = clamp(s.intensityLevel ?? 1.0, intensityMin, NEON_HUM_MAX);
        const peakAlpha = clamp(baseAlpha * NEON_BRIGHTNESS * flickerMult, 0.0, 1.0);
        const beatColorBoost = clamp(s.beatColorBoost ?? 0, 0.0, NEON_AUDIO_BEAT_COLOR_MAX);
        const bass = this._musicReactive ? this._bassLevel : 0;
        const gatedBass = this._musicReactive ? this._gatedBassLevel(bass) : 0;
        const treble = this._musicReactive ? this._trebleLevel : 0;
        const beat = this._musicReactive ? this._visualBeatPulse : 0;
        const alpha = clamp(
            peakAlpha * intensityMult * (1.0 + beatColorBoost + gatedBass * 0.08 + beat * 0.18),
            0.0,
            1.0
        );
        const glowAlpha = clamp(alpha * 0.85 * NEON_GLOW_STRENGTH * (s.audioGlowBoost ?? 1.0), 0.0, 1.0);

        let [cr, cg, cb] = s.color;
        const colorShift = beatColorBoost + gatedBass * 0.12 + beat * 0.2 + treble * 0.06;
        if (colorShift > 0.001) {
            cr = clamp(cr + colorShift * 0.72, 0, 1);
            cg = clamp(cg + colorShift * 0.38, 0, 1);
            cb = clamp(cb + colorShift * 0.58, 0, 1);
        }

        const density = this._musicReactive ? this._densityFactor : 1.0;
        const rainAlphaMult = this._musicReactive
            ? 1.0 + gatedBass * NEON_AUDIO_RAIN_ALPHA_BASS_MAX * density + beat * 0.24
            : 1.0;
        const dustTwinkleAmp = this._musicReactive
            ? clamp(0.72 + (this._dustTwinkleMult - 1.0) * 0.34, 0.72, 1.55)
            : 1.0;
        const dustBrightnessMult = this._musicReactive
            ? 1.0 + treble * NEON_AUDIO_DUST_BRIGHTNESS_TREBLE_MAX * density + beat * 0.18
            : 1.0;

        ctx.save();
        ctx.setLineCap(Cairo.LineCap.ROUND);
        ctx.setLineJoin(Cairo.LineJoin.ROUND);

        this._drawRain(ctx, [cr, cg, cb], flickerMult, rainAlphaMult);

        ctx.save();
        const audioScale = clamp(
            s.audioScale ?? 1.0,
            1.0,
            1.0 + NEON_AUDIO_SCALE_MAX + NEON_AUDIO_BEAT_SCALE_MAX
        );
        if (audioScale !== 1.0) {
            ctx.translate(s.cx, s.cy);
            ctx.scale(audioScale, audioScale);
            ctx.translate(-s.cx, -s.cy);
        }

        this._rebuildPathCacheIfNeeded(w, h, type);
        const glowPasses = this._buildGlowPasses(NEON_GLOW_SIZE, glowAlpha);
        const prevOp = ctx.getOperator?.() ?? Cairo.Operator.OVER;
        ctx.setOperator(Cairo.Operator.ADD);
        for (const p of glowPasses) {
            const half = p.w / 2;

            ctx.setSourceRGBA(cr, cg, cb, p.a);
            ctx.newPath();
            this._appendCachedShapePath(ctx, w, h, type, half);
            ctx.setLineWidth(p.w);
            ctx.stroke();

            if (this._glowInnerBand) {
                ctx.setSourceRGBA(cr, cg, cb, p.a);
                ctx.newPath();
                this._appendCachedShapePath(ctx, w, h, type, -half);
                ctx.setLineWidth(p.w);
                ctx.stroke();
            }
        }
        ctx.setOperator(prevOp);

        ctx.newPath();
        this._appendCachedShapePath(ctx, w, h, type, 0);
        ctx.setSourceRGBA(cr, cg, cb, clamp(alpha * 0.38, 0.0, 1.0));
        ctx.setLineWidth(NEON_CORE_WIDTH + NEON_CORE_BORDER_WIDTH * 2);
        ctx.strokePreserve();

        ctx.setSourceRGBA(1, 1, 1, clamp(alpha * 0.82, 0.0, 1.0));
        ctx.setLineWidth(NEON_CORE_WIDTH);
        ctx.stroke();
        ctx.restore();

        const dustBrightness = clamp(baseAlpha * NEON_BRIGHTNESS * 1.38 * dustBrightnessMult, 0.0, 1.0);
        ctx.setOperator(Cairo.Operator.ADD);
        for (const d of this.dust) {
            const twinkle = dustTwinkleAmp * (0.65 + 0.35 * (0.5 + 0.5 * Math.sin(d.twinklePhase)));
            const a = clamp(d.alpha * twinkle * dustBrightness, 0.0, 1.0);
            if (a < 0.02) continue;
            ctx.setSourceRGBA(cr, cg, cb, a);
            ctx.arc(d.x, d.y, d.size, 0, Math.PI * 2);
            ctx.fill();
            if (this._dustHalos && d.size > 1.2) {
                ctx.setSourceRGBA(cr, cg, cb, a * 0.48);
                ctx.arc(d.x, d.y, d.size * 2.2, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        ctx.setOperator(prevOp);

        ctx.restore();
    },
};

function createPowerProfilesProxy() {
    try {
        return Gio.DBusProxy.new_for_bus_sync(
            Gio.BusType.SYSTEM,
            Gio.DBusProxyFlags.NONE,
            null,
            'net.hadess.PowerProfiles',
            '/net/hadess/PowerProfiles',
            'net.hadess.PowerProfiles',
            null
        );
    } catch {
        return null;
    }
}

function readPowerSaverActive(proxy) {
    if (!proxy)
        return false;
    const profile = proxy.get_cached_property('ActiveProfile')?.unpack();
    return profile === 'power-saver';
}

export default class CyberGlowExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._canvas = null;
        this._onRepaintHandler = null;
        this._timeoutId = null;
        this._lastFrameTime = 0;
        this._frameIntervalMs = PERF_TIERS.normal.frameMsCalm;
        this._powerProfilesProxy = null;
        this._perfTier = 'normal';
        this._width = 0;
        this._height = 0;
        this._underglow = null;
        this._audioVisualizer = null;
        this._enableRetrySource = null;
        this._enableRetries = 0;
        this._deferredStartupId = null;
    }

    enable() {
        if (this._canvas)
            return;

        this._enableRetries = 0;
        if (this._enableRetrySource)
            GLib.source_remove(this._enableRetrySource);
        this._enableRetrySource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            return this._enableWhenReady();
        });
    }

    _enableWhenReady() {
        const backgroundGroup = Main.layoutManager?._backgroundGroup;
        if (!backgroundGroup) {
            this._enableRetries += 1;
            if (this._enableRetries > 120)
                console.error('[CyberGlow] layout background group never became ready');
            return this._enableRetries <= 120 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        }

        this._enableRetrySource = null;
        try {
            this._enableInternal(backgroundGroup);
        } catch (err) {
            console.error('[CyberGlow] failed to enable extension:', err);
            this.disable();
        }
        return GLib.SOURCE_REMOVE;
    }

    _enableInternal(backgroundGroup) {
        const monitor = Main.layoutManager.primaryMonitor;
        this._width = monitor.width;
        this._height = monitor.height;

        this._onRepaintHandler = this._onRepaint.bind(this);
        this._canvas = new St.DrawingArea({
            width: this._width,
            height: this._height,
        });
        this.connectObject(
            this._canvas,
            'repaint',
            this._onRepaintHandler,
        );

        this._canvas.set_position(monitor.x, monitor.y);
        backgroundGroup.add_child(this._canvas);

        this._initEffect();
        this._setPerfTier('normal');

        this.connectObject(
            this.getSettings(),
            'changed',
            (_settings, key) => {
                if (key === 'music-reactive') {
                    this._initEffect();
                    this._syncAudioVisualizer();
                    return;
                }

                if (key === 'underglow') {
                    this._syncUnderglow();
                    return;
                }

                this._initEffect();
            },
        );

        this._lastFrameTime = GLib.get_monotonic_time();
        this._rescheduleFrameTimer(this._desiredFrameInterval(false));

        this.connectObject(
            Main.layoutManager,
            'monitors-changed',
            this._onMonitorsChanged.bind(this),
        );

        this._scheduleHeavyStartup();
    }

    _scheduleHeavyStartup() {
        if (this._deferredStartupId)
            GLib.source_remove(this._deferredStartupId);
        this._deferredStartupId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            HEAVY_STARTUP_DELAY_MS,
            () => {
                this._deferredStartupId = null;
                if (!this._canvas)
                    return GLib.SOURCE_REMOVE;
                try {
                    this._startHeavySubsystems();
                } catch (err) {
                    console.error('[CyberGlow] deferred startup failed:', err);
                }
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _startHeavySubsystems() {
        this._powerProfilesProxy = createPowerProfilesProxy();
        if (this._powerProfilesProxy) {
            this._setPerfTier(readPowerSaverActive(this._powerProfilesProxy) ? 'powerSaver' : 'normal');
            this.connectObject(
                this._powerProfilesProxy,
                'g-properties-changed',
                (_proxy, changed) => {
                    if (!('ActiveProfile' in changed))
                        return;
                    this._setPerfTier(readPowerSaverActive(this._powerProfilesProxy) ? 'powerSaver' : 'normal');
                },
            );
        }

        this._syncAudioVisualizer();
        this._syncUnderglow();
    }

    _syncUnderglow() {
        const enabled = this.getSettings().get_boolean('underglow');

        if (enabled) {
            if (this._underglow)
                return;

            try {
                this._underglow = new UnderglowManager(this.getSettings());
                this._underglow.enable();
            } catch (err) {
                console.error('[CyberGlow] failed to enable underglow:', err);
                this._underglow = null;
            }
            return;
        }

        if (this._underglow) {
            this._underglow.disable();
            this._underglow = null;
        }
    }

    disable() {
        if (this._enableRetrySource) {
            GLib.source_remove(this._enableRetrySource);
            this._enableRetrySource = null;
        }
        this._enableRetries = 0;

        if (this._deferredStartupId) {
            GLib.source_remove(this._deferredStartupId);
            this._deferredStartupId = null;
        }

        this.disconnectObject(Main.layoutManager);
        this.disconnectObject(this.getSettings());

        if (this._powerProfilesProxy) {
            this.disconnectObject(this._powerProfilesProxy);
            this._powerProfilesProxy = null;
        }

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._canvas) {
            this.disconnectObject(this._canvas);
            this._onRepaintHandler = null;
            this._canvas.destroy();
            this._canvas = null;
        }

        if (this._underglow) {
            this._underglow.disable();
            this._underglow = null;
        }

        if (this._audioVisualizer) {
            this._audioVisualizer.disable();
            this._audioVisualizer = null;
        }

        this._lastFrameTime = 0;
    }

    _initEffect() {
        const settings = this.getSettings();
        NeonShapeEffect.init(this._width, this._height, settings);
        NeonShapeEffect.setPerfTier(this._perfTier);
        NeonShapeEffect.setMusicReactive(settings.get_boolean('music-reactive'));
    }

    _syncAudioVisualizer() {
        const enabled = this.getSettings().get_boolean('music-reactive');
        NeonShapeEffect.setMusicReactive(enabled);
        this._underglow?.setAudioIntensity?.(1.0, 0);

        if (enabled) {
            if (!this._audioVisualizer) {
                try {
                    this._audioVisualizer = new AudioVisualizer();
                    this._audioVisualizer.enable();
                } catch (err) {
                    console.error('[CyberGlow] failed to enable audio visualizer:', err);
                    this._audioVisualizer = null;
                }
            }
        } else if (this._audioVisualizer) {
            this._audioVisualizer.disable();
            this._audioVisualizer = null;
        }

        const inFlicker = NeonShapeEffect.shape?.inFlickerEpisode ?? false;
        this._rescheduleFrameTimer(this._desiredFrameInterval(inFlicker));
    }

    _desiredFrameInterval(inFlicker) {
        const cfg = PERF_TIERS[this._perfTier] ?? PERF_TIERS.normal;
        let interval = inFlicker ? cfg.frameMsFlicker : cfg.frameMsCalm;

        if (!this.getSettings().get_boolean('music-reactive'))
            return interval;

        if (inFlicker)
            return Math.min(interval, NEON_AUDIO_FRAME_MS_FAST);

        const visualizer = this._audioVisualizer;
        if (!visualizer)
            return Math.min(interval, NEON_AUDIO_FRAME_MS_MED);

        if (visualizer.isSilent)
            return cfg.frameMsCalm;

        const activity = visualizer.activityLevel;
        if (activity > 0.28 || visualizer.beatPulse > 0.35)
            return NEON_AUDIO_FRAME_MS_FAST;
        if (activity > 0.05)
            return NEON_AUDIO_FRAME_MS_MED;
        return cfg.frameMsCalm;
    }

    _setPerfTier(tier) {
        if (tier !== 'powerSaver')
            tier = 'normal';
        if (this._perfTier === tier)
            return;
        this._perfTier = tier;
        NeonShapeEffect.setPerfTier(tier);
        const inFlicker = NeonShapeEffect.shape?.inFlickerEpisode ?? false;
        this._rescheduleFrameTimer(this._desiredFrameInterval(inFlicker));
    }

    _rescheduleFrameTimer(intervalMs) {
        if (this._timeoutId)
            GLib.source_remove(this._timeoutId);
        this._frameIntervalMs = intervalMs;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, intervalMs, () => {
            this._onFrame();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onMonitorsChanged() {
        const monitor = Main.layoutManager.primaryMonitor;
        this._width = monitor.width;
        this._height = monitor.height;

        if (this._canvas) {
            this._canvas.set_position(monitor.x, monitor.y);
            this._canvas.set_size(this._width, this._height);
        }

        NeonShapeEffect.init(this._width, this._height, this.getSettings());
    }

    _onFrame() {
        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastFrameTime) / 1000000, 0.1);
        this._lastFrameTime = now;

        const wasFlickering = NeonShapeEffect.shape?.inFlickerEpisode ?? false;
        if (this._audioVisualizer && this.getSettings().get_boolean('music-reactive')) {
            NeonShapeEffect.setAudioLevels({
                bass: this._audioVisualizer.bassLevel,
                mid: this._audioVisualizer.midLevel,
                treble: this._audioVisualizer.trebleLevel,
                beatPulse: this._audioVisualizer.beatPulse,
            });

        }
        NeonShapeEffect.update(dt);
        if (this._audioVisualizer && this.getSettings().get_boolean('music-reactive')) {
            const visualBeat = NeonShapeEffect._visualBeatPulse;
            this._underglow?.setAudioIntensity?.(
                1.0 + this._audioVisualizer.bassLevel * 0.5 + visualBeat * 0.22,
                visualBeat
            );
        }
        const inFlicker = NeonShapeEffect.shape?.inFlickerEpisode ?? false;
        const desiredInterval = this._desiredFrameInterval(inFlicker);
        if (desiredInterval !== this._frameIntervalMs || wasFlickering !== inFlicker)
            this._rescheduleFrameTimer(desiredInterval);
        this._canvas.queue_repaint();
    }

    _onRepaint(area) {
        const ctx = area.get_context();
        const width = area.get_width();
        const height = area.get_height();

        ctx.setOperator(Cairo.Operator.CLEAR);
        ctx.paint();
        ctx.setOperator(Cairo.Operator.OVER);

        NeonShapeEffect.draw(ctx, width, height);

        ctx.$dispose();
        return Clutter.EVENT_STOP;
    }
}
