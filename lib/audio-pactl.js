import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {decodeSpawnStdout, monitorDeviceNameFromSink} from './utils.js';

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

    try {
        const proc = Gio.Subprocess.new(
            ['pactl', 'get-default-sink'],
            Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE
        );
        proc.communicate_utf8_async(null, null, (_proc, result) => {
            _fetchInFlight = false;
            let device = null;
            try {
                const [, stdout] = _proc.communicate_utf8_finish(result);
                device = monitorDeviceNameFromSink(decodeSpawnStdout(stdout));
            } catch {
                device = null;
            }
            _cachedMonitorDevice = device;
            const waiters = _fetchWaiters.splice(0);
            for (const waiter of waiters)
                waiter(device);
        });
    } catch {
        _fetchInFlight = false;
        _cachedMonitorDevice = null;
        const waiters = _fetchWaiters.splice(0);
        for (const waiter of waiters)
            waiter(null);
    }
}
