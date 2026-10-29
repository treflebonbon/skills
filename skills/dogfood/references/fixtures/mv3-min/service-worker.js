// Minimal MV3 service worker. Existence + registration is what the spike checks.
self.addEventListener("install", () => {
  console.log("[mv3-min-fixture] service worker installed");
});
globalThis.__MV3_MIN_FIXTURE_READY__ = true;
