const bytesToHex = (bytes: ArrayBuffer): string =>
  Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (value: string | Uint8Array): Promise<string> => {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : Uint8Array.from(value);
  return bytesToHex(await crypto.subtle.digest("SHA-256", bytes));
};
