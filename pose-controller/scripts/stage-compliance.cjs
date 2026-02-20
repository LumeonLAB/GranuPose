#!/usr/bin/env node

const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

async function ensureDirectory(directoryPath) {
  await fsp.mkdir(directoryPath, { recursive: true });
}

async function copyIfExists(sourcePath, targetPath) {
  if (!fs.existsSync(sourcePath)) {
    return false;
  }
  await ensureDirectory(path.dirname(targetPath));
  await fsp.copyFile(sourcePath, targetPath);
  return true;
}

async function main() {
  const poseControllerRoot = path.resolve(__dirname, '..');
  const workspaceRoot = path.resolve(poseControllerRoot, '..');
  const ec2Root = path.resolve(workspaceRoot, 'EmissionControl2');

  const complianceRoot = path.resolve(poseControllerRoot, 'release-compliance');
  const licenseDir = path.resolve(complianceRoot, 'licenses');
  const noticesDir = path.resolve(complianceRoot, 'notices');

  await fsp.rm(complianceRoot, { recursive: true, force: true });
  await ensureDirectory(licenseDir);
  await ensureDirectory(noticesDir);

  const copiedArtifacts = [];

  if (
    await copyIfExists(
      path.resolve(ec2Root, 'LICENSE'),
      path.resolve(licenseDir, 'EmissionControl2-GPL-3.0.txt'),
    )
  ) {
    copiedArtifacts.push('licenses/EmissionControl2-GPL-3.0.txt');
  }

  if (
    await copyIfExists(
      path.resolve(ec2Root, 'notice.txt'),
      path.resolve(noticesDir, 'EmissionControl2-notice.txt'),
    )
  ) {
    copiedArtifacts.push('notices/EmissionControl2-notice.txt');
  }

  const sourceUrl =
    process.env.GRANUPOSE_SOURCE_URL ||
    'https://github.com/EmissionControl2/EmissionControl2';
  const sourceOfferPath = path.resolve(complianceRoot, 'SOURCE_OFFER.txt');
  const sourceOfferText = [
    'GranuPose bundled component source availability notice',
    '',
    'This distribution bundles EmissionControl2, licensed under GPL-3.0-or-later.',
    'Complete corresponding source code for the bundled GPL component is available at:',
    sourceUrl,
    '',
    'If you received this binary without source, contact the distributor to request',
    'the corresponding source under GPL terms.',
    '',
    `Generated: ${new Date().toISOString()}`,
    '',
  ].join('\n');
  await fsp.writeFile(sourceOfferPath, sourceOfferText, 'utf8');
  copiedArtifacts.push('SOURCE_OFFER.txt');

  const readmePath = path.resolve(complianceRoot, 'README.md');
  const readmeText = [
    '# Release Compliance Bundle',
    '',
    'This directory is copied into packaged artifacts at `resources/compliance`.',
    '',
    'Included artifacts:',
    ...copiedArtifacts.map((entry) => `- \`${entry}\``),
    '',
  ].join('\n');
  await fsp.writeFile(readmePath, `${readmeText}\n`, 'utf8');
  copiedArtifacts.push('README.md');

  const manifestPath = path.resolve(complianceRoot, 'manifest.json');
  const manifest = {
    generatedAt: new Date().toISOString(),
    component: 'EmissionControl2',
    license: 'GPL-3.0-or-later',
    sourceUrl,
    artifacts: copiedArtifacts,
  };
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  console.log('[compliance-stage] completed successfully.');
  console.log(`[compliance-stage] output: ${complianceRoot}`);
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[compliance-stage] ERROR: ${message}`);
  process.exit(1);
});

