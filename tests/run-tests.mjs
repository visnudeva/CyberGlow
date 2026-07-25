#!/usr/bin/env node
/**
 * Lightweight ESM test runner for CyberGlow pure modules + EGO review checks.
 * Run: node tests/run-tests.mjs
 */

import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync, readdirSync} from 'node:fs';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

let passed = 0;
let failed = 0;
const failures = [];

function test(name, fn) {
    try {
        fn();
        passed++;
        console.log(`  ✓ ${name}`);
    } catch (err) {
        failed++;
        failures.push({name, err});
        console.log(`  ✗ ${name}`);
        console.log(`    ${err.message}`);
    }
}

function suite(name) {
    console.log(`\n${name}`);
}

function importLib(relPath) {
    return import(pathToFileURL(join(root, relPath)).href);
}

suite('lib/utils.js');
const {
    lerp, clamp, monitorDeviceNameFromSink, colorChannelsToRgb01,
    parseColorStringToRgb01, rgb01ToCss, getGlowWidthPasses,
} = await importLib('lib/utils.js');

test('lerp interpolates', () => {
    assert.equal(lerp(0, 10, 0.5), 5);
    assert.equal(lerp(2, 4, 0), 2);
    assert.equal(lerp(2, 4, 1), 4);
});

test('clamp bounds values', () => {
    assert.equal(clamp(5, 0, 10), 5);
    assert.equal(clamp(-1, 0, 10), 0);
    assert.equal(clamp(99, 0, 10), 10);
});

test('monitorDeviceNameFromSink appends .monitor', () => {
    assert.equal(monitorDeviceNameFromSink('alsa_output.pci'), 'alsa_output.pci.monitor');
    assert.equal(monitorDeviceNameFromSink('  sink  '), 'sink.monitor');
    assert.equal(monitorDeviceNameFromSink(''), null);
    assert.equal(monitorDeviceNameFromSink(null), null);
});

test('parseColorStringToRgb01 parses hex and rgb', () => {
    assert.deepEqual(parseColorStringToRgb01('#00ffcc'), [0, 1, 204 / 255]);
    assert.deepEqual(parseColorStringToRgb01('rgb(0, 255, 128)'), [0, 1, 128 / 255]);
    assert.deepEqual(parseColorStringToRgb01('rgba(1.0, 0.5, 0.0, 1)'), [1, 0.5, 0]);
    assert.equal(parseColorStringToRgb01('not-a-color'), null);
    assert.equal(parseColorStringToRgb01(''), null);
});

test('colorChannelsToRgb01 handles 0-1 and 0-255', () => {
    assert.deepEqual(colorChannelsToRgb01(0.2, 0.4, 0.6), [0.2, 0.4, 0.6]);
    assert.deepEqual(colorChannelsToRgb01(255, 0, 128), [1, 0, 128 / 255]);
});

test('rgb01ToCss formats channels', () => {
    assert.equal(rgb01ToCss(0, 1, 0.5), '0,255,128');
});

test('getGlowWidthPasses returns decreasing widths', () => {
    const passes = getGlowWidthPasses(1.15, 5);
    assert.equal(passes.length, 5);
    assert.ok(passes[0].w > passes[passes.length - 1].w);
    assert.ok(passes[0].alphaScale < passes[passes.length - 1].alphaScale);
    assert.equal(getGlowWidthPasses(1.15, 5), passes);
});

suite('lib/audio-levels.js');
const {
    mixBandDb, dbToRawLevel, smoothLevel, updateNoiseFloor, effectiveThreshold,
    createBeatDetectorState, resetBeatDetector, updateBeatDetector,
    hasAudibleActivity, isSteadyAmbientEnergy, combinedBeatEnergy,
    createVisualBeatState, updateVisualBeatPulse,
    denseMixAttenuation, updateBandKick, BAND_RANGES, SPECTRUM_BANDS,
} = await importLib('lib/audio-levels.js');

function fakeMagnitudes(values) {
    return {
        n_values: values.length,
        get_nth(i) {
            return values[i];
        },
    };
}

test('SPECTRUM_BANDS and BAND_RANGES cover 16 bands', () => {
    assert.equal(SPECTRUM_BANDS, 16);
    assert.equal(BAND_RANGES.bass[1] - BAND_RANGES.bass[0], 4);
    assert.equal(BAND_RANGES.treble[1], 16);
});

test('mixBandDb averages and peaks', () => {
    const mags = fakeMagnitudes([-40, -30, -50, -20]);
    const mixed = mixBandDb(mags, 0, 4);
    assert.ok(mixed > -40);
    assert.ok(mixed <= -20);
    assert.equal(mixBandDb(null, 0, 4), null);
});

test('dbToRawLevel maps silence near zero and loud signal high', () => {
    assert.ok(dbToRawLevel(-76, -76) < 0.05);
    assert.ok(dbToRawLevel(-20, -76) > 0.5);
});

test('smoothLevel attacks faster than decays', () => {
    const attack = smoothLevel(0, 1, false, 0.9, 0.5, 0.8);
    const decay = smoothLevel(1, 0, false, 0.9, 0.5, 0.8);
    assert.ok(attack > 0.8);
    assert.ok(decay < 0.6);
});

test('noise floor and threshold calibration', () => {
    let floor = -76;
    floor = updateNoiseFloor(floor, -60);
    assert.ok(floor > -76);
    assert.ok(floor < -60);
    assert.equal(effectiveThreshold(-76, -50, 8), -42);
});

test('beat detector fires on onset and decays', () => {
    const state = createBeatDetectorState();
    for (let i = 0; i < 8; i++)
        updateBeatDetector(state, 0.2, 0.05);

    assert.equal(updateBeatDetector(state, 0.85, 0.05), 1.0);

    let later = 1;
    for (let i = 0; i < 20; i++)
        later = updateBeatDetector(state, 0.2, 0.05);
    assert.ok(later < 1.0);

    resetBeatDetector(state);
    assert.equal(state.beatPulse, 0);
    assert.equal(state.energyHistory.length, 0);
});

test('hasAudibleActivity and steady ambient detection', () => {
    assert.equal(hasAudibleActivity(0.2, 0, 0), true);
    assert.equal(hasAudibleActivity(0.01, 0.01, 0.01), false);
    assert.equal(isSteadyAmbientEnergy([0.2, 0.21, 0.19, 0.2, 0.205, 0.198]), true);
    assert.equal(isSteadyAmbientEnergy([0.1, 0.9, 0.1, 0.9, 0.1, 0.9]), false);
});

test('combinedBeatEnergy gates bass', () => {
    assert.equal(combinedBeatEnergy(0.08, 1, 1), 0);
    assert.ok(combinedBeatEnergy(1, 0, 0) > 0.9);
});

test('visual beat pulse and dense mix helpers', () => {
    const state = createVisualBeatState();
    updateVisualBeatPulse(state, 1, 0.016);
    assert.ok(state.pulse > 0.5);

    assert.equal(denseMixAttenuation(0.1, 0.1, 0.1), 1.0);
    assert.ok(denseMixAttenuation(0.9, 0.9, 0.9) < 1.0);
});

test('updateBandKick tracks rising bass transient', () => {
    const state = {average: 0};
    const kick = updateBandKick(state, 0.8);
    assert.ok(kick > 0);
    assert.ok(state.average > 0);
    assert.ok(state.average < 0.8);
});

suite('lib/underglow-style.js');
const {
    parseWindowRadiusFromCss, getShadowPadding, buildShadowStyle,
    canHaveUnderglow, shouldShowUnderglow, contentOffset,
    clampedContentOffset, isUnderglowGeometrySane, ALLOWED_WINDOW_TYPES,
    scaledThickness, DEFAULT_WINDOW_RADIUS,
} = await importLib('lib/underglow-style.js');

function mockWin({
    type = 0,
    overrideRedirect = false,
    maximizedH = false,
    maximizedV = false,
    fullscreen = false,
    frame = {x: 100, y: 100, width: 800, height: 600},
    buffer = {x: 100, y: 100, width: 800, height: 600},
} = {}) {
    return {
        get_window_type: () => type,
        is_override_redirect: () => overrideRedirect,
        maximizedHorizontally: maximizedH,
        maximizedVertically: maximizedV,
        fullscreen,
        get_frame_rect: () => frame,
        get_buffer_rect: () => buffer,
    };
}

test('parseWindowRadiusFromCss reads --window-radius', () => {
    assert.equal(parseWindowRadiusFromCss(':root { --window-radius: 14px; }'), 14);
    assert.equal(parseWindowRadiusFromCss('--window-radius: 8.5px;'), 8.5);
    assert.equal(parseWindowRadiusFromCss('no radius here'), null);
    assert.equal(parseWindowRadiusFromCss(''), null);
});

test('getShadowPadding and scaledThickness', () => {
    assert.ok(getShadowPadding() >= 2);
    assert.equal(scaledThickness(2), 2 * 4.5);
    assert.equal(DEFAULT_WINDOW_RADIUS, 12);
});

test('buildShadowStyle hides maximized and styles visible windows', () => {
    const hidden = buildShadowStyle([0, 1, 0.8], true, true, 12);
    assert.match(hidden, /opacity:\s*0/);
    assert.match(hidden, /box-shadow:\s*none/);

    const shown = buildShadowStyle([0, 1, 0.8], true, false, 12, 1.2);
    assert.match(shown, /border-radius:\s*12px/);
    assert.match(shown, /box-shadow:/);
    assert.match(shown, /rgba\(0,255,204,/);
});

test('canHaveUnderglow filters window types', () => {
    assert.equal(canHaveUnderglow(null), false);
    assert.equal(canHaveUnderglow(mockWin({type: 0})), true);
    assert.equal(canHaveUnderglow(mockWin({type: 1})), false);
    assert.equal(canHaveUnderglow(mockWin({overrideRedirect: true})), false);
    assert.ok(ALLOWED_WINDOW_TYPES.has(0));
    assert.ok(ALLOWED_WINDOW_TYPES.has(3));
});

test('shouldShowUnderglow hides maximized and bad geometry', () => {
    assert.equal(shouldShowUnderglow(mockWin()), true);
    assert.equal(shouldShowUnderglow(mockWin({maximizedH: true})), false);
    assert.equal(shouldShowUnderglow(mockWin({fullscreen: true})), false);
    assert.equal(shouldShowUnderglow(mockWin({
        buffer: {x: 0, y: 0, width: 10, height: 10},
        frame: {x: 0, y: 0, width: 800, height: 600},
    })), false);
});

test('contentOffset and clampedContentOffset', () => {
    const win = mockWin({
        buffer: {x: 90, y: 80, width: 820, height: 640},
        frame: {x: 100, y: 100, width: 800, height: 600},
    });
    assert.deepEqual(contentOffset(win), [10, 20, -20, -40]);
    assert.equal(clampedContentOffset(win).length, 4);
    assert.equal(isUnderglowGeometrySane(win), true);
    assert.equal(isUnderglowGeometrySane(null), false);
});

suite('lib/gtk-shadow-cleanup.js');
const {
    removeGtkShadowBlock, GTK_SHADOW_MARKER_BEGIN, GTK_SHADOW_MARKER_END,
} = await importLib('lib/gtk-shadow-cleanup.js');

test('removeGtkShadowBlock strips marked blocks and preserves other CSS', () => {
    const css = `/* user css */
${GTK_SHADOW_MARKER_BEGIN}
window.csd decoration { box-shadow: none; }
${GTK_SHADOW_MARKER_END}
.other { color: red; }`;
    const cleaned = removeGtkShadowBlock(css);
    assert.ok(!cleaned.includes(GTK_SHADOW_MARKER_BEGIN));
    assert.ok(cleaned.includes('.other { color: red; }'));
    assert.ok(cleaned.includes('/* user css */'));
    assert.equal(removeGtkShadowBlock(''), '');
    assert.equal(removeGtkShadowBlock(null), '');
});

suite('EGO review compliance');
const metadata = JSON.parse(readFileSync(join(root, 'metadata.json'), 'utf8'));
const extensionJs = readFileSync(join(root, 'extension.js'), 'utf8');
const prefsJs = readFileSync(join(root, 'prefs.js'), 'utf8');
const audioPactl = readFileSync(join(root, 'lib/audio-pactl.js'), 'utf8');
const audioViz = readFileSync(join(root, 'lib/audio-visualizer.js'), 'utf8');
const underglow = readFileSync(join(root, 'lib/underglow.js'), 'utf8');
const indicator = readFileSync(join(root, 'lib/indicator.js'), 'utf8');
const idleInhibit = readFileSync(join(root, 'lib/idle-inhibit.js'), 'utf8');
const coreSources = [extensionJs, prefsJs, audioPactl, audioViz, underglow, indicator, idleInhibit];

test('metadata has no preferences key', () => {
    assert.equal('preferences' in metadata, false);
});

test('metadata donations.kofi is correct', () => {
    assert.deepEqual(metadata.donations, {kofi: 'visnu_deva'});
});

test('audio-pactl uses D-Bus, not spawn', () => {
    assert.ok(audioPactl.includes('Gio.DBusProxy'));
    assert.equal(/GLib\.spawn|spawn_command|spawn_async/.test(audioPactl), false);
});

test('audio-visualizer checks Gst.is_initialized before init', () => {
    assert.ok(audioViz.includes('Gst.is_initialized()'));
    assert.match(audioViz, /is_initialized\(\)[\s\S]{0,120}Gst\.init/);
});

test('no this._enabled flag pattern in core modules', () => {
    for (const src of [extensionJs, underglow, audioViz, idleInhibit, indicator])
        assert.equal(/this\._enabled\b/.test(src), false);
});

test('extension/underglow/audio use INSTANCE.connectObject / disconnectObject', () => {
    for (const src of [extensionJs, underglow, audioViz, indicator]) {
        assert.ok(src.includes('.connectObject('));
        assert.ok(src.includes('.disconnectObject(this)') || src.includes('.disconnectObject(item)'));
        assert.equal(/this\.connectObject\(/.test(src), false);
        assert.equal(/this\.disconnectObject\(\)/.test(src), false);
    }
});

test('prefs.js does not use connectObject; cleans up on close-request', () => {
    assert.equal(prefsJs.includes('connectObject'), false);
    assert.ok(prefsJs.includes("window.connect('close-request'"));
    assert.ok(prefsJs.includes('obj.disconnect(id)'));
});

test('frame timeout cleared before reschedule and on disable', () => {
    assert.ok(extensionJs.includes('_rescheduleFrameTimer'));
    assert.match(
        extensionJs,
        /_rescheduleFrameTimer\(intervalMs\)\s*\{[\s\S]*?if \(this\._timeoutId\)\s*\{[\s\S]*?GLib\.source_remove\(this\._timeoutId\)/
    );
    assert.match(
        extensionJs,
        /disable\(\)\s*\{[\s\S]*?if \(this\._timeoutId\)\s*\{[\s\S]*?GLib\.source_remove\(this\._timeoutId\)/
    );
});

test('single shared settings instance (one getSettings in extension)', () => {
    const calls = extensionJs.match(/this\.getSettings\(\)/g) ?? [];
    assert.equal(calls.length, 1);
    assert.ok(extensionJs.includes('new CyberGlowIndicator(this, this._settings)'));
    assert.ok(indicator.includes('_init(extension, settings)'));
    assert.equal(indicator.includes('getSettings('), false);
});

test('underglow disable fully cleans up (no selective disable)', () => {
    assert.match(
        underglow,
        /disable\(\)\s*\{[\s\S]*?_disconnectGlobalSignals[\s\S]*?_removeUnderglow/
    );
    assert.equal(/if\s*\(\s*!this\._enabled\s*\)/.test(underglow), false);
});

test('no debug console.log in shipped modules', () => {
    for (const src of coreSources)
        assert.equal(/console\.(log|debug|info)\(/.test(src), false);
});

test('idle inhibit uses SessionManager D-Bus, not spawn', () => {
    assert.ok(idleInhibit.includes('org.gnome.SessionManager'));
    assert.equal(/GLib\.spawn|spawn_command|spawn_async/.test(idleInhibit), false);
});

test('all JS modules parse with node --check', () => {
    const files = [
        'extension.js', 'prefs.js',
        ...readdirSync(join(root, 'lib')).filter(f => f.endsWith('.js')).map(f => `lib/${f}`),
    ];
    for (const file of files)
        execFileSync(process.execPath, ['--check', join(root, file)], {stdio: 'pipe'});
});

console.log(`\n${'─'.repeat(48)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length) {
    console.log('\nFailures:');
    for (const {name, err} of failures) {
        console.log(`\n• ${name}`);
        console.log(err.stack);
    }
    process.exit(1);
}
