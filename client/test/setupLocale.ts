// The DOM fixtures use an English browser (jsdom's navigator.language) and
// English messages. Keep implicit numeric formatting consistent with that
// browser on Windows/Polish hosts too; explicit locale tests are untouched.
const nativeNumberFormat = Number.prototype.toLocaleString;
Number.prototype.toLocaleString = function (locales, options) {
  return nativeNumberFormat.call(this, locales ?? "en-US", options);
};
