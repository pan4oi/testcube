# Realistic Mode — webcam hand tracking

A second input path for the cube: pinch or fist a sticker, move your hand, and the
layer follows it. Release and it snaps to the nearest 90°. An open palm drag
orbits the whole cube. Mouse and touch keep working exactly as before.

## Running it

Realistic Mode needs a camera, and browsers only expose cameras to secure
origins. `file://` is not one of them, so double-clicking `index.html` plays the
game with the mouse but cannot start hand tracking. Serve the folder instead:

```bash
python3 -m http.server 8321
# open http://localhost:8321
```

Then start a game, press **Hands** (top right) or **H**, and allow the camera.
Leave the tab on `localhost`; `127.0.0.1` works too. HTTPS works if you host it.

The MediaPipe runtime and model are vendored in `vendor/mediapipe/`, so tracking
itself needs no network. Only the camera permission prompt is external.

## Gestures

| Gesture | Result |
| --- | --- |
| Thumb tip touches index tip over a sticker | Grab that layer |
| Closed fist over a sticker | Grab that layer (knuckles are the grab point) |
| Move the grabbing hand | Rotate the layer continuously |
| Open the hand | Ease to the nearest 90° and commit the move |
| Open palm drag | Orbit the whole cube |
| Two open palms, move them together | Orbit the whole cube |

`Esc` leaves the mode. Closing or solving the game turns the camera off.

While you are not grabbing, the cursor highlights a sticker you can reach and
labels it **Pinch to turn**. If tracking drops a frame mid-gesture, the layer
holds still for 180 ms before the snap, instead of ending the turn instantly.

## Files

| File | Responsibility |
| --- | --- |
| `js/hand-tracking.js` | `HandTracker`: getUserMedia, MediaPipe model, 30 fps detection loop, smoothing, typed errors. |
| `js/realistic-mode.js` | `RealisticMode`: landmark → screen → cube mapping, gesture state machine, cursor/preview overlay. |
| `js/controls.js` | Hand-gesture API on top of the existing cube machinery: `startHandLayer`, `rotateHandLayer`, `endHandLayer`, `startHandOrbit`, `rotateHandOrbit`, `endHandOrbit`. |
| `index.html` | Camera panel, toggle button, script order. |
| `style.css` | Panel, cursor and toggle styling. Sized in px/vw because the game scales its root font to the viewport. |
| `vendor/mediapipe/` | Tasks Vision 1.1.1 (`vision_bundle.js`), SIMD wasm, `hand_landmarker.task`. |

MediaPipe Tasks Vision is Apache-2.0; the hand model comes from Google's
`mediapipe-models` bucket. Versions: `@mediapipe/tasks-vision@1.1.1`.

## How the mapping works

1. **Hands → screen.** MediaPipe returns 21 landmarks normalized to the video
   frame. `x` is mirrored (`1 - x`) because the preview is a mirror and moving
   your hand right should move the pointer right. The result is scaled to the
   canvas. The pinch point is the midpoint of the thumb and index tips.
2. **Screen → cube.** A ray is cast from the camera through that point at
   `game.cube.cubes`. The first hit gives a piece, a world point and a face.
3. **Face normal.** The hit face normal is transformed into cube-local space and
   quantized to the nearest axis. This is more reliable than the dominant
   coordinate of the hit point, which is ambiguous on corners.
4. **Drag direction.** Camera right/up are projected onto the grabbed face, then
   the hand's screen motion picks the dominant one. A face tangent `t` and a
   radius `r` (cube centre → grabbed point) define the rotation axis:

   `A = r × t`

   because angular velocity is `A × r`. `A` is quantized to the nearest cube
   axis, and the layer at the grabbed piece's coordinate on that axis is selected.
5. **Angle.** The hand ray is intersected with a plane through the grabbed point
   facing the camera, giving a real 3D movement vector. Its dot product with the
   actual tangent (`A × r`) divided by `r.length()` is the angle. Per-frame
   rotation is clamped to ±0.35 rad so a tracking jump cannot spin a layer.
6. **Release.** `flipAngle` is rounded to a multiple of π/2 and tweened there by
   `Controls.rotateLayer`, which re-parents the pieces, saves the game and runs
   the solved check — the same path as a mouse move. A rotation that would snap
   back to zero is cancelled without counting as a move.
7. **Orbit.** Drag deltas map to yaw about world Y and pitch about world X.
   On release the orientation is snapped to the closest of the cube's 24
   axis-aligned orientations (quaternion comparison), not by rounding Euler
   angles. That keeps the solved check — which buckets stickers by world axis —
   valid.

## Tuning

| Constant | Where | Effect |
| --- | --- | --- |
| `PINCH_START` / `PINCH_END` | `realistic-mode.js` | Pinch hysteresis, relative to wrist–middle-MCP span. Lower = harder to trigger. |
| `GRAB_DEADZONE` | `realistic-mode.js` | Pixels of movement before the axis locks. |
| `ORBIT_DEADZONE` | `realistic-mode.js` | Pixels before an open palm starts orbiting. |
| `Turn sensitivity` slider | `realistic-mode.js` | Overall layer sensitivity, 0.6–2.0×, persisted as `theCube_handsSensitivity` in localStorage. Default 1.15. |
| `LOST_GRACE` | `realistic-mode.js` | How long a grab/orbit survives without a hand before snapping (180 ms). |
| `minInterval` | `hand-tracking.js` | Detection rate (default 33 ms ≈ 30 fps). |
| `smoothAlpha` | `hand-tracking.js` | Low-pass strength; higher = snappier, noisier. |
| `numHands` | `hand-tracking.js` | 2 by default; 1 halves the work if two-handed orbit is not needed. |

## Performance

- Detection runs at ~30 fps on the main thread; `detectForVideo` is skipped when
  the video frame has not advanced. The cube's own rAF loop is untouched.
- GPU delegate is requested first; if the device rejects it the tracker retries
  on CPU.
- Assets are local: 156 KB bundle, 13.5 MB SIMD wasm, 7.8 MB model. They are only
  fetched when the user enables the mode.
- Landmarks are smoothed with a one-pole filter keyed by hand, so a hand leaving
  and re-entering the frame does not inherit a stale position.

## Known limitations

- Monocular depth (`landmark.z`) is noisy, so grab depth is fixed at the sticker's
  depth; the 3D motion vector comes from the ray/plane intersection instead.
- Very low light, motion blur, or a hand partly outside the frame will drop
  tracking; the current rotation snaps and ends rather than hanging.
- SIMD is assumed for the wasm build (all current browsers support it). The
  non-SIMD build is not vendored.

## Possible next steps

- Highlight the whole layer that will turn, not just the sticker under the
  cursor (the axis is only known once the drag direction is clear).
- Two-hand twist (both palms rotating in opposite directions) for a whole-cube
  roll instead of orbit.
- Optional zoom by moving both palms closer/farther apart.
- Move detection into a Web Worker to keep the main thread free on low-end
  laptops.
