export function lerp(a, b, t) {
    return a + (b - a) * t;
}

export function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
}

export function expRand(meanSeconds) {
    return -Math.log(1 - Math.random()) * Math.max(0.001, meanSeconds);
}

export function monitorDeviceNameFromSink(sinkName) {
    const name = String(sinkName ?? '').trim();
    return name ? `${name}.monitor` : null;
}

export function decodeSpawnStdout(stdout) {
    if (!stdout)
        return '';
    if (stdout instanceof Uint8Array)
        return new TextDecoder().decode(stdout);
    return String(stdout);
}

export function colorChannelsToRgb01(r, g, b) {
    const max = Math.max(r, g, b);
    if (max <= 1.0)
        return [clamp(r, 0, 1), clamp(g, 0, 1), clamp(b, 0, 1)];
    return [r / 255, g / 255, b / 255];
}

export function parseColorStringToRgb01(str) {
    if (!str || typeof str !== 'string')
        return null;
    const s = str.trim();
    if (s.startsWith('#')) {
        const hex = s.slice(1);
        if (hex.length === 6 || hex.length === 8) {
            const r = parseInt(hex.slice(0, 2), 16);
            const g = parseInt(hex.slice(2, 4), 16);
            const b = parseInt(hex.slice(4, 6), 16);
            return colorChannelsToRgb01(r, g, b);
        }
    }
    const m = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/i);
    if (m)
        return colorChannelsToRgb01(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    return null;
}

export function rgb01ToCss(r, g, b) {
    return `${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)}`;
}

const _glowWidthCache = new Map();

export function getGlowWidthPasses(gsz, count) {
    const key = `${gsz}:${count}`;
    if (_glowWidthCache.has(key))
        return _glowWidthCache.get(key);

    const maxW = 32 * gsz;
    const minW = 1.85 * gsz;
    const passes = [];
    for (let i = 0; i < count; i++) {
        const t = i / (count - 1);
        passes.push({
            w: lerp(maxW, minW, t),
            alphaScale: lerp(0.018, 0.15, Math.pow(t, 0.92)),
        });
    }
    _glowWidthCache.set(key, passes);
    return passes;
}
