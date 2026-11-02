import { Settings } from "luxon";
import { beforeEach } from "vitest";

// Test workers only: application locale/Intl and the host OS settings are unchanged.
const nativeFormatter = Symbol.for("rybbit.test.locale.nativeFormatter");
export const nativeNumberToLocaleString =
  (Reflect.get(Number.prototype.toLocaleString, nativeFormatter) as
    | typeof Number.prototype.toLocaleString
    | undefined) ?? Number.prototype.toLocaleString;
export const nativeDateToLocaleDateString =
  (Reflect.get(Date.prototype.toLocaleDateString, nativeFormatter) as
    | typeof Date.prototype.toLocaleDateString
    | undefined) ?? Date.prototype.toLocaleDateString;
export const hostIntl = Object.freeze({
  NumberFormat: Intl.NumberFormat,
  DateTimeFormat: Intl.DateTimeFormat,
  numberLocale: new Intl.NumberFormat().resolvedOptions().locale,
  dateLocale: new Intl.DateTimeFormat().resolvedOptions().locale,
});

function toLocaleString(this: number, ...args: Parameters<typeof Number.prototype.toLocaleString>) {
  if (args[0] === undefined) args[0] = "en-US";
  return Reflect.apply(nativeNumberToLocaleString, this, args);
}

function toLocaleDateString(this: Date, ...args: Parameters<typeof Date.prototype.toLocaleDateString>) {
  if (args[0] === undefined) args[0] = "en-US";
  return Reflect.apply(nativeDateToLocaleDateString, this, args);
}

// Direct descriptors survive vi.restoreAllMocks; symbols avoid nesting wrappers
// if a worker reevaluates this setup after a module-cache reset.
Object.defineProperty(toLocaleString, nativeFormatter, { value: nativeNumberToLocaleString });
Object.defineProperty(toLocaleDateString, nativeFormatter, { value: nativeDateToLocaleDateString });
Object.defineProperty(Number.prototype, "toLocaleString", {
  ...Object.getOwnPropertyDescriptor(Number.prototype, "toLocaleString"),
  value: toLocaleString,
});
Object.defineProperty(Date.prototype, "toLocaleDateString", {
  ...Object.getOwnPropertyDescriptor(Date.prototype, "toLocaleDateString"),
  value: toLocaleDateString,
});

const languages = Object.freeze(["en-US"]);
function resetLocale() {
  Object.defineProperties(navigator, {
    language: { configurable: true, get: () => "en-US" },
    languages: { configurable: true, get: () => languages },
  });
  Settings.defaultLocale = "en-US";
}

// Pin navigator before application imports can select their module-level locale.
resetLocale();
beforeEach(resetLocale);
