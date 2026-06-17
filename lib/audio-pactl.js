import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {monitorDeviceNameFromSink} from './utils.js';

const PA_BUS_NAME = 'org.PulseAudio.Core1';
const PA_CORE_PATH = '/org/pulseaudio/core1';
const PA_CORE_IFACE = 'org.PulseAudio.Core1';
const PA_DEVICE_IFACE = 'org.PulseAudio.Core1.Device';
const DBUS_PROPERTIES = 'org.freedesktop.DBus.Properties';

let _cachedMonitorDevice = null;
let _fetchInFlight = false;
const _fetchWaiters = [];

export function isAudioRuntimeReady() {
    const runtimeDir = GLib.getenv('XDG_RUNTIME_DIR');
    if (!runtimeDir)
        return false;

    const pulseSocket = GLib.build_filenamev([runtimeDir, 'pulse', 'native']);
    if (Gio.File.new_for_path(pulseSocket).query_exists(null))
        return true;

    const pipewireSocket = GLib.build_filenamev([runtimeDir, 'pipewire-0']);
    return Gio.File.new_for_path(pipewireSocket).query_exists(null);
}

export function clearDefaultMonitorDeviceCache() {
    _cachedMonitorDevice = null;
}

export function getCachedDefaultMonitorDevice() {
    return _cachedMonitorDevice;
}

function _finishFetch(device) {
    _fetchInFlight = false;
    _cachedMonitorDevice = device;
    const waiters = _fetchWaiters.splice(0);
    for (const waiter of waiters)
        waiter(device);
}

function _fetchSinkName(sinkPath, onReady) {
    Gio.DBusProxy.new_for_bus(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.NONE,
        null,
        PA_BUS_NAME,
        sinkPath,
        DBUS_PROPERTIES,
        null,
        (proxy, result) => {
            try {
                const sinkProxy = Gio.DBusProxy.new_for_bus_finish(result);
                sinkProxy.call(
                    'Get',
                    new GLib.Variant('(ss)', [PA_DEVICE_IFACE, 'Name']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (p, res) => {
                        try {
                            const [, value] = p.call_finish(res).deepUnpack();
                            onReady(monitorDeviceNameFromSink(String(value)));
                        } catch {
                            onReady(null);
                        }
                    }
                );
            } catch {
                onReady(null);
            }
        }
    );
}

export function fetchDefaultMonitorDeviceFromPactl(onReady) {
    if (!isAudioRuntimeReady()) {
        onReady?.(null);
        return;
    }

    if (_cachedMonitorDevice)
        return onReady?.(_cachedMonitorDevice);

    if (typeof onReady === 'function')
        _fetchWaiters.push(onReady);

    if (_fetchInFlight)
        return;

    _fetchInFlight = true;

    Gio.DBusProxy.new_for_bus(
        Gio.BusType.SESSION,
        Gio.DBusProxyFlags.NONE,
        null,
        PA_BUS_NAME,
        PA_CORE_PATH,
        DBUS_PROPERTIES,
        null,
        (proxy, result) => {
            try {
                const coreProxy = Gio.DBusProxy.new_for_bus_finish(result);
                coreProxy.call(
                    'Get',
                    new GLib.Variant('(ss)', [PA_CORE_IFACE, 'FallbackSink']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (p, res) => {
                        try {
                            const [, sinkPath] = p.call_finish(res).deepUnpack();
                            _fetchSinkName(String(sinkPath), device => _finishFetch(device));
                        } catch {
                            _finishFetch(null);
                        }
                    }
                );
            } catch {
                _finishFetch(null);
            }
        }
    );
}
