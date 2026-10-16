# Public photo attribution

These four PNG crops derive from the official VisA sample figure published by the SPot-the-Difference project, not from user/customer attachments.

## Expanded pack: 20 additional photographs

The `board-*-*_redacted.png` files are twenty distinct full-object photographs retrieved from the official VisA archive at https://amazon-visual-anomaly.s3.us-west-2.amazonaws.com/VisA_20220922.tar under the same CC BY 4.0 license and authorship below. Together with the original four crops, the package contains 24 pictures. `photo-manifest.json` records each archive member, exact byte range, original SHA-256 and prepared PNG SHA-256. `scripts/prepare_public_photo_pack.py` reproduces the preparation from the four documented local archive ranges.

Changes: oriented as recorded, resized to a longest edge of at most 960 pixels and stripped of metadata; no synthetic damage, labels or answer frames added. All twenty added originals are from the upstream `Normal` folders for pcb1–pcb4. Selection is targeted, not random or a representative evaluation split. Repeated board types are not 24 independent fault categories. The tasks test visual description, visible component locations, missing information and safe escalation, not anomaly-detection benchmark performance. Questions, policies and reference answers are platform-authored, not historical customer records. Reviewed locally October 14, 2026; exact file fingerprints alone qualify for the reviewed-public-image path, never arbitrary user uploads.

- Dataset: Visual Anomaly (VisA).
- Authors: Yang Zou, Jongheon Jeong, Latha Pemula, Dongqing Zhang, Onkar Dabeer.
- Paper: *SPot-the-Difference Self-Supervised Pre-training for Anomaly Detection and Segmentation*, ECCV 2022.
- Repository: https://github.com/amazon-science/spot-diff
- Source figure: https://raw.githubusercontent.com/amazon-science/spot-diff/main/figures/VisA_samples.png
- Dataset license: Creative Commons Attribution 4.0 International, as stated in the upstream README's License section. https://creativecommons.org/licenses/by/4.0/
- Source figure SHA-256: `d707e2e95d3b98336c99e2b8aa6049f65f1f7044542f2839a63df74b9ba3a629`.
- Retrieved and reviewed: October 14, 2026.

Changes: cropped four PCB photograph regions; removed answer-encoding colored borders and original metadata; saved pixels as RGB PNG without enlargement or synthetic inpainting. The preparation script checks the source hash and reproduces the crops. The original downloaded figure is preserved outside this package.

Chinese customer questions, references and the illustrative service policy are authored by this platform. They are not customer utterances or official VisA annotations. These low-resolution illustrative crops are not a VisA benchmark test split. Do not report their scores as VisA performance, production containment or a representative customer-service evaluation. No endorsement by the original authors is implied.

Image filenames use a `_redacted` suffix to indicate border/metadata removal. Local automated checks and visual review did not identify personal data in these four crops; that does not guarantee absolute safety.
