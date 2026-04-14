import GObject from 'gi://GObject';
import St from 'gi://St';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Clutter from 'gi://Clutter';
import Soup from 'gi://Soup?version=3.0';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js';

const MPRIS_PLAYER_PATH = '/org/mpris/MediaPlayer2';
const MPRIS_PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

// Lyrics API configuration - NetEase Cloud Music (accessible through corporate proxy)
const NETEASE_SEARCH_URL = 'https://music.163.com/api/search/get';
const NETEASE_LYRIC_URL = 'https://music.163.com/api/song/lyric';

// Helper function to check if a bus name is a supported music player
function isSupportedPlayer(busName) {
    // Desktop apps
    if (busName === 'org.mpris.MediaPlayer2.spotify' ||
        busName === 'org.mpris.MediaPlayer2.youtube-music') {
        return true;
    }

    // Browser-based players (chromium, chrome, firefox, etc.)
    // These have instance IDs like: org.mpris.MediaPlayer2.chromium.instance12345
    const browserPatterns = [
        /^org\.mpris\.MediaPlayer2\.chromium\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.chrome\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.firefox\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.brave\.instance\d+$/,
        /^org\.mpris\.MediaPlayer2\.edge\.instance\d+$/
    ];

    return browserPatterns.some(pattern => pattern.test(busName));
}

const MusicLyricsIndicator = GObject.registerClass(
    class MusicLyricsIndicator extends PanelMenu.Button {
        _init(settings) {
            super._init(0.5, 'Music Lyrics Indicator');

            this._settings = settings;

            // Create a box to hold lyrics container and info icon
            const box = new St.BoxLayout({
                style_class: 'panel-status-menu-box'
            });

            // Karaoke container: two overlapping labels
            this._lyricsContainer = new Clutter.Actor({
                layout_manager: new Clutter.BinLayout(),
                y_align: Clutter.ActorAlign.CENTER
            });

            // Base label (dim, shows full line)
            this._baseLabel = new St.Label({
                text: 'No music playing',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-lyrics-label spotify-lyrics-base'
            });
            this._baseLabel.clutter_text.ellipsize = 3;

            // Highlight label (bright, clipped for karaoke sweep)
            this._highlightLabel = new St.Label({
                text: 'No music playing',
                y_align: Clutter.ActorAlign.CENTER,
                style_class: 'spotify-lyrics-label spotify-lyrics-highlight'
            });
            this._highlightLabel.clutter_text.ellipsize = 3;
            this._highlightLabel.set_clip(0, 0, 0, 0);

            this._lyricsContainer.add_child(this._baseLabel);
            this._lyricsContainer.add_child(this._highlightLabel);

            // Keep a reference for non-karaoke mode
            this._label = this._baseLabel;

            // Info icon button
            this._infoIcon = new St.Icon({
                icon_name: 'dialog-information-symbolic',
                style_class: 'system-status-icon',
                icon_size: 16,
                y_align: Clutter.ActorAlign.CENTER,
                opacity: 0,
                reactive: true
            });

            box.add_child(this._lyricsContainer);
            box.add_child(this._infoIcon);
            this.add_child(box);

            // Show/hide info icon on hover
            this.connect('enter-event', () => {
                this._infoIcon.ease({
                    opacity: 255,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            });

            this.connect('leave-event', () => {
                this._infoIcon.ease({
                    opacity: 0,
                    duration: 200,
                    mode: Clutter.AnimationMode.EASE_OUT_QUAD
                });
            });

            this._currentTrack = null;
            this._currentLyrics = null;
            this._currentLine = '';
            this._currentLyricIndex = -1;
            this._proxy = null;
            this._propertiesChangedId = null;
            this._lyricsTimeoutId = null;
            this._karaokeTimeoutId = null;
            this._karaokeLineStart = 0;
            this._karaokeLineEnd = 0;
            this._currentBusName = null;
            this._busWatchId = null;
            this._lyricsCache = new Map();

            // Internal state for lyrics
            this._showLyrics = true;

            // Apply initial style from settings
            this._applyStyle();

            // Connect setting signals for live updates
            this._settingsSignals = [];
            const styleKeys = ['font-size', 'max-width', 'highlight-color', 'base-color'];
            for (const key of styleKeys) {
                this._settingsSignals.push(
                    this._settings.connect(`changed::${key}`, () => this._applyStyle())
                );
            }
            this._settingsSignals.push(
                this._settings.connect('changed::max-text-length', () => this._updateLabelText())
            );
            this._settingsSignals.push(
                this._settings.connect('changed::karaoke-enabled', () => this._onKaraokeToggled())
            );

            this._buildMenu();
            this._setupDBusMonitoring();
        }

        _buildMenu() {
            // Player info section
            this._playerInfoItem = new PopupMenu.PopupMenuItem('No player connected', {
                reactive: false
            });
            this._playerInfoItem.label.style = 'font-size: 0.85em; color: #888;';
            this.menu.addMenuItem(this._playerInfoItem);

            // Track info section
            this._trackInfoItem = new PopupMenu.PopupMenuItem('No track playing', {
                reactive: false
            });
            this.menu.addMenuItem(this._trackInfoItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Playback controls
            const controlsBox = new St.BoxLayout({
                style_class: 'popup-menu-item',
                x_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                style: 'spacing: 12px;'
            });

            const prevButton = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'media-skip-backward-symbolic',
                    icon_size: 20
                })
            });
            prevButton.connect('clicked', () => this._controlPlayback('Previous'));

            const playPauseButton = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'media-playback-start-symbolic',
                    icon_size: 20
                })
            });
            this._playPauseButton = playPauseButton;
            playPauseButton.connect('clicked', () => this._controlPlayback('PlayPause'));

            const nextButton = new St.Button({
                style_class: 'button',
                child: new St.Icon({
                    icon_name: 'media-skip-forward-symbolic',
                    icon_size: 20
                })
            });
            nextButton.connect('clicked', () => this._controlPlayback('Next'));

            controlsBox.add_child(prevButton);
            controlsBox.add_child(playPauseButton);
            controlsBox.add_child(nextButton);

            const controlsItem = new PopupMenu.PopupBaseMenuItem({
                reactive: false,
                can_focus: false
            });
            controlsItem.add_child(controlsBox);
            this.menu.addMenuItem(controlsItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Toggle lyrics display
            this._lyricsToggle = new PopupMenu.PopupSwitchMenuItem(
                'Show Lyrics',
                this._showLyrics
            );
            this._lyricsToggle.connect('toggled', (item) => {
                this._showLyrics = item.state;
                if (!item.state) {
                    if (this._lyricsTimeoutId) {
                        GLib.source_remove(this._lyricsTimeoutId);
                        this._lyricsTimeoutId = null;
                    }
                    this._updateTrackInfo();
                } else {
                    this._updateTrackInfo();
                }
            });
            this.menu.addMenuItem(this._lyricsToggle);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Refresh button
            const refreshItem = new PopupMenu.PopupMenuItem('Refresh Player');
            refreshItem.connect('activate', () => {
                this._findActivePlayer();
            });
            this.menu.addMenuItem(refreshItem);

            this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

            // Info submenu
            this._infoSubmenu = new PopupMenu.PopupSubMenuMenuItem('About');

            // GitHub link
            const githubItem = new PopupMenu.PopupMenuItem('View on GitHub');
            githubItem.connect('activate', () => {
                Gio.AppInfo.launch_default_for_uri(
                    'https://github.com/d3osaju/Spotline',
                    null
                );
            });
            this._infoSubmenu.menu.addMenuItem(githubItem);

            // Credits
            const creditsItem = new PopupMenu.PopupMenuItem('Created by deosaju', {
                reactive: false
            });
            creditsItem.label.style = 'font-size: 0.9em; color: #888;';
            this._infoSubmenu.menu.addMenuItem(creditsItem);

            this.menu.addMenuItem(this._infoSubmenu);
        }

        _applyStyle() {
            const fontSize = this._settings.get_int('font-size');
            const maxWidth = this._settings.get_int('max-width');
            const baseColor = this._settings.get_string('base-color');
            const highlightColor = this._settings.get_string('highlight-color');

            const baseStyle = `font-size: ${fontSize}px; max-width: ${maxWidth}px; color: ${baseColor};`;
            const hlStyle = `font-size: ${fontSize}px; max-width: ${maxWidth}px; color: ${highlightColor};`;

            this._baseLabel.set_style(baseStyle);
            this._highlightLabel.set_style(hlStyle);
        }

        _onKaraokeToggled() {
            const enabled = this._settings.get_boolean('karaoke-enabled');
            if (!enabled) {
                this._stopKaraokeAnimation();
                this._highlightLabel.set_clip(0, 0, 0, 0);
            } else if (this._currentLyrics && this._currentLyrics.length > 0) {
                this._scheduleNextLyricUpdate();
            }
        }

        _controlPlayback(action) {
            if (!this._playerProxy) {
                return;
            }

            try {
                this._playerProxy.call(
                    action,
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    null
                );
            } catch (e) {
                logError(e, `Failed to ${action}`);
            }
        }

        _updatePlayPauseButton() {
            if (!this._playerProxy || !this._playPauseButton) {
                return;
            }

            try {
                const playbackStatus = this._playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    const icon = status === 'Playing' ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic';
                    this._playPauseButton.child.icon_name = icon;
                }
            } catch (e) {
                logError(e, 'Failed to update play/pause button');
            }
        }

        _setupDBusMonitoring() {
            // Watch for new media players appearing on the bus
            this._busWatchId = Gio.bus_watch_name(
                Gio.BusType.SESSION,
                'org.mpris.MediaPlayer2.*',
                Gio.BusNameWatcherFlags.NONE,
                () => this._findActivePlayer(),
                () => this._findActivePlayer()
            );

            this._findActivePlayer();
        }

        _findActivePlayer() {
            try {
                const dbusProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    'org.freedesktop.DBus',
                    '/org/freedesktop/DBus',
                    'org.freedesktop.DBus',
                    null
                );

                dbusProxy.call(
                    'ListNames',
                    null,
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            const reply = proxy.call_finish(result);
                            const names = reply.get_child_value(0).deep_unpack();

                            // First try to find a playing supported player
                            let foundPlayer = null;

                            for (const name of names) {
                                if (isSupportedPlayer(name)) {
                                    if (this._isPlayerPlaying(name)) {
                                        foundPlayer = name;
                                        break;
                                    }
                                }
                            }

                            // If no playing player, connect to any supported player
                            if (!foundPlayer) {
                                for (const name of names) {
                                    if (isSupportedPlayer(name)) {
                                        foundPlayer = name;
                                        break;
                                    }
                                }
                            }

                            if (foundPlayer) {
                                this._tryConnectToPlayer(foundPlayer);
                            } else {
                                this._updateLabelText('No music playing');
                            }
                        } catch (e) {
                            logError(e, 'Failed to list DBus names');
                            this._updateLabelText('No music playing');
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to query DBus');
                this._updateLabelText('No music playing');
            }
        }

        _isPlayerPlaying(busName) {
            try {
                const playerProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    null
                );

                const playbackStatus = playerProxy.get_cached_property('PlaybackStatus');
                if (playbackStatus) {
                    const status = playbackStatus.unpack();
                    return status === 'Playing';
                }
            } catch (e) {
                // Ignore errors, player might not be available
            }
            return false;
        }

        _tryConnectToPlayer(busName) {
            try {
                // Create proxy for properties interface
                const proxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    'org.freedesktop.DBus.Properties',
                    null
                );

                // Create proxy for player interface to monitor changes
                const playerProxy = Gio.DBusProxy.new_for_bus_sync(
                    Gio.BusType.SESSION,
                    Gio.DBusProxyFlags.NONE,
                    null,
                    busName,
                    MPRIS_PLAYER_PATH,
                    MPRIS_PLAYER_INTERFACE,
                    null
                );

                // Disconnect previous player if any
                if (this._propertiesChangedId && this._playerProxy) {
                    this._playerProxy.disconnect(this._propertiesChangedId);
                }

                this._proxy = proxy;
                this._playerProxy = playerProxy;
                this._currentBusName = busName;

                this._propertiesChangedId = this._playerProxy.connect(
                    'g-properties-changed',
                    this._onPropertiesChanged.bind(this)
                );

                this._updatePlayerInfo();
                this._updateTrackInfo();
                return true;
            } catch (e) {
                return false;
            }
        }

        _updatePlayerInfo() {
            if (!this._currentBusName) {
                this._playerInfoItem.label.text = 'No player connected';
                return;
            }

            let playerName = 'Unknown Player';
            let playerIcon = '♪';

            if (this._currentBusName.includes('spotify')) {
                playerName = 'Spotify';
                playerIcon = '🎵';
            } else if (this._currentBusName.includes('youtube-music')) {
                playerName = 'YouTube Music';
                playerIcon = '🎵';
            } else if (this._currentBusName.includes('chromium')) {
                playerName = 'Chromium';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('chrome')) {
                playerName = 'Chrome';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('firefox')) {
                playerName = 'Firefox';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('brave')) {
                playerName = 'Brave';
                playerIcon = '🌐';
            } else if (this._currentBusName.includes('edge')) {
                playerName = 'Edge';
                playerIcon = '🌐';
            }

            this._playerInfoItem.label.text = `${playerIcon} Playing from ${playerName}`;
        }

        _onPropertiesChanged() {
            this._updateTrackInfo();
            this._updatePlayPauseButton();
        }

        _updateTrackInfo() {
            if (!this._playerProxy) {
                return;
            }

            try {
                const metadata = this._playerProxy.get_cached_property('Metadata');
                if (!metadata) {
                    this._updateLabelText('No music playing');
                    this._trackInfoItem.label.text = 'No track playing';
                    return;
                }

                const metadataDict = metadata.deep_unpack();
                const title = metadataDict['xesam:title']?.unpack() || null;
                const artist = metadataDict['xesam:artist']?.deep_unpack()[0] || null;
                const album = metadataDict['xesam:album']?.unpack() || null;

                // If both title and artist are missing, show icon or nothing
                if (!title && !artist) {
                    this._updateLabelText('♪');
                    this._trackInfoItem.label.text = 'Unknown track';
                    return;
                }

                this._currentTrack = {
                    title: title || 'Unknown Track',
                    artist: artist || 'Unknown Artist',
                    album: album || 'Unknown Album'
                };

                // Update menu with track info
                this._trackInfoItem.label.text = `${this._currentTrack.artist} - ${this._currentTrack.title}`;

                // Try to fetch lyrics if enabled
                if (this._showLyrics) {
                    this._fetchLyrics(this._currentTrack.title, this._currentTrack.artist);
                } else {
                    this._updateLabelText(`${this._currentTrack.artist} - ${this._currentTrack.title}`);
                }
            } catch (e) {
                logError(e, 'Failed to get track info');
            }
        }

        _fetchLyrics(title, artist) {
            // Clear any existing lyrics timeout
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            // Check cache first
            const cacheKey = `${artist}::${title}`;
            if (this._lyricsCache.has(cacheKey)) {
                const cached = this._lyricsCache.get(cacheKey);
                if (cached.length > 0) {
                    this._currentLyrics = cached;
                    this._currentLyricIndex = -1;
                    this._startLyricsDisplay();
                } else {
                    this._updateLabelText(`${artist} - ${title}`);
                }
                return;
            }

            // Step 1: Search song on NetEase to get song ID
            const searchUrl = `${NETEASE_SEARCH_URL}?s=${encodeURIComponent(title + ' ' + artist)}&type=1&limit=1`;
            const session = new Soup.Session();
            const searchMsg = Soup.Message.new('GET', searchUrl);
            searchMsg.get_request_headers().append('User-Agent', 'Mozilla/5.0');

            session.send_and_read_async(searchMsg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    if (searchMsg.get_status() !== Soup.Status.OK) {
                        this._updateLabelText(`${artist} - ${title}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const songs = data?.result?.songs;

                    if (!songs || songs.length === 0) {
                        this._updateLabelText(`${artist} - ${title}`);
                        return;
                    }

                    const songId = songs[0].id;
                    this._fetchNeteaseLyric(session, songId, title, artist);
                } catch (e) {
                    logError(e, 'Failed to search lyrics');
                    this._updateLabelText(`${artist} - ${title}`);
                }
            });
        }

        _fetchNeteaseLyric(session, songId, title, artist) {
            // Step 2: Fetch lyrics by song ID
            const lyricUrl = `${NETEASE_LYRIC_URL}?id=${songId}&lv=1`;
            const lyricMsg = Soup.Message.new('GET', lyricUrl);
            lyricMsg.get_request_headers().append('User-Agent', 'Mozilla/5.0');

            session.send_and_read_async(lyricMsg, GLib.PRIORITY_DEFAULT, null, (sess, result) => {
                try {
                    const bytes = sess.send_and_read_finish(result);
                    if (lyricMsg.get_status() !== Soup.Status.OK) {
                        this._updateLabelText(`${artist} - ${title}`);
                        return;
                    }

                    const decoder = new TextDecoder('utf-8');
                    const data = JSON.parse(decoder.decode(bytes.get_data()));
                    const lrcText = data?.lrc?.lyric;

                    const cacheKey = `${artist}::${title}`;
                    if (lrcText) {
                        this._currentLyrics = this._parseLRC(lrcText);
                        this._lyricsCache.set(cacheKey, this._currentLyrics);
                        this._currentLyricIndex = -1;
                        if (this._currentLyrics.length > 0) {
                            this._startLyricsDisplay();
                        } else {
                            this._updateLabelText(`${artist} - ${title}`);
                        }
                    } else {
                        this._lyricsCache.set(cacheKey, []);
                        this._updateLabelText(`${artist} - ${title}`);
                    }
                } catch (e) {
                    logError(e, 'Failed to fetch lyrics');
                    this._updateLabelText(`${artist} - ${title}`);
                }
            });
        }

        _parseLRC(lrcText) {
            // Parse LRC format: [mm:ss.xx]lyrics or [mm:ss.xxx]lyrics
            const lines = [];
            const lrcLines = lrcText.split('\n');
            // Skip NetEase metadata lines (作词, 作曲, 编曲, etc.)
            const metadataPattern = /^(作词|作曲|编曲|制作|混音|母带|录音|吉他|贝斯|鼓|钢琴|和声|Lyricist|Composer|Arranger|Producer)/;

            for (const line of lrcLines) {
                const match = line.match(/\[(\d+):(\d+)\.(\d+)\](.*)/);
                if (match) {
                    const minutes = parseInt(match[1]);
                    const seconds = parseInt(match[2]);
                    const fraction = match[3];
                    const text = match[4].trim();

                    // Convert fraction to milliseconds (handle both .xx and .xxx)
                    let ms = parseInt(fraction);
                    if (fraction.length === 2) ms *= 10;
                    else if (fraction.length === 1) ms *= 100;

                    const timeMs = (minutes * 60 + seconds) * 1000 + ms;

                    if (text && !metadataPattern.test(text)) {
                        lines.push({ time: timeMs, text: text });
                    }
                }
            }

            return lines.sort((a, b) => a.time - b.time);
        }

        _startLyricsDisplay() {
            if (!this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            this._scheduleNextLyricUpdate();
        }

        _stopKaraokeAnimation() {
            if (this._karaokeTimeoutId) {
                GLib.source_remove(this._karaokeTimeoutId);
                this._karaokeTimeoutId = null;
            }
        }

        _scheduleNextLyricUpdate() {
            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            if (!this._proxy || !this._currentLyrics || this._currentLyrics.length === 0) {
                return;
            }

            try {
                this._proxy.call(
                    'Get',
                    new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'Position']),
                    Gio.DBusCallFlags.NONE,
                    -1,
                    null,
                    (proxy, result) => {
                        try {
                            const reply = proxy.call_finish(result);
                            const positionUs = reply.get_child_value(0).get_variant().get_int64();
                            const positionMs = positionUs / 1000;

                            // Find current lyric index
                            let currentIndex = -1;
                            for (let i = this._currentLyrics.length - 1; i >= 0; i--) {
                                if (this._currentLyrics[i].time <= positionMs) {
                                    currentIndex = i;
                                    break;
                                }
                            }

                            // New line: update text and start karaoke sweep
                            if (currentIndex !== this._currentLyricIndex) {
                                this._currentLyricIndex = currentIndex;
                                this._stopKaraokeAnimation();

                                if (currentIndex >= 0) {
                                    const lineText = this._currentLyrics[currentIndex].text;
                                    this._currentLine = lineText;
                                    const karaokeOn = this._settings.get_boolean('karaoke-enabled');
                                    this._updateLabelText(lineText, karaokeOn);

                                    if (karaokeOn) {
                                        // Karaoke timing: current line start → next line start
                                        this._karaokeLineStart = this._currentLyrics[currentIndex].time;
                                        const nextIdx = currentIndex + 1;
                                        this._karaokeLineEnd = nextIdx < this._currentLyrics.length
                                            ? this._currentLyrics[nextIdx].time
                                            : this._karaokeLineStart + 5000;

                                        this._highlightLabel.set_clip(0, 0, 0, 0);
                                        this._startKaraokeAnimation();
                                    }
                                }
                            }

                            // Schedule check for next line change
                            const nextIndex = currentIndex + 1;
                            let delay;
                            if (nextIndex < this._currentLyrics.length) {
                                delay = Math.max(50, this._currentLyrics[nextIndex].time - positionMs);
                            } else {
                                delay = 1000;
                            }

                            this._lyricsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
                                this._lyricsTimeoutId = null;
                                this._scheduleNextLyricUpdate();
                                return GLib.SOURCE_REMOVE;
                            });
                        } catch (e) {
                            this._lyricsTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1000, () => {
                                this._lyricsTimeoutId = null;
                                this._scheduleNextLyricUpdate();
                                return GLib.SOURCE_REMOVE;
                            });
                        }
                    }
                );
            } catch (e) {
                logError(e, 'Failed to update lyric line');
            }
        }

        _startKaraokeAnimation() {
            this._karaokeTimeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 33, () => {
                if (!this._proxy) {
                    this._karaokeTimeoutId = null;
                    return GLib.SOURCE_REMOVE;
                }

                try {
                    this._proxy.call(
                        'Get',
                        new GLib.Variant('(ss)', [MPRIS_PLAYER_INTERFACE, 'Position']),
                        Gio.DBusCallFlags.NONE,
                        -1,
                        null,
                        (proxy, result) => {
                            try {
                                const reply = proxy.call_finish(result);
                                const positionUs = reply.get_child_value(0).get_variant().get_int64();
                                const positionMs = positionUs / 1000;

                                const duration = this._karaokeLineEnd - this._karaokeLineStart;
                                if (duration <= 0) return;

                                const elapsed = positionMs - this._karaokeLineStart;
                                const progress = Math.min(1.0, Math.max(0.0, elapsed / duration));

                                const totalWidth = this._highlightLabel.get_width();
                                const totalHeight = this._highlightLabel.get_height();
                                const clipWidth = totalWidth * progress;

                                this._highlightLabel.set_clip(0, 0, clipWidth, totalHeight);
                            } catch (e) {
                                // ignore
                            }
                        }
                    );
                } catch (e) {
                    // ignore
                }

                return GLib.SOURCE_CONTINUE;
            });
        }

        _updateLabelText(text = null, isLyric = false) {
            if (text !== null) {
                this._currentText = text;
            }

            const display = this._currentText || 'No music playing';
            const maxLength = this._settings.get_int('max-text-length');
            const truncated = this._truncateText(display, maxLength);
            this._baseLabel.set_text(truncated);
            this._highlightLabel.set_text(truncated);

            if (!isLyric) {
                // Non-lyric text: show highlight fully, base dim
                this._highlightLabel.remove_clip();
            }
        }

        _truncateText(text, maxLength) {
            if (text.length <= maxLength) {
                return text;
            }
            return text.substring(0, maxLength - 3) + '...';
        }

        destroy() {
            if (this._settingsSignals) {
                for (const id of this._settingsSignals) {
                    this._settings.disconnect(id);
                }
                this._settingsSignals = null;
            }

            if (this._lyricsTimeoutId) {
                GLib.source_remove(this._lyricsTimeoutId);
                this._lyricsTimeoutId = null;
            }

            this._stopKaraokeAnimation();

            if (this._propertiesChangedId && this._playerProxy) {
                this._playerProxy.disconnect(this._propertiesChangedId);
                this._propertiesChangedId = null;
            }

            if (this._busWatchId) {
                Gio.bus_unwatch_name(this._busWatchId);
                this._busWatchId = null;
            }

            this._proxy = null;
            this._playerProxy = null;
            this._lyricsCache.clear();
            super.destroy();
        }
    });

export default class MusicLyricsExtension extends Extension {
    constructor(metadata) {
        super(metadata);
        this._indicator = null;
        this._settings = null;
    }

    enable() {
        this._settings = this.getSettings();
        this._indicator = new MusicLyricsIndicator(this._settings);

        this._updatePosition();

        this._settingsSignalId = this._settings.connect('changed::position-in-panel', () => {
            this._updatePosition();
        });
    }

    disable() {
        if (this._settingsSignalId) {
            this._settings.disconnect(this._settingsSignalId);
            this._settingsSignalId = null;
        }

        if (this._indicator) {
            this._indicator.destroy();
            this._indicator = null;
        }

        this._settings = null;
    }

    _updatePosition() {
        if (!this._indicator) return;

        // Remove from current parent if applied
        if (this._indicator.get_parent()) {
            this._indicator.get_parent().remove_child(this._indicator);
        }

        const position = this._settings.get_string('position-in-panel');

        if (position === 'left') {
            Main.panel._leftBox.add_child(this._indicator);
        } else if (position === 'center') {
            Main.panel._centerBox.add_child(this._indicator);
        } else {
            // Default to right (status area)
            // We use addToStatusArea but need to handle re-adding carefully
            // addToStatusArea destroys existing indicator with same role, but we handle that

            // Since we manually removed it, we can just add it back using the panel method
            // or just use addToStatusArea again (which is safer for right side)
            Main.panel.addToStatusArea('music-lyrics-indicator', this._indicator);
        }
    }
}
