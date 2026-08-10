const { app, BrowserWindow } = require("electron");

async function start() {
	await app.whenReady();
	const window = new BrowserWindow({
		width: 1220,
		height: 800,
		show: false,
		webPreferences: {
			nodeIntegration: false,
			contextIsolation: true,
			sandbox: true,
		},
	});
	await window.loadURL(process.env.PI_DESKTOP_E2E_URL ?? "about:blank");
	window.on("closed", () => app.quit());
}

void start();
