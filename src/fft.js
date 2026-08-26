// Iterative radix-2 Cooley-Tukey FFT, in place. No dependencies.
// real/imag must have equal length, a power of two.
export function fft(real, imag) {
  const n = real.length;
  if (n & (n - 1)) {
    throw new Error("fft: length must be a power of two");
  }

  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [real[i], real[j]] = [real[j], real[i]];
      [imag[i], imag[j]] = [imag[j], imag[i]];
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    const half = len / 2;
    for (let i = 0; i < n; i += len) {
      let curWr = 1;
      let curWi = 0;
      for (let k = 0; k < half; k++) {
        const uRe = real[i + k];
        const uIm = imag[i + k];
        const vRe = real[i + k + half] * curWr - imag[i + k + half] * curWi;
        const vIm = real[i + k + half] * curWi + imag[i + k + half] * curWr;
        real[i + k] = uRe + vRe;
        imag[i + k] = uIm + vIm;
        real[i + k + half] = uRe - vRe;
        imag[i + k + half] = uIm - vIm;
        const nextWr = curWr * wr - curWi * wi;
        const nextWi = curWr * wi + curWi * wr;
        curWr = nextWr;
        curWi = nextWi;
      }
    }
  }
}
