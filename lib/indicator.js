import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';

const QuickSettingsMenu = Main.panel.statusArea.quickSettings;

const FEATURE_SWITCHES = [
    {key: 'underglow', label: 'Underglow'},
    {key: 'music-reactive', label: 'React to music'},
    {key: 'keep-awake', label: 'Keep awake'},
    {key: 'reverse-rain', label: 'Reverse rain'},
];

const CyberGlowToggle = GObject.registerClass({
    GTypeName: 'CyberGlowToggle',
}, class CyberGlowToggle extends QuickSettings.QuickMenuToggle {
    _init(extension, settings) {
        super._init({
            title: 'CyberGlow',
            iconName: 'applications-graphics-symbolic',
            toggleMode: true,
        });

        this._settings = settings;
        this._featureItems = [];

        this.menu.setHeader(
            'applications-graphics-symbolic',
            'CyberGlow',
            'Neon shape overlay',
        );

        this._settings.bind(
            'neon-enabled',
            this,
            'checked',
            Gio.SettingsBindFlags.DEFAULT,
        );

        this._settings.connectObject(
            'changed::neon-enabled',
            () => this._syncSubtitle(),
            this,
        );

        for (const feature of FEATURE_SWITCHES) {
            const item = new PopupMenu.PopupSwitchMenuItem(
                feature.label,
                this._settings.get_boolean(feature.key),
            );
            item.connect('toggled', (_item, state) => {
                this._settings.set_boolean(feature.key, state);
            });
            this._settings.connectObject(
                `changed::${feature.key}`,
                () => {
                    const active = this._settings.get_boolean(feature.key);
                    if (item.state !== active)
                        item.setToggleState(active);
                },
                item,
            );
            this.menu.addMenuItem(item);
            this._featureItems.push(item);
        }

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const settingsItem = this.menu.addAction(
            'Extension Settings',
            () => extension.openPreferences(),
        );
        settingsItem.visible = Main.sessionMode.allowSettings;
        this.menu._settingsActions[extension.uuid] = settingsItem;

        this._syncSubtitle();
    }

    _syncSubtitle() {
        this.subtitle = this._settings.get_boolean('neon-enabled') ? 'On' : 'Off';
    }

    destroy() {
        for (const item of this._featureItems)
            this._settings.disconnectObject(item);
        this._featureItems = [];
        this._settings.disconnectObject(this);
        super.destroy();
    }
});

export const CyberGlowIndicator = GObject.registerClass({
    GTypeName: 'CyberGlowIndicator',
}, class CyberGlowIndicator extends QuickSettings.SystemIndicator {
    _init(extension, settings) {
        super._init();

        this._settings = settings;

        this._indicator = this._addIndicator();
        this._indicator.icon_name = 'applications-graphics-symbolic';

        this._toggle = new CyberGlowToggle(extension, settings);
        this.quickSettingsItems.push(this._toggle);

        this._settings.connectObject(
            'changed::neon-enabled',
            () => this._syncIndicator(),
            this,
        );

        this._syncIndicator();
        QuickSettingsMenu.addExternalIndicator(this);
    }

    _syncIndicator() {
        this._indicator.visible = this._settings.get_boolean('neon-enabled');
    }

    destroy() {
        this._settings.disconnectObject(this);
        this.quickSettingsItems.forEach(item => item.destroy());
        this.quickSettingsItems = [];
        super.destroy();
    }
});
