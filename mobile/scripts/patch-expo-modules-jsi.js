const fs = require('node:fs');
const path = require('node:path');

const packageRoot = path.dirname(require.resolve('expo-modules-jsi/package.json'));
const version = require(path.join(packageRoot, 'package.json')).version;
if (version !== '57.1.1') {
  throw new Error(`Review the Expo JSI iOS patch for version ${version} before installing dependencies.`);
}

function replace(source, before, after, count) {
  const actual = source.split(before).length - 1;
  if (actual !== count) {
    throw new Error(`Expo JSI patch expected ${count} occurrences, found ${actual}: ${before}`);
  }
  return source.replaceAll(before, after);
}

const headerPath = path.join(packageRoot, 'apple/Sources/ExpoModulesJSI-Cxx/include/RuntimeScheduler.h');
const swiftPath = path.join(packageRoot, 'apple/Sources/ExpoModulesJSI/Runtime/JavaScriptRuntime.swift');

let header = fs.readFileSync(headerPath, 'utf8');
if (header.includes('SWIFT_RETURNS_RETAINED RuntimeScheduler(')) {
  header = replace(header, 'SWIFT_RETURNS_RETAINED RuntimeScheduler(', 'RuntimeScheduler(', 2);
  fs.writeFileSync(headerPath, header);
}

let swift = fs.readFileSync(swiftPath, 'utf8');
if (!swift.includes('private struct UnsafeSendableBox<Value>')) {
  swift = replace(swift, 'internal import jsi\n', `internal import jsi

// Expo's synchronous JSI callbacks keep these pointers alive for the duration of each call.
private struct UnsafeSendableBox<Value>: @unchecked Sendable {
  let value: Value

  init(_ value: Value) {
    self.value = value
  }
}
`, 1);
  swift = replace(swift, 'nonisolated(unsafe) let resultPtr = resultPtr', 'let resultPtr = UnsafeSendableBox(resultPtr)', 3);
  swift = replace(swift, 'nonisolated(unsafe) let thisPtr = thisPtr', 'let thisPtr = UnsafeSendableBox(thisPtr)', 2);
  swift = replace(swift, 'nonisolated(unsafe) let argumentsPtr = argumentsPtr', 'let argumentsPtr = UnsafeSendableBox(argumentsPtr)', 2);
  swift = replace(swift, 'writeJSIValue(to: resultPtr)', 'writeJSIValue(to: resultPtr.value)', 3);
  swift = replace(swift, 'UnsafeMutablePointer(mutating: thisPtr).move()', 'UnsafeMutablePointer(mutating: thisPtr.value).move()', 1);
  swift = replace(swift, 'JavaScriptValuesBuffer(runtime, start: argumentsPtr, count: argumentsCount)', 'JavaScriptValuesBuffer(runtime, start: argumentsPtr.value, count: argumentsCount)', 2);
  swift = replace(swift, 'JavaScriptUnownedValue(runtime.pointee, thisPtr)', 'JavaScriptUnownedValue(runtime.pointee, thisPtr.value)', 1);
  fs.writeFileSync(swiftPath, swift);
}

console.log('Applied Expo JSI iOS compatibility patch.');
