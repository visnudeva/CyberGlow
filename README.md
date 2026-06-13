



https://github.com/user-attachments/assets/0867f4b2-8862-4c90-8895-400a3b3a3b24


# <img src="https://github.com/visnudeva/CyberGlow/blob/main/docs/assets/logo.png?raw=true" width="100"> CyberGlow


<table>
  <tr>
    <td>
      <strong>A GNOME Shell extension that adds a cyberpunk neon overlay to your desktop background.</strong><br>
      Glowing shapes, tinted rain, drifting dust, and glitch flicker sit behind your windows and panels.<br>
      Optional window underglow and music-reactive effects respond to bass, treble, and beats from system audio.<br>
    </td>
    <td>
      <img src="https://github.com/visnudeva/CyberGlow/blob/main/docs/assets/Screenshot.png?raw=true" width="600">
    </td>
  </tr>
</table>

## Features

- **Neon Desktop Overlay**: Glowing shape, rain, and dust drawn on the wallpaper layer
- **Customizable Look**: Pick shape, color, and rain direction from the settings panel
- **Glitch Flicker**: Random neon tube flicker for a worn cyberpunk feel
- **Window Underglow**: Optional neon glow around normal window shadows
- **Music Reactive**: Multi-band visuals driven by system audio when enabled
- **Power-Aware**: Adjusts frame timing when GNOME power-saver profile is active

### Customization Options

- **Shapes**: Up-triangle, down-triangle, circle
- **Color**: Single neon color for the tube, rain, and dust (default `#00ffcc`)
- **Reverse Rain**: Make the rain fall upward instead of downward
- **Underglow**: Neon glow on window shadows (restart GTK apps after enabling)
- **React to Music**: Bass, mid, treble, and beat detection via GStreamer

## Installation

### From GNOME Extensions (Recommended)

Once published, install directly from [extensions.gnome.org](https://extensions.gnome.org/).

### Manual Installation

Download the .zip file, extract

```bash
# Copy to local extensions directory
cp -r CyberGlow-main ~/.local/share/gnome-shell/extensions/CyberGlow@visnudeva.io

# Compile GSettings schemas
glib-compile-schemas ~/.local/share/gnome-shell/extensions/CyberGlow@visnudeva.io/schemas/

# Enable the extension
gnome-extensions enable CyberGlow@visnudeva.io

# Restart GNOME Shell (Wayland: log out and back in, X11: Alt+F2, type 'r')
```

## How It Works

1. Draws a neon shape overlay on the desktop background group, behind windows and panels
2. Animates tinted rain streaks and drifting dust particles matched to your chosen color
3. Runs occasional glitch flicker episodes on the neon tube
4. Optionally adds neon underglow to normal window shadows
5. When music reactive mode is on, analyzes system audio and maps bass, mid, treble, and beats to glow, rain, dust, scale, and color

## Configuration

Open **Extensions → CyberGlow → Settings** to customize the effect:

- **Shape** — up-triangle, down-triangle, or circle
- **Color** — neon tube, dust, and rain color
- **Underglow** — neon glow on window shadows
- **React to music** — multi-band effects from system audio
- **Reverse rain** — rain falls upward instead of downward

Underglow works out of the box for Shell windows. For GTK app decoration shadows, restart affected apps after enabling underglow.

## Troubleshooting

**Extension not visible?**
- Ensure the extension is enabled: `gnome-extensions list --enabled`
- Check logs: `journalctl -f | grep -i "cyberglow"`
- Restart GNOME Shell after installation

**Underglow missing on some apps?**
- Underglow targets normal, non-maximized windows
- Restart GTK applications after enabling underglow in settings

**Music reactive not working?**
- Confirm audio is playing through your default output
- Verify GStreamer is installed and PulseAudio/PipeWire provides a monitor source

## Requirements

- GNOME Shell 45–50
- GStreamer (for music reactive mode)
- PulseAudio or PipeWire with a monitor source on the default output (for music reactive mode)

## License

GNU General Public License v2.0 or later. See the [LICENSE](LICENSE) file for details.

## Contributing

Issues and pull requests welcome at [GitHub](https://github.com/visnudeva/CyberGlow).
