# GPL Distribution Compliance Checklist (Standalone Bundle)

Last updated: 2026-02-19

## Scope

This checklist covers GPL-facing distribution obligations when bundling EmissionControl2 in GranuPose standalone artifacts.

## Required Artifacts

1. Include GPL license text for bundled component.
2. Include upstream notices/attribution text shipped with bundled component.
3. Include source-availability/source-offer reference in release bundle.
4. Include machine-readable compliance manifest in release bundle.
5. Ensure artifacts are copied into packaged output.

## Current Status

| Item | Status | Evidence |
| --- | --- | --- |
| GPL license text bundled | PASS | `pose-controller/release-compliance/licenses/EmissionControl2-GPL-3.0.txt` |
| Upstream notice bundled | PASS | `pose-controller/release-compliance/notices/EmissionControl2-notice.txt` |
| Source-offer/source URL included | PASS | `pose-controller/release-compliance/SOURCE_OFFER.txt` |
| Compliance manifest generated | PASS | `pose-controller/release-compliance/manifest.json` |
| Packaging config includes compliance dir | PASS | `pose-controller/package.json` (`build.extraResources -> release-compliance -> resources/compliance`) |

## Automation

Compliance artifacts are staged by:

- `npm run compliance:stage`
- Script: `pose-controller/scripts/stage-compliance.cjs`

Packaging pipeline includes compliance staging before `dist`:

- `npm run build:standalone`
- `npm run dist`

