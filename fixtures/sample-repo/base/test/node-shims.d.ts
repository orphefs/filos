// Just enough of node:test and node:assert for the tests to type-check without @types/node.
declare module 'node:test' {
  export function test(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface Assert {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, expected?: RegExp | Function | Error, message?: string): void;
  }
  const assert: Assert;
  export default assert;
}
