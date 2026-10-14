# Vendored model weights

`selfie.json` / `selfie.bin` — MediaPipe Selfie Segmentation converted to TensorFlow.js graph format, taken unchanged from
[`@vladmandic/human-models`](https://www.npmjs.com/package/@vladmandic/human-models) 3.0.4 (MIT; the original model is
Google MediaPipe, Apache-2.0). Used by `src/lib/imagefilter-core.js` for the body filter's torso silhouette. It is vendored
because the full models package is ~170 MB and only these ~300 KB are needed.

`mobilenet.json` / `mobilenet.bin` — MobileNetV2 (224 px, uint8-quantised Keras layers model) from the
[`nsfwjs`](https://www.npmjs.com/package/nsfwjs) 4.4.0 package (MIT), unpacked from its bundled JS modules into plain
TensorFlow.js files (weights unchanged). Used by `src/lib/embeddings.js` for the visual "More like this" vectors: only the
backbone up to the global pool runs; the package's classifier head is never used. ~2.6 MB.
