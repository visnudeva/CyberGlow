import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CyberGlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        const bindings = [];

        const bind = (obj, signal, handler) => {
            bindings.push([obj, obj.connect(signal, handler)]);
        };

        const page = new Adw.PreferencesPage({
            title: 'CyberGlow',
            icon_name: 'video-display-symbolic',
        });
        window.add(page);

        const neonGroup = new Adw.PreferencesGroup({
            title: 'Settings',
            description: 'Customize the neon shape effect',
        });
        page.add(neonGroup);

        const shapeNames = [
            'up-triangle',
            'down-triangle',
            'Circle',
            'Hexagon',
            'Horizontal rectangle',
            'Square',
            'Vertical rectangle',
            'Diamond',
        ];
        const shapeCount = shapeNames.length;
        let shape = settings.get_int('neon-shape');
        if (shape < 0 || shape >= shapeCount) {
            shape = 0;
            settings.set_int('neon-shape', shape);
        }
        const shapeRow = new Adw.ComboRow({
            title: 'Shape',
            subtitle: 'Pick one of the shapes (no morphing)',
            model: Gtk.StringList.new(shapeNames),
            selected: shape,
        });
        bind(shapeRow, 'notify::selected', () => {
            const selected = shapeRow.get_selected();
            if (selected < 0 || selected >= shapeCount)
                return;
            settings.set_int('neon-shape', selected);
        });
        bind(settings, 'changed::neon-shape', () => {
            const v = settings.get_int('neon-shape');
            if (v < 0 || v >= shapeCount)
                return;
            if (shapeRow.get_selected() !== v)
                shapeRow.set_selected(v);
        });
        neonGroup.add(shapeRow);

        const colorRow = new Adw.ActionRow({
            title: 'Color',
            subtitle: 'Neon tube, dust, and rain color',
        });
        const rgba = new Gdk.RGBA();
        rgba.parse(settings.get_string('neon-color'));
        const colorDialog = new Gtk.ColorDialog({
            title: 'Neon Color',
            with_alpha: false,
        });
        const colorButton = new Gtk.ColorDialogButton({
            dialog: colorDialog,
            rgba,
            valign: Gtk.Align.CENTER,
        });
        let syncingColor = false;
        bind(colorButton, 'notify::rgba', () => {
            if (syncingColor)
                return;
            settings.set_string('neon-color', colorButton.get_rgba().to_string());
        });
        bind(settings, 'changed::neon-color', () => {
            const r = new Gdk.RGBA();
            if (!r.parse(settings.get_string('neon-color')))
                return;
            if (colorButton.get_rgba().equal(r))
                return;
            syncingColor = true;
            colorButton.set_rgba(r);
            syncingColor = false;
        });
        colorRow.add_suffix(colorButton);
        neonGroup.add(colorRow);

        const underglowRow = new Adw.SwitchRow({
            title: 'Underglow',
            subtitle: 'Neon glow on window shadows (GTK apps; restart apps to apply)',
            active: settings.get_boolean('underglow'),
        });
        bind(underglowRow, 'notify::active', () => {
            settings.set_boolean('underglow', underglowRow.get_active());
        });
        bind(settings, 'changed::underglow', () => {
            const active = settings.get_boolean('underglow');
            if (underglowRow.get_active() !== active)
                underglowRow.set_active(active);
        });
        neonGroup.add(underglowRow);

        const musicReactiveRow = new Adw.SwitchRow({
            title: 'React to music',
            subtitle: 'Multi-band neon effects driven by system audio (GStreamer)',
            active: settings.get_boolean('music-reactive'),
        });
        bind(musicReactiveRow, 'notify::active', () => {
            settings.set_boolean('music-reactive', musicReactiveRow.get_active());
        });
        bind(settings, 'changed::music-reactive', () => {
            const active = settings.get_boolean('music-reactive');
            if (musicReactiveRow.get_active() !== active)
                musicReactiveRow.set_active(active);
        });
        neonGroup.add(musicReactiveRow);

        const reverseRainRow = new Adw.SwitchRow({
            title: 'Reverse rain',
            subtitle: 'Make the neon rain fall upward',
            active: settings.get_boolean('reverse-rain'),
        });
        bind(reverseRainRow, 'notify::active', () => {
            settings.set_boolean('reverse-rain', reverseRainRow.get_active());
        });
        bind(settings, 'changed::reverse-rain', () => {
            const active = settings.get_boolean('reverse-rain');
            if (reverseRainRow.get_active() !== active)
                reverseRainRow.set_active(active);
        });
        neonGroup.add(reverseRainRow);

        window.connect('close-request', () => {
            for (const [obj, id] of bindings)
                obj.disconnect(id);
        });
    }
}
