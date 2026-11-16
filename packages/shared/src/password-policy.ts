export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

const DENYLIST = new Set([
  "password",
  "password1",
  "password123",
  "12345678",
  "123456789",
  "1234567890",
  "qwertyui",
  "qwerty123",
  "letmein!",
  "welcome1",
  "admin123",
  "iloveyou",
]);

const DIGITS = "0123456789";
const DIGITS_REV = "9876543210";
const ALPHABET = "abcdefghijklmnopqrstuvwxyz";
const ALPHABET_REV = "zyxwvutsrqponmlkjihgfedcba";

function hasRepetition(str: string): boolean {
  const len = str.length;
  for (let unitLen = 1; unitLen <= 4; unitLen++) {
    if (len % unitLen === 0) {
      const unit = str.slice(0, unitLen);
      let matches = true;
      for (let i = unitLen; i < len; i += unitLen) {
        if (str.slice(i, i + unitLen) !== unit) {
          matches = false;
          break;
        }
      }
      if (matches) {
        return true;
      }
    }
  }
  return false;
}

export function newPasswordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) {
    return "Use at least 8 characters.";
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    return "Use no more than 256 characters.";
  }

  const lower = password.toLowerCase();

  if (DENYLIST.has(lower)) {
    return "Choose a less predictable password.";
  }

  if (hasRepetition(lower)) {
    return "Choose a less predictable password.";
  }

  if (
    DIGITS.includes(lower) ||
    DIGITS_REV.includes(lower) ||
    ALPHABET.includes(lower) ||
    ALPHABET_REV.includes(lower)
  ) {
    return "Choose a less predictable password.";
  }

  return null;
}
