import { DateTime, Settings } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";
import { hostIntl, nativeDateToLocaleDateString, nativeNumberToLocaleString } from "./setupLocale";

const date = new Date("2024-03-15T12:30:00Z");
const result = (fn: () => unknown) => {
  try {
    return { value: fn() };
  } catch (error) {
    const exception = error as Error;
    return { errorType: exception.constructor, errorName: exception.name, message: exception.message };
  }
};

export function registerLocaleFixtureProof(environment: "node" | "dom") {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe.sequential(`${environment} deterministic locale fixture`, () => {
    it("pins navigator before imports without replacing its other capabilities", () => {
      expect(navigator.language).toBe("en-US");
      expect(navigator.languages).toEqual(["en-US"]);
      expect(typeof navigator.userAgent).toBe("string");
      if (environment === "dom") expect(window.navigator).toBe(navigator);
      else expect(typeof window).toBe("undefined");
      expect(Settings.defaultLocale).toBe("en-US");
      expect(DateTime.fromISO("2024-03-15").toFormat("MMMM")).toBe("March");
    });

    it("uses en-US only for absent/undefined locale while retaining supplied options", () => {
      expect((12345.67).toLocaleString()).toBe("12,345.67");
      expect((12345.67).toLocaleString(undefined, { style: "currency", currency: "EUR" })).toBe(
        Reflect.apply(nativeNumberToLocaleString, 12345.67, ["en-US", { style: "currency", currency: "EUR" }])
      );
      expect(date.toLocaleDateString()).toBe(Reflect.apply(nativeDateToLocaleDateString, date, ["en-US"]));
      const options: Intl.DateTimeFormatOptions = { timeZone: "UTC", month: "long", year: "numeric", day: "2-digit" };
      expect(date.toLocaleDateString(undefined, options)).toBe(
        Reflect.apply(nativeDateToLocaleDateString, date, ["en-US", options])
      );
    });

    it.each(["pl-PL", "de-DE", "ar-EG"])("preserves native explicit %s output including Luxon overrides", locale => {
      const numberOptions: Intl.NumberFormatOptions = { style: "currency", currency: "EUR", minimumFractionDigits: 3 };
      const dateOptions: Intl.DateTimeFormatOptions = {
        timeZone: "UTC",
        year: "numeric",
        month: "long",
        day: "numeric",
      };
      expect((12345.67).toLocaleString(locale, numberOptions)).toBe(
        Reflect.apply(nativeNumberToLocaleString, 12345.67, [locale, numberOptions])
      );
      expect(date.toLocaleDateString(locale, dateOptions)).toBe(
        Reflect.apply(nativeDateToLocaleDateString, date, [locale, dateOptions])
      );
      Settings.defaultLocale = locale;
      expect(DateTime.fromJSDate(date, { zone: "UTC" }).toLocaleString(DateTime.DATE_FULL)).toBe(
        new Intl.DateTimeFormat(locale, dateOptions).format(date)
      );
    });

    it("preserves native null/invalid arguments, receivers, boxed numbers and invalid dates", () => {
      const argumentsToCheck: unknown[][] = [
        [null],
        ["not_a_locale"],
        [["de-DE", "pl-PL"]],
        [[], { maximumFractionDigits: 1 }],
        [undefined, null],
        [undefined, { minimumFractionDigits: -1 }],
      ];
      for (const args of argumentsToCheck) {
        expect(result(() => Reflect.apply(Number.prototype.toLocaleString, 1234, args))).toEqual(
          result(() =>
            Reflect.apply(nativeNumberToLocaleString, 1234, args[0] === undefined ? ["en-US", ...args.slice(1)] : args)
          )
        );
        expect(result(() => Reflect.apply(Date.prototype.toLocaleDateString, date, args))).toEqual(
          result(() =>
            Reflect.apply(
              nativeDateToLocaleDateString,
              date,
              args[0] === undefined ? ["en-US", ...args.slice(1)] : args
            )
          )
        );
      }
      for (const receiver of [null, undefined, {}, "1234"]) {
        expect(result(() => Reflect.apply(Number.prototype.toLocaleString, receiver, []))).toEqual(
          result(() => Reflect.apply(nativeNumberToLocaleString, receiver, ["en-US"]))
        );
        expect(result(() => Reflect.apply(Date.prototype.toLocaleDateString, receiver, []))).toEqual(
          result(() => Reflect.apply(nativeDateToLocaleDateString, receiver, ["en-US"]))
        );
      }
      expect(new Number(1234).toLocaleString()).toBe("1,234");
      expect(new Date(NaN).toLocaleDateString()).toBe(
        Reflect.apply(nativeDateToLocaleDateString, new Date(NaN), ["en-US"])
      );
    });

    it("does not replace Intl constructors or change the host's default Intl locale", () => {
      expect(Intl.NumberFormat).toBe(hostIntl.NumberFormat);
      expect(Intl.DateTimeFormat).toBe(hostIntl.DateTimeFormat);
      expect(new Intl.NumberFormat().resolvedOptions().locale).toBe(hostIntl.numberLocale);
      expect(new Intl.DateTimeFormat().resolvedOptions().locale).toBe(hostIntl.dateLocale);
      expect(Reflect.apply(nativeNumberToLocaleString, 12345.67, [])).toBe(new Intl.NumberFormat().format(12345.67));
    });

    it("survives mock restoration and restores the pinned native navigator after global stubs", () => {
      const navigatorBeforeStub = navigator;
      vi.spyOn(Number.prototype, "toLocaleString");
      vi.spyOn(Date.prototype, "toLocaleDateString");
      vi.stubGlobal("navigator", { language: "pl-PL", languages: ["pl-PL"] });
      expect(navigator.language).toBe("pl-PL");
      vi.restoreAllMocks();
      vi.unstubAllGlobals();
      expect(navigator).toBe(navigatorBeforeStub);
      expect(navigator.language).toBe("en-US");
      expect((12345).toLocaleString()).toBe("12,345");
      expect(date.toLocaleDateString()).toBe(Reflect.apply(nativeDateToLocaleDateString, date, ["en-US"]));
      Settings.defaultLocale = "pl-PL";
      Object.defineProperty(navigator, "language", { configurable: true, value: "de-DE" });
    });

    it("resets an earlier test's Luxon and navigator locale changes before the next test", () => {
      expect(Settings.defaultLocale).toBe("en-US");
      expect(navigator.language).toBe("en-US");
      expect(navigator.languages).toEqual(["en-US"]);
    });
  });
}
