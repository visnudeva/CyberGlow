import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {removeGtkShadowBlock} from './gtk-shadow-cleanup.js';
import {
    buildShadowStyle,
    canHaveUnderglow,
    clampedContentOffset,
    DEFAULT_WINDOW_RADIUS,
    getShadowPadding,
    parseWindowRadiusFromCss,
    shouldShowUnderglow,
} from './underglow-style.js';
import {parseColorStringToRgb01} from './utils.js';

let _themeWindowRadius = null;
let _themeSettings = null;

function themeSettings() {
    if (!_themeSettings)
        _themeSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return _themeSettings;
}

function gtkThemeName() {
    const settings = themeSettings();
    const keys = settings.list_keys();
    if (keys.includes('gtk4-theme')) {
        const gtk4Theme = settings.get_string('gtk4-theme');
        if (gtk4Theme)
            return gtk4Theme;
    }
    return settings.get_string('gtk-theme') || 'Adwaita';
}

function clearThemeWindowRadiusCache() {
    _themeWindowRadius = null;
}

function themeCssCandidates(themeName) {
    const home = GLib.get_home_dir();
    return [
        GLib.build_filenamev([home, '.config', 'gtk-4.0', 'gtk.css']),
        GLib.build_filenamev([home, '.config', 'gtk-4.0', 'libadwaita.css']),
        `/usr/share/themes/${themeName}/gtk-4.0/libadwaita.css`,
        `/usr/share/themes/${themeName}/gtk-4.0/gtk.css`,
        `/usr/share/themes/${themeName}/gtk-3.0/gtk.css`,
    ];
}

function getThemeWindowRadius() {
    if (_themeWindowRadius !== null)
        return _themeWindowRadius;

    return DEFAULT_WINDOW_RADIUS;
}

function preloadThemeWindowRadius(onDone) {
    if (_themeWindowRadius !== null) {
        onDone?.();
        return;
    }

    _loadThemeWindowRadiusFromPaths(themeCssCandidates(gtkThemeName()), 0, onDone);
}

function _loadThemeWindowRadiusFromPaths(paths, index, onDone) {
    if (index >= paths.length) {
        _themeWindowRadius = DEFAULT_WINDOW_RADIUS;
        onDone?.();
        return;
    }

    Gio.File.new_for_path(paths[index]).load_contents_async(null, (file, result) => {
        let radius = null;
        try {
            const [, bytes] = file.load_contents_finish(result);
            radius = parseWindowRadiusFromCss(new TextDecoder().decode(bytes));
        } catch {
            radius = null;
        }

        if (radius !== null) {
            _themeWindowRadius = radius;
            onDone?.();
            return;
        }

        _loadThemeWindowRadiusFromPaths(paths, index + 1, onDone);
    });
}

function getWindowCornerRadius(win) {
    if (!win || win.maximizedHorizontally || win.maximizedVertically || win.fullscreen)
        return 0;

    try {
        if (win.decorated && win.get_frame_type() === Meta.FrameType.BORDER)
            return 0;
    } catch {
        // Fall through to the GTK theme radius.
    }

    return getThemeWindowRadius();
}

function getWindowGroup() {
    return global.windowGroup ?? global.window_group;
}

function getWindowManager() {
    return global.windowManager ?? global.window_manager;
}

function actorAlive(actor) {
    if (!actor)
        return false;
    try {
        if (actor.is_finalized?.())
            return false;
        void actor.visible;
        return true;
    } catch {
        return false;
    }
}

function gtkCssPath(version) {
    return GLib.build_filenamev([
        GLib.get_home_dir(),
        '.config',
        `gtk-${version}.0`,
        'gtk.css',
    ]);
}

function removeGtkShadowOverride() {
    for (const version of ['3', '4']) {
        const path = gtkCssPath(version);
        const file = Gio.File.new_for_path(path);
        file.load_contents_async(null, (_file, result) => {
            try {
                const [, bytes] = _file.load_contents_finish(result);
                const contents = new TextDecoder().decode(bytes);
                const updated = removeGtkShadowBlock(contents);
                if (updated === contents.trimEnd())
                    return;

                if (updated.length > 0) {
                    _file.replace_contents_async(
                        `${updated}\n`,
                        null,
                        false,
                        Gio.FileCreateFlags.REPLACE_DESTINATION,
                        null,
                        () => {}
                    );
                } else {
                    _file.delete_async(GLib.PRIORITY_DEFAULT, null, () => {});
                }
            } catch {
                // Best-effort cleanup during disable.
            }
        });
    }
}

export const UnderglowManager = GObject.registerClass({
    GTypeName: 'CyberGlowUnderglowManager',
}, class UnderglowManager extends GObject.Object {
    _init(settings) {
        super._init();

        this._settings = settings;
        this._entries = new Map();
        this._globalSignalsConnected = false;
        this._color = [0, 1, 0.8];
        this._musicReactive = false;
        this._audioIntensityMult = 1.0;
        this._audioBeatPulse = 0;
    }

    enable() {
        if (this._globalSignalsConnected)
            return;

        this._refreshColor();
        this._connectThemeSignals();
        preloadThemeWindowRadius(() => {
            this._restyleAll();
        });

        this.connectObject(
            this._settings,
            'changed::neon-color', () => {
                this._refreshColor();
                this._restyleAll();
            },
            'changed::music-reactive', () => {
                this._musicReactive = this._settings.get_boolean('music-reactive');
                if (!this._musicReactive)
                    this.setAudioIntensity(1.0, 0);
                else
                    this._restyleAll();
            },
        );

        this._musicReactive = this._settings.get_boolean('music-reactive');
        this._connectGlobalSignals();
        for (const actor of global.get_window_actors()) {
            if (actorAlive(actor))
                this._ensureUnderglow(actor);
        }
        this._pruneStaleEntries();
    }

    setAudioIntensity(mult, beatPulse = 0) {
        const next = Math.max(1.0, Math.min(2.0, mult));
        const nextBeat = Math.max(0, Math.min(1, beatPulse));
        if (Math.abs(next - this._audioIntensityMult) < 0.01 &&
            Math.abs(nextBeat - this._audioBeatPulse) < 0.02) {
            return;
        }
        this._audioIntensityMult = next;
        this._audioBeatPulse = nextBeat;
        if (this._musicReactive)
            this._restyleAll();
    }

    disable() {
        this.disconnectObject(this._settings);
        this._disconnectThemeSignals();
        this._disconnectGlobalSignals();
        this._cleanupGtkShadowOverride();

        for (const actor of [...this._entries.keys()])
            this._removeUnderglow(actor);
    }

    _connectThemeSignals() {
        const settings = themeSettings();
        const onThemeChanged = () => {
            clearThemeWindowRadiusCache();
            preloadThemeWindowRadius(() => {
                this._restyleAll();
            });
        };

        const themeSignals = [
            ['changed::gtk-theme', onThemeChanged],
        ];
        if (settings.list_keys().includes('gtk4-theme'))
            themeSignals.push(['changed::gtk4-theme', onThemeChanged]);

        for (const [signal, handler] of themeSignals)
            this.connectObject(settings, signal, handler);
    }

    _disconnectThemeSignals() {
        this.disconnectObject(themeSettings());
    }

    _cleanupGtkShadowOverride() {
        try {
            removeGtkShadowOverride();
        } catch (err) {
            console.error('[CyberGlow] failed to clean up GTK shadow override:', err);
        }
    }

    _refreshColor() {
        this._color = parseColorStringToRgb01(this._settings.get_string('neon-color')) ??
            [0, 1, 0.8];
    }

    _audioReactiveColor() {
        const [r, g, b] = this._color;
        if (!this._musicReactive)
            return [r, g, b];

        const bassLift = Math.max(0, this._audioIntensityMult - 1.0);
        const shift = bassLift * 0.4 + this._audioBeatPulse * 0.5;
        if (shift <= 0.01)
            return [r, g, b];

        return [
            Math.min(1, r + shift * 0.6),
            Math.min(1, g + shift * 0.32),
            Math.min(1, b + shift * 0.52),
        ];
    }

    _connectGlobalSignals() {
        if (this._globalSignalsConnected)
            return;

        this.connectObject(
            global.display,
            'window-created', (_d, metaWindow) => {
                this._onWindowCreated(metaWindow);
            },
            'restacked', () => {
                this._restackAll();
            },
            getWindowManager(),
            'destroy', (_wm, actor) => {
                this._removeUnderglow(actor);
            },
        );
        this._globalSignalsConnected = true;
    }

    _disconnectGlobalSignals() {
        if (!this._globalSignalsConnected)
            return;

        this.disconnectObject(global.display);
        this.disconnectObject(getWindowManager());
        this._globalSignalsConnected = false;
    }

    _onWindowCreated(metaWindow) {
        const actor = metaWindow.get_compositor_private();
        if (actor)
            this._ensureUnderglow(actor);
    }

    _pruneStaleEntries() {
        for (const actor of [...this._entries.keys()]) {
            if (!actorAlive(actor))
                this._removeUnderglow(actor);
        }
    }

    _ensureUnderglow(windowActor) {
        if (!actorAlive(windowActor))
            return;

        if (this._entries.has(windowActor))
            return;

        const win = windowActor.get_meta_window?.() ?? windowActor.meta_window;
        if (!canHaveUnderglow(win))
            return;

        try {
            this._createUnderglow(windowActor, win);
        } catch (err) {
            console.error(`[CyberGlow] underglow failed for "${win?.get_title?.() ?? 'window'}":`, err);
        }
    }

    _createUnderglow(windowActor, win) {
        const padding = getShadowPadding();
        const shadow = new St.Bin({
            style: `padding: ${padding}px; overflow: hidden;`,
            clip_to_allocation: true,
            child: new St.Bin({
                x_expand: true,
                y_expand: true,
            }),
        });

        const child = shadow.firstChild;
        child.add_style_class_name('cyberglow-underglow');

        getWindowGroup().insert_child_below(shadow, windowActor);

        const constraints = [];
        const offsets = this._shadowOffsets(windowActor);
        for (let i = 0; i < 4; i++) {
            constraints.push(new Clutter.BindConstraint({
                source: windowActor,
                coordinate: i,
                offset: offsets[i],
            }));
            shadow.add_constraint(constraints[i]);
        }

        const propertyBindings = [];
        for (const prop of [
            'pivot-point',
            'translation-x',
            'translation-y',
            'scale-x',
            'scale-y',
            'visible',
        ]) {
            propertyBindings.push(windowActor.bind_property(
                prop,
                shadow,
                prop,
                GObject.BindingFlags.SYNC_CREATE
            ));
        }

        const entry = {
            shadow,
            constraints,
            propertyBindings,
            win,
            innerStyle: '',
            outerStyle: '',
            offsets: null,
        };
        this._entries.set(windowActor, entry);

        this.connectObject(
            win,
            'notify::appears-focused', () => {
                if (!this._entries.has(windowActor))
                    return;
                this._updateShadowStyle(windowActor);
            },
            'notify::maximized-horizontally', () => {
                if (!this._entries.has(windowActor))
                    return;
                this._updateShadowStyle(windowActor);
            },
            'notify::maximized-vertically', () => {
                if (!this._entries.has(windowActor))
                    return;
                this._updateShadowStyle(windowActor);
            },
            'notify::fullscreen', () => {
                if (!this._entries.has(windowActor))
                    return;
                this._updateShadowStyle(windowActor);
            },
            'size-changed', () => {
                if (!this._entries.has(windowActor))
                    return;
                this._updateShadowStyle(windowActor);
            },
            'position-changed', () => {
                if (!this._entries.has(windowActor))
                    return;
                this._updateShadowStyle(windowActor);
            },
        );

        this._updateShadowStyle(windowActor);
    }

    _shadowOffsets(windowActor) {
        if (!actorAlive(windowActor))
            return null;

        const padding = getShadowPadding();
        const win = windowActor.get_meta_window?.() ?? windowActor.meta_window;
        const [dx, dy, dw, dh] = clampedContentOffset(win);
        return [dx - padding, dy - padding, dh + 2 * padding, dw + 2 * padding];
    }

    _updateShadowStyle(windowActor) {
        if (!actorAlive(windowActor))
            return;

        const entry = this._entries.get(windowActor);
        if (!entry)
            return;

        const win = windowActor.get_meta_window?.() ?? windowActor.meta_window;
        const hidden = !shouldShowUnderglow(win);
        const focused = win?.appears_focused ?? false;
        const innerStyle = buildShadowStyle(
            this._audioReactiveColor(),
            focused,
            hidden,
            getWindowCornerRadius(win),
            this._musicReactive ? this._audioIntensityMult : 1.0
        );
        const padding = getShadowPadding();
        const outerStyle = `padding: ${padding}px; overflow: hidden;`;
        const offsets = this._shadowOffsets(windowActor);
        if (!offsets)
            return;

        const offsetsChanged = !entry.offsets ||
            entry.offsets.some((value, index) => value !== offsets[index]);
        const styleChanged = entry.innerStyle !== innerStyle ||
            entry.outerStyle !== outerStyle;

        if (!styleChanged && !offsetsChanged)
            return;

        if (offsetsChanged) {
            entry.offsets = offsets;
            for (let i = 0; i < entry.constraints.length; i++)
                entry.constraints[i].offset = offsets[i];
        }

        if (styleChanged) {
            entry.innerStyle = innerStyle;
            entry.outerStyle = outerStyle;
            entry.shadow.style = outerStyle;
            entry.shadow.firstChild.style = innerStyle;
            entry.shadow.firstChild.queue_redraw();
        }
    }

    _restyleAll() {
        for (const actor of [...this._entries.keys()])
            this._updateShadowStyle(actor);
        this._pruneStaleEntries();
    }

    _restackAll() {
        for (const [actor, entry] of this._entries) {
            if (!actorAlive(actor) || !actorAlive(entry.shadow) || !actor.visible)
                continue;
            try {
                getWindowGroup().set_child_below_sibling(entry.shadow, actor);
            } catch {
                // Best-effort restack during compositor updates.
            }
        }
        this._pruneStaleEntries();
    }

    _removeUnderglow(windowActor) {
        const entry = this._entries.get(windowActor);
        if (!entry)
            return;

        this._entries.delete(windowActor);

        if (entry.win)
            this.disconnectObject(entry.win);

        try {
            for (const binding of entry.propertyBindings ?? [])
                binding.unbind();
        } catch {
            // Best-effort cleanup.
        }

        try {
            if (actorAlive(entry.shadow)) {
                for (const constraint of entry.shadow.get_constraints?.() ?? [])
                    entry.shadow.remove_constraint(constraint);
                if (actorAlive(getWindowGroup()))
                    getWindowGroup().remove_child(entry.shadow);
                entry.shadow.destroy();
            }
        } catch {
            // Best-effort cleanup.
        }
    }
});
