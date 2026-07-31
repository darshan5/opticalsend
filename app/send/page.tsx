"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import QRCode from "qrcode";
import { LTEncoder } from "@/lib/fountain";
import { HEADER_LEN, fnv1a, packFrame, wrapPayload, type FrameHeader } from "@/lib/protocol";

const MARGIN = 4;
const LOOKAHEAD = 3;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function SendPage() {
  const [mode, setMode] = useState<"file" | "text">("file");
  const [file, setFile] = useState<{ name: string; size: number; data: Uint8Array } | null>(null);
  const [text, setText] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [specs, setSpecs] = useState("");
  const [over, setOver] = useState(false);
  const [fps, setFps] = useState(24);
  const [frameBytes, setFrameBytes] = useState(1465);
  const [ecc, setEcc] = useState<"L" | "M" | "Q" | "H">("L");
  const [grid, setGrid] = useState(1);
  const [colorMode, setColorMode] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const genRef = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const startStream = useCallback(
    async (payload: Uint8Array, name: string) => {
      const gen = ++genRef.current;
      setStreaming(true);
      await new Promise((r) => setTimeout(r, 50));
      const canvas = canvasRef.current;
      if (!canvas || gen !== genRef.current) return;

      const wrapped = await wrapPayload(name, payload);
      const ratio = wrapped.length < payload.length + 20
        ? ` · ${Math.round((1 - wrapped.length / (payload.length + name.length + 3)) * 100)}% compressed`
        : "";
      const sessionId = (Math.floor(Math.random() * 0xffff) + 1) & 0xffff;
      const blockLen = frameBytes - HEADER_LEN;
      const encoder = new LTEncoder(wrapped, blockLen, sessionId);
      const header: FrameHeader = {
        sessionId, seq: 0, k: encoder.k, blockLen,
        totalLen: wrapped.length, payloadFnv: fnv1a(wrapped),
      };

      const gridCols = grid;
      const gridRows = grid;
      const channelsPerCell = colorMode ? 3 : 1;
      const codesPerFrame = gridCols * gridRows * channelsPerCell;

      let version: number | undefined;
      let modules = 0;
      let scale = 1;
      const staging = document.createElement("canvas");
      const queue: ImageData[] = [];
      let nextSeq = 0;

      const sizeCanvas = () => {
        const dpr = window.devicePixelRatio || 1;
        const cellSize = modules + 2 * MARGIN;
        const totalW = gridCols * cellSize;
        const totalH = gridRows * cellSize;
        const maxPx = Math.min(0.92 * Math.min(window.innerWidth, window.innerHeight), 700);
        scale = Math.max(1, Math.floor((maxPx * dpr) / Math.max(totalW, totalH)));
        staging.width = totalW;
        staging.height = totalH;
        canvas.width = totalW * scale;
        canvas.height = totalH * scale;
        canvas.style.width = `${(totalW * scale) / dpr}px`;
        canvas.style.height = `${(totalH * scale) / dpr}px`;
      };

      const genQR = () => {
        const bytes = packFrame({ ...header, seq: nextSeq }, encoder.encode(nextSeq));
        nextSeq++;
        const qr = QRCode.create(
          [{ data: bytes, mode: "byte" } as unknown as QRCode.QRCodeSegment],
          { errorCorrectionLevel: ecc, version, maskPattern: 4 },
        );
        if (version === undefined) {
          version = qr.version;
          modules = qr.modules.size;
          sizeCanvas();
          const modeLabel = colorMode ? "RGB" : "B&W";
          const gridLabel = grid > 1 ? `${gridCols}x${gridRows} · ` : "";
          setSpecs(
            `${gridLabel}${modeLabel} · ${fps} FPS · ${codesPerFrame} codes/frame · V${version} · ${formatSize(wrapped.length)}${ratio} · K=${encoder.k}`,
          );
        }
        return { data: qr.modules.data, size: qr.modules.size };
      };

      const makeFrame = (): ImageData => {
        const cellSize = modules + 2 * MARGIN;
        const totalW = gridCols * cellSize;
        const totalH = gridRows * cellSize;
        const img = new ImageData(totalW, totalH);
        const px = new Uint32Array(img.data.buffer);
        px.fill(0xffffffff);

        for (let gy = 0; gy < gridRows; gy++) {
          for (let gx = 0; gx < gridCols; gx++) {
            const ox = gx * cellSize + MARGIN;
            const oy = gy * cellSize + MARGIN;

            if (colorMode) {
              const qrR = genQR();
              const qrG = genQR();
              const qrB = genQR();
              const size = qrR.size;
              for (let y = 0; y < size; y++) {
                const dstRow = (oy + y) * totalW + ox;
                const srcRow = y * size;
                for (let x = 0; x < size; x++) {
                  const si = srcRow + x;
                  const r = qrR.data[si] ? 0 : 255;
                  const g = qrG.data[si] ? 0 : 255;
                  const b = qrB.data[si] ? 0 : 255;
                  px[dstRow + x] = 0xff000000 | (b << 16) | (g << 8) | r;
                }
              }
            } else {
              const q = genQR();
              for (let y = 0; y < q.size; y++) {
                const dstRow = (oy + y) * totalW + ox;
                const srcRow = y * q.size;
                for (let x = 0; x < q.size; x++) {
                  if (q.data[srcRow + x]) px[dstRow + x] = 0xff000000;
                }
              }
            }
          }
        }
        return img;
      };

      const pump = () => {
        if (gen !== genRef.current) return;
        try {
          while (queue.length < LOOKAHEAD) queue.push(makeFrame());
        } catch (err) {
          setSpecs(`Error: ${err instanceof Error ? err.message : String(err)}`);
          return;
        }
        setTimeout(pump, 0);
      };
      pump();

      const interval = 1000 / fps;
      let nextAt = performance.now();
      const tick = (now: number) => {
        if (gen !== genRef.current) return;
        requestAnimationFrame(tick);
        if (now < nextAt) return;
        const img = queue.shift();
        if (!img) { nextAt = now + interval; return; }
        staging.getContext("2d")!.putImageData(img, 0, 0);
        const ctx = canvas.getContext("2d")!;
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(staging, 0, 0, canvas.width, canvas.height);
        nextAt += interval;
        if (now - nextAt > 3 * interval) nextAt = now + interval;
      };
      requestAnimationFrame(tick);

      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (navigator as any).wakeLock?.request("screen").catch(() => {});
      } catch { /* fine */ }
    },
    [fps, frameBytes, ecc, grid, colorMode],
  );

  useEffect(() => {
    if (file) startStream(file.data, file.name);
  }, [file, startStream]);

  async function handleFile(f: File) {
    const buf = new Uint8Array(await f.arrayBuffer());
    setFile({ name: f.name, size: f.size, data: buf });
  }

  function sendText() {
    if (!text.trim()) return;
    const data = new TextEncoder().encode(text);
    setFile({ name: "__text__.txt", size: data.length, data });
  }

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setOver(false);
    const f = e.dataTransfer.files[0];
    if (f) handleFile(f);
  }

  function clearFile() {
    genRef.current++;
    setFile(null);
    setStreaming(false);
    setSpecs("");
  }

  const isTextMode = file?.name === "__text__.txt";

  return (
    <div className="page">
      <h1>OPTICALSEND <small>— Send</small></h1>

      {!streaming && (
        <>
          <div className="mode-toggle">
            <button className={mode === "file" ? "active" : ""} onClick={() => setMode("file")}>File</button>
            <button className={mode === "text" ? "active" : ""} onClick={() => setMode("text")}>Text</button>
          </div>

          <details className="settings" open>
            <summary>Settings</summary>
            <div className="row">
              <label>
                grid
                <select value={grid} onChange={(e) => setGrid(Number(e.target.value))}>
                  <option value={1}>1x1</option>
                  <option value={2}>2x2 (4x)</option>
                </select>
              </label>
              <label>
                color
                <select value={colorMode ? "rgb" : "bw"} onChange={(e) => setColorMode(e.target.value === "rgb")}>
                  <option value="bw">B&W</option>
                  <option value="rgb">RGB (3x)</option>
                </select>
              </label>
              <label>
                tx fps
                <select value={fps} onChange={(e) => setFps(Number(e.target.value))}>
                  {[10, 15, 20, 24, 30, 60].map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label>
                bytes / frame
                <select value={frameBytes} onChange={(e) => setFrameBytes(Number(e.target.value))}>
                  {[500, 1000, 1465, 1850, 2331, 2953].map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label>
                error correction
                <select value={ecc} onChange={(e) => setEcc(e.target.value as "L" | "M" | "Q" | "H")}>
                  {["L", "M", "Q", "H"].map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
            </div>
          </details>
        </>
      )}

      {!streaming && mode === "file" && (
        <>
          <button className="upload-btn" onClick={() => inputRef.current?.click()}>
            <span className="upload-icon">+</span>
            Choose a file to send
            <span className="upload-sub">Any file type, any size</span>
          </button>
          <div
            className={`dropzone${over ? " over" : ""}`}
            onDragOver={(e) => { e.preventDefault(); setOver(true); }}
            onDragLeave={() => setOver(false)}
            onDrop={onDrop}
            onClick={() => inputRef.current?.click()}
          >
            <p>or drag and drop here</p>
          </div>
          <input
            ref={inputRef}
            type="file"
            hidden
            onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); }}
          />
        </>
      )}

      {!streaming && mode === "text" && (
        <>
          <textarea
            className="text-input"
            placeholder="Type or paste text to send..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={6}
            autoFocus
          />
          <button
            className="upload-btn"
            onClick={sendText}
            style={{ opacity: text.trim() ? 1 : 0.5 }}
          >
            Send text
            <span className="upload-sub">{text.length > 0 ? formatSize(new TextEncoder().encode(text).length) : "type something first"}</span>
          </button>
        </>
      )}

      {streaming && (
        <>
          <div className="file-info">
            <span className="name">{isTextMode ? "Text message" : file!.name}</span>
            <span className="size">{formatSize(file!.size)}</span>
            <button onClick={clearFile} title="Clear">&times;</button>
          </div>

          <p className="hint">{specs}</p>

          <div className="stage">
            <canvas ref={canvasRef} width={16} height={16} />
          </div>

          <p className="hint">
            Max screen brightness helps. Point the receiver&apos;s camera at this code.
          </p>
        </>
      )}

      <nav className="bottom-nav">
        <Link href="/send" className="active">
          <span className="nav-icon">&uarr;</span>
          Send
        </Link>
        <Link href="/receive">
          <span className="nav-icon">&darr;</span>
          Receive
        </Link>
      </nav>
    </div>
  );
}
