import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CyberGlowPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const settings = this.getSettings();

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

        const shapeRow = new Adw.ComboRow({
            title: 'Shape',
            subtitle: 'Pick one of the shapes (no morphing)',
            model: Gtk.StringList.new([
                'up-triangle',
                'down-triangle',
                'Circle',
            ]),
            selected: settings.get_int('neon-shape'),
        });
        shapeRow.connectObject(
            'notify::selected',
            () => settings.set_int('neon-shape', shapeRow.get_selected()),
            this,
        );
        settings.connectObject(
            'changed::neon-shape',
            () => {
                const v = settings.get_int('neon-shape');
                if (shapeRow.get_selected() !== v)
                    shapeRow.set_selected(v);
            },
            this,
        );
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
        colorButton.connectObject(
            'notify::rgba',
            () => {
                if (syncingColor)
                    return;
                settings.set_string('neon-color', colorButton.get_rgba().to_string());
            },
            this,
        );
        settings.connectObject(
            'changed::neon-color',
            () => {
                const r = new Gdk.RGBA();
                if (!r.parse(settings.get_string('neon-color')))
                    return;
                if (colorButton.get_rgba().equal(r))
                    return;
                syncingColor = true;
                colorButton.set_rgba(r);
                syncingColor = false;
            },
            this,
        );
        colorRow.add_suffix(colorButton);
        neonGroup.add(colorRow);

        const underglowRow = new Adw.SwitchRow({
            title: 'Underglow',
            subtitle: 'Neon glow on window shadows (GTK apps; restart apps to apply)',
            active: settings.get_boolean('underglow'),
        });
        underglowRow.connectObject(
            'notify::active',
            () => settings.set_boolean('underglow', underglowRow.get_active()),
            this,
        );
        settings.connectObject(
            'changed::underglow',
            () => {
                const active = settings.get_boolean('underglow');
                if (underglowRow.get_active() !== active)
                    underglowRow.set_active(active);
            },
            this,
        );
        neonGroup.add(underglowRow);

        const musicReactiveRow = new Adw.SwitchRow({
            title: 'React to music',
            subtitle: 'Multi-band neon effects driven by system audio (GStreamer)',
            active: settings.get_boolean('music-reactive'),
        });
        musicReactiveRow.connectObject(
            'notify::active',
            () => settings.set_boolean('music-reactive', musicReactiveRow.get_active()),
            this,
        );
        settings.connectObject(
            'changed::music-reactive',
            () => {
                const active = settings.get_boolean('music-reactive');
                if (musicReactiveRow.get_active() !== active)
                    musicReactiveRow.set_active(active);
            },
            this,
        );
        neonGroup.add(musicReactiveRow);

        const reverseRainRow = new Adw.SwitchRow({
            title: 'Reverse rain',
            subtitle: 'Make the neon rain fall upward',
            active: settings.get_boolean('reverse-rain'),
        });
        reverseRainRow.connectObject(
            'notify::active',
            () => settings.set_boolean('reverse-rain', reverseRainRow.get_active()),
            this,
        );
        settings.connectObject(
            'changed::reverse-rain',
            () => {
                const active = settings.get_boolean('reverse-rain');
                if (reverseRainRow.get_active() !== active)
                    reverseRainRow.set_active(active);
            },
            this,
        );
        neonGroup.add(reverseRainRow);

        window.connectObject('destroy', () => {
            shapeRow.disconnectObject(this);
            settings.disconnectObject(this);
            colorButton.disconnectObject(this);
            underglowRow.disconnectObject(this);
            musicReactiveRow.disconnectObject(this);
            reverseRainRow.disconnectObject(this);
        }, this);
    }
}
