# White pawn geometry audit

Audited asset: `prototypes/white-pawn/assets/white-pawn.glb`, SHA-256 `ebc1aa828665c9727781f365d4da584f8c2c7530490317ca12f4faef5a7a0618`.

Read-only source investigation. No repository files, model files, or git state changed. Numeric results are written to `geometry-overlaps.json.gz`; the scratch-only audit script is `pawn_geometry_audit.py`.

## Confirmed defects

### 1. The two brown upper-back blobs are shoulder straps passing through the body

- The red circles in `upload/01-1000280243.jpg` mark the rear ends of `ARMOR_Shoulder leather strap` and `ARMOR_Shoulder leather strap.001`. These are not shield enarmes or isolated decorative studs.
- `scripts/build_pawn.py`, lines 133–134, creates each as an eight-sided tube of radius 0.018 m through only three points: `(±0.11, -0.11, 1.435)`, `(±0.13, -0.02, 1.507)`, `(±0.115, 0.102, 1.44)`. Both use a rigid `spine01` attachment.
- The visible rear fragments are connected to longer geometry hidden inside the shoulder/torso. The path is not fitted to the garment or anatomy. The exact source objects have 24 base vertices each.
- At neutral frame 0, BVH reports actual surface crossings with `CLOTH_Underarm and leggings`: 239 triangle pairs for the first strap and 284 for `.001`. Both also cross `BODY_Human` (11 and 12 pairs) and the restored intact base-body surface (134 pairs each).
- The overlap is present throughout the initial sample of all three clips, including `Guard_Breath` frame 140.7 / 4.69 s, matching the time visible in the user's mobile screenshot. This is a fitted-geometry defect present at rest, not merely a transient animation artifact.

Required correction: replace the hard-coded tube paths with continuous flat leather straps following the outside of the garment, with visible and mechanically coherent front/back plate attachments. Fit against the complete underlying body/garment surface. Verify strap clearance in the same evaluated pose used for export. Do not hide the visible blobs while leaving a route through the torso.

### 2. Proximal shield enarme crosses the left vambrace

- Exact pair: `SHIELD_Leather enarme 0` and `ARMOR_Vambrace L`.
- At neutral frame 0 and every initially sampled pose, BVH finds 38 triangle-pair surface crossings.
- The intersection region is approximately `(0.2230, -0.1698, 1.2773)` m in Blender world coordinates at neutral. This is near the back of the proximal left forearm, not the torso.
- `build_pawn.py`, lines 292–301, makes the enarme arc with a fixed radius of 0.069 m, a width of 0.036 m, and thickness 0.004 m. The left vambrace uses the body's radial surface plus 0.023 m (`limb_cuff`, lines 162–173), so the two pieces have no shared clearance calculation.
- Both enarmes and their mounts are rigidly attached to `wrist.L`, while the vambrace is attached to `lowerarm01.L`. Their relative motion must be checked if wrist poses are revised.

Required correction: fit the enarme to the actual evaluated vambrace exterior with a deliberate clearance and coherent shield mounts; verify it after arm and wrist animation. Current intersection must not be dismissed as intentional strap contact.

## Not established from the current evidence

- Across every integer frame of all three clips, neither shield enarme crossed `CLOTH_Underarm and leggings`, the remaining `BODY_Human`, or the restored intact base body. The exact confirmed shield collision is with the vambrace. The shield brackets and crossbars also had no tested body/cloth surface crossing.
- The rear waist/thigh circle in `upload/02-1000280245.jpg` alone does not prove a penetration: the reinforcing crossbars are behind the figure. No crossbar/body or crossbar/cloth surface crossing was found at any tested integer frame.
- The thumb is being independently investigated by the pose agent; this report does not certify it.

## Method and limits

- Load the final authored `.blend` without saving it. Evaluate the saved animation actions with NLA tracks muted.
- Restore the intact `Human body` from the preserved base `.blend` solely as an audit reference, assigned to `WhitePawn_Rig`. This avoids confusing deleted hidden skin with actual geometric clearance.
- Build world-space triangle BVHs for evaluated meshes and test surface intersections. These counts are triangle pairs, not penetration volume or depth.
- Final sampling: every integer frame at 30 fps in all three clips, plus `Guard_Breath` frame 140.7 / 4.69 s. Total 424 evaluated poses.
- The audit evaluates the authored Blender scene. It does not claim that source triangle counts equal merged GLB triangle counts, or that continuous motion between sampled times is collision-free.

## Full-frame follow-up

Completed. No additional source/target intersection pairs appeared between the initial 0.4-second samples.

| Clip | Tested frames | Shoulder strap → cloth/body | Enarme 0 → left vambrace |
|---|---|---|---|
| `Guard_Breath` | 0–180 inclusive; also 140.7 | Both straps intersect on all 182 poses | 38 triangle pairs on all 182 poses |
| `Shield_Brace` | 0–120 inclusive | Both straps intersect on all 121 poses | 38 triangle pairs on all 121 poses |
| `Spear_Study` | 0–120 inclusive | Both straps intersect on all 121 poses | 38 triangle pairs on all 121 poses |

At neutral, 32 of 44 triangles of the first shoulder strap and 27 of 44 triangles of `.001` participate in cloth intersections. For the proximal enarme, 16 of 116 evaluated triangles participate in the vambrace intersections. This is more than a single coincident endpoint.

The earlier visual QA pass was insufficient: the upper-back strap ends were already visible in the rear screenshot, but continuity of the strap route and clearance were not verified. Full-view plausibility did not justify accepting those parts.
