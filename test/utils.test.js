import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    clamp,
    colorChannelsToRgb01,
    decodeSpawnStdout,
    expRand,
    getGlowWidthPasses,
    lerp,
    monitorDeviceNameFromSink,
    parseColorStringToRgb01,
    rgb01ToCss,
} from '../lib/utils.js';

describe('utils', () => {
    it('lerp interpolates between endpoints', () => {
        assert.equal(lerp(0, 10, 0), 0);
        assert.equal(lerp(0, 10, 1), 10);
        assert.equal(lerp(0, 10, 0.5), 5);
    });

    it('clamp limits values to the given range', () => {
        assert.equal(clamp(5, 0, 10), 5);
        assert.equal(clamp(-1, 0, 10), 0);
        assert.equal(clamp(15, 0, 10), 10);
    });

    it('colorChannelsToRgb01 normalizes 0-255 and 0-1 inputs', () => {
        assert.deepEqual(colorChannelsToRgb01(0, 255, 128), [0, 1, 128 / 255]);
        assert.deepEqual(colorChannelsToRgb01(0.2, 0.4, 0.6), [0.2, 0.4, 0.6]);
    });

    it('parseColorStringToRgb01 parses hex and rgb strings', () => {
        assert.deepEqual(parseColorStringToRgb01('#00ffcc'), [0, 1, 204 / 255]);
        assert.deepEqual(parseColorStringToRgb01('rgb(0, 255, 204)'), [0, 1, 204 / 255]);
        assert.deepEqual(parseColorStringToRgb01('rgba(0, 255, 204, 0.5)'), [0, 1, 204 / 255]);
        assert.equal(parseColorStringToRgb01('not-a-color'), null);
        assert.equal(parseColorStringToRgb01(''), null);
    });

    it('rgb01ToCss converts normalized channels to css tuples', () => {
        assert.equal(rgb01ToCss(0, 1, 204 / 255), '0,255,204');
    });

    it('getGlowWidthPasses returns sorted glow layers with caching', () => {
        const passes = getGlowWidthPasses(1.15, 5);
        assert.equal(passes.length, 5);
        assert.ok(passes[0].w > passes[4].w);
        assert.ok(passes[0].alphaScale < passes[4].alphaScale);
        assert.equal(getGlowWidthPasses(1.15, 5), passes);
    });

    it('expRand returns positive values scaled by mean', () => {
        const random = Math.random;
        Math.random = () => 0.5;
        try {
            assert.equal(expRand(10), -Math.log(0.5) * 10);
            assert.ok(expRand(0) > 0);
        } finally {
            Math.random = random;
        }
    });

    it('monitorDeviceNameFromSink appends the monitor suffix', () => {
        assert.equal(monitorDeviceNameFromSink('alsa_output.pci'), 'alsa_output.pci.monitor');
        assert.equal(monitorDeviceNameFromSink('  default-sink\n'), 'default-sink.monitor');
        assert.equal(monitorDeviceNameFromSink(''), null);
        assert.equal(monitorDeviceNameFromSink(null), null);
    });

    it('decodeSpawnStdout normalizes pactl stdout formats', () => {
        assert.equal(decodeSpawnStdout(null), '');
        assert.equal(decodeSpawnStdout(undefined), '');
        assert.equal(decodeSpawnStdout(''), '');
        assert.equal(
            decodeSpawnStdout(new TextEncoder().encode('default-sink\n')),
            'default-sink\n'
        );
        assert.equal(decodeSpawnStdout(42), '42');
    });
});
