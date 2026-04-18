/**
 * OpenCV.js async loader.
 *
 * @techstark/opencv-js ships a WASM build that initializes asynchronously.
 * Consumers must await cvReady() before calling any cv.* function.
 *
 * IMPORTANT: cvReady() resolves with undefined, not the cv module. cv is an
 * Emscripten Module and has a `.then` method (so it can be awaited directly).
 * Passing it to Promise.resolve triggers the thenable-unwrapping protocol,
 * which recurses forever through cv.then and locks the main thread inside
 * microtask processing — the promise never settles, await never resumes.
 * Consumers should import `cv` directly from this module after awaiting.
 */

import cv from '@techstark/opencv-js';

let readyPromise: Promise<void> | null = null;

export function cvReady(): Promise<void> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise<void>((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyCv = cv as any;
    if (anyCv.Mat && typeof anyCv.Mat === 'function') {
      resolve();
      return;
    }
    anyCv.onRuntimeInitialized = () => resolve();
  });
  return readyPromise;
}

export { cv };
