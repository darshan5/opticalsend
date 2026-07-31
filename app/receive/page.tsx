"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Link from "next/link";
import { LTDecoder } from "@/lib/fountain";
import { fnv1a, parseFrame, unwrapPayload } from "@/lib/protocol";

const OVERHEAD_EST = 1.18;

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function mimeFromName(name: string): string {
  const ext = name.split(".").pop()?.toLowerCase() || "";
  const map: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf",
    txt: "text/plain", json: "application/json", zip: "application/zip",
    mp4: "video/mp4", mp3: "audio/mpeg", wav: "audio/wav",
  };
  return map[ext] || "application/octet-stream";
}

function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg|bmp)$/i.test(name);
}

interface ReceiveResult {
  name: string;
  url: string;
  isImg: boolean;
  isText: boolean;
  text?: string;
}

export default function ReceivePage() {
  const [status, setStatus] = useState("Point the camera at the sender's code");
  const [started, setStarted] = useState(false);
  const [progress, setProgress] = useState(0);
  const [showProgress, setShowProgress] = useState(false);
  const [metrics, setMetrics] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ReceiveResult | null>(null);
  const [copied, setCopied] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const doneRef = useRef(false);
  const decoderRef = useRef<LTDecoder | null>(null);
  const sessionRef = useRef(0);
  const startTsRef = useRef(0);
  const captureGenRef = useRef(0);
  const streamRef = useRef<MediaStream | null>(null);
  const workersRef = useRef<Worker[]>([]);
  const busyRef = useRef<boolean[]>([]);
  const captureTimesRef = useRef<number[]>([]);
  const decodeTimesRef = useRef<number[]>([]);
  const frameIdRef = useRef(0);
  const grabRef = useRef<HTMLCanvasElement | null>(null);

  const [captureWidth, setCaptureWidth] = useState(1280);
  const [captureFps, setCaptureFps] = useState(60);
  const [workerCount, setWorkerCount] = useState(2);

  const finish = useCallback((payload: Uint8Array, hashOk: boolean, seconds: number, totalLen: number) => {
    doneRef.current = true;
    captureGenRef.current++;
    streamRef.current?.getTracks().forEach((t) => t.stop());
    setProgress(100);

    const { name, bytes } = unwrapPayload(payload);
    const isText = name === "__text__.txt";
    const mime = mimeFromName(name);
    const buf = new Uint8Array(bytes.length);
    buf.set(bytes);

    let textContent: string | undefined;
    if (isText) {
      textContent = new TextDecoder().decode(buf);
    }

    const url = URL.createObjectURL(new Blob([buf], { type: mime }));
    const kb = Math.round(totalLen / 1024);
    const rate = (totalLen / 1024 / seconds).toFixed(1);
    setStatus(`${kb} KB in ${seconds.toFixed(1)}s · ${rate} KB/s · hash ${hashOk ? "verified" : "MISMATCH"}`);
    setResult({ name, url, isImg: isImage(name), isText, text: textContent });
  }, []);

  const onDecoded = useCallback((bytes: Uint8Array) => {
    decodeTimesRef.current.push(performance.now());
    const parsed = parseFrame(bytes);
    if (!parsed || doneRef.current) return;
    const { header, block } = parsed;
    if (!decoderRef.current || sessionRef.current !== header.sessionId) {
      decoderRef.current = new LTDecoder(header.k, header.blockLen, header.sessionId, header.totalLen);
      sessionRef.current = header.sessionId;
      startTsRef.current = performance.now();
      setShowProgress(true);
    }
    const dec = decoderRef.current;
    dec.addFrame(header.seq, block);
    setProgress(Math.min(99, (dec.framesNew / (dec.k * OVERHEAD_EST)) * 100));
    if (dec.isComplete) {
      const payload = dec.assemble()!;
      const seconds = (performance.now() - startTsRef.current) / 1000;
      finish(payload, fnv1a(payload) === header.payloadFnv, seconds, header.totalLen);
    }
  }, [finish]);

  const captureFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    const vw = video.videoWidth;
    const vh = video.videoHeight;
    if (!vw || !vh) return;
    captureTimesRef.current.push(performance.now());
    const slot = busyRef.current.indexOf(false);
    if (slot === -1) return;
    if (!grabRef.current) grabRef.current = document.createElement("canvas");
    const grab = grabRef.current;
    if (grab.width !== vw || grab.height !== vh) { grab.width = vw; grab.height = vh; }
    const ctx = grab.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(video, 0, 0);
    const img = ctx.getImageData(0, 0, vw, vh);
    busyRef.current[slot] = true;
    workersRef.current[slot]!.postMessage(
      { id: frameIdRef.current++, buf: img.data.buffer, w: vw, h: vh },
      [img.data.buffer],
    );
  }, []);

  const scheduleFrame = useCallback((gen: number) => {
    if (doneRef.current || gen !== captureGenRef.current) return;
    const video = videoRef.current;
    if (!video) return;
    const next = () => {
      if (doneRef.current || gen !== captureGenRef.current) return;
      captureFrame();
      scheduleFrame(gen);
    };
    if ("requestVideoFrameCallback" in video) {
      (video as HTMLVideoElement & { requestVideoFrameCallback: (cb: () => void) => void })
        .requestVideoFrameCallback(next);
    } else {
      requestAnimationFrame(next);
    }
  }, [captureFrame]);

  async function start() {
    if (!navigator.mediaDevices?.getUserMedia) {
      setStatus("Camera needs HTTPS — this page must be served over a secure connection.");
      return;
    }
    setStarted(true);
    const base: MediaTrackConstraints = {
      facingMode: "environment",
      width: { ideal: captureWidth },
      height: { ideal: Math.round((captureWidth * 3) / 4) },
    };
    let stream: MediaStream;
    try {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { exact: captureFps } } });
      } catch {
        stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...base, frameRate: { ideal: captureFps } } });
      }
    } catch (err) {
      setStatus(`Camera: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    streamRef.current = stream;
    const video = videoRef.current!;
    video.srcObject = stream;
    await video.play().catch(() => undefined);
    const track = stream.getVideoTracks()[0];
    const s = track?.getSettings();
    setStatus(`Camera ${s?.width}x${s?.height}@${s?.frameRate} — searching for stream...`);

    const workers: Worker[] = [];
    const busy: boolean[] = [];
    for (let i = 0; i < workerCount; i++) {
      const w = new Worker(new URL("../../lib/qr-worker.ts", import.meta.url));
      const slot = i;
      w.onmessage = (e: MessageEvent) => {
        const { id, bytes } = e.data as { id: number; bytes: Uint8Array | null };
        if (id === -1) return;
        busy[slot] = false;
        if (bytes) onDecoded(bytes);
      };
      workers.push(w);
      busy.push(false);
    }
    workersRef.current = workers;
    busyRef.current = busy;

    captureGenRef.current++;
    scheduleFrame(captureGenRef.current);
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await (navigator as any).wakeLock?.request("screen");
    } catch { /* fine */ }
  }

  useEffect(() => {
    if (!started || doneRef.current) return;
    const id = setInterval(() => {
      const now = performance.now();
      const prune = (a: number[]) => { while (a.length > 0 && a[0]! < now - 2000) a.shift(); };
      prune(captureTimesRef.current);
      prune(decodeTimesRef.current);
      const m: Record<string, string> = {
        capFps: (captureTimesRef.current.length / 2).toFixed(0),
        decFps: (decodeTimesRef.current.length / 2).toFixed(1),
      };
      const dec = decoderRef.current;
      if (dec) {
        const elapsed = (now - startTsRef.current) / 1000;
        m.rate = `${((dec.framesNew * dec.blockLen) / OVERHEAD_EST / 1024 / Math.max(0.1, elapsed)).toFixed(1)} KB/s`;
        m.time = `${elapsed.toFixed(0)}s`;
        m.frames = `${dec.framesNew}/${dec.framesDup}`;
        m.payload = formatSize(dec.totalLen);
      }
      setMetrics(m);
    }, 500);
    return () => clearInterval(id);
  }, [started]);

  async function copyText() {
    if (!result?.text) return;
    await navigator.clipboard.writeText(result.text);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  return (
    <div className="page">
      <h1>OPTICALSEND <small>— Receive</small></h1>

      {showProgress && (
        <div className="progress-bar">
          <div style={{ width: `${progress.toFixed(1)}%` }} />
        </div>
      )}

      <p className="hint">{status}</p>

      {!started && !result && (
        <>
          <details className="settings">
            <summary>Settings</summary>
            <div className="row">
              <label>
                capture width
                <select value={captureWidth} onChange={(e) => setCaptureWidth(Number(e.target.value))}>
                  {[960, 1280, 1920].map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label>
                capture fps
                <select value={captureFps} onChange={(e) => setCaptureFps(Number(e.target.value))}>
                  {[30, 60].map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
              <label>
                decode workers
                <select value={workerCount} onChange={(e) => setWorkerCount(Number(e.target.value))}>
                  {[1, 2, 3].map((v) => <option key={v}>{v}</option>)}
                </select>
              </label>
            </div>
          </details>
          <button className="upload-btn" onClick={() => void start()}>
            <span className="upload-icon">&#x25CE;</span>
            Start camera
            <span className="upload-sub">Point at the sender&apos;s QR code</span>
          </button>
        </>
      )}

      {started && !result && (
        <>
          <div className="metrics">
            <div className="metric"><div className="k">Goodput</div><div className="v amber">{metrics.rate ?? "—"}</div></div>
            <div className="metric"><div className="k">Decode FPS</div><div className="v amber">{metrics.decFps ?? "—"}</div></div>
            <div className="metric"><div className="k">Elapsed</div><div className="v">{metrics.time ?? "—"}</div></div>
            <div className="metric"><div className="k">Payload</div><div className="v">{metrics.payload ?? "—"}</div></div>
          </div>
          <div className="preview">
            <video ref={videoRef} muted playsInline />
          </div>
        </>
      )}

      {result && (
        <>
          <p className="done-text">Transfer Complete!</p>

          {result.isText && result.text ? (
            <>
              <div className="text-result">
                <div className="text-result-content">{result.text}</div>
              </div>
              <button className="upload-btn" onClick={copyText}>
                {copied ? "Copied!" : "Copy text"}
              </button>
            </>
          ) : (
            <>
              {result.isImg && (
                // eslint-disable-next-line @next/next/no-img-element
                <img className="received" src={result.url} alt="Received file" />
              )}
              <a className="btn" href={result.url} download={result.name} style={{ width: "100%", padding: "16px" }}>
                Download {result.name}
              </a>
            </>
          )}
        </>
      )}

      {!started && !result && (
        <video ref={videoRef} muted playsInline style={{ display: "none" }} />
      )}

      <nav className="bottom-nav">
        <Link href="/send">
          <span className="nav-icon">&uarr;</span>
          Send
        </Link>
        <Link href="/receive" className="active">
          <span className="nav-icon">&darr;</span>
          Receive
        </Link>
      </nav>
    </div>
  );
}
