import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    buildShadowStyle,
    canHaveUnderglow,
    clampedContentOffset,
    contentOffset,
    getShadowPadding,
    isUnderglowGeometrySane,
    maxDecorationInset,
    parseWindowRadiusFromCss,
    scaledThickness,
    shouldShowUnderglow,
    THICKNESS_SCALE,
} from '../lib/underglow-style.js';

function mockWindow({
    type = 0,
    overrideRedirect = false,
    maximizedH = false,
    maximizedV = false,
    fullscreen = false,
    frame = {x: 100, y: 80, width: 840, height: 640},
    buffer = {x: 120, y: 120, width: 800, height: 600},
} = {}) {
    return {
        get_window_type: () => type,
        is_override_redirect: () => overrideRedirect,
        maximizedHorizontally: maximizedH,
        maximizedVertically: maximizedV,
        fullscreen,
        get_frame_rect: () => ({...frame}),
        get_buffer_rect: () => ({...buffer}),
    };
}

describe('underglow-style', () => {
    it('scaledThickness applies the glow scale factor', () => {
        assert.equal(scaledThickness(10), 10 * THICKNESS_SCALE);
    });

    it('parseWindowRadiusFromCss reads libadwaita-style variables', () => {
        const css = ':root { --window-radius: 12px; }';
        assert.equal(parseWindowRadiusFromCss(css), 12);

        const nested = 'body { color: red; }\n--window-radius: 8px;';
        assert.equal(parseWindowRadiusFromCss(nested), 8);
        assert.equal(parseWindowRadiusFromCss(''), null);
    });

    it('getShadowPadding scales and rounds the base padding', () => {
        assert.equal(getShadowPadding(), Math.max(2, Math.round(28 * THICKNESS_SCALE)));
    });

    it('buildShadowStyle hides glow when requested', () => {
        const hidden = buildShadowStyle([0, 1, 0.8], true, true, 12);
        assert.match(hidden, /opacity:\s*0/);
        assert.match(hidden, /box-shadow:\s*none/);
    });

    it('buildShadowStyle emits focused and unfocused bloom strengths', () => {
        const color = [0, 1, 0.8];
        const focused = buildShadowStyle(color, true, false, 12);
        const unfocused = buildShadowStyle(color, false, false, 12);
        const boosted = buildShadowStyle(color, true, false, 12, 1.4);

        assert.match(focused, /border-radius:\s*12px/);
        assert.match(focused, /rgba\(0,255,204,1\)/);
        assert.match(unfocused, /rgba\(0,255,204,0\.9\)/);
        assert.match(boosted, /rgba\(0,255,204,1\.4\)/);
    });

    it('canHaveUnderglow accepts normal app windows only', () => {
        assert.equal(canHaveUnderglow(mockWindow({type: 0})), true);
        assert.equal(canHaveUnderglow(mockWindow({type: 3})), true);
        assert.equal(canHaveUnderglow(mockWindow({type: 1})), false);
        assert.equal(canHaveUnderglow(mockWindow({overrideRedirect: true})), false);
        assert.equal(canHaveUnderglow(null), false);
    });

    it('isUnderglowGeometrySane accepts normal and CSD shadow insets', () => {
        assert.equal(isUnderglowGeometrySane(mockWindow()), true);
        assert.equal(isUnderglowGeometrySane(mockWindow({
            frame: {x: 100, y: 80, width: 800, height: 600},
            buffer: {x: 108, y: 88, width: 816, height: 616},
        })), true);
        assert.equal(isUnderglowGeometrySane(mockWindow({
            frame: {x: 0, y: 0, width: 1920, height: 1080},
            buffer: {x: 100, y: 50, width: 800, height: 600},
        })), false);
        assert.equal(isUnderglowGeometrySane(mockWindow({
            frame: {x: 100, y: 80, width: 840, height: 640},
            buffer: {x: 120, y: 120, width: 900, height: 700},
        })), true);
    });

    it('contentOffset reports frame/buffer deltas', () => {
        assert.deepEqual(contentOffset(mockWindow()), [-20, -40, 40, 40]);
        assert.deepEqual(contentOffset(null), [0, 0, 0, 0]);
    });

    it('maxDecorationInset scales with window size', () => {
        assert.equal(maxDecorationInset({width: 800, height: 600}), 240);
        assert.equal(maxDecorationInset({width: 0, height: 0}), 96);
        assert.equal(maxDecorationInset(null), 96);
    });

    it('clampedContentOffset limits extreme frame/buffer mismatches', () => {
        const offsets = clampedContentOffset(mockWindow({
            frame: {x: 0, y: 0, width: 1920, height: 1080},
            buffer: {x: 100, y: 50, width: 800, height: 600},
        }));

        assert.deepEqual(offsets, [-100, -50, 576, 480]);
    });

    it('shouldShowUnderglow rejects maximized, fullscreen, and transitional windows', () => {
        assert.equal(shouldShowUnderglow(mockWindow()), true);
        assert.equal(shouldShowUnderglow(mockWindow({maximizedH: true})), false);
        assert.equal(shouldShowUnderglow(mockWindow({maximizedV: true})), false);
        assert.equal(shouldShowUnderglow(mockWindow({fullscreen: true})), false);
        assert.equal(shouldShowUnderglow(mockWindow({type: 1})), false);
        assert.equal(shouldShowUnderglow(mockWindow({
            frame: {x: 0, y: 0, width: 1920, height: 1080},
            buffer: {x: 100, y: 50, width: 800, height: 600},
        })), false);
    });
});
