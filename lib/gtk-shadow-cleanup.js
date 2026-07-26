import {scaledThickness} from './underglow-style.js';
import {rgb01ToCss} from './utils.js';

export const GTK_SHADOW_MARKER_BEGIN = '/* CYBERGLOW-UNDERGLOW-BEGIN */';
export const GTK_SHADOW_MARKER_END = '/* CYBERGLOW-UNDERGLOW-END */';
export const GTK_SHADOW_BLOCK_PATTERN =
    /\/\* CYBERGLOW-UNDERGLOW-BEGIN \*\/[\s\S]*?\/\* CYBERGLOW-UNDERGLOW-END \*\/\n?/;

const BASE_CORE_BLUR = 10;
const BASE_BLOOM_BLUR = 28;

export function hasGtkShadowBlock(contents) {
    return Boolean(contents?.includes(GTK_SHADOW_MARKER_BEGIN));
}

export function removeGtkShadowBlock(contents) {
    if (!contents)
        return '';
    return contents.replace(GTK_SHADOW_BLOCK_PATTERN, '').trimEnd();
}

export function buildGtkUnderglowBlock(color, intensityMult = 1.0) {
    const [r, g, b] = color;
    const css = rgb01ToCss(r, g, b);
    const boost = Math.max(0.85, Math.min(1.6, intensityMult));
    const coreBlur = Math.max(4, Math.round(scaledThickness(BASE_CORE_BLUR)));
    const bloomBlur = Math.max(coreBlur + 4, Math.round(scaledThickness(BASE_BLOOM_BLUR)));
    const coreAlpha = Math.min(1, 0.92 * boost).toFixed(2);
    const bloomAlpha = Math.min(1, 0.62 * boost).toFixed(2);

    return `${GTK_SHADOW_MARKER_BEGIN}
window.csd decoration,
window.csd decoration:backdrop {
  box-shadow:
    0 0 ${coreBlur}px rgba(${css}, ${coreAlpha}),
    0 0 ${bloomBlur}px rgba(${css}, ${bloomAlpha});
}
${GTK_SHADOW_MARKER_END}`;
}
