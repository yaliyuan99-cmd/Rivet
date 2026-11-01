/** A rough signal for the form, not a security control; the server enforces the minimum length. */
export function passwordStrength(password: string): 'Weak' | 'Fair' | 'Strong' {
  const variety = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(password)).length;
  if (password.length >= 14 && variety >= 2) return 'Strong';
  if (password.length >= 12 && variety >= 3) return 'Strong';
  if (password.length >= 10) return 'Fair';
  return 'Weak';
}
