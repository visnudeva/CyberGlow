import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    GTK_SHADOW_MARKER_BEGIN,
    GTK_SHADOW_MARKER_END,
} from '../lib/gtk-shadow-cleanup.js';
import {buildGtkUnderglowBlock} from '../lib/gtk-underglow-style.js';

describe('gtk-underglow', () => {
    it('buildGtkUnderglowBlock emits a valid CSD decoration shadow', () => {
        const block = buildGtkUnderglowBlock([0, 1, 0.8], 1.0);

        assert.match(block, new RegExp(GTK_SHADOW_MARKER_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(block, new RegExp(GTK_SHADOW_MARKER_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
        assert.match(block, /window\.csd decoration/);
        assert.match(block, /window\.csd decoration:backdrop/);
        assert.match(block, /rgba\(0,255,204/);
        assert.doesNotMatch(block, /box-shadow:\s*none/);
    });

    it('buildGtkUnderglowBlock scales intensity for music reactivity', () => {
        const calm = buildGtkUnderglowBlock([0, 1, 0.8], 1.0);
        const boosted = buildGtkUnderglowBlock([0, 1, 0.8], 1.5);

        assert.match(boosted, /rgba\(0,255,204, 1\.00\)/);
        assert.notEqual(calm, boosted);
    });
});
