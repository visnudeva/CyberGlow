import {clamp, rgb01ToCss} from './utils.js';

export const THICKNESS_SCALE = 4.5;
export const BASE_SHADOW_PADDING = 28;
export const BASE_GLOW_BLUR = 6;
export const BASE_GLOW_SPREAD = 2;
export const DEFAULT_WINDOW_RADIUS = 12;

// Meta.WindowType values used by canHaveUnderglow.
export const ALLOWED_WINDOW_TYPES = new Set([
    0, // NORMAL
    3, // DIALOG
    4, // MODAL_DIALOG
    7, // UTILITY
]);

export function scaledThickness(value) {
    return value * THICKNESS_SCALE;
}

export function parseWindowRadiusFromCss(css) {
    if (!css)
        return null;

    const rootMatch = css.match(/:root\s*\{[^}]*--window-radius:\s*([0-9.]+)px/s);
    if (rootMatch)
        return parseFloat(rootMatch[1]);

    const anyMatch = css.match(/--window-radius:\s*([0-9.]+)px/);
    return anyMatch ? parseFloat(anyMatch[1]) : null;
}

export function getShadowPadding() {
    return Math.max(2, Math.round(scaledThickness(BASE_SHADOW_PADDING)));
}

export function buildShadowStyle(color, focused, hidden, cornerRadius, intensityMult = 1.0) {
    if (hidden) {
        return 'background: transparent; box-shadow: none; opacity: 0;';
    }

    const [r, g, b] = color;
    const css = rgb01ToCss(r, g, b);
    const boost = Math.max(0.35, intensityMult);
    const bloomOpacity = (focused ? 1.0 : 0.9) * boost;
    const coreOpacity = 1.0 * Math.min(1.25, boost);

    const radius = Math.max(0, cornerRadius);
    const blur = scaledThickness(BASE_GLOW_BLUR);
    const spread = scaledThickness(BASE_GLOW_SPREAD);
    const coreBlur = Math.max(2, blur * 0.35);
    const coreSpread = Math.max(1, spread * 0.5);

    return `background: transparent;
border-radius: ${radius}px;
box-shadow: 0 0 ${coreBlur}px ${coreSpread}px rgba(${css},${coreOpacity}),
            0 0 ${blur}px ${spread}px rgba(${css},${bloomOpacity});`;
}

export function canHaveUnderglow(win) {
    if (!win)
        return false;

    if (!ALLOWED_WINDOW_TYPES.has(win.get_window_type()))
        return false;

    return !win.is_override_redirect();
}

export function maxDecorationInset(frame) {
    if (!frame || frame.width <= 0 || frame.height <= 0)
        return 96;

    return Math.max(96, Math.max(frame.width, frame.height) * 0.3);
}

export function contentOffset(win) {
    if (!win)
        return [0, 0, 0, 0];

    const buf = win.get_buffer_rect();
    const frame = win.get_frame_rect();
    return [
        frame.x - buf.x,
        frame.y - buf.y,
        frame.width - buf.width,
        frame.height - buf.height,
    ];
}

export function clampedContentOffset(win) {
    const frame = win?.get_frame_rect?.();
    if (!frame || frame.width <= 0 || frame.height <= 0)
        return [0, 0, 0, 0];

    const maxInset = maxDecorationInset(frame);
    const [dx, dy, dw, dh] = contentOffset(win);
    return [
        clamp(dx, -maxInset, maxInset),
        clamp(dy, -maxInset, maxInset),
        clamp(dw, -maxInset, maxInset),
        clamp(dh, -maxInset, maxInset),
    ];
}

export function isUnderglowGeometrySane(win) {
    if (!win)
        return false;

    const frame = win.get_frame_rect();
    if (frame.width <= 0 || frame.height <= 0)
        return false;

    const maxInset = maxDecorationInset(frame);
    const [dx, dy, dw, dh] = contentOffset(win);
    return [dx, dy, dw, dh].every(value => Math.abs(value) <= maxInset);
}

export function shouldShowUnderglow(win) {
    if (!canHaveUnderglow(win))
        return false;

    if (win.maximizedHorizontally || win.maximizedVertically || win.fullscreen)
        return false;

    return isUnderglowGeometrySane(win);
}
