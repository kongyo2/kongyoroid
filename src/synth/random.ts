export class Xorshift32 {
  private state: number;

  public constructor(seed: number) {
    this.state = seed >>> 0 || 0x9e3779b9;
  }

  public nextUint(): number {
    let r = this.state;
    r ^= r << 13;
    r ^= r >>> 17;
    r ^= r << 5;
    this.state = r >>> 0;
    return this.state;
  }

  public nextSigned(): number {
    return this.nextUint() / 2_147_483_648 - 1;
  }

  public nextUnit(): number {
    return this.nextUint() / 4_294_967_296;
  }
}

export function deriveSeed(seed: number, label: string): number {
  let hash = (seed >>> 0) ^ 0x811c9dc5;
  for (const char of label) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= hash >>> 16;
  hash = Math.imul(hash, 0x7feb352d) >>> 0;
  hash ^= hash >>> 15;
  hash = Math.imul(hash, 0x846ca68b) >>> 0;
  hash ^= hash >>> 16;
  return hash >>> 0 || 1;
}

export class GaussianNoise {
  private readonly random: Xorshift32;
  private spare: number | undefined;

  public constructor(seed: number) {
    this.random = new Xorshift32(seed);
  }

  public next(): number {
    if (this.spare !== undefined) {
      const value = this.spare;
      this.spare = undefined;
      return value;
    }
    let u = 0;
    let v = 0;
    let s = 0;
    do {
      u = this.random.nextSigned();
      v = this.random.nextSigned();
      s = u * u + v * v;
    } while (s >= 1 || s === 0);
    const factor = Math.sqrt((-2 * Math.log(s)) / s);
    this.spare = v * factor;
    return u * factor;
  }
}
