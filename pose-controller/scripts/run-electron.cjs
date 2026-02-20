const path = require('node:path');
const { spawn } = require('node:child_process');

function getElectronExecutablePath() {
  const executableName = process.platform === 'win32' ? 'electron.exe' : 'electron';
  return path.resolve(__dirname, '..', 'node_modules', 'electron', 'dist', executableName);
}

function main() {
  const argv = process.argv.slice(2);
  const entryArg = argv.length > 0 ? argv : ['electron/main.cjs'];
  const electronPath = getElectronExecutablePath();
  const env = { ...process.env };

  // Some shells/session profiles export this globally, which forces Electron
  // to behave like plain Node and breaks main-process IPC wiring.
  delete env.ELECTRON_RUN_AS_NODE;

  const child = spawn(electronPath, entryArg, {
    stdio: 'inherit',
    env,
    cwd: path.resolve(__dirname, '..'),
    windowsHide: false,
  });

  child.once('error', (error) => {
    console.error(`[run-electron] Failed to launch Electron: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });

  child.once('exit', (code, signal) => {
    if (signal) {
      console.error(`[run-electron] Electron exited via signal: ${signal}`);
      process.exit(1);
      return;
    }
    process.exit(typeof code === 'number' ? code : 0);
  });
}

main();
