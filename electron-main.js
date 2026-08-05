// Frozen native shell: a transparent, always-on-top overlay that loads the dev URL.
// SAFETY: the window is click-through BY DEFAULT — the mouse always passes through to
// your real apps, so the overlay can never trap you. The renderer flips a region to
// interactive only while you hover a button (Start / Quit). Hard exits below.
const { app, BrowserWindow, globalShortcut, session, screen, ipcMain } = require('electron');

const URL = 'http://localhost:4777/';   // the hub is the shell everywhere — one nav, one permission, one tracker
let win;

function createWindow() {
  const { width, height } = screen.getPrimaryDisplay().workAreaSize;
  win = new BrowserWindow({
    x: 0, y: 0, width, height,
    transparent: true, frame: false, hasShadow: false,
    resizable: false, movable: false, skipTaskbar: true,
    alwaysOnTop: true, fullscreenable: true,
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false },
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadURL(URL);
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(true));

  // DEFAULT: mouse passes through to the desktop. Never traps the pointer.
  win.setIgnoreMouseEvents(true, { forward: true });

  // renderer asks to capture the mouse only while hovering a real button
  let locked = false;
  ipcMain.on('interactive', (e, on) => { if (win && !locked) win.setIgnoreMouseEvents(!on, { forward: true }); });
  ipcMain.on('lock', (e, on) => { locked = on; if (win) win.setIgnoreMouseEvents(!on, { forward: true }); });
  ipcMain.on('quit', () => app.quit());

  // emergency hotkeys — work even when the window is click-through
  globalShortcut.register('Command+Alt+Q', () => app.quit());          // QUIT
  globalShortcut.register('Command+R', () => win && win.reload());      // reload
  globalShortcut.register('Command+Alt+H', () => {                      // force full mouse control on/off
    locked = !locked;
    win.setIgnoreMouseEvents(!locked, { forward: true });
  });
}

app.whenReady().then(createWindow);
app.on('will-quit', () => globalShortcut.unregisterAll());
app.on('window-all-closed', () => app.quit());
