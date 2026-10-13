# Vendored model weights

`selfie.json` / `selfie.bin` — MediaPipe Selfie Segmentation converted to TensorFlow.js graph format, taken unchanged from
[`@vladmandic/human-models`](https://www.npmjs.com/package/@vladmandic/human-models) 3.0.4 (MIT; the original model is
Google MediaPipe, Apache-2.0). Used by `src/lib/imagefilter-core.js` for the body filter's torso silhouette. It is vendored
because the full models package is ~170 MB and only these ~300 KB are needed.
