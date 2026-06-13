import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    GTK_SHADOW_MARKER_BEGIN,
    GTK_SHADOW_MARKER_END,
    hasGtkShadowBlock,
    removeGtkShadowBlock,
} from '../lib/gtk-shadow-cleanup.js';

const LEGACY_BLOCK = `${GTK_SHADOW_MARKER_BEGIN}
window.csd decoration {
  box-shadow: none !important;
}
${GTK_SHADOW_MARKER_END}`;

describe('gtk-shadow-cleanup', () => {
    it('hasGtkShadowBlock detects legacy override blocks', () => {
        assert.equal(hasGtkShadowBlock(''), false);
        assert.equal(hasGtkShadowBlock('body { color: red; }'), false);
        assert.equal(hasGtkShadowBlock(LEGACY_BLOCK), true);
    });

    it('removeGtkShadowBlock strips legacy override blocks', () => {
        const css = `body { color: red; }\n${LEGACY_BLOCK}\nfooter { margin: 0; }`;
        assert.equal(removeGtkShadowBlock(css), 'body { color: red; }\nfooter { margin: 0; }');
    });

    it('removeGtkShadowBlock returns empty string when only the block remains', () => {
        assert.equal(removeGtkShadowBlock(`${LEGACY_BLOCK}\n`), '');
        assert.equal(removeGtkShadowBlock(''), '');
    });
});
