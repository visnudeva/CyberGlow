export const GTK_SHADOW_MARKER_BEGIN = '/* CYBERGLOW-UNDERGLOW-BEGIN */';
export const GTK_SHADOW_MARKER_END = '/* CYBERGLOW-UNDERGLOW-END */';
export const GTK_SHADOW_BLOCK_PATTERN =
    /\/\* CYBERGLOW-UNDERGLOW-BEGIN \*\/[\s\S]*?\/\* CYBERGLOW-UNDERGLOW-END \*\/\n?/;

export function removeGtkShadowBlock(contents) {
    if (!contents)
        return '';
    return contents.replace(GTK_SHADOW_BLOCK_PATTERN, '').trimEnd();
}
