// Little-endian binary cursor + growable writer for Unreal GVAS save files.
// Strings use Unreal's FString convention: int32 length prefix; positive =>
// ASCII/UTF-8 (length includes the trailing null), negative => UTF-16LE
// (abs length = char count including the null terminator).

export class BinaryReader {
  private view: DataView;
  pos = 0;

  constructor(public bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }

  get remaining(): number {
    return this.bytes.length - this.pos;
  }

  u8(): number {
    return this.view.getUint8(this.pos++);
  }

  i32(): number {
    const v = this.view.getInt32(this.pos, true);
    this.pos += 4;
    return v;
  }

  u32(): number {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }

  i64(): bigint {
    const v = this.view.getBigInt64(this.pos, true);
    this.pos += 8;
    return v;
  }

  f32(): number {
    const v = this.view.getFloat32(this.pos, true);
    this.pos += 4;
    return v;
  }

  bool(): boolean {
    return this.u8() !== 0;
  }

  take(n: number): Uint8Array {
    const slice = this.bytes.subarray(this.pos, this.pos + n);
    this.pos += n;
    return slice;
  }

  fstring(): string {
    const len = this.i32();
    if (len === 0) return "";
    if (len < 0) {
      const chars = -len;
      const byteLen = chars * 2;
      let out = "";
      for (let i = 0; i < chars - 1; i++) {
        out += String.fromCharCode(this.view.getUint16(this.pos + i * 2, true));
      }
      this.pos += byteLen;
      return out;
    }
    let out = "";
    for (let i = 0; i < len - 1; i++) out += String.fromCharCode(this.bytes[this.pos + i]!);
    this.pos += len;
    return out;
  }
}

export class BinaryWriter {
  private buf = new Uint8Array(1024);
  private view = new DataView(this.buf.buffer);
  pos = 0;

  private ensure(n: number): void {
    if (this.pos + n <= this.buf.length) return;
    let cap = this.buf.length * 2;
    while (cap < this.pos + n) cap *= 2;
    const next = new Uint8Array(cap);
    next.set(this.buf.subarray(0, this.pos));
    this.buf = next;
    this.view = new DataView(this.buf.buffer);
  }

  u8(v: number): void {
    this.ensure(1);
    this.view.setUint8(this.pos++, v);
  }

  i32(v: number): void {
    this.ensure(4);
    this.view.setInt32(this.pos, v, true);
    this.pos += 4;
  }

  u32(v: number): void {
    this.ensure(4);
    this.view.setUint32(this.pos, v, true);
    this.pos += 4;
  }

  i64(v: bigint): void {
    this.ensure(8);
    this.view.setBigInt64(this.pos, v, true);
    this.pos += 8;
  }

  f32(v: number): void {
    this.ensure(4);
    this.view.setFloat32(this.pos, v, true);
    this.pos += 4;
  }

  bool(v: boolean): void {
    this.u8(v ? 1 : 0);
  }

  raw(bytes: Uint8Array): void {
    this.ensure(bytes.length);
    this.buf.set(bytes, this.pos);
    this.pos += bytes.length;
  }

  fstring(s: string): void {
    if (s.length === 0) {
      this.i32(0);
      return;
    }
    const wide = !isAscii(s);
    if (wide) {
      this.i32(-(s.length + 1));
      for (let i = 0; i < s.length; i++) {
        this.ensure(2);
        this.view.setUint16(this.pos, s.charCodeAt(i), true);
        this.pos += 2;
      }
      this.ensure(2);
      this.view.setUint16(this.pos, 0, true);
      this.pos += 2;
    } else {
      this.i32(s.length + 1);
      this.ensure(s.length + 1);
      for (let i = 0; i < s.length; i++) this.view.setUint8(this.pos++, s.charCodeAt(i));
      this.view.setUint8(this.pos++, 0);
    }
  }

  finish(): Uint8Array {
    return this.buf.subarray(0, this.pos);
  }
}

function isAscii(s: string): boolean {
  for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) return false;
  return true;
}
