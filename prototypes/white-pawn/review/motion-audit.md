# White pawn v0.1 — read-only motion audit

Audited asset: `prototypes/white-pawn/assets/white-pawn.glb`, SHA-256 `ebc1aa828665c9727781f365d4da584f8c2c7530490317ca12f4faef5a7a0618`.
Source: `scripts/pawn_pose.py`, equipment construction and baking in `scripts/build_pawn.py`. No repository edits. Face review is deferred.

## Current motion, as implemented

All clips reset every bone to its bind transform, apply the same guard/grip, then adjust torso/head/arms. There is no pelvis, leg, foot or root motion, no step, weight transfer, opponent or contact target. Both hands keep fixed local finger poses, which is normal for a held grip but means the initial grip must be correct.

- **Guard_Breath, 6 s:** sine cycle; spine01 rotates ±0.4°, both wrist targets move ±2 mm vertically. It is a very small idle motion, not a breathing deformation of the chest.
- **Shield_Brace, 4 s:** smooth rise 0.25–1.6 s, hold 1.6–2.0 s, smooth return 2.0–3.75 s; no motion outside that interval. Left wrist target moves 55 mm forward and 25 mm up, spine03 adds 2.1° forward rotation, head adds 1.5°. The shield follows the forearm with constant local wrist orientation. There is no body support action beyond torso rotation.
- **Spear_Study, 4 s:** smooth rise 0.25–1.75 s, hold 1.75–2.0 s, smooth return 2.0–3.75 s. Right wrist target moves 100 mm forward and 50 mm down; elbow pole rises; shaft rotates from vertical to 45° forward. The weapon is lowered/presented in an arc. This is not a linear tip-forward thrust or full-body lunge.

## Measurements of the delivered GLB

Independent GLB accessor parsing and hierarchical TRS evaluation at 30 Hz; coordinates converted back to Blender convention. Equipment points are actual source construction landmarks transformed by the final baked wrist matrices. Positive “forward” below means Blender −Y. Peak is 1.8 s for both action clips.

| Landmark | Shield_Brace forward | Shield_Brace up |
| --- | ---: | ---: |
| Left grip | 64.6 mm | 21.7 mm |
| Shield face center | 84.5 mm | 48.1 mm |
| Bottom center | 191.9 mm | 56.9 mm |
| Top center | **−24.6 mm** | 39.2 mm |

Shield tilt reaches 9.37°. The lower edge travels forward while the top travels backward, explaining the user's perception that the bottom swings instead of the whole shield being driven forward.

| Landmark | Spear_Study forward | Spear_Study up |
| --- | ---: | ---: |
| Right grip | 86.8 mm | −119.0 mm |
| Spear tip | 1193.5 mm | −577.4 mm |

At the peak, the shaft is still 45° above horizontal. Most tip travel comes from rotating the long weapon around the hand, rather than extending it along its axis. The grip movement differs from the wrist target because the grip sits approximately 0.1 m away from the wrist origin and rotates with it.

Root, both pelvis branches, leg joints and feet have zero change in their sampled world positions/rotations. Fixed feet prevent sliding but do not establish balance: there is no pelvis response or support transfer to assess. Endpoint agreement and a stationary support polygon cannot prove physical plausibility.

## Thumb / grip

The three thumb bones use separately derived axes `bone_direction × direction_to_palm_center`, then fixed additional rotations 28.90°, 63.23°, 13.17°. This is a geometric curling heuristic, not an authored opposition/abduction setup with explicit CMC/MCP/IP intent. The source hand is already curved, so these values are additional bone rotations, not anatomical joint angles. This is a risk to inspect, not proof that a particular joint is dislocated.

The function `measure_contacts()` excludes the thumb and checks only finger joint centers, so it cannot validate thumb-pad contact, skin shape or self-intersection. Existing file-integrity checks also do not validate those properties.

A narrow check of the final exported skin in neutral gave the same results for both hands:

- Vertices with total thumb-bone weight >0.25: nearest cylindrical radius 14.577 mm, versus a 14 mm leather handle.
- Distal-thumb patch with `finger1-3` weight >0.5: 440 vertices, all within the axial grip span; nearest radius 16.608 mm. Thus these vertices have at least 2.608 mm separation from the 14 mm cylinder (2.308 mm from spear binding rings of radius14.3 mm).

This patch test does not identify a precise thumb pad, does not test triangles against the cylinder, and does not test thumb-to-palm/finger self-intersection. It cannot certify a correct grip. Additional palm views expose the thumb base and a large fold, but the exact user-observed thumb defect is not established by the available screenshots. Do not claim a confirmed self-intersection or solved thumb from these measurements.

## Proposed acceptance gates for the next revision

1. **Approve the static hands first.** Author thumb opposition separately from MCP/IP flexion and inspect both hands from palm, thumb side, back and top. Identify the actual pad patch; require visible supported contact, no collapsed thumb base, no finger/shaft or thumb/palm penetration, and preserve the web space. Check the exported skin, not only bone locations.
2. **Give the shield a clear action.** Set an intended contact plane/target and require center and upper/lower shield regions to move together toward it, with a deliberate angular change. Coordinate shoulder/elbow extension with pelvis/knee/torso support. Choose whether both feet stay planted or one steps; then verify that choice. A larger bottom-edge sweep alone is not acceptance.
3. **Choose the spear's promise.** Keeping the current scope means naming it lowering/aiming/presenting the spear. A true thrust needs the tip aimed before the drive, measurable advance primarily along the shaft during extension, coordinated hip/torso/arm action, and recovery. It does not require an extreme lunge, but must not be described as one if the lower body remains frozen.
4. **Verify the final export at meaningful phases.** Static guard, preparation, extension/contact, and return; side and three-quarter views plus hand closeups. Measure foot drift for planted feet, weapon trajectory, wrist alignment and grip invariance. Check shield/body/armor clearance over the motion. Keep endpoint and finite-coordinate checks as technical gates, not realism evidence.
5. **State remaining limits.** A support-polygon or approximate body-center check is only a pose sanity check without a mass/dynamics model. Do not label the result a physically validated combat animation.

Machine-readable evidence: `/workspace/scratch/c3dfd1aa64e3/motion-numerics.json`. Inspection renders (shield hidden only for visibility; source file not saved): `audit-thumb-palm.png`, `audit-thumb-thumb.png`, `audit-thumb-palm_low.png`.
