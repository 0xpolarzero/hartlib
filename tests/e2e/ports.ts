export const E2E_PORT_BASE_DEFAULT = 43_110;

const E2E_PORT_MIN = 1_024;
const E2E_PORT_MAX = 65_532;

export const parseE2ePortBase = (raw = process.env.HARTLIB_E2E_PORT_BASE): number => {
  if (raw === undefined || raw === "") return E2E_PORT_BASE_DEFAULT;
  if (!/^\d+$/u.test(raw)) {
    throw new Error("HARTLIB_E2E_PORT_BASE must be a decimal integer");
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < E2E_PORT_MIN || value > E2E_PORT_MAX) {
    throw new Error(
      `HARTLIB_E2E_PORT_BASE must be a safe integer between ${E2E_PORT_MIN} and ${E2E_PORT_MAX}`,
    );
  }
  return value;
};

export const e2ePortsFromBase = (base: number) => ({
  api: base,
  demo: base + 1,
  web: base + 2,
  objectStore: base + 3,
});
