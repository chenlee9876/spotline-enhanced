# SpotLine Enhanced

[中文文档](README.zh-CN.md)

A GNOME Shell extension that displays synchronized lyrics with karaoke animation in the top bar.

Fork of [SpotLine](https://github.com/d3osaju/Spotline) by deosaju, with significant enhancements.

![Karaoke lyrics in top bar](screenshots/topbar-karaoke.png)
![Karaoke lyrics in top bar](screenshots/topbar-karaoke-2.png)

## Features

- **Karaoke sweep effect** - lyrics highlight progressively as the song plays
- **NetEase Cloud Music lyrics** - proxy-friendly lyrics source with broad coverage
- **Lyrics caching** - no redundant API calls for repeated plays
- **Smart timing** - precise lyric sync based on timestamps, not polling
- **Fully customizable** via preferences:
  - Font size
  - Max display width
  - Highlight color (karaoke sweep)
  - Base color (unsung lyrics)
  - Karaoke effect toggle
  - Panel position (left / center / right)
  - Max text length
- **MPRIS support** - works with Spotify, YouTube Music, and browser-based players

## Supported GNOME Versions

45, 46, 47, 48

## Installation

### From GNOME Extensions

Visit [extensions.gnome.org](https://extensions.gnome.org/) and search for "SpotLine Enhanced".

### From Source

```bash
git clone https://github.com/chenlee9876/spotline-enhanced.git
cd spotline-enhanced
./install.sh
```

Then restart GNOME Shell:
- **X11**: `killall -HUP gnome-shell`
- **Wayland**: Log out and log back in

## Configuration

Open the extension preferences via:

```bash
gnome-extensions prefs spotline-enhanced@chenlee9876
```

Or use the GNOME Extensions app / Extension Manager.

![Preferences](screenshots/preferences.png)

## Changes from Original SpotLine

| Feature | SpotLine | SpotLine Enhanced |
|---|---|---|
| Lyrics source | LRCLIB | NetEase Cloud Music |
| HTTP client | Gio.File (no proxy) | Soup.Session (proxy-aware) |
| Animation | Static text | Karaoke sweep effect |
| Caching | None | In-memory lyrics cache |
| Timing | 500ms polling | Smart scheduling per lyric line |
| Customization | Position, text length | + font size, colors, width, karaoke toggle |

## License

GPL-3.0 - see [LICENSE](LICENSE)

Based on [SpotLine](https://github.com/d3osaju/Spotline) by deosaju, licensed under GPL-3.0.
