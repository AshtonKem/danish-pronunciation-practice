/**
 * iOS's WebKit build of onnxruntime-web's WebGPU (JSEP) execution path is a
 * known, serious memory hazard, not just slow: WebKit has no native JS
 * Promise Integration, so ORT falls back to an asyncify-instrumented wasm
 * binary that's been reported to add on the order of 700MB of overhead *per
 * model session* on WebKit (confirmed in this app's own crash logs, which
 * traced through `ort-wasm-simd-threaded.asyncify.mjs`) — and even where
 * WebKit has since added JSEP support, that path has its own severe
 * CPU/memory issues (microsoft/onnxruntime#26827). Either way it silently
 * kills the tab with no catchable error and no console output, regardless
 * of how small the model otherwise is.
 *
 * There's no feature you can probe for "WebKit's webgpu EP is unsafe to
 * use" — `navigator.gpu` and `requestAdapter()` both succeed right up until
 * the tab dies. So this is an explicit platform carve-out, not a capability
 * check: on iOS, never route onnxruntime-web through the webgpu EP, and
 * fall back to plain wasm instead.
 */
export function isIosWebkit(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent);
}
