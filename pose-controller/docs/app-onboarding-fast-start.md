# GranuPose App Onboarding (Fast Start)

This runbook is for starting the app quickly and validating core GUI/functionality in 5-10 minutes.

## 0) Prerequisites

- Windows PowerShell
- Node.js + npm installed
- Webcam connected and allowed by OS/browser permissions
- Optional: Docker Desktop running (only for containerized mode)

## 1) Fastest Start (Recommended): Desktop Electron Mode

Run from repo root:

```powershell
cd .\pose-controller
npm ci
npm run dev
```

Expected result:
- Electron app opens.
- Camera preview appears.
- `Output` panel and `Managed Engine` panel are visible.

## 2) 5-10 Minute GUI + Functionality Smoke

Inside the app:

1. Camera:
- Pick your camera device if needed.
- Confirm live preview and pose overlay are active.

2. Output setup:
- `Protocol` = `OSC`.
- `Managed Local Engine` = ON.
- Click `Apply OSC Settings`.

3. Engine startup:
- In `Managed Engine`, click `Start`.
- Wait for status chip to show running state (and no startup errors).

4. Audio bridge baseline:
- In `EC2 Audio Bridge`, click `Select Sound File` and load a WAV.
- Optional quick sample path: `pose-controller\engine-resources\samples\440sine48k.wav`.
- Click `Apply Main Output` if you need to force audio device routing.

5. Transport + motion:
- Click `Play (Audio On)`.
- Move in front of camera.
- Confirm output activity: `msgs/sec` increases and mapping `Live` values update.

6. Record cycle:
- Set `Record File Name` and `Output Folder`.
- Click `Record Start`, wait 3-5s, click `Record Stop`.
- Confirm file appears in `Recorded Files` list.

7. Shutdown:
- Click `Audio Off`.
- Close app (or click `Stop` in `Managed Engine` first).

## 3) Hosted Mode (No Electron)

Use this if you want browser + bridge runtime:

```powershell
cd .\pose-controller
npm ci
npm run dev:hosted
```

Then open `http://localhost:5173`.

Notes:
- Browser mode has fewer host-integrated capabilities than desktop Electron mode.
- For non-localhost hosting, webcam requires HTTPS.

## 4) Docker: Do You Need `--no-cache`?

Short answer: usually no.

Start with normal rebuild:

```powershell
cd .\pose-controller
npm run docker:down
npm run docker:up:no-monitor
```

Use `--no-cache` only when one of these is true:
- Behavior looks stale after normal `--build`.
- Base images/dependency layers changed and cache reuse is suspicious.
- You want a fully clean rebuild after a long gap.

No-cache commands:

```powershell
cd .\pose-controller
docker compose --profile prod build --no-cache --pull
docker compose --profile prod up
```

PowerShell wrapper variant with monitor:

```powershell
cd .\pose-controller
npm run docker:up -- --no-cache
```

Important:
- `prod` frontend `VITE_*` values are build args, so they require rebuild to take effect.
- Standard scripts already use `--build`; add `--no-cache` only when needed.

## 5) Quick Validation Commands (Optional but Useful)

```powershell
cd .\pose-controller
npm run validate:headless-smoke
npm run validate:b2-matrix
npm run validate:packaged-clean-smoke
```

Generated reports:
- `docs\headless-smoke-latest.json`
- `docs\b2-ec2-matrix-evidence-latest.json`
- `docs\packaged-clean-smoke-latest.json`

## 6) Troubleshooting Quick Hits

- Packaged app exits immediately:
```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
```
- No camera feed: verify OS camera permissions and close apps currently locking the camera.
- No audio output: verify `Protocol=OSC`, engine is running, source WAV is loaded, and click `Apply Main Output`.
