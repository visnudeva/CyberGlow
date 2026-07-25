import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const SESSION_MANAGER_IFACE = `<?xml version="1.0" encoding="UTF-8"?>
<node>
  <interface name="org.gnome.SessionManager">
    <method name="Inhibit">
      <arg type="s" direction="in"/>
      <arg type="u" direction="in"/>
      <arg type="s" direction="in"/>
      <arg type="u" direction="in"/>
      <arg type="u" direction="out"/>
    </method>
    <method name="Uninhibit">
      <arg type="u" direction="in"/>
    </method>
  </interface>
</node>`;

const INHIBIT_IDLE = 8;

export class IdleInhibitor {
    constructor() {
        this._cookie = null;
        this._proxy = null;
    }

    get active() {
        return this._cookie !== null;
    }

    setActive(active) {
        if (active)
            this._acquire();
        else
            this._release();
    }

    _ensureProxy() {
        if (this._proxy)
            return this._proxy;

        try {
            const SessionManager = Gio.DBusProxy.makeProxyWrapper(SESSION_MANAGER_IFACE);
            this._proxy = new SessionManager(
                Gio.DBus.session,
                'org.gnome.SessionManager',
                '/org/gnome/SessionManager'
            );
        } catch {
            this._proxy = null;
        }
        return this._proxy;
    }

    _acquire() {
        if (this._cookie !== null)
            return;

        const proxy = this._ensureProxy();
        if (!proxy)
            return;

        try {
            const params = GLib.Variant.new_tuple([
                GLib.Variant.new_string('CyberGlow@visnudeva.github.io'),
                GLib.Variant.new_uint32(0),
                GLib.Variant.new_string('CyberGlow music visualization'),
                GLib.Variant.new_uint32(INHIBIT_IDLE),
            ]);
            const result = proxy.call_sync(
                'Inhibit',
                params,
                Gio.DBusCallFlags.NONE,
                -1,
                null
            );
            if (result)
                this._cookie = result.get_child_value(0).get_uint32();
        } catch {
            this._cookie = null;
        }
    }

    _release() {
        if (this._cookie === null)
            return;

        const cookie = this._cookie;
        this._cookie = null;

        const proxy = this._ensureProxy();
        if (!proxy)
            return;

        try {
            proxy.UninhibitRemote(cookie);
        } catch {
            // Session may already be gone during shutdown.
        }
    }

    destroy() {
        this._release();
        this._proxy = null;
    }
}
