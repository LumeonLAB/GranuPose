#!/usr/bin/env node

const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const { spawnSync } = require('node:child_process');

function parseBoolean(rawValue) {
  if (typeof rawValue !== 'string') {
    return false;
  }
  const normalized = rawValue.trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(normalized);
}

function runCommand(command, args, cwd) {
  const printable = `${command} ${args.join(' ')}`.trim();
  console.log(`[engine-stage] ${printable}`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: false,
  });

  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${printable}`);
  }
}

function commandExists(command) {
  const checker = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(checker, [command], {
    stdio: 'ignore',
    shell: false,
  });
  return result.status === 0;
}

// ---------------------------------------------------------------------------
// Windows MSVC auto-detection helpers
// ---------------------------------------------------------------------------

function findVsInstallPath() {
  const vswhereCandidates = [
    path.join(
      process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)',
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe',
    ),
  ];
  const vswhere = vswhereCandidates.find((p) => fs.existsSync(p));
  if (!vswhere) {
    return '';
  }
  // Ask vswhere for installations that have the C++ toolset component.
  const result = spawnSync(
    vswhere,
    [
      '-all',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath',
      '-format',
      'value',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'], shell: false },
  );
  if (result.status !== 0 || !result.stdout) {
    return '';
  }
  const lines = result.stdout
    .toString('utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines[0] : '';
}

function findVcvars64() {
  const vsPath = findVsInstallPath();
  if (!vsPath) {
    return '';
  }
  const candidate = path.join(vsPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  return fs.existsSync(candidate) ? candidate : '';
}

function findVsCmake() {
  const vsPath = findVsInstallPath();
  if (!vsPath) {
    return '';
  }
  const candidate = path.join(
    vsPath,
    'Common7',
    'IDE',
    'CommonExtensions',
    'Microsoft',
    'CMake',
    'CMake',
    'bin',
    'cmake.exe',
  );
  return fs.existsSync(candidate) ? candidate : '';
}

function findVcpkgToolchain() {
  const envPath = process.env.VCPKG_ROOT || process.env.GRANUPOSE_VCPKG_ROOT;
  const candidates = [
    envPath ? path.join(envPath, 'scripts', 'buildsystems', 'vcpkg.cmake') : '',
    'C:\\dev\\vcpkg\\scripts\\buildsystems\\vcpkg.cmake',
    path.join(process.env.LOCALAPPDATA || '', 'vcpkg', 'scripts', 'buildsystems', 'vcpkg.cmake'),
  ].filter(Boolean);
  return candidates.find((p) => fs.existsSync(p)) || '';
}

/**
 * Run a command inside a vcvars64-initialised cmd.exe shell.
 * This ensures INCLUDE / LIB / PATH are set for MSVC even when the caller
 * is a plain PowerShell or Node process.
 */
function runCommandInVcvarsShell(vcvarsPath, command, args, cwd) {
  const quoteArgForCmd = (value) => {
    const text = String(value);
    if (!/[ \t"]/g.test(text)) {
      return text;
    }
    return `"${text.replace(/"/g, '""')}"`;
  };
  const inner = `call "${vcvarsPath}" && "${command}" ${args.map(quoteArgForCmd).join(' ')}`;
  const printable = `[vcvars64] ${command} ${args.join(' ')}`.trim();
  console.log(`[engine-stage] ${printable}`);
  const result = spawnSync(inner, [], {
    cwd,
    stdio: 'inherit',
    shell: 'cmd.exe',
  });
  if (result.status !== 0) {
    throw new Error(`command failed (${result.status}): ${printable}`);
  }
}

async function ensureDirectoryClean(directoryPath) {
  await fsp.rm(directoryPath, { recursive: true, force: true });
  await fsp.mkdir(directoryPath, { recursive: true });
}

function getPlatformDirectory() {
  if (process.platform === 'win32') {
    return 'win32';
  }
  if (process.platform === 'darwin') {
    return 'darwin';
  }
  return 'linux';
}

function getBinaryName() {
  return process.platform === 'win32' ? 'ec2_headless.exe' : 'ec2_headless';
}

function getRuntimeLibraryPattern() {
  if (process.platform === 'win32') {
    return /\.dll$/i;
  }
  if (process.platform === 'darwin') {
    return /\.dylib$/i;
  }
  return /\.so(\..+)?$/i;
}

async function findFirstExistingPath(candidatePaths) {
  for (const candidatePath of candidatePaths) {
    try {
      await fsp.access(candidatePath);
      return candidatePath;
    } catch {
      // continue searching
    }
  }
  return '';
}

async function walkDirectory(rootPath, onFile) {
  const entries = await fsp.readdir(rootPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(rootPath, entry.name);
    if (entry.isDirectory()) {
      await walkDirectory(fullPath, onFile);
      continue;
    }
    if (entry.isFile()) {
      await onFile(fullPath, entry.name);
    }
  }
}

async function stageRuntimeLibraries(sourceDirectories, destinationDirectory) {
  const pattern = getRuntimeLibraryPattern();
  const discovered = new Map();

  for (const sourceDirectory of sourceDirectories) {
    if (!sourceDirectory) {
      continue;
    }
    if (!fs.existsSync(sourceDirectory)) {
      continue;
    }

    await walkDirectory(sourceDirectory, async (fullPath, fileName) => {
      if (!pattern.test(fileName)) {
        return;
      }

      const key = fileName.toLowerCase();
      if (!discovered.has(key)) {
        discovered.set(key, fullPath);
      }
    });
  }

  const staged = [];
  for (const [key, sourcePath] of discovered.entries()) {
    const targetPath = path.join(destinationDirectory, path.basename(sourcePath));
    await fsp.copyFile(sourcePath, targetPath);
    staged.push({
      key,
      sourcePath,
      targetPath,
    });
  }

  return staged;
}

async function main() {
  const platformDirectory = getPlatformDirectory();
  const binaryName = getBinaryName();
  const buildConfiguration = process.env.GRANUPOSE_ENGINE_BUILD_CONFIG || 'Release';
  const skipSubmoduleUpdate = parseBoolean(process.env.GRANUPOSE_ENGINE_SKIP_SUBMODULE_UPDATE);
  const skipBuild = parseBoolean(process.env.GRANUPOSE_ENGINE_SKIP_BUILD);
  const skipVcvars = parseBoolean(process.env.GRANUPOSE_ENGINE_SKIP_VCVARS);

  const poseControllerRoot = path.resolve(__dirname, '..');
  const workspaceRoot = path.resolve(poseControllerRoot, '..');
  const ecRoot = path.resolve(workspaceRoot, 'EmissionControl2');
  const ecSourceRoot = path.resolve(ecRoot, 'ecSource');
  const buildRoot =
    process.env.GRANUPOSE_ENGINE_BUILD_DIR &&
    process.env.GRANUPOSE_ENGINE_BUILD_DIR.trim().length > 0
      ? path.resolve(process.cwd(), process.env.GRANUPOSE_ENGINE_BUILD_DIR.trim())
      : path.resolve(workspaceRoot, '.build', 'ec2_headless', platformDirectory);

  const stageBinaryDir = path.resolve(poseControllerRoot, 'engine-bin', platformDirectory);
  const stageResourcesRoot = path.resolve(poseControllerRoot, 'engine-resources');
  const stageSamplesDir = path.resolve(stageResourcesRoot, 'samples');
  const stageLibsDir = path.resolve(stageResourcesRoot, 'libs');
  const stageManifestPath = path.resolve(stageResourcesRoot, 'stage-manifest.json');

  if (!fs.existsSync(ecSourceRoot)) {
    throw new Error(`EC2 source directory not found: ${ecSourceRoot}`);
  }

  if (!skipSubmoduleUpdate) {
    runCommand('git', ['submodule', 'update', '--init', '--recursive'], workspaceRoot);
  } else {
    console.log('[engine-stage] skipping submodule update (GRANUPOSE_ENGINE_SKIP_SUBMODULE_UPDATE=1).');
  }

  // --- Resolve cmake and MSVC environment for the current platform ---
  const isWindows = process.platform === 'win32';
  const vcvarsPath = isWindows && !skipVcvars ? findVcvars64() : '';
  const vsCmakePath = isWindows ? findVsCmake() : '';
  const vcpkgToolchain = isWindows ? findVcpkgToolchain() : '';

  // Prefer the VS-bundled cmake on Windows; fall back to PATH cmake.
  const cmakeBin = vsCmakePath || (commandExists('cmake') ? 'cmake' : '');
  const cmakeAvailable = Boolean(cmakeBin);
  const effectiveSkipBuild = skipBuild || !cmakeAvailable;

  if (!skipBuild && !cmakeAvailable) {
    console.warn('[engine-stage] cmake not found in PATH or VS installation; falling back to staging prebuilt binary.');
  }

  if (isWindows && cmakeAvailable) {
    console.log(`[engine-stage] vcvars64 : ${vcvarsPath || '(not found – using current env)'}`);
    console.log(`[engine-stage] cmake    : ${cmakeBin}`);
    console.log(`[engine-stage] vcpkg    : ${vcpkgToolchain || '(not found)'}`);
  }

  if (!effectiveSkipBuild) {
    // Build the cmake configure arguments.
    const configureArgs = ['-S', ecSourceRoot, '-B', buildRoot];
    if (isWindows) {
      configureArgs.push('-G', 'Visual Studio 17 2022', '-A', 'x64');
    } else {
      configureArgs.push('-DCMAKE_BUILD_TYPE=Release');
    }
    if (vcpkgToolchain) {
      configureArgs.push(`-DCMAKE_TOOLCHAIN_FILE=${vcpkgToolchain}`);
    }

    const buildArgs = [
      '--build', buildRoot,
      '--config', buildConfiguration,
      '--target', 'ec2_headless',
    ];

    // On Windows, run cmake inside a vcvars64-initialised shell so that
    // INCLUDE / LIB / PATH are set for MSVC even from a plain terminal.
    if (vcvarsPath) {
      runCommandInVcvarsShell(vcvarsPath, cmakeBin, configureArgs, workspaceRoot);
      runCommandInVcvarsShell(vcvarsPath, cmakeBin, buildArgs, workspaceRoot);
    } else {
      runCommand(cmakeBin, configureArgs, workspaceRoot);
      runCommand(cmakeBin, buildArgs, workspaceRoot);
    }
  } else {
    console.log('[engine-stage] skipping CMake build.');
  }

  const binaryCandidates = [
    path.resolve(ecSourceRoot, 'bin', binaryName),
    path.resolve(buildRoot, 'bin', binaryName),
    path.resolve(buildRoot, buildConfiguration, binaryName),
    path.resolve(buildRoot, binaryName),
  ];

  const builtBinaryPath = await findFirstExistingPath(binaryCandidates);
  if (!builtBinaryPath) {
    throw new Error(`ec2_headless binary not found. Checked: ${binaryCandidates.join(' | ')}`);
  }

  await fsp.mkdir(stageBinaryDir, { recursive: true });
  const stagedBinaryPath = path.resolve(stageBinaryDir, binaryName);
  await fsp.copyFile(builtBinaryPath, stagedBinaryPath);

  const samplesSourceDir = path.resolve(ecRoot, 'externalResources', 'samples');
  await ensureDirectoryClean(stageSamplesDir);
  if (!fs.existsSync(samplesSourceDir)) {
    throw new Error(`samples source directory not found: ${samplesSourceDir}`);
  }
  await fsp.cp(samplesSourceDir, stageSamplesDir, { recursive: true });

  await ensureDirectoryClean(stageLibsDir);
  const runtimeLibrarySources = [
    path.dirname(builtBinaryPath),
    path.resolve(ecSourceRoot, 'bin'),
    path.resolve(ecRoot, 'externalResources', 'libsndfile'),
  ];
  // Include vcpkg runtime DLLs when a vcpkg toolchain was used.
  if (vcpkgToolchain) {
    const vcpkgRoot = path.resolve(vcpkgToolchain, '..', '..', '..', '..');
    runtimeLibrarySources.push(path.join(vcpkgRoot, 'installed', 'x64-windows', 'bin'));
  }
  const stagedLibraries = await stageRuntimeLibraries(runtimeLibrarySources, stageLibsDir);

  const manifest = {
    generatedAt: new Date().toISOString(),
    platform: process.platform,
    platformDirectory,
    buildConfiguration,
    buildRoot,
    builtBinaryPath,
    stagedBinaryPath,
    samplesSourceDir,
    stageSamplesDir,
    stageLibsDir,
    stagedLibraries: stagedLibraries.map((entry) => ({
      sourcePath: entry.sourcePath,
      targetPath: entry.targetPath,
    })),
  };

  await fsp.mkdir(stageResourcesRoot, { recursive: true });
  await fsp.writeFile(stageManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('[engine-stage] completed successfully.');
  console.log(`[engine-stage] binary: ${stagedBinaryPath}`);
  console.log(`[engine-stage] samples: ${stageSamplesDir}`);
  console.log(`[engine-stage] libs: ${stageLibsDir} (${stagedLibraries.length} files)`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[engine-stage] ERROR: ${message}`);
  process.exit(1);
});
