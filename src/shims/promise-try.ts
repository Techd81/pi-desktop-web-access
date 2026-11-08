// Stand-in for the `promise.try` package.
//
// `upstream/pdf-extract.ts` imports it for one call — `promiseTry.shim()` —
// before handing the bytes to the PDF reader, so the reader can rely on
// `Promise.try` being present. The published package reaches `es-abstract`,
// `call-bind` and `function-bind`, and the last two call `Function()`, which the
// plugin center's fail-closed audit refuses in any shipped package.
//
// `Promise.try(fn, ...args)` calls `fn` synchronously and returns a promise that
// settles with its result, turning a synchronous throw into a rejection. The
// constructor below does exactly that: `resolve` adopts a returned thenable, and
// a throw inside the executor rejects the promise. `shim()` installs it only
// when the runtime does not already provide it, which is the same contract the
// package documents.
function promiseTry<T>(callback: () => T | PromiseLike<T>): Promise<T> {
  return new Promise<T>((resolve) => resolve(callback()));
}

promiseTry.shim = function shim(): void {
  const target = Promise as unknown as { try?: unknown };
  if (typeof target.try !== "function") target.try = promiseTry;
};

promiseTry.try = promiseTry;

export default promiseTry;
