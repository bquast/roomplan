# XRayRoom — Quest 3

WebXR `immersive-ar` (passthrough) x-ray of a room scanned with the XRayRoom iPhone app.
three.js r187 as local ESM files, no build step, no CDN.

## Deploy

Push to GitHub, branch `master`. Settings → Pages → Deploy from branch → `master` / root.
Open the Pages URL in the Quest Browser.

## Load a scan

- `?scan=my-room.json` loads a file from the repo.
- **Load model.json** picks a file on the Quest (for example a download from Google Drive).
- The menu lists the scans in the repo root: `airbnb.json` (first real scan) and `demo.json`.
  Add a scan: copy its `model.json` to the root with a new name and add one `<option>` in `index.html`.

## In the headset

1. **Enter AR.** A small model of the room shows in front of you. The longest wall is yellow.
2. **Align.** Face that wall. Aim at the floor at its left corner (green), pull trigger.
   Then the right corner (red). The x-ray locks onto the room. The panel shows the CAD wall length
   against your two points, as a check.
3. **Shoot.** Aim at a wall, pipe, outlet or furniture, pull trigger. The info panel opens at the hit.

| Control | Action |
|---|---|
| Trigger | shoot / pick floor point |
| A / X | align again |
| B / Y | layers: All, Structure, Services |
| Left stick | move the model |
| Right stick | rotate (left/right), height (up/down) |
| Grip | hide the panel |

**Record:** Meta button → Camera → Record video.

On a desktop browser you get an orbit preview: drag, wheel, click to shoot.
