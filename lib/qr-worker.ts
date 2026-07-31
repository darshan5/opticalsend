import { prepareZXingModule, readBarcodes } from "zxing-wasm/reader";

prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) =>
      path.endsWith(".wasm") ? "/zxing_reader.wasm" : prefix + path,
  },
});

const ctx = self as unknown as {
  onmessage: ((e: MessageEvent) => void) | null;
  postMessage(msg: unknown, transfer?: Transferable[]): void;
};

function extractChannel(rgba: Uint8ClampedArray, w: number, h: number, channel: number): ImageData {
  const out = new ImageData(w, h);
  const d = out.data;
  for (let i = 0; i < w * h; i++) {
    const v = rgba[i * 4 + channel]!;
    const o = i * 4;
    d[o] = v;
    d[o + 1] = v;
    d[o + 2] = v;
    d[o + 3] = 255;
  }
  return out;
}

ctx.onmessage = async (e: MessageEvent) => {
  const { id, buf, w, h, color } = e.data as {
    id: number; buf: ArrayBuffer; w: number; h: number; color?: boolean;
  };
  try {
    const rgba = new Uint8ClampedArray(buf);
    const allResults: Uint8Array[] = [];

    if (color) {
      const channels = [
        extractChannel(rgba, w, h, 0),
        extractChannel(rgba, w, h, 1),
        extractChannel(rgba, w, h, 2),
      ];
      for (const ch of channels) {
        const results = await readBarcodes(ch, { formats: ["QRCode"], maxNumberOfSymbols: 4 });
        for (const r of results) {
          if (r.isValid && r.bytes.length > 0) allResults.push(r.bytes);
        }
      }
    } else {
      const img = new ImageData(rgba, w, h);
      const results = await readBarcodes(img, { formats: ["QRCode"], maxNumberOfSymbols: 9 });
      for (const r of results) {
        if (r.isValid && r.bytes.length > 0) allResults.push(r.bytes);
      }
    }

    ctx.postMessage({ id, results: allResults });
  } catch {
    ctx.postMessage({ id, results: [] });
  }
};

void readBarcodes(new ImageData(8, 8), { formats: ["QRCode"] })
  .catch(() => undefined)
  .then(() => ctx.postMessage({ id: -1, results: [] }));
