/**
 * OpenCV.js async loader.
 *
 * @techstark/opencv-js ships a WASM build that initializes asynchronously.
 * Consumers must await cvReady() before calling any cv.* function.
 */

import cv from '@techstark/opencv-js';

let readyPromise: Promise<typeof cv> | null = null;

export function cvReady(): Promise<typeof cv> {
  if (readyPromise) return readyPromise;
  readyPromise = new Promise((resolve) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const anyCv = cv as any;
    console.log('[grader] cvReady: inspecting cv', {
      cvType: typeof anyCv,
      matType: typeof anyCv?.Mat,
      runtimeInitType: typeof anyCv?.onRuntimeInitialized,
      keyCount: anyCv ? Object.keys(anyCv).length : -1,
      firstKeys: anyCv ? Object.keys(anyCv).slice(0, 8) : [],
    });

    if (anyCv.Mat && typeof anyCv.Mat === 'function') {
      console.log('[grader] cvReady: cv.Mat already defined, resolving immediately');
      resolve(cv);
      return;
    }

    // Heartbeat so we can tell from the console whether we're still waiting
    // or whether onRuntimeInitialized never fires.
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
      console.log(`[grader] cvReady: still waiting, tick ${ticks}, cv.Mat=${typeof anyCv?.Mat}`);
      // Also check if Mat became available without the callback firing.
      if (anyCv?.Mat && typeof anyCv.Mat === 'function') {
        console.warn('[grader] cvReady: cv.Mat appeared without onRuntimeInitialized firing — resolving');
        clearInterval(heartbeat);
        resolve(cv);
      }
    }, 2000);

    console.log('[grader] cvReady: installing onRuntimeInitialized callback');
    anyCv.onRuntimeInitialized = () => {
      console.log('[grader] cvReady: onRuntimeInitialized fired');
      clearInterval(heartbeat);
      resolve(cv);
    };
  });
  return readyPromise;
}

export { cv };
