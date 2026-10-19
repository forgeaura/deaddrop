import { startSettingsServer } from "../lib/settings-server.js";

let electronModule = null;
if (process.versions.electron) {
  electronModule = await import("electron");
}

let settingsServer = null;
let mainWindow = null;

export function getSettingsServer() {
  return settingsServer;
}

export function getMainWindow() {
  return mainWindow;
}

export function buildMenuTemplate(app, isMac = process.platform === "darwin") {
  return [
    ...(isMac ? [{
      label: app ? app.name : "Dead Drop Settings",
      submenu: [
        { role: "about" },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" }
      ]
    }] : []),
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" }
      ]
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" }
      ]
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
        ...(isMac ? [
          { type: "separator" },
          { role: "front" },
          { type: "separator" },
          { role: "window" }
        ] : [
          { role: "close" }
        ])
      ]
    }
  ];
}

export async function createWindow(url, electronOverride = electronModule) {
  const { BrowserWindow } = electronOverride || {};
  if (!BrowserWindow) {
    throw new Error("BrowserWindow is unavailable outside Electron runtime");
  }

  mainWindow = new BrowserWindow({
    width: 960,
    height: 720,
    minWidth: 640,
    minHeight: 500,
    title: "Dead Drop Settings",
    show: false,
    backgroundColor: "#0d1117",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  mainWindow.once("ready-to-show", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.show();
    }
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.loadURL(url);
  return mainWindow;
}

export async function startApp({
  port = 3344,
  deaddropDir,
  electronOverride = electronModule,
  skipWindow = false
} = {}) {
  const electron = electronOverride || electronModule;
  if (electron && electron.Menu && electron.app) {
    const template = buildMenuTemplate(electron.app);
    const menu = electron.Menu.buildFromTemplate(template);
    electron.Menu.setApplicationMenu(menu);
  }

  settingsServer = await startSettingsServer({
    port,
    deaddropDir,
    isCli: false
  });

  if (!skipWindow && electron && electron.BrowserWindow) {
    await createWindow(settingsServer.url, electron);
  }

  return {
    settingsServer,
    mainWindow,
    port: settingsServer.port,
    url: settingsServer.url
  };
}

export async function stopApp() {
  if (settingsServer && typeof settingsServer.close === "function") {
    await settingsServer.close();
    settingsServer = null;
  }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.close();
    mainWindow = null;
  }
}

// Wire Electron lifecycle events if running inside Electron app runtime
if (electronModule && electronModule.app) {
  const { app, BrowserWindow } = electronModule;

  app.whenReady().then(async () => {
    try {
      await startApp();
    } catch (err) {
      console.error("[Dead Drop Electron] Failed to start:", err);
      app.quit();
    }
  });

  app.on("window-all-closed", () => {
    app.quit();
  });

  app.on("before-quit", async (event) => {
    if (settingsServer) {
      event.preventDefault();
      try {
        await stopApp();
      } finally {
        app.exit(0);
      }
    }
  });

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0 && settingsServer) {
      await createWindow(settingsServer.url);
    }
  });
}
