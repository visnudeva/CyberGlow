import Clutter from 'gi://Clutter';
import Cairo from 'gi://cairo';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {UnderglowManager} from './lib/underglow.js';
import {AudioVisualizer} from './lib/audio-visualizer.js';
import {IdleInhibitor} from './lib/idle-inhibit.js';
import {CyberGlowIndicator} from './lib/indicator.js';
import {
    compressAudioEnvelope,
    createVisualBeatState,
    denseMixAttenuation,
    updateBandKick,
    updateVisualBeatPulse,
} from './lib/audio-levels.js';
import {ALLOWED_WINDOW_TYPES} from './lib/underglow-style.js';
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
// Live wallpapers (e.g. Laniakea) map windows well after login; keep restacking
// neon above those actors in window_group past that window.
const RAISE_CANVAS_DELAYS_MS = [500, 1100, 2000, 3000, 5000, 8000, 12000, 20000, 30000];
const RAISE_WATCH_INTERVAL_MS = 500;
const RAISE_WATCH_MAX_COUNT = 90; // 45s
// Laniakea's real renderer lives in window_group (above _backgroundGroup), so
// neon must share that layer and stack above the renderer actor.
const LANIAKEA_RENDERER_ID = 'io.github.visnudeva.LaniakeaRenderer';
const LANIAKEA_RENDERER_CMDLINE = 'laniakea-renderer';

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
        return clamp(this._settings.get_int('neon-shape'), 0, 7);
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
    _traceRoundedRectPath(ctx, cx, cy, halfW, halfH, cornerRadius) {
        const r = Math.min(cornerRadius, halfW, halfH);
        const left = cx - halfW;
        const right = cx + halfW;
        const top = cy - halfH;
        const bottom = cy + halfH;

        ctx.newPath();
        ctx.moveTo(left + r, top);
        ctx.lineTo(right - r, top);
        ctx.arc(right - r, top + r, r, -Math.PI / 2, 0);
        ctx.lineTo(right, bottom - r);
        ctx.arc(right - r, bottom - r, r, 0, Math.PI / 2);
        ctx.lineTo(left + r, bottom);
        ctx.arc(left + r, bottom - r, r, Math.PI / 2, Math.PI);
        ctx.lineTo(left, top + r);
        ctx.arc(left + r, top + r, r, Math.PI, Math.PI * 1.5);
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

        if (type === 4 || type === 5 || type === 6) {
            const wide = radius * (Math.sqrt(3) / 2);
            let halfW;
            let halfH;
            if (type === 4) {
                halfW = radius;
                halfH = radius * 0.5;
            } else if (type === 5) {
                halfW = wide;
                halfH = wide;
            } else {
                halfW = radius * 0.5;
                halfH = radius;
            }
            this._traceRoundedRectPath(ctx, cx, cy, halfW, halfH, cornerRadius);
            return;
        }

        if (type === 7) {
            this._traceRoundedPolygonPath(ctx, cx, cy, radius, 4, -Math.PI / 2, cornerRadius);
            return;
        }

        const sides = type === 3 ? 6 : 3;
        const rot = type === 1 ? Math.PI / 2 : -Math.PI / 2;
        this._traceRoundedPolygonPath(ctx, cx, cy, radius, sides, rot, cornerRadius);
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
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const w = monitor.width;
        const h = monitor.height;
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
        if (s.nextFlickerIn <= 0) {
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
        this._raiseCanvasTimeoutIds = [];
        this._raiseCanvasDebounceId = 0;
        this._raiseCanvasDelaysScheduled = false;
        this._raiseCanvasWatchId = 0;
        this._raiseCanvasWatchCount = 0;
        this._laniakeaPidCache = new Map(); // pid → boolean
        this._laniakeaPidPending = new Set();
        this._settings = null;
        this._windowGroup = null;
        this._idleInhibitor = null;
        this._indicator = null;
    }

    enable() {
        if (this._canvas || this._enableRetrySource || this._settings)
            return;

        this._settings = this.getSettings();
        this._indicator = new CyberGlowIndicator(this, this._settings);
        this._idleInhibitor = new IdleInhibitor();

        this._enableRetries = 0;

        // Wait until gnome-shell finishes startup before attaching into
        // window_group. Restacking during early Wayland map/configure races
        // have crashed mutter (xdg_toplevel_configure SIGSEGV) at login.
        const startWhenReady = () => {
            this._enableRetrySource = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                return this._enableWhenReady();
            });
        };

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject(
                'startup-complete',
                () => {
                    Main.layoutManager.disconnectObject(this);
                    startWhenReady();
                },
                this,
            );
        } else {
            startWhenReady();
        }
    }

    _enableWhenReady() {
        const windowGroup = global.window_group ?? global.windowGroup;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!windowGroup || !monitor) {
            this._enableRetries += 1;
            if (this._enableRetries > 120)
                console.error('[CyberGlow] window group/monitor never became ready');
            return this._enableRetries <= 120 ? GLib.SOURCE_CONTINUE : GLib.SOURCE_REMOVE;
        }

        this._enableRetrySource = null;
        this._enableInternal(windowGroup);
        return GLib.SOURCE_REMOVE;
    }

    _enableInternal(windowGroup) {
        this._windowGroup = windowGroup;
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            throw new Error('primary monitor unavailable');

        this._width = monitor.width;
        this._height = monitor.height;
        if (!this._settings)
            this._settings = this.getSettings();

        this._onRepaintHandler = this._onRepaint.bind(this);
        this._canvas = new St.DrawingArea({
            width: this._width,
            height: this._height,
            reactive: false,
            can_focus: false,
        });
        // Transparent outside neon strokes so the live-wallpaper clone (still in
        // `_backgroundGroup`) shows through; we live in window_group so we can
        // stack above Laniakea's real renderer window.
        this._canvas.set_style('background-color: transparent;');
        this._canvas.connectObject(
            'repaint',
            this._onRepaintHandler,
            this,
        );

        this._canvas.set_position(monitor.x, monitor.y);
        windowGroup.insert_child_at_index(this._canvas, 0);
        // Never restack synchronously from insert/child-added — defer.
        this._raiseCanvasSoon();

        this._windowGroup.connectObject(
            'child-added',
            (_group, child) => {
                if (child === this._canvas)
                    return;
                this._raiseCanvasSoon();
            },
            this,
        );

        this._scheduleRaiseCanvasToTop();
        this._initEffect();
        this._setPerfTier('normal');

        this._settings.connectObject(
            'changed',
            (_settings, key) => {
                if (key === 'neon-enabled') {
                    this._syncNeonEnabled();
                    return;
                }

                if (key === 'music-reactive') {
                    this._initEffect();
                    this._syncAudioVisualizer();
                    this._syncIdleInhibit();
                    return;
                }

                if (key === 'underglow') {
                    this._syncUnderglow();
                    return;
                }

                if (key === 'keep-awake') {
                    this._syncIdleInhibit();
                    return;
                }

                this._initEffect();
            },
            this,
        );

        this._syncNeonEnabled();

        Main.layoutManager.connectObject(
            'monitors-changed',
            () => {
                this._onMonitorsChanged();
                this._scheduleRaiseCanvasToTop();
                this._startCanvasRaiseWatch();
            },
            this,
        );

        Main.overview.connectObject(
            'showing',
            () => {
                if (this._canvas)
                    this._canvas.visible = false;
            },
            this,
        );
        Main.overview.connectObject(
            'hiding',
            () => {
                this._syncNeonEnabled();
                this._scheduleRaiseCanvasToTop();
            },
            this,
        );

        if (Main.layoutManager._startingUp) {
            Main.layoutManager.connectObject(
                'startup-complete',
                () => {
                    this._scheduleRaiseCanvasToTop();
                    this._startCanvasRaiseWatch();
                },
                this,
            );
        }

        global.workspace_manager.connectObject(
            'active-workspace-changed',
            () => {
                this._scheduleRaiseCanvasToTop();
                this._startCanvasRaiseWatch();
            },
            this,
        );

        // Keep neon below normal windows when the stack changes (raises, maps, etc.).
        global.display.connectObject(
            'restacked',
            () => this._raiseCanvasSoon(),
            'window-entered-monitor',
            () => this._raiseCanvasSoon(),
            this,
        );

        this._startCanvasRaiseWatch();
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
                this._startHeavySubsystems();
                return GLib.SOURCE_REMOVE;
            }
        );
    }

    _startHeavySubsystems() {
        this._powerProfilesProxy = createPowerProfilesProxy();
        if (this._powerProfilesProxy) {
            this._setPerfTier(readPowerSaverActive(this._powerProfilesProxy) ? 'powerSaver' : 'normal');
            this._powerProfilesProxy.connectObject(
                'g-properties-changed',
                (_proxy, changed) => {
                    if (!('ActiveProfile' in changed))
                        return;
                    this._setPerfTier(readPowerSaverActive(this._powerProfilesProxy) ? 'powerSaver' : 'normal');
                },
                this,
            );
        }

        this._syncAudioVisualizer();
        this._syncUnderglow();
        this._syncIdleInhibit();
    }

    _syncIdleInhibit() {
        if (!this._settings || !this._idleInhibitor)
            return;

        const want = this._settings.get_boolean('keep-awake')
            && this._settings.get_boolean('neon-enabled')
            && this._settings.get_boolean('music-reactive')
            && this._audioVisualizer
            && !this._audioVisualizer.isSilent;
        this._idleInhibitor.setActive(want);
    }

    _syncUnderglow() {
        const enabled = this._settings.get_boolean('underglow');

        if (enabled) {
            if (this._underglow)
                return;

            this._underglow = new UnderglowManager(this._settings);
            this._underglow.enable();
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

        for (const id of this._raiseCanvasTimeoutIds)
            GLib.source_remove(id);
        this._raiseCanvasTimeoutIds = [];
        this._raiseCanvasDelaysScheduled = false;

        if (this._raiseCanvasDebounceId) {
            GLib.source_remove(this._raiseCanvasDebounceId);
            this._raiseCanvasDebounceId = 0;
        }

        global.display.disconnectObject(this);

        this._laniakeaPidCache.clear();
        this._laniakeaPidPending.clear();
        this._stopCanvasRaiseWatch();

        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.workspace_manager.disconnectObject(this);
        this._settings?.disconnectObject(this);
        this._windowGroup?.disconnectObject(this);
        this._windowGroup = null;

        if (this._powerProfilesProxy) {
            this._powerProfilesProxy.disconnectObject(this);
            this._powerProfilesProxy = null;
        }

        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (this._canvas) {
            this._canvas.disconnectObject(this);
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

        this._indicator?.destroy();
        this._indicator = null;

        this._idleInhibitor?.destroy();
        this._idleInhibitor = null;
        this._lastFrameTime = 0;
        this._settings = null;
    }

    _syncNeonEnabled() {
        if (!this._settings || !this._canvas)
            return;

        const settingOn = this._settings.get_boolean('neon-enabled');
        this._canvas.visible = settingOn && !Main.overview?.visible;

        if (settingOn) {
            this._lastFrameTime = GLib.get_monotonic_time();
            this._rescheduleFrameTimer(this._desiredFrameInterval(false));
            if (this._canvas.visible)
                this._canvas.queue_repaint();
        } else if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        this._syncAudioVisualizer();
        this._syncIdleInhibit();
    }

    _decodeProcCmdline(bytes) {
        if (typeof bytes === 'string')
            return bytes;

        const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        let text = '';
        for (let i = 0; i < arr.length; i++)
            text += arr[i] === 0 ? ' ' : String.fromCharCode(arr[i]);
        return text;
    }

    _probeLaniakeaPid(pid) {
        if (this._laniakeaPidPending.has(pid))
            return;

        this._laniakeaPidPending.add(pid);
        const file = Gio.File.new_for_path(`/proc/${pid}/cmdline`);
        file.load_contents_async(null, (f, result) => {
            this._laniakeaPidPending.delete(pid);

            let matched = false;
            try {
                const [, bytes] = f.load_contents_finish(result);
                const text = this._decodeProcCmdline(bytes);
                matched = text.includes(LANIAKEA_RENDERER_CMDLINE)
                    || text.includes(LANIAKEA_RENDERER_ID);
            } catch {
                matched = false;
            }

            const previous = this._laniakeaPidCache.get(pid);
            this._laniakeaPidCache.set(pid, matched);
            if (matched && previous !== matched)
                this._raiseCanvasSoon();
        });
    }

    _isLaniakeaRendererPid(pid) {
        if (!pid || pid <= 0)
            return false;

        if (this._laniakeaPidCache.has(pid))
            return this._laniakeaPidCache.get(pid);

        // Async probe; treat as non-Laniakea until resolved, then restack.
        this._laniakeaPidCache.set(pid, false);
        this._probeLaniakeaPid(pid);
        return false;
    }

    _isLaniakeaRendererWindow(window) {
        if (!window)
            return false;

        const title = window.title ?? '';
        if (title.includes(LANIAKEA_RENDERER_ID) || title.includes('Laniakea Renderer'))
            return true;

        try {
            const gtkId = window.get_gtk_application_id?.();
            if (gtkId === LANIAKEA_RENDERER_ID)
                return true;
        } catch {
            // Meta API may be unavailable on some shells.
        }

        try {
            const wmClass = window.get_wm_class?.() ?? '';
            const wmInstance = window.get_wm_class_instance?.() ?? '';
            if (wmClass.includes('LaniakeaRenderer') || wmInstance.includes('LaniakeaRenderer'))
                return true;
        } catch {
            // Best-effort identity fallback.
        }

        try {
            const pid = window.get_pid?.() ?? 0;
            if (this._isLaniakeaRendererPid(pid))
                return true;
        } catch {
            // Best-effort.
        }

        return false;
    }

    _windowFromActor(actor) {
        if (!actor)
            return null;
        return actor.meta_window ?? actor.get_meta_window?.() ?? null;
    }

    // Solid app windows that must occlude neon. Menus, tooltips, and other
    // ephemeral popups (tab previews, etc.) are excluded — using them as the
    // stack ceiling lets restacks put neon above the real app window.
    _isOccludingWindowActor(actor) {
        if (!actor || actor === this._canvas)
            return false;

        const window = this._windowFromActor(actor);
        if (!window || this._isLaniakeaRendererWindow(window))
            return false;

        try {
            if (window.is_override_redirect?.())
                return false;
        } catch {
            // Best-effort; fall through to window-type check.
        }

        try {
            return ALLOWED_WINDOW_TYPES.has(window.get_window_type());
        } catch {
            // If type is unavailable, treat as occluder to avoid bleed-through.
            return true;
        }
    }

    // Any non-Laniakea surface that should punch a hole in neon painting.
    // Includes menus/tooltips so glow cannot show through them when a restack
    // briefly leaves the canvas above the parent app.
    _isNeonMaskWindowActor(actor) {
        if (!actor || actor === this._canvas)
            return false;

        try {
            if (!actor.visible)
                return false;
        } catch {
            return false;
        }

        const window = this._windowFromActor(actor);
        if (!window || this._isLaniakeaRendererWindow(window))
            return false;

        try {
            if (window.minimized)
                return false;
            if (window.showing_on_its_workspace && !window.showing_on_its_workspace())
                return false;
        } catch {
            // Best-effort visibility checks.
        }

        return true;
    }

    _actorRectInCanvas(actor, window) {
        const canvas = this._canvas;
        if (!canvas)
            return null;

        try {
            const frame = window?.get_frame_rect?.();
            if (frame && frame.width > 0 && frame.height > 0) {
                return {
                    x: frame.x - canvas.x,
                    y: frame.y - canvas.y,
                    width: frame.width,
                    height: frame.height,
                };
            }
        } catch {
            // Fall through to actor allocation.
        }

        try {
            return {
                x: actor.x - canvas.x,
                y: actor.y - canvas.y,
                width: actor.width,
                height: actor.height,
            };
        } catch {
            return null;
        }
    }

    // Keep neon pixels clear over windows/menus so stacking glitches cannot
    // paint glow on top of app content (transparent holes still composite).
    _clipNeonAwayFromWindows(ctx, width, height) {
        const group = this._windowGroup ?? global.window_group ?? global.windowGroup;
        if (!group || !ctx)
            return;

        let children;
        try {
            children = group.get_children();
        } catch {
            return;
        }

        let punched = false;
        try {
            ctx.setFillRule(Cairo.FillRule.EVEN_ODD);
        } catch {
            // Older cairo bindings may lack FillRule; skip masking.
            return;
        }

        ctx.rectangle(0, 0, width, height);

        for (let i = 0; i < children.length; i++) {
            const actor = children[i];
            if (!this._isNeonMaskWindowActor(actor))
                continue;

            const window = this._windowFromActor(actor);
            const rect = this._actorRectInCanvas(actor, window);
            if (!rect || rect.width <= 0 || rect.height <= 0)
                continue;
            if (rect.x + rect.width <= 0 || rect.y + rect.height <= 0)
                continue;
            if (rect.x >= width || rect.y >= height)
                continue;

            ctx.rectangle(rect.x, rect.y, rect.width, rect.height);
            punched = true;
        }

        if (punched)
            ctx.clip();
    }

    _raiseCanvasToTop() {
        const group = this._windowGroup ?? global.window_group ?? global.windowGroup;
        const canvas = this._canvas;
        if (!group || !canvas || canvas.is_finalized?.())
            return;

        // Skip while shell is still starting — window actors may not be
        // configure-ready and sibling restacks can trip mutter bugs.
        if (Main.layoutManager._startingUp)
            return;

        try {
            // Reattach into window_group if a restack orphaned us.
            if (!group.contains(canvas)) {
                const parent = canvas.get_parent?.();
                if (parent && parent !== group) {
                    try {
                        parent.remove_child(canvas);
                    } catch {
                        // Actor may already be detached during shell teardown.
                    }
                }
                if (!group.contains(canvas))
                    group.insert_child_at_index(canvas, 0);
            }

            let children;
            try {
                children = group.get_children();
            } catch {
                children = [];
            }

            // Stay above Laniakea renderers but below the first solid app window.
            // Ignore menus/tooltips as ceiling — hover restacks made those leap
            // neon over the parent app.
            let ceiling = null;
            let topLaniakea = null;

            for (let i = 0; i < children.length; i++) {
                const actor = children[i];
                if (this._isOccludingWindowActor(actor)) {
                    ceiling = actor;
                    break;
                }
            }

            for (let i = children.length - 1; i >= 0; i--) {
                const actor = children[i];
                if (actor === canvas)
                    continue;

                const window = this._windowFromActor(actor);
                if (window && this._isLaniakeaRendererWindow(window)) {
                    topLaniakea = actor;
                    break;
                }
            }

            if (ceiling)
                group.set_child_below_sibling(canvas, ceiling);
            else if (topLaniakea)
                group.set_child_above_sibling(canvas, topLaniakea);
            else
                group.set_child_at_index(canvas, 0);

            // If a Laniakea renderer sits below the ceiling but above us, climb
            // above it without passing the solid-app ceiling.
            try {
                children = group.get_children();
            } catch {
                children = [];
            }
            let canvasIndex = children.indexOf(canvas);
            const ceilingIndex = ceiling ? children.indexOf(ceiling) : -1;
            if (canvasIndex >= 0) {
                for (let i = children.length - 1; i >= 0; i--) {
                    if (i <= canvasIndex)
                        break;
                    if (ceilingIndex >= 0 && i >= ceilingIndex)
                        continue;

                    const window = this._windowFromActor(children[i]);
                    if (window && this._isLaniakeaRendererWindow(window)) {
                        group.set_child_above_sibling(canvas, children[i]);
                        break;
                    }
                }
            }

            // Safety clamp: never paint above any solid app (Laniakea or a popup
            // restack can leave us above an occluder after the placement above).
            try {
                children = group.get_children();
            } catch {
                children = [];
            }
            canvasIndex = children.indexOf(canvas);
            if (canvasIndex > 0) {
                for (let i = 0; i < canvasIndex; i++) {
                    if (this._isOccludingWindowActor(children[i])) {
                        group.set_child_below_sibling(canvas, children[i]);
                        break;
                    }
                }
            }

            if (this._settings?.get_boolean('neon-enabled') && !Main.overview?.visible)
                canvas.visible = true;
        } catch (err) {
            console.error('[CyberGlow] failed to restack neon canvas:', err);
        }
    }

    _raiseCanvasSoon() {
        if (this._raiseCanvasDebounceId)
            return;

        // Idle (not a 32ms timer): menu/tab restacks must correct before paint.
        this._raiseCanvasDebounceId = GLib.idle_add(GLib.PRIORITY_HIGH_IDLE, () => {
            this._raiseCanvasDebounceId = 0;
            this._raiseCanvasToTop();
            this._canvas?.queue_repaint();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleRaiseCanvasDelays() {
        if (this._raiseCanvasDelaysScheduled)
            return;
        this._raiseCanvasDelaysScheduled = true;

        for (const delay of RAISE_CANVAS_DELAYS_MS) {
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                const index = this._raiseCanvasTimeoutIds.indexOf(id);
                if (index >= 0)
                    this._raiseCanvasTimeoutIds.splice(index, 1);
                this._raiseCanvasToTop();
                this._canvas?.queue_repaint();
                return GLib.SOURCE_REMOVE;
            });
            this._raiseCanvasTimeoutIds.push(id);
        }
    }

    _scheduleRaiseCanvasToTop() {
        this._raiseCanvasSoon();
        this._scheduleRaiseCanvasDelays();
    }

    _stopCanvasRaiseWatch() {
        if (this._raiseCanvasWatchId) {
            GLib.source_remove(this._raiseCanvasWatchId);
            this._raiseCanvasWatchId = 0;
        }
        this._raiseCanvasWatchCount = 0;
    }

    _startCanvasRaiseWatch() {
        this._stopCanvasRaiseWatch();
        this._raiseCanvasWatchId = GLib.timeout_add(
            GLib.PRIORITY_DEFAULT,
            RAISE_WATCH_INTERVAL_MS,
            () => {
                this._raiseCanvasToTop();
                this._raiseCanvasWatchCount += 1;
                if (this._raiseCanvasWatchCount >= RAISE_WATCH_MAX_COUNT) {
                    this._raiseCanvasWatchId = 0;
                    return GLib.SOURCE_REMOVE;
                }
                return GLib.SOURCE_CONTINUE;
            },
        );
    }

    _initEffect() {
        NeonShapeEffect.init(this._width, this._height, this._settings);
        NeonShapeEffect.setPerfTier(this._perfTier);
        NeonShapeEffect.setMusicReactive(this._settings.get_boolean('music-reactive'));
    }

    _syncAudioVisualizer() {
        const enabled = this._settings.get_boolean('neon-enabled')
            && this._settings.get_boolean('music-reactive');
        NeonShapeEffect.setMusicReactive(enabled);
        this._underglow?.setAudioIntensity?.(1.0, 0);

        if (enabled) {
            if (!this._audioVisualizer) {
                this._audioVisualizer = new AudioVisualizer();
                this._audioVisualizer.enable();
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

        if (!this._settings?.get_boolean('neon-enabled'))
            return interval;

        if (!this._settings.get_boolean('music-reactive'))
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
        if (this._timeoutId) {
            GLib.source_remove(this._timeoutId);
            this._timeoutId = null;
        }

        if (!this._settings?.get_boolean('neon-enabled'))
            return;

        this._frameIntervalMs = intervalMs;
        this._timeoutId = GLib.timeout_add(GLib.PRIORITY_LOW, intervalMs, () => {
            this._onFrame();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _onMonitorsChanged() {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;

        this._width = monitor.width;
        this._height = monitor.height;

        if (this._canvas) {
            this._canvas.set_position(monitor.x, monitor.y);
            this._canvas.set_size(this._width, this._height);
        }

        NeonShapeEffect.init(this._width, this._height, this._settings);
        this._raiseCanvasDelaysScheduled = false;
    }

    _onFrame() {
        if (!this._settings?.get_boolean('neon-enabled'))
            return;

        const now = GLib.get_monotonic_time();
        const dt = Math.min((now - this._lastFrameTime) / 1000000, 0.1);
        this._lastFrameTime = now;

        const wasFlickering = NeonShapeEffect.shape?.inFlickerEpisode ?? false;
        const musicReactive = this._settings.get_boolean('music-reactive');
        if (this._audioVisualizer && musicReactive) {
            NeonShapeEffect.setAudioLevels({
                bass: this._audioVisualizer.bassLevel,
                mid: this._audioVisualizer.midLevel,
                treble: this._audioVisualizer.trebleLevel,
                beatPulse: this._audioVisualizer.beatPulse,
            });

        }
        NeonShapeEffect.update(dt);
        if (this._audioVisualizer && musicReactive) {
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
        this._syncIdleInhibit();
        this._canvas.queue_repaint();
    }

    _onRepaint(area) {
        const ctx = area.get_context();
        const width = area.get_width();
        const height = area.get_height();

        ctx.setOperator(Cairo.Operator.CLEAR);
        ctx.paint();
        ctx.setOperator(Cairo.Operator.OVER);

        if (this._settings?.get_boolean('neon-enabled')) {
            // Clear over window/menu rects so glow cannot bleed through even when
            // a restack momentarily leaves the canvas above an app.
            this._clipNeonAwayFromWindows(ctx, width, height);
            NeonShapeEffect.draw(ctx, width, height);
        }

        ctx.$dispose();
        return Clutter.EVENT_STOP;
    }
}
